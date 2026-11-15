import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../server/studio.mjs'
import { merchantFixture } from './helpers/merchant-fixture.mjs'

const forbidden = (callback, statuses = [403]) => assert.throws(callback,
  (error) => error instanceof ApiError && statuses.includes(error.status))

test('merchant posts without payment using server-bound merchant, customer, platform, three prices and player remark', (t) => {
  const f = merchantFixture(t)
  const created = f.order()
  const actual = f.service.orderDetail('admin', created.id).order
  assert.equal(actual.merchantId, f.merchants[0].id)
  assert.equal(actual.customerId, f.merchants[0].customerId)
  assert.equal(actual.platformId, f.merchants[0].platformId)
  assert.equal(actual.settlementMode, 'merchant-credit')
  assert.equal(actual.merchantCustomerAmount, 10000)
  assert.equal(actual.amount, 8000)
  assert.equal(actual.reward, 6000)
  assert.equal(actual.receivedAmount, 0)
  assert.equal(actual.paidAt, null)
  assert.equal(actual.playerRemark, '报响箭电竞')
  assert.equal(actual.snapshot.merchantCustomerAmount, 10000)
  assert.equal('reward' in created, false)
  assert.equal(f.service.merchants('admin').length, 2)
  forbidden(() => f.service.merchants(f.accounts[0].id))
})

test('merchant cannot choose another template, change fixed prices or obtain template management through overrides', (t) => {
  const f = merchantFixture(t)
  forbidden(() => f.order({}, f.accounts[0].id, f.templates[1]))
  for (const extra of [
    { amount: 1 }, { reward: 1 }, { merchantCustomerAmount: 1 },
    { receivedAmount: 8000 }, { merchantId: f.merchants[1].id },
    { customerId: f.merchants[1].customerId }, { platformId: f.merchants[1].platformId },
    { settlementMode: 'merchant-credit' }
  ]) forbidden(() => f.order(extra), [400, 403])
  const merchant = f.accounts[0]
  f.mutate('/users', { ...merchant, permissionOverrides: { 'templates.manage': true, 'finance.review': true, 'reports.export': true } })
  forbidden(() => f.mutate('/templates', { ...f.templates[0], reward: 1 }, merchant.id))
  assert.equal(f.service.bootstrap(merchant.id).permissions.includes('finance.review'), false)
  assert.equal(f.service.bootstrap(merchant.id).permissions.includes('reports.export'), false)
})

test('stale template quote is rejected before first creation while a successful same-body retry preserves its original snapshot', (t) => {
  const f = merchantFixture(t)
  const successfulBody = f.orderBody()
  const original = f.mutate('/orders', successfulBody, f.accounts[0].id)
  const staleFirstBody = f.orderBody()
  const revised = f.mutate('/templates', { ...f.templates[0], merchantCustomerAmount: 12000, amount: 9000, reward: 6500 })
  assert.ok(revised.revision > f.templates[0].revision)
  forbidden(() => f.mutate('/orders', staleFirstBody, f.accounts[0].id), [409])
  const retried = f.mutate('/orders', successfulBody, f.accounts[0].id)
  assert.equal(retried.id, original.id)
  const snapshot = f.service.orderDetail('admin', original.id).order
  assert.equal(snapshot.merchantCustomerAmount, 10000)
  assert.equal(snapshot.amount, 8000)
  assert.equal(snapshot.reward, 6000)
  const bootstrap = f.service.bootstrap(f.accounts[0].id)
  assert.deepEqual(bootstrap.templates.map((row) => row.id), [revised.id])
  assert.equal(JSON.stringify(bootstrap).includes('"reward"'), false)
  assert.equal(JSON.stringify(bootstrap).includes('INTERNAL-TEMPLATE-NOTE'), false)
})

test('existing support retains ordinary paid order creation, global order visibility, reward reading and service editing', (t) => {
  const f = merchantFixture(t)
  const support = f.mutate('/users', {
    username: 'unchanged-support', name: '原客服', role: 'support', status: 'active',
    maxActiveOrders: 1, permissionOverrides: {}, password: 'isolated-unchanged-support-password'
  })
  const customer = f.mutate('/customers', { name: '原客服客户', contact: '', remark: '' })
  const template = f.mutate('/templates', {
    name: '原普通模板', game: '游戏', amount: 2000, reward: 1000, active: true
  })
  const firstMerchantOrder = f.order()
  const secondMerchantOrder = f.order({}, f.accounts[2].id, f.templates[1])
  const ordinary = f.mutate('/orders', {
    customerId: customer.id, templateId: template.id, platformId: 'xianyu',
    shopId: 'jindun', externalOrderNo: 'UNCHANGED-SUPPORT-ORDER', roomCode: 'ORIGINAL-ROOM',
    receivedAmount: 2000, paidAt: '2026-11-08T04:00:00Z', dispatchMode: 'pool'
  }, support.id)
  assert.equal(ordinary.reward, 1000)
  assert.equal(ordinary.receivedAmount, 2000)
  assert.notEqual(ordinary.settlementMode, 'merchant-credit')
  const page = f.service.ordersPage(support.id, { current: 1, size: 10 })
  assert.equal(page.total, 3)
  assert.deepEqual(page.records.map((row) => row.id).sort(),
    [firstMerchantOrder.id, secondMerchantOrder.id, ordinary.id].sort())
  assert.equal(f.service.orderDetail(support.id, firstMerchantOrder.id).order.reward, 6000)
  f.mutate(`/orders/${ordinary.id}/action`, { action: 'edit', roomCode: 'UPDATED-ROOM' }, support.id)
  assert.equal(f.service.orderDetail(support.id, ordinary.id).order.roomCode, 'UPDATED-ROOM')
})

test('merchant accounts are excluded from employee payroll and performance while existing support salary is retained', (t) => {
  const f = merchantFixture(t)
  const support = f.mutate('/users', {
    username: 'existing-payroll-support', name: '原客服工资', role: 'support', status: 'active',
    maxActiveOrders: 1, permissionOverrides: {}, password: 'isolated-existing-payroll-support-password'
  })
  f.mutate('/salary-plans', {
    userId: support.id, mode: 'fixed', base: 5000, rate: null,
    platformRates: {}, effectiveFrom: '2026-11-01', hourlyEnabled: false
  })
  const reports = f.service.bootstrap('admin', '2026-11').reports
  const merchantIds = new Set(f.accounts.map((row) => row.id))
  assert.equal(reports.payroll.some((row) => merchantIds.has(row.userId)), false)
  assert.equal(reports.performance.some((row) => merchantIds.has(row.userId)), false)
  assert.equal(reports.payroll.find((row) => row.userId === support.id).total, 5000)
  assert.equal(reports.performance.some((row) => row.userId === support.id), true)
  const range = { start: '2026-11-01', end: '2026-11-30' }
  assert.equal(f.service.overview('admin', range).metrics.staffCount, 2)
  const newStaff = f.service.overviewDetails('admin', { ...range, metric: 'people', view: 'new-staff' })
  assert.deepEqual(newStaff.records.map((row) => row.id).sort(), ['admin', support.id].sort())
})

test('merchant directly cancels unaccepted and submitted orders, retaining history and production reward closure without fabricated cash', (t) => {
  for (const stage of ['pending', 'review']) {
    const f = merchantFixture(t)
    const created = f.order()
    let image = null
    if (stage === 'review') {
      const player = f.players[0]
      f.mutate(`/player/orders/${created.id}/claim`, {}, player.id)
      image = f.upload(player.id)
      f.mutate(`/player/orders/${created.id}/submit`, { screenshots: [image] }, player.id)
    }
    const before = f.service.orderDetail('admin', created.id).order
    assert.equal(before.status, stage)
    const fundsBefore = f.service.db.prepare('SELECT COUNT(*) AS total FROM fund_transactions').get().total
    const result = f.mutate(`/orders/${created.id}/action`, {
      action: 'cancel', reason: '商家终止本次任务'
    }, f.accounts[0].id)
    assert.equal(result.status, 'canceled')
    const after = f.service.orderDetail('admin', created.id).order
    assert.equal(after.status, 'canceled')
    assert.equal(after.canceledFrom, stage)
    assert.deepEqual(after.submissions, before.submissions)
    const assignmentIdentity = ({ releasedAt, reason, ...row }) => row
    assert.deepEqual(after.assignments.map(assignmentIdentity), before.assignments.map(assignmentIdentity))
    assert.ok(after.assignments.every((row) => row.releasedAt))
    assert.equal(after.receivedAmount, 0)
    assert.equal(after.paidAt, null)
    assert.equal(after.compensationPending, false)
    assert.equal(after.compensationSettled, true)
    assert.equal(after.cancellationPolicyVersion, 1)
    assert.equal(after.rewardDisposition.mode, 'zero-unsettled')
    assert.equal(f.service.orderDetail('admin', created.id).refunds.length, 0)
    assert.equal(f.service.db.prepare('SELECT COUNT(*) AS total FROM fund_transactions').get().total, fundsBefore)
    assert.equal(f.service.playerWallet(f.players[0].id).earned, 0)
    if (image) assert.equal(f.service.download('admin', image.id).data.length > 0, true)
  }
})
