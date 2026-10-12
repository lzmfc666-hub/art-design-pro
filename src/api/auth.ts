import { useStudio } from '@/studio/useStudio'
import { toFrameworkUser } from '@/studio/framework-auth'

/** 使用工作室服务器会话，保留原框架的登录及路由流程。 */
export async function fetchLogin(params: Api.Auth.LoginParams) {
  await useStudio().login(params.userName, params.password)
  return fetchGetUserInfo()
}

export async function fetchGetUserInfo(): Promise<Api.Auth.UserInfo> {
  const studio = useStudio()
  if (!studio.user.value || !studio.data.value) await studio.refresh()
  if (!studio.user.value) throw new Error('登录已失效，请重新登录')
  return toFrameworkUser(studio.user.value)
}
