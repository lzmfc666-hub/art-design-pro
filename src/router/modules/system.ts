import type { AppRouteRecord } from '@/types/router'

export const systemRoutes: AppRouteRecord = {
  path: '/system',
  name: 'System',
  component: '/index/index',
  meta: { title: '系统管理', icon: 'ri:settings-3-line', business: true },
  children: [
    {
      path: 'user',
      name: 'User',
      component: '/system/user',
      meta: { title: '人员管理', icon: 'ri:team-line', studioPermissions: ['users.manage'] }
    },
    {
      path: 'role',
      name: 'Role',
      component: '/system/role',
      meta: {
        title: '角色与权限',
        icon: 'ri:user-settings-line',
        studioPermissions: ['users.manage']
      }
    },
    {
      path: 'business',
      name: 'BusinessConfig',
      component: '/system/business',
      meta: {
        title: '业务配置',
        icon: 'ri:gamepad-line',
        studioPermissions: ['templates.manage', 'settings.manage']
      }
    },
    {
      path: 'menu',
      name: 'Menus',
      component: '/system/menu',
      meta: { title: '菜单权限', icon: 'ri:menu-line', studioPermissions: ['users.manage'] }
    },
    {
      path: 'logs',
      name: 'AuditLogs',
      component: '/system/logs',
      meta: { title: '操作日志', icon: 'ri:history-line', studioPermissions: ['logs.view'] }
    },
    {
      path: 'user-center',
      name: 'UserCenter',
      component: '/system/user-center',
      meta: { title: '个人中心', icon: 'ri:user-line', isHide: true }
    }
  ]
}
