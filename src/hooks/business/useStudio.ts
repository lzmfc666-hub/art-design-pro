import { storeToRefs } from 'pinia'
import { useStudioStore } from '@/store/modules/studio'
import type { Role, OrderStatus, OrderDisplayStatus, Order } from '@/types/studio'

export function useStudio() {
  const store = useStudioStore()
  return {
    ...storeToRefs(store),
    can: store.can,
    refresh: store.refresh,
    mutate: store.mutate,
    upload: store.upload,
    login: store.login,
    logout: store.logout,
    init: store.init,
    clearSession: store.clearSession
  }
}
export const roleLabels: Record<Role, string> = {
  owner: '工作室老板',
  manager: '店长',
  finance: '财务',
  hr: '人事',
  operations: '运营',
  support_lead: '客服主管',
  support: '客服',
  admin: '管理员',
  super_admin: '超级管理员',
  player: '打手'
}
export const statusLabels: Record<OrderStatus, string> = {
  pending: '待接单',
  active: '接单中',
  review: '待验收',
  completed: '已完成',
  canceled: '已取消'
}
export const orderDisplayStatusLabels: Record<OrderDisplayStatus, string> = {
  ...statusLabels,
  stored: '已存单',
  refunded: '已退款',
  'refund-pending': '全额退款审批中'
}
export function orderStatusLabel(order: Pick<Order, 'status' | 'displayStatus' | 'dispatchState'>) {
  const status = order.displayStatus || order.status
  if (order.status === 'canceled')
    return status === 'refunded'
      ? '已取消 · 已退款'
      : status === 'refund-pending'
        ? '已取消 · 退款待处理'
        : '已取消'
  return status === 'pending' && order.dispatchState === 'unassigned'
    ? '待分配'
    : orderDisplayStatusLabels[status]
}
export function orderStatusType(status: OrderDisplayStatus) {
  return (
    {
      pending: 'info',
      active: 'primary',
      review: 'warning',
      completed: 'success',
      canceled: 'danger',
      stored: 'info',
      refunded: 'danger',
      'refund-pending': 'warning'
    } as const
  )[status]
}
export function money(value: number | null | undefined) {
  return value == null
    ? '待配置'
    : `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
export function formatTime(value?: string | null) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—'
}
