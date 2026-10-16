import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createStudioServer } from '../../server/index.mjs'

// Request-layer client verification: own memory DB, native browser fetch/XHR and random ports.
const output = resolve(process.env.STUDIO_QA_ROOT || 'player-client/.qa', 'request-v31')
await mkdir(output, { recursive: true })
const dependency = createRequire(await realpath(resolve('player-client/node_modules/vite/package.json')))
const { build } = dependency('esbuild')
const bundle = resolve(output, 'request-actor-browser.js')
await build({ entryPoints: [resolve('player-client/tests/request-actor-browser-harness.ts')], outfile: bundle,
  bundle: true, platform: 'browser', format: 'iife', globalName: 'PlayerRequestRuntimeQA', tsconfig: resolve('player-client/tsconfig.json') })
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `isolated-actor-${randomUUID()}`
const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, notificationIntervalMs: 86_400_000 })
await new Promise((ready) => backend.listen(0, '127.0.0.1', ready))
const apiBase = `http://127.0.0.1:${backend.address().port}`
const report = { contract: '稳定性整改共享契约 v3.1 (2026-10-14)', database: ':memory:', cases: [], requests: [], runtimeErrors: [], failures: [], passed: false }
let delayedPath = '', releaseBody, bodyHeld = false, browser, page, adminCookie = '', adminActor = ''
const front = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><script src="/request.js"></script>'); return }
  if (req.url === '/request.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(bundle)); return }
  if (!req.url.startsWith('/api/studio/')) { res.writeHead(404); res.end(); return }
  const headers = { ...req.headers, host: new URL(apiBase).host, 'x-studio-client': 'player' }
  report.requests.push({ path: req.url, method: req.method, actor: headers['x-studio-actor'] || null })
  const outgoing = httpRequest(`${apiBase}${req.url}`, { method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode, response.headers)
    response.pipe(res)
  })
  outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  if (req.url === delayedPath && req.method === 'POST') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks), split = Math.max(1, Math.floor(body.length / 2))
    outgoing.write(body.subarray(0, split))
    // The real server has authenticated headers and is awaiting the rest of the JSON body.
    await new Promise((ready) => setTimeout(ready, 30))
    bodyHeld = true
    await new Promise((ready) => { releaseBody = ready })
    outgoing.end(body.subarray(split))
  } else req.pipe(outgoing)
})
await new Promise((ready) => front.listen(0, '127.0.0.1', ready))
const base = `http://127.0.0.1:${front.address().port}`
report.apiBase = apiBase; report.base = base
async function admin(path, body) {
  const response = await fetch(`${apiBase}/api/studio/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(adminCookie ? { Cookie: adminCookie } : {}),
      ...(adminActor && path !== 'login' && body !== undefined ? { 'X-Studio-Actor': adminActor } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (response.headers.get('set-cookie')) adminCookie = response.headers.get('set-cookie').split(';')[0]
  const result = await response.json()
  if (path === 'login') adminActor = result.user.id
  assert.equal(response.status, 200, `${path}: ${result.message || response.status}`)
  return result
}
const pass = (name) => report.cases.push({ name, passed: true })
try {
  await admin('login', { username: 'admin', password })
  const level = await admin('levels', { name: '请求账号冻结验证等级', delaySeconds: 0 })
  const users = []
  for (const suffix of ['A', 'B']) users.push(await admin('users', { username: `actor-${suffix}`, name: `请求验证${suffix}`, role: 'player',
    status: 'active', levelId: level.id, maxActiveOrders: 2, permissionOverrides: {}, password }))
  const customer = await admin('customers', { name: '隔离请求客户', gameId: 'CLIENT-ONLY-GAME-ID' })
  const template = await admin('templates', { name: '冻结账号请求验证', game: '三角洲行动', amount: 10000, reward: 1001, description: '隔离真实接口', map: '长弓溪谷', active: true })
  const createOrder = () => admin('orders', { requestId: randomUUID(), templateId: template.id, customerId: customer.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'ISOLATED-ROOM', gameId: 'ISOLATED-GAME', amount: 10000,
    reward: 1001, receivedAmount: 10000, paidAt: new Date().toISOString(), dispatchMode: 'pool', playerRemark: '授权说明', remark: '内部说明' })
  const firstOrder = await createOrder(), delayedOrder = await createOrder()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => report.runtimeErrors.push(error.message))
  await page.goto(base)
  await page.evaluate(() => {
    window.qaActor = 'stale-before-login'
    window.qaUnauthorized = 0
    PlayerRequestRuntimeQA.setRequestActorProvider(() => window.qaActor)
    PlayerRequestRuntimeQA.setPrincipalVerifier(() => true)
    PlayerRequestRuntimeQA.setUnauthorizedHandler(() => { window.qaUnauthorized++ })
  })
  const login = async (user) => page.evaluate(async ({ user, password }) => {
    const result = await PlayerRequestRuntimeQA.studioRequest('login', { username: user.username, password }, 'POST')
    window.qaActor = result.user.id
    return result.user.id
  }, { user, password })
  assert.equal(await login(users[0]), users[0].id)
  assert.equal(report.requests.filter((item) => item.path === '/api/studio/login').at(-1).actor, null)
  pass('login sends no actor header even when an old provider value exists')
  await page.evaluate(() => PlayerRequestRuntimeQA.studioRequest('profile', { name: '原生fetch验证A' }, 'POST'))
  assert.equal(report.requests.at(-1).actor, users[0].id)
  pass('native fetch authenticated POST captures and sends current owner')
  await page.evaluate(async ({ original, next }) => {
    window.qaActor = next
    await PlayerRequestRuntimeQA.studioRequest('profile', { name: '原意图账号验证A' }, 'POST', undefined, { expectedActorId: original })
    window.qaActor = original
  }, { original: users[0].id, next: users[1].id })
  assert.equal(report.requests.at(-1).actor, users[0].id)
  pass('explicit original expectedActorId is not replaced by a different provider value')
  const upload = await page.evaluate(async ({ original, next }) => {
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 300, 200); ctx.fillStyle = '#111'; ctx.fillText('清晰上传验证', 20, 50)
    const blob = await new Promise((ready) => canvas.toBlob(ready, 'image/png'))
    const file = new File([blob], 'isolated-evidence.png', { type: 'image/png' })
    const progress = []
    window.qaActor = original
    const result = await PlayerRequestRuntimeQA.uploadStudioImage(file, { kind: 'evidence', onProgress(value) {
      progress.push(value)
      if (value.phase === 'preparing' && value.percent === 0) window.qaActor = next
    } })
    window.qaActor = original
    return { id: result.id, progress }
  }, { original: users[0].id, next: users[1].id })
  assert.equal(report.requests.filter((item) => item.path === '/api/studio/uploads').at(-1).actor, users[0].id)
  assert.ok(upload.progress.some((item) => item.phase === 'uploading' && item.percent === 100))
  pass('native XHR upload freezes owner before compression and reports transport progress')
  assert.equal(await login(users[1]), users[1].id)
  const mismatchId = randomUUID()
  const mismatch = await page.evaluate(async ({ original, order, requestId }) => {
    window.qaActor = original
    PlayerRequestRuntimeQA.setPrincipalVerifier((id) => id === original)
    try { await PlayerRequestRuntimeQA.studioRequest(`player/orders/${order.id}/claim`, { requestId, expectedRevision: order.revision, dispatchRound: order.dispatchRound }, 'POST', undefined, { actorId: original }); return { succeeded: true } }
    catch (error) { return { status: error.status, code: error.code, outcome: error.outcome, requestId: error.requestId, unauthorized: window.qaUnauthorized } }
  }, { original: users[0].id, order: firstOrder, requestId: mismatchId })
  assert.deepEqual({ status: mismatch.status, code: mismatch.code, outcome: mismatch.outcome, requestId: mismatch.requestId },
    { status: 409, code: 'PRINCIPAL_CHANGED', outcome: 'rejected', requestId: mismatchId })
  assert.equal((await admin(`orders/${firstOrder.id}`)).order.leaderId, null)
  pass('B cookie with frozen A header returns atomic 409 PRINCIPAL_CHANGED, not response-header 401, with no claim side effect')
  const missing = await page.evaluate(async ({ order }) => {
    try { await PlayerRequestRuntimeQA.studioRequest(`player/orders/${order.id}/claim`, { requestId: crypto.randomUUID(), expectedRevision: order.revision, dispatchRound: order.dispatchRound }, 'POST', undefined, { expectedActorId: undefined }); return { succeeded: true } }
    catch (error) { return { status: error.status, code: error.code, outcome: error.outcome } }
  }, { order: firstOrder })
  assert.deepEqual(missing, { status: 409, code: 'PRECONDITION_REQUIRED', outcome: 'rejected' })
  assert.equal(report.requests.at(-1).actor, null)
  pass('explicit missing owner does not silently fall back to current provider and preserves atomic PRECONDITION_REQUIRED')
  await page.evaluate(({ id }) => { window.qaActor = id; PlayerRequestRuntimeQA.setPrincipalVerifier((actor) => actor === id) }, { id: users[1].id })
  await page.evaluate(async ({ order }) => PlayerRequestRuntimeQA.studioRequest(`player/orders/${order.id}/claim`,
    { requestId: crypto.randomUUID(), expectedRevision: order.revision, dispatchRound: order.dispatchRound }, 'POST'), { order: firstOrder })
  assert.equal((await admin(`orders/${firstOrder.id}`)).order.leaderId, users[1].id)
  pass('matching owner claim succeeds over the real backend')
  delayedPath = `/api/studio/player/orders/${delayedOrder.id}/claim`
  await page.evaluate(({ order }) => {
    window.qaDelayedResult = PlayerRequestRuntimeQA.studioRequest(`player/orders/${order.id}/claim`,
      { requestId: crypto.randomUUID(), expectedRevision: order.revision, dispatchRound: order.dispatchRound }, 'POST')
      .then(() => ({ succeeded: true }), (error) => ({ status: error.status, code: error.code, outcome: error.outcome }))
  }, { order: delayedOrder })
  for (let attempt = 0; attempt < 100 && !bodyHeld; attempt++) await new Promise((ready) => setTimeout(ready, 10))
  assert.equal(bodyHeld, true)
  await page.evaluate(() => PlayerRequestRuntimeQA.studioRequest('logout', {}, 'POST'))
  releaseBody()
  const expired = await page.evaluate(() => window.qaDelayedResult)
  assert.deepEqual(expired, { status: 401, code: 'SESSION_EXPIRED', outcome: 'rejected' })
  assert.equal((await admin(`orders/${delayedOrder.id}`)).order.leaderId, null)
  pass('session revoked after authenticated headers but before JSON completion returns real 401 SESSION_EXPIRED without claim')
  assert.deepEqual(report.runtimeErrors, [])
  report.passed = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
  process.exitCode = 1
} finally {
  releaseBody?.()
  await browser?.close().catch(() => {})
  const close = async (server) => { server.closeAllConnections?.(); await new Promise((ready) => server.close(ready)) }
  await close(front); await close(backend)
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, requests: report.requests.length, failures: report.failures.map((item) => item.message), output }))
}
