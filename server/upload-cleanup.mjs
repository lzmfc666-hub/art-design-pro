/** Explicitly enabled, bounded reference-safe cleanup. The service proves references in its transaction. */
export function createUploadCleanup({
  collect,
  enabled = process.env.STUDIO_UPLOAD_GC_ENABLED === 'true',
  intervalMinutes = Number(process.env.STUDIO_UPLOAD_GC_INTERVAL_MINUTES || 60),
  retentionDays = Number(process.env.STUDIO_UPLOAD_GC_RETENTION_DAYS || 7),
  limit = 50,
  clock = Date.now
} = {}) {
  if (
    typeof enabled !== 'boolean' ||
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
    lastErrorCode: null
  }
  const run = () => {
    if (!enabled || closed) return { skipped: true }
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
