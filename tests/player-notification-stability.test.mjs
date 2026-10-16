import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, createECDH } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import webpush from 'web-push'
import { createPlayerNotifications } from '../server/player-notifications.mjs'
import { createStudioServer } from '../server/index.mjs'

const timeZero = '2026-10-14T00:00:00.000Z'
const player = (id, extra = {}) => ({
  id,
  role: 'player',
  name: id,
  status: 'active',
  maxActiveOrders: 1,
  levelId: 'level',
  playerAccess: { login: true, claim: true, withdraw: true },
  ...extra
})
const order = (id, extra = {}) => ({
  id,
  orderNo: id,
  revision: 1,
  dispatchRound: 1,
  status: 'pending',
  dispatchMode: 'pool',
  dispatchState: 'ready',
  publishedAt: timeZero,
  createdAt: timeZero,
  leaderId: null,
  assignedTo: null,
  assignments: [],
  submissions: [],
  returnRequests: [],
  ...extra
})
const subscription = (suffix = '') => {
  const key = createECDH('prime256v1')
  key.generateKeys()
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/test-${suffix}`,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url')
    }
  }
}
function fixture(t, options = {}) {
  let time = Date.parse(timeZero)
  const db = new DatabaseSync(options.dbPath || ':memory:')
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; CREATE TABLE studio_state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)'
  )
  const initial = {
    users: [
      player('player-a'),
      player('player-b'),
      { id: 'support', role: 'support', status: 'active' }
    ],
    orders: [],
    levels: [{ id: 'level', delaySeconds: 0 }],
    withdrawals: [],
    passwords: {}
  }
  db.prepare('INSERT INTO studio_state VALUES(1,?)').run(JSON.stringify(initial))
  const sent = []
  const config = {
    ...webpush.generateVAPIDKeys(),
    clock: () => new Date(time),
    subject: 'mailto:notification-test@example.com',
    pushSender:
      options.pushSender ||
      (async (binding, payload) => {
        sent.push({ binding, payload })
      }),
    sendConcurrency: options.sendConcurrency || 1,
    ...options.notificationOptions
  }
  const notifications = createPlayerNotifications(db, config)
  t.after(() => {
    notifications.close()
    if (db.isOpen) db.close()
  })
  const snapshot = () =>
    JSON.parse(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const before = snapshot(),
        after = structuredClone(before)
      const result = fn(after)
      notifications.onTransaction({
        state: after,
        beforeState: before,
        now: new Date(time).toISOString()
      })
      db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(after))
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const mutate = (path, body, userId = 'player-a') =>
    tx((state) =>
      notifications.mutate({
        state,
        user: state.users.find((user) => user.id === userId),
        path,
        body,
        audit() {}
      })
    )
  const enable = (id = 'player-a') =>
    mutate('/player/notification-settings', { pool: true, push: true }, id)
  const bind = (id = 'player-a', value = subscription(id)) => {
    mutate('/player/push-subscriptions', { subscription: value }, id)
    return value
  }
  return {
    db,
    notifications,
    snapshot,
    tx,
    mutate,
    enable,
    bind,
    sent,
    config,
    advance(ms) {
      time += ms
    }
  }
}

test('公共池提醒采用服务端接单资格，名额/等级/接单开关/通知设置均有效', (t) => {
  const f = fixture(t)
  f.enable()
  f.enable('player-b')
  f.tx((state) => {
    state.users[1].playerAccess.claim = false
    state.users.push(
      player('full'),
      player('delayed', { levelId: 'delayed' }),
      player('no-preference')
    )
    state.levels.push({ id: 'delayed', delaySeconds: 60 })
  })
  f.enable('full')
  f.enable('delayed')
  f.tx((state) => {
    state.orders.push(order('busy', { status: 'active', leaderId: 'full' }), order('pool'))
  })
  const first = f.notifications.scanTimeouts()
  assert.equal(first.inserted, 1)
  assert.equal(f.notifications.unreadCount('player-a'), 1)
  assert.equal(f.notifications.unreadCount('player-b'), 0)
  assert.equal(f.notifications.unreadCount('full'), 0)
  assert.equal(f.notifications.unreadCount('delayed'), 0)
  assert.equal(f.notifications.unreadCount('no-preference'), 0)
  f.advance(60_000)
  assert.equal(f.notifications.scanTimeouts().inserted, 1)
  assert.equal(f.notifications.unreadCount('delayed'), 1)
})

test('取消/重新派单/关闭提醒使旧新单推送失效，历史资金消息保留', async (t) => {
  const f = fixture(t)
  f.enable()
  f.bind()
  f.tx((state) => {
    state.orders.push(order('pool'))
  })
  f.notifications.scanTimeouts()
  f.tx((state) => {
    state.orders[0].status = 'canceled'
    state.orders[0].revision++
  })
  await f.notifications.flushPush()
  assert.equal(f.sent.length, 0)
  assert.equal(f.notifications.unreadCount('player-a'), 0)
  f.tx((state) => {
    state.orders[0] = order('pool', { dispatchRound: 2, revision: 3 })
  })
  f.notifications.scanTimeouts()
  f.mutate('/player/notification-settings', { pool: false, push: true })
  await f.notifications.flushPush()
  assert.equal(f.sent.length, 0)
  f.tx((state) => {
    state.withdrawals.push({ id: 'money', userId: 'player-a', status: 'pending' })
  })
  f.tx((state) => {
    state.withdrawals[0].status = 'paid'
  })
  await f.notifications.flushPush()
  assert.equal(f.sent.length, 1)
  assert.equal(
    f.notifications.list('player-a').records.find((row) => row.type === 'withdrawal-result')
      .invalidatedAt,
    null
  )
})

test('发送前再次裁决资格，等待中的打手达到上限或停用后不发送公共池提醒', async (t) => {
  const f = fixture(t)
  f.enable()
  f.bind()
  f.tx((state) => {
    state.orders.push(order('pool'))
  })
  f.notifications.scanTimeouts()
  // Simulates another successful business transaction before the outbox worker runs.
  f.tx((state) => {
    state.orders.push(order('other', { status: 'active', leaderId: 'player-a' }))
  })
  await f.notifications.flushPush()
  assert.equal(f.sent.length, 0)
  assert.equal(f.notifications.unreadCount('player-a'), 0)
  f.tx((state) => {
    state.orders[1].status = 'completed'
    state.orders.push(order('new'))
  })
  f.notifications.scanTimeouts()
  f.tx((state) => {
    state.users[0].status = 'disabled'
  })
  await f.notifications.flushPush()
  assert.equal(f.sent.length, 0)
})

test('同账号同设备重绑保留原订阅及有效待发任务，换账号不会继承', async (t) => {
  const f = fixture(t),
    value = f.bind()
  f.mutate('/player/push-subscriptions/test', {})
  const before = f.db.prepare('SELECT * FROM player_push_subscriptions').get()
  f.bind('player-a', value)
  assert.equal(f.db.prepare('SELECT id FROM player_push_subscriptions').get().id, before.id)
  assert.equal(f.notifications.queueStats().pending, 1)
  await f.notifications.flushPush()
  assert.equal(f.sent.length, 1)
  f.mutate('/player/push-subscriptions/test', {})
  f.bind('player-b', value)
  await f.notifications.flushPush()
  assert.equal(f.sent.length, 1)
  assert.equal(f.notifications.queueStats().pending, 0)
  f.mutate('/player/push-subscriptions/test', {}, 'player-b')
  await f.notifications.flushPush()
  assert.equal(f.sent.length, 2)
})

test('隔离磁盘库两个发送器原子领取，不重复领取正在处理的租约，网络发送不持有写锁', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-notification-stability-'))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let enteredResolve
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  let calls = 0
  const f = fixture(t, {
    dbPath: join(directory, 'isolated.sqlite'),
    pushSender: async () => {
      calls++
      enteredResolve()
      await gate
    }
  })
  const secondDb = new DatabaseSync(join(directory, 'isolated.sqlite'))
  secondDb.exec('PRAGMA busy_timeout=1000')
  const second = createPlayerNotifications(secondDb, f.config)
  t.after(() => {
    second.close()
    secondDb.close()
    if (f.db.isOpen) f.db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  f.bind()
  f.mutate('/player/push-subscriptions/test', {})
  const running = f.notifications.flushPush()
  await entered
  assert.equal(f.notifications.queueStats().processing, 1)
  assert.deepEqual(await second.flushPush(), { claimed: 0, sent: 0 })
  // A different connection can commit while the external service has not responded.
  secondDb.exec('BEGIN IMMEDIATE; COMMIT')
  release()
  await running
  assert.equal(calls, 1)
  assert.equal(f.db.prepare('SELECT attempts,status FROM player_push_outbox').get().attempts, 1)
  assert.equal(f.notifications.queueStats().statuses.sent, 1)
})

test('推送租约过期可重新领取，失败有有限重试，已过期的提醒不再外发', async (t) => {
  let calls = 0
  const f = fixture(t, {
    pushSender: async () => {
      calls++
      throw new Error('test-service-failure')
    }
  })
  f.bind()
  f.mutate('/player/push-subscriptions/test', {})
  await f.notifications.flushPush()
  assert.equal(calls, 1)
  assert.equal(f.notifications.queueStats().pending, 1)
  await f.notifications.flushPush()
  assert.equal(calls, 1)
  f.advance(60_000)
  await f.notifications.flushPush()
  assert.equal(calls, 2)
  f.advance(120_000)
  await f.notifications.flushPush()
  assert.equal(calls, 3)
  assert.equal(f.notifications.queueStats().statuses.failed, 1)
  f.mutate('/player/push-subscriptions/test', {})
  f.db
    .prepare(
      "UPDATE player_push_outbox SET status='processing',lease_token='crashed',lease_until=?,attempts=1 WHERE status='pending'"
    )
    .run(timeZero)
  await f.notifications.flushPush()
  assert.equal(calls, 4)
  f.advance(24 * 60 * 60_000)
  await f.notifications.flushPush()
  assert.equal(calls, 4)
  assert.equal(f.notifications.queueStats().statuses.expired, 1)
})

test('有效未读指派超时先过滤后计数分页，不被最新100条历史消息挤掉', (t) => {
  const f = fixture(t)
  f.tx((state) => {
    state.orders.push(
      order('direct-a', { dispatchMode: 'direct', assignedTo: 'player-a', assignedAt: timeZero }),
      order('direct-b', { dispatchMode: 'direct', assignedTo: 'player-b', assignedAt: timeZero })
    )
  })
  f.advance(300_000)
  f.notifications.scanTimeouts()
  const insert = f.db.prepare(
    'INSERT INTO player_notifications(id,user_id,event_key,type,title,body,href,created_at) VALUES(?,?,?,?,?,?,?,?)'
  )
  for (let i = 0; i < 150; i++)
    insert.run(
      `history-${i}`,
      'support',
      `history-${i}`,
      'order-result',
      '历史',
      '',
      '/#/orders/list',
      '2026-10-14T01:00:00.000Z'
    )
  assert.equal(
    f.notifications
      .list('support', { size: 100 }, false)
      .records.every((row) => row.type === 'order-result'),
    true
  )
  const result = f.notifications.listStaffTimeouts('support', { current: 1, size: 1 })
  assert.equal(result.total, 2)
  assert.equal(result.records.length, 1)
  assert.equal(
    f.notifications.listStaffTimeouts('support', { current: 2, size: 1 }).records.length,
    1
  )
  f.notifications.readStaff('support', result.records[0].id)
  assert.equal(f.notifications.listStaffTimeouts('support').total, 1)
  assert.throws(
    () => f.notifications.listStaffTimeouts('player-a'),
    (error) => error.status === 403
  )
})

test('通知候选按事件、开放时间和游标分批，处理预算限制每次事务工作', (t) => {
  const f = fixture(t)
  f.tx((state) => {
    for (let i = 0; i < 20; i++) state.users.push(player(`batch-${String(i).padStart(2, '0')}`))
  })
  for (const user of f.snapshot().users.filter((row) => row.role === 'player')) f.enable(user.id)
  f.tx((state) => {
    state.orders.push(order('batch-order'))
  })
  const first = f.notifications.scanTimeouts({ limit: 5 })
  assert.equal(first.processed, 5)
  assert.equal(first.inserted, 5)
  assert.equal(first.remaining, 1)
  for (let i = 0; i < 5; i++) assert.ok(f.notifications.scanTimeouts({ limit: 5 }).processed <= 5)
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM player_notifications WHERE type='pool'").get().n,
    22
  )
  assert.deepEqual(f.notifications.scanTimeouts({ limit: 5 }), {
    processed: 0,
    inserted: 0,
    completed: 0,
    remaining: 0
  })
})

test('业务事务回滚时消息及候选任务一同回滚，不出现虚假成功提醒', (t) => {
  const f = fixture(t)
  const before = f.snapshot(),
    after = structuredClone(before)
  after.orders.push(
    order('rolled-back', { dispatchMode: 'direct', assignedTo: 'player-a', assignedAt: timeZero })
  )
  f.db.exec('BEGIN IMMEDIATE')
  f.notifications.onTransaction({ state: after, beforeState: before, now: timeZero })
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM player_notifications').get().n, 1)
  f.db.exec('ROLLBACK')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM player_notifications').get().n, 0)
  assert.equal(f.notifications.queueStats().candidateBacklog, 0)
})

test('修改等级开放时间更新待处理候选并再次核对已生成提醒资格', (t) => {
  const f = fixture(t)
  f.enable()
  f.tx((state) => {
    state.levels[0].delaySeconds = 60
    state.orders.push(order('delay-change'))
  })
  f.advance(10_000)
  assert.equal(f.notifications.scanTimeouts().inserted, 0)
  f.tx((state) => {
    state.levels[0].delaySeconds = 0
  })
  assert.equal(f.notifications.scanTimeouts().inserted, 1)
  assert.equal(f.notifications.unreadCount('player-a'), 1)
  f.tx((state) => {
    state.levels[0].delaySeconds = 60
  })
  assert.equal(f.notifications.unreadCount('player-a'), 0)
})

test('通知版本按账号在同一事务推进，插入/已读/失效/删除触发摘要更新且不扫描业务状态', (t) => {
  const f = fixture(t)
  assert.deepEqual(f.notifications.summary('player-a'), { version: 0, unreadCount: 0 })
  f.tx((state) => {
    state.orders.push(
      order('version-a', { dispatchMode: 'direct', assignedTo: 'player-a', assignedAt: timeZero })
    )
  })
  const createdVersion = f.notifications.changeVersion('player-a')
  assert.ok(createdVersion > 0)
  assert.equal(f.notifications.changeVersion('player-b'), 0)
  const notice = f.notifications.list('player-a').records[0]
  f.mutate(`/player/notifications/${notice.id}/read`, {})
  const readVersion = f.notifications.changeVersion('player-a')
  assert.ok(readVersion > createdVersion)
  assert.equal(f.notifications.summary('player-a').unreadCount, 0)
  f.mutate(`/player/notifications/${notice.id}/read`, {})
  assert.equal(f.notifications.changeVersion('player-a'), readVersion)
  f.tx((state) => {
    state.orders[0].assignedTo = 'player-b'
    state.orders[0].dispatchRound++
  })
  const invalidatedVersion = f.notifications.changeVersion('player-a')
  assert.ok(invalidatedVersion > readVersion)
  assert.ok(f.notifications.changeVersion('player-b') > 0)
  f.db.prepare('DELETE FROM player_notifications WHERE id=?').run(notice.id)
  assert.ok(f.notifications.changeVersion('player-a') > invalidatedVersion)
  const beforeRollback = f.notifications.changeVersion('player-b')
  f.db.exec('BEGIN IMMEDIATE')
  f.db.prepare('DELETE FROM player_notifications WHERE user_id=?').run('player-b')
  f.db.exec('ROLLBACK')
  assert.equal(f.notifications.changeVersion('player-b'), beforeRollback)
  const prepare = f.db.prepare.bind(f.db)
  f.db.prepare = (sql) => {
    assert.equal(
      sql.includes('studio_state'),
      false,
      'summary must not parse the full business state'
    )
    return prepare(sql)
  }
  assert.equal(f.notifications.summary('support').unreadCount, 0)
  assert.equal(f.notifications.summary('player-b').unreadCount, 1)
})

test('真实HTTP轻量摘要检测异步消息变化，人事可读取本人摘要且其他账号版本不受影响', async (t) => {
  let time = new Date(timeZero)
  const password = 'isolated-notification-summary-only-123'
  const server = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password,
    clock: () => time,
    notifications: {
      publicKey: '',
      privateKey: '',
      subject: '',
      allowedPushHosts: [],
      clock: () => time
    },
    backups: { intervalMinutes: 0, failureWebhook: '' },
    uploadCleanup: { enabled: false },
    notificationIntervalMs: 3_600_000
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  t.after(() => new Promise((closed) => server.close(closed)))
  const s = server.service,
    mutate = (path, body, actor = 'admin') =>
      s.mutate(actor, path, { requestId: randomBytes(16).toString('hex'), ...body })
  const level = mutate('/levels', { name: '摘要等级', delaySeconds: 0 })
  const users = {}
  for (const [key, role] of [
    ['hr', 'hr'],
    ['first', 'player'],
    ['other', 'player']
  ])
    users[key] = mutate('/users', {
      username: `summary-${key}`,
      name: key,
      role,
      status: 'active',
      password,
      levelId: level.id,
      maxActiveOrders: 1,
      permissionOverrides: {}
    })
  const customer = mutate('/customers', { name: '隔离摘要客户' })
  const platform = mutate('/platforms', {
    name: '隔离摘要来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const template = mutate('/templates', {
    name: '隔离摘要订单',
    game: '隔离',
    amount: 10000,
    reward: 7000,
    active: true
  })
  const createOrder = (extra = {}) =>
    mutate('/orders', {
      templateId: template.id,
      customerId: customer.id,
      platformId: platform.id,
      roomCode: 'summary-room',
      amount: 10000,
      reward: 7000,
      receivedAmount: 10000,
      paidAt: time.toISOString(),
      dispatchMode: 'pool',
      ...extra
    })
  mutate('/player/notification-settings', { pool: true, push: false }, users.first.id)
  createOrder()
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const credentials = Object.fromEntries(
    [['admin', 'admin'], ...Object.entries(users).map(([key, user]) => [key, user.username])].map(
      ([key, username]) => [key, s.login(username, password).token]
    )
  )
  const get = async (key, since) => {
    const playerClient = ['first', 'other'].includes(key)
    const response = await fetch(
      base +
        (playerClient ? '/player/changes' : '/changes') +
        (since ? `?since=${encodeURIComponent(since)}` : ''),
      {
        headers: {
          Cookie: `${playerClient ? 'studio_player_session' : 'studio_session'}=${credentials[key]}`,
          ...(playerClient ? { 'X-Studio-Client': 'player' } : {})
        }
      }
    )
    assert.equal(response.status, 200)
    return response.json()
  }
  const before = { first: await get('first'), other: await get('other'), hr: await get('hr') }
  assert.equal((await get('first', before.first.version)).changed, false)
  assert.equal((await get('hr', before.hr.version)).changed, false)
  server.notifications.scanTimeouts()
  assert.equal((await get('first', before.first.version)).changed, true)
  assert.equal((await get('first')).unreadCount, 1)
  assert.equal((await get('other', before.other.version)).changed, false)
  assert.equal((await get('hr', before.hr.version)).changed, false)
  createOrder({ dispatchMode: 'direct', assignedTo: users.first.id })
  const adminBefore = await get('admin'),
    hrBefore = await get('hr')
  time = new Date(Date.parse(timeZero) + 300_000)
  server.notifications.scanTimeouts()
  assert.equal((await get('admin', adminBefore.version)).changed, true)
  assert.equal((await get('admin')).unreadCount, 1)
  assert.equal((await get('hr', hrBefore.version)).changed, false)
})

test('慢批次按实际发送时间续租，后排正在外发的任务不能被第二发送器重新领取', async (t) => {
  let firstRelease, secondRelease, enteredSecond
  const firstGate = new Promise((resolve) => {
    firstRelease = resolve
  })
  const secondGate = new Promise((resolve) => {
    secondRelease = resolve
  })
  const secondEntered = new Promise((resolve) => {
    enteredSecond = resolve
  })
  let calls = 0
  const f = fixture(t, {
    notificationOptions: { sendBatchSize: 2, sendConcurrency: 1, leaseMs: 30_000 },
    pushSender: async () => {
      calls++
      if (calls === 1) await firstGate
      else if (calls === 2) {
        enteredSecond()
        await secondGate
      }
    }
  })
  const second = createPlayerNotifications(f.db, f.config)
  t.after(() => {
    second.close()
    firstRelease()
    secondRelease()
  })
  f.bind()
  f.mutate('/player/push-subscriptions/test', {})
  f.mutate('/player/push-subscriptions/test', {})
  const running = f.notifications.flushPush()
  f.advance(25_000)
  firstRelease()
  await secondEntered
  f.advance(10_000)
  assert.deepEqual(await second.flushPush(), { claimed: 0, sent: 0 })
  secondRelease()
  await running
  assert.equal(calls, 2)
  assert.equal(f.notifications.queueStats().statuses.sent, 2)
})

test('排队批次在真正外发前再次核对截止时间，已过期后排任务不发送', async (t) => {
  let f,
    calls = 0
  f = fixture(t, {
    notificationOptions: { sendBatchSize: 2, sendConcurrency: 1, historyPushLifetimeMs: 5000 },
    pushSender: async () => {
      calls++
      f.advance(6000)
    }
  })
  f.bind()
  f.mutate('/player/push-subscriptions/test', {})
  f.mutate('/player/push-subscriptions/test', {})
  await f.notifications.flushPush()
  assert.equal(calls, 1)
  assert.equal(f.notifications.queueStats().statuses.sent, 1)
  assert.equal(f.notifications.queueStats().statuses.expired, 1)
})

test('无效租约和并发配置启动时拒绝，不允许租约短于固定网络超时', (t) => {
  const f = fixture(t)
  for (const invalid of [{ leaseMs: 5000 }, { sendConcurrency: 0 }, { sendBatchSize: Number.NaN }])
    assert.throws(
      () => createPlayerNotifications(f.db, { ...f.config, ...invalid }),
      /通知任务配置无效/
    )
})
