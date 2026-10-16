/** Explicitly enabled, bounded reference-safe cleanup. The service proves references in its transaction. */
export function createUploadCleanup({
  collect,
  archive,
  removeCompleted,
  completedRetentionDays = 30,
  enabled = process.env.STUDIO_UPLOAD_GC_ENABLED === 'true',
  intervalMinutes = Number(process.env.STUDIO_UPLOAD_GC_INTERVAL_MINUTES || 60),
  retentionDays = Number(process.env.STUDIO_UPLOAD_GC_RETENTION_DAYS || 7),
  limit = 50,
  clock = Date.now
} = {}) {
  if (
    typeof enabled !== 'boolean' ||
    (archive !== undefined && typeof archive !== 'function') ||
    (removeCompleted !== undefined && typeof removeCompleted !== 'function') ||
    (archive && removeCompleted) ||
    !Number.isSafeInteger(completedRetentionDays) || completedRetentionDays < 30 || completedRetentionDays > 3650 ||
    !Number.isFinite(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 35791 ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 7 ||
    retentionDays > 3650 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error('废弃上传回收配置无效：至少保留7天，每批不超过50条')
  let timer,
    closed = false
  const status = {
    enabled,
    intervalMinutes,
    retentionDays,
    batchLimit: limit,
    lastRunAt: null,
    lastResult: null,
    failed: 0,
    lastErrorCode: null,
    archivingEnabled: Boolean(archive) && enabled,
    completedRetentionDays,
    archiveBatchLimit: 5,
    archiveRunning: false,
    lastArchiveResult: null,
    archiveFailed: 0,
    lastArchiveErrorCode: null,
    completedDeletionEnabled: Boolean(removeCompleted) && enabled,
    deletionRunning: false,
    deletionBatchLimit: 50,
    lastDeletionResult: null,
    deletionFailed: 0,
    lastDeletionErrorCode: null
  }
  const run = () => {
    if (!enabled || closed || status.archiveRunning || status.deletionRunning) return { skipped: true }
    const timestamp = new Date(clock())
    status.lastRunAt = timestamp.toISOString()
    try {
      const result = collect({
        before: new Date(timestamp.getTime() - retentionDays * 86400000).toISOString(),
        limit
      })
      status.lastResult = Object.fromEntries(
        ['scanned', 'deleted', 'bytes', 'protected'].map((field) => [
          field,
          Number(result[field]) || 0
        ])
      )
      status.lastErrorCode = null
      if (removeCompleted) {
        status.deletionRunning = true
        return Promise.resolve().then(() => removeCompleted({ retentionDays: completedRetentionDays, limit: 50 }))
          .then(result => {
            status.lastDeletionResult = Object.fromEntries(
              ['scanned', 'deleted', 'bytes', 'protected', 'filesDeleted', 'pendingFiles', 'reusableBytes']
                .map(field => [field, Number(result[field]) || 0]))
            status.lastDeletionErrorCode = result.pendingFiles ? 'IMAGE_DELETE_FILE_PENDING' : null
            return { ok: !result.pendingFiles, ...status.lastResult, deletion: { ...status.lastDeletionResult } }
          }).catch(() => {
            status.deletionFailed++
            status.lastDeletionErrorCode = 'IMAGE_DELETE_FAILED'
            return { ok: false, ...status.lastResult, code: status.lastDeletionErrorCode }
          }).finally(() => { status.deletionRunning = false })
      }
      if (archive) {
        status.archiveRunning = true
        return Promise.resolve().then(() => archive({ retentionDays: completedRetentionDays, limit: 5 }))
          .then(result => {
            status.lastArchiveResult = Object.fromEntries(
              ['scanned', 'archived', 'bytes', 'protected', 'heldOrderCount'].map(field => [field, Number(result[field]) || 0]))
            status.lastArchiveErrorCode = null
            return { ok: true, ...status.lastResult, archive: { ...status.lastArchiveResult } }
          }).catch(() => {
            status.archiveFailed++
            status.lastArchiveErrorCode = 'IMAGE_ARCHIVE_FAILED'
            return { ok: false, ...status.lastResult, code: status.lastArchiveErrorCode }
          }).finally(() => { status.archiveRunning = false })
      }
      return { ok: true, ...status.lastResult }
    } catch {
      status.failed++
      status.lastErrorCode = 'UPLOAD_CLEANUP_FAILED'
      return { ok: false, code: status.lastErrorCode }
    }
  }
  return {
    start() {
      if (enabled && !timer && !closed) {
        timer = setInterval(run, intervalMinutes * 60000)
        timer.unref()
      }
    },
    run,
    metrics: () => ({ ...status }),
    close() {
      closed = true
      if (timer) clearInterval(timer)
    }
  }
}
