import type { Attachment } from './studio'

export interface AppearanceBackground {
  mode: 'default' | 'color' | 'image'
  color: string
  image: Attachment | null
  overlay: number
}
export interface AppearanceConfig {
  studioName: string
  logo: Attachment | null
  playerOrderCardImage: Attachment | null
  page: AppearanceBackground
  hero: AppearanceBackground & { showDecoration: boolean }
  login: LoginAppearance
  glass: { enabled: boolean }
  icons: Record<string, string>
  revision: number
  updatedAt?: string
  updatedBy?: string
}
export interface LoginAppearance {
  title: string
  subtitle: string
  description: string
  illustration: { mode: 'default' | 'image'; image: Attachment | null }
  background: AppearanceBackground
}
export type PublicAppearance = Pick<AppearanceConfig, 'studioName' | 'logo' | 'login' | 'glass'>

export const APPEARANCE_ICON_TARGETS = [
  { key: 'dashboard', label: '工作台', icon: 'ri:pie-chart-line' },
  { key: 'orders', label: '订单业务', icon: 'ri:file-list-3-line' },
  { key: 'finance', label: '财务管理', icon: 'ri:wallet-3-line' },
  { key: 'personnel', label: '人员管理', icon: 'ri:team-line' },
  { key: 'system', label: '系统管理', icon: 'ri:settings-3-line' },
  { key: 'reports', label: '数据报表', icon: 'ri:file-excel-2-line' },
  { key: 'createOrder', label: '创建与派单', icon: 'ri:add-box-line' },
  { key: 'orderList', label: '订单管理', icon: 'ri:list-check-2' },
  { key: 'customers', label: '老板管理', icon: 'ri:contacts-book-line' },
  { key: 'users', label: '员工管理', icon: 'ri:user-settings-line' },
  { key: 'roles', label: '角色与权限', icon: 'ri:user-settings-line' },
  { key: 'business', label: '业务配置', icon: 'ri:gamepad-line' },
  { key: 'appearance', label: '界面外观', icon: 'ri:palette-line' },
  { key: 'logs', label: '操作日志', icon: 'ri:history-line' },
  { key: 'attendance', label: '排班与到岗', icon: 'ri:calendar-check-line' },
  { key: 'salary', label: '工资与提成', icon: 'ri:money-cny-circle-line' },
  { key: 'export', label: '自选导出', icon: 'ri:download-2-line' },
  { key: 'profile', label: '个人中心', icon: 'ri:user-line' }
] as const
const appearanceIconRouteAliases: Record<string, string> = {
  '/personnel/employees': 'users',
  '/personnel/customers': 'customers',
  '/personnel/players': 'personnel',
  '/system/user': 'users',
  '/orders/customers': 'customers',
  '/dashboard': 'dashboard',
  '/dashboard/console': 'dashboard',
  '/dashboard/analysis': 'dashboard',
  '/orders': 'orders',
  '/orders/create': 'createOrder',
  '/orders/list': 'orderList',
  '/finance': 'finance',
  '/finance/settlement': 'finance',
  '/finance/salary': 'salary',
  '/personnel': 'personnel',
  '/personnel/attendance': 'attendance',
  '/system': 'system',
  '/system/role': 'roles',
  '/system/menu': 'roles',
  '/system/business': 'business',
  '/system/appearance': 'appearance',
  '/system/logs': 'logs',
  '/system/user-center': 'profile',
  '/reports': 'reports',
  '/reports/export': 'export'
}
export function canonicalAppearanceIcons(value: Record<string, string> = {}) {
  const result = { ...value }
  for (const [path, key] of Object.entries(appearanceIconRouteAliases)) {
    if (Object.hasOwn(value, path) && !Object.hasOwn(result, key)) result[key] = value[path]
    delete result[path]
  }
  return result
}
export const APPEARANCE_ICON_OPTIONS = [
  'ri:pie-chart-line',
  'ri:dashboard-line',
  'ri:home-smile-2-line',
  'ri:file-list-3-line',
  'ri:list-check-2',
  'ri:add-box-line',
  'ri:wallet-3-line',
  'ri:money-cny-circle-line',
  'ri:funds-line',
  'ri:calendar-check-line',
  'ri:team-line',
  'ri:group-line',
  'ri:user-settings-line',
  'ri:contacts-book-line',
  'ri:settings-3-line',
  'ri:palette-line',
  'ri:gamepad-line',
  'ri:history-line',
  'ri:file-excel-2-line',
  'ri:download-2-line',
  'ri:user-line',
  'ri:shield-check-line',
  'ri:star-line',
  'ri:customer-service-2-line'
] as const
export const DEFAULT_APPEARANCE: AppearanceConfig = {
  studioName: '电竞工作室',
  logo: null,
  playerOrderCardImage: null,
  page: { mode: 'default', color: '#f5f8fc', image: null, overlay: 50 },
  hero: { mode: 'default', color: '#80b7ff', image: null, overlay: 35, showDecoration: true },
  login: {
    title: '欢迎使用电竞工作室后台',
    subtitle: '统一管理订单、人员与财务',
    description: '账号由工作室管理员分配，忘记密码请联系管理员。',
    illustration: { mode: 'default', image: null },
    background: { mode: 'default', color: '#eef4ff', image: null, overlay: 50 }
  },
  glass: { enabled: false },
  icons: {},
  revision: 0
}
export const cloneAppearance = (value: AppearanceConfig): AppearanceConfig =>
  JSON.parse(JSON.stringify(value))

/** 旧数据库外观缺少新设置时，保持原行为并补充默认值。 */
export function completeAppearance(value: AppearanceConfig): AppearanceConfig {
  const defaults = cloneAppearance(DEFAULT_APPEARANCE)
  return {
    ...defaults,
    ...value,
    playerOrderCardImage: value.playerOrderCardImage ?? null,
    icons: canonicalAppearanceIcons(value.icons),
    login: value.login
      ? {
          ...defaults.login,
          ...value.login,
          illustration: { ...defaults.login.illustration, ...value.login.illustration },
          background: { ...defaults.login.background, ...value.login.background }
        }
      : defaults.login,
    glass: value.glass ? { ...defaults.glass, ...value.glass } : defaults.glass
  }
}
