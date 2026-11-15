import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as requestHttp } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createMerchantClientServer } from '../scripts/merchant-client-server.mjs'
import { createStudioServer } from '../server/index.mjs'
import { merchantFixture, merchantPassword, merchantPng } from './helpers/merchant-fixture.mjs'

const merchantHost = 'merchant.jinxiaodun.top'
const merchantOrigin = `https://${merchantHost}`
const indexHTML = '<!doctype html><html><head><title>商家隔离入口</title><script type="module" src="/assets/app.js"></script></head><body><div id="app"></div></body></html>'

function resources(t) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-merchant-proxy-'))
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
  const staticRoot = join(directory, 'site'), servers = []
  mkdirSync(join(staticRoot, 'assets'), { recursive: true })
  writeFileSync(join(staticRoot, 'index.html'), indexHTML)
  writeFileSync(join(staticRoot, 'assets/app.js'), 'window.__isolatedMerchantAsset = true;')
  writeFileSync(join(staticRoot, 'alternate.html'), '<html>PRIVATE-ALTERNATE-HTML</html>')
  writeFileSync(join(staticRoot, '.env'), 'PRIVATE-STATIC-CONFIG')
  writeFileSync(join(directory, 'outside.txt'), 'PRIVATE-OUTSIDE-ROOT')
  t.after(async () => {
    for (const server of [...servers].reverse()) {
      server.closeAllConnections()
      if (server.listening) await new Promise(done => server.close(done))
    }
    rmSync(directory, { recursive: true, force: true })
  })
  const listen = async server => {
    servers.push(server)
    await new Promise((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    })
    assert.ok(![3006, 3007, 3008, 3009, 3011].includes(server.address().port))
    return `http://127.0.0.1:${server.address().port}`
  }
  return { directory, staticRoot, listen }
}

function request(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const target = new URL(base)
    const req = requestHttp({ hostname: target.hostname, port: target.port, path, method,
      headers: { Host: merchantHost, ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
        json() { return JSON.parse(this.body.toString('utf8')) } }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function realFixture(t) {
  const r = resources(t)
  const backend = createStudioServer({ dbPath: ':memory:', seed: false, password: merchantPassword,
    clock: () => new Date('2026-11-08T04:00:00Z'), releaseId: '7'.repeat(64), maintenanceFromEnv: false,
    uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
    notifications: { publicKey: '', privateKey: '', subject: '' } })
  const f = merchantFixture(t, backend.service)
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.accounts[0].id })
  const apiBase = await r.listen(backend)
  const base = await r.listen(createMerchantClientServer({ staticRoot: r.staticRoot, apiTarget: apiBase }))
  const post = (path, body, { cookie, actor, origin = merchantOrigin, channel = 'admin' } = {}) => request(base, '/api/studio' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Studio-Client': channel,
      ...(cookie ? { Cookie: cookie } : {}), ...(actor ? { 'X-Studio-Actor': actor } : {}) }, body: JSON.stringify(body)
  })
  const login = async (username = f.accounts[0].username) => {
    const response = await post('/login', { username, password: merchantPassword })
    assert.equal(response.status, 200, response.body.toString())
    assert.equal(response.headers['set-cookie'].length, 1)
    const cookie = response.headers['set-cookie'][0].split(';')[0]
    assert.match(cookie, /^studio_merchant_session=/)
    return { cookie, user: response.json().user }
  }
  return { ...r, ...f, backend, base, apiBase, post, login }
}

test('merchant gateway fixes its upstream and channel while filtering cookies, credentials and both hop-header directions', async t => {
  const f = resources(t), received = []
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=9999',
      Connection: 'close, x-upstream-private', 'X-Upstream-Private': 'PRIVATE-HOP-RESPONSE',
      'Proxy-Authenticate': 'PRIVATE-PROXY-CHALLENGE', 'X-Studio-User': 'merchant-isolated',
      'Set-Cookie': ['studio_merchant_session=merchant-new; Path=/; HttpOnly',
        'studio_session=PRIVATE-ADMIN; Path=/', 'studio_player_session=PRIVATE-PLAYER; Path=/',
        'studio_merchant_session_extra=PRIVATE-OTHER; Path=/'] })
    res.end(JSON.stringify({ ok: true }))
  })
  const apiTarget = await f.listen(upstream)
  const base = await f.listen(createMerchantClientServer({ staticRoot: f.staticRoot, apiTarget }))
  const payload = Buffer.from([0, 137, 80, 78, 71, 255, 0, 17])
  const response = await request(base, '/api/studio/uploads?isolated=1', { method: 'POST', body: payload,
    headers: { 'Content-Type': 'image/png', 'Content-Length': payload.length, 'X-Upload-Name': '%E5%AE%A2%E6%9C%8D.png',
      Cookie: 'studio_session=PRIVATE-ADMIN; studio_merchant_session=PRIVATE-MERCHANT; studio_player_session=PRIVATE-PLAYER; other=PRIVATE-OTHER',
      'X-Studio-Client': 'admin', 'X-Studio-Actor': 'merchant-current', Origin: merchantOrigin,
      Authorization: 'Bearer PRIVATE-AUTH', 'Proxy-Authorization': 'PRIVATE-PROXY-AUTH',
      Connection: 'keep-alive, x-hop-private', 'X-Hop-Private': 'PRIVATE-HOP-REQUEST',
      'Keep-Alive': 'timeout=999', TE: 'trailers', Upgrade: 'websocket',
      'X-Forwarded-For': '198.51.100.21', 'X-Forwarded-Host': 'evil.invalid', 'X-Forwarded-Proto': 'https',
      'X-Real-IP': '198.51.100.22', Forwarded: 'for=198.51.100.23' } })
  assert.equal(response.status, 200)
  assert.equal(received.length, 1)
  assert.equal(received[0].path, '/api/studio/uploads?isolated=1')
  assert.deepEqual(received[0].body, payload)
  const headers = received[0].headers
  assert.equal(headers.host, merchantHost)
  assert.equal(headers.origin, merchantOrigin)
  assert.equal(headers.cookie, 'studio_merchant_session=PRIVATE-MERCHANT')
  assert.equal(headers['x-studio-client'], 'merchant')
  assert.equal(headers['x-studio-actor'], 'merchant-current')
  assert.equal(headers['x-upload-name'], '%E5%AE%A2%E6%9C%8D.png')
  assert.equal(headers['x-forwarded-for'], '127.0.0.1')
  for (const key of ['authorization', 'proxy-authorization', 'x-hop-private', 'keep-alive', 'te', 'upgrade',
    'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded']) assert.equal(headers[key], undefined, key)
  assert.equal(response.headers['x-studio-user'], 'merchant-isolated')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['x-upstream-private'], undefined)
  assert.equal(response.headers['proxy-authenticate'], undefined)
  assert.deepEqual(response.headers['set-cookie'], ['studio_merchant_session=merchant-new; Path=/; HttpOnly'])
})

test('only an explicitly trusted reverse proxy may supply a client address and cannot choose another backend authority', async t => {
  const f = resources(t), received = []
  const upstream = createServer((req, res) => { received.push(req.headers); res.end('{}') })
  const apiTarget = await f.listen(upstream)
  const base = await f.listen(createMerchantClientServer({ staticRoot: f.staticRoot, apiTarget, trustedProxies: ['127.0.0.1'] }))
  const response = await request(base, '/api/studio/session', { headers: {
    'X-Forwarded-For': '198.51.100.21, 127.0.0.1', 'X-Forwarded-Host': 'evil.invalid',
    'X-Forwarded-Proto': 'https', Forwarded: 'for=198.51.100.22', 'X-Studio-Client': 'player'
  } })
  assert.equal(response.status, 200)
  assert.equal(received[0]['x-forwarded-for'], '198.51.100.21')
  assert.equal(received[0].host, merchantHost)
  assert.equal(received[0]['x-studio-client'], 'merchant')
  for (const key of ['x-forwarded-host', 'x-forwarded-proto', 'forwarded']) assert.equal(received[0][key], undefined)
  for (const invalid of ['file:///private', 'ftp://127.0.0.1', 'http://user:secret@127.0.0.1',
    apiTarget + '/api', apiTarget + '/?secret=1', apiTarget + '/#fragment'])
    assert.throws(() => createMerchantClientServer({ staticRoot: f.staticRoot, apiTarget: invalid }))
})

test('index HTML injects a blocking same-origin merchant entry before modules without changing build bytes', async t => {
  const f = resources(t)
  const base = await f.listen(createMerchantClientServer({ staticRoot: f.staticRoot, apiTarget: 'http://127.0.0.1:1' }))
  const response = await request(base, '/')
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  const html = response.body.toString('utf8')
  const tag = html.match(/<script\b[^>]*\bsrc=["']\/merchant-entry\.js["'][^>]*>\s*<\/script>/)
  assert.ok(tag, html)
  assert.doesNotMatch(tag[0], /\b(?:async|defer)\b|type=["']module["']/)
  assert.ok(html.indexOf(tag[0]) < html.indexOf('type="module"'))
  assert.equal(Number(response.headers['content-length']), response.body.length)
  assert.equal(readFileSync(join(f.staticRoot, 'index.html'), 'utf8'), indexHTML)
  const head = await request(base, '/index.html', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.equal(Number(head.headers['content-length']), response.body.length)
  const deep = await request(base, '/merchant/orders?isolated=1')
  assert.equal(deep.status, 200)
  assert.equal(deep.body.toString(), html)
  const asset = await request(base, '/assets/app.js')
  assert.equal(asset.status, 200)
  assert.deepEqual(asset.body, readFileSync(join(f.staticRoot, 'assets/app.js')))
  assert.match(asset.headers['content-type'], /javascript/)
})

test('entry bootstrap preserves exact merchant hashes and queries while invalid or double-slash entries remain on their original origin', async t => {
  const f = resources(t)
  const base = await f.listen(createMerchantClientServer({ staticRoot: f.staticRoot, apiTarget: 'http://127.0.0.1:1' }))
  const script = await request(base, '/merchant-entry.js')
  assert.equal(script.status, 200)
  assert.equal(script.headers['cache-control'], 'no-store')
  assert.match(script.headers['content-type'], /javascript/)
  const execute = href => {
    let current = new URL(href)
    const replacements = []
    const location = { get href() { return current.href }, get hash() { return current.hash },
      set hash(value) { current.hash = value }, get pathname() { return current.pathname }, get search() { return current.search },
      get origin() { return current.origin }, replace(value) { current = new URL(value, current); replacements.push(current.href) } }
    runInNewContext(script.body.toString('utf8'), { window: { location }, location, URL }, { timeout: 1000 })
    return { current, replacements }
  }
  for (const hash of ['/merchant/login?redirect=%2Fmerchant%2Forders%3Fid%3D1', '/merchant/overview',
    '/merchant/orders?id=PRIVATE-ISOLATED', '/merchant/create', '/merchant/staff?current=2', '/merchant/profile']) {
    const href = merchantOrigin + '/#' + hash, result = execute(href)
    assert.equal(result.current.href, href)
    assert.deepEqual(result.replacements, [])
  }
  for (const suffix of ['/', '/#/auth/login', '/#/dashboard/console', '/#/player/login', '/#/merchant/orders/extra',
    '/#//evil.invalid/merchant/orders', '//evil.invalid/path?next=1#/auth/login']) {
    const result = execute(merchantOrigin + suffix)
    assert.equal(result.current.origin, merchantOrigin)
    assert.equal(result.current.hash, '#/merchant/login')
    assert.equal(result.replacements.length, 1)
  }
})

test('static traversal, alternate HTML and hidden files are denied and unsupported methods never mutate assets', async t => {
  const f = resources(t)
  const base = await f.listen(createMerchantClientServer({ staticRoot: f.staticRoot, apiTarget: 'http://127.0.0.1:1' }))
  for (const path of ['/%2e%2e%2foutside.txt', '/alternate.html', '/.env', '/assets/.secret', '/missing.js', '/api/arbitrary']) {
    const response = await request(base, path)
    assert.ok([400, 403, 404].includes(response.status), `${path}: ${response.status}`)
    assert.doesNotMatch(response.body.toString(), /PRIVATE-/)
  }
  assert.equal((await request(base, '/%invalid')).status, 400)
  const unsupported = await request(base, '/index.html', { method: 'POST', body: 'PRIVATE-WRITE' })
  assert.equal(unsupported.status, 405)
  assert.equal(readFileSync(join(f.staticRoot, 'index.html'), 'utf8'), indexHTML)
  const emptyRoot = join(f.directory, 'unbuilt'); mkdirSync(emptyRoot)
  const unbuilt = await f.listen(createMerchantClientServer({ staticRoot: emptyRoot, apiTarget: 'http://127.0.0.1:1' }))
  assert.equal((await request(unbuilt, '/')).status, 503)
})

test('real merchant host shares the existing API database and role-scoped order visibility without accepting admin or player sessions', async t => {
  const f = await realFixture(t), own = f.order(), foreign = f.order({}, f.accounts[2].id, f.templates[1])
  const admin = f.service.login('admin', merchantPassword), player = f.service.login(f.players[0].username, merchantPassword)
  const onlyForeignCookies = `studio_session=${admin.token}; studio_player_session=${player.token}`
  const anonymous = await request(f.base, '/api/studio/session', { headers: { Cookie: onlyForeignCookies, 'X-Studio-Client': 'admin' } })
  assert.equal(anonymous.status, 200)
  assert.equal(anonymous.json().user, null)
  assert.equal((await request(f.base, '/api/studio/bootstrap', { headers: { Cookie: onlyForeignCookies } })).status, 401)
  assert.equal((await f.post('/login', { username: 'admin', password: merchantPassword })).status, 403)
  const actor = await f.login()
  const cookie = `${onlyForeignCookies}; ${actor.cookie}`
  const session = await request(f.base, '/api/studio/session', { headers: { Cookie: cookie, 'X-Studio-Client': 'player' } })
  assert.equal(session.json().user.id, f.accounts[0].id)
  const bootstrap = await request(f.base, '/api/studio/bootstrap', { headers: { Cookie: cookie } })
  assert.equal(bootstrap.status, 200)
  assert.equal(bootstrap.json().user.role, 'merchant')
  assert.equal(bootstrap.json().user.merchantRole, 'owner')
  const orders = await request(f.base, '/api/studio/orders', { headers: { Cookie: cookie } })
  assert.equal(orders.status, 200)
  assert.deepEqual(orders.json().records.map(row => row.id), [own.id])
  assert.equal((await request(f.base, `/api/studio/orders/${foreign.id}`, { headers: { Cookie: cookie } })).status, 403)
  assert.equal(JSON.stringify(bootstrap.json()).includes('"reward"'), false)
  const disguisedAdmin = await request(f.base, '/api/studio/session', { headers: { Cookie: `studio_merchant_session=${admin.token}` } })
  assert.equal(disguisedAdmin.json().user, null)
})

test('real public appearance and readiness remain reachable while backend control APIs stay denied by real authorization', async t => {
  const f = await realFixture(t)
  for (const path of ['/health/live', '/health/ready', '/appearance/public']) {
    const response = await request(f.base, '/api/studio' + path)
    assert.equal(response.status, 200, response.body.toString())
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  const ready = (await request(f.base, '/api/studio/health/ready')).json()
  assert.equal(ready.release, '7'.repeat(64))
  assert.equal(ready.checks.database, true)
  const actor = await f.login()
  for (const path of ['/merchants', '/runtime/metrics', '/player/wallet', '/ops/summary']) {
    const response = await request(f.base, '/api/studio' + path, { headers: {
      Cookie: actor.cookie, 'X-Studio-Client': 'admin', Authorization: 'Bearer PRIVATE-FORGED-MONITOR'
    } })
    assert.ok([401, 403].includes(response.status), `${path}: ${response.status}`)
  }
  assert.equal((await f.post('/users', { username: 'PRIVATE-ILLEGAL', role: 'super_admin' }, { cookie: actor.cookie, actor: actor.user.id })).status, 403)
  assert.equal((await f.post('/appearance', { revision: 1, config: {} }, { cookie: actor.cookie, actor: actor.user.id })).status, 403)
})

test('preserved merchant HTTPS Origin passes existing API CSRF checks and foreign Origin or actor mismatch still fails', async t => {
  const f = await realFixture(t), actor = await f.login()
  const before = f.service.ordersPage('admin').total
  const invalidOrigin = await f.post('/orders', f.orderBody(), { cookie: actor.cookie, actor: actor.user.id, origin: 'https://evil.invalid' })
  assert.equal(invalidOrigin.status, 403)
  const mismatch = await f.post('/orders', { ...f.orderBody(), expectedActorId: actor.user.id }, { cookie: actor.cookie, actor: 'admin' })
  assert.equal(mismatch.status, 409)
  assert.equal(f.service.ordersPage('admin').total, before)
  const created = await f.post('/orders', { ...f.orderBody(), expectedActorId: actor.user.id }, { cookie: actor.cookie, actor: actor.user.id })
  assert.equal(created.status, 200, created.body.toString())
  assert.equal(created.json().creatorId, actor.user.id)
  assert.equal(created.json().merchantId, f.merchants[0].id)
  assert.equal(f.service.ordersPage('admin').total, before + 1)
})

test('a caller cannot erase a foreign Origin with a Connection token before the shared API validates a write', async t => {
  const f = await realFixture(t), actor = await f.login()
  const before = f.service.bootstrap(actor.user.id).user.name
  const response = await request(f.base, '/api/studio/profile', { method: 'POST',
    headers: { Cookie: actor.cookie, Origin: 'https://evil.invalid', Connection: 'keep-alive, origin',
      'Content-Type': 'application/json', 'X-Studio-Actor': actor.user.id },
    body: JSON.stringify({ name: 'PRIVATE-FOREIGN-ORIGIN-WRITE' }) })
  assert.equal(response.status, 403)
  assert.equal(f.service.bootstrap(actor.user.id).user.name, before)
})

test('real binary uploads and cookie-only private images keep original bytes and revoked merchant sessions cannot reuse them', async t => {
  const f = await realFixture(t), actor = await f.login(f.accounts[1].username)
  const original = Buffer.from(merchantPng, 'base64')
  const uploaded = await request(f.base, '/api/studio/uploads', { method: 'POST', body: original,
    headers: { Cookie: actor.cookie, Origin: merchantOrigin, 'X-Studio-Actor': actor.user.id,
      'Content-Type': 'image/png', 'Content-Length': original.length, 'X-Upload-Name': encodeURIComponent('客服 独立入口.png') } })
  assert.equal(uploaded.status, 200, uploaded.body.toString())
  const image = uploaded.json()
  assert.equal(image.name, '客服 独立入口.png')
  assert.match(image.url, /^\/api\/studio\/merchant\/uploads\//)
  const download = await request(f.base, image.url, { headers: { Cookie: actor.cookie } })
  assert.equal(download.status, 200)
  assert.equal(download.headers['cache-control'], 'no-store')
  assert.deepEqual(download.body, original)
  const foreign = await f.login(f.accounts[2].username)
  assert.equal((await request(f.base, image.url, { headers: { Cookie: foreign.cookie } })).status, 403)
  f.mutate(`/merchant/staff/${actor.user.id}/delete`, {}, f.accounts[0].id)
  assert.equal((await request(f.base, image.url, { headers: { Cookie: actor.cookie } })).status, 401)
  assert.deepEqual(f.service.db.prepare('SELECT data FROM uploads WHERE id=?').get(image.id).data, new Uint8Array(original))
})

test('merchant logout only clears its own cookie and leaves an existing backend login valid', async t => {
  const f = await realFixture(t), actor = await f.login()
  const admin = f.service.login('admin', merchantPassword)
  const loggedOut = await f.post('/logout', {}, { cookie: `studio_session=${admin.token}; ${actor.cookie}` })
  assert.equal(loggedOut.status, 200)
  assert.equal(loggedOut.headers['set-cookie'].length, 1)
  assert.match(loggedOut.headers['set-cookie'][0], /^studio_merchant_session=;/)
  assert.equal(f.service.session(admin.token).id, 'admin')
  assert.equal((await request(f.base, '/api/studio/session', { headers: { Cookie: actor.cookie } })).json().user, null)
})

test('owner transfer in the shared business API invalidates both gateway sessions and refreshed management follows the new owner', async t => {
  const f = await realFixture(t), previous = await f.login(), support = await f.login(f.accounts[1].username)
  const staffPage = cookie => request(f.base, '/api/studio/merchant/staff', { headers: { Cookie: cookie } })
  assert.equal((await staffPage(previous.cookie)).status, 200)
  assert.equal((await staffPage(support.cookie)).status, 403)
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: support.user.id })
  for (const actor of [previous, support]) {
    const session = await request(f.base, '/api/studio/session', { headers: { Cookie: actor.cookie } })
    assert.equal(session.json().user, null)
    assert.equal((await staffPage(actor.cookie)).status, 401)
  }
  const current = await f.login(f.accounts[1].username)
  assert.equal(current.user.merchantRole, 'owner')
  const management = await staffPage(current.cookie)
  assert.equal(management.status, 200)
  assert.equal(management.headers['cache-control'], 'no-store')
  assert.ok(management.json().records.some(row => row.id === previous.user.id && row.status === 'disabled'))
})

test('upstream failure returns an uncached error instead of acknowledging a merchant write', async t => {
  const f = resources(t), closed = createServer()
  await new Promise(done => closed.listen(0, '127.0.0.1', done))
  const port = closed.address().port
  await new Promise(done => closed.close(done))
  const base = await f.listen(createMerchantClientServer({ staticRoot: f.staticRoot, apiTarget: `http://127.0.0.1:${port}` }))
  const response = await request(base, '/api/studio/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), templateId: 'isolated-unavailable' }) })
  assert.equal(response.status, 502)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(typeof response.json().message, 'string')
})
