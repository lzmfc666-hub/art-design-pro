import App from './App.vue'
import { createApp, watch } from 'vue'
import { initStore } from './store'
import { initRouter, router } from './router'
import language from './locales'
import '@styles/core/tailwind.css'
import '@styles/index.scss'
import '@utils/sys/console.ts'
import { setupGlobDirectives } from './directives'
import { setupErrorHandle } from './utils/sys/error-handle'
import { useUserStore } from './store/modules/user'
import { useStudio } from './hooks/business/useStudio'
import { toFrameworkUser } from './utils/auth/studio-user'
import { resetRouterState } from './router/guards/beforeEach'

document.addEventListener('touchstart', function () {}, { passive: false })

async function bootstrap() {
  const app = createApp(App)
  initStore(app)
  const userStore = useUserStore()
  const studio = useStudio()

  // 界面偏好可以恢复，登录状态必须由服务器会话确认。
  userStore.setLoginStatus(false)
  userStore.setToken('', '')
  try {
    await studio.init()
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

  watch(studio.user, (user) => {
    if (user) {
      userStore.setUserInfo(toFrameworkUser(user))
    } else if (userStore.isLogin) {
      userStore.clearSession()
      void router.replace({
        name: 'Login',
        query: { redirect: router.currentRoute.value.fullPath }
      })
    }
  })
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
