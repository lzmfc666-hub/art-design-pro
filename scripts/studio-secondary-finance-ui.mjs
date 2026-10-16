import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createPortProbe } from 'node:net'
import { join, resolve } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { createStudioServer } from '../server/index.mjs'
import { testMutate } from '../tests/helpers/current-intent.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'

// This script owns every process/database it starts. It never uses the existing
// development ports, live database, environment password or external push service.
const output = resolve('.qa/secondary-details-20261014/finance', `run-${randomUUID()}`)
const navigationSmoke = process.argv.includes('--withdrawal-navigation-smoke')
const salaryOnly = process.argv.includes('--salary-only')
const contentNavigationOnly = process.argv.includes('--content-navigation-only')
mkdirSync(output, { recursive: true })
process.env.STUDIO_QA_DECLARATIONS_DIR = join(output, 'generated-types')
const before = sourceFingerprint()
const password = `isolated-secondary-finance-${randomUUID()}`
const clock = () => new Date('2026-10-14T05:00:00Z')
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
let server, service, vite, browser, page
let delayedRestoreRead, releaseDelayedRestoreRead, delayedRestoreReadTimer
const report = {
  passed: false,
  scope: contentNavigationOnly
    ? 'content-navigation-only'
    : salaryOnly
      ? 'salary-only'
      : navigationSmoke
        ? 'withdrawal-navigation-smoke'
        : 'full-finance-secondary-ui',
  cases: [],
  pageErrors: [],
  serverErrors: [],
  deniedWrites: [],
  blockedExternal: [],
  requests: [],
  layouts: [],
  output,
  database: join(output, 'test.sqlite'),
  sourceBefore: before,
  isolation: {
    maintenanceFromEnv: false,
    scheduledBackups: false,
    uploadCleanup: false,
    push: 'local fake sender, no configured subscription service',
    declarations: process.env.STUDIO_QA_DECLARATIONS_DIR
  },
  limitations: [
    'Checks rendering and cancellation of existing forms only; the separate joint UI suite verifies business submission chains.',
    'Pagination here uses already-authorized snapshots or the existing report preview limit; no capacity result is inferred.',
    'No physical handset, external push service or production database is used.'
  ]
}
const pass = (name) => {
  report.cases.push(name)
  console.log(`PASS ${name}`)
}
const digest = (value) => createHash('sha256').update(value).digest('hex')
async function freePort() {
  const probe = createPortProbe()
  await new Promise((done, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', done)
  })
  const port = probe.address().port
  await new Promise((done, reject) => probe.close((error) => (error ? reject(error) : done())))
  assert.ok(![3006, 3007, 3008].includes(port))
  return port
}
function fixture() {
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const upload = (actor, name) => service.upload(actor, { name, mime: 'image/png', data: png })
  const level = mutate('/levels', { name: '二级详情隔离等级', delaySeconds: 0 })
  const players = ['待审', '待发', '已发', '差额'].map((name, index) =>
    mutate('/users', {
      username: `secondary-player-${index}`,
      name: `二级详情${name}打手`,
      role: 'player',
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 3,
      permissionOverrides: {},
      password
    })
  )
  const platform = mutate('/platforms', {
    name: '二级详情测试来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const shop = mutate('/shops', { name: '二级详情测试店铺', platformId: platform.id })
  const customer = mutate('/customers', {
    name: '二级详情隔离客户',
    gameId: 'QA-SECONDARY',
    contact: 'QA fictional contact'
  })
  const template = mutate('/templates', {
    name: '二级详情订单项目',
    game: '三角洲行动',
    description: '仅用于隔离展示核对',
    amount: 10000,
    reward: 6500,
    map: '不限',
    remark: 'QA default player remark',
    active: true
  })
  const orders = Array.from({ length: 25 }, () =>
    mutate('/orders', {
      templateId: template.id,
      customerId: customer.id,
      platformId: platform.id,
      shopId: shop.id,
      roomCode: 'QA-SECONDARY-ROOM',
      amount: 10000,
      reward: 6500,
      receivedAmount: 10000,
      paidAt: clock().toISOString(),
      dispatchMode: 'pool'
    })
  )
  const receipt = upload('admin', '隔离财务凭证.png')
  for (const player of players) {
    mutate('/player-adjustments', {
      userId: player.id,
      kind: 'supplement',
      amount: 50000,
      reason: '隔离夹具钱包金额',
      orderId: null
    })
    const qrCode = upload(player.id, `隔离${player.name}收款码.png`)
    mutate('/player/payment-methods', { method: 'wechat', qrCode }, player.id)
  }
  const withdrawals = players.slice(0, 3).map((player, index) =>
    mutate(
      '/player/withdrawals',
      {
        amount: (index + 1) * 1100,
        paymentMethod: 'wechat'
      },
      player.id
    )
  )
  for (const withdrawal of withdrawals.slice(1))
    mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  mutate(`/withdrawals/${withdrawals[2].id}/action`, { action: 'pay', receipt })
  const adjustment = mutate('/player-adjustments', {
    userId: players[3].id,
    kind: 'deduction',
    amount: 51000,
    orderId: orders[1].id,
    reason: '隔离差额核对依据'
  })
  const refund = mutate('/refunds', {
    orderId: orders[0].id,
    amount: 500,
    reason: '隔离已实际退款'
  })
  const expenses = Array.from({ length: 23 }, (_, index) =>
    mutate('/expenses', {
      category: `QA费用类别${String(index + 1).padStart(2, '0')}`,
      amount: 1200 + index,
      date: '2026-10-14',
      purpose: `隔离支出用途${index + 1}`,
      receipt
    })
  )
  const staff = Array.from({ length: 23 }, (_, index) =>
    mutate('/users', {
      username: `secondary-salary-${index}`,
      name: `工资隔离员工${String(index + 1).padStart(2, '0')}`,
      role: 'support',
      status: 'active',
      maxActiveOrders: 1,
      permissionOverrides: {},
      password
    })
  )
  const plans = staff.map((employee, index) =>
    mutate('/salary-plans', {
      userId: employee.id,
      mode: 'fixed',
      base: 10000 + index * 100,
      rate: 0,
      platformRates: {},
      effectiveFrom: '2026-10-01',
      hourlyEnabled: false
    })
  )
  const payroll = mutate('/payrolls', { month: '2026-10' })
  const pendingRefund = mutate(
    '/refunds',
    { orderId: orders[2].id, amount: 600, reason: '隔离待审退款' },
    staff[0].id
  )
  mutate(`/expenses/${expenses[1].id}/action`, { action: 'delete' })
  let announcement = mutate('/player-content', {
    type: 'announcement',
    title: '二级详情版本公告',
    text: '发布版滚动文字',
    body: '发布版详情正文',
    imageId: null,
    sortOrder: 1,
    startAt: null,
    endAt: null
  })
  announcement = mutate(`/player-content/${announcement.id}/publish`, {
    revision: announcement.revision
  })
  announcement = mutate('/player-content', {
    id: announcement.id,
    revision: announcement.revision,
    type: 'announcement',
    title: announcement.title,
    text: '尚未发布的草稿文字',
    body: '尚未发布的草稿详情',
    imageId: null,
    sortOrder: 1,
    startAt: null,
    endAt: null
  })
  const bannerImage = upload('admin', '隔离内容轮播.png')
  const banner = mutate('/player-content', {
    type: 'banner',
    title: '二级详情轮播草稿',
    text: '',
    body: '隔离轮播正文',
    imageId: bannerImage.id,
    sortOrder: 2,
    startAt: null,
    endAt: null
  })
  // A durable legacy-only record cannot be produced through a new modern flow.
  // This explicit fixture exercises its existing read/form UI, not funding rules.
  const state = JSON.parse(
    service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  )
  const legacy = {
    id: randomUUID(),
    orderId: orders[1].id,
    expectedReward: 6500,
    reason: '隔离历史报酬人工核对',
    createdAt: clock().toISOString(),
    actorId: 'admin'
  }
  state.rewardReviews.push(legacy)
  // A stored commission difference permits opening the original supplementary
  // payroll confirmation without executing another frontend/business chain.
  state.commissionAdjustments.push({
    id: randomUUID(),
    userId: staff[0].id,
    orderId: orders[1].id,
    sourceId: randomUUID(),
    kind: 'support',
    amount: 550,
    month: '2026-10',
    reason: '隔离工资差额展示夹具',
    payrollId: null
  })
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  const salaryReport = service.bootstrap('admin', '2026-10').reports
  const pendingSalary = salaryReport.payroll.slice(payroll.lines.length)
  assert.equal(salaryReport.month, '2026-10')
  assert.equal(pendingSalary.length, 1)
  assert.equal(pendingSalary[0].userId, staff[0].id)
  assert.equal(pendingSalary[0].total, -550)
  assert.equal(pendingSalary[0].incomplete, false)
  report.salaryFixture = {
    month: salaryReport.month,
    originalPaidLines: payroll.lines.length,
    pendingLines: pendingSalary.length,
    pendingTotal: pendingSalary[0].total,
    incomplete: pendingSalary[0].incomplete
  }
  report.fixture = {
    orders: orders.length,
    players: players.length,
    expenses: expenses.length,
    salaryStaff: staff.length,
    payrollLines: payroll.lines.length,
    legacyInjection:
      'one legacy reward-review and one stored commission-difference display record in the isolated database only'
  }
  assert.equal(payroll.lines.length, 23)
  assert.equal(adjustment.manualAmount, 1000)
  return {
    players,
    platform,
    shop,
    template,
    orders,
    withdrawals,
    adjustment,
    refund,
    expenses,
    plans,
    payroll,
    announcement,
    banner,
    legacy,
    pendingRefund
  }
}

try {
  server = createStudioServer({
    dbPath: report.database,
    seed: false,
    password,
    clock,
    maintenanceFromEnv: false,
    trustedProxies: [],
    auditHotMaxRows: 10,
    auditRetentionDays: 90,
    backups: { intervalMinutes: 0, directory: join(output, 'backups'), failureWebhook: '' },
    uploadCleanup: { enabled: false },
    notificationIntervalMs: 86_400_000,
    notifications: {
      clock,
      publicKey: '',
      privateKey: '',
      subject: '',
      allowedPushHosts: [],
      pushSender: async () => {
        report.fakePushCalls = (report.fakePushCalls || 0) + 1
        return { statusCode: 202 }
      }
    }
  })
  service = server.service
  const data = fixture()
  const requestListeners = server.listeners('request')
  server.removeAllListeners('request')
  server.on('request', (request, response) => {
    const handle = () => {
      for (const listener of requestListeners) listener.call(server, request, response)
    }
    const gate = delayedRestoreRead
    if (
      gate &&
      request.method === 'GET' &&
      new URL(request.url, 'http://127.0.0.1').pathname === '/api/studio/player-content'
    ) {
      delayedRestoreRead = null
      gate.arrived()
      void gate.released.then(handle)
    } else handle()
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const api = `http://127.0.0.1:${server.address().port}`
  assert.ok(![3006, 3007, 3008].includes(server.address().port))
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } })
  const login = await context.request.post(api + '/api/studio/login', {
    data: { username: 'admin', password }
  })
  assert.equal(login.status(), 200)
  // Login intentionally records its audit/data version. Compare read-only UI
  // work against the post-login fixture instead of reporting it as a UI write.
  const businessBefore = service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  report.businessStateBefore = digest(businessBefore)
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') {
      report.blockedExternal.push({ host: url.hostname, path: url.pathname })
      return route.abort('blockedbyclient')
    }
    if (
      url.pathname.startsWith('/api/studio/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
      !(request.method() === 'POST' && url.pathname === '/api/studio/exports/preview')
    ) {
      report.deniedWrites.push({ method: request.method(), path: url.pathname })
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.setDefaultNavigationTimeout(30_000)
  page.on('pageerror', (error) => report.pageErrors.push(error.message))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/studio/'))
      report.requests.push({ method: request.method(), path: new URL(request.url()).pathname })
  })
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/studio/') && response.status() >= 500)
      report.serverErrors.push({
        path: new URL(response.url()).pathname,
        status: response.status()
      })
  })
  const dialog = () =>
    page
      .locator('.business-detail-page-panel:visible, .el-dialog:visible, .el-drawer:visible')
      .last()
  const secondaryStack = () =>
    new URLSearchParams(new URL(page.url()).hash.split('?')[1] || '').getAll('secondary')
  const clickTab = async (scope, name) => {
    const tab = scope.getByRole('tab', { name, exact: true })
    await tab.waitFor({ state: 'attached' })
    const wrap = tab.locator('xpath=ancestor::div[contains(@class,"el-tabs__nav-wrap")][1]')
    const settleNav = () =>
      wrap.evaluate(async (element) => {
        await new Promise((done) => requestAnimationFrame(done))
        const animations = element.querySelector('.el-tabs__nav')?.getAnimations() || []
        await Promise.all(animations.map((animation) => animation.finished.catch(() => {})))
      })
    await settleNav()
    for (let attempt = 0; attempt < 10; attempt++) {
      const clipped = await tab.evaluate((element) => {
        const scroll = element.closest('.el-tabs__nav-scroll')
        if (!scroll) return ''
        const target = element.getBoundingClientRect()
        const visible = scroll.getBoundingClientRect()
        return target.left < visible.left - 1
          ? 'prev'
          : target.right > visible.right + 1
            ? 'next'
            : ''
      })
      if (!clipped) {
        await tab.click()
        return
      }
      const arrow = wrap.locator(`.el-tabs__nav-${clipped}:visible:not(.is-disabled)`)
      assert.equal(
        await arrow.count(),
        1,
        `${String(name)} clipped without an available original ${clipped} tab arrow`
      )
      await arrow.click()
      report.tabNavigation ||= []
      report.tabNavigation.push({ name: String(name), originalArrow: clipped })
      await settleNav()
    }
    throw new Error(`Original tab arrows did not expose ${String(name)}`)
  }
  const navigate = async (path, heading) => {
    await page.goto(base + '/#' + path)
    if (heading) await page.getByRole('heading', { name: heading, exact: true }).waitFor()
  }
  const openRow = async (text, button = '查看详情') => {
    await page
      .locator('.el-table__body tr')
      .filter({ hasText: text })
      .getByRole('button', { name: button, exact: true })
      .first()
      .click()
  }
  const checkDialog = async (title, texts = []) => {
    const scope = dialog()
    await scope.waitFor()
    assert.equal(
      (
        await scope
          .locator('.business-detail-panel-heading, .el-dialog__title, .el-drawer__title')
          .first()
          .innerText()
      ).trim(),
      title
    )
    assert.ok((await scope.locator('.business-detail-header').count()) > 0)
    for (const text of texts) await scope.getByText(text, { exact: false }).first().waitFor()
    return scope
  }
  const closeDialog = async (cancel = false) => {
    const scope = dialog()
    const key = await scope.getAttribute('data-page-key')
    report.lastNavigationAttempt = {
      action: cancel ? 'form-cancel' : key ? 'return-header' : 'dialog-close',
      pageKey: key,
      beforeUrl: page.url()
    }
    if (cancel) await scope.getByRole('button', { name: '取消', exact: true }).click()
    else if (key) await scope.getByRole('button', { name: '返回上一页', exact: true }).click()
    else await scope.locator('.el-dialog__headerbtn').click()
    if (key) await page.locator(`[data-page-key="${key}"]`).waitFor({ state: 'hidden' })
    else await scope.waitFor({ state: 'hidden' })
    report.lastNavigationAttempt.afterUrl = page.url()
  }
  const checkConfirmation = async (title, texts = []) => {
    const scope = page.locator('.el-message-box:visible').last()
    await scope.waitFor()
    assert.equal((await scope.locator('.el-message-box__title').innerText()).trim(), title)
    assert.ok((await scope.locator('.business-confirm-facts').count()) > 0)
    for (const text of texts) await scope.getByText(text, { exact: false }).first().waitFor()
    return scope
  }
  const cancelConfirmation = async (label = '取消') => {
    const scope = page.locator('.el-message-box:visible').last()
    await scope.getByRole('button', { name: label, exact: true }).click()
    await scope.waitFor({ state: 'hidden' })
  }
  const screenshot = async (name, scope = dialog()) => {
    await page.screenshot({ path: join(output, name + '-viewport.png') })
    if (await scope.count()) await scope.screenshot({ path: join(output, name + '-detail.png') })
  }
  const withdrawalDetail = async () => {
    await navigate('/finance/settlement?tab=withdrawals', '财务结算')
    await openRow(data.players[2].name)
    const scope = await checkDialog('提现记录详情', [
      '申请时收款资料',
      '处理记录与发放凭证',
      '¥33.00'
    ])
    await scope.locator('.el-image img').first().waitFor()
    await scope
      .locator('.el-image img')
      .first()
      .evaluate(
        (image) =>
          new Promise((done, reject) => {
            if (image.complete)
              return image.naturalWidth
                ? done()
                : reject(new Error('Withdrawal snapshot image did not decode'))
            const timer = setTimeout(
              () => reject(new Error('Withdrawal image load timed out')),
              15_000
            )
            image.addEventListener(
              'load',
              () => {
                clearTimeout(timer)
                done()
              },
              { once: true }
            )
            image.addEventListener(
              'error',
              () => {
                clearTimeout(timer)
                reject(new Error('Withdrawal image decode failed'))
              },
              { once: true }
            )
          })
      )
    return scope
  }
  const paymentForm = async () => {
    await navigate('/finance/settlement?tab=withdrawals', '财务结算')
    await openRow(data.players[1].name, '登记已发放')
    return checkDialog('登记提现已发放', ['核对收款资料与实际凭证', '¥22.00', '实际转账凭证'])
  }
  const expenseForm = async () => {
    await navigate('/finance/settlement?tab=expenses', '财务结算')
    await page.getByRole('button', { name: '录入费用', exact: true }).click()
    return checkDialog('录入费用（提交即入账）', ['支出信息与凭证', '提交即入账'])
  }
  const businessForm = async () => {
    await navigate('/system/business', '业务配置')
    await clickTab(page, '订单项目 / 模板')
    await openRow(data.template.name, '编辑配置')
    return checkDialog('订单项目配置', ['项目内容与默认金额', '¥100.00'])
  }
  const contentForm = async () => {
    await navigate('/system/player-content', '打手端内容管理')
    await clickTab(page, /^滚动公告/)
    await page
      .locator('.el-table__body tr')
      .filter({ hasText: data.announcement.title })
      .getByRole('button', { name: '编辑', exact: true })
      .click()
    return checkDialog('编辑内容', ['编辑草稿与展示时间', '保存草稿', '保存并发布'])
  }
  const logDetail = async () => {
    await navigate('/system/logs', '操作日志')
    await page.getByRole('button', { name: '查看前后值', exact: true }).first().click()
    const scope = await checkDialog('审计记录详情', ['业务关联与操作上下文', '修改前后对照'])
    await clickTab(scope, '原始记录')
    await scope.getByText('留存的原始数据', { exact: true }).waitFor()
    await clickTab(scope, '字段变化')
    return scope
  }
  const runtimeDetail = async () => {
    await navigate('/safeguard/server')
    await page.getByRole('button', { name: '查看运行详情', exact: true }).click()
    const scope = await checkDialog('实际运行监测详情', ['采集时间'])
    await clickTab(scope, '请求与进程')
    await scope.getByText('实际请求与服务进程', { exact: true }).waitFor()
    return scope
  }

  const salaryChecks = async () => {
    await navigate('/finance/settlement?tab=withdrawals', '财务结算')
    const salaryRead = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === '/api/studio/bootstrap' &&
        url.searchParams.get('includeReports') === 'true' &&
        response.request().method() === 'GET'
      )
    })
    await navigate('/finance/salary?tab=history', '工资与提成')
    const actualSalaryResponse = await salaryRead
    assert.equal(actualSalaryResponse.status(), 200)
    const actualSalary = await actualSalaryResponse.json()
    assert.equal(actualSalary.reports.month, '2026-10')
    assert.equal(actualSalary.reports.payroll.length, 24)
    assert.equal(actualSalary.reports.payroll.at(-1).total, -550)
    assert.equal(actualSalary.reports.payroll.at(-1).incomplete, false)
    report.salaryEntry = {
      automaticRead: true,
      actualMonth: actualSalary.reports.month,
      completeAuthorizedLines: actualSalary.reports.payroll.length
    }
    await page.getByRole('button', { name: '查看发放明细', exact: true }).first().click()
    const payrollScope = await checkDialog('2026-10 工资发放快照', ['原始发放明细', '23 人'])
    await payrollScope.locator('.el-pagination .btn-next').click()
    await payrollScope.locator('.el-table__body tr').filter({ hasText: '工资隔离员工23' }).waitFor()
    await screenshot('payroll-snapshot-page-two')
    await closeDialog()
    await clickTab(page, '工资方案')
    await openRow('工资隔离员工01')
    await checkDialog('工资方案详情', ['提成配置', '¥100.00'])
    await screenshot('salary-plan-detail')
    await closeDialog()
    await openRow('工资隔离员工01', '编辑方案')
    await checkDialog('工资方案配置', ['员工、金额与比例'])
    await screenshot('salary-plan-form')
    await closeDialog(true)
    pass(
      'payroll snapshot pages existing authorized 23 lines while its summary stays complete; salary plan details/edit form remain read-only in QA'
    )
    await navigate('/finance/salary?tab=payroll', '工资与提成')
    await page.getByRole('button', { name: '登记全员差额已结算', exact: true }).click()
    const salaryConfirmation = await checkConfirmation('工资差额补结算', [
      '2026-10',
      '¥-5.50',
      '本次待结算差额',
      '待结算员工',
      '本月原发放快照'
    ])
    await screenshot('salary-supplementary-confirmation', salaryConfirmation)
    await cancelConfirmation()
    await navigate('/finance/settlement?tab=withdrawals', '财务结算')
    const salaryReentryRead = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === '/api/studio/bootstrap' &&
        url.searchParams.get('includeReports') === 'true' &&
        response.request().method() === 'GET'
      )
    })
    await navigate('/finance/salary?tab=payroll', '工资与提成')
    assert.equal((await salaryReentryRead).status(), 200)
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent.trim() === '登记全员差额已结算' && !button.disabled
      )
    )
    await page.getByRole('button', { name: '登记全员差额已结算', exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: '登记全员差额已结算', exact: true }).isEnabled(),
      true
    )
    report.salaryEntry.automaticReentryRead = true
    pass(
      'supplementary payroll confirmation uses complete authorized difference and prior snapshots; cancel preserves payroll'
    )
  }
  const contentChecks = async (navigationOnly = false) => {
    await navigate('/system/player-content', '打手端内容管理')
    await openRow(data.announcement.title)
    const contentScope = await checkDialog('内容记录详情', ['尚未发布的草稿详情'])
    await clickTab(contentScope, '最近发布版')
    await contentScope.getByText('发布版详情正文', { exact: true }).waitFor()
    await screenshot('content-published-version')
    await closeDialog()
    await contentForm()
    await screenshot('content-edit-form')
    const originalEditorTitle = await dialog()
      .locator('.el-form-item')
      .filter({ hasText: '标题' })
      .locator('input')
      .first()
      .inputValue()
    await dialog().getByRole('button', { name: '预览', exact: true }).click()
    await checkDialog('内容预览', ['尚未发布的草稿详情'])
    assert.deepEqual(secondaryStack().slice(-2), [
      'player-content-editor',
      'player-content-preview'
    ])
    await page.goBack()
    await checkDialog('编辑内容', ['编辑草稿与展示时间'])
    assert.equal(
      await dialog()
        .locator('.el-form-item')
        .filter({ hasText: '标题' })
        .locator('input')
        .first()
        .inputValue(),
      originalEditorTitle
    )
    pass(
      'nested content preview has a child URL and browser Back restores the original initialized editor fields'
    )
    const editorTitle = dialog()
      .locator('.el-form-item')
      .filter({ hasText: '标题' })
      .locator('input')
      .first()
    const unsavedTitle = originalEditorTitle + ' 临时未保存核对'
    await editorTitle.fill(unsavedTitle)
    await page.evaluate(() => {
      window.location.hash = '/system/business'
    })
    const leaveConfirmation = page.locator('.el-message-box:visible').last()
    await leaveConfirmation.getByText('关闭编辑', { exact: true }).waitFor()
    await cancelConfirmation()
    await checkDialog('编辑内容', ['编辑草稿与展示时间'])
    assert.equal(await editorTitle.inputValue(), unsavedTitle)
    assert.ok(secondaryStack().includes('player-content-editor'))
    assert.equal(await page.locator('.el-message-box:visible').count(), 0)
    await editorTitle.fill(originalEditorTitle)
    pass(
      'cross-module content navigation uses the original close-editor confirmation once; cancellation preserves the routed editor and unsaved input'
    )
    await closeDialog()
    if (navigationOnly) return
    await clickTab(page, /^图片轮播/)
    await openRow(data.banner.title)
    await checkDialog('内容记录详情', ['隔离轮播正文'])
    await screenshot('content-banner-detail')
    await closeDialog()
    pass(
      'content read detail switches saved draft/published versions and editor closes without publication or unsaved changes'
    )
    await clickTab(page, /^滚动公告/)
    await openRow(data.announcement.title, '发布')
    const contentPublishConfirmation = await checkConfirmation('发布内容', [
      data.announcement.title,
      '滚动公告',
      '已保存修订',
      '展示中'
    ])
    await screenshot('content-publish-confirmation', contentPublishConfirmation)
    await cancelConfirmation()
    pass(
      'saved content publish confirmation shows the selected title/type/state/revision without publishing'
    )
    await contentForm()
    await dialog().getByRole('button', { name: '保存并发布', exact: true }).click()
    const contentEditingConfirmation = await checkConfirmation('保存并发布', [
      data.announcement.title,
      '原记录修订',
      '开始展示（北京时间）'
    ])
    await screenshot('content-editor-publish-confirmation', contentEditingConfirmation)
    await cancelConfirmation()
    await closeDialog()
    pass(
      'editor save-and-publish confirmation shows the actual editing target and original revision; cancel keeps draft'
    )
    await openRow(data.announcement.title, '下架')
    const contentOfflineConfirmation = await checkConfirmation('下架内容', [
      data.announcement.title,
      '滚动公告',
      '最近发布时间',
      '展示中'
    ])
    await screenshot('content-offline-confirmation', contentOfflineConfirmation)
    await cancelConfirmation()
    pass('content offline confirmation identifies current publication before cancellation')
    await clickTab(page, /^图片轮播/)
    await openRow(data.banner.title, '删除')
    const contentDeleteConfirmation = await checkConfirmation('删除内容', [
      data.banner.title,
      '图片轮播',
      '草稿',
      '最近修改时间'
    ])
    await screenshot('content-delete-confirmation', contentDeleteConfirmation)
    await cancelConfirmation()
    pass(
      'content delete confirmation identifies the eligible draft and revision without deleting it'
    )

    // Delay one actual isolated HTTP handler, preserving its authentication and
    // source-generated response. Returning from the page must invalidate restore.
    await page.goto('about:blank')
    let readArrived
    const heldRead = new Promise((done, reject) => {
      readArrived = () => {
        clearTimeout(delayedRestoreReadTimer)
        done()
      }
      delayedRestoreReadTimer = setTimeout(
        () => reject(new Error('Actual delayed content read was not reached')),
        20_000
      )
    })
    const releasedRead = new Promise((done) => {
      releaseDelayedRestoreRead = done
    })
    delayedRestoreRead = { arrived: readArrived, released: releasedRead }
    const lateReadResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/studio/player-content' &&
        response.request().method() === 'GET',
      { timeout: 20_000 }
    )
    // Keep timeout rejection observed even if navigation fails before release.
    void lateReadResponse.catch(() => {})
    const restoreQuery = new URLSearchParams({
      secondary: 'player-content-details',
      secondaryRecord: data.announcement.id
    })
    await Promise.all([page.goto(base + '/#/system/player-content?' + restoreQuery), heldRead])
    const pendingContentPage = page.locator('[data-page-key="player-content-details"]:visible')
    await pendingContentPage.getByRole('button', { name: '返回上一页', exact: true }).click()
    await page.getByRole('heading', { name: '打手端内容管理', exact: true }).waitFor()
    assert.ok(!secondaryStack().includes('player-content-details'))
    releaseDelayedRestoreRead()
    releaseDelayedRestoreRead = null
    const actualLateResponse = await lateReadResponse
    assert.equal(actualLateResponse.status(), 200)
    await page
      .locator('.el-table__body tr')
      .filter({ hasText: data.announcement.title })
      .first()
      .waitFor()
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    )
    assert.equal(await page.locator('[data-page-key="player-content-details"]:visible').count(), 0)
    assert.ok(!secondaryStack().includes('player-content-details'))
    await screenshot('content-late-restore-return-keeps-list', page.locator('.el-table').first())
    pass(
      'returning while a real authorized content GET is delayed invalidates restore; the later actual response cannot reopen the canceled page'
    )
  }
  if (contentNavigationOnly) {
    await contentChecks(true)
  } else if (salaryOnly) {
    await salaryChecks()
  } else {
    await withdrawalDetail()
    await screenshot('withdrawal-paid')
    assert.equal(secondaryStack().at(-1), 'finance-withdrawal-details')
    const readsBeforeReload = report.requests.length
    await page.reload()
    await checkDialog('提现记录详情', ['申请时收款资料', '¥33.00'])
    const restoredReads = report.requests.slice(readsBeforeReload)
    assert.ok(
      restoredReads.some(
        (request) => request.method === 'GET' && request.path === '/api/studio/session'
      )
    )
    assert.ok(
      restoredReads.some(
        (request) => request.method === 'GET' && request.path === '/api/studio/bootstrap'
      )
    )
    await screenshot('withdrawal-restored-after-authorized-reload')
    pass(
      'readonly detail has a public URL and reload reauthenticates/reads the actual current authorized record'
    )
    report.lastNavigationAttempt = {
      action: 'browser-back',
      pageKey: 'finance-withdrawal-details',
      beforeUrl: page.url()
    }
    await page.goBack()
    await page.locator('[data-page-key="finance-withdrawal-details"]').waitFor({ state: 'hidden' })
    await page.getByRole('heading', { name: '财务结算', exact: true }).waitFor()
    assert.ok(!secondaryStack().includes('finance-withdrawal-details'))
    report.lastNavigationAttempt.afterUrl = page.url()
    pass(
      'browser Back returns from standalone withdrawal detail to its original business list without writing'
    )
    await withdrawalDetail()
    await closeDialog()
    pass(
      'withdrawal read detail shows original amount, payment snapshot, processing record and private receipt image'
    )
    if (navigationSmoke) {
      await paymentForm()
      await closeDialog(true)
      pass('original withdrawal payment cancel closes its routed form without a financial write')
    } else {
      await paymentForm()
      await screenshot('withdrawal-payment-form')
      await closeDialog(true)
      await openRow(data.players[0].name, '驳回')
      await checkDialog('驳回提现申请', ['填写驳回依据', '¥11.00'])
      await screenshot('withdrawal-reject-form')
      await closeDialog(true)
      await openRow(data.players[0].name, '审核通过')
      const withdrawalConfirmation = await checkConfirmation('提现审核', [
        data.players[0].name,
        '¥11.00',
        '原申请金额',
        '申请时间',
        '待审核'
      ])
      await screenshot('withdrawal-approval-confirmation', withdrawalConfirmation)
      await cancelConfirmation()
      pass(
        'withdrawal payment/rejection forms show target and impact; approval confirmation is canceled without a write'
      )
      pass(
        'withdrawal approval confirmation identifies the actual applicant, amount, application date and current status before cancellation'
      )

      await navigate('/finance/settlement?tab=refunds', '财务结算')
      await openRow(data.orders[0].orderNo)
      await checkDialog('退款记录详情', ['退款依据与经办记录', '¥5.00'])
      await screenshot('refund-detail')
      await closeDialog()
      await page.getByRole('button', { name: '登记实际退款', exact: true }).click()
      await checkDialog('登记已实际发生的退款', ['退款金额与原因'])
      await screenshot('refund-create-form')
      await closeDialog(true)
      pass(
        'refund detail and original registration form distinguish stored refund, remaining authorization and original payment-day attribution'
      )
      await openRow(data.orders[2].orderNo, '确认退款')
      const refundConfirmation = await checkConfirmation('审核并登记退款', [
        data.orders[2].orderNo,
        '¥6.00',
        '原付款时间',
        '待审核'
      ])
      await screenshot('refund-approval-confirmation', refundConfirmation)
      await cancelConfirmation()
      pass(
        'pending refund approval confirmation identifies original order/payment time and amount; cancel does not approve'
      )

      await navigate('/finance/settlement?tab=expenses', '财务结算')
      await openRow('QA费用类别01')
      await checkDialog('费用记录详情', ['用途与留存凭证', '隔离支出用途1'])
      await screenshot('expense-detail')
      await closeDialog()
      await expenseForm()
      await screenshot('expense-create-form')
      await closeDialog(true)
      pass(
        'expense detail and registration form retain actual expense date, voucher and reversible statistics explanation'
      )
      await openRow('QA费用类别01', '删除')
      const expenseDeleteConfirmation = await checkConfirmation('删除费用', [
        'QA费用类别01',
        '¥12.00',
        '2026-10-14',
        '当前统计状态'
      ])
      await screenshot('expense-delete-confirmation', expenseDeleteConfirmation)
      await cancelConfirmation()
      pass(
        'expense delete confirmation includes the concrete category, original amount and date before cancellation'
      )
      const statusSelector = page
        .locator('.el-form-item')
        .filter({ hasText: '入账状态' })
        .locator('.el-select')
      await statusSelector.click()
      await page.getByRole('option', { name: '已删除', exact: true }).click()
      await page.getByRole('button', { name: '查询', exact: true }).click()
      await openRow('QA费用类别02', '恢复')
      const expenseRestoreConfirmation = await checkConfirmation('恢复费用', [
        'QA费用类别02',
        '¥12.01',
        '2026-10-14',
        '已删除，不计入费用'
      ])
      await screenshot('expense-restore-confirmation', expenseRestoreConfirmation)
      await cancelConfirmation()
      pass(
        'expense restore confirmation identifies the deleted record and original value before cancellation'
      )

      await navigate('/finance/settlement?tab=adjustments', '财务结算')
      await openRow('隔离差额核对依据')
      await checkDialog('打手报酬调整详情', ['调整依据', '人工差额处理', '¥10.00'])
      await screenshot('adjustment-detail')
      await closeDialog()
      await openRow('隔离差额核对依据', '登记差额处理')
      await checkDialog('登记待追回差额处理', ['实际处理结果与依据', '¥10.00'])
      await screenshot('adjustment-resolution-form')
      await closeDialog(true)
      await page.getByRole('button', { name: '新增打手扣款 / 补款', exact: true }).click()
      await checkDialog('打手扣款 / 补款', ['调整对象与依据'])
      await screenshot('adjustment-create-form')
      await closeDialog(true)
      await page
        .getByRole('button', { name: '历史报酬更正 · 人工待处理记录', exact: false })
        .click()
      await openRow('隔离历史报酬人工核对')
      await checkDialog('历史报酬更正详情', ['原始依据与人工结果'])
      await screenshot('legacy-adjustment-detail')
      await closeDialog()
      await openRow('隔离历史报酬人工核对', '登记处理结果')
      await checkDialog('历史报酬人工处理', ['实际差额与处理依据'])
      await screenshot('legacy-adjustment-resolution-form')
      await closeDialog(true)
      pass(
        'modern and legacy reward adjustment details/forms keep applied amount separate from manual difference and do not submit'
      )

      await salaryChecks()

      await navigate('/system/business', '业务配置')
      await openRow(data.template.name)
      await checkDialog('业务配置详情', ['项目与默认内容', '¥100.00'])
      await screenshot('business-template-detail')
      await closeDialog()
      await businessForm()
      await screenshot('business-template-form')
      await closeDialog(true)
      await clickTab(page, '来源平台与店铺')
      await openRow(data.platform.name)
      await checkDialog('业务配置详情', ['来源下单规则'])
      await screenshot('business-platform-detail')
      await closeDialog()
      await openRow(data.platform.name, '编辑平台')
      await checkDialog('来源平台配置', ['名称与现有下单规则'])
      await closeDialog(true)
      await openRow(data.shop.name)
      await checkDialog('业务配置详情', ['来源归属'])
      await closeDialog()
      await openRow(data.shop.name, '编辑店铺')
      await checkDialog('来源店铺配置', ['名称与来源归属'])
      await closeDialog(true)
      await clickTab(page, '打手等级')
      await openRow('二级详情隔离等级')
      await checkDialog('业务配置详情', ['公共抢单池开放口径'])
      await closeDialog()
      await openRow('二级详情隔离等级', '编辑规则')
      await checkDialog('打手等级配置', ['等级与开放延迟'])
      await closeDialog(true)
      pass(
        'all four business configuration read/details and existing edit forms retain current default/rule scope without saving'
      )

      await contentChecks()

      await navigate('/reports/export?modules=orders', '自选数据导出')
      const previewResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/studio/exports/preview' &&
          response.request().method() === 'POST'
      )
      await page.getByRole('button', { name: '预览所选内容', exact: true }).click()
      const preview = await previewResponse
      assert.equal(preview.status(), 200)
      const previewResult = await preview.json()
      const sheet = previewResult.sheets.find((row) => row.id === 'orders')
      assert.ok(sheet.rowCount >= 25)
      assert.equal(sheet.rows.length, 20)
      await page.getByRole('heading', { name: '本次报表预览', exact: true }).waitFor()
      await page.getByText('每表 20 条', { exact: true }).waitFor()
      await page.getByRole('button', { name: '查看行详情', exact: true }).first().click()
      await checkDialog('报表行详情', ['所选字段原值'])
      await screenshot('report-preview-row-detail')
      assert.equal(secondaryStack().at(-1), 'report-preview-row')
      const previewsBeforeReload = report.requests.filter(
        (request) => request.path === '/api/studio/exports/preview'
      ).length
      await page.reload()
      await page
        .locator('[data-page-key="report-preview-row"]:visible')
        .getByText('这份临时报表预览已失效', { exact: false })
        .waitFor()
      assert.equal(
        report.requests.filter((request) => request.path === '/api/studio/exports/preview').length,
        previewsBeforeReload
      )
      await screenshot('report-refresh-expired-preview')
      pass(
        'transient report row refresh reports expiration and never reuses an old index against a new preview'
      )
      await closeDialog()
      pass(
        'actual authorized export preview reports full matched rowCount and only 20 rows; row detail shows selected fields without a download'
      )

      await logDetail()
      await screenshot('audit-changes-detail')
      await closeDialog()
      pass(
        'audit detail renders field comparison and original projected before/after values without a maintenance operation'
      )
      await page.getByRole('button', { name: '清理已备份归档', exact: true }).click()
      const purgeScope = await checkDialog('完整备份与归档清理', ['备份范围与清理依据'])
      const cutoff = purgeScope
        .locator('.el-form-item')
        .filter({ hasText: '清理此日期之前的归档' })
        .locator('input')
      await cutoff.fill('2026-10-15')
      await cutoff.press('Enter')
      await cutoff.press('Tab')
      const downloadEvent = page.waitForEvent('download', { timeout: 20_000 })
      await purgeScope.getByRole('button', { name: '下载完整归档备份', exact: true }).click()
      const archiveDownload = await downloadEvent
      await archiveDownload.saveAs(join(output, 'isolated-archive-backup.json'))
      assert.equal(await archiveDownload.failure(), null)
      await purgeScope.getByText('已生成', { exact: false }).first().waitFor()
      const backupConfirmation = purgeScope.getByRole('checkbox', {
        name: '我已核对并保存本次将清理记录的完整原始归档备份',
        exact: true
      })
      assert.equal(await backupConfirmation.isEnabled(), true)
      await purgeScope
        .getByText('我已核对并保存本次将清理记录的完整原始归档备份', { exact: true })
        .click()
      assert.equal(await backupConfirmation.isChecked(), true)
      await purgeScope
        .locator('.el-form-item')
        .filter({ hasText: '清理原因' })
        .locator('textarea')
        .fill('隔离最终确认展示，仅打开后取消')
      await purgeScope.getByRole('button', { name: '确认清理归档', exact: true }).click()
      const purgeConfirmation = await checkConfirmation('确认清理归档', [
        '2026-10-15 之前的归档',
        '本次完整备份记录',
        '已确认保存',
        '继续保留'
      ])
      await screenshot('audit-purge-confirmation', purgeConfirmation)
      await cancelConfirmation('继续核对')
      await closeDialog(true)
      pass(
        'archive purge final confirmation uses an actual isolated full backup and cutoff/count; cancellation never clears logs'
      )
      const runtimeScope = await runtimeDetail()
      for (const [tab, title] of [
        ['磁盘与审计', '当前真实文件容量'],
        ['推送队列', '等待与发送中队列'],
        ['计划备份', '实际备份结果']
      ]) {
        await clickTab(runtimeScope, tab)
        await runtimeScope.getByText(title, { exact: true }).waitFor()
      }
      await screenshot('runtime-backup-detail')
      await closeDialog()
      pass(
        'runtime detail shows actual request/storage/push/backup sections and retains service-acceptance versus handset-arrival explanation'
      )

      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: width < 1000 ? 844 : 1050 })
        for (const [name, open, cancel] of [
          ['withdrawal-payment', paymentForm, true],
          ['expense-form', expenseForm, true],
          ['business-form', businessForm, true],
          ['content-form', contentForm, false],
          ['audit', logDetail, false],
          ['runtime', runtimeDetail, false]
        ]) {
          const scope = await open()
          const box = await scope.boundingBox()
          const layout = await page.evaluate(() => ({
            width: innerWidth,
            pageWidth: document.documentElement.scrollWidth
          }))
          assert.ok(
            box && box.width <= width + 1 && box.x >= -1 && box.x + box.width <= width + 1,
            `${name} dialog exceeds ${width}px viewport`
          )
          assert.ok(
            layout.pageWidth <= width + 1,
            `${name} page has horizontal overflow at ${width}px`
          )
          report.layouts.push({ name, ...layout, dialogWidth: box.width, dialogHeight: box.height })
          await screenshot(`layout-${name}-${width}`, scope)
          await closeDialog(cancel)
        }
        pass(
          `secondary details and form cancellation usable at ${width}px without page/dialog horizontal overflow`
        )
      }
    }
  }
  const businessAfter = service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  report.businessStateAfter = digest(businessAfter)
  report.businessStateUnchanged = businessBefore === businessAfter
  assert.equal(report.businessStateUnchanged, true)
  assert.deepEqual(report.deniedWrites, [])
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.serverErrors, [])
  assert.equal(report.fakePushCalls || 0, 0)
  report.passed = true
} catch (error) {
  report.error = error.message
  report.stack = error.stack
  process.exitCode = 1
  if (page) {
    try {
      report.failedUrl = page.url()
      await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
    } catch {}
  }
} finally {
  clearTimeout(delayedRestoreReadTimer)
  releaseDelayedRestoreRead?.()
  if (browser) await browser.close()
  if (vite) await vite.close()
  if (server?.listening) await new Promise((done) => server.close(done))
  else service?.close()
  report.sourceAfter = sourceFingerprint()
  report.sourceUnchanged = before.digest === report.sourceAfter.digest
  if (!report.sourceUnchanged) {
    report.passed = false
    report.sourceChangeError = 'Source changed during UI acceptance'
    process.exitCode = 1
  }
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      passed: report.passed,
      cases: report.cases.length,
      pageErrors: report.pageErrors.length,
      serverErrors: report.serverErrors.length,
      deniedWrites: report.deniedWrites.length,
      sourceUnchanged: report.sourceUnchanged,
      output,
      error: report.error
    })
  )
}
