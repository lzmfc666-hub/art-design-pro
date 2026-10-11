import { createRouter, createWebHashHistory } from 'vue-router'

export const studioRouter = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    {
      path: '/overview',
      component: () => import('./pages/OverviewPage.vue'),
      meta: { title: '数据概览' }
    },
    {
      path: '/dispatch',
      component: () => import('./pages/DispatchPage.vue'),
      meta: { title: '快捷下单' }
    },
    {
      path: '/orders',
      component: () => import('./pages/OrdersPage.vue'),
      meta: { title: '订单管理' }
    },
    {
      path: '/catalog',
      component: () => import('./pages/CatalogPage.vue'),
      meta: { title: '游戏与业务配置' }
    },
    {
      path: '/people',
      component: () => import('./pages/PeoplePage.vue'),
      meta: { title: '用户管理' }
    },
    {
      path: '/attendance',
      component: () => import('./pages/AttendancePage.vue'),
      meta: { title: '人事考勤' }
    },
    {
      path: '/finance',
      component: () => import('./pages/FinancePage.vue'),
      meta: { title: '财务管理' }
    },
    { path: '/logs', component: () => import('./pages/LogsPage.vue'), meta: { title: '操作日志' } },
    { path: '/:pathMatch(.*)*', redirect: '/overview' }
  ],
  scrollBehavior: () => ({ top: 0 })
})
studioRouter.afterEach((to) => {
  document.title = `${to.meta.title || '工作台'} · 金盾电竞`
})
