<template>
  <ElDialog
    v-model="visible"
    :title="`${customerName} · 储值账户`"
    width="min(980px, 96vw)"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <div v-loading="loading">
      <ElAlert v-if="error" :title="error" type="error" :closable="false" class="mb-4" />
      <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div
          ><p class="text-sm text-g-500">可用储值余额</p
          ><p class="mt-2 text-2xl font-semibold">{{ money(balance) }}</p></div
        >
        <ElButton :disabled="busy" @click="loadAccount">刷新账户</ElButton>
      </div>
      <ElAlert
        title="充值属于预收款；订单使用储值付款时才计订单收入。非订单扣款计其他收入，退回储值不重复计收入。"
        type="info"
        :closable="false"
        class="mb-4"
      />
      <template v-if="canManage">
        <ElForm :model="draft" :disabled="busy" label-position="top" @submit.prevent="save">
          <ElRow :gutter="16">
            <ElCol :xs="24" :sm="12"
              ><ElFormItem label="操作类型" required
                ><ElRadioGroup v-model="draft.kind">
                  <ElRadioButton value="recharge">充值</ElRadioButton
                  ><ElRadioButton value="deduction">非订单扣款</ElRadioButton
                  ><ElRadioButton value="return">退回储值</ElRadioButton>
                </ElRadioGroup></ElFormItem
              ></ElCol
            >
            <ElCol :xs="24" :sm="12"
              ><ElFormItem label="金额（元）" required
                ><ElInputNumber
                  v-model="draft.amount"
                  :min="0.01"
                  :precision="2"
                  :step="0.01"
                  controls-position="right"
                  class="!w-full" /></ElFormItem
            ></ElCol>
          </ElRow>
          <ElFormItem label="原因 / 处理说明" required
            ><ElInput
              v-model="draft.reason"
              type="textarea"
              :rows="2"
              maxlength="1000"
              show-word-limit
          /></ElFormItem>
          <ElFormItem label="收款或处理凭证（选填）"
            ><BusinessUpload v-model="draft.receipt" :disabled="saving" @busy="uploading = $event"
          /></ElFormItem>
          <ElAlert
            v-if="draft.kind === 'return'"
            title="请完成线下退回后登记；本操作只退回尚未消费的储值，不替代订单退款。"
            type="warning"
            :closable="false"
            class="mb-3"
          />
          <div class="flex justify-between items-center flex-wrap gap-3 mb-4">
            <span class="text-sm text-g-500">本次操作后余额：{{ money(nextBalance) }}</span>
            <ElButton
              type="primary"
              native-type="submit"
              :loading="saving"
              :disabled="uploading || balance === null || loading"
              >确认登记</ElButton
            >
          </div>
        </ElForm>
        <ElDivider content-position="left">储值流水</ElDivider>
        <ElTable
          :data="transactions"
          v-loading="ledgerLoading"
          row-key="id"
          empty-text="暂无储值流水"
        >
          <ElTableColumn label="时间" min-width="175"
            ><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></ElTableColumn
          >
          <ElTableColumn label="类型" min-width="140"
            ><template #default="{ row }">{{
              kindLabels[row.kind] || row.kind
            }}</template></ElTableColumn
          >
          <ElTableColumn label="余额变动" width="140"
            ><template #default="{ row }"
              >{{ row.delta > 0 ? '+' : '' }}{{ money(row.delta) }}</template
            ></ElTableColumn
          >
          <ElTableColumn label="当时余额" width="140"
            ><template #default="{ row }">{{ money(row.balanceAfter) }}</template></ElTableColumn
          >
          <ElTableColumn prop="reason" label="原因" min-width="220" show-overflow-tooltip />
          <ElTableColumn label="关联订单" min-width="110"
            ><template #default="{ row }"
              ><ElButton
                v-if="row.orderId && can('orders.view')"
                link
                type="primary"
                :disabled="busy"
                @click="openOrder(row.orderId)"
                >查看订单</ElButton
              ><span v-else>—</span></template
            ></ElTableColumn
          >
          <ElTableColumn label="凭证" width="90"
            ><template #default="{ row }"
              ><ElLink
                v-if="row.receipt"
                :href="row.receipt.url"
                target="_blank"
                rel="noopener"
                type="primary"
                >查看</ElLink
              ><span v-else>—</span></template
            ></ElTableColumn
          >
        </ElTable>
        <div class="overflow-x-auto max-w-full"
          ><ElPagination
            v-if="pagination.total > 0"
            v-model:current-page="pagination.current"
            v-model:page-size="pagination.size"
            :page-sizes="[10, 20, 50]"
            :total="pagination.total"
            layout="total, sizes, prev, pager, next"
            class="mt-4"
            @current-change="loadLedger"
            @size-change="changeSize"
        /></div>
      </template>
      <p v-else class="text-sm text-g-500"
        >充值、退回及非订单扣款由财务登记；创建订单时可选择储值支付。</p
      >
    </div>
  </ElDialog>
</template>
<script setup lang="ts">
  import { ElMessage } from 'element-plus'
  import { studioRequest } from '@/api/studio'
  import { useStudio, money, formatTime } from '@/hooks/business/useStudio'
  import type { Attachment } from '@/types/studio'
  import BusinessUpload from '@/components/business/BusinessUpload.vue'
  const props = defineProps<{ customerId: string; customerName: string }>()
  const visible = defineModel<boolean>({ default: false })
  const emit = defineEmits<{ busy: [value: boolean] }>()
  const router = useRouter()
  const { can, user, mutate, clearSession } = useStudio()
  const canManage = computed(() => can('finance.refunds'))
  const canRead = computed(() =>
    ['orders.view', 'orders.create', 'users.manage', 'finance.refunds'].some(can)
  )
  const balance = ref<number | null>(null)
  const loading = ref(false),
    ledgerLoading = ref(false),
    saving = ref(false),
    uploading = ref(false)
  const error = ref('')
  const busy = computed(() => saving.value || uploading.value)
  const pagination = reactive({ current: 1, size: 20, total: 0 })
  interface Transaction {
    id: string
    kind: string
    amount: number
    delta: number
    balanceAfter: number
    reason: string
    orderId: string | null
    receipt: Attachment | null
    createdAt: string
  }
  const transactions = ref<Transaction[]>([])
  const kindLabels: Record<string, string> = {
    recharge: '储值充值',
    deduction: '非订单扣款',
    return: '退回储值',
    'order-payment': '订单储值支付',
    'order-refund': '订单退款回储值'
  }
  const draft = reactive({
    kind: 'recharge' as 'recharge' | 'deduction' | 'return',
    amount: null as number | null,
    reason: '',
    receipt: null as Attachment | null
  })
  let requestId = crypto.randomUUID(),
    attempted = false,
    accountVersion = 0,
    ledgerVersion = 0
  const cents = computed(() => Math.round(Number(draft.amount) * 100))
  const nextBalance = computed(() =>
    balance.value === null
      ? null
      : balance.value + (draft.kind === 'recharge' ? cents.value : -cents.value)
  )
  watch(
    () => JSON.stringify(draft),
    () => {
      if (!attempted) requestId = crypto.randomUUID()
    },
    { flush: 'sync' }
  )
  watch(busy, (value) => emit('busy', value), { flush: 'sync' })
  function handleError(cause: unknown) {
    if ((cause as { status?: number }).status === 401) clearSession()
    error.value = cause instanceof Error ? cause.message : '账户加载失败，请重试'
    if (error.value.includes('requestId'))
      error.value = '本次操作的内容已变化，请先核对上一笔流水，再关闭窗口重新登记新的操作。'
  }
  async function loadLedger() {
    if (!visible.value || !props.customerId || !canManage.value) return
    const version = ++ledgerVersion
    ledgerLoading.value = true
    try {
      const result = await studioRequest<{
        records: Transaction[]
        total: number
        current: number
        size: number
      }>(
        `customers/${encodeURIComponent(props.customerId)}/transactions?current=${pagination.current}&size=${pagination.size}`
      )
      if (version !== ledgerVersion || !visible.value || !canManage.value) return
      transactions.value = result.records
      Object.assign(pagination, { total: result.total, current: result.current, size: result.size })
    } catch (cause) {
      if (version === ledgerVersion) handleError(cause)
    } finally {
      if (version === ledgerVersion) ledgerLoading.value = false
    }
  }
  async function loadAccount() {
    if (!visible.value || !props.customerId || !canRead.value) return
    const version = ++accountVersion
    loading.value = true
    error.value = ''
    try {
      const result = await studioRequest<{ customerId: string; balance: number }>(
        `customers/${encodeURIComponent(props.customerId)}/balance`
      )
      if (version !== accountVersion || !visible.value || !canRead.value) return
      balance.value = result.balance
      await loadLedger()
    } catch (cause) {
      if (version === accountVersion) handleError(cause)
    } finally {
      if (version === accountVersion) loading.value = false
    }
  }
  function changeSize() {
    pagination.current = 1
    void loadLedger()
  }
  async function save() {
    if (busy.value || loading.value || !canManage.value || balance.value === null) return
    if (!Number.isSafeInteger(cents.value) || cents.value <= 0 || !draft.reason.trim())
      return void ElMessage.warning('请填写有效金额和处理原因')
    if (!attempted && draft.kind !== 'recharge' && cents.value > balance.value)
      return void ElMessage.warning('扣款或退回不能超过当前储值余额')
    saving.value = true
    attempted = true
    error.value = ''
    try {
      await mutate('/customer-transactions', {
        customerId: props.customerId,
        kind: draft.kind,
        amount: cents.value,
        reason: draft.reason.trim(),
        receipt: draft.receipt,
        requestId
      })
      attempted = false
      requestId = crypto.randomUUID()
      Object.assign(draft, { amount: null, reason: '', receipt: null })
      pagination.current = 1
      await loadAccount()
      ElMessage.success('储值操作已登记')
    } catch (cause) {
      handleError(cause)
      const status = (cause as { status?: number }).status
      if (!status || status >= 500)
        error.value =
          '操作结果尚未确认，请重试原操作，或先刷新并核对流水后再登记新的操作。' + error.value
      ElMessage.error(error.value)
    } finally {
      saving.value = false
    }
  }
  function openOrder(id: string) {
    if (busy.value) return
    visible.value = false
    void router.push({ path: '/orders/list', query: { id } })
  }
  function invalidate() {
    accountVersion++
    ledgerVersion++
    loading.value = false
    ledgerLoading.value = false
    transactions.value = []
  }
  watch([visible, () => props.customerId], ([open]) => {
    invalidate()
    balance.value = null
    if (open) {
      attempted = false
      Object.assign(draft, { kind: 'recharge', amount: null, reason: '', receipt: null })
      requestId = crypto.randomUUID()
      pagination.current = 1
      void loadAccount()
    }
  })
  watch(canManage, (allowed) => {
    if (!allowed) {
      ledgerVersion++
      transactions.value = []
      ledgerLoading.value = false
    }
  })
  watch(canRead, (allowed) => {
    if (!allowed) {
      invalidate()
      visible.value = false
      balance.value = null
    }
  })
  onBeforeRouteLeave(() => !user.value || !busy.value)
  onUnmounted(invalidate)
</script>
