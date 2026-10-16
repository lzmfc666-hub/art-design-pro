import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, createECDH, randomBytes, randomUUID } from 'node:crypto'
import { createStudioServer } from '../../server/index.mjs'
import { createServer as createPortProbe } from 'node:net'
import { createServer as createViteServer } from '../node_modules/vite/dist/node/index.js'
import { sourceFingerprint } from '../../scripts/studio-source-fingerprint.mjs'

// New v3.2 reads/UI only. Existing v3.1 safety suites retain their own assertions.
// Browser subscription getter uses a generated fixture: it is not a real device enrollment.
const output = resolve(process.env.STUDIO_QA_ROOT || '.qa/final-closure-20261014/client', 'remaining-v32', `run-${randomUUID()}`)
await mkdir(output, { recursive: true })
const before = sourceFingerprint()
await writeFile(resolve(output, 'source-before.json'), JSON.stringify(before, null, 2))
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `isolated-v32-${randomUUID()}`
let time = new Date('2026-10-14T06:00:00Z')
const clock = () => time
const vapid = createECDH('prime256v1'); vapid.generateKeys()
let externalPushAttempts = 0
const backend = createStudioServer({ dbPath: resolve(output, 'test.sqlite'), seed: false, password, clock, maintenanceFromEnv: false,
  backups: { intervalMinutes: 0, directory: resolve(output, 'backups'), failureWebhook: '' }, notificationIntervalMs: 86_400_000,
  notifications: { clock, publicKey: vapid.getPublicKey().toString('base64url'), privateKey: vapid.getPrivateKey().toString('base64url'),
    subject: 'mailto:isolated-v32@example.test', allowedPushHosts: ['fcm.googleapis.com'],
    pushSender: async () => { externalPushAttempts++; throw new Error('External push prohibited in client QA') } } })
const report = { contract: 'v3.2', output, database: resolve(output, 'test.sqlite'), cases: [], layouts: [], requests: [],
  runtimeErrors: [], failures: [], passed: false, sourceStable: false, limitations: [
    'Desktop Edge with mobile viewport sizes does not validate real Android/iPhone, HTTPS, keyboard/safe areas or mobile networks.',
    'Only browser subscription getter is a generated fixture; binding lookup is real current-source HTTP. No subscription enrollment or phone arrival is claimed.',
    'This targets new client reads; final backend/client write chain and full regression are owned by the combined acceptance run.'
  ] }
const service = backend.service
const mutate = (path, body, actor = 'admin') => {
  time = new Date(time.getTime() + 1000)
  return service.mutate(actor, path, { requestId: randomUUID(), ...body })
}
const current = id => service.orderDetail('admin', id).order
const action = (id, body) => {
  const row = current(id)
  return mutate(`/orders/${id}/action`, { expectedRevision: row.revision, dispatchRound: row.dispatchRound,
    assignmentId: row.assignmentId, leaderId: row.leaderId, submissionId: row.submissionId, ...body })
}
const fingerprints = subscription => {
  const endpoint = new URL(subscription.endpoint).href
  const digest = value => createHash('sha256').update(value).digest('hex')
  return { endpointHash: digest(endpoint), subscriptionHash: digest(JSON.stringify({ endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } })) }
}
const success = (name, details = {}) => report.cases.push({ name, passed: true, ...details })
const jars = new Map(), actorIds = new Map([['admin', 'admin']])
let vite, browser, context, page, apiBase, base
async function freePort() {
  const probe = createPortProbe()
  await new Promise(done => probe.listen(0, '127.0.0.1', done))
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  return port
}
async function api(actor, path, body, expected = 200) {
  const player = actor !== 'admin'
  const response = await fetch(`${apiBase}/api/studio/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...(player ? { 'X-Studio-Client': 'player' } : {}), ...(jars.has(actor) ? { Cookie: jars.get(actor) } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(path === 'login' ? {} : { 'X-Studio-Actor': actorIds.get(actor) }) })
  }, body: body === undefined ? undefined : JSON.stringify(body) })
  const cookie = response.headers.get('set-cookie'); if (cookie) jars.set(actor, cookie.split(';')[0])
  const value = await response.json()
  report.requests.push({ actor, path, method: body === undefined ? 'GET' : 'POST', status: response.status })
  assert.equal(response.status, expected, `${actor} ${path}: ${value.message || response.status}`)
  return value
}
const titles = { lobby: '接单大厅', tasks: '我的任务', wallet: '报酬钱包', withdrawals: '提现记录', ledger: '收支明细', messages: '消息中心', notifications: '通知设置', orders: '任务详情' }
async function visit(path) {
  await page.evaluate(value => { location.hash = `#${value}` }, path)
  const title = path.startsWith('/player/orders/') ? titles.orders : titles[path.split('/').at(-1)?.split('?')[0]]
  if (title) await page.waitForFunction(expected => document.querySelector('.p-header h1')?.textContent?.trim() === expected, title)
  await page.waitForFunction(() => !document.querySelector('.p-spinner'))
}
async function capture(name) { await page.screenshot({ path: resolve(output, `${name}.png`) }) }
async function responseFor(path, operation) {
  const response = page.waitForResponse(item => new URL(item.url()).pathname === `/api/studio/${path}` && item.request().method() === 'GET')
  await operation()
  const actual = await response
  assert.equal(actual.status(), 200, path)
  return actual.json()
}

try {
  const level = mutate('/levels', { name: 'v3.2新增读取隔离等级', delaySeconds: 0 })
  const players = ['A', 'B'].map(name => mutate('/users', { username: `v32-${name}-${randomUUID().slice(0, 8)}`, name: `v3.2隔离打手${name}`,
    role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 20, permissionOverrides: {}, password }))
  actorIds.set('A', players[0].id); actorIds.set('B', players[1].id)
  const customer = mutate('/customers', { name: 'v3.2隔离客户', contact: 'CUSTOMER-PRIVATE-SEARCH-NEVER', gameId: 'CUSTOMER-PRIVATE-GAME' })
  const template = mutate('/templates', { name: '新增读取验证普通任务', game: 'QA', amount: 10000, reward: 1001, description: '打手公开要求', active: true })
  const uniqueTemplate = mutate('/templates', { name: 'GLOBAL-Needle跨页任务', game: 'QA', amount: 10000, reward: 1001, active: true })
  const newOrder = (extra = {}) => mutate('/orders', { templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(),
    roomCode: 'ROOM-PRIVATE-V32', gameId: 'GAME-PRIVATE-V32', amount: 10000, reward: 1001, receivedAmount: 10000, paidAt: time.toISOString(),
    dispatchMode: 'pool', playerRemark: '允许本人查看的说明', remark: 'INTERNAL-PRIVATE-SEARCH-NEVER', ...extra })
  const oldest = newOrder({ templateId: uniqueTemplate.id })
  for (let index = 0; index < 24; index++) newOrder()
  const hidden = newOrder({ templateId: uniqueTemplate.id, dispatchMode: 'direct', assignedTo: players[1].id })
  const rejected = newOrder({ dispatchMode: 'direct', assignedTo: players[0].id })
  mutate(`/player/orders/${rejected.id}/reject`, { expectedRevision: rejected.revision, dispatchRound: rejected.dispatchRound, reason: 'PRIVATE-OLD-REJECT-REASON' }, players[0].id)
  action(rejected.id, { action: 'dispatch', dispatchMode: 'direct', assignedTo: players[1].id })
  let otherRound = current(rejected.id)
  mutate(`/player/orders/${rejected.id}/reject`, { expectedRevision: otherRound.revision, dispatchRound: otherRound.dispatchRound, reason: 'OTHER-PLAYER-REJECT-REASON' }, players[1].id)
  const returned = newOrder({ dispatchMode: 'direct', assignedTo: players[0].id })
  mutate(`/player/orders/${returned.id}/claim`, { expectedRevision: returned.revision, dispatchRound: returned.dispatchRound }, players[0].id)
  let row = current(returned.id)
  mutate(`/player/orders/${returned.id}/return-request`, { expectedRevision: row.revision, assignmentId: row.assignmentId, leaderId: row.leaderId, reason: 'PRIVATE-OLD-RETURN-REASON' }, players[0].id)
  row = current(returned.id)
  action(returned.id, { action: 'return-approve', returnRequestId: row.returnRequests.at(-1).id, reason: 'PRIVATE-OLD-PROCESS-REASON' })
  const transferred = newOrder({ dispatchMode: 'direct', assignedTo: players[0].id })
  mutate(`/player/orders/${transferred.id}/claim`, { expectedRevision: transferred.revision, dispatchRound: transferred.dispatchRound }, players[0].id)
  const live = newOrder({ dispatchMode: 'direct', assignedTo: players[0].id })
  mutate(`/player/orders/${live.id}/claim`, { expectedRevision: live.revision, dispatchRound: live.dispatchRound }, players[0].id)
  for (let index = 0; index < 25; index++) mutate('/player-adjustments', { userId: players[0].id, kind: 'supplement', amount: 1000, reason: `v32隔离补款${index}` })
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
  const qr = service.upload(players[0].id, { name: 'v32隔离收款码.png', mime: 'image/png', data: png })
  mutate('/player/payment-methods', { method: 'wechat', qrCode: qr }, players[0].id)
  for (let index = 0; index < 22; index++) {
    const withdrawal = mutate('/player/withdrawals', { amount: 1, paymentMethod: 'wechat' }, players[0].id)
    mutate(`/player/withdrawals/${withdrawal.id}/cancel`, {}, players[0].id)
  }
  const noticeOrder = newOrder({ dispatchMode: 'direct', assignedTo: players[0].id })
  await new Promise(ready => backend.listen(0, '127.0.0.1', ready))
  apiBase = `http://127.0.0.1:${backend.address().port}`
  process.env.STUDIO_API_TARGET = apiBase
  vite = await createViteServer({ root: resolve('player-client'), configFile: resolve('player-client/vite.config.ts'), cacheDir: resolve(output, 'vite-cache'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true } })
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`
  Object.assign(report, { apiBase, base, fixture: { orders: 31, players: 2, customers: 1, withdrawalRecords: 22, supplementRecords: 25 } })
  await api('admin', 'login', { username: 'admin', password })
  for (const [index, actor] of ['A', 'B'].entries()) await api(actor, 'login', { username: players[index].username, password })
  const receiver = createECDH('prime256v1'); receiver.generateKeys()
  const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/v32-isolated-${randomUUID()}`, keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  await api('A', 'player/push-subscriptions', { subscription })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await context.grantPermissions(['notifications'], { origin: base })
  await context.addInitScript(value => {
    window.__qaSubscription = value
    window.__qaNotificationSideEffects = { register: 0, requestPermission: 0, subscribe: 0 }
    Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => ({ pushManager: {
      getSubscription: async () => window.__qaSubscription ? { endpoint: window.__qaSubscription.endpoint, toJSON: () => window.__qaSubscription } : null,
      subscribe: async () => { window.__qaNotificationSideEffects.subscribe++; throw new Error('Unexpected enrollment') }
    } }) })
    Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: async () => { window.__qaNotificationSideEffects.register++; throw new Error('Unexpected register') } })
    Object.defineProperty(Notification, 'requestPermission', { configurable: true, value: async () => { window.__qaNotificationSideEffects.requestPermission++; throw new Error('Unexpected permission request') } })
  }, subscription)
  page = await context.newPage(); page.setDefaultTimeout(20000)
  page.on('pageerror', cause => report.runtimeErrors.push(cause.message))
  page.on('response', response => {
    if (response.url().includes('/api/studio/')) report.requests.push({ actor: 'browser', path: new URL(response.url()).pathname + new URL(response.url()).search, method: response.request().method(), status: response.status() })
  })
  await page.goto(`${base}/#/player/login`)
  await page.getByLabel('账号', { exact: true }).fill(players[0].username)
  await page.locator('input[name=password]').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/#/player/lobby')

  const queueBefore = service.db.prepare('SELECT COUNT(*) n FROM player_push_outbox').get().n
  const auditsBefore = service.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n
  await visit('/player/notifications')
  await page.getByText('后台已确认当前账号绑定有效', { exact: true }).waitFor()
  const statusRequest = report.requests.filter(item => item.actor === 'browser' && item.path.startsWith('/api/studio/player/push-subscriptions/status')).at(-1)
  const hashes = fingerprints(subscription), query = new URL(statusRequest.path, base).searchParams
  assert.equal(query.get('endpointHash'), hashes.endpointHash); assert.equal(query.get('subscriptionHash'), hashes.subscriptionHash)
  assert.ok(!statusRequest.path.includes(subscription.endpoint) && !statusRequest.path.includes(subscription.keys.auth))
  assert.equal(service.db.prepare('SELECT COUNT(*) n FROM player_push_outbox').get().n, queueBefore)
  assert.equal(service.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, auditsBefore)
  assert.deepEqual(await page.evaluate(() => window.__qaNotificationSideEffects), { register: 0, requestPermission: 0, subscribe: 0 })
  success('ordinary settings open reads generated browser subscription fingerprint over real HTTP, verifies current binding without side effects')
  await api('B', 'player/push-subscriptions', { subscription })
  await visit('/player/lobby'); await visit('/player/notifications')
  await page.getByText('未绑定当前账号或已失效', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '发送测试提醒', exact: true }).count(), 0)
  success('same browser fingerprint rebound elsewhere displays only unbound, with no other identity and no automatic rebind')
  await api('A', 'player/push-subscriptions', { subscription })
  await page.evaluate(() => { window.__qaSubscription = { ...window.__qaSubscription, keys: { ...window.__qaSubscription.keys, auth: 'browser-content-changed' } } })
  await visit('/player/lobby'); await visit('/player/notifications')
  await page.getByText('本机订阅与后台绑定不一致', { exact: true }).waitFor()
  success('current account endpoint with mismatched full subscription fingerprint displays invalid')
  await page.evaluate(value => { window.__qaSubscription = value }, subscription)

  await visit(`/player/orders/${transferred.id}`)
  await page.getByText('ROOM-PRIVATE-V32', { exact: true }).waitFor()
  await page.getByPlaceholder('说明无法继续执行的原因').fill('PRIVATE-LOCAL-RETURN-DRAFT')
  action(transferred.id, { action: 'release', reason: '隔离解除旧负责人' })
  action(transferred.id, { action: 'dispatch', dispatchMode: 'direct', assignedTo: players[1].id })
  await responseFor(`player/orders/${transferred.id}`, () => page.evaluate(() => window.dispatchEvent(new Event('focus'))))
  await page.getByText('本人参与历史摘要', { exact: true }).waitFor()
  const historyText = await page.locator('.p-main').innerText()
  for (const value of ['ROOM-PRIVATE-V32', 'GAME-PRIVATE-V32', 'PRIVATE-LOCAL-RETURN-DRAFT']) assert.ok(!historyText.includes(value), value)
  assert.equal(await page.locator('textarea,input[type=file]').count(), 0)
  assert.equal(await page.getByRole('button', { name: '提交退单申请', exact: true }).count(), 0)
  success('live private detail and local draft become safe history summary after real release/reassignment; no private form or write survives')

  await visit('/player/tasks?status=all')
  const history = await api('A', 'player/orders?current=1&size=100&scope=mine&sortBy=participatedAt')
  for (const id of [rejected.id, returned.id, transferred.id]) {
    const record = history.records.find(item => item.id === id)
    assert.ok(record?.historyOnly); assert.equal(record.participation, 'historical')
    const serialized = JSON.stringify(record)
    for (const value of ['ROOM-PRIVATE-V32', 'GAME-PRIVATE-V32', 'CUSTOMER-PRIVATE-SEARCH-NEVER', 'INTERNAL-PRIVATE-SEARCH-NEVER', 'OTHER-PLAYER-REJECT-REASON']) assert.ok(!serialized.includes(value), `history ${id} exposed ${value}`)
    assert.equal(record.canClaim, false); assert.equal(record.canSubmit, false)
    assert.ok(!record.assignments?.length && !record.submissions?.length)
    assert.equal(await page.locator(`a[href*="/player/orders/${id}"]`).count(), 0)
  }
  assert.equal(history.total, 4)
  assert.ok(JSON.stringify(history.records.find(item => item.id === rejected.id)).includes('PRIVATE-OLD-REJECT-REASON'))
  assert.ok(JSON.stringify(history.records.find(item => item.id === returned.id)).includes('PRIVATE-OLD-RETURN-REASON'))
  success('mine includes approved-return, rejected-direct and reassigned history; history cards have no detail link, private execution fields or other player reasons, while own existing reasons remain', { total: history.total, counts: history.counts })
  await page.getByRole('button', { name: '全部授权任务', exact: true }).click()
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.getByLabel('搜索全部授权任务', { exact: true }).fill('global-needle')
  await page.getByText('GLOBAL-Needle跨页任务', { exact: true }).waitFor()
  await page.getByText('共 1 条 · 第 1 / 1 页', { exact: true }).waitFor()
  const searched = await api('A', 'player/orders?current=1&size=20&scope=all&keyword=global-needle')
  assert.equal(searched.total, 1); assert.equal(searched.records[0].id, oldest.id); assert.ok(!searched.records.some(item => item.id === hidden.id))
  for (const keyword of ['CUSTOMER-PRIVATE-SEARCH-NEVER', 'INTERNAL-PRIVATE-SEARCH-NEVER']) {
    await page.getByLabel('搜索全部授权任务', { exact: true }).fill(keyword)
    await page.getByText('没有匹配的任务', { exact: true }).waitFor()
  }
  await page.getByLabel('搜索全部授权任务', { exact: true }).fill('')
  success('server keyword finds an authorized order beyond the original page with real total; other player assignment/private fields never match')

  await visit('/player/withdrawals')
  await page.getByText('共 22 条 · 第 1 / 2 页', { exact: true }).waitFor()
  const firstWithdrawal = await api('A', 'player/withdrawals?current=1&size=20')
  const nextWithdrawal = await responseFor('player/withdrawals', () => page.getByRole('button', { name: '下一页', exact: true }).click())
  assert.equal(nextWithdrawal.total, 22); assert.equal(nextWithdrawal.records.length, 2)
  assert.ok(!nextWithdrawal.records.some(record => firstWithdrawal.records.some(first => first.id === record.id)))
  await page.getByLabel('提现状态', { exact: true }).selectOption('pending')
  await page.getByText('共 0 条 · 第 1 / 1 页', { exact: true }).waitFor()
  await page.getByLabel('提现状态', { exact: true }).selectOption('canceled')
  await page.getByText('共 22 条 · 第 1 / 2 页', { exact: true }).waitFor()
  await page.getByLabel('提现开始日期', { exact: true }).fill('2026-10-14')
  await page.getByLabel('提现结束日期', { exact: true }).fill('2026-10-14')
  await page.getByText('共 22 条 · 第 1 / 2 页', { exact: true }).waitFor()
  success('withdrawal record page uses independent real pagination, status and Shanghai-date filters without altering snapshots or amounts')
  await visit('/player/ledger')
  await page.getByLabel('流水类型', { exact: true }).selectOption('supplement')
  await page.getByText('共 25 条 · 第 1 / 2 页', { exact: true }).waitFor()
  const nextLedger = await responseFor('player/wallet/ledger', () => page.getByRole('button', { name: '下一页', exact: true }).click())
  assert.equal(nextLedger.total, 25); assert.equal(nextLedger.records.length, 5)
  await page.getByLabel('账本开始日期', { exact: true }).fill('2026-10-14')
  await page.getByLabel('账本结束日期', { exact: true }).fill('2026-10-14')
  await visit('/player/wallet')
  await page.locator('.p-wallet-preview strong').waitFor()
  const summary = await api('A', 'player/wallet?includeRecords=false')
  assert.equal(summary.available, 25000); assert.equal(summary.weeklyUsed, 0)
  assert.deepEqual(summary.withdrawals, []); assert.deepEqual(summary.ledger, [])
  assert.match(await page.locator('.p-wallet-preview').innerText(), /250\.00/)
  assert.ok(report.requests.some(item => item.actor === 'browser' && item.path === '/api/studio/player/wallet?includeRecords=false'))
  success('ledger independent pagination does not calculate balance; wallet uses complete authoritative summary and natural-week count')

  const notices = await api('A', 'player/notifications?current=1&size=100')
  const oldNotice = notices.records.find(item => item.orderId === noticeOrder.id && item.type === 'assigned')
  assert.ok(oldNotice?.target); assert.equal(oldNotice.target.dispatchRound, noticeOrder.dispatchRound)
  assert.deepEqual(Object.keys(oldNotice.target).sort(), ['assignmentId', 'dispatchRound', 'orderId', 'submissionId'])
  await visit('/player/messages')
  await page.locator(`[data-notification-id="${oldNotice.id}"]`).waitFor()
  action(noticeOrder.id, { action: 'dispatch', dispatchMode: 'direct', assignedTo: players[0].id })
  const message = await responseFor(`player/notifications/${oldNotice.id}`, () => page.locator(`[data-notification-id="${oldNotice.id}"]`).click())
  assert.ok(message.invalidatedAt); assert.equal(message.target.dispatchRound, noticeOrder.dispatchRound)
  await page.locator('.p-message-current').waitFor()
  assert.match(await page.locator('.p-message-current').innerText(), /旧派单、接单或材料目标已变化/)
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).count(), 0)
  success('cached notification clicks exact single read and latest authorized order; original target remains old after same-player redispatch')

  for (const width of [320, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 })
    for (const path of ['/player/tasks?status=all', '/player/lobby', '/player/wallet', '/player/withdrawals', '/player/ledger', '/player/messages', '/player/notifications', `/player/orders/${live.id}`, `/player/orders/${transferred.id}`]) {
      await visit(path)
      const layout = await page.evaluate(() => {
        const main = document.querySelector('.p-main'), nav = document.querySelector('.p-nav'), app = document.querySelector('.player-app')
        const controls = [...document.querySelectorAll('.p-main button,.p-main input,.p-main select,.p-main textarea')].filter(element => element.getBoundingClientRect().width > 0)
        const history = [...main.querySelectorAll('[role="status"]')].find(element => element.textContent.includes('本人参与历史摘要'))
        const historyHeading = history?.querySelector('h3')?.getBoundingClientRect()
        const historyReturn = history?.querySelector('a')?.getBoundingClientRect()
        return { width: innerWidth, page: document.documentElement.scrollWidth, app: app.scrollWidth, appClient: app.clientWidth,
          main: main.scrollWidth, mainClient: main.clientWidth, bottom: nav.getBoundingClientRect().bottom, navTop: nav.getBoundingClientRect().top,
          mainBottom: main.getBoundingClientRect().bottom, controls: controls.length,
          history: history ? { headingWidth: historyHeading?.width, returnWidth: historyReturn?.width,
            returnHeight: historyReturn?.height, returnLeft: historyReturn?.left, returnRight: historyReturn?.right } : null,
          outOfBounds: controls.filter(element => { const rect = element.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1 }).map(element => element.textContent || element.getAttribute('aria-label')) }
      })
      assert.ok(layout.page <= width + 1 && layout.app <= layout.appClient + 1 && layout.main <= layout.mainClient + 1, JSON.stringify({ path, layout }))
      assert.ok(layout.mainBottom <= layout.navTop + 2 && Math.abs(layout.bottom - 844) <= 2)
      assert.deepEqual(layout.outOfBounds, [])
      if (layout.history) {
        assert.ok(layout.history.headingWidth >= 150 && layout.history.returnWidth >= 100 && layout.history.returnHeight <= 60,
          `history heading and return action must remain readable: ${JSON.stringify({ path, layout })}`)
        assert.ok(layout.history.returnLeft >= -1 && layout.history.returnRight <= width + 1)
      }
      report.layouts.push({ path, ...layout })
      if (width === 320 || width === 390) await capture(`layout-${path.split('/')[2].split('?')[0]}-${path.includes(transferred.id) ? 'history-' : ''}${width}`)
    }
  }
  success('new pages and current/history detail controls fit 320/390/430/768 widths with safe navigation', { layouts: report.layouts.length })
  assert.deepEqual(report.runtimeErrors, []); assert.equal(externalPushAttempts, 0)
  report.passed = true
} catch (cause) {
  report.failures.push({ message: cause.message, stack: cause.stack }); process.exitCode = 1
  if (page && !page.isClosed()) await capture('failure').catch(() => {})
} finally {
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
  backend.closeAllConnections?.(); await new Promise(done => backend.close(done))
  const after = sourceFingerprint()
  report.sourceStable = before.digest === after.digest
  report.changedSourceFiles = Object.keys(after.files).filter(path => before.files[path] !== after.files[path])
  await writeFile(resolve(output, 'source-after.json'), JSON.stringify(after, null, 2))
  report.finalVersionValid = report.passed && report.sourceStable
  report.externalPushAttempts = externalPushAttempts
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, finalVersionValid: report.finalVersionValid, sourceStable: report.sourceStable,
    cases: report.cases.length, layouts: report.layouts.length, requests: report.requests.length, failures: report.failures.map(item => item.message), output }))
}
