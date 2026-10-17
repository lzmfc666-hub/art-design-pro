<template>
  <div>
    <BusinessDetailHeader
      description="按真实指定、负责人、队友及历史记录查看关联订单。订单总数由服务端返回，明细按页读取。"
      icon="ri:history-line"
    />
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
        ><ElTag :type="orderStatusType(row.displayStatus || row.status)">{{
          orderStatusLabel(row)
        }}</ElTag></template
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
        ><ElButton link type="primary" @click="openAssignments(row)">接单记录</ElButton
        ><ElButton v-if="can('orders.view')" link type="primary" @click="openOrder(row.id)"
          >订单详情</ElButton
        ></template
      >
    </ArtTable>
    <BusinessDetailPanel
      page-key="player-order-assignments"
      :record-id="selected?.id"
      @restore="restoreAssignments"
      class="business-detail-dialog"
      :model-value="!!selected"
      title="实际接单与解除记录"
      width="min(960px,94vw)"
      @update:model-value="closeAssignments"
    >
      <BusinessDetailHeader
        :title="selected?.title"
        description="该打手在此订单中的实际负责人接单与解除记录；队友身份仍以材料记录为准。"
        icon="ri:team-line"
        :context="selected?.orderNo"
      />
      <BusinessDetailSummary
        :items="[
          { label: '当前订单状态', value: selected ? orderStatusLabel(selected) : '—' },
          { label: '参与身份', value: selected ? participation(selected) : '—' },
          {
            label: '负责人接单记录',
            value: selectedAssignments.length,
            hint: '该订单中该打手的记录数'
          }
        ]"
      />
      <BusinessDetailSection
        title="实际接单与解除明细"
        description="尚未接受的指定任务不伪造接单时间，未解除的接单不填解除时间。"
      >
        <ElTable :data="selectedAssignments" border
          ><ElTableColumn type="expand"
            ><template #default="{ row }"
              ><BusinessDetailSection title="单次接单详情">
                <ElDescriptions :column="2" border>
                  <ElDescriptionsItem label="派单轮次">{{
                    row.dispatchRound ?? '未提供'
                  }}</ElDescriptionsItem>
                  <ElDescriptionsItem label="接单状态">{{
                    row.releasedAt ? '已解除' : '未记录解除'
                  }}</ElDescriptionsItem>
                  <ElDescriptionsItem label="实际接单">{{
                    formatTime(row.acceptedAt)
                  }}</ElDescriptionsItem>
                  <ElDescriptionsItem label="解除时间">{{
                    formatTime(row.releasedAt)
                  }}</ElDescriptionsItem>
                  <ElDescriptionsItem label="解除说明" :span="2"
                    ><p class="whitespace-pre-wrap break-all">{{
                      row.reason || '未填写'
                    }}</p></ElDescriptionsItem
                  >
                </ElDescriptions>
              </BusinessDetailSection></template
            ></ElTableColumn
          ><ElTableColumn prop="dispatchRound" label="派单轮次" width="100" /><ElTableColumn
            label="实际接单"
            min-width="175"
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
      </BusinessDetailSection>
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, onUnmounted, reactive, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { studioRequest } from '@/api/studio'
  import {
    formatTime,
    orderStatusLabel,
    orderStatusType,
    useStudio
  } from '@/hooks/business/useStudio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import type { Order } from '@/types/studio'

  const props = defineProps<{ userId: string }>()
  const { can, clearSession, refresh } = useStudio()
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
  function openAssignments(row: Order) {
    if (can('orders.view') || can('finance.withdrawals')) selected.value = row
  }
  async function restoreAssignments({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    if (!recordId) return
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (!can('orders.view') && !can('finance.withdrawals')) return
      const owner = props.userId
      const row = await studioRequest<Order>(
        `players/${encodeURIComponent(owner)}/orders/${encodeURIComponent(recordId)}`
      )
      if (isCurrent && !isCurrent()) return
      if (owner === props.userId) openAssignments(row)
    } catch (cause) {
      selected.value = null
      if ((cause as { status?: number }).status === 401) clearSession()
      error.value = cause instanceof Error ? cause.message : '接单记录读取失败'
    }
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
