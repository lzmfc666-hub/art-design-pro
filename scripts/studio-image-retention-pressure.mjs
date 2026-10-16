import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { createStudioServer } from '../server/index.mjs'
import { backupStudioDatabase, restoreStudioDatabase } from './studio-backup.mjs'
import { largePng } from './studio-stability-pressure.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'
import { testMutate } from '../tests/helpers/current-intent.mjs'

const root = resolve('.qa/image-retention', 'pressure-' + randomUUID())
const deleting = process.argv.includes('--delete')
mkdirSync(root, { recursive: true })
const sourceBefore = sourceFingerprint(), startedAt = new Date().toISOString()
const password = 'isolated-' + randomUUID(), database = join(root, 'source.sqlite')
let time = new Date('2026-01-01T00:00:00Z'), peakRss = process.memoryUsage().rss
const server = createStudioServer({ dbPath: database, password, seed: false, maintenanceFromEnv: false,
  clock: () => time, uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
  notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] } })
const s = server.service, mutate = (path, body, actor = 'admin') => testMutate(s, actor, path, body)
const report = { kind: 'isolated-image-retention-disk-load', startedAt, root, success: false,
  mode: deleting ? 'permanent-expiry-deletion' : 'readable-archive',
  sourceBefore: sourceBefore.digest, requests: [], concurrency: 8,
  isolation: { newDiskSQLite: true, randomLoopbackPort: true, realPush: false, realAlerts: false,
    scheduledMaintenance: false, actualImageArchiveCalledOnlyOnFixture: true } }
const pendingBackground = []
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 25)
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] || 0
const stats = rows => { const values = rows.map(row => row.ms); return { requests: rows.length,
  p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maximumMs: Math.max(0, ...values) } }
try {
  const level = mutate('/levels', { name: '归档压力等级', delaySeconds: 0 })
  const player = mutate('/users', { username: 'pressure-player', name: '隔离压力打手', role: 'player', status: 'active',
    levelId: level.id, maxActiveOrders: 5, permissionOverrides: {}, password })
  const customer = mutate('/customers', { name: '隔离压力客户', contact: '', gameId: '', remark: '' })
  const template = mutate('/templates', { name: '归档压力订单', game: 'QA', amount: 10000, reward: 7000, active: true })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const api = `http://127.0.0.1:${server.address().port}/api/studio`
  const login = async (username, playerClient) => {
    const response = await fetch(api + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(playerClient ? { 'X-Studio-Client': 'player' } : {}) }, body: JSON.stringify({ username, password }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  let adminCookie = await login('admin', false), playerCookie = await login('pressure-player', true)
  const png = largePng(), digest = createHash('sha256').update(png).digest('hex'), images = []
  assert.ok(png.length > 7.5 * 1024 ** 2 && png.length < 8 * 1024 ** 2)
  for (let i = 0; i < 5; i++) {
    const upload = await fetch(api + '/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Cookie: playerCookie, 'X-Studio-Client': 'player' }, body: JSON.stringify({ name: 'actual-large.png', mime: 'image/png', data: png.toString('base64') }) })
    assert.equal(upload.status, 200)
    const image = await upload.json(); images.push(image)
    const order = mutate('/orders', { templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun',
      externalOrderNo: randomUUID(), roomCode: 'isolated', dispatchMode: 'pool', receivedAmount: 10000, paidAt: time.toISOString() })
    mutate(`/player/orders/${order.id}/claim`, {}, player.id)
    mutate(`/player/orders/${order.id}/submit`, { screenshots: [image] }, player.id)
    mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  }
  time = new Date('2026-02-02T00:00:00Z')
  adminCookie = await login('admin', false)
  playerCookie = await login('pressure-player', true)
  const snapshot = () => JSON.parse(s.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const before = snapshot(), walletBefore = s.playerWallet(player.id)
  const reads = ['/orders?current=1&size=20', '/player/orders?scope=mine&current=1&size=20',
    '/player/wallet', '/player/wallet/ledger?current=1&size=20']
  const phaseStart = performance.now()
  const pages = () => ({ pages: s.db.prepare('PRAGMA page_count').get().page_count,
    freePages: s.db.prepare('PRAGMA freelist_count').get().freelist_count,
    pageSize: s.db.prepare('PRAGMA page_size').get().page_size })
  report.pagesBefore = pages()
  const archival = deleting ? s.deleteCompletedOrderImages({ retentionDays: 30, limit: 50 }) :
    s.archiveCompletedOrderImages({ retentionDays: 30, limit: 5 })
  const concurrentBackup = backupStudioDatabase(database, join(root, 'concurrent-backup.sqlite'))
  pendingBackground.push(archival, concurrentBackup)
  for (const pending of pendingBackground) void pending.catch(() => {})
  await Promise.all(Array.from({ length: 8 }, async (_, worker) => {
    for (let i = 0; i < 50; i++) {
      const path = reads[(i + worker) % reads.length], playerClient = path.startsWith('/player/')
      const start = performance.now()
      const response = await fetch(api + path, { headers: { Cookie: playerClient ? playerCookie : adminCookie,
        ...(playerClient ? { 'X-Studio-Client': 'player' } : {}) } })
      await response.arrayBuffer()
      report.requests.push({ path, status: response.status, ms: performance.now() - start })
      assert.equal(response.status, 200)
    }
  }))
  report.archive = await archival
  report.pagesAfter = pages()
  await concurrentBackup
  report.readPhaseDurationMs = performance.now() - phaseStart
  report.reads = stats(report.requests)
  report.reads.throughputPerSecond = report.reads.requests / (report.readPhaseDurationMs / 1000)
  report.imageReads = []
  for (const image of images) for (const playerClient of [false, true]) {
    const start = performance.now()
    const response = await fetch(api + '/uploads/' + image.id, { headers: { Cookie: playerClient ? playerCookie : adminCookie,
      ...(playerClient ? { 'X-Studio-Client': 'player' } : {}) } })
    assert.equal(response.status, deleting ? 410 : 200)
    const data = Buffer.from(await response.arrayBuffer())
    if (!deleting) assert.equal(createHash('sha256').update(data).digest('hex'), digest)
    report.imageReads.push({ ms: performance.now() - start, status: response.status })
  }
  report.images = { count: images.length, bytesEach: png.length, totalBytes: images.length * png.length,
    sha256: digest, dimensions: [1440, 1440], downloads: stats(report.imageReads) }
  assert.equal(deleting ? report.archive.deleted : report.archive.archived, 5)
  assert.deepEqual(snapshot().orders, before.orders)
  assert.deepEqual(snapshot().users, before.users)
  assert.deepEqual(s.playerWallet(player.id), walletBefore)
  const backupStart = performance.now()
  const copied = await backupStudioDatabase(database, join(root, 'full-backup.sqlite'))
  report.backupMs = performance.now() - backupStart
  const restoreStart = performance.now(), restored = join(root, 'offline-restored.sqlite')
  await restoreStudioDatabase(copied.path, restored)
  report.restoreMs = performance.now() - restoreStart
  const offline = new DatabaseSync(restored, { readOnly: true })
  try {
    assert.equal(offline.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(offline.prepare('SELECT count(*) AS count FROM uploads WHERE length(data)=size').get().count, deleting ? 0 : 5)
    if (deleting) assert.equal(offline.prepare('SELECT count(*) AS count FROM image_deletions').get().count, 5)
    else assert.equal(offline.prepare('SELECT count(*) AS count FROM image_archives').get().count, 0)
  } finally { offline.close() }
  report.backupBytes = copied.metadata.bytes
  report.backupArchivedImagesMaterialized = copied.metadata.archivedImagesMaterialized
  if (deleting) {
    assert.ok(report.pagesAfter.freePages > report.pagesBefore.freePages)
    assert.ok(copied.metadata.bytes < report.pagesBefore.pages * report.pagesBefore.pageSize / 2)
    for (let i = 0; i < 5; i++) s.upload(player.id, { name: 'reuse.png', mime: 'image/png', data: png.toString('base64') })
    report.pagesAfterReuse = pages()
    assert.ok(report.pagesAfterReuse.freePages < report.pagesAfter.freePages)
    assert.ok(report.pagesAfterReuse.pages <= report.pagesBefore.pages + 64)
    report.storageReused = true
  }
  report.unexpectedErrors = report.requests.filter(row => row.status !== 200).length
  report.expectedBusinessConflicts = 0
  report.sampledPeakRssBytes = peakRss
  report.endRssBytes = process.memoryUsage().rss
  report.notes = ['400 mixed real HTTP reads overlap real-disk retention work and a consistent backup.',
    'Near-8MiB genuine PNGs uploaded over HTTP; backend/player authenticated downloads verify original SHA.',
    'The isolated clock advances 32 days to test retention; those 32 days are not measured task latency.',
    'Concurrency is request concurrency, not online users.',
    deleting ? 'Expired image BLOBs are removed, old IDs return 410; freed SQLite pages are reused by five new images and new backup copies are compacted.' :
      'Same-volume archival does not reduce total disk usage.']
  report.success = true
} catch (cause) { report.error = cause.message; process.exitCode = 1 }
finally {
  clearInterval(sample)
  await Promise.allSettled(pendingBackground)
  report.sourceAfter = sourceFingerprint().digest
  report.sourceUnchanged = report.sourceAfter === sourceBefore.digest
  if (!report.sourceUnchanged) { report.success = false; process.exitCode = 1 }
  if (server.listening) await new Promise(done => server.close(done)); else if (s.db.isOpen) s.close()
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ success: report.success, output: join(root, 'report.json'), reads: report.reads,
    images: report.images, archive: report.archive, backupMs: report.backupMs, restoreMs: report.restoreMs,
    sampledPeakRssBytes: report.sampledPeakRssBytes, error: report.error }))
}
