import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createPortProbe } from 'node:net'
import { createServer as createViteServer } from 'vite'
import { createStudioServer } from '../server/index.mjs'
import { merchantFixture, merchantPassword, merchantPng } from '../tests/helpers/merchant-fixture.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.env.STUDIO_FINAL_QA_ROOT || resolve(root, '.qa'), 'merchant-joint-ui', `run-${randomUUID()}`)
mkdirSync(resolve(output, 'tmp'), { recursive: true })
process.env.TEMP = process.env.TMP = resolve(output, 'tmp')
process.env.STUDIO_QA_DECLARATIONS_DIR = resolve(output, 'generated-types')
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
const time = new Date('2026-11-08T04:00:00Z')
const server = createStudioServer({ dbPath: resolve(output, 'isolated.sqlite'), seed: false, password: merchantPassword,
  clock: () => time,
  backups: { intervalMinutes: 0, directory: resolve(output, 'backups'), failureWebhook: '' },
  notificationIntervalMs: 86400000, notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] } })
const fixture = merchantFixture(null, server.service)
const { service, accounts, merchants, players, templates } = fixture
const finance = fixture.mutate('/users', { username: 'merchant-joint-finance', name: '联合财务', role: 'finance',
  status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: merchantPassword })
const current = id => service.orderDetail('admin', id).order
const result = { output, isolated: true, simulatedResponses: 0, passes: [], pageErrors: [], serverErrors: [], requests: [], widths: [], uiObservations: [], sourceBefore: sourceFingerprint() }
const pass = name => { result.passes.push(name); console.log(`PASS ${name}`) }
let adminVite, playerVite, browser, merchantPage, financePage, mobile
try {
  await new Promise(ready => server.listen(0, '127.0.0.1', ready))
  const api = `http://127.0.0.1:${server.address().port}`
  adminVite = await createViteServer({ root, configFile: resolve(root, 'vite.config.ts'), cacheDir: resolve(output, 'admin-vite-cache'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true,
      watch: { ignored: ['**/player-client/**', '**/.qa/**', '**/.data/**'] }, proxy: { '/api': { target: api, changeOrigin: true } } } })
  await adminVite.listen()
  const base = `http://127.0.0.1:${adminVite.httpServer.address().port}`
  playerVite = await createViteServer({ root: resolve(root, 'player-client'), configFile: resolve(root, 'player-client/vite.config.ts'), cacheDir: resolve(output, 'player-vite-cache'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true, proxy: { '/api/studio': { target: api, changeOrigin: true, headers: { 'X-Studio-Client': 'player' } } } } })
  await playerVite.listen()
  const playerBase = `http://127.0.0.1:${playerVite.httpServer.address().port}`
  result.ports = { api: server.address().port, adminMerchant: adminVite.httpServer.address().port, player: playerVite.httpServer.address().port }
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  result.browserVersion = browser.version()
  const sharedContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const otherContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  merchantPage = await sharedContext.newPage()
  financePage = await sharedContext.newPage()
  mobile = await mobileContext.newPage()
  for (const [name, page] of [['merchant', merchantPage], ['finance', financePage], ['player', mobile]]) {
    page.setDefaultTimeout(30000)
    page.on('pageerror', error => result.pageErrors.push({ name, message: error.message }))
    page.on('response', response => { if (response.url().includes('/api/studio/') && response.status() >= 500) result.serverErrors.push({ name, path: new URL(response.url()).pathname, status: response.status() }) })
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/api/studio/') && !request.url().endsWith('/login')) {
        const body = request.postDataJSON()
        result.requests.push({ name, path: new URL(request.url()).pathname, actor: request.headers()['x-studio-actor'], requestId: body.requestId })
      }
    })
  }
  const reply = (page, path) => page.waitForResponse(response => new URL(response.url()).pathname === `/api/studio/${path}` && response.request().method() === 'POST')
  const field = (page, scope, label) => scope.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label').filter({ hasText: label }) }).first()
  const financeDetail = () => financePage.locator('.business-detail-page-panel[data-page-key="order-detail"]:visible, .el-drawer:visible').last()
  const financeDialog = () => financePage.locator('.business-detail-page-panel[data-page-key="order-action"]:visible, .business-detail-page-panel[data-page-key="finance-withdrawal-pay"]:visible, .el-dialog:visible').last()
  const financeOrder = async id => {
    await financePage.goto(`${base}/#/orders/list?id=${id}`)
    await financeDetail().getByText(current(id).orderNo, { exact: true }).first().waitFor()
    const refreshed = financePage.waitForResponse(response => new URL(response.url()).pathname === `/api/studio/orders/${id}` && response.request().method() === 'GET')
    await financeDetail().getByRole('button', { name: '刷新订单并重新确认操作', exact: true }).click()
    assert.equal((await refreshed).status(), 200)
    await financePage.waitForLoadState('networkidle')
  }
  const mobileRoute = async route => { await mobile.goto(`${playerBase}/#${route}`); await mobile.locator('.p-page').waitFor(); await mobile.waitForLoadState('networkidle') }

  await merchantPage.goto(`${base}/#/merchant/login`)
  await merchantPage.getByRole('heading', { name: '商家登录', exact: true }).waitFor()
  await merchantPage.waitForLoadState('networkidle')
  writeFileSync(resolve(output, 'merchant-login-dom.txt'), await merchantPage.locator('body').innerText())
  await merchantPage.locator('input[autocomplete=username]').fill(accounts[0].username)
  await merchantPage.locator('input[autocomplete=current-password]').fill(merchantPassword)
  const track = await merchantPage.locator('.drag_verify').boundingBox()
  result.sliderBefore = { track, handle: await merchantPage.locator('.dv_handler').boundingBox() }
  await merchantPage.locator('.dv_handler').dragTo(merchantPage.locator('.drag_verify'), {
    sourcePosition: { x: 2, y: track.height / 2 }, targetPosition: { x: track.width - 2, y: track.height / 2 }
  })
  result.sliderAfter = await merchantPage.locator('.drag_verify').innerText()
  console.log('SLIDER ' + JSON.stringify({ before: result.sliderBefore, after: result.sliderAfter }))
  let waiting = reply(merchantPage, 'login')
  await merchantPage.getByRole('button', { name: '登录', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  await merchantPage.waitForURL('**/#/merchant/overview')
  await merchantPage.getByText('商家数据看板', { exact: true }).first().waitFor()
  const overviewText = await merchantPage.locator('#app-main').innerText()
  result.uiObservations.push({ name: 'default-range-is-today', passed: /未选择日期时显示(?:今天|今日)/.test(overviewText),
    observed: overviewText.split('\n').find(line => line.includes('未选择日期')) })
  assert.ok((await sharedContext.cookies()).some(cookie => cookie.name === 'studio_merchant_session'))
  assert.equal((await sharedContext.request.post(`${base}/api/studio/login`, { data: { username: finance.username, password: merchantPassword } })).status(), 200)
  await financePage.goto(`${base}/#/orders/list`)
  await financePage.locator('#app-main').waitFor()
  const merchantSession = await sharedContext.request.get(`${base}/api/studio/session`, { headers: { 'X-Studio-Client': 'merchant' } })
  assert.equal((await merchantSession.json()).user.id, accounts[0].id)
  pass('商家真实登录与财务页面同浏览器使用独立Cookie和通道，互不覆盖')

  await merchantPage.goto(`${base}/#/merchant/create`)
  const create = merchantPage.locator('#app-main')
  await create.getByRole('button', { name: '发布商家订单', exact: true }).waitFor()
  await field(merchantPage, create, '订单项目').locator('.el-select').click()
  await merchantPage.getByRole('option').filter({ hasText: templates[0].name }).click()
  await field(merchantPage, create, '房间码').locator('input').fill('PRIVATE-MERCHANT-ROOM')
  await field(merchantPage, create, '客户游戏 ID').locator('input').fill('PRIVATE-MERCHANT-GAME')
  assert.equal(await field(merchantPage, create, '打手可见备注').locator('textarea').inputValue(), '报响箭电竞')
  assert.equal(await create.locator('.el-form-item').filter({ hasText: '客户档案' }).count(), 0)
  assert.doesNotMatch(await create.innerText(), /整单报酬|打手到手|确认收款并发布订单/)
  waiting = reply(merchantPage, 'orders')
  await create.getByRole('button', { name: '发布商家订单', exact: true }).click()
  const created = await waiting
  assert.equal(created.status(), 200, await created.text())
  const order = await created.json()
  assert.equal(order.merchantId, merchants[0].id)
  assert.equal(Object.hasOwn(order, 'reward'), false)
  assert.equal(current(order.id).receivedAmount, 0)
  assert.equal(current(order.id).paidAt, null)
  assert.equal(current(order.id).amount, 8000)
  assert.equal(current(order.id).reward, 6000)
  pass('商家页面选择总后台模板直接发单，默认备注与来源正确，真实到账保持0且报酬不返回')
  const merchantDetail = () => merchantPage.locator('.business-detail-page-panel[data-page-key="order-detail"]:visible').last()
  const merchantAction = () => merchantPage.locator('.business-detail-page-panel[data-page-key="order-action"]:visible').last()
  await merchantDetail().getByText(current(order.id).orderNo, { exact: true }).first().waitFor()
  await merchantPage.reload()
  await merchantDetail().getByText(current(order.id).orderNo, { exact: true }).first().waitFor()
  assert.doesNotMatch(await merchantDetail().innerText(), /整单打手报酬|INTERNAL-TEMPLATE-NOTE/)
  assert.equal(await merchantDetail().getByRole('button', { name: '确认收款', exact: true }).count(), 0)
  await merchantDetail().getByRole('button', { name: '编辑订单', exact: true }).click()
  await field(merchantPage, merchantAction(), '房间码').locator('input').fill('PRIVATE-MERCHANT-ROOM-UPDATED')
  await field(merchantPage, merchantAction(), '原因 / 处理说明').locator('textarea').fill('商家修改任务信息')
  waiting = reply(merchantPage, `orders/${order.id}/action`)
  await merchantAction().getByRole('button', { name: '确认保存', exact: true }).click()
  const edited = await waiting
  assert.equal(edited.status(), 200, await edited.text())
  for (const key of ['amount', 'reward', 'remark', 'receivedAmount']) assert.equal(Object.hasOwn(edited.request().postDataJSON(), key), false, key)
  assert.equal(current(order.id).roomCode, 'PRIVATE-MERCHANT-ROOM-UPDATED')
  pass('商家订单长详情刷新深链仍可用，只编辑任务字段且不提交价格、实收或内部备注')

  assert.equal((await otherContext.request.post(`${base}/api/studio/login`, { headers: { 'X-Studio-Client': 'merchant' }, data: { username: accounts[2].username, password: merchantPassword } })).status(), 200)
  const otherPage = await otherContext.request.get(`${base}/api/studio/orders?current=1&size=20`, { headers: { 'X-Studio-Client': 'merchant' } })
  assert.equal((await otherPage.json()).total, 0)
  assert.equal((await otherContext.request.get(`${base}/api/studio/orders/${order.id}`, { headers: { 'X-Studio-Client': 'merchant' } })).status(), 403)
  const sameMerchant = service.ordersPage(accounts[1].id, { current: 1, size: 20 })
  assert.equal(sameMerchant.total, 1)
  pass('另一商家列表与详情隔离，同商家第二账号可见共同订单')

  await mobile.goto(`${playerBase}/#/player/login`)
  await mobile.getByLabel('账号', { exact: true }).fill(players[0].username)
  await mobile.locator('input[name=password]').fill(merchantPassword)
  waiting = reply(mobile, 'login')
  await mobile.getByRole('button', { name: '登录', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  await mobile.waitForURL('**/#/player/lobby')
  await mobileRoute(`/player/orders/${order.id}`)
  waiting = reply(mobile, `player/orders/${order.id}/claim`)
  await mobile.getByRole('button', { name: '接受订单', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  await mobile.getByText('PRIVATE-MERCHANT-ROOM-UPDATED', { exact: true }).waitFor()
  await mobile.getByText('本单由平台垫付，可正常上报；财务验收后按原规则结算报酬。', { exact: true }).waitFor()
  const detail = await (await mobileContext.request.get(`${playerBase}/api/studio/player/orders/${order.id}`)).json()
  assert.equal(detail.paymentConfirmed, false)
  assert.equal(detail.fulfillmentAuthorized, true)
  for (const key of ['amount', 'merchantCustomerAmount', 'receivedAmount', 'customerId']) assert.equal(Object.hasOwn(detail, key), false, key)
  for (const key of ['amount', 'merchantCustomerAmount', 'reward', 'remark', 'merchantId', 'customerId', 'platformId']) assert.equal(Object.hasOwn(detail.snapshot, key), false, `snapshot.${key}`)
  waiting = reply(mobile, 'uploads')
  await mobile.locator('input[type=file]').setInputFiles({ name: '信用单完成材料.png', mimeType: 'image/png', buffer: Buffer.from(merchantPng, 'base64') })
  assert.equal((await waiting).status(), 200)
  await mobile.locator('.p-upload-thumb').waitFor()
  await mobile.getByLabel('实际参与队友（可选）', { exact: true }).selectOption(players[1].id)
  waiting = reply(mobile, `player/orders/${order.id}/submit`)
  await mobile.getByRole('button', { name: '提交完成，等待验收', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.equal(current(order.id).status, 'review')
  assert.equal(service.playerWallet(players[0].id).available, 0)
  pass('独立打手端真实接取未回款信用单、上传材料和双人上报，显示垫付且不泄露商家价格')

  await financeOrder(order.id)
  await financeDetail().getByRole('button', { name: '验收通过', exact: true }).click()
  waiting = reply(financePage, `orders/${order.id}/action`)
  await financePage.getByRole('button', { name: '核对无误，通过验收', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.equal(current(order.id).status, 'completed')
  assert.equal(current(order.id).receivedAmount, 0)
  assert.equal(service.playerWallet(players[0].id).available, 3000)
  assert.equal(service.playerWallet(players[1].id).available, 3000)
  pass('财务页面验收信用单，未回款仍按原双人分账各30元记入原钱包，合计60元')
  await merchantPage.goto(`${base}/#/merchant/orders?id=${order.id}`)
  await merchantDetail().getByText(current(order.id).orderNo, { exact: true }).first().waitFor()
  const refreshedMaterial = merchantPage.waitForResponse(response => new URL(response.url()).pathname === `/api/studio/orders/${order.id}` && response.request().method() === 'GET')
  await merchantDetail().getByRole('button', { name: '刷新订单并重新确认操作', exact: true }).click()
  assert.equal((await refreshedMaterial).status(), 200)
  await merchantPage.getByRole('tab', { name: '完成材料 (1)', exact: true }).click()
  const materialImage = merchantDetail().getByRole('img', { name: '信用单完成材料.png', exact: true })
  await materialImage.waitFor()
  await merchantPage.waitForFunction(() => {
    const image = document.querySelector('.business-detail-page-panel[data-page-key="order-detail"] img[alt="信用单完成材料.png"]')
    return image && image.complete && image.naturalWidth > 0
  })
  const materialText = await merchantDetail().innerText()
  result.uiObservations.push({ name: 'reviewed-material-without-internal-reviewer', passed: materialText.includes('总后台') && !materialText.includes('尚未审核'),
    observed: materialText.includes('尚未审核') ? '尚未审核' : materialText.includes('总后台') ? '总后台' : 'unknown' })
  const support = fixture.mutate('/users', { username: 'merchant-joint-original-support', name: '原客服', role: 'support', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: merchantPassword })
  const normalTemplate = fixture.mutate('/templates', { name: '原客服普通模板', game: 'QA', amount: 8000, reward: 6000, active: true })
  const normal = fixture.mutate('/orders', { templateId: normalTemplate.id, customerId: merchants[0].customerId, platformId: merchants[0].platformId,
    roomCode: 'ORDINARY-SUPPORT', dispatchMode: 'pool', payOnArrival: true, receivedAmount: 0 })
  const supportContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  assert.equal((await supportContext.request.post(`${base}/api/studio/login`, { data: { username: support.username, password: merchantPassword } })).status(), 200)
  const supportPage = await supportContext.newPage()
  await supportPage.goto(`${base}/#/orders/list?id=${order.id}`)
  const supportDetail = supportPage.locator('.business-detail-page-panel[data-page-key="order-detail"]:visible').last()
  await supportDetail.getByText(current(order.id).orderNo, { exact: true }).first().waitFor()
  const creditPaymentButtons = await supportDetail.getByRole('button', { name: '确认收款', exact: true }).count()
  await supportPage.goto(`${base}/#/orders/list?id=${normal.id}`)
  await supportDetail.getByText(current(normal.id).orderNo, { exact: true }).first().waitFor()
  const ordinaryPaymentButtons = await supportDetail.getByRole('button', { name: '确认收款', exact: true }).count()
  result.uiObservations.push({ name: 'original-support-payment-action-preserved', passed: creditPaymentButtons === 0 && ordinaryPaymentButtons === 1,
    observed: { creditPaymentButtons, ordinaryPaymentButtons } })
  await supportContext.close()
  console.log('UI_OBSERVATIONS ' + JSON.stringify(result.uiObservations))

  await mobileRoute('/player/payment')
  const wechat = mobile.locator('.p-card').filter({ has: mobile.getByRole('heading', { name: '微信收款码', exact: true }) })
  waiting = reply(mobile, 'uploads')
  await wechat.locator('input[type=file]').setInputFiles({ name: '隔离收款码.png', mimeType: 'image/png', buffer: Buffer.from(merchantPng, 'base64') })
  assert.equal((await waiting).status(), 200)
  waiting = reply(mobile, 'player/payment-methods')
  await wechat.getByRole('button', { name: '保存微信收款码', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  await mobileRoute('/player/wallet')
  await mobile.getByLabel('提现金额（元）', { exact: true }).fill('30')
  await mobile.getByLabel('收款方式', { exact: true }).selectOption('wechat')
  waiting = reply(mobile, 'player/withdrawals')
  await mobile.getByRole('button', { name: '提交提现申请', exact: true }).click()
  const withdrawalResponse = await waiting
  assert.equal(withdrawalResponse.status(), 200)
  const withdrawal = await withdrawalResponse.json()
  assert.equal(service.playerWallet(players[0].id).occupied, 3000)
  await financePage.goto(`${base}/#/finance/settlement?tab=withdrawals`)
  const refreshedWithdrawals = financePage.waitForResponse(response => new URL(response.url()).pathname === '/api/studio/bootstrap')
  await financePage.getByRole('button', { name: '刷新记录', exact: true }).click()
  assert.equal((await refreshedWithdrawals).status(), 200)
  await financePage.locator('.el-table__body tr').filter({ hasText: players[0].name }).getByRole('button', { name: '审核通过', exact: true }).click()
  waiting = reply(financePage, `withdrawals/${withdrawal.id}/action`)
  await financePage.locator('.el-message-box:visible').getByRole('button', { name: '审核通过', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  await financePage.locator('.el-table__body tr').filter({ hasText: players[0].name }).getByRole('button', { name: '登记已发放', exact: true }).click()
  waiting = reply(financePage, 'uploads')
  await financeDialog().locator('input[type=file]').setInputFiles({ name: '隔离垫付凭证.png', mimeType: 'image/png', buffer: Buffer.from(merchantPng, 'base64') })
  assert.equal((await waiting).status(), 200)
  await financeDialog().getByRole('link', { name: '隔离垫付凭证.png', exact: true }).waitFor()
  waiting = reply(financePage, `withdrawals/${withdrawal.id}/action`)
  await financeDialog().getByRole('button', { name: '确认已发放', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.equal(service.playerWallet(players[0].id).paid, 3000)
  assert.equal(current(order.id).receivedAmount, 0)
  pass('信用单报酬未回款即可真实申请提现、财务审核并登记垫付，未伪造商家到账')

  await financeOrder(order.id)
  await financeDetail().getByRole('button', { name: '确认收款', exact: true }).click()
  const date = new Date(time.valueOf() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
  const paidAt = field(financePage, financeDialog(), '客户实际付款时间').locator('input')
  await paidAt.fill(date); await paidAt.press('Tab')
  waiting = reply(financePage, `orders/${order.id}/action`)
  await financeDialog().getByRole('button', { name: '确认保存', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.equal(current(order.id).receivedAmount, 8000)
  assert.equal(service.playerWallet(players[0].id).earned, 3000)
  assert.equal(service.playerWallet(players[1].id).earned, 3000)
  await merchantPage.goto(`${base}/#/merchant/overview`)
  await merchantPage.getByText('商家数据看板', { exact: true }).first().waitFor()
  const refreshedOverview = merchantPage.waitForResponse(response => new URL(response.url()).pathname === '/api/studio/merchant/overview')
  await merchantPage.getByRole('button', { name: '查询数据', exact: true }).click()
  assert.equal((await refreshedOverview).status(), 200)
  await merchantPage.waitForLoadState('networkidle')
  const overview = await (await sharedContext.request.get(`${base}/api/studio/merchant/overview`, { headers: { 'X-Studio-Client': 'merchant' } })).json()
  assert.equal(overview.summary.merchantCustomerAmount, 10000)
  assert.equal(overview.summary.receivedAmount, 8000)
  assert.equal(overview.summary.outstandingAmount, 0)
  await merchantPage.screenshot({ path: resolve(output, 'merchant-repaid-overview.png'), fullPage: true })
  pass('完成后财务补记真实80元回款，商家独立看板结清，双人报酬不重复入账')
  for (const width of [390, 768, 1440]) {
    await merchantPage.setViewportSize({ width, height: 1000 })
    const geometry = await merchantPage.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
    result.widths.push({ surface: 'merchant', ...geometry })
    result.uiObservations.push({ name: `merchant-layout-${width}`, passed: geometry.scroll <= geometry.width + 1, observed: geometry })
    await merchantPage.screenshot({ path: resolve(output, `merchant-${width}.png`), fullPage: true })
  }
  await merchantPage.goto(`${base}/#/merchant/create`)
  await create.getByRole('button', { name: '发布商家订单', exact: true }).waitFor()
  await field(merchantPage, create, '订单项目').locator('.el-select').click()
  await merchantPage.getByRole('option').filter({ hasText: templates[0].name }).click()
  await field(merchantPage, create, '房间码').locator('input').fill('CANCEL-ONLY-THIS-ORDER')
  waiting = reply(merchantPage, 'orders')
  await create.getByRole('button', { name: '发布商家订单', exact: true }).click()
  const cancelCandidateResponse = await waiting
  assert.equal(cancelCandidateResponse.status(), 200)
  const cancelCandidate = await cancelCandidateResponse.json()
  await merchantDetail().getByText(current(cancelCandidate.id).orderNo, { exact: true }).first().waitFor()
  await merchantDetail().getByRole('button', { name: '取消订单', exact: true }).click()
  await field(merchantPage, merchantAction(), '原因 / 处理说明').locator('textarea').fill('未接单商家直接取消')
  waiting = reply(merchantPage, `orders/${cancelCandidate.id}/action`)
  await merchantAction().getByRole('button', { name: '确认保存', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.equal(current(cancelCandidate.id).status, 'canceled')
  assert.equal(current(cancelCandidate.id).receivedAmount, 0)
  assert.equal(service.playerWallet(players[0].id).earned, 3000)
  pass('商家页面未接单订单直接取消，无审批或虚构退款，不影响已验收报酬')

  await mobileRoute(`/player/orders/${order.id}`)
  for (const width of [320, 390, 430, 768]) {
    await mobile.setViewportSize({ width, height: 900 })
    const geometry = await mobile.locator('.p-page').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }))
    assert.ok(geometry.scroll <= geometry.width + 1, `player ${width}px horizontal overflow`)
    result.widths.push({ surface: 'player', width, ...geometry })
    await mobile.screenshot({ path: resolve(output, `player-${width}.png`), fullPage: true })
  }
  assert.deepEqual(result.pageErrors, [])
  assert.deepEqual(result.serverErrors, [])
  assert.deepEqual(result.uiObservations.filter(item => !item.passed), [], 'new merchant UI must match actual read scope and authority')
  pass('打手320/390/430/768宽度信用单详情无横向溢出，三端无页面异常或5xx')
  result.ok = true
} catch (error) {
  result.ok = false; result.error = error.message; process.exitCode = 1
  for (const [name, page] of [['merchant', merchantPage], ['finance', financePage], ['player', mobile]])
    if (page && !page.isClosed()) await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true })
  console.error(error)
} finally {
  await browser?.close()
  await adminVite?.close()
  await playerVite?.close()
  await new Promise(ready => server.close(ready))
  result.sourceAfter = sourceFingerprint()
  result.sourceUnchanged = result.sourceBefore.digest === result.sourceAfter.digest
  if (!result.sourceUnchanged) { result.ok = false; result.sourceChangeError = 'Source changed during joint UI validation'; process.exitCode = 1 }
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ output, ok: result.ok, passes: result.passes, sourceUnchanged: result.sourceUnchanged, error: result.error }, null, 2))
}
