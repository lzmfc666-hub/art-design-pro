import { onSessionInvalidated, sessionRevision } from './sessionBoundary'
import { readStudioImage } from './studio'

const maxEntries = 48, maxBytes = 12 * 1024 * 1024, ttl = 60000, concurrency = 4
type Cached = { blob: Blob; createdAt: number }
const cache = new Map<string, Cached>()
const pending = new Map<string, Promise<Blob>>()
const controllers = new Set<AbortController>()
const queue: { epoch: number; run: () => void; reject: (error: unknown) => void }[] = []
let active = 0, bytes = 0
const cancelled = () => new DOMException('图片读取已取消', 'AbortError')

export function clearPrivateImages() {
  cache.clear(); bytes = 0; pending.clear()
  controllers.forEach(controller => controller.abort('session-changed'))
  controllers.clear()
  queue.splice(0).forEach(item => item.reject(cancelled()))
}
onSessionInvalidated(clearPrivateImages)
function drain() {
  while (active < concurrency && queue.length) {
    const next = queue.shift()!
    if (next.epoch !== sessionRevision()) { next.reject(cancelled()); continue }
    active++; next.run()
  }
}
/** A bounded memory-only thumbnail cache. Original previews are fetched by explicit user action. */
export function privateImageBlob(url: string, context = ''): Promise<Blob> {
  const epoch = sessionRevision(), key = `${epoch}:${context}:${url}`
  const existing = cache.get(key)
  if (existing && Date.now() - existing.createdAt < ttl) {
    cache.delete(key); cache.set(key, existing)
    return Promise.resolve(existing.blob)
  }
  if (existing) { cache.delete(key); bytes -= existing.blob.size }
  const loading = pending.get(key)
  if (loading) return loading
  if (queue.length >= 96) return Promise.reject(new Error('图片正在排队，请稍后重新进入页面'))
  const request = new Promise<Blob>((resolve, reject) => {
    queue.push({ epoch, reject, run: () => {
      const controller = new AbortController(); controllers.add(controller)
      void readStudioImage(url, controller.signal).then(blob => {
        if (epoch !== sessionRevision()) throw cancelled()
        // Cache only thumbnails; full-size originals and their retention remain on the server.
        if (/\?variant=(?:thumb|display)$/.test(url) && blob.size <= maxBytes) {
          while (cache.size >= maxEntries || bytes + blob.size > maxBytes) {
            const oldest = cache.keys().next().value
            if (oldest === undefined) break
            bytes -= cache.get(oldest)!.blob.size; cache.delete(oldest)
          }
          cache.set(key, { blob, createdAt: Date.now() }); bytes += blob.size
        }
        resolve(blob)
      }).catch(reject).finally(() => {
        controllers.delete(controller); active--; drain()
      })
    } })
    drain()
  })
  pending.set(key, request)
  void request.finally(() => { if (pending.get(key) === request) pending.delete(key) }).catch(() => {})
  return request
}
export function thumbnailUrl(url: string, variant: 'thumb' | 'display' = 'thumb') {
  return /^\/api\/studio\/(?:uploads|player\/content-assets)\/[^/?#]+$/.test(url) ? `${url}?variant=${variant}` : ''
}
