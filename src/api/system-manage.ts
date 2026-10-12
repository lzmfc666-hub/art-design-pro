import { ACCOUNT_TABLE_DATA } from '@/mock/temp/formData'
import { routeModules } from '@/router/modules'

/** 原模板的示例数据，与工作室真实人员及权限独立。 */
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

// 获取用户列表
export async function fetchGetUserList(params: Api.SystemManage.UserSearchParams) {
  const records: Api.SystemManage.UserListItem[] = ACCOUNT_TABLE_DATA.map((row) => ({
    id: row.id,
    avatar: row.avatar,
    status: row.status,
    userName: row.username,
    userGender: row.gender ? '男' : '女',
    nickName: row.username,
    userPhone: row.mobile,
    userEmail: row.email,
    userRoles: ['R_USER'],
    createBy: '模板示例',
    createTime: row.create_time,
    updateBy: '模板示例',
    updateTime: row.create_time
  }))
  const filtered = records.filter((row) =>
    ['userName', 'userGender', 'userPhone', 'userEmail', 'status'].every((key) => {
      const value = params[key as keyof typeof params]
      return (
        value == null ||
        value === '' ||
        String(row[key as keyof typeof row]).includes(String(value))
      )
    })
  )
  return paginate(filtered, params)
}

// 获取角色列表
export async function fetchGetRoleList(params: Api.SystemManage.RoleSearchParams) {
  const records: Api.SystemManage.RoleListItem[] = [
    {
      roleId: 1,
      roleName: '超级管理员',
      roleCode: 'R_SUPER',
      description: '原模板最高权限示例',
      enabled: true,
      createTime: '2025-01-01'
    },
    {
      roleId: 2,
      roleName: '管理员',
      roleCode: 'R_ADMIN',
      description: '原模板管理权限示例',
      enabled: true,
      createTime: '2025-01-01'
    },
    {
      roleId: 3,
      roleName: '普通用户',
      roleCode: 'R_USER',
      description: '原模板普通权限示例',
      enabled: true,
      createTime: '2025-01-01'
    }
  ]
  return paginate(
    records.filter(
      (row) =>
        (!params.roleName || row.roleName.includes(params.roleName)) &&
        (!params.roleCode || row.roleCode.includes(params.roleCode)) &&
        (!params.description || row.description.includes(params.description)) &&
        (params.enabled == null || row.enabled === params.enabled)
    ),
    params
  )
}

// 获取菜单列表
export async function fetchGetMenuList() {
  return structuredClone(routeModules)
}
