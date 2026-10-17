import type { PlayerOrder } from '@/types/player'
import { StudioApiError } from './studio'

export const orderTargetKey = (order: PlayerOrder) => JSON.stringify([
  order.id, order.revision, order.dispatchRound, order.assignmentId, order.submissionId,
  order.leaderId, order.assignedTo, order.status, order.displayStatus, order.problem?.id, order.problem?.status
])
export const orderSnapshot = (order: Readonly<PlayerOrder>): PlayerOrder => JSON.parse(JSON.stringify(order))
export function dispatchTarget(order: Readonly<PlayerOrder>) {
  if (!Number.isSafeInteger(order.revision) || !Number.isSafeInteger(order.dispatchRound))
    throw new StudioApiError('订单信息尚未更新，请刷新后重新确认', { code: 'PRECONDITION_REQUIRED', status: 409 })
  return { expectedRevision: order.revision!, dispatchRound: order.dispatchRound! }
}
/** Both current participants may report an issue; ordinary fulfillment remains leader-only. */
export function problemFeedbackTarget(order: Readonly<PlayerOrder>, actorId: string) {
  if (!Number.isSafeInteger(order.revision) || (!order.assignmentId && order.status !== 'completed') || !order.leaderId ||
      ![order.leaderId, order.teammateId].includes(actorId) || order.problem?.status !== 'open')
    throw new StudioApiError('订单或问题已变化，请重新确认', { code: 'PROBLEM_CONFLICT', status: 409 })
  return { expectedRevision: order.revision!, assignmentId: order.assignmentId || null, leaderId: order.leaderId }
}
export function assignmentTarget(order: Readonly<PlayerOrder>, actorId: string) {
  if (!Number.isSafeInteger(order.revision) || !order.assignmentId || !order.leaderId || order.leaderId !== actorId)
    throw new StudioApiError('订单已变化，请重新确认', { code: 'ASSIGNMENT_CONFLICT', status: 409 })
  return { expectedRevision: order.revision!, assignmentId: order.assignmentId, leaderId: order.leaderId }
}
