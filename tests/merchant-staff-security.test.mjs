import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'
import { ApiError } from '../server/studio.mjs'
import { merchantFixture, merchantPassword } from './helpers/merchant-fixture.mjs'

const stateOf = (f) => JSON.parse(f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
const denied = (callback, statuses = [400, 403, 404, 409]) => assert.throws(callback,
  (error) => error instanceof ApiError && statuses.includes(error.status))

function ownedFixture(t, service) {
  const f = merchantFixture(t, service)
  for (const [merchant, owner] of [[f.merchants[0], f.accounts[0]], [f.merchants[1], f.accounts[2]]])
    f.mutate(`/merchants/${merchant.id}/owner`, { userId: owner.id })
  return {
    ...f, owner: f.accounts[0], otherOwner: f.accounts[2],
    staff(body = {}, owner = f.accounts[0]) {
      return f.mutate('/merchant/staff', {
        username: 'isolated-new-merchant-support', name: '独立商家客服', status: 'active',
        password: merchantPassword, ...body
      }, owner.id)
    }
  }
}

test('merchant ownership is derived from the merchant pointer and an ordinary merchant cannot appoint an owner', (t) => {
  const f = merchantFixture(t)
  assert.equal(f.service.merchants('admin')[0].ownerUserId, null)
  assert.equal(f.service.login(f.accounts[0].username, merchantPassword).user.merchantRole, 'support')
  denied(() => f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.accounts[0].id }, f.accounts[0].id), [403])
  assert.equal(f.service.merchants('admin')[0].ownerUserId, null)
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.accounts[0].id })
  assert.equal(f.service.login(f.accounts[0].username, merchantPassword).user.merchantRole, 'owner')
  assert.equal(f.service.login(f.accounts[1].username, merchantPassword).user.merchantRole, 'support')
  assert.equal(f.service.login(f.accounts[0].username, merchantPassword).user.role, 'merchant')
})

test('owner staff creation rejects injected roles, permissions, ownership and foreign merchant fields without creating an account', (t) => {
  const f = ownedFixture(t)
  const before = stateOf(f).users.length
  const injections = [
    { role: 'super_admin' }, { role: 'support' }, { merchantRole: 'owner' },
    { merchantId: f.merchants[1].id }, { ownerUserId: f.owner.id },
    { permissionOverrides: { 'users.manage': true, 'finance.review': true } },
    { deletedAt: null }, { maxActiveOrders: 100 }
  ]
  for (const [index, injected] of injections.entries()) {
    denied(() => f.staff({ username: `staff-injection-${index}`, ...injected }), [400, 403])
    assert.equal(stateOf(f).users.length, before)
  }
  const support = f.staff()
  assert.equal(support.role, 'merchant')
  assert.equal(support.merchantId, f.merchants[0].id)
  assert.equal(support.merchantRole, 'support')
  assert.equal('password' in support, false)
})

test('support edit and password reset cannot smuggle foreign targets or alter the owner', (t) => {
  const f = ownedFixture(t)
  const support = f.staff()
  const other = f.staff({ username: 'other-owned-support' }, f.otherOwner)
  const old = stateOf(f)
  for (const target of [other.id, f.otherOwner.id, f.owner.id, 'admin', f.players[0].id]) {
    denied(() => f.staff({ id: target, name: '越权修改', password: 'isolated-attempted-reset' }))
    assert.deepEqual(stateOf(f).users, old.users)
    assert.deepEqual(stateOf(f).passwords, old.passwords)
  }
  for (const injected of [{ role: 'super_admin' }, { merchantRole: 'owner' },
    { merchantId: f.merchants[1].id }, { permissionOverrides: { 'finance.review': true } }]) {
    denied(() => f.staff({ id: support.id, ...injected }), [400, 403])
    assert.deepEqual(stateOf(f).users, old.users)
    assert.deepEqual(stateOf(f).passwords, old.passwords)
  }
  const session = f.service.login(support.username, merchantPassword)
  const reset = f.mutate('/merchant/staff', { id: support.id, name: support.name,
    password: 'isolated-replacement-merchant-password' }, f.owner.id)
  assert.equal(reset.id, support.id)
  assert.equal(f.service.session(session.token), null)
  denied(() => f.service.login(support.username, merchantPassword), [401])
  assert.equal(f.service.login(support.username, 'isolated-replacement-merchant-password').user.id, support.id)
})

test('merchant support cannot list, create, reset, delete staff or use generic user-management paths', (t) => {
  const f = ownedFixture(t)
  const support = f.staff()
  denied(() => f.service.merchantStaff(support.id), [403])
  denied(() => f.staff({ username: 'unauthorized-child' }, support), [403])
  denied(() => f.mutate('/merchant/staff', { id: support.id, name: '自改密码', password: 'isolated-abuse' }, support.id), [403])
  denied(() => f.mutate(`/merchant/staff/${f.accounts[1].id}/delete`, {}, support.id), [403])
  denied(() => f.mutate('/users', { ...support, role: 'super_admin', merchantRole: undefined }, support.id), [403])
  denied(() => f.mutate(`/users/${support.id}/delete`, {}, support.id), [403])
  denied(() => f.mutate(`/users/${support.id}/delete`, {}, f.owner.id), [403])
})

test('generic user edits cannot bypass owner transfer or revive a deleted support account', (t) => {
  const f = ownedFixture(t)
  const ownerBefore = stateOf(f).users.find((u) => u.id === f.owner.id)
  for (const extra of [{ role: 'support' }, { merchantId: f.merchants[1].id }, { merchantRole: 'support' }]) {
    denied(() => f.mutate('/users', { ...ownerBefore, ...extra }))
    assert.equal(f.service.merchants('admin')[0].ownerUserId, f.owner.id)
    assert.deepEqual(stateOf(f).users.find((u) => u.id === f.owner.id), ownerBefore)
  }
  denied(() => f.mutate(`/users/${f.owner.id}/delete`, {}))
  const staff = f.staff()
  f.mutate(`/merchant/staff/${staff.id}/delete`, {}, f.owner.id)
  const deletedBefore = stateOf(f).users.find((u) => u.id === staff.id)
  denied(() => f.mutate('/users', { ...deletedBefore, status: 'active', password: merchantPassword }))
  assert.deepEqual(stateOf(f).users.find((u) => u.id === staff.id), deletedBefore)
  denied(() => f.mutate('/merchant/staff', { id: staff.id, name: '复活账号', status: 'active' }, f.owner.id))
  denied(() => f.mutate(`/users/${f.players[0].id}/delete`, {}))
  denied(() => f.mutate('/users/admin/delete', {}))
})

test('an internal administrator with user-management permission still cannot delete merchant support or transfer ownership', (t) => {
  const f = ownedFixture(t)
  const staff = f.staff()
  const administrator = f.mutate('/users', { username: 'isolated-ordinary-admin', name: '普通管理员',
    role: 'admin', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: merchantPassword })
  assert.ok(f.service.bootstrap(administrator.id).permissions.includes('users.manage'))
  const ownerSession = f.service.login(f.owner.username, merchantPassword)
  const supportSession = f.service.login(staff.username, merchantPassword)
  const before = stateOf(f).users
  denied(() => f.mutate(`/users/${staff.id}/delete`, {}, administrator.id), [403])
  denied(() => f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: staff.id }, administrator.id), [403])
  denied(() => f.mutate('/users', { ...f.owner, name: '普通管理员改主账号' }, administrator.id), [403])
  assert.deepEqual(stateOf(f).users, before)
  assert.equal(f.service.merchants('admin')[0].ownerUserId, f.owner.id)
  assert.equal(f.service.session(ownerSession.token)?.id, f.owner.id)
  assert.equal(f.service.session(supportSession.token)?.id, staff.id)
})

test('disable and re-enable preserve support identity but never restore sessions issued before disabling', (t) => {
  const f = ownedFixture(t)
  const support = f.staff()
  const login = f.service.login(support.username, merchantPassword)
  const body = f.orderBody()
  const first = f.service.mutate(support.id, '/orders', body, { sessionToken: login.token })
  const disabled = f.mutate('/merchant/staff', { id: support.id, status: 'disabled' }, f.owner.id)
  assert.equal(disabled.id, support.id)
  assert.equal(f.service.session(login.token), null)
  const enabled = f.mutate('/merchant/staff', { id: support.id, status: 'active' }, f.owner.id)
  assert.equal(enabled.id, support.id)
  assert.equal(f.service.session(login.token), null)
  denied(() => f.service.mutate(support.id, '/orders', body, { sessionToken: login.token }), [401])
  const fresh = f.service.login(support.username, merchantPassword)
  assert.equal(f.service.mutate(support.id, '/orders', body, { sessionToken: fresh.token }).id, first.id)
})

test('deleted username reuse creates a new identity and cannot reuse the old session or successful order request', (t) => {
  const f = ownedFixture(t)
  const first = f.staff({ username: 'reuse-merchant-user', name: '旧客服姓名' })
  const oldSession = f.service.login(first.username, merchantPassword)
  const body = f.orderBody()
  const order = f.service.mutate(first.id, '/orders', body)
  const count = stateOf(f).orders.length
  const tombstone = f.mutate(`/merchant/staff/${first.id}/delete`, {}, f.owner.id)
  assert.equal(tombstone.id, first.id)
  assert.equal(f.service.session(oldSession.token), null)
  denied(() => f.service.mutate(first.id, '/orders', body), [401, 403])
  const replacement = f.staff({ username: 'REUSE-MERCHANT-USER', name: '新客服姓名',
    password: 'isolated-new-identity-password' })
  assert.notEqual(replacement.id, first.id)
  assert.equal(f.service.login('reuse-merchant-user', 'isolated-new-identity-password').user.id, replacement.id)
  denied(() => f.service.login('reuse-merchant-user', merchantPassword), [401])
  denied(() => f.service.mutate(replacement.id, '/orders', body), [409])
  assert.equal(stateOf(f).orders.length, count)
  assert.equal(stateOf(f).orders.find((o) => o.id === order.id).creatorId, first.id)
  const historical = f.service.bootstrap('admin').users.find((u) => u.id === first.id)
  assert.ok(historical, 'deletion must preserve stable references to the former account')
  assert.match(historical.name, /旧客服姓名.*已删除/)
  assert.equal(f.service.session(oldSession.token), null)
  assert.equal(f.service.login(replacement.username, 'isolated-new-identity-password').user.merchantRole, 'support')
})

test('failed foreign or deleted owner appointments leave the old owner active and logged in', (t) => {
  const f = ownedFixture(t)
  const login = f.service.login(f.owner.username, merchantPassword)
  const staff = f.staff()
  f.mutate(`/merchant/staff/${staff.id}/delete`, {}, f.owner.id)
  for (const id of [f.otherOwner.id, f.players[0].id, 'admin', staff.id, 'missing-owner']) {
    denied(() => f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: id }))
    assert.equal(f.service.merchants('admin')[0].ownerUserId, f.owner.id)
    assert.equal(f.service.session(login.token)?.id, f.owner.id)
  }
  const existing = stateOf(f).users.find((u) => u.id === f.owner.id)
  assert.equal(existing.status, 'active')
})

test('owner and support share only their own merchant totals, safe details and safe dispatch targets', (t) => {
  const f = ownedFixture(t)
  const support = f.staff()
  const own = f.order({}, support.id)
  const own2 = f.order()
  f.order({}, f.otherOwner.id, f.templates[1])
  for (const user of [f.owner, support]) {
    const list = f.service.ordersPage(user.id, { current: 1, size: 1 })
    assert.equal(list.total, 2)
    assert.equal(list.counts.all, 2)
    assert.equal(f.service.merchantOverview(user.id).summary.merchantCustomerAmount, 20000)
    assert.equal(f.service.merchantOverview(user.id).summary.orders, 2)
    assert.deepEqual(f.service.ordersPage(user.id, { merchantId: f.merchants[1].id }).records, [])
    const detail = f.service.orderDetail(user.id, own.id)
    assert.equal('reward' in detail.order, false)
    assert.equal('reward' in detail.order.snapshot, false)
    const targets = f.service.dispatchTargets(user.id)
    assert.deepEqual(targets.records.map((r) => r.id).sort(), f.players.map((r) => r.id).sort())
    for (const row of targets.records) {
      for (const key of ['username', 'password', 'reward', 'commission', 'salary', 'wallet',
        'permissionOverrides', 'deposit', 'activeOrders', 'pendingAssignments'])
        assert.equal(key in row, false, `dispatch targets expose ${key}`)
    }
    assert.equal(JSON.stringify(detail).includes('INTERNAL-TEMPLATE-NOTE'), false)
  }
  assert.equal(f.service.orderDetail(f.owner.id, own2.id).order.id, own2.id)
})

test('accepted merchant orders cannot be canceled by either owner or support and no money moves', (t) => {
  const f = ownedFixture(t)
  const support = f.staff()
  const order = f.order()
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.players[0].id)
  const screenshot = f.upload(f.players[0].id)
  f.mutate(`/player/orders/${order.id}/submit`, { screenshots: [screenshot] }, f.players[0].id)
  f.mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  const before = stateOf(f).orders.find((o) => o.id === order.id)
  assert.equal(before.status, 'completed')
  const fundsBefore = f.service.db.prepare('SELECT count(*) AS n FROM fund_transactions').get().n
  for (const user of [f.owner, support])
    denied(() => f.mutate(`/orders/${order.id}/action`, { action: 'cancel', reason: '验收后越权取消' }, user.id), [403])
  assert.deepEqual(stateOf(f).orders.find((o) => o.id === order.id), before)
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM fund_transactions').get().n, fundsBefore)
})

async function httpFixture(t) {
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password: merchantPassword,
    clock: () => new Date('2026-11-08T04:00:00Z'), maintenanceFromEnv: false,
    uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
    notifications: { publicKey: '', privateKey: '', subject: '' } })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const f = ownedFixture(t, server.service)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  async function request(path, body, cookie, channel, actor) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}), ...(channel ? { 'X-Studio-Client': channel } : {}),
        ...(actor ? { 'X-Studio-Actor': actor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json()
    return { response, data }
  }
  async function login(username, channel) {
    const result = await request('/login', { username, password: merchantPassword }, null, channel)
    assert.equal(result.response.status, 200, result.data.message)
    return { cookie: result.response.headers.get('set-cookie').split(';')[0], user: result.data.user }
  }
  return { ...f, request, login }
}

test('concurrent owner appointments leave one active owner and revoke both the replaced and promoted sessions', async (t) => {
  const f = await httpFixture(t)
  const first = f.staff({ username: 'concurrent-owner-one' })
  const second = f.staff({ username: 'concurrent-owner-two' })
  const former = await f.login(f.owner.username, 'merchant')
  const oneSession = await f.login(first.username, 'merchant')
  const twoSession = await f.login(second.username, 'merchant')
  const admin = await f.login('admin')
  const transfers = await Promise.all([first, second].map((user) => f.request(
    `/merchants/${f.merchants[0].id}/owner`, { userId: user.id, expectedActorId: 'admin' }, admin.cookie, null, 'admin')))
  assert.deepEqual(transfers.map((r) => r.response.status), [200, 200])
  const ownerId = f.service.merchants('admin')[0].ownerUserId
  assert.ok([first.id, second.id].includes(ownerId))
  const state = stateOf(f)
  for (const userId of [f.owner.id, first.id, second.id])
    assert.equal(state.users.find((u) => u.id === userId).status, userId === ownerId ? 'active' : 'disabled')
  for (const session of [former, oneSession, twoSession]) {
    const result = await f.request('/session', undefined, session.cookie, 'merchant')
    assert.equal(result.data.user, null)
  }
  const active = ownerId === first.id ? first : second
  assert.equal((await f.login(active.username, 'merchant')).user.merchantRole, 'owner')
})
