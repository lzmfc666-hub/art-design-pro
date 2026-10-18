import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'

// Real browser + real HTTP + one disposable SQLite memory database, with external push disabled.
const output = resolve(process.env.STUDIO_QA_ROOT || 'player-client/.qa', 'production-fixes-browser')
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const sharp = createRequire(resolve('package.json'))('sharp')
const password = `isolated-player-fixes-${randomUUID()}`
const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, maintenanceFromEnv: false,
  notificationIntervalMs: 86400000, notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [],
    pushSender: async () => { throw new Error('External delivery prohibited in browser acceptance') } } })
await new Promise(done => backend.listen(0, '127.0.0.1', done))
const apiBase = `http://127.0.0.1:${backend.address().port}`
const client = createPlayerClientServer({ apiTarget: apiBase, staticRoot: resolve(process.env.PLAYER_QA_STATIC_ROOT || 'player-client/dist') })
await new Promise(done => client.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${client.address().port}`
const jars = new Map(), actorIds = new Map([['admin', 'admin']])
const report = { passed: false, database: ':memory:', cases: [], errors: [], imageReads: [], writes: [], limitations: ['Isolated desktop browser, not physical phone delivery or Rainyun/company-network performance.'] }
let browser
const ok = name => report.cases.push({ name, passed: true })
async function api(actor, path, body) {
  const response = await fetch(`${actor === 'player' ? base : apiBase}/api/studio/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(actor === 'player' ? { 'X-Studio-Client': 'player' } : {}),
      ...(body === undefined || path === 'login' ? {} : { 'X-Studio-Actor': actorIds.get(actor) }),
      ...(jars.get(actor) ? { Cookie: jars.get(actor) } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const cookie = response.headers.get('set-cookie'); if (cookie) jars.set(actor, cookie.split(';')[0])
  const value = await response.json()
  assert.equal(response.status, 200, `${actor} ${path}: ${value.message || response.status}`)
  return value
}
async function current(order) { return (await api('admin', `orders/${order.id}`)).order }
async function action(order, action, extra = {}) {
  const row = await current(order)
  return api('admin', `orders/${order.id}/action`, { requestId: randomUUID(), action, reason: '隔离浏览器验收', expectedRevision: row.revision, assignmentId: row.assignmentId, leaderId: row.leaderId, submissionId: row.submissionId, ...extra })
}
async function claim(order) {
  const row = await api('player', `player/orders/${order.id}`)
  return api('player', `player/orders/${order.id}/claim`, { requestId: randomUUID(), expectedRevision: row.revision, dispatchRound: row.dispatchRound })
}
try {
  await api('admin', 'login', { username: 'admin', password })
  const level = await api('admin', 'levels', { name: '新流程浏览器验收等级', delaySeconds: 0 })
  const player = await api('admin', 'users', { username: `qa-${randomUUID()}`, name: '隔离验收打手', role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
  const support = await api('admin', 'users', { username: `qa-support-${randomUUID()}`, name: '隔离验收客服', role: 'support', status: 'active', maxActiveOrders: 5, permissionOverrides: {}, password })
  actorIds.set('support', support.id)
  await api('support', 'login', { username: support.username, password })
  actorIds.set('player', player.id)
  await api('player', 'login', { username: player.username, password })
  const customer = await api('admin', 'customers', { name: '隔离验收客户', gameId: 'qa-only', contact: 'qa-only' })
  const template = await api('admin', 'templates', { name: '新流程验收项目', game: '三角洲行动', description: '隔离验收流程', map: '航天基地', amount: 10000, reward: 1000, active: true })
  async function order(name, extra = {}) { return api('admin', 'orders', { requestId: randomUUID(), templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'qa-room', gameId: 'qa-game', amount: 10000, reward: 1000, receivedAmount: 10000, paidAt: new Date().toISOString(), dispatchMode: 'pool', playerRemark: name, title: name, ...extra }) }
  const continuing = await order('存单恢复并处理问题'), stored = await order('暂存任务'), refunded = await order('全额退款任务'), refundPending = await order('退款审批任务')
  const blockedDirect = await order('问题单指定任务', { dispatchMode: 'direct', assignedTo: player.id })
  for (const row of [continuing, stored, refunded, refundPending]) await claim(row)
  await action(continuing, 'problem-open', { reason: '请补充本单进度说明' })
  await action(continuing, 'store', { reason: '客户暂时暂停，已完成一半' })
  await action(continuing, 'resume', { mode: 'original' })
  await action(stored, 'store', { reason: '客户稍后继续' })
  await action(stored, 'problem-open', { reason: '存单问题交后台客服处理' })
  await action(blockedDirect, 'problem-open', { reason: '指定任务问题交后台客服处理' })
  const refundCurrent = await current(refunded)
  await api('admin', 'refunds', { requestId: randomUUID(), orderId: refunded.id, expectedRevision: refundCurrent.revision, amount: 10000, reason: '全额退款验收' })
  await api('support', 'refunds', { requestId: randomUUID(), orderId: refundPending.id, expectedRevision: (await current(refundPending)).revision, amount: 10000, reason: '申请全额退款验收' })
  // Seed one legacy feedback record in this disposable database only, to prove
  // historical content remains readable after the new staff-only rule.
  const legacyState = JSON.parse(backend.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  legacyState.orders.find(order => order.id === continuing.id).problem.feedback.push({ id: randomUUID(), userId: player.id, userName: player.name, message: '规则调整前保留的历史反馈', createdAt: new Date().toISOString() })
  backend.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(legacyState))
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.includes('/uploads/')) report.imageReads.push({ path: url.pathname, variant: url.searchParams.get('variant') })
    if (request.method() === 'POST' && (url.pathname.endsWith('/problem-feedback') || url.pathname.endsWith('/submit') || url.pathname.endsWith('/uploads')))
      report.writes.push({ path: url.pathname, contentType: request.headers()['content-type'], bytes: request.postDataBuffer()?.length || 0, ...(url.pathname.endsWith('/uploads') ? {} : { body: request.postDataJSON() }) })
  })
  await page.goto(`${base}/#/player/login`)
  await page.getByLabel('账号', { exact: true }).fill(player.username)
  await page.locator('input[name=password]').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/#/player/lobby')
  async function visit(path) {
    await page.evaluate(value => { location.hash = `#${value}` }, path)
    await page.waitForFunction(value => location.hash === `#${value}`, path)
  }
  await visit(`/player/orders/${continuing.id}`)
  await page.getByRole('heading', { name: '问题单与处理记录' }).waitFor()
  await page.getByText('本单由存单恢复给原负责人继续完成，本轮不占接单名额。是否可以操作以当前限制为准。').waitFor()
  await page.getByText('问题单当前仅可查看，请联系后台客服记录处理结果并关闭问题。关闭后是否可以继续操作，以订单当前状态为准。').waitFor()
  await page.getByText('规则调整前保留的历史反馈', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('处理反馈', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '提交问题反馈', exact: true }).count(), 0)
  assert.equal(await page.getByRole('heading', { name: '提交完成材料' }).count(), 0)
  assert.equal(await page.getByRole('heading', { name: '申请退单' }).count(), 0)
  assert.equal(await page.locator('input[type=file]').count(), 0)
  let row = await current(continuing)
  assert.equal(row.problem.status, 'open'); assert.equal(row.problem.feedback.length, 1)
  assert.equal(row.capacityExempt, true)
  assert.equal(row.countsTowardsCapacity, false)
  ok('问题单仅可查看并联系后台客服，保留历史反馈与免名额规则，隐藏全部订单操作')
  await page.screenshot({ path: resolve(output, 'problem-readonly-390.png'), fullPage: true })
  await action(continuing, 'problem-close', { problemId: row.problem.id, reason: '后台已核实解决' })
  await page.reload()
  await page.getByText(/后台确认：后台已核实解决/).waitFor()
  assert.equal(await page.getByRole('button', { name: '提交问题反馈', exact: true }).count(), 0)
  await page.getByText('规则调整前保留的历史反馈', { exact: true }).waitFor()
  await page.getByRole('heading', { name: '提交完成材料' }).waitFor()
  ok('后台客服确认关闭后保留历史记录，并按当前其他限制恢复履约入口')
  const pixels = Buffer.alloc(640 * 480 * 3)
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 73 + Math.floor(index / 31)) % 256
  const image = await sharp(pixels, { raw: { width: 640, height: 480, channels: 3 } }).png().toBuffer()
  const fixture = resolve(output, 'isolated-evidence.png'); await writeFile(fixture, image)
  const uploadResponse = page.waitForResponse(response => response.url().endsWith('/uploads') && response.request().method() === 'POST')
  await page.locator('input[type=file][multiple]').setInputFiles(fixture)
  const upload = await uploadResponse; assert.equal(upload.status(), 200)
  await page.locator('.p-upload-thumb img').waitFor()
  await page.locator('.p-upload-thumb img').scrollIntoViewIfNeeded()
  await page.waitForFunction(() => { const image = document.querySelector('.p-upload-thumb img'); return image?.naturalWidth > 0 })
  const uploadedUrl = await page.locator('.p-upload-thumb a').getAttribute('href')
  assert.match(uploadedUrl, /^\/api\/studio\/uploads\/[^/?#]+$/)
  const uploadedId = uploadedUrl.split('/').at(-1)
  const uploadWrite = report.writes.find(item => item.path.endsWith('/uploads'))
  assert.equal(uploadWrite.contentType, 'image/png')
  const original = await fetch(`${base}${uploadedUrl}`, { headers: { Cookie: jars.get('player'), 'X-Studio-Client': 'player' } })
  assert.equal(original.status, 200); assert.deepEqual(Buffer.from(await original.arrayBuffer()), image)
  assert.ok(report.imageReads.some(item => item.path.endsWith(uploadedId) && item.variant === 'thumb'))
  assert.equal(report.imageReads.filter(item => item.path.endsWith(uploadedId) && !item.variant).length, 0)
  ok('完成材料二进制上传保留字节，缩略图真实解码，原图仅由显式预览读取')
  await page.getByRole('button', { name: '提交完成，等待验收', exact: true }).click()
  await page.getByText('正在等待财务验收，本单已释放接单名额。验收通过后报酬计入钱包。').waitFor()
  await action(continuing, 'review-pass')
  await page.reload(); await page.locator('.p-detail-hero .p-badge').filter({ hasText: '已完成' }).waitFor()
  ok('存单恢复→问题单只读→客服关闭→上传→上报→后台验收完整真实链路通过')
  await action(continuing, 'problem-open', { reason: '已完成订单售后问题' })
  const notifications = await api('player', 'player/notifications?current=1&size=30')
  const problemNotice = notifications.records.find(item => item.type === 'problem-open' && item.target?.problemId === (backend.service.orderDetail('admin', continuing.id).order.problem.id))
  assert.ok(problemNotice)
  await visit('/player/messages')
  await page.locator(`[data-notification-id="${problemNotice.id}"]`).click()
  await page.getByText(/本单有待处理问题。当前状态：已完成/).waitFor()
  await page.getByRole('button', { name: '查看当前订单', exact: true }).click()
  await page.getByText('问题单当前仅可查看，请联系后台客服记录处理结果并关闭问题。关闭后是否可以继续操作，以订单当前状态为准。').waitFor()
  assert.equal(await page.getByRole('button', { name: '提交问题反馈', exact: true }).count(), 0)
  ok('真实问题消息重新核对目标并进入只读详情，点击通知不会解除问题限制')
  await visit(`/player/orders/${stored.id}`)
  await page.getByRole('heading', { name: '订单已存单' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: '提交完成材料' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).count(), 0)
  row = await current(stored)
  await action(stored, 'problem-close', { problemId: row.problem.id, reason: '客服处理问题，订单仍保持存单' })
  await page.reload(); await page.getByRole('heading', { name: '订单已存单' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: '提交完成材料' }).count(), 0)
  assert.equal(await page.getByRole('heading', { name: '申请退单' }).count(), 0)
  await visit('/player/tasks?status=stored')
  await page.locator('.p-order-card .p-badge.stored').waitFor()
  ok('存单任务可筛选查看，客服关闭问题不能解除存单只读限制')
  await visit(`/player/orders/${blockedDirect.id}`)
  await page.getByRole('heading', { name: '问题单与处理记录' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '拒绝指定', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '确认拒绝', exact: true }).count(), 0)
  ok('尚未接受的指定问题单也仅可查看，不能接受或拒绝指定')
  await visit(`/player/orders/${refunded.id}`)
  await page.locator('.p-detail-hero .p-badge.refunded').waitFor()
  assert.equal(await page.getByRole('heading', { name: '提交完成材料' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).count(), 0)
  await visit('/player/tasks?status=refunded')
  await page.locator('.p-order-card .p-badge.refunded').waitFor()
  ok('全额退款显示已退款，可筛选回查，旧履约状态不能暴露继续操作入口')
  await visit(`/player/orders/${refundPending.id}`)
  await page.locator('.p-detail-hero .p-badge.refund-pending').waitFor()
  assert.equal(await page.getByRole('heading', { name: '提交完成材料' }).count(), 0)
  await visit('/player/tasks?status=refund-pending')
  await page.locator('.p-order-card .p-badge.refund-pending').waitFor()
  ok('全额退款审批中显示暂停，筛选可见且不提供履约提交入口')
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await page.screenshot({ path: resolve(output, 'refunded-tasks-390.png'), fullPage: true })
  ok('320/390任务筛选与状态展示没有横向溢出')
  assert.equal(report.writes.some(item => item.path.endsWith('/problem-feedback')), false, 'current UI must never send a new player problem feedback')
  assert.deepEqual(report.errors, [])
  report.passed = true
} catch (error) {
  report.failure = error.stack
  throw error
} finally {
  await browser?.close()
  await new Promise(done => client.close(done))
  await new Promise(done => backend.close(done))
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, count: report.cases.length, output, failure: report.failure?.split('\n')[0] }))
}
