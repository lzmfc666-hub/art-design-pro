import type { Staff } from '@/types/studio'
import { useStudio } from '@/hooks/business/useStudio'

export function isStudioSuperAdmin(user: Staff | null): boolean {
  return user?.role === 'super_admin'
}

export function isMerchantOwner(user: Staff | null): boolean {
  return (
    user?.role === 'merchant' &&
    user.merchantRole === 'owner' &&
    user.status === 'active' &&
    !user.deletedAt &&
    !!user.merchantId
  )
}

/** 页面按钮与编辑器使用同一边界；服务器仍逐次核对最新账号归属。 */
export function canEditMerchantAccount(
  actor: Staff | null,
  target: Staff,
  hasUserManagement = false
): boolean {
  if (target.role !== 'merchant' || target.deletedAt) return false
  if (isMerchantOwner(actor))
    return (
      actor!.merchantId === target.merchantId &&
      actor!.id !== target.id &&
      target.merchantRole !== 'owner'
    )
  return (
    !!actor &&
    actor.role !== 'merchant' &&
    hasUserManagement &&
    (target.merchantRole !== 'owner' || isStudioSuperAdmin(actor))
  )
}

export function canDeleteMerchantAccount(actor: Staff | null, target: Staff): boolean {
  if (target.role !== 'merchant' || target.deletedAt || target.merchantRole === 'owner')
    return false
  return (
    isStudioSuperAdmin(actor) ||
    (isMerchantOwner(actor) && actor!.merchantId === target.merchantId && actor!.id !== target.id)
  )
}

export function canAssignMerchantOwner(actor: Staff | null, target: Staff): boolean {
  return (
    isStudioSuperAdmin(actor) &&
    target.role === 'merchant' &&
    !!target.merchantId &&
    target.merchantRole !== 'owner' &&
    !target.deletedAt
  )
}

export function toFrameworkUser(user: Staff): Api.Auth.UserInfo {
  const superAdmin = isStudioSuperAdmin(user)
  return {
    userId: user.id,
    userName: user.name,
    email: '',
    buttons: [
      ...(useStudio().data.value?.permissions ?? []),
      ...(superAdmin ? ['add', 'edit', 'delete'] : [])
    ],
    roles: [superAdmin ? 'R_SUPER' : `R_STUDIO_${user.role.toUpperCase()}`]
  }
}
