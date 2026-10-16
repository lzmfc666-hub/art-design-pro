import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStudioServer } from '../server/index.mjs'
import { backupStudioDatabase, restoreStudioDatabase, verifyStudioBackup } from '../scripts/studio-backup.mjs'
import { testMutate } from './helpers/current-intent.mjs'
import { createUploadCleanup } from '../server/upload-cleanup.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const password = 'isolated-image-deletion-123'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-image-deletion-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  let time = new Date('2026-01-01T00:00:00Z')
  const path = join(root, 'source.sqlite')
  const server = createStudioServer({ dbPath: path, seed: false, password, clock: () => time,
    maintenanceFromEnv: false, uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
    notifications: { publicKey: '', privateKey: '', subject: '' } })
  const s = server.service
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    else if (s.db.isOpen) s.close()
    rmSync(root, { recursive: true, force: true })
  })
  const mutate = (route, body, actor = 'admin') => testMutate(s, actor, route, body)
  const level = mutate('/levels', { name: '隔离等级', delaySeconds: 0 })
  const player = mutate('/users', { username: 'delete-player', name: '图片测试打手', role: 'player',
    status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
  const outsider = mutate('/users', { username: 'other-player', name: '其他打手', role: 'player',
    status: 'active', levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
  const customer = mutate('/customers', { name: '图片测试客户', contact: '', gameId: '', remark: '' })
  const template = mutate('/templates', { name: '图片测试订单', game: '隔离', amount: 10000, reward: 7000, active: true })
  const upload = (actor = player.id) => s.upload(actor, { name: 'material.png', mime: 'image/png', data: png })
  const order = () => mutate('/orders', { customerId: customer.id, templateId: template.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'private-room',
    receivedAmount: 10000, paidAt: time.toISOString(), dispatchMode: 'pool' })
  const complete = (image = upload()) => {
    const record = order()
    mutate(`/player/orders/${record.id}/claim`, {}, player.id)
    mutate(`/player/orders/${record.id}/submit`, { screenshots: [image] }, player.id)
    mutate(`/orders/${record.id}/action`, { action: 'review-pass' })
    return { image, record }
  }
  const state = () => JSON.parse(s.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const edit = change => { const value = state(); change(value); s.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(value)) }
  return { root, path, server, s, player, outsider, mutate, upload, order, complete, state, edit,
    setTime: value => { time = new Date(value) }, remove: () => s.deleteCompletedOrderImages({ retentionDays: 30, limit: 50 }) }
}
const inlineSize = (f, image) => f.s.db.prepare('SELECT length(data) AS size FROM uploads WHERE id=?').get(image.id).size
const expectGone = (f, image, actor = f.player.id) => assert.throws(() => f.s.download(actor, image.id), error => error.status === 410)

test('打手材料按订单完成时间满30天永久删除，29天及差1毫秒均保留，后续复核不延后保留期', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.edit(state => { state.orders.find(row => row.id === record.id).submissions.at(-1).reviewedAt = '2026-01-20T00:00:00Z' })
  for (const when of ['2026-01-30T00:00:00Z', '2026-01-30T23:59:59.999Z']) {
    f.setTime(when)
    assert.equal((await f.remove()).deleted, 0)
    assert.ok(inlineSize(f, image) > 0)
  }
  f.setTime('2026-01-31T00:00:00Z')
  assert.equal((await f.remove()).deleted, 1)
  assert.equal(inlineSize(f, image), 0)
  expectGone(f, image)
})

test('删除只清原图BLOB并保留墓碑、元数据及订单/账号/钱包/审计/幂等原记录', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  const state = f.state(), wallet = f.s.playerWallet(f.player.id)
  const tables = ['business_requests', 'financial_requests', 'fund_transactions', 'audit_logs']
  const rows = new Map(tables.map(table => [table, f.s.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  const metadata = f.s.db.prepare('SELECT id,owner_id,name,mime,size,created_at FROM uploads WHERE id=?').get(image.id)
  const result = await f.remove()
  assert.equal(result.deleted, 1)
  assert.equal(result.bytes, Buffer.from(png, 'base64').length)
  assert.equal(inlineSize(f, image), 0)
  assert.deepEqual(f.s.db.prepare('SELECT id,owner_id,name,mime,size,created_at FROM uploads WHERE id=?').get(image.id), metadata)
  assert.equal(f.s.db.prepare('SELECT count(*) AS count FROM image_deletions WHERE upload_id=?').get(image.id).count, 1)
  assert.deepEqual(f.state(), state)
  assert.deepEqual(f.s.playerWallet(f.player.id), wallet)
  for (const table of tables) assert.deepEqual(f.s.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows.get(table), table)
  assert.equal(f.state().orders.find(row => row.id === record.id).submissions[0].screenshots[0].id, image.id)
  assert.equal((await f.remove()).deleted, 0)
  assert.equal(f.s.collectAbandonedUploads({ before: '2026-01-03T00:00:00Z' }).deleted, 0)
})

test('删除范围仅限打手上传且用于订单上报的图片，管理员上传材料和未引用图片均不混入', async t => {
  const f = fixture(t), administrative = f.upload('admin'), unused = f.upload()
  // The backend may accept administrator-owned material only through an administrator edit.
  const { record, image } = f.complete()
  f.edit(state => { state.orders.find(row => row.id === record.id).submissions[0].screenshots.push(administrative) })
  f.setTime('2026-02-02T00:00:00Z')
  assert.equal((await f.remove()).deleted, 1)
  expectGone(f, image)
  assert.ok(inlineSize(f, administrative) > 0)
  assert.ok(inlineSize(f, unused) > 0)
})

test('进行中、未足额收款、资金核对、未知引用和共享进行中图片继续保护', async t => {
  for (const mode of ['active', 'unpaid', 'pending-refund', 'reward-review', 'receipt', 'unknown', 'shared']) {
    const f = fixture(t), { image, record } = f.complete()
    f.setTime('2026-02-02T00:00:00Z')
    f.edit(state => {
      const order = state.orders.find(row => row.id === record.id)
      if (mode === 'active') order.status = 'active'
      if (mode === 'unpaid') order.receivedAmount = 0
      if (mode === 'pending-refund') state.refunds.push({ orderId: record.id, status: 'pending' })
      if (mode === 'reward-review') state.rewardReviews.push({ orderId: record.id })
      if (mode === 'receipt') order.receipt = image
      if (mode === 'unknown') order.otherAttachment = image
      if (mode === 'shared') state.orders.push({ ...order, id: randomUUID(), status: 'active' })
    })
    assert.equal((await f.remove()).deleted, 0, mode)
    assert.ok(inlineSize(f, image) > 0, mode)
  }
})

test('线下争议保留清单及历史收付款引用阻止永久删除', async t => {
  for (const mode of ['hold', 'financial-history', 'private-qr']) {
    const f = fixture(t), { image, record } = f.complete()
    f.setTime('2026-02-02T00:00:00Z')
    if (mode === 'hold') writeFileSync(join(f.root, 'image-retention-holds.json'), JSON.stringify({ format: 'studio-image-retention-holds-v1', orderIds: [record.id] }))
    if (mode === 'private-qr') f.s.db.prepare('INSERT INTO player_private_uploads VALUES(?,?)').run(image.id, f.player.id)
    if (mode === 'financial-history') {
      const row = f.s.db.prepare("SELECT id,payload FROM audit_logs WHERE entity='order' AND entity_id=? LIMIT 1").get(record.id)
      f.s.db.prepare('UPDATE audit_logs SET payload=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.payload), receipt: image }), row.id)
    }
    assert.equal((await f.remove()).deleted, 0, mode)
    assert.ok(inlineSize(f, image) > 0, mode)
  }
})

test('删除图片先核对权限：后台和本人410、他人403、匿名401，详情仍有订单及删除标识', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  await f.remove()
  assert.equal(f.s.playerOrderDetail(f.player.id, record.id).submissions[0].screenshots[0].retentionStatus, 'deleted')
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${f.server.address().port}/api/studio`
  for (const [name, player, expected] of [['admin', false, 410], ['delete-player', true, 410], ['other-player', true, 403]]) {
    const client = player ? { 'X-Studio-Client': 'player' } : {}
    const login = await fetch(api + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...client }, body: JSON.stringify({ username: name, password }) })
    assert.equal(login.status, 200)
    const response = await fetch(api + '/uploads/' + image.id, { headers: { Cookie: login.headers.get('set-cookie').split(';')[0], ...client } })
    assert.equal(response.status, expected, name)
    const text = await response.text()
    assert.ok(!text.includes(f.root))
    assert.ok(!text.includes(png))
  }
  assert.equal((await fetch(api + '/uploads/' + image.id)).status, 401)
})

test('已过期图片编号不能作为新订单上报材料重新使用', async t => {
  const f = fixture(t), { image } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  await f.remove()
  const record = f.order()
  f.mutate(`/player/orders/${record.id}/claim`, {}, f.player.id)
  assert.throws(() => f.mutate(`/player/orders/${record.id}/submit`, { screenshots: [image] }, f.player.id), error => error.status === 410)
  assert.equal(f.state().orders.find(row => row.id === record.id).submissions.length, 0)
})

test('图片删除进入双端轻量变更摘要，后台复核不会复用已删除旧截图', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  const staffBefore = f.s.staffChanges('admin'), playerBefore = f.s.playerChanges(f.player.id)
  assert.equal(f.s.staffChanges('admin', staffBefore.version).changed, false)
  assert.equal(f.s.playerChanges(f.player.id, playerBefore.version).changed, false)
  await f.remove()
  const staffAfter = f.s.staffChanges('admin', staffBefore.version), playerAfter = f.s.playerChanges(f.player.id, playerBefore.version)
  assert.equal(staffAfter.changed, true)
  assert.equal(playerAfter.changed, true)
  assert.notEqual(staffAfter.version, staffBefore.version)
  assert.notEqual(playerAfter.version, playerBefore.version)
  assert.equal(f.s.staffChanges('admin', staffAfter.version).changed, false)
  assert.equal(f.s.playerChanges(f.player.id, playerAfter.version).changed, false)
  const review = f.mutate(`/orders/${record.id}/action`, { action: 'correct-status', status: 'review', reason: '到期材料删除后的后台复核' })
  assert.equal(review.status, 'review')
  assert.equal(review.submissions.at(-1).source, 'status-correction')
  assert.deepEqual(review.submissions.at(-1).screenshots, [])
  expectGone(f, image)
})

test('旧归档图片到期删除同盘文件；文件损坏保留待重试但不可再下载或备份复活', async t => {
  const f = fixture(t), { image } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  assert.equal((await f.s.archiveCompletedOrderImages({ retentionDays: 30, limit: 5 })).archived, 1)
  const archive = f.s.db.prepare('SELECT * FROM image_archives WHERE upload_id=?').get(image.id)
  const file = join(archive.archive_root, archive.file_name)
  writeFileSync(file, Buffer.alloc(archive.size))
  const result = await f.remove()
  assert.equal(f.s.db.prepare('SELECT count(*) AS count FROM image_archives WHERE upload_id=?').get(image.id).count, 1, JSON.stringify(result))
  assert.equal(result.deleted, 1)
  assert.ok(result.pendingFiles > 0)
  assert.equal(existsSync(file), true)
  expectGone(f, image, 'admin')
  const backup = await backupStudioDatabase(f.path, join(f.root, 'pending-file-backup.sqlite'))
  assert.equal(backup.metadata.archivedImagesMaterialized, 0)
  assert.equal(backup.metadata.expiredImages, 1)
  writeFileSync(file, Buffer.from(png, 'base64'))
  assert.equal((await f.remove()).deleted, 0)
  assert.equal(existsSync(file), false)
  assert.equal(f.s.db.prepare('SELECT count(*) AS count FROM image_archives WHERE upload_id=?').get(image.id).count, 0)
  expectGone(f, image)
})

test('到期删除后完整备份/离线恢复仍返回410、保留资金与幂等保护，原库后续交易不变', async t => {
  const f = fixture(t), { image, record } = f.complete()
  f.setTime('2026-02-02T00:00:00Z')
  await f.remove()
  const backup = join(f.root, 'expired-backup.sqlite'), restored = join(f.root, 'offline.sqlite')
  const snapshotWallet = f.s.playerWallet(f.player.id)
  const requestRows = f.s.db.prepare('SELECT * FROM business_requests ORDER BY rowid').all()
  const result = await backupStudioDatabase(f.path, backup)
  assert.equal(result.metadata.expiredImages, 1)
  assert.equal(typeof result.metadata.compactedExpiredImagePages, 'boolean')
  assert.equal((await verifyStudioBackup(backup)).hashVerification, 'verified')
  const later = f.order(), currentState = f.state()
  await restoreStudioDatabase(backup, restored)
  const recovered = createStudioServer({ dbPath: restored, seed: false, maintenanceFromEnv: false,
    clock: () => new Date('2026-02-02T00:00:00Z'),
    uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 }, notifications: { publicKey: '', privateKey: '', subject: '' } })
  try {
    assert.equal(recovered.service.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.throws(() => recovered.service.download(f.player.id, image.id), error => error.status === 410)
    assert.equal(recovered.service.db.prepare('SELECT length(data) AS size FROM uploads WHERE id=?').get(image.id).size, 0)
    assert.deepEqual(recovered.service.playerWallet(f.player.id), snapshotWallet)
    assert.deepEqual(recovered.service.db.prepare('SELECT * FROM business_requests ORDER BY rowid').all(), requestRows)
    assert.equal(recovered.service.playerOrderDetail(f.player.id, record.id).submissions[0].screenshots[0].retentionStatus, 'deleted')
    assert.deepEqual(f.state(), currentState)
    assert.ok(f.state().orders.some(order => order.id === later.id))
  } finally { recovered.service.close() }
})

test('原定时器启用删除且归档关闭，忙时不重叠、失败独立计数且不泄露路径', async () => {
  let release
  const cleanup = createUploadCleanup({ enabled: true, retentionDays: 30,
    collect: () => ({ scanned: 0, deleted: 0 }),
    removeCompleted: input => {
      assert.deepEqual(input, { retentionDays: 30, limit: 50 })
      return new Promise(resolve => { release = resolve })
    } })
  const pending = cleanup.run()
  await Promise.resolve()
  assert.equal(cleanup.metrics().completedDeletionEnabled, true)
  assert.equal(cleanup.metrics().archivingEnabled, false)
  assert.deepEqual(cleanup.run(), { skipped: true })
  release({ scanned: 2, deleted: 1, bytes: 68, protected: 1, pendingFiles: 0 })
  assert.equal((await pending).deletion.deleted, 1)
  assert.equal(cleanup.metrics().deletionRunning, false)
  cleanup.close()
  const failed = createUploadCleanup({ enabled: true, collect: () => ({}), removeCompleted: () => { throw new Error('PRIVATE-PATH') } })
  assert.equal((await failed.run()).code, 'IMAGE_DELETE_FAILED')
  assert.equal(failed.metrics().deletionFailed, 1)
  assert.equal(failed.metrics().failed, 0)
  assert.ok(!JSON.stringify(failed.metrics()).includes('PRIVATE-PATH'))
  failed.close()
  assert.throws(() => createUploadCleanup({ archive() {}, removeCompleted() {} }))
  assert.throws(() => createStudioServer({ dbPath: ':memory:', maintenanceFromEnv: false,
    imageArchive: { enabled: true, deletionEnabled: true } }), /不能同时开启/)
})
