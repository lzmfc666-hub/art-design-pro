import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'
import { sourceFingerprint } from '../../scripts/studio-source-fingerprint.mjs'

// The browser uses real native Web Locks. Only delivery of a native callback's
// result is held, to expose a marker arriving before execute's reservation await.
const output = resolve(process.env.STUDIO_QA_ROOT || '.qa/final-closure-20261014/lock-diagnosis', 'late-marker-v32', `run-${randomUUID()}`)
await mkdir(output, { recursive: true })
const before = sourceFingerprint()
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `late-marker-${randomUUID()}`
const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, maintenanceFromEnv: false, notificationIntervalMs: 86400000,
  notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] } })
const service = backend.service
const mutate = (path, body) => service.mutate('admin', path, { requestId: randomUUID(), ...body })
const level = mutate('/levels', { name: '迟到标记隔离等级', delaySeconds: 0 })
const player = mutate('/users', { username: `late-marker-${randomUUID().slice(0, 8)}`, name: '迟到标记隔离打手', role: 'player', status: 'active',
  levelId: level.id, maxActiveOrders: 2, permissionOverrides: {}, password })
const customer = mutate('/customers', { name: '迟到标记隔离客户', gameId: 'QA' })
const template = mutate('/templates', { name: '迟到原标记真实任务', game: 'QA', amount: 10000, reward: 1001, active: true })
const orders = Array.from({ length: 2 }, () => mutate('/orders', { templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun',
  externalOrderNo: randomUUID(), roomCode: 'QA', amount: 10000, reward: 1001, receivedAmount: 10000, paidAt: new Date().toISOString(), dispatchMode: 'pool' }))
await new Promise(done => backend.listen(0, '127.0.0.1', done))
const apiBase = `http://127.0.0.1:${backend.address().port}`
const client = createPlayerClientServer({ apiTarget: apiBase, staticRoot: resolve('player-client/dist') })
await new Promise(done => client.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${client.address().port}`
const report = { output, apiBase, base, database: ':memory:', cases: [], claims: [], lookups: [], lockTrace: [], runtimeErrors: [], failures: [], passed: false,
  limitations: ['Real desktop Edge native locks plus callback-result scheduling fault; no real phone or production service is used.'] }
let browser, context, first, second
const markerIds = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('__studio_player_unconfirmed_v1__:'))
  .map(key => JSON.parse(localStorage.getItem(key)).requestId))
const clickOrder = (page, orderNo) => page.evaluate(value => {
  const card = [...document.querySelectorAll('.p-order-card')].find(item => item.querySelector('.p-order-no')?.textContent === value)
  card.querySelector('button.p-primary').click()
}, orderNo)
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addInitScript(() => {
    const nativeRequest = navigator.locks.request.bind(navigator.locks)
    window.qaLockTrace = []
    const record = (event, details = {}) => window.qaLockTrace.push({ event, at: Date.now(), ...details })
    window.addEventListener('storage', event => {
      if (event.key?.startsWith('__studio_player_unconfirmed_v1__:')) record('storage-event', { marker: event.newValue ? JSON.parse(event.newValue) : null })
    })
    navigator.locks.request = (name, ...args) => {
      const options = args.length === 2 ? args[0] : {}, callback = args.at(-1)
      record('request', { name, options })
      return nativeRequest(name, options, async lock => {
        record('native-callback', { name, granted: !!lock })
        if (lock && window.qaHoldGranted) {
          window.qaGrantedEntered = true
          await new Promise(done => { window.qaReleaseGranted = done })
        }
        const result = callback(lock)
        if (!lock && window.qaHoldBlockedResult) {
          window.qaBlockedResultEntered = true
          await new Promise(done => { window.qaReleaseBlockedResult = done })
        }
        record('return', { name, result })
        return result
      })
    }
  })
  await context.route('**/api/studio/player/orders/*/claim', async route => {
    const response = await route.fetch({ maxRetries: 0 })
    assert.equal(response.status(), 200)
    report.claims.push({ requestId: route.request().postDataJSON().requestId, path: new URL(route.request().url()).pathname, status: response.status() })
    await route.abort('failed')
  })
  context.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path.includes('/player/operation-results/')) report.lookups.push({ path, status: response.status() })
  })
  first = await context.newPage(); first.setDefaultTimeout(15000)
  first.on('pageerror', error => report.runtimeErrors.push(error.message))
  await first.goto(`${base}/#/player/login`)
  await first.getByLabel('账号', { exact: true }).fill(player.username)
  await first.locator('input[name=password]').fill(password)
  await first.getByRole('button', { name: '登录', exact: true }).click()
  await first.waitForURL('**/#/player/lobby')
  second = await context.newPage(); second.setDefaultTimeout(15000)
  second.on('pageerror', error => report.runtimeErrors.push(error.message))
  await second.goto(`${base}/#/player/lobby`)
  await Promise.all([first.locator('.p-order-card').filter({ hasText: orders[0].orderNo }).waitFor(), second.locator('.p-order-card').filter({ hasText: orders[1].orderNo }).waitFor()])
  await first.evaluate(() => { window.qaHoldGranted = true })
  await clickOrder(first, orders[0].orderNo)
  await first.waitForFunction(() => window.qaGrantedEntered)
  await second.evaluate(() => { window.qaHoldBlockedResult = true })
  await clickOrder(second, orders[1].orderNo)
  await second.waitForFunction(() => window.qaBlockedResultEntered)
  assert.deepEqual(await markerIds(second), [])
  assert.equal(report.claims.length, 0); assert.equal(report.lookups.length, 0)
  await first.evaluate(() => { window.qaReleaseGranted() })
  await Promise.all([first.getByRole('button', { name: '核对结果', exact: true }).waitFor(), second.getByRole('button', { name: '核对结果', exact: true }).waitFor()])
  assert.equal(report.claims.length, 1)
  const originalId = report.claims[0].requestId
  assert.deepEqual(await markerIds(second), [originalId])
  assert.equal(await second.evaluate(() => window.qaLockTrace.some(item => item.event === 'return')), false, 'original marker replaces the waiting draft before blocked reservation returns')
  await second.evaluate(() => { window.qaReleaseBlockedResult() })
  await second.waitForFunction(() => window.qaLockTrace.some(item => item.event === 'return' && item.result === 'blocked'))
  assert.equal(await second.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  assert.equal(await second.locator('.p-order-card').filter({ hasText: orders[1].orderNo }).locator('button.p-primary').isDisabled(), true)
  assert.equal(report.claims.length, 1)
  await second.getByRole('button', { name: '核对结果', exact: true }).click()
  await second.waitForFunction(() => !document.querySelector('.p-operation-state.p-warning'))
  await first.getByRole('button', { name: '核对结果', exact: true }).click()
  await first.waitForFunction(() => !document.querySelector('.p-operation-state.p-warning'))
  assert.ok(report.lookups.length >= 1)
  assert.ok(report.lookups.every(item => item.path.endsWith(`/${originalId}`) && item.status === 200))
  assert.equal(report.claims.length, 1)
  assert.equal(service.orderDetail('admin', orders[0].id).order.leaderId, player.id)
  assert.equal(service.orderDetail('admin', orders[1].id).order.leaderId, null)
  assert.deepEqual(report.runtimeErrors, [])
  report.cases.push({ name: 'original marker arrives before blocked reservation Promise returns; pending draft is replaced, its unsent ID never POSTs/GETs, and only the original operation is confirmed', passed: true })
  report.passed = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1
  await second?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
} finally {
  for (const page of [first, second]) if (page) report.lockTrace.push(...await page.evaluate(() => window.qaLockTrace || []).catch(() => []))
  await browser?.close().catch(() => {})
  const close = async server => { server.closeAllConnections?.(); await new Promise(done => server.close(done)) }
  await close(client); await close(backend)
  const after = sourceFingerprint()
  report.sourceStable = before.digest === after.digest
  await writeFile(resolve(output, 'source-before.json'), JSON.stringify(before, null, 2))
  await writeFile(resolve(output, 'source-after.json'), JSON.stringify(after, null, 2))
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, claims: report.claims.length, lookups: report.lookups.length, sourceStable: report.sourceStable, failures: report.failures.map(item => item.message), output }))
}
