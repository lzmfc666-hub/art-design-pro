import { mkdirSync, readdirSync, lstatSync, realpathSync, readFileSync, openSync,
  writeFileSync, closeSync, fstatSync, unlinkSync, statfsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { resolve, dirname, join, relative, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { backupStudioDatabase, verifyStudioBackup, backupFileDigest } from '../scripts/studio-backup.mjs'
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
  'BACKUP_SNAPSHOT_ACTIVE', 'BACKUP_SOURCE_CHANGED', 'BACKUP_DISK_LOW', 'BACKUP_DISK_PROBE_FAILED',
  'BACKUP_CAPACITY_EXCEEDED', 'BACKUP_RETENTION_FAILED'].includes(error?.code)
  ? error.code : 'BACKUP_FAILED'
const bounded = async (callback, timeoutMs) => {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(callback), new Promise((_, reject) => {
      timer = setTimeout(() => reject(codeError('BACKUP_CALLBACK_TIMEOUT')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
const backupWorker = (workerData, onReserved) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./backup-job-worker.mjs', import.meta.url), { workerData })
  let result, settled = false
  const timer = setTimeout(() => { void worker.terminate() }, 300000)
  worker.on('message', value => { if (value.reserved) onReserved?.(value.reserved); else result = value })
  worker.on('error', () => {})
  worker.on('exit', code => {
    if (settled) return
    settled = true; clearTimeout(timer)
    if (code !== 0 || !result?.ok) reject(codeError(safeCode({ code: result?.code })))
    else resolve(result.value)
  })
})

/** Opt-in verified backups. Filesystem/callback work never shares a business transaction. */
export function createBackupScheduler({
  dbPath,
  intervalMinutes = Number(process.env.STUDIO_BACKUP_INTERVAL_MINUTES || 0),
  directory = process.env.STUDIO_BACKUP_DIR ||
    (dbPath && dbPath !== ':memory:' ? resolve(dirname(dbPath), 'backups') : ''),
  retentionCount = Number(process.env.STUDIO_BACKUP_RETENTION_COUNT || 7),
  maxTotalBytes = Number(process.env.STUDIO_BACKUP_MAX_TOTAL_BYTES || 0),
  minFreeBytes = Number(process.env.STUDIO_BACKUP_MIN_FREE_BYTES || 0),
  failureWebhook = process.env.STUDIO_BACKUP_FAILURE_WEBHOOK || '',
  clock = Date.now, backup = backupStudioDatabase, notifyFailure, fetcher = fetch,
  applicationRelease = null, onEvent, callbackTimeoutMs = 10000, replication = {},
  staleAfterMinutes = intervalMinutes > 0 ? intervalMinutes * 2 : 0,
  diskProbe = statfsSync
} = {}) {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 35791 ||
      !Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 90 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0 ||
      !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0 || typeof diskProbe !== 'function' ||
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
    enabled, intervalMinutes, retentionCount, maxTotalBytes, minFreeBytes, completed: 0, failed: 0,
    failureNotificationsFailed: 0, eventCallbacksFailed: 0, retentionFailed: 0,
    skipped: 0, lastStartedAt: null, lastCompletedAt: null, lastFailureAt: null,
    lastDurationMs: null, lastErrorCode: null, lastRetentionErrorCode: null, lastSuccess: null,
    retainedCount: null, retainedBytes: null, directoryBytes: null, removedBackups: 0, lastCapacityCheck: null,
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
  const verify = path => maxTotalBytes || minFreeBytes
    ? backupWorker({ operation: 'verify', path }) : verifyStudioBackup(path)
  const directoryBytes = () => {
    let bytes = 0
    const visit = path => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name), info = lstatSync(child)
        if (info.isSymbolicLink()) continue
        if (info.isDirectory()) visit(child)
        else if (info.isFile()) bytes += info.size
      }
    }
    visit(root)
    return bytes
  }
  const retain = async (currentPath, sourceId) => {
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
        files.push({ path, manifest, info, summary, sha256: metadata.sha256, manifestText: readFileSync(manifest, 'utf8'),
          bytes: info.size + summary.size, completed: Date.parse(metadata.completedAt), name })
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    }
    files.sort((a, b) => Number(b.path === currentPath) - Number(a.path === currentPath) ||
      b.completed - a.completed || b.info.mtimeMs - a.info.mtimeMs || b.name.localeCompare(a.name))
    // An invalid snapshot is never silently treated as a reclaimable managed backup.
    const verified = []
    for (const file of files) {
      try {
        const digest = await backupFileDigest(file.path)
        let active = false
        try { active = lstatSync(file.path + '-wal').size > 0 } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
        if (digest.sha256 === file.sha256 && !active) verified.push(file)
      } catch { /* Leave corrupt/active/unrecognized snapshots untouched. */ }
    }
    let count = verified.length, bytes = verified.reduce((sum, file) => sum + file.bytes, 0)
    let protectedPath
    for (const file of verified) {
      try { if ((await verify(file.path)).hashVerification === 'verified') { protectedPath = file.path; break } }
      catch { /* Keep every unverified snapshot intact. */ }
    }
    if (verified.length && !protectedPath) throw codeError('BACKUP_CORRUPT')
    let totalBytes = maxTotalBytes ? directoryBytes() : bytes
    for (const file of [...verified].reverse()) {
      if (count <= retentionCount && (!maxTotalBytes || totalBytes <= maxTotalBytes)) break
      if (file.path === protectedPath) continue
      try { if ((await verify(file.path)).hashVerification !== 'verified') continue }
      catch { continue }
      // Re-check both regular-file identities and the configured root immediately before unlink.
      validateRoot()
      for (const [path, expected] of [[file.manifest, file.summary], [file.path, file.info]]) {
        const actual = lstatSync(path)
        if (actual.isSymbolicLink() || !actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
            actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs)
          throw codeError('BACKUP_PATH_INVALID')
      }
      if (readFileSync(file.manifest, 'utf8') !== file.manifestText ||
          (await backupFileDigest(file.path)).sha256 !== file.sha256) throw codeError('BACKUP_METADATA_INVALID')
      validateRoot()
      for (const [path, expected] of [[file.path, file.info], [file.manifest, file.summary]]) {
        const actual = lstatSync(path)
        if (actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
            actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) throw codeError('BACKUP_PATH_INVALID')
      }
      unlinkSync(file.path); unlinkSync(file.manifest)
      count--; bytes -= file.bytes; totalBytes -= file.bytes; status.removedBackups++
    }
    status.retainedCount = count; status.retainedBytes = bytes
    status.directoryBytes = maxTotalBytes ? directoryBytes() : null
    if (maxTotalBytes && status.directoryBytes > maxTotalBytes) throw codeError('BACKUP_CAPACITY_EXCEEDED')
    if (count > retentionCount) throw codeError('BACKUP_RETENTION_FAILED')
  }
  const freeBytes = path => {
    try {
      const sample = diskProbe(path), bytes = Number(sample.bavail) * Number(sample.bsize)
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Unavailable disk probe')
      return bytes
    } catch { throw codeError('BACKUP_DISK_PROBE_FAILED') }
  }
  const capacityCheck = (target, estimatedBytes, initial = false) => {
    if (!maxTotalBytes && !minFreeBytes) return
    const sourceFreeBytes = freeBytes(dirname(resolve(dbPath))), targetFreeBytes = freeBytes(root)
    const workingBytes = initial ? estimatedBytes * 3 + 64 * 1024 * 1024 : 0
    status.lastCapacityCheck = { sourceFreeBytes, targetFreeBytes, estimatedBytes, workingBytes,
      minimumFreeBytes: minFreeBytes, checkedAt: new Date(clock()).toISOString() }
    if (sourceFreeBytes < minFreeBytes || targetFreeBytes < minFreeBytes + workingBytes)
      throw codeError('BACKUP_DISK_LOW')
    let targetBytes = 0
    for (const path of [target, target + '.json']) {
      try {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink()) throw codeError('BACKUP_PATH_INVALID')
        targetBytes += info.size
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    }
    if (maxTotalBytes && Math.max(targetBytes, initial ? estimatedBytes : 0) > maxTotalBytes)
      throw codeError('BACKUP_CAPACITY_EXCEEDED')
  }
  const estimate = () => {
    let bytes = lstatSync(dbPath).size
    try { bytes += lstatSync(dbPath + '-wal').size } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    const source = new DatabaseSync(dbPath, { readOnly: true })
    try {
      if (source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_archives'").get())
        bytes += source.prepare('SELECT coalesce(sum(size),0) AS bytes FROM image_archives').get().bytes
    } finally { source.close() }
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > Number.MAX_SAFE_INTEGER / 4)
      throw codeError('BACKUP_CAPACITY_EXCEEDED')
    return bytes
  }
  const run = async () => {
    if (closed || running || !dbPath || dbPath === ':memory:' || !configuredRoot) return { skipped: true }
    running = true
    const started = Number(new Date(clock())), measured = performance.now()
    status.lastStartedAt = new Date(started).toISOString()
    let unpublished = null
    try {
      validateRoot()
      const reason = acquire(started)
      if (reason) { status.skipped++; status.lastErrorCode = reason; return { skipped: true, reason } }
      const sourceId = createHash('sha256').update(realpathSync(dbPath)).digest('hex')
      if (maxTotalBytes || minFreeBytes) {
        try { await retain(null, sourceId); status.lastRetentionErrorCode = null }
        catch (cause) { status.retentionFailed++; status.lastRetentionErrorCode = safeCode(cause); throw cause }
      }
      const backupId = randomUUID(), stamp = new Date(started).toISOString().replace(/[-:.]/g, '')
      const target = resolve(root, 'studio-backup-' + stamp + '-' + backupId + '.sqlite')
      const estimatedBytes = maxTotalBytes || minFreeBytes ? estimate() : 0
      capacityCheck(target, estimatedBytes, true)
      unpublished = []
      if ((maxTotalBytes || minFreeBytes) && backup === backupStudioDatabase)
        await backupWorker({ operation: 'backup', source: resolve(dbPath), target,
          options: { applicationRelease, clockTime: Number(new Date(clock())), ownership: { sourceId, backupId } },
          protection: { maxTotalBytes, minFreeBytes } }, value => {
          unpublished.push({ path: value.path, info: { dev: value.dev, ino: value.ino } })
        })
      else await backup(dbPath, target, { applicationRelease, clock, ownership: { sourceId, backupId },
        checkCapacity: () => capacityCheck(target, estimatedBytes) })
      unpublished = [target, target + '.json'].map(path => ({ path, info: lstatSync(path) }))
      capacityCheck(target, estimatedBytes)
      const verified = await verify(target)
      if (verified.hashVerification !== 'verified') throw codeError('BACKUP_METADATA_INVALID')
      status.completed++
      status.lastCompletedAt = new Date(clock()).toISOString()
      status.lastErrorCode = null
      status.lastSuccess = { completedAt: status.lastCompletedAt, applicationRelease: verified.applicationRelease,
        schemaVersion: verified.schemaVersion, bytes: verified.bytes, sha256: verified.sha256 }
      unpublished = null
      try { await retain(target, sourceId); status.lastRetentionErrorCode = null }
      catch (cause) {
        status.retentionFailed++; status.lastRetentionErrorCode = 'BACKUP_RETENTION_FAILED'
        throw codeError(safeCode(cause) === 'BACKUP_FAILED' ? 'BACKUP_RETENTION_FAILED' : safeCode(cause))
      }
      await observe(eventFor('backup', true, 'BACKUP_COMPLETE', status.lastCompletedAt))
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
      if (unpublished) {
        try {
          validateRoot()
          const present = []
          for (const { path, info } of unpublished) {
            let current
            try { current = lstatSync(path) } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause }
            if (!inside(root, path) || current.isSymbolicLink() || !current.isFile() ||
                current.dev !== info.dev || current.ino !== info.ino) throw codeError('BACKUP_PATH_INVALID')
            present.push(path)
          }
          for (const path of present) unlinkSync(path)
        } catch { status.lastRetentionErrorCode = 'BACKUP_RETENTION_FAILED' }
      }
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
