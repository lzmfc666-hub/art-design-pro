import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { createStudioServer } from '../../server/index.mjs'

// This focused component-contract check substitutes only the two new fulfillment
// fields on a genuine paid-order detail. All sessions, upload and submit calls
// still use an isolated real API; the full merchant-credit flow is tested jointly.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(process.env.STUDIO_FINAL_QA_ROOT || resolve(root, '.qa'), 'merchant-player-ui', `run-${randomUUID()}`)
mkdirSync(resolve(output, 'tmp'), { recursive: true })
process.env.TEMP = process.env.TMP = resolve(output, 'tmp')
const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) }
catch { ({ chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')) }
const password = `isolated-merchant-${randomUUID()}`
const server = createStudioServer({
  dbPath: resolve(output, 'isolated.sqlite'), seed: false, password,
  backups: { intervalMinutes: 0, directory: resolve(output, 'backups'), failureWebhook: '' },
  notificationIntervalMs: 86400000,
  notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] }
})
const service = server.service
const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, { requestId: randomUUID(), ...body })
const level = mutate('/levels', { name: '商家打手适配等级', delaySeconds: 0 })
const player = mutate('/users', { username: 'isolated-merchant-player', name: '适配打手', role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
const platform = mutate('/platforms', { name: '适配测试平台', rules: { requiresShop: false, requiresExternalOrderNo: false, requiresReceipt: false, allowPayOnArrival: true } })
const customer = mutate('/customers', { name: '适配测试客户' })
const template = mutate('/templates', { name: '履约适配测试', game: 'QA', amount: 8000, reward: 6000, active: true })
const orders = [true, false].map(paid => {
  const order = mutate('/orders', { templateId: template.id, customerId: customer.id, platformId: platform.id,
    roomCode: 'QA', amount: 8000, reward: 6000, receivedAmount: paid ? 8000 : 0,
    paidAt: paid ? new Date().toISOString() : null, payOnArrival: !paid, dispatchMode: 'pool' })
  mutate(`/player/orders/${order.id}/claim`, { expectedRevision: order.revision, dispatchRound: order.dispatchRound }, player.id)
  return order
})
const png = resolve(output, 'evidence.png')
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX0sAAAAASUVORK5CYII=', 'base64'))
let vite, browser
const result = { output, passes: [], pageErrors: [], simulatedResponses: 0, submitted: null, limitation: 'Focused UI contract test; only new fulfillment fields are controlled. Full merchant-credit integration is separate.' }
try {
  await new Promise(ready => server.listen(0, '127.0.0.1', ready))
  vite = await createViteServer({ root: resolve(root, 'player-client'), configFile: resolve(root, 'player-client/vite.config.ts'), cacheDir: resolve(output, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: true, proxy: { '/api/studio': { target: `http://127.0.0.1:${server.address().port}`, changeOrigin: true, headers: { 'X-Studio-Client': 'player' } } } } })
  await vite.listen()
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  assert.equal((await context.request.post(`${origin}/api/studio/login`, { data: { username: player.username, password } })).status(), 200)
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => result.pageErrors.push(error.message))
  let creditCanSubmit = true
  await page.route(`**/api/studio/player/orders/${orders[0].id}`, async route => {
    const response = await route.fetch()
    const body = await response.json()
    result.simulatedResponses++
    await route.fulfill({ response, json: { ...body, paymentConfirmed: false, fulfillmentAuthorized: true,
      canSubmit: creditCanSubmit, submitBlockedReason: creditCanSubmit ? null : { code: 'RETURN_REQUEST_PENDING', message: '退单处理中，请等待客服核对' } } })
  })
  await page.goto(`${origin}/#/player/orders/${orders[0].id}`)
  await page.getByRole('heading', { name: '提交完成材料', exact: true }).waitFor()
  await page.waitForLoadState('networkidle')
  await page.locator('input[type=file]').setInputFiles(png)
  await page.getByText('已上传 100%', { exact: false }).waitFor()
  const submit = page.getByRole('button', { name: '提交完成，等待验收', exact: true })
  assert.equal(await submit.isEnabled(), true, 'credit fulfillment must not be blocked solely because paymentConfirmed is false')
  assert.match(await page.locator('section.p-page').innerText(), /平台垫付/)
  assert.doesNotMatch(await page.locator('section.p-page').innerText(), /足额收款后才可正常上报/)
  creditCanSubmit = false
  await page.reload()
  await page.getByText('退单处理中，请等待客服核对', { exact: true }).waitFor()
  await page.locator('input[type=file]').setInputFiles(png)
  await page.getByText('已上传 100%', { exact: false }).waitFor()
  assert.equal(await page.getByRole('button', { name: '提交完成，等待验收', exact: true }).isDisabled(), true,
    'credit fulfillment must not override canSubmit=false')
  result.passes.push('credit fulfillment does not grant submission when the server denies current permission')
  creditCanSubmit = true
  await page.reload()
  await page.getByRole('heading', { name: '提交完成材料', exact: true }).waitFor()
  await page.waitForLoadState('networkidle')
  await page.locator('input[type=file]').setInputFiles(png)
  await page.getByText('已上传 100%', { exact: false }).waitFor()
  assert.equal(await submit.isEnabled(), true)
  const waiting = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/player/orders/${orders[0].id}/submit`))
  await submit.click()
  const request = await waiting
  const body = request.postDataJSON()
  assert.equal(body.expectedRevision, service.orderDetail('admin', orders[0].id).order.revision)
  assert.equal(body.assignmentId, service.orderDetail('admin', orders[0].id).order.assignmentId)
  assert.equal(request.headers()['x-studio-actor'], player.id)
  assert.ok(body.requestId && body.screenshots.length === 1)
  result.submitted = { actor: request.headers()['x-studio-actor'], assignmentId: body.assignmentId, requestId: body.requestId }
  await page.getByText('正在等待财务验收，本单已释放接单名额。验收通过后报酬计入钱包。', { exact: true }).waitFor()
  result.passes.push('credit fulfillment enables material submission without inventing paid status and preserves original operation identity')
  await page.goto(`${origin}/#/player/orders/${orders[1].id}`)
  await page.getByRole('heading', { name: '提交完成材料', exact: true }).waitFor()
  await page.waitForLoadState('networkidle')
  await page.locator('input[type=file]').setInputFiles(png)
  await page.getByText('已上传 100%', { exact: false }).waitFor()
  assert.equal(await page.getByRole('button', { name: '提交完成，等待验收', exact: true }).isDisabled(), true)
  assert.match(await page.locator('section.p-page').innerText(), /足额收款后才可正常上报/)
  result.passes.push('ordinary unpaid order remains blocked after material upload')
  assert.deepEqual(result.pageErrors, [])
  await page.screenshot({ path: resolve(output, 'ordinary-unpaid.png'), fullPage: true })
  result.ok = true
  console.log(JSON.stringify(result, null, 2))
} finally {
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2))
  await browser?.close()
  await vite?.close()
  await new Promise(ready => server.close(ready))
}
