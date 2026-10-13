import type { AppRouteRecord } from '@/types/router'

export const ordersRoutes: AppRouteRecord = {
  path: '/orders',
  name: 'Orders',
  component: '/index/index',
  meta: { title: '订单业务', icon: 'ri:file-list-3-line', business: true },
  children: [
    {
      path: 'list',
      name: 'OrderList',
      component: '/orders/list',
      meta: { title: '订单管理', icon: 'ri:list-check-2', studioPermissions: ['orders.view'] }
    },
    {
      path: 'create',
      name: 'OrderCreate',
      component: '/orders/create',
      meta: { title: '创建与派单', icon: 'ri:add-box-line', studioPermissions: ['orders.create'] }
    }
  ]
}
