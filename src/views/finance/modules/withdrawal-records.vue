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
      title="每人每自然周最多 7 次有效申请；待审核撤回或驳回释放额度和原周次数。审核后请按申请时收款码人工转账，并登记真实付款凭证。"
      type="info"
      :closable="false"
      show-icon
    />
    <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload"
      ><template #left
        ><ElTag effect="plain">提现记录 {{ rows.length }} 笔</ElTag></template
      ></ArtTableHeader
    >
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
      <template #userId="{ row }">{{ personName(row.userId) }}</template>
      <template #amount="{ row }"
        ><strong>{{ money(row.amount) }}</strong></template
      >
      <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
      <template #status="{ row }"
        ><ElTag
          :type="
            row.status === 'paid'
              ? 'success'
              : ['rejected', 'canceled'].includes(row.status)
                ? 'info'
                : 'warning'
          "
          >{{ statusLabels[row.status as Withdrawal['status']] }}</ElTag
        ></template
      >
      <template #paidAt="{ row }">{{
        row.paidAt
          ? formatTime(row.paidAt)
          : row.canceledAt
            ? '撤回于 ' + formatTime(row.canceledAt)
            : row.reason || '—'
      }}</template>
      <template #receipt="{ row }"
        ><ElLink
          v-if="row.receipt"
          :href="row.receipt.url"
          target="_blank"
          rel="noopener"
          type="primary"
          >查看凭证</ElLink
        ><span v-else>—</span></template
      >
      <template #paymentSnapshot="{ row }">
        <ElLink
          v-if="row.paymentSnapshot?.qrCode"
          :href="row.paymentSnapshot.qrCode.url"
          target="_blank"
          rel="noopener"
          type="primary"
          >{{ row.paymentSnapshot.method === 'wechat' ? '微信' : '支付宝' }}收款码</ElLink
        >
        <span v-else>历史记录未登记</span>
        <p v-if="row.weekStart" class="text-xs text-g-500">自然周 {{ row.weekStart }}</p>
      </template>
      <template #actions="{ row }">
        <ElButton link type="primary" @click="detailId = row.id">查看详情</ElButton>
        <ElButton
          v-if="row.status === 'pending'"
          link
          type="primary"
          :disabled="saving || uploading"
          @click="approve(row)"
          >审核通过</ElButton
        >
        <ElButton
          v-if="['pending', 'approved'].includes(row.status)"
          link
          type="danger"
          :disabled="saving || uploading"
          @click="openReject(row)"
          >驳回</ElButton
        >
        <ElButton
          v-if="row.status === 'approved'"
          link
          type="primary"
          :disabled="saving || uploading"
          @click="openPay(row)"
          >登记已发放</ElButton
        >
      </template>
    </ArtTable>
    <BusinessDetailPanel
      page-key="finance-withdrawal-details"
      :record-id="detailId || undefined"
      @restore="queueRestore('detail', $event)"
      :restore-error="restoreError"
      :model-value="!!detailId"
      title="提现记录详情"
      @update:model-value="!$event && !saving && !uploading && (detailId = '')"
      @close="detailId = ''"
    >
      <template v-if="detail">
        <BusinessDetailHeader
          :title="personName(detail.userId)"
          description="查看这笔提现的原申请、处理记录和凭证。收款资料使用申请时快照。"
          icon="ri:bank-card-line"
          :badge="statusLabels[detail.status]"
          :context="detail.id"
        />
        <BusinessDetailSummary
          :items="[
            { label: '申请金额', value: money(detail.amount), tone: 'primary', hint: '原申请金额' },
            { label: '申请时间', value: formatTime(detail.createdAt) },
            { label: '所属自然周', value: detail.weekStart || '历史记录未登记' },
            { label: '当前状态', value: statusLabels[detail.status] }
          ]"
        />
        <BusinessDetailSection
          title="申请时收款资料"
          description="后来更新个人收款码，不会改写这笔申请的快照。"
        >
          <ElDescriptions :column="1" border>
            <ElDescriptionsItem label="收款方式">{{
              detail.paymentSnapshot?.method === 'wechat'
                ? '微信'
                : detail.paymentSnapshot?.method === 'alipay'
                  ? '支付宝'
                  : '历史记录未登记'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="资料更新时间">{{
              detail.paymentSnapshot ? formatTime(detail.paymentSnapshot.updatedAt) : '—'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem v-if="detail.paymentSnapshot?.qrCode" label="收款码"
              ><ElImage
                :src="detail.paymentSnapshot.qrCode.url"
                :preview-src-list="[detail.paymentSnapshot.qrCode.url]"
                preview-teleported
                fit="contain"
                style="width: 180px; height: 180px"
            /></ElDescriptionsItem>
          </ElDescriptions>
        </BusinessDetailSection>
        <BusinessDetailSection
          title="处理记录与发放凭证"
          description="已发放表示财务登记了人工转账，到账情况以实际转账结果为准。"
        >
          <ElDescriptions :column="1" border>
            <ElDescriptionsItem label="处理时间">{{
              detail.processedAt ? formatTime(detail.processedAt) : '—'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="经办人">{{
              detail.processedBy ? personName(detail.processedBy) : '—'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="发放时间">{{
              detail.paidAt ? formatTime(detail.paidAt) : '—'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="撤回时间">{{
              detail.canceledAt ? formatTime(detail.canceledAt) : '—'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="处理原因">{{ detail.reason || '—' }}</ElDescriptionsItem>
            <ElDescriptionsItem label="转账凭证"
              ><ElImage
                v-if="detail.receipt"
                :src="detail.receipt.url"
                :preview-src-list="[detail.receipt.url]"
                preview-teleported
                fit="contain"
                style="width: 180px; height: 180px"
              /><span v-else>尚未登记</span></ElDescriptionsItem
            >
          </ElDescriptions>
        </BusinessDetailSection>
      </template>
      <ElEmpty v-else description="当前账号没有可读取的记录，请关闭后刷新列表" />
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-withdrawal-pay"
      :record-id="payment.id || undefined"
      @restore="queueRestore('payment', $event)"
      :restore-error="restoreError"
      v-model="payment.open"
      title="登记提现已发放"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving && !uploading"
      :show-close="!saving && !uploading"
      destroy-on-close
    >
      <BusinessDetailHeader
        :title="payment.name"
        description="核对原申请收款资料，完成实际人工转账后上传凭证并登记。"
        icon="ri:bank-card-line"
        badge="待发放"
        :context="payment.id"
      />
      <BusinessDetailSummary
        :items="[
          { label: '本次转账金额', value: money(payment.amount), tone: 'primary' },
          { label: '登记后状态', value: '已发放', hint: '保存时间与经办人' }
        ]"
      />
      <BusinessDetailSection title="核对收款资料与实际凭证">
        <ElDescriptions :column="1" border class="mb-4"
          ><ElDescriptionsItem label="收款打手">{{ payment.name }}</ElDescriptionsItem
          ><ElDescriptionsItem label="实际转账">{{ money(payment.amount) }}</ElDescriptionsItem>
          <ElDescriptionsItem label="申请时收款方式">{{
            payment.snapshot?.method === 'wechat'
              ? '微信'
              : payment.snapshot?.method === 'alipay'
                ? '支付宝'
                : '历史记录未登记'
          }}</ElDescriptionsItem>
          <ElDescriptionsItem v-if="payment.snapshot" label="申请时收款码">
            <ElImage
              :src="payment.snapshot.qrCode.url"
              :preview-src-list="[payment.snapshot.qrCode.url]"
              fit="contain"
              style="width: 220px; height: 220px"
            />
            <p class="text-xs text-g-500"
              >资料更新时间 {{ formatTime(payment.snapshot.updatedAt) }}</p
            >
          </ElDescriptionsItem>
        </ElDescriptions>
        <ElForm label-position="top" :disabled="saving || uploading"
          ><ElFormItem label="实际转账凭证" required
            ><BusinessUpload v-model="payment.receipt" @busy="uploading = $event" /></ElFormItem
        ></ElForm>
        <p class="text-g-500">完成实际人工转账后登记，系统记录发放时间及经办人。</p>
      </BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving || uploading" @click="payment.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" :disabled="uploading" @click="savePay"
          >确认已发放</ElButton
        ></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-withdrawal-reject"
      :record-id="rejection.id || undefined"
      @restore="queueRestore('rejection', $event)"
      :restore-error="restoreError"
      v-model="rejection.open"
      title="驳回提现申请"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving && !uploading"
      :show-close="!saving && !uploading"
    >
      <BusinessDetailHeader
        description="驳回后释放申请占用金额及原自然周次数，保留申请和处理原因。"
        icon="ri:close-circle-line"
        :context="rejection.id"
      />
      <BusinessDetailSummary
        v-if="rejectionRecord"
        :items="[
          { label: '申请打手', value: personName(rejectionRecord.userId) },
          { label: '申请金额', value: money(rejectionRecord.amount), tone: 'primary' },
          { label: '当前状态', value: statusLabels[rejectionRecord.status] }
        ]"
      />
      <BusinessDetailSection title="填写驳回依据"
        ><ElInput
          v-model="rejection.reason"
          :disabled="saving"
          type="textarea"
          :rows="4"
          maxlength="2000"
          show-word-limit
          placeholder="填写驳回原因" /></BusinessDetailSection
      ><template #footer
        ><ElButton :disabled="saving" @click="rejection.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveReject"
          >确认驳回</ElButton
        ></template
      ></BusinessDetailPanel
    >
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { formatTime, money, useStudio } from '@/hooks/business/useStudio'
  import BusinessUpload from '@/components/business/BusinessUpload.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import type { Attachment, PlayerPaymentSnapshot, Withdrawal } from '@/types/studio'
  import { useFinanceActions } from './useFinanceActions'
  import { businessConfirmMessage } from '@/utils/business/confirm-message'

  const { data, loading } = useStudio()
  const { saving, submit, reload } = useFinanceActions()
  const uploading = ref(false)
  const detailId = ref('')
  const detail = computed(() => data.value?.withdrawals.find((row) => row.id === detailId.value))
  const emit = defineEmits<{ busy: [value: boolean] }>()
  watch([saving, uploading], ([saving, uploading]) => emit('busy', saving || uploading), {
    immediate: true
  })
  const statusLabels = {
    pending: '待审核',
    approved: '待发放',
    paid: '已发放',
    rejected: '已驳回',
    canceled: '已撤回'
  }
  const search = ref({ keyword: '', reason: '', status: '' })
  const applied = ref({ ...search.value })
  const searchItems = [
    {
      key: 'keyword',
      label: '打手',
      type: 'input',
      props: { placeholder: '打手姓名', clearable: true }
    },
    {
      key: 'reason',
      label: '处理原因',
      type: 'input',
      props: { placeholder: '按处理原因搜索', clearable: true }
    },
    {
      key: 'status',
      label: '提现状态',
      type: 'select',
      props: {
        clearable: true,
        options: Object.entries(statusLabels).map(([value, label]) => ({ value, label }))
      }
    }
  ]
  const rows = computed(() =>
    (data.value?.withdrawals || [])
      .filter(
        (row) =>
          (!applied.value.status || row.status === applied.value.status) &&
          personName(row.userId)
            .toLowerCase()
            .includes(applied.value.keyword.trim().toLowerCase()) &&
          (row.reason || '').toLowerCase().includes(applied.value.reason.trim().toLowerCase())
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<Withdrawal>(() => [
    { prop: 'userId', label: '打手', minWidth: 120, useSlot: true },
    { prop: 'amount', label: '申请金额', minWidth: 140, useSlot: true },
    { prop: 'createdAt', label: '申请时间', minWidth: 180, useSlot: true },
    { prop: 'status', label: '状态', minWidth: 100, useSlot: true },
    { prop: 'paymentSnapshot', label: '申请时收款资料', minWidth: 180, useSlot: true },
    {
      prop: 'paidAt',
      label: '发放 / 撤回时间 / 原因',
      minWidth: 185,
      useSlot: true,
      showOverflowTooltip: true
    },
    { prop: 'receipt', label: '发放凭证', minWidth: 100, useSlot: true },
    { prop: 'actions', label: '操作', width: 270, fixed: 'right', useSlot: true }
  ])
  const payment = reactive({
    open: false,
    id: '',
    name: '',
    amount: 0,
    snapshot: null as PlayerPaymentSnapshot | null,
    receipt: null as Attachment | null
  })
  const rejection = reactive({ open: false, id: '', reason: '' })
  const rejectionRecord = computed(() =>
    data.value?.withdrawals.find((row) => row.id === rejection.id)
  )
  const restoreError = ref('')
  const pendingRestore = ref<{
    kind: 'detail' | 'payment' | 'rejection'
    recordId?: string
    isCurrent?: () => boolean
  } | null>(null)
  function queueRestore(
    kind: 'detail' | 'payment' | 'rejection',
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
    if (!pendingRestore.value || loading.value || saving.value || uploading.value || !data.value)
      return
    const request = pendingRestore.value
    pendingRestore.value = null
    const row = data.value.withdrawals.find((item) => item.id === request.recordId)
    if (!data.value.permissions.includes('finance.withdrawals') || !row) {
      restoreError.value = '这笔提现不存在或当前账号无权读取，请返回提现列表重新核对。'
      return
    }
    if (request.kind === 'detail') detailId.value = row.id
    else if (request.kind === 'payment' && row.status === 'approved') openPay(row)
    else if (request.kind === 'rejection' && ['pending', 'approved'].includes(row.status))
      openReject(row)
    else restoreError.value = '这笔提现的状态已经变化，请返回列表查看当前处理结果。'
  }
  watch([data, loading, saving, uploading], resumeRestore)
  function applySearch() {
    applied.value = { ...search.value }
    resetPage()
  }
  function resetSearch() {
    search.value = { keyword: '', reason: '', status: '' }
    applySearch()
  }
  function personName(id: string) {
    return data.value?.users.find((row) => row.id === id)?.name || id
  }
  function openPay(row: Withdrawal) {
    if (saving.value || uploading.value) return
    uploading.value = false
    Object.assign(payment, {
      open: true,
      id: row.id,
      name: personName(row.userId),
      amount: row.amount,
      snapshot: row.paymentSnapshot || null,
      receipt: null
    })
  }
  function openReject(row: Withdrawal) {
    if (saving.value || uploading.value) return
    Object.assign(rejection, { open: true, id: row.id, reason: '' })
  }
  async function approve(row: Withdrawal) {
    try {
      await ElMessageBox.confirm(
        businessConfirmMessage(
          `确认审核通过 ${personName(row.userId)} 的 ${money(row.amount)} 提现申请？`,
          [
            { label: '提现编号', value: row.id },
            { label: '收款打手', value: personName(row.userId) },
            { label: '原申请金额', value: money(row.amount) },
            { label: '申请时间', value: formatTime(row.createdAt) },
            { label: '当前状态', value: statusLabels[row.status] },
            { label: '所属自然周', value: row.weekStart || '历史记录未登记' },
            {
              label: '申请时收款方式',
              value:
                row.paymentSnapshot?.method === 'wechat'
                  ? '微信'
                  : row.paymentSnapshot?.method === 'alipay'
                    ? '支付宝'
                    : '历史记录未登记'
            }
          ],
          '审核通过后进入待发放，实际人工转账及登记付款凭证另行处理。'
        ),
        '提现审核',
        { confirmButtonText: '审核通过', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    await submit(`/withdrawals/${row.id}/action`, { action: 'approve' }, '提现已审核，等待人工转账')
  }
  async function savePay() {
    if (uploading.value || !payment.receipt)
      return void ElMessage.warning('请等待实际转账凭证上传完成')
    if (
      await submit(
        `/withdrawals/${payment.id}/action`,
        { action: 'pay', receipt: payment.receipt },
        '已登记发放'
      )
    )
      payment.open = false
  }
  async function saveReject() {
    if (!rejection.reason.trim()) return void ElMessage.warning('请填写驳回原因')
    if (
      await submit(
        `/withdrawals/${rejection.id}/action`,
        { action: 'reject', reason: rejection.reason },
        '提现已驳回'
      )
    )
      rejection.open = false
  }
</script>
