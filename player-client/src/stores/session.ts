import { ref } from 'vue'
import { defineStore } from 'pinia'
import { playerApi } from '@/api/player'
import type { Staff } from '@/types/studio'
import { invalidateSessionRequests } from '@/api/sessionBoundary'

/** Player sessions stay in memory; no admin state, menus or browser persistence. */
export const useSessionStore = defineStore('player-session', () => {
  const user = ref<Staff | null>(null)
  const epoch = ref(0)
  const loginMessage = ref('')
  let version = 0
  let verifiedAt = 0
  let inFlight: Promise<Staff | null> | null = null
  function closeDeviceNotifications(type: 'player-session-ended' | 'player-session-changed') {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type })
    else void navigator.serviceWorker.getRegistration()
      .then((registration) => registration?.active?.postMessage({ type })).catch(() => {})
  }
  function clearSession() {
    closeDeviceNotifications('player-session-ended')
    version++
    epoch.value++
    invalidateSessionRequests()
    user.value = null
    verifiedAt = 0
    inFlight = null
  }
  const permissionSnapshot = (value: Staff) => JSON.stringify({
    id: value.id, role: value.role, status: value.status, playerAccess: value.playerAccess,
    levelId: value.levelId, maxActiveOrders: value.maxActiveOrders,
    permissionOverrides: (value as Staff & { permissionOverrides?: unknown }).permissionOverrides,
    permissions: (value as Staff & { permissions?: unknown }).permissions
  })
  function acceptUser(value: Staff) {
    if (value.role !== 'player') throw new Error('此入口仅供打手账号使用，请从管理后台入口登录。')
    if (!user.value || permissionSnapshot(user.value) !== permissionSnapshot(value)) {
      if (user.value?.id !== value.id) closeDeviceNotifications('player-session-changed')
      version++
      epoch.value++
      invalidateSessionRequests(user.value?.id === value.id ? 'permissions' : 'account')
    }
    user.value = value
    verifiedAt = Date.now()
    loginMessage.value = ''
  }
  /** A short display/session cache reduces duplicate reads; business eligibility remains server-side. */
  async function checkSession(force = false, signal?: AbortSignal) {
    if (!force && user.value && Date.now() - verifiedAt < 30000) return user.value
    if (inFlight) return inFlight
    const requestVersion = version
    const pending = (async () => {
      const result = await playerApi.session(signal)
      if (requestVersion !== version) return user.value
      if (result.user && result.user.role !== 'player') {
        await playerApi.logout().catch(() => {})
        clearSession()
        loginMessage.value = '此入口仅供打手账号使用，请从管理后台入口登录。'
        return null
      }
      if (result.user) acceptUser(result.user)
      else if (user.value) clearSession()
      verifiedAt = Date.now()
      return user.value
    })().finally(() => {
      if (inFlight === pending) inFlight = null
    })
    inFlight = pending
    return inFlight
  }
  return { user, epoch, loginMessage, acceptUser, clearSession, checkSession }
})
