import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync,
  existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { backupStudioDatabase, verifyStudioBackup } from '../scripts/studio-backup.mjs'
import { createBackupScheduler } from '../server/backup-scheduler.mjs'

const MiB = 1024 * 1024
const ampleDisk = () => ({ bavail: 20 * 1024 * MiB, bsize: 1 })
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const metadata = path => JSON.parse(readFileSync(path + '.json', 'utf8'))
const snapshots = directory => existsSync(directory)
  ? readdirSync(directory).filter(name => name.endsWith('.sqlite')).map(name => join(directory, name)) : []
const bytes = path => lstatSync(path).size + lstatSync(path + '.json').size

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-backup-capacity-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'studio-backup-capacity-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const source = join(root, 'business.sqlite'), directory = join(root, 'backups')
  const db = new DatabaseSync(source)
  db.exec('CREATE TABLE studio_state(id INTEGER PRIMARY KEY,json TEXT);CREATE TABLE test_funds(id INTEGER PRIMARY KEY,amount INTEGER);CREATE TABLE test_images(id INTEGER PRIMARY KEY,data BLOB)')
  db.prepare('INSERT INTO studio_state VALUES(1,?)').run(JSON.stringify({ schemaVersion: 2,
    orders: [{ id: 'retained-order' }], users: [{ id: 'retained-account' }] }))
  db.prepare('INSERT INTO test_funds VALUES(1,?)').run(12345)
  db.prepare('INSERT INTO test_images VALUES(1,?)').run(Buffer.alloc(1000, 7))
  db.close()
  let now = Date.parse('2026-10-17T00:00:00Z')
  const scheduler = options => {
    const result = createBackupScheduler({ dbPath: source, directory, intervalMinutes: 0,
      retentionCount: 3, maxTotalBytes: 0, minFreeBytes: 0, failureWebhook: '',
      clock: () => now++, diskProbe: ampleDisk, ...options })
    t.after(() => result.close())
    return result
  }
  return { root, source, directory, scheduler }
}

async function seed(f, count) {
  const scheduler = f.scheduler({ retentionCount: 90 })
  for (let index = 0; index < count; index++) assert.deepEqual(await scheduler.run(), { ok: true })
  return snapshots(f.directory).sort((a, b) => Date.parse(metadata(a).completedAt) - Date.parse(metadata(b).completedAt))
}

test('三份数量和总容量同时生效，统计包括完成清单，保留后源订单/资金/账号/图片字节不变', async t => {
  const f = fixture(t), original = digest(f.source)
  const scheduler = f.scheduler({ maxTotalBytes: 4 * MiB, minFreeBytes: MiB })
  for (let index = 0; index < 6; index++) assert.deepEqual(await scheduler.run(), { ok: true })
  const retained = snapshots(f.directory)
  assert.equal(retained.length, 3)
  assert.equal(scheduler.metrics().removedBackups, 3)
  assert.equal(scheduler.metrics().retainedCount, 3)
  assert.equal(scheduler.metrics().retainedBytes, retained.reduce((sum, path) => sum + bytes(path), 0))
  for (const path of retained) assert.equal((await verifyStudioBackup(path)).hashVerification, 'verified')
  assert.equal(digest(f.source), original)
})

test('容量不足三份时按完成时间删更旧同源副本，实际保留数可少于三份', async t => {
  const f = fixture(t), old = await seed(f, 5), original = digest(f.source)
  const cap = Math.floor(bytes(old.at(-1)) * 2.5)
  const scheduler = f.scheduler({ maxTotalBytes: cap, minFreeBytes: MiB })
  assert.deepEqual(await scheduler.run(), { ok: true })
  assert.equal(snapshots(f.directory).length, 2)
  assert.ok(scheduler.metrics().retainedBytes <= cap)
  assert.equal(scheduler.metrics().removedBackups, 4)
  assert.ok(old.slice(0, 4).every(path => !existsSync(path)))
  assert.equal(existsSync(old.at(-1)), true)
  assert.equal(digest(f.source), original)
})

test('最后一份校验通过备份本身超额时保留且报错，不删到零份或误发恢复通知', async t => {
  const f = fixture(t), [good] = await seed(f, 1), original = digest(good), events = []
  const scheduler = f.scheduler({ maxTotalBytes: bytes(good) - 1, onEvent: event => events.push(event) })
  assert.deepEqual(await scheduler.run(), { ok: false, code: 'BACKUP_CAPACITY_EXCEEDED' })
  assert.deepEqual(snapshots(f.directory), [good])
  assert.equal(digest(good), original)
  assert.equal(scheduler.metrics().retentionFailed, 1)
  assert.equal(scheduler.metrics().completed, 0)
  assert.deepEqual(events.map(event => [event.healthy, event.code]), [[false, 'BACKUP_CAPACITY_EXCEEDED']])
})

test('源盘和目标盘分别探测，低盘或无法采样在生成副本前拒绝且保留recent good', async t => {
  const f = fixture(t), [good] = await seed(f, 1), original = digest(f.source)
  const reserve = 64 * MiB, working = lstatSync(f.source).size * 3 + 64 * MiB
  for (const failure of ['source', 'target', 'probe', 'invalid']) {
    const seen = [], scheduler = f.scheduler({ minFreeBytes: reserve,
      diskProbe(path) {
        seen.push(resolve(path))
        const isSource = resolve(path) === resolve(dirname(f.source))
        if (failure === 'probe' && !isSource) throw new Error('PRIVATE-DISK-ERROR')
        if (failure === 'invalid' && !isSource) return { bavail: NaN, bsize: 4096 }
        return { bavail: failure === 'source' && isSource ? reserve - 1 :
          failure === 'target' && !isSource ? reserve + working - 1 : 20 * 1024 * MiB, bsize: 1 }
      } })
    assert.deepEqual(await scheduler.run(), { ok: false,
      code: ['probe', 'invalid'].includes(failure) ? 'BACKUP_DISK_PROBE_FAILED' : 'BACKUP_DISK_LOW' })
    assert.deepEqual(seen, [resolve(dirname(f.source)), resolve(f.directory)])
    assert.deepEqual(snapshots(f.directory), [good])
    assert.equal(digest(f.source), original)
    assert.equal(existsSync(join(f.directory, '.studio-backup-running.json')), false)
  }
})

test('首次空间预算包含活动WAL与旧图片归档回填，并为复制/整理预留三倍估算和64MiB', async t => {
  const f = fixture(t), db = new DatabaseSync(f.source)
  try {
    db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE image_archives(size INTEGER);INSERT INTO image_archives VALUES(3145728)')
    assert.ok(lstatSync(f.source + '-wal').size > 0)
    const estimated = lstatSync(f.source).size + lstatSync(f.source + '-wal').size + 3 * MiB
    const original = digest(f.source), wal = digest(f.source + '-wal'), reserve = 8 * MiB
    let called = false
    const scheduler = f.scheduler({ minFreeBytes: reserve,
      backup() { called = true; throw new Error('must reject before invoking backup') },
      diskProbe(path) { return { bavail: resolve(path) === resolve(dirname(f.source))
        ? 20 * 1024 * MiB : reserve + estimated * 3 + 64 * MiB - 1, bsize: 1 } } })
    assert.deepEqual(await scheduler.run(), { ok: false, code: 'BACKUP_DISK_LOW' })
    assert.equal(called, false)
    assert.equal(scheduler.metrics().lastCapacityCheck.estimatedBytes, estimated)
    assert.equal(scheduler.metrics().lastCapacityCheck.workingBytes, estimated * 3 + 64 * MiB)
    assert.equal(digest(f.source), original)
    assert.equal(digest(f.source + '-wal'), wal)
  } finally { db.close() }
})

test('真实备份中途磁盘降到预留值以下时回收本次副本和清单，原副本与业务库不变', async t => {
  const f = fixture(t), [good] = await seed(f, 1), original = digest(f.source)
  let targetSamples = 0
  const scheduler = f.scheduler({ minFreeBytes: MiB,
    backup: (...args) => backupStudioDatabase(...args),
    diskProbe(path) {
      if (resolve(path) === resolve(f.directory) && ++targetSamples >= 3)
        return { bavail: MiB - 1, bsize: 1 }
      return ampleDisk()
    } })
  assert.deepEqual(await scheduler.run(), { ok: false, code: 'BACKUP_DISK_LOW' })
  assert.equal(targetSamples, 3)
  assert.deepEqual(readdirSync(f.directory).sort(), [basename(good), basename(good) + '.json'].sort())
  assert.equal(digest(f.source), original)
})

test('完成清单写入后再次容量检查失败也回收本次副本，最后成功状态与恢复事件不冒报', async t => {
  const f = fixture(t), [good] = await seed(f, 1), events = []
  let finished = false
  const scheduler = f.scheduler({ minFreeBytes: MiB,
    backup: async (...args) => { const result = await backupStudioDatabase(...args); finished = true; return result },
    diskProbe: () => finished ? { bavail: 0, bsize: 1 } : ampleDisk(),
    onEvent: event => events.push(event) })
  assert.deepEqual(await scheduler.run(), { ok: false, code: 'BACKUP_DISK_LOW' })
  assert.deepEqual(readdirSync(f.directory).sort(), [basename(good), basename(good) + '.json'].sort())
  assert.equal(scheduler.metrics().lastSuccess, null)
  assert.deepEqual(events.map(event => event.healthy), [false])
})

test('容量不足时未知/手工/他源/损坏/未完成及链接文件均不成为清理对象', async t => {
  const f = fixture(t), old = await seed(f, 4), cap = Math.floor(bytes(old[0]) * 1.5)
  const unknown = join(f.directory, 'unrelated.sqlite'), manual = join(f.directory, 'manual-backup.sqlite')
  writeFileSync(unknown, Buffer.alloc(100000, 8))
  await backupStudioDatabase(f.source, manual)
  const managedName = () => join(f.directory, 'studio-backup-20000101T000000000Z-' + randomUUID() + '.sqlite')
  const foreign = managedName(), corrupt = managedName(), selfConsistentCorrupt = managedName()
  const incomplete = managedName(), link = managedName()
  await backupStudioDatabase(f.source, foreign, { ownership: { sourceId: 'a'.repeat(64),
    backupId: basename(foreign).match(/[a-f0-9-]{36}(?=\.sqlite)/)[0] } })
  await backupStudioDatabase(f.source, corrupt, { ownership: { sourceId: metadata(old[0]).ownership.sourceId,
    backupId: basename(corrupt).match(/[a-f0-9-]{36}(?=\.sqlite)/)[0] } })
  const bad = Buffer.from(readFileSync(corrupt)); bad[bad.length - 1] ^= 1; writeFileSync(corrupt, bad)
  await backupStudioDatabase(f.source, selfConsistentCorrupt, { ownership: {
    sourceId: metadata(old[0]).ownership.sourceId,
    backupId: basename(selfConsistentCorrupt).match(/[a-f0-9-]{36}(?=\.sqlite)/)[0] } })
  const fakeComplete = metadata(selfConsistentCorrupt)
  writeFileSync(selfConsistentCorrupt, Buffer.alloc(fakeComplete.bytes, 9))
  writeFileSync(selfConsistentCorrupt + '.json', JSON.stringify({ ...fakeComplete,
    completedAt: '2000-01-01T00:00:00Z', sha256: digest(selfConsistentCorrupt) }))
  writeFileSync(incomplete, 'unfinished')
  writeFileSync(incomplete + '.json', '{"status":"incomplete"}')
  const outside = join(f.root, 'outside.sqlite'); writeFileSync(outside, 'outside-image-and-business')
  try { symlinkSync(outside, link, 'file') } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error
    t.diagnostic('文件symlink权限不可用；完成副本清单链接及目录junction保护另例覆盖')
  }
  const untouched = [unknown, manual, foreign, corrupt, selfConsistentCorrupt, incomplete, outside]
    .flatMap(path => [path, ...(existsSync(path + '.json') ? [path + '.json'] : [])])
    .map(path => [path, digest(path)])
  const scheduler = f.scheduler({ maxTotalBytes: cap, minFreeBytes: MiB })
  assert.deepEqual(await scheduler.run(), { ok: false, code: 'BACKUP_CAPACITY_EXCEEDED' })
  // The hash-consistent but corrupt candidate is retained conservatively and
  // still consumes the quota alongside the latest fully verified backup.
  assert.equal(scheduler.metrics().retainedCount, 2)
  assert.ok(scheduler.metrics().directoryBytes > cap)
  assert.ok(old.slice(0, -1).every(path => !existsSync(path)))
  assert.equal(existsSync(old.at(-1)), true)
  for (const [path, original] of untouched) assert.equal(digest(path), original)
  if (existsSync(link)) assert.equal(lstatSync(link).isSymbolicLink(), true)
})

test('保留阶段目录归属变化只报告故障，不先发备份恢复再发失败，已完成副本仍保留', async t => {
  const f = fixture(t), events = [], preserved = join(f.root, 'owned-original-backups')
  const outside = join(f.root, 'replacement-directory'); mkdirSync(outside)
  let finished = false, postBackupClocks = 0, now = Date.parse('2026-10-17T00:00:00Z')
  const scheduler = f.scheduler({ minFreeBytes: MiB,
    backup: async (...args) => { const result = await backupStudioDatabase(...args); finished = true; return result },
    clock() {
      // The first post-backup sample is the final disk check. The next is the
      // completion timestamp, immediately before retention validates its root.
      if (finished && ++postBackupClocks === 2) {
        renameSync(f.directory, preserved)
        symlinkSync(outside, f.directory, 'junction')
      }
      return now++
    }, onEvent: event => events.push(event) })
  const result = await scheduler.run()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BACKUP_PATH_INVALID')
  assert.equal(scheduler.metrics().retentionFailed, 1)
  assert.deepEqual(events.map(event => event.healthy), [false])
  assert.deepEqual(readdirSync(outside), [])
  const [good] = snapshots(preserved)
  assert.equal((await verifyStudioBackup(good)).hashVerification, 'verified')
})

test('容量与空间限制拒绝非法配置和非法环境值，缺省零值兼容已有显式测试实例', t => {
  const f = fixture(t)
  for (const key of ['maxTotalBytes', 'minFreeBytes']) {
    for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1024'])
      assert.throws(() => f.scheduler({ [key]: value }), /计划备份配置无效/)
  }
  const keys = ['STUDIO_BACKUP_MAX_TOTAL_BYTES', 'STUDIO_BACKUP_MIN_FREE_BYTES']
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) {
      process.env[key] = 'not-a-number'
      assert.throws(() => createBackupScheduler({ dbPath: f.source, directory: f.directory,
        intervalMinutes: 0, retentionCount: 3, failureWebhook: '' }), /计划备份配置无效/)
      delete process.env[key]
    }
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  }
  assert.equal(f.scheduler().metrics().maxTotalBytes, 0)
  assert.equal(f.scheduler().metrics().minFreeBytes, 0)
})
