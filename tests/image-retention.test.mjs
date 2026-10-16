import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, existsSync, renameSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStudioServer } from '../server/index.mjs'
import { backupStudioDatabase, restoreStudioDatabase, verifyStudioBackup } from '../scripts/studio-backup.mjs'
import { testMutate } from './helpers/current-intent.mjs'
import { createUploadCleanup } from '../server/upload-cleanup.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const password = 'isolated-image-retention-123'
function fixture(t, imageArchive = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studio-image-retention-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  let time = new Date('2026-01-01T00:00:00Z')
  const path = join(root, 'source.sqlite')
  const server = createStudioServer({ dbPath: path, seed: false, password, clock: () => time,
    maintenanceFromEnv: false, imageArchive, uploadCleanup: { enabled: false },
    backups: { intervalMinutes: 0 }, notifications: { publicKey: '', privateKey: '', subject: '' } })
  const s = server.service
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    else if (s.db.isOpen) s.close()
    rmSync(root, { recursive: true, force: true })
  })
  const mutate = (route, body, actor = 'admin') => testMutate(s, actor, route, body)
  const level = mutate('/levels', { name: '隔离等级', delaySeconds: 0 })
  const player = mutate('/users', { username: 'archive-player', name: '归档打手', role: 'player',
    status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
  const outsider = mutate('/users', { username: 'other-player', name: '隔离其他打手', role: 'player',
    status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
  const customer = mutate('/customers', { name: '归档测试客户', contact: '', gameId: '', remark: '' })
  const template = mutate('/templates', { name: '归档测试订单', game: '隔离', amount: 10000, reward: 7000, active: true })
  const upload = (actor = player.id) => s.upload(actor, { name: 'material.png', mime: 'image/png', data: png })
  const order = () => mutate('/orders', { customerId: customer.id, templateId: template.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'private-room',
    receivedAmount: 10000, paidAt: time.toISOString(), dispatchMode: 'pool' })
  const complete = () => {
    const image = upload(), record = order()
    mutate(`/player/orders/${record.id}/claim`, {}, player.id)
    mutate(`/player/orders/${record.id}/submit`, { screenshots: [image] }, player.id)
    mutate(`/orders/${record.id}/action`, { action: 'review-pass' })
    return { image, record }
  }
  const state = () => JSON.parse(s.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const edit = change => { const value = state(); change(value); s.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(value)) }
  return { root, path, server, s, player, outsider, mutate, upload, order, complete, state, edit,
    setTime: value => { time = new Date(value) }, archive: () => s.archiveCompletedOrderImages({ retentionDays: 30, limit: 5 }) }
}
const inlineSize = (f, image) => f.s.db.prepare('SELECT length(data) AS size FROM uploads WHERE id=?').get(image.id).size

test('完成后30天归档保留原图和元数据，订单/账号/钱包/幂等记录不变', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  const before = f.state(), wallet = f.s.playerWallet(f.player.id)
  const requests = f.s.db.prepare('SELECT * FROM business_requests ORDER BY rowid').all()
  const result = await f.archive()
  assert.equal(result.archived, 1)
  assert.equal(result.bytes, Buffer.from(png, 'base64').length)
  assert.equal(inlineSize(f, image), 0)
  assert.deepEqual(f.s.download('admin', image.id).data, Buffer.from(png, 'base64'))
  assert.deepEqual(f.s.download(f.player.id, image.id).data, Buffer.from(png, 'base64'))
  assert.throws(() => f.s.download(f.outsider.id, image.id), error => error.status === 403)
  assert.deepEqual(f.state(), before)
  assert.deepEqual(f.s.playerWallet(f.player.id), wallet)
  assert.deepEqual(f.s.db.prepare('SELECT * FROM business_requests ORDER BY rowid').all(), requests)
  assert.equal(f.state().orders.find(row => row.id === record.id).submissions[0].screenshots[0].id, image.id)
  assert.equal((await f.archive()).archived, 0)
})

test('按较晚完成/验收时间计30天，最近完成、日期不明或未足额收款均保留', async t => {
  for (const mode of ['recent-completion', 'recent-review', 'missing-time', 'unpaid']) {
    const f = fixture(t), { image, record } = f.complete()
    f.setTime('2026-02-02T00:00:00Z')
    f.edit(state => {
      const order = state.orders.find(row => row.id === record.id)
      if (mode === 'recent-completion') order.completedAt = '2026-01-20T00:00:00Z'
      if (mode === 'recent-review') order.submissions.at(-1).reviewedAt = '2026-01-20T00:00:00Z'
      if (mode === 'missing-time') order.completedAt = null
      if (mode === 'unpaid') order.receivedAmount = 0
    })
    assert.equal((await f.archive()).archived, 0, mode)
    assert.ok(inlineSize(f, image) > 0, mode)
  }
})

test('同一批最多归档5张且游标继续推进，已归档图不被废弃上传回收删除', async t => {
  const f = fixture(t), images = []
  for (let i = 0; i < 7; i++) images.push(f.complete().image)
  f.setTime('2026-02-02T00:00:00Z')
  assert.equal((await f.archive()).archived, 5)
  assert.equal((await f.archive()).archived, 2)
  const result = f.s.collectAbandonedUploads({ before: '2026-01-03T00:00:00Z' })
  assert.equal(result.deleted, 0)
  for (const image of images) assert.deepEqual(f.s.download(f.player.id, image.id).data, Buffer.from(png, 'base64'))
})

test('进行中、退单、退款、人工差额、状态更正及共享到进行中订单均阻止归档', async t => {
  for (const mode of ['active', 'return', 'refund', 'reward-review', 'manual-adjustment', 'correction', 'shared']) {
    const f = fixture(t), { image, record } = f.complete()
    f.setTime('2026-02-02T00:00:00Z')
    f.edit(state => {
      const order = state.orders.find(row => row.id === record.id)
      if (mode === 'active') order.status = 'active'
      if (mode === 'return') order.returnRequests = [{ status: 'pending' }]
      if (mode === 'refund') state.refunds.push({ orderId: record.id, status: 'pending' })
      if (mode === 'reward-review') state.rewardReviews.push({ orderId: record.id })
      if (mode === 'manual-adjustment') state.playerAdjustments.push({ orderId: record.id, status: 'manual' })
      if (mode === 'correction') state.statusCorrectionReversals[record.id] = { active: true }
      if (mode === 'shared') state.orders.push({ ...order, id: randomUUID(), status: 'active' })
    })
    assert.equal((await f.archive()).archived, 0, mode)
    assert.ok(inlineSize(f, image) > 0, mode)
  }
})

test('当前收款凭证、私人收款码及历史财务/不明确引用优先保护', async t => {
  for (const mode of ['receipt', 'private-qr', 'historical-receipt', 'unknown-reference']) {
    const f = fixture(t), { image, record } = f.complete()
    f.setTime('2026-02-02T00:00:00Z')
    if (mode === 'receipt') f.edit(state => { state.orders.find(row => row.id === record.id).receipt = image })
    if (mode === 'private-qr') f.s.db.prepare('INSERT INTO player_private_uploads VALUES(?,?)').run(image.id, f.player.id)
    if (mode === 'historical-receipt' || mode === 'unknown-reference') {
      const row = f.s.db.prepare("SELECT id,payload FROM audit_logs WHERE entity='order' AND entity_id=? LIMIT 1").get(record.id)
      const value = JSON.parse(row.payload)
      value[mode === 'historical-receipt' ? 'receipt' : 'unknownField'] = image
      f.s.db.prepare('UPDATE audit_logs SET payload=? WHERE id=?').run(JSON.stringify(value), row.id)
    }
    assert.equal((await f.archive()).archived, 0, mode)
    assert.ok(inlineSize(f, image) > 0, mode)
  }
})

test('人工保留清单保护线下争议，畸形配置拒绝归档且不释放原图', async t => {
  const f = fixture(t), { image, record } = f.complete(), holds = join(f.root, 'image-retention-holds.json')
  f.setTime('2026-02-02T00:00:00Z')
  writeFileSync(holds, JSON.stringify({ format: 'studio-image-retention-holds-v1', orderIds: [record.id] }))
  assert.equal((await f.archive()).heldOrderCount, 1)
  assert.ok(inlineSize(f, image) > 0)
  writeFileSync(holds, '{invalid')
  await assert.rejects(f.archive(), error => error.code === 'IMAGE_ARCHIVE_HOLDS_INVALID')
  assert.ok(inlineSize(f, image) > 0)
})

test('写文件期间订单重新进行则二次核验拒绝归档，两个归档任务不重叠', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  const pending = f.archive()
  assert.deepEqual(await f.archive(), { skipped: true })
  f.edit(state => { state.orders.find(row => row.id === record.id).status = 'active' })
  assert.equal((await pending).archived, 0)
  assert.ok(inlineSize(f, image) > 0)
  assert.equal(f.s.db.prepare('SELECT count(*) AS count FROM image_archives').get().count, 0)
})

test('归档写入失败保留主库原图，目录链接不得将图片写到其他位置', async t => {
  const f = fixture(t)
  const { image } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  const blocked = join(f.root, 'blocked-root')
  writeFileSync(blocked, 'not a directory')
  const { createImageArchive } = await import('../server/image-archive.mjs')
  const store = createImageArchive({ db: f.s.db, dbPath: f.path, directory: blocked, clock: () => new Date('2026-02-02') })
  await assert.rejects(store.run())
  assert.ok(inlineSize(f, image) > 0)
  const outside = join(f.root, 'outside'), linked = join(f.root, 'linked-root')
  mkdirSync(outside)
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const linkedStore = createImageArchive({ db: f.s.db, dbPath: f.path, directory: linked, clock: () => new Date('2026-02-02') })
  await assert.rejects(linkedStore.run(), error => error.code === 'IMAGE_ARCHIVE_PATH_INVALID')
  assert.ok(inlineSize(f, image) > 0)
})

test('归档文件写入期间新增历史财务引用，使短事务引用证明失效并保留原图', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  const pending = f.archive()
  const row = f.s.db.prepare("SELECT id,payload FROM audit_logs WHERE entity='order' AND entity_id=? LIMIT 1").get(record.id)
  f.s.db.prepare('UPDATE audit_logs SET payload=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.payload), receipt: image }), row.id)
  assert.equal((await pending).archived, 0)
  assert.ok(inlineSize(f, image) > 0)
})

test('归档图片经两端原HTTP地址及权限读取，退出和无关打手不获权限', async t => {
  const f = fixture(t), { image } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  await f.archive()
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${f.server.address().port}/api/studio`
  const login = async (username, player) => {
    const response = await fetch(api + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(player ? { 'X-Studio-Client': 'player' } : {}) }, body: JSON.stringify({ username, password }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  for (const [name, player] of [['admin', false], ['archive-player', true]]) {
    const cookie = await login(name, player)
    const response = await fetch(api + '/uploads/' + image.id, { headers: { Cookie: cookie, ...(player ? { 'X-Studio-Client': 'player' } : {}) } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, 'base64'))
  }
  const other = await login('other-player', true)
  assert.equal((await fetch(api + '/uploads/' + image.id, { headers: { Cookie: other, 'X-Studio-Client': 'player' } })).status, 403)
  assert.equal((await fetch(api + '/uploads/' + image.id)).status, 401)
})

test('归档磁盘余量不足时不写原图副本，原BLOB继续可读', async t => {
  const f = fixture(t), { image } = f.complete()
  const { createImageArchive } = await import('../server/image-archive.mjs')
  const store = createImageArchive({ db: f.s.db, dbPath: f.path, clock: () => new Date('2026-02-02'),
    diskProbe: async () => ({ bavail: 0, bsize: 4096 }) })
  await assert.rejects(store.run(), error => error.code === 'IMAGE_ARCHIVE_DISK_LOW')
  assert.ok(inlineSize(f, image) > 0)
  assert.deepEqual(f.s.download(f.player.id, image.id).data, Buffer.from(png, 'base64'))
})

test('完整备份恢复不依赖归档目录，缺图/损坏不产生成功备份或覆盖旧副本', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  await f.archive()
  const archive = f.s.db.prepare('SELECT * FROM image_archives WHERE upload_id=?').get(image.id)
  const backup = join(f.root, 'complete-backup.sqlite'), restored = join(f.root, 'offline.sqlite')
  const result = await backupStudioDatabase(f.path, backup)
  assert.equal(result.metadata.archivedImagesMaterialized, 1)
  assert.equal((await verifyStudioBackup(backup)).hashVerification, 'verified')
  writeFileSync(join(archive.archive_root, archive.file_name), Buffer.alloc(archive.size))
  assert.throws(() => f.s.download('admin', image.id), error => error.status === 503)
  const failed = join(f.root, 'failed.sqlite')
  await assert.rejects(backupStudioDatabase(f.path, failed))
  assert.equal(existsSync(failed), false)
  assert.equal(existsSync(failed + '.json'), false)
  assert.equal((await verifyStudioBackup(backup)).integrity, 'ok')
  renameSync(archive.archive_root, archive.archive_root + '-unavailable')
  f.edit(state => { state.orders.find(row => row.id === record.id).remark = 'source-only-later-change' })
  await restoreStudioDatabase(backup, restored)
  const recovered = createStudioServer({ dbPath: restored, seed: false, maintenanceFromEnv: false })
  try {
    assert.deepEqual(recovered.service.download(f.player.id, image.id).data, Buffer.from(png, 'base64'))
    assert.equal(recovered.service.db.prepare('SELECT count(*) AS count FROM image_archives').get().count, 0)
    assert.equal(f.state().orders.find(row => row.id === record.id).remark, 'source-only-later-change')
    assert.equal(recovered.service.playerWallet(f.player.id).earned, 7000)
  } finally { recovered.service.close() }
})

test('复用同一调度器：归档有独立结果、有限批量、失败不伪装成废图回收失败', async () => {
  let release
  const cleanup = createUploadCleanup({ enabled: true, intervalMinutes: 60, retentionDays: 30,
    collect: () => ({ scanned: 1, deleted: 0, bytes: 0, protected: 1 }),
    archive: input => { assert.deepEqual(input, { retentionDays: 30, limit: 5 }); return new Promise(resolve => { release = resolve }) } })
  const pending = cleanup.run()
  await Promise.resolve()
  assert.deepEqual(cleanup.run(), { skipped: true })
  release({ scanned: 2, archived: 1, bytes: 68, protected: 1, heldOrderCount: 0 })
  assert.equal((await pending).archive.archived, 1)
  assert.equal(cleanup.metrics().archivingEnabled, true)
  assert.equal(cleanup.metrics().archiveRunning, false)
  cleanup.close()
  const failed = createUploadCleanup({ enabled: true, collect: () => ({ deleted: 0 }), archive: async () => { throw new Error('PRIVATE-PATH') } })
  assert.equal((await failed.run()).code, 'IMAGE_ARCHIVE_FAILED')
  assert.equal(failed.metrics().failed, 0)
  assert.equal(failed.metrics().archiveFailed, 1)
  assert.ok(!JSON.stringify(failed.metrics()).includes('PRIVATE-PATH'))
  failed.close()
})
