import { useStudio } from '@/hooks/business/useStudio'

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
  roles?: unknown
): boolean {
  if (Array.isArray(roles) && !roles.includes(useStudio().user.value?.role)) return false
  if (!Array.isArray(permissions) || permissions.length === 0) return true
  const hasPermission = (permission: unknown) => useStudio().can(String(permission))
  return mode === 'all' ? permissions.every(hasPermission) : permissions.some(hasPermission)
}
