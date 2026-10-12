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
      title="申请提现先占用额度；审核通过后由财务人工转账，再上传实际转账凭证登记发放。提现不重复计入经营成本。"
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
          :type="row.status === 'paid' ? 'success' : row.status === 'rejected' ? 'info' : 'warning'"
          >{{ statusLabels[row.status as Withdrawal['status']] }}</ElTag
        ></template
      >
      <template #paidAt="{ row }">{{
        row.paidAt ? formatTime(row.paidAt) : row.reason || '—'
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
      <template #actions="{ row }">
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
    <ElDialog
      v-model="payment.open"
      title="登记提现已发放"
      width="min(540px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving && !uploading"
      :show-close="!saving && !uploading"
      destroy-on-close
    >
      <ElDescriptions :column="1" border class="mb-4"
        ><ElDescriptionsItem label="收款打手">{{ payment.name }}</ElDescriptionsItem
        ><ElDescriptionsItem label="实际转账">{{
          money(payment.amount)
        }}</ElDescriptionsItem></ElDescriptions
      >
      <ElForm label-position="top" :disabled="saving || uploading"
        ><ElFormItem label="实际转账凭证" required
          ><BusinessUpload v-model="payment.receipt" @busy="uploading = $event" /></ElFormItem
      ></ElForm>
      <p class="text-g-500">完成实际人工转账后登记，系统记录发放时间及经办人。</p>
      <template #footer
        ><ElButton :disabled="saving || uploading" @click="payment.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" :disabled="uploading" @click="savePay"
          >确认已发放</ElButton
        ></template
      >
    </ElDialog>
    <ElDialog
      v-model="rejection.open"
      title="驳回提现申请"
      width="min(540px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving && !uploading"
      :show-close="!saving && !uploading"
      ><ElInput
        v-model="rejection.reason"
        :disabled="saving"
        type="textarea"
        :rows="4"
        maxlength="2000"
        show-word-limit
        placeholder="填写驳回原因"
      /><template #footer
        ><ElButton :disabled="saving" @click="rejection.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveReject"
          >确认驳回</ElButton
        ></template
      ></ElDialog
    >
  </div>
</template>

<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { formatTime, money, useStudio } from '@/hooks/business/useStudio'
  import BusinessUpload from '@/components/business/BusinessUpload.vue'
  import type { Attachment, Withdrawal } from '@/types/studio'
  import { useFinanceActions } from './useFinanceActions'

  const { data, loading } = useStudio()
  const { saving, submit, reload } = useFinanceActions()
  const uploading = ref(false)
  const emit = defineEmits<{ busy: [value: boolean] }>()
  watch([saving, uploading], ([saving, uploading]) => emit('busy', saving || uploading), {
    immediate: true
  })
  const statusLabels = { pending: '待审核', approved: '待发放', paid: '已发放', rejected: '已驳回' }
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
    {
      prop: 'paidAt',
      label: '发放时间 / 原因',
      minWidth: 185,
      useSlot: true,
      showOverflowTooltip: true
    },
    { prop: 'receipt', label: '发放凭证', minWidth: 100, useSlot: true },
    { prop: 'actions', label: '操作', width: 190, fixed: 'right', useSlot: true }
  ])
  const payment = reactive({
    open: false,
    id: '',
    name: '',
    amount: 0,
    receipt: null as Attachment | null
  })
  const rejection = reactive({ open: false, id: '', reason: '' })
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
        `确认审核通过 ${personName(row.userId)} 的 ${money(row.amount)} 提现申请？`,
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
