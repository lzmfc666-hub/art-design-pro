import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'

// The caller supplies an isolated current build. This script never builds, deploys or opens a real database.
assert.ok(process.env.PLAYER_QA_STATIC_ROOT, 'Supply PLAYER_QA_STATIC_ROOT with an isolated current player build')
const staticRoot = resolve(process.env.PLAYER_QA_STATIC_ROOT)
assert.equal((await stat(resolve(staticRoot, 'index.html'))).isFile(), true)
const output = resolve(process.env.STUDIO_QA_ROOT || 'player-client/.qa', 'cancellation-refund-browser')
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYER_QA_PLAYWRIGHT_ROOT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `isolated-cancellation-${randomUUID()}`
const report = { passed: false, database: ':memory:', cases: [], errors: [], failures: [], abortedReads: [], writes: [],
  limitations: ['Desktop Edge mobile viewports; no physical phone, external push or company-network acceptance.'] }
const jars = new Map(), actorIds = new Map([['admin', 'admin']])
let backend, client, browser, apiBase, base
const ok = name => report.cases.push({ name, passed: true })
async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  if (!server) return
  server.closeAllConnections()
  if (server.listening) await new Promise(done => server.close(done))
}
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
  return api('admin', `orders/${order.id}/action`, { requestId: randomUUID(), action, reason: '取消退款隔离验收',
    expectedRevision: row.revision, assignmentId: row.assignmentId, leaderId: row.leaderId, submissionId: row.submissionId, ...extra })
}
async function claim(order) {
  const row = await api('player', `player/orders/${order.id}`)
  return api('player', `player/orders/${order.id}/claim`, { requestId: randomUUID(), expectedRevision: row.revision, dispatchRound: row.dispatchRound })
}
try {
  backend = createStudioServer({ dbPath: ':memory:', seed: false, password, maintenanceFromEnv: false,
    notificationIntervalMs: 86400000, notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [],
      pushSender: async () => { throw new Error('External delivery prohibited in cancellation acceptance') } } })
  apiBase = await listen(backend)
  client = createPlayerClientServer({ apiTarget: apiBase, staticRoot })
  base = await listen(client)
  await api('admin', 'login', { username: 'admin', password })
  const level = await api('admin', 'levels', { name: '取消退款隔离等级', delaySeconds: 0 })
  const player = await api('admin', 'users', { username: `qa-cancel-${randomUUID()}`, name: '取消退款隔离打手', role: 'player', status: 'active',
    levelId: level.id, maxActiveOrders: 10, permissionOverrides: {}, password })
  actorIds.set('player', player.id)
  await api('player', 'login', { username: player.username, password })
  const customer = await api('admin', 'customers', { name: '取消退款隔离客户', gameId: 'qa-only', contact: 'qa-only' })
  const template = await api('admin', 'templates', { name: '取消退款隔离项目', game: '三角洲行动', description: '仅用于隔离验收', map: '航天基地', amount: 10000, reward: 1201, active: true })
  async function order(title, extra = {}) {
    return api('admin', 'orders', { requestId: randomUUID(), templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun',
      externalOrderNo: randomUUID(), roomCode: 'qa-room', gameId: 'qa-game', amount: 10000, reward: 1201, receivedAmount: 10000,
      paidAt: new Date().toISOString(), dispatchMode: 'pool', playerRemark: title, title, ...extra })
  }
  const canceled = await order('应从日常移除的已取消任务', { dispatchMode: 'direct', assignedTo: player.id })
  const fullRefund = await order('未结算全退当前报酬为零')
  const partialRefund = await order('部分退款保持报酬')
  const settled = await order('已结算全退保留报酬')
  for (const row of [canceled, fullRefund, partialRefund, settled]) await claim(row)
  const originalNotice = (await api('player', 'player/notifications?current=1&size=30')).records.find(row => (row.target?.orderId || row.orderId) === canceled.id)
  assert.ok(originalNotice, 'A genuine pre-cancellation notification must exist')
  const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l0AAAAASUVORK5CYII=', 'base64')
  const image = await api('player', 'uploads', { name: '取消退款隔离凭证.png', mime: 'image/png', data: pixels.toString('base64') })
  let row = await api('player', `player/orders/${settled.id}`)
  await api('player', `player/orders/${settled.id}/submit`, { requestId: randomUUID(), expectedRevision: row.revision, assignmentId: row.assignmentId,
    leaderId: row.leaderId, screenshots: [image], teammateId: null })
  await action(settled, 'review-pass')
  for (const [target, amount] of [[fullRefund, 10000], [partialRefund, 3000], [settled, 10000]])
    await api('admin', 'refunds', { requestId: randomUUID(), orderId: target.id, expectedRevision: (await current(target)).revision, amount, reason: '隔离验收退款' })

  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  assert.equal((await context.request.post(base + '/api/studio/login', { data: { username: player.username, password } })).status(), 200)
  const page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) report.failures.push({ status: response.status(), path: new URL(response.url()).pathname }) })
  page.on('requestfailed', request => {
    const path = new URL(request.url()).pathname, reason = request.failure()?.errorText
    if (request.method() === 'GET' && path.startsWith('/api/studio/') && reason === 'net::ERR_ABORTED')
      report.abortedReads.push(path) // Leaving a page deliberately aborts its authenticated read.
    else report.errors.push(`Request failed: ${path}: ${reason}`)
  })
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/studio/'))
    report.writes.push({ path: new URL(request.url()).pathname, method: request.method() }) })
  const cards = page.locator('.p-order-card')
  await page.goto(base + '/#/player/tasks?status=all')
  await cards.filter({ hasText: canceled.orderNo }).waitFor()
  await action(canceled, 'cancel-refund', { refundAmount: 10000, refundDestination: 'cash', refundChannel: 'wechat', actualRefundConfirmed: true })
  row = await api('player', `player/orders/${canceled.id}`)
  assert.equal(row.status, 'canceled'); assert.equal(row.displayStatus, 'refunded'); assert.equal(row.effectiveReward, 0); assert.equal(row.reward, 1201)
  for (const query of ['scope=mine', 'scope=all', 'scope=direct', 'scope=pool']) {
    const list = await api('player', `player/orders?current=1&size=30&${query}`)
    assert.ok(list.records.every(order => order.status !== 'canceled'))
  }
  await page.getByRole('searchbox', { name: '搜索本人参与历史', exact: true }).fill(canceled.orderNo)
  await page.getByText('没有匹配的任务', { exact: true }).waitFor()
  assert.equal(await cards.count(), 0, 'The last matching canceled row must produce an empty state')
  await page.getByRole('searchbox', { name: '搜索本人参与历史', exact: true }).fill('')
  // Return through KeepAlive, then refresh: neither the old card nor its refunded count may survive.
  await page.locator('.p-nav a[href="#/player/lobby"]').click()
  await page.getByRole('heading', { name: '接单大厅', exact: true, level: 1 }).waitFor()
  await page.locator('.p-nav a[href="#/player/tasks"]').click()
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await cards.filter({ hasText: fullRefund.orderNo }).waitFor()
  assert.equal(await cards.filter({ hasText: canceled.orderNo }).count(), 0)
  await page.getByRole('button', { name: '已退款', exact: true }).click()
  await cards.filter({ hasText: fullRefund.orderNo }).waitFor()
  assert.equal(await cards.count(), 2)
  assert.equal(await cards.filter({ hasText: canceled.orderNo }).count(), 0)
  assert.equal(await cards.filter({ hasText: fullRefund.orderNo }).locator('.p-reward strong').innerText(), '¥ 0.00')
  assert.equal(await cards.filter({ hasText: settled.orderNo }).locator('.p-reward strong').innerText(), '¥ 12.01')
  ok('后台取消后日常任务/大厅与退款计数排除raw canceled，KeepAlive返回及筛选不保留旧卡片')

  const marker = { owner: player.id, family: 'submit', requestId: `cancel-unknown-${randomUUID()}`, createdAt: Date.now() }
  const markerKey = `__studio_player_unconfirmed_v1__:${encodeURIComponent(player.id)}:submit:${encodeURIComponent(marker.requestId)}`
  const markerValue = JSON.stringify(marker)
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: markerKey, value: markerValue })
  await page.goto(`${base}/#/player/orders/${canceled.id}?action=reject`)
  await page.getByRole('heading', { name: canceled.title, exact: true }).waitFor()
  assert.equal(await page.locator('.p-detail-hero .p-reward strong').innerText(), '¥ 0.00')
  await page.getByText(/原订单报酬（历史）¥ 12.01/).waitFor()
  assert.equal(await page.getByRole('heading', { name: '提交完成材料', exact: true }).count(), 0)
  assert.equal(await page.getByRole('heading', { name: '申请退单', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /接受订单|确认拒绝|重新确认当前订单|重试原操作/ }).count(), 0)
  assert.equal(await page.locator('input[type=file]').count(), 0)
  assert.equal(await page.evaluate(key => localStorage.getItem(key), markerKey), markerValue)
  await page.screenshot({ path: resolve(output, 'canceled-readonly-390.png'), fullPage: true })
  ok('取消前的旧详情链接重新GET后仅可看历史及有效报酬，不能接拒上报退单或重试，未知操作标记保留')

  await page.goto(base + '/#/player/messages')
  await page.locator(`[data-notification-id="${originalNotice.id}"]`).click()
  await page.locator('.p-message-current').waitFor()
  await page.getByRole('button', { name: '查看当前订单', exact: true }).click()
  await page.getByRole('heading', { name: canceled.title, exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: '提交完成材料', exact: true }).count(), 0)
  assert.equal(await page.locator('input[type=file]').count(), 0)
  ok('真实旧通知先核对当前服务端，再进入已取消只读详情，不恢复旧操作资格')

  for (const [target, amount, disposition] of [[fullRefund, '¥ 0.00', 'zero-unsettled'], [partialRefund, '¥ 12.01', null], [settled, '¥ 12.01', 'preserve-settled']]) {
    await page.goto(`${base}/#/player/orders/${target.id}`)
    await page.getByRole('heading', { name: target.title, exact: true }).waitFor()
    assert.equal(await page.locator('.p-detail-hero .p-reward strong').innerText(), amount)
    const detail = await api('player', `player/orders/${target.id}`)
    assert.equal(detail.reward, 1201)
    if (disposition) {
      assert.equal(detail.rewardDisposition.mode, disposition)
      assert.deepEqual(Object.keys(detail.rewardDisposition).sort(), ['mode', 'policyVersion', 'trigger'])
    }
    for (const key of ['refundAmount', 'refundChannel', 'refundDestination', 'refundSummary', 'refunds', 'receivedAmount', 'paymentMethod'])
      assert.equal(Object.hasOwn(detail, key), false, `Player must not receive private customer field ${key}`)
  }
  ok('未结算实际全退报酬为零，部分退款与已结算全退保持报酬，原reward保留且不泄露客户资金字段')

  await page.goto(base + '/#/player/tasks?status=stored')
  await page.getByText('这里还没有任务', { exact: true }).waitFor()
  assert.equal(await cards.count(), 0)
  await page.reload()
  await page.getByText('这里还没有任务', { exact: true }).waitFor()
  assert.equal(await cards.count(), 0)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  assert.equal(await page.evaluate(key => localStorage.getItem(key), markerKey), markerValue)
  ok('空态与整页刷新不恢复已取消任务，无横向溢出')
  assert.deepEqual(report.errors, []); assert.deepEqual(report.failures, [])
  assert.ok(report.writes.every(request => /^\/api\/studio\/player\/notifications\/[^/]+\/read$/.test(request.path)), 'Browser inspection may mark a message read but must never write orders or money')
  report.passed = true
} catch (error) {
  report.failure = error.stack || String(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await close(client)
  await close(backend)
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
