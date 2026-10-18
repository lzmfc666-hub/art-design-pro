import type { PlayerOrder } from '@/types/player'
import { StudioApiError } from './studio'
import { playerOrderBlockedReason } from './orderAccess'

export const orderTargetKey = (order: PlayerOrder) => JSON.stringify([
  order.id, order.revision, order.dispatchRound, order.assignmentId, order.submissionId,
  order.leaderId, order.assignedTo, order.status, order.displayStatus, order.problem?.id, order.problem?.status, order.playerOperationBlockedReason?.code
])
export const orderSnapshot = (order: Readonly<PlayerOrder>): PlayerOrder => JSON.parse(JSON.stringify(order))
export function dispatchTarget(order: Readonly<PlayerOrder>) {
  const blocked = playerOrderBlockedReason(order)
  if (blocked) throw new StudioApiError(blocked.message, { code: blocked.code, status: 409 })
  if (!Number.isSafeInteger(order.revision) || !Number.isSafeInteger(order.dispatchRound))
    throw new StudioApiError('订单信息尚未更新，请刷新后重新确认', { code: 'PRECONDITION_REQUIRED', status: 409 })
  return { expectedRevision: order.revision!, dispatchRound: order.dispatchRound! }
}
export function assignmentTarget(order: Readonly<PlayerOrder>, actorId: string) {
  const blocked = playerOrderBlockedReason(order)
  if (blocked) throw new StudioApiError(blocked.message, { code: blocked.code, status: 409 })
  if (!Number.isSafeInteger(order.revision) || !order.assignmentId || !order.leaderId || order.leaderId !== actorId)
    throw new StudioApiError('订单已变化，请重新确认', { code: 'ASSIGNMENT_CONFLICT', status: 409 })
  return { expectedRevision: order.revision!, assignmentId: order.assignmentId, leaderId: order.leaderId }
}
