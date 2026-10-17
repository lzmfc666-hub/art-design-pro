import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from './studio.mjs'
import { orderLifecycle, createLifecycleContext, orderExecutable } from './order-lifecycle.mjs'

export function conflict(code, message, details) {
  throw Object.assign(new ApiError(message, 409), { code, details, publicBusinessError: true })
}
export const paymentConfirmed = (order) =>
  order.receivedAmount > 0 && Boolean(order.paidAt) && order.receivedAmount === order.amount
export const activeOrderCount = (state, userId, lifecycle = createLifecycleContext(state)) =>
  state.orders.filter(
    (order) =>
      order.leaderId === userId && orderLifecycle(state, order, lifecycle).countsTowardsCapacity
  ).length

export function normalizeOrderIdentity(order) {
  order.revision = Number.isSafeInteger(order.revision) && order.revision > 0 ? order.revision : 1
  order.dispatchRound =
    Number.isSafeInteger(order.dispatchRound) && order.dispatchRound > 0 ? order.dispatchRound : 1
  order.playerRemark ??= ''
  order.assignments ||= []
  order.submissions ||= []
  if (
    order.leaderId &&
    ['active', 'review'].includes(order.status) &&
    !order.assignments.some((row) => row.leaderId === order.leaderId && !row.releasedAt)
  ) {
    order.assignments.push({
      id: `legacy-current:${order.id}`,
      leaderId: order.leaderId,
      acceptedAt: '',
      dispatchRound: order.dispatchRound,
      legacyInitialized: true
    })
  }
  for (const [index, row] of order.assignments.entries()) {
    row.id ||= `legacy-assignment:${order.id}:${index}`
    row.dispatchRound ||= order.dispatchRound
  }
  const current = order.assignments.findLast(
    (row) => !row.releasedAt && row.leaderId === order.leaderId
  )
  order.assignmentId = current?.id || null
  for (const row of order.submissions) {
    row.id ||= `legacy-submission:${order.id}:${order.submissions.indexOf(row)}`
    row.assignmentId ??=
      order.assignments.findLast(
        (a) => a.leaderId === row.leaderId && a.acceptedAt <= row.submittedAt
      )?.id || null
    row.dispatchRound ||= order.dispatchRound
  }
  for (const row of order.returnRequests || []) {
    row.assignmentId ??= current?.leaderId === row.leaderId ? current.id : null
    row.dispatchRound ||= order.dispatchRound
  }
  order.submissionId = order.submissions.at(-1)?.id || null
  return order
}

export function claimEligibility(state, user, order, now, context = {}) {
  const lifecycle = context.lifecycle || createLifecycleContext(state)
  const activeOrders = context.activeCount ?? activeOrderCount(state, user.id, lifecycle)
  const maxActiveOrders = user.maxActiveOrders || 1
  const pendingAssignments =
    context.pendingAssignments ??
    state.orders.filter(
      (o) => orderExecutable(state, o, lifecycle) && o.status === 'pending' && o.dispatchState !== 'unassigned' && o.assignedTo === user.id
    ).length
  const level = context.level ?? state.levels.find((row) => row.id === user.levelId)
  const availableAt =
    order.dispatchMode === 'pool' && level
      ? new Date(Date.parse(order.publishedAt) + level.delaySeconds * 1000).toISOString()
      : order.publishedAt
  let reasonCode = null,
    reason = null
  const block = (code, message) => {
    reasonCode = code
    reason = message
  }
  if (user.status !== 'active' || user.role !== 'player' || user.playerAccess?.login === false)
    block('PLAYER_DISABLED', '账号已停用或关闭登录')
  else if (user.playerAccess?.claim === false) block('CLAIM_DISABLED', '账号已关闭新接单')
  else if (orderLifecycle(state, order, lifecycle).executionBlockedReason) {
    const blocked = orderLifecycle(state, order, lifecycle).executionBlockedReason
    block(blocked.code, blocked.message)
  }
  else if (order.status !== 'pending' || order.leaderId)
    block('ORDER_NOT_CLAIMABLE', '订单已被接取或已经结束')
  else if (order.dispatchState === 'unassigned') block('DISPATCH_NOT_READY', '订单等待重新分配')
  else if (order.dispatchMode === 'direct' && order.assignedTo !== user.id)
    block('NOT_ASSIGNED', '订单未指定给本人')
  else if (order.dispatchMode === 'pool' && (!level || Date.parse(now) < Date.parse(availableAt)))
    block('LEVEL_NOT_OPEN', '订单尚未向你的等级开放')
  else if (activeOrders >= maxActiveOrders) block('CLAIM_CAPACITY_REACHED', '已达到同时接单上限')
  return {
    canClaim: !reasonCode,
    reasonCode,
    reason,
    activeOrders,
    maxActiveOrders,
    pendingAssignments,
    paymentConfirmed: paymentConfirmed(order),
    availableAt
  }
}

export function submitEligibility(user, order, state = { refunds: [] }) {
  let code = null,
    message = null
  if (order.leaderId !== user.id || !order.assignmentId) {
    code = 'NOT_CURRENT_LEADER'
    message = '只有当前有效负责人可以上报'
  } else if (orderLifecycle(state, order).executionBlockedReason) {
    const blocked = orderLifecycle(state, order).executionBlockedReason
    code = blocked.code
    message = blocked.message
  } else if (order.status !== 'active') {
    code = 'ORDER_NOT_ACTIVE'
    message = '只有接单中订单可以上报'
  } else if (!paymentConfirmed(order)) {
    code = 'PAYMENT_NOT_CONFIRMED'
    message = '足额收款后才允许正常上报'
  }
  return { canSubmit: !code, submitBlockedReason: code ? { code, message } : null }
}

export function checkOrderPreconditions(order, body, action) {
  if (!Number.isSafeInteger(body.expectedRevision))
    conflict('PRECONDITION_REQUIRED', '缺少订单版本，请刷新后重新确认')
  // Identity conflicts are reported before generic revision conflicts so clients can explain the stale target.
  if (['claim', 'reject'].includes(action)) {
    if (!Number.isSafeInteger(body.dispatchRound))
      conflict('PRECONDITION_REQUIRED', '缺少派单轮次，请刷新后重新确认')
    if (body.dispatchRound !== order.dispatchRound)
      conflict('DISPATCH_ROUND_CONFLICT', '订单已重新派单，请刷新后重新确认')
  }
  if (['release', 'submit', 'return-request', 'return-approve', 'return-reject', 'problem-feedback'].includes(action)) {
    const legacyCompletedFeedback = action === 'problem-feedback' && order.status === 'completed' &&
      order.assignmentId === null && body.assignmentId === null
    if ((!legacyCompletedFeedback && typeof body.assignmentId !== 'string') || typeof body.leaderId !== 'string')
      conflict('PRECONDITION_REQUIRED', '缺少接单身份，请刷新后重新确认')
    if (body.assignmentId !== order.assignmentId || body.leaderId !== order.leaderId)
      conflict('ASSIGNMENT_CONFLICT', '负责人或本次接单记录已变化，请刷新后重新确认')
  }
  if (['review-pass', 'review-return'].includes(action)) {
    if (typeof body.submissionId !== 'string')
      conflict('PRECONDITION_REQUIRED', '缺少材料编号，请刷新后重新确认')
    if (body.submissionId !== order.submissionId)
      conflict('SUBMISSION_CONFLICT', '完成材料已变化，请刷新后重新确认')
  }
  if (body.expectedRevision !== order.revision)
    conflict('ORDER_REVISION_CONFLICT', '订单已被其他人更新，请刷新后重新确认', {
      expectedRevision: body.expectedRevision,
      currentRevision: order.revision
    })
}

const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  )
export function createBusinessRequests(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS business_requests(request_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,operation TEXT NOT NULL,payload_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL)'
  )
  return (user, path, body, execute, now) => {
    if (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 128)
      conflict('PRECONDITION_REQUIRED', '请提供 requestId，网络重试须沿用原编号')
    const { requestId, ...payload } = body
    const hash = createHash('sha256').update(stable(payload)).digest('hex')
    const prior = db.prepare('SELECT * FROM business_requests WHERE request_id=?').get(requestId)
    if (prior) {
      if (prior.actor_id !== user.id || prior.operation !== path || prior.payload_hash !== hash)
        conflict('REQUEST_ID_CONFLICT', 'requestId 已绑定不同操作者、操作、目标或内容')
      return JSON.parse(prior.result_json)
    }
    if (db.prepare('SELECT 1 FROM financial_requests WHERE request_id=?').get(requestId))
      conflict(
        'REQUEST_ID_CONFLICT',
        '该编号属于升级前的成功记录，请先核对原操作结果，不能用新内容复用'
      )
    const result = execute()
    db.prepare('INSERT INTO business_requests VALUES(?,?,?,?,?,?)').run(
      requestId,
      user.id,
      path,
      hash,
      JSON.stringify(result),
      now
    )
    return result
  }
}

export function advanceOrderIdentity(order, before, action) {
  for (const row of order.assignments || []) {
    row.id ||= randomUUID()
    row.dispatchRound ||= order.dispatchRound
  }
  const current = order.assignments.findLast(
    (row) => !row.releasedAt && row.leaderId === order.leaderId
  )
  order.assignmentId = current?.id || null
  for (const row of order.submissions || []) {
    row.assignmentId ??= order.assignmentId
    row.dispatchRound ||= order.dispatchRound
  }
  for (const row of order.returnRequests || []) {
    row.assignmentId ??= before?.assignmentId || order.assignmentId
    row.dispatchRound ||= order.dispatchRound
  }
  if (
    ['dispatch', 'release', 'return-approve'].includes(action) ||
    (action === 'correct-status' && order.status === 'pending')
  )
    order.dispatchRound++
  order.submissionId = order.submissions.at(-1)?.id || null
  order.revision++
}
