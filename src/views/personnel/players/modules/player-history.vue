<template>
  <div>
    <ElAlert
      title="按真实指定、负责人、队友和接单记录查看历史。关闭接单开关不删除历史，也不影响已接订单提交。"
      type="info"
      :closable="false"
      class="mb-4"
    />
    <ElForm inline label-position="top" :disabled="loading">
      <ElFormItem label="排序字段"
        ><ElSelect v-model="sortBy" @change="resetAndLoad" style="width: 180px"
          ><ElOption label="订单创建时间" value="createdAt" /><ElOption
            label="完成时间"
            value="completedAt" /><ElOption
            label="接单 / 队友上报时间"
            value="acceptedAt" /></ElSelect
      ></ElFormItem>
      <ElFormItem label="排序方向"
        ><ElSelect v-model="sortOrder" @change="resetAndLoad" style="width: 130px"
          ><ElOption label="最新在前" value="desc" /><ElOption
            label="最早在前"
            value="asc" /></ElSelect
      ></ElFormItem>
    </ElForm>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" class="mb-4" />
    <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="load"
      ><template #left
        ><ElTag effect="plain">{{ pagination.total }} 笔关联订单</ElTag></template
      ></ArtTableHeader
    >
    <ArtTable
      :data="records"
      :columns="columns"
      :pagination="pagination"
      :loading="loading"
      height="390"
      @pagination:size-change="changeSize"
      @pagination:current-change="changePage"
    >
      <template #status="{ row }"
        ><ElTag
          :type="
            row.status === 'completed' ? 'success' : row.status === 'canceled' ? 'info' : 'warning'
          "
          >{{ statusLabels[row.status as OrderStatus] }}</ElTag
        ></template
      >
      <template #participation="{ row }">{{ participation(row) }}</template>
      <template #acceptedAt="{ row }">{{
        participatedAt(row)
          ? formatTime(participatedAt(row))
          : row.status === 'pending' && row.assignedTo === userId
            ? '尚未接单'
            : '—'
      }}</template>
      <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
      <template #completedAt="{ row }">{{ formatTime(row.completedAt) }}</template>
      <template #operation="{ row }"
        ><ElButton link type="primary" @click="selected = row">接单记录</ElButton
        ><ElButton v-if="can('orders.view')" link type="primary" @click="openOrder(row.id)"
          >订单详情</ElButton
        ></template
      >
    </ArtTable>
    <ElDialog
      :model-value="!!selected"
      title="实际接单与解除记录"
      width="min(720px,94vw)"
      @update:model-value="closeAssignments"
    >
      <p class="mb-4">{{ selected?.orderNo }} · {{ selected?.title }}</p>
      <ElTable :data="selectedAssignments" border
        ><ElTableColumn label="实际接单" min-width="175"
          ><template #default="{ row }">{{ formatTime(row.acceptedAt) }}</template></ElTableColumn
        ><ElTableColumn label="解除时间" min-width="175"
          ><template #default="{ row }">{{ formatTime(row.releasedAt) }}</template></ElTableColumn
        ><ElTableColumn prop="reason" label="解除说明" min-width="220"
      /></ElTable>
      <p class="text-sm text-g-500 mt-3">{{
        selectedAssignments.length
          ? '仅显示该打手的真实接单记录。队友身份以完成上报记录为准。'
          : '该打手在此订单中没有负责人接单记录，可能是指定待接单人或完成队友。'
      }}</p>
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import { computed, onUnmounted, reactive, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { studioRequest } from '@/api/studio'
  import { formatTime, statusLabels, useStudio } from '@/hooks/business/useStudio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Order, OrderStatus } from '@/types/studio'

  const props = defineProps<{ userId: string }>()
  const { can, clearSession } = useStudio()
  const router = useRouter()
  const records = ref<Order[]>([]),
    selected = ref<Order | null>(null)
  const loading = ref(false),
    error = ref('')
  const sortBy = ref('createdAt'),
    sortOrder = ref('desc')
  const pagination = reactive({ current: 1, size: 20, total: 0 })
  let version = 0
  let controller: AbortController | undefined
  onUnmounted(() => {
    version++
    controller?.abort()
  })
  const { columns, columnChecks } = useTableColumns<Order>(() => [
    { prop: 'orderNo', label: '订单号', minWidth: 180 },
    { prop: 'title', label: '订单项目', minWidth: 190 },
    { prop: 'status', label: '当前状态', width: 100, useSlot: true },
    { prop: 'participation', label: '参与身份', minWidth: 140, useSlot: true },
    { prop: 'acceptedAt', label: '参与时间', minWidth: 175, useSlot: true },
    { prop: 'createdAt', label: '订单创建', minWidth: 175, useSlot: true },
    { prop: 'completedAt', label: '完成时间', minWidth: 175, useSlot: true },
    {
      prop: 'operation',
      label: '查看',
      width: can('orders.view') ? 185 : 110,
      fixed: 'right',
      useSlot: true
    }
  ])
  function participation(order: Order) {
    if (order.leaderId === props.userId) return '负责人'
    if (order.teammateId === props.userId) return '完成队友'
    if (order.assignedTo === props.userId) return '指定接单人'
    if (assignments(order).length) return '历史负责人'
    if (order.submissions?.some((row) => row.teammateId === props.userId)) return '历史队友'
    return '历史参与'
  }
  const assignments = (order: Order) =>
    (order.assignments || []).filter((row) => row.leaderId === props.userId)
  const participatedAt = (order: Order) =>
    assignments(order).at(-1)?.acceptedAt ||
    order.submissions?.find((row) => row.teammateId === props.userId)?.submittedAt
  const selectedAssignments = computed(() => (selected.value ? assignments(selected.value) : []))
  function closeAssignments(value: boolean) {
    if (!value) selected.value = null
  }
  function openOrder(id: string) {
    if (can('orders.view')) void router.push({ path: '/orders/list', query: { id } })
  }
  async function load() {
    if (!can('orders.view') && !can('finance.withdrawals')) return
    const currentVersion = ++version
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = ''
    try {
      const result = await studioRequest<{
        records: Order[]
        total: number
        current: number
        size: number
      }>(
        `players/${encodeURIComponent(props.userId)}/orders?${new URLSearchParams({ current: String(pagination.current), size: String(pagination.size), sortBy: sortBy.value, sortOrder: sortOrder.value })}`,
        undefined,
        'GET',
        controller.signal
      )
      if (currentVersion !== version) return
      records.value = result.records
      Object.assign(pagination, { total: result.total, current: result.current, size: result.size })
    } catch (cause) {
      if (currentVersion !== version || (cause as { name?: string }).name === 'AbortError') return
      if ((cause as { status?: number }).status === 401) clearSession()
      records.value = []
      error.value = cause instanceof Error ? cause.message : '订单历史读取失败'
    } finally {
      if (currentVersion === version) loading.value = false
    }
  }
  function changePage(current: number) {
    pagination.current = current
    void load()
  }
  function changeSize(size: number) {
    pagination.size = size
    pagination.current = 1
    void load()
  }
  function resetAndLoad() {
    pagination.current = 1
    void load()
  }
  watch(
    () => props.userId,
    () => {
      pagination.current = 1
      records.value = []
      void load()
    },
    { immediate: true }
  )
</script>
