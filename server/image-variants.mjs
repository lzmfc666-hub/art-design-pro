import { createHash } from 'node:crypto'
import sharp from 'sharp'

const profiles = {
  thumb: { width: 480, height: 360, quality: 76 },
  display: { width: 1600, height: 1600, quality: 82 }
}
export class ImageVariantError extends Error {
  constructor(message, status = 422, code = 'IMAGE_VARIANT_UNAVAILABLE') {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Regenerable derivatives only. No business rows or original bytes are changed.
 * Callers MUST authorize the original before and after awaiting this queue.
 * A single native asynchronous transform bounds decode memory on small hosts.
 */
export function createImageVariants({ concurrency = 1, maxQueued = 8, maxBytes = 32 * 1024 * 1024,
  transform = async (data, profile) => sharp(data, { failOn: 'warning', limitInputPixels: 32_000_000,
    limitInputChannels: 4, pages: 1 })
    .rotate().resize({ width: profile.width, height: profile.height, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: profile.quality, effort: 3 }).timeout({ seconds: 10 }).toBuffer()
} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2 ||
      !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 32 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024)
    throw new Error('图片衍生队列配置无效')
  const cache = new Map(), jobs = new Map(), failures = new Map(), queue = []
  let active = 0, bytes = 0, closed = false, generation = 0
  function remember(key, value) {
    if (closed || value.size > maxBytes) return
    while (bytes + value.size > maxBytes && cache.size) {
      const oldest = cache.keys().next().value
      bytes -= cache.get(oldest).size
      cache.delete(oldest)
    }
    cache.set(key, value)
    bytes += value.size
  }
  function drain() {
    while (!closed && active < concurrency && queue.length) {
      const job = queue.shift()
      active++
      Promise.resolve().then(() => transform(job.data, profiles[job.variant])).then(data => {
        const result = { data: Buffer.from(data), size: data.length, mime: 'image/webp',
          name: `${job.id}-${job.variant}.webp`, etag: `"${createHash('sha256').update(data).digest('hex')}"` }
        if (job.generation === generation) remember(job.key, result)
        job.resolve(result)
      }).catch(() => {
        // Malformed/overlarge legacy images remain available as originals.
        if (!closed && job.generation === generation) failures.set(job.key, Date.now() + 30_000)
        if (failures.size > 64) failures.delete(failures.keys().next().value)
        job.reject(new ImageVariantError('图片预览无法生成，请查看原图'))
      }).finally(() => { active--; jobs.delete(job.key); drain() })
    }
  }
  return {
    get(attachment, variant) {
      if (!Object.hasOwn(profiles, variant)) throw new ImageVariantError('图片尺寸类型无效', 400)
      if (closed) throw new ImageVariantError('图片服务正在关闭', 503)
      const hash = createHash('sha256').update(attachment.data).digest('hex')
      const key = `${attachment.id}:${variant}:${hash}`
      if (cache.has(key)) {
        const result = cache.get(key)
        cache.delete(key); cache.set(key, result)
        return Promise.resolve(result)
      }
      if (jobs.has(key)) return jobs.get(key)
      if ((failures.get(key) || 0) > Date.now())
        throw new ImageVariantError('图片预览无法生成，请查看原图')
      failures.delete(key)
      if (active >= concurrency && queue.length >= maxQueued)
        throw new ImageVariantError('图片预览繁忙，请稍后重试', 429, 'IMAGE_VARIANT_BUSY')
      let resolveJob, rejectJob
      const promise = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject })
      jobs.set(key, promise)
      queue.push({ key, id: attachment.id, variant, generation, data: attachment.data, resolve: resolveJob, reject: rejectJob })
      drain()
      return promise
    },
    clear() { generation++; cache.clear(); failures.clear(); bytes = 0 },
    metrics: () => ({ active, queued: queue.length, cached: cache.size, bytes, maxBytes, concurrency, maxQueued }),
    close() {
      closed = true
      cache.clear(); failures.clear(); bytes = 0
      for (const job of queue.splice(0)) {
        jobs.delete(job.key)
        job.reject(new ImageVariantError('图片服务正在关闭', 503))
      }
    }
  }
}
