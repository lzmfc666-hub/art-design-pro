import { DatabaseSync, backup } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, writeFileSync, openSync, closeSync,
  unlinkSync, lstatSync, fstatSync, fsyncSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReleaseManifest } from './studio-release.mjs'

export const MAX_BACKUP_SCHEMA_VERSION = 2
const coded = (code, message) => Object.assign(new Error(message), { code })
const timestamp = clock => new Date(clock()).toISOString()
const release = value => {
  if (value == null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))
    throw coded('BACKUP_RELEASE_INVALID', '应用发布标识无效')
  return value.trim()
}
export async function backupFileDigest(path, { signal } = {}) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw coded('BACKUP_PATH_INVALID', '备份必须是普通文件')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return { bytes: info.size, sha256: hash.digest('hex') }
}
const readManifest = async path => {
  let info
  try { info = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
    throw coded('BACKUP_METADATA_INVALID', '备份完成清单无效')
  let source = '', bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (bytes > 65536) throw coded('BACKUP_METADATA_INVALID', '备份完成清单无效')
    source += chunk
  }
  try {
    const value = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value
  } catch { throw coded('BACKUP_METADATA_INVALID', '备份完成清单无效') }
}

/** Read-only verification. No business records, credentials, or filesystem paths are returned. */
export async function verifyStudioBackup(path, { maxSchemaVersion = MAX_BACKUP_SCHEMA_VERSION } = {}) {
  if (!Number.isSafeInteger(maxSchemaVersion) || maxSchemaVersion < 1 || maxSchemaVersion > MAX_BACKUP_SCHEMA_VERSION)
    throw coded('BACKUP_SCHEMA_UNSUPPORTED', '允许的数据版本无效')
  const source = resolve(path), digest = await backupFileDigest(source)
  const metadata = await readManifest(`${source}.json`)
  const hasHash = metadata?.sha256 != null || metadata?.bytes != null || metadata?.status != null
  if (metadata && (metadata.format !== 'studio-sqlite-backup-v1' || metadata.integrity !== 'ok'))
    throw coded('BACKUP_METADATA_INVALID', '备份完成清单无效')
  if (hasHash && (metadata.status !== 'complete' || !/^[a-f0-9]{64}$/.test(metadata.sha256 || '') ||
      !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1))
    throw coded('BACKUP_METADATA_INVALID', '备份尚未完成或校验清单无效')
  if (hasHash && (metadata.bytes !== digest.bytes || metadata.sha256 !== digest.sha256))
    throw coded('BACKUP_HASH_MISMATCH', '备份字节或校验值不匹配')
  const applicationRelease = release(metadata?.applicationRelease)
  if ((hasHash || metadata?.completedAt != null) &&
      (typeof metadata.completedAt !== 'string' || !Number.isFinite(Date.parse(metadata.completedAt))))
    throw coded('BACKUP_METADATA_INVALID', '备份完成时间无效')
  const rejectActiveSnapshot = () => {
    if (hasHash && existsSync(source + '-wal') && lstatSync(source + '-wal').size > 0)
      throw coded('BACKUP_SNAPSHOT_ACTIVE', '已完成备份有额外WAL变动，请重新生成离线备份')
  }
  rejectActiveSnapshot()
  let database, schemaVersion
  try {
    database = new DatabaseSync(source, { readOnly: true })
    if (database.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok'))
      throw new Error('integrity')
    const state = database.prepare("SELECT json_extract(json,'$.schemaVersion') AS value FROM studio_state WHERE id=1").get()
    if (!state) throw new Error('missing state')
    schemaVersion = state.value ?? 1
  } catch { throw coded('BACKUP_CORRUPT', '备份数据库完整性或格式检查未通过') }
  finally { database?.close() }
  rejectActiveSnapshot()
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > maxSchemaVersion)
    throw coded('BACKUP_SCHEMA_UNSUPPORTED', '备份数据版本与当前应用不兼容')
  if (metadata && metadata.schemaVersion !== schemaVersion)
    throw coded('BACKUP_SCHEMA_MISMATCH', '备份清单与数据库版本不一致')
  return { integrity: 'ok', schemaVersion, ...digest,
    hashVerification: hasHash ? 'verified' : 'unknown',
    applicationRelease, completedAt: metadata?.completedAt ?? null }
}

/** A consistent SQLite copy includes state, audit, uploads, funds and notifications. */
export async function backupStudioDatabase(sourcePath, targetPath, options = {}) {
  const source = resolve(sourcePath), target = resolve(targetPath)
  if (source === target || !existsSync(source)) throw new Error('备份源必须存在，且不能与目标相同')
  if (existsSync(target) || existsSync(`${target}.json`)) throw new Error('目标备份已存在，请使用新的文件名')
  const applicationRelease = release(options.applicationRelease), clock = options.clock || Date.now
  const startedAt = timestamp(clock), ownership = options.ownership
  if (ownership && (!/^[a-f0-9]{64}$/.test(ownership.sourceId || '') || !/^[a-f0-9-]{36}$/.test(ownership.backupId || '')))
    throw coded('BACKUP_METADATA_INVALID', '备份归属标识无效')
  mkdirSync(dirname(target), { recursive: true })
  const owned = []
  const reserve = path => {
    const handle = openSync(path, 'wx', 0o600), info = fstatSync(handle)
    owned.push({ path, dev: info.dev, ino: info.ino })
    return handle
  }
  let sourceDb, manifestHandle
  try {
    closeSync(reserve(target))
    manifestHandle = reserve(`${target}.json`)
    sourceDb = new DatabaseSync(source, { readOnly: true })
    await backup(sourceDb, target)
    const copied = new DatabaseSync(target, { readOnly: true })
    let schemaVersion
    try {
      if (copied.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok'))
        throw coded('BACKUP_CORRUPT', '备份完整性检查未通过')
      const state = copied.prepare("SELECT json_extract(json,'$.schemaVersion') AS value FROM studio_state WHERE id=1").get()
      if (!state) throw coded('BACKUP_CORRUPT', '备份业务状态缺失')
      schemaVersion = state.value ?? 1
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
        throw coded('BACKUP_SCHEMA_UNSUPPORTED', '备份数据版本无效')
    } finally { copied.close() }
    const digest = await backupFileDigest(target), completedAt = timestamp(clock)
    if (options.expectedSourceDigest) {
      const current = await backupFileDigest(source)
      if (current.sha256 !== options.expectedSourceDigest.sha256 || current.bytes !== options.expectedSourceDigest.bytes ||
          schemaVersion !== options.expectedSourceDigest.schemaVersion ||
          (options.expectedSourceDigest.hashVerification === 'verified' && existsSync(source + '-wal') && lstatSync(source + '-wal').size > 0))
        throw coded('BACKUP_SOURCE_CHANGED', '恢复期间源备份已变化，未生成完成副本')
    }
    const metadata = { format: 'studio-sqlite-backup-v1', generatedAt: completedAt, startedAt, completedAt,
      status: 'complete', schemaVersion, applicationRelease,
      // Compatibility only, not an application release identifier.
      playerVersion: '1.0', integrity: 'ok', containsPrivateBusinessData: true, ...digest,
      ...(ownership ? { ownership: { managedBy: 'studio-backup-scheduler-v1', ...ownership } } : {}) }
    writeFileSync(manifestHandle, JSON.stringify(metadata, null, 2))
    fsyncSync(manifestHandle); closeSync(manifestHandle); manifestHandle = undefined
    return { path: target, metadata }
  } catch (error) {
    if (manifestHandle !== undefined) closeSync(manifestHandle)
    for (const item of owned.reverse()) {
      try {
        const info = lstatSync(item.path)
        if (info.isFile() && !info.isSymbolicLink() && info.dev === item.dev && info.ino === item.ino) unlinkSync(item.path)
      } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.cleanupFailed = true }
    }
    throw error
  } finally { sourceDb?.close() }
}

/** Restore only into a new offline path, after checksum/schema verification. */
export async function restoreStudioDatabase(backupPath, targetPath, options = {}) {
  if (existsSync(resolve(targetPath)) || existsSync(`${resolve(targetPath)}.json`))
    throw new Error('目标备份已存在，请使用新的文件名')
  const verification = await verifyStudioBackup(backupPath, options)
  const result = await backupStudioDatabase(backupPath, targetPath, {
    ...options, applicationRelease: options.applicationRelease ?? verification.applicationRelease,
    expectedSourceDigest: verification })
  return { ...result, restoredFromBackup: true, sourceVerification: verification }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const restore = args[0] === '--restore'
  const [source = '.data/studio.sqlite', target] = restore ? args.slice(1) : args
  if (!target)
    throw new Error(
      '用法：node scripts/studio-backup.mjs [--restore] 源数据库/备份 新的备份/离线恢复文件路径'
    )
  const result = await (restore ? restoreStudioDatabase : backupStudioDatabase)(source, target,
    { applicationRelease: readReleaseManifest()?.id ?? null })
  console.log(`${restore ? '离线恢复副本' : '备份'}已完成并通过完整性检查：${result.path}`)
}
