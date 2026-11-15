import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { testMutate } from './helpers/current-intent.mjs'

const PASSWORD = 'isolated-merchant-scope-test-password'

// Existing-state fixtures intentionally bypass the not-yet-added merchant account
// editor: these tests must expose a row/field authorization failure, not fail setup.
function fixture(t) {
  const service = createStudioService({ dbPath: ':memory:', seed: false, password: PASSWORD })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const accounts = ['a1', 'a2', 'b'].map((name) =>
    mutate('/users', {
      username: `merchant-${name}`,
      name: `商家${name}`,
      role: 'support',
      status: 'active',
      maxActiveOrders: 1,
      permissionOverrides: {},
      password: PASSWORD
    })
  )
  const customer = mutate('/customers', { name: '隔离客户', contact: 'PRIVATE-CUSTOMER-CONTACT', remark: '' })
  const template = mutate('/templates', {
    name: '商家隔离任务', game: '游戏', description: '任务', amount: 8000,
    reward: 6000, map: '不限', remark: 'INTERNAL-TEMPLATE-NOTE', active: true
  })
  const orders = ['A-FIRST', 'A-SECOND', 'B-ORDER', 'INTERNAL-ORDER'].map((title) =>
    mutate('/orders', {
      templateId: template.id, customerId: customer.id, platformId: 'xianyu',
      shopId: 'jindun', externalOrderNo: randomUUID(), title,
      roomCode: 'ROOM', dispatchMode: 'pool', amount: 8000, reward: 6000,
      receivedAmount: 8000, paidAt: '2026-11-08T01:00:00Z',
      remark: 'INTERNAL-ORDER-NOTE'
    })
  )
  const state = JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  state.merchants = [
    { id: 'merchant-a', name: '同名商家', status: 'active', customerId: customer.id, platformId: 'xianyu' },
    { id: 'merchant-b', name: '同名商家', status: 'active', customerId: customer.id, platformId: 'xianyu' }
  ]
  accounts.forEach((account, index) => {
    const user = state.users.find((row) => row.id === account.id)
    user.role = 'merchant'
    user.merchantId = index < 2 ? 'merchant-a' : 'merchant-b'
    user.permissionOverrides = { 'orders.view': true, 'orders.create': true, 'orders.edit': true }
  })
  orders.forEach((order, index) => {
    const row = state.orders.find((item) => item.id === order.id)
    row.title = ['A-FIRST', 'A-SECOND', 'B-ORDER', 'INTERNAL-ORDER'][index]
    if (index < 3) {
      row.merchantId = index < 2 ? 'merchant-a' : 'merchant-b'
      row.merchantCustomerAmount = 10000
    }
  })
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  return { service, mutate, accounts, orders }
}

test('merchant scope precedes pagination and counts; colleagues share merchant orders, not same-name outsiders or internal orders', (t) => {
  const { service, accounts, orders } = fixture(t)
  const page = service.ordersPage(accounts[0].id, { current: 1, size: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.records.length, 1)
  assert.equal(page.counts.pending, 2)
  const colleague = service.ordersPage(accounts[1].id, { current: 1, size: 10 })
  assert.deepEqual(colleague.records.map((row) => row.id).sort(), orders.slice(0, 2).map((row) => row.id).sort())
  assert.equal(service.ordersPage(accounts[0].id, { keyword: 'B-ORDER' }).total, 0)
  assert.equal(service.ordersPage(accounts[0].id, { keyword: 'INTERNAL-ORDER' }).total, 0)
  assert.throws(() => service.orderDetail(accounts[0].id, orders[2].id), (error) => error instanceof ApiError && error.status === 403)
})

test('merchant order projections exclude player pay and internal notes in detail, snapshot and audit history', (t) => {
  const { service, mutate, accounts, orders } = fixture(t)
  mutate(`/orders/${orders[0].id}/action`, {
    action: 'edit', roomCode: 'ADMIN-CORRECTED-ROOM', reason: 'INTERNAL-FINANCE-REASON'
  })
  assert.equal(JSON.stringify(service.orderDetail('admin', orders[0].id)).includes('INTERNAL-FINANCE-REASON'), true)
  const detail = service.orderDetail(accounts[0].id, orders[0].id)
  assert.equal('reward' in detail.order, false)
  assert.equal('reward' in detail.order.snapshot, false)
  assert.equal('remark' in detail.order, false)
  const serialized = JSON.stringify(detail)
  assert.equal(serialized.includes('INTERNAL-ORDER-NOTE'), false)
  assert.equal(serialized.includes('INTERNAL-TEMPLATE-NOTE'), false)
  assert.equal(serialized.includes('INTERNAL-FINANCE-REASON'), false)
  assert.equal(serialized.includes('"reward"'), false)
})

test('merchant may edit its own service fields but cannot mutate another merchant order', (t) => {
  const { service, mutate, accounts, orders } = fixture(t)
  mutate(`/orders/${orders[0].id}/action`, { action: 'edit', roomCode: 'OWN-ROOM' }, accounts[0].id)
  assert.equal(service.orderDetail('admin', orders[0].id).order.roomCode, 'OWN-ROOM')
  assert.equal(Array.isArray(service.orderDetail(accounts[0].id, orders[0].id).order.assignments), true)
  mutate(`/orders/${orders[0].id}/action`, { action: 'remark', playerRemark: '商家补充任务说明' }, accounts[0].id)
  const own = service.orderDetail(accounts[0].id, orders[0].id).order
  assert.equal(own.playerRemark, '商家补充任务说明')
  assert.throws(
    () => mutate(`/orders/${orders[2].id}/action`, { action: 'edit', roomCode: 'STOLEN-ROOM' }, accounts[0].id),
    (error) => error instanceof ApiError && error.status === 403
  )
  assert.equal(service.orderDetail('admin', orders[2].id).order.roomCode, 'ROOM')
})

test('rebinding an uploader to another merchant revokes access to its old merchant order images', (t) => {
  const { service, accounts, orders } = fixture(t)
  const picture = service.upload(accounts[0].id, {
    name: 'order.png', mime: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
  })
  const state = JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  state.orders.find((row) => row.id === orders[0].id).submissions = [{
    id: 'isolated-submission', leaderId: 'isolated-player', teammateId: null,
    submittedAt: '2026-11-08T04:00:00Z', screenshots: [picture]
  }]
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  assert.equal(service.download(accounts[1].id, picture.id).data.length > 0, true)
  state.users.find((row) => row.id === accounts[0].id).merchantId = 'merchant-b'
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  assert.throws(() => service.download(accounts[0].id, picture.id), (error) => error instanceof ApiError && error.status === 403)
  assert.equal(service.download(accounts[1].id, picture.id).data.length > 0, true)
})
