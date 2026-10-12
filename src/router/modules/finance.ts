import type { AppRouteRecord } from '@/types/router'

export const financeRoutes: AppRouteRecord = {
  path: '/finance',
  name: 'Finance',
  component: '/index/index',
  meta: { title: '财务管理', icon: 'ri:wallet-3-line', business: true },
  children: [
    {
      path: 'settlement',
      name: 'Settlement',
      component: '/finance/settlement',
      meta: {
        title: '验收与结算',
        icon: 'ri:checkbox-circle-line',
        studioPermissions: [
          'finance.review',
          'finance.refunds',
          'finance.withdrawals',
          'finance.expenses'
        ]
      }
    },
    {
      path: 'salary',
      name: 'Salary',
      component: '/finance/salary',
      meta: {
        title: '工资与提成',
        icon: 'ri:money-cny-circle-line',
        studioPermissions: ['salary.view', 'salary.all', 'salary.manage']
      }
    }
  ]
}
