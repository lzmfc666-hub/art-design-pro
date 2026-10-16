import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { useSessionStore } from '@/stores/session'
import { useAppearanceStore } from '@/stores/appearance'
import { setUnauthorizedHandler, setPrincipalVerifier, setRequestActorProvider } from '@/api/studio'
import { setPlayerSessionVerifier } from '@/api/readScheduler'
import { onRemotePlayerSessionChanged } from '@/api/crossTabSession'
import './style.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
const session = useSessionStore(pinia)
setRequestActorProvider(() => session.user?.id)
setPrincipalVerifier((id) => !session.user || session.user.id === id)
setUnauthorizedHandler(() => {
  const redirect = router.currentRoute.value.fullPath
  session.clearSession()
  session.loginMessage = '登录状态已变化，请重新登录后确认。'
  if (!redirect.startsWith('/player/login'))
    void router.replace({ path: '/player/login', query: { redirect } })
})
app.use(router)
app.mount('#app')
const stopSessionSync = onRemotePlayerSessionChanged((phase) => {
  const redirect = router.currentRoute.value.fullPath
  // Another tab owns its login/logout request. Never call server logout or re-broadcast here.
  session.clearSession()
  session.loginMessage = phase === 'logout' || phase === 'password-updated'
    ? '账号已在其他页面退出，请重新登录' : '账号正在其他页面更改，请重新登录确认'
  if (!redirect.startsWith('/player/login'))
    void router.replace({ path: '/player/login', query: { redirect } })
})
if (import.meta.hot) import.meta.hot.dispose(stopSessionSync)
void useAppearanceStore(pinia)
  .loadPublic()
  .catch(() => {})

// One foreground coordinator combines the summary and a short-cached principal check.
setPlayerSessionVerifier(async (signal) => {
  if (!session.user) return
  const user = await session.checkSession(false, signal)
  if (!user) await router.replace('/player/login')
})
