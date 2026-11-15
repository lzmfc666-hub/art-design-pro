import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createPortProbe } from 'node:net'
import { createServer as createViteServer } from 'vite'
import { createStudioServer } from '../server/index.mjs'
import { merchantFixture, merchantPassword } from '../tests/helpers/merchant-fixture.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const production = process.argv.includes('--production')
const output = resolve(root, production ? '.qa/merchant-staff-production-ui' : '.qa/merchant-staff-ui', `run-${randomUUID()}`)
mkdirSync(output, { recursive: true })
process.env.STUDIO_QA_DECLARATIONS_DIR = resolve(output, 'generated-types')
Object.assign(process.env, { VITE_ACCESS_MODE: 'frontend', VITE_VERSION: '3.0.0', VITE_BASE_URL: '/', VITE_API_URL: '/api', VITE_PORT: '0' })
const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) }
catch { ({ chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')) }
const freePort = async () => {
  const probe = createPortProbe()
  await new Promise(ready => probe.listen(0, '127.0.0.1', ready))
  const port = probe.address().port
  await new Promise(ready => probe.close(ready))
  return port
}
const server = createStudioServer({ dbPath: resolve(output, 'isolated.sqlite'), staticRoot: resolve(root, 'dist'), seed: false, password: merchantPassword,
  backups: { intervalMinutes: 0 }, notificationIntervalMs: 86400000,
  notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] } })
const f = merchantFixture(null, server.service), { service, accounts, merchants, templates, players } = f
f.mutate(`/merchants/${merchants[0].id}/owner`, { userId: accounts[0].id })
const result = { output, production, runtime: process.version, isolated: true, simulatedResponses: 0, passes: [], pageErrors: [], serverErrors: [], sourceBefore: sourceFingerprint() }
const pass = name => { result.passes.push(name); console.log(`PASS ${name}`) }
let vite, browser, ownerPage, supportPage, adminPage
try {
  await new Promise(ready => server.listen(0, '127.0.0.1', ready))
  if (!production) vite = await createViteServer({ root, configFile: resolve(root, 'vite.config.ts'), cacheDir: resolve(output, 'vite-cache'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true,
      watch: { ignored: ['**/player-client/**', '**/.qa/**', '**/.data/**'] },
      proxy: { '/api': { target: `http://127.0.0.1:${server.address().port}`, changeOrigin: true } } } })
  await vite?.listen()
  const base = `http://127.0.0.1:${production ? server.address().port : vite.httpServer.address().port}`
  result.ports = { api: server.address().port, browser: production ? server.address().port : vite.httpServer.address().port }
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const supportContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  ownerPage = await ownerContext.newPage(); supportPage = await supportContext.newPage(); adminPage = await ownerContext.newPage()
  for (const page of [ownerPage, supportPage, adminPage]) {
    page.setDefaultTimeout(25000)
    page.on('pageerror', e => result.pageErrors.push(e.message))
    page.on('response', r => { if (r.url().includes('/api/studio/') && r.status() >= 500) result.serverErrors.push({ url: new URL(r.url()).pathname, status: r.status() }) })
  }
  const reply = (page, path) => page.waitForResponse(r => new URL(r.url()).pathname === `/api/studio/${path}` && r.request().method() === 'POST')
  const field = (page, scope, name) => scope.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label').filter({ hasText: name }) }).first()
  const login = async (page, username) => {
    await page.goto(`${base}/#/merchant/login`)
    await page.getByRole('heading', { name: '商家登录', exact: true }).waitFor()
    await page.waitForLoadState('networkidle')
    await page.locator('input[autocomplete=username]').fill(username)
    await page.locator('input[autocomplete=current-password]').fill(merchantPassword)
    const track = await page.locator('.drag_verify').boundingBox()
    await page.locator('.dv_handler').dragTo(page.locator('.drag_verify'), { sourcePosition: { x: 2, y: track.height / 2 }, targetPosition: { x: track.width - 2, y: track.height / 2 } })
    const waiting = reply(page, 'login')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const response = await waiting
    assert.equal(response.status(), 200, await response.text())
    await page.waitForURL('**/#/merchant/overview')
    await page.waitForLoadState('networkidle')
  }
  await login(ownerPage, accounts[0].username)
  await ownerPage.goto(`${base}/#/merchant/staff`)
  await ownerPage.getByRole('button', { name: '新增客服', exact: true }).waitFor()
  const add = async name => {
    await ownerPage.getByRole('button', { name: '新增客服', exact: true }).click()
    const dialog = ownerPage.getByRole('dialog', { name: '新增客服', exact: true })
    await field(ownerPage, dialog, '登录账号').locator('input').fill('ui-owned-support')
    await field(ownerPage, dialog, '客服昵称').locator('input').fill(name)
    await field(ownerPage, dialog, '初始密码').locator('input').fill(merchantPassword)
    const waiting = reply(ownerPage, 'merchant/staff')
    await dialog.getByRole('button', { name: '保存客服', exact: true }).click()
    const response = await waiting
    assert.equal(response.status(), 200, await response.text())
    const staff = await response.json()
    await ownerPage.locator('.el-table__row').filter({ hasText: 'ui-owned-support' }).waitFor()
    return staff
  }
  const original = await add('轮班测试客服')
  pass('主账号通过实际页面新增本商家客服')
  await login(supportPage, original.username)
  assert.equal(await supportPage.getByText('客服管理', { exact: true }).count(), 0)
  await supportPage.goto(`${base}/#/merchant/staff`)
  await supportPage.waitForLoadState('networkidle')
  assert.equal(await supportPage.getByRole('button', { name: '新增客服', exact: true }).count(), 0)
  assert.equal((await supportContext.request.get(`${base}/api/studio/merchant/staff`, { headers: { 'X-Studio-Client': 'merchant' } })).status(), 403)
  pass('客服菜单与直接地址均不能进入账号管理，接口也拒绝')

  await supportPage.goto(`${base}/#/merchant/create`)
  const create = supportPage.locator('#app-main')
  await create.getByRole('button', { name: '发布商家订单', exact: true }).waitFor()
  await field(supportPage, create, '订单项目').locator('.el-select').click()
  await supportPage.getByRole('option').filter({ hasText: templates[0].name }).click()
  await field(supportPage, create, '房间码').locator('input').fill('STAFF-SHARED-ORDER')
  await create.getByText('指定打手', { exact: true }).first().click()
  await field(supportPage, create, '指定打手').locator('.el-select').click()
  await supportPage.getByRole('option', { name: players[0].name, exact: true }).click()
  let waiting = reply(supportPage, 'orders')
  await create.getByRole('button', { name: '发布商家订单', exact: true }).click()
  const createdResponse = await waiting
  assert.equal(createdResponse.status(), 200, await createdResponse.text())
  const order = await createdResponse.json()
  assert.equal(order.creatorId, original.id)
  assert.equal(order.assignedTo, players[0].id)
  const detail = () => supportPage.locator('.business-detail-page-panel[data-page-key="order-detail"]:visible').last()
  await detail().getByText(order.orderNo, { exact: true }).first().waitFor()
  assert.doesNotMatch(await detail().innerText(), /INTERNAL-TEMPLATE-NOTE|整单打手报酬/)
  await detail().getByRole('button', { name: '调整派单', exact: true }).click()
  const action = supportPage.locator('.business-detail-page-panel[data-page-key="order-action"]:visible').last()
  await action.getByText('公开抢单池', { exact: true }).click()
  waiting = reply(supportPage, `orders/${order.id}/action`)
  await action.getByRole('button', { name: '确认保存', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.equal(service.orderDetail('admin', order.id).order.dispatchMode, 'pool')
  pass('客服实际发单并指定打手，再调整为公开抢单，记录本人创建责任')

  await ownerPage.goto(`${base}/#/merchant/orders?id=${order.id}`)
  const ownerDetail = () => ownerPage.locator('.business-detail-page-panel[data-page-key="order-detail"]:visible').last()
  await ownerDetail().getByText(order.orderNo, { exact: true }).first().waitFor()
  assert.ok((await ownerPage.locator('#app-main').innerText()).includes('轮班测试客服'))
  await ownerPage.goto(`${base}/#/merchant/staff`)
  const row = ownerPage.locator('.el-table__row').filter({ hasText: original.username })
  await row.getByRole('button', { name: '删除客服', exact: true }).click()
  waiting = reply(ownerPage, `merchant/staff/${original.id}/delete`)
  await ownerPage.getByRole('button', { name: '删除登录资格', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  await row.waitFor({ state: 'hidden' })
  assert.equal((await supportContext.request.get(`${base}/api/studio/orders`, { headers: { 'X-Studio-Client': 'merchant' } })).status(), 401)
  const replacement = await add('轮班测试客服')
  assert.notEqual(replacement.id, original.id)
  await ownerPage.goto(`${base}/#/merchant/orders?id=${order.id}`)
  await ownerDetail().getByText('轮班测试客服（已删除）', { exact: false }).first().waitFor()
  await ownerPage.screenshot({ path: resolve(output, 'deleted-creator-history.png'), fullPage: true })
  pass('主账号删除客服后旧会话失效，同登录名新账号不接管旧订单责任，历史姓名标记已删除')

  const adminLogin = await ownerContext.request.post(`${base}/api/studio/login`, { data: { username: 'admin', password: merchantPassword } })
  assert.equal(adminLogin.status(), 200)
  await adminPage.goto(`${base}/#/merchants/manage?tab=accounts`)
  await adminPage.getByRole('tab', { name: '商家账号', exact: true }).click()
  const accountRow = adminPage.locator('.el-table__row').filter({ hasText: replacement.username })
  await accountRow.getByRole('button', { name: '交接主账号', exact: true }).click()
  waiting = reply(adminPage, `merchants/${merchants[0].id}/owner`)
  await adminPage.getByRole('button', { name: '确认交接', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  await accountRow.getByText('主账号', { exact: true }).waitFor()
  await adminPage.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal((await ownerContext.request.get(`${base}/api/studio/merchant/staff`, { headers: { 'X-Studio-Client': 'merchant' } })).status(), 401)
  await adminPage.screenshot({ path: resolve(output, 'superadmin-owner-transfer.png'), fullPage: true })
  pass('超管通过总后台交接唯一主账号，旧主账号停用且原会话立即失效')
  await ownerContext.clearCookies()
  await login(ownerPage, replacement.username)
  await ownerPage.goto(`${base}/#/merchant/staff`)
  await ownerPage.getByRole('button', { name: '新增客服', exact: true }).waitFor()
  await ownerPage.setViewportSize({ width: 390, height: 844 })
  await ownerPage.screenshot({ path: resolve(output, 'owner-staff-mobile.png'), fullPage: true })
  const width = await ownerPage.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(width.scroll <= width.viewport + 1)
  assert.deepEqual(result.pageErrors, [])
  assert.deepEqual(result.serverErrors, [])
  pass('接任主账号重新登录后具有管理入口，390宽度页面无整体横向溢出，页面无异常或5xx')
  result.ok = true
} catch (e) {
  result.ok = false; result.error = e.stack; process.exitCode = 1
  console.error(e)
  for (const [name, page] of [['owner', ownerPage], ['support', supportPage], ['admin', adminPage]])
    if (page && !page.isClosed()) {
      await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true }).catch(() => {})
      writeFileSync(resolve(output, `${name}-dom.txt`), await page.locator('body').innerText().catch(() => ''))
    }
} finally {
  await browser?.close(); await vite?.close()
  await new Promise(ready => server.close(ready))
  result.sourceAfter = sourceFingerprint()
  result.sourceUnchanged = result.sourceBefore.digest === result.sourceAfter.digest
  if (!result.sourceUnchanged) { result.ok = false; process.exitCode = 1 }
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ output, ok: result.ok, passes: result.passes, sourceUnchanged: result.sourceUnchanged, error: result.error }, null, 2))
}
