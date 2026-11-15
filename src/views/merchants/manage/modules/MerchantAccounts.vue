<template>
  <div class="merchant-accounts">
    <ArtSearchBar
      v-model="search"
      :items="searchItems"
      @search="applySearch"
      @reset="resetSearch"
    />
    <ElCard class="art-table-card" shadow="never">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="refreshData">
        <template #left>
          <ElSpace wrap>
            <ElButton v-if="isAdmin && can('users.manage')" type="primary" @click="edit()">
              新增商家账号
            </ElButton>
            <span class="text-sm text-g-500">共 {{ filteredRows.length }} 个商家账号</span>
          </ElSpace>
        </template>
      </ArtTableHeader>
      <ArtTable
        :data="tableData"
        :loading="loading"
        :columns="columns"
        :pagination="pagination"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
      >
        <template #merchantId="{ row }">{{ merchantName(row.merchantId) }}</template>
        <template #status="{ row }">
          <ElTag :type="row.status === 'active' ? 'success' : 'info'">
            {{ row.status === 'active' ? '启用' : '停用' }}
          </ElTag>
        </template>
        <template #operation="{ row }">
          <ElButton v-if="can('users.manage')" link type="primary" @click="edit(row)">
            编辑账号
          </ElButton>
          <span v-else class="text-g-500">无编辑权限</span>
        </template>
      </ArtTable>
    </ElCard>
    <UserDialog
      v-model:visible="dialogVisible"
      :row="currentRow"
      account-kind="merchant"
      :default-merchant-id="merchantId"
      @restore="restoreMerchantEditor"
    />
  </div>
</template>

<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage } from 'element-plus'
  import { useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Staff } from '@/types/studio'
  import UserDialog from '@/views/system/user/modules/user-dialog.vue'

  const props = defineProps<{ merchantId?: string }>()
  const { data, user, loading, can, refresh } = useStudio()
  const isAdmin = computed(() => ['super_admin', 'admin'].includes(user.value?.role || ''))
  const emptySearch = () => ({ merchantName: '', username: '', name: '', status: '' })
  const search = ref(emptySearch())
  const applied = reactive(emptySearch())
  const searchItems = [
    {
      key: 'merchantName',
      label: '商家名称',
      type: 'input',
      props: { clearable: true, placeholder: '按商家名称搜索' }
    },
    {
      key: 'username',
      label: '登录账号',
      type: 'input',
      props: { clearable: true, placeholder: '按登录账号搜索' }
    },
    {
      key: 'name',
      label: '姓名 / 称呼',
      type: 'input',
      props: { clearable: true, placeholder: '按姓名或称呼搜索' }
    },
    {
      key: 'status',
      label: '账号状态',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { value: 'active', label: '启用' },
          { value: 'disabled', label: '停用' }
        ]
      }
    }
  ]
  const merchantAccounts = computed(() =>
    (data.value?.users || []).filter((row) => row.role === 'merchant')
  )
  function merchantName(merchantId?: string | null) {
    return data.value?.merchants?.find((item) => item.id === merchantId)?.name || '未关联商家'
  }
  const includes = (value: string, query: string) =>
    value.toLowerCase().includes(query.trim().toLowerCase())
  const filteredRows = computed(() =>
    merchantAccounts.value.filter(
      (row) =>
        (!props.merchantId || row.merchantId === props.merchantId) &&
        includes(merchantName(row.merchantId), applied.merchantName) &&
        includes(row.username, applied.username) &&
        includes(row.name, applied.name) &&
        (!applied.status || row.status === applied.status)
    )
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(filteredRows)
  const { columns, columnChecks } = useTableColumns<Staff>(() => [
    { prop: 'merchantId', label: '所属商家', minWidth: 170, useSlot: true },
    { prop: 'username', label: '登录账号', minWidth: 170 },
    { prop: 'name', label: '姓名 / 称呼', minWidth: 160 },
    { prop: 'status', label: '状态', width: 100, useSlot: true },
    { prop: 'operation', label: '操作', width: 130, fixed: 'right', useSlot: true }
  ])
  watch(() => props.merchantId, resetPage)
  const dialogVisible = ref(false)
  const currentRow = ref<Staff>()
  function edit(row?: Staff) {
    if (!can('users.manage') || (!row && !isAdmin.value) || (row && row.role !== 'merchant')) return
    if (row && props.merchantId && row.merchantId !== props.merchantId) return
    currentRow.value = row
    dialogVisible.value = true
  }
  function applySearch() {
    Object.assign(applied, search.value)
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
  async function restoreMerchantEditor({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if ((isCurrent && !isCurrent()) || !can('users.manage')) return
      if (recordId === 'new') edit()
      else {
        const row = merchantAccounts.value.find(
          (item) =>
            item.id === recordId && (!props.merchantId || item.merchantId === props.merchantId)
        )
        if (row) edit(row)
      }
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '账号读取失败，请返回列表重试')
    }
  }
</script>
