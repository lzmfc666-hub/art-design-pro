import { AppRouteRecord } from '@/types/router'

// 示例使用独立名称，避免动态路由注销时移除系统的静态错误页。
export const exceptionRoutes: AppRouteRecord = {
  path: '/exception',
  name: 'Exception',
  component: '/index/index',
  meta: {
    title: 'menus.exception.title',
    icon: 'ri:error-warning-line'
  },
  children: [
    {
      path: '403',
      name: 'ExceptionDemo403',
      component: '/exception/403',
      meta: {
        title: 'menus.exception.forbidden',
        keepAlive: true,
        isHideTab: true,
        isFullPage: true
      }
    },
    {
      path: '404',
      name: 'ExceptionDemo404',
      component: '/exception/404',
      meta: {
        title: 'menus.exception.notFound',
        keepAlive: true,
        isHideTab: true,
        isFullPage: true
      }
    },
    {
      path: '500',
      name: 'ExceptionDemo500',
      component: '/exception/500',
      meta: {
        title: 'menus.exception.serverError',
        keepAlive: true,
        isHideTab: true,
        isFullPage: true
      }
    }
  ]
}
