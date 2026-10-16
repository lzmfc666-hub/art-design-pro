import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudioServer } from '../server/index.mjs'
import { testMutate } from '../tests/helpers/current-intent.mjs'

// Owns its new QA database, certificate and ephemeral servers. No .env, existing
// database, ops directory, cloud host or external push endpoint is used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const output = resolve('.qa/browser-compat-20261016', `run-${randomUUID()}`)
const database = join(output, 'test.sqlite')
assert.ok(database.startsWith(resolve('.qa') + sep))
mkdirSync(output, { recursive: true })
const capabilitiesOnly = process.argv.includes('--capabilities-only')
const password = `browser-compat-isolated-${randomUUID()}`
const hostname = 'studio-compat.test'
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const report = {
  passed: false,
  scope: capabilitiesOnly ? 'capabilities-only' : 'built-admin-http-and-https',
  output, database, startedAt: new Date().toISOString(), cases: [], contexts: [],
  browserPosts: [], controlledTransport: [], pageErrors: [], consoleErrors: [], blockedExternal: [],
  isolation: { newQaDatabase: true, maintenanceFromEnv: false, backups: false,
    uploadCleanup: false, externalPush: false, certificate: 'new self-signed test certificate only' },
  limitations: ['Local Edge with a temporary test certificate is not cloud or public certificate acceptance.',
    'This checks the admin compatibility regression and one real funds retry, not complete business or capacity acceptance.']
}
const pass = name => { report.cases.push(name); console.log(`PASS ${name}`) }
const hash = value => createHash('sha256').update(value).digest('hex')
let api, tls, browser, currentPage, stage = 'initialization'

function buildFingerprint() {
  const files = []
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else files.push(child)
    }
  }
  walk(resolve('dist'))
  const entries = Object.fromEntries(files.sort().map(path => [relative(root, path).replaceAll('\\', '/'), hash(readFileSync(path))]))
  return { fileCount: files.length, digest: hash(JSON.stringify(entries)) }
}
async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  assert.ok(![3006, 3007, 3008].includes(port))
  return port
}
async function close(server) {
  if (!server?.listening) return
  server.closeAllConnections?.()
  await new Promise(done => server.close(done))
}
function certificate() {
  const executable = process.env.STUDIO_QA_OPENSSL ||
    (existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl')
  const key = join(output, 'test-key.pem'), cert = join(output, 'test-cert.pem')
  execFileSync(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', `/CN=${hostname}`,
    '-addext', `subjectAltName=DNS:${hostname}`], { stdio: 'ignore', windowsHide: true })
  return { key: readFileSync(key), cert: readFileSync(cert) }
}
function fixture(service) {
  const mutate = (path, body) => testMutate(service, 'admin', path, body)
  const level = mutate('/levels', { name: '浏览器兼容隔离等级', delaySeconds: 0 })
  const player = mutate('/users', { username: 'compat-player', name: '兼容验证打手', role: 'player',
    status: 'active', levelId: level.id, maxActiveOrders: 3, permissionOverrides: {}, password })
  const customer = mutate('/customers', { name: '兼容验证老板', gameId: 'QA-COMPAT', contact: 'QA fictional contact' })
  return { player, customer }
}
const dialog = page => page.locator('.business-detail-page-panel:visible,.el-dialog:visible').last()
const drawer = page => page.locator('.business-detail-page-panel:visible,.el-drawer:visible').last()
const rows = scope => scope.locator('.el-table__body tr')
const field = (page, scope, label) => scope.locator('.el-form-item').filter({ has: page.getByText(label, { exact: true }) }).first()
async function closeDialog(page) {
  const scope = dialog(page)
  const pageKey = await scope.getAttribute('data-page-key')
  await scope.getByRole('button', { name: '取消', exact: true }).click()
  // A nested page closes back to a visible parent; bind this wait to its key.
  if (pageKey) await page.locator(`[data-page-key="${pageKey}"]`).waitFor({ state: 'hidden' })
  else await scope.waitFor({ state: 'hidden' })
}
async function json(page, path) {
  return page.evaluate(async path => {
    const response = await fetch(`/api/studio/${path}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`QA GET failed: ${response.status}`)
    return response.json()
  }, path)
}
async function contextFor(origin, protocol) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(20_000)
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
    report.blockedExternal.push({ protocol, origin: url.origin, pathname: url.pathname })
    return route.abort('blockedbyclient')
  })
  await context.addInitScript(() => {
    const capability = { secureContext: window.isSecureContext,
      randomUUID: typeof globalThis.crypto?.randomUUID,
      getRandomValues: typeof globalThis.crypto?.getRandomValues,
      nativeCalls: 0, fallbackCalls: 0 }
    window.__studioCompat = capability
    const crypto = globalThis.crypto
    if (typeof crypto?.randomUUID === 'function') {
      const original = crypto.randomUUID.bind(crypto)
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => {
        capability.nativeCalls++
        return original()
      } })
    }
    if (typeof crypto?.getRandomValues === 'function') {
      const original = crypto.getRandomValues.bind(crypto)
      Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: array => {
        capability.fallbackCalls++
        return original(array)
      } })
    }
  })
  const page = await context.newPage()
  currentPage = page
  page.on('pageerror', error => report.pageErrors.push({ protocol, message: error.message }))
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push({ protocol, message: message.text() })
  })
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().includes('/api/studio/') || request.url().endsWith('/login')) return
    const body = request.postDataJSON()
    report.browserPosts.push({ protocol, path: new URL(request.url()).pathname,
      requestId: body?.requestId, signature: hash(JSON.stringify(body)) })
  })
  await page.goto(`${origin}/#/login`)
  const capability = await page.evaluate(() => window.__studioCompat)
  assert.equal(capability.secureContext, protocol === 'https')
  assert.equal(capability.randomUUID, protocol === 'https' ? 'function' : 'undefined')
  assert.equal(capability.getRandomValues, 'function')
  pass(`${protocol}: real browser origin exposes expected secure-context crypto capabilities`)
  if (!capabilitiesOnly) {
    const status = await page.evaluate(async password => (await fetch('/api/studio/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password })
    })).status, password)
    assert.equal(status, 200)
    // The app derives its in-memory framework identity during document bootstrap.
    // Re-enter it with the real server cookie instead of fabricating client state.
    await page.reload()
  }
  return { context, page, capability }
}
async function exercise(origin, protocol, fixtures) {
  const { context, page, capability } = await contextFor(origin, protocol)
  try {
    if (capabilitiesOnly) { report.contexts.push({ protocol, origin, ...capability }); return }
    stage = `${protocol}: refunds`
    await page.goto(`${origin}/#/finance/settlement?tab=refunds`)
    await page.getByRole('heading', { name: '财务结算', exact: true }).waitFor()
    await page.getByRole('button', { name: '登记实际退款', exact: true }).click()
    await dialog(page).getByText('退款金额与原因', { exact: true }).waitFor()
    await field(page, dialog(page), '实际退款金额（元）').locator('input').fill('1')
    await field(page, dialog(page), '退款原因').locator('textarea').fill('隔离兼容验证，取消不提交')
    await closeDialog(page)
    pass(`${protocol}: refunds module initializes and regenerates draft request IDs`)

    stage = `${protocol}: customer balance and lost-result retry`
    await page.goto(`${origin}/#/personnel/customers`)
    await page.getByRole('heading', { name: '老板管理', exact: true }).waitFor()
    await rows(page).filter({ hasText: fixtures.customer.name }).getByRole('button', { name: '储值账户', exact: true }).click()
    await dialog(page).getByText('可用储值余额', { exact: true }).waitFor()
    const before = await json(page, `customers/${fixtures.customer.id}/transactions`)
    const balanceBefore = await json(page, `customers/${fixtures.customer.id}/balance`)
    const amount = protocol === 'http' ? 123 : 234
    await dialog(page).locator('.el-radio-button').filter({ hasText: '充值' }).click()
    await field(page, dialog(page), '金额（元）').locator('input').fill((amount / 100).toFixed(2))
    await field(page, dialog(page), '原因 / 处理说明').locator('textarea').fill(`${protocol} 隔离真实写入后丢弃响应`)
    let lost
    const lostResponse = new Promise((done, reject) => {
      page.route('**/api/studio/customer-transactions', async route => {
        try {
          lost = route.request().postDataJSON()
          // Playwright's API transport does not inherit Chromium's DNS mapping.
          // Reach only our loopback listener while retaining the actual Host,
          // Origin, cookie and body that the browser submitted.
          const target = new URL(route.request().url())
          const host = target.host
          target.hostname = '127.0.0.1'
          const response = await route.fetch({ url: target.href, maxRedirects: 0,
            headers: { ...route.request().headers(), host } })
          assert.equal(response.status(), 200, await response.text())
          await route.abort('failed')
          done()
        } catch (error) { await route.abort('failed').catch(() => {}); reject(error) }
      }, { times: 1 }).catch(reject)
    })
    await dialog(page).getByRole('button', { name: '确认登记', exact: true }).click()
    await lostResponse
    await dialog(page).getByText(/操作结果尚未确认/).waitFor()
    assert.match(lost.requestId, uuidV4)
    const committed = await json(page, `customers/${fixtures.customer.id}/transactions`)
    assert.equal(committed.total, before.total + 1)
    const retried = page.waitForResponse(response => response.url().endsWith('/api/studio/customer-transactions') && response.request().method() === 'POST')
    await dialog(page).getByRole('button', { name: '确认登记', exact: true }).click()
    const response = await retried
    assert.equal(response.status(), 200, await response.text())
    assert.deepEqual(response.request().postDataJSON(), lost)
    const after = await json(page, `customers/${fixtures.customer.id}/transactions`)
    const balanceAfter = await json(page, `customers/${fixtures.customer.id}/balance`)
    assert.equal(after.total, before.total + 1)
    assert.equal(balanceAfter.balance, balanceBefore.balance + amount)
    report.controlledTransport.push({ protocol, requestId: lost.requestId, committedRows: after.total - before.total,
      originalBodyEqualsRetry: true, balanceDelta: balanceAfter.balance - balanceBefore.balance })
    await page.screenshot({ path: join(output, `${protocol}-customer-retry.png`), fullPage: true })
    pass(`${protocol}: actual funds write survives lost response and identical-ID retry without duplicate ledger`)

    stage = `${protocol}: player wallet and deposit dialogs`
    await page.goto(`${origin}/#/personnel/players`)
    await page.getByRole('heading', { name: '打手管理', exact: true }).waitFor()
    await rows(page).filter({ hasText: fixtures.player.name }).getByRole('button', { name: '账户与历史', exact: true }).click()
    await drawer(page).getByRole('button', { name: '补款', exact: true }).click()
    await dialog(page).getByText('打手报酬补款', { exact: true }).waitFor()
    await closeDialog(page)
    await drawer(page).getByRole('tab', { name: '独立押金账户', exact: true }).click()
    await drawer(page).getByRole('button', { name: '缴纳押金', exact: true }).click()
    await dialog(page).getByText('登记打手缴纳押金', { exact: true }).waitFor()
    await page.screenshot({ path: join(output, `${protocol}-deposit-dialog.png`), fullPage: true })
    await closeDialog(page)
    pass(`${protocol}: player reward adjustment and independent deposit dialogs generate request IDs`)
    const finalCapability = await page.evaluate(() => window.__studioCompat)
    if (protocol === 'http') {
      assert.equal(finalCapability.nativeCalls, 0)
      assert.ok(finalCapability.fallbackCalls > 0)
    } else assert.ok(finalCapability.nativeCalls > 0)
    report.contexts.push({ protocol, origin, ...finalCapability })
  } catch (error) {
    report.failurePage = { url: page.url(), text: (await page.locator('body').innerText()).slice(0, 4000) }
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally { await context.close() }
}

try {
  process.env.STUDIO_SECURE_COOKIE = 'false'
  report.adminBuild = buildFingerprint()
  api = createStudioServer({ dbPath: database, password, seed: false, maintenanceFromEnv: false,
    trustedProxies: [], staticRoot: resolve('dist'),
    backups: { intervalMinutes: 0, directory: join(output, 'backups'), failureWebhook: '' },
    uploadCleanup: { enabled: false }, notificationIntervalMs: 86_400_000,
    notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [],
      pushSender: async () => { throw new Error('QA forbids external push') } } })
  const fixtures = fixture(api.service)
  const httpPort = await listen(api)
  tls = createHttpsServer(certificate(), (request, response) => api.emit('request', request, response))
  const httpsPort = await listen(tls)
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.STUDIO_QA_PLAYWRIGHT ||
    'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  browser = await chromium.launch({ headless: true, channel: 'msedge', timeout: 60_000,
    args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'] })
  await exercise(`http://${hostname}:${httpPort}`, 'http', fixtures)
  await exercise(`https://${hostname}:${httpsPort}`, 'https', fixtures)
  assert.deepEqual(report.pageErrors, [])
  report.unexpectedConsoleErrors = report.consoleErrors.filter(item =>
    !/^Failed to load resource: net::ERR_(?:BLOCKED_BY_CLIENT(?:\.Inspector)?|FAILED)$/.test(item.message))
  assert.deepEqual(report.unexpectedConsoleErrors, [], 'unexpected browser console error')
  assert.deepEqual(buildFingerprint(), report.adminBuild, 'tested dist changed during browser verification')
  report.passed = true
} catch (error) {
  report.failure = { stage, message: error.message, stack: error.stack }
  await currentPage?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await close(tls)
  await close(api)
  report.finishedAt = new Date().toISOString()
  report.ownedServersStopped = !api?.listening && !tls?.listening
  writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, scope: report.scope,
    cases: report.cases.length, report: join(output, 'results.json') }, null, 2))
}
