import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import sharp from 'sharp'
import { uploadPreviewFixture } from '../tests/helpers/upload-preview-fixture.mjs'

// Exercises the exact preview proxy with the built real Vue clients. The
// existing 3106/3107/3108 preview and its fake data remain running untouched.
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.STUDIO_PLAYWRIGHT_MODULE ||
  'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = resolve('.qa/production-fixes-20261018/upload-proxy-ui', `run-${randomUUID()}`)
mkdirSync(output, { recursive: true })
const previewBuilds = resolve('.qa/production-fixes-20261018/preview-builds')
const fixture = await uploadPreviewFixture({
  adminDirectory: existsSync(join(previewBuilds, 'admin/index.html')) ? join(previewBuilds, 'admin') : resolve('dist'),
  playerDirectory: existsSync(join(previewBuilds, 'player/index.html')) ? join(previewBuilds, 'player') : resolve('player-client/dist')
})
const report = { passed: false, database: ':memory:', existingPreviewRestarted: false,
  cases: [], uploads: [], errors: [], output }
const png = await sharp({ create: { width: 120, height: 90, channels: 3, background: '#4488bb' } }).png().toBuffer()
let browser
async function uploadThroughUi(page, locator, name, actorId) {
  const pending = page.waitForResponse(response => response.url().endsWith('/api/studio/uploads') && response.request().method() === 'POST')
  await locator.setInputFiles({ name, mimeType: 'image/png', buffer: png })
  const response = await pending, image = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(image))
  const headers = await response.request().allHeaders()
  assert.equal(headers['x-upload-name'], encodeURIComponent(name))
  assert.equal(image.name, name)
  const upstream = fixture.uploads.findLast(row => row.nameHeader === encodeURIComponent(name))
  assert.ok(upstream, 'upstream must receive the same filename header from the actual browser')
  assert.equal(upstream.actor, actorId)
  assert.deepEqual(fixture.api.service.download(actorId, image.id).data, png)
  report.uploads.push({ name, status: response.status(), clientFilenameHeader: headers['x-upload-name'],
    upstreamFilenameHeader: upstream.nameHeader, channel: upstream.channel, originalBytesEqual: true })
  return image
}
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  assert.equal((await adminContext.request.post(fixture.bases.admin + '/api/studio/login', {
    data: { username: 'admin', password: fixture.password }
  })).status(), 200)
  const admin = await adminContext.newPage()
  admin.on('pageerror', error => report.errors.push(error.message))
  await admin.goto(fixture.bases.admin + '/#/system/appearance')
  await admin.getByRole('heading', { name: '界面外观', exact: true }).waitFor()
  const logo = await uploadThroughUi(admin, admin.locator('.appearance-image-upload input[type=file]').first(),
    '工作室 中文 Logo 空格.png', 'admin')
  await admin.waitForFunction(() => {
    const image = document.querySelector('.appearance-image-upload .image-select img')
    return image?.complete && image.naturalWidth > 0
  })
  const savedAppearance = admin.waitForResponse(response => response.url().endsWith('/api/studio/appearance') && response.request().method() === 'POST')
  await admin.getByRole('button', { name: '保存到工作室', exact: true }).click()
  assert.equal((await savedAppearance).status(), 200)
  assert.equal(fixture.api.service.getAppearance('admin').logo.id, logo.id)
  await admin.screenshot({ path: join(output, 'appearance-logo-upload.png'), fullPage: true })
  report.cases.push('actual appearance Logo selection, binary upload, thumbnail and save through admin proxy')

  const playerContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  assert.equal((await playerContext.request.post(fixture.bases.player + '/api/studio/login', {
    data: { username: fixture.person.username, password: fixture.password }
  })).status(), 200)
  const player = await playerContext.newPage()
  player.on('pageerror', error => report.errors.push(error.message))
  await player.goto(fixture.bases.player + '/#/player/profile')
  await player.getByText('更换头像', { exact: true }).waitFor()
  const avatar = await uploadThroughUi(player, player.locator('input[type=file]'), '我的 中文 头像 空格.png', fixture.person.id)
  const savedProfile = player.waitForResponse(response => response.url().endsWith('/api/studio/profile') && response.request().method() === 'POST')
  await player.getByRole('button', { name: '保存资料', exact: true }).click()
  assert.equal((await savedProfile).status(), 200)
  const profile = await playerContext.request.get(fixture.bases.player + '/api/studio/player/profile')
  assert.equal((await profile.json()).user.avatar.id, avatar.id)
  await player.waitForFunction(() => {
    const image = document.querySelector('img[alt="头像"]')
    return image?.complete && image.naturalWidth > 0
  })
  await player.screenshot({ path: join(output, 'player-avatar-upload.png'), fullPage: true })
  report.cases.push('actual player avatar upload, thumbnail and profile save through player proxy')

  await player.goto(fixture.bases.player + `/#/player/orders/${fixture.order.id}`)
  await player.getByRole('heading', { name: '提交完成材料', exact: true }).waitFor()
  const material = await uploadThroughUi(player, player.locator('.p-upload-button input[type=file]'),
    '订单 完成材料 中文 空格.png', fixture.person.id)
  await player.waitForFunction(() => {
    const image = document.querySelector('.p-upload-thumb img')
    return image?.complete && image.naturalWidth > 0
  })
  const submitted = player.waitForResponse(response => response.url().endsWith(`/api/studio/player/orders/${fixture.order.id}/submit`) && response.request().method() === 'POST')
  await player.getByRole('button', { name: '提交完成，等待验收', exact: true }).click()
  assert.equal((await submitted).status(), 200)
  const current = fixture.api.service.orderDetail('admin', fixture.order.id).order
  assert.equal(current.status, 'review')
  assert.equal(current.submissions.at(-1).screenshots[0].id, material.id)
  await player.screenshot({ path: join(output, 'player-order-material-upload.png'), fullPage: true })
  report.cases.push('actual order material upload, thumbnail and fulfillment submission through player proxy')
  assert.deepEqual(report.errors, [])
  report.passed = true
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await browser?.close(); await fixture.stop()
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, uploads: report.uploads.length,
    errors: report.errors, output }))
}
