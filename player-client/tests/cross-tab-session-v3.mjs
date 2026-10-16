import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'

// Client verification only: actual HTTP, its own memory DB, current dist and random loopback ports.
// No normal localhost service, shared SQLite file or external notification provider is used.
const output = resolve(process.env.STUDIO_QA_ROOT || 'player-client/.qa', 'cross-tab-v3')
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `isolated-tabs-${randomUUID()}`
const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, notificationIntervalMs: 86_400_000 })
await new Promise((ready) => backend.listen(0, '127.0.0.1', ready))
const apiBase = `http://127.0.0.1:${backend.address().port}`
const client = createPlayerClientServer({ apiTarget: apiBase, staticRoot: resolve('player-client/dist') })
await new Promise((ready) => client.listen(0, '127.0.0.1', ready))
const base = `http://127.0.0.1:${client.address().port}`
const report = { contract: '稳定性整改共享契约 v3 (2026-10-14)', database: ':memory:', base, apiBase,
  cases: [], requests: [], runtimeErrors: [], failures: [], passed: false,
  limitations: ['This suite verifies normal cross-tab login/logout; atomic expected Actor/session checks are covered by the separate v3.1 suites.',
    'No physical Android/iPhone, HTTPS, lock-screen or external push validation.'] }
let adminCookie = '', browser, context, lastPage
async function adminApi(path, body) {
  const response = await fetch(`${apiBase}/api/studio/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(path === 'login' ? {} : { 'X-Studio-Actor': 'admin' }), ...(adminCookie ? { Cookie: adminCookie } : {}) }, body: JSON.stringify(body) })
  if (response.headers.get('set-cookie')) adminCookie = response.headers.get('set-cookie').split(';')[0]
  const result = await response.json()
  report.requests.push({ actor: 'isolated-admin', path, method: 'POST', status: response.status })
  assert.equal(response.status, 200, `${path}: ${result.message || response.status}`)
  return result
}
async function fillLogin(page, user) {
  await page.goto(`${base}/#/player/login`)
  await page.getByLabel('账号', { exact: true }).fill(user.username)
  await page.locator('input[name=password]').fill(password)
}
const success = (mode, name) => report.cases.push({ mode, name, passed: true })
try {
  await adminApi('login', { username: 'admin', password })
  const level = await adminApi('levels', { name: `跨标签等级-${randomUUID().slice(0, 8)}`, delaySeconds: 0 })
  const users = []
  for (const suffix of ['A', 'B']) users.push(await adminApi('users', { username: `cross-tab-${suffix}-${randomUUID().slice(0, 8)}`,
    name: `多标签验证${suffix}`, role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 2, permissionOverrides: {}, password }))
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const mode of ['broadcast-channel', 'storage-fallback']) {
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    if (mode === 'storage-fallback') await context.addInitScript(() => Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined }))
    const pages = [await context.newPage(), await context.newPage()]
    for (const page of pages) { page.setDefaultTimeout(15000); page.on('pageerror', (error) => report.runtimeErrors.push(error.message)) }
    context.on('response', (response) => {
      if (response.url().includes('/api/studio/')) report.requests.push({ actor: mode, path: new URL(response.url()).pathname,
        status: response.status(), method: response.request().method() })
    })
    const [first, second] = pages
    lastPage = first
    await fillLogin(first, users[0])
    await first.getByRole('button', { name: '登录', exact: true }).click()
    await first.waitForURL('**/#/player/lobby')
    await first.evaluate(() => { location.hash = '#/player/me' })
    await first.getByText(`账号：${users[0].username}`, { exact: true }).waitFor()
    await fillLogin(second, users[1])
    let releaseLogin, loginHeld = false
    const gate = new Promise((ready) => { releaseLogin = ready })
    await context.route('**/api/studio/login', async (route) => {
      if (route.request().frame().page() === second && route.request().postDataJSON()?.username === users[1].username) {
        loginHeld = true
        await gate
      }
      await route.continue()
    })
    const logoutsBefore = report.requests.filter((item) => item.actor === mode && item.path === '/api/studio/logout' && item.method === 'POST').length
    try {
      await second.getByRole('button', { name: '登录', exact: true }).click()
      await first.waitForFunction(() => location.hash.startsWith('#/player/login'))
      assert.equal(loginHeld, true, 'new login must still be held before the backend receives it')
      assert.equal(await first.locator('.p-main').count(), 0, 'old private page is removed before cookie changes')
      success(mode, 'login-start clears the old tab and its cached private page before new login POST proceeds')
    } finally { releaseLogin() }
    await second.waitForURL('**/#/player/lobby')
    await second.evaluate(() => { location.hash = '#/player/me' })
    await second.getByText(`账号：${users[1].username}`, { exact: true }).waitFor()
    await first.waitForFunction(() => location.hash.startsWith('#/player/login'))
    const current = await second.evaluate(async () => (await fetch('/api/studio/session', { cache: 'no-store' })).json())
    assert.equal(current.user.id, users[1].id)
    assert.equal(report.requests.filter((item) => item.actor === mode && item.path === '/api/studio/logout' && item.method === 'POST').length, logoutsBefore,
      'remote login events must never call backend logout for the new account')
    success(mode, 'login-complete keeps the new account valid; remote cleanup makes no backend logout request')
    await second.screenshot({ path: `${output}/${mode}-account-B.png` })
    const third = await context.newPage()
    third.setDefaultTimeout(15000); third.on('pageerror', (error) => report.runtimeErrors.push(error.message))
    await third.goto(`${base}/#/player/me`)
    await third.getByText(`账号：${users[1].username}`, { exact: true }).waitFor()
    lastPage = third
    await second.getByRole('button', { name: '退出登录', exact: true }).click()
    await Promise.all([second.waitForFunction(() => location.hash.startsWith('#/player/login')), third.waitForFunction(() => location.hash.startsWith('#/player/login'))])
    assert.equal(report.requests.filter((item) => item.actor === mode && item.path === '/api/studio/logout' && item.method === 'POST').length, logoutsBefore + 1,
      'explicit logout is sent once; other tabs only clear local state')
    assert.equal(await third.locator('.p-main').count(), 0)
    const storageEventStillSaved = await second.evaluate(() => localStorage.getItem('__studio_player_session_event_v1__'))
    assert.equal(storageEventStillSaved, null)
    success(mode, 'successful logout redirects all other tabs without extra logout and leaves no stored event payload')
    await third.screenshot({ path: `${output}/${mode}-logged-out.png` })
    await context.close(); context = undefined
  }
  assert.deepEqual(report.runtimeErrors, [])
  report.passed = true
} catch (cause) {
  report.failures.push({ message: cause.message, stack: cause.stack })
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  const close = async (server) => { server.closeAllConnections?.(); await new Promise((ready) => server.close(ready)) }
  await close(client); await close(backend)
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, requests: report.requests.length,
    failures: report.failures.map((item) => item.message), output }))
}
