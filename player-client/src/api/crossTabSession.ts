export type PlayerSessionEventPhase = 'login-start' | 'login-complete' | 'logout' | 'password-updated'
type PlayerSessionEvent = { type: 'player-session-event'; version: 1; id: string; phase: PlayerSessionEventPhase }
const channelName = 'studio-player-session-events-v1'
const storageKey = '__studio_player_session_event_v1__'
const listeners = new Set<(phase: PlayerSessionEventPhase) => void>()
const seen = new Set<string>()
let channel: BroadcastChannel | undefined
let storageListener: ((event: StorageEvent) => void) | undefined
const phases = new Set<PlayerSessionEventPhase>(['login-start', 'login-complete', 'logout', 'password-updated'])

function remember(id: string) {
  seen.add(id)
  if (seen.size > 100) seen.delete(seen.values().next().value!)
}
function receive(value: unknown) {
  if (!value || typeof value !== 'object') return
  const event = value as Partial<PlayerSessionEvent>
  if (event.type !== 'player-session-event' || event.version !== 1 || typeof event.id !== 'string' ||
    event.id.length > 128 || !event.phase || !phases.has(event.phase) || seen.has(event.id)) return
  remember(event.id)
  for (const listener of listeners) listener(event.phase)
}
function connect() {
  if (typeof window === 'undefined' || channel || storageListener) return
  if (typeof window.BroadcastChannel === 'function') {
    try {
      channel = new window.BroadcastChannel(channelName)
      channel.onmessage = (event) => receive(event.data)
      return
    } catch { /* Private/restricted browser modes can use the event-only storage fallback. */ }
  }
  storageListener = (event) => {
    if (event.key !== storageKey || !event.newValue) return
    try { receive(JSON.parse(event.newValue)) } catch { /* Invalid events cannot change session state. */ }
  }
  window.addEventListener('storage', storageListener)
}

/** Broadcast only a session event, never credentials, actor details, attachments or write payloads. */
export function announcePlayerSession(phase: PlayerSessionEventPhase) {
  if (typeof window === 'undefined') return
  connect()
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const event: PlayerSessionEvent = { type: 'player-session-event', version: 1, id, phase }
  remember(id)
  try {
    if (channel) channel.postMessage(event)
    else {
      window.localStorage.setItem(storageKey, JSON.stringify(event))
      window.localStorage.removeItem(storageKey)
    }
  } catch { /* Server authentication/identity checks remain authoritative if broadcasting is unavailable. */ }
}
export function onRemotePlayerSessionChanged(listener: (phase: PlayerSessionEventPhase) => void) {
  listeners.add(listener)
  connect()
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    channel?.close()
    channel = undefined
    if (storageListener && typeof window !== 'undefined') window.removeEventListener('storage', storageListener)
    storageListener = undefined
    seen.clear()
  }
}
