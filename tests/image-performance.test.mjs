import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createStudioServer } from '../server/index.mjs'
import { createImageVariants } from '../server/image-variants.mjs'
import { testMutate } from './helpers/current-intent.mjs'

const password = 'isolated-image-performance-20261018'
async function fixture(t, imageVariants, options = {}) {
  const server = createStudioServer({ dbPath: ':memory:', password, seed: false, imageVariants, ...options })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const headers = { Cookie: cookie, 'X-Studio-Actor': 'admin' }
  return { server, base, cookie, headers }
}
const validPng = () => sharp({ create: { width: 80, height: 60, channels: 4,
  background: { r: 40, g: 80, b: 120, alpha: 1 } } }).png().toBuffer()

test('二进制与旧JSON上传共用权限及校验，原图字节保持不变', async t => {
  const f = await fixture(t), data = await validPng()
  const send = (body, extra = {}) => fetch(f.base + '/uploads', { method: 'POST',
    headers: { ...f.headers, 'Content-Type': 'image/png', 'X-Upload-Name': encodeURIComponent('原始凭证.png'), ...extra }, body })
  const response = await send(data)
  assert.equal(response.status, 200)
  const image = await response.json()
  assert.equal(image.name, '原始凭证.png')
  assert.equal(image.size, data.length)
  const original = await fetch(f.base + '/uploads/' + image.id, { headers: f.headers })
  assert.equal(original.status, 200)
  assert.equal(original.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), data)
  assert.deepEqual(f.server.service.download('admin', image.id).data, data)
  const legacy = await send(JSON.stringify({ name: '兼容旧客户端.png', mime: 'image/png', data: data.toString('base64') }),
    { 'Content-Type': 'application/json' })
  assert.equal(legacy.status, 200)
  assert.deepEqual(f.server.service.download('admin', (await legacy.json()).id).data, data)
  assert.equal((await send(data, { 'X-Studio-Actor': 'another-account' })).status, 409)
  assert.equal((await send(data, { 'X-Upload-Name': '%invalid' })).status, 400)
  assert.equal((await send(Buffer.from('not an image'))).status, 400)
  assert.equal((await send(data, { 'Content-Type': 'image/svg+xml' })).status, 415)
  assert.equal((await send(Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413)
})

test('大图首屏只传缩略图，原图完整且私图缓存不绕过授权', async t => {
  const f = await fixture(t)
  const data = await sharp(randomBytes(1600 * 1200 * 3), { raw: { width: 1600, height: 1200, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer()
  const image = f.server.service.uploadBinary('admin', { name: '大原始图.png', mime: 'image/png', data })
  const path = f.base + '/uploads/' + image.id + '?variant=thumb'
  const response = await fetch(path, { headers: f.headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('content-type'), 'image/webp')
  const thumbnail = Buffer.from(await response.arrayBuffer()), metadata = await sharp(thumbnail).metadata()
  assert.ok(metadata.width <= 480 && metadata.height <= 360)
  assert.ok(thumbnail.length < data.length / 10, `thumb ${thumbnail.length}, original ${data.length}`)
  assert.deepEqual(f.server.service.download('admin', image.id).data, data)
  assert.equal(f.server.imageVariants.metrics().cached, 1)
  assert.equal((await fetch(path)).status, 401)
  const other = testMutate(f.server.service, 'admin', '/users', { username: 'image-outsider', name: '其他员工', role: 'support',
    status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password })
  const login = await fetch(f.base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: other.username, password }) })
  const otherCookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(path, { headers: { Cookie: otherCookie } })).status, 403)
  assert.equal((await fetch(path.replace('thumb', 'invalid'), { headers: f.headers })).status, 400)
})

test('公开图片ETag条件请求仍重新核对公开槽，移除后不能用304续读', async t => {
  const f = await fixture(t), data = await validPng()
  const image = f.server.service.uploadBinary('admin', { name: '公开Logo.png', mime: 'image/png', data })
  const config = f.server.service.getAppearance('admin')
  testMutate(f.server.service, 'admin', '/appearance', { config: { ...config, logo: image }, revision: config.revision })
  const path = f.base + '/public-assets/' + image.id + '?variant=thumb&v=' + image.id
  const first = await fetch(path)
  assert.equal(first.status, 200)
  const etag = first.headers.get('etag')
  assert.ok(etag)
  assert.equal(first.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
  await first.arrayBuffer()
  const conditional = await fetch(path, { headers: { 'If-None-Match': etag } })
  assert.equal(conditional.status, 304)
  const next = f.server.service.getAppearance('admin')
  testMutate(f.server.service, 'admin', '/appearance', { config: { ...next, logo: null }, revision: next.revision })
  assert.equal((await fetch(path, { headers: { 'If-None-Match': etag } })).status, 404)
})

test('缩图解码畸形数据不会改变原图，队列失败后继续服务合法图片', async t => {
  const f = await fixture(t), malformed = Buffer.from('89504e470d0a1a0a6e6f742d612d706e67', 'hex')
  const bad = f.server.service.uploadBinary('admin', { name: '历史畸形.png', mime: 'image/png', data: malformed })
  assert.equal((await fetch(f.base + '/uploads/' + bad.id + '?variant=thumb', { headers: f.headers })).status, 422)
  assert.deepEqual(f.server.service.download('admin', bad.id).data, malformed)
  const good = f.server.service.uploadBinary('admin', { name: '合法.png', mime: 'image/png', data: await validPng() })
  const response = await fetch(f.base + '/uploads/' + good.id + '?variant=thumb', { headers: f.headers })
  assert.equal(response.status, 200)
  await response.arrayBuffer()
})

test('并发缩图去重、有界排队、拒绝超限，关闭不会遗留排队任务', async () => {
  const releases = [], variants = createImageVariants({ concurrency: 1, maxQueued: 1, maxBytes: 10,
    transform: () => new Promise(resolve => releases.push(resolve)) })
  const image = id => ({ id, data: Buffer.from(id) })
  const first = variants.get(image('one'), 'thumb')
  assert.equal(variants.get(image('one'), 'thumb'), first)
  const second = variants.get(image('two'), 'thumb')
  assert.throws(() => variants.get(image('three'), 'thumb'), error => error.status === 429)
  await new Promise(resolve => setImmediate(resolve))
  releases.shift()(Buffer.from('small'))
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(variants.metrics().active, 1)
  const queued = variants.get(image('three'), 'thumb')
  const rejected = assert.rejects(queued, error => error.status === 503)
  variants.close()
  await rejected
  releases.shift()(Buffer.from('small'))
  await second
  assert.equal(variants.metrics().cached, 0)
})

test('异步缩图期间退出登录，响应不能在旧会话下发送图片', async t => {
  let release
  const f = await fixture(t, { transform: () => new Promise(resolve => { release = resolve }) })
  const image = f.server.service.uploadBinary('admin', { name: '退出前图片.png', mime: 'image/png', data: await validPng() })
  const response = fetch(f.base + '/uploads/' + image.id + '?variant=thumb', { headers: f.headers })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  f.server.service.logout(f.cookie.split('=')[1])
  release(Buffer.from('no-private-pixels'))
  assert.equal((await response).status, 401)
})

test('已有缩图不能绕过归档完整性和到期删除，损坏归档仍报503，删除仍报410', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-image-variants-'))
  let time = new Date('2026-01-01T00:00:00Z')
  const f = await fixture(t, undefined, { clock: () => time, imageArchive: { directory: join(root, 'private-archive') } })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mutate = (path, body, actor = 'admin') => testMutate(f.server.service, actor, path, body)
  const level = mutate('/levels', { name: '缩图测试等级', delaySeconds: 0 })
  const player = mutate('/users', { username: 'variant-archive-player', name: '缩图归档打手', role: 'player',
    status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
  const customer = mutate('/customers', { name: '缩图隔离客户', contact: '', gameId: '', remark: '' })
  const template = mutate('/templates', { name: '缩图隔离订单', game: '隔离', amount: 10000, reward: 7000, active: true })
  const image = f.server.service.uploadBinary(player.id, { name: '归档原图.png', mime: 'image/png', data: await validPng() })
  const order = mutate('/orders', { customerId: customer.id, templateId: template.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: 'image-variant-archive', roomCode: 'private-room',
    receivedAmount: 10000, paidAt: time.toISOString(), dispatchMode: 'pool' })
  mutate(`/player/orders/${order.id}/claim`, {}, player.id)
  mutate(`/player/orders/${order.id}/submit`, { screenshots: [image] }, player.id)
  mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  const path = f.base + '/uploads/' + image.id + '?variant=thumb'
  assert.equal((await fetch(path, { headers: f.headers })).status, 200)
  time = new Date('2026-02-02T00:00:00Z')
  const renewed = await fetch(f.base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }) })
  f.headers.Cookie = renewed.headers.get('set-cookie').split(';')[0]
  assert.equal((await f.server.service.archiveCompletedOrderImages({ retentionDays: 30, limit: 5 })).archived, 1)
  assert.equal((await fetch(path, { headers: f.headers })).status, 200)
  const archive = f.server.service.db.prepare('SELECT * FROM image_archives WHERE upload_id=?').get(image.id)
  writeFileSync(join(archive.archive_root, archive.file_name), Buffer.alloc(archive.size))
  assert.equal((await fetch(path, { headers: f.headers })).status, 503)
  // Simulate the same tombstone written by the separately tested retention task.
  f.server.service.db.exec('CREATE TABLE IF NOT EXISTS image_deletions(upload_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,completed_at TEXT NOT NULL,size INTEGER NOT NULL)')
  f.server.service.db.prepare('INSERT INTO image_deletions VALUES(?,?,?,?)').run(image.id, time.toISOString(),
    '2026-01-01T00:00:00Z', image.size)
  assert.equal((await fetch(path, { headers: f.headers })).status, 410)
})
