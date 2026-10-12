import { storeToRefs } from 'pinia'
import { useStudioStore } from '@/store/modules/studio'
import type { Role, OrderStatus } from '@/types/studio'

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
  owner: '老板',
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
