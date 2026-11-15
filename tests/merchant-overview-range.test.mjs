import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../server/studio.mjs'
import { merchantFixture } from './helpers/merchant-fixture.mjs'

test('merchant overview defaults to all historical orders and outstanding amounts after the creation day', (t) => {
  const f = merchantFixture(t)
  f.setTime('2025-01-01T04:00:00Z')
  f.order()
  f.setTime('2026-11-08T04:00:00Z')
  f.order()
  f.setTime('2026-11-10T07:00:00Z')
  const report = f.service.merchantOverview(f.accounts[0].id)
  assert.deepEqual(report.range, {})
  assert.equal(report.summary.orders, 2)
  assert.equal(report.summary.pending, 2)
  assert.equal(report.summary.merchantCustomerAmount, 20000)
  assert.equal(report.summary.receivableAmount, 16000)
  assert.equal(report.summary.receivedAmount, 0)
  assert.equal(report.summary.outstandingAmount, 16000)
  assert.equal(report.recentOrders.length, 2)
})

test('explicit merchant dates retain creation-date filtering and clearing both dates restores all history', (t) => {
  const f = merchantFixture(t)
  const first = f.order()
  f.setTime('2026-11-09T04:00:00Z')
  const second = f.order()
  f.setTime('2026-11-10T07:00:00Z')
  const today = f.service.merchantOverview(f.accounts[0].id, { start: '2026-11-10', end: '2026-11-10' })
  assert.equal(today.summary.orders, 0)
  assert.equal(today.summary.outstandingAmount, 0)
  assert.deepEqual(today.recentOrders, [])
  const oneDay = f.service.merchantOverview(f.accounts[0].id, { start: '2026-11-08', end: '2026-11-08' })
  assert.equal(oneDay.summary.orders, 1)
  assert.equal(oneDay.summary.outstandingAmount, 8000)
  assert.deepEqual(oneDay.recentOrders.map((row) => row.id), [first.id])
  const throughToday = f.service.merchantOverview(f.accounts[0].id, { start: '2026-11-08' })
  assert.equal(throughToday.range.end, '2026-11-10')
  assert.equal(throughToday.summary.orders, 2)
  const cleared = f.service.merchantOverview(f.accounts[0].id, { start: null, end: null })
  assert.deepEqual(cleared.range, {})
  assert.equal(cleared.summary.orders, 2)
  assert.deepEqual(cleared.recentOrders.map((row) => row.id), [second.id, first.id])
})

test('all-history merchant overview is shared by colleague accounts and excludes other merchants and internal orders', (t) => {
  const f = merchantFixture(t)
  const own = f.order()
  const other = f.order({}, f.accounts[2].id, f.templates[1])
  const ordinaryTemplate = f.mutate('/templates', {
    name: '内部任务', game: '游戏', amount: 2000, reward: 1000, active: true
  })
  f.mutate('/orders', {
    customerId: f.merchants[0].customerId, templateId: ordinaryTemplate.id,
    platformId: f.merchants[0].platformId, roomCode: 'INTERNAL', dispatchMode: 'pool',
    receivedAmount: 2000, paidAt: '2026-11-08T04:00:00Z'
  })
  f.setTime('2026-11-10T07:00:00Z')
  const colleague = f.service.merchantOverview(f.accounts[1].id)
  assert.equal(colleague.summary.orders, 1)
  assert.equal(colleague.summary.outstandingAmount, 8000)
  assert.deepEqual(colleague.recentOrders.map((row) => row.id), [own.id])
  const outsider = f.service.merchantOverview(f.accounts[2].id)
  assert.equal(outsider.summary.orders, 1)
  assert.deepEqual(outsider.recentOrders.map((row) => row.id), [other.id])
  for (const field of ['reward', 'cost', 'profit', 'commissionSnapshot'])
    assert.equal(JSON.stringify(colleague).includes(`"${field}"`), false)
})

test('explicit merchant date boundaries use Shanghai days and include both ends', (t) => {
  const f = merchantFixture(t)
  const orders = []
  for (const time of [
    '2026-11-08T15:59:59.999Z', '2026-11-08T16:00:00.000Z',
    '2026-11-09T15:59:59.999Z', '2026-11-09T16:00:00.000Z'
  ]) {
    f.setTime(time)
    orders.push(f.order())
  }
  f.setTime('2026-11-10T07:00:00Z')
  const report = f.service.merchantOverview(f.accounts[0].id, { start: '2026-11-09', end: '2026-11-09' })
  assert.equal(report.summary.orders, 2)
  assert.equal(report.summary.outstandingAmount, 16000)
  assert.deepEqual(report.recentOrders.map((row) => row.id), [orders[2].id, orders[1].id])
})

test('an empty merchant has zero all-history totals even when another merchant has orders', (t) => {
  const f = merchantFixture(t)
  f.order({}, f.accounts[2].id, f.templates[1])
  f.setTime('2026-11-10T07:00:00Z')
  const report = f.service.merchantOverview(f.accounts[0].id)
  assert.deepEqual(report.range, {})
  assert.equal(report.summary.orders, 0)
  assert.equal(report.summary.receivableAmount, 0)
  assert.equal(report.summary.receivedAmount, 0)
  assert.equal(report.summary.outstandingAmount, 0)
  assert.deepEqual(report.recentOrders, [])
})

test('merchant overview still rejects malformed, reversed and oversized explicit date ranges', (t) => {
  const f = merchantFixture(t)
  f.setTime('2026-11-10T07:00:00Z')
  for (const input of [
    null, [], 'all', { start: '' }, { end: '2026-02-30' },
    { start: '2026-11-11', end: '2026-11-10' },
    { start: '2025-01-01', end: '2026-11-10' }
  ]) {
    assert.throws(() => f.service.merchantOverview(f.accounts[0].id, input),
      (error) => error instanceof ApiError && error.status === 400)
  }
  assert.throws(() => f.service.merchantOverview('admin'),
    (error) => error instanceof ApiError && error.status === 403)
})

test('all-history summary includes every own order while recent orders retain the newest ten only', (t) => {
  const f = merchantFixture(t)
  const orders = []
  for (let index = 0; index < 12; index++) {
    f.setTime(`2026-11-08T04:${String(index).padStart(2, '0')}:00Z`)
    orders.push(f.order())
  }
  f.setTime('2026-11-10T07:00:00Z')
  const report = f.service.merchantOverview(f.accounts[0].id)
  assert.equal(report.summary.orders, 12)
  assert.equal(report.summary.outstandingAmount, 96000)
  assert.equal(report.recentOrders.length, 10)
  assert.deepEqual(report.recentOrders.map((row) => row.id), orders.slice(2).reverse().map((row) => row.id))
})
