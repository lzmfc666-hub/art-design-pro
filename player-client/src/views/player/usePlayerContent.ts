import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { contentApi } from '@/api/content'
import { onSessionInvalidated, sessionRevision } from '@/api/sessionBoundary'
import { isAbortError, safeApiMessage } from '@/api/studio'
import { registerPlayerReader } from '@/api/readScheduler'
import type { PlayerContentFeed, Publication } from '@/types/content'

export function publicationActive(item: Publication, now: number) {
  const start = item.startAt ? Date.parse(item.startAt) : -Infinity
  const end = item.endAt ? Date.parse(item.endAt) : Infinity
  return (
    Number.isFinite(now) && !Number.isNaN(start) && !Number.isNaN(end) && start <= now && now < end
  )
}

/** The monotonic clock keeps schedules accurate even when the phone's wall clock is wrong. */
export function usePlayerContent(
  loader: (signal: AbortSignal) => Promise<PlayerContentFeed> = contentApi.feed
) {
  const feed = ref<PlayerContentFeed | null>(null)
  const loading = ref(false)
  const error = ref('')
  const errorStatus = ref(0)
  const loadedRevision = ref(0)
  const now = ref(NaN)
  const isActive = ref(false)
  const visible = ref(document.visibilityState === 'visible')
  const stale = ref(true)
  let active = false,
    disposed = false,
    requestNumber = 0,
    clockAnchor = NaN,
    clockStarted = 0,
    controller: AbortController | undefined,
    clockTick: ReturnType<typeof setInterval> | undefined
  let unregister: (() => void) | undefined
  let inFlight: Promise<void> | undefined
  let failures = 0, nextAttempt = 0, retryAfterUntil = 0
  const sorted = (items: Publication[]) =>
    items
      .filter((item) => publicationActive(item, now.value))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  const announcements = computed(() => sorted(feed.value?.announcements || []))
  const banners = computed(() => sorted(feed.value?.banners || []))
  function tick() {
    now.value = clockAnchor + Math.max(0, performance.now() - clockStarted)
  }
  function cancel() {
    if (controller) stale.value = true
    controller?.abort('inactive-content')
    controller = undefined
    requestNumber++
    inFlight = undefined
    loading.value = false
  }
  async function refresh(force = true, scheduled = false) {
    if (disposed || !active || !visible.value) return
    if (force && scheduled) stale.value = true
    if (inFlight) {
      if (!force) return inFlight
      cancel()
    }
    if ((scheduled || !force) && Date.now() < nextAttempt) return
    if (!navigator.onLine) {
      feed.value = null
      loading.value = false
      error.value = '网络已断开，连接恢复后会更新内容'
      stale.value = true
      return
    }
    const request = ++requestNumber,
      revision = sessionRevision(),
      current = new AbortController()
    controller = current
    loading.value = true
    inFlight = (async () => { try {
      const result = await Promise.resolve().then(() => {
        if (current.signal.aborted) throw new DOMException('读取已取消', 'AbortError')
        return loader(current.signal)
      })
      if (
        disposed ||
        !active ||
        current.signal.aborted ||
        request !== requestNumber ||
        revision !== sessionRevision()
      )
        return
      const serverTime = Date.parse(result.serverTime)
      if (!Number.isFinite(serverTime)) throw new Error('内容时间暂未获取，请稍后重试')
      clockAnchor = serverTime
      clockStarted = performance.now()
      tick()
      feed.value = result
      loadedRevision.value++
      stale.value = false
      failures = 0
      nextAttempt = 0
      retryAfterUntil = 0
      error.value = ''
      errorStatus.value = 0
    } catch (cause) {
      if (current.signal.aborted || request !== requestNumber || disposed || revision !== sessionRevision() || isAbortError(cause)) return
      feed.value = null
      stale.value = true
      error.value = safeApiMessage(cause, '内容加载失败，请稍后重试')
      errorStatus.value = (cause as { status?: number }).status || 0
      failures = Math.min(4, failures + 1)
      const retryAfter = Number((cause as { retryAfter?: number }).retryAfter || 0)
      retryAfterUntil = Math.max(retryAfterUntil, Date.now() + retryAfter)
      nextAttempt = Math.max(Date.now() + 15000 * 2 ** (failures - 1), retryAfterUntil)
    } finally {
      if (!disposed && request === requestNumber) {
        loading.value = false
        controller = undefined
        inFlight = undefined
      }
    } })()
    return inFlight
  }
  function stopTimers() {
    clearInterval(clockTick)
    clockTick = undefined
  }
  function startTimers() {
    stopTimers()
    if (!active || !visible.value) return
    clockTick = setInterval(tick, 500)
  }
  function activate() {
    if (active || disposed) return
    active = isActive.value = true
    visible.value = document.visibilityState === 'visible'
    tick()
    startTimers()
    nextAttempt = retryAfterUntil
    void refresh(false, true)
  }
  function deactivate() {
    active = isActive.value = false
    cancel()
    stopTimers()
  }
  function visibility() {
    visible.value = document.visibilityState === 'visible'
    tick()
    startTimers()
    if (!visible.value) cancel()
    else if (active) { nextAttempt = retryAfterUntil; stale.value = true }
  }
  function connection() {
    if (!navigator.onLine) {
      cancel()
      feed.value = null
      stale.value = true
      error.value = '网络已断开，连接恢复后会更新内容'
    } else if (active) { nextAttempt = retryAfterUntil; stale.value = true }
  }
  const unsubscribeSession = onSessionInvalidated(() => {
    cancel()
    feed.value = null
    stale.value = true
    error.value = ''
    errorStatus.value = 0
    failures = 0
    nextAttempt = retryAfterUntil = 0
  })
  onMounted(() => {
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
    window.addEventListener('focus', visibility)
    document.addEventListener('visibilitychange', visibility)
    unregister = registerPlayerReader({
      topics: ['content'],
      active: () => active && !disposed && visible.value && navigator.onLine,
      needsRefresh: () => stale.value || feed.value === null,
      refresh: (force = false) => refresh(force, true)
    })
    activate()
  })
  onActivated(activate)
  onDeactivated(deactivate)
  onUnmounted(() => {
    disposed = true
    deactivate()
    unregister?.()
    unsubscribeSession()
    window.removeEventListener('online', connection)
    window.removeEventListener('offline', connection)
    window.removeEventListener('focus', visibility)
    document.removeEventListener('visibilitychange', visibility)
  })
  return {
    announcements,
    banners,
    loading,
    error,
    errorStatus,
    loadedRevision,
    now,
    isActive,
    visible,
    stale,
    refresh,
    cancel
  }
}
