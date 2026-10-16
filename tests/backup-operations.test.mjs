import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  existsSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { backupStudioDatabase, restoreStudioDatabase, verifyStudioBackup } from '../scripts/studio-backup.mjs'
import { createBackupScheduler } from '../server/backup-scheduler.mjs'
import { createBackupReplicator, createMountedBackupAdapter } from '../server/backup-replication.mjs'

function fixture(t, version = 2) {
  const root = mkdtempSync(join(tmpdir(), 'studio-backup-ops-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source.sqlite')
  const db = new DatabaseSync(source)
  db.exec('CREATE TABLE studio_state(id INTEGER PRIMARY KEY,json TEXT);CREATE TABLE test_funds(id INTEGER PRIMARY KEY,amount INTEGER);CREATE TABLE test_images(id INTEGER PRIMARY KEY,data BLOB)')
  db.prepare('INSERT INTO studio_state VALUES(1,?)').run(JSON.stringify({ schemaVersion: version, privateNote: 'PRIVATE-TEST-CREDENTIAL' }))
  db.prepare('INSERT INTO test_funds VALUES(1,?)').run(1001)
  db.prepare('INSERT INTO test_images VALUES(1,?)').run(Buffer.from('PRIVATE-TEST-IMAGE'))
  db.close()
  const directory = join(root, 'backups'), remote = join(root, 'mounted-simulation')
  mkdirSync(remote)
  const scheduler = options => createBackupScheduler({ dbPath: source, directory,
    intervalMinutes: 0, retentionCount: 2, failureWebhook: '', ...options })
  return { root, source, directory, remote, scheduler }
}
const manifest = path => JSON.parse(readFileSync(path + '.json', 'utf8'))
const artifact = directory => join(directory, readdirSync(directory).find(name => name.endsWith('.sqlite')))
const hasCode = code => error => error.code === code

test('完成清单含时间/发布/数据版本/真实字节SHA，只读校验无私人记录', async t => {
  const f = fixture(t), target = join(f.root, 'verified.sqlite')
  let now = Date.parse('2026-10-15T02:00:00Z')
  const result = await backupStudioDatabase(f.source, target, {
    applicationRelease: 'isolated-release-v3.4', clock: () => now++ })
  const metadata = result.metadata
  assert.equal(metadata.status, 'complete')
  assert.equal(metadata.schemaVersion, 2)
  assert.equal(metadata.applicationRelease, 'isolated-release-v3.4')
  assert.ok(Date.parse(metadata.completedAt) >= Date.parse(metadata.startedAt))
  assert.equal(metadata.generatedAt, metadata.completedAt)
  assert.equal(metadata.bytes, readFileSync(target).length)
  assert.equal(metadata.sha256, createHash('sha256').update(readFileSync(target)).digest('hex'))
  const verified = await verifyStudioBackup(target)
  assert.equal(verified.hashVerification, 'verified')
  assert.equal(verified.integrity, 'ok')
  assert.ok(!JSON.stringify(verified).includes('PRIVATE-'))
  assert.equal(verified.path, undefined)
  await assert.rejects(() => backupStudioDatabase(f.source, target), /已存在/)
  assert.deepEqual(manifest(target), metadata)
})

test('损坏副本/清单版本冲突/未来schema在创建离线目标前拒绝', async t => {
  const f = fixture(t), backup = join(f.root, 'valid.sqlite')
  await backupStudioDatabase(f.source, backup)
  const original = manifest(backup), destination = join(f.root, 'offline.sqlite')
  writeFileSync(backup + '.json', JSON.stringify({ ...original, sha256: '0'.repeat(64) }))
  await assert.rejects(() => restoreStudioDatabase(backup, destination), hasCode('BACKUP_HASH_MISMATCH'))
  assert.equal(existsSync(destination), false)
  writeFileSync(backup + '.json', JSON.stringify({ ...original, schemaVersion: 1 }))
  await assert.rejects(() => restoreStudioDatabase(backup, destination), hasCode('BACKUP_SCHEMA_MISMATCH'))
  assert.equal(existsSync(destination), false)
  const future = fixture(t, 3), futureBackup = join(future.root, 'future.sqlite')
  await backupStudioDatabase(future.source, futureBackup)
  await assert.rejects(() => restoreStudioDatabase(futureBackup, destination), hasCode('BACKUP_SCHEMA_UNSUPPORTED'))
  assert.equal(existsSync(destination), false)
  const corrupt = join(f.root, 'corrupt.sqlite')
  writeFileSync(corrupt, 'not a database')
  await assert.rejects(() => restoreStudioDatabase(corrupt, destination), hasCode('BACKUP_CORRUPT'))
  assert.equal(existsSync(destination), false)
})

test('旧无SHA完成清单兼容但来源校验unknown，离线复制保留资金与图片', async t => {
  const f = fixture(t), backup = join(f.root, 'legacy.sqlite'), restored = join(f.root, 'offline.sqlite')
  await backupStudioDatabase(f.source, backup)
  const old = manifest(backup)
  for (const key of ['sha256', 'bytes', 'status', 'applicationRelease', 'completedAt', 'startedAt']) delete old[key]
  writeFileSync(backup + '.json', JSON.stringify(old))
  assert.equal((await verifyStudioBackup(backup)).hashVerification, 'unknown')
  const copied = await restoreStudioDatabase(backup, restored)
  assert.equal(copied.sourceVerification.hashVerification, 'unknown')
  const db = new DatabaseSync(restored, { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT amount FROM test_funds').get().amount, 1001)
    assert.equal(Buffer.from(db.prepare('SELECT data FROM test_images').get().data).toString(), 'PRIVATE-TEST-IMAGE')
  } finally { db.close() }
})

test('已完成副本额外WAL不冒充SHA完整快照，版本上限与异常清单保守拒绝', async t => {
  const f = fixture(t), target = join(f.root, 'snapshot.sqlite'), offline = join(f.root, 'offline.sqlite')
  await backupStudioDatabase(f.source, target)
  const original = manifest(target)
  await assert.rejects(() => verifyStudioBackup(target, { maxSchemaVersion: 999 }), hasCode('BACKUP_SCHEMA_UNSUPPORTED'))
  for (const value of [null, 0, [], { ...original, applicationRelease: { secret: 'PRIVATE-RELEASE' } },
    { ...original, completedAt: undefined }]) {
    writeFileSync(target + '.json', JSON.stringify(value))
    await assert.rejects(() => verifyStudioBackup(target))
  }
  writeFileSync(target + '.json', JSON.stringify(original))
  const active = new DatabaseSync(target)
  try {
    active.exec('PRAGMA journal_mode=WAL')
    active.prepare('INSERT INTO test_funds VALUES(2,?)').run(2002)
    // Refresh only the base-file digest: it still cannot attest the additional WAL frames.
    const data = readFileSync(target)
    writeFileSync(target + '.json', JSON.stringify({ ...original, bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') }))
    await assert.rejects(() => restoreStudioDatabase(target, offline), hasCode('BACKUP_SNAPSHOT_ACTIVE'))
    assert.equal(existsSync(offline), false)
  } finally { active.close() }
})

test('源校验变化在新完成清单前失败，清理只限本次离线目标', async t => {
  const f = fixture(t), target = join(f.root, 'changed.sqlite')
  const before = readFileSync(f.source)
  await assert.rejects(() => backupStudioDatabase(f.source, target, { expectedSourceDigest: {
    bytes: before.length, sha256: '0'.repeat(64), schemaVersion: 2, hashVerification: 'verified'
  } }), hasCode('BACKUP_SOURCE_CHANGED'))
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(target + '.json'), false)
  assert.deepEqual(readFileSync(f.source), before)
})

test('失败不覆盖recent good；故障/恢复结构事件不带路径或原异常', async t => {
  const f = fixture(t), events = []
  let failed = false
  const scheduler = f.scheduler({ applicationRelease: 'local-test-release', onEvent: event => events.push(event),
    backup: (...args) => failed ? Promise.reject(new Error('PRIVATE-SECRET-PATH')) : backupStudioDatabase(...args) })
  t.after(() => scheduler.close())
  assert.deepEqual(await scheduler.run(), { ok: true })
  const good = scheduler.metrics().lastSuccess, goodPath = artifact(f.directory)
  const original = readFileSync(goodPath)
  failed = true
  assert.deepEqual(await scheduler.run(), { ok: false, code: 'BACKUP_FAILED' })
  assert.deepEqual(scheduler.metrics().lastSuccess, good)
  assert.deepEqual(readFileSync(goodPath), original)
  failed = false
  assert.deepEqual(await scheduler.run(), { ok: true })
  assert.deepEqual(events.map(row => [row.key, row.healthy]), [
    ['backup.backup', true], ['backup.backup', false], ['backup.backup', true] ])
  assert.ok(events.every(row => row.adviceCode === 'CHECK_BACKUP'))
  assert.ok(!JSON.stringify(events).includes('PRIVATE-'))
  assert.ok(!JSON.stringify(events).includes(f.root))
  assert.equal(scheduler.metrics().completed, 2)
  assert.equal(scheduler.metrics().failed, 1)
})

test('备份失败删除本次预约目标，不影响另一个成功副本', async t => {
  const f = fixture(t), good = join(f.root, 'good.sqlite'), broken = join(f.root, 'broken.sqlite')
  await backupStudioDatabase(f.source, good)
  const invalid = join(f.root, 'invalid.sqlite')
  writeFileSync(invalid, 'broken source')
  await assert.rejects(() => backupStudioDatabase(invalid, broken))
  assert.equal(existsSync(broken), false)
  assert.equal(existsSync(broken + '.json'), false)
  assert.equal((await verifyStudioBackup(good)).hashVerification, 'verified')
})

test('retention只删本源归属完成副本，伪装文件/他源/符号链接保持', async t => {
  const f = fixture(t), scheduler = f.scheduler({ retentionCount: 1 })
  t.after(() => scheduler.close())
  await scheduler.run()
  const other = join(f.directory, 'studio-backup-20200101T000000000Z-' + randomUUID() + '.sqlite')
  await backupStudioDatabase(f.source, other, { ownership: { sourceId: 'a'.repeat(64), backupId: basename(other).match(/[a-f0-9-]{36}(?=\.sqlite)/)[0] } })
  const impostor = join(f.directory, 'studio-backup-19990101T000000000Z-' + randomUUID() + '.sqlite')
  writeFileSync(impostor, 'PRIVATE-UNRELATED')
  writeFileSync(impostor + '.json', JSON.stringify({ status: 'complete', path: '../private.sqlite' }))
  const outside = join(f.root, 'outside.sqlite'), link = join(f.directory, 'studio-backup-19980101T000000000Z-' + randomUUID() + '.sqlite')
  writeFileSync(outside, 'PRIVATE-OUTSIDE')
  try { symlinkSync(outside, link, 'file') } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error
    t.diagnostic('当前Windows权限不支持文件symlink；目录junction边界另例验证')
  }
  await scheduler.run()
  assert.equal(readFileSync(impostor, 'utf8'), 'PRIVATE-UNRELATED')
  assert.equal(readFileSync(outside, 'utf8'), 'PRIVATE-OUTSIDE')
  assert.equal(existsSync(other), true)
  const owned = readdirSync(f.directory).filter(name => name.endsWith('.sqlite')).filter(name => {
    try { return manifest(join(f.directory, name)).ownership?.sourceId !== 'a'.repeat(64) && manifest(join(f.directory, name)).ownership?.managedBy === 'studio-backup-scheduler-v1' } catch { return false }
  })
  assert.equal(owned.length, 1)
})

test('同实例/同目录另一调度器拒绝重叠，过期锁不偷取', async t => {
  const f = fixture(t)
  let release, entered
  const waiting = new Promise(done => { entered = done })
  const first = f.scheduler({ backup: async (...args) => { entered(); await new Promise(done => { release = done }); return backupStudioDatabase(...args) } })
  const second = f.scheduler()
  t.after(() => { first.close(); second.close() })
  const active = first.run(); await waiting
  assert.deepEqual(await first.run(), { skipped: true })
  assert.deepEqual(await second.run(), { skipped: true, reason: 'BACKUP_IN_PROGRESS' })
  release(); assert.deepEqual(await active, { ok: true })
  const lock = join(f.directory, '.studio-backup-running.json')
  writeFileSync(lock, JSON.stringify({ expiresAt: '1999-01-01T00:00:00Z' }))
  assert.deepEqual(await second.run(), { skipped: true, reason: 'BACKUP_LOCK_STALE' })
  assert.equal(existsSync(lock), true)
})

test('目录junction外跳拒绝，不清理或备份到陌生目录', async t => {
  const f = fixture(t), outside = join(f.root, 'outside-directory')
  mkdirSync(outside)
  const configured = join(f.root, 'linked-backups')
  symlinkSync(outside, configured, 'junction')
  const scheduler = f.scheduler({ directory: configured })
  t.after(() => scheduler.close())
  assert.deepEqual(await scheduler.run(), { ok: false, code: 'BACKUP_PATH_INVALID' })
  assert.deepEqual(readdirSync(outside), [])
  assert.throws(() => createMountedBackupAdapter({ directory: configured }), hasCode('BACKUP_REPLICATION_PATH_INVALID'))
})

test('callback与旧webhook bounded，无实际网络且错误不泄露', async t => {
  const f = fixture(t), started = performance.now()
  const scheduler = f.scheduler({ callbackTimeoutMs: 10,
    backup: async () => { throw new Error('PRIVATE-FAILURE') },
    onEvent: () => new Promise(() => {}), failureWebhook: 'https://dummy.invalid/no-network',
    fetcher: () => new Promise(() => {}) })
  t.after(() => scheduler.close())
  assert.deepEqual(await scheduler.run(), { ok: false, code: 'BACKUP_FAILED' })
  assert.ok(performance.now() - started < 1000)
  assert.equal(scheduler.metrics().eventCallbacksFailed, 1)
  assert.equal(scheduler.metrics().failureNotificationsFailed, 1)
})

test('配置关闭不创建复制目标；past good age过期与新成功恢复', async t => {
  const f = fixture(t), missing = join(f.root, 'must-not-create')
  const disabled = createBackupReplicator({ enabled: false, directory: missing })
  assert.deepEqual(await disabled.run(), { skipped: true })
  assert.equal(existsSync(missing), false)
  let now = Date.parse('2026-10-15T00:00:00Z')
  const scheduler = f.scheduler({ intervalMinutes: 1, staleAfterMinutes: 2, clock: () => now })
  t.after(() => scheduler.close())
  assert.equal(scheduler.metrics().stale, false)
  now += 120001
  assert.equal(scheduler.metrics().stale, true)
  await scheduler.run()
  assert.equal(scheduler.metrics().stale, false)
})

test('mounted target模拟复制完整SHA匹配，同盘不冒称异机', async t => {
  const f = fixture(t), events = []
  const scheduler = f.scheduler({ onEvent: event => events.push(event),
    replication: { enabled: true, kind: 'simulation', targetId: 'isolated-copy', directory: f.remote } })
  t.after(() => scheduler.close())
  const result = await scheduler.run()
  assert.equal(result.ok, true)
  assert.equal(result.replication.kind, 'simulation')
  const local = artifact(f.directory), copied = join(f.remote, basename(local))
  assert.equal((await verifyStudioBackup(copied)).sha256, (await verifyStudioBackup(local)).sha256)
  assert.deepEqual(events.map(row => row.key), ['backup.backup', 'replication.replication'])
  assert.equal(scheduler.metrics().replication.completed, 1)
  assert.throws(() => createBackupReplicator({ enabled: true, kind: 'remote', targetId: 'not-remote',
    remoteIdentity: { host: 'backup-host.example', share: 'share' }, directory: f.remote }),
  hasCode('BACKUP_REPLICATION_IDENTITY_REQUIRED'))
})

test('复制中失败或SHA不符只增加复制failed，保留本地成功及清理temp', async t => {
  for (const kind of ['copy', 'hash']) {
    const f = fixture(t), events = []
    const mounted = createMountedBackupAdapter({ directory: f.remote })
    const adapter = { ...mounted, ...(kind === 'copy' ? {
      async writeTemporary(input) { await mounted.writeTemporary(input); throw new Error('PRIVATE-COPY-FAILED') }
    } : { inspectTemporary: async () => ({ bytes: 1, sha256: '0'.repeat(64) }) }) }
    const scheduler = f.scheduler({ onEvent: event => events.push(event), replication: {
      enabled: true, kind: 'simulation', targetId: 'failed-copy', adapter } })
    t.after(() => scheduler.close())
    const result = await scheduler.run()
    assert.equal(result.ok, true)
    assert.equal(result.replication.ok, false)
    const status = scheduler.metrics()
    assert.equal(status.completed, 1); assert.equal(status.failed, 0)
    assert.equal(status.replication.failed, 1)
    assert.equal((await verifyStudioBackup(artifact(f.directory))).hashVerification, 'verified')
    assert.deepEqual(readdirSync(f.remote), [])
    assert.equal(events.at(-1).key, 'replication.replication')
    assert.equal(events.at(-1).healthy, false)
    assert.ok(!JSON.stringify(events).includes('PRIVATE-'))
  }
})

test('已存在复制目标不覆盖；未知文件及恶意cleanup路径不删除', async t => {
  const f = fixture(t), mounted = createMountedBackupAdapter({ directory: f.remote })
  const scheduler = f.scheduler({ replication: { enabled: true, kind: 'simulation', targetId: 'collision',
    adapter: { ...mounted, async writeTemporary(input) {
      writeFileSync(join(f.remote, basename(input.sourcePath)), 'PRIVATE-FOREIGN')
      await mounted.writeTemporary(input)
    } } } })
  t.after(() => scheduler.close())
  const result = await scheduler.run()
  assert.equal(result.ok, true); assert.equal(result.replication.ok, false)
  assert.equal(readFileSync(join(f.remote, basename(artifact(f.directory))), 'utf8'), 'PRIVATE-FOREIGN')
  const keep = join(f.remote, 'keep.txt'); writeFileSync(keep, 'keep')
  mounted.removeTemporary({ temporaryName: 'keep.txt' })
  assert.equal(readFileSync(keep, 'utf8'), 'keep')
  assert.throws(() => mounted.removeTemporary({ temporaryName: '../source.sqlite' }), hasCode('BACKUP_REPLICATION_PATH_INVALID'))
})

test('超时适配器迟到的临时写不发布完成副本，调度等待有界', async t => {
  const f = fixture(t)
  let commits = 0, cleaned = 0
  const scheduler = f.scheduler({ replication: { enabled: true, kind: 'simulation', targetId: 'late-copy', timeoutMs: 20,
    adapter: { writeTemporary: () => new Promise(done => setTimeout(done, 80)),
      inspectTemporary: async () => { throw new Error('must not inspect canceled write') },
      commit: async () => { commits++ }, removeTemporary: async () => { cleaned++ } } } })
  t.after(() => scheduler.close())
  const result = await scheduler.run()
  assert.deepEqual(result, { ok: true, replication: { ok: false, code: 'BACKUP_REPLICATION_TIMEOUT' } })
  await new Promise(done => setTimeout(done, 100))
  assert.equal(commits, 0); assert.equal(cleaned, 1)
  assert.equal(scheduler.metrics().failed, 0)
})
