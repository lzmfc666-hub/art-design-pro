import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createPortProbe } from 'node:net'
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { createStudioServer } from '../../server/index.mjs'
import { createServer as createViteServer } from '../node_modules/vite/dist/node/index.js'

// Persistent isolated fixture for CUA-driven browser QA. No browser automation,
// live database, fixed development port, external notification or successful
// response stub is used. Explicit faults are listed in the control metadata.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(root, 'player-client/.qa/v33-card-image-client', `browser-${randomUUID()}`)
await mkdir(output, { recursive: true })
const metadataPath = resolve(output, 'metadata.private.json')
const password = `V33qa${randomUUID().replaceAll('-', '')}`
const controlToken = randomUUID()
const sha256 = value => createHash('sha256').update(value).digest('hex')
const listen = server => new Promise(ready => server.listen(0, '127.0.0.1', ready))
const address = server => `http://127.0.0.1:${server.address().port}`
const close = server => new Promise(ready => server.close(ready))
async function freePort() {
  const probe = createPortProbe()
  await listen(probe)
  const port = probe.address().port
  await close(probe)
  assert.ok(![3006, 3007, 3008].includes(port))
  return port
}
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(name, data) {
  const body = Buffer.concat([Buffer.from(name), data]), header = Buffer.alloc(4), crc = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([header, body, crc])
}
function testPng(primary, alternate) {
  const width = 160, height = 160, raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const color = (x > 38 && x < 122 && y > 38 && y < 122) ? alternate : primary
      raw.set(color, row + 1 + x * 3)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
const pngA = testPng([19, 92, 223], [122, 206, 255])
const pngB = testPng([231, 64, 74], [255, 192, 73])
await writeFile(resolve(output, 'image-A-blue.png'), pngA)
await writeFile(resolve(output, 'image-B-red.png'), pngB)
const backend = createStudioServer({ dbPath: resolve(output, 'isolated.sqlite'), seed: false, password, maintenanceFromEnv: false,
  backups: { intervalMinutes: 0, directory: resolve(output, 'backups'), failureWebhook: '' }, notificationIntervalMs: 86_400_000,
  notifications: { pushSender: async () => { throw new Error('External notifications disabled in v3.3 browser fixture') } } })
await listen(backend)
const backendBase = address(backend)
const actors = new Map([['admin', { id: 'admin', username: 'admin' }]])
const cookies = new Map()
async function api(actor, path, body, expected = 200) {
  const row = actors.get(actor)
  const response = await fetch(`${backendBase}/api/studio/${path.replace(/^\//, '')}`, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      ...(row?.role === 'player' ? { 'X-Studio-Client': 'player' } : {}),
      ...(cookies.has(actor) ? { Cookie: cookies.get(actor) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(path === 'login' ? {} : { 'X-Studio-Actor': row.id }) })
    }, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const cookie = response.headers.get('set-cookie')
  if (cookie) cookies.set(actor, cookie.split(';')[0])
  const value = await response.json()
  assert.equal(response.status, expected, `${actor} ${path}: ${value.message || response.status}`)
  return value
}
await api('admin', 'login', { username: 'admin', password })
const level = await api('admin', 'levels', { name: 'v3.3浏览器专用隔离等级', delaySeconds: 0 })
for (const actor of ['A', 'B']) {
  actors.set(actor, await api('admin', 'users', { username: `v33-browser-${actor.toLowerCase()}-${randomUUID().slice(0, 7)}`,
    name: `卡片图片隔离打手${actor}`, role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 3,
    permissionOverrides: {}, password }))
  await api(actor, 'login', { username: actors.get(actor).username, password })
}
const customer = await api('admin', 'customers', { name: '卡图隔离客户', contact: 'PRIVATE-CUSTOMER-CONTACT-NOT-FOR-PLAYER', gameId: 'PRIVATE-CUSTOMER-GAME' })
const template = await api('admin', 'templates', { name: '70 788w', game: '三角洲行动', amount: 10000, reward: 7000,
  description: '任务要求：目标 788w · 按约定路线完成', map: '长弓溪谷', active: true })
const orders = []
for (let index = 0; index < 5; index++) {
  orders.push(await api('admin', 'orders', { requestId: randomUUID(), templateId: template.id, customerId: customer.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), amount: 10000, reward: 7000,
    receivedAmount: 10000, paidAt: new Date().toISOString(), roomCode: 'PRIVATE-ROOM-CODE', gameId: 'PRIVATE-GAME-ID',
    dispatchMode: index === 0 ? 'direct' : 'pool', ...(index === 0 ? { assignedTo: actors.get('A').id } : {}),
    playerRemark: index === 1 ? '打手备注：这是后台明确授权展示给打手的要求。请按约定流程执行，完成后上传清晰材料。'.repeat(5) : '打手备注：保持沟通，按要求完成任务。',
    remark: 'INTERNAL-REMARK-NEVER-EXPOSE' }))
}
await api('A', `player/orders/${orders[0].id}/claim`, { requestId: randomUUID(), expectedRevision: orders[0].revision, dispatchRound: orders[0].dispatchRound })
const imageA = await api('admin', 'uploads', { name: 'v33-browser-A-blue.png', mime: 'image/png', data: pngA.toString('base64') })
const imageB = await api('admin', 'uploads', { name: 'v33-browser-B-red.png', mime: 'image/png', data: pngB.toString('base64') })
async function save(image) {
  const config = await api('admin', 'appearance')
  return api('admin', 'appearance', { config: { ...config, playerOrderCardImage: image }, revision: config.revision })
}
await save(imageA)

const flags = { configError: false, imageError: 0, holdConfig: 0, holdImage: 0 }
const held = new Map(), requests = [], sockets = new Set()
let sequence = 0, shuttingDown = false, vite
const gateway = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const kind = req.method === 'GET' && url.pathname === '/api/studio/player/appearance' ? 'config'
    : req.method === 'GET' && /^\/api\/studio\/uploads\/[^/]+$/.test(url.pathname) ? 'image' : 'other'
  const row = { sequence: ++sequence, method: req.method, path: req.url, kind, startedAt: new Date().toISOString(), status: null, held: false }
  requests.push(row)
  const record = () => appendFile(resolve(output, 'requests.jsonl'), JSON.stringify(row) + '\n').catch(() => {})
  if ((kind === 'config' && flags.configError) || (kind === 'image' && flags.imageError)) {
    row.status = kind === 'config' ? 503 : flags.imageError
    row.explicitFaultInjection = true
    res.writeHead(row.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ code: 'QA_EXPLICIT_READ_FAULT', message: '隔离验证：读取暂不可用' }))
    record()
    return
  }
  const shouldHold = kind === 'config' ? flags.holdConfig > 0 : kind === 'image' ? flags.holdImage > 0 : false
  if (shouldHold) {
    if (kind === 'config') flags.holdConfig--
    else flags.holdImage--
  }
  const upstream = httpRequest(`${backendBase}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(backendBase).host } }, real => {
    row.status = real.statusCode
    if (!shouldHold) {
      res.writeHead(real.statusCode, real.headers)
      real.pipe(res)
      real.on('end', record)
      return
    }
    const chunks = []
    real.on('data', chunk => chunks.push(chunk))
    real.on('end', () => {
      const original = Buffer.concat(chunks)
      row.held = true
      row.originalResponseSha256 = sha256(original)
      row.originalResponseBytes = original.length
      held.set(row.sequence, { row, res, status: real.statusCode, headers: real.headers, original })
      record()
    })
  })
  upstream.on('error', error => {
    row.upstreamError = error.message
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ code: 'QA_UPSTREAM_ERROR', message: '隔离验证连接失败' }))
    record()
  })
  req.pipe(upstream)
})
for (const server of [backend, gateway]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await listen(gateway)
const gatewayBase = address(gateway)
process.env.STUDIO_API_TARGET = gatewayBase
vite = await createViteServer({ root: resolve(root, 'player-client'), configFile: resolve(root, 'player-client/vite.config.ts'),
  cacheDir: resolve(output, 'vite-cache'), server: { host: '127.0.0.1', port: await freePort(), strictPort: true } })
await vite.listen()
const frontendBase = `http://127.0.0.1:${vite.httpServer.address().port}`
function release(kind) {
  let count = 0
  for (const [id, item] of held) {
    if (kind && item.row.kind !== kind) continue
    item.row.releasedAt = new Date().toISOString()
    item.row.clientAlreadyClosed = item.res.destroyed
    if (!item.res.destroyed) { item.res.writeHead(item.status, item.headers); item.res.end(item.original) }
    held.delete(id); count++
  }
  return count
}
function state() {
  const config = backend.service.getAppearance('admin')
  return { flags, current: { revision: config.revision, imageId: config.playerOrderCardImage?.id || null },
    held: [...held.values()].map(({ row }) => row), requestCount: requests.length, frontendBase, backendBase, gatewayBase }
}
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await writeFile(resolve(output, 'requests-final.json'), JSON.stringify(requests, null, 2))
  for (const item of held.values()) item.res.destroy()
  held.clear()
  await vite.close()
  for (const socket of sockets) socket.destroy()
  await Promise.all([close(gateway), close(backend), close(control)])
}
const control = createServer(async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  if (req.headers.origin || req.headers['x-qa-control-token'] !== controlToken) { reply(403, { message: 'QA control access denied' }); return }
  try {
    if (req.method === 'GET' && req.url === '/state') { reply(200, state()); return }
    if (req.method === 'GET' && req.url === '/requests') { reply(200, requests); return }
    if (req.method !== 'POST' || req.url !== '/control') { reply(404, { message: 'Unknown QA control path' }); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    let result = null
    switch (input.action) {
      case 'save-a': result = await save(imageA); break
      case 'save-b': result = await save(imageB); break
      case 'remove': result = await save(null); break
      case 'reset': { const current = await api('admin', 'appearance'); result = await api('admin', 'appearance/reset', { revision: current.revision }); break }
      case 'config-error-on': flags.configError = true; break
      case 'config-error-off': flags.configError = false; break
      case 'image-403': flags.imageError = 403; break
      case 'image-404': flags.imageError = 404; break
      case 'image-error-off': flags.imageError = 0; break
      case 'hold-config': flags.holdConfig++; break
      case 'hold-image': flags.holdImage++; break
      case 'release': result = { released: release() }; break
      case 'release-config': result = { released: release('config') }; break
      case 'release-image': result = { released: release('image') }; break
      case 'clear-log': requests.length = 0; break
      case 'login-off-a': result = await api('admin', 'users', { ...actors.get('A'), playerAccess: { login: false, claim: true, withdraw: true } }); break
      case 'login-on-a': result = await api('admin', 'users', { ...actors.get('A'), status: 'active', playerAccess: { login: true, claim: true, withdraw: true } }); break
      case 'disable-a': result = await api('admin', 'users', { ...actors.get('A'), status: 'disabled' }); break
      case 'shutdown': reply(200, { shuttingDown: true }); setTimeout(() => shutdown().then(() => process.exit(0)), 50); return
      default: reply(400, { message: 'Unknown QA action' }); return
    }
    await writeFile(resolve(output, 'control-state.json'), JSON.stringify(state(), null, 2))
    reply(200, { action: input.action, result, state: state() })
  } catch (error) { reply(500, { message: error.message }) }
})
await listen(control)
const controlBase = address(control)
const metadata = { output, metadataPath, password, controlToken, controlBase, backendBase, gatewayBase, frontendBase,
  loginUrl: `${frontendBase}/#/player/login`, lobbyUrl: `${frontendBase}/#/player/lobby`, tasksUrl: `${frontendBase}/#/player/tasks`,
  players: Object.fromEntries(['A', 'B'].map(actor => [actor, { id: actors.get(actor).id, username: actors.get(actor).username }])),
  images: { A: imageA, B: imageB }, orders: { activeA: orders[0].id, pending: orders.slice(1).map(order => order.id) },
  contractSha256: sha256(await readFile(resolve(root, 'docs/STUDIO-CONTRACT.md'))),
  processId: process.pid,
  controls: ['save-a', 'save-b', 'remove', 'reset', 'config-error-on', 'config-error-off', 'image-403', 'image-404', 'image-error-off',
    'hold-config', 'hold-image', 'release', 'release-config', 'release-image', 'clear-log', 'login-off-a', 'login-on-a', 'disable-a', 'shutdown'],
  controlUsage: 'GET /state or /requests, POST /control {action}; all require X-QA-Control-Token from this file and reject Origin.',
  faultMeaning: 'config-error-on and image-403/404 are explicit isolated fault responses, never fake success. Held config/image captures original backend status, headers and bytes before release.',
  limitations: ['Desktop browser QA only; no real phone, HTTPS, keyboard/safe-area or external push validation.'] }
await writeFile(metadataPath, JSON.stringify(metadata, null, 2))
await writeFile(resolve(output, 'control-state.json'), JSON.stringify(state(), null, 2))
console.log(JSON.stringify({ metadataPath, localUrl: metadata.loginUrl }))
process.once('SIGINT', () => shutdown().then(() => process.exit(0)))
process.once('SIGTERM', () => shutdown().then(() => process.exit(0)))
