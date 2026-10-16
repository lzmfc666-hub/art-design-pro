<template>
  <div class="user-page art-full-height">
    <BusinessPageHeader
      title="员工管理"
      description="维护工作室员工账号、岗位角色及个人授权，账号创建与密码重置由管理员操作。"
      icon="ri:team-line"
      :badge="`${staffRows.length} 个员工账号`"
    />
    <UserSearch v-model="search" account-kind="staff" @search="applySearch" @reset="resetSearch" />
    <ElCard class="art-table-card">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="refreshData">
        <template #left
          ><ElSpace wrap
            ><ElButton v-if="isAdmin && can('users.manage')" type="primary" v-ripple @click="edit()"
              >新增员工账号</ElButton
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
          ><ElButton link type="primary" @click="showStaffDetail(row)">查看详情</ElButton
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
      default-role="support"
      account-kind="staff"
      @restore="restoreStaffEditor"
    />
    <BusinessDetailPanel
      page-key="employee-detail"
      :record-id="detailId"
      @restore="restoreStaffDetail"
      v-model="detailVisible"
      class="business-detail-drawer"
      title="员工档案详情"
      size="min(1040px,96vw)"
      destroy-on-close
    >
      <template v-if="staffDetail">
        <BusinessDetailHeader
          :title="staffDetail.name"
          description="员工账号、岗位与已有授权信息概览。"
          icon="ri:user-settings-line"
          :badge="roleLabels[staffDetail.role]"
          :context="
            staffDetail.createdAt
              ? `账号创建于 ${formatTime(staffDetail.createdAt)}`
              : '创建时间未提供'
          "
        >
          <template #actions
            ><ElButton
              v-if="
                can('users.manage') &&
                (staffDetail.role !== 'super_admin' || user?.role === 'super_admin')
              "
              type="primary"
              plain
              @click="editStaffDetail"
              >编辑档案</ElButton
            ></template
          >
        </BusinessDetailHeader>
        <BusinessDetailSummary
          :items="[
            { label: '岗位角色', value: roleLabels[staffDetail.role] },
            {
              label: '账号状态',
              value: staffDetail.status === 'active' ? '启用' : '停用',
              tone: staffDetail.status === 'active' ? 'success' : 'warning'
            },
            {
              label: '个人权限',
              value:
                can('users.manage') || staffDetail.id === user?.id
                  ? staffDetail.role === 'super_admin'
                    ? '全部权限'
                    : `${Object.keys(staffDetail.permissionOverrides || {}).length} 项覆盖`
                  : '未授权读取'
            }
          ]"
        />
        <ElTabs>
          <ElTabPane label="基础档案">
            <BusinessDetailSection title="账号资料">
              <ElDescriptions :column="2" border>
                <ElDescriptionsItem label="姓名 / 称呼">{{ staffDetail.name }}</ElDescriptionsItem>
                <ElDescriptionsItem label="登录账号">{{
                  staffDetail.username || '当前权限不提供'
                }}</ElDescriptionsItem>
                <ElDescriptionsItem label="岗位角色">{{
                  roleLabels[staffDetail.role]
                }}</ElDescriptionsItem>
                <ElDescriptionsItem label="账号状态">{{
                  staffDetail.status === 'active' ? '启用' : '停用'
                }}</ElDescriptionsItem>
                <ElDescriptionsItem label="创建时间" :span="2">{{
                  formatTime(staffDetail.createdAt)
                }}</ElDescriptionsItem>
              </ElDescriptions>
            </BusinessDetailSection>
          </ElTabPane>
          <ElTabPane label="权限明细">
            <BusinessDetailSection
              title="角色默认与个人覆盖"
              description="按当前已授权档案展示角色默认和个人设置；客服导出限制与超级管理员规则沿用原业务。"
            >
              <ElTable
                v-if="can('users.manage') || staffDetail.id === user?.id"
                :data="staffPermissions"
                max-height="440"
              >
                <ElTableColumn prop="label" label="业务权限" min-width="170" />
                <ElTableColumn label="角色默认" width="120"
                  ><template #default="{ row }">{{
                    row.inherited ? '允许' : '禁止'
                  }}</template></ElTableColumn
                >
                <ElTableColumn label="个人设置" min-width="150"
                  ><template #default="{ row }">{{ row.override }}</template></ElTableColumn
                >
              </ElTable>
              <ElEmpty v-else description="当前账号无权读取此员工的个人权限明细" />
            </BusinessDetailSection>
          </ElTabPane>
        </ElTabs>
      </template>
      <ElEmpty v-else description="档案已变化或当前账号无权查看，请刷新名单" />
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, reactive, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { useStudio, roleLabels, formatTime } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Role, Staff } from '@/types/studio'
  import UserSearch, { type UserSearch as SearchParams } from './modules/user-search.vue'
  import UserDialog from './modules/user-dialog.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import { permissionLabels } from './modules/permissions'

  defineOptions({ name: 'User' })
  const { data, user, loading, can, refresh } = useStudio()
  const isAdmin = computed(() => ['super_admin', 'admin'].includes(user.value?.role || ''))
  const emptySearch = (): SearchParams => ({ name: '', username: '', role: '', status: '' })
  const search = ref<SearchParams>(emptySearch())
  const applied = reactive<SearchParams>(emptySearch())
  const route = useRoute()
  watch(
    [() => route.query.name, () => route.query.username, () => route.query.keyword],
    ([name, username, keyword]) => {
      if (route.path !== '/personnel/employees') return
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
      if (route.path !== '/personnel/employees') return
      const role =
        typeof value === 'string' && value !== 'player' && value in roleLabels ? value : ''
      search.value.role = role
      applied.role = role
    },
    { immediate: true }
  )
  const staffRows = computed(() => (data.value?.users || []).filter((row) => row.role !== 'player'))
  const detailVisible = ref(false)
  const detailId = ref('')
  const staffDetail = computed(() => staffRows.value.find((row) => row.id === detailId.value))
  function showStaffDetail(row: Staff) {
    detailId.value = row.id
    detailVisible.value = true
  }
  async function restoreStaffDetail({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      const row = staffRows.value.find((item) => item.id === recordId)
      if (row) showStaffDetail(row)
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  async function restoreStaffEditor({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (!can('users.manage')) return
      if (recordId === 'new') {
        if (isAdmin.value) edit()
      } else {
        const row = staffRows.value.find((item) => item.id === recordId)
        if (row) edit(row)
      }
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  function editStaffDetail() {
    const row = staffDetail.value
    if (!row) return
    edit(row)
  }
  const staffPermissions = computed(() =>
    Object.entries(permissionLabels).map(([key, label]) => ({
      label,
      inherited:
        staffDetail.value?.role === 'super_admin' ||
        (staffDetail.value && data.value?.roleDefaults?.[staffDetail.value.role]?.includes(key)),
      override:
        staffDetail.value?.role === 'super_admin'
          ? '全部允许'
          : key === 'reports.export' &&
              ['support', 'support_lead'].includes(staffDetail.value?.role || '')
            ? '固定不可导出'
            : staffDetail.value?.permissionOverrides?.[key] === undefined
              ? '继承角色'
              : staffDetail.value.permissionOverrides[key]
                ? '允许'
                : '禁止'
    }))
  )
  const filteredRows = computed(() =>
    staffRows.value.filter(
      (row) =>
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
    { prop: 'status', label: '状态', width: 100, useSlot: true },
    { prop: 'permissionOverrides', label: '个人权限', width: 120, useSlot: true },
    { prop: 'operation', label: '操作', width: 205, fixed: 'right', useSlot: true }
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
