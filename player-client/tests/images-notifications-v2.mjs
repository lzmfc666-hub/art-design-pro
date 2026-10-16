import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import ts from '../node_modules/typescript/lib/typescript.js'
import { createRequire } from 'node:module'

const clientRoot = fileURLToPath(new URL('../', import.meta.url))
const output = path.resolve(process.env.STUDIO_QA_ROOT || path.resolve(clientRoot, '.qa'), 'images-notifications-v2')
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const results = []
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main><h2>图片清晰度检查</h2><div id="preview"></div></main></body></html>')
  const source = await readFile(path.join(clientRoot, 'src/utils/prepareImage.ts'), 'utf8')
  const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '')
  await page.addScriptTag({ content: script + '\nwindow.prepareImage = prepareImage' })
  const imageResults = await page.evaluate(async () => {
    const checks = [], ok = (condition, name, details = {}) => { if (!condition) throw new Error(name); checks.push({ name, passed: true, ...details }) }
    const make = async (width, height, type, name) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#101018'; ctx.font = `${Math.max(16, width / 40)}px sans-serif`
      for (let y = 60; y < height; y += Math.max(40, width / 25)) ctx.fillText('验收材料：截图文字必须清晰可读 1234567890', 30, y)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.97))
      return new File([blob], name, { type })
    }
    const png = await make(1080, 2340, 'image/png', 'screen.png'), progress = []
    const same = await window.prepareImage(png, { kind: 'evidence', onProgress: (n) => progress.push(n) })
    ok(same === png && same.type === 'image/png', 'normal PNG evidence stays unchanged and lossless')
    ok(progress[0] === 0 && progress.at(-1) === 100, 'preparation progress starts at zero and finishes at 100')
    const qr = await make(1600, 1600, 'image/png', 'qr.png'), qrResult = await window.prepareImage(qr, { kind: 'qr' })
    ok(qrResult === qr, 'normal QR image remains unchanged')
    const avatar = await make(3000, 3000, 'image/png', 'avatar.png'), avatarResult = await window.prepareImage(avatar, { kind: 'avatar' })
    const bitmap = await createImageBitmap(avatarResult)
    ok(bitmap.width === 1024 && bitmap.height === 1024 && avatarResult.size < avatar.size, 'large avatar is reduced to 1024 while retaining lossless PNG', { before: avatar.size, after: avatarResult.size })
    bitmap.close()
    const jpg = await make(4800, 3600, 'image/jpeg', 'large.jpg'), jpgResult = await window.prepareImage(jpg, { kind: 'evidence' })
    const evidence = await createImageBitmap(jpgResult)
    ok(evidence.width === 3200 && evidence.height === 2400 && jpgResult.size < jpg.size, 'large JPEG evidence is reduced to readable 3200 width', { before: jpg.size, after: jpgResult.size })
    evidence.close()
    const transparent = new File([await new Promise((resolve) => { const c = document.createElement('canvas'); c.width = c.height = 200; c.toBlob(resolve, 'image/webp') })], 'alpha.webp', { type: 'image/webp' })
    ok(await window.prepareImage(transparent, { kind: 'qr' }) === transparent, 'small transparent WebP is not converted to JPEG')
    const controller = new AbortController(); controller.abort()
    try { await window.prepareImage(png, { signal: controller.signal }); throw new Error('missing abort') } catch (cause) { ok(cause.name === 'AbortError', 'preprocessing honors cancellation') }
    try { await window.prepareImage(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })); throw new Error('missing rejection') } catch (cause) { ok(cause.message.includes('JPG'), 'unsupported image type is rejected before decode') }
    try { await window.prepareImage(new File([], 'empty.png', { type: 'image/png' })); throw new Error('missing empty rejection') } catch (cause) { ok(cause.message.includes('为空'), 'empty file is rejected') }
    try { await window.prepareImage(new File([new Uint8Array(41 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' })); throw new Error('missing size rejection') } catch (cause) { ok(cause.message.includes('过大'), 'oversized source is rejected before decode') }
    const preview = document.querySelector('#preview')
    for (const [title, file] of [['原截图保真', same], ['大图处理后', jpgResult], ['二维码保真', qrResult]]) {
      const caption = document.createElement('p'); caption.textContent = title; preview.append(caption)
      const img = document.createElement('img'); img.src = URL.createObjectURL(file); img.style.width = '100%'; preview.append(img)
      await img.decode()
    }
    ok(document.documentElement.scrollWidth === window.innerWidth, 'image preview has no mobile horizontal overflow')
    return checks
  })
  results.push(...imageResults)
  await page.screenshot({ path: path.join(output, 'compression-preview-390.png'), fullPage: true })
} finally { await browser.close() }

const workerSource = await readFile(path.join(clientRoot, 'public/player-sw.js'), 'utf8')
const listeners = {}, notifications = [], navigation = [], closed = []
const self = {
  addEventListener: (name, handler) => { listeners[name] = handler }, skipWaiting: () => {},
  location: { origin: 'https://worker.example.test' },
  clients: { claim: async () => {}, matchAll: async () => [{ url: 'https://worker.example.test/#/player/lobby', navigate: async (url) => navigation.push(url), focus: async () => {} }], openWindow: async () => {} },
  registration: { showNotification: async (title, options) => notifications.push({ title, options }), getNotifications: async () => [{ close: () => closed.push(true) }] }
}
vm.runInNewContext(workerSource, { self, URL })
assert.equal(listeners.fetch, undefined)
assert.equal(listeners.sync, undefined)
results.push({ name: 'service worker has no offline cache or background business-write handler', passed: true })
const event = async (name, extra = {}) => { let pending; listeners[name]({ ...extra, waitUntil: (promise) => { pending = promise } }); await pending }
await event('push'); await event('push')
assert.equal(notifications[0].options.tag, notifications[1].options.tag)
assert.equal(notifications[0].options.renotify, false)
assert.equal(JSON.stringify(notifications).includes('amount'), false)
results.push({ name: 'duplicate push uses one silent-update tag and generic content only', passed: true })
await event('notificationclick', { notification: { close: () => {} } })
assert.equal(navigation[0], 'https://worker.example.test/#/player/messages')
results.push({ name: 'notification click opens current-account message center without business mutation', passed: true })
await event('message', { data: { type: 'player-session-ended' } })
assert.equal(closed.length, 1)
results.push({ name: 'logout session message closes existing generic reminder', passed: true })
const result = { contract: '稳定性整改共享契约 v3 (2026-10-14)', scope: 'isolated browser image processing and service-worker unit validation; not real device push delivery', tests: results, passed: results.every((r) => r.passed) }
await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ passed: result.passed, count: results.length, output }))
