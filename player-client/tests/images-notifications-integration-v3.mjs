import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createECDH, randomBytes, randomUUID } from 'node:crypto'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'

// Isolated client acceptance only. Backend imports are read-only; every business
// setup/write below uses actual HTTP and its own :memory: database and random ports.
const notifyRoundOnly = process.env.PLAYER_QA_NOTIFICATION_ONLY === 'true'
const output = resolve(process.env.STUDIO_QA_ROOT || 'player-client/.qa', 'integration-v3', notifyRoundOnly ? 'notification-rounds' : '')
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `client-qa-${randomUUID()}`
let blockedExternalPushAttempts = 0
const vapid = createECDH('prime256v1'); vapid.generateKeys()
const backend = createStudioServer({ dbPath: ':memory:', seed: false, password,
  notificationIntervalMs: 86_400_000,
  notifications: { publicKey: vapid.getPublicKey().toString('base64url'), privateKey: vapid.getPrivateKey().toString('base64url'), subject: 'mailto:isolated-client-qa@example.test',
    // A fail-closed guard, not a successful mock delivery. No external recipient may be contacted.
    pushSender: async () => { blockedExternalPushAttempts++; throw new Error('External push disabled in isolated client QA') } } })
await new Promise((done) => backend.listen(0, '127.0.0.1', done))
const apiBase = `http://127.0.0.1:${backend.address().port}`
const client = createPlayerClientServer({ apiTarget: apiBase, staticRoot: resolve('player-client/dist') })
await new Promise((done) => client.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${client.address().port}`
const report = { contract: 'v3 image/notification suite adapted to v3.2 (2026-10-14)', database: ':memory:', apiBase, base,
  cases: [], layouts: [], requests: [], runtimeErrors: [], limitations: [
    'Chromium desktop mobile sizes and browser permission configuration do not replace Android/iPhone.',
    'Rebinding uses isolated legal endpoint/key fixture over real HTTP; no external push is sent and no phone arrival is claimed.',
    'No-subscription settings now read current-account binding status; generated endpoint fixture does not prove browser/phone enrollment.',
    'No HTTPS, lock-screen, closed-app or Mainland mobile network push validation.'
  ], failures: [], passed: false }
const jars = new Map(), actorIds = new Map([['admin', 'admin']])
async function api(actor, path, body, { expected = 200 } = {}) {
  const player = actor?.startsWith('player'), origin = player ? base : apiBase
  const response = await fetch(`${origin}/api/studio/${path.replace(/^\//, '')}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(path === 'login' ? {} : { 'X-Studio-Actor': actorIds.get(actor) }) }), ...(player ? { 'X-Studio-Client': 'player' } : {}), ...(jars.get(actor) ? { Cookie: jars.get(actor) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const cookie = response.headers.get('set-cookie')
  if (cookie) jars.set(actor, cookie.split(';')[0])
  const value = await response.json()
  report.requests.push({ actor, path, method: body === undefined ? 'GET' : 'POST', status: response.status, code: value.code || null })
  assert.equal(response.status, expected, `${actor} ${path}: ${value.message || response.status}`)
  return value
}
const success = (name, details = {}) => report.cases.push({ name, passed: true, ...details })
const uploads = []
backend.on('request', (req) => {
  if (req.url === '/api/studio/uploads' && req.method === 'POST') uploads.push(Date.now())
})
let browser, context, page
try {
  await api('admin', 'login', { username: 'admin', password })
  const level = await api('admin', 'levels', { name: '客户端联调等级', delaySeconds: 0 })
  const users = {}
  for (const role of ['support', 'finance', 'playerA', 'playerB']) {
    users[role] = await api('admin', 'users', { username: `client-integration-${role}`, name: `独立联调${role}`, role: role.startsWith('player') ? 'player' : role,
      status: 'active', levelId: level.id, maxActiveOrders: 2, permissionOverrides: {}, password })
    actorIds.set(role, users[role].id)
    await api(role, 'login', { username: users[role].username, password })
  }
  const customer = await api('support', 'customers', { name: '隔离客户', contact: 'INTERNAL-CONTACT-NEVER-DISPLAY', gameId: '000123' })
  const template = await api('admin', 'templates', { name: '通知与图片联调订单', game: '三角洲行动', amount: 10000, reward: 1001, description: '测试服务要求', map: '长弓溪谷', active: true })
  const order = async (overrides = {}) => api('support', 'orders', { requestId: randomUUID(), templateId: template.id, customerId: customer.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'PRIVATE-ROOM-CODE', gameId: 'PRIVATE-GAME-ID', amount: 10000,
    reward: 1001, receivedAmount: 10000, paidAt: new Date().toISOString(), dispatchMode: 'pool', remark: 'INTERNAL-REMARK-NEVER-DISPLAY', playerRemark: '打手可见说明：按约定路线执行。' + '较长说明'.repeat(40), ...overrides })
  const direct = await order({ dispatchMode: 'direct', assignedTo: users.playerA.id })
  for (let index = 0; index < 13; index++) await order()
  const firstPage = await api('playerA', 'player/orders?current=1&size=10&scope=all')
  const secondPage = await api('playerA', 'player/orders?current=2&size=10&scope=all')
  assert.equal(firstPage.total, 14); assert.equal(firstPage.records.length, 10); assert.equal(secondPage.records.length, 4)
  success('actual backend pagination returns 14 total across 10 + 4 records')

  // A real endpoint-binding contract test, with no external sender invocation.
  const receiver = createECDH('prime256v1'); receiver.generateKeys()
  const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/isolated-client-${randomUUID()}`,
    keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  await api('playerA', 'player/push-subscriptions', { subscription })
  const originalBinding = backend.service.db.prepare('SELECT id FROM player_push_subscriptions WHERE user_id=?').get(users.playerA.id)
  await order({ dispatchMode: 'direct', assignedTo: users.playerA.id })
  const queueBefore = backend.service.db.prepare('SELECT COUNT(*) n FROM player_push_outbox WHERE subscription_id=? AND status=?').get(originalBinding.id, 'pending').n
  assert.ok(queueBefore > 0)
  await api('playerA', 'player/push-subscriptions', { subscription })
  assert.equal(backend.service.db.prepare('SELECT id FROM player_push_subscriptions WHERE user_id=?').get(users.playerA.id).id, originalBinding.id)
  assert.equal(backend.service.db.prepare('SELECT COUNT(*) n FROM player_push_outbox WHERE subscription_id=? AND status=?').get(originalBinding.id, 'pending').n, queueBefore)
  await api('playerB', 'player/push-subscriptions', { subscription })
  assert.equal(backend.service.db.prepare('SELECT COUNT(*) n FROM player_push_subscriptions WHERE user_id=?').get(users.playerA.id).n, 0)
  assert.equal(backend.service.db.prepare('SELECT COUNT(*) n FROM player_push_outbox WHERE subscription_id=? AND status=?').get(originalBinding.id, 'pending').n, 0)
  success('same-account endpoint rebind preserves binding and pending queue; cross-account rebind invalidates old queue', { scope: 'real HTTP + read-only SQL on isolated DB, not a real device subscription or delivery' })

  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => report.runtimeErrors.push(error.message))
  page.on('response', (response) => { if (response.url().includes('/api/studio/')) report.requests.push({ actor: 'browser', path: new URL(response.url()).pathname, status: response.status(), method: response.request().method() }) })
  const login = async (actor, reload = true) => {
    if (reload) await page.goto(`${base}/#/player/login`)
    else await page.evaluate(() => { location.hash = '#/player/login' })
    await page.getByLabel('账号', { exact: true }).fill(users[actor].username)
    await page.locator('input[name=password]').fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/#/player/lobby'); await page.locator('.p-header h1').waitFor()
  }
  const titles = { notifications: '通知设置', messages: '消息中心', profile: '个人资料', payment: '收款码', me: '我的', tasks: '我的任务', lobby: '接单大厅' }
  const visit = async (path) => {
    await page.evaluate((next) => { location.hash = `#${next}` }, path)
    await page.waitForFunction((next) => location.hash === `#${next}`, path)
    const title = titles[path.split('/').at(-1)]
    if (title) await page.waitForFunction((expected) => document.querySelector('.p-header h1')?.textContent?.trim() === expected, title)
    await page.waitForFunction(() => !document.querySelector('.p-spinner'))
  }
  const capture = async (name) => page.screenshot({ path: `${output}/${name}.png` })
  await login('playerA')
  assert.equal(await page.getByText('INTERNAL-CONTACT-NEVER-DISPLAY').count(), 0)
  assert.equal(await page.getByText('INTERNAL-REMARK-NEVER-DISPLAY').count(), 0)

  await context.grantPermissions([], { origin: base })
  const writesBefore = report.requests.filter((item) => item.actor === 'browser' && item.method === 'POST' && /push-subscriptions/.test(item.path)).length
  await visit('/player/notifications')
  assert.equal(await page.evaluate(() => Notification.permission), 'denied')
  await page.getByText('已拒绝', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '授权并绑定本机通知' }).isDisabled(), true)
  assert.ok(await page.getByText('未绑定当前账号或已失效', { exact: true }).count())
  assert.equal(report.requests.filter((item) => item.actor === 'browser' && item.method === 'POST' && /push-subscriptions/.test(item.path)).length, writesBefore)
  await capture('notification-denied-390')
  success('browser permission denial is displayed; opening settings does not bind or generate test notifications', { scope: 'real Chromium permission setting, not physical-device authorization' })
  const checkboxes = page.locator('.p-toggle-row input')
  const settingsReload = page.waitForResponse((response) => response.url().endsWith('/player/notification-settings') && response.request().method() === 'GET')
  await checkboxes.nth(1).uncheck()
  await settingsReload
  assert.equal((await api('playerA', 'player/notification-settings')).push, false)
  const queueCount = backend.service.db.prepare('SELECT COUNT(*) n FROM player_push_outbox WHERE status=?').get('pending').n
  await order({ dispatchMode: 'direct', assignedTo: users.playerA.id })
  assert.equal(backend.service.db.prepare('SELECT COUNT(*) n FROM player_push_outbox WHERE status=?').get('pending').n, queueCount)
  assert.ok((await api('playerA', 'player/notifications')).records.some((item) => item.type === 'assigned'))
  success('push switch saves false over actual HTTP; station assignment messages remain and no new external queue is created')

  await visit('/player/messages')
  const targetNotification = (await api('playerA', 'player/notifications')).records.find((item) => item.orderId === direct.id)
  assert.ok(targetNotification)
  const beforeRedispatch = await api('support', `orders/${direct.id}`)
  await api('support', `orders/${direct.id}/action`, { requestId: randomUUID(), expectedRevision: beforeRedispatch.order.revision,
    action: 'dispatch', dispatchMode: 'direct', assignedTo: users.playerA.id })
  const redispatchNotices = await api('playerA', 'player/notifications')
  assert.ok(redispatchNotices.records.find((item) => item.id === targetNotification.id).invalidatedAt)
  assert.ok(redispatchNotices.records.some((item) => item.orderId === direct.id && item.id !== targetNotification.id && !item.invalidatedAt))
  const orderReadsBefore = report.requests.filter((item) => item.actor === 'browser' && item.path === `/api/studio/player/orders/${direct.id}`).length
  await page.locator(`[data-notification-id="${targetNotification.id}"]`).click()
  await page.locator('.p-message-current').waitFor()
  assert.match(await page.locator('.p-message-current').innerText(), /这条提醒已失效，请重新确认当前订单/)
  assert.equal(report.requests.filter((item) => item.actor === 'browser' && item.path === `/api/studio/player/orders/${direct.id}`).length, orderReadsBefore + 1)
  const latestTarget = await api('playerA', `player/orders/${direct.id}`)
  assert.equal(latestTarget.status, 'pending'); assert.equal(latestTarget.assignedTo, users.playerA.id)
  assert.ok(latestTarget.dispatchRound > beforeRedispatch.order.dispatchRound)
  await capture('same-player-redispatch-invalidated-390')
  await page.getByRole('button', { name: '返回消息', exact: true }).click()
  success('same-person redispatch invalidates old reminder; clicking its cached row refreshes notification validity and current order without inviting acceptance of old round')
  const current = await api('support', `orders/${direct.id}`)
  await api('support', `orders/${direct.id}/action`, { requestId: randomUUID(), expectedRevision: current.order.revision, action: 'cancel', reason: '隔离验证通知过期' })
  // Select by the actual message ID, even when a new round changes list ordering.
  await page.locator(`[data-notification-id="${targetNotification.id}"]`).click()
  await page.locator('.p-message-current').waitFor()
  assert.match(await page.locator('.p-message-current').innerText(), /已取消|提醒已变化|重新分配/)
  assert.ok(await page.getByRole('button', { name: '返回消息', exact: true }).count())
  await capture('stale-notification-390')
  const updated = await api('playerA', 'player/notifications')
  assert.ok(updated.records.find((item) => item.id === targetNotification.id).readAt)
  await api('playerA', `player/orders/${direct.id}`, undefined, { expected: 403 })
  const canceledOrder = await api('support', `orders/${direct.id}`)
  assert.equal(canceledOrder.order.status, 'canceled'); assert.equal(canceledOrder.order.leaderId, null)
  success('stale actual assignment notification reads current canceled order and provides return action; marking read cannot accept it')

  if (!notifyRoundOnly) {
  const source = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4800
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 4800, 4800); ctx.fillStyle = '#161616'; ctx.font = '110px sans-serif'
    for (let y = 150; y < 4800; y += 160) ctx.fillText('清晰测试图，仅用于隔离联调 1234567890', 100, y)
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'))
    const data = await new Promise((done) => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).split(',')[1]); reader.readAsDataURL(blob) })
    return { size: blob.size, data }
  })
  const imagePayload = { name: '隔离清晰测试.png', mimeType: 'image/png', buffer: Buffer.from(source.data, 'base64') }
  await visit('/player/profile')
  await page.evaluate(() => {
    window.__imageStages = []
    const observer = new MutationObserver(() => { const text = document.querySelector('.p-upload-state')?.textContent || ''; if (text) window.__imageStages.push(text) })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true }); window.__imageObserver = observer
  })
  const avatarResponse = page.waitForResponse((response) => response.url().endsWith('/uploads') && response.request().method() === 'POST')
  await page.locator('input[type=file]').setInputFiles(imagePayload)
  const uploadedAvatar = await (await avatarResponse).json()
  await page.getByText('图片已上传，保存时会沿用这张图片。', { exact: true }).waitFor()
  const avatarRequest = (await avatarResponse).request()
  assert.equal(avatarRequest.headers()['content-type'], 'image/png'); assert.ok(uploadedAvatar.size < source.size)
  const avatarBitmap = await page.evaluate(async (url) => { const blob = await (await fetch(url, { cache: 'no-store' })).blob(); const bitmap = await createImageBitmap(blob); const size = [bitmap.width, bitmap.height]; bitmap.close(); return size }, uploadedAvatar.url)
  assert.deepEqual(avatarBitmap, [1024, 1024])
  const stages = await page.evaluate(() => { window.__imageObserver.disconnect(); return window.__imageStages })
  assert.ok(stages.some((text) => /图片|上传/.test(text)))
  await page.getByLabel('昵称', { exact: true }).fill('头像迟到隔离A')
  await visit('/player/me'); await visit('/player/profile')
  assert.equal(await page.getByLabel('昵称', { exact: true }).inputValue(), '头像迟到隔离A')
  await page.waitForFunction(() => { const image = document.querySelector('.p-avatar-editor img'); return image?.naturalWidth > 0 && image.src.startsWith('blob:') })
  const countBeforeProfile = uploads.length
  let profileDropped = false
  await page.route('**/api/studio/profile', async (route) => {
    if (route.request().method() === 'POST' && !profileDropped) { profileDropped = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed') }
    else await route.continue()
  })
  await page.getByRole('button', { name: '保存资料', exact: true }).click()
  await page.getByRole('button', { name: '核对保存结果', exact: true }).waitFor()
  assert.equal(await page.getByLabel('昵称', { exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '核对保存结果', exact: true }).click()
  await page.getByText('资料已保存', { exact: true }).waitFor()
  assert.equal(uploads.length, countBeforeProfile)
  await page.unroute('**/api/studio/profile')
  success('real avatar upload uses lossless 1024 compression, progress and navigation draft; lost save response is verified without reupload', { uploadCount: uploads.length, observedStages: stages.length })

  await visit('/player/payment')
  const qrResponse = page.waitForResponse((response) => response.url().endsWith('/uploads') && response.request().method() === 'POST')
  await page.locator('input[type=file]').first().setInputFiles(imagePayload)
  const uploadedQr = await (await qrResponse).json()
  await page.getByRole('button', { name: '保存微信收款码', exact: true }).waitFor()
  const qrBitmap = await page.evaluate(async (url) => { const blob = await (await fetch(url, { cache: 'no-store' })).blob(); const bitmap = await createImageBitmap(blob); const size = [bitmap.width, bitmap.height]; bitmap.close(); return size }, uploadedQr.url)
  assert.deepEqual(qrBitmap, [4096, 4096])
  await visit('/player/me'); await visit('/player/payment')
  await page.waitForFunction(() => { const image = document.querySelector('.p-qr-preview'); return image?.naturalWidth > 0 && image.src.startsWith('blob:') })
  assert.equal(await page.locator('a[aria-label="查看收款码原图"]').first().getAttribute('href'), uploadedQr.url)
  const countBeforePayment = uploads.length
  let paymentDropped = false
  await page.route('**/api/studio/player/payment-methods', async (route) => {
    if (route.request().method() === 'POST' && !paymentDropped) { paymentDropped = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed') }
    else await route.continue()
  })
  await page.getByRole('button', { name: '保存微信收款码', exact: true }).click()
  await page.getByRole('button', { name: '核对保存结果', exact: true }).waitFor()
  await page.getByRole('button', { name: '核对保存结果', exact: true }).click()
  await page.getByText('已核对，收款码已保存，新提现申请使用此资料。', { exact: true }).waitFor()
  assert.equal(uploads.length, countBeforePayment)
  assert.equal((await api('playerA', 'player/payment-methods'))[0].qrCode.id, uploadedQr.id)
  await page.unroute('**/api/studio/player/payment-methods')
  success('real payment image keeps lossless 4096 QR detail; successful attachment survives navigation/lost save response and is not reuploaded')
  const privateResponse = await context.request.get(new URL(uploadedQr.url, base).href)
  assert.equal(privateResponse.status(), 200); assert.match(privateResponse.headers()['cache-control'], /no-store/)
  await page.evaluate(async () => { await navigator.serviceWorker.register('/player-sw.js', { scope: '/' }); await navigator.serviceWorker.ready })
  const offlineKeys = await page.evaluate(async () => (await caches.keys()).map(String))
  assert.deepEqual(offlineKeys, [])
  const workerSource = await (await context.request.get(`${base}/player-sw.js`)).text()
  assert.doesNotMatch(workerSource, /addEventListener\(['"](?:fetch|sync)['"]|caches\.open|indexedDB/)
  success('actual private image response is no-store; registered notification worker creates no offline cache or write replay')

  let releaseLate, capturedLate
  const gate = new Promise((done) => { releaseLate = done })
  const captured = new Promise((done) => { capturedLate = done })
  let held = false
  await page.route('**/api/studio/player/profile', async (route) => {
    if (!held && route.request().method() === 'GET') { held = true; const response = await route.fetch(); assert.equal(response.status(), 200); capturedLate(); await gate; try { await route.fulfill({ response }) } catch {} }
    else await route.continue()
  })
  await page.evaluate(() => { location.hash = '#/player/profile' })
  await captured
  await login('playerB', false)
  releaseLate(); await page.unroute('**/api/studio/player/profile')
  await visit('/player/profile')
  assert.equal(await page.getByLabel('昵称', { exact: true }).inputValue(), users.playerB.name)
  assert.equal(await page.getByText('头像迟到隔离A', { exact: true }).count(), 0)
  assert.equal(await page.locator('.p-avatar-editor img').count(), 0)
  await visit('/player/payment')
  assert.equal(await page.locator('.p-qr-preview').count(), 0)
  await visit('/player/messages')
  assert.equal(await page.locator('.p-message').count(), 0)
  const cannotRead = await context.request.get(new URL(uploadedQr.url, base).href)
  assert.equal(cannotRead.status(), 403)
  success('held actual old-account response cannot populate the new account; drafts/messages/private images remain isolated')

  await login('playerA')
  for (const width of [320, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 })
    for (const path of ['/player/notifications', '/player/messages', '/player/payment', '/player/profile']) {
      await visit(path)
      const layout = await page.evaluate(() => {
        const main = document.querySelector('.p-main'), nav = document.querySelector('.p-nav'), app = document.querySelector('.player-app')
        return { width: innerWidth, page: document.documentElement.scrollWidth, app: app.scrollWidth, appClient: app.clientWidth, main: main.scrollWidth, mainClient: main.clientWidth,
          bottom: nav.getBoundingClientRect().bottom, navTop: nav.getBoundingClientRect().top, mainBottom: main.getBoundingClientRect().bottom }
      })
      assert.ok(layout.page <= width + 1); assert.ok(layout.app <= layout.appClient + 1); assert.ok(layout.main <= layout.mainClient + 1)
      assert.ok(layout.mainBottom <= layout.navTop + 2); assert.ok(Math.abs(layout.bottom - 844) <= 2)
      report.layouts.push({ path, ...layout })
      if (width === 320 || width === 390) await capture(`layout-${path.split('/').at(-1)}-${width}`)
    }
  }
  success('notification/payment/profile/message layouts fit 320/390/430/768 with fixed safe navigation', { layouts: report.layouts.length })
  }
  assert.deepEqual(report.runtimeErrors, [])
  assert.equal(blockedExternalPushAttempts, 0, 'client test must never attempt external delivery')
  report.passed = true
} catch (cause) {
  report.failures.push({ message: cause.message, stack: cause.stack })
  if (page && !page.isClosed()) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  const close = async (server) => { server.closeAllConnections?.(); await new Promise((done) => server.close(done)) }
  await close(client); await close(backend)
  report.blockedExternalPushAttempts = blockedExternalPushAttempts
  await writeFile(`${output}/images-notifications-results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, layouts: report.layouts.length, requests: report.requests.length, failures: report.failures.map((item) => item.message), output }))
}
