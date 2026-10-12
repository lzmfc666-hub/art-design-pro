import type { AppRouteRecord } from '@/types/router'

export const personnelRoutes: AppRouteRecord = {
  path: '/personnel',
  name: 'Personnel',
  component: '/index/index',
  meta: { title: '排班考勤', icon: 'ri:calendar-check-line', business: true },
  children: [
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
