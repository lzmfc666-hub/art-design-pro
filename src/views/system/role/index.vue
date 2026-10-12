<template>
  <div class="art-full-height">
    <ArtSearchBar
      v-model="search"
      :items="searchItems"
      @search="applySearch"
      @reset="resetSearch"
    />
    <ElCard class="art-table-card">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="refreshData">
        <template #left
          ><ElSpace
            ><span class="font-medium">角色默认权限</span
            ><ElTag type="info">来源：服务器权限定义</ElTag></ElSpace
          ></template
        >
      </ArtTableHeader>
      <ElAlert
        class="mb-4"
        type="info"
        :closable="false"
        title="岗位沿用业务固定角色。员工的额外授权或限制在“人员管理 → 编辑档案 → 个人权限”中设置；超级管理员始终拥有全部权限。"
      />
      <ArtTable
        :data="tableData"
        :columns="columns"
        :pagination="pagination"
        :loading="loading"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
      >
        <template #role="{ row }"
          ><ElTag>{{ roleLabels[row.role as Role] }}</ElTag></template
        >
        <template #permissions="{ row }"
          ><ElSpace wrap
            ><ElTag
              v-for="permission in row.permissions.slice(0, 3)"
              :key="permission"
              type="info"
              >{{ permissionLabels[permission] || permission }}</ElTag
            ><span v-if="row.permissions.length > 3" class="text-g-500"
              >等 {{ row.permissions.length }} 项</span
            ><span v-if="!row.permissions.length" class="text-g-500"
              >无管理端业务权限</span
            ></ElSpace
          ></template
        >
        <template #operation="{ row }"
          ><ElButton type="primary" link @click="showPermissions(row.role)">查看权限</ElButton
          ><ElButton
            type="primary"
            link
            @click="router.push({ path: '/system/user', query: { role: row.role } })"
            >管理人员</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <RolePermissionDialog v-model="permissionVisible" :role="selectedRole" />
  </div>
</template>

<script setup lang="ts">
  import { computed, reactive, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { roleLabels, useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Role } from '@/types/studio'
  import { permissionLabels } from '../user/modules/permissions'
  import RolePermissionDialog from './modules/role-permission-dialog.vue'

  defineOptions({ name: 'Role' })
  interface RoleRow {
    role: Role
    code: string
    permissions: string[]
    members: number
    overrides: number
  }
  const router = useRouter()
  const { data, loading, refresh } = useStudio()
  const search = ref({ keyword: '' })
  const applied = reactive({ keyword: '' })
  const searchItems = [
    {
      key: 'keyword',
      type: 'input',
      label: '角色名称 / 编码',
      props: { placeholder: '搜索岗位角色', clearable: true }
    }
  ]
  const rows = computed<RoleRow[]>(() =>
    Object.entries(data.value?.roleDefaults || {})
      .filter(([role]) =>
        `${role} ${roleLabels[role as Role]}`.toLowerCase().includes(applied.keyword.toLowerCase())
      )
      .map(([role, permissions]) => {
        const members = data.value?.users.filter((staff) => staff.role === role) || []
        return {
          role: role as Role,
          code: role,
          permissions,
          members: members.length,
          overrides: members.filter((staff) => Object.keys(staff.permissionOverrides).length).length
        }
      })
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<RoleRow>(() => [
    { prop: 'role', label: '岗位角色', width: 140, useSlot: true },
    { prop: 'code', label: '角色编码', minWidth: 140 },
    { prop: 'permissions', label: '默认业务权限', minWidth: 320, useSlot: true },
    { prop: 'members', label: '人员数量', width: 110 },
    { prop: 'overrides', label: '个人权限覆盖人数', width: 155 },
    { prop: 'operation', label: '操作', width: 190, fixed: 'right', useSlot: true }
  ])
  const permissionVisible = ref(false)
  const selectedRole = ref<Role>('support')
  function showPermissions(role: Role) {
    selectedRole.value = role
    permissionVisible.value = true
  }
  function applySearch() {
    applied.keyword = search.value.keyword || ''
    resetPage()
  }
  function resetSearch() {
    search.value.keyword = ''
    applySearch()
  }
  async function refreshData() {
    try {
      await refresh()
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '刷新失败')
    }
  }
</script>
