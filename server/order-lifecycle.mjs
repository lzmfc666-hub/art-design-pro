import { effectiveOrderReward } from './order-reward-policy.mjs'

/** One authoritative execution view; financial and fulfillment history stay intact. */
export function createLifecycleContext(state) {
  const refunds = new Map()
  for (const row of state.refunds || []) {
    if (!['paid', 'pending'].includes(row.status)) continue
    let amounts = refunds.get(row.orderId)
    if (!amounts) { amounts = { paid: 0, pending: 0 }; refunds.set(row.orderId, amounts) }
    amounts[row.status] += row.amount
  }
  return { refunds }
}

export function refundSummary(state, order, context) {
  let paid = 0, pending = 0
  if (context) ({ paid = 0, pending = 0 } = context.refunds.get(order.id) || {})
  else for (const refund of state.refunds || []) {
    if (refund.orderId !== order.id) continue
    if (refund.status === 'paid') paid += refund.amount
    if (refund.status === 'pending') pending += refund.amount
  }
  const received = order.receivedAmount || 0
  const fullRefund = received > 0 && paid >= received
  return {
    paid, pending, remaining: Math.max(0, received - paid - pending),
    fullRefund,
    refundPending: !fullRefund && received > 0 && pending > 0 && paid + pending >= received
  }
}

export function resumedCapacityExempt(order) {
  const exemption = order.capacityExemption
  return Boolean(
    exemption && order.storage && !order.storage.active && order.storage.resumedAt &&
    exemption.storageId === order.storage.id && exemption.leaderId === order.leaderId &&
    exemption.assignmentId === order.assignmentId && order.assignmentId &&
    ['active', 'review'].includes(order.status) &&
    order.assignments?.some(row => row.id === order.assignmentId && !row.releasedAt && row.leaderId === order.leaderId)
  )
}

export function orderLifecycle(state, order, context) {
  const refunds = refundSummary(state, order, context)
  const fullRefund = refunds.fullRefund || Boolean(order.refundExecutionClosedAt)
  const stored = order.storage?.active === true
  const capacityExempt = resumedCapacityExempt(order)
  const activeAssignment = !order.assignmentId || order.assignments?.some(
    row => row.id === order.assignmentId && !row.releasedAt && row.leaderId === order.leaderId
  )
  const blocked = fullRefund
    ? { code: 'ORDER_REFUNDED', message: '订单已全额退款，不能继续执行' }
    : refunds.refundPending
      ? { code: 'REFUND_PENDING', message: '全额退款审批中，订单暂时停止执行' }
       : stored ? { code: 'ORDER_STORED', message: '订单已存单，请由后台恢复后继续' }
         : order.status === 'canceled' && order.cancellationPolicyVersion === 1
           ? { code: 'ORDER_CANCELED', message: '订单已取消，不能恢复履约' } : null
  return {
    displayStatus: fullRefund ? 'refunded' : refunds.refundPending ? 'refund-pending' : stored ? 'stored' : order.status,
    fullRefund,
    refundPending: !fullRefund && refunds.refundPending,
    stored,
    capacityExempt,
    effectiveReward: effectiveOrderReward(order),
    countsTowardsCapacity: Boolean(order.status === 'active' && order.leaderId && activeAssignment && !stored && !fullRefund && !capacityExempt),
    executionBlockedReason: blocked,
    playerOperationBlockedReason: blocked || (order.status === 'canceled'
      ? { code: 'ORDER_CANCELED', message: '订单已取消，不能继续操作' } : null) || (order.problem?.status === 'open'
      ? { code: 'ORDER_PROBLEM', message: '问题单由后台客服处理，打手暂不可操作' } : null),
    refundSummary: refunds
  }
}

export const orderExecutable = (state, order, context) => !orderLifecycle(state, order, context).executionBlockedReason
export const playerOrderExecutable = (state, order, context) => !orderLifecycle(state, order, context).playerOperationBlockedReason
