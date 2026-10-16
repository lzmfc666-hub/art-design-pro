/** Only an unresolved-operation marker is persisted. No amounts, targets, images,
 * request bodies or replay queue are stored, and this module never sends a request. */
export interface OperationGuard { owner: string; family: string; requestId: string; createdAt: number }
const prefix = '__studio_player_unconfirmed_v1__:'
const familyKey = (owner: string, family: string) => `${prefix}${encodeURIComponent(owner)}:${family}`
const key = (marker: OperationGuard) => `${familyKey(marker.owner, marker.family)}:${encodeURIComponent(marker.requestId)}`
function parse(value: string | null): OperationGuard | null {
  if (!value) return null
  try {
    const item = JSON.parse(value)
    return typeof item.owner === 'string' && typeof item.family === 'string' &&
      typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 128 &&
      Number.isFinite(item.createdAt)
      ? { owner: item.owner, family: item.family, requestId: item.requestId, createdAt: item.createdAt } : null
  } catch { return null }
}
function scopedKeys(owner: string, family: string) {
  const scoped = familyKey(owner, family), keys: string[] = []
  for (let index = 0; index < window.localStorage.length; index++) {
    const name = window.localStorage.key(index)
    // Also read the original single-slot format, without migrating or losing an unresolved intent.
    if (name === scoped || name?.startsWith(`${scoped}:`)) keys.push(name)
  }
  return keys
}
export function readOperationGuard(owner: string, family: string) {
  try {
    return scopedKeys(owner, family).map(name => parse(window.localStorage.getItem(name)))
      .filter((marker): marker is OperationGuard => !!marker && marker.owner === owner && marker.family === family)
      .sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId))[0] || null
  } catch { return null }
}
export function writeOperationGuard(marker: OperationGuard) {
  try { window.localStorage.setItem(key(marker), JSON.stringify(marker)) } catch { /* In-memory protection remains available. */ }
}
export async function reserveOperationGuard(marker: OperationGuard, stillCurrent: () => boolean): Promise<'reserved' | 'blocked' | 'canceled'> {
  const reserve = (): 'reserved' | 'blocked' | 'canceled' => {
    if (!stillCurrent()) return 'canceled'
    if (readOperationGuard(marker.owner, marker.family)) return 'blocked'
    writeOperationGuard(marker)
    return 'reserved'
  }
  // The lock covers only reservation, never a network request or automatic retry queue.
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    // Do not queue a second callback immediately behind a writer: another renderer's
    // localStorage cache may not yet reflect that writer when the lock is released.
    try { return await navigator.locks.request(familyKey(marker.owner, marker.family), { ifAvailable: true }, lock =>
      lock ? reserve() : stillCurrent() ? 'blocked' : 'canceled') }
    catch { /* Per-request records retain every unresolved intent if browser locks are unavailable. */ }
  }
  return reserve()
}
export function clearOperationGuard(owner: string, family: string, requestId: string) {
  try {
    for (const name of scopedKeys(owner, family)) {
      const marker = parse(window.localStorage.getItem(name))
      if (marker?.owner === owner && marker.family === family && marker.requestId === requestId) window.localStorage.removeItem(name)
    }
  } catch { /* Never turn a storage limitation into a successful business result. */ }
}
export function onOperationGuardChanged(listener: (marker: OperationGuard, removed: boolean) => void) {
  if (typeof window === 'undefined') return
  window.addEventListener('storage', event => {
    if (!event.key?.startsWith(prefix)) return
    const marker = parse(event.newValue || event.oldValue)
    if (marker) listener(marker, !event.newValue)
  })
}
