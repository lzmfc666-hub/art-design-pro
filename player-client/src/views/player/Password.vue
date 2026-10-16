<template>
  <section class="p-page"
    ><form class="p-card" @submit.prevent="save"
      ><p class="p-hint">修改后所有旧会话失效，需要使用新密码重新登录。</p
      ><label class="p-field"
        >当前密码<input
          v-model="current"
          type="password"
          autocomplete="current-password"
          :disabled="busy || uncertain"
          required /></label
      ><label class="p-field"
        >新密码<input
          v-model="password"
          type="password"
          autocomplete="new-password"
          :disabled="busy || uncertain"
          required
          minlength="8"
          placeholder="至少 8 位" /></label
      ><label class="p-field"
        >确认新密码<input
          v-model="confirmation"
          type="password"
          autocomplete="new-password"
          :disabled="busy || uncertain"
          required
          minlength="8" /></label
      ><p v-if="error" class="p-notice p-error" role="alert">{{ error }}</p
      ><p v-if="uncertain" class="p-notice p-warning">修改结果尚未确认，请使用新密码重新登录核对，避免重复修改。</p
      ><button v-if="uncertain" type="button" class="p-btn p-secondary p-full" @click="verifyLogin">前往登录核对</button
      ><button v-else class="p-btn p-primary p-full" :disabled="busy || !online">{{
        busy ? '正在修改…' : '修改并重新登录'
      }}</button></form
    ><p v-if="!online" class="p-notice p-warning">网络已断开，连接恢复后再修改。</p></section
  >
</template>
<script setup lang="ts">
  import { ref, onMounted, onUnmounted, onDeactivated } from 'vue'
  import { useRouter } from 'vue-router'
  import { useSessionStore } from '@/stores/session'
  import { playerApi } from '@/api/player'
  import { safeApiMessage } from '@/api/studio'
  import { announcePlayerSession } from '@/api/crossTabSession'
  const current = ref(''),
    password = ref(''),
    confirmation = ref(''),
    error = ref(''),
    busy = ref(false),
    uncertain = ref(false),
    online = ref(navigator.onLine),
    router = useRouter()
  const session = useSessionStore()
  let disposed = false
  function clearPasswords() { current.value = ''; password.value = ''; confirmation.value = '' }
  function connection() {
    online.value = navigator.onLine
  }
  onMounted(() => {
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
  })
  onUnmounted(() => {
    disposed = true
    clearPasswords()
    window.removeEventListener('online', connection)
    window.removeEventListener('offline', connection)
  })
  onDeactivated(clearPasswords)
  function verifyLogin() {
    clearPasswords()
    session.clearSession()
    void router.replace('/player/login')
  }
  async function save() {
    if (busy.value || uncertain.value || !online.value) return
    error.value = ''
    if (password.value !== confirmation.value) {
      error.value = '两次输入的新密码不一致'
      return
    }
    busy.value = true
    const epoch = session.epoch
    try {
      await playerApi.password(current.value, password.value)
      if (disposed || epoch !== session.epoch) return
      current.value = ''
      password.value = ''
      confirmation.value = ''
      announcePlayerSession('password-updated')
      session.clearSession()
      await router.replace('/player/login')
    } catch (cause) {
      if (disposed || epoch !== session.epoch) return
      const result = cause as { status?: number; outcome?: string }
      uncertain.value = result.outcome === 'unknown' || !result.status || result.status === 502 || result.status === 504
      error.value = safeApiMessage(cause, uncertain.value ? '修改结果未确认，请重新登录核对' : '修改失败')
    } finally {
      if (!disposed && epoch === session.epoch) busy.value = false
    }
  }
</script>
