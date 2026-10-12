import { AppRouteRecord } from '@/types/router'
import { dashboardRoutes } from './dashboard'
import { templateRoutes } from './template'
import { widgetsRoutes } from './widgets'
import { examplesRoutes } from './examples'
import { systemRoutes } from './system'
import { articleRoutes } from './article'
import { resultRoutes } from './result'
import { exceptionRoutes } from './exception'
import { safeguardRoutes } from './safeguard'
import { helpRoutes } from './help'
import { ordersRoutes } from './orders'
import { financeRoutes } from './finance'
import { personnelRoutes } from './personnel'

/**
 * 导出所有模块化路由
 */
export const routeModules: AppRouteRecord[] = [
  dashboardRoutes,
  ordersRoutes,
  financeRoutes,
  personnelRoutes,
  systemRoutes,
  templateRoutes,
  widgetsRoutes,
  examplesRoutes,
  articleRoutes,
  resultRoutes,
  exceptionRoutes,
  safeguardRoutes,
  ...helpRoutes
].map((route) =>
  route.meta.business ? route : { ...route, meta: { ...route.meta, templateExample: true } }
)
