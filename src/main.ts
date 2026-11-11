import App from './App.vue'
import { createApp, watch } from 'vue'
import { initStore } from './store'
import { initRouter, router } from './router'
import language from './locales'
import '@styles/core/tailwind.css'
import '@styles/index.scss'
import '@styles/business-detail.scss'
import '@utils/sys/console.ts'
import { setupGlobDirectives } from './directives'
import { setupErrorHandle } from './utils/sys/error-handle'
import { useUserStore } from './store/modules/user'
import { useStudio } from './hooks/business/useStudio'
import { toFrameworkUser } from './utils/auth/studio-user'
import { resetRouterState } from './router/guards/beforeEach'
import { useAppearanceStore } from './store/modules/appearance'
import { setPageTitle } from './utils/router'
import { studioRequest } from './api/studio'
import type { Staff } from './types/studio'
import { adminSessionUser } from './utils/auth/admin-entry'

document.addEventListener('touchstart', function () {}, { passive: false })
// 默认不显示开发工具，不从浏览器缓存推断超管身份。
document.documentElement.classList.remove('studio-super-admin')

async function bootstrap() {
  const app = createApp(App)
  initStore(app)
  const userStore = useUserStore()
  const studio = useStudio()
  const appearance = useAppearanceStore()

  // 界面偏好可以恢复，登录状态必须由服务器会话确认。
  userStore.setLoginStatus(false)
  userStore.setToken('', '')
  try {
    const session = await studioRequest<{ user: Staff | null }>('session')
    studio.user.value = adminSessionUser(session.user)
    if (studio.user.value) await studio.refresh()
    if (studio.user.value) {
      userStore.setUserInfo(toFrameworkUser(studio.user.value))
      userStore.setLoginStatus(true)
    } else {
      userStore.clearSession()
    }
  } catch (cause) {
    userStore.clearSession()
    studio.error.value = cause instanceof Error ? cause.message : '后台连接失败，请稍后重试'
  }

  watch(
    () => studio.user.value?.role,
    (role) => {
      document.documentElement.classList.toggle('studio-super-admin', role === 'super_admin')
    },
    { immediate: true, flush: 'sync' }
  )
  watch(
    () => appearance.effective.glass.enabled,
    (enabled) => {
      document.documentElement.classList.toggle('studio-glass', enabled)
    },
    { immediate: true, flush: 'sync' }
  )
  // 原主题初始化与切换会重设 html.class；业务标记由真实会话与配置恢复。
  const syncAppearanceClasses = () => {
    document.documentElement.classList.toggle(
      'studio-super-admin',
      studio.user.value?.role === 'super_admin'
    )
    document.documentElement.classList.toggle('studio-glass', appearance.effective.glass.enabled)
  }
  const appearanceClassObserver = new MutationObserver(syncAppearanceClasses)
  appearanceClassObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  })

  watch(studio.user, (user) => {
    if (user) {
      userStore.setUserInfo(toFrameworkUser(user))
    } else {
      if (userStore.isLogin) {
        userStore.clearSession()
        void router.replace({
          name: 'Login',
          query: { redirect: router.currentRoute.value.fullPath }
        })
      }
      appearance.clear()
      void appearance.loadPublic().catch(() => {})
    }
  })
  watch(
    () => studio.data.value?.appearance,
    (config) => {
      if (config) appearance.acceptServer(config)
      else if (!studio.user.value) appearance.clear()
    },
    { immediate: true }
  )
  if (!studio.user.value || studio.user.value.role === 'player') {
    try {
      await appearance.loadPublic()
    } catch {
      /* 无公开设置时使用安全默认外观。 */
    }
  }
  watch(
    () => studio.data.value?.permissions,
    (permissions) => {
      if (!permissions?.includes('settings.manage')) appearance.stopPreview()
    }
  )
  const initialIcon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  const defaultFavicon = initialIcon?.href || '/favicon.ico'
  const defaultIconType = initialIcon?.type || 'image/x-icon'
  watch(
    () => appearance.effective.logo?.url,
    (url) => {
      let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
      if (!link) {
        link = document.createElement('link')
        link.rel = 'icon'
        document.head.appendChild(link)
      }
      link.href =
        url && /^\/api\/studio\/(?:uploads|public-assets)\/[A-Za-z0-9_-]+$/.test(url)
          ? url
          : defaultFavicon
      link.type = url ? appearance.effective.logo?.mime || 'image/png' : defaultIconType
    },
    { immediate: true }
  )
  watch(
    () => appearance.effective.studioName,
    () => setPageTitle(router.currentRoute.value)
  )
  watch(
    () => studio.data.value?.permissions.join('|'),
    (permissions, previous) => {
      if (
        userStore.isLogin &&
        permissions !== undefined &&
        previous !== undefined &&
        permissions !== previous
      ) {
        resetRouterState(0)
        const current = router.currentRoute.value
        void router.replace({
          path: current.path,
          query: current.query,
          hash: current.hash,
          force: true
        })
      }
    }
  )

  initRouter(app)
  setupGlobDirectives(app)
  setupErrorHandle(app)
  app.use(language)
  app.mount('#app')
}

void bootstrap()
