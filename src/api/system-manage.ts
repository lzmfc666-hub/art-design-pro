import { routeModules } from '@/router/modules'
import { useStudioStore } from '@/store/modules/studio'
import { roleLabels } from '@/hooks/business/useStudio'

function paginate<T>(
  records: T[],
  params: Partial<Api.Common.CommonSearchParams>
): Api.Common.PaginatedResponse<T> {
  const current = Math.max(1, Number(params.current) || 1)
  const size = Math.min(200, Math.max(1, Number(params.size) || 20))
  return {
    records: records.slice((current - 1) * size, current * size),
    total: records.length,
    current,
    size
  }
}

/** 兼容原框架 useTable 的接口形状，数据取自当前服务器人员快照。 */
export async function fetchGetUserList(params: Api.SystemManage.UserSearchParams) {
  const studio = useStudioStore()
  if (!studio.data) await studio.refresh()
  const records: Api.SystemManage.UserListItem[] = (studio.data?.users || []).map((row, index) => ({
    id: index + 1,
    avatar: '',
    status: row.status,
    userName: row.username,
    userGender: '',
    nickName: row.name,
    userPhone: '',
    userEmail: '',
    userRoles: [row.role],
    createBy: '',
    createTime: '',
    updateBy: '',
    updateTime: ''
  }))
  return paginate(
    records.filter(
      (row) =>
        (!params.userName || row.userName.includes(params.userName)) &&
        (!params.status || row.status === params.status)
    ),
    params
  )
}

/** 角色权限由服务器统一定义，列表同步真实角色和授权数量。 */
export async function fetchGetRoleList(params: Api.SystemManage.RoleSearchParams) {
  const studio = useStudioStore()
  if (!studio.data) await studio.refresh()
  const records: Api.SystemManage.RoleListItem[] = Object.entries(
    studio.data?.roleDefaults || {}
  ).map(([role, permissions], index) => ({
    roleId: index + 1,
    roleName: roleLabels[role as keyof typeof roleLabels],
    roleCode: role,
    description: `${permissions.length} 项默认业务权限`,
    enabled: true,
    createTime: ''
  }))
  return paginate(
    records.filter(
      (row) =>
        (!params.roleName || row.roleName.includes(params.roleName)) &&
        (!params.roleCode || row.roleCode.includes(params.roleCode))
    ),
    params
  )
}

/** 与路由注册使用同一份源码配置；不再返回伪造可保存菜单。 */
export async function fetchGetMenuList() {
  return structuredClone(routeModules)
}
