import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'
import { ApiError } from '../server/studio.mjs'
import { merchantFixture, merchantPassword } from './helpers/merchant-fixture.mjs'

async function fixture(t) {
  let time = new Date('2026-11-08T04:00:00Z')
  const server = createStudioServer({
    dbPath: ':memory:', seed: false, password: merchantPassword, clock: () => time, maintenanceFromEnv: false,
    uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
    notifications: { publicKey: '', privateKey: '', subject: '', clock: () => time }
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const f = merchantFixture(t, server.service)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const request = (path, { body, cookie, channel, actor } = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(channel ? { 'X-Studio-Client': channel } : {}),
      ...(actor ? { 'X-Studio-Actor': actor } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const login = async (username, channel) => {
    const response = await request('/login', { channel, body: { username, password: merchantPassword } })
    const data = await response.json()
    assert.equal(response.status, 200, data.message)
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user }
  }
  return { ...f, server, request, login, setTime(value) { time = new Date(value) }, base }
}

test('merchant HTTP channel has an independent cookie and never falls back to administrator or player sessions', async (t) => {
  const f = await fixture(t)
  const admin = await f.login('admin')
  const merchant = await f.login(f.accounts[0].username, 'merchant')
  const player = await f.login(f.players[0].username, 'player')
  assert.match(merchant.cookie, /^studio_merchant_session=/)
  const cookies = `${admin.cookie}; ${merchant.cookie}; ${player.cookie}`
  for (const [channel, id] of [[undefined, 'admin'], ['merchant', f.accounts[0].id], ['player', f.players[0].id]]) {
    const response = await f.request('/session', { cookie: cookies, channel })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).user.id, id)
  }
  const adminOnly = await f.request('/session', { cookie: admin.cookie, channel: 'merchant' })
  assert.equal((await adminOnly.json()).user, null)
  const denied = await f.request('/login', { channel: 'merchant', body: { username: 'admin', password: merchantPassword } })
  assert.equal(denied.status, 403)
  assert.equal((await f.request('/merchant/overview', { cookie: admin.cookie, channel: 'merchant' })).status, 401)
  assert.equal((await f.request('/player/wallet', { cookie: cookies, channel: 'merchant' })).status, 403)
  assert.equal((await f.request('/merchants', { cookie: cookies, channel: 'merchant' })).status, 403)
})

test('merchant HTTP writes retain original Actor checks and no longer return an old merchant result after account rebinding', async (t) => {
  const f = await fixture(t)
  const merchant = await f.login(f.accounts[0].username, 'merchant')
  const body = { ...f.orderBody(), expectedActorId: merchant.user.id }
  const mismatch = await f.request('/orders', { body, cookie: merchant.cookie, channel: 'merchant', actor: f.accounts[2].id })
  assert.equal(mismatch.status, 409)
  const createdResponse = await f.request('/orders', { body, cookie: merchant.cookie, channel: 'merchant', actor: merchant.user.id })
  const created = await createdResponse.json()
  assert.equal(createdResponse.status, 200, created.message)
  assert.equal(JSON.stringify(created).includes('"reward"'), false)
  const retry = await f.request('/orders', { body, cookie: merchant.cookie, channel: 'merchant', actor: merchant.user.id })
  assert.equal((await retry.json()).id, created.id)
  const other = await f.login(f.accounts[2].username, 'merchant')
  assert.equal((await f.request(`/orders/${created.id}`, { cookie: other.cookie, channel: 'merchant' })).status, 403)
  f.mutate('/users', { ...f.accounts[0], merchantId: f.merchants[1].id })
  const rebound = await f.request('/orders', { body, cookie: merchant.cookie, channel: 'merchant', actor: merchant.user.id })
  assert.ok([401, 403].includes(rebound.status))
  assert.throws(() => f.mutate('/orders', body, merchant.user.id),
    (error) => error instanceof ApiError && error.status === 403)
})

test('merchant order image URLs work with cookie-only browser requests and deny other merchants and private payment codes', async (t) => {
  const f = await fixture(t)
  const order = f.order()
  const player = f.players[0]
  f.mutate(`/player/orders/${order.id}/claim`, {}, player.id)
  const image = f.upload(player.id)
  f.mutate(`/player/orders/${order.id}/submit`, { screenshots: [image] }, player.id)
  const merchant = await f.login(f.accounts[0].username, 'merchant')
  const response = await f.request(`/orders/${order.id}`, { cookie: merchant.cookie, channel: 'merchant' })
  assert.equal(response.status, 200)
  const detail = await response.json()
  const url = detail.order.submissions[0].screenshots[0].url
  const browserImage = await fetch(new URL(url, f.base), { headers: { Cookie: merchant.cookie } })
  assert.equal(browserImage.status, 200)
  assert.equal((await browserImage.arrayBuffer()).byteLength > 0, true)
  const other = await f.login(f.accounts[2].username, 'merchant')
  assert.equal((await fetch(new URL(url, f.base), { headers: { Cookie: other.cookie } })).status, 403)
  const admin = await f.login('admin')
  assert.equal((await fetch(new URL(url, f.base), { headers: { Cookie: admin.cookie } })).status, 401)
  const qrCode = f.upload(player.id)
  f.mutate('/player/payment-methods', { method: 'wechat', qrCode }, player.id)
  const privateUrl = `${f.base}/merchant/uploads/${qrCode.id}`
  assert.equal((await fetch(privateUrl, { headers: { Cookie: merchant.cookie } })).status, 403)
})

test('assignment timeout notifications follow merchant ownership while existing support keeps global reminders', async (t) => {
  const f = await fixture(t)
  const support = f.mutate('/users', {
    username: 'timeout-original-support', name: '原客服提醒', role: 'support', status: 'active',
    maxActiveOrders: 1, permissionOverrides: {}, password: 'isolated-timeout-original-support-password'
  })
  f.order({ dispatchMode: 'direct', assignedTo: f.players[0].id })
  f.setTime('2026-11-08T04:05:01Z')
  f.server.notifications.scanTimeouts()
  assert.equal(f.server.notifications.listStaffTimeouts(f.accounts[0].id).total, 1)
  assert.equal(f.server.notifications.listStaffTimeouts(f.accounts[1].id).total, 1)
  assert.equal(f.server.notifications.listStaffTimeouts(f.accounts[2].id).total, 0)
  assert.equal(f.server.notifications.listStaffTimeouts(support.id).total, 1)
  f.mutate('/users', { ...f.accounts[1], merchantId: f.merchants[1].id })
  assert.equal(f.server.notifications.listStaffTimeouts(f.accounts[1].id).total, 0)
})
