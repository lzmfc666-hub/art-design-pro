import type { AppRouteRecord } from '@/types/router'

export const merchantsRoutes: AppRouteRecord = {
  path: '/merchants/manage',
  name: 'MerchantManagement',
  component: '/merchants/manage',
  meta: {
    title: '商家管理',
    icon: 'ri:store-2-line',
    business: true,
    studioPermissions: ['users.manage', 'templates.manage'],
    keepAlive: false
  }
}
