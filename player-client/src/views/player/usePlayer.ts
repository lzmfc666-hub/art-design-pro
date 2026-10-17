import { ref, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { isAbortError, safeApiMessage } from '@/api/studio'
import { onSessionInvalidated, sessionRevision } from '@/api/sessionBoundary'
import { registerPlayerReader, type PlayerResourceTopic } from '@/api/readScheduler'

export const money = (cents = 0) => (cents / 100).toFixed(2)
export const dateTime = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(value))
    : '—'
export const currentMonth = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit'
  }).format(new Date())
export const orderStatus: Record<string, string> = {
  pending: '待接单',
  active: '接单中',
  review: '待验收',
  completed: '已完成',
  canceled: '已取消',
  stored: '已存单',
  refunded: '已退款',
  'refund-pending': '退款审批中'
}
export const withdrawalStatus: Record<string, string> = {
  pending: '待审核',
  approved: '待发放',
  paid: '财务已登记发放',
  rejected: '已驳回',
  canceled: '已撤回'
}
export const requestId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 手机只读取本人接口；切换标签保留已加载数据，回到前台立即核对服务器。 */
export function usePlayerResource<T>(loader: (signal?: AbortSignal) => Promise<T>, initial: T,
  poll = true, options: { topics?: PlayerResourceTopic[] } = {}) {
  const data = ref<T>(initial)
  const loading = ref(false)
  const error = ref('')
  const online = ref(navigator.onLine)
  const stale = ref(false)
  const updatedAt = ref<number | null>(null)
  const router = useRouter()
  let active = true, disposed = false
  let generation = 0
  let inFlight: Promise<void> | null = null
  let controller: AbortController | undefined
  let failures = 0, nextAttempt = 0, lastStarted = 0, retryAfterUntil = 0
  let unregister: (() => void) | undefined
  function cancel() {
    generation++
    if (controller) stale.value = true
    controller?.abort('inactive-page')
    controller = undefined
    inFlight = null
    loading.value = false
  }
  async function refresh(quiet = false, reconcile = false) {
    if (disposed || !active) return
    // A consumed summary change must survive an existing read, debounce or retry backoff.
    // Mark it before cancellation; the next unchanged summary will still see this resource stale.
    if (reconcile) stale.value = true
    if (inFlight) {
      if (quiet && !reconcile) return inFlight
      // An explicit refresh may represent a new filter or target; do not accept the prior read.
      cancel()
    }
    if (quiet && (Date.now() < nextAttempt || (!reconcile && Date.now() - lastStarted < 350))) return
    if (!navigator.onLine) {
      online.value = false
      stale.value = true
      error.value = '当前已断网，恢复网络后将核对最新数据'
      return
    }
    const version = ++generation
    const epoch = sessionRevision()
    const request = new AbortController()
    controller = request
    lastStarted = Date.now()
    if (!quiet) loading.value = true
    inFlight = (async () => {
      try {
        const result = await Promise.resolve().then(() => {
          if (request.signal.aborted) throw new DOMException('读取已取消', 'AbortError')
          return loader(request.signal)
        })
        if (!disposed && active && version === generation && epoch === sessionRevision() && !request.signal.aborted) {
          data.value = result as typeof data.value
          error.value = ''
          stale.value = false
          failures = 0
          nextAttempt = 0
          retryAfterUntil = 0
          updatedAt.value = Date.now()
          online.value = navigator.onLine
        }
      } catch (cause) {
        if (disposed || version !== generation || epoch !== sessionRevision() || isAbortError(cause)) return
        stale.value = true
        online.value = navigator.onLine
        const status = (cause as { status?: number }).status
        if (status === 403 || status === 404) {
          // Visibility can disappear after reassignment/cancellation. Do not retain old private fields.
          data.value = initial as typeof data.value
          updatedAt.value = null
        }
        error.value = safeApiMessage(cause)
        failures = Math.min(3, failures + 1)
        const retryAfter = Number((cause as { retryAfter?: number }).retryAfter || 0)
        retryAfterUntil = Math.max(retryAfterUntil, Date.now() + retryAfter)
        nextAttempt = Math.max(Date.now() + 15000 * 2 ** (failures - 1), retryAfterUntil)
        if ((cause as { status?: number }).status === 401) {
          useSessionStore().clearSession()
          void router.replace({
            path: '/player/login',
            query: { redirect: router.currentRoute.value.fullPath }
          })
        }
      } finally {
        if (version === generation) {
          inFlight = null
          controller = undefined
          loading.value = false
        }
      }
    })()
    return inFlight
  }
  function connection() {
    online.value = navigator.onLine
    if (!online.value) {
      cancel()
      stale.value = true
      error.value = '当前已断网，恢复网络后将核对最新数据'
    } else if (active) {
      nextAttempt = retryAfterUntil
      lastStarted = 0
      if (!poll) void refresh(true)
    }
  }
  function visibility() {
    if (document.visibilityState === 'visible' && active) {
      nextAttempt = retryAfterUntil
      lastStarted = 0
      if (!poll) void refresh(true)
    } else cancel()
  }
  const unsubscribeSession = onSessionInvalidated(() => {
    cancel()
    data.value = initial as typeof data.value
    updatedAt.value = null
    stale.value = true
    error.value = ''
    failures = 0
    nextAttempt = retryAfterUntil = 0
  })
  onMounted(() => {
    void refresh()
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
    document.addEventListener('visibilitychange', visibility)
    if (poll) unregister = registerPlayerReader({
      topics: options.topics,
      active: () => active && !disposed && navigator.onLine && document.visibilityState === 'visible',
      needsRefresh: () => stale.value || updatedAt.value === null,
      refresh: (force = false) => refresh(true, force)
    })
  })
  onActivated(() => {
    active = true
    nextAttempt = retryAfterUntil
    lastStarted = 0
    void refresh(true)
  })
  onDeactivated(() => {
    active = false
    cancel()
  })
  onUnmounted(() => {
    disposed = true
    cancel()
    unregister?.()
    unsubscribeSession()
    window.removeEventListener('online', connection)
    window.removeEventListener('offline', connection)
    document.removeEventListener('visibilitychange', visibility)
  })
  return { data, loading, error, online, stale, updatedAt, refresh, cancel }
}
