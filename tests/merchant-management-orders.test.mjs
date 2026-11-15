import test from 'node:test'
import assert from 'node:assert/strict'
import { merchantFixture } from './helpers/merchant-fixture.mjs'

function managementFixture(t) {
  const f = merchantFixture(t)
  const pending = f.order()
  const active = f.order()
  f.mutate(`/player/orders/${active.id}/claim`, {}, f.players[0].id)
  const other = f.order({}, f.accounts[2].id, f.templates[1])
  const ordinaryTemplate = f.mutate('/templates', {
    name: '内部普通任务', game: '游戏', amount: 2000, reward: 1000, active: true
  })
  const internal = f.mutate('/orders', {
    customerId: f.merchants[0].customerId,
    templateId: ordinaryTemplate.id,
    platformId: f.merchants[0].platformId,
    roomCode: 'INTERNAL-ROOM', dispatchMode: 'pool',
    receivedAmount: 2000, paidAt: '2026-11-08T04:00:00Z'
  })

  // Imported historical data may share a platform across merchants. All writes
  // here target the fixture's in-memory database, never an application database.
  const state = JSON.parse(f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  state.merchants.find((row) => row.id === f.merchants[1].id).platformId = f.merchants[0].platformId
  state.orders.find((row) => row.id === other.id).platformId = f.merchants[0].platformId
  f.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  return { ...f, pending, active, other, internal }
}

test('management merchant filter precedes counts and pagination, excluding internal and other-merchant orders on the same platform', (t) => {
  const f = managementFixture(t)
  const query = { merchantId: f.merchants[0].id, current: 1, size: 1 }
  const first = f.service.ordersPage('admin', query)
  assert.equal(first.total, 2)
  assert.equal(first.records.length, 1)
  assert.equal(first.counts.all, 2)
  assert.equal(first.counts.pending, 1)
  assert.equal(first.counts.active, 1)
  const second = f.service.ordersPage('admin', { ...query, current: 2 })
  assert.deepEqual([first.records[0].id, second.records[0].id].sort(), [f.pending.id, f.active.id].sort())
  const pending = f.service.ordersPage('admin', { ...query, status: 'pending' })
  assert.equal(pending.total, 1)
  assert.equal(pending.records[0].id, f.pending.id)
  assert.equal(pending.counts.all, 2)
  assert.equal(pending.counts.active, 1)
})

test('merchant filter only narrows existing role visibility and cannot reveal another merchant through query parameters', (t) => {
  const f = managementFixture(t)
  const own = f.service.ordersPage(f.accounts[0].id, { merchantId: f.merchants[0].id })
  assert.equal(own.total, 2)
  const other = f.service.ordersPage(f.accounts[0].id, { merchantId: f.merchants[1].id })
  assert.deepEqual(other.records, [])
  assert.equal(other.total, 0)
  assert.equal(other.counts.all, 0)
  const unknown = f.service.ordersPage('admin', { merchantId: 'missing-merchant' })
  assert.deepEqual(unknown.records, [])
  assert.equal(unknown.total, 0)
  assert.equal(unknown.counts.all, 0)
})

test('existing unfiltered and source-filtered order lists retain all authorized orders', (t) => {
  const f = managementFixture(t)
  const all = f.service.ordersPage('admin', {})
  assert.equal(all.total, 4)
  assert.equal(all.counts.all, 4)
  const source = f.service.ordersPage('admin', { platformId: f.merchants[0].platformId })
  assert.equal(source.total, 4)
  assert.deepEqual(source.records.map((row) => row.id).sort(), [f.pending.id, f.active.id, f.other.id, f.internal.id].sort())
})
