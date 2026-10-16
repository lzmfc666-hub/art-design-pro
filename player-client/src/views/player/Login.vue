<template>
  <div
    class="player-app p-login"
    :class="{ 'p-solid': !appearance.glass.enabled }"
    :style="background"
  >
    <div class="p-login-inner">
      <img
        v-if="appearance.logo"
        :src="appearance.logo.url"
        class="p-login-logo"
        alt="工作室标识"
      />
      <div v-else class="p-login-logo p-login-mark"><PlayerIcon name="lobby" /></div>
      <p class="p-eyebrow">{{ appearance.studioName }} · 打手端</p>
      <h1>{{ loginTitle }}</h1
      ><p class="p-login-subtitle">{{ appearance.login.subtitle || '开始今天的任务' }}</p>
      <img
        v-if="appearance.login.illustration.mode === 'image' && appearance.login.illustration.image"
        :src="appearance.login.illustration.image.url"
        class="p-login-illustration"
        alt="登录插图"
      />
      <form class="p-card p-login-form" @submit.prevent="login">
        <label class="p-field"
          >账号<input
            v-model.trim="username"
            name="username"
            autocomplete="username"
            autocapitalize="none"
            required
            placeholder="请输入工作室分配的账号"
        /></label>
        <label class="p-field"
          >密码<div class="p-password-input"
            ><input
              v-model="password"
              name="password"
              aria-label="密码"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              required
              placeholder="请输入密码"
            /><button type="button" class="p-text-btn" @click="showPassword = !showPassword">{{
              showPassword ? '隐藏' : '显示'
            }}</button></div
          ></label
        >
        <div v-if="error" role="alert" class="p-notice p-error">{{ error }}</div>
        <button class="p-btn p-primary p-full" :disabled="busy || !online">{{
          busy ? '正在登录…' : '登录'
        }}</button>
        <p class="p-hint">账号由工作室开通，忘记密码请联系管理员。</p>
      </form>
      <p v-if="!online" class="p-notice p-warning">网络已断开，请连接网络后登录。</p>
      <p v-if="appearance.login.description" class="p-login-description">{{
        appearance.login.description
      }}</p>
      <a :href="adminUrl" class="p-text-btn p-desktop-link">管理后台入口</a>
    </div>
  </div>
</template>
<script setup lang="ts">
  import { computed, ref, onMounted, onUnmounted } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { useAppearanceStore } from '@/stores/appearance'
  import { useSessionStore } from '@/stores/session'
  import { DEFAULT_APPEARANCE } from '@/types/appearance'
  import { playerApi } from '@/api/player'
  import { announcePlayerSession } from '@/api/crossTabSession'
  import PlayerIcon from './PlayerIcon.vue'
  import './player.css'
  const appearanceStore = useAppearanceStore(),
    studio = useSessionStore()
  const adminUrl = import.meta.env.VITE_ADMIN_URL || 'http://127.0.0.1:3006/#/auth/login'
  const appearance = computed(() => appearanceStore.publicSaved || DEFAULT_APPEARANCE)
  const loginTitle = computed(() => appearance.value.login.title.replace(/后台/g, '打手端'))
  const background = computed(() => {
    const value = appearance.value.login.background
    if (value.mode === 'image' && value.image)
      return {
        backgroundImage: `linear-gradient(rgba(235,245,255,${Math.min(1, Math.max(0, value.overlay / 100))}), rgba(235,245,255,.96)), url("${value.image.url}")`
      }
    return value.mode === 'color' ? { backgroundColor: value.color } : {}
  })
  const route = useRoute(),
    router = useRouter()
  const username = ref(''),
    password = ref(''),
    showPassword = ref(false),
    busy = ref(false),
    error = ref(studio.loginMessage),
    online = ref(navigator.onLine)
  let disposed = false
  function connection() {
    online.value = navigator.onLine
  }
  onMounted(() => {
    void appearanceStore.loadPublic().catch(() => {})
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
  })
  onUnmounted(() => {
    disposed = true
    window.removeEventListener('online', connection)
    window.removeEventListener('offline', connection)
  })
  async function login() {
    if (busy.value || !online.value) return
    busy.value = true
    error.value = ''
    const epoch = studio.epoch
    announcePlayerSession('login-start')
    try {
      const result = await playerApi.login(username.value, password.value)
      if (disposed || epoch !== studio.epoch) return
      password.value = ''
      if (result.user.role !== 'player') {
        await playerApi.logout().catch(() => {})
        studio.clearSession()
        throw new Error('此入口仅供打手账号使用，请从管理后台入口登录。')
      }
      studio.acceptUser(result.user)
      announcePlayerSession('login-complete')
      const target =
        typeof route.query.redirect === 'string' &&
        route.query.redirect.startsWith('/player/') &&
        !route.query.redirect.startsWith('/player/login')
          ? route.query.redirect
          : '/player/lobby'
      await router.replace(target)
    } catch (cause) {
      if (!disposed && epoch === studio.epoch) error.value = cause instanceof Error ? cause.message : '登录失败，请重试'
    } finally {
      busy.value = false
    }
  }
</script>
