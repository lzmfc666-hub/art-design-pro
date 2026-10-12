import type { Staff } from '@/types/studio'
import { useStudio } from './useStudio'

export function isStudioSuperAdmin(user: Staff | null): boolean {
  return user?.role === 'super_admin'
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
