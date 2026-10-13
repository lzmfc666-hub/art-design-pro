<template>
  <div>
    <ArtSearchBar
      v-model="search"
      :items="searchItems"
      @search="applySearch"
      @reset="resetSearch"
    />
    <ElAlert
      class="mb-4"
      title="验收通过后形成可提现报酬；曾接单后取消的订单，须由财务确认最终补偿报酬。"
      type="info"
      :closable="false"
      show-icon
    />
    <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload">
      <template #left
        ><ElTag effect="plain">待处理 {{ rows.length }} 单</ElTag></template
      >
    </ArtTableHeader>
    <ArtTable
      :data="tableData"
      :columns="columns"
      :loading="loading"
      :pagination="pagination"
      height="480"
      empty-height="260px"
      empty-text="当前没有待验收或待确认补偿的订单"
      @pagination:size-change="handleSizeChange"
      @pagination:current-change="handleCurrentChange"
    >
      <template #orderNo="{ row }"
        ><ElButton link type="primary" @click="viewOrder(row.id)">{{
          row.orderNo
        }}</ElButton></template
      >
      <template #leaderId="{ row }">{{
        personName(row.leaderId || row.assignedTo || row.assignments.at(-1)?.leaderId || '')
      }}</template>
      <template #receivedAmount="{ row }">{{ money(row.receivedAmount) }}</template>
      <template #reward="{ row }">{{ money(row.reward) }}</template>
      <template #status="{ row }"
        ><ElTag :type="row.status === 'review' ? 'primary' : 'warning'">{{
          row.status === 'review' ? '待验收' : '取消补偿待确认'
        }}</ElTag></template
      >
      <template #materials="{ row }">{{
        row.submissions.at(-1)?.source === 'status-correction' &&
        !row.submissions.at(-1)?.screenshots.length
          ? '后台登记（免截图）'
          : (row.submissions.at(-1)?.screenshots.length || 0) + ' 张截图'
      }}</template>
      <template #actions="{ row }"
        ><ElButton type="primary" link @click="viewOrder(row.id)">{{
          row.status === 'review' ? '核查并验收' : '查看订单 / 确认补偿'
        }}</ElButton></template
      >
    </ArtTable>
    <ElDrawer
      :model-value="!!detailId"
      title="订单核查"
      size="min(1100px, 96vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!detailBusy"
      :show-close="!detailBusy"
      destroy-on-close
      @close="detailId = ''"
    >
      <OrderDetail v-if="detailId" :order-id="detailId" @busy="detailBusy = $event" />
    </ElDrawer>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { money, useStudio } from '@/hooks/business/useStudio'
  import type { Order } from '@/types/studio'
  import { useFinanceActions } from './useFinanceActions'
  import OrderDetail from '@/views/orders/modules/order-detail.vue'

  const { data, loading, can } = useStudio()
  const emit = defineEmits<{ busy: [value: boolean] }>()
  const detailId = ref('')
  const detailBusy = ref(false)
  watch(detailBusy, (busy) => emit('busy', busy), { immediate: true })
  const { reload } = useFinanceActions()
  const router = useRouter()
  const search = ref({ orderNo: '', title: '', status: '' })
  const applied = ref({ ...search.value })
  const searchItems = [
    {
      key: 'orderNo',
      label: '订单号',
      type: 'input',
      props: { placeholder: '按订单号搜索', clearable: true }
    },
    {
      key: 'title',
      label: '订单项目',
      type: 'input',
      props: { placeholder: '按项目名称搜索', clearable: true }
    },
    {
      key: 'status',
      label: '处理类型',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { label: '待验收', value: 'review' },
          { label: '取消补偿待确认', value: 'canceled' }
        ]
      }
    }
  ]
  const rows = computed(() =>
    (data.value?.orders || []).filter(
      (row) =>
        (row.status === 'review' ||
          (row.status === 'canceled' && row.compensationPending && !row.compensationSettled)) &&
        (!applied.value.status || row.status === applied.value.status) &&
        row.orderNo.toLowerCase().includes(applied.value.orderNo.trim().toLowerCase()) &&
        row.title.toLowerCase().includes(applied.value.title.trim().toLowerCase())
    )
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<Order>(() => [
    { prop: 'orderNo', label: '订单号', minWidth: 180, useSlot: true },
    { prop: 'title', label: '订单项目', minWidth: 170 },
    { prop: 'leaderId', label: '负责人', minWidth: 130, useSlot: true },
    { prop: 'receivedAmount', label: '客户收款', minWidth: 130, useSlot: true },
    { prop: 'reward', label: '整单报酬', minWidth: 130, useSlot: true },
    { prop: 'status', label: '处理类型', minWidth: 155, useSlot: true },
    { prop: 'materials', label: '上报材料', minWidth: 110, useSlot: true },
    { prop: 'actions', label: '操作', width: 190, fixed: 'right', useSlot: true }
  ])
  function applySearch() {
    applied.value = { ...search.value }
    resetPage()
  }
  function resetSearch() {
    search.value = { orderNo: '', title: '', status: '' }
    applySearch()
  }
  function personName(id: string) {
    return data.value?.users.find((row) => row.id === id)?.name || id || '—'
  }
  function viewOrder(id: string) {
    if (detailBusy.value) return
    if (can('orders.view')) router.push({ path: '/orders/list', query: { id } })
    else {
      detailId.value = id
      detailBusy.value = false
    }
  }
</script>
