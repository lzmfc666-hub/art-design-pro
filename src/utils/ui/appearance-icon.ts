/** 原业务路由对应的外观图标槽位；未知路由继续使用原 meta.icon。 */
const appearanceRouteIcons = {
  '/dashboard': 'dashboard',
  '/dashboard/console': 'dashboard',
  '/dashboard/analysis': 'dashboard',
  '/orders': 'orders',
  '/orders/create': 'createOrder',
  '/orders/list': 'orderList',
  '/orders/customers': 'customers',
  '/finance': 'finance',
  '/finance/settlement': 'finance',
  '/finance/salary': 'salary',
  '/personnel': 'personnel',
  '/personnel/attendance': 'attendance',
  '/system': 'system',
  '/system/user': 'users',
  '/system/role': 'roles',
  '/system/menu': 'roles',
  '/system/business': 'business',
  '/system/appearance': 'appearance',
  '/system/logs': 'logs',
  '/system/user-center': 'profile',
  '/reports': 'reports',
  '/reports/export': 'export'
} as const

export type AppearanceRouteIconKey =
  (typeof appearanceRouteIcons)[keyof typeof appearanceRouteIcons]

export function appearanceIconForRoute(path?: string): AppearanceRouteIconKey | undefined {
  if (!path) return undefined
  const canonicalPath = path.split(/[?#]/, 1)[0].replace(/\/+$/, '')
  if (!Object.hasOwn(appearanceRouteIcons, canonicalPath)) return undefined
  return appearanceRouteIcons[canonicalPath as keyof typeof appearanceRouteIcons]
}
