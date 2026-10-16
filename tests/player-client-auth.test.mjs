import { testMutate, installTestClientFetch } from './helpers/current-intent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import webpush from 'web-push'
import { createStudioServer } from '../server/index.mjs'

const password = 'independent-player-client-123'
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

async function fixture(t) {
  const clock = () => new Date('2026-10-13T04:00:00Z')
  const server = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password,
    clock,
    notifications: {
      ...webpush.generateVAPIDKeys(),
      subject: 'mailto:player-client-test@example.com',
      clock,
      pushSender: async () => {}
    }
  })
  const service = server.service
  const level = testMutate(service, 'admin', '/levels', { name: '独立打手端等级', delaySeconds: 0 })
  const users = {}
  for (const [name, role] of [
    ['player', 'player'],
    ['other', 'player'],
    ['support', 'support']
  ])
    users[name] = testMutate(service, 'admin', '/users', {
      username: `client-${name}`,
      name: `独立端${name}`,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 1,
      permissionOverrides: {},
      password
    })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  async function request(path, { body, cookie, player = false, headers = {} } = {}) {
    return fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(player ? { 'X-Studio-Client': 'player' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }
  async function login(name, player = false) {
    const response = await request('/login', {
      player,
      body: { username: name === 'admin' ? name : users[name].username, password }
    })
    const data = await response.json()
    assert.equal(response.status, 200, data.message)
    const setCookie = response.headers.get('set-cookie')
    assert.match(setCookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200/)
    assert.ok(setCookie.startsWith(player ? 'studio_player_session=' : 'studio_session='))
    return { data, cookie: setCookie.split(';')[0], setCookie }
  }
  async function session(cookie, player = false) {
    const response = await request('/session', { cookie, player })
    assert.equal(response.status, 200)
    return (await response.json()).user
  }
  return { server, service, users, request, login, session }
}

test('独立端真实HTTP：同一浏览器两个会话同时存在，切换渠道只读取各自Cookie', async (t) => {
  const f = await fixture(t)
  const admin = await f.login('admin')
  const player = await f.login('player', true)
  const combined = `${admin.cookie}; ${player.cookie}`
  assert.equal((await f.session(combined)).id, 'admin')
  assert.equal((await f.session(combined, true)).id, f.users.player.id)
  assert.equal((await f.session(`${player.cookie}; ${admin.cookie}`)).id, 'admin')
  assert.equal((await f.session(`${player.cookie}; ${admin.cookie}`, true)).id, f.users.player.id)
  assert.equal(await f.session(admin.cookie, true), null)
  assert.equal(await f.session(player.cookie), null)
  assert.equal(await f.session(undefined, true), null)
  assert.equal(
    (await f.request('/player/wallet', { cookie: admin.cookie, player: true })).status,
    401
  )
  assert.equal((await f.request('/overview', { cookie: player.cookie })).status, 401)
  assert.equal((await f.request('/overview', { cookie: combined })).status, 200)
  assert.equal((await f.request('/overview', { cookie: combined, player: true })).status, 403)
  const wallet = await f.request('/player/wallet', { cookie: combined, player: true })
  assert.equal(wallet.status, 200)
  assert.equal(wallet.headers.get('x-studio-user'), f.users.player.id)
  assert.equal((await wallet.json()).userId, f.users.player.id)
  const switchedWallet = await f.request('/player/wallet', {
    cookie: (await f.login('other', true)).cookie,
    player: true
  })
  assert.equal(switchedWallet.headers.get('x-studio-user'), f.users.other.id)
  assert.equal((await switchedWallet.json()).userId, f.users.other.id)
})

test('独立端真实HTTP：后台角色登录在创建会话和审计前拒绝，复制后台token也不能越权或退出后台', async (t) => {
  const f = await fixture(t)
  const admin = await f.login('admin')
  const beforeSessions = f.service.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  const beforeLogs = f.service.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n
  for (const name of ['admin', f.users.support.username]) {
    const denied = await f.request('/login', {
      cookie: admin.cookie,
      player: true,
      body: { username: name, password }
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('set-cookie'), null)
    await denied.json()
  }
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, beforeSessions)
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, beforeLogs)
  const copied = admin.cookie.replace('studio_session=', 'studio_player_session=')
  assert.equal(await f.session(copied, true), null)
  for (const path of ['/bootstrap', '/overview', '/player/wallet', '/uploads/nonexistent'])
    assert.equal((await f.request(path, { cookie: copied, player: true })).status, 403, path)
  assert.equal(
    (await f.request('/uploads', { cookie: copied, player: true, body: { name: '越权.png' } }))
      .status,
    403
  )
  assert.equal((await f.request('/logout', { cookie: copied, player: true, body: {} })).status, 403)
  assert.equal((await f.session(admin.cookie)).id, 'admin')
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, beforeSessions)
})

test('独立端真实HTTP：后台退出保留打手会话，打手退出保留后台会话并撤销打手推送绑定', async (t) => {
  const f = await fixture(t)
  let admin = await f.login('admin')
  const player = await f.login('player', true)
  let combined = `${admin.cookie}; ${player.cookie}`
  const key = createECDH('prime256v1')
  key.generateKeys()
  const subscribe = await f.request('/player/push-subscriptions', {
    cookie: combined,
    player: true,
    body: {
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/independent-player-test',
        keys: {
          p256dh: key.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url')
        }
      }
    }
  })
  assert.equal(subscribe.status, 200)
  await subscribe.json()
  const staffLogout = await f.request('/logout', { cookie: combined, body: {} })
  assert.equal(staffLogout.status, 200)
  assert.match(staffLogout.headers.get('set-cookie'), /^studio_session=;.*Max-Age=0/)
  assert.equal(await f.session(combined), null)
  assert.equal((await f.session(combined, true)).id, f.users.player.id)
  assert.equal(
    f.service.db.prepare('SELECT COUNT(*) AS n FROM player_push_subscriptions').get().n,
    1
  )
  admin = await f.login('admin')
  combined = `${admin.cookie}; ${player.cookie}`
  const playerLogout = await f.request('/logout', { cookie: combined, player: true, body: {} })
  assert.equal(playerLogout.status, 200)
  assert.match(playerLogout.headers.get('set-cookie'), /^studio_player_session=;.*Max-Age=0/)
  assert.equal(await f.session(combined, true), null)
  assert.equal((await f.session(combined)).id, 'admin')
  assert.equal(
    f.service.db.prepare('SELECT COUNT(*) AS n FROM player_push_subscriptions').get().n,
    0
  )
})

test('独立端真实HTTP：后台停用或关闭登录立即失效，接单和提现开关保持本人权限', async (t) => {
  const f = await fixture(t)
  const admin = await f.login('admin')
  const player = await f.login('player', true)
  const other = await f.login('other', true)
  for (const [name, changes, cookie] of [
    ['player', { playerAccess: { login: false, claim: true, withdraw: true } }, player.cookie],
    ['other', { status: 'disabled' }, other.cookie]
  ]) {
    const update = await f.request('/users', {
      cookie: admin.cookie,
      body: { ...f.users[name], ...changes }
    })
    assert.equal(update.status, 200)
    await update.json()
    assert.equal(await f.session(`${admin.cookie}; ${cookie}`, true), null)
    assert.equal((await f.request('/player/wallet', { cookie, player: true })).status, 401)
    const retry = await f.request('/login', {
      player: true,
      body: { username: f.users[name].username, password }
    })
    assert.equal(retry.status, 401)
    assert.equal(retry.headers.get('set-cookie'), null)
  }
  const reenable = await f.request('/users', {
    cookie: admin.cookie,
    body: { ...f.users.player, playerAccess: { login: true, claim: false, withdraw: false } }
  })
  assert.equal(reenable.status, 200)
  const enabled = await f.login('player', true)
  assert.equal((await f.session(enabled.cookie, true)).id, f.users.player.id)
  assert.equal(
    (await f.request('/player/wallet', { cookie: enabled.cookie, player: true })).status,
    200
  )
  for (const path of ['/player/orders/nonexistent/claim', '/player/withdrawals'])
    assert.equal(
      (await f.request(path, { cookie: enabled.cookie, player: true, body: {} })).status,
      403,
      path
    )
  assert.equal((await f.session(admin.cookie)).id, 'admin')
})

test('独立端真实HTTP：附件读取和上传始终使用打手本人会话，组合Cookie不扩大权限', async (t) => {
  const f = await fixture(t)
  const admin = await f.login('admin')
  const player = await f.login('player', true)
  const other = await f.login('other', true)
  const combined = `${admin.cookie}; ${player.cookie}`
  const upload = await f.request('/uploads', {
    cookie: combined,
    player: true,
    body: { name: '本人图片.png', mime: 'image/png', data: png }
  })
  assert.equal(upload.status, 200)
  const attachment = await upload.json()
  assert.equal(
    f.service.db.prepare('SELECT owner_id FROM uploads WHERE id=?').get(attachment.id).owner_id,
    f.users.player.id
  )
  const own = await f.request(`/uploads/${attachment.id}`, { cookie: combined, player: true })
  assert.equal(own.status, 200)
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), Buffer.from(png, 'base64'))
  assert.equal((await f.request(`/uploads/${attachment.id}`, { cookie: combined })).status, 403)
  assert.equal(
    (await f.request(`/uploads/${attachment.id}`, { cookie: other.cookie, player: true })).status,
    403
  )
  assert.equal(
    (await f.request(`/uploads/${attachment.id}`, { cookie: admin.cookie, player: true })).status,
    401
  )
})

test('独立端真实HTTP：来源校验保留，Secure设置同时作用于登录和退出Cookie', async (t) => {
  const previousSecure = process.env.STUDIO_SECURE_COOKIE
  process.env.STUDIO_SECURE_COOKIE = 'true'
  t.after(() => {
    if (previousSecure === undefined) delete process.env.STUDIO_SECURE_COOKIE
    else process.env.STUDIO_SECURE_COOKIE = previousSecure
  })
  const f = await fixture(t)
  const admin = await f.login('admin')
  const player = await f.login('player', true)
  assert.match(admin.setCookie, /; Secure$/)
  assert.match(player.setCookie, /; Secure$/)
  const combined = `${admin.cookie}; ${player.cookie}`
  for (const path of ['/login', '/logout', '/uploads']) {
    const denied = await f.request(path, {
      cookie: combined,
      player: true,
      body: { username: f.users.player.username, password },
      headers: { Origin: 'https://untrusted-player-client.invalid' }
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('set-cookie'), null)
  }
  assert.equal((await f.session(combined)).id, 'admin')
  assert.equal((await f.session(combined, true)).id, f.users.player.id)
  const logout = await f.request('/logout', { cookie: combined, player: true, body: {} })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0; Secure$/)
})

installTestClientFetch()
