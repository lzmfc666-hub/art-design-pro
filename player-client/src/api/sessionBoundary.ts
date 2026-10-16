let revision = 0
export type SessionInvalidationReason = 'account' | 'permissions'
const listeners = new Set<(reason: SessionInvalidationReason) => void>()
export const sessionRevision = () => revision
export const invalidateSessionRequests = (reason: SessionInvalidationReason = 'account') => {
  revision++
  for (const listener of listeners) listener(reason)
}
/** Abort reads and invalidate account-scoped resources synchronously, before late replies arrive. */
export const onSessionInvalidated = (listener: (reason: SessionInvalidationReason) => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
