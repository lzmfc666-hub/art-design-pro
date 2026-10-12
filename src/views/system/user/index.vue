<template>
  <div class="user-page art-full-height">
    <BusinessPageHeader
      title="人员管理"
      description="集中维护员工与打手账号，管理角色、个人授权、等级和同时接单上限。"
      icon="ri:team-line"
      :badge="`${data?.users.length || 0} 个账号`"
    />
    <UserSearch v-model="search" @search="applySearch" @reset="resetSearch" />
    <ElCard class="art-table-card">
      <ElTabs v-model="tab" @tab-change="resetPage"
        ><ElTabPane label="员工档案" name="staff" /><ElTabPane label="打手档案" name="players"
      /></ElTabs>
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="refreshData">
        <template #left
          ><ElSpace wrap
            ><ElButton
              v-if="isAdmin && can('users.manage')"
              type="primary"
              v-ripple
              @click="edit()"
              >{{ tab === 'players' ? '新增打手账号' : '新增员工账号' }}</ElButton
            ><span class="text-sm text-g-500"
              >共 {{ filteredRows.length }} 人 · 账号创建与密码重置由管理员操作</span
            ></ElSpace
          ></template
        >
      </ArtTableHeader>
      <ArtTable
        :data="tableData"
        :loading="loading"
        :columns="columns"
        :pagination="pagination"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
      >
        <template #role="{ row }"
          ><ElTag>{{ roleLabels[row.role as Role] }}</ElTag></template
        >
        <template #name="{ row }"
          ><div class="flex items-center gap-3"
            ><ElAvatar :size="32" class="!bg-theme/10 !text-theme">{{
              row.name.slice(0, 1)
            }}</ElAvatar
            ><span class="font-medium">{{ row.name }}</span></div
          ></template
        >
        <template #levelId="{ row }">{{
          row.role === 'player'
            ? data?.levels.find((level) => level.id === row.levelId)?.name || '未设置'
            : '—'
        }}</template>
        <template #maxActiveOrders="{ row }">{{
          row.role === 'player' ? `${row.activeOrders ?? 0} / ${row.maxActiveOrders}` : '—'
        }}</template>
        <template #status="{ row }"
          ><ElTag :type="row.status === 'active' ? 'success' : 'info'">{{
            row.status === 'active' ? '启用' : '停用'
          }}</ElTag></template
        >
        <template #permissionOverrides="{ row }">{{
          row.role === 'super_admin'
            ? '全部权限'
            : `${Object.keys(row.permissionOverrides || {}).length} 项覆盖`
        }}</template>
        <template #operation="{ row }"
          ><ElButton
            v-if="
              can('users.manage') && (row.role !== 'super_admin' || user?.role === 'super_admin')
            "
            link
            type="primary"
            @click="edit(row)"
            >编辑档案</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <UserDialog
      v-model:visible="dialogVisible"
      :row="currentRow"
      :default-role="tab === 'players' ? 'player' : 'support'"
    />
  </div>
</template>

<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { useStudio, roleLabels } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Role, Staff } from '@/types/studio'
  import UserSearch, { type UserSearch as SearchParams } from './modules/user-search.vue'
  import UserDialog from './modules/user-dialog.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'

  defineOptions({ name: 'User' })
  const { data, user, loading, can, refresh } = useStudio()
  const isAdmin = computed(() => ['super_admin', 'admin'].includes(user.value?.role || ''))
  const tab = ref('staff')
  const emptySearch = (): SearchParams => ({ name: '', username: '', role: '', status: '' })
  const search = ref<SearchParams>(emptySearch())
  const applied = reactive<SearchParams>(emptySearch())
  const route = useRoute()
  watch(
    [() => route.query.name, () => route.query.username, () => route.query.keyword],
    ([name, username, keyword]) => {
      if (route.path !== '/system/user') return
      search.value.name =
        typeof name === 'string' ? name : typeof keyword === 'string' ? keyword : ''
      search.value.username = typeof username === 'string' ? username : ''
      applied.name = search.value.name
      applied.username = search.value.username
    },
    { immediate: true }
  )
  watch(
    () => route.query.role,
    (value) => {
      if (route.path !== '/system/user') return
      const role = typeof value === 'string' && value in roleLabels ? value : ''
      search.value.role = role
      applied.role = role
      tab.value = role === 'player' ? 'players' : 'staff'
    },
    { immediate: true }
  )
  const filteredRows = computed(() =>
    (data.value?.users || []).filter(
      (row) =>
        (tab.value === 'players' ? row.role === 'player' : row.role !== 'player') &&
        row.name.toLowerCase().includes((applied.name || '').trim().toLowerCase()) &&
        row.username.toLowerCase().includes((applied.username || '').trim().toLowerCase()) &&
        (!applied.role || row.role === applied.role) &&
        (!applied.status || row.status === applied.status)
    )
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(filteredRows)
  const { columns, columnChecks } = useTableColumns<Staff>(() => [
    { prop: 'name', label: '姓名 / 称呼', minWidth: 160, useSlot: true },
    { prop: 'username', label: '登录账号', minWidth: 150 },
    { prop: 'role', label: '角色', width: 130, useSlot: true },
    { prop: 'levelId', label: '打手等级', minWidth: 120, useSlot: true },
    { prop: 'maxActiveOrders', label: '接单数量 / 上限', width: 150, useSlot: true },
    { prop: 'status', label: '状态', width: 100, useSlot: true },
    { prop: 'permissionOverrides', label: '个人权限', width: 120, useSlot: true },
    { prop: 'operation', label: '操作', width: 110, fixed: 'right', useSlot: true }
  ])
  const dialogVisible = ref(false)
  const currentRow = ref<Staff>()
  function edit(row?: Staff) {
    currentRow.value = row
    dialogVisible.value = true
  }
  function applySearch() {
    Object.assign(applied, emptySearch(), search.value)
    resetPage()
  }
  function resetSearch() {
    search.value = emptySearch()
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
