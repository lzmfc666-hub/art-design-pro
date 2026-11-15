import test from 'node:test'
import assert from 'node:assert/strict'
import { merchantFixture, merchantPassword } from './helpers/merchant-fixture.mjs'

function fixture(t) {
  const f = merchantFixture(t)
  f.owner = f.accounts[0].id
  f.staff = f.accounts[1].id
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.owner })
  f.current = order => f.service.orderDetail(f.staff, order.id).order
  f.actual = order => f.service.orderDetail('admin', order.id).order
  f.action = (order, action, body = {}, actor = 'admin') =>
    f.mutate(`/orders/${order.id}/action`, { action, reason: '生产关闭兼容性验证', ...body }, actor)
  f.receive = order => f.action(order, 'confirm-payment', {
    receivedAmount: 8000, paidAt: '2026-11-08T04:00:00Z', receipt: f.upload()
  })
  f.refund = (order, amount = 8000, actor = 'admin') =>
    f.mutate('/refunds', { orderId: order.id, amount, reason: '实际已退款' }, actor)
  f.credit = () => f.service.bootstrap('admin', '2026-11').reports.merchantCredit
  f.summary = () => f.service.merchantOverview(f.staff).summary
  return f
}
const money = (due, received, outstanding) => ({
  receivableAmount: due, receivedAmount: received, outstandingAmount: outstanding
})
const statusTotal = summary => ['pending', 'active', 'review', 'completed', 'canceled', 'stored', 'refunded', 'refundPending']
  .reduce((total, key) => total + summary[key], 0)
const assertPrivate = value => {
  const serialized = JSON.stringify(value)
  for (const field of ['reward', 'effectiveReward', 'rewardDisposition', 'commissionSnapshot', 'refundSummary'])
    assert.equal(serialized.includes(`"${field}"`), false, `merchant leaked ${field}`)
}

test('a real full refund closes both merchant and internal receivables while retaining original active fulfillment history', t => {
  const f = fixture(t), order = f.order({}, f.staff)
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.players[0].id)
  f.receive(order)
  assert.equal(f.refund(order).status, 'paid')
  const actual = f.actual(order), current = f.current(order)
  assert.equal(actual.status, 'active')
  assert.equal(actual.displayStatus, 'refunded')
  assert.ok(actual.refundExecutionClosedAt)
  assert.equal(current.amount, 8000)
  assert.equal(current.receivedAmount, 8000)
  assert.deepEqual(current.merchantFinancials, money(0, 0, 0))
  assert.equal(current.displayStatus, 'refunded')
  assert.equal(current.fullRefund, true)
  assert.equal(current.executionBlockedReason.code, 'ORDER_REFUNDED')
  const summary = f.summary(), credit = f.credit()
  assert.equal(summary.active, 0)
  assert.equal(summary.refunded, 1)
  assert.deepEqual(money(summary.receivableAmount, summary.receivedAmount, summary.outstandingAmount), money(0, 0, 0))
  assert.deepEqual(money(credit.receivableAmount, credit.receivedAmount, credit.outstandingAmount), money(0, 0, 0))
  assert.equal(statusTotal(summary), summary.orders)
  assertPrivate(current)
  f.action(order, 'cancel')
  const canceledRefund = f.summary()
  assert.equal(canceledRefund.refunded, 1)
  assert.equal(canceledRefund.canceled, 0)
  assert.equal(statusTotal(canceledRefund), canceledRefund.orders)
})

test('durable full-refund closure survives a later historical receipt correction without discarding actual remaining net receipts', t => {
  const f = fixture(t), order = f.order({}, f.staff)
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.players[0].id)
  f.mutate(`/player/orders/${order.id}/submit`, { screenshots: [f.upload(f.players[0].id)] }, f.players[0].id)
  f.action(order, 'review-pass')
  f.receive(order)
  f.refund(order)
  const before = f.actual(order)
  f.action(order, 'adjust', { amount: 9000, reward: 6000,
    amountChangeKind: 'historical-correction', affectsHistoricalReceived: true })
  const actual = f.actual(order), current = f.current(order)
  assert.equal(actual.status, 'completed')
  assert.equal(actual.completedAt, before.completedAt)
  assert.equal(actual.refundExecutionClosedAt, before.refundExecutionClosedAt)
  assert.equal(actual.receivedAmount, 9000)
  assert.equal(actual.displayStatus, 'refunded')
  assert.deepEqual(current.merchantFinancials, money(0, 1000, 0))
  assert.equal(current.amount, 9000)
  assert.equal(f.summary().completed, 0)
  assert.equal(f.summary().refunded, 1)
  assert.deepEqual(money(f.credit().receivableAmount, f.credit().receivedAmount, f.credit().outstandingAmount), money(0, 1000, 0))
  assert.equal(f.service.playerWallet(f.players[0].id).earned, 6000)
})

test('unpaid merchant cancellation clears current debt while preserving the original quote and empty payment history', t => {
  const f = fixture(t), order = f.order({}, f.staff)
  assert.deepEqual(f.current(order).merchantFinancials, money(8000, 0, 8000))
  f.action(order, 'cancel', {}, f.staff)
  const current = f.current(order)
  assert.equal(current.amount, 8000)
  assert.equal(current.receivedAmount, 0)
  assert.equal(current.paidAt, null)
  assert.equal(current.status, 'canceled')
  assert.equal(current.displayStatus, 'canceled')
  assert.deepEqual(current.merchantFinancials, money(0, 0, 0))
  assert.equal(f.summary().canceled, 1)
  assert.equal(f.summary().outstandingAmount, 0)
  assert.equal(f.credit().outstandingAmount, 0)
  assert.equal(f.service.orderDetail('admin', order.id).refunds.length, 0)
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM fund_transactions').get().n, 0)
  assertPrivate(current)
})

test('stored merchant orders expose safe current workflow and generic problem flags without private operational notes or reward costs', t => {
  const f = fixture(t), order = f.order({}, f.staff)
  f.action(order, 'store', { reason: 'PRIVATE_STORAGE_REASON_6131' })
  f.action(order, 'problem-open', { reason: 'PRIVATE_PROBLEM_REASON_8186' })
  const current = f.current(order)
  assert.equal(current.status, 'pending')
  assert.equal(current.displayStatus, 'stored')
  assert.equal(current.stored, true)
  assert.equal(current.fullRefund, false)
  assert.equal(current.refundPending, false)
  assert.equal(current.executionBlockedReason.code, 'ORDER_STORED')
  assert.equal(typeof current.executionBlockedReason.message, 'string')
  assert.equal(current.problem.status, 'open')
  assert.equal(JSON.stringify(current).includes('PRIVATE_STORAGE_REASON_6131'), false)
  assert.equal(JSON.stringify(current).includes('PRIVATE_PROBLEM_REASON_8186'), false)
  assert.equal(Object.hasOwn(current.problem, 'feedback'), false)
  assert.equal(Object.hasOwn(current.problem, 'resolution'), false)
  assert.deepEqual(current.merchantFinancials, money(8000, 0, 8000))
  assert.equal(f.summary().pending, 0)
  assert.equal(f.summary().stored, 1)
  assertPrivate(current)
})

test('refund-pending and partial paid refunds retain the existing net money arithmetic and truthful current counts', t => {
  const f = fixture(t), partial = f.order({}, f.staff)
  f.receive(partial)
  f.refund(partial, 1000)
  const afterPartial = f.current(partial)
  assert.deepEqual(afterPartial.merchantFinancials, money(8000, 7000, 1000))
  assert.equal(afterPartial.fullRefund, false)
  assert.equal(afterPartial.displayStatus, 'pending')
  const order = f.order({}, f.staff)
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.players[0].id)
  f.receive(order)
  const support = f.mutate('/users', { username: 'refund-approval-support', name: '内部退款客服',
    role: 'support', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: merchantPassword })
  assert.equal(f.refund(order, 8000, support.id).status, 'pending')
  const frozen = f.current(order), summary = f.summary()
  assert.equal(frozen.displayStatus, 'refund-pending')
  assert.equal(frozen.refundPending, true)
  assert.equal(frozen.fullRefund, false)
  assert.equal(frozen.executionBlockedReason.code, 'REFUND_PENDING')
  assert.deepEqual(frozen.merchantFinancials, money(8000, 8000, 0))
  assert.equal(summary.active, 0)
  assert.equal(summary.pending, 1)
  assert.equal(summary.refundPending, 1)
  assert.equal(summary.receivableAmount, 16000)
  assert.equal(summary.receivedAmount, 15000)
  assert.equal(summary.outstandingAmount, 1000)
  assert.equal(statusTotal(summary), summary.orders)
})

test('merchant historical audit snapshots never inherit current refund status or current financial projections', t => {
  const f = fixture(t), order = f.order({}, f.staff)
  const created = f.service.orderDetail(f.staff, order.id).logs.find(row => row.before === null)
  assert.ok(created)
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.players[0].id)
  f.receive(order)
  f.refund(order)
  const detail = f.service.orderDetail(f.staff, order.id)
  assert.equal(detail.order.displayStatus, 'refunded')
  assert.deepEqual(detail.order.merchantFinancials, money(0, 0, 0))
  const historical = detail.logs.find(row => row.id === created.id)
  assert.equal(historical.actorId, f.staff)
  assert.equal(historical.after.status, 'pending')
  assert.equal(historical.after.receivedAmount, 0)
  assert.equal(historical.after.paidAt, null)
  for (const log of detail.logs) for (const value of [log.before, log.after].filter(Boolean)) {
    for (const key of ['merchantFinancials', 'displayStatus', 'fullRefund', 'refundPending', 'stored', 'executionBlockedReason', 'capacityExempt'])
      assert.equal(Object.hasOwn(value, key), false, `historical snapshot derived current ${key}`)
    assertPrivate(value)
  }
})
