import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createPortProbe } from 'node:net'
import { resolve, join } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { createStudioServer } from '../server/index.mjs'
import { createPlayerClientServer } from './player-client-server.mjs'
import { testMutate } from '../tests/helpers/current-intent.mjs'

// Each run owns one disposable memory database and random loopback listeners.
// It never reads production config, invokes external push, or uses live ports.
const output = resolve('.qa/production-fixes-20261018/admin-ui', `run-${randomUUID()}`)
mkdirSync(output, { recursive: true })
process.env.STUDIO_QA_DECLARATIONS_DIR = join(output, 'generated-types')
const password = `isolated-admin-fixes-${randomUUID()}`
const report = {
  passed: false,
  output,
  database: ':memory:',
  cases: [],
  pageErrors: [],
  serverErrors: [],
  writes: [],
  imageReads: [],
  layouts: [],
  limitations: [
    'Local isolated browser acceptance; no physical-phone push or company/Rainyun network measurement.'
  ]
}
const require = createRequire(import.meta.url)
const {
  chromium
} = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const sharp = require('sharp')
let backend, vite, playerServer, browser, page
const pass = (name) => {
  report.cases.push(name)
  console.log(`PASS ${name}`)
}
async function freePort() {
  const probe = createPortProbe()
  await new Promise((done) => probe.listen(0, '127.0.0.1', done))
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  assert.ok(![3006, 3007, 3008, 3011].includes(port))
  return port
}
try {
  backend = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password,
    maintenanceFromEnv: false,
    notificationIntervalMs: 86400000,
    uploadCleanup: { enabled: false },
    backups: { intervalMinutes: 0, directory: join(output, 'backups'), failureWebhook: '' },
    notifications: {
      publicKey: '',
      privateKey: '',
      subject: '',
      allowedPushHosts: [],
      pushSender: async () => {
        throw new Error('External push prohibited in isolated acceptance')
      }
    }
  })
  await new Promise((done) => backend.listen(0, '127.0.0.1', done))
  const service = backend.service
  const api = `http://127.0.0.1:${backend.address().port}`
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const current = (id) => service.orderDetail('admin', id).order
  const level = mutate('/levels', { name: '后台修改验收等级', delaySeconds: 0 })
  const player = mutate('/users', {
    username: `qa-player-${randomUUID()}`,
    name: '内部验收打手A',
    role: 'player',
    status: 'active',
    levelId: level.id,
    maxActiveOrders: 1,
    permissionOverrides: {},
    password
  })
  const employee = mutate('/users', {
    username: `qa-employee-${randomUUID()}`,
    name: '内部排班员工A',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password
  })
  const platform = mutate('/platforms', {
    name: '后台修改隔离来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const customer = mutate('/customers', { name: '后台验收虚构客户', gameId: 'qa-only' })
  function order(name) {
    const template = mutate('/templates', {
      name,
      game: '三角洲行动',
      description: '后台修改隔离验收',
      map: 'QA',
      amount: 10000,
      reward: 1000,
      active: true
    })
    return mutate('/orders', {
      templateId: template.id,
      customerId: customer.id,
      platformId: platform.id,
      roomCode: 'QA',
      amount: 10000,
      reward: 1000,
      receivedAmount: 10000,
      paidAt: new Date().toISOString(),
      dispatchMode: 'pool'
    })
  }
  const idle = order('无人存单验收'),
    continuing = order('原打手续做验收'),
    refunded = order('全额退款大厅拦截验收')
  mutate(`/player/orders/${continuing.id}/claim`, {}, player.id)
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
  playerServer = createPlayerClientServer({
    apiTarget: api,
    staticRoot: resolve('player-client/dist')
  })
  await new Promise((done) => playerServer.listen(0, '127.0.0.1', done))
  const playerBase = `http://127.0.0.1:${playerServer.address().port}`
  report.ports = {
    api: backend.address().port,
    admin: vite.httpServer.address().port,
    player: playerServer.address().port
  }
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } })
  assert.equal(
    (
      await context.request.post(api + '/api/studio/login', {
        data: { username: 'admin', password }
      })
    ).status(),
    200
  )
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1'
      ? route.abort('blockedbyclient')
      : route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.setDefaultNavigationTimeout(60000)
  page.on('pageerror', (error) => report.pageErrors.push(error.message))
  page.on('response', (response) => {
    if (response.url().includes('/api/studio/') && response.status() >= 500)
      report.serverErrors.push({
        path: new URL(response.url()).pathname,
        status: response.status()
      })
  })
  page.on('request', (request) => {
    if (request.url().includes('/api/studio/uploads/') && request.method() === 'GET')
      report.imageReads.push({ url: request.url() })
    if (request.url().includes('/api/studio/') && request.method() === 'POST')
      report.writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
  })
  const detail = () =>
    page
      .locator(
        '.business-detail-page-panel[data-page-key="order-detail"]:visible, .el-drawer:visible'
      )
      .last()
  const panel = () =>
    page
      .locator(
        '.business-detail-page-panel[data-page-key="order-action"]:visible, .el-dialog:visible'
      )
      .last()
  const field = (scope, label) =>
    scope
      .locator('.el-form-item')
      .filter({ has: page.locator('.el-form-item__label').filter({ hasText: label }) })
      .first()
  async function visit(id) {
    if (await detail().count())
      await detail()
        .getByRole('button', { name: '刷新订单并重新确认操作', exact: true })
        .click({ trial: true })
    await page.goto(`${base}/#/orders/list?id=${id}`)
    await page.reload()
    await detail().getByText(current(id).orderNo, { exact: true }).first().waitFor()
    await detail().getByRole('button', { name: '刷新订单并重新确认操作', exact: true }).waitFor()
  }
  async function action(id, label, reason, path = `/orders/${id}/action`) {
    await detail().getByRole('button', { name: label, exact: true }).click()
    await field(panel(), '原因 / 处理说明').locator('textarea').fill(reason)
    const response = page.waitForResponse(
      (reply) => new URL(reply.url()).pathname.endsWith(path) && reply.request().method() === 'POST'
    )
    await panel().getByRole('button', { name: '确认保存', exact: true }).click()
    const value = await response
    assert.equal(value.status(), 200, JSON.stringify(await value.json()))
    await panel().waitFor({ state: 'hidden' })
    await detail()
      .getByRole('button', { name: '刷新订单并重新确认操作', exact: true })
      .click({ trial: true })
  }
  await visit(idle.id)
  await action(idle.id, '客户存单', '客户暂时不打，保留原订单')
  assert.equal(current(idle.id).stored, true)
  await detail().getByRole('button', { name: '恢复存单', exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'stored-desktop.png'), fullPage: true })
  await action(idle.id, '恢复存单', '客户恢复，放回大厅')
  assert.equal(current(idle.id).stored, false)
  assert.equal(current(idle.id).dispatchMode, 'pool')
  pass('无人接单存单/恢复由真实按钮提交，重新开放公共大厅')
  await visit(continuing.id)
  await action(continuing.id, '客户存单', '已完成一半，客户暂停；进度继续保留')
  const additional = order('原打手名额占用验收')
  mutate(`/player/orders/${additional.id}/claim`, {}, player.id)
  assert.equal(service.playerProfile(player.id).activeOrders, 1)
  await action(continuing.id, '恢复存单', '原负责人按已做进度继续')
  assert.equal(current(continuing.id).capacityExempt, true)
  assert.equal(service.playerProfile(player.id).activeOrders, 1)
  pass('原负责人满额时仍可恢复续做，名额保持原普通订单一单')
  await action(continuing.id, '标记问题单', '请核对客户进度并反馈')
  const problem = current(continuing.id).problem
  await detail().getByRole('button', { name: '确认问题已解决', exact: true }).click()
  await field(panel(), '原因 / 处理说明').locator('textarea').fill('旧页面尝试关闭问题')
  mutate(
    `/player/orders/${continuing.id}/problem-feedback`,
    { problemId: problem.id, message: '已联系客户，确认可以继续' },
    player.id
  )
  const conflict = page.waitForResponse(
    (reply) =>
      reply.url().endsWith(`/orders/${continuing.id}/action`) && reply.request().method() === 'POST'
  )
  await panel().getByRole('button', { name: '确认保存', exact: true }).click()
  const rejected = await conflict
  assert.equal(rejected.status(), 409)
  assert.equal((await rejected.json()).code, 'ORDER_REVISION_CONFLICT')
  assert.equal(current(continuing.id).problem.status, 'open')
  assert.equal(
    await field(panel(), '原因 / 处理说明').locator('textarea').inputValue(),
    '旧页面尝试关闭问题'
  )
  await panel().getByRole('button', { name: '返回', exact: true }).click()
  pass('打手新反馈使旧后台关闭意图409失效，问题保持未关闭并保留输入')
  await visit(continuing.id)
  await action(continuing.id, '确认问题已解决', '后台已核对打手反馈，问题关闭')
  assert.equal(current(continuing.id).problem.status, 'closed')
  assert.equal(current(continuing.id).problem.feedback.length, 1)
  assert.equal(current(continuing.id).capacityExempt, true)
  pass('问题单开立、打手反馈、后台核对关闭，保留处理记录及原名额规则')
  const image = await sharp({
    create: { width: 900, height: 650, channels: 3, background: '#1e7b9a' }
  })
    .png()
    .toBuffer()
  const screenshot = service.upload(player.id, {
    name: '后台验收材料.png',
    mime: 'image/png',
    data: image.toString('base64')
  })
  mutate(
    `/player/orders/${continuing.id}/submit`,
    { screenshots: [screenshot], teammateId: null },
    player.id
  )
  await visit(continuing.id)
  await detail()
    .getByRole('tab', { name: /完成材料/ })
    .click()
  const imageView = detail().locator('.business-image img').first()
  await imageView.scrollIntoViewIfNeeded()
  await imageView.waitFor()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.business-image img')].some((image) => image.naturalWidth > 0)
  )
  assert.ok(
    report.imageReads.some((row) => {
      const url = new URL(row.url)
      return url.pathname.endsWith(screenshot.id) && url.searchParams.get('variant') === 'thumb'
    })
  )
  assert.equal(
    report.imageReads.filter((row) => {
      const url = new URL(row.url)
      return url.pathname.endsWith(screenshot.id) && !url.searchParams.has('variant')
    }).length,
    0
  )
  const originalRead = page.waitForResponse((reply) => {
    const url = new URL(reply.url())
    return url.pathname.endsWith(`/uploads/${screenshot.id}`) && !url.searchParams.has('variant')
  })
  await imageView.click()
  assert.equal((await originalRead).status(), 200)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(output, 'materials-desktop.png'), fullPage: true })
  pass('后台材料先取缩略图并真实解码，点击预览后才读取原图')
  await visit(refunded.id)
  await action(refunded.id, '登记退款', '客户整单全额退款，禁止继续接单', '/refunds')
  assert.equal(current(refunded.id).displayStatus, 'refunded')
  assert.equal(await detail().getByRole('button', { name: '调整派单', exact: true }).count(), 0)
  await detail().getByText('已退款', { exact: true }).first().waitFor()
  assert.equal(
    service.playerOrders(player.id).some((row) => row.id === refunded.id),
    false
  )
  const playerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true
  })
  const playerPage = await playerContext.newPage()
  playerPage.setDefaultTimeout(20000)
  await playerPage.goto(`${playerBase}/#/player/login`)
  await playerPage.getByLabel('账号', { exact: true }).fill(player.username)
  await playerPage.locator('input[name=password]').fill(password)
  await playerPage.getByRole('button', { name: '登录', exact: true }).click()
  await playerPage.waitForURL('**/#/player/lobby')
  await playerPage.getByText(idle.orderNo, { exact: true }).first().waitFor()
  assert.equal(await playerPage.getByText(refunded.orderNo, { exact: true }).count(), 0)
  await playerPage.screenshot({ path: join(output, 'refund-player-lobby-390.png'), fullPage: true })
  pass('后台真实全额退款显示已退款，真实打手大厅不再展示该单')
  await visit(refunded.id)
  await page.screenshot({ path: join(output, 'refunded-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(output, 'refunded-admin-390.png'), fullPage: true })
  report.layouts.push(
    await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      surface: 'admin-refund'
    }))
  )
  await page.setViewportSize({ width: 1440, height: 1050 })
  const approvalOrder = order('财务退款审批版本验收')
  const rejectOrder = order('财务退款驳回验收')
  const approvalRefund = mutate(
    '/refunds',
    { orderId: approvalOrder.id, amount: 10000, reason: '隔离全额退款申请' },
    employee.id
  )
  const rejectRefund = mutate(
    '/refunds',
    { orderId: rejectOrder.id, amount: 10000, reason: '隔离待驳回申请' },
    employee.id
  )
  await page.goto(`${base}/#/finance/settlement?tab=refunds`)
  await page.getByRole('heading', { name: '财务结算', exact: true }).waitFor()
  const approvalRow = page
    .locator('.el-table__body tr')
    .filter({ hasText: approvalOrder.orderNo })
    .first()
  await approvalRow.getByRole('button', { name: '确认退款', exact: true }).click()
  const confirm = () => page.locator('.el-message-box:visible').last()
  await confirm().getByRole('button', { name: '确认已退款', exact: true }).waitFor()
  const capturedRevision = current(approvalOrder.id).revision
  mutate(`/orders/${approvalOrder.id}/action`, {
    action: 'remark',
    playerRemark: '确认弹窗期间订单已更新'
  })
  let approvalResponse = page.waitForResponse(
    (reply) =>
      reply.url().endsWith(`/refunds/${approvalRefund.id}/action`) &&
      reply.request().method() === 'POST'
  )
  await confirm().getByRole('button', { name: '确认已退款', exact: true }).click()
  assert.equal((await approvalResponse).status(), 409)
  assert.equal(report.writes.at(-1).body.expectedRevision, capturedRevision)
  assert.equal(
    service.bootstrap('admin').refunds.find((row) => row.id === approvalRefund.id).status,
    'pending'
  )
  await approvalRow.getByRole('button', { name: '确认退款', exact: true }).click()
  await confirm().getByRole('button', { name: '确认已退款', exact: true }).waitFor()
  approvalResponse = page.waitForResponse(
    (reply) =>
      reply.url().endsWith(`/refunds/${approvalRefund.id}/action`) &&
      reply.request().method() === 'POST'
  )
  await confirm().getByRole('button', { name: '确认已退款', exact: true }).click()
  assert.equal((await approvalResponse).status(), 200)
  assert.equal(current(approvalOrder.id).displayStatus, 'refunded')
  pass('财务审批按弹窗前捕获版本提交，竞态409后重新核对才成功，不重复退款')
  const rejectRow = page
    .locator('.el-table__body tr')
    .filter({ hasText: rejectOrder.orderNo })
    .first()
  await rejectRow.getByRole('button', { name: '驳回', exact: true }).click()
  const rejectionPanel = page
    .locator('.business-detail-page-panel[data-page-key="finance-refund-process"]:visible')
    .last()
  await rejectionPanel.locator('textarea').fill('财务核对后驳回本次申请')
  const rejectionResponse = page.waitForResponse(
    (reply) =>
      reply.url().endsWith(`/refunds/${rejectRefund.id}/action`) &&
      reply.request().method() === 'POST'
  )
  await rejectionPanel.getByRole('button', { name: '保存处理结果', exact: true }).click()
  assert.equal((await rejectionResponse).status(), 200)
  await rejectionPanel.waitFor({ state: 'hidden' })
  assert.equal(current(rejectOrder.id).refundPending, false)
  assert.equal(current(rejectOrder.id).displayStatus, 'pending')
  pass('财务真实驳回带订单版本，解除全额退款审批暂停')
  await page.getByRole('button', { name: '登记实际退款', exact: true }).click()
  const registerPanel = page
    .locator('.business-detail-page-panel[data-page-key="finance-refund-register"]:visible')
    .last()
  await field(registerPanel, '关联订单（不含大厅来源）').locator('.el-select').click()
  await page.getByRole('option', { name: `${idle.orderNo} · ${idle.title}`, exact: true }).click()
  await field(registerPanel, '实际退款金额（元）').locator('input').fill('10.00')
  await field(registerPanel, '退款原因').locator('textarea').fill('独立财务表单部分实际退款')
  const registerResponse = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname.endsWith('/refunds') && reply.request().method() === 'POST'
  )
  await registerPanel.getByRole('button', { name: '确认实际退款并登记', exact: true }).click()
  assert.equal((await registerResponse).status(), 200)
  await registerPanel.waitFor({ state: 'hidden' })
  assert.equal(current(idle.id).refundSummary.paid, 1000)
  assert.equal(current(idle.id).displayStatus, 'pending')
  pass('独立财务登记表单读取订单版本再提交，部分退款保持原履约状态')
  await page.goto(`${base}/#/personnel/attendance`)
  await page.getByRole('heading', { name: '排班与考勤', exact: true }).waitFor()
  await page.getByRole('combobox', { name: '固定班次人员', exact: true }).click()
  await page.getByRole('option', { name: `${employee.name} · 客服`, exact: true }).waitFor()
  assert.equal(await page.getByRole('option', { name: new RegExp(player.name) }).count(), 0)
  await page.keyboard.press('Escape')
  assert.equal(
    await page.locator('.el-table__body').getByText(player.name, { exact: true }).count(),
    0
  )
  await page.screenshot({ path: join(output, 'employee-attendance-desktop.png'), fullPage: true })
  pass('人事固定排班选项及每日默认行均只含内部员工，不含打手')
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.serverErrors, [])
  report.passed = true
} catch (error) {
  report.error = { message: error.message, stack: error.stack }
  if (page)
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  console.error(error.stack)
  process.exitCode = 1
} finally {
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
  await new Promise((done) => playerServer?.close(() => done()) || done())
  await new Promise((done) => backend?.close(() => done()) || done())
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, output }))
}
