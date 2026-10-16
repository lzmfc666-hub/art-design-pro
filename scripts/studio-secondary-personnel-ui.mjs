import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { createServer as createPortProbe } from 'node:net'
import { createServer as createViteServer } from 'vite'
import webpush from 'web-push'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { createStudioServer } from '../server/index.mjs'
import { testMutate } from '../tests/helpers/current-intent.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'

// This suite exercises presentation and cancellation. Existing business/funds
// regressions remain responsible for mutation semantics and financial workflows.
// Compile-only mode opens no database, browser or server.
if (process.argv.includes('--compile-only')) {
  try {
    console.log(
      JSON.stringify({ passed: true, compiledTemplates: compileOwnedTemplates() }, null, 2)
    )
    process.exit(0)
  } catch (error) {
    console.error(error.stack || error)
    process.exit(1)
  }
}
const qaRoot = resolve('.qa/secondary-details-20261014/personnel')
const privacyOnly = process.argv.includes('--privacy-only')
const navigationOnly = process.argv.includes('--navigation-only')
const customerOnly = process.argv.includes('--customer-only')
const output = join(qaRoot, `run-${randomUUID()}`)
const database = join(output, 'test.sqlite')
assert.ok(output.startsWith(resolve('.qa') + sep))
assert.ok(!database.includes(`${sep}.data${sep}`))
mkdirSync(output, { recursive: true })
process.env.STUDIO_QA_DECLARATIONS_DIR = join(output, 'generated-types')
const before = sourceFingerprint()
const password = `secondary-isolated-${randomUUID()}`
const started = new Date()
const day = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(started)
const report = {
  passed: false,
  output,
  database,
  startedAt: started.toISOString(),
  cases: [],
  layouts: [],
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  requestFailures: [],
  requests: [],
  browserPostAttempts: [],
  serverBusinessPosts: [],
  controlledTransport: [],
  navigations: [],
  denied: [],
  privacyChecks: [],
  sourceBefore: before,
  isolation: {
    realDiskSQLite: true,
    maintenanceFromEnv: false,
    backupIntervalMinutes: 0,
    uploadCleanup: false,
    fakePush: true
  },
  limitations: [
    'Desktop Chromium and emulated 390/768 viewports are not real mobile devices.',
    'Permission cleanup is checked after an actual protected detail read or bootstrap refresh; no immediate cross-tab revocation is claimed.',
    'This is secondary-interface coverage; existing financial and concurrency suites remain required.'
  ]
}
console.log(JSON.stringify({ output, database }))
let server, service, vite, browser, page
let stage = 'isolated fixture setup'

function timeout(promise, label, milliseconds = 60_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
        milliseconds
      )
    })
  ]).finally(() => clearTimeout(timer))
}
async function freePort() {
  const probe = createPortProbe()
  try {
    await timeout(
      new Promise((done, reject) => {
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', done)
      }),
      'port probe',
      10_000
    )
    const port = probe.address().port
    assert.ok(![3006, 3007, 3008].includes(port))
    return port
  } finally {
    if (probe.listening)
      await timeout(new Promise((done) => probe.close(done)), 'port probe close', 10_000)
  }
}
function pass(name) {
  report.cases.push(name)
  console.log('PASS ' + name)
}
function compileOwnedTemplates() {
  const files = [
    'src/views/orders/list/index.vue',
    'src/views/orders/modules/order-detail.vue',
    'src/views/orders/create/index.vue',
    'src/views/orders/customers/index.vue',
    'src/views/orders/customers/modules/customer-balance.vue',
    'src/views/personnel/players/index.vue',
    'src/views/personnel/players/modules/player-wallet.vue',
    'src/views/personnel/players/modules/player-deposits.vue',
    'src/views/personnel/players/modules/player-history.vue',
    'src/views/system/user/index.vue',
    'src/views/system/user/modules/user-dialog.vue',
    'src/views/personnel/attendance/index.vue'
  ]
  const compiled = []
  for (const filename of files) {
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
    assert.deepEqual(errors, [], `${filename}: SFC parse failed`)
    const script = compileScript(descriptor, { id: filename })
    const template = compileTemplate({
      source: descriptor.template.content,
      filename,
      id: filename,
      compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] }
    })
    assert.deepEqual(template.errors, [], `${filename}: Vue template compile failed`)
    compiled.push(filename)
  }
  return compiled
}
const fmt = (value) =>
  `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

try {
  report.compiledTemplates = compileOwnedTemplates()
  pass(
    'all 12 owned Vue SFC scripts and templates compile through the actual Vue compiler before browser startup'
  )
  server = createStudioServer({
    dbPath: database,
    password,
    seed: false,
    maintenanceFromEnv: false,
    trustedProxies: [],
    backups: { intervalMinutes: 0, directory: join(output, 'backups'), failureWebhook: '' },
    uploadCleanup: { enabled: false },
    notificationIntervalMs: 86_400_000,
    notifications: {
      ...webpush.generateVAPIDKeys(),
      subject: 'mailto:secondary-ui@example.invalid',
      allowedPushHosts: [],
      pushSender: async () => {}
    }
  })
  service = server.service
  server.on('request', (request) => {
    if (
      request.method === 'POST' &&
      !['/api/studio/login', '/api/studio/logout'].includes(
        new URL(request.url, 'http://isolated.invalid').pathname
      )
    )
      report.serverBusinessPosts.push({
        path: new URL(request.url, 'http://isolated.invalid').pathname
      })
  })
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '二级详情隔离等级', delaySeconds: 0 })
  const staff = (username, name, role, permissionOverrides = {}) =>
    mutate('/users', {
      username,
      name,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 10,
      permissionOverrides,
      password
    })
  const player = staff('secondary-player', '二级详情打手', 'player')
  const employee = staff('secondary-employee-private-account', '二级详情员工', 'support', {
    'orders.edit': false
  })
  const viewer = staff('secondary-viewer', '二级详情验证管理员', 'admin', {
    'orders.view': true,
    'orders.create': true,
    'orders.edit': true,
    'finance.review': true,
    'finance.refunds': true,
    'finance.withdrawals': true,
    'attendance.manage': true,
    'users.manage': true
  })
  const platform = mutate('/platforms', {
    name: '二级详情隔离来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: true,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const customer = mutate('/customers', {
    name: '二级详情客户',
    platformId: platform.id,
    contact: 'SECONDARY-PRIVATE-CONTACT',
    gameId: '000-SECONDARY-GAME',
    remark: 'SECONDARY-CUSTOMER-REMARK'
  })
  for (let index = 1; index <= 24; index++)
    mutate('/customer-order-references', {
      customerId: customer.id,
      platformId: platform.id,
      shopId: null,
      externalOrderNo: `000-SECONDARY-REF-${String(index).padStart(2, '0')}`
    })
  for (let index = 1; index <= 22; index++) {
    mutate('/customer-transactions', {
      customerId: customer.id,
      kind: 'recharge',
      amount: 1000,
      reason: `SECONDARY-RECHARGE-${index}`
    })
    mutate('/player-deposit-transactions', {
      userId: player.id,
      kind: 'deposit',
      amount: 500,
      reason: `SECONDARY-DEPOSIT-${index}`
    })
  }
  mutate('/player-adjustments', {
    userId: player.id,
    kind: 'supplement',
    amount: 5000,
    reason: 'SECONDARY-SUPPLEMENT'
  })
  const deduction = mutate('/player-adjustments', {
    userId: player.id,
    kind: 'deduction',
    amount: 7000,
    reason: 'SECONDARY-MANUAL-DEDUCTION'
  })
  assert.equal(deduction.status, 'manual')
  const template = mutate('/templates', {
    name: '二级详情订单项目',
    game: 'QA',
    description: 'SECONDARY-TEMPLATE-TARGET',
    amount: 10000,
    reward: 4000,
    map: '不限',
    remark: 'SECONDARY-SNAPSHOT-REMARK',
    active: true
  })
  const order = (changes) =>
    mutate('/orders', {
      templateId: template.id,
      customerId: customer.id,
      platformId: platform.id,
      shopId: null,
      externalOrderNo: `000-SECONDARY-ORDER-${randomUUID()}`,
      roomCode: 'SECONDARY-PRIVATE-ROOM',
      gameId: 'SECONDARY-PRIVATE-GAME',
      amount: 10000,
      reward: 4000,
      receivedAmount: 10000,
      paidAt: started.toISOString(),
      receipt: null,
      dispatchMode: 'pool',
      remark: 'SECONDARY-INTERNAL-REMARK',
      playerRemark: 'SECONDARY-PLAYER-REMARK',
      ...changes
    })
  const completed = order({})
  mutate(`/player/orders/${completed.id}/claim`, {}, player.id)
  const png = service.upload(player.id, {
    name: 'secondary-completion.png',
    mime: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
  })
  mutate(`/player/orders/${completed.id}/submit`, { screenshots: [png] }, player.id)
  mutate(`/orders/${completed.id}/action`, { action: 'review-pass' })
  for (let index = 1; index <= 21; index++) {
    const history = order({})
    mutate(`/player/orders/${history.id}/claim`, {}, player.id)
    mutate(`/orders/${history.id}/action`, {
      action: 'release',
      reason: `SECONDARY-RELEASE-${index}`
    })
  }
  const active = order({})
  mutate(`/player/orders/${active.id}/claim`, {}, player.id)
  const pendingReview = order({})
  mutate(`/player/orders/${pendingReview.id}/claim`, {}, player.id)
  mutate(`/player/orders/${pendingReview.id}/submit`, { screenshots: [png] }, player.id)
  const unpaid = order({ receivedAmount: 0, paidAt: null, payOnArrival: true })
  mutate('/attendance', {
    userId: employee.id,
    date: day,
    start: '09:00',
    end: '18:00',
    status: 'present',
    actualHours: 7.5,
    remark: 'SECONDARY-ATTENDANCE-REMARK'
  })
  mutate('/work-schedules', {
    userId: employee.id,
    effectiveFrom: day,
    enabled: true,
    start: '09:00',
    end: '18:00',
    remark: 'SECONDARY-SCHEDULE-REMARK'
  })
  report.fixtures = {
    customer: customer.id,
    employee: employee.id,
    player: player.id,
    viewer: viewer.id,
    completed: completed.id,
    active: active.id,
    unpaid: unpaid.id,
    references: 24,
    rechargeRows: 22,
    depositRows: 22,
    associatedPlayerOrders: 24,
    pendingReview: pendingReview.id,
    date: day
  }

  const invariant = () => {
    const data = service.bootstrap('admin')
    return {
      orders: data.orders.map((row) => ({
        id: row.id,
        revision: row.revision,
        status: row.status,
        amount: row.amount,
        reward: row.reward
      })),
      customerAccount: service.customerBalance('admin', customer.id),
      customerTransactions: service.customerTransactions('admin', customer.id).total,
      deposit: {
        balance: service.playerDeposit('admin', player.id).balance,
        total: service.playerDeposit('admin', player.id).total
      },
      wallets: data.wallets,
      adjustments: data.playerAdjustments,
      attendance: data.attendance,
      schedules: data.workSchedules
    }
  }
  const businessBefore = invariant()
  await timeout(
    new Promise((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    }),
    'isolated API listen'
  )
  report.apiPort = server.address().port
  assert.ok(![3006, 3007, 3008].includes(report.apiPort))
  const api = `http://127.0.0.1:${report.apiPort}`
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
  await timeout(vite.listen(), 'isolated Vite listen')
  report.uiPort = vite.httpServer.address().port
  assert.ok(![3006, 3007, 3008].includes(report.uiPort))
  const base = `http://127.0.0.1:${report.uiPort}`
  const require = createRequire(import.meta.url)
  const {
    chromium
  } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  browser = await chromium.launch({ headless: true, channel: 'msedge', timeout: 60_000 })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(30_000)
  assert.equal(
    (
      await context.request.post(api + '/api/studio/login', {
        data: { username: 'admin', password }
      })
    ).status(),
    200
  )
  page = await context.newPage()
  const controlledRequests = new Set()
  const controlledUrls = new Set()
  const observe = (target) => {
    target.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (
        request.method() === 'POST' &&
        path.startsWith('/api/studio/') &&
        !['/api/studio/login', '/api/studio/logout'].includes(path)
      )
        report.browserPostAttempts.push({ stage, path })
    })
    target.on('framenavigated', (frame) => {
      if (frame === target.mainFrame())
        report.navigations.push({ stage, at: new Date().toISOString(), url: frame.url() })
    })
    target.setDefaultTimeout(30_000)
    target.setDefaultNavigationTimeout(60_000)
    target.on('pageerror', (error) => report.pageErrors.push({ stage, message: error.message }))
    target.on('console', (message) => {
      if (
        controlledUrls.has(message.location().url) &&
        /net::ERR_(?:ABORTED|FAILED)|Failed to fetch/.test(message.text())
      ) {
        report.controlledTransport.push({
          event: 'expected-abort-console',
          message: message.text()
        })
        return
      }
      if (message.type() === 'error' && !/\b(401|403|404|409)\b/.test(message.text()))
        report.consoleErrors.push({ stage, message: message.text().slice(0, 500) })
    })
    target.on('requestfailed', (request) => {
      if (controlledRequests.has(request)) {
        report.controlledTransport.push({
          event: 'expected-request-abort',
          path: new URL(request.url()).pathname,
          error: request.failure()?.errorText
        })
        return
      }
      if (
        new URL(request.url()).pathname.startsWith('/api/studio/') &&
        request.failure()?.errorText !== 'net::ERR_ABORTED'
      )
        report.requestFailures.push({
          stage,
          path: new URL(request.url()).pathname,
          message: request.failure()?.errorText
        })
    })
    target.on('response', (response) => {
      const url = new URL(response.url())
      if (!url.pathname.startsWith('/api/studio/')) return
      const value = {
        stage,
        method: response.request().method(),
        path: url.pathname,
        query: url.search,
        status: response.status()
      }
      report.requests.push(value)
      if (response.status() >= 500) report.serverErrors.push(value)
    })
  }
  observe(page)
  const rows = (scope) => scope.locator('.el-table__body tr')
  const dialog = (title, target = page) =>
    target
      .locator('.business-detail-page-panel:visible,.el-dialog:visible')
      .filter({ has: target.getByRole('heading', { name: title, exact: true }) })
  const drawer = (target = page) =>
    target.locator('.business-detail-page-panel:visible,.el-drawer:visible')
  const pageLocation = () => new URL(page.url().split('#')[1], 'http://isolated.invalid')
  function assertPageKey(key, recordId) {
    const location = pageLocation()
    const keys = location.searchParams.getAll('secondary')
    const ids = location.searchParams.getAll('secondaryRecord')
    const index = keys.lastIndexOf(key)
    assert.ok(index >= 0, `Missing secondary page ${key}: ${page.url()}`)
    if (recordId) assert.equal(ids[index], recordId)
    assert.ok(
      !/SECONDARY-(?:PRIVATE|INTERNAL|CUSTOMER-REMARK)|password/i.test(location.search),
      'private form data leaked into page URL'
    )
  }
  const field = (scope, label, target = page) =>
    scope
      .locator('.el-form-item')
      .filter({ has: target.locator('.el-form-item__label').getByText(label, { exact: true }) })
      .first()
  const text = async (scope, value) => {
    await scope.getByText(value, { exact: true }).first().waitFor()
  }
  async function quiet(target = page) {
    await target.waitForFunction(
      () =>
        [...document.querySelectorAll('.el-message')].every(
          (node) =>
            !node.getBoundingClientRect().height || getComputedStyle(node).display === 'none'
        ),
      null,
      { timeout: 12_000 }
    )
    await target.waitForFunction(
      () =>
        [...document.querySelectorAll('.el-loading-mask')].every(
          (node) =>
            !node.getBoundingClientRect().height || getComputedStyle(node).display === 'none'
        ),
      null,
      { timeout: 30_000 }
    )
  }
  async function enter(path, heading, target = page) {
    stage = path
    const loading = target.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/studio/bootstrap' &&
        response.request().method() === 'GET'
    )
    // A hash-only goto reuses the existing document and does not promise a new
    // bootstrap request. A fresh query forces real document initialization while
    // retaining this isolated browser context's cookie and the intended route.
    await target.goto(`${base}/?secondaryUi=${randomUUID()}#${path}`)
    assert.equal((await loading).status(), 200)
    const destination = new URL(path, 'http://isolated.invalid')
    if (destination.pathname === '/orders/list' && destination.searchParams.has('id'))
      await target.locator('[data-page-key="order-detail"]:visible').waitFor()
    else await target.getByRole('heading', { name: heading, exact: true }).waitFor()
    await quiet(target)
  }
  async function capture(name, scope, target = page, button) {
    stage = name
    await scope.waitFor()
    await quiet(target)
    if (button) {
      const control = scope.getByRole('button', { name: button, exact: true }).first()
      await control.scrollIntoViewIfNeeded()
      assert.ok(await control.isVisible(), `${name}: ${button} is not visible`)
      assert.ok(await control.isEnabled(), `${name}: ${button} is disabled`)
      const position = await control.boundingBox()
      assert.ok(
        position &&
          position.y >= -1 &&
          position.y + position.height <= target.viewportSize().height + 1,
        `${name}: ${button} is outside viewport`
      )
    }
    const layout = await target.evaluate(() => ({
      width: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth
    }))
    const box = await scope.boundingBox()
    assert.ok(
      layout.pageWidth <= layout.width + 2,
      `${name}: page overflow ${JSON.stringify(layout)}`
    )
    assert.ok(
      box && box.x >= -1 && box.x + box.width <= layout.width + 2,
      `${name}: overlay exceeds viewport ${JSON.stringify(box)}`
    )
    report.layouts.push({ name, ...layout, overlay: box })
    const screenshot = join(output, `${name}.png`)
    await target.screenshot({ path: screenshot })
    report.screenshots.push(screenshot)
    const scrollingBody = scope
      .locator('.business-detail-panel-body,.el-dialog__body,.el-drawer__body')
      .first()
    if (await scrollingBody.count()) {
      await scrollingBody.evaluate((node) => {
        node.scrollTop = 0
      })
      const topScreenshot = join(output, `${name}-top.png`)
      await target.screenshot({ path: topScreenshot })
      report.screenshots.push(topScreenshot)
    }
  }
  async function close(scope, label, target = page) {
    if (label) await scope.getByRole('button', { name: label, exact: true }).first().click()
    else if (await scope.locator('.business-detail-panel-header').count())
      await scope.getByRole('button', { name: '关闭详情页', exact: true }).click()
    else await scope.locator('.el-dialog__headerbtn,.el-drawer__close-btn').first().click()
    await scope.waitFor({ state: 'hidden' })
    await quiet(target)
  }
  async function assertFields(scope, labels) {
    for (const label of labels) {
      await field(scope, label).first().waitFor({ state: 'attached' })
      assert.ok(await field(scope, label).count(), `Missing form field ${label}`)
    }
  }

  if (!privacyOnly && !navigationOnly) {
    // Full desktop coverage; narrow widths exercise the same actual modal controls.
    await enter('/personnel/customers', '老板管理')
    const customerRow = rows(page).filter({ hasText: customer.name }).first()
    await customerRow.getByRole('button', { name: '查看详情', exact: true }).click()
    await text(drawer(), 'SECONDARY-PRIVATE-CONTACT')
    await text(drawer(), '000-SECONDARY-GAME')
    await text(drawer(), 'SECONDARY-CUSTOMER-REMARK')
    assert.equal(await rows(drawer()).count(), 20)
    await text(drawer(), '24')
    await capture('desktop-customer-detail', drawer(), page, '编辑档案')
    await close(drawer())
    pass(
      'customer readonly dossier renders authorized identity, exact reference total and explicitly limited 20-reference preview'
    )

    await customerRow.getByRole('button', { name: '编辑与关联编号', exact: true }).click()
    let scope = dialog('编辑客户档案')
    await assertFields(scope, ['客户名称', '联系方式', '游戏 ID', '备注', '平台订单号'])
    await scope.getByText('共 24 条关联记录', { exact: true }).waitFor()
    const referencesPage = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/studio/customers/${customer.id}/order-references` &&
        new URL(response.url()).searchParams.get('current') === '2'
    )
    await scope.locator('.reference-pagination').getByText('2', { exact: true }).click()
    const referencesResult = await referencesPage
    assert.equal(referencesResult.status(), 200)
    const referencesBody = await referencesResult.json()
    assert.equal(referencesBody.total, 24)
    assert.equal(referencesBody.records.length, 4)
    await text(scope, referencesBody.records[0].externalOrderNo)
    await rows(scope)
      .filter({ hasText: referencesBody.records[0].externalOrderNo })
      .getByRole('button', { name: '删除', exact: true })
      .click()
    const deleteConfirmation = page.locator('.el-message-box:visible')
    await text(deleteConfirmation, customer.name)
    await text(deleteConfirmation, referencesBody.records[0].externalOrderNo)
    await text(deleteConfirmation, platform.name)
    await capture(
      'desktop-customer-reference-delete-confirmation',
      deleteConfirmation,
      page,
      '取消'
    )
    await close(deleteConfirmation, '取消')
    await capture('desktop-customer-editor-reference-page-2', scope, page, '关闭')
    await close(scope, '关闭')
    pass(
      'customer editor preserves required fields and performs actual reference pagination with authoritative total'
    )

    await customerRow.getByRole('button', { name: '储值账户', exact: true }).click()
    scope = dialog(`${customer.name} · 储值账户`)
    await text(scope, fmt(businessBefore.customerAccount.balance))
    const ledgerPage = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/studio/customers/${customer.id}/transactions` &&
        new URL(response.url()).searchParams.get('current') === '2'
    )
    await scope.locator('.el-pagination').getByText('2', { exact: true }).click()
    const ledgerResponse = await ledgerPage
    assert.equal(ledgerResponse.status(), 200)
    const ledgerBody = await ledgerResponse.json()
    assert.equal(ledgerBody.total, 22)
    assert.equal(ledgerBody.records.length, 2)
    await text(scope, ledgerBody.records[0].reason)
    await capture('desktop-customer-balance', scope, page, '确认登记')
    await rows(scope)
      .filter({ hasText: ledgerBody.records[0].reason })
      .getByRole('button', { name: '查看明细', exact: true })
      .click()
    const ledgerDetail = dialog('储值流水详情')
    await text(ledgerDetail, ledgerBody.records[0].reason)
    await text(ledgerDetail, ledgerBody.records[0].createdByName)
    await capture('desktop-customer-transaction-detail', ledgerDetail)
    assertPageKey('customer-balance', customer.id)
    assertPageKey('customer-transaction-detail', ledgerBody.records[0].id)
    const transactionRestored = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/studio/customers/${customer.id}/transactions/${ledgerBody.records[0].id}`
    )
    await page.reload()
    assert.equal((await transactionRestored).status(), 200)
    await text(dialog('储值流水详情'), ledgerBody.records[0].reason)
    const transactionPageUrl = page.url()
    if (customerOnly)
      await page.evaluate(async () => {
        const { router } = await import('/src/router/index.ts')
        window.__secondaryRouterTrace = []
        for (const method of ['push', 'replace', 'back']) {
          const original = router[method].bind(router)
          router[method] = (...args) => {
            window.__secondaryRouterTrace.push({
              method,
              from: router.currentRoute.value.fullPath,
              args: JSON.parse(JSON.stringify(args)),
              history: { ...router.options.history.state }
            })
            const result = original(...args)
            if (result && typeof result.then === 'function')
              result.then((failure) =>
                window.__secondaryRouterTrace.push({
                  method: method + '-settled',
                  current: router.currentRoute.value.fullPath,
                  failure: failure?.type || null
                })
              )
            return result
          }
        }
        router.afterEach((to, from, failure) =>
          window.__secondaryRouterTrace.push({
            method: 'afterEach',
            from: from.fullPath,
            to: to.fullPath,
            failure: failure?.type || null,
            history: { ...router.options.history.state }
          })
        )
      })
    pass(
      'customer ledger record refresh reauthorizes exact ID beyond initial page and retains public parent/child URL IDs'
    )
    await close(ledgerDetail)
    let transactionEntered, releaseTransaction
    const enteredTransaction = new Promise((done) => {
      transactionEntered = done
    })
    const releaseTransactionRead = new Promise((done) => {
      releaseTransaction = done
    })
    const transactionPath = `/api/studio/customers/${customer.id}/transactions/${ledgerBody.records[0].id}`
    const transactionRoute = async (route) => {
      const response = await route.fetch()
      transactionEntered()
      await timeout(releaseTransactionRead, 'held exact transaction read', 30_000)
      await route.fulfill({ response })
    }
    await page.route(`**${transactionPath}`, transactionRoute)
    try {
      await page.goto(transactionPageUrl)
      await timeout(enteredTransaction, 'exact transaction restore entry', 30_000)
      await close(dialog('储值流水详情'))
      const releasedTransaction = page.waitForResponse(
        (response) => new URL(response.url()).pathname === transactionPath
      )
      releaseTransaction()
      assert.equal((await releasedTransaction).status(), 200)
      await page.waitForTimeout(250)
      assert.ok(
        !pageLocation().searchParams.getAll('secondary').includes('customer-transaction-detail')
      )
      assert.equal(await dialog('储值流水详情').count(), 0)
      pass(
        'return during an exact readonly restoration prevents the late authorized response from reopening the canceled page'
      )
    } finally {
      releaseTransaction()
      await page.unroute(`**${transactionPath}`, transactionRoute)
    }
    stage = 'customer-account-close-after-canceled-child'
    await close(scope)
    pass(
      'stored-value account and single transaction display actual paged records, original actor/reason and full authoritative balance'
    )

    if (!customerOnly) {
      await enter('/personnel/employees', '员工管理')
      const employeeRow = rows(page).filter({ hasText: employee.name }).first()
      await employeeRow.getByRole('button', { name: '查看详情', exact: true }).click()
      await text(drawer(), employee.username)
      await drawer().getByRole('tab', { name: '权限明细', exact: true }).click()
      await text(drawer(), '编辑实际订单')
      await capture('desktop-employee-detail-permissions', drawer(), page, '编辑档案')
      await close(drawer())
      await employeeRow.getByRole('button', { name: '编辑档案', exact: true }).click()
      scope = dialog('编辑人员档案')
      await assertFields(scope, ['姓名 / 称呼', '登录账号', '角色', '重置密码（留空保持原密码）'])
      await capture('desktop-employee-editor', scope, page, '取消')
      await close(scope, '取消')
      await page.getByRole('button', { name: '新增员工账号', exact: true }).click()
      scope = dialog('新增人员账号')
      await assertFields(scope, ['姓名 / 称呼', '登录账号', '初始密码'])
      await capture('desktop-employee-create', scope, page, '取消')
      await close(scope, '取消')
      pass(
        'employee readonly permissions and original create/edit/password fields render and cancel without saving'
      )

      await enter(`/orders/list?id=${unpaid.id}`, '订单管理')
      await text(drawer(), 'SECONDARY-PRIVATE-ROOM')
      await text(drawer(), 'SECONDARY-INTERNAL-REMARK')
      await capture('desktop-order-detail', drawer(), page, '编辑订单')
      assertPageKey('order-detail', unpaid.id)
      const restoredOrder = page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/api/studio/orders/${unpaid.id}`
      )
      await page.reload()
      assert.equal((await restoredOrder).status(), 200)
      await text(drawer(), 'SECONDARY-PRIVATE-ROOM')
      pass(
        'order readonly page refresh performs current authorized HTTP read and restores public ID'
      )
      for (const [button, title, labels] of [
        [
          '编辑订单',
          '编辑实际订单',
          [
            '房间码',
            '客户游戏 ID',
            '内部备注（保留历史内容，不向打手公开）',
            '打手可见备注',
            '订单金额（元）',
            '原因 / 处理说明'
          ]
        ],
        ['调整派单', '重新派单', ['派单方式']],
        ['确认收款', '确认客户收款', ['收款方式', '客户实际收款金额（元）', '客户实际付款时间']]
      ]) {
        await drawer().getByRole('button', { name: button, exact: true }).click()
        scope = dialog(title)
        assertPageKey('order-detail', unpaid.id)
        assertPageKey(
          'order-action',
          `${button === '编辑订单' ? 'edit' : button === '调整派单' ? 'dispatch' : 'payment'}:${unpaid.id}`
        )
        await assertFields(scope, labels)
        await capture(`desktop-order-${button}`, scope, page, '返回')
        if (button === '编辑订单') {
          await page.goBack()
          await scope.waitFor({ state: 'hidden' })
          await page.locator('[data-page-key="order-detail"]:visible').waitFor()
          assert.ok(!pageLocation().searchParams.getAll('secondary').includes('order-action'))
        } else await close(scope, '返回')
      }
      await drawer()
        .getByRole('tab', { name: /操作记录/ })
        .click()
      await text(drawer(), '显示该订单及退款最近最多 200 条授权操作记录，按最新时间排序。')
      await close(drawer())
      await enter(`/orders/list?id=${completed.id}`, '订单管理')
      await drawer()
        .getByRole('tab', { name: /完成材料/ })
        .click()
      await text(drawer(), '审核人')
      assert.ok(await drawer().locator('img[alt="secondary-completion.png"]').count())
      await page.waitForFunction(() => {
        const image = document.querySelector('img[alt="secondary-completion.png"]')
        return image?.complete && image.naturalWidth > 0
      })
      await capture('desktop-order-completion-materials', drawer())
      await close(drawer())
      pass(
        'order detail and original edit/dispatch/payment dialogs expose real context, required fields and bounded audit history without mutation'
      )

      await enter(`/orders/list?id=${pendingReview.id}`, '订单管理')
      await drawer().getByRole('button', { name: '验收通过', exact: true }).click()
      const reviewConfirmation = page.locator('.el-message-box:visible')
      const reviewOrder = service
        .bootstrap('admin')
        .orders.find((row) => row.id === pendingReview.id)
      await text(reviewConfirmation, `${reviewOrder.orderNo} · ${reviewOrder.title}`)
      await text(reviewConfirmation, reviewOrder.submissionId)
      await text(reviewConfirmation, fmt(reviewOrder.reward))
      await text(reviewConfirmation, player.name)
      await capture('desktop-order-review-confirmation', reviewConfirmation, page, '继续核对')
      await close(reviewConfirmation, '继续核对')
      await close(drawer())
      pass(
        'original customer-reference deletion and review-pass confirmations show actual objects/material/reward and cancel without submitting'
      )

      await enter('/orders/create', '创建与派单')
      await text(page, '订单项目与客户资料')
      await text(page, '收款确认')
      await text(page, '派单安排')
      await page.getByText(/展示最新 8 笔/).waitFor()
      await capture('desktop-create-order', page.locator('body'))
      await field(page, '客户档案').getByRole('button', { name: '新增', exact: true }).click()
      scope = dialog('新增客户档案')
      await assertFields(scope, ['客户名称', '客户来源', '联系方式', '客户游戏 ID', '客户备注'])
      await capture('desktop-quick-customer', scope, page, '取消')
      await close(scope, '取消')
      pass(
        'create-order sections, limited pending-order preview and quick-customer original form remain visible and cancellable'
      )

      async function enterPlayer() {
        await enter('/personnel/players', '打手管理')
        const row = rows(page).filter({ hasText: player.name }).first()
        await row.getByRole('button', { name: '账户与历史', exact: true }).click()
        await text(drawer(), '累计已赚报酬')
        return row
      }
      await enterPlayer()
      const wallet = service.players('admin', { name: player.name }).records[0].wallet
      await text(drawer(), fmt(wallet.available))
      await rows(drawer())
        .filter({ hasText: 'SECONDARY-MANUAL-DEDUCTION' })
        .getByRole('button', { name: '查看明细', exact: true })
        .click()
      scope = dialog('报酬扣补记录详情')
      await text(scope, 'SECONDARY-MANUAL-DEDUCTION')
      await text(scope, '未登记处理结果')
      await capture('desktop-player-adjustment-detail', scope)
      await close(scope)
      for (const [button, title] of [
        ['补款', '打手报酬补款'],
        ['扣款', '打手报酬扣款'],
        ['登记差额处理', '登记待追回差额处理']
      ]) {
        await drawer().getByRole('button', { name: button, exact: true }).first().click()
        scope = dialog(title)
        await capture(`desktop-player-${button}`, scope, page, '取消')
        await close(scope, '取消')
      }
      await drawer().getByRole('tab', { name: '独立押金账户', exact: true }).click()
      const depositPage = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/studio/players/${player.id}/deposits` &&
          new URL(response.url()).searchParams.get('current') === '2'
      )
      await drawer().locator('.el-pagination').getByText('2', { exact: true }).click()
      const depositResponse = await depositPage
      assert.equal(depositResponse.status(), 200)
      const depositBody = await depositResponse.json()
      assert.equal(depositBody.total, 22)
      assert.equal(depositBody.records.length, 2)
      await rows(drawer())
        .filter({ hasText: depositBody.records[0].reason })
        .getByRole('button', { name: '查看明细', exact: true })
        .click()
      scope = dialog('押金流水详情')
      await text(scope, depositBody.records[0].reason)
      await text(scope, depositBody.records[0].createdByName)
      await capture('desktop-player-deposit-detail', scope)
      assertPageKey('player-detail', player.id)
      assertPageKey('player-deposit-detail', depositBody.records[0].id)
      const depositRestored = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/studio/players/${player.id}/deposits/${depositBody.records[0].id}`
      )
      await page.reload()
      assert.equal((await depositRestored).status(), 200)
      await text(dialog('押金流水详情'), depositBody.records[0].reason)
      pass(
        'deposit record refresh uses exact authorized getter for a record outside the initial page and restores deposit tab'
      )
      await close(scope)
      for (const [button, title] of [
        ['缴纳押金', '登记打手缴纳押金'],
        ['退店 / 跑路处理', '退店 / 跑路押金处理']
      ]) {
        await drawer().getByRole('button', { name: button, exact: true }).click()
        scope = dialog(title)
        await capture(`desktop-player-${button.replaceAll(' / ', '-')}`, scope, page, '取消')
        await close(scope, '取消')
      }
      await drawer().getByRole('tab', { name: '订单与接单历史', exact: true }).click()
      await text(drawer(), '24 笔关联订单')
      const historyPage = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/studio/players/${player.id}/orders` &&
          new URL(response.url()).searchParams.get('current') === '2'
      )
      await drawer().locator('.el-pagination').getByText('2', { exact: true }).click()
      assert.equal((await historyPage).status(), 200)
      await drawer().getByRole('button', { name: '接单记录', exact: true }).first().click()
      scope = dialog('实际接单与解除记录')
      await text(scope, '负责人接单记录')
      await scope.locator('.el-table__expand-icon').first().click()
      await text(scope, '单次接单详情')
      await capture('desktop-player-assignment-detail', scope)
      await close(scope)
      await close(drawer())
      const playerRow = rows(page).filter({ hasText: player.name }).first()
      await playerRow.getByRole('button', { name: '档案与权限', exact: true }).click()
      scope = dialog('编辑打手档案')
      await assertFields(scope, [
        '姓名 / 称呼',
        '登录账号',
        '打手等级',
        '同时接单上限',
        '允许登录',
        '允许接新订单',
        '允许申请新提现'
      ])
      await capture('desktop-player-profile-editor', scope, page, '取消')
      await close(scope, '取消')
      pass(
        'player wallet, independent deposit pagination, adjustment/deposit records, historical assignments and original account/fund forms render and cancel'
      )

      await enter('/personnel/attendance', '排班与考勤')
      const attendanceRow = rows(page).filter({ hasText: employee.name }).first()
      await attendanceRow.getByRole('button', { name: '查看详情', exact: true }).click()
      scope = dialog('考勤详情')
      await text(scope, 'SECONDARY-ATTENDANCE-REMARK')
      await text(scope, '7.50 小时')
      await capture('desktop-attendance-detail', scope)
      await close(scope)
      await attendanceRow.getByRole('button', { name: '编辑记录', exact: true }).click()
      scope = dialog('编辑考勤记录')
      await assertFields(scope, [
        '人员',
        '班次开始日期',
        '上班时间',
        '下班时间',
        '出勤状态',
        '实际工作时长（小时）',
        '备注'
      ])
      await capture('desktop-attendance-editor', scope, page, '取消')
      await close(scope, '取消')
      await page.locator('.schedule-person-select').click()
      await page.getByRole('option', { name: `${employee.name} · 客服`, exact: true }).click()
      await page.getByRole('button', { name: '设置上班时间', exact: true }).click()
      scope = dialog('设置个人上班时间')
      await text(scope, '班次设置记录')
      await text(scope, 'SECONDARY-SCHEDULE-REMARK')
      await assertFields(scope, ['生效日期', '固定班次', '上班时间', '下班时间', '备注'])
      await capture('desktop-work-schedule-editor-history', scope, page, '取消')
      await close(scope, '取消')
      pass(
        'real attendance and work-schedule versions display registered hours, remarks and original editable fields without fabricating attendance'
      )

      for (const width of [390, 768]) {
        await page.setViewportSize({ width, height: 960 })
        await enter('/personnel/customers', '老板管理')
        await rows(page)
          .filter({ hasText: customer.name })
          .first()
          .getByRole('button', { name: '查看详情', exact: true })
          .click()
        await capture(`layout-${width}-customer-detail`, drawer(), page, '储值账户')
        await close(drawer())
        await rows(page)
          .filter({ hasText: customer.name })
          .first()
          .getByRole('button', { name: '编辑与关联编号', exact: true })
          .click()
        await capture(`layout-${width}-customer-editor`, dialog('编辑客户档案'), page, '关闭')
        await close(dialog('编辑客户档案'), '关闭')
        await enter('/personnel/employees', '员工管理')
        await rows(page)
          .filter({ hasText: employee.name })
          .first()
          .getByRole('button', { name: '编辑档案', exact: true })
          .click()
        await capture(`layout-${width}-employee-editor`, dialog('编辑人员档案'), page, '取消')
        await close(dialog('编辑人员档案'), '取消')
        await enter(`/orders/list?id=${unpaid.id}`, '订单管理')
        await drawer().getByRole('button', { name: '编辑订单', exact: true }).click()
        await capture(`layout-${width}-order-editor`, dialog('编辑实际订单'), page, '返回')
        await close(dialog('编辑实际订单'), '返回')
        await capture(`layout-${width}-order-detail`, drawer(), page, '编辑订单')
        await close(drawer())
        await enterPlayer()
        await capture(`layout-${width}-player-wallet`, drawer(), page, '扣款')
        await drawer().getByRole('tab', { name: '独立押金账户', exact: true }).click()
        await capture(`layout-${width}-player-deposits`, drawer(), page, '缴纳押金')
        await close(drawer())
        await enter('/personnel/attendance', '排班与考勤')
        await rows(page)
          .filter({ hasText: employee.name })
          .first()
          .getByRole('button', { name: '编辑记录', exact: true })
          .click()
        await capture(`layout-${width}-attendance-editor`, dialog('编辑考勤记录'), page, '取消')
        await close(dialog('编辑考勤记录'), '取消')
        pass(
          `${width}px emulated secondary drawers/forms remain closable with visible controls and no whole-page horizontal overflow`
        )
      }
      assert.deepEqual(invariant(), businessBefore)
      assert.equal(
        report.requests.filter(
          (row) =>
            !['GET', 'HEAD'].includes(row.method) &&
            !['/api/studio/login', '/api/studio/logout'].includes(row.path)
        ).length,
        0
      )
      pass(
        'opening, inspecting, paginating and cancelling every tested form makes no business POST or changes to orders/funds/attendance'
      )

      const restrictedContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 }
      })
      restrictedContext.setDefaultTimeout(30_000)
      assert.equal(
        (
          await restrictedContext.request.post(api + '/api/studio/login', {
            data: { username: viewer.username, password }
          })
        ).status(),
        200
      )
      const restrictedPage = await restrictedContext.newPage()
      observe(restrictedPage)
      page = restrictedPage
      await enter('/personnel/players', '打手管理')
      await rows(page)
        .filter({ hasText: player.name })
        .first()
        .getByRole('button', { name: '账户与历史', exact: true })
        .click()
      await text(drawer(), 'SECONDARY-MANUAL-DEDUCTION')
      const revokeFunds = {
        ...viewer.permissionOverrides,
        'finance.refunds': false,
        'finance.withdrawals': false
      }
      mutate('/users', { ...viewer, permissionOverrides: revokeFunds })
      const reloaded = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/studio/bootstrap'
      )
      await drawer().locator('#art-table-header .button').first().click()
      assert.equal((await reloaded).status(), 200)
      await page.waitForFunction(
        () =>
          ![
            ...document.querySelectorAll(
              '.business-detail-page-panel .el-button,.el-drawer .el-button'
            )
          ].some(
            (node) => node.textContent.trim() === '扣款' && node.getBoundingClientRect().height
          )
      )
      assert.equal(await page.getByText('SECONDARY-MANUAL-DEDUCTION', { exact: true }).count(), 0)
      const deniedDeposit = await restrictedContext.request.get(
        api + `/api/studio/players/${player.id}/deposits?current=1&size=20`
      )
      assert.equal(deniedDeposit.status(), 403)
      const deniedAdjustment = await restrictedContext.request.post(
        api + '/api/studio/player-adjustments',
        {
          headers: { 'X-Studio-Actor': viewer.id },
          data: {
            userId: player.id,
            kind: 'supplement',
            amount: 1,
            reason: 'denied after revocation',
            requestId: randomUUID()
          }
        }
      )
      assert.equal(deniedAdjustment.status(), 403)
      report.denied.push(
        { path: 'player deposits', status: 403 },
        { path: 'player adjustment write', status: 403 }
      )
      await capture('revoked-funds-after-bootstrap-refresh', page.locator('body'))
      pass(
        'actual bootstrap refresh removes revoked private wallet content and financial write controls; independent HTTP reads/writes return 403'
      )

      await enter(`/orders/list?id=${unpaid.id}`, '订单管理')
      await text(drawer(), 'SECONDARY-PRIVATE-ROOM')
      const revokedAll = {
        ...revokeFunds,
        'orders.view': false,
        'orders.create': false,
        'orders.edit': false,
        'finance.review': false,
        'users.manage': false,
        'attendance.manage': false,
        'logs.view': false
      }
      mutate('/users', { ...viewer, permissionOverrides: revokedAll })
      const deniedOrderRead = page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/api/studio/orders/${unpaid.id}`
      )
      await drawer().getByRole('button', { name: '刷新订单并重新确认操作', exact: true }).click()
      assert.equal((await deniedOrderRead).status(), 403)
      await page.getByText('订单不存在或当前账号无权查看', { exact: true }).waitFor()
      assert.equal(await page.getByText('SECONDARY-PRIVATE-ROOM', { exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '编辑订单', exact: true }).count(), 0)
      const deniedOrderWrite = await restrictedContext.request.post(
        api + `/api/studio/orders/${unpaid.id}/action`,
        {
          headers: { 'X-Studio-Actor': viewer.id },
          data: {
            action: 'edit',
            requestId: randomUUID(),
            expectedRevision: unpaid.revision,
            roomCode: 'DENIED',
            reason: 'denied after revocation'
          }
        }
      )
      assert.equal(deniedOrderWrite.status(), 403)
      const deniedStaffWrite = await restrictedContext.request.post(api + '/api/studio/users', {
        headers: { 'X-Studio-Actor': viewer.id },
        data: {
          id: employee.id,
          name: 'DENIED',
          username: employee.username,
          role: employee.role,
          status: 'active',
          maxActiveOrders: 1,
          permissionOverrides: {}
        }
      })
      assert.equal(deniedStaffWrite.status(), 403)
      report.denied.push(
        { path: 'order protected reread', status: 403 },
        { path: 'order edit write', status: 403 },
        { path: 'staff write', status: 403 }
      )
      await capture('revoked-order-private-details-cleared', drawer())
      const permissionsReloaded = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/studio/bootstrap'
      )
      await page.reload()
      assert.equal((await permissionsReloaded).status(), 200)
      await quiet()
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('.el-button')].some(
            (node) =>
              ['新增员工账号', '编辑档案', '编辑订单', '新增排班 / 考勤'].includes(
                node.textContent.trim()
              ) && node.getBoundingClientRect().height
          )
      )
      assert.deepEqual(invariant(), businessBefore)
      pass(
        'protected order reread clears private details and edit action after 403; revoked order/staff writes are refused without business changes'
      )
    }
  }

  if (navigationOnly) {
    await enter(`/orders/list?id=${unpaid.id}`, '订单管理')
    const orderPage = page.locator('[data-page-key="order-detail"]:visible')
    await text(orderPage, 'SECONDARY-PRIVATE-ROOM')
    assertPageKey('order-detail', unpaid.id)
    assert.equal(pageLocation().searchParams.has('id'), false)
    const legacyUrl = (id) => page.url().split('#')[0] + `#/orders/list?id=${id}`
    async function waitCanonical(id, action = false) {
      await page.waitForFunction(
        ({ id, action }) => {
          const query = new URL(location.hash.slice(1), location.origin).searchParams
          const keys = query.getAll('secondary'),
            records = query.getAll('secondaryRecord')
          const position = keys.lastIndexOf('order-detail')
          return (
            !query.has('id') &&
            position >= 0 &&
            records[position] === id &&
            (!action || keys.includes('order-action'))
          )
        },
        { id, action }
      )
    }
    await page.goto(legacyUrl(unpaid.id))
    await waitCanonical(unpaid.id)
    await text(orderPage, 'SECONDARY-PRIVATE-ROOM')
    pass(
      'initial and repeated same-ID legacy links retain canonical authorized order page without closing it'
    )
    let legacyRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/studio/orders/${active.id}`
    )
    await page.goto(legacyUrl(active.id))
    assert.equal((await legacyRead).status(), 200)
    await waitCanonical(active.id)
    await text(
      orderPage,
      service.bootstrap('admin').orders.find((row) => row.id === active.id).orderNo
    )
    legacyRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/studio/orders/${unpaid.id}`
    )
    await page.goto(legacyUrl(unpaid.id))
    assert.equal((await legacyRead).status(), 200)
    await waitCanonical(unpaid.id)
    await text(orderPage, 'SECONDARY-PRIVATE-ROOM')
    pass('legacy links to a different ID reopen through the normal protected current-order GET')

    await orderPage.getByRole('button', { name: '编辑订单', exact: true }).click()
    const editPage = page.locator('[data-page-key="order-action"]:visible')
    await field(editPage, '原因 / 处理说明').locator('textarea').fill('NAVIGATION-CONTROLLED-LOSS')
    const actionPath = `/api/studio/orders/${unpaid.id}/action`
    let enterAction, abortAction, capturedBody
    const enteredAction = new Promise((done) => {
      enterAction = done
    })
    const abortActionGate = new Promise((done) => {
      abortAction = done
    })
    const controlledAction = async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const request = route.request()
      controlledRequests.add(request)
      controlledUrls.add(request.url())
      capturedBody = request.postDataJSON()
      report.controlledTransport.push({
        event: 'held-browser-post-not-forwarded',
        path: actionPath,
        requestId: capturedBody.requestId,
        bodyHash: createHash('sha256').update(JSON.stringify(capturedBody)).digest('hex')
      })
      enterAction()
      await timeout(abortActionGate, 'controlled action transport', 45_000)
      await route.abort('aborted')
    }
    await page.route(`**${actionPath}`, controlledAction)
    try {
      await editPage.getByRole('button', { name: '确认保存', exact: true }).click()
      await timeout(enteredAction, 'real saving action request entry', 30_000)
      assert.ok(await editPage.getByRole('button', { name: '返回', exact: true }).isDisabled())
      await page.goBack()
      await page
        .locator('.el-message:visible')
        .filter({ hasText: /正在.*稍后/ })
        .first()
        .waitFor()
      await waitCanonical(unpaid.id, true)
      await quiet()
      await page.evaluate(() => {
        location.hash = '/system/role'
      })
      await page
        .locator('.el-message:visible')
        .filter({ hasText: /正在.*稍后/ })
        .first()
        .waitFor()
      await waitCanonical(unpaid.id, true)
      await quiet()
      assert.equal(
        await field(editPage, '原因 / 处理说明').locator('textarea').inputValue(),
        'NAVIGATION-CONTROLLED-LOSS'
      )
      await page.goto(legacyUrl(active.id))
      await page
        .locator('.el-message:visible')
        .filter({ hasText: /正在.*稍后/ })
        .first()
        .waitFor()
      await waitCanonical(unpaid.id, true)
      await quiet()
      pass(
        'real UI saving state rejects browser Back, a different legacy order ID and leaving the module while a browser POST is held before server delivery'
      )
    } finally {
      abortAction()
    }
    await editPage.getByRole('button', { name: '刷新订单并重新确认操作', exact: true }).waitFor()
    await page.unroute(`**${actionPath}`, controlledAction)
    async function originalIntentSnapshot() {
      return page.evaluate(
        ({ path, submitted }) => {
          let owner
          for (const node of document.querySelectorAll('[data-page-key="order-action"] *')) {
            let component = node.__vueParentComponent
            while (component) {
              if (
                component.type.__file
                  ?.replaceAll('\\', '/')
                  .endsWith('/orders/modules/order-detail.vue')
              ) {
                owner = component
                break
              }
              component = component.parent
            }
            if (owner) break
          }
          if (!owner?.setupState.actionIntent)
            throw new Error('original order intent unavailable for isolated navigation evidence')
          const unsigned = { ...submitted }
          delete unsigned.requestId
          delete unsigned.expectedActorId
          const original = owner.setupState.actionIntent.prepare(path, unsigned)
          return { uncertain: owner.setupState.actionIntent.uncertain, body: original }
        },
        { path: actionPath.replace(/^\/api\/studio/, ''), submitted: capturedBody }
      )
    }
    assert.deepEqual((await originalIntentSnapshot()).body, capturedBody)
    assert.equal((await originalIntentSnapshot()).uncertain, true)
    await editPage.getByRole('button', { name: '返回', exact: true }).click()
    await page
      .locator('.el-message:visible')
      .filter({ hasText: '上一次提交结果尚未确认' })
      .first()
      .waitFor()
    assert.ok(await editPage.isVisible())
    await quiet()
    await page.goto(legacyUrl(active.id))
    await page
      .locator('.el-message:visible')
      .filter({ hasText: '上一次提交结果尚未确认' })
      .first()
      .waitFor()
    await waitCanonical(unpaid.id, true)
    await quiet()
    const unchangedIntent = await originalIntentSnapshot()
    assert.equal(unchangedIntent.uncertain, true)
    assert.deepEqual(unchangedIntent.body, capturedBody)
    assert.equal(
      await field(editPage, '原因 / 处理说明').locator('textarea').inputValue(),
      'NAVIGATION-CONTROLLED-LOSS'
    )
    pass(
      'controlled response loss creates the original uncertain intent; footer return and a different legacy ID cannot discard its complete body or requestId'
    )
    const readsOnlyBefore = report.browserPostAttempts.length
    const reread = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/studio/orders/${unpaid.id}` &&
        response.request().method() === 'GET'
    )
    await editPage.getByRole('button', { name: '刷新订单并重新确认操作', exact: true }).click()
    assert.equal((await reread).status(), 200)
    await editPage.waitFor({ state: 'hidden' })
    await waitCanonical(unpaid.id)
    assert.equal(report.browserPostAttempts.length, readsOnlyBefore)
    assert.equal(
      report.serverBusinessPosts.filter((request) => request.path === actionPath).length,
      0
    )
    assert.deepEqual(invariant(), businessBefore)
    report.navigationTransportBoundary = {
      browserPostAttempts: 1,
      forwardedServerActionPosts: 0,
      actualDatabaseUnchanged: true,
      source: 'real UI submit; controlled browser transport held then aborted',
      recovery: 'existing admin current-order refresh/reconfirm, not player operation-results'
    }
    pass(
      'existing admin refresh/reconfirm is available on the uncertain action page and sends only GET; held POST never reaches server or changes business data'
    )
    await orderPage.getByRole('button', { name: '返回上一页', exact: true }).click()
    await page.waitForFunction(() => {
      const query = new URL(location.hash.slice(1), location.origin).searchParams
      return !query.has('id') && !query.getAll('secondary').includes('order-detail')
    })
    await orderPage.waitFor({ state: 'hidden' })
    await capture('order-return-list', page.locator('body'))
    pass(
      'order page return removes only legacy/public route IDs after close completes and returns to same list'
    )
    const currentOrder = service.bootstrap('admin').orders.find((row) => row.id === unpaid.id)
    await rows(page)
      .filter({ hasText: currentOrder.orderNo })
      .first()
      .getByRole('button', { name: currentOrder.title, exact: true })
      .click()
    await text(orderPage, 'SECONDARY-PRIVATE-ROOM')
    await page.evaluate(() => {
      location.hash = '/system/role'
    })
    await page.waitForFunction(() => location.hash === '#/system/role')
    await orderPage.waitFor({ state: 'hidden' })
    await page.getByRole('heading', { name: '角色与权限', exact: true }).waitFor()
    await quiet()
    await capture('order-cross-path-role', page.locator('body'))
    assert.equal(await page.getByText('SECONDARY-PRIVATE-ROOM', { exact: true }).count(), 0)
    assert.deepEqual(invariant(), businessBefore)
    pass(
      'leaving an order page for another module retains destination and does not race old ID cleanup'
    )
  }

  if (!navigationOnly && !customerOnly) {
    // Real server revocation, with cached authorization deliberately retained until
    // a protected response or the app's normal bootstrap refresh observes it.
    const privacyProblems = []
    async function privacyActor(suffix) {
      const actor = staff(`secondary-privacy-${suffix}`, `隐私核对${suffix}`, 'admin', {
        'users.manage': true,
        'orders.view': true,
        'orders.create': true,
        'finance.refunds': true
      })
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      context.setDefaultTimeout(30_000)
      assert.equal(
        (
          await context.request.post(api + '/api/studio/login', {
            data: { username: actor.username, password }
          })
        ).status(),
        200
      )
      page = await context.newPage()
      observe(page)
      return { actor, context }
    }
    for (const method of ['bootstrap', 'post403']) {
      const { actor, context } = await privacyActor(method)
      await enter('/personnel/employees', '员工管理')
      await rows(page)
        .filter({ hasText: employee.name })
        .first()
        .getByRole('button', { name: '编辑档案', exact: true })
        .click()
      const editor = dialog('编辑人员档案')
      await editor.waitFor()
      assert.equal(await field(editor, '登录账号').locator('input').inputValue(), employee.username)
      mutate('/users', {
        ...actor,
        permissionOverrides: { ...actor.permissionOverrides, 'users.manage': false }
      })
      if (method === 'bootstrap') {
        const refreshed = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/studio/bootstrap'
        )
        await page.evaluate(async () => {
          const { useStudioStore } = await import('/src/store/modules/studio.ts')
          await useStudioStore().refresh()
        })
        assert.equal((await refreshed).status(), 200)
      } else {
        const denied = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/studio/users' &&
            response.request().method() === 'POST'
        )
        await editor.getByRole('button', { name: '保存档案', exact: true }).click()
        assert.equal((await denied).status(), 403)
      }
      await quiet()
      await editor
        .locator('form')
        .waitFor({ state: 'hidden', timeout: 5_000 })
        .catch(() => {})
      const privateEditorVisible = await editor.locator('form').isVisible()
      const panelVisible = await editor.isVisible()
      const privateInputs = await page
        .locator('input:visible')
        .evaluateAll(
          (nodes, username) => nodes.filter((node) => node.value === username).length,
          employee.username
        )
      report.privacyChecks.push({ method, privateEditorVisible, panelVisible, privateInputs })
      await capture(`privacy-user-${method}`, page.locator('body'))
      if (privateEditorVisible || privateInputs)
        privacyProblems.push(`${method}: revoked staff editor remains visible`)
      await context.close()
    }
    const { actor: balanceActor, context: balanceContext } = await privacyActor('ledger403')
    await enter('/personnel/customers', '老板管理')
    const balanceLoaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/studio/customers/${customer.id}/transactions`
    )
    await rows(page)
      .filter({ hasText: customer.name })
      .first()
      .getByRole('button', { name: '储值账户', exact: true })
      .click()
    assert.equal((await balanceLoaded).status(), 200)
    const balanceEditor = dialog(`${customer.name} · 储值账户`)
    const oldReason = await rows(balanceEditor).first().locator('td').nth(4).innerText()
    await rows(balanceEditor).first().getByRole('button', { name: '查看明细', exact: true }).click()
    await dialog('储值流水详情').waitFor()
    await close(dialog('储值流水详情'))
    mutate('/users', {
      ...balanceActor,
      permissionOverrides: { ...balanceActor.permissionOverrides, 'finance.refunds': false }
    })
    const ledgerDenied = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/studio/customers/${customer.id}/transactions`
    )
    await balanceEditor.getByRole('button', { name: '刷新账户', exact: true }).click()
    assert.equal((await ledgerDenied).status(), 403)
    await quiet()
    const oldRows = await rows(balanceEditor).count()
    const detailButtons = await balanceEditor
      .getByRole('button', { name: '查看明细', exact: true })
      .count()
    const writeButtons = await balanceEditor
      .getByRole('button', { name: '确认登记', exact: true })
      .count()
    await text(balanceEditor, '待读取')
    report.privacyChecks.push({
      method: 'ledger403',
      oldRows,
      detailButtons,
      writeButtons,
      oldReason
    })
    await capture('privacy-customer-ledger403', balanceEditor)
    if (oldRows || detailButtons || writeButtons)
      privacyProblems.push('ledger403: revoked private ledger or write controls remain visible')
    await balanceContext.close()
    assert.deepEqual(invariant(), businessBefore)
    assert.deepEqual(privacyProblems, [])
    pass(
      'staff bootstrap/POST403 and customer ledger403 revoke cached private details and writing controls without business changes'
    )
  }

  if (customerOnly)
    report.routerDiagnostics = await page.evaluate(() => window.__secondaryRouterTrace || [])
  if (customerOnly) {
    assert.deepEqual(invariant(), businessBefore)
    assert.equal(
      report.requests.filter(
        (row) =>
          !['GET', 'HEAD'].includes(row.method) &&
          !['/api/studio/login', '/api/studio/logout'].includes(row.path)
      ).length,
      0
    )
    pass(
      'targeted customer navigation/recovery check preserves original orders/funds/attendance and sends no business mutation'
    )
  }
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.consoleErrors, [])
  assert.deepEqual(report.serverErrors, [])
  assert.deepEqual(report.requestFailures, [])
  report.passed = true
} catch (error) {
  report.error = error.message
  report.stack = error.stack
  report.failedStage = stage
  process.exitCode = 1
  if (page) {
    try {
      report.failedUrl = page.url()
      if (customerOnly)
        report.routerDiagnostics = await page.evaluate(() => window.__secondaryRouterTrace || [])
      report.visibleTextAtFailure = (await page.locator('body').innerText()).slice(-12_000)
      await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
    } catch (captureError) {
      report.captureError = captureError.message
    }
  }
} finally {
  for (const [name, cleanup] of [
    [
      'browser',
      async () => {
        if (browser) await browser.close()
      }
    ],
    [
      'vite',
      async () => {
        if (vite) await vite.close()
      }
    ],
    [
      'isolated API',
      async () => {
        if (server?.listening) {
          server.closeIdleConnections?.()
          await new Promise((done) => {
            const timer = setTimeout(() => server.closeAllConnections?.(), 10_000)
            server.close(() => {
              clearTimeout(timer)
              done()
            })
          })
        } else service?.close()
      }
    ]
  ]) {
    try {
      await timeout(cleanup(), `${name} cleanup`, 30_000)
    } catch (error) {
      report.cleanupErrors ||= []
      report.cleanupErrors.push({ name, message: error.message })
      report.passed = false
      process.exitCode = 1
    }
  }
  report.finishedAt = new Date().toISOString()
  report.sourceAfter = sourceFingerprint()
  report.sourceUnchanged = before.digest === report.sourceAfter.digest
  if (!report.sourceUnchanged) {
    report.passed = false
    report.sourceChangeError = 'Source changed while secondary UI verification was running'
    process.exitCode = 1
  }
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      passed: report.passed,
      cases: report.cases.length,
      layouts: report.layouts.length,
      sourceUnchanged: report.sourceUnchanged,
      output,
      error: report.error
    })
  )
}
