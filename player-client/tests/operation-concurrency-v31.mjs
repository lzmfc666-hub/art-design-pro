import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'
import { sourceFingerprint } from '../../scripts/studio-source-fingerprint.mjs'

const output = resolve(process.env.STUDIO_QA_ROOT || 'player-client/.qa', 'operation-concurrency-v31')
await mkdir(output, { recursive: true })
const before = sourceFingerprint()
await writeFile(resolve(output, 'source-before.json'), JSON.stringify(before, null, 2))
const dependency = createRequire(await realpath(resolve('player-client/node_modules/vite/package.json')))
const { build } = dependency('esbuild')
const harness = resolve(output, 'guard-harness.js')
await build({ stdin: { contents: "export {studioRequest} from './src/api/studio'; export {readOperationGuard,writeOperationGuard,clearOperationGuard} from './src/api/operationGuard'",
  resolveDir: resolve('player-client'), loader: 'ts', sourcefile: 'operation-concurrency-harness.ts' }, outfile: harness,
  bundle: true, platform: 'browser', format: 'iife', globalName: 'OperationConcurrencyQA', tsconfig: resolve('player-client/tsconfig.json') })
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `isolated-concurrency-${randomUUID()}`
const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, notificationIntervalMs: 86_400_000 })
await new Promise((ready) => backend.listen(0, '127.0.0.1', ready))
const apiBase = `http://127.0.0.1:${backend.address().port}`
const client = createPlayerClientServer({ apiTarget: apiBase, staticRoot: resolve('player-client/dist') })
await new Promise((ready) => client.listen(0, '127.0.0.1', ready))
const base = `http://127.0.0.1:${client.address().port}`
const report = { contract: '稳定性整改共享契约 v3.1 (2026-10-14)', database: ':memory:', apiBase, base,
  cases: [], requests: [], droppedCommittedResponses: [], lookups: [], lockTrace: [], finalMarkers: [], runtimeErrors: [], failures: [], passed: false,
  limitations: ['Fallback cannot promise atomic single submission without Web Locks. Its worst-case record recovery is verified using two actual committed claims with responses dropped and production per-request marker helpers.',
    'Browser verification does not replace real Android/iPhone acceptance or final joint backend regression.'] }
let adminCookie = '', adminActor = '', browser, context, lastPage
async function admin(path, body) {
  const response = await fetch(`${apiBase}/api/studio/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(adminCookie ? { Cookie: adminCookie } : {}),
      ...(adminActor && path !== 'login' && body !== undefined ? { 'X-Studio-Actor': adminActor } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (response.headers.get('set-cookie')) adminCookie = response.headers.get('set-cookie').split(';')[0]
  const result = await response.json()
  if (path === 'login') adminActor = result.user.id
  report.requests.push({ source: 'isolated-admin', path, method: body === undefined ? 'GET' : 'POST', status: response.status })
  assert.equal(response.status, 200, `${path}: ${result.message || response.status}`)
  return result
}
const pass = (name) => report.cases.push({ name, passed: true })
const collectLockTrace = async (ctx) => {
  if (!ctx) return
  for (const page of ctx.pages()) report.lockTrace.push(...await page.evaluate(() => {
    const entries = (window.qaLockTrace || []).slice(window.qaTraceFlushedCount || 0)
    window.qaTraceFlushedCount = window.qaLockTrace?.length || 0
    return entries
  }).catch(() => []))
}
const markers = (page, owner) => page.evaluate((id) => Object.keys(localStorage).filter(key => key.startsWith('__studio_player_unconfirmed_v1__:'))
  .map(key => ({ key, ...JSON.parse(localStorage.getItem(key)) })).filter(item => item.owner === id && item.family === 'claim'), owner)
const waitNoPending = (page) => page.waitForFunction(() => !document.querySelector('.p-operation-state.p-warning') && document.querySelector('.p-lobby-page')?.getAttribute('aria-busy') !== 'true')
async function bounded(promise, phase, timeout = 15000) {
  report.phase = phase
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${phase}`)), timeout) })])
  } finally { clearTimeout(timer) }
}
const setPage = (page) => {
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => report.runtimeErrors.push(error.message))
  lastPage = page
}
async function login(page, user) {
  await page.goto(`${base}/#/player/login`)
  await page.getByLabel('账号', { exact: true }).fill(user.username)
  await page.locator('input[name=password]').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/#/player/lobby')
}
async function installLossRouting(ctx, source) {
  await ctx.route('**/api/studio/player/orders/*/claim', async route => {
    const response = await route.fetch({ maxRetries: 0 })
    const body = route.request().postDataJSON()
    assert.equal(response.status(), 200, 'response is dropped only after an actual successful backend commit')
    report.droppedCommittedResponses.push({ source, requestId: body.requestId, orderPath: new URL(route.request().url()).pathname, status: response.status(), at: Date.now() })
    await route.abort('failed')
  })
  if (!ctx.qaResponseObserver) {
    ctx.qaResponseObserver = true
    ctx.on('response', async response => {
      if (!response.url().includes('/api/studio/')) return
      const path = new URL(response.url()).pathname
      report.requests.push({ source: ctx.qaRequestSource, path, method: response.request().method(), status: response.status() })
      if (path.includes('/player/operation-results/')) report.lookups.push({ source: ctx.qaRequestSource, status: response.status(), result: await response.json().catch(() => null) })
    })
  }
  ctx.qaRequestSource = source
}
try {
  await admin('login', { username: 'admin', password })
  const level = await admin('levels', { name: '并发意图验证等级', delaySeconds: 0 })
  const users = []
  for (const suffix of ['locks', 'fallback']) users.push(await admin('users', { username: `intent-${suffix}`, name: `并发验证${suffix}`,
    role: 'player', status: 'active', levelId: level.id, maxActiveOrders: suffix === 'locks' ? 10 : 2, permissionOverrides: {}, password }))
  const customer = await admin('customers', { name: '隔离并发客户', gameId: 'CLIENT-CONCURRENCY-GAME' })
  const template = await admin('templates', { name: '并发意图真实订单', game: '三角洲行动', amount: 10000, reward: 1001, description: '隔离客户端并发', map: '长弓溪谷', active: true })
  const orders = []
  for (let index = 0; index < 6; index++) orders.push(await admin('orders', { requestId: randomUUID(), templateId: template.id, customerId: customer.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'CONCURRENCY-ROOM', gameId: 'CONCURRENCY-GAME', amount: 10000,
    reward: 1001, receivedAmount: 10000, paidAt: new Date().toISOString(), dispatchMode: 'pool', playerRemark: '授权并发验证说明', remark: '内部资料不展示' }))
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addInitScript(() => {
    const nativeRequest = navigator.locks.request.bind(navigator.locks)
    const nativeGet = Storage.prototype.getItem, nativeSet = Storage.prototype.setItem, nativeRemove = Storage.prototype.removeItem, nativeKey = Storage.prototype.key
    const nativeLength = Object.getOwnPropertyDescriptor(Storage.prototype, 'length').get
    const markerPrefix = '__studio_player_unconfirmed_v1__:'
    const tab = crypto.randomUUID()
    let sequence = 0
    window.qaLockTrace = []
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.qaPauseCoordinator ? 'hidden' : visibility.call(document) })
    // Memory-only tracing avoids extra localStorage reads/console IPC that could mask timing.
    const trace = (event, details = {}) => window.qaLockTrace.push({ tab, phase: window.qaLockPhase || 'held-reservation', sequence: ++sequence, at: Date.now(), event, ...details })
    Object.defineProperty(Storage.prototype, 'length', { configurable: true, get() {
      const value = nativeLength.call(this)
      if (this === localStorage) trace('storage-length-read', { value })
      return value
    } })
    Storage.prototype.key = function (index) {
      const value = nativeKey.call(this, index)
      if (this === localStorage) trace('storage-key-read', { index, key: value?.startsWith(markerPrefix) ? value : '<other>' })
      return value
    }
    Storage.prototype.getItem = function (key) {
      const value = nativeGet.call(this, key)
      if (this === localStorage && key.startsWith(markerPrefix)) trace('marker-read', { key, marker: value ? JSON.parse(value) : null })
      return value
    }
    Storage.prototype.setItem = function (key, value) {
      const result = nativeSet.call(this, key, value)
      if (this === localStorage && key.startsWith(markerPrefix)) trace('marker-written', { key, marker: JSON.parse(value) })
      return result
    }
    Storage.prototype.removeItem = function (key) {
      const result = nativeRemove.call(this, key)
      if (this === localStorage && key.startsWith(markerPrefix)) trace('marker-removed', { key })
      return result
    }
    window.addEventListener('storage', event => {
      if (event.key?.startsWith(markerPrefix)) trace('storage-event', { key: event.key, newMarker: event.newValue ? JSON.parse(event.newValue) : null })
    })
    window.qaLockRequests = []
    navigator.locks.request = (name, ...args) => {
      const callback = args.at(-1), options = args.length === 2 ? args[0] : {}
      window.qaLockRequests.push(name)
      trace('lock-request', { name, options })
      return nativeRequest(name, options, async lock => {
        trace('lock-callback-enter', { name, granted: !!lock })
        if (lock && window.qaHoldReservation) {
          window.qaLockEntered = true
          await new Promise(ready => { window.qaReleaseReservation = ready })
        }
        const result = callback(lock)
        trace('lock-callback-exit', { name, granted: !!lock, result: typeof result === 'string' ? result : '<async>' })
        return result
      })
    }
  })
  await installLossRouting(context, 'web-locks')
  const first = await context.newPage(); setPage(first)
  await login(first, users[0])
  const second = await context.newPage(); setPage(second)
  await second.goto(`${base}/#/player/lobby`)
  await Promise.all([first.locator('.p-order-card').filter({ hasText: orders[0].orderNo }).waitFor(), second.locator('.p-order-card').filter({ hasText: orders[1].orderNo }).waitFor()])
  await first.evaluate((orderNo) => {
    window.qaHoldReservation = true
    const card = [...document.querySelectorAll('.p-order-card')].find(item => item.querySelector('.p-order-no')?.textContent === orderNo)
    card.querySelector('button.p-primary').click()
  }, orders[0].orderNo)
  await first.waitForFunction(() => window.qaLockEntered === true)
  await second.evaluate((orderNo) => {
    const card = [...document.querySelectorAll('.p-order-card')].find(item => item.querySelector('.p-order-no')?.textContent === orderNo)
    card.querySelector('button.p-primary').click()
  }, orders[1].orderNo)
  await second.waitForFunction(() => window.qaLockRequests.length === 1)
  await second.getByText('另一页面正在保留同类操作，正在核对待确认标记。本页不会新建或提交请求。', { exact: true }).waitFor()
  const blockedCard = second.locator('.p-order-card').filter({ hasText: orders[1].orderNo }).locator('button.p-primary')
  assert.equal(await blockedCard.isDisabled(), true)
  assert.equal((await markers(second, users[0].id)).length, 0, 'no unsent second request ID is persisted while original marker is not yet written')
  await second.evaluate((orderNo) => {
    const card = [...document.querySelectorAll('.p-order-card')].find(item => item.querySelector('.p-order-no')?.textContent === orderNo)
    card.querySelector('button.p-primary').click()
  }, orders[1].orderNo)
  assert.equal(await second.evaluate(() => window.qaLockRequests.length), 1, 'blocked family cannot open another reservation before storage sync')
  assert.equal(report.droppedCommittedResponses.length, 0, 'held reservation has not sent either original or blocked request')
  // Refresh only the contending page's real session while the owner is paused in
  // reservation. The unsent draft must remain sending and never be result-queried.
  await first.evaluate(() => { window.qaPauseCoordinator = true; document.dispatchEvent(new Event('visibilitychange')) })
  await admin('users', { ...users[0], playerAccess: { login: true, claim: true, withdraw: false } })
  await second.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__
    const pinia = Object.getOwnPropertySymbols(app._context.provides).map(key => app._context.provides[key]).find(value => value?._s instanceof Map)
    await pinia._s.get('player-session').checkSession(true)
  })
  await second.getByText('账号权限已更新，仍在核对另一页面的待确认标记。本页不会提交请求。', { exact: true }).waitFor()
  assert.equal((await markers(second, users[0].id)).length, 0)
  assert.equal(report.requests.filter(item => item.source === 'web-locks' && item.path.includes('/player/operation-results/')).length, 0)
  assert.equal(await blockedCard.isDisabled(), true)
  pass('same-account permission refresh while a contending reservation has no marker keeps the unsent draft gated and never queries its new ID')
  await first.evaluate(() => { window.qaHoldReservation = false; window.qaReleaseReservation() })
  await Promise.all([first.getByRole('button', { name: '核对结果', exact: true }).waitFor(), second.getByRole('button', { name: '核对结果', exact: true }).waitFor()])
  assert.equal(report.droppedCommittedResponses.filter(item => item.source === 'web-locks').length, 1)
  const originalMarker = await markers(first, users[0].id)
  assert.equal(originalMarker.length, 1)
  assert.equal(originalMarker[0].requestId, report.droppedCommittedResponses[0].requestId)
  pass('native ifAvailable rejects a contending reservation; its sending gate stays closed before any marker arrives, then only the original real claim commits')
  await collectLockTrace(context)
  await first.reload()
  await first.getByRole('button', { name: '核对结果', exact: true }).waitFor()
  assert.equal((await markers(first, users[0].id))[0].requestId, originalMarker[0].requestId)
  assert.equal(await first.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  pass('whole-page reload restores the original request ID without a body or retry permission')
  await first.getByRole('button', { name: '核对结果', exact: true }).click()
  await Promise.all([waitNoPending(first), waitNoPending(second)])
  assert.equal((await markers(first, users[0].id)).length, 0)
  const active = await first.evaluate(async () => (await (await fetch('/api/studio/player/profile')).json()).activeOrders)
  assert.equal(active, 1)
  assert.equal((await admin(`orders/${orders[0].id}`)).order.leaderId, users[0].id)
  assert.equal((await admin(`orders/${orders[1].id}`)).order.leaderId, null)
  pass('real succeeded lookup acknowledges only the original request, clears both pending tabs and current active count remains one')

  // The reservation lock is already released while the actual committed HTTP
  // response is held. A second tab still blocks on the original unresolved marker.
  await Promise.all([first.evaluate(() => { window.qaLockPhase = 'http-response-held' }), second.evaluate(() => { window.qaLockPhase = 'http-response-held' })])
  let releaseHeldResponse, enteredHeldResponse
  const heldResponse = new Promise(ready => { releaseHeldResponse = ready })
  const enteredResponse = new Promise(ready => { enteredHeldResponse = ready })
  await context.unroute('**/api/studio/player/orders/*/claim')
  await context.route('**/api/studio/player/orders/*/claim', async route => {
    const response = await route.fetch({ maxRetries: 0 })
    assert.equal(response.status(), 200)
    report.droppedCommittedResponses.push({ source: 'http-response-held', requestId: route.request().postDataJSON().requestId,
      orderPath: new URL(route.request().url()).pathname, status: response.status(), at: Date.now() })
    enteredHeldResponse()
    await bounded(heldResponse, 'release-held-real-http-response', 30000)
    await route.abort('failed')
  })
  await first.locator('.p-order-card').filter({ hasText: orders[1].orderNo }).locator('button.p-primary').click()
  await bounded(enteredResponse, 'real-claim-post-after-current-read-finished')
  const heldLocks = await first.evaluate(async () => (await navigator.locks.query()).held.filter(lock => lock.name.startsWith('__studio_player_unconfirmed_v1__:')))
  assert.deepEqual(heldLocks, [], 'no operation lock may cover a network request')
  await second.getByRole('button', { name: '核对结果', exact: true }).waitFor()
  const lateButton = second.locator('.p-order-card').filter({ hasText: orders[4].orderNo }).locator('button.p-primary')
  assert.equal(await lateButton.isDisabled(), true)
  await second.evaluate((orderNo) => {
    const card = [...document.querySelectorAll('.p-order-card')].find(item => item.querySelector('.p-order-no')?.textContent === orderNo)
    card.querySelector('button.p-primary').click()
  }, orders[4].orderNo)
  assert.equal(report.droppedCommittedResponses.filter(item => item.source === 'http-response-held').length, 1)
  const heldMarker = await markers(second, users[0].id)
  assert.equal(heldMarker.length, 1)
  assert.equal(heldMarker[0].requestId, report.droppedCommittedResponses.find(item => item.source === 'http-response-held').requestId)
  releaseHeldResponse()
  await first.getByRole('button', { name: '核对结果', exact: true }).waitFor()
  await first.getByRole('button', { name: '核对结果', exact: true }).click()
  await Promise.all([waitNoPending(first), waitNoPending(second)])
  assert.equal((await admin(`orders/${orders[4].id}`)).order.leaderId, null)
  pass('after reservation release and real backend commit, held original HTTP response keeps the second tab blocked without holding the network in Web Locks')

  // No lock callback is artificially held: both real pages click different
  // authorized orders concurrently. Preserve the original no-duplicate assertion.
  await Promise.all([first.evaluate(() => { window.qaLockPhase = 'unforced-concurrent'; window.qaHoldReservation = false }), second.evaluate(() => { window.qaLockPhase = 'unforced-concurrent'; window.qaHoldReservation = false })])
  await context.unroute('**/api/studio/player/orders/*/claim')
  await installLossRouting(context, 'unforced-concurrent')
  await Promise.all([first.locator('.p-order-card').filter({ hasText: orders[4].orderNo }).waitFor(), second.locator('.p-order-card').filter({ hasText: orders[5].orderNo }).waitFor()])
  await Promise.all([first, second].map((page, index) => page.evaluate(orderNo => {
    const card = [...document.querySelectorAll('.p-order-card')].find(item => item.querySelector('.p-order-no')?.textContent === orderNo)
    card.querySelector('button.p-primary').click()
  }, orders[index + 4].orderNo)))
  await Promise.all([first.getByRole('button', { name: '核对结果', exact: true }).waitFor(), second.getByRole('button', { name: '核对结果', exact: true }).waitFor()])
  assert.equal(report.droppedCommittedResponses.filter(item => item.source === 'unforced-concurrent').length, 1)
  assert.equal((await markers(first, users[0].id)).length, 1)
  await collectLockTrace(context)
  await first.reload()
  await first.getByRole('button', { name: '核对结果', exact: true }).click()
  await waitNoPending(first)
  // Either page can win this unforced race. If the second page owns the full
  // unknown intent, removal of another tab's marker is not a server confirmation.
  if (await second.getByRole('button', { name: '核对结果', exact: true }).count()) await second.getByRole('button', { name: '核对结果', exact: true }).click()
  await Promise.all([waitNoPending(first), waitNoPending(second)])
  const unforcedActive = await first.evaluate(async () => (await (await fetch('/api/studio/player/profile')).json()).activeOrders)
  assert.equal(unforcedActive, 3)
  const outcomes = await Promise.all([orders[4], orders[5]].map(order => admin(`orders/${order.id}`)))
  assert.equal(outcomes.filter(result => result.order.leaderId === users[0].id).length, 1)
  pass('unforced concurrent clicks from two real tabs commit one original request; refresh and result acknowledgement preserve the exact original marker')

  // Cancel the owner before reservation can write: it must not turn the unsent
  // request into unknown on the same-account permission revision, or send it later.
  const unused = outcomes.find(result => !result.order.leaderId).order
  await first.evaluate(() => { window.qaLockPhase = 'reservation-permission-cancel'; window.qaHoldReservation = true; window.qaLockEntered = false })
  const committedBeforeCancel = report.droppedCommittedResponses.length
  const lookupsBeforeCancel = report.requests.filter(item => item.path.includes('/player/operation-results/')).length
  await first.evaluate(orderNo => {
    const card = [...document.querySelectorAll('.p-order-card')].find(item => item.querySelector('.p-order-no')?.textContent === orderNo)
    card.querySelector('button.p-primary').click()
  }, unused.orderNo)
  await first.waitForFunction(() => window.qaLockEntered === true)
  await admin('users', { ...users[0], playerAccess: { login: true, claim: true, withdraw: true } })
  await first.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__
    const pinia = Object.getOwnPropertySymbols(app._context.provides).map(key => app._context.provides[key]).find(value => value?._s instanceof Map)
    await pinia._s.get('player-session').checkSession(true)
  })
  await first.getByText('账号权限已更新，仍在核对另一页面的待确认标记。本页不会提交请求。', { exact: true }).waitFor()
  assert.equal(await first.getByRole('button', { name: '核对结果', exact: true }).count(), 0)
  await first.evaluate(() => { window.qaHoldReservation = false; window.qaReleaseReservation() })
  await first.waitForFunction(() => window.qaLockTrace.some(item => item.phase === 'reservation-permission-cancel' && item.event === 'lock-callback-exit' && item.result === 'canceled'))
  assert.equal(report.droppedCommittedResponses.length, committedBeforeCancel)
  assert.equal(report.requests.filter(item => item.path.includes('/player/operation-results/')).length, lookupsBeforeCancel)
  assert.equal((await markers(first, users[0].id)).length, 0)
  assert.equal(await first.locator('.p-order-card').filter({ hasText: unused.orderNo }).locator('button.p-primary').isDisabled(), true)
  await collectLockTrace(context)
  await first.reload()
  await first.locator('.p-order-card').filter({ hasText: unused.orderNo }).locator('button.p-primary').waitFor()
  assert.equal(await first.locator('.p-order-card').filter({ hasText: unused.orderNo }).locator('button.p-primary').isDisabled(), false)
  pass('permission update before reservation returns cancels the unsent owner ID without POST/GET or persistence; conservative gate survives until a fresh reload')
  await first.screenshot({ path: `${output}/web-locks-confirmed.png` })
  await collectLockTrace(context)
  await context.close(); context = undefined

  context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }))
  await installLossRouting(context, 'fallback-record-recovery')
  const fallbackFirst = await context.newPage(); setPage(fallbackFirst)
  await login(fallbackFirst, users[1])
  const fallbackSecond = await context.newPage(); setPage(fallbackSecond)
  await fallbackSecond.goto(`${base}/#/player/lobby`)
  await fallbackSecond.locator('.p-header').waitFor()
  await Promise.all([fallbackFirst.addScriptTag({ path: harness }), fallbackSecond.addScriptTag({ path: harness })])
  const requestIds = [randomUUID(), randomUUID()]
  report.fallbackRequestIds = requestIds
  const unknowns = await Promise.all([fallbackFirst, fallbackSecond].map((page, index) => page.evaluate(async ({ owner, order, requestId, index }) => {
    OperationConcurrencyQA.writeOperationGuard({ owner, family: 'claim', requestId, createdAt: Date.now() + index })
    try {
      await OperationConcurrencyQA.studioRequest(`player/orders/${order.id}/claim`, { requestId, expectedRevision: order.revision, dispatchRound: order.dispatchRound }, 'POST', undefined, { expectedActorId: owner })
      return { success: true }
    } catch (error) { return { outcome: error.outcome, requestId: error.requestId } }
  }, { owner: users[1].id, order: orders[index + 2], requestId: requestIds[index], index })))
  assert.deepEqual(unknowns.map(item => item.outcome), ['unknown', 'unknown'])
  assert.equal(report.droppedCommittedResponses.filter(item => item.source === 'fallback-record-recovery').length, 2)
  assert.deepEqual((await markers(fallbackFirst, users[1].id)).map(item => item.requestId).sort(), [...requestIds].sort())
  assert.equal((await admin(`orders/${orders[2].id}`)).order.leaderId, users[1].id)
  assert.equal((await admin(`orders/${orders[3].id}`)).order.leaderId, users[1].id)
  pass('without Web Locks, two actual successful-but-unacknowledged request IDs occupy separate production markers and neither overwrites the other')
  // Seed only the old marker format with a real committed request ID, to verify compatibility.
  await fallbackFirst.evaluate(({ owner, requestId }) => {
    const oldest = Math.min(...Object.keys(localStorage).filter(key => key.startsWith('__studio_player_unconfirmed_v1__:'))
      .map(key => JSON.parse(localStorage.getItem(key))).filter(marker => marker.owner === owner && marker.family === 'claim').map(marker => marker.createdAt))
    localStorage.setItem(`__studio_player_unconfirmed_v1__:${encodeURIComponent(owner)}:claim`, JSON.stringify({ owner, family: 'claim', requestId, createdAt: oldest - 1 }))
  }, { owner: users[1].id, requestId: requestIds[0] })
  await Promise.all([fallbackFirst.reload(), fallbackSecond.reload()])
  await Promise.all([fallbackFirst.getByRole('button', { name: '核对结果', exact: true }).waitFor(), fallbackSecond.getByRole('button', { name: '核对结果', exact: true }).waitFor()])
  assert.equal(await fallbackFirst.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  await fallbackFirst.getByRole('button', { name: '核对结果', exact: true }).click()
  await fallbackFirst.waitForFunction((remaining) => Object.keys(localStorage).filter(key => key.startsWith('__studio_player_unconfirmed_v1__:'))
    .map(key => JSON.parse(localStorage.getItem(key))).filter(item => item.family === 'claim').every(item => item.requestId === remaining), requestIds[1])
  const remaining = await markers(fallbackFirst, users[1].id)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].requestId, requestIds[1])
  pass('first real succeeded lookup removes only its request ID and its legacy single-slot alias; the second unknown request remains locked')
  await fallbackFirst.getByRole('button', { name: '核对结果', exact: true }).click()
  await Promise.all([waitNoPending(fallbackFirst), waitNoPending(fallbackSecond)])
  assert.equal((await markers(fallbackFirst, users[1].id)).length, 0)
  const fallbackActive = await fallbackFirst.evaluate(async () => (await (await fetch('/api/studio/player/profile')).json()).activeOrders)
  assert.equal(fallbackActive, 2)
  pass('second real succeeded lookup independently clears its record and both tabs refresh the actual two active tasks')
  await fallbackFirst.screenshot({ path: `${output}/fallback-confirmed.png` })
  assert.deepEqual(report.runtimeErrors, [])
  report.passed = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await collectLockTrace(context)
  for (const page of context?.pages() || []) report.finalMarkers.push(await page.evaluate(() => ({
    markers: Object.keys(localStorage).filter(key => key.startsWith('__studio_player_unconfirmed_v1__:')).map(key => ({ key, ...JSON.parse(localStorage.getItem(key)) })),
    message: document.querySelector('.p-operation-state')?.textContent || '',
    busy: document.querySelector('.p-lobby-page')?.getAttribute('aria-busy'),
    controls: [...document.querySelectorAll('.p-order-card button.p-primary')].map(button => ({ label: button.textContent, disabled: button.disabled }))
  })).catch(() => ({ unavailable: true })))
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  const close = async (server) => { server.closeAllConnections?.(); await new Promise((ready) => server.close(ready)) }
  await close(client); await close(backend)
  const after = sourceFingerprint()
  report.sourceStable = before.digest === after.digest
  report.finalVersionValid = report.passed && report.sourceStable
  await writeFile(resolve(output, 'source-after.json'), JSON.stringify(after, null, 2))
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, sourceStable: report.sourceStable, cases: report.cases.length, droppedCommittedResponses: report.droppedCommittedResponses.length,
    requests: report.requests.length, failures: report.failures.map(item => item.message), output }))
}
