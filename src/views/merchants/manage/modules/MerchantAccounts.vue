<template>
  <div class="merchant-accounts">
    <ArtSearchBar
      v-model="search"
      :items="searchItems"
      @search="applySearch"
      @reset="resetSearch"
    />
    <ElCard class="art-table-card" shadow="never">
      <ElAlert
        v-if="merchantId && !data?.merchants?.find((item) => item.id === merchantId)?.ownerUserId"
        title="本商家尚未指定主账号。由超级管理员在客服账号行点击“设为主账号”完成指定，原有客服订单权限继续保留。"
        type="info"
        :closable="false"
        class="mb-4"
      />
      <ElAlert
        v-if="pendingAction"
        title="上次账号操作的结果尚未确认，请重试原操作。"
        type="warning"
        :closable="false"
        class="mb-4"
      >
        <ElButton :loading="acting" @click="runAction(pendingAction)">重试原操作</ElButton>
      </ElAlert>
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
        <template #merchantRole="{ row }"
          ><ElTag :type="row.merchantRole === 'owner' ? 'warning' : 'info'">{{
            row.merchantRole === 'owner' ? '主账号' : '客服'
          }}</ElTag></template
        >
        <template #status="{ row }">
          <ElTag :type="row.status === 'active' ? 'success' : 'info'">
            {{ row.status === 'active' ? '启用' : '停用' }}
          </ElTag>
        </template>
        <template #operation="{ row }">
          <ElButton
            v-if="canEditMerchantAccount(user, row, can('users.manage'))"
            link
            type="primary"
            :disabled="acting || !!pendingAction"
            @click="edit(row)"
          >
            编辑账号
          </ElButton>
          <ElButton
            v-if="canAssignMerchantOwner(user, row)"
            link
            type="primary"
            :disabled="acting || !!pendingAction"
            @click="assignOwner(row)"
            >{{ hasOwner(row) ? '交接主账号' : '设为主账号' }}</ElButton
          >
          <ElButton
            v-if="canDeleteMerchantAccount(user, row)"
            link
            type="danger"
            :disabled="acting || !!pendingAction"
            @click="remove(row)"
            >删除客服</ElButton
          >
          <span
            v-if="
              !canEditMerchantAccount(user, row, can('users.manage')) &&
              !canAssignMerchantOwner(user, row)
            "
            class="text-g-500"
            >{{ row.merchantRole === 'owner' ? '主账号由超管管理' : '无编辑权限' }}</span
          >
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
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Staff } from '@/types/studio'
  import UserDialog from '@/views/system/user/modules/user-dialog.vue'
  import {
    canEditMerchantAccount,
    canDeleteMerchantAccount,
    canAssignMerchantOwner
  } from '@/utils/auth/studio-user'
  import { createStudioMutationIntent } from '@/api/studio-mutation'

  const props = defineProps<{ merchantId?: string }>()
  const { data, user, loading, can, refresh, mutate } = useStudio()
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
    (data.value?.users || []).filter((row) => row.role === 'merchant' && !row.deletedAt)
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
    { prop: 'merchantRole', label: '账号身份', width: 110, useSlot: true },
    { prop: 'status', label: '状态', width: 100, useSlot: true },
    { prop: 'operation', label: '操作', width: 310, fixed: 'right', useSlot: true }
  ])
  watch(() => props.merchantId, resetPage)
  const dialogVisible = ref(false)
  const currentRow = ref<Staff>()
  function edit(row?: Staff) {
    if (!can('users.manage') || (!row && !isAdmin.value) || (row && row.role !== 'merchant')) return
    if (
      acting.value ||
      pendingAction.value ||
      (row && !canEditMerchantAccount(user.value, row, can('users.manage')))
    )
      return
    if (row && props.merchantId && row.merchantId !== props.merchantId) return
    currentRow.value = row
    dialogVisible.value = true
  }
  type AccountAction = { kind: 'delete' | 'owner'; row: Staff; actorId: string }
  const actionIntent = createStudioMutationIntent()
  const acting = ref(false)
  const pendingAction = ref<AccountAction | null>(null)
  function hasOwner(row: Staff) {
    return !!data.value?.merchants?.find((item) => item.id === row.merchantId)?.ownerUserId
  }
  async function remove(row: Staff) {
    if (acting.value || pendingAction.value || !canDeleteMerchantAccount(user.value, row)) return
    try {
      await ElMessageBox.confirm(
        `删除客服“${row.name}”？该账号将不能登录，登录账号可重新使用；历史订单、操作责任与记录继续保留，在途订单继续处理。`,
        '删除客服',
        { confirmButtonText: '删除登录资格', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return
    }
    await runAction({ kind: 'delete', row, actorId: user.value?.id || '' })
  }
  async function assignOwner(row: Staff) {
    if (acting.value || pendingAction.value || !canAssignMerchantOwner(user.value, row)) return
    const merchant = data.value?.merchants?.find((item) => item.id === row.merchantId)
    const old = data.value?.users.find((item) => item.id === merchant?.ownerUserId)
    try {
      await ElMessageBox.confirm(
        `将“${row.name}（${row.username}）”设为“${merchant?.name || merchantName(row.merchantId)}”的唯一主账号？${old ? `旧主账号“${old.name}”将立即停用，` : ''}新主账号将启用，双方历史订单与操作归属保留。`,
        old ? '交接主账号' : '指定主账号',
        { confirmButtonText: '确认交接', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return
    }
    await runAction({ kind: 'owner', row, actorId: user.value?.id || '' })
  }
  async function runAction(action: AccountAction) {
    if (acting.value || action.actorId !== user.value?.id) return
    if (
      action.kind === 'delete'
        ? !canDeleteMerchantAccount(user.value, action.row)
        : !canAssignMerchantOwner(user.value, action.row)
    )
      return
    acting.value = true
    const path =
      action.kind === 'delete'
        ? `/users/${action.row.id}/delete`
        : `/merchants/${action.row.merchantId}/owner`
    try {
      await mutate(
        path,
        actionIntent.prepare(path, action.kind === 'delete' ? {} : { userId: action.row.id })
      )
      actionIntent.complete()
      pendingAction.value = null
      ElMessage.success(
        action.kind === 'delete'
          ? '客服登录资格已删除，历史记录已保留'
          : '主账号交接已完成，旧主账号已停用'
      )
    } catch (error) {
      actionIntent.fail(error)
      pendingAction.value = actionIntent.uncertain ? action : null
      ElMessage.error(error instanceof Error ? error.message : '账号操作失败')
    } finally {
      acting.value = false
    }
  }
  watch(
    () => user.value?.id,
    () => {
      pendingAction.value = null
      actionIntent.complete()
      dialogVisible.value = false
    }
  )
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
