import { useStudio } from './useStudio'

export function canAccessStudioPage(permissions: unknown): boolean {
  if (!Array.isArray(permissions) || permissions.length === 0) return true
  return permissions.some((permission) => useStudio().can(String(permission)))
}
