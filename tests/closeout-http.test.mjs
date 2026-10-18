import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioServer } from '../server/index.mjs'

// Unadapted HTTP, real cookies and Actor headers; disposable memory database only.
const password = 'isolated-closeout-http-20261018'
const clock = () => new Date('2026-10-18T04:00:00Z')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
async function fixture(t) {
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password, clock, maintenanceFromEnv: false,
    notificationIntervalMs: 86400000, uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
    notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [], pushSender: async () => { throw new Error('External push forbidden') } } })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)) })
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  async function login(username, player = false) {
    const response = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(player ? { 'X-Studio-Client': 'player' } : {}) }, body: JSON.stringify({ username, password }) })
    const data = await response.json()
    assert.equal(response.status, 200, 'Isolated login')
    return { user: data.user, cookie: response.headers.get('set-cookie').split(';')[0], player }
  }
  const admin = await login('admin')
  async function call(path, body, actor = admin) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: actor.cookie, ...(actor.player ? { 'X-Studio-Client': 'player' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Studio-Actor': actor.user.id }) },
      body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  async function ok(path, body, actor) {
    const result = await call(path, body, actor)
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.data)}`)
    return result.data
  }
  const level = await ok('/levels', { name: '取消HTTP验收', delaySeconds: 0 })
  const leader = await ok('/users', { username: 'closeout-player', name: '验收打手', role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 10, permissionOverrides: {}, password })
  await ok('/users', { username: 'closeout-support', name: '验收客服', role: 'support', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password })
  const player = await login(leader.username, true), support = await login('closeout-support')
  const customer = await ok('/customers', { name: '取消验收客户', contact: 'QA-only', gameId: 'QA-only' })
  const template = await ok('/templates', { name: '取消验收项目', game: '隔离游戏', description: '验收要求', map: '不限', amount: 2000, reward: 1000, active: true })
  const snapshot = () => JSON.parse(server.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const current = async row => (await ok(`/orders/${row.id}`)).order
  const intent = row => ({ requestId: randomUUID(), expectedRevision: row.revision, dispatchRound: row.dispatchRound, assignmentId: row.assignmentId, leaderId: row.leaderId, submissionId: row.submissionId })
  const order = (extra = {}) => ok('/orders', { requestId: randomUUID(), templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'QA-ROOM', dispatchMode: 'pool', receivedAmount: 2000, paidAt: clock().toISOString(), ...extra })
  const claim = async row => {
    const body = intent(await current(row))
    return { body, result: await ok(`/player/orders/${row.id}/claim`, body, player) }
  }
  const action = async (row, action, fields = {}, actor = admin) => ok(`/orders/${row.id}/action`, { ...intent(await current(row)), action, reason: '老板取消订单', ...fields }, actor)
  const close = (row, fields = {}, actor = admin) => action(row, 'cancel-refund', { refundAmount: 2000, refundDestination: 'cash', refundChannel: 'wechat', actualRefundConfirmed: false, ...fields }, actor)
  const balance = async () => (await ok(`/customers/${customer.id}/balance`)).balance
  const recharge = amount => ok('/customer-transactions', { requestId: randomUUID(), customerId: customer.id, kind: 'recharge', amount, reason: '隔离验收充值', paymentMethod: 'cash', paidAt: clock().toISOString() })
  const approve = async (refund, fields = {}) => ok(`/refunds/${refund.id}/action`, { ...intent(await current({ id: refund.orderId })), action: 'approve', ...fields })
  return { server, admin, support, player, leader, customer, call, ok, current, intent, order, claim, action, close, balance, recharge, approve, snapshot }
}

test('HTTP取消并申请退款一次提交，日常移除但历史可查，拒绝退款不恢复订单', async t => {
  const f = await fixture(t), order = await f.order(), accepted = await f.claim(order)
  await f.close(order, {}, f.support)
  const after = await f.current(order)
  assert.equal(after.status, 'canceled'); assert.equal(after.effectiveReward, 0)
  assert.equal(after.reward, 1000); assert.equal(after.cancellationPolicyVersion, 1)
  assert.equal(after.compensationPending, false); assert.equal(after.countsTowardsCapacity, false)
  assert.equal(after.receivedAmount, 2000); assert.equal(after.paidAt, order.paidAt)
  assert.ok(!(await f.ok('/orders')).records.some(row => row.id === order.id))
  assert.ok((await f.ok('/orders?status=canceled')).records.some(row => row.id === order.id))
  assert.ok(!(await f.ok('/player/orders?scope=mine', undefined, f.player)).records.some(row => row.id === order.id))
  assert.equal((await f.ok('/player/profile', undefined, f.player)).activeOrders, 0)
  const replay = await f.call(`/player/orders/${order.id}/claim`, accepted.body, f.player)
  assert.equal(replay.status, 409, 'Old successful POST must not replay obsolete execution authority')
  const refund = f.snapshot().refunds.find(row => row.orderId === order.id)
  assert.equal(refund.status, 'pending'); assert.equal(refund.destination, 'cash')
  await f.ok(`/refunds/${refund.id}/action`, { ...f.intent(after), action: 'reject', reason: '客户尚未确认退款' })
  assert.equal((await f.current(order)).status, 'canceled')
  assert.equal((await f.call(`/orders/${order.id}/action`, { ...f.intent(await f.current(order)), action: 'correct-status', status: 'pending', reason: '旧页面试图重新上架' })).status, 409)
})

test('HTTP原储值订单选择线下退款不返余额，余额路线只入账一次且幂等绑定去向', async t => {
  const f = await fixture(t)
  await f.recharge(6000)
  const external = await f.order({ paymentMethod: 'balance' })
  const beforeCash = await f.balance()
  await f.close(external, { actualRefundConfirmed: true })
  assert.equal(await f.balance(), beforeCash)
  const paidCash = f.snapshot().refunds.find(row => row.orderId === external.id)
  assert.equal(paidCash.destination, 'cash'); assert.equal(paidCash.refundMethod, 'cash'); assert.equal(paidCash.status, 'paid')
  assert.equal(paidCash.balanceTransactionId, undefined)
  const internal = await f.order({ paymentMethod: 'balance' }), beforeBalance = await f.balance()
  const body = { ...f.intent(await f.current(internal)), action: 'cancel-refund', refundAmount: 2000, refundDestination: 'balance', actualRefundConfirmed: false, reason: '退回原客户余额' }
  await f.ok(`/orders/${internal.id}/action`, body)
  assert.equal(await f.balance(), beforeBalance + 2000)
  await f.ok(`/orders/${internal.id}/action`, body)
  assert.equal(await f.balance(), beforeBalance + 2000)
  assert.equal((await f.call(`/orders/${internal.id}/action`, { ...body, refundDestination: 'cash', refundChannel: 'alipay', actualRefundConfirmed: true })).status, 409)
  assert.equal(f.snapshot().refunds.filter(row => row.orderId === internal.id).length, 1)
  assert.ok((await f.ok('/orders?status=canceled')).records.some(row => row.id === internal.id), 'Full-refund display must not hide raw cancellation history')
})

test('HTTP新线下退款没有实际确认不记已退，审批不得切换冻结去向', async t => {
  const f = await fixture(t), order = await f.order()
  await f.close(order)
  const refund = f.snapshot().refunds.find(row => row.orderId === order.id)
  assert.equal(refund.status, 'pending')
  const unconfirmed = await f.call(`/refunds/${refund.id}/action`, { ...f.intent(await f.current(order)), action: 'approve', actualRefundConfirmed: false })
  assert.ok(unconfirmed.status >= 400)
  assert.equal(f.snapshot().refunds.find(row => row.id === refund.id).status, 'pending')
  const changedDestination = await f.call(`/refunds/${refund.id}/action`, { ...f.intent(await f.current(order)), action: 'approve', destination: 'balance', actualRefundConfirmed: true })
  assert.ok(changedDestination.status >= 400, 'Changing destination while approving must be rejected')
  const body = { ...f.intent(await f.current(order)), action: 'approve', actualRefundConfirmed: true }
  await f.ok(`/refunds/${refund.id}/action`, body)
  await f.ok(`/refunds/${refund.id}/action`, body)
  assert.equal(f.snapshot().refunds.filter(row => row.orderId === order.id && row.status === 'paid').length, 1)
  assert.equal(await f.balance(), 0)
})

test('HTTP旧储值待审退款缺新字段仍按原路线入账，不能套用新线下默认', async t => {
  const f = await fixture(t)
  await f.recharge(3000)
  const order = await f.order({ paymentMethod: 'balance' }), before = await f.balance()
  const legacy = await f.ok('/refunds', { ...f.intent(await f.current(order)), orderId: order.id, amount: 2000, reason: '旧客户端申请' }, f.support)
  assert.equal(legacy.status, 'pending'); assert.equal(legacy.destination, undefined)
  await f.approve(legacy)
  assert.equal(await f.balance(), before + 2000)
  assert.equal(f.snapshot().refunds.find(row => row.id === legacy.id).refundMethod, 'balance')
})

test('HTTP部分退及全退申请保留报酬，实际全退才置零，后续补款不复活报价', async t => {
  const f = await fixture(t), order = await f.order()
  await f.claim(order)
  await f.ok('/refunds', { ...f.intent(await f.current(order)), orderId: order.id, amount: 500, destination: 'cash', channel: 'alipay', actualRefundConfirmed: true, reason: '部分退款继续履约' })
  assert.equal((await f.current(order)).effectiveReward, 1000)
  const pending = await f.ok('/refunds', { ...f.intent(await f.current(order)), orderId: order.id, amount: 1500, destination: 'cash', channel: 'alipay', actualRefundConfirmed: false, reason: '申请退完剩余金额' }, f.support)
  assert.equal((await f.current(order)).effectiveReward, 1000)
  assert.equal((await f.current(order)).countsTowardsCapacity, true)
  await f.approve(pending, { actualRefundConfirmed: true })
  assert.equal((await f.current(order)).effectiveReward, 0)
  assert.equal((await f.current(order)).reward, 1000)
  assert.equal((await f.current(order)).countsTowardsCapacity, false)
  await f.ok('/player-adjustments', { requestId: randomUUID(), userId: f.leader.id, kind: 'supplement', amount: 300, orderId: order.id, reason: '特殊情况补款' })
  assert.equal((await f.current(order)).effectiveReward, 0)
  assert.equal((await f.ok('/player/wallet', undefined, f.player)).available, 300)
  assert.equal(f.snapshot().rewardCredits.filter(row => row.orderId === order.id).length, 0)
})

test('HTTP已完成结算后全退与取消均保留原报酬，特殊扣款走原财务窗口', async t => {
  const f = await fixture(t), order = await f.order()
  await f.claim(order)
  const image = await f.ok('/uploads', { name: '隔离验收.png', mime: 'image/png', data: png }, f.player)
  await f.ok(`/player/orders/${order.id}/submit`, { ...f.intent(await f.current(order)), screenshots: [image], teammateId: null }, f.player)
  await f.action(order, 'review-pass')
  assert.equal((await f.ok('/player/wallet', undefined, f.player)).available, 1000)
  await f.close(order, { actualRefundConfirmed: true })
  const after = await f.current(order)
  assert.equal(after.effectiveReward, 1000); assert.equal(after.rewardDisposition.mode, 'preserve-settled')
  assert.equal(after.compensationPending, false)
  assert.equal((await f.ok('/player/wallet', undefined, f.player)).available, 1000)
  await f.ok('/player-adjustments', { requestId: randomUUID(), userId: f.leader.id, kind: 'deduction', amount: 200, orderId: order.id, reason: '财务确认扣减差额' })
  assert.equal((await f.ok('/player/wallet', undefined, f.player)).available, 800)
  assert.equal((await f.current(order)).effectiveReward, 1000, 'Adjustment is separate, not a mutation of the original settled base')
})

test('HTTP无效渠道和超额退款整笔回滚，不出现先取消后退款失败的半成品', async t => {
  const f = await fixture(t), order = await f.order()
  for (const fields of [{ refundChannel: '' }, { refundChannel: 'other', refundChannelNote: '' }, { refundAmount: 2001 }]) {
    const result = await f.call(`/orders/${order.id}/action`, { ...f.intent(await f.current(order)), action: 'cancel-refund', refundAmount: 2000, refundDestination: 'cash', refundChannel: 'wechat', actualRefundConfirmed: true, reason: '检查原子回滚', ...fields })
    assert.ok(result.status >= 400)
    const after = await f.current(order)
    assert.equal(after.status, 'pending'); assert.equal(after.rewardDisposition, undefined)
    assert.equal(f.snapshot().refunds.filter(row => row.orderId === order.id).length, 0)
  }
  await f.close(order, { refundAmount: 0 })
  assert.equal((await f.current(order)).status, 'canceled')
  assert.equal(f.snapshot().refunds.filter(row => row.orderId === order.id).length, 0)
})

test('HTTP同版本取消与抢单并发只接受一个意图，重试取消不重复退款', async t => {
  const f = await fixture(t), order = await f.order(), before = await f.current(order)
  const body = { ...f.intent(before), action: 'cancel-refund', refundAmount: 2000, refundDestination: 'cash', refundChannel: 'platform', actualRefundConfirmed: true, reason: '并发取消退款' }
  const [closed, claimed] = await Promise.all([f.call(`/orders/${order.id}/action`, body), f.call(`/player/orders/${order.id}/claim`, f.intent(before), f.player)])
  assert.deepEqual([closed.status, claimed.status].sort(), [200, 409])
  if (closed.status !== 200) await f.close(order, { actualRefundConfirmed: true })
  else await f.ok(`/orders/${order.id}/action`, body)
  assert.equal((await f.current(order)).status, 'canceled')
  assert.equal(f.snapshot().refunds.filter(row => row.orderId === order.id).length, 1)
  assert.equal((await f.ok('/player/profile', undefined, f.player)).activeOrders, 0)
})

test('HTTP余额退款绑定提交时原客户，后续更换订单客户不能转走退款', async t => {
  const f = await fixture(t), order = await f.order()
  const other = await f.ok('/customers', { name: '另一个验收客户', contact: 'QA-other', gameId: 'QA-other' })
  const pending = await f.ok('/refunds', { ...f.intent(await f.current(order)), orderId: order.id, amount: 500,
    destination: 'balance', destinationCustomerId: other.id, actualRefundConfirmed: false, reason: '原客户指定退余额' }, f.support)
  assert.equal(pending.destinationCustomerId, f.customer.id, 'A supplied account identifier must not override the bound original customer')
  await f.action(order, 'edit', { customerId: other.id })
  await f.approve(pending)
  assert.equal(await f.balance(), 500)
  assert.equal((await f.ok(`/customers/${other.id}/balance`)).balance, 0)
})

test('HTTP客服伪称实际退款仍只能申请，打手无权取消或登记客户退款', async t => {
  const f = await fixture(t), order = await f.order()
  const denied = await f.call(`/orders/${order.id}/action`, { ...f.intent(await f.current(order)), action: 'cancel-refund', refundAmount: 0, reason: '越权尝试取消' }, f.player)
  assert.equal(denied.status, 403)
  assert.equal((await f.current(order)).status, 'pending')
  await f.close(order, { actualRefundConfirmed: true }, f.support)
  assert.equal(f.snapshot().refunds.find(row => row.orderId === order.id).status, 'pending')
  assert.equal(await f.balance(), 0)
})

test('HTTP全退确认flag也绑定原请求，不允许把同一待退款请求改成实际退款重放', async t => {
  const f = await fixture(t), order = await f.order()
  const body = { ...f.intent(await f.current(order)), action: 'cancel-refund', refundAmount: 2000, refundDestination: 'cash', refundChannel: 'bank', actualRefundConfirmed: false, reason: '待实际退款' }
  await f.ok(`/orders/${order.id}/action`, body)
  const replay = await f.call(`/orders/${order.id}/action`, { ...body, actualRefundConfirmed: true })
  assert.equal(replay.status, 409)
  assert.equal(f.snapshot().refunds.filter(row => row.orderId === order.id).length, 1)
  assert.equal(f.snapshot().refunds.find(row => row.orderId === order.id).status, 'pending')
})
