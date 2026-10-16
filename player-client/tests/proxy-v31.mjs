import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createPortProbe } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudioServer } from '../../server/index.mjs'
import { createServer as createViteServer } from '../node_modules/vite/dist/node/index.js'

// Executes the actual client Vite config, its proxy hooks and real HTTP. Echo is
// strictly a transport probe; all auth/business checks use an isolated real backend.
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolve(projectRoot, '..')
const output = resolve(process.env.STUDIO_QA_ROOT || resolve(projectRoot, '.qa'), 'proxy-v31')
await mkdir(output, { recursive: true })
const contract = await readFile(resolve(workspace, 'docs/STUDIO-CONTRACT.md'))
const report = { contract: '稳定性整改共享契约 v3.1 (2026-10-14)', contractSha256: createHash('sha256').update(contract).digest('hex'),
  database: ':memory:', cases: [], requests: [], failures: [], passed: false,
  limitations: ['This validates the explicitly handed-off client Vite proxy; production and root proxies remain owned by the backend task.',
    'No production DB, existing service, real secret, HTTPS deployment or external push provider is used.'] }
const previousCwd = process.cwd(), previousTarget = process.env.STUDIO_API_TARGET
const servers = [], viteServers = [], jars = new Map(), identities = new Map()
let directOrigin
const listen = async (server) => { await new Promise((ready) => server.listen(0, '127.0.0.1', ready)); servers.push(server); return `http://127.0.0.1:${server.address().port}` }
async function availableRandomPort() {
  const probe = createPortProbe()
  await new Promise((ready, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', ready) })
  const port = probe.address().port
  await new Promise((ready) => probe.close(ready))
  return [3006, 3007, 3008, 5173, 5174].includes(port) ? availableRandomPort() : port
}
async function viteAt(target, suffix) {
  process.env.STUDIO_API_TARGET = target
  // Both the actual config's custom loadEnv and Vite's env loader read this clean
  // test directory, never the user's deployment environment files.
  process.chdir(output)
  // Vite treats port 0 as a falsy default. Pick a Node-assigned ephemeral port
  // first, then require it explicitly; if another process takes it, pick again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await availableRandomPort()
    const vite = await createViteServer({ root: projectRoot, envDir: output,
      configFile: resolve(projectRoot, 'vite.config.ts'), mode: 'isolated-proxy-v31',
      cacheDir: resolve(output, `vite-cache-${suffix}`), logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false } })
    try {
      await vite.listen()
      viteServers.push(vite)
      const address = vite.httpServer.address()
      assert.equal(address.port, port)
      assert.ok(![3006, 3007, 3008, 5173, 5174].includes(port))
      return `http://127.0.0.1:${port}`
    } catch (cause) {
      await vite.close().catch(() => {})
      if (cause.code !== 'EADDRINUSE' && !/already in use/i.test(cause.message)) throw cause
      if (attempt === 4) throw cause
    }
  }
}
async function request(origin, path, { actor, body, headers = {}, expected = 200, transport = false } = {}) {
  const method = body === undefined ? 'GET' : 'POST'
  const identity = identities.get(actor)
  const response = await fetch(`${origin}/api/studio/${path}`, { method,
    headers: { ...(jars.has(actor) ? { Cookie: jars.get(actor) } : {}),
      ...(identity?.role === 'player' ? { 'X-Studio-Client': 'player' } : {}),
      ...(method === 'POST' && identity ? { 'X-Studio-Actor': identity.id } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  report.requests.push({ target: transport ? 'transport-only' : 'real-business-api', path, method, actor: actor || 'anonymous', status: response.status })
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`)
  if (path === 'login' && response.status === 200) {
    jars.set(actor, response.headers.get('set-cookie').split(';')[0])
    identities.set(actor, value.user)
  }
  return value
}
const post = (path, body, actor = 'admin') => request(directOrigin, path, { actor, body: { ...body, requestId: body.requestId || randomUUID() } })
const success = (name, details = {}) => report.cases.push({ name, ...details, passed: true })
try {
  const echo = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ transportOnly: true, headers: req.headers, remoteAddress: req.socket.remoteAddress }))
  })
  const echoOrigin = await listen(echo)
  const proxyOrigin = await viteAt(echoOrigin, 'echo')
  const forged = { Forwarded: 'for=203.0.113.99;proto=https;host=attacker.example',
    'X-Forwarded-For': '203.0.113.98, 198.51.100.77', 'X-Forwarded-Host': 'attacker.example',
    'X-Forwarded-Proto': 'https', 'X-Forwarded-Port': '443', 'X-Forwarded-Prefix': '/evil',
    'X-Forwarded-Custom-Trace': 'never-trusted', 'X-Real-IP': '203.0.113.97',
    'X-Studio-Client': 'admin', 'X-Studio-Actor': 'transport-owner',
    Cookie: 'studio_session=transport-admin; studio_player_session=transport-player; other=drop' }
  const probe = await request(proxyOrigin, 'transport-probe', { headers: forged, transport: true })
  assert.equal(probe.transportOnly, true)
  assert.equal(probe.headers.forwarded, undefined)
  assert.equal(probe.headers['x-real-ip'], undefined)
  assert.deepEqual(Object.keys(probe.headers).filter((name) => name.startsWith('x-forwarded-')), ['x-forwarded-for'])
  assert.equal(probe.headers['x-forwarded-for'], '127.0.0.1')
  assert.equal(probe.headers.cookie, 'studio_player_session=transport-player')
  assert.equal(probe.headers['x-studio-client'], 'player')
  assert.equal(probe.headers['x-studio-actor'], 'transport-owner')
  success('Actual Vite proxy removes Forwarded/all incoming X-Forwarded-*/X-Real-IP and uses verified socket source', { source: probe.headers['x-forwarded-for'] })
  success('Actual Vite proxy forwards only worker cookie, fixes player channel, preserves captured actor header')
  const adminOnly = await request(proxyOrigin, 'transport-probe', { headers: { Cookie: 'studio_session=transport-admin; other=drop' }, transport: true })
  assert.equal(adminOnly.headers.cookie, undefined)
  assert.equal(adminOnly.headers['x-studio-client'], 'player')
  success('Admin-only Cookie is removed instead of becoming a worker credential')

  const password = `proxy-v31-${randomUUID()}`
  const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, notificationIntervalMs: 86_400_000,
    trustedProxies: '127.0.0.1', notifications: { publicKey: '', privateKey: '', subject: '' } })
  directOrigin = await listen(backend)
  const businessProxy = await viteAt(directOrigin, 'business')
  Object.assign(report, { echoOrigin, transportProxy: proxyOrigin, apiOrigin: directOrigin, businessProxy })
  await request(directOrigin, 'login', { actor: 'admin', body: { username: 'admin', password } })
  const level = await post('levels', { name: '独立代理真实账号验证', delaySeconds: 0 })
  for (const [actor, role] of [['A', 'player'], ['B', 'player'], ['support', 'support']]) {
    const user = await post('users', { name: `代理验证${actor}`, username: `proxy-${actor}-${randomUUID().slice(0, 8)}`, role,
      status: 'active', levelId: level.id, maxActiveOrders: 3, permissionOverrides: {}, password })
    identities.set(actor, user)
    await request(directOrigin, 'login', { actor, body: { username: user.username, password } })
  }
  const anonymous = await request(businessProxy, 'session', { headers: { Cookie: jars.get('admin'), 'X-Studio-Client': 'admin' } })
  assert.equal(anonymous.user, null)
  await request(businessProxy, 'player/profile', { headers: { Cookie: jars.get('admin') }, expected: 401 })
  const profile = await request(businessProxy, 'player/profile', { headers: { Cookie: `${jars.get('admin')}; ${jars.get('B')}`, 'X-Studio-Client': 'admin', ...Object.fromEntries(Object.entries(forged).filter(([name]) => /^(forwarded|x-forwarded-|x-real-ip)/i.test(name))) } })
  assert.equal(profile.user.id, identities.get('B').id)
  assert.equal(profile.user.role, 'player')
  success('Through actual Vite + real backend, mixed cookie uses B worker identity; admin-only remains unauthenticated')
  const customer = await post('customers', { name: '代理隔离客户', contact: 'NO-REAL-CONTACT', gameId: 'NO-REAL-GAME' })
  const template = await post('templates', { name: '代理真实接单验证', game: '三角洲行动', description: '代理验证公开要求', amount: 2000, reward: 1001, map: '航天基地', active: true })
  const order = await post('orders', { templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(),
    roomCode: 'PROXY-PRIVATE-ROOM', gameId: 'PROXY-PRIVATE-GAME', amount: 2000, reward: 1001, receivedAmount: 2000,
    paidAt: new Date().toISOString(), dispatchMode: 'direct', assignedTo: identities.get('B').id, remark: 'INTERNAL-ONLY', playerRemark: '代理真实验证说明' }, 'support')
  const claimPath = `player/orders/${order.id}/claim`
  const intent = { requestId: randomUUID(), expectedRevision: order.revision, dispatchRound: order.dispatchRound }
  const mismatch = await request(businessProxy, claimPath, { actor: 'B', body: intent, headers: { 'X-Studio-Actor': identities.get('A').id }, expected: 409 })
  assert.equal(mismatch.code, 'PRINCIPAL_CHANGED')
  let latest = await request(directOrigin, `orders/${order.id}`, { actor: 'support' })
  assert.equal(latest.order.status, 'pending')
  assert.equal(latest.order.revision, order.revision)
  assert.equal(latest.order.leaderId, null)
  const notRecorded = await request(businessProxy, `player/operation-results/${intent.requestId}?family=claim`, { actor: 'B' })
  assert.equal(notRecorded.status, 'not-recorded')
  assert.equal(notRecorded.operationConfirmed, false)
  success('B Cookie with captured A actor traverses Vite unchanged and is atomically rejected 409 PRINCIPAL_CHANGED without side effects')
  const missingActor = await request(businessProxy, claimPath, { body: intent, headers: { Cookie: jars.get('B') }, expected: 409 })
  assert.equal(missingActor.code, 'PRECONDITION_REQUIRED')
  latest = await request(directOrigin, `orders/${order.id}`, { actor: 'support' })
  assert.equal(latest.order.revision, order.revision)
  const accepted = await request(businessProxy, claimPath, { actor: 'B', body: intent })
  assert.equal(accepted.leaderId, identities.get('B').id)
  const confirmation = await request(businessProxy, `player/operation-results/${intent.requestId}?family=claim`, { actor: 'B' })
  assert.equal(confirmation.status, 'succeeded')
  assert.equal(confirmation.result, 'confirmation-only')
  assert.equal(confirmation.operationConfirmed, true)
  assert.equal(confirmation.canCreateNew, false)
  assert.equal(confirmation.canRetryWithOriginal, false)
  assert.equal(confirmation.order, undefined)
  success('Missing actor is rejected; correct captured actor succeeds and real GET acknowledgement contains confirmation only')
  report.passed = true
} catch (cause) {
  report.failures.push({ message: cause.message, stack: cause.stack })
  process.exitCode = 1
} finally {
  for (const vite of viteServers.reverse()) await vite.close().catch(() => {})
  for (const server of servers.reverse()) {
    server.closeAllConnections?.()
    await new Promise((ready) => server.close(ready))
  }
  if (previousTarget === undefined) delete process.env.STUDIO_API_TARGET
  else process.env.STUDIO_API_TARGET = previousTarget
  process.chdir(previousCwd)
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, requests: report.requests.length,
    failures: report.failures.map((item) => item.message), output }))
}
