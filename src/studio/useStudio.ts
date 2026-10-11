import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { Attachment, Role, OrderStatus, Staff, StudioData } from '@/types/studio'

const data = ref<StudioData | null>(null)
const user = ref<Staff | null>(null)
const loading = ref(false)
const error = ref('')
let refreshVersion = 0
const selectedMonth = ref(
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit'
  }).format(new Date())
)

async function request<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`/api/studio/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const result = await response
    .json()
    .catch(() => ({ message: '服务暂时不可用，请检查后台是否已启动' }))
  if (!response.ok) {
    if (response.status === 401) {
      user.value = null
      data.value = null
    }
    throw new Error(result.message || '操作失败，请重试')
  }
  return result as T
}

async function refresh(month?: string) {
  if (month) selectedMonth.value = month
  const version = ++refreshVersion
  loading.value = true
  error.value = ''
  try {
    const result = await request<StudioData>(`bootstrap?month=${selectedMonth.value}`)
    if (version === refreshVersion) {
      data.value = result
      user.value = result.user
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
  const result = await request<T>(path.replace(/^\//, ''), body, method)
  try {
    await refresh()
  } catch {
    ElMessage.warning(
      user.value ? '修改已保存，数据刷新失败，请点击刷新重试' : '修改已保存，请重新登录'
    )
  }
  return result
}
async function upload(file: File): Promise<Attachment> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('请上传 JPG、PNG 或 WebP 图片')
  if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MB')
  const encoded = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
  return request<Attachment>('uploads', { name: file.name, mime: file.type, data: encoded }, 'POST')
}
async function login(username: string, password: string) {
  const result = await request<{ user: Staff }>('login', { username, password }, 'POST')
  user.value = result.user
  await refresh()
}
async function logout() {
  await request('logout', {}, 'POST')
  refreshVersion++
  loading.value = false
  user.value = null
  data.value = null
}
async function init() {
  const session = await request<{ user: Staff | null }>('session')
  user.value = session.user
  if (session.user) await refresh()
}
function can(permission: string) {
  return data.value?.permissions.includes(permission) ?? false
}

export function useStudio() {
  return {
    data,
    user,
    loading,
    error,
    selectedMonth,
    can,
    refresh,
    mutate,
    upload,
    login,
    logout,
    init
  }
}
export const roleLabels: Record<Role, string> = {
  owner: '老板',
  manager: '店长',
  finance: '财务',
  hr: '人事',
  operations: '运营',
  support_lead: '客服主管',
  support: '客服',
  admin: '管理员',
  player: '打手'
}
export const statusLabels: Record<OrderStatus, string> = {
  pending: '待接单',
  active: '接单中',
  review: '待验收',
  completed: '已完成',
  canceled: '已取消'
}
export function money(value: number | null | undefined) {
  return value == null
    ? '待配置'
    : `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
export function formatTime(value?: string | null) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—'
}
