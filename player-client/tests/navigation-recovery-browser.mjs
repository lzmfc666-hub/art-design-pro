import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'

// Two explicitly supplied builds, random ports and a disposable database only.
// Never overwrite an active build to simulate a release.
const beforeRoot = process.env.PLAYER_NAV_BEFORE_ROOT
const afterRoot = process.env.PLAYER_NAV_AFTER_ROOT
assert.ok(beforeRoot && afterRoot, 'Supply PLAYER_NAV_BEFORE_ROOT and PLAYER_NAV_AFTER_ROOT with different build hashes')
const output = resolve(process.env.STUDIO_QA_ROOT || '.qa/production-fixes-20261018', 'navigation-browser')
await mkdir(output, { recursive: true })
const { chromium } = createRequire(import.meta.url)('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `navigation-${randomUUID()}`
const api = createStudioServer({ dbPath: ':memory:', seed: false, password, maintenanceFromEnv: false,
  notificationIntervalMs: 86400000, notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [],
    pushSender: async () => { throw new Error('External push prohibited in navigation acceptance') } } })
await new Promise(done => api.listen(0, '127.0.0.1', done))
const apiBase = `http://127.0.0.1:${api.address().port}`
const level = api.service.mutate('admin', '/levels', { name: '导航验收等级', delaySeconds: 0 })
const player = api.service.mutate('admin', '/users', { username: `nav-${randomUUID()}`, name: '导航隔离验收', role: 'player',
  status: 'active', levelId: level.id, maxActiveOrders: 3, permissionOverrides: {}, password })
const variants = [beforeRoot, afterRoot].map(root => createPlayerClientServer({ staticRoot: resolve(root), apiTarget: apiBase }))
let active = 1
const server = createServer((request, response) => variants[active].emit('request', request, response))
await new Promise(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const report = { passed: false, database: ':memory:', cases: [], unexpectedErrors: [], expectedAssetFailures: [], writes: [], limitations: ['Desktop Edge mobile viewports; no physical phone or company-network test.'] }
const ok = name => report.cases.push({ name, passed: true })
let browser
async function loggedIn(width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true })
  assert.equal((await context.request.post(base + '/api/studio/login', { data: { username: player.username, password } })).status(), 200)
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/studio/'))
      report.writes.push({ path: new URL(request.url()).pathname, method: request.method() })
  })
  return { context, page }
}
async function tab(page, path, heading) {
  await page.locator(`.p-nav a[href="#/player/${path}"]`).click()
  await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor()
  assert.equal(new URL(page.url()).hash, `#/player/${path}`)
}
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const width of [320, 390]) {
    active = 1
    const { context, page } = await loggedIn(width)
    page.on('pageerror', error => report.unexpectedErrors.push(error.message))
    page.on('response', response => { if (response.status() >= 400) report.unexpectedErrors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
    await page.goto(base + '/#/player/lobby')
    for (const [path, title] of [['rank', '排行榜'], ['me', '我的'], ['tasks', '我的任务'], ['lobby', '接单大厅'], ['me', '我的'], ['rank', '排行榜']]) await tab(page, path, title)
    await page.getByRole('button', { name: '提现排行', exact: true }).click()
    await page.getByLabel('排行月份').fill('2026-09')
    await page.getByRole('button', { name: '接单排行', exact: true }).click()
    await page.getByText('本月暂无成绩', { exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: '排行榜', exact: true, level: 1 }).waitFor()
    await tab(page, 'me', '我的')
    for (const [path, title] of [['profile', '个人资料'], ['wallet', '报酬钱包'], ['payment', '收款码'], ['withdrawals', '提现记录'], ['ledger', '收支明细'], ['deposit', '独立押金'], ['notifications', '通知设置'], ['password', '修改密码']]) {
      await page.locator(`.p-menu-list a[href="#/player/${path}"]`).click()
      await page.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor()
      await tab(page, 'me', '我的')
    }
    assert.equal(await page.locator('.player-navigation-recovery').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await page.screenshot({ path: resolve(output, `me-${width}.png`), fullPage: true })
    ok(`${width}px四个主入口、排行筛选、直达刷新及“我的”八个子页面`)
    await context.close()
  }
  for (const [path, title] of [['rank', '排行榜'], ['me', '我的']]) {
    active = 0
    const { context, page } = await loggedIn()
    const errors = [], failures = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.status() >= 400) failures.push({ status: response.status(), path: new URL(response.url()).pathname })
    })
    await page.goto(base + '/#/player/lobby')
    await page.locator('.p-nav').waitFor()
    const marker = { owner: player.id, family: 'withdraw', requestId: `unconfirmed-${randomUUID()}`, createdAt: Date.now() }
    const markerKey = `__studio_player_unconfirmed_v1__:${encodeURIComponent(player.id)}:withdraw:${encodeURIComponent(marker.requestId)}`
    const markerValue = JSON.stringify(marker)
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: markerKey, value: markerValue })
    let documentRequests = 0
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests++ })
    active = 1
    await page.locator(`.p-nav a[href="#/player/${path}"]`).click()
    await page.getByRole('alert').filter({ hasText: '页面暂时无法打开' }).waitFor()
    await pause(700)
    assert.equal(documentRequests, 0, 'A failed import must not automatically reload')
    assert.equal(new URL(page.url()).hash, '#/player/lobby')
    assert.ok(failures.some(row => row.status === 404 && row.path.startsWith('/assets/')), 'The old route really requested a missing hashed asset')
    assert.ok(failures.every(row => row.path.startsWith('/assets/')), 'No business API failure may be mistaken for a module failure')
    const oldMissingAssets = new Set(failures.map(row => row.path))
    await page.getByRole('button', { name: '暂不刷新', exact: true }).click()
    assert.equal(await page.locator('.player-navigation-recovery').count(), 0)
    assert.equal(documentRequests, 0)
    await page.locator(`.p-nav a[href="#/player/${path}"]`).click()
    await page.getByRole('alert').filter({ hasText: '页面暂时无法打开' }).waitFor()
    await page.screenshot({ path: resolve(output, `stale-${path}-prompt.png`), fullPage: true })
    await page.getByRole('button', { name: '刷新并打开页面', exact: true }).click()
    await page.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor()
    assert.equal(new URL(page.url()).hash, `#/player/${path}`)
    await pause(300)
    assert.equal(documentRequests, 1, 'Exactly one user-requested document reload')
    assert.equal(await page.locator('.player-navigation-recovery').count(), 0)
    assert.equal(await page.evaluate(key => localStorage.getItem(key), markerKey), markerValue)
    // The unresolved financial marker must still block a new withdrawal after refresh.
    await page.evaluate(() => { location.hash = '#/player/wallet' })
    await page.getByRole('heading', { name: '报酬钱包', exact: true, level: 1 }).waitFor()
    await page.getByText('请先保存微信或支付宝收款码').waitFor()
    assert.equal(await page.getByLabel('提现金额（元）').isDisabled(), true)
    assert.equal(await page.evaluate(key => localStorage.getItem(key), markerKey), markerValue)
    assert.ok(failures.every(row => row.status === 404 && oldMissingAssets.has(row.path)), 'After recovery, no new module or API failure is expected')
    assert.deepEqual(errors.filter(message => !/^(?:Failed to fetch dynamically imported module(?::|\s|$)|error loading dynamically imported module(?::|\s|$)|Importing a module script failed\.?$|Unable to preload CSS for\s)/i.test(message)), [], 'Do not hide unrelated page errors behind expected import failure')
    report.expectedAssetFailures.push({ target: path, failures, errors })
    ok(`跨版本旧${title}脚本404后明确提示，手动一次刷新恢复目标，登录和资金防重标记保留`)
    await context.close()
  }
  assert.deepEqual(report.unexpectedErrors, [])
  assert.deepEqual(report.writes, [], 'Browsing and recovery must not submit business writes')
  report.passed = true
} catch (error) {
  report.failure = error.stack || String(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  server.closeAllConnections(); await new Promise(done => server.close(done))
  for (const variant of variants) variant.closeAllConnections()
  api.closeAllConnections(); await new Promise(done => api.close(done))
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
