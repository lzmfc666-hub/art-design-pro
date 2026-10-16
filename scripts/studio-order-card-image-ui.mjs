import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer as createPortProbe } from 'node:net'
import { deflateSync } from 'node:zlib'
import { createServer as createViteServer } from 'vite'
import { createStudioServer } from '../server/index.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'

const outputRoot = process.env.STUDIO_FINAL_QA_ROOT
  ? resolve(process.env.STUDIO_FINAL_QA_ROOT, 'order-card-image-ui')
  : resolve('.qa/order-card-image-v33/ui')
const output = resolve(outputRoot, `run-${randomUUID()}`)
mkdirSync(output, { recursive: true })
process.env.STUDIO_QA_DECLARATIONS_DIR = join(output, 'generated-types')
const before = sourceFingerprint()
const password = `isolated-card-image-${randomUUID()}`
const server = createStudioServer({ dbPath: join(output, 'test.sqlite'), seed: true, password,
  maintenanceFromEnv: false, trustedProxies: [], backups: { intervalMinutes: 0, directory: join(output, 'backups'), failureWebhook: '' },
  uploadsCleanup: { enabled: false }, notificationIntervalMs: 86_400_000,
  notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] } })
const service = server.service
const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, { requestId: randomUUID(), ...body })
const level = mutate('/levels', { name: '订单卡图隔离等级', delaySeconds: 0 })
const player = mutate('/users', { username: 'isolated-card-player', name: '卡图隔离打手', role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
const reader = mutate('/users', { username: 'isolated-card-reader', name: '卡图只读员工', role: 'support', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password })
let vite, browser, page
const report = { passed: false, cases: [], pageErrors: [], serverErrors: [], layouts: [], output,
  database: join(output, 'test.sqlite'), sourceBefore: before, limitations: ['This suite checks admin card-image UI and shared API authorization; player rendering is covered by the preserved v3.3 client and separate client/joint suites.'] }
const pass = (name) => { report.cases.push(name); console.log('PASS ' + name) }
async function freePort() {
  const probe = createPortProbe()
  await new Promise(done => probe.listen(0, '127.0.0.1', done))
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  return port
}
function png(color) {
  const chunk = (name, data) => {
    const kind = Buffer.from(name), all = Buffer.concat([kind, data])
    let crc = 0xffffffff
    for (const byte of all) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4)
    head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([head, kind, data, tail])
  }
  const size = 200, header = Buffer.alloc(13), raw = Buffer.alloc(size * (1 + size * 4))
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = y * (1 + size * 4) + 1 + x * 4
    raw[offset] = color[0]; raw[offset + 1] = color[1]; raw[offset + 2] = color[2]; raw[offset + 3] = 255
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const api = `http://127.0.0.1:${server.address().port}`
  vite = await createViteServer({ cacheDir: join(output, 'vite-cache'), server: { host: '127.0.0.1', port: await freePort(), strictPort: true,
    watch: { ignored: ['**/player-client/**', '**/.qa/**', '**/.data/**'] }, proxy: { '/api': { target: api, changeOrigin: true } } } })
  await vite.listen()
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`
  report.apiPort = server.address().port; report.uiPort = vite.httpServer.address().port
  const require = createRequire(import.meta.url)
  const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } })
  const playerContext = await browser.newContext()
  const readerContext = await browser.newContext()
  assert.equal((await context.request.post(api + '/api/studio/login', { data: { username: 'admin', password } })).status(), 200)
  assert.equal((await playerContext.request.post(api + '/api/studio/login', { headers: { 'X-Studio-Client': 'player' }, data: { username: player.username, password } })).status(), 200)
  assert.equal((await readerContext.request.post(api + '/api/studio/login', { data: { username: reader.username, password } })).status(), 200)
  const playerGet = path => playerContext.request.get(api + '/api/studio' + path, { headers: { 'X-Studio-Client': 'player' } })
  const playerConfig = async () => { const response = await playerGet('/player/appearance'); assert.equal(response.status(), 200); return response.json() }
  page = await context.newPage(); page.setDefaultTimeout(20_000)
  page.on('pageerror', error => report.pageErrors.push(error.message))
  page.on('response', response => { if (response.url().includes('/api/studio/') && response.status() >= 500) report.serverErrors.push({ path: new URL(response.url()).pathname, status: response.status() }) })
  const enterCard = async () => {
    await page.goto(base + '/#/system/appearance')
    await page.getByRole('heading', { name: '界面外观', exact: true }).waitFor()
    await page.getByRole('tab', { name: '打手订单卡片', exact: true }).click()
    await page.locator('.order-card-image-preview').waitFor()
  }
  const upload = async (name, color) => {
    const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/studio/uploads' && response.request().method() === 'POST')
    await page.locator('.order-card-image-settings input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: png(color) })
    const response = await waiting; assert.equal(response.status(), 200)
    const image = await response.json()
    await page.getByText(name, { exact: true }).waitFor()
    await page.locator('.order-card-preview-thumbnail img').waitFor()
    await page.locator('.order-card-preview-thumbnail img').evaluate(image => new Promise((done, reject) => {
      if (image.complete) return image.naturalWidth ? done() : reject(new Error('Image decode failed'))
      image.addEventListener('load', done, { once: true }); image.addEventListener('error', () => reject(new Error('Image decode failed')), { once: true })
    }))
    assert.equal(await page.locator('.order-card-preview-thumbnail img').evaluate(image => image.naturalWidth), 200)
    return image
  }
  const save = async (status = 200, confirmConflict = false) => {
    const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/studio/appearance' && response.request().method() === 'POST')
    await page.getByRole('button', { name: confirmConflict ? '确认并保存草稿' : '保存到工作室', exact: true }).click()
    if (confirmConflict) {
      const confirmation = page.locator('.el-message-box:visible')
      await confirmation.getByText('最新已保存版本', { exact: true }).waitFor()
      await confirmation.getByText('当前草稿名称', { exact: true }).waitFor()
      await confirmation.getByText('隔离订单卡图片二.png', { exact: true }).waitFor()
      await confirmation.getByRole('button', { name: '确认替换并保存', exact: true }).click()
    }
    const response = await waiting; assert.equal(response.status(), status)
    const data = await response.json()
    if (status === 200) await page.locator('.el-tag').getByText('与已保存设置一致', { exact: true }).waitFor()
    return data
  }
  await enterCard()
  assert.deepEqual(await playerConfig(), { revision: 0, orderCardImage: null })
  await page.locator('.order-card-image-preview').getByText('当前草稿使用原游戏图标', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '预览应用', exact: true }).count(), 0)
  pass('existing appearance UI has a separate card-image tab, default game icon and no misleading apply-preview action')
  const first = await upload('隔离订单卡图片一.png', [50, 100, 210])
  await page.getByRole('button', { name: '读取已保存设置', exact: true }).click()
  const discard = page.locator('.el-message-box:visible')
  await discard.getByText('草稿基于版本', { exact: true }).waitFor()
  await discard.getByText('本窗口预览', { exact: true }).waitFor()
  await discard.getByRole('button', { name: '继续编辑', exact: true }).click()
  await discard.waitFor({ state: 'hidden' })
  assert.ok((await page.locator('.order-card-preview-thumbnail img').getAttribute('src')).includes(first.id))
  assert.equal((await playerConfig()).orderCardImage, null)
  pass('discard confirmation explains draft version and local preview; cancelling preserves draft without publishing')
  await page.evaluate(() => { location.hash = '/system/menu' })
  const navigationDiscard = page.locator('.el-message-box:visible')
  await navigationDiscard.getByText('草稿基于版本', { exact: true }).waitFor()
  assert.equal(await navigationDiscard.count(), 1)
  await navigationDiscard.getByRole('button', { name: '继续编辑', exact: true }).click()
  await page.waitForURL(url => url.hash.startsWith('#/system/appearance'))
  assert.ok((await page.locator('.order-card-preview-thumbnail img').getAttribute('src')).includes(first.id))
  assert.equal((await playerConfig()).orderCardImage, null)
  pass('native hash navigation keeps one pending discard confirmation; cancel restores appearance URL and unsaved draft without publishing')
  assert.equal((await playerConfig()).orderCardImage, null)
  assert.equal((await playerGet(first.url.replace('/api/studio', ''))).status(), 403)
  await page.screenshot({ path: join(output, 'uploaded-unsaved.png') })
  const saved = await save()
  assert.equal(saved.playerOrderCardImage.id, first.id)
  assert.equal((await playerConfig()).orderCardImage.id, first.id)
  const imageResponse = await playerGet(first.url.replace('/api/studio', ''))
  assert.equal(imageResponse.status(), 200); assert.match(imageResponse.headers()['cache-control'], /private.*no-store/)
  assert.deepEqual(await imageResponse.body(), png([50, 100, 210]))
  await page.screenshot({ path: join(output, 'saved-card-image.png') })
  pass('actual PNG upload decodes in admin preview, stays private before save, then enabled player reads exact saved image')
  await enterCard()
  assert.ok((await page.locator('.order-card-preview-thumbnail img').getAttribute('src')).includes(first.id))
  pass('fresh admin load restores the saved global card image')
  const second = await upload('隔离订单卡图片二.png', [30, 150, 90])
  const newer = mutate('/appearance', { revision: saved.revision, config: { ...saved, studioName: '隔离管理员已改名称' } })
  await save(409)
  await page.getByText('其他管理员已更新外观，当前草稿已保留', { exact: true }).waitFor()
  assert.ok((await page.locator('.order-card-preview-thumbnail img').getAttribute('src')).includes(second.id))
  assert.equal((await playerConfig()).orderCardImage.id, first.id)
  await page.screenshot({ path: join(output, 'revision-conflict-keeps-draft.png') })
  await page.getByRole('button', { name: '读取最新设置', exact: true }).click()
  await page.getByText('最新设置已读取，当前编辑草稿保持不变', { exact: true }).waitFor()
  const replaced = await save(200, true)
  assert.equal(replaced.revision, newer.revision + 1)
  assert.equal((await playerConfig()).orderCardImage.id, second.id)
  assert.equal((await playerGet(first.url.replace('/api/studio', ''))).status(), 403)
  assert.equal((await playerGet(second.url.replace('/api/studio', ''))).status(), 200)
  pass('stale save returns 409 without publishing draft; explicit latest-read and confirmation replace image and revoke old shared URL')
  await page.getByRole('button', { name: '移除图片', exact: true }).click()
  await page.locator('.order-card-image-preview').getByText('当前草稿使用原游戏图标', { exact: true }).waitFor()
  assert.equal((await playerConfig()).orderCardImage.id, second.id)
  const removed = await save()
  assert.equal(removed.playerOrderCardImage, null)
  assert.equal((await playerConfig()).orderCardImage, null)
  assert.equal((await playerGet(second.url.replace('/api/studio', ''))).status(), 403)
  pass('remove previews original game icon and only saved removal changes player projection or old image sharing')
  const third = await upload('隔离订单卡图片三.png', [155, 100, 200])
  const thirdSaved = await save()
  const denied = await readerContext.request.post(api + '/api/studio/appearance', { headers: { 'X-Studio-Actor': reader.id }, data: { config: { ...thirdSaved, playerOrderCardImage: null }, revision: thirdSaved.revision } })
  assert.equal(denied.status(), 403); assert.equal((await playerConfig()).orderCardImage.id, third.id)
  pass('read-only staff cannot edit saved image through actual HTTP and saved configuration remains unchanged')
  await page.getByRole('button', { name: '恢复工作室默认外观', exact: true }).click()
  const restore = page.locator('.el-message-box:visible')
  await restore.getByText('本次核对版本', { exact: true }).waitFor()
  await restore.getByText('隔离订单卡图片三.png', { exact: true }).waitFor()
  await restore.getByText('未配置，打手显示原游戏图标', { exact: true }).waitFor()
  await restore.getByRole('button', { name: '确认恢复并保存', exact: true }).click()
  await page.getByText('工作室默认外观已恢复', { exact: false }).waitFor()
  assert.equal((await playerConfig()).orderCardImage, null)
  assert.equal((await playerGet(third.url.replace('/api/studio', ''))).status(), 403)
  assert.equal(service.getAppearance('admin').studioName, '电竞工作室')
  await page.locator('.order-card-image-preview').getByText('当前草稿使用原游戏图标', { exact: true }).waitFor()
  pass('existing full restore-default action clears global card image and preserves original default appearance flow')
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 1000 ? 844 : 1050 })
    await enterCard()
    await page.locator('.order-card-image-preview').scrollIntoViewIfNeeded()
    const layout = await page.evaluate(() => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth,
      previewWidth: document.querySelector('.order-card-preview-thumbnail').getBoundingClientRect().width }))
    assert.ok(layout.pageWidth <= width + 1); assert.ok(layout.previewWidth >= 50)
    report.layouts.push(layout)
    await page.screenshot({ path: join(output, `layout-${width}.png`), fullPage: true })
    await page.screenshot({ path: join(output, `viewport-${width}.png`) })
  }
  pass('new card-image editor and preview remain usable at 390/768/1440 widths without horizontal overflow')
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.serverErrors, [])
  report.passed = true
} catch (error) {
  report.error = error.message; report.stack = error.stack; process.exitCode = 1
  if (page) { try { report.failedUrl = page.url(); await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }) } catch {} }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
  if (server.listening) await new Promise(done => server.close(done))
  else service.close()
  report.sourceAfter = sourceFingerprint()
  report.sourceUnchanged = before.digest === report.sourceAfter.digest
  if (!report.sourceUnchanged) { report.passed = false; report.sourceChangeError = 'Source changed during UI acceptance'; process.exitCode = 1 }
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outputRoot, 'latest-result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, pageErrors: report.pageErrors.length, sourceUnchanged: report.sourceUnchanged, output, error: report.error }))
}
