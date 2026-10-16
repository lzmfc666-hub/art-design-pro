import { onSessionInvalidated } from './sessionBoundary'
import { ref } from 'vue'
import { safeApiMessage } from './studio'

export type PlayerResourceTopic = 'orders' | 'profile' | 'wallet' | 'notifications' | 'deposit' | 'content' | 'settings' | 'appearance' | 'ranking'
export type PlayerSummarySnapshot = { version: string | number; changed: boolean }
type Reader = {
  topics?: PlayerResourceTopic[]
  active: () => boolean
  needsRefresh?: () => boolean
  refreshOnWake?: boolean
  onPause?: () => void
  refresh: (force?: boolean, context?: { signal: AbortSignal; revalidate: boolean }) => Promise<unknown> | unknown
}
type SummaryProvider = (signal: AbortSignal) => Promise<PlayerSummarySnapshot>
const readers = new Set<Reader>()
export const playerReadFailure = ref('')
let summaryProvider: SummaryProvider | undefined
let verifySession: ((signal: AbortSignal) => Promise<unknown>) | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let inFlight: Promise<void> | undefined
let started = false
let failures = 0
let rerun = false
let lastWake = 0
let retryAfterUntil = 0
const foreground = () => typeof document === 'undefined' || document.visibilityState === 'visible'
const connected = () => typeof navigator === 'undefined' || navigator.onLine
const jitter = () => Math.round(Math.random() * 1400)

/** The caller adapts the documented summary contract; this module never invents endpoint paths. */
export function setPlayerSummaryProvider(provider: SummaryProvider) {
  summaryProvider = provider
  return () => { if (summaryProvider === provider) summaryProvider = undefined }
}
export function setPlayerSessionVerifier(verifier: (signal: AbortSignal) => Promise<unknown>) {
  verifySession = verifier
}
function schedule(delay = Math.min(120000, 15000 * 2 ** failures)) {
  clearTimeout(timer)
  if (started && foreground() && connected()) timer = setTimeout(() => void wake(false), Math.max(delay, retryAfterUntil - Date.now()) + jitter())
}
async function wake(force: boolean) {
  if (!started || !foreground() || !connected()) return
  if (Date.now() < retryAfterUntil) { schedule(retryAfterUntil - Date.now()); return }
  // focus, visibility and online commonly arrive together; reconcile once.
  if (force && Date.now() - lastWake < 500) return inFlight
  if (inFlight) { rerun ||= force; return inFlight }
  lastWake = Date.now()
  const request = new AbortController()
  controller = request
  inFlight = (async () => {
    let delay: number | undefined
    try {
      let changed = !summaryProvider
      if (verifySession) await verifySession(request.signal)
      if (request.signal.aborted) return
      if (summaryProvider) {
        const next = await summaryProvider(request.signal)
        if (request.signal.aborted) return
        changed = next.changed
      }
      if (request.signal.aborted) return
      failures = 0
      retryAfterUntil = 0
      playerReadFailure.value = ''
      await Promise.allSettled(Array.from(readers).filter((reader) => reader.active() &&
        (changed || reader.needsRefresh?.() || (force && reader.refreshOnWake)))
        .map((reader) => reader.refresh(changed, { signal: request.signal, revalidate: force && !!reader.refreshOnWake })))
    } catch (cause) {
      if (!request.signal.aborted) {
        failures = Math.min(3, failures + 1)
        playerReadFailure.value = `${safeApiMessage(cause, '最新状态暂未核对，请稍后重试')}；页面保留上次数据`
        const retryAfter = Number((cause as { retryAfter?: number }).retryAfter || 0)
        if (retryAfter) {
          retryAfterUntil = Math.max(retryAfterUntil, Date.now() + retryAfter)
          delay = Math.max(retryAfter, 15000)
        }
      }
    } finally {
      if (controller === request) controller = undefined
      inFlight = undefined
      if (rerun && foreground() && connected()) {
        rerun = false
        // Permit one queued recovery after the current reconcile finishes.
        lastWake = 0
        void wake(true)
      } else schedule(delay)
    }
  })()
  return inFlight
}
function reconnect() {
  if (connected()) void wake(true)
  else { playerReadFailure.value = '当前已断网，页面保留上次数据，联网后核对最新状态'; pause() }
}
function visibility() { if (foreground()) void wake(true); else pause() }
function focus() { void wake(true) }
function pause() {
  clearTimeout(timer)
  controller?.abort('background')
  for (const reader of readers) reader.onPause?.()
  rerun = false
  lastWake = 0
}
function start() {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('online', reconnect)
  window.addEventListener('offline', reconnect)
  window.addEventListener('focus', focus)
  document.addEventListener('visibilitychange', visibility)
  schedule(300)
}
function stop() {
  started = false
  pause()
  window.removeEventListener('online', reconnect)
  window.removeEventListener('offline', reconnect)
  window.removeEventListener('focus', focus)
  document.removeEventListener('visibilitychange', visibility)
  failures = 0
  retryAfterUntil = 0
  playerReadFailure.value = ''
}
export function registerPlayerReader(reader: Reader) {
  readers.add(reader)
  start()
  return () => {
    readers.delete(reader)
    if (!readers.size) stop()
  }
}
/** User-triggered foreground check is coalesced with reconnect and visibility events. */
export const reconcilePlayerReads = () => wake(true)
/** Invalidate visible resources after a confirmed write without making eligibility decisions. */
export const invalidatePlayerReads = () => Promise.allSettled(Array.from(readers)
  .filter((reader) => reader.active()).map((reader) => reader.refresh(true)))
onSessionInvalidated(() => {
  failures = 0
  retryAfterUntil = 0
  playerReadFailure.value = ''
  pause()
})
