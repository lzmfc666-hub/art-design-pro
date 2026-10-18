import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioService } from '../server/studio.mjs'
import { createPlayerNotifications } from '../server/player-notifications.mjs'
import { testMutate } from './helpers/current-intent.mjs'
import { withdrawalBody } from './player-test-helpers.mjs'
import { buildExportSheets } from '../server/report-export.mjs'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
function fixture(t) {
  let notices
  const service = createStudioService({ dbPath: ':memory:', seed: false, password: 'isolated-closeout-password',
    clock: () => new Date('2026-10-18T04:00:00Z'), onTransaction: event => notices?.onTransaction(event) })
  notices = createPlayerNotifications(service.db, { clock: () => new Date('2026-10-18T04:00:00Z') })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const state = () => JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const change = fn => { const value = state(); fn(value); service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(value)) }
  const level = mutate('/levels', { name: '立即', delaySeconds: 0 })
  const player = mutate('/users', { username: randomUUID(), name: '打手', role: 'player', password: 'isolated-closeout-password', status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {} })
  const support = mutate('/users', { username: randomUUID(), name: '客服', role: 'support', password: 'isolated-closeout-password', status: 'active', maxActiveOrders: 1, permissionOverrides: {} })
  const upload = actor => service.upload(actor || 'admin', { name: '隔离凭证.png', mime: 'image/png', data: PNG })
  const customer = mutate('/customers', { name: '隔离客户', gameId: 'SAFE' })
  const template = mutate('/templates', { name: '隔离项目', game: '游戏', amount: 2000, reward: 1000, active: true })
  const order = (extra = {}) => mutate('/orders', { templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'TEST', amount: 2000, reward: 1000, receivedAmount: 2000, paidAt: '2026-10-18T04:00:00Z', receipt: upload(), dispatchMode: 'pool', ...extra })
  const current = row => service.orderDetail('admin', row.id).order
  const action = (row, action, extra = {}, actor = 'admin') => mutate(`/orders/${row.id}/action`, { action, reason: '隔离原因', ...extra }, actor)
  const claim = row => mutate(`/player/orders/${row.id}/claim`, {}, player.id)
  const complete = row => { claim(row); mutate(`/player/orders/${row.id}/submit`, { screenshots: [upload(player.id)] }, player.id); return action(row, 'review-pass') }
  const refund = (row, amount = 2000, extra = {}, actor = 'admin') => mutate('/refunds', { orderId: row.id, amount, reason: '隔离退款', ...extra }, actor)
  const cancel = (row, extra = {}, actor = 'admin') => action(row, 'cancel-refund', { refundAmount: 0, ...extra }, actor)
  const fail = (fn, code) => assert.throws(fn, error => error.status >= 400 && (!code || error.code === code))
  return { service, notices, mutate, state, change, player, support, customer, upload, order, current, action, claim, complete, refund, cancel, fail }
}

test('客服取消已接单默认有效报酬0、原报价和履约史保留，列表移除而财务及历史详情仍可读', t => {
  const f = fixture(t), row = f.order()
  f.claim(row)
  const canceled = f.cancel(row, {}, f.support.id)
  assert.equal(canceled.status, 'canceled'); assert.equal(canceled.effectiveReward, 0); assert.equal(canceled.reward, 1000)
  assert.equal(canceled.compensationPending, false); assert.equal(canceled.compensationSettled, true)
  assert.equal(canceled.cancellationPolicyVersion, 1); assert.equal(canceled.rewardDisposition.mode, 'zero-unsettled')
  assert.ok(canceled.assignments[0].releasedAt); assert.equal(canceled.assignmentId, null)
  assert.equal(f.service.ordersPage('admin').total, 0)
  assert.equal(f.service.ordersPage('admin', { status: 'canceled' }).records[0].id, row.id)
  assert.equal(f.service.playerOrdersPage(f.player.id).total, 0)
  assert.equal(f.service.bootstrap(f.player.id).orders.length, 0)
  assert.ok(f.service.bootstrap('admin').orders.some(order => order.id === row.id))
  assert.equal(f.service.playerOrderDetail(f.player.id, row.id).playerOperationBlockedReason.code, 'ORDER_CANCELED')
  assert.equal(f.service.playerWallet(f.player.id).earned, 0)
  assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM player_notifications WHERE type='order-canceled' AND user_id=?").get(f.player.id).n, 1)
  for (const action of ['correct-status', 'adjust', 'cancel-settle', 'resume']) f.fail(() => f.action(row, action, { status: 'active', reward: 800, amount: 2000 }), 'ORDER_CANCELED')
  f.action(row, 'remark', { remark: '保留内部处理备注' })
  assert.equal(f.service.diagnostics('admin').checks.find(row => row.id === 'rewards').errorCount, 0, 'zero closure is not a missing-credit error')
  const sheet = buildExportSheets(f.service.exportSnapshot('admin', { month: '2026-10' }), {
    month: '2026-10', modules: [{ id: 'orders', fields: ['id', 'reward'] }]
  }).sheets[0]
  assert.equal(sheet.rows.find(item => item.id === row.id).reward, 0, 'financial export uses effective base cost while retaining the canceled row')
})

test('取消并退款一个版本一次提交，重放不重复退款，不合法金额或渠道全部回滚', t => {
  const f = fixture(t), row = f.order(), revision = f.current(row).revision
  const body = { refundAmount: 2000, refundDestination: 'cash', refundChannel: 'wechat', actualRefundConfirmed: true, requestId: randomUUID() }
  const first = f.cancel(row, body)
  const repeated = f.cancel(row, body)
  assert.equal(first.revision, revision + 1); assert.equal(repeated.revision, first.revision)
  assert.equal(f.state().refunds.length, 1); assert.equal(first.displayStatus, 'refunded')
  assert.equal(f.service.ordersPage('admin', { status: 'canceled' }).records[0].id, row.id)
  for (const extra of [{ refundAmount: 2001 }, { refundAmount: -1 }, { refundChannel: 'invalid' }, { refundChannel: 'other', refundChannelNote: '' }]) {
    const next = f.order(), before = f.current(next)
    f.fail(() => f.cancel(next, { ...body, ...extra, requestId: randomUUID() }))
    assert.deepEqual(f.current(next), before)
  }
})

test('显式现金未确认保持待审，目的和渠道冻结，财务审批必须确认真实线下退款', t => {
  const f = fixture(t), row = f.order()
  const refund = f.refund(row, 2000, { destination: 'cash', channel: 'bank', channelNote: '隔离渠道', actualRefundConfirmed: false })
  assert.equal(refund.status, 'pending'); assert.equal(f.current(row).effectiveReward, 1000)
  f.fail(() => f.mutate(`/refunds/${refund.id}/action`, { action: 'approve' }), 'ACTUAL_REFUND_CONFIRMATION_REQUIRED')
  f.fail(() => f.mutate(`/refunds/${refund.id}/action`, { action: 'approve', actualRefundConfirmed: true, destination: 'balance' }), 'REFUND_ROUTE_FROZEN')
  const paid = f.mutate(`/refunds/${refund.id}/action`, { action: 'approve', actualRefundConfirmed: true })
  assert.equal(paid.refundMethod, 'cash'); assert.equal(f.current(row).effectiveReward, 0)
  const log = f.service.bootstrap('admin').logs.find(log => log.entity === 'refund' && log.entityId === refund.id && log.after?.status === 'paid')
  assert.equal(log.after.destination, 'cash'); assert.equal(log.after.channel, 'bank')
})

test('客服取消立刻归零及释放名额，退款待审被驳回仍不可恢复', t => {
  const f = fixture(t), row = f.order(); f.claim(row)
  const canceled = f.cancel(row, { refundAmount: 2000, refundDestination: 'cash', refundChannel: 'platform', actualRefundConfirmed: true }, f.support.id)
  assert.equal(canceled.status, 'canceled'); assert.equal(canceled.displayStatus, 'refund-pending')
  assert.equal(canceled.effectiveReward, 0); assert.equal(f.service.bootstrap(f.player.id).user.activeOrders, 0)
  const refund = f.state().refunds[0]; assert.equal(refund.status, 'pending')
  f.mutate(`/refunds/${refund.id}/action`, { action: 'reject', reason: '隔离拒绝' })
  assert.equal(f.current(row).displayStatus, 'canceled'); assert.equal(f.current(row).effectiveReward, 0)
  f.fail(() => f.action(row, 'correct-status', { status: 'pending' }), 'ORDER_CANCELED')
})

test('部分退款和全退申请不归零，实际全退持久归零，后续补款只单独入成本', t => {
  const f = fixture(t), row = f.order(); f.claim(row)
  f.refund(row, 500)
  assert.equal(f.current(row).effectiveReward, 1000); assert.equal(f.current(row).rewardDisposition, undefined)
  const pending = f.refund(row, 1500, {}, f.support.id)
  assert.equal(f.current(row).effectiveReward, 1000)
  f.mutate(`/refunds/${pending.id}/action`, { action: 'approve' })
  const zero = f.current(row)
  assert.equal(zero.status, 'active'); assert.equal(zero.reward, 1000); assert.equal(zero.effectiveReward, 0)
  f.mutate('/player-adjustments', { userId: f.player.id, orderId: row.id, kind: 'supplement', amount: 400, reason: '特殊履约补款' })
  assert.deepEqual(f.current(row).rewardDisposition, zero.rewardDisposition)
  assert.equal(f.current(row).effectiveReward, 0); assert.equal(f.service.playerWallet(f.player.id).earned, 400)
  const day = f.service.bootstrap('admin', '2026-10').reports.days.find(row => row.date === '2026-10-18')
  assert.equal(day.reward, 0); assert.equal(day.estimatedReward, 0); assert.equal(day.expenses, 400); assert.equal(day.profit, -400)
  const exported = buildExportSheets(f.service.exportSnapshot('admin', { month: '2026-10' }), {
    month: '2026-10', modules: [{ id: 'orders', fields: ['id', 'reward'] }]
  }).sheets[0]
  assert.equal(exported.rows.find(item => item.id === row.id).reward, 0)
})

test('已结算取消及全退保持钱包，特殊扣款只动可用部分而保留在途提现', t => {
  const f = fixture(t), row = f.complete(f.order())
  const withdrawal = f.mutate('/player/withdrawals', withdrawalBody(f.service, f.player.id, 1000), f.player.id)
  const canceled = f.cancel(row)
  assert.equal(canceled.rewardDisposition.mode, 'preserve-settled'); assert.equal(canceled.effectiveReward, 1000)
  assert.equal(canceled.compensationPending, false)
  f.refund(row)
  assert.equal(f.current(row).effectiveReward, 1000); assert.equal(f.service.playerWallet(f.player.id).occupied, 1000)
  const deduction = f.mutate('/player-adjustments', { userId: f.player.id, orderId: row.id, kind: 'deduction', amount: 600, reason: '已结单另行扣款' })
  assert.equal(deduction.appliedAmount, 0); assert.equal(deduction.manualAmount, 600)
  assert.equal(f.service.playerWallet(f.player.id).earned, 1000)
  assert.equal(f.state().withdrawals.find(row => row.id === withdrawal.id).status, 'pending')
})

test('本单零金额结算历史、已完成后改回、旧扣补及冲正均保守保留，其他订单提现不误判', t => {
  const evidence = [
    (state, row) => { row.completedAt = '2026-10-17T00:00:00Z' },
    (state, row) => state.rewardCredits.push({ id: randomUUID(), orderId: row.id, userId: 'history', amount: 0 }),
    (state, row) => state.playerRewardLedger.push({ id: randomUUID(), orderId: row.id, amount: 0 }),
    (state, row) => state.playerAdjustments.push({ id: randomUUID(), orderId: row.id, userId: 'history', kind: 'supplement', amount: 0, appliedAmount: 0, status: 'applied', createdAt: '2026-10-18T04:00:00Z' }),
    (state, row) => { state.statusCorrectionReversals[row.id] = { active: false } }
  ]
  const f = fixture(t)
  for (const add of evidence) {
    const row = f.order(); f.change(state => add(state, state.orders.find(order => order.id === row.id)))
    assert.equal(f.cancel(row).rewardDisposition.mode, 'preserve-settled')
  }
  const clean = f.order()
  f.change(state => state.withdrawals.push({ id: randomUUID(), userId: f.player.id, amount: 1000, status: 'paid' }))
  assert.equal(f.cancel(clean).rewardDisposition.mode, 'zero-unsettled')
})

test('未收款和游戏大厅的零元取消不创建退款，旧补偿待办仍保留财务处理入口', t => {
  const f = fixture(t), unpaid = f.order({ platformId: 'hall', shopId: null, receivedAmount: 0, paidAt: null, payOnArrival: true })
  assert.equal(f.cancel(unpaid).status, 'canceled'); assert.equal(f.state().refunds.length, 0)
  const hall = f.order({ platformId: 'hall', shopId: null })
  assert.equal(f.cancel(hall).status, 'canceled'); assert.equal(f.state().refunds.length, 0)
  const legacy = f.order(); f.claim(legacy)
  f.change(state => Object.assign(state.orders.find(row => row.id === legacy.id), { status: 'canceled', compensationPending: true, compensationSettled: false }))
  const settled = f.action(legacy, 'cancel-settle', { reward: 300 })
  assert.equal(settled.compensationPending, false); assert.equal(f.service.playerWallet(f.player.id).earned, 300)
})

test('旧状态更正取消也终止且不冲正已结报酬，成功后降角色不能重放绕过角色门槛', t => {
  const f = fixture(t), row = f.order()
  const manager = f.mutate('/users', { username: randomUUID(), name: '临时店长', role: 'manager', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: 'isolated-closeout-password' })
  const body = { requestId: randomUUID(), expectedRevision: row.revision, action: 'correct-status', status: 'canceled', reason: '旧入口取消' }
  const result = f.service.mutate(manager.id, `/orders/${row.id}/action`, body)
  assert.equal(result.cancellationPolicyVersion, 1); assert.equal(result.effectiveReward, 0)
  f.mutate('/users', { ...manager, role: 'support' })
  f.fail(() => f.service.mutate(manager.id, `/orders/${row.id}/action`, body))
  const complete = f.complete(f.order()), walletBefore = f.service.playerWallet(f.player.id)
  const canceled = f.action(complete, 'correct-status', { status: 'canceled' })
  assert.equal(canceled.rewardDisposition.mode, 'preserve-settled')
  assert.deepEqual(f.service.playerWallet(f.player.id), walletBefore)
  assert.equal(f.state().statusCorrectionReversals[complete.id], undefined)
})

test('同一关键词及范围下日常与取消历史的tab计数稳定，已退款取消仍按原始状态归历史', t => {
  const f = fixture(t), row = f.order()
  f.cancel(row, { refundAmount: 2000, refundDestination: 'cash', refundChannel: 'wechat', actualRefundConfirmed: true })
  f.order()
  for (const input of [{}, { keyword: row.orderNo }, { scope: 'pool' }]) {
    const daily = f.service.ordersPage('admin', input), history = f.service.ordersPage('admin', { ...input, status: 'canceled' })
    assert.deepEqual(daily.counts, history.counts)
    assert.equal(daily.counts.canceled, 1); assert.equal(history.total, 1)
    assert.equal(history.records[0].displayStatus, 'refunded')
    assert.equal(daily.records.some(item => item.id === row.id), false)
  }
  assert.equal(f.service.playerOrdersPage(f.player.id, { status: 'canceled' }).total, 0)
  assert.equal(f.service.playerOrdersPage(f.player.id).counts.canceled, 0)
})
