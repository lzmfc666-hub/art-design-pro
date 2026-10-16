import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer as portProbe } from 'node:net'
import { createServer as createViteServer } from 'vite'
import { createStudioServer } from '../server/index.mjs'
import { testMutate } from '../tests/helpers/current-intent.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'

const output = resolve(process.env.STUDIO_FINAL_QA_ROOT
  ? resolve(process.env.STUDIO_FINAL_QA_ROOT, 'overview-ui')
  : '.qa/secondary-details-20261014/overview', `run-${randomUUID()}`)
mkdirSync(output, { recursive: true })
process.env.STUDIO_QA_DECLARATIONS_DIR = join(output, 'generated-types')
const before = sourceFingerprint()
const password = `isolated-detail-${randomUUID()}`
const server = createStudioServer({
  dbPath: join(output, 'test.sqlite'),
  seed: false,
  password,
  maintenanceFromEnv: false,
  trustedProxies: [],
  backups: { intervalMinutes: 0, directory: join(output, 'backups'), failureWebhook: '' },
  uploadsCleanup: { enabled: false },
  notificationIntervalMs: 86_400_000,
  notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] }
})
const service = server.service
const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
const level = mutate('/levels', { name: '明细隔离等级', delaySeconds: 0 })
const staff = (username, role, permissionOverrides = {}) =>
  mutate('/users', {
    username,
    name: username,
    role,
    status: 'active',
    levelId: level.id,
    maxActiveOrders: 5,
    permissionOverrides,
    password
  })
const support = staff('detail-ui-support', 'support')
const player = staff('detail-ui-player', 'player', { 'profit.view': true, 'orders.view': true })
const customers = [0, 1, 2].map((index) =>
  mutate('/customers', {
    name: `明细客户${index}`,
    contact: `PRIVATE-CONTACT-${index}`,
    gameId: `PRIVATE-GAME-${index}`,
    remark: 'PRIVATE-CUSTOMER-NOTE'
  })
)
const templates = [0, 1, 2].map((index) =>
  mutate('/templates', {
    name: `明细项目${index}`,
    game: `明细游戏${index}`,
    description: 'PRIVATE-TEMPLATE-TEXT',
    amount: 10000,
    reward: 2000,
    map: '不限',
    remark: '',
    active: true
  })
)
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const receipt = service.upload(support.id, { name: 'private.png', mime: 'image/png', data: PNG })
const orders = Array.from({ length: 23 }, (_, index) =>
  mutate(
    '/orders',
    {
      templateId: templates[index % 3].id,
      customerId: customers[index % 3].id,
      platformId: 'hall',
      roomCode: 'PRIVATE-ROOM',
      gameId: 'PRIVATE-ORDER-GAME',
      receivedAmount: 10000,
      receipt,
      paidAt: new Date().toISOString(),
      dispatchMode: 'pool',
      remark: 'PRIVATE-INTERNAL-NOTE'
    },
    support.id
  )
)
// An approved return creates an existing read-only diagnostic warning.
mutate(`/player/orders/${orders[0].id}/claim`, {}, player.id)
mutate(`/player/orders/${orders[0].id}/return-request`, { reason: '隔离检查退单申请' }, player.id)
const pendingReturn = service
  .orderDetail('admin', orders[0].id)
  .order.returnRequests.find((row) => row.status === 'pending')
mutate(`/orders/${orders[0].id}/action`, {
  action: 'return-approve',
  returnRequestId: pendingReturn.id,
  reason: '隔离检查待重新分配'
})
const report = {
  passed: false,
  cases: [],
  errors: [],
  serverErrors: [],
  layouts: [],
  output,
  sourceBefore: before
}
let vite, browser, page
const pass = (text) => {
  report.cases.push(text)
  console.log('PASS ' + text)
}
async function freePort() {
  const probe = portProbe()
  await new Promise((done) => probe.listen(0, '127.0.0.1', done))
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  return port
}
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const api = `http://127.0.0.1:${server.address().port}`
  vite = await createViteServer({
    cacheDir: join(output, 'vite-cache'),
    server: {
      host: '127.0.0.1',
      port: await freePort(),
      strictPort: true,
      watch: { ignored: ['**/player-client/**', '**/.qa/**', '**/.data/**'] },
      proxy: { '/api': { target: api, changeOrigin: true } }
    }
  })
  await vite.listen()
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`
  report.apiPort = server.address().port
  report.uiPort = vite.httpServer.address().port
  const require = createRequire(import.meta.url)
  const {
    chromium
  } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const supportContext = await browser.newContext()
  const playerContext = await browser.newContext()
  assert.equal(
    (
      await context.request.post(api + '/api/studio/login', {
        data: { username: 'admin', password }
      })
    ).status(),
    200
  )
  assert.equal(
    (
      await supportContext.request.post(api + '/api/studio/login', {
        data: { username: support.username, password }
      })
    ).status(),
    200
  )
  assert.equal(
    (
      await playerContext.request.post(api + '/api/studio/login', {
        headers: { 'X-Studio-Client': 'player' },
        data: { username: player.username, password }
      })
    ).status(),
    200
  )
  const requests = []
  const businessWrites = []
  page = await context.newPage()
  page.setDefaultTimeout(25_000)
  page.on('pageerror', (error) => report.errors.push(error.message))
  page.on('response', (response) => {
    if (response.url().includes('/api/studio/') && response.status() >= 500)
      report.serverErrors.push({
        path: new URL(response.url()).pathname,
        status: response.status()
      })
  })
  page.on('request', (request) => {
    if (request.url().includes('/overview/details?')) requests.push(request.url())
    if (
      request.url().includes('/api/studio/') &&
      request.method() === 'POST' &&
      !['/api/studio/login', '/api/studio/logout'].includes(new URL(request.url()).pathname)
    )
      businessWrites.push(new URL(request.url()).pathname)
  })
  const dialog = () => page.locator('.overview-statistics-detail:visible')
  const card = (name) =>
    page
      .locator('.overview-metric-card')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
  const detailWait = (predicate) =>
    page.waitForResponse(
      (response) =>
        response.url().includes('/overview/details?') &&
        response.ok() &&
        (!predicate || predicate(new URL(response.url()).searchParams))
    )
  const open = async (name) => {
    const waiting = detailWait()
    await card(name).getByRole('button', { name: '查看详情', exact: true }).click()
    const data = await (await waiting).json()
    await dialog().locator('.detail-record-table').waitFor()
    return data
  }
  const view = async (name) => {
    const waiting = detailWait()
    await dialog()
      .locator('.detail-explorer-navigation')
      .getByRole('button', { name, exact: true })
      .click()
    const data = await (await waiting).json()
    await dialog().locator('.detail-record-table').waitFor()
    return data
  }
  const close = async () => {
    await dialog().getByRole('button', { name: '关闭', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
  }
  await page.goto(base + '/#/dashboard/console')
  await card('营业额').waitFor()
  assert.equal(requests.length, 0)
  const initial = await open('营业额')
  assert.equal(initial.summary.received, 230000)
  assert.equal(initial.view, 'days')
  assert.ok(new URL(page.url()).hash.includes('secondary=overview-metric'))
  assert.equal(await page.locator('.el-dialog:visible').count(), 0)
  await page.goBack()
  await dialog().waitFor({ state: 'hidden' })
  await card('营业额').waitFor()
  let restoring = detailWait()
  await page.goForward()
  assert.equal((await (await restoring).json()).summary.received, 230000)
  await dialog().waitFor()
  restoring = detailWait()
  await page.reload()
  const restored = await (await restoring).json()
  assert.equal(restored.metric, 'received')
  assert.equal(restored.summary.received, 230000)
  assert.deepEqual(restored.range, initial.range)
  pass(
    'long overview details navigate to a normal business page; Back/Forward and refresh reauthorize the same metric and dates'
  )
  const paid = await view('付款订单')
  assert.equal(paid.total, 23)
  assert.equal(paid.records.length, 20)
  assert.ok((await dialog().innerText()).includes('端游 / 手游'))
  assert.ok(!(await dialog().innerText()).includes('PRIVATE-INTERNAL-NOTE'))
  pass(
    'lazy real overview detail loading shows authoritative totals, safe columns and explicitly unsupported terminal'
  )
  let waiting = detailWait((params) => params.get('current') === '2')
  await dialog().locator('.detail-pagination .btn-next').click()
  const second = await (await waiting).json()
  assert.equal(second.total, 23)
  assert.equal(second.records.length, 3)
  assert.equal(second.summary.received, 230000)
  await dialog().locator('.detail-record-table').waitFor()
  await dialog().getByRole('textbox', { name: '搜索统计明细' }).fill(orders[0].orderNo)
  waiting = detailWait((params) => params.get('keyword') === orders[0].orderNo)
  await dialog().getByRole('button', { name: '搜索明细', exact: true }).click()
  const found = await (await waiting).json()
  assert.equal(found.total, 1)
  assert.equal(found.summary.received, 230000)
  pass('pagination and public-keyword filtering preserve exact totals and full summary')
  waiting = detailWait()
  await dialog().getByRole('button', { name: '清空', exact: true }).click()
  await waiting
  const games = await view('按游戏')
  assert.equal(games.total, 3)
  assert.equal(
    games.groups.reduce((sum, row) => sum + row.count, 0),
    23
  )
  await dialog().locator('.detail-distribution canvas').waitFor()
  await page.evaluate(async () => {
    const { echarts } = await import('/src/plugins/echarts.ts')
    const host = document
      .querySelector('.overview-statistics-detail .detail-distribution canvas')
      ?.closest('[_echarts_instance_]')
    const chart = host && echarts.getInstanceByDom(host)
    if (!chart || !chart.getOption().series?.[0]?.data?.length)
      throw new Error('Actual chart data not rendered')
    if (!chart.getZr().animation.isFinished())
      await new Promise((done, reject) => {
        const timeout = setTimeout(() => {
          chart.off('finished', settle)
          reject(new Error('Chart did not finish rendering'))
        }, 10000)
        const settle = () => {
          clearTimeout(timeout)
          chart.off('finished', settle)
          done()
        }
        chart.on('finished', settle)
      })
  })
  await page.screenshot({ path: join(output, 'received-by-game-desktop.png') })
  const projects = await view('按项目/价格快照')
  assert.equal(projects.total, 3)
  pass('game and project charts aggregate all authorized records rather than one page')
  for (const width of [320, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 })
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      dialogWidth: document.querySelector('.overview-statistics-detail').getBoundingClientRect()
        .width
    }))
    assert.ok(layout.pageWidth <= width + 1, `overview page overflow at ${width}`)
    assert.ok(layout.dialogWidth <= width)
    await dialog().getByRole('button', { name: '关闭', exact: true }).scrollIntoViewIfNeeded()
    report.layouts.push(layout)
    if ([390, 768, 1440].includes(width))
      await page.screenshot({ path: join(output, `overview-detail-${width}.png`) })
  }
  pass(
    'overview secondary interface retains usable close and classification controls at 320/390/430/768/1440'
  )
  await close()
  await page.setViewportSize({ width: 1440, height: 1100 })
  for (const name of ['订单统计', '客户消费', '区间经营利润', '人员新增', '接单统计', '费用统计']) {
    const data = await open(name)
    assert.ok(data.columns.length)
    await close()
  }
  const countBeforeWallet = requests.length
  await card('打手待付余额').getByRole('button', { name: '查看详情', exact: true }).click()
  await dialog().getByText('金额已隐藏', { exact: true }).waitFor()
  assert.equal(requests.length, countBeforeWallet)
  waiting = detailWait()
  await dialog().getByRole('button', { name: '显示金额', exact: true }).click()
  const wallet = await (await waiting).json()
  assert.equal(wallet.metric, 'wallet')
  await close()
  pass(
    'all available metric secondary views use actual reads and hidden-wallet details wait for explicit reveal'
  )
  await open('营业额')
  const drilldown = await view('付款订单')
  await dialog()
    .locator('.detail-record-table')
    .getByRole('button', { name: String(drilldown.records[0].orderNo), exact: true })
    .click()
  const drilldownId = String(drilldown.records[0].orderId || drilldown.records[0].id)
  await page.waitForURL((url) => {
    const location = new URL(url.hash.slice(1), url.origin)
    const keys = location.searchParams.getAll('secondary')
    const records = location.searchParams.getAll('secondaryRecord')
    return (
      location.pathname === '/orders/list' &&
      (location.searchParams.get('id') === drilldownId ||
        records[keys.indexOf('order-detail')] === drilldownId)
    )
  })
  await page.locator('.business-detail-drawer:visible').waitFor()
  pass('drilldown opens existing current-authorized order detail using its original route identity')
  const supportPage = await supportContext.newPage()
  supportPage.on('pageerror', (error) => report.errors.push(error.message))
  await supportPage.goto(base + '/#/dashboard/console')
  await supportPage.locator('.overview-metric-card').first().waitFor()
  assert.equal(await supportPage.getByRole('heading', { name: '营业额', exact: true }).count(), 0)
  assert.equal(
    (
      await supportContext.request.get(api + '/api/studio/overview/details?metric=received')
    ).status(),
    403
  )
  assert.equal(
    (
      await playerContext.request.get(api + '/api/studio/overview/details?metric=received', {
        headers: { 'X-Studio-Client': 'player' }
      })
    ).status(),
    403
  )
  pass('support and player permission overrides cannot read unauthorized global financial details')
  await page.goto(base + '/#/system/role')
  await page.getByRole('button', { name: '查看权限', exact: true }).first().click()
  await page.getByRole('textbox', { name: '搜索默认权限' }).fill('订单')
  assert.ok(
    await page
      .locator('.business-detail-dialog:visible')
      .getByText('筛选后', { exact: false })
      .count()
  )
  await page
    .locator('.business-detail-dialog:visible')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await page.goto(base + '/#/system/menu')
  await page.getByRole('button', { name: '查看准入详情', exact: true }).first().click()
  await page.getByText('只读路由定义', { exact: true }).waitFor()
  await page
    .locator('.business-detail-dialog:visible')
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  pass(
    'role and menu secondary views explain default permissions and all/any access conditions without writes'
  )
  const reportRead = () =>
    page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === '/api/studio/bootstrap' &&
        url.searchParams.get('includeReports') === 'true' &&
        response.ok()
      )
    })
  let reading = reportRead()
  await page.evaluate(() => {
    location.hash = '/dashboard/analysis'
  })
  const reportData = await (await reading).json()
  assert.equal(reportData.reports.days.length, 31)
  await page.getByRole('button', { name: '查看日报详情', exact: true }).first().click()
  const analysis = page.locator('[data-page-key="analysis-record"]:visible')
  await analysis.getByText('归属与统计说明', { exact: true }).waitFor()
  assert.ok(new URL(page.url()).hash.includes('secondary=analysis-record'))
  reading = reportRead()
  await page.reload()
  assert.equal((await (await reading).json()).reports.days.length, 31)
  await analysis.getByText('归属与统计说明', { exact: true }).waitFor()
  await analysis.getByRole('button', { name: '关闭', exact: true }).click()
  await analysis.waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(output, 'analysis-normal-page.png') })
  pass(
    'monthly analysis loads complete authorized reports on SPA entry; daily detail URL reload restores the same month and record'
  )
  await page.goto(base + '/#/system/diagnostics')
  reading = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/studio/diagnostics' && response.ok()
  )
  await page.getByRole('button', { name: '开始数据检查', exact: true }).click()
  const inspection = await (await reading).json()
  assert.ok(inspection.issues.some((row) => row.entityId === orders[0].id))
  await page.getByRole('button', { name: '查看检查详情', exact: true }).first().click()
  const diagnostic = page.locator('[data-page-key="diagnostic-issue"]:visible')
  await diagnostic.getByText('关联与核对说明', { exact: true }).waitFor()
  reading = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/studio/diagnostics' && response.ok()
  )
  await page.reload()
  assert.ok((await (await reading).json()).issues.length > 0)
  await diagnostic.getByText('关联与核对说明', { exact: true }).waitFor()
  await diagnostic.getByRole('button', { name: '关闭', exact: true }).click()
  await diagnostic.waitFor({ state: 'hidden' })
  pass(
    'diagnostic detail reload reruns the original authorized read and restores an actual current issue without repairing business data'
  )
  reading = reportRead()
  await page.evaluate(() => {
    location.hash = '/system/user-center'
  })
  const selfData = await (await reading).json()
  assert.equal(selfData.user.id, 'admin')
  assert.equal(selfData.reports.month, reportData.reports.month)
  await page.getByText('所选月份个人业绩', { exact: true }).waitFor()
  await page.getByRole('button', { name: '保存资料', exact: true }).waitFor()
  await page.getByRole('button', { name: '修改密码并重新登录', exact: true }).waitFor()
  assert.deepEqual(businessWrites, [])
  pass(
    'personal center explicitly reads current authorized report data on SPA entry while retaining original profile/password forms without writes'
  )
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.serverErrors, [])
  report.requests = requests.length
  report.passed = true
} catch (error) {
  report.failedUrl = page?.url()
  report.error = error.message
  report.stack = error.stack
  process.exitCode = 1
  if (page) {
    try {
      await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
    } catch {}
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
  if (server.listening) await new Promise((done) => server.close(done))
  else service.close()
  report.sourceAfter = sourceFingerprint()
  report.sourceUnchanged = before.digest === report.sourceAfter.digest
  if (!report.sourceUnchanged) {
    report.passed = false
    report.sourceChangeError = 'Source changed during acceptance'
    process.exitCode = 1
  }
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
  writeFileSync(
    resolve('.qa/secondary-details-20261014/overview/latest-result.json'),
    JSON.stringify(report, null, 2)
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      cases: report.cases.length,
      requests: report.requests,
      sourceUnchanged: report.sourceUnchanged,
      output,
      error: report.error
    })
  )
}
