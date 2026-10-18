import type { PlayerOrder } from '@/types/player'

/** The server is authoritative; legacy projections also fail closed for stored/open issues. */
export function playerOrderBlockedReason(order: Readonly<PlayerOrder> | null | undefined) {
  if (!order) return null
  if (order.playerOperationBlockedReason) return order.playerOperationBlockedReason
  if (order.executionBlockedReason) return order.executionBlockedReason
  if (order.fullRefund || order.displayStatus === 'refunded') return { code: 'ORDER_REFUNDED', message: '订单已全额退款，当前仅可查看，请联系后台客服。' }
  if (order.refundPending || order.displayStatus === 'refund-pending') return { code: 'REFUND_PENDING', message: '退款审批中，当前仅可查看，请等待后台客服处理。' }
  if (order.stored || order.storage?.active || order.displayStatus === 'stored') return { code: 'ORDER_STORED', message: '订单已存单，当前仅可查看，请联系后台客服处理。' }
  if (order.problem?.status === 'open') return { code: 'ORDER_PROBLEM', message: '本单有未关闭的问题，当前仅可查看，请联系后台客服处理。' }
  return null
}
