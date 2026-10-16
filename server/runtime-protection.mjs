import { isIP } from 'node:net'
import { existsSync, statSync, statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const MiB = 1024 * 1024
const normalizedAddress = (input) => {
  const value = String(input || '')
    .trim()
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
  return isIP(value) ? value : null
}
const ipValue = (address) => {
  if (isIP(address) === 4)
    return {
      bits: 32,
      value: address.split('.').reduce((result, part) => (result << 8n) + BigInt(part), 0n)
    }
  if (isIP(address) !== 6) return null
  let text = address.toLowerCase()
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const ipv4 = ipValue(dotted[1]).value
    text =
      text.slice(0, -dotted[1].length) +
      (ipv4 >> 16n).toString(16) +
      ':' +
      (ipv4 & 65535n).toString(16)
  }
  const halves = text.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const parts =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left
  return {
    bits: 128,
    value: parts.reduce((result, part) => (result << 16n) + BigInt('0x' + part), 0n)
  }
}

/** Only explicitly configured addresses/subnets may assert forwarding headers. */
export function createTrustedProxyResolver(trustedProxies = []) {
  const inputs = Array.isArray(trustedProxies) ? trustedProxies : String(trustedProxies).split(',')
  const ranges = inputs
    .map((input) => String(input).trim())
    .filter(Boolean)
    .map((input) => {
      const [raw, prefix] = input.split('/')
      const address = normalizedAddress(raw),
        parsed = address && ipValue(address)
      const length = prefix == null ? parsed?.bits : Number(prefix)
      if (
        !parsed ||
        !Number.isInteger(length) ||
        length < 0 ||
        length > parsed.bits ||
        input.split('/').length > 2
      )
        throw new Error('STUDIO_TRUSTED_PROXIES 必须为明确的 IP 或 CIDR')
      const shift = BigInt(parsed.bits - length)
      return { bits: parsed.bits, shift, network: parsed.value >> shift }
    })
  const trusted = (address) => {
    const parsed = ipValue(address)
    return (
      parsed &&
      ranges.some(
        (range) => range.bits === parsed.bits && parsed.value >> range.shift === range.network
      )
    )
  }
  return (request) => {
    const remote = normalizedAddress(request.socket?.remoteAddress) || 'unknown'
    if (!trusted(remote)) return remote
    const header = request.headers?.['x-forwarded-for']
    if (typeof header !== 'string' || header.length > 2048) return remote
    const forwarded = header.split(',').map(normalizedAddress)
    if (forwarded.length > 16 || forwarded.some((address) => !address)) return remote
    let current = remote
    for (let index = forwarded.length - 1; index >= 0 && trusted(current); index--)
      current = forwarded[index]
    return current
  }
}

/** A proxy replaces all caller-provided forwarding assertions with its own verified source. */
export function sanitizedProxyHeaders(
  request,
  { resolveAddress = createTrustedProxyResolver() } = {}
) {
  const headers = { ...request.headers }
  for (const name of Object.keys(headers))
    if (name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))
      delete headers[name]
  headers['x-forwarded-for'] = resolveAddress(request)
  return headers
}

const protectionError = (message, status, code, details) =>
  Object.assign(new Error(message), { status, code, details, runtimeProtection: true })

export function createRuntimeProtection({
  clock = Date.now,
  dbPath = ':memory:',
  maxBuckets = 20000,
  uploadRate = Number(process.env.STUDIO_UPLOAD_RATE_PER_MINUTE || 30),
  claimRate = Number(process.env.STUDIO_CLAIM_RATE_PER_MINUTE || 30),
  uploadConcurrency = Number(process.env.STUDIO_UPLOAD_CONCURRENCY || 8),
  uploadPerUser = Number(process.env.STUDIO_UPLOAD_PER_USER || 2),
  exportConcurrency = Number(process.env.STUDIO_EXPORT_CONCURRENCY || 1),
  exportQueueLimit = 4,
  exportWaitMs = 30000,
  diskWarningBytes = Number(process.env.STUDIO_DISK_WARNING_MIB || 256) * MiB,
  diskMinimumBytes = Number(process.env.STUDIO_DISK_MINIMUM_MIB || 64) * MiB,
  walWarningBytes = Number(process.env.STUDIO_WAL_WARNING_MIB || 256) * MiB,
  diskProbe = statfsSync
} = {}) {
  for (const value of [
    maxBuckets,
    uploadRate,
    claimRate,
    uploadConcurrency,
    uploadPerUser,
    exportConcurrency,
    exportQueueLimit,
    exportWaitMs
  ])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('运行限流/并发配置必须为正整数')
  for (const value of [diskWarningBytes, diskMinimumBytes, walWarningBytes])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('磁盘容量阈值必须为正整数')
  if (diskWarningBytes < diskMinimumBytes) throw new Error('磁盘告警阈值不能小于上传停止阈值')
  const buckets = new Map(),
    activeUploads = new Map(),
    exportQueue = [],
    samples = []
  const statusCounts = { unauthorized401: 0, forbidden403: 0, conflict409: 0, limited429: 0, otherClient: 0 }
  let uploads = 0,
    exports = 0,
    requests = 0,
    errors = 0,
    clientErrors = 0,
    aborted = 0,
    inflight = 0
  let latencySum = 0,
    maxLatency = 0,
    maxExportWaitMs = 0,
    closed = false,
    lastSweep = 0
  const databasePath = dbPath === ':memory:' ? null : resolve(dbPath)
  const rateCheck = (name, subject, maximum) => {
    const now = Number(new Date(clock()))
    if (now - lastSweep >= 60000 || buckets.size >= maxBuckets) {
      for (const [key, entry] of buckets) if (entry.until <= now) buckets.delete(key)
      lastSweep = now
    }
    const key = `${name}:${subject}`
    let entry = buckets.get(key)
    if (!entry || entry.until <= now) {
      if (buckets.size >= maxBuckets)
        throw protectionError('请求限流容量暂满，请稍后重试', 429, 'RATE_LIMIT_CAPACITY')
      entry = { count: 0, until: now + 60000 }
      buckets.set(key, entry)
    }
    if (entry.count >= maximum)
      throw protectionError('操作过于频繁，请稍后重试', 429, 'RATE_LIMITED', {
        retryAfter: Math.max(1, Math.ceil((entry.until - now) / 1000))
      })
    entry.count++
  }
  const storage = () => {
    if (!databasePath) return { persistent: false, warnings: [] }
    const bytes = (path) => {
      try {
        return existsSync(path) ? statSync(path).size : 0
      } catch {
        return null
      }
    }
    let freeBytes = null
    try {
      const result = diskProbe(dirname(databasePath))
      freeBytes = Number(result.bavail) * Number(result.bsize)
    } catch {
      // Report an unavailable disk probe as null, never as zero free capacity.
    }
    const databaseBytes = bytes(databasePath),
      walBytes = bytes(databasePath + '-wal')
    const warnings = []
    if (freeBytes == null) warnings.push('DISK_PROBE_UNAVAILABLE')
    if (freeBytes != null && freeBytes < diskWarningBytes) warnings.push('DISK_FREE_LOW')
    if (walBytes != null && walBytes >= walWarningBytes) warnings.push('WAL_LARGE')
    return {
      persistent: true,
      databaseBytes,
      walBytes,
      freeBytes,
      diskMinimumBytes,
      diskWarningBytes,
      walWarningBytes,
      warnings
    }
  }
  const nextExport = () => {
    while (!closed && exports < exportConcurrency && exportQueue.length) {
      const job = exportQueue.shift()
      clearTimeout(job.timer)
      exports++
      maxExportWaitMs = Math.max(maxExportWaitMs, performance.now() - job.started)
      job.resolve(exportRelease())
    }
  }
  const exportRelease = () => {
    let released = false
    return () => {
      if (!released) {
        released = true
        exports--
        nextExport()
      }
    }
  }
  return {
    begin(req, res) {
      const start = performance.now()
      inflight++
      let finished = false
      const end = () => {
        if (finished) return
        finished = true
        inflight--
        requests++
        const elapsed = performance.now() - start
        latencySum += elapsed
        maxLatency = Math.max(maxLatency, elapsed)
        samples.push(elapsed)
        if (samples.length > 2048) samples.shift()
        if (!res.writableFinished) aborted++
        else if (res.statusCode >= 500) errors++
        else if (res.statusCode >= 400) {
          clientErrors++
          const key = { 401: 'unauthorized401', 403: 'forbidden403', 409: 'conflict409', 429: 'limited429' }[res.statusCode]
          statusCounts[key || 'otherClient']++
        }
      }
      res.once('finish', end)
      res.once('close', end)
    },
    claim(actor, address) {
      rateCheck('claim-user', actor, claimRate)
      rateCheck('claim-address', address, claimRate * 5)
    },
    acquireUpload(actor, address) {
      rateCheck('upload-user', actor, uploadRate)
      rateCheck('upload-address', address, uploadRate * 5)
      const disk = storage()
      if (disk.freeBytes != null && disk.freeBytes < diskMinimumBytes)
        throw protectionError(
          '磁盘可用空间不足，已暂缓图片上传，请联系管理员',
          507,
          'UPLOAD_DISK_PRESSURE'
        )
      if (uploads >= uploadConcurrency || (activeUploads.get(actor) || 0) >= uploadPerUser)
        throw protectionError('图片上传处理中，请稍后重试', 429, 'UPLOAD_CONCURRENCY', {
          retryAfter: 2
        })
      uploads++
      activeUploads.set(actor, (activeUploads.get(actor) || 0) + 1)
      let released = false
      return () => {
        if (!released) {
          released = true
          uploads--
          const count = activeUploads.get(actor) - 1
          if (count) activeUploads.set(actor, count)
          else activeUploads.delete(actor)
        }
      }
    },
    acquireExport() {
      if (closed)
        return Promise.reject(protectionError('服务器正在停止，请稍后重试', 503, 'SERVER_STOPPING'))
      if (exports < exportConcurrency) {
        exports++
        return Promise.resolve(exportRelease())
      }
      if (exportQueue.length >= exportQueueLimit)
        return Promise.reject(
          protectionError('报表导出队列已满，请稍后重试', 429, 'EXPORT_BUSY', { retryAfter: 5 })
        )
      return new Promise((resolveJob, reject) => {
        const job = { resolve: resolveJob, reject, started: performance.now() }
        job.timer = setTimeout(() => {
          const index = exportQueue.indexOf(job)
          if (index >= 0) exportQueue.splice(index, 1)
          reject(protectionError('报表导出等待超时，请稍后重试', 503, 'EXPORT_WAIT_TIMEOUT'))
        }, exportWaitMs)
        exportQueue.push(job)
      })
    },
    storage,
    metrics(db) {
      const ordered = [...samples].sort((a, b) => a - b)
      const logs = db.prepare('SELECT table_name,bytes,rows FROM audit_storage_totals').all()
      const queue = db
        .prepare(
          'SELECT status,COUNT(*) AS count,MIN(next_at) AS oldestDueAt FROM player_push_outbox GROUP BY status'
        )
        .all()
      const due = db
        .prepare(
          "SELECT COUNT(*) AS count,MIN(next_at) AS oldestDueAt FROM player_push_outbox WHERE status='pending' AND next_at<=?"
        )
        .get(new Date(clock()).toISOString())
      return {
        generatedAt: new Date(clock()).toISOString(),
        source: 'actual-runtime',
        process: {
          uptimeSeconds: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage()
        },
        http: {
          requests,
          errors,
          clientErrors,
          classifications: { ...statusCounts },
          aborted,
          inflight,
          serverErrorRate: requests ? errors / requests : 0,
          averageMs: requests ? latencySum / requests : 0,
          maxMs: maxLatency,
          p95Ms: ordered.length
            ? ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]
            : 0,
          sampleCount: ordered.length,
          sampleLimit: 2048
        },
        controls: {
          activeUploads: uploads,
          uploadConcurrency,
          activeExports: exports,
          exportConcurrency,
          exportQueued: exportQueue.length,
          exportQueueLimit,
          maxExportWaitMs
        },
        storage: storage(),
        logs,
        push: {
          queue,
          due: Number(due.count),
          oldestDueAt: due.oldestDueAt || null,
          oldestDueWaitMs: due.oldestDueAt
            ? Math.max(0, Number(new Date(clock())) - Date.parse(due.oldestDueAt))
            : 0
        }
      }
    },
    close() {
      closed = true
      for (const job of exportQueue.splice(0)) {
        clearTimeout(job.timer)
        job.reject(protectionError('服务器正在停止，请稍后重试', 503, 'SERVER_STOPPING'))
      }
    }
  }
}
