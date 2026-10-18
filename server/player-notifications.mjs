import { randomUUID, createHash } from 'node:crypto'
import webpush from 'web-push'
import { ApiError, permissionsFor, playerAccess } from './studio.mjs'
import { claimEligibility } from './order-contract.mjs'
import { orderLifecycle, playerOrderExecutable, createLifecycleContext } from './order-lifecycle.mjs'

const fail = (message, status = 400) => {
  throw new ApiError(message, status)
}
const digest = (value) => createHash('sha256').update(value).digest('hex')
const defaultSettings = { pool: false, push: true }
const reminderTypes = ['pool', 'assigned', 'assignment-timeout']
const parsedObject = (value) => {
  try {
    const parsed = JSON.parse(value || 'null')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
const positiveRound = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null)
const identifier = (value) => (typeof value === 'string' && value ? value : null)
const publicTarget = (row) => {
  if (!row.order_id) return null
  const target = parsedObject(row.target_json),
    legacyValidity = parsedObject(row.validity_json)
  return {
    orderId: row.order_id,
    dispatchRound: positiveRound(target?.dispatchRound ?? legacyValidity?.dispatchRound),
    assignmentId: identifier(target?.assignmentId),
    submissionId: identifier(target?.submissionId),
    ...(target?.problemId ? { problemId: identifier(target.problemId) } : {})
  }
}
const publicNotice = (row) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.type === 'problem-open' ? '订单已暂停打手操作，由后台客服处理；可查看问题及处理记录。' : row.body,
  orderId: row.order_id || null,
  target: publicTarget(row),
  href: row.href,
  createdAt: row.created_at,
  readAt: row.read_at || null,
  invalidatedAt: row.invalidated_at || null
})
const pagination = (query) => ({
  current: Math.max(1, Math.trunc(Number(query.current) || 1)),
  size: Math.min(100, Math.max(1, Math.trunc(Number(query.size) || 30)))
})
const round = (order) => Number(order.dispatchRound) || 1
const dispatchToken = (order) =>
  `${order.id}:${round(order)}:${order.dispatchMode}:${order.assignedTo || ''}:${order.assignedAt || order.publishedAt}`

/** Durable owner-scoped messages and outbox rows committed with business mutations. */
export function createPlayerNotifications(
  db,
  {
    clock = () => new Date(),
    publicKey = process.env.STUDIO_PUSH_PUBLIC_KEY || '',
    privateKey = process.env.STUDIO_PUSH_PRIVATE_KEY || '',
    subject = process.env.STUDIO_PUSH_SUBJECT || '',
    allowedPushHosts = (process.env.STUDIO_PUSH_ALLOWED_HOSTS || '').split(',').filter(Boolean),
    pushSender = (subscription, payload, options) =>
      webpush.sendNotification(subscription, payload, options),
    scanBatchSize = 100,
    sendBatchSize = 20,
    sendConcurrency = 2,
    leaseMs = 30_000,
    reminderLifetimeMs = 15 * 60_000,
    historyPushLifetimeMs = 24 * 60 * 60_000,
    maxAttempts = 3
  } = {}
) {
  if (
    ![
      scanBatchSize,
      sendBatchSize,
      sendConcurrency,
      leaseMs,
      reminderLifetimeMs,
      historyPushLifetimeMs,
      maxAttempts
    ].every(Number.isSafeInteger) ||
    scanBatchSize < 1 ||
    scanBatchSize > 500 ||
    sendBatchSize < 1 ||
    sendBatchSize > 100 ||
    sendConcurrency < 1 ||
    sendConcurrency > 5 ||
    leaseMs < 15_000 ||
    leaseMs > 300_000 ||
    reminderLifetimeMs < 1 ||
    historyPushLifetimeMs < 1 ||
    maxAttempts < 1 ||
    maxAttempts > 10
  )
    fail('通知任务配置无效：发送租约至少 15 秒，并须大于 5 秒网络超时')
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_key TEXT NOT NULL,
      type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      order_id TEXT, href TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT,
      UNIQUE(user_id,event_key));
    CREATE INDEX IF NOT EXISTS player_notifications_owner ON player_notifications(user_id,created_at);
    CREATE TABLE IF NOT EXISTS player_notification_settings(user_id TEXT PRIMARY KEY,pool INTEGER NOT NULL DEFAULT 0,push INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS player_push_subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,endpoint_hash TEXT UNIQUE NOT NULL,subscription_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS player_push_outbox(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL,subscription_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,last_error TEXT,sent_at TEXT,UNIQUE(notification_id,subscription_id));
    CREATE INDEX IF NOT EXISTS player_push_due ON player_push_outbox(status,next_at);
    CREATE TABLE IF NOT EXISTS player_notification_candidates (
      event_key TEXT PRIMARY KEY,order_id TEXT NOT NULL,dispatch_token TEXT NOT NULL,
      type TEXT NOT NULL,level_id TEXT,due_at TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS player_notification_candidates_due ON player_notification_candidates(status,due_at,event_key);
  `)
  const addColumns = (table, definitions) => {
    const existing = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
    )
    for (const [name, definition] of Object.entries(definitions))
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
  addColumns('player_notifications', {
    validity_json: 'TEXT',
    invalidated_at: 'TEXT',
    target_json: 'TEXT'
  })
  addColumns('player_push_outbox', {
    lease_token: 'TEXT',
    lease_until: 'TEXT',
    claimed_at: 'TEXT',
    created_at: 'TEXT',
    expires_at: 'TEXT'
  })
  db.exec(`CREATE INDEX IF NOT EXISTS player_notifications_unread ON player_notifications(user_id,read_at,invalidated_at,type);
    CREATE INDEX IF NOT EXISTS player_push_leases ON player_push_outbox(status,lease_until);
    CREATE INDEX IF NOT EXISTS player_notification_candidates_order ON player_notification_candidates(order_id,status);`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_notification_versions(user_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO player_notification_versions(user_id,revision)
      SELECT user_id,COUNT(*) FROM player_notifications GROUP BY user_id;
    CREATE TRIGGER IF NOT EXISTS player_notices_version_insert AFTER INSERT ON player_notifications BEGIN
      INSERT INTO player_notification_versions(user_id,revision) VALUES(NEW.user_id,1)
        ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS player_notices_version_delete AFTER DELETE ON player_notifications BEGIN
      INSERT INTO player_notification_versions(user_id,revision) VALUES(OLD.user_id,1)
        ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS player_notices_version_update AFTER UPDATE ON player_notifications
      WHEN OLD.user_id IS NOT NEW.user_id OR OLD.read_at IS NOT NEW.read_at OR
        OLD.invalidated_at IS NOT NEW.invalidated_at OR OLD.title IS NOT NEW.title OR
        OLD.body IS NOT NEW.body OR OLD.href IS NOT NEW.href OR OLD.order_id IS NOT NEW.order_id OR
        OLD.type IS NOT NEW.type OR OLD.created_at IS NOT NEW.created_at
      BEGIN
        INSERT INTO player_notification_versions(user_id,revision) VALUES(NEW.user_id,1)
          ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
        INSERT INTO player_notification_versions(user_id,revision)
          SELECT OLD.user_id,1 WHERE OLD.user_id IS NOT NEW.user_id
          ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
      END;
  `)
  const now = () => new Date(clock()).toISOString()
  const state = () => JSON.parse(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const transaction = (callback) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const getUser = (userId, playerOnly = true, snapshot = state()) => {
    const user = snapshot.users.find((row) => row.id === userId)
    if (!user || user.status !== 'active' || (user.role === 'player' && !playerAccess(user).login))
      fail('账号不可用', 403)
    if (playerOnly && user.role !== 'player') fail('此接口仅供打手账号使用', 403)
    if (!playerOnly && user.role !== 'player' && !permissionsFor(user).includes('orders.edit'))
      fail('没有查看消息的权限', 403)
    return user
  }
  const settings = (userId) => {
    const row = db
      .prepare('SELECT pool,push FROM player_notification_settings WHERE user_id=?')
      .get(userId)
    return row ? { pool: Boolean(row.pool), push: Boolean(row.push) } : { ...defaultSettings }
  }
  const configured = Boolean(publicKey && privateKey && /^(mailto:|https:\/\/)/.test(subject))
  if (configured) {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey)
    } catch {
      fail('网页推送密钥配置无效，请检查服务端配置')
    }
  }
  const indexed = (snapshot) => {
    const lifecycle = createLifecycleContext(snapshot)
    return ({
    snapshot,
    lifecycle,
    users: new Map(snapshot.users.map((row) => [row.id, row])),
    orders: new Map(snapshot.orders.map((row) => [row.id, row])),
    pendingCounts: snapshot.orders.reduce((result, order) => {
      if (playerOrderExecutable(snapshot, order, lifecycle) && order.status === 'pending' && order.assignedTo && order.dispatchState !== 'unassigned')
        result.set(order.assignedTo, (result.get(order.assignedTo) || 0) + 1)
      return result
    }, new Map()),
    counts: snapshot.orders.reduce((result, order) => {
      if (
        orderLifecycle(snapshot, order, lifecycle).countsTowardsCapacity
      )
        result.set(order.leaderId, (result.get(order.leaderId) || 0) + 1)
      return result
    }, new Map())
  }) }
  const eligible = (index, user, order, timestamp) =>
    claimEligibility(index.snapshot, user, order, timestamp, {
      activeCount: index.counts.get(user.id) || 0,
      pendingAssignments: index.pendingCounts.get(user.id) || 0,
      level: index.snapshot.levels.find((row) => row.id === user.levelId)
      , lifecycle: index.lifecycle
    }).canClaim === true
  const validity = (type, order) =>
    reminderTypes.includes(type) && order
      ? {
          dispatchToken: dispatchToken(order),
          dispatchRound: round(order),
          revision: order.revision || 1,
          assignedTo: order.assignedTo || null
        }
      : null
  const isValid = (row, index, timestamp, preferences = settings(row.user_id)) => {
    if (row.invalidated_at) return false
    if (row.type === 'problem-open') {
      const order = index.orders.get(row.order_id), target = parsedObject(row.target_json)
      return Boolean(order && order.problem?.status === 'open' && order.problem.id === target?.problemId &&
        [order.leaderId, order.teammateId].includes(row.user_id) &&
        order.assignmentId === target.assignmentId && order.dispatchRound === target.dispatchRound)
    }
    if (!reminderTypes.includes(row.type)) return true
    const order = index.orders.get(row.order_id),
      user = index.users.get(row.user_id)
    if (!order || !user || user.status !== 'active') return false
    let expected
    try {
      expected = JSON.parse(row.validity_json || 'null')
    } catch {
      return false
    }
    if (!expected || expected.dispatchToken !== dispatchToken(order)) return false
    if (!playerOrderExecutable(index.snapshot, order) || order.status !== 'pending' || order.dispatchState === 'unassigned' || order.leaderId)
      return false
    if (row.type === 'assignment-timeout')
      return (
        user.role !== 'player' &&
        permissionsFor(user).includes('orders.edit') &&
        order.dispatchMode === 'direct' &&
        Boolean(order.assignedTo) &&
        Date.parse(timestamp) >= Date.parse(order.assignedAt || order.publishedAt) + 300_000
      )
    if (user.role !== 'player' || !playerAccess(user).login || !playerAccess(user).claim)
      return false
    if (row.type === 'assigned')
      return order.dispatchMode === 'direct' && order.assignedTo === user.id
    return (
      order.dispatchMode === 'pool' && preferences.pool && eligible(index, user, order, timestamp)
    )
  }
  const invalidate = (where, args, timestamp, reason = '提醒已失效') => {
    db.prepare(
      `UPDATE player_notifications SET invalidated_at=COALESCE(invalidated_at,?),read_at=COALESCE(read_at,?) WHERE ${where} AND type IN ('pool','assigned','assignment-timeout','problem-open')`
    ).run(timestamp, timestamp, ...args)
    db.prepare(
      `UPDATE player_push_outbox SET status='skipped',last_error=?,lease_token=NULL,lease_until=NULL WHERE status IN ('pending','processing') AND notification_id IN (SELECT id FROM player_notifications WHERE ${where} AND invalidated_at IS NOT NULL)`
    ).run(reason, ...args)
  }
  const invalidateRows = (rows, index, timestamp) => {
    for (const row of rows)
      if (!isValid(row, index, timestamp)) invalidate('id=?', [row.id], timestamp)
  }
  const insert = ({
    userId,
    key,
    type,
    title,
    body,
    orderId = null,
    target,
    href = '/#/player/messages',
    timestamp = now(),
    index
  }) => {
    const order = index?.orders.get(orderId),
      valid = validity(type, order),
      businessTarget = orderId
        ? {
            orderId,
            dispatchRound: positiveRound(target ? target.dispatchRound : order?.dispatchRound),
            assignmentId: identifier(
              target ? target.assignmentId : reminderTypes.includes(type) ? null : order?.assignmentId
            ),
            submissionId: identifier(
              target ? target.submissionId : reminderTypes.includes(type) ? null : order?.submissionId
            ),
            ...(target?.problemId ? { problemId: target.problemId } : {})
          }
        : null
    const draft = {
      user_id: userId,
      type,
      order_id: orderId,
      validity_json: valid ? JSON.stringify(valid) : null
    }
    if (reminderTypes.includes(type) && (!index || !isValid(draft, index, timestamp))) return null
    const id = randomUUID()
    const result = db
      .prepare(
        'INSERT OR IGNORE INTO player_notifications(id,user_id,event_key,type,title,body,order_id,href,created_at,validity_json,target_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        userId,
        key,
        type,
        title,
        body,
        orderId,
        href,
        timestamp,
        draft.validity_json,
        businessTarget ? JSON.stringify(businessTarget) : null
      )
    if (!result.changes) return null
    const user = index?.users.get(userId)
    if (
      settings(userId).push &&
      configured &&
      user?.role === 'player' &&
      user.status === 'active' &&
      playerAccess(user).login
    ) {
      const expiresAt = new Date(
        Date.parse(timestamp) +
          (reminderTypes.includes(type) ? reminderLifetimeMs : historyPushLifetimeMs)
      ).toISOString()
      for (const subscription of db
        .prepare('SELECT id FROM player_push_subscriptions WHERE user_id=?')
        .all(userId))
        db.prepare(
          'INSERT OR IGNORE INTO player_push_outbox(id,notification_id,subscription_id,next_at,created_at,expires_at) VALUES(?,?,?,?,?,?)'
        ).run(randomUUID(), id, subscription.id, timestamp, timestamp, expiresAt)
    }
    return id
  }
  const skipBinding = (subscriptionId, reason) =>
    db
      .prepare(
        "UPDATE player_push_outbox SET status='skipped',last_error=?,lease_token=NULL,lease_until=NULL WHERE status IN ('pending','processing') AND subscription_id=?"
      )
      .run(reason, subscriptionId)
  const revoke = (userId) => {
    for (const subscription of db
      .prepare('SELECT id FROM player_push_subscriptions WHERE user_id=?')
      .all(userId))
      skipBinding(subscription.id, '通知订阅已撤销')
    db.prepare('DELETE FROM player_push_subscriptions WHERE user_id=?').run(userId)
  }
  const playerTarget = (orderId) => `/#/player/orders/${encodeURIComponent(orderId)}`
  const schedule = (order, snapshot, timestamp) => {
    if (!playerOrderExecutable(snapshot, order) || order.status !== 'pending' || order.dispatchState === 'unassigned' || order.leaderId) return
    const token = dispatchToken(order)
    const add = (type, levelId, dueAt) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO player_notification_candidates(event_key,order_id,dispatch_token,type,level_id,due_at,created_at) VALUES(?,?,?,?,?,?,?)'
        )
        .run(
          `${type}:${token}:${levelId || ''}`,
          order.id,
          token,
          type,
          levelId || null,
          dueAt,
          timestamp
        )
    if (order.dispatchMode === 'direct' && order.assignedTo)
      add(
        'assignment-timeout',
        null,
        new Date(Date.parse(order.assignedAt || order.publishedAt) + 300_000).toISOString()
      )
    if (order.dispatchMode === 'pool')
      for (const level of snapshot.levels)
        add(
          'pool',
          level.id,
          new Date(Date.parse(order.publishedAt) + level.delaySeconds * 1000).toISOString()
        )
  }
  const onTransaction = ({ state: after, beforeState: before, now: timestamp }) => {
    const index = indexed(after),
      oldOrders = new Map(before.orders.map((row) => [row.id, row])),
      oldUsers = new Map(before.users.map((row) => [row.id, row])),
      affectedUsers = new Set()
    const oldLevels = new Map(before.levels.map((row) => [row.id, row]))
    const changedLevels = after.levels.filter(
      (level) => JSON.stringify(oldLevels.get(level.id)) !== JSON.stringify(level)
    )
    if (changedLevels.length) {
      const changedIds = new Set(changedLevels.map((row) => row.id))
      for (const user of after.users) if (changedIds.has(user.levelId)) affectedUsers.add(user.id)
      for (const order of after.orders) {
        if (
          order.status !== 'pending' ||
          order.dispatchMode !== 'pool' ||
          order.dispatchState === 'unassigned' ||
          order.leaderId
        )
          continue
        schedule(order, after, timestamp)
        for (const level of changedLevels)
          db.prepare(
            "UPDATE player_notification_candidates SET due_at=? WHERE order_id=? AND level_id=? AND status='pending'"
          ).run(
            new Date(Date.parse(order.publishedAt) + level.delaySeconds * 1000).toISOString(),
            order.id,
            level.id
          )
      }
    }
    for (const user of after.users) {
      const old = oldUsers.get(user.id)
      const changed = !old || JSON.stringify(old) !== JSON.stringify(user)
      const passwordChanged =
        JSON.stringify(before.passwords?.[user.id]) !== JSON.stringify(after.passwords?.[user.id])
      if (
        (changed || passwordChanged) &&
        (user.status !== 'active' ||
          user.role !== 'player' ||
          !playerAccess(user).login ||
          (old && old.role !== user.role) ||
          passwordChanged)
      )
        revoke(user.id)
      if (changed) affectedUsers.add(user.id)
    }
    for (const old of before.users) if (!index.users.has(old.id)) revoke(old.id)
    for (const order of after.orders) {
      const old = oldOrders.get(order.id)
      const changedDispatch =
        !old ||
        old.status !== order.status ||
        dispatchToken(old) !== dispatchToken(order) ||
        old.dispatchState !== order.dispatchState ||
        old.leaderId !== order.leaderId ||
        orderLifecycle(before, old).displayStatus !== orderLifecycle(after, order).displayStatus ||
        orderLifecycle(before, old).playerOperationBlockedReason?.code !== orderLifecycle(after, order).playerOperationBlockedReason?.code
      if (changedDispatch) {
        invalidateRows(
          db
            .prepare(
              "SELECT * FROM player_notifications WHERE order_id=? AND invalidated_at IS NULL AND type IN ('pool','assigned','assignment-timeout')"
            )
            .all(order.id),
          index,
          timestamp
        )
        db.prepare(
          "UPDATE player_notification_candidates SET status='obsolete' WHERE order_id=? AND status='pending' AND dispatch_token<>?"
        ).run(order.id, dispatchToken(order))
        if (!playerOrderExecutable(after, order) || order.status !== 'pending' || order.dispatchState === 'unassigned' || order.leaderId)
          db.prepare(
            "UPDATE player_notification_candidates SET status='obsolete' WHERE order_id=? AND status='pending'"
          ).run(order.id)
        else schedule(order, after, timestamp)
        if (old?.leaderId) affectedUsers.add(old.leaderId)
        if (order.leaderId) affectedUsers.add(order.leaderId)
      }
      if (
        changedDispatch &&
        playerOrderExecutable(after, order) &&
        order.status === 'pending' &&
        order.dispatchMode === 'direct' &&
        order.assignedTo &&
        order.dispatchState !== 'unassigned'
      )
        insert({
          userId: order.assignedTo,
          key: `assigned:${dispatchToken(order)}`,
          type: 'assigned',
          title: '有指定给你的订单',
          body: '请查看订单要求并接受，或填写原因拒绝。',
          orderId: order.id,
          href: playerTarget(order.id),
          timestamp,
          index
        })
      const related = [...new Set([order.leaderId, order.teammateId].filter(Boolean))]
      const lifecycle = orderLifecycle(after, order)
      const oldLifecycle = old ? orderLifecycle(before, old) : null
      if (old && old.status !== 'canceled' && order.status === 'canceled') {
        for (const userId of new Set([...related, old.leaderId, old.teammateId].filter(Boolean)))
          insert({ userId, key: `canceled:${order.id}:${order.revision}`, type: 'order-canceled', title: '订单已取消',
            body: '本单已停止履约并释放接单名额，特殊报酬由后台另行登记。', orderId: order.id, href: playerTarget(order.id), timestamp, index,
            target: { dispatchRound: order.dispatchRound, assignmentId: old.assignmentId, submissionId: null } })
      }
      if (old && oldLifecycle.displayStatus !== lifecycle.displayStatus &&
          (['stored', 'refunded', 'refund-pending'].includes(lifecycle.displayStatus) || oldLifecycle.stored || oldLifecycle.refundPending)) {
        const type = lifecycle.stored && !lifecycle.fullRefund && !lifecycle.refundPending ? 'order-stored' : oldLifecycle.stored && !lifecycle.stored && !lifecycle.executionBlockedReason ? 'order-resumed' : 'refund-result'
        const title = type === 'order-stored' ? '订单已存单' : type === 'order-resumed' ? '存单已恢复，请核对任务状态' : lifecycle.fullRefund ? '订单已全额退款' : lifecycle.refundPending ? '订单退款审批中，暂时停止执行' : '订单退款暂停已解除'
        for (const userId of new Set([...related, old.leaderId, old.teammateId].filter(Boolean)))
          insert({ userId, key: `${type}:${order.id}:${order.revision}`, type, title, body: '请打开任务核对当前状态与处理说明。', orderId: order.id, href: playerTarget(order.id), timestamp, index,
            target: { dispatchRound: order.dispatchRound, assignmentId: order.assignmentId || old.assignmentId, submissionId: null } })
      }
      invalidateRows(db.prepare("SELECT * FROM player_notifications WHERE order_id=? AND type='problem-open' AND invalidated_at IS NULL").all(order.id), index, timestamp)
      if (order.problem?.status === 'open') {
        for (const userId of related) {
          if (old?.problem?.id === order.problem.id && old.problem.status === 'open' && old.assignmentId === order.assignmentId && old.dispatchRound === order.dispatchRound && [old.leaderId, old.teammateId].includes(userId)) continue
          insert({ userId, key: `problem:${order.problem.id}:${order.dispatchRound}:${order.assignmentId || ''}`, type: 'problem-open', title: '订单有待处理的问题', body: '订单已暂停打手操作，由后台客服处理；可查看问题及处理记录。', orderId: order.id, href: playerTarget(order.id), timestamp, index,
            target: { dispatchRound: order.dispatchRound, assignmentId: order.assignmentId, submissionId: null, problemId: order.problem.id } })
        }
      } else if (order.problem?.status === 'closed' && old?.problem?.status === 'open' && old.problem.id === order.problem.id) {
        for (const userId of related) insert({ userId, key: `problem-closed:${order.problem.id}`, type: 'problem-closed', title: '问题单已由后台确认关闭', body: '请查看处理结果与原订单状态。', orderId: order.id, href: playerTarget(order.id), timestamp, index,
          target: { dispatchRound: order.dispatchRound, assignmentId: order.assignmentId, submissionId: null, problemId: order.problem.id } })
      }
      for (const request of order.returnRequests || []) {
        const oldRequest = old?.returnRequests?.find((row) => row.id === request.id)
        if (
          ['approved', 'rejected'].includes(request.status) &&
          oldRequest?.status !== request.status
        )
          insert({
            userId: request.leaderId,
            key: `return:${request.id}:${request.status}`,
            type: 'return-result',
            title: request.status === 'approved' ? '退单申请已批准' : '退单申请被驳回',
            body:
              request.status === 'approved'
                ? '订单已交回客服，你可以查看处理记录。'
                : '请继续执行订单，并查看处理说明。',
            orderId: order.id,
            target: {
              dispatchRound: request.dispatchRound,
              assignmentId: request.assignmentId,
              submissionId: null
            },
            href: playerTarget(order.id),
            timestamp,
            index
          })
      }
      if (
        old &&
        old.status !== order.status &&
        ['active', 'review', 'completed', 'canceled'].includes(order.status)
      )
        for (const userId of new Set(
          [order.leaderId, order.teammateId, old.leaderId, old.teammateId].filter(Boolean)
        ))
          insert({
            userId,
            key: `status:${order.id}:${order.revision || randomUUID()}:${order.status}`,
            type: 'order-result',
            title: '任务状态已更新',
            body: '打开任务查看最新状态与处理记录。',
            orderId: order.id,
            target: {
              dispatchRound: order.dispatchRound,
              assignmentId: order.assignmentId || old.assignmentId,
              submissionId:
                ['review', 'completed'].includes(order.status) || old.status === 'review'
                  ? order.submissionId || old.submissionId
                  : null
            },
            href: playerTarget(order.id),
            timestamp,
            index
          })
    }
    for (const userId of affectedUsers)
      invalidateRows(
        db
          .prepare(
            "SELECT * FROM player_notifications WHERE user_id=? AND type IN ('pool','assigned','assignment-timeout') AND invalidated_at IS NULL"
          )
          .all(userId),
        index,
        timestamp
      )
    const oldWithdrawals = new Map(before.withdrawals.map((row) => [row.id, row]))
    for (const withdrawal of after.withdrawals) {
      const old = oldWithdrawals.get(withdrawal.id)
      if (old && old.status !== withdrawal.status)
        insert({
          userId: withdrawal.userId,
          key: `withdrawal:${withdrawal.id}:${withdrawal.status}`,
          type: 'withdrawal-result',
          title: '提现处理结果已更新',
          body:
            withdrawal.status === 'paid'
              ? '财务已登记发放，请核对实际到账。'
              : '请查看提现记录中的状态与处理说明。',
          href: '/#/player/withdrawals',
          timestamp,
          index
        })
    }
  }
  // Startup backfills legacy candidates once. Periodic scans use only the durable due index.
  transaction(() => {
    const snapshot = state(),
      index = indexed(snapshot),
      timestamp = now()
    for (const order of snapshot.orders) schedule(order, snapshot, timestamp)
    for (const row of db
      .prepare(
        "SELECT * FROM player_notifications WHERE validity_json IS NULL AND type IN ('pool','assigned','assignment-timeout')"
      )
      .all()) {
      const order = index.orders.get(row.order_id)
      const stamp =
        order && (row.type === 'pool' ? order.publishedAt : order.assignedAt || order.publishedAt)
      const matches = Boolean(
        order &&
          row.event_key.endsWith(stamp) &&
          (row.type === 'pool' || row.event_key.includes(`:${order.assignedTo}:`))
      )
      if (matches)
        db.prepare('UPDATE player_notifications SET validity_json=? WHERE id=?').run(
          JSON.stringify(validity(row.type, order)),
          row.id
        )
      else invalidate('id=?', [row.id], timestamp)
    }
    for (const row of db
      .prepare(
        'SELECT o.id,o.created_at,n.created_at AS notice_created_at,n.type FROM player_push_outbox o LEFT JOIN player_notifications n ON n.id=o.notification_id WHERE o.created_at IS NULL OR o.expires_at IS NULL'
      )
      .all()) {
      const createdAt = row.created_at || row.notice_created_at || timestamp
      const lifetime = reminderTypes.includes(row.type) ? reminderLifetimeMs : historyPushLifetimeMs
      db.prepare(
        'UPDATE player_push_outbox SET created_at=COALESCE(created_at,?),expires_at=COALESCE(expires_at,?) WHERE id=?'
      ).run(createdAt, new Date(Date.parse(createdAt) + lifetime).toISOString(), row.id)
    }
    invalidateRows(
      db
        .prepare(
          "SELECT * FROM player_notifications WHERE invalidated_at IS NULL AND type IN ('pool','assigned','assignment-timeout')"
        )
        .all(),
      index,
      timestamp
    )
  })
  const scanTimeouts = ({ limit = scanBatchSize } = {}) =>
    transaction(() => {
      const timestamp = now(),
        index = indexed(state())
      const budget = Math.min(500, Math.max(1, Math.trunc(Number(limit) || scanBatchSize)))
      const candidates = db
        .prepare(
          "SELECT * FROM player_notification_candidates WHERE status='pending' AND due_at<=? ORDER BY due_at,event_key LIMIT ?"
        )
        .all(timestamp, Math.min(20, budget))
      const preferences = new Map(
        db
          .prepare('SELECT * FROM player_notification_settings')
          .all()
          .map((row) => [row.user_id, row])
      )
      let processed = 0,
        completed = 0,
        inserted = 0
      for (const candidate of candidates) {
        if (processed >= budget) break
        const order = index.orders.get(candidate.order_id)
        if (
          !order || !playerOrderExecutable(index.snapshot, order) ||
          candidate.dispatch_token !== dispatchToken(order) ||
          order.status !== 'pending' ||
          order.dispatchState === 'unassigned' ||
          order.leaderId
        ) {
          db.prepare(
            "UPDATE player_notification_candidates SET status='obsolete' WHERE event_key=?"
          ).run(candidate.event_key)
          completed++
          continue
        }
        if (candidate.type === 'pool') {
          const level = index.snapshot.levels.find((row) => row.id === candidate.level_id)
          if (!level) {
            db.prepare(
              "UPDATE player_notification_candidates SET status='obsolete' WHERE event_key=?"
            ).run(candidate.event_key)
            completed++
            continue
          }
          const opensAt = new Date(
            Date.parse(order.publishedAt) + level.delaySeconds * 1000
          ).toISOString()
          if (opensAt > timestamp) {
            db.prepare('UPDATE player_notification_candidates SET due_at=? WHERE event_key=?').run(
              opensAt,
              candidate.event_key
            )
            continue
          }
        }
        const recipients = index.snapshot.users
          .filter(
            (user) =>
              user.id > candidate.cursor &&
              (candidate.type === 'pool'
                ? user.role === 'player' && user.levelId === candidate.level_id
                : user.role !== 'player' && permissionsFor(user).includes('orders.edit'))
          )
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const batch = recipients.slice(0, budget - processed)
        for (const user of batch) {
          processed++
          if (
            candidate.type === 'pool' &&
            (!preferences.get(user.id)?.pool || !eligible(index, user, order, timestamp))
          )
            continue
          const created = insert({
            userId: user.id,
            key: `${candidate.type}:${candidate.dispatch_token}`,
            type: candidate.type,
            title: candidate.type === 'pool' ? '接单大厅有新订单' : '指定订单超过 5 分钟未接受',
            body:
              candidate.type === 'pool'
                ? '打开大厅查看当前可接订单。'
                : `订单 ${order.orderNo} 仍待接受，请核实后决定是否重新分配。`,
            orderId: order.id,
            href:
              candidate.type === 'pool'
                ? '/#/player/lobby'
                : `/#/orders/list?id=${encodeURIComponent(order.id)}`,
            timestamp,
            index
          })
          if (created) inserted++
        }
        const done = batch.length === recipients.length
        db.prepare(
          'UPDATE player_notification_candidates SET cursor=?,status=? WHERE event_key=?'
        ).run(batch.at(-1)?.id || candidate.cursor, done ? 'done' : 'pending', candidate.event_key)
        if (done) completed++
      }
      return {
        processed,
        completed,
        inserted,
        remaining: db
          .prepare(
            "SELECT COUNT(*) AS count FROM player_notification_candidates WHERE status='pending'"
          )
          .get().count
      }
    })
  const validateSubscription = (subscription) => {
    if (!subscription || typeof subscription !== 'object') fail('推送订阅无效')
    let endpoint
    try {
      endpoint = new URL(subscription.endpoint)
    } catch {
      fail('推送订阅地址无效')
    }
    const host = endpoint.hostname.toLowerCase()
    const permitted = [
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'web.push.apple.com',
      'wns.windows.com',
      ...allowedPushHosts
    ]
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.port ||
      endpoint.hash ||
      !permitted.some(
        (value) =>
          host === value ||
          (value === 'web.push.apple.com' && host.endsWith('.push.apple.com')) ||
          (value === 'wns.windows.com' && host.endsWith('.wns.windows.com'))
      )
    )
      fail('不支持此浏览器的推送服务地址')
    if (endpoint.href.length > 4096) fail('推送订阅地址过长')
    const keys = subscription.keys
    if (
      !keys ||
      !/^[A-Za-z0-9_-]+$/.test(keys.p256dh || '') ||
      !/^[A-Za-z0-9_-]+$/.test(keys.auth || '') ||
      Buffer.from(keys.p256dh, 'base64url').length !== 65 ||
      Buffer.from(keys.auth, 'base64url').length !== 16
    )
      fail('推送订阅密钥无效')
    return { endpoint: endpoint.href, keys: { p256dh: keys.p256dh, auth: keys.auth } }
  }
  const markRead = (userId, notificationId) => {
    if (
      !db
        .prepare('SELECT id FROM player_notifications WHERE id=? AND user_id=?')
        .get(notificationId, userId)
    )
      fail('消息不存在', 404)
    db.prepare(
      'UPDATE player_notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?'
    ).run(now(), notificationId, userId)
    return { ok: true }
  }
  const mutate = ({ state: snapshot, user, path, body, audit }) => {
    const userId = user.id
    if (path === '/player/notification-settings') {
      if (typeof body.pool !== 'boolean' || typeof body.push !== 'boolean')
        fail('通知开关必须为布尔值')
      const before = settings(userId)
      db.prepare(
        'INSERT INTO player_notification_settings(user_id,pool,push) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET pool=excluded.pool,push=excluded.push'
      ).run(userId, +body.pool, +body.push)
      if (!body.pool) invalidate("user_id=? AND type='pool'", [userId], now(), '公共池提醒已关闭')
      if (!body.push)
        for (const row of db
          .prepare('SELECT id FROM player_push_subscriptions WHERE user_id=?')
          .all(userId))
          skipBinding(row.id, '网页推送已关闭')
      audit('修改通知设置', 'player-notification', userId, before, {
        pool: body.pool,
        push: body.push
      })
      return settings(userId)
    }
    if (path === '/player/push-subscriptions') {
      if (!configured) fail('服务器尚未配置网页推送，站内消息仍可使用', 503)
      const subscription = validateSubscription(body.subscription),
        hash = digest(subscription.endpoint)
      const count = db
        .prepare('SELECT COUNT(*) AS count FROM player_push_subscriptions WHERE user_id=?')
        .get(userId).count
      const existing = db
        .prepare('SELECT * FROM player_push_subscriptions WHERE endpoint_hash=?')
        .get(hash)
      if ((!existing || existing.user_id !== userId) && count >= 5)
        fail('每个账号最多绑定 5 个通知设备')
      if (existing?.user_id === userId)
        db.prepare(
          'UPDATE player_push_subscriptions SET subscription_json=? WHERE id=? AND user_id=?'
        ).run(JSON.stringify(subscription), existing.id, userId)
      else {
        if (existing) {
          skipBinding(existing.id, '通知设备已更换账号')
          db.prepare('DELETE FROM player_push_subscriptions WHERE id=?').run(existing.id)
        }
        db.prepare(
          'INSERT INTO player_push_subscriptions(id,user_id,endpoint_hash,subscription_json,created_at) VALUES(?,?,?,?,?)'
        ).run(randomUUID(), userId, hash, JSON.stringify(subscription), now())
      }
      audit('绑定通知设备', 'player-notification', userId, null, { subscribed: true })
      return { ok: true }
    }
    if (path === '/player/push-subscriptions/remove') {
      if (typeof body.endpoint !== 'string') fail('请提供当前设备地址')
      const row = db
        .prepare('SELECT id FROM player_push_subscriptions WHERE endpoint_hash=? AND user_id=?')
        .get(digest(body.endpoint), userId)
      if (row) {
        skipBinding(row.id, '通知设备已解绑')
        db.prepare('DELETE FROM player_push_subscriptions WHERE id=?').run(row.id)
      }
      audit('解除通知设备', 'player-notification', userId, null, { subscribed: false })
      return { ok: true }
    }
    if (path === '/player/push-subscriptions/test') {
      if (
        !configured ||
        !db.prepare('SELECT id FROM player_push_subscriptions WHERE user_id=?').get(userId)
      )
        fail('请先启用当前设备的网页推送')
      insert({
        userId,
        key: `test:${randomUUID()}`,
        type: 'test',
        title: '通知测试',
        body: '这是网页推送测试。实际到达情况请在你的手机上核对。',
        index: indexed(snapshot)
      })
      return { ok: true, message: '测试提醒已排队，是否收到请以设备实际显示为准' }
    }
    if (path === '/player/notifications/read-all') {
      db.prepare(
        'UPDATE player_notifications SET read_at=? WHERE user_id=? AND read_at IS NULL'
      ).run(now(), userId)
      return { ok: true }
    }
    const match = path.match(/^\/player\/notifications\/([^/]+)\/read$/)
    if (match) return markRead(userId, match[1])
  }
  const unreadCount = (userId, playerOnly = true) => {
    getUser(userId, playerOnly)
    return db
      .prepare(
        'SELECT COUNT(*) AS count FROM player_notifications WHERE user_id=? AND read_at IS NULL AND invalidated_at IS NULL'
      )
      .get(userId).count
  }
  // Internal summary getters: HTTP routes must supply the currently authenticated user's own ID.
  // They intentionally avoid parsing studio_state again and expose no message payload.
  const changeVersion = (userId) =>
    db.prepare('SELECT revision FROM player_notification_versions WHERE user_id=?').get(userId)
      ?.revision || 0
  const summary = (userId) => ({
    version: changeVersion(userId),
    unreadCount: db
      .prepare(
        'SELECT COUNT(*) AS count FROM player_notifications WHERE user_id=? AND read_at IS NULL AND invalidated_at IS NULL'
      )
      .get(userId).count
  })
  const list = (userId, query = {}, playerOnly = true) => {
    getUser(userId, playerOnly)
    const { current, size } = pagination(query)
    return {
      records: db
        .prepare(
          'SELECT * FROM player_notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?'
        )
        .all(userId, size, (current - 1) * size)
        .map(publicNotice),
      total: db
        .prepare('SELECT COUNT(*) AS count FROM player_notifications WHERE user_id=?')
        .get(userId).count,
      unread: db
        .prepare(
          'SELECT COUNT(*) AS count FROM player_notifications WHERE user_id=? AND read_at IS NULL AND invalidated_at IS NULL'
        )
        .get(userId).count,
      current,
      size
    }
  }
  const detail = (userId, notificationId) => {
    const snapshot = state()
    getUser(userId, true, snapshot)
    const row = db
      .prepare('SELECT * FROM player_notifications WHERE id=? AND user_id=?')
      .get(notificationId, userId)
    if (!row) fail('消息不存在', 404)
    const timestamp = now()
    // Current validity is a read projection. Merely opening a historical message
    // does not mark it read, mutate the outbox, or confer current order access.
    return publicNotice({
      ...row,
      invalidated_at:
        row.invalidated_at || (isValid(row, indexed(snapshot), timestamp) ? null : timestamp)
    })
  }
  const bindingStatus = (userId, query = {}) => {
    getUser(userId)
    const { endpointHash, subscriptionHash } = query,
      hasEndpoint = endpointHash !== undefined,
      hasSubscription = subscriptionHash !== undefined
    if (
      hasEndpoint !== hasSubscription ||
      (hasEndpoint &&
        (!/^[a-f0-9]{64}$/.test(endpointHash) || !/^[a-f0-9]{64}$/.test(subscriptionHash)))
    )
      fail('设备订阅指纹无效')
    let status = configured ? 'unbound' : 'unconfigured'
    if (configured && hasEndpoint) {
      // Owner-qualified lookup deliberately makes another account's binding
      // indistinguishable from absent/revoked bindings.
      const row = db
        .prepare(
          'SELECT subscription_json FROM player_push_subscriptions WHERE endpoint_hash=? AND user_id=?'
        )
        .get(endpointHash, userId)
      if (row) {
        const subscription = parsedObject(row.subscription_json)
        let normalized
        try {
          normalized = subscription && {
            endpoint: new URL(subscription.endpoint).href,
            keys: { p256dh: subscription.keys?.p256dh, auth: subscription.keys?.auth }
          }
        } catch {
          normalized = null
        }
        status =
          normalized && digest(JSON.stringify(normalized)) === subscriptionHash ? 'valid' : 'invalid'
      }
    }
    return { configured, status, pushEnabled: settings(userId).push }
  }
  const listStaffTimeouts = (userId, query = {}) => {
    const user = getUser(userId, false)
    if (user.role === 'player') fail('没有查看指派超时的权限', 403)
    const { current, size } = pagination(query)
    // Filter first, then count and page: historical rows cannot evict active timeout alerts.
    const where = `n.user_id=? AND n.type='assignment-timeout' AND n.read_at IS NULL AND n.invalidated_at IS NULL AND
      EXISTS(SELECT 1 FROM studio_state s,json_each(s.json,'$.orders') o WHERE s.id=1 AND
      json_extract(o.value,'$.id')=n.order_id AND json_extract(o.value,'$.status')='pending' AND
      json_extract(o.value,'$.dispatchMode')='direct' AND COALESCE(json_extract(o.value,'$.dispatchState'),'ready')<>'unassigned' AND
      json_extract(o.value,'$.assignedTo')=json_extract(n.validity_json,'$.assignedTo') AND
      COALESCE(json_extract(o.value,'$.dispatchRound'),1)=json_extract(n.validity_json,'$.dispatchRound') AND
      COALESCE(json_extract(o.value,'$.assignedAt'),json_extract(o.value,'$.publishedAt'))<=?)`
    const timestamp = new Date(Date.parse(now()) - 300_000).toISOString()
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM player_notifications n WHERE ${where}`)
      .get(userId, timestamp).count
    return {
      records: db
        .prepare(
          `SELECT n.* FROM player_notifications n WHERE ${where} ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`
        )
        .all(userId, timestamp, size, (current - 1) * size)
        .map(publicNotice),
      total,
      unread: total,
      current,
      size
    }
  }
  const queueStats = () => {
    const timestamp = now()
    const statuses = Object.fromEntries(
      db
        .prepare('SELECT status,COUNT(*) AS count FROM player_push_outbox GROUP BY status')
        .all()
        .map((row) => [row.status, row.count])
    )
    const waiting = db
      .prepare(
        "SELECT MIN(created_at) AS oldest,COUNT(*) AS due FROM player_push_outbox WHERE status='pending' AND next_at<=?"
      )
      .get(timestamp)
    const wait = db
      .prepare(
        'SELECT AVG(MAX(0,(julianday(claimed_at)-julianday(created_at))*86400000)) AS average,MAX(MAX(0,(julianday(claimed_at)-julianday(created_at))*86400000)) AS maximum FROM player_push_outbox WHERE claimed_at IS NOT NULL'
      )
      .get()
    return {
      snapshotAt: timestamp,
      statuses,
      pending: statuses.pending || 0,
      processing: statuses.processing || 0,
      due: waiting.due,
      oldestPendingAt: waiting.oldest || null,
      oldestDueAt: waiting.oldest || null,
      oldestDueWaitMs: waiting.oldest
        ? Math.max(0, Date.parse(timestamp) - Date.parse(waiting.oldest))
        : 0,
      oldestWaitingMs: waiting.oldest
        ? Math.max(0, Date.parse(timestamp) - Date.parse(waiting.oldest))
        : 0,
      averageQueueWaitMs: Math.round(wait.average || 0),
      meanQueueWaitMs: Math.round(wait.average || 0),
      maxQueueWaitMs: Math.round(wait.maximum || 0),
      candidateBacklog: db
        .prepare(
          "SELECT COUNT(*) AS count FROM player_notification_candidates WHERE status='pending'"
        )
        .get().count
    }
  }
  const claimPush = () =>
    transaction(() => {
      const timestamp = now()
      db.prepare(
        "UPDATE player_push_outbox SET status='expired',last_error='提醒发送已过期',lease_token=NULL,lease_until=NULL WHERE status IN ('pending','processing') AND expires_at<=?"
      ).run(timestamp)
      db.prepare(
        "UPDATE player_push_outbox SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='processing' AND lease_until<=? AND attempts<?"
      ).run(timestamp, maxAttempts)
      db.prepare(
        "UPDATE player_push_outbox SET status='failed',last_error='发送租约超时且已达重试上限',lease_token=NULL,lease_until=NULL WHERE status='processing' AND lease_until<=? AND attempts>=?"
      ).run(timestamp, maxAttempts)
      db.prepare(
        "UPDATE player_push_outbox SET status='skipped',last_error='消息或订阅已不存在' WHERE status='pending' AND (NOT EXISTS(SELECT 1 FROM player_push_subscriptions s WHERE s.id=subscription_id) OR NOT EXISTS(SELECT 1 FROM player_notifications n WHERE n.id=notification_id))"
      ).run()
      const rows = db
        .prepare(
          "SELECT * FROM player_push_outbox WHERE status='pending' AND next_at<=? ORDER BY next_at,id LIMIT ?"
        )
        .all(timestamp, Math.max(1, Math.min(100, sendBatchSize)))
      for (const row of rows) {
        row.leaseToken = randomUUID()
        db.prepare(
          "UPDATE player_push_outbox SET status='processing',attempts=attempts+1,lease_token=?,lease_until=?,claimed_at=? WHERE id=? AND status='pending'"
        ).run(
          row.leaseToken,
          new Date(Date.parse(timestamp) + Math.max(15_000, leaseMs)).toISOString(),
          timestamp,
          row.id
        )
      }
      return rows
    })
  let sending = false,
    closed = false
  const flushPush = async () => {
    if (closed || sending || !configured) return { claimed: 0, sent: 0 }
    sending = true
    let sent = 0
    try {
      const rows = claimPush()
      let cursor = 0
      const send = async () => {
        while (!closed && cursor < rows.length) {
          const row = rows[cursor++]
          // Fresh validity check immediately before network I/O. No write lock spans await.
          const subscription = transaction(() => {
            const owned = db
              .prepare(
                "SELECT * FROM player_push_outbox WHERE id=? AND status='processing' AND lease_token=?"
              )
              .get(row.id, row.leaseToken)
            if (!owned) return null
            if (owned.expires_at <= now()) {
              db.prepare(
                "UPDATE player_push_outbox SET status='expired',last_error='提醒发送已过期',lease_token=NULL,lease_until=NULL WHERE id=? AND status='processing' AND lease_token=?"
              ).run(row.id, row.leaseToken)
              return null
            }
            const notice = db
              .prepare('SELECT * FROM player_notifications WHERE id=?')
              .get(row.notification_id)
            const binding = db
              .prepare('SELECT * FROM player_push_subscriptions WHERE id=?')
              .get(row.subscription_id)
            const index = indexed(state()),
              user = notice && index.users.get(notice.user_id)
            if (
              !notice ||
              !binding ||
              binding.user_id !== notice.user_id ||
              !user ||
              user.role !== 'player' ||
              user.status !== 'active' ||
              !playerAccess(user).login ||
              !settings(user.id).push ||
              !isValid(notice, index, now())
            ) {
              db.prepare(
                "UPDATE player_push_outbox SET status='skipped',last_error='提醒或账号状态已失效',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?"
              ).run(row.id, row.leaseToken)
              if (notice && reminderTypes.includes(notice.type))
                invalidate('id=?', [notice.id], now())
              return null
            }
            // Earlier rows may have waited for network responses. Renew at the actual send boundary,
            // rather than keeping the shared batch-claim deadline for a newly starting request.
            db.prepare(
              "UPDATE player_push_outbox SET lease_until=? WHERE id=? AND status='processing' AND lease_token=?"
            ).run(new Date(Date.parse(now()) + leaseMs).toISOString(), row.id, row.leaseToken)
            return JSON.parse(binding.subscription_json)
          })
          if (!subscription) continue
          try {
            await pushSender(
              subscription,
              JSON.stringify({
                title: '工作室有新的消息',
                body: '打开打手端查看当前账号的消息。',
                url: '/#/player/messages'
              }),
              {
                TTL: 300,
                timeout: 5000,
                urgency: 'high',
                vapidDetails: { subject, publicKey, privateKey }
              }
            )
            if (!closed) {
              const result = db
                .prepare(
                  "UPDATE player_push_outbox SET status='sent',sent_at=?,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND status='processing' AND lease_token=?"
                )
                .run(now(), row.id, row.leaseToken)
              sent += result.changes
            }
          } catch (error) {
            if (closed) break
            const permanent = [404, 410].includes(error.statusCode)
            transaction(() => {
              db.prepare(
                "UPDATE player_push_outbox SET status=?,next_at=?,last_error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='processing' AND lease_token=?"
              ).run(
                permanent || row.attempts + 1 >= maxAttempts ? 'failed' : 'pending',
                new Date(Date.parse(now()) + 60_000 * (row.attempts + 1)).toISOString(),
                permanent ? '订阅已失效' : '推送服务发送失败',
                row.id,
                row.leaseToken
              )
              if (permanent) {
                skipBinding(row.subscription_id, '订阅已失效')
                db.prepare('DELETE FROM player_push_subscriptions WHERE id=?').run(
                  row.subscription_id
                )
              }
            })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.max(1, Math.min(5, sendConcurrency)) }, send))
      return { claimed: rows.length, sent }
    } finally {
      sending = false
    }
  }
  return {
    onTransaction,
    mutate,
    scanTimeouts,
    flushPush,
    revoke,
    list,
    detail,
    bindingStatus,
    unreadCount,
    changeVersion,
    summary,
    listStaffTimeouts,
    queueStats,
    settings(userId) {
      getUser(userId)
      return settings(userId)
    },
    config(userId) {
      getUser(userId)
      return {
        enabled: configured,
        configured,
        publicKey: configured ? publicKey : '',
        reason: configured ? '' : '服务器尚未配置网页推送；站内消息正常可用'
      }
    },
    readStaff(userId, notificationId) {
      getUser(userId, false)
      return transaction(() => markRead(userId, notificationId))
    },
    deliveryStatus(userId) {
      const user = getUser(userId, false)
      if (user.role === 'player') fail('没有查看发送状态的权限', 403)
      return db
        .prepare(
          'SELECT o.status,COUNT(*) AS count FROM player_push_outbox o JOIN player_notifications n ON n.id=o.notification_id WHERE n.order_id IN (SELECT order_id FROM player_notifications WHERE user_id=?) GROUP BY o.status'
        )
        .all(userId)
    },
    close() {
      closed = true
    }
  }
}
