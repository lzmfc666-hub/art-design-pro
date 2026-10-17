export type StudioImageVariant = 'thumb' | 'display'
const canonical = /^\/api\/studio\/(?:uploads|public-assets|player\/content-assets|player-content\/assets)\/[A-Za-z0-9_-]+$/

/** Derivative URLs are display-only: the stored attachment and preview URL stay original. */
export function studioImageUrl(source: string | undefined, variant: StudioImageVariant = 'thumb') {
  if (!source) return ''
  const [path] = source.split('?')
  if (!canonical.test(path)) return source
  const search = new URLSearchParams(source.split('?')[1] || '')
  search.set('variant', variant)
  // Attachment IDs are immutable; conditional server validation still checks current access.
  search.set('v', path.slice(path.lastIndexOf('/') + 1))
  return `${path}?${search}`
}

type Entry = { url: string; size: number; at: number }
const entries = new Map<string, Entry>()
const pending = new Map<string, { controller: AbortController; promise: Promise<string> }>()
let bytes = 0, generation = 0, actor = ''
const maximumBytes = 16 * 1024 * 1024

/** Private pixels are memory-only and never enter localStorage, Cache API or service worker. */
export function clearStudioImageSession() {
  generation++
  for (const entry of entries.values()) URL.revokeObjectURL(entry.url)
  for (const entry of pending.values()) entry.controller.abort()
  entries.clear(); pending.clear(); bytes = 0; actor = ''
}

export function studioImagePixels(actorId: string, source: string): Promise<string> {
  if (!actorId) return Promise.reject(new Error('请先登录'))
  if (actor !== actorId) { clearStudioImageSession(); actor = actorId }
  const [path] = source.split('?')
  if (!canonical.test(path) || path.startsWith('/api/studio/public-assets/'))
    return Promise.resolve(source)
  const key = `${actorId}:${source}`, saved = entries.get(key)
  if (saved && Date.now() - saved.at < 30_000) {
    entries.delete(key); entries.set(key, saved)
    return Promise.resolve(saved.url)
  }
  if (saved) { entries.delete(key); bytes -= saved.size; URL.revokeObjectURL(saved.url) }
  const previous = pending.get(key)
  if (previous) return previous.promise
  const controller = new AbortController(), version = generation
  const promise = (async () => {
    let response: Response | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(source, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (response.status !== 429 || attempt === 2) break
      await response.body?.cancel()
      await new Promise<void>((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(new Error('图片会话已变更')) }
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve() }, 1500)
        if (controller.signal.aborted) stop()
        else controller.signal.addEventListener('abort', stop, { once: true })
      })
    }
    if (!response) throw new Error('图片当前不可读取')
    if (!response.ok || response.headers.get('X-Studio-User') !== actorId)
      throw new Error('图片当前不可读取')
    const blob = await response.blob()
    if (version !== generation || actor !== actorId) throw new Error('图片会话已变更')
    if (!blob.type.startsWith('image/') || blob.size > 8 * 1024 * 1024)
      throw new Error('图片内容无效')
    while ((bytes + blob.size > maximumBytes || entries.size >= 48) && entries.size) {
      const first = entries.keys().next().value!
      const entry = entries.get(first)!
      bytes -= entry.size; entries.delete(first); URL.revokeObjectURL(entry.url)
    }
    const url = URL.createObjectURL(blob)
    entries.set(key, { url, size: blob.size, at: Date.now() }); bytes += blob.size
    return url
  })().finally(() => { if (pending.get(key)?.controller === controller) pending.delete(key) })
  pending.set(key, { controller, promise })
  return promise
}
