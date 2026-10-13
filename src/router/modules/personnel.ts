import type { AppRouteRecord } from '@/types/router'

export const personnelRoutes: AppRouteRecord = {
  path: '/personnel',
  name: 'Personnel',
  component: '/index/index',
  meta: { title: '人员管理', icon: 'ri:team-line', business: true },
  children: [
    {
      path: 'employees',
      name: 'User',
      component: '/system/user',
      meta: {
        title: '员工管理',
        icon: 'ri:user-settings-line',
        studioPermissions: ['users.manage']
      }
    },
    {
      path: 'customers',
      name: 'Customers',
      component: '/orders/customers',
      meta: {
        title: '老板管理',
        icon: 'ri:contacts-book-line',
        studioPermissions: ['users.manage', 'orders.create', 'finance.refunds']
      }
    },
    {
      path: 'players',
      name: 'Players',
      component: '/personnel/players',
      meta: {
        title: '打手管理',
        icon: 'ri:gamepad-line',
        studioPermissions: ['users.manage', 'finance.withdrawals']
      }
    },
    {
      path: 'attendance',
      name: 'Attendance',
      component: '/personnel/attendance',
      meta: {
        title: '排班与到岗',
        icon: 'ri:calendar-2-line',
        studioPermissions: ['attendance.manage']
      }
    }
  ]
}
