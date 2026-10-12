import type { AppRouteRecord } from '@/types/router'

/** 工作室业务作为原框架的一个模块，沿用其布局、标签页和主题。 */
export const studioRoutes: AppRouteRecord = {
  path: '/',
  name: 'Studio',
  component: '/index/index',
  meta: { title: '工作室管理', icon: 'ri:gamepad-line' },
  children: [
    {
      path: 'overview',
      name: 'StudioOverview',
      component: '/studio/overview',
      meta: { title: '工作台', icon: 'ri:dashboard-line', fixedTab: true }
    },
    {
      path: 'dispatch',
      name: 'StudioDispatch',
      component: '/studio/dispatch',
      meta: { title: '下单与派单', icon: 'ri:add-box-line', studioPermissions: ['orders.create'] }
    },
    {
      path: 'orders',
      name: 'StudioOrders',
      component: '/studio/orders',
      meta: { title: '订单管理', icon: 'ri:file-list-3-line', studioPermissions: ['orders.view'] }
    },
    {
      path: 'catalog',
      name: 'StudioCatalog',
      component: '/studio/catalog',
      meta: {
        title: '业务配置',
        icon: 'ri:settings-3-line',
        studioPermissions: ['templates.manage', 'settings.manage']
      }
    },
    {
      path: 'people',
      name: 'StudioPeople',
      component: '/studio/people',
      meta: { title: '人员与权限', icon: 'ri:team-line', studioPermissions: ['users.manage'] }
    },
    {
      path: 'attendance',
      name: 'StudioAttendance',
      component: '/studio/attendance',
      meta: {
        title: '排班与考勤',
        icon: 'ri:calendar-check-line',
        studioPermissions: ['attendance.manage']
      }
    },
    {
      path: 'finance',
      name: 'StudioFinance',
      component: '/studio/finance',
      meta: {
        title: '财务与薪资',
        icon: 'ri:wallet-3-line',
        studioPermissions: [
          'finance.review',
          'finance.refunds',
          'finance.withdrawals',
          'finance.expenses',
          'salary.view',
          'salary.all',
          'salary.manage',
          'profit.view'
        ]
      }
    },
    {
      path: 'logs',
      name: 'StudioLogs',
      component: '/studio/logs',
      meta: { title: '操作日志', icon: 'ri:history-line', studioPermissions: ['logs.view'] }
    },
    {
      path: 'profile',
      name: 'StudioProfile',
      component: '/studio/profile',
      meta: { title: '个人资料', icon: 'ri:user-line', isHide: true }
    }
  ]
}
