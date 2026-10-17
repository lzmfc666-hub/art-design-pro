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
        <ElButton link type="primary" @click="refundDetailId = row.id">查看详情</ElButton>
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
    <BusinessDetailPanel
      page-key="finance-refund-details"
      :record-id="refundDetailId || undefined"
      @restore="queueRestore('detail', $event)"
      :restore-error="restoreError"
      :model-value="!!refundDetailId"
      title="退款记录详情"
      @update:model-value="!$event && !saving && !detailBusy && (refundDetailId = '')"
      @close="refundDetailId = ''"
    >
      <template v-if="refundDetail">
        <BusinessDetailHeader
          :title="orderName(refundDetail.orderId)"
          description="退款归属原付款日统计，原申请和财务处理结果分别保留。"
          icon="ri:refund-2-line"
          :badge="statusLabels[refundDetail.status]"
          :context="refundDetail.id"
        />
        <BusinessDetailSummary
          :items="[
            { label: '退款金额', value: money(refundDetail.amount), tone: 'primary' },
            {
              label: '退款方式',
              value:
                refundDetail.refundMethod === 'balance'
                  ? '退回客户储值'
                  : refundDetail.refundMethod === 'cash'
                    ? '现金退款'
                    : '历史记录未登记'
            },
            { label: '申请时间', value: formatTime(refundDetail.createdAt) },
            {
              label: '报酬差额',
              value: refundDetail.manualRewardReview
                ? refundDetail.manualResolution
                  ? '已登记处理'
                  : '待财务处理'
                : '无人工处理标记'
            }
          ]"
        />
        <BusinessDetailSection title="退款依据与经办记录">
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem label="退款原因">{{ refundDetail.reason }}</ElDescriptionsItem
            ><ElDescriptionsItem label="申请人">{{
              personName(refundDetail.requestedBy)
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="处理时间">{{
              refundDetail.processedAt ? formatTime(refundDetail.processedAt) : '尚未处理'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="经办人">{{
              refundDetail.processedBy ? personName(refundDetail.processedBy) : '—'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="储值流水编号">{{
              refundDetail.balanceTransactionId || '—'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="人工差额处理说明">{{
              refundDetail.manualResolution || '尚未登记'
            }}</ElDescriptionsItem></ElDescriptions
          >
          <ElButton
            class="mt-4"
            plain
            type="primary"
            :disabled="saving || detailBusy"
            @click="viewOrder(refundDetail.orderId)"
            >查看关联订单</ElButton
          >
        </BusinessDetailSection> </template
      ><ElEmpty v-else description="当前账号没有可读取的记录，请关闭后刷新列表" />
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-refund-register"
      @restore="queueRestore('new', $event)"
      :restore-error="restoreError"
      v-model="refund.open"
      title="登记已实际发生的退款"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      destroy-on-close
    >
      <BusinessDetailHeader
        description="选择原订单，核对可退额度和退款方式后登记。退款调整原付款日统计。"
        icon="ri:refund-2-line"
        :badge="refundIsBalance ? '客户储值退款' : '实际退款登记'"
      />
      <BusinessDetailSummary
        :items="[
          { label: '关联订单', value: refund.orderId ? orderName(refund.orderId) : '待选择' },
          { label: '可登记余额', value: money(refundableAmount), hint: '扣除已退金额与待审核占用' },
          {
            label: '本次退款',
            value: refund.amount == null ? '待填写' : money(refund.amount),
            tone: 'primary'
          }
        ]"
      />
      <BusinessDetailSection
        title="退款金额与原因"
        :description="
          refundIsBalance
            ? '保存后自动退回原客户储值账户，避免重复线下退款。'
            : '完成客户实际退款后再登记本次金额。'
        "
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
          <ElAlert
            v-if="revisionError"
            :title="revisionError"
            type="error"
            :closable="false"
            class="mb-4"
          />
          <p v-if="revisionLoading" class="text-g-500 mb-3">正在读取关联订单版本，请稍候。</p>
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
      </BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving" @click="refund.open = false">取消</ElButton
        ><ElButton
          type="primary"
          :loading="saving"
          :disabled="revisionLoading || refund.expectedRevision == null || !!revisionError"
          @click="saveRefund"
          >{{ refundIsBalance ? '确认退回储值' : '确认实际退款并登记' }}</ElButton
        ></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-refund-process"
      :record-id="reason.id ? reason.action + ':' + reason.id : undefined"
      @restore="queueRestore('process', $event)"
      :restore-error="restoreError"
      v-model="reason.open"
      :title="reason.action === 'resolve' ? '登记报酬差额人工处理结果' : '驳回退款申请'"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <BusinessDetailHeader
        :description="
          reason.action === 'resolve'
            ? '登记财务核对后的处理依据，本次只保存说明。'
            : '保留退款申请并填写驳回依据，释放待审核占用。'
        "
        icon="ri:file-check-line"
        :context="reason.id"
      />
      <BusinessDetailSummary
        v-if="reasonRecord"
        :items="[
          { label: '关联订单', value: orderName(reasonRecord.orderId) },
          { label: '退款金额', value: money(reasonRecord.amount), tone: 'primary' },
          { label: '原申请状态', value: statusLabels[reasonRecord.status] }
        ]"
      />
      <ElAlert
        v-if="reason.action === 'resolve'"
        class="mb-4"
        title="记录财务确认的差额、处理方式和结果。本次只保存说明，不自动追回或扣减打手余额。"
        type="warning"
        :closable="false"
      />
      <BusinessDetailSection title="处理原因与结果"
        ><ElInput
          v-model="reason.text"
          :disabled="saving"
          type="textarea"
          :rows="5"
          maxlength="2000"
          show-word-limit
          placeholder="填写具体原因或处理结果"
      /></BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving" @click="reason.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveReason"
          >保存处理结果</ElButton
        ></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-refund-order"
      :record-id="detailId || undefined"
      @restore="queueRestore('order', $event)"
      :restore-error="restoreError"
      :model-value="!!detailId"
      title="关联订单"
      :close-on-click-modal="false"
      :close-on-press-escape="!detailBusy"
      :show-close="!detailBusy"
      destroy-on-close
      @update:model-value="!$event && !detailBusy && (detailId = '')"
      @close="detailId = ''"
    >
      <OrderDetail v-if="detailId" :order-id="detailId" @busy="detailBusy = $event" />
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, reactive, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { createStudioRequestId } from '@/api/studio-mutation'
  import { studioRequest } from '@/api/studio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { formatTime, money, useStudio } from '@/hooks/business/useStudio'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import type { Refund, OrderDetailResponse } from '@/types/studio'
  import { useFinanceActions } from './useFinanceActions'
  import OrderDetail from '@/views/orders/modules/order-detail.vue'
  import { businessConfirmMessage } from '@/utils/business/confirm-message'

  const { data, user, loading, can, clearSession } = useStudio()
  const { saving, submit, reload, lastFailure } = useFinanceActions()
  const emit = defineEmits<{ busy: [value: boolean] }>()
  const detailId = ref('')
  const refundDetailId = ref('')
  const refundDetail = computed(() =>
    data.value?.refunds.find((row) => row.id === refundDetailId.value)
  )
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
    { prop: 'actions', label: '操作', width: 270, fixed: 'right', useSlot: true }
  ])
  const refund = reactive({
    open: false,
    orderId: '',
    amount: null as number | null,
    reason: '',
    expectedRevision: null as number | null
  })
  const revisionLoading = ref(false)
  const revisionError = ref('')
  let revisionVersion = 0
  watch(
    () => [refund.orderId, user.value?.id],
    async () => {
      const version = ++revisionVersion
      refund.expectedRevision = null
      revisionError.value = ''
      revisionLoading.value = false
      if (!refund.orderId || !refund.open) return
      revisionLoading.value = true
      try {
        const result = await studioRequest<OrderDetailResponse>(
          `orders/${encodeURIComponent(refund.orderId)}`
        )
        if (version === revisionVersion) refund.expectedRevision = result.order.revision
      } catch (cause) {
        if (version === revisionVersion)
          revisionError.value =
            cause instanceof Error ? cause.message : '订单版本读取失败，请重新选择订单'
        if ((cause as { status?: number }).status === 401) clearSession()
      } finally {
        if (version === revisionVersion) revisionLoading.value = false
      }
    }
  )
  const refundIsBalance = computed(
    () => data.value?.orders.find((row) => row.id === refund.orderId)?.paymentMethod === 'balance'
  )
  const approveRequests = new Map<string, { requestId: string; expectedRevision: number }>()
  const reason = reactive({
    open: false,
    id: '',
    action: '' as 'reject' | 'resolve' | '',
    text: '',
    expectedRevision: null as number | null
  })
  const reasonRecord = computed(() => data.value?.refunds.find((row) => row.id === reason.id))
  const restoreError = ref('')
  const pendingRestore = ref<{
    kind: 'detail' | 'new' | 'process' | 'order'
    recordId?: string
    isCurrent?: () => boolean
  } | null>(null)
  function queueRestore(
    kind: 'detail' | 'new' | 'process' | 'order',
    payload: { recordId?: string; isCurrent?: () => boolean }
  ) {
    restoreError.value = ''
    pendingRestore.value = { kind, ...payload }
    resumeRestore()
  }
  function resumeRestore() {
    if (pendingRestore.value?.isCurrent?.() === false) {
      pendingRestore.value = null
      return
    }
    if (!pendingRestore.value || loading.value || saving.value || detailBusy.value || !data.value)
      return
    const request = pendingRestore.value
    pendingRestore.value = null
    if (!can('finance.refunds')) {
      restoreError.value = '当前账号没有退款处理权限，请返回财务列表。'
      return
    }
    if (request.kind === 'new') return openRefund()
    if (request.kind === 'order' && request.recordId) return viewOrder(request.recordId)
    const [action, id] =
      request.kind === 'process' ? (request.recordId || '').split(':') : ['', request.recordId]
    const row = data.value.refunds.find((item) => item.id === id)
    if (!row) {
      restoreError.value = '这笔退款不存在或当前账号无权读取，请返回退款列表重新核对。'
      return
    }
    if (request.kind === 'detail') refundDetailId.value = row.id
    else if (action === 'reject' && row.status === 'pending') openReason(row, 'reject')
    else if (action === 'resolve' && row.manualRewardReview && !row.manualResolution)
      openReason(row, 'resolve')
    else restoreError.value = '这笔退款已变化或处理完毕，请返回列表查看最新记录。'
  }
  watch([data, loading, saving, detailBusy], resumeRestore)
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
  function personName(id: string) {
    return data.value?.users.find((row) => row.id === id)?.name || id || '—'
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
  async function openReason(row: Refund, action: 'reject' | 'resolve') {
    if (saving.value || detailBusy.value) return
    let expectedRevision: number | null = null
    if (action === 'reject') {
      detailBusy.value = true
      try {
        const accountId = user.value?.id
        const result = await studioRequest<OrderDetailResponse>(
          `orders/${encodeURIComponent(row.orderId)}`
        )
        if (accountId !== user.value?.id) {
          detailBusy.value = false
          return
        }
        expectedRevision = result.order.revision
      } catch (cause) {
        ElMessage.error(
          cause instanceof Error
            ? cause.message
            : '无权读取关联订单，请由有订单查看权限的人员核对后处理'
        )
        return
      } finally {
        detailBusy.value = false
      }
    }
    Object.assign(reason, { open: true, id: row.id, action, text: '', expectedRevision })
  }
  async function approve(row: Refund) {
    if (saving.value || detailBusy.value) return
    const accountId = user.value?.id
    let request = approveRequests.get(row.id)
    detailBusy.value = true
    if (!request) {
      try {
        const result = await studioRequest<OrderDetailResponse>(
          `orders/${encodeURIComponent(row.orderId)}`
        )
        if (accountId !== user.value?.id) {
          detailBusy.value = false
          return
        }
        request = { requestId: createStudioRequestId(), expectedRevision: result.order.revision }
      } catch (cause) {
        detailBusy.value = false
        ElMessage.error(
          cause instanceof Error
            ? cause.message
            : '无权读取关联订单，请由有订单查看权限的人员核对后处理'
        )
        return
      }
    }
    const isBalance =
      data.value?.orders.find((order) => order.id === row.orderId)?.paymentMethod === 'balance'
    try {
      await ElMessageBox.confirm(
        businessConfirmMessage(
          isBalance
            ? `确认将 ${money(row.amount)} 退回原客户储值账户？本次无需线下再退款。`
            : `确认已向客户实际退款 ${money(row.amount)}？退款将归属原订单付款日统计。`,
          [
            { label: '退款编号', value: row.id },
            { label: '关联订单', value: orderName(row.orderId) },
            { label: '本次退款金额', value: money(row.amount) },
            { label: '当前申请状态', value: statusLabels[row.status] },
            { label: '申请时间', value: formatTime(row.createdAt) },
            {
              label: '原付款时间',
              value: formatTime(
                data.value?.orders.find((order) => order.id === row.orderId)?.paidAt
              )
            },
            { label: '退款方式', value: isBalance ? '退回原客户储值' : '确认实际现金退款' }
          ],
          '退款仍归原订单付款日，申请与财务处理记录继续保留。'
        ),
        '审核并登记退款',
        {
          type: 'warning',
          confirmButtonText: isBalance ? '确认退回储值' : '确认已退款',
          cancelButtonText: '取消'
        }
      )
    } catch {
      detailBusy.value = false
      return
    }
    detailBusy.value = false
    if (accountId !== user.value?.id || !request) return
    approveRequests.set(row.id, request)
    const success = await submit(
      `/refunds/${row.id}/action`,
      { action: 'approve', ...request },
      '退款已登记'
    )
    const failureStatus = (lastFailure.value as { status?: number } | null)?.status
    if (
      success ||
      (failureStatus &&
        failureStatus < 500 &&
        (lastFailure.value as { code?: string } | null)?.code !== 'LOCAL_PENDING_REQUEST')
    )
      approveRequests.delete(row.id)
  }
  async function saveRefund() {
    if (revisionLoading.value || revisionError.value || refund.expectedRevision == null)
      return void ElMessage.warning(revisionError.value || '请先读取关联订单，核对后登记退款')
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
          expectedRevision: refund.expectedRevision,
          amount: refund.amount,
          reason: refund.reason
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
        {
          action: reason.action,
          reason: reason.text,
          ...(reason.action === 'reject' ? { expectedRevision: reason.expectedRevision } : {})
        },
        '处理结果已保存'
      )
    )
      reason.open = false
  }
</script>
