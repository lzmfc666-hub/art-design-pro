import { isSafeOpsEvent } from './ops-events.mjs'

/** Used by the bounded ops queue; URL/config remains in the caller's resolver. */
export function createOpsWebhookSender({ resolveTarget, fetcher = fetch } = {}) {
  if (typeof resolveTarget !== 'function' || typeof fetcher !== 'function')
    throw new Error('OPS_SENDER_CONFIG_INVALID')
  return async (event, { signal, deliveryId } = {}) => {
    if (
      !isSafeOpsEvent(event) ||
      typeof deliveryId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(deliveryId)
    )
      return { ok: false, code: 'DELIVERY_CONFIG_INVALID' }
    let target
    try {
      const raw = resolveTarget()
      if (!raw) return { ok: false, code: 'DELIVERY_DISABLED' }
      target = new URL(raw)
      if (target.protocol !== 'https:' || target.username || target.password || target.hash)
        return { ok: false, code: 'DELIVERY_CONFIG_INVALID' }
    } catch {
      return { ok: false, code: 'DELIVERY_CONFIG_INVALID' }
    }
    try {
      const response = await fetcher(target.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': deliveryId },
        body: JSON.stringify(event),
        signal,
        redirect: 'error'
      })
      return response.ok === true ? { ok: true } : { ok: false, code: 'DELIVERY_REJECTED' }
    } catch {
      return { ok: false, code: signal?.aborted ? 'DELIVERY_TIMEOUT' : 'DELIVERY_FAILED' }
    }
  }
}
