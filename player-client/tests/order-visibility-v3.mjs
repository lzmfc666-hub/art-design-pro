import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createStudioServer } from '../../server/index.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'

// Client-owned real integration: isolated memory DB, ephemeral loopback ports and current dist.
// The one transport fault discards an actual successful HTTP response; no business result is mocked.
const output = resolve(process.env.STUDIO_QA_ROOT || 'player-client/.qa', 'order-visibility-v3')
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const password = `visibility-${randomUUID()}`
const contract = await readFile(resolve('docs/STUDIO-CONTRACT.md'))
const report = { contract: 'v3 visibility suite adapted to v3.2 (2026-10-14)', contractSha256: createHash('sha256').update(contract).digest('hex'),
  database: ':memory:', cases: [], requests: [], runtimeErrors: [], failures: [], passed: false,
  limitations: ['Original-result GET is deliberately aborted at browser transport in the uncertain-intent group; current order/history cannot confirm an original operation.',
    'No physical Android/iPhone, HTTPS, lock-screen or external push validation.'] }
const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, notificationIntervalMs: 86_400_000,
  notifications: { publicKey: '', privateKey: '', subject: '' } })
await new Promise((ready) => backend.listen(0, '127.0.0.1', ready))
const apiOrigin = `http://127.0.0.1:${backend.address().port}`
const client = createPlayerClientServer({ apiTarget: apiOrigin, staticRoot: resolve('player-client/dist'), trustedProxies: '' })
await new Promise((ready) => client.listen(0, '127.0.0.1', ready))
const origin = `http://127.0.0.1:${client.address().port}`
Object.assign(report, { apiOrigin, origin })
const cookies = new Map(), users = new Map()
let browser, context, page
async function api(path, body, actor = 'admin', expected = 200) {
  const response = await fetch(`${apiOrigin}/api/studio/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookies.has(actor) ? { Cookie: cookies.get(actor) } : {}), ...(users.get(actor)?.role === 'player' ? { 'X-Studio-Client': 'player' } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(path === 'login' ? {} : { 'X-Studio-Actor': users.get(actor)?.id || 'admin' }) }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  report.requests.push({ actor, path, method: body === undefined ? 'GET' : 'POST', status: response.status })
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${actor} ${path}: ${response.status} ${JSON.stringify(value)}`)
  if (path === 'login') cookies.set(actor, response.headers.get('set-cookie').split(';')[0])
  return { status: response.status, value }
}
const get = async (path, actor = 'admin', expected = 200) => (await api(path, undefined, actor, expected)).value
const post = async (path, body, actor = 'admin', expected = 200) => (await api(path, { ...body, requestId: body.requestId || randomUUID() }, actor, expected)).value
const current = (id, actor = 'A', expected = 200) => get(`player/orders/${id}`, actor, expected)
async function transfer(id) {
  const latest = (await get(`orders/${id}`, 'support')).order
  await post(`orders/${id}/action`, { action: 'release', expectedRevision: latest.revision, assignmentId: latest.assignmentId,
    leaderId: latest.leaderId, reason: '隔离验证：解除旧轮并重新指派' }, 'support')
  const released = (await get(`orders/${id}`, 'support')).order
  await post(`orders/${id}/action`, { action: 'dispatch', expectedRevision: released.revision, dispatchMode: 'direct', assignedTo: users.get('B').id }, 'support')
  const target = await current(id, 'B')
  await post(`player/orders/${id}/claim`, { expectedRevision: target.revision, dispatchRound: target.dispatchRound }, 'B')
  return current(id, 'B')
}
async function openOrder(id) {
  await page.evaluate((value) => { location.hash = `#/player/orders/${value}` }, id)
  await page.locator('.p-detail-hero').waitFor()
}
async function reconcile(id) {
  // Browser focus events can be coalesced for 500 ms; leave enough room for a genuine wake.
  await page.waitForTimeout(650)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  // The scheduled summary can already have refreshed this detail during the wake delay.
  // Wait for the current safe projection, then inspect the actual recorded browser read;
  // an unchanged summary correctly performs no redundant detail GET.
  await page.getByText('本人参与历史摘要', { exact: true }).waitFor()
  const response = report.requests.filter((item) => item.actor === 'browser-A' && item.path === `/api/studio/player/orders/${id}` && item.method === 'GET').at(-1)
  assert.ok(response, 'safe projection must come from an actual browser detail read')
  return response.status
}
async function assertPrivateGone(room, game) {
  await page.waitForFunction(({ room, game }) => !document.body.innerText.includes(room) && !document.body.innerText.includes(game), { room, game })
  assert.equal(await page.getByText(room, { exact: true }).count(), 0)
  assert.equal(await page.getByText(game, { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '接受订单', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '提交完成，等待验收', exact: true }).count(), 0)
  await page.getByText('本人参与历史摘要', { exact: true }).waitFor()
  await page.getByRole('link', { name: '返回参与历史', exact: true }).waitFor()
}
try {
  await api('login', { username: 'admin', password })
  const level = await post('levels', { name: '私有详情独立验证', delaySeconds: 0 })
  for (const [key, role] of [['A', 'player'], ['B', 'player'], ['support', 'support']]) {
    const user = await post('users', { username: `visibility-${key}-${randomUUID().slice(0, 8)}`, name: `详情验证${key}`, role,
      status: 'active', levelId: level.id, maxActiveOrders: 3, permissionOverrides: {}, password })
    users.set(key, user)
    await api('login', { username: user.username, password }, key)
  }
  const customer = await post('customers', { name: '隔离测试客户', contact: 'INTERNAL-ONLY', gameId: 'CUSTOMER-PRIVATE' })
  const template = await post('templates', { name: '详情权限真实联调', game: '三角洲行动', description: '公开服务要求',
    amount: 2000, reward: 1001, map: '航天基地', active: true })
  const createOrder = (suffix) => post('orders', { templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun',
    externalOrderNo: randomUUID(), roomCode: `PRIVATE-ROOM-${suffix}`, gameId: `PRIVATE-GAME-${suffix}`, amount: 2000, reward: 1001,
    receivedAmount: 2000, paidAt: new Date().toISOString(), dispatchMode: 'direct', assignedTo: users.get('A').id,
    remark: 'INTERNAL-REMARK-ONLY', playerRemark: '允许本人查看的公开打手说明' }, 'support')
  const first = await createOrder('VISIBLE')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (cause) => report.runtimeErrors.push(cause.message))
  context.on('response', (item) => {
    if (item.url().includes('/api/studio/')) report.requests.push({ actor: 'browser-A', path: new URL(item.url()).pathname,
      method: item.request().method(), status: item.status() })
  })
  await page.goto(`${origin}/#/player/login`)
  await page.getByLabel('账号', { exact: true }).fill(users.get('A').username)
  await page.locator('input[name=password]').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/#/player/lobby')
  await openOrder(first.id)
  assert.equal(await page.getByText('PRIVATE-ROOM-VISIBLE', { exact: true }).count(), 0)
  await page.getByRole('button', { name: '接受订单', exact: true }).click()
  await page.getByText('PRIVATE-ROOM-VISIBLE', { exact: true }).waitFor()
  await page.getByText('PRIVATE-GAME-VISIBLE', { exact: true }).waitFor()
  const accepted = await current(first.id)
  assert.equal(accepted.leaderId, users.get('A').id)
  await page.screenshot({ path: `${output}/accepted-private-details.png` })
  const newOwner = await transfer(first.id)
  assert.equal(newOwner.leaderId, users.get('B').id)
  assert.notEqual(newOwner.assignmentId, accepted.assignmentId)
  assert.ok(newOwner.dispatchRound > accepted.dispatchRound)
  const revoked = await api(`player/orders/${first.id}`, undefined, 'A')
  assert.equal(revoked.value.historyOnly, true)
  assert.equal(revoked.value.roomCode, undefined); assert.equal(revoked.value.gameId, undefined)
  const refreshStatus = await reconcile(first.id)
  assert.equal(refreshStatus, 200)
  await assertPrivateGone('PRIVATE-ROOM-VISIBLE', 'PRIVATE-GAME-VISIBLE')
  assert.equal((await current(first.id, 'B')).assignmentId, newOwner.assignmentId)
  report.cases.push({ name: '真实解除并重派后，旧详情读取200安全历史摘要，立即移除私人执行字段、禁止旧按钮并保留返回入口', passed: true,
    directReadStatus: revoked.status, browserReadStatus: refreshStatus })
  await page.screenshot({ path: `${output}/revoked-private-details-cleared.png` })

  const second = await createOrder('UNCONFIRMED')
  await openOrder(second.id)
  // Keep this original safety assertion meaningful after v3.1 added GET lookup:
  // transport unavailability leaves the real successful claim unknown to the page.
  await context.route('**/api/studio/player/operation-results/**', route => route.abort('failed'))
  let discarded = 0, realCommit, lostRequestId
  await context.route(`**/api/studio/player/orders/${second.id}/claim`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const actualResponse = await route.fetch()
    assert.equal(actualResponse.status(), 200)
    realCommit = await actualResponse.json()
    lostRequestId = route.request().postDataJSON().requestId
    discarded++
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '接受订单', exact: true }).click()
  await page.getByRole('button', { name: '核对结果', exact: true }).waitFor()
  assert.equal(discarded, 1)
  assert.equal(realCommit.leaderId, users.get('A').id)
  await page.getByRole('button', { name: '核对结果', exact: true }).click()
  await page.getByText('PRIVATE-ROOM-UNCONFIRMED', { exact: true }).waitFor()
  await page.getByText(/原操作结果仍需核对/).waitFor()
  const pendingAccepted = await current(second.id)
  await transfer(second.id)
  assert.equal(await reconcile(second.id), 200)
  await assertPrivateGone('PRIVATE-ROOM-UNCONFIRMED', 'PRIVATE-GAME-UNCONFIRMED')
  assert.equal(await page.locator('.p-detail-hero').count(), 1)
  await page.getByRole('button', { name: '核对结果', exact: true }).waitFor()
  const writesBeforeCheck = report.requests.filter((item) => item.actor === 'browser-A' && item.path === `/api/studio/player/orders/${second.id}/claim` && item.method === 'POST').length
  await page.getByRole('button', { name: '核对结果', exact: true }).click()
  await page.getByText(/原操作结果仍需核对/).waitFor()
  assert.equal(discarded, 1, 'focus and checks must never automatically repeat the uncertain claim')
  assert.equal(report.requests.filter((item) => item.actor === 'browser-A' && item.path === `/api/studio/player/orders/${second.id}/claim` && item.method === 'POST').length, writesBeforeCheck)
  assert.equal(await page.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  assert.notEqual((await current(second.id, 'B')).assignmentId, pendingAccepted.assignmentId)
  report.cases.push({ name: '真实成功响应丢失且原结果读取断网时保持未确认；旧详情仅有安全摘要时仍保留核对入口，不猜成功、不自动重发', passed: true,
    realCommittedClaims: discarded, oldReadStatus: 200, originalResultLookup: 'transport fault injected, real successful claim retained' })
  await page.screenshot({ path: `${output}/unconfirmed-operation-without-order.png` })
  const markerValues = () => page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('__studio_player_unconfirmed_v1__:'))
    .map(([key, value]) => ({ key, marker: JSON.parse(value) })))
  const markersBeforeReload = await markerValues()
  assert.equal(markersBeforeReload.length, 1)
  const marker = markersBeforeReload[0].marker
  assert.deepEqual(Object.keys(marker).sort(), ['createdAt', 'family', 'owner', 'requestId'])
  assert.equal(marker.owner, users.get('A').id)
  assert.equal(marker.family, 'claim')
  assert.equal(marker.requestId, lostRequestId)
  assert.equal(typeof marker.createdAt, 'number')
  assert.equal(JSON.stringify(marker).includes('PRIVATE'), false)
  await page.reload()
  await page.getByRole('button', { name: '核对结果', exact: true }).waitFor()
  await page.getByRole('link', { name: '返回参与历史', exact: true }).waitFor()
  await page.getByText('前次操作结果仍未确认，请先核对。本页不会再次提交。', { exact: true }).waitFor()
  assert.deepEqual(await markerValues(), markersBeforeReload)
  assert.equal(await page.locator('.p-detail-hero').count(), 1)
  assert.equal(await page.getByRole('button', { name: '重试原请求', exact: true }).count(), 0)
  assert.equal(discarded, 1, 'full-page reload must never re-send the original uncertain claim')
  const checkButtonGeometry = await page.getByRole('button', { name: '核对结果', exact: true }).evaluate((button) => {
    const rect = button.getBoundingClientRect()
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode(), text = node?.textContent || ''
    const first = text.search(/\S/), last = text.trimEnd().length - 1
    const firstRange = document.createRange(), lastRange = document.createRange()
    firstRange.setStart(node, first); firstRange.setEnd(node, first + 1)
    lastRange.setStart(node, last); lastRange.setEnd(node, last + 1)
    return { width: rect.width, height: rect.height, firstTextY: firstRange.getBoundingClientRect().y,
      lastTextY: lastRange.getBoundingClientRect().y, noticeDisplay: getComputedStyle(button.closest('.p-operation-state')).display }
  })
  assert.equal(checkButtonGeometry.noticeDisplay, 'block')
  assert.ok(checkButtonGeometry.width >= 80 && checkButtonGeometry.height < 70)
  assert.ok(Math.abs(checkButtonGeometry.firstTextY - checkButtonGeometry.lastTextY) < 1, '390px check action must read horizontally on one line')
  await page.screenshot({ path: `${output}/reloaded-unconfirmed-marker.png` })
  const third = await createOrder('NEW-CLAIM-BLOCKED')
  await openOrder(third.id)
  const claimCount = report.requests.filter((item) => item.actor === 'browser-A' && item.method === 'POST' && /\/claim$/.test(item.path)).length
  assert.ok(await page.getByRole('button', { name: '接受订单', exact: true }).isDisabled())
  await page.getByRole('button', { name: '核对结果', exact: true }).click()
  await page.getByText(/原操作结果仍需核对/).waitFor()
  assert.equal(report.requests.filter((item) => item.actor === 'browser-A' && item.method === 'POST' && /\/claim$/.test(item.path)).length, claimCount)
  assert.deepEqual(await markerValues(), markersBeforeReload)
  report.cases.push({ name: '真实丢响应后整页刷新仍锁定同类接单；仅持久四项待核对标记，无业务内容、队列或重试，390核对按钮正常横排',
    passed: true, persistedKeys: Object.keys(marker).sort(), restoredFamily: marker.family, checkButtonGeometry })
  await page.screenshot({ path: `${output}/recovered-marker-blocks-new-claim.png` })
  await page.getByRole('link', { name: '接单大厅', exact: true }).click()
  await page.waitForURL('**/#/player/lobby')
  assert.equal(await page.getByText('PRIVATE-ROOM-UNCONFIRMED', { exact: true }).count(), 0)
  assert.equal(await page.getByText('PRIVATE-GAME-UNCONFIRMED', { exact: true }).count(), 0)
  assert.deepEqual(report.runtimeErrors, [])
  report.passed = true
} catch (cause) {
  report.failures.push({ message: cause.message, stack: cause.stack })
  if (page && !page.isClosed()) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  const close = async (server) => { server.closeAllConnections?.(); await new Promise((ready) => server.close(ready)) }
  await close(client)
  await close(backend)
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, requests: report.requests.length,
    runtimeErrors: report.runtimeErrors, failures: report.failures.map((item) => item.message), output }))
}
