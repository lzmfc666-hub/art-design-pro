import { mkdirSync, readdirSync, lstatSync, realpathSync, readFileSync, openSync,
  writeFileSync, closeSync, fstatSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join, relative, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { backupStudioDatabase, verifyStudioBackup } from '../scripts/studio-backup.mjs'
import { BACKUP_FILE_NAME, createBackupReplicator } from './backup-replication.mjs'

const codeError = code => Object.assign(new Error(code), { code })
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const inside = (root, path) => {
  const child = relative(root, path)
  return Boolean(child) && !child.startsWith('..') && !isAbsolute(child)
}
const safeCode = error => ['BACKUP_PATH_INVALID', 'BACKUP_LOCK_STALE', 'BACKUP_METADATA_INVALID',
  'BACKUP_HASH_MISMATCH', 'BACKUP_SCHEMA_UNSUPPORTED', 'BACKUP_SCHEMA_MISMATCH',
  'BACKUP_CORRUPT', 'BACKUP_REPLICATION_TIMEOUT', 'BACKUP_REPLICATION_HASH_MISMATCH',
  'BACKUP_REPLICATION_PATH_INVALID', 'BACKUP_REPLICATION_SOURCE_INVALID',
  'BACKUP_SNAPSHOT_ACTIVE', 'BACKUP_SOURCE_CHANGED'].includes(error?.code)
  ? error.code : 'BACKUP_FAILED'
const bounded = async (callback, timeoutMs) => {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(callback), new Promise((_, reject) => {
      timer = setTimeout(() => reject(codeError('BACKUP_CALLBACK_TIMEOUT')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

/** Opt-in verified backups. Filesystem/callback work never shares a business transaction. */
export function createBackupScheduler({
  dbPath,
  intervalMinutes = Number(process.env.STUDIO_BACKUP_INTERVAL_MINUTES || 0),
  directory = process.env.STUDIO_BACKUP_DIR ||
    (dbPath && dbPath !== ':memory:' ? resolve(dirname(dbPath), 'backups') : ''),
  retentionCount = Number(process.env.STUDIO_BACKUP_RETENTION_COUNT || 7),
  failureWebhook = process.env.STUDIO_BACKUP_FAILURE_WEBHOOK || '',
  clock = Date.now, backup = backupStudioDatabase, notifyFailure, fetcher = fetch,
  applicationRelease = null, onEvent, callbackTimeoutMs = 10000, replication = {},
  staleAfterMinutes = intervalMinutes > 0 ? intervalMinutes * 2 : 0
} = {}) {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 35791 ||
      !Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 90 ||
      !Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs < 10 || callbackTimeoutMs > 60000 ||
      !Number.isFinite(staleAfterMinutes) || staleAfterMinutes < 0)
    throw new Error('数据库计划备份配置无效')
  const enabled = intervalMinutes > 0
  if (enabled && (!dbPath || dbPath === ':memory:' || !directory))
    throw new Error('数据库计划备份需要独立磁盘源库和备份目录')
  if (failureWebhook) {
    const url = new URL(failureWebhook)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('备份失败提醒地址必须为 HTTPS')
  }
  const replicator = createBackupReplicator(replication)
  const configuredRoot = directory ? resolve(directory) : null
  const createdAt = Number(new Date(clock()))
  let timer, running = false, closed = false, root, lock, lockInfo
  const status = {
    enabled, intervalMinutes, retentionCount, completed: 0, failed: 0,
    failureNotificationsFailed: 0, eventCallbacksFailed: 0, retentionFailed: 0,
    skipped: 0, lastStartedAt: null, lastCompletedAt: null, lastFailureAt: null,
    lastDurationMs: null, lastErrorCode: null, lastRetentionErrorCode: null, lastSuccess: null,
    replication: { enabled: replicator.enabled, kind: replicator.kind, targetId: replicator.targetId,
      completed: 0, failed: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null }
  }
  const eventFor = (category, healthy, code, occurredAt) => ({
    key: category + '.' + category, type: 'studio.' + category + (healthy ? '.completed' : '.failed'),
    healthy, service: category, category, severity: healthy ? 'info' : 'error',
    adviceCode: category === 'backup' ? 'CHECK_BACKUP' : 'CHECK_REPLICATION', code, occurredAt
  })
  const observe = async event => {
    if (!onEvent) return
    try { await bounded(() => onEvent(event), callbackTimeoutMs) }
    catch { status.eventCallbacksFailed++ }
  }
  const alertFailure = async event => {
    try {
      if (notifyFailure) await bounded(() => notifyFailure(event), callbackTimeoutMs)
      if (failureWebhook) {
        const response = await bounded(() => fetcher(failureWebhook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
          signal: AbortSignal.timeout(callbackTimeoutMs), redirect: 'error'
        }), callbackTimeoutMs)
        if (!response.ok) throw codeError('BACKUP_FAILURE_HOOK_FAILED')
      }
    } catch { status.failureNotificationsFailed++ }
  }
  const validateRoot = () => {
    mkdirSync(configuredRoot, { recursive: true, mode: 0o700 })
    if (!lstatSync(configuredRoot).isDirectory() || lstatSync(configuredRoot).isSymbolicLink())
      throw codeError('BACKUP_PATH_INVALID')
    const actual = realpathSync(configuredRoot)
    if (root && !same(actual, root)) throw codeError('BACKUP_PATH_INVALID')
    root = actual
  }
  const acquire = started => {
    lock = join(root, '.studio-backup-running.json')
    let handle
    try { handle = openSync(lock, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      let reason = 'BACKUP_IN_PROGRESS'
      try {
        const info = lstatSync(lock)
        if (info.isFile() && !info.isSymbolicLink() && info.size <= 4096) {
          const owner = JSON.parse(readFileSync(lock, 'utf8'))
          if (typeof owner.expiresAt === 'string' && Date.parse(owner.expiresAt) < started)
            reason = 'BACKUP_LOCK_STALE'
        }
      } catch {}
      // Expired locks are not silently deleted or stolen from another process.
      lock = null
      return reason
    }
    lockInfo = fstatSync(handle)
    try {
      writeFileSync(handle, JSON.stringify({ pid: process.pid, token: randomUUID(),
        startedAt: new Date(started).toISOString(), expiresAt: new Date(started + 3600000).toISOString() }))
    } finally { closeSync(handle) }
    return null
  }
  const releaseLock = () => {
    if (!lock) return
    try {
      const info = lstatSync(lock)
      if (info.isFile() && !info.isSymbolicLink() && info.dev === lockInfo.dev && info.ino === lockInfo.ino)
        unlinkSync(lock)
    } finally { lock = null; lockInfo = null }
  }
  const retain = (currentPath, sourceId) => {
    validateRoot()
    const files = []
    for (const name of readdirSync(root)) {
      const match = name.match(BACKUP_FILE_NAME)
      if (!match) continue
      const path = resolve(root, name), manifest = path + '.json'
      if (!inside(root, path) || !inside(root, manifest)) throw codeError('BACKUP_PATH_INVALID')
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      try {
        const summary = lstatSync(manifest)
        if (!summary.isFile() || summary.isSymbolicLink() || summary.size > 65536) continue
        const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
        if (metadata.status !== 'complete' || metadata.ownership?.managedBy !== 'studio-backup-scheduler-v1' ||
            metadata.ownership.sourceId !== sourceId || metadata.ownership.backupId !== match[1] ||
            !/^[a-f0-9]{64}$/.test(metadata.sha256 || '') || metadata.bytes !== info.size ||
            !Number.isFinite(Date.parse(metadata.completedAt))) continue
        files.push({ path, manifest, info, summary, completed: Date.parse(metadata.completedAt), name })
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    }
    files.sort((a, b) => Number(b.path === currentPath) - Number(a.path === currentPath) ||
      b.completed - a.completed || b.info.mtimeMs - a.info.mtimeMs || b.name.localeCompare(a.name))
    for (const file of files.slice(retentionCount)) {
      // Re-check both regular-file identities and the configured root immediately before unlink.
      validateRoot()
      for (const [path, expected] of [[file.manifest, file.summary], [file.path, file.info]]) {
        const actual = lstatSync(path)
        if (actual.isSymbolicLink() || !actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino)
          throw codeError('BACKUP_PATH_INVALID')
      }
      unlinkSync(file.manifest); unlinkSync(file.path)
    }
  }
  const run = async () => {
    if (closed || running || !dbPath || dbPath === ':memory:' || !configuredRoot) return { skipped: true }
    running = true
    const started = Number(new Date(clock())), measured = performance.now()
    status.lastStartedAt = new Date(started).toISOString()
    try {
      validateRoot()
      const reason = acquire(started)
      if (reason) { status.skipped++; status.lastErrorCode = reason; return { skipped: true, reason } }
      const sourceId = createHash('sha256').update(realpathSync(dbPath)).digest('hex')
      const backupId = randomUUID(), stamp = new Date(started).toISOString().replace(/[-:.]/g, '')
      const target = resolve(root, 'studio-backup-' + stamp + '-' + backupId + '.sqlite')
      await backup(dbPath, target, { applicationRelease, clock, ownership: { sourceId, backupId } })
      const verified = await verifyStudioBackup(target)
      if (verified.hashVerification !== 'verified') throw codeError('BACKUP_METADATA_INVALID')
      status.completed++
      status.lastCompletedAt = new Date(clock()).toISOString()
      status.lastErrorCode = null
      status.lastSuccess = { completedAt: status.lastCompletedAt, applicationRelease: verified.applicationRelease,
        schemaVersion: verified.schemaVersion, bytes: verified.bytes, sha256: verified.sha256 }
      await observe(eventFor('backup', true, 'BACKUP_COMPLETE', status.lastCompletedAt))
      try { retain(target, sourceId); status.lastRetentionErrorCode = null }
      catch { status.retentionFailed++; status.lastRetentionErrorCode = 'BACKUP_RETENTION_FAILED' }
      if (!replicator.enabled) return { ok: true }
      try {
        const metadata = JSON.parse(readFileSync(target + '.json', 'utf8'))
        const result = await replicator.run({ path: target, metadata })
        status.replication.completed++
        status.replication.lastSuccessAt = new Date(clock()).toISOString()
        status.replication.lastErrorCode = null
        await observe(eventFor('replication', true, 'REPLICATION_COMPLETE', status.replication.lastSuccessAt))
        return { ok: true, replication: result }
      } catch (error) {
        status.replication.failed++
        status.replication.lastFailureAt = new Date(clock()).toISOString()
        status.replication.lastErrorCode = safeCode(error) === 'BACKUP_FAILED' ? 'BACKUP_REPLICATION_FAILED' : safeCode(error)
        const event = eventFor('replication', false, status.replication.lastErrorCode, status.replication.lastFailureAt)
        await observe(event); await alertFailure(event)
        return { ok: true, replication: { ok: false, code: status.replication.lastErrorCode } }
      }
    } catch (error) {
      status.failed++
      status.lastFailureAt = new Date(clock()).toISOString()
      status.lastErrorCode = safeCode(error)
      const event = eventFor('backup', false, status.lastErrorCode, status.lastFailureAt)
      await observe(event); await alertFailure(event)
      return { ok: false, code: status.lastErrorCode }
    } finally {
      try { releaseLock() } catch { status.lastErrorCode = 'BACKUP_LOCK_RELEASE_FAILED' }
      status.lastDurationMs = Math.max(0, performance.now() - measured)
      running = false
    }
  }
  return {
    start() {
      if (enabled && !timer && !closed) {
        timer = setInterval(() => void run(), Math.max(1000, intervalMinutes * 60000)); timer.unref()
      }
    },
    run,
    metrics() {
      const ageMs = Math.max(0, Number(new Date(clock())) -
        (status.lastCompletedAt ? Date.parse(status.lastCompletedAt) : createdAt))
      return { ...status, lastSuccess: status.lastSuccess ? { ...status.lastSuccess } : null,
        replication: { ...status.replication }, running, closed,
        ageMs, stale: enabled && staleAfterMinutes > 0 && ageMs > staleAfterMinutes * 60000 }
    },
    close() { closed = true; if (timer) clearInterval(timer) }
  }
}
