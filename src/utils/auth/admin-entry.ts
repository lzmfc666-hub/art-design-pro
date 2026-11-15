const ADMIN_HOME = '/dashboard/console'

/** 旧打手会话不能改变管理后台入口，也不撤销独立打手端的登录。 */
export function adminSessionUser<T extends { role: string }>(user: T | null | undefined): T | null {
  return user && !['player', 'merchant'].includes(user.role) ? user : null
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
    isPlayerEntryPath(value) ||
    studioClientForPath(value) === 'merchant'
  ) {
    return ADMIN_HOME
  }
  return value
}

/** 商家通道按入口选择，身份及商家归属仍由服务端会话核验。 */
export function studioClientForPath(path: string): 'admin' | 'merchant' {
  return /^\/merchant(?:[/?#]|$)/.test(path) ? 'merchant' : 'admin'
}

export const studioClient = studioClientForPath(
  typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '')
)

export function merchantLoginRedirect(value: unknown): string {
  if (typeof value !== 'string' || !/^\/merchant\/(overview|orders|create|profile)(?:[?#]|$)/.test(value) || value.includes('\\'))
    return '/merchant/overview'
  return value
}

export function merchantOrderPayload(
  form: { templateId: string; roomCode?: string; gameId?: string; map?: string; dispatchMode?: string; assignedTo?: string; playerRemark?: string },
  template: { id: string; revision?: number } | undefined
) {
  if (!template || template.id !== form.templateId || !template.revision)
    throw new Error('模板已变化，请刷新模板后重新选择')
  return {
    templateId: form.templateId,
    expectedTemplateRevision: template.revision,
    roomCode: form.roomCode || '',
    gameId: form.gameId || '',
    map: form.map || '不限',
    dispatchMode: form.dispatchMode || 'pool',
    assignedTo: form.assignedTo || null,
    playerRemark: form.playerRemark || '报响箭电竞'
  }
}
