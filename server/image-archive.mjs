import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, unlink, statfs } from 'node:fs/promises'
import { closeSync, fstatSync, lstatSync, openSync, readSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { privateOpsDirectory } from './ops-config.mjs'

const maximumBytes = 8 * 1024 * 1024
const error = code => Object.assign(new Error(code), { code })
const hash = data => createHash('sha256').update(data).digest('hex')
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const existsTable = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
const hasReference = (value, id) => {
  if (typeof value === 'string') return value.includes(id)
  if (value && typeof value === 'object') return Object.values(value).some(child => hasReference(child, id))
  return false
}

// Only order submission screenshots are eligible. Unknown uses remain protected.
export function referenceOutsideMaterials(value, id, submission = false) {
  if (typeof value === 'string') return value.includes(id)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => {
    if (submission && key === 'screenshots') return false
    if (key === 'submissions' && Array.isArray(child))
      return child.some(row => referenceOutsideMaterials(row, id, true))
    return referenceOutsideMaterials(child, id)
  })
}

export function completedMaterialEligibility(state, id, cutoff, holds = new Set(), deletion = false) {
  let referenced = false, completedAt = 0
  for (const order of state.orders || []) {
    if (referenceOutsideMaterials(order, id)) return null
    if (!(order.submissions || []).some(row => (row.screenshots || []).some(image => image.id === id))) continue
    referenced = true
    const latest = order.submissions.at(-1)
    const completed = Date.parse(order.completedAt), reviewed = Date.parse(latest?.reviewedAt)
    if (order.status !== 'completed' || latest?.review !== 'passed' ||
        order.storage?.active === true || order.problem?.status === 'open' ||
        !Number.isFinite(completed) || !Number.isFinite(reviewed) ||
        (deletion ? completed > cutoff : Math.max(completed, reviewed) >= cutoff) ||
        holds.has(order.id) || order.receivedAmount !== order.amount ||
        (order.returnRequests || []).some(row => row.status === 'pending') ||
        (order.compensationPending && !order.compensationSettled) ||
        state.statusCorrectionReversals?.[order.id]?.active ||
        (state.refunds || []).some(row => row.orderId === order.id &&
          (row.status === 'pending' || (row.manualRewardReview && !row.manualResolution))) ||
        (state.rewardReviews || []).some(row => row.orderId === order.id && !row.resolvedAt) ||
        (state.playerAdjustments || []).some(row => row.orderId === order.id && row.status === 'manual')) return null
    completedAt = deletion ? Math.max(completedAt, completed) : Math.max(completedAt, completed, reviewed)
  }
  for (const [key, value] of Object.entries(state))
    if (!['orders', 'logs', 'passwords'].includes(key) && hasReference(value, id)) return null
  return referenced ? new Date(completedAt).toISOString() : null
}

function checkedRoot(directory) {
  const root = privateOpsDirectory(resolve(directory))
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(root, realpathSync(root)))
    throw error('IMAGE_ARCHIVE_PATH_INVALID')
  return root
}

function checkExistingParent(directory) {
  let candidate = resolve(directory)
  for (;;) {
    try { checkedRoot(candidate); return }
    catch (cause) {
      if (cause.code !== 'ENOENT' || dirname(candidate) === candidate) throw cause
      candidate = dirname(candidate)
    }
  }
}

export function readArchivedImage(record) {
  if (!record || !/^[a-f0-9-]{36}\.image$/.test(record.file_name || '') ||
      !/^[a-f0-9]{64}$/.test(record.sha256 || '') || !Number.isSafeInteger(record.size) ||
      record.size < 1 || record.size > maximumBytes) throw error('IMAGE_ARCHIVE_METADATA_INVALID')
  const root = checkedRoot(record.archive_root), path = join(root, record.file_name)
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== record.size) throw error('IMAGE_ARCHIVE_FILE_INVALID')
  const handle = openSync(path, 'r')
  try {
    const current = fstatSync(handle)
    if (current.dev !== info.dev || current.ino !== info.ino || current.size !== record.size)
      throw error('IMAGE_ARCHIVE_FILE_INVALID')
    const data = Buffer.alloc(record.size)
    let offset = 0
    while (offset < data.length) {
      const count = readSync(handle, data, offset, data.length - offset, offset)
      if (!count) throw error('IMAGE_ARCHIVE_FILE_INVALID')
      offset += count
    }
    if (fstatSync(handle).size !== record.size || hash(data) !== record.sha256)
      throw error('IMAGE_ARCHIVE_HASH_MISMATCH')
    return data
  } finally { closeSync(handle) }
}

export function archivedImageRecord(db, id) {
  return existsTable(db, 'image_archives') ? db.prepare('SELECT * FROM image_archives WHERE upload_id=?').get(id) : undefined
}

export function deletedImageRecord(db, id) {
  return existsTable(db, 'image_deletions') ? db.prepare('SELECT * FROM image_deletions WHERE upload_id=?').get(id) : undefined
}

function readHolds(path) {
  if (!path) return new Set()
  let info
  try { info = lstatSync(path) } catch (cause) { if (cause.code === 'ENOENT') return new Set(); throw cause }
  checkedRoot(dirname(path))
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw error('IMAGE_ARCHIVE_HOLDS_INVALID')
  let data
  try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { throw error('IMAGE_ARCHIVE_HOLDS_INVALID') }
  if (data?.format !== 'studio-image-retention-holds-v1' || !Array.isArray(data.orderIds) ||
      data.orderIds.length > 1000 || data.orderIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))
    throw error('IMAGE_ARCHIVE_HOLDS_INVALID')
  return new Set(data.orderIds)
}

export function createImageArchive({ db, dbPath, directory, holdsFile, clock = Date.now, diskProbe = statfs }) {
  const root = dbPath === ':memory:' && !directory ? null : privateOpsDirectory(directory || join(dirname(resolve(dbPath)), 'image-archive'))
  const holdsPath = holdsFile ? privateOpsDirectory(holdsFile) :
    (dbPath === ':memory:' ? null : join(dirname(resolve(dbPath)), 'image-retention-holds.json'))
  let running = false
  const state = () => JSON.parse(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  // Same-connection changes and other-connection commits both invalidate the reference proof.
  const changeToken = () => db.prepare('SELECT total_changes() AS value').get().value + ':' +
    db.prepare('PRAGMA data_version').get().data_version
  const historyAllows = id => {
    if (db.prepare('SELECT 1 FROM player_private_uploads WHERE attachment_id=?').get(id)) return false
    for (const table of ['audit_logs', 'audit_logs_archive'])
      for (const row of db.prepare(`SELECT payload FROM ${table} WHERE entity<>'upload' AND instr(payload,?)>0`).iterate(id))
        if (referenceOutsideMaterials(JSON.parse(row.payload), id)) return false
    for (const table of ['business_requests', 'financial_requests'])
      for (const row of db.prepare(`SELECT result_json FROM ${table} WHERE instr(result_json,?)>0`).iterate(id))
        if (referenceOutsideMaterials(JSON.parse(row.result_json), id)) return false
    return !db.prepare('SELECT 1 FROM fund_transactions WHERE instr(receipt_json,?)>0 LIMIT 1').get(id)
  }
  return {
    // Reuse the same reference proof; permanently remove only completed player materials.
    // Tombstones keep historical metadata and prevent old IDs becoming new evidence.
    async remove({ retentionDays = 30, limit = 50 } = {}) {
      if (running) return { skipped: true }
      if (!Number.isSafeInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw error('IMAGE_DELETE_CONFIG_INVALID')
      running = true
      try {
        const cutoff = Number(new Date(clock())) - retentionDays * 86400000
        readHolds(holdsPath)
        db.exec('CREATE TABLE IF NOT EXISTS image_deletions(upload_id TEXT PRIMARY KEY REFERENCES uploads(id),deleted_at TEXT NOT NULL,completed_at TEXT NOT NULL,size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS image_delete_cursor(id INTEGER PRIMARY KEY CHECK(id=1),upload_id TEXT NOT NULL)')
        let filesDeleted = 0
        const deleteFiles = () => {
          if (!existsTable(db, 'image_archives')) return
          for (const record of db.prepare('SELECT a.* FROM image_archives a JOIN image_deletions d ON d.upload_id=a.upload_id ORDER BY a.upload_id LIMIT 50').all()) {
            try {
              // Never delete a directory, linked path, unknown file, or mismatched original.
              try { readArchivedImage(record) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
              const checked = checkedRoot(record.archive_root)
              try { unlinkSync(join(checked, record.file_name)) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
              db.prepare('DELETE FROM image_archives WHERE upload_id=?').run(record.upload_id)
              filesDeleted++
            } catch { /* Keep the committed mapping for a bounded retry next cycle. */ }
          }
        }
        deleteFiles()
        const cursor = db.prepare('SELECT upload_id FROM image_delete_cursor WHERE id=1').get()?.upload_id || ''
        const snapshot = state()
        // Active/recent orders and unrelated images must not slow the expiry cursor.
        const materialIds = [...new Set(snapshot.orders.filter(order => order.status === 'completed' &&
          Number.isFinite(Date.parse(order.completedAt)) && Date.parse(order.completedAt) <= cutoff)
          .flatMap(order => (order.submissions || []).flatMap(submission => (submission.screenshots || []).map(image => image.id))))]
        const candidates = db.prepare('SELECT id,owner_id,size FROM uploads WHERE id>? AND id IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM image_deletions d WHERE d.upload_id=uploads.id) ORDER BY id LIMIT ?').all(cursor, JSON.stringify(materialIds), limit)
        let deleted = 0, bytes = 0
        for (const row of candidates) {
          const holds = readHolds(holdsPath)
          if (!snapshot.users.some(user => user.id === row.owner_id && user.role === 'player') ||
              !completedMaterialEligibility(snapshot, row.id, cutoff, holds, true)) continue
          const proof = changeToken()
          if (!historyAllows(row.id)) continue
          db.exec('BEGIN IMMEDIATE')
          try {
            const current = state(), completedAt = completedMaterialEligibility(current, row.id, cutoff, readHolds(holdsPath), true)
            if (completedAt && changeToken() === proof &&
                current.users.some(user => user.id === row.owner_id && user.role === 'player')) {
              db.prepare('INSERT INTO image_deletions VALUES(?,?,?,?)').run(row.id, new Date(clock()).toISOString(), completedAt, row.size)
              db.prepare("UPDATE uploads SET data=x'' WHERE id=?").run(row.id)
              deleted++; bytes += row.size
            }
            db.exec('COMMIT')
          } catch (cause) { db.exec('ROLLBACK'); throw cause }
        }
        db.prepare('INSERT INTO image_delete_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET upload_id=excluded.upload_id').run(candidates.at(-1)?.id || '')
        deleteFiles()
        const storage = {
          pageSize: db.prepare('PRAGMA page_size').get().page_size,
          freePages: db.prepare('PRAGMA freelist_count').get().freelist_count
        }
        const pendingFiles = existsTable(db, 'image_archives') ? db.prepare('SELECT count(*) AS count FROM image_archives a JOIN image_deletions d ON d.upload_id=a.upload_id').get().count : 0
        return { scanned: candidates.length, deleted, bytes, protected: candidates.length - deleted,
          filesDeleted, pendingFiles, reusableBytes: storage.pageSize * storage.freePages }
      } finally { running = false }
    },
    async run({ retentionDays = 30, limit = 5 } = {}) {
      if (running) return { skipped: true }
      if (!root || !Number.isSafeInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw error('IMAGE_ARCHIVE_CONFIG_INVALID')
      running = true
      try {
        const cutoff = Number(new Date(clock())) - retentionDays * 86400000
        const holds = readHolds(holdsPath)
        db.exec('CREATE TABLE IF NOT EXISTS image_archives(upload_id TEXT PRIMARY KEY REFERENCES uploads(id),archive_root TEXT NOT NULL,file_name TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,size INTEGER NOT NULL,archived_at TEXT NOT NULL,completed_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS image_archive_cursor(id INTEGER PRIMARY KEY CHECK(id=1),upload_id TEXT NOT NULL)')
        const cursor = db.prepare('SELECT upload_id FROM image_archive_cursor WHERE id=1').get()?.upload_id || ''
        const candidates = db.prepare('SELECT id,size FROM uploads WHERE id>? AND created_at<? AND length(data)=size ORDER BY id LIMIT 50')
          .all(cursor, new Date(cutoff).toISOString())
        const snapshot = state()
        let scanned = 0, archived = 0, bytes = 0, last = ''
        for (const row of candidates) {
          scanned++; last = row.id
          if (deletedImageRecord(db, row.id) || !completedMaterialEligibility(snapshot, row.id, cutoff, holds)) continue
          const proof = changeToken()
          if (!completedMaterialEligibility(state(), row.id, cutoff, holds) || !historyAllows(row.id)) continue
          const source = db.prepare('SELECT data FROM uploads WHERE id=?').get(row.id)
          if (!source || source.data.length !== row.size || row.size < 1 || row.size > maximumBytes) continue
          const data = Buffer.from(source.data)
          checkExistingParent(root)
          await mkdir(root, { recursive: true, mode: 0o700 })
          checkedRoot(root)
          const disk = await diskProbe(root)
          const freeBytes = Number(disk.bavail) * Number(disk.bsize)
          if (!Number.isFinite(freeBytes) || freeBytes < data.length + 64 * 1024 * 1024)
            throw error('IMAGE_ARCHIVE_DISK_LOW')
          const record = { upload_id: row.id, archive_root: root, file_name: randomUUID() + '.image',
            sha256: hash(data), size: row.size }
          const path = join(root, record.file_name)
          let handle, identity, committed = false
          try {
            handle = await open(path, 'wx', 0o600); identity = await handle.stat()
            await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null
            if (process.platform !== 'win32') {
              const directoryHandle = await open(root, 'r')
              try { await directoryHandle.sync() } finally { await directoryHandle.close() }
            }
            readArchivedImage(record)
            db.exec('BEGIN IMMEDIATE')
            try {
              const completedAt = completedMaterialEligibility(state(), row.id, cutoff, readHolds(holdsPath))
              const current = db.prepare('SELECT data FROM uploads WHERE id=?').get(row.id)
              if (completedAt && changeToken() === proof && current && Buffer.from(current.data).equals(data) && !archivedImageRecord(db, row.id)) {
                db.prepare('INSERT INTO image_archives VALUES(?,?,?,?,?,?,?)').run(row.id, root, record.file_name,
                  record.sha256, row.size, new Date(clock()).toISOString(), completedAt)
                db.prepare("UPDATE uploads SET data=x'' WHERE id=?").run(row.id)
                committed = true
              }
              db.exec('COMMIT')
            } catch (cause) { committed = false; db.exec('ROLLBACK'); throw cause }
          } finally {
            if (handle) await handle.close()
            if (!committed && identity) {
              const current = lstatSync(path)
              if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(path)
            }
          }
          if (committed) { archived++; bytes += row.size }
          if (archived === limit) break
        }
        db.prepare('INSERT INTO image_archive_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET upload_id=excluded.upload_id')
          .run(last || '')
        return { scanned, archived, bytes, protected: scanned - archived, heldOrderCount: holds.size }
      } finally { running = false }
    }
  }
}

// Only the new backup copy is modified. Its original image bytes become self-contained again.
export function materializeArchivedImages(db) {
  if (!existsTable(db, 'image_archives')) return { count: 0, bytes: 0 }
  let count = 0, bytes = 0
  for (;;) {
    const records = db.prepare('SELECT * FROM image_archives ORDER BY upload_id LIMIT 100').all()
    if (!records.length) break
    for (const record of records) {
      if (deletedImageRecord(db, record.upload_id)) {
        db.prepare('DELETE FROM image_archives WHERE upload_id=?').run(record.upload_id)
        continue
      }
      const row = db.prepare('SELECT size,length(data) AS inline_size FROM uploads WHERE id=?').get(record.upload_id)
      if (!row || row.size !== record.size || row.inline_size !== 0) throw error('IMAGE_ARCHIVE_METADATA_INVALID')
      const data = readArchivedImage(record)
      db.prepare('UPDATE uploads SET data=? WHERE id=?').run(data, record.upload_id)
      db.prepare('DELETE FROM image_archives WHERE upload_id=?').run(record.upload_id)
      count++; bytes += data.length
    }
  }
  return { count, bytes }
}
