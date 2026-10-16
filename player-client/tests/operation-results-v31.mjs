import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { request as requestHttp } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'

// Client acceptance: business setup/mutations use actual HTTP, a private in-memory
// database and random loopback ports. No formal services, secrets or database are used.
const output = resolve(process.env.STUDIO_QA_ROOT || 'player-client/.qa', 'operation-results-v31')
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `operation-client-qa-${randomUUID()}`
const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, maintenanceFromEnv: false,
  notificationIntervalMs: 86_400_000, notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [],
    pushSender: async () => { throw new Error('External push is prohibited in client acceptance') } } })
await new Promise((done) => backend.listen(0, '127.0.0.1', done))
const apiBase = `http://127.0.0.1:${backend.address().port}`
const client = createPlayerClientServer({ apiTarget: apiBase, staticRoot: resolve('player-client/dist') })
await new Promise((done) => client.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${client.address().port}`
const report = { contract: '稳定性整改共享契约 v3.1 (2026-10-14)', database: ':memory:', apiBase, base,
  cases: [], requests: [], operationWrites: [], lookups: [], runtimeErrors: [], failures: [], passed: false,
  limitations: ['Isolated desktop browser client acceptance, not final combined backend regression or formal deployment.', 'No real Android/iPhone/HTTPS or external push delivery validation.'] }
const jars = new Map(), actorIds = new Map([['admin', 'admin']]), partialWrites = []
let browser, context, page
async function api(actor, path, body, { expected = 200, actorOverride } = {}) {
  const origin = actor.startsWith('player') ? base : apiBase, expectedActor = actorOverride ?? actorIds.get(actor)
  const response = await fetch(`${origin}/api/studio/${path.replace(/^\//, '')}`, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(actor.startsWith('player') ? { 'X-Studio-Client': 'player' } : {}),
      ...(body === undefined || !expectedActor || path === 'login' ? {} : { 'X-Studio-Actor': expectedActor }), ...(jars.get(actor) ? { Cookie: jars.get(actor) } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const cookie = response.headers.get('set-cookie'); if (cookie) jars.set(actor, cookie.split(';')[0])
  const result = await response.json()
  report.requests.push({ actor, path, method: body === undefined ? 'GET' : 'POST', status: response.status, code: result.code || null })
  assert.equal(response.status, expected, `${actor} ${path}: ${result.message || response.status}`)
  return result
}
const success = (name, details = {}) => report.cases.push({ name, passed: true, ...details })
const confirmationOnly = (value) => {
  assert.equal(value.result, 'confirmation-only'); assert.equal(value.canCreateNew, false)
  for (const field of ['order', 'target', 'body', 'amount', 'screenshots', 'paymentSnapshot', 'qrCode']) assert.equal(Object.hasOwn(value, field), false, `private/stale field ${field}`)
}
const receiptCount = (id, owner) => backend.service.db.prepare('SELECT COUNT(*) n FROM business_requests WHERE request_id=? AND actor_id=?').get(id, owner).n
const browserWrites = (path) => report.operationWrites.filter((item) => item.path === path)
const prefix = '__studio_player_unconfirmed_v1__:'
function holdActualWrite(url, raw, headers) {
  let resolveResult, rejectResult
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  result.catch(() => {})
  const request = requestHttp(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), 'X-Studio-Client': 'player',
    'X-Studio-Actor': headers['x-studio-actor'], Cookie: headers.cookie || ''
  } }, (response) => {
    const chunks = []; response.on('data', (data) => chunks.push(data)); response.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      report.requests.push({ actor: 'held-original', path: new URL(url).pathname, method: 'POST', status: response.statusCode, code: body.code || null })
      resolveResult({ status: response.statusCode, body })
    })
  })
  request.on('error', rejectResult)
  request.flushHeaders(); request.write(raw.slice(0, -1))
  const held = { request, result, release: () => request.end(raw.slice(-1)) }
  partialWrites.push(held)
  return held
}

try {
  await api('admin', 'login', { username: 'admin', password })
  const level = await api('admin', 'levels', { name: 'v3.1操作联调等级', delaySeconds: 0 })
  const users = {}
  for (const actor of ['support', 'finance', 'playerA', 'playerB']) {
    users[actor] = await api('admin', 'users', { username: `v31-${actor}`, name: `v31隔离${actor}`, role: actor.startsWith('player') ? 'player' : actor,
      status: 'active', levelId: level.id, maxActiveOrders: 20, permissionOverrides: {}, password })
    actorIds.set(actor, users[actor].id); await api(actor, 'login', { username: users[actor].username, password })
  }
  const customer = await api('support', 'customers', { name: 'v31隔离客户', gameId: '000031', contact: 'PRIVATE-CONTACT' })
  const template = await api('admin', 'templates', { name: 'v31原操作核对订单', game: '三角洲行动', description: '保持已有流程', map: '航天基地', amount: 10000, reward: 1001, active: true })
  const newOrder = (playerRemark) => api('support', 'orders', { requestId: randomUUID(), templateId: template.id, customerId: customer.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'PRIVATE-ROOM', gameId: 'PRIVATE-ID', amount: 10000, reward: 1001,
    receivedAmount: 10000, paidAt: new Date().toISOString(), dispatchMode: 'pool', playerRemark, remark: 'PRIVATE-INTERNAL-REMARK' })
  const orders = {}
  for (const name of ['success', 'reload', 'retry', 'late', 'blocked', 'principal']) orders[name] = await newOrder(`初始说明-${name}`)
  await api('finance', 'player-adjustments', { requestId: randomUUID(), userId: users.playerA.id, kind: 'supplement', amount: 10000, reason: '隔离提现验证余额' })
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
  const qr = await api('playerA', 'uploads', { name: '隔离收款码.png', mime: 'image/png', data: png })
  await api('playerA', 'player/payment-methods', { method: 'wechat', qrCode: qr })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => report.runtimeErrors.push(error.message))
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && (/\/player\/orders\/[^/]+\/(claim|reject|return-request|submit)$/.test(path) || /\/player\/withdrawals(?:\/[^/]+\/cancel)?$/.test(path)))
      report.operationWrites.push({ path, body: request.postDataJSON(), actor: request.headers()['x-studio-actor'] || '' })
  })
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname
    if (!path.startsWith('/api/studio/')) return
    report.requests.push({ actor: 'browser', path, method: response.request().method(), status: response.status() })
    if (path.includes('/player/operation-results/')) {
      const result = await response.json().catch(() => null)
      if (result) report.lookups.push({ path, status: response.status(), result })
    }
  })
  const login = async () => {
    await page.goto(`${base}/#/player/login`); await page.getByLabel('账号', { exact: true }).fill(users.playerA.username)
    await page.locator('input[name=password]').fill(password); await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/#/player/lobby'); await page.locator('.p-header h1').waitFor()
  }
  const visit = async (path) => {
    await page.evaluate((value) => { location.hash = `#${value}` }, path)
    await page.waitForFunction((value) => location.hash === `#${value}`, path)
    await page.waitForFunction(() => !document.querySelector('.p-spinner'))
  }
  const detail = async (order) => { await visit(`/player/orders/${order.id}`); await page.locator('.p-detail-hero .p-order-no').filter({ hasText: order.orderNo }).waitFor() }
  const lookupFromUI = async () => {
    const response = page.waitForResponse((res) => res.url().includes('/player/operation-results/') && res.request().method() === 'GET')
    await page.getByRole('button', { name: '核对结果', exact: true }).click()
    const value = await (await response).json(); confirmationOnly(value); return value
  }
  const guard = async (family) => page.evaluate(({ owner, family, prefix }) => {
    const scoped = `${prefix}${encodeURIComponent(owner)}:${family}`, markers = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key !== scoped && !key?.startsWith(`${scoped}:`)) continue
      try {
        const marker = JSON.parse(localStorage.getItem(key))
        if (marker?.owner === owner && marker.family === family) markers.push(marker)
      } catch {}
    }
    return markers.sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId))[0] || null
  }, { owner: users.playerA.id, family, prefix })
  const assertPending = async () => {
    await page.getByRole('button', { name: '核对结果', exact: true }).waitFor()
    assert.ok(await page.locator('.p-operation-state').count())
  }
  const patchRemark = async (order, text) => {
    const latest = await api('support', `orders/${order.id}`)
    await api('support', `orders/${order.id}/action`, { requestId: randomUUID(), expectedRevision: latest.order.revision, action: 'remark', playerRemark: text })
  }
  const dropSuccess = async (path) => {
    let dropped = false
    await page.route(`${base}${path}`, async (route) => {
      if (!dropped && route.request().method() === 'POST') { dropped = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed') }
      else await route.continue()
    })
  }
  await login()

  const successPath = `/api/studio/player/orders/${orders.success.id}/claim`
  await detail(orders.success); await dropSuccess(successPath)
  await page.getByRole('button', { name: '接受订单', exact: true }).click(); await assertPending()
  const succeededIntent = browserWrites(successPath).at(-1)
  assert.equal(succeededIntent.actor, users.playerA.id)
  await patchRemark(orders.success, '原操作成功后的最新服务要求-v31')
  const succeeded = await lookupFromUI(); assert.equal(succeeded.status, 'succeeded'); assert.equal(succeeded.operationConfirmed, true)
  await page.getByText('原操作成功后的最新服务要求-v31', { exact: true }).waitFor()
  assert.equal(receiptCount(succeededIntent.body.requestId, users.playerA.id), 1); assert.equal(await guard('claim'), null)
  await page.unroute(`${base}${successPath}`)
  success('claim committed then response lost: GET acknowledgement succeeds and page reads current changed order, without replaying an old snapshot')

  const reloadPath = `/api/studio/player/orders/${orders.reload.id}/claim`
  await detail(orders.reload); await dropSuccess(reloadPath)
  await page.getByRole('button', { name: '接受订单', exact: true }).click(); await assertPending()
  const reloadIntent = browserWrites(reloadPath).at(-1), marker = await guard('claim')
  assert.deepEqual(Object.keys(marker).sort(), ['createdAt', 'family', 'owner', 'requestId'])
  assert.equal(marker.requestId, reloadIntent.body.requestId)
  await page.reload(); await assertPending()
  assert.equal(await page.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  const recovered = await lookupFromUI(); assert.equal(recovered.status, 'succeeded')
  await page.waitForFunction(({ owner, prefix }) => {
    const scoped = `${prefix}${encodeURIComponent(owner)}:claim`
    return !Object.keys(localStorage).some((key) => key === scoped || key.startsWith(`${scoped}:`))
  }, { owner: users.playerA.id, prefix })
  assert.equal(browserWrites(reloadPath).length, 1); assert.equal(receiptCount(reloadIntent.body.requestId, users.playerA.id), 1)
  await page.unroute(`${base}${reloadPath}`)
  success('whole-page reload restores confirmation marker only; succeeded GET clears the lock without original body, retry or duplicate write')

  await visit('/player/wallet'); await page.getByLabel('提现金额（元）', { exact: true }).fill('0.01')
  await page.getByLabel('收款方式', { exact: true }).selectOption('wechat')
  const withdrawPath = '/api/studio/player/withdrawals'; await dropSuccess(withdrawPath)
  await page.getByRole('button', { name: '提交提现申请', exact: true }).click(); await assertPending()
  const withdrawIntent = browserWrites(withdrawPath).at(-1)
  assert.equal(withdrawIntent.actor, users.playerA.id)
  const wallet = await api('playerA', 'player/wallet'), row = wallet.withdrawals.find((item) => item.requestId === withdrawIntent.body.requestId)
  assert.ok(row)
  await api('finance', `withdrawals/${row.id}/action`, { requestId: randomUUID(), action: 'reject', reason: '客户端核对必须读取当前状态' })
  const withdrawLookup = await lookupFromUI(); assert.equal(withdrawLookup.status, 'succeeded')
  await page.getByText('原操作已确认，请查看当前最新状态。', { exact: true }).waitFor()
  await page.getByText('原申请已确认，请查看最新提现记录。', { exact: true }).waitFor()
  const currentWallet = await api('playerA', 'player/wallet')
  assert.equal(currentWallet.withdrawals.find((item) => item.id === row.id).status, 'rejected')
  assert.equal(currentWallet.available, 10000); assert.equal(currentWallet.occupied, 0)
  assert.match(await page.locator('.p-wallet-preview').innerText(), /100\.00/)
  assert.equal(currentWallet.withdrawals.filter((item) => item.requestId === withdrawIntent.body.requestId).length, 1)
  assert.equal(browserWrites(withdrawPath).length, 1); assert.equal(await guard('withdraw'), null)
  await page.unroute(`${base}${withdrawPath}`)
  success('withdrawal committed then response lost: succeeded lookup and latest wallet/refund state, with one immutable request and no duplicate funds write')

  // Relay a real service-unavailable error from this unconfigured push API into
  // the current-wallet transport, explicitly an SDK error fault test. The real
  // backend rejects before binding or delivery; no successful result is fabricated.
  await page.getByLabel('提现金额（元）', { exact: true }).fill('0.01')
  await dropSuccess(withdrawPath)
  await page.getByRole('button', { name: '提交提现申请', exact: true }).click(); await assertPending()
  const readFailureIntent = browserWrites(withdrawPath).at(-1)
  await page.route(`${base}/api/studio/player/wallet?*`, async (route) => {
    const originalHeaders = await route.request().allHeaders()
    const response = await route.fetch({ url: `${apiBase}/api/studio/player/push-subscriptions`, method: 'POST', postData: '{"subscription":null}',
      headers: { Cookie: originalHeaders.cookie || '', 'Content-Type': 'application/json', 'X-Studio-Client': 'player', 'X-Studio-Actor': users.playerA.id } })
    assert.equal(response.status(), 503)
    report.requests.push({ actor: 'actual-unconfigured-push-error-relay', path: '/api/studio/player/wallet', method: 'GET', status: response.status() })
    await route.fulfill({ response })
  })
  const failedLatest = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/studio/player/wallet' && response.status() === 503)
  assert.equal((await lookupFromUI()).status, 'succeeded'); await failedLatest
  await page.waitForFunction(() => document.querySelector('button.p-primary.p-full')?.disabled === true)
  assert.equal(await page.getByRole('button', { name: '提交提现申请', exact: true }).isDisabled(), true)
  assert.equal(await guard('withdraw'), null, 'success is acknowledged while current data still gates new funds writes')
  assert.equal(receiptCount(readFailureIntent.body.requestId, users.playerA.id), 1)
  await page.unroute(`${base}/api/studio/player/wallet?*`)
  const recoveredLatest = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/studio/player/wallet' && response.status() === 200)
  await page.getByRole('button', { name: '重试', exact: true }).click(); await recoveredLatest
  await page.waitForFunction(() => document.querySelector('button.p-primary.p-full')?.disabled === false)
  await page.unroute(`${base}${withdrawPath}`)
  success('acknowledgement followed by actual backend 503 error relay keeps new funds writes disabled until a successful explicit current-wallet read', { faultScope: 'SDK fault injection relays the real isolated unconfigured-push API 503 into wallet GET; no success, binding or external delivery is mocked' })

  const installDelayed = async (order) => {
    const path = `/api/studio/player/orders/${order.id}/claim`
    let held, first = true
    await page.route(`${base}${path}`, async (route) => {
      if (route.request().method() !== 'POST' || !first) return route.continue()
      first = false
      held = holdActualWrite(route.request().url(), route.request().postData(), await route.request().allHeaders())
      await route.abort('failed')
    })
    await detail(order); await page.getByRole('button', { name: '接受订单', exact: true }).click(); await assertPending()
    assert.ok(held)
    return { path, held, intent: browserWrites(path).at(-1) }
  }
  const retry = await installDelayed(orders.retry)
  const retryCurrentUrl = `${base}/api/studio/player/orders/${orders.retry.id}`
  const checkLatest = page.waitForResponse(res => new URL(res.url()).pathname === new URL(retryCurrentUrl).pathname && res.request().method() === 'GET' && res.status() === 200)
  const notRecorded = await lookupFromUI()
  await checkLatest
  await page.waitForFunction(() => ![...document.querySelectorAll('.p-notice')].some(item => item.textContent?.includes('正在核对最新订单')))
  await page.getByRole('button', { name: '重试原请求', exact: true }).waitFor()
  assert.equal(notRecorded.status, 'not-recorded'); assert.equal(notRecorded.lateCommitPossible, true); assert.equal(notRecorded.canRetryWithOriginal, true)
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).isDisabled(), true)
  let releaseRetryLatest, signalRetryLatest
  const retryLatestGate = new Promise((done) => { releaseRetryLatest = done })
  const retryLatestStarted = new Promise((done) => { signalRetryLatest = done })
  let firstRetryLatest = true, originalRetrySucceeded = false
  const retryLatestUrl = retryCurrentUrl
  // Mark real retry success before its response reaches the app, so this GET
  // gate cannot intercept a prior lookup refresh or a periodic summary read.
  await page.route(`${base}${retry.path}`, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    originalRetrySucceeded = true
    await route.fulfill({ response })
  })
  await page.route(retryLatestUrl, async (route) => {
    if (route.request().method() !== 'GET' || !firstRetryLatest || !originalRetrySucceeded) return route.continue()
    firstRetryLatest = false
    const response = await route.fetch(); assert.equal(response.status(), 200)
    signalRetryLatest(); await retryLatestGate
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '重试原请求', exact: true }).click()
  const retryResponse = page.waitForResponse((res) => res.url().endsWith(retry.path) && res.request().method() === 'POST')
  await page.getByRole('button', { name: '确认重试原请求', exact: true }).click(); assert.equal((await retryResponse).status(), 200)
  await retryLatestStarted
  const originalPageAction = page.locator('.p-card .p-actions > button.p-primary').first()
  assert.equal(await originalPageAction.isDisabled(), true, 'known retry result cannot unlock new operation before latest read completes')
  assert.equal(browserWrites(retry.path).length, 2)
  await originalPageAction.click({ force: true })
  assert.equal(browserWrites(retry.path).length, 2, 'a disabled old button must not create a third intent while latest HTTP read is held')
  releaseRetryLatest(); await page.unroute(retryLatestUrl)
  await page.waitForFunction(() => !document.querySelector('.p-operation-state'))
  const retryWrites = browserWrites(retry.path); assert.equal(retryWrites.length, 2)
  assert.deepEqual(retryWrites[1].body, retryWrites[0].body); assert.equal(retryWrites[1].actor, retryWrites[0].actor)
  retry.held.release(); assert.equal((await retry.held.result).status, 200)
  const retryOrder = await api('support', `orders/${orders.retry.id}`)
  assert.equal(retryOrder.order.assignments.filter((item) => item.leaderId === users.playerA.id).length, 1)
  assert.equal(receiptCount(retry.intent.body.requestId, users.playerA.id), 1)
  await page.unroute(`${base}${retry.path}`)
  success('manual original retry holds page action lock until its real current-order read completes; old page button cannot create a third intent')
  success('not-recorded remains locked; explicit full-intent retry retains requestId/body/owner, and original in-flight request later commits only one assignment')

  const late = await installDelayed(orders.late), beforeLate = await lookupFromUI()
  assert.equal(beforeLate.status, 'not-recorded'); assert.equal(beforeLate.lateCommitPossible, true)
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).isDisabled(), true)
  late.held.release(); assert.equal((await late.held.result).status, 200)
  await patchRemark(orders.late, '迟到原请求成功后仍须读取最新说明-v31')
  const afterLate = await lookupFromUI(); assert.equal(afterLate.status, 'succeeded')
  await page.getByText('迟到原请求成功后仍须读取最新说明-v31', { exact: true }).waitFor()
  assert.equal(browserWrites(late.path).length, 1); assert.equal(receiptCount(late.intent.body.requestId, users.playerA.id), 1)
  await page.unroute(`${base}${late.path}`)
  success('original request truly delayed in HTTP body can finish after not-recorded; later GET succeeds with one request and current order data')

  const blockedPath = `/api/studio/player/orders/${orders.blocked.id}/claim`
  await detail(orders.blocked)
  await page.route(`${base}${blockedPath}`, (route) => route.request().method() === 'POST' ? route.abort('failed') : route.continue())
  await page.getByRole('button', { name: '接受订单', exact: true }).click(); await assertPending()
  const blockedIntent = browserWrites(blockedPath).at(-1), firstBlockedLookup = await lookupFromUI()
  assert.equal(firstBlockedLookup.canRetryWithOriginal, true); await page.getByRole('button', { name: '重试原请求', exact: true }).waitFor()
  const editPlayer = (claim) => api('admin', 'users', { id: users.playerA.id, username: users.playerA.username, name: users.playerA.name,
    role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 20, permissionOverrides: {}, playerAccess: { login: true, claim, withdraw: true } })
  await editPlayer(false)
  const closedLookup = await lookupFromUI(); assert.equal(closedLookup.status, 'not-recorded'); assert.equal(closedLookup.canRetryWithOriginal, false)
  assert.equal(await page.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).isDisabled(), true)
  assert.equal((await guard('claim')).requestId, blockedIntent.body.requestId); assert.equal(browserWrites(blockedPath).length, 1)
  success('backend closes claim qualification: lookup denies original retry, hides retry button and retains unresolved family marker/lock')

  await editPlayer(true); await page.reload(); await assertPending()
  const bodyless = await lookupFromUI(); assert.equal(bodyless.status, 'not-recorded'); assert.equal(bodyless.canRetryWithOriginal, true)
  assert.equal(await page.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).isDisabled(), true)
  assert.equal((await guard('claim')).requestId, blockedIntent.body.requestId)
  success('not-recorded reload marker without original body stays locked even when server permits retry; no new requestId is created')

  // Obtain an actual 403 from the isolated backend using its valid staff cookie.
  // Relay that real forbidden response as an auth fault; never fabricate success.
  let forbidden = false
  await page.route('**/api/studio/player/operation-results/**', async (route) => {
    const response = await route.fetch({ url: `${apiBase}${new URL(route.request().url()).pathname}${new URL(route.request().url()).search}`,
      headers: { Cookie: jars.get('admin'), 'X-Studio-Client': 'admin' } })
    assert.equal(response.status(), 403); forbidden = true
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '核对结果', exact: true }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/player/login'))
  assert.equal(forbidden, true); assert.equal((await guard('claim')).requestId, blockedIntent.body.requestId)
  assert.equal(await page.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  await page.unroute('**/api/studio/player/operation-results/**')
  await login(); await detail(orders.blocked); await assertPending()
  assert.equal((await lookupFromUI()).status, 'not-recorded'); assert.equal(await page.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  await page.unroute(`${base}${blockedPath}`)
  success('actual backend 403 cannot confirm failure or clear marker; principal/session cleanup and relogin preserve unresolved bodyless intent')

  const principalBody = { requestId: randomUUID(), expectedRevision: orders.principal.revision, dispatchRound: orders.principal.dispatchRound }
  const mismatch = await api('playerB', `player/orders/${orders.principal.id}/claim`, principalBody, { expected: 409, actorOverride: users.playerA.id })
  assert.equal(mismatch.code, 'PRINCIPAL_CHANGED')
  const untouched = await api('support', `orders/${orders.principal.id}`)
  assert.equal(untouched.order.status, 'pending'); assert.equal(untouched.order.leaderId, null); assert.equal(untouched.order.assignments.length, 0)
  assert.equal(receiptCount(principalBody.requestId, users.playerA.id), 0); assert.equal(receiptCount(principalBody.requestId, users.playerB.id), 0)
  const foreignResult = await api('playerB', `player/operation-results/${succeededIntent.body.requestId}?family=claim`)
  confirmationOnly(foreignResult); assert.equal(foreignResult.status, 'not-recorded')
  success('B cookie with A captured actor is rejected before any business effect; B cannot discover A success through result lookup')

  assert.deepEqual(report.runtimeErrors, [])
  report.passed = true
  await page.screenshot({ path: `${output}/final-unresolved-marker-390.png` })
} catch (cause) {
  report.failures.push({ message: cause.message, stack: cause.stack }); process.exitCode = 1
  if (page && !page.isClosed()) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
} finally {
  for (const held of partialWrites) held.request.destroy()
  await browser?.close().catch(() => {})
  const close = async (server) => { server.closeAllConnections?.(); await new Promise((done) => server.close(done)) }
  await close(client); await close(backend)
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, requests: report.requests.length, writes: report.operationWrites.length,
    lookups: report.lookups.length, failures: report.failures.map((item) => item.message), output }))
}
