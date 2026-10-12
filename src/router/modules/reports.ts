import type { AppRouteRecord } from '@/types/router'

export const reportsRoutes: AppRouteRecord = {
  path: '/reports',
  name: 'Reports',
  component: '/index/index',
  meta: {
    title: '数据报表',
    icon: 'ri:file-excel-2-line',
    business: true,
    studioPermissions: ['reports.export']
  },
  children: [
    {
      path: 'export',
      name: 'ReportExport',
      component: '/reports/export',
      meta: {
        title: '自选导出',
        icon: 'ri:download-2-line',
        business: true,
        studioPermissions: ['reports.export']
      }
    }
  ]
}
