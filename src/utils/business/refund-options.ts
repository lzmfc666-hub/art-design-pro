import type { Refund, RefundDestination, RefundChannel, Order } from '@/types/studio'

export const refundChannelLabels: Record<RefundChannel, string> = {
  wechat: '微信',
  alipay: '支付宝',
  platform: '原平台',
  bank: '银行卡',
  other: '其他'
}
export function refundDestinationOf(refund: Refund, order?: Pick<Order, 'paymentMethod'>) {
  return (
    refund.destination ||
    (order
      ? order.paymentMethod === 'balance'
        ? 'balance'
        : 'cash'
      : refund.refundMethod || 'cash')
  )
}
export const effectiveOrderReward = (order: Pick<Order, 'effectiveReward' | 'reward'>) =>
  order.effectiveReward ?? order.reward
export function refundOutcome(
  destination: RefundDestination,
  canConfirm: boolean,
  confirmed: boolean,
  amount: number
) {
  if (amount === 0) return '仅取消订单，不生成退款记录、不增加客户余额。'
  if (destination === 'balance')
    return canConfirm
      ? '保存后退回客户余额，不再进行线下退款。'
      : '提交回客户余额申请，财务批准后才增加客户余额。'
  return canConfirm && confirmed
    ? '保存为已退款，只登记已完成的线下退款，不增加客户余额。'
    : '提交线下退款申请，当前保存为待处理；完成线下退款后由财务确认，不增加客户余额。'
}
export function validateRefundRoute(
  destination: RefundDestination,
  channel: string,
  note: string,
  amount: number
) {
  if (amount <= 0 || destination === 'balance') return ''
  if (!Object.hasOwn(refundChannelLabels, channel)) return '请选择线下退款渠道'
  if (channel === 'other' && !note.trim()) return '请填写其他退款渠道说明'
  return ''
}
