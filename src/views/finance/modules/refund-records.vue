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
      title="退款回到原付款日调整经营统计。打手已提现后的报酬差额，由财务确认并登记结果，不自动扣回余额。"
      type="warning"
      :closable="false"
      show-icon
    />
    <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload">
      <template #left
        ><ElButton type="primary" :disabled="saving || detailBusy" @click="openRefund"
          ><ArtSvgIcon icon="ri:add-line" class="mr-1" />登记实际退款</ElButton
        ></template
      >
    </ArtTableHeader>
    <ArtTable
      :data="tableData"
      :columns="columns"
      :loading="loading"
      :pagination="pagination"
      height="480"
      empty-height="260px"
      @pagination:size-change="handleSizeChange"
      @pagination:current-change="handleCurrentChange"
    >
      <template #orderId="{ row }"
        ><ElButton link type="primary" @click="viewOrder(row.orderId)">{{
          orderName(row.orderId)
        }}</ElButton></template
      >
      <template #amount="{ row }">{{ money(row.amount) }}</template>
      <template #createdAt="{ row }">{{ formatTime(row.processedAt || row.createdAt) }}</template>
      <template #status="{ row }"
        ><ElTag
          :type="row.status === 'paid' ? 'success' : row.status === 'pending' ? 'warning' : 'info'"
          >{{ statusLabels[row.status as Refund['status']] }}</ElTag
        ></template
      >
      <template #manualResolution="{ row }"
        ><ElTag v-if="row.manualRewardReview && !row.manualResolution" type="warning"
          >待财务人工处理</ElTag
        ><span v-else>{{ row.manualResolution || '—' }}</span></template
      >
      <template #actions="{ row }">
        <template v-if="row.status === 'pending'"
          ><ElButton link type="primary" :disabled="saving" @click="approve(row)">确认退款</ElButton
          ><ElButton link type="danger" :disabled="saving" @click="openReason(row, 'reject')"
            >驳回</ElButton
          ></template
        >
        <ElButton
          v-if="row.manualRewardReview && !row.manualResolution"
          link
          type="primary"
          :disabled="saving"
          @click="openReason(row, 'resolve')"
          >登记差额处理</ElButton
        >
      </template>
    </ArtTable>
    <ElDialog
      v-model="refund.open"
      title="登记已实际发生的退款"
      width="min(600px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      destroy-on-close
    >
      <ElForm label-position="top" :disabled="saving" @submit.prevent="saveRefund">
        <ElFormItem label="关联订单（不含大厅来源）" required
          ><ElSelect v-model="refund.orderId" filterable class="w-full"
            ><ElOption
              v-for="row in refundableOrders"
              :key="row.id"
              :value="row.id"
              :label="`${row.orderNo} · ${row.title}`" /></ElSelect
        ></ElFormItem>
        <ElFormItem label="实际退款金额（元）" required
          ><BusinessAmount v-model="refund.amount" placeholder="实际退款金额"
        /></ElFormItem>
        <p class="text-g-500 mb-4"
          >可登记余额 {{ money(refundableAmount) }}，已扣除待审核申请占用。</p
        >
        <ElFormItem label="退款原因" required
          ><ElInput
            v-model="refund.reason"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
        /></ElFormItem>
        <ElAlert
          :title="
            refundIsBalance
              ? '保存后自动退回原客户储值账户，不再重复线下退款。'
              : '保存即视为实际退款，请完成客户退款后再登记。'
          "
          type="warning"
          :closable="false"
        />
      </ElForm>
      <template #footer
        ><ElButton :disabled="saving" @click="refund.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveRefund">{{
          refundIsBalance ? '确认退回储值' : '确认实际退款并登记'
        }}</ElButton></template
      >
    </ElDialog>
    <ElDialog
      v-model="reason.open"
      :title="reason.action === 'resolve' ? '登记报酬差额人工处理结果' : '驳回退款申请'"
      width="min(560px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <ElAlert
        v-if="reason.action === 'resolve'"
        class="mb-4"
        title="记录财务确认的差额、处理方式和结果。本次只保存说明，不自动追回或扣减打手余额。"
        type="warning"
        :closable="false"
      />
      <ElInput
        v-model="reason.text"
        :disabled="saving"
        type="textarea"
        :rows="5"
        maxlength="2000"
        show-word-limit
        placeholder="填写具体原因或处理结果"
      />
      <template #footer
        ><ElButton :disabled="saving" @click="reason.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveReason"
          >保存处理结果</ElButton
        ></template
      >
    </ElDialog>
    <ElDrawer
      :model-value="!!detailId"
      title="关联订单"
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
  import { computed, reactive, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { formatTime, money, useStudio } from '@/hooks/business/useStudio'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import type { Refund } from '@/types/studio'
  import { useFinanceActions } from './useFinanceActions'
  import OrderDetail from '@/views/orders/modules/order-detail.vue'

  const { data, loading, can } = useStudio()
  const { saving, submit, reload } = useFinanceActions()
  const emit = defineEmits<{ busy: [value: boolean] }>()
  const detailId = ref('')
  const detailBusy = ref(false)
  watch([saving, detailBusy], ([saving, details]) => emit('busy', saving || details), {
    immediate: true
  })
  const router = useRouter()
  const statusLabels = { pending: '待审核', paid: '已退款', rejected: '已驳回' }
  const search = ref({ orderNo: '', reason: '', status: '' })
  const applied = ref({ ...search.value })
  const searchItems = [
    {
      key: 'orderNo',
      label: '关联订单号',
      type: 'input',
      props: { placeholder: '按订单号搜索', clearable: true }
    },
    {
      key: 'reason',
      label: '退款原因',
      type: 'input',
      props: { placeholder: '按原因搜索', clearable: true }
    },
    {
      key: 'status',
      label: '处理状态',
      type: 'select',
      props: {
        clearable: true,
        options: [
          ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
          { label: '报酬差额待人工处理', value: 'manual' }
        ]
      }
    }
  ]
  const rows = computed(() =>
    (data.value?.refunds || [])
      .filter(
        (row) =>
          (!applied.value.status ||
            row.status === applied.value.status ||
            (applied.value.status === 'manual' &&
              row.manualRewardReview &&
              !row.manualResolution)) &&
          orderName(row.orderId)
            .toLowerCase()
            .includes(applied.value.orderNo.trim().toLowerCase()) &&
          row.reason.toLowerCase().includes(applied.value.reason.trim().toLowerCase())
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<Refund>(() => [
    { prop: 'orderId', label: '关联订单', minWidth: 180, useSlot: true },
    { prop: 'amount', label: '退款金额', minWidth: 130, useSlot: true },
    { prop: 'reason', label: '退款原因', minWidth: 180, showOverflowTooltip: true },
    { prop: 'createdAt', label: '申请 / 实退时间', minWidth: 180, useSlot: true },
    { prop: 'status', label: '状态', minWidth: 100, useSlot: true },
    {
      prop: 'manualResolution',
      label: '打手报酬差额',
      minWidth: 200,
      useSlot: true,
      showOverflowTooltip: true
    },
    { prop: 'actions', label: '操作', width: 190, fixed: 'right', useSlot: true }
  ])
  const refund = reactive({ open: false, orderId: '', amount: null as number | null, reason: '' })
  let refundRequestId = crypto.randomUUID()
  watch(
    () => JSON.stringify([refund.orderId, refund.amount, refund.reason]),
    () => {
      refundRequestId = crypto.randomUUID()
    },
    { flush: 'sync' }
  )
  const refundIsBalance = computed(
    () => data.value?.orders.find((row) => row.id === refund.orderId)?.paymentMethod === 'balance'
  )
  const approveRequestIds = new Map<string, string>()
  const reason = reactive({
    open: false,
    id: '',
    action: '' as 'reject' | 'resolve' | '',
    text: ''
  })
  const refundableOrders = computed(() =>
    (data.value?.orders || []).filter((row) => {
      const platform = data.value?.platforms.find((platform) => platform.id === row.platformId)
      return (
        platform?.id !== 'hall' &&
        platform?.name !== '游戏大厅' &&
        row.receivedAmount >
          (data.value?.refunds || [])
            .filter((item) => item.orderId === row.id && ['paid', 'pending'].includes(item.status))
            .reduce((sum, item) => sum + item.amount, 0)
      )
    })
  )
  const refundableAmount = computed(() => {
    const order = data.value?.orders.find((row) => row.id === refund.orderId)
    return order
      ? order.receivedAmount -
          (data.value?.refunds || [])
            .filter((row) => row.orderId === order.id && ['paid', 'pending'].includes(row.status))
            .reduce((sum, row) => sum + row.amount, 0)
      : 0
  })
  function applySearch() {
    applied.value = { ...search.value }
    resetPage()
  }
  function resetSearch() {
    search.value = { orderNo: '', reason: '', status: '' }
    applySearch()
  }
  function orderName(id: string) {
    return data.value?.orders.find((row) => row.id === id)?.orderNo || id
  }
  function viewOrder(id: string) {
    if (saving.value || detailBusy.value) return
    if (can('orders.view')) router.push({ path: '/orders/list', query: { id } })
    else {
      detailId.value = id
      detailBusy.value = false
    }
  }
  function openRefund() {
    if (saving.value || detailBusy.value) return
    Object.assign(refund, { open: true, orderId: '', amount: null, reason: '' })
  }
  function openReason(row: Refund, action: 'reject' | 'resolve') {
    if (saving.value || detailBusy.value) return
    Object.assign(reason, { open: true, id: row.id, action, text: '' })
  }
  async function approve(row: Refund) {
    const isBalance =
      data.value?.orders.find((order) => order.id === row.orderId)?.paymentMethod === 'balance'
    try {
      await ElMessageBox.confirm(
        isBalance
          ? `确认将 ${money(row.amount)} 退回原客户储值账户？本次无需线下再退款。`
          : `确认已向客户实际退款 ${money(row.amount)}？退款将归属原订单付款日统计。`,
        '审核并登记退款',
        {
          type: 'warning',
          confirmButtonText: isBalance ? '确认退回储值' : '确认已退款',
          cancelButtonText: '取消'
        }
      )
    } catch {
      return
    }
    const requestId = approveRequestIds.get(row.id) || crypto.randomUUID()
    approveRequestIds.set(row.id, requestId)
    await submit(`/refunds/${row.id}/action`, { action: 'approve', requestId }, '退款已登记')
  }
  async function saveRefund() {
    if (
      !refund.orderId ||
      !refund.reason.trim() ||
      refund.amount == null ||
      refund.amount <= 0 ||
      refund.amount > refundableAmount.value
    )
      return void ElMessage.warning('请选择订单，并填写有效退款金额与原因')
    if (
      await submit(
        '/refunds',
        {
          orderId: refund.orderId,
          amount: refund.amount,
          reason: refund.reason,
          requestId: refundRequestId
        },
        '实际退款已登记'
      )
    )
      refund.open = false
  }
  async function saveReason() {
    if (!reason.text.trim()) return void ElMessage.warning('请填写处理原因或具体结果')
    if (
      await submit(
        `/refunds/${reason.id}/action`,
        { action: reason.action, reason: reason.text },
        '处理结果已保存'
      )
    )
      reason.open = false
  }
</script>
