import type { AppRouteRecord } from '@/types/router'

export const merchantRoutes: AppRouteRecord = {
  path: '/merchant',
  name: 'Merchant',
  component: '/index/index',
  meta: { title: '商家工作台', icon: 'ri:store-2-line', business: true },
  children: [
    { path: 'overview', name: 'MerchantOverview', component: '/merchant/overview', meta: { title: '商家看板', icon: 'ri:dashboard-line' } },
    { path: 'orders', name: 'MerchantOrders', component: '/orders/list', meta: { title: '本商家订单', icon: 'ri:file-list-3-line', studioPermissions: ['orders.view'] } },
    { path: 'create', name: 'MerchantCreate', component: '/orders/create', meta: { title: '发布订单', icon: 'ri:add-box-line', studioPermissions: ['orders.create'] } },
    { path: 'profile', name: 'MerchantProfile', component: '/merchant/profile', meta: { title: '账号与通知', icon: 'ri:user-settings-line' } }
  ]
}
