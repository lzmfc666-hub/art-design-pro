const ADMIN_HOME = '/dashboard/console'

/** 旧打手会话不能改变管理后台入口，也不撤销独立打手端的登录。 */
export function adminSessionUser<T extends { role: string }>(user: T | null | undefined): T | null {
  return user && user.role !== 'player' ? user : null
}

export function isPlayerEntryPath(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0]
  return path === '/player' || path.startsWith('/player/')
}

/** 管理后台登录成功后，仅恢复管理后台内部的目标页面。 */
export function adminLoginRedirect(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value === '/auth' ||
    value.startsWith('/auth/') ||
    isPlayerEntryPath(value)
  ) {
    return ADMIN_HOME
  }
  return value
}
