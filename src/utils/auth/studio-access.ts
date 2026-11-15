import { useStudio } from '@/hooks/business/useStudio'
import type { Staff } from '@/types/studio'

/** 菜单和搜索缓存跟随账号身份与登录资格变化，不能只比较相同的订单授权。 */
export function studioAccessScopeSignature(
  user: Staff | null | undefined,
  permissions: string[] | undefined
): string | undefined {
  if (!permissions) return undefined
  return JSON.stringify([
    user?.id || '',
    user?.role || '',
    user?.merchantId || '',
    user?.merchantRole || '',
    user?.status || '',
    user?.deletedAt || '',
    [...permissions].sort()
  ])
}

export const dataInspectionPermissions = [
  'settings.manage',
  'logs.view',
  'reports.export',
  'orders.view',
  'users.manage',
  'salary.all',
  'profit.view',
  'finance.review',
  'finance.refunds',
  'finance.withdrawals',
  'finance.expenses'
]

export function canAccessStudioPage(
  permissions: unknown,
  mode: unknown = 'any',
  merchantOwnerOnly: unknown = false,
  roles?: unknown
): boolean {
  if (merchantOwnerOnly) {
    const user = useStudio().user.value
    if (
      user?.role !== 'merchant' ||
      user.merchantRole !== 'owner' ||
      user.deletedAt ||
      user.status !== 'active'
    )
      return false
  }
  if (Array.isArray(roles) && !roles.includes(useStudio().user.value?.role)) return false
  if (!Array.isArray(permissions) || permissions.length === 0) return true
  const hasPermission = (permission: unknown) => useStudio().can(String(permission))
  return mode === 'all' ? permissions.every(hasPermission) : permissions.some(hasPermission)
}
