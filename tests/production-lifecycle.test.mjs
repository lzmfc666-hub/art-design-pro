import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createPlayerNotifications } from '../server/player-notifications.mjs'

const PASSWORD = 'isolated-production-fix-password'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const rejected = (fn, code) => assert.throws(fn, error => error instanceof ApiError && error.status >= 400 && (!code || error.code === code))

function fixture(t, { notifications = false } = {}) {
  let notices
  const service = createStudioService({ dbPath: ':memory:', seed: false, password: PASSWORD, clock: () => new Date('2026-10-18T04:00:00Z'), onTransaction: notifications ? event => notices?.onTransaction(event) : undefined })
  if (notifications) notices = createPlayerNotifications(service.db, { clock: () => new Date('2026-10-18T04:00:00Z') })
  t.after(() => service.close())
  const snapshot = () => JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const current = row => service.orderDetail('admin', row.id).order
  const intent = row => {
    const order = current(row)
    return { expectedRevision: order.revision, dispatchRound: order.dispatchRound, assignmentId: order.assignmentId, leaderId: order.leaderId, submissionId: order.submissionId }
  }
  const mutate = (path, body = {}, actor = 'admin') => {
    const state = snapshot()
    const orderId = path.match(/^\/(?:player\/)?orders\/([^/]+)\//)?.[1] || body.orderId || state.refunds.find(r => path === `/refunds/${r.id}/action`)?.orderId
    const order = state.orders.find(row => row.id === orderId)
    return service.mutate(actor, path, { ...(order ? intent(order) : {}), requestId: randomUUID(), ...body })
  }
  const level = mutate('/levels', { name: '立即开放', delaySeconds: 0 })
  const players = ['lead', 'mate', 'other'].map(name => mutate('/users', { username: name, name, role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 1, permissionOverrides: {}, password: PASSWORD }))
  const support = mutate('/users', { username: 'support', name: '客服', role: 'support', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: PASSWORD })
  const staff = mutate('/users', { username: 'staff', name: '内部员工', role: 'support', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: PASSWORD })
  const customer = mutate('/customers', { name: '隔离客户', contact: 'PRIVATE', gameId: 'PRIVATE', remark: '' })
  const template = mutate('/templates', { name: '隔离服务', game: '游戏', description: '要求', map: '不限', amount: 2000, reward: 1000, active: true, remark: '' })
  const upload = (actor = 'admin') => service.upload(actor, { name: 'test.png', mime: 'image/png', data: PNG })
  const receipt = upload()
  const order = () => mutate('/orders', { customerId: customer.id, templateId: template.id, platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'ROOM', amount: 2000, reward: 1000, receivedAmount: 2000, paidAt: '2026-10-18T04:00:00Z', receipt, dispatchMode: 'pool', remark: 'PRIVATE' })
  const action = (row, action, body = {}) => mutate(`/orders/${row.id}/action`, { action, reason: '隔离业务原因', ...body })
  const claim = (row, player = players[0]) => mutate(`/player/orders/${row.id}/claim`, {}, player.id)
  const submit = (row, teammateId = null) => mutate(`/player/orders/${row.id}/submit`, { screenshots: [upload(players[0].id)], teammateId }, players[0].id)
  const refund = (row, amount = 2000, actor = 'admin') => mutate('/refunds', { orderId: row.id, amount, reason: '实际退款' }, actor)
  return { service, notices, snapshot, current, intent, mutate, players, support, staff, upload, order, action, claim, submit, refund }
}

test('全额退款移出大厅并阻止真实抢单和状态更正，旧接单意图失效', t => {
  const f = fixture(t), order = f.order(), old = f.intent(order)
  f.refund(order)
  assert.equal(f.current(order).displayStatus, 'refunded')
  assert.equal(f.current(order).status, 'pending')
  assert.equal(f.service.playerOrdersPage(f.players[0].id, { status: 'pending' }).records.some(row => row.id === order.id), false)
  rejected(() => f.claim(order), 'ORDER_REFUNDED')
  rejected(() => f.service.mutate(f.players[0].id, `/player/orders/${order.id}/claim`, { ...old, requestId: randomUUID() }))
  rejected(() => f.action(order, 'dispatch', { dispatchMode: 'pool' }), 'ORDER_REFUNDED')
  rejected(() => f.action(order, 'correct-status', { status: 'active', leaderId: f.players[0].id }), 'ORDER_REFUNDED')
  assert.equal(f.service.ordersPage('admin', { status: 'refunded' }).total, 1)
})

test('接单中全退释放名额，阻止上报；原实收和付款时间不变', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  f.refund(order)
  const after = f.current(order)
  assert.equal(after.receivedAmount, 2000)
  assert.equal(after.paidAt, order.paidAt)
  assert.equal(after.countsTowardsCapacity, false)
  assert.equal(f.service.bootstrap(f.players[0].id).user.activeOrders, 0)
  rejected(() => f.submit(order), 'ORDER_REFUNDED')
  f.claim(f.order())
})

test('部分已退加剩余全退申请冻结履约并保留名额，驳回后解除冻结', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  f.refund(order, 500)
  assert.equal(f.current(order).displayStatus, 'active')
  const request = f.refund(order, 1500, f.support.id)
  assert.equal(request.status, 'pending')
  assert.equal(f.current(order).displayStatus, 'refund-pending')
  assert.equal(f.service.bootstrap(f.players[0].id).user.activeOrders, 1)
  rejected(() => f.submit(order), 'REFUND_PENDING')
  f.mutate(`/refunds/${request.id}/action`, { action: 'reject', reason: '继续原服务' })
  assert.equal(f.current(order).displayStatus, 'active')
  f.submit(order)
})

test('退款与验收不能用旧版本并发通过，审批全退后禁止验收', t => {
  const f = fixture(t), order = f.order()
  f.claim(order); f.submit(order)
  const stale = f.intent(order)
  const request = f.refund(order, 2000, f.support.id)
  rejected(() => f.action(order, 'review-pass'), 'REFUND_PENDING')
  f.mutate(`/refunds/${request.id}/action`, { action: 'approve' })
  rejected(() => f.action(order, 'review-pass'), 'ORDER_REFUNDED')
  rejected(() => f.service.mutate('admin', `/orders/${order.id}/action`, { ...stale, action: 'review-pass', requestId: randomUUID() }))
  assert.equal(f.current(order).submissions[0].review, undefined)
})

test('退款重试只执行一次，退款缺少订单版本时拒绝', t => {
  const f = fixture(t), order = f.order()
  rejected(() => f.service.mutate('admin', '/refunds', { orderId: order.id, amount: 2000, reason: '退款', requestId: randomUUID() }), 'PRECONDITION_REQUIRED')
  const body = { ...f.intent(order), orderId: order.id, amount: 2000, reason: '退款', requestId: randomUUID() }
  const first = f.service.mutate('admin', '/refunds', body)
  assert.deepEqual(f.service.mutate('admin', '/refunds', body), first)
  assert.equal(f.snapshot().refunds.length, 1)
})

test('旧格式全退但仍待接单的订单在读取和执行时也被拦截', t => {
  const f = fixture(t), order = f.order(), state = f.snapshot()
  state.refunds.push({ id: randomUUID(), orderId: order.id, amount: 2000, status: 'paid', reason: '历史退款', createdAt: order.createdAt, processedAt: order.createdAt, requestedBy: 'admin', processedBy: 'admin' })
  f.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  assert.equal(f.current(order).displayStatus, 'refunded')
  rejected(() => f.claim(order), 'ORDER_REFUNDED')
})

test('无人接单存单不进大厅，恢复产生新派单轮次并正常占名额', t => {
  const f = fixture(t), order = f.order()
  f.action(order, 'store')
  assert.equal(f.current(order).displayStatus, 'stored')
  rejected(() => f.claim(order), 'ORDER_STORED')
  f.action(order, 'resume')
  assert.equal(f.current(order).dispatchMode, 'pool')
  assert.ok(f.current(order).dispatchRound > order.dispatchRound)
  f.claim(order)
  assert.equal(f.current(order).countsTowardsCapacity, true)
})

test('原打手满额也可恢复存单续做，验收退回保留本轮免名额', t => {
  const f = fixture(t), order = f.order()
  f.claim(order); f.action(order, 'store')
  const normal = f.order(); f.claim(normal)
  const restored = f.action(order, 'resume')
  assert.equal(restored.leaderId, f.players[0].id)
  assert.equal(restored.capacityExempt, true)
  assert.equal(f.service.bootstrap(f.players[0].id).user.activeOrders, 1)
  f.submit(order)
  f.action(order, 'review-return')
  assert.equal(f.current(order).capacityExempt, true)
  assert.equal(f.service.bootstrap(f.players[0].id).user.activeOrders, 1)
  rejected(() => f.claim(f.order()), 'CLAIM_CAPACITY_REACHED')
})

test('原打手不可用保持存单，人工回大厅换人后恢复普通名额', t => {
  const f = fixture(t), order = f.order()
  f.claim(order); f.action(order, 'store')
  f.mutate('/users', { ...f.players[0], status: 'disabled' })
  rejected(() => f.action(order, 'resume'))
  assert.equal(f.current(order).storage.active, true)
  f.action(order, 'resume', { mode: 'pool' })
  f.claim(order, f.players[2])
  assert.equal(f.current(order).capacityExempt, false)
  assert.equal(f.current(order).countsTowardsCapacity, true)
})

test('存单期间全退后不能恢复，驳回退款只解除退款冻结而不解除存单', t => {
  const f = fixture(t), order = f.order()
  f.claim(order); f.action(order, 'store')
  const request = f.refund(order, 2000, f.support.id)
  f.mutate(`/refunds/${request.id}/action`, { action: 'reject', reason: '撤销申请' })
  assert.equal(f.current(order).displayStatus, 'stored')
  f.refund(order)
  rejected(() => f.action(order, 'resume'), 'ORDER_REFUNDED')
})

test('问题反馈仅当前参与者、编号和版本有效时可写，后台关闭且不改变名额', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const problem = f.action(order, 'problem-open', { reason: '客户反馈问题' }).problem
  const body = { problemId: problem.id, message: '已联系处理' }
  rejected(() => f.mutate(`/player/orders/${order.id}/problem-feedback`, body, f.players[2].id))
  f.mutate(`/player/orders/${order.id}/problem-feedback`, body, f.players[0].id)
  assert.equal(f.current(order).problem.status, 'open')
  assert.equal(f.current(order).countsTowardsCapacity, true)
  f.action(order, 'store')
  f.mutate(`/player/orders/${order.id}/problem-feedback`, { ...body, message: '存单期间反馈' }, f.players[0].id)
  f.action(order, 'problem-close', { problemId: problem.id, reason: '后台核实已解决' })
  assert.equal(f.current(order).displayStatus, 'stored')
  rejected(() => f.mutate(`/player/orders/${order.id}/problem-feedback`, body, f.players[0].id), 'PROBLEM_CHANGED')
  assert.equal(f.service.playerOrdersPage(f.players[0].id, { scope: 'mine', status: 'stored' }).total, 1)
})

test('问题反馈原请求成功后可核对成功凭据且不可重复写入', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const problem = f.action(order, 'problem-open').problem
  const body = { ...f.intent(order), problemId: problem.id, message: '反馈', requestId: randomUUID() }
  f.service.mutate(f.players[0].id, `/player/orders/${order.id}/problem-feedback`, body)
  f.service.mutate(f.players[0].id, `/player/orders/${order.id}/problem-feedback`, body)
  assert.equal(f.current(order).problem.feedback.length, 1)
  assert.equal(f.service.playerOperationResult(f.players[0].id, body.requestId, 'problem-feedback').status, 'succeeded')
})

test('完成后全退保留完成时间、验收与问题反馈资格，不产生新报酬', t => {
  const f = fixture(t), order = f.order()
  f.claim(order); f.submit(order); f.action(order, 'review-pass')
  const completedAt = f.current(order).completedAt
  const problem = f.action(order, 'problem-open').problem
  f.refund(order)
  assert.equal(f.current(order).status, 'completed')
  assert.equal(f.current(order).completedAt, completedAt)
  assert.equal(f.current(order).displayStatus, 'refunded')
  f.mutate(`/player/orders/${order.id}/problem-feedback`, { problemId: problem.id, message: '售后反馈' }, f.players[0].id)
  assert.equal(f.current(order).submissions[0].review, 'passed')
})

test('员工排班接口拒绝打手，内部员工仍可正常设置班次和考勤', t => {
  const f = fixture(t)
  const schedule = { userId: f.players[0].id, effectiveFrom: '2026-10-18', enabled: true, start: '09:00', end: '18:00' }
  rejected(() => f.mutate('/work-schedules', schedule))
  rejected(() => f.mutate('/attendance', { userId: f.players[0].id, date: '2026-10-18', status: 'normal', start: '09:00', end: '18:00', actualHours: 8 }))
  f.mutate('/work-schedules', { ...schedule, userId: f.staff.id })
  assert.equal(f.service.bootstrap('admin').workSchedules.length, 1)
})

test('问题原因不向未接单大厅用户泄露，接取后才可查看', t => {
  const f = fixture(t), order = f.order()
  f.action(order, 'problem-open', { reason: 'PRIVATE-PROBLEM-DETAIL' })
  const lobby = f.service.playerOrderDetail(f.players[0].id, order.id)
  assert.equal(lobby.problem.status, 'open')
  assert.equal(JSON.stringify(lobby).includes('PRIVATE-PROBLEM-DETAIL'), false)
  assert.equal(Object.hasOwn(lobby, 'refundSummary'), false)
  f.claim(order)
  assert.equal(f.service.playerOrderDetail(f.players[0].id, order.id).problem.reason, 'PRIVATE-PROBLEM-DETAIL')
})

test('旧完成单没有接单编号时，问题反馈仍精确绑定负责人、问题和版本', t => {
  const f = fixture(t), order = f.order()
  f.claim(order); f.submit(order); f.action(order, 'review-pass')
  const state = f.snapshot(), legacy = state.orders.find(row => row.id === order.id)
  legacy.assignments = []; legacy.assignmentId = null
  f.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  const problem = f.action(order, 'problem-open').problem
  assert.equal(f.current(order).assignmentId, null)
  f.mutate(`/player/orders/${order.id}/problem-feedback`, { problemId: problem.id, message: '历史单售后反馈' }, f.players[0].id)
  assert.equal(f.current(order).problem.feedback.length, 1)
  rejected(() => f.mutate(`/player/orders/${order.id}/problem-feedback`, { problemId: problem.id, message: '错误身份', assignmentId: 'forged' }, f.players[0].id), 'ASSIGNMENT_CONFLICT')
})

test('问题通知随接入生成，关闭后旧问题提醒失效，存单恢复和退款解除均通知', t => {
  const f = fixture(t, { notifications: true }), order = f.order()
  const problem = f.action(order, 'problem-open').problem
  f.claim(order)
  let rows = f.notices.list(f.players[0].id).records
  const opened = rows.find(row => row.type === 'problem-open')
  assert.ok(opened)
  assert.equal(opened.target.problemId, problem.id)
  f.action(order, 'problem-close', { problemId: problem.id })
  rows = f.notices.list(f.players[0].id).records
  assert.ok(rows.find(row => row.id === opened.id).invalidatedAt)
  assert.ok(rows.some(row => row.type === 'problem-closed'))
  f.action(order, 'store'); f.action(order, 'resume')
  rows = f.notices.list(f.players[0].id).records
  assert.ok(rows.some(row => row.type === 'order-stored'))
  assert.ok(rows.some(row => row.type === 'order-resumed'))
  const refund = f.refund(order, 2000, f.support.id)
  f.mutate(`/refunds/${refund.id}/action`, { action: 'reject', reason: '恢复履约' })
  rows = f.notices.list(f.players[0].id).records
  assert.ok(rows.some(row => row.type === 'refund-result' && row.title === '订单退款暂停已解除'))
})

test('存单与退款清理旧大厅候选和指定提醒，退款驳回可重新派发', t => {
  const f = fixture(t, { notifications: true })
  const order = f.mutate('/orders', { customerId: f.snapshot().customers[0].id, templateId: f.snapshot().templates.at(-1).id, platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: '1', amount: 2000, reward: 1000, receivedAmount: 2000, paidAt: '2026-10-18T04:00:00Z', dispatchMode: 'direct', assignedTo: f.players[0].id })
  const initial = f.notices.list(f.players[0].id).records.find(row => row.type === 'assigned')
  assert.ok(initial)
  const refund = f.refund(order, 2000, f.support.id)
  assert.ok(f.notices.list(f.players[0].id).records.find(row => row.id === initial.id).invalidatedAt)
  f.mutate(`/refunds/${refund.id}/action`, { action: 'reject', reason: '申请驳回' })
  assert.ok(f.notices.list(f.players[0].id).records.some(row => row.type === 'assigned' && row.id !== initial.id && !row.invalidatedAt))
})

test('旧打手考勤仍保存在业务库，员工考勤读取不混入该记录', t => {
  const f = fixture(t), state = f.snapshot()
  state.attendance.push({ id: randomUUID(), userId: f.players[0].id, date: '2026-10-18', status: 'present', start: '09:00', end: '18:00', actualHours: 8, hoursRegistered: true })
  f.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  assert.equal(f.service.bootstrap('admin').attendance.length, 0)
  assert.equal(f.snapshot().attendance.length, 1)
})

test('关闭新接单不妨碍原存单续做，但仍拒绝普通新接单', t => {
  const f = fixture(t), order = f.order()
  f.claim(order); f.action(order, 'store')
  f.mutate('/users', { ...f.players[0], playerAccess: { login: true, claim: false, withdraw: true } })
  assert.equal(f.action(order, 'resume').capacityExempt, true)
  f.submit(order)
  assert.throws(() => f.claim(f.order()), error => error.status === 403 && error.message.includes('新接单'))
})

test('日志保留当时存单和问题前后值，不用今天的退款状态覆盖历史', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  f.action(order, 'store', { reason: '客户暂存' })
  f.action(order, 'problem-open', { reason: '检查问题' })
  f.refund(order)
  const logs = f.service.logs('admin', { entity: 'order', source: 'all' }).records.filter(row => row.entityId === order.id)
  const stored = logs.find(row => row.action.startsWith('订单：store'))
  assert.equal(stored.after.storage.active, true)
  assert.equal(stored.after.storage.reason, '客户暂存')
  assert.equal(stored.after.refundExecutionClosedAt, undefined)
  assert.equal(stored.after.displayStatus, undefined)
  const problem = logs.find(row => row.action.startsWith('订单：problem-open'))
  assert.equal(problem.after.problem.reason, '检查问题')
})

test('退款暂停和旧全退单不进入可办理退单待办，驳回后恢复待办且历史不丢失', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  f.mutate(`/player/orders/${order.id}/return-request`, { reason: '原负责人申请退单' }, f.players[0].id)
  assert.equal(f.service.ordersPage('admin', { status: 'return-pending' }).total, 1)
  const request = f.refund(order, 2000, f.support.id)
  assert.equal(f.service.ordersPage('admin', { status: 'return-pending' }).total, 0)
  assert.equal(f.service.bootstrap('admin').orderCounts['return-pending'], 0)
  assert.equal(f.current(order).returnRequests[0].status, 'pending')
  f.mutate(`/refunds/${request.id}/action`, { action: 'reject', reason: '继续原服务' })
  assert.equal(f.service.ordersPage('admin', { status: 'return-pending' }).total, 1)
  f.refund(order)
  const state = f.snapshot(), legacy = state.orders.find(row => row.id === order.id)
  delete legacy.refundExecutionClosedAt
  legacy.returnRequests[0].status = 'pending'
  f.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  assert.equal(f.service.ordersPage('admin', { status: 'return-pending' }).total, 0)
  assert.equal(f.service.bootstrap('admin').orderCounts['return-pending'], 0)
  assert.equal(f.snapshot().orders.find(row => row.id === order.id).returnRequests[0].status, 'pending')
})
