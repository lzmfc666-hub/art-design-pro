import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioServer } from '../server/index.mjs'
import { merchantFixture, merchantPassword } from './helpers/merchant-fixture.mjs'

async function fixture(t) {
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password: merchantPassword,
    backups: { intervalMinutes: 0 }, notificationIntervalMs: 86400000 })
  t.after(() => new Promise(ready => server.close(ready)))
  const f = merchantFixture(null, server.service)
  await new Promise(ready => server.listen(0, '127.0.0.1', ready))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const request = (path, session, body) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(session?.cookie ? { Cookie: session.cookie } : {}),
      ...(session?.channel ? { 'X-Studio-Client': session.channel } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Studio-Actor': session.user.id }) },
    body: body === undefined ? undefined : JSON.stringify({ requestId: randomUUID(), expectedActorId: session.user.id, ...body })
  })
  const login = async (username, channel = 'merchant') => {
    const res = await fetch(base + '/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Client': channel },
      body: JSON.stringify({ username, password: merchantPassword }) })
    const value = await res.json()
    assert.equal(res.status, 200, value.message)
    return { cookie: res.headers.get('set-cookie').split(';')[0], user: value.user, channel }
  }
  const post = async (path, session, body = {}) => {
    const res = await request(path, session, body), value = await res.json()
    assert.equal(res.status, 200, value.message)
    return value
  }
  return { ...f, request, login, post }
}

test('HTTP owner manages support and reused login never revives old cookies or creator identity', async t => {
  const f = await fixture(t)
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.accounts[0].id })
  const owner = await f.login(f.accounts[0].username)
  assert.equal(owner.user.merchantRole, 'owner')
  const staff = await f.post('/merchant/staff', owner, { username: 'http-reusable-support', name: '轮班客服', password: merchantPassword })
  const oldSession = await f.login(staff.username)
  const created = await f.post('/orders', oldSession, f.orderBody())
  assert.equal(created.creatorId, staff.id)
  assert.equal((await f.request('/merchant/staff', oldSession)).status, 403)
  const removed = await f.post(`/merchant/staff/${staff.id}/delete`, owner)
  assert.ok(removed.deletedAt)
  assert.equal((await f.request('/orders', oldSession)).status, 401)
  const fresh = await f.post('/merchant/staff', owner, { username: 'HTTP-Reusable-Support', name: '轮班客服', password: merchantPassword })
  assert.notEqual(fresh.id, staff.id)
  const newSession = await f.login(fresh.username.toLowerCase())
  assert.equal(newSession.user.id, fresh.id)
  const detail = await (await f.request(`/orders/${created.id}`, newSession)).json()
  assert.equal(detail.order.creatorId, staff.id)
  const bootstrap = await (await f.request('/bootstrap?includeOrders=false&includeReports=false', newSession)).json()
  assert.match(bootstrap.users.find(user => user.id === staff.id).name, /轮班客服.*已删除/)
  assert.equal((await f.request('/orders', oldSession)).status, 401)
})

test('HTTP superadmin transfer revokes former owner and exposes owner support tiers in fresh sessions', async t => {
  const f = await fixture(t)
  const admin = await f.login('admin', 'admin')
  await f.post(`/merchants/${f.merchants[0].id}/owner`, admin, { userId: f.accounts[0].id })
  const former = await f.login(f.accounts[0].username)
  const selected = await f.login(f.accounts[1].username)
  await f.post(`/merchants/${f.merchants[0].id}/owner`, admin, { userId: f.accounts[1].id })
  assert.equal((await f.request('/merchant/staff', former)).status, 401)
  assert.equal((await f.request('/merchant/staff', selected)).status, 401, 'role change revokes existing target session too')
  const owner = await f.login(f.accounts[1].username)
  assert.equal(owner.user.merchantRole, 'owner')
  assert.equal((await f.request('/merchant/staff', owner)).status, 200)
  const bootstrap = await (await f.request('/bootstrap?includeOrders=false&includeReports=false', owner)).json()
  assert.equal(bootstrap.users.find(user => user.id === former.user.id).status, 'disabled')
})

test('HTTP merchant dispatch candidates contain only the established safe dispatch fields', async t => {
  const f = await fixture(t), session = await f.login(f.accounts[1].username)
  const response = await f.request('/orders/dispatch-targets', session)
  assert.equal(response.status, 200)
  const { records } = await response.json()
  assert.ok(records.some(row => row.id === f.players[0].id))
  const allowed = new Set(['id', 'name', 'status', 'levelId', 'maxActiveOrders', 'activeOrders', 'pendingAssignments', 'playerAccess'])
  for (const row of records) for (const key of Object.keys(row)) assert.ok(allowed.has(key), `unsafe dispatch field ${key}`)
  assert.equal((await f.request('/users', session)).status, 403)
  assert.equal((await f.request('/merchants', session)).status, 403)
})
