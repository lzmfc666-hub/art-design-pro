import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { studioRequest, uploadStudioImage } from '@/api/studio'
import type { Staff, StudioData } from '@/types/studio'
import { clearStudioImageSession } from '@/utils/studio-image'

/** 与原框架共用 Pinia；人员和业务数据不持久化到浏览器。 */
export const useStudioStore = defineStore('studio', () => {
  const data = ref<StudioData | null>(null)
  const user = ref<Staff | null>(null)
  const loading = ref(false)
  const error = ref('')
  const lastUpdatedAt = ref<string | null>(null)
  const selectedMonth = ref(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit'
    }).format(new Date())
  )
  let refreshVersion = 0

  function clearSession() {
    clearStudioImageSession()
    refreshVersion++
    loading.value = false
    user.value = null
    data.value = null
    lastUpdatedAt.value = null
  }

  async function request<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
    try {
      return await studioRequest<T>(path, body, method)
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) {
        clearSession()
      }
      throw cause
    }
  }
  async function refresh(month?: string) {
    if (month) selectedMonth.value = month
    const version = ++refreshVersion
    loading.value = true
    error.value = ''
    try {
      const path =
        typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '').split('?')[0]
      const lightOrders = path.startsWith('/orders/')
      const needsReports = [
        '/finance/salary',
        '/dashboard/console',
        '/dashboard/analysis',
        '/system/user-center',
        '/reports/export'
      ].includes(path)
      const result = await request<StudioData>(
        `bootstrap?month=${selectedMonth.value}&includeOrders=${!lightOrders}&includeReports=${needsReports}`
      )
      if (version === refreshVersion) {
        data.value = result
        user.value = result.user
        lastUpdatedAt.value = new Date().toISOString()
      }
    } catch (cause) {
      if (version !== refreshVersion) return
      error.value = cause instanceof Error ? cause.message : '加载失败'
      throw cause
    } finally {
      if (version === refreshVersion) loading.value = false
    }
  }
  async function mutate<T = unknown>(path: string, body: unknown, method = 'POST'): Promise<T> {
    const result = await request<T>(path, body, method)
    try {
      await refresh()
    } catch {
      ElMessage.warning(user.value ? '修改已保存，请刷新数据重试' : '修改已保存，请重新登录')
    }
    return result
  }
  async function login(username: string, password: string) {
    clearStudioImageSession()
    const result = await request<{ user: Staff; maintenanceNotice?: string }>(
      'login',
      { username, password },
      'POST'
    )
    user.value = result.user
    await refresh()
    return result
  }
  async function logout() {
    try {
      await request('logout', {}, 'POST')
    } finally {
      clearSession()
    }
  }
  async function upload(file: File) {
    try {
      return await uploadStudioImage(file)
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) clearSession()
      throw cause
    }
  }
  async function init() {
    const session = await request<{ user: Staff | null }>('session')
    user.value = session.user
    if (session.user) await refresh()
  }
  function can(permission: string) {
    return data.value?.permissions.includes(permission) ?? false
  }
  return {
    data,
    user,
    loading,
    error,
    lastUpdatedAt,
    selectedMonth,
    can,
    refresh,
    mutate,
    login,
    logout,
    init,
    upload,
    clearSession
  }
})
