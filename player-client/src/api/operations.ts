import { computed, shallowReactive } from 'vue'
import { onSessionInvalidated, sessionRevision } from './sessionBoundary'
import { StudioApiError, safeApiMessage, studioRequest } from './studio'
import { useSessionStore } from '@/stores/session'
import { playerApi } from './player'
import type { PlayerOperationFamily, PlayerOperationResult } from '@/types/player'
import { readOperationGuard, reserveOperationGuard, clearOperationGuard, onOperationGuardChanged } from './operationGuard'
import type { OperationGuard } from './operationGuard'
import { invalidatePlayerReads } from './readScheduler'

export type OperationFamily = PlayerOperationFamily
export interface PlayerOperation {
  readonly family: OperationFamily
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
  readonly requestId: string
  readonly owner: string
  readonly recovered?: boolean
  readonly reservationWaiting?: boolean
  session: number
  state: 'sending' | 'unknown' | 'confirmed' | 'rejected'
  message: string
  checking: boolean
  retryAllowed: boolean
}
export type OperationLookup = (operation: PlayerOperation) => Promise<PlayerOperationResult>
const operations = shallowReactive(new Map<OperationFamily, PlayerOperation>())
const families = new Set<OperationFamily>(['claim', 'reject', 'return', 'submit', 'problem-feedback', 'withdraw', 'cancel-withdrawal'])
function recover(family: OperationFamily, received?: OperationGuard) {
  const current = operations.get(family)
  if (operationPending(current) && !current?.reservationWaiting) return
  const owner = useSessionStore().user?.id
  if (!owner) return
  // The storage event carries the original marker even when the receiving
  // renderer's cached localStorage read is still catching up.
  const marker = received?.owner === owner && received.family === family ? received : readOperationGuard(owner, family)
  if (marker) operations.set(family, Object.freeze({ family, owner, requestId: marker.requestId,
    path: '', body: Object.freeze({ requestId: marker.requestId }), session: sessionRevision(), recovered: true,
    state: 'unknown', checking: false, retryAllowed: false,
    message: '前次操作结果仍未确认，请先核对。本页不会再次提交。' }))
}
onOperationGuardChanged((marker, removed) => {
  if (marker.owner !== useSessionStore().user?.id || !families.has(marker.family as OperationFamily)) return
  const family = marker.family as OperationFamily, current = operations.get(family)
  if (removed && current?.recovered && current.requestId === marker.requestId) {
    operations.delete(family); recover(family)
    void invalidatePlayerReads()
  }
  else if (!removed) recover(family, marker)
})
let lookup: OperationLookup = operation => playerApi.operationResult(operation.requestId, operation.family)
export function setOperationLookup(value: OperationLookup) { lookup = value }
onSessionInvalidated((reason) => {
  if (reason !== 'permissions') { operations.clear(); return }
  // A permission refresh is the same account, not proof that an uncertain write failed.
  // Abort the old transport, retain the exact intent and keep its family locked.
  for (const [family, operation] of operations) {
    if (operationPending(operation)) operations.set(family, Object.freeze({ ...operation,
      session: sessionRevision(), state: operation.reservationWaiting ? 'sending' : 'unknown', checking: false, retryAllowed: false,
      message: operation.reservationWaiting ? '账号权限已更新，仍在核对另一页面的待确认标记。本页不会提交请求。' : '账号权限已更新，原操作结果仍需核对。请勿重新创建请求。' }))
    else operations.delete(family)
  }
})

function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const value = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
function freeze(value: unknown): unknown {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export const orderChangeMessage = '订单已变化，请重新确认'
const targetConflicts = new Set(['PRECONDITION_REQUIRED', 'ORDER_REVISION_CONFLICT', 'DISPATCH_ROUND_CONFLICT', 'ASSIGNMENT_CONFLICT', 'SUBMISSION_CONFLICT', 'PROBLEM_CONFLICT', 'PROBLEM_CHANGED'])
export function operationMessage(cause: unknown) {
  if ((cause as { code?: string })?.code === 'PRINCIPAL_CHANGED') return '账号已变化，请重新登录后确认。'
  if ((cause as { code?: string })?.code === 'SESSION_EXPIRED') return '登录已失效，请重新登录后确认。'
  if (targetConflicts.has((cause as { code?: string })?.code || '')) return orderChangeMessage
  if ((cause as { code?: string })?.code === 'REQUEST_ID_CONFLICT') return '这次操作的信息已变化，请先联系后台核对原操作结果。'
  return safeApiMessage(cause, '操作暂时无法处理，请稍后核对')
}
export function captureOperation(family: OperationFamily, path: string, body: Record<string, unknown>): PlayerOperation {
  const owner = useSessionStore().user?.id
  if (!owner) throw new StudioApiError('请重新登录后确认操作', { status: 401 })
  const requestId = uuid()
  // The exact body belongs to this intent; refreshing a page cannot rewrite its version or materials.
  const original = freeze(JSON.parse(JSON.stringify({ ...body, requestId }))) as Record<string, unknown>
  return Object.freeze({ family, owner, path, body: original, requestId, session: sessionRevision(), state: 'sending', message: '', checking: false, retryAllowed: false })
}
export function operationPending(operation?: PlayerOperation | null) {
  return !!operation && (operation.state === 'sending' || operation.state === 'unknown')
}
function replace(operation: PlayerOperation, changes: Partial<PlayerOperation>) {
  if (operation.session !== sessionRevision() || operations.get(operation.family)?.requestId !== operation.requestId) return null
  const next = Object.freeze({ ...operation, ...changes })
  operations.set(operation.family, next)
  if (next.state === 'confirmed' || next.state === 'rejected') {
    clearOperationGuard(next.owner, next.family, next.requestId)
    recover(next.family)
  }
  return next
}
async function send(operation: PlayerOperation, uncertainRetry = false) {
  try {
    await studioRequest(operation.path, operation.body, 'POST', undefined, { expectedActorId: operation.owner })
    return replace(operation, { state: 'confirmed', message: '', checking: false })
  } catch (cause) {
    // A rejected retry proves only that this attempt did not execute; the original
    // uncertain attempt may still arrive. Only result acknowledgement can release it.
    const unknown = uncertainRetry || cause instanceof StudioApiError && cause.outcome === 'unknown'
    if (cause instanceof StudioApiError && !unknown && (cause.code !== 'PRINCIPAL_CHANGED' || cause.status === 409))
      clearOperationGuard(operation.owner, operation.family, operation.requestId)
    return replace(operation, { state: unknown ? 'unknown' : 'rejected', message: unknown
      ? `${uncertainRetry && cause instanceof StudioApiError && cause.outcome === 'rejected' ? `${operationMessage(cause)} ` : ''}操作结果尚未确认，请先核对，勿创建另一笔请求。`
      : operationMessage(cause), checking: false, retryAllowed: false })
  }
}
export function usePlayerOperation(family: OperationFamily) {
  recover(family)
  const operation = computed(() => operations.get(family) || null)
  const pending = computed(() => operationPending(operation.value))
  async function execute(intent: PlayerOperation) {
    recover(family)
    if (family === 'problem-feedback') throw new StudioApiError('问题单已改由后台客服处理，打手仅可查看并核对历史结果。', { status: 409, code: 'PROBLEM_STAFF_ONLY' })
    if (intent.session !== sessionRevision() || intent.owner !== useSessionStore().user?.id || pending.value) return null
    // This draft has not been sent yet. A permission refresh during reservation
    // must not turn its new ID into an unknown server operation or query that ID.
    operations.set(family, Object.freeze({ ...intent, reservationWaiting: true }))
    const sameOwner = () => intent.owner === useSessionStore().user?.id
    const stillCurrent = () => intent.session === sessionRevision() && sameOwner() && operations.get(family)?.requestId === intent.requestId
    const reserved = await reserveOperationGuard({ owner: intent.owner, family, requestId: intent.requestId, createdAt: Date.now() }, stillCurrent)
    if (reserved !== 'reserved' || !stillCurrent()) {
      if (reserved === 'reserved') clearOperationGuard(intent.owner, family, intent.requestId)
      if (operations.get(family)?.requestId === intent.requestId) {
        if (sameOwner() && (reserved === 'blocked' || intent.session !== sessionRevision())) operations.set(family, Object.freeze({ ...intent, session: sessionRevision(), reservationWaiting: true,
          message: '另一页面正在保留同类操作，正在核对待确认标记。本页不会新建或提交请求。' }))
        else operations.delete(family)
      }
      if (sameOwner()) recover(family)
      return null
    }
    const sending = Object.freeze({ ...intent, reservationWaiting: false })
    operations.set(family, sending)
    return send(sending)
  }
  async function check() {
    const original = operation.value
    if (!original || original.state !== 'unknown' || original.checking || original.session !== sessionRevision() || original.owner !== useSessionStore().user?.id) return null
    replace(original, { checking: true, retryAllowed: false })
    try {
      const result = await lookup(original)
      if (!result || typeof result !== 'object' || result.requestId !== original.requestId || result.family !== original.family || result.result !== 'confirmation-only' ||
          result.canCreateNew !== false || !['succeeded', 'not-recorded'].includes(result.status) ||
          result.operationConfirmed !== (result.status === 'succeeded') || typeof result.lateCommitPossible !== 'boolean' ||
          typeof result.canRetryWithOriginal !== 'boolean') throw new StudioApiError('暂时无法核对原操作，请稍后重试')
      if (result.status === 'succeeded') return replace(original, { state: 'confirmed', checking: false, retryAllowed: false,
        message: '原操作已确认，请查看当前最新状态。' })
      const retryAllowed = original.family !== 'problem-feedback' && !original.recovered && !!original.path && result.canRetryWithOriginal
      return replace(original, { state: 'unknown', checking: false, retryAllowed,
        message: original.recovered ? '暂未核对到成功结果，原请求仍可能完成。本页没有原提交内容，请联系后台核对。'
          : retryAllowed ? '暂未核对到成功结果，原请求仍可能完成。请继续核对，或明确重试原操作；不会另建请求。'
          : '暂未核对到成功结果，当前不允许重试。原请求仍需核对，请勿重复提交新的操作。' })
    } catch (cause) { return replace(original, { checking: false, retryAllowed: false, message: `${operationMessage(cause)} 原操作结果仍需核对。` }) }
  }
  async function retryOriginal() {
    const original = operation.value
    if (family === 'problem-feedback') return null
    if (!original || original.recovered || original.state !== 'unknown' || !original.retryAllowed || original.checking || original.session !== sessionRevision() || original.owner !== useSessionStore().user?.id) return null
    const sending = replace(original, { state: 'sending', message: '', retryAllowed: false })
    return sending ? send(sending, true) : null
  }
  function dismiss() {
    if (!pending.value) operations.delete(family)
  }
  return { operation, pending, execute, check, retryOriginal, dismiss }
}
