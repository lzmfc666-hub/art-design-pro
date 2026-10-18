import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { createNavigationLoadRecovery } from '@/api/navigationRecovery'

const page = (
  path: string,
  name: string,
  title: string,
  component: NonNullable<RouteRecordRaw['component']>
): RouteRecordRaw => ({ path, name, component, meta: { title } })
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/player/lobby' },
  page('/player/login', 'PlayerLogin', '打手登录', () => import('@/views/player/Login.vue')),
  {
    path: '/player',
    component: () => import('@/views/player/PlayerShell.vue'),
    redirect: '/player/lobby',
    children: [
      page('lobby', 'PlayerLobby', '接单大厅', () => import('@/views/player/Lobby.vue')),
      page('tasks', 'PlayerTasks', '我的任务', () => import('@/views/player/Tasks.vue')),
      page('rank', 'PlayerLeaderboard', '排行榜', () => import('@/views/player/Leaderboard.vue')),
      page('me', 'PlayerMe', '我的', () => import('@/views/player/Me.vue')),
      page(
        'content/:id',
        'PlayerContentDetail',
        '公告与板报',
        () => import('@/views/player/ContentDetail.vue')
      ),
      page(
        'orders/:id',
        'PlayerOrderDetail',
        '任务详情',
        () => import('@/views/player/OrderDetail.vue')
      ),
      page('wallet', 'PlayerWallet', '报酬钱包', () => import('@/views/player/Wallet.vue')),
      page('ledger', 'PlayerLedger', '收支明细', () => import('@/views/player/Ledger.vue')),
      page(
        'withdrawals',
        'PlayerWithdrawals',
        '提现记录',
        () => import('@/views/player/Withdrawals.vue')
      ),
      page('deposit', 'PlayerDeposit', '独立押金', () => import('@/views/player/Deposit.vue')),
      page('payment', 'PlayerPayment', '收款码', () => import('@/views/player/Payment.vue')),
      page('profile', 'PlayerProfile', '个人资料', () => import('@/views/player/Profile.vue')),
      page('password', 'PlayerPassword', '修改密码', () => import('@/views/player/Password.vue')),
      page('messages', 'PlayerMessages', '消息中心', () => import('@/views/player/Messages.vue')),
      page(
        'notifications',
        'PlayerNotificationSettings',
        '通知设置',
        () => import('@/views/player/NotificationSettings.vue')
      )
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/player/lobby' }
]
export const router = createRouter({ history: createWebHashHistory(), routes })
const builtInRouteNames = new Set<string | symbol>()
const registerNames = (records: RouteRecordRaw[]) => {
  for (const record of records) {
    if (record.name) builtInRouteNames.add(record.name)
    if (record.children) registerNames(record.children)
  }
}
registerNames(routes)
export const navigationLoadRecovery = createNavigationLoadRecovery({
  resolveTarget(target) {
    const matched = router.resolve(target)
    return matched.name && builtInRouteNames.has(matched.name) ? matched.fullPath : null
  },
  href: () => window.location.href,
  replaceHref: href => window.history.replaceState(window.history.state, '', href),
  reload: () => window.location.reload()
})
router.onError((error, to) => {
  if (!navigationLoadRecovery.report(error, to.fullPath)) {
    navigationLoadRecovery.clear()
    console.error(error)
  }
})
router.beforeEach(async (to) => {
  const session = useSessionStore()
  if (to.path === '/player/login') return true
  try {
    if (await session.checkSession()) return true
  } catch (cause) {
    if ((cause as { status?: number }).status !== 401)
      session.loginMessage = cause instanceof Error ? cause.message : '后台连接失败，请重试'
  }
  return { path: '/player/login', query: { redirect: to.fullPath } }
})
router.afterEach((to, _from, failure) => {
  if (!failure) navigationLoadRecovery.clear()
  document.title = `${String(to.meta.title || '打手端')} · 工作室打手端`
})
