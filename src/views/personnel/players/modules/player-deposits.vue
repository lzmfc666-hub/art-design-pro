<template>
  <div>
    <div class="deposit-overview">
      <BusinessStatCard
        label="独立押金余额"
        :value="account ? money(account.balance) : '—'"
        icon="ri:shield-check-line"
        description="不计入可用报酬，也不能申请普通提现"
      />
      <div class="deposit-policy"
        ><h3>押金保留规则</h3
        ><p>日常报酬扣款不动押金。只有退店或跑路时，由财务登记退还或没收，并保留独立台账。</p></div
      >
    </div>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" class="mb-4" />
    <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="load">
      <template #left
        ><ElSpace wrap
          ><ElButton type="primary" :disabled="busy || loading || !account" @click="openDeposit"
            >缴纳押金</ElButton
          ><ElButton
            plain
            type="warning"
            :disabled="busy || loading || !account || account.balance <= 0"
            @click="openExit"
            >退店 / 跑路处理</ElButton
          ></ElSpace
        ></template
      >
    </ArtTableHeader>
    <ArtTable
      :data="account?.records || []"
      :columns="columns"
      :loading="loading"
      :pagination="pagination"
      height="360"
      @pagination:size-change="changeSize"
      @pagination:current-change="changePage"
    >
      <template #kind="{ row }"
        ><ElTag
          :type="row.kind === 'deposit' ? 'success' : row.kind === 'penalty' ? 'danger' : 'info'"
          >{{ kindLabel(row.kind) }}</ElTag
        ></template
      >
      <template #amount="{ row }">{{ money(row.amount) }}</template>
      <template #balanceAfter="{ row }">{{ money(row.balanceAfter) }}</template>
      <template #exitType="{ row }">{{
        row.exitType === 'leave' ? '退店' : row.exitType === 'absconded' ? '跑路' : '—'
      }}</template>
      <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
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
    </ArtTable>
    <ElDialog
      v-model="open"
      :title="form.kind === 'deposit' ? '登记打手缴纳押金' : '退店 / 跑路押金处理'"
      width="min(620px,94vw)"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      destroy-on-close
    >
      <ElAlert
        v-if="form.kind !== 'deposit'"
        title="退出资金处理不会自动停用账号、关闭权限或清空订单工资，请另外核对三个开关和未完成订单的人员移交。"
        type="warning"
        :closable="false"
        class="mb-4"
      />
      <ElForm
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        :disabled="busy"
        @submit.prevent="save"
      >
        <ElDescriptions :column="1" border class="mb-4"
          ><ElDescriptionsItem label="打手"
            >{{ player.name }} · {{ player.username }}</ElDescriptionsItem
          ><ElDescriptionsItem label="当前押金余额">{{
            account ? money(account.balance) : '—'
          }}</ElDescriptionsItem></ElDescriptions
        >
        <template v-if="form.kind !== 'deposit'">
          <ElFormItem label="退出场景" prop="exitType"
            ><ElRadioGroup v-model="form.exitType"
              ><ElRadioButton value="leave">退店</ElRadioButton
              ><ElRadioButton value="absconded">跑路</ElRadioButton></ElRadioGroup
            ></ElFormItem
          >
          <ElFormItem label="处理方式"
            ><ElRadioGroup v-model="form.kind"
              ><ElRadioButton value="return">退还押金</ElRadioButton
              ><ElRadioButton value="penalty">没收押金</ElRadioButton></ElRadioGroup
            ></ElFormItem
          >
          <p class="text-sm text-g-500 mb-4">{{
            form.kind === 'penalty'
              ? '没收部分计入工作室其他收入；报酬钱包保持独立。'
              : '完成实际退还后登记，退还金额不能超过当前押金余额。'
          }}</p>
        </template>
        <ElFormItem label="金额（元）" prop="amount"
          ><BusinessAmount v-model="form.amount" placeholder="填写实际金额"
        /></ElFormItem>
        <ElFormItem :label="form.kind === 'deposit' ? '缴纳说明' : '处理原因'" prop="reason"
          ><ElInput
            v-model="form.reason"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            placeholder="填写实际发生情况和处理依据"
        /></ElFormItem>
        <ElFormItem label="资金凭证（可选）"
          ><BusinessUpload v-model="form.receipt" :disabled="saving" @busy="uploading = $event"
        /></ElFormItem>
      </ElForm>
      <template #footer
        ><ElButton :disabled="busy" @click="open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" :disabled="uploading" @click="save"
          >确认登记</ElButton
        ></template
      >
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import { computed, onUnmounted, reactive, ref, watch } from 'vue'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import { studioRequest } from '@/api/studio'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import BusinessUpload from '@/components/business/BusinessUpload.vue'
  import { formatTime, money, useStudio } from '@/hooks/business/useStudio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Attachment, FundTransaction, PlayerListRecord } from '@/types/studio'

  interface DepositPage {
    userId: string
    balance: number
    records: FundTransaction[]
    total: number
    current: number
    size: number
  }
  const props = defineProps<{ player: PlayerListRecord }>()
  const emit = defineEmits<{ updated: []; busy: [value: boolean] }>()
  const { can, mutate, clearSession } = useStudio()
  const account = ref<DepositPage | null>(null)
  const loading = ref(false),
    error = ref(''),
    saving = ref(false),
    uploading = ref(false)
  const busy = computed(() => saving.value || uploading.value)
  watch(busy, (value) => emit('busy', value))
  const pagination = reactive({ current: 1, size: 20, total: 0 })
  let version = 0
  let controller: AbortController | undefined
  onUnmounted(() => {
    version++
    controller?.abort()
    emit('busy', false)
  })
  const kindLabel = (kind: string) =>
    ({ deposit: '缴纳押金', penalty: '退出没收', return: '退还押金' })[
      kind as 'deposit' | 'penalty' | 'return'
    ] || kind
  const { columns, columnChecks } = useTableColumns<FundTransaction>(() => [
    { prop: 'kind', label: '类型', width: 130, useSlot: true },
    { prop: 'amount', label: '金额', width: 125, useSlot: true },
    { prop: 'balanceAfter', label: '操作后押金', width: 145, useSlot: true },
    { prop: 'exitType', label: '退出场景', width: 100, useSlot: true },
    { prop: 'reason', label: '原因 / 说明', minWidth: 240, showOverflowTooltip: true },
    { prop: 'createdByName', label: '经办人', minWidth: 120 },
    { prop: 'createdAt', label: '登记时间', minWidth: 175, useSlot: true },
    { prop: 'receipt', label: '凭证', width: 100, useSlot: true }
  ])
  async function load() {
    if (busy.value || !can('finance.withdrawals')) return
    const currentVersion = ++version
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = ''
    try {
      const result = await studioRequest<DepositPage>(
        `players/${encodeURIComponent(props.player.id)}/deposits?${new URLSearchParams({ current: String(pagination.current), size: String(pagination.size) })}`,
        undefined,
        'GET',
        controller.signal
      )
      if (currentVersion !== version) return
      account.value = result
      Object.assign(pagination, { total: result.total, current: result.current, size: result.size })
    } catch (cause) {
      if (currentVersion !== version || (cause as { name?: string }).name === 'AbortError') return
      if ((cause as { status?: number }).status === 401) clearSession()
      account.value = null
      error.value = cause instanceof Error ? cause.message : '押金账户读取失败'
    } finally {
      if (currentVersion === version) loading.value = false
    }
  }
  function changePage(current: number) {
    if (!busy.value) {
      pagination.current = current
      void load()
    }
  }
  function changeSize(size: number) {
    if (!busy.value) {
      pagination.size = size
      pagination.current = 1
      void load()
    }
  }
  watch(
    () => props.player.id,
    () => {
      pagination.current = 1
      account.value = null
      void load()
    },
    { immediate: true }
  )
  const open = ref(false),
    formRef = ref<FormInstance>()
  const form = reactive({
    kind: 'deposit' as 'deposit' | 'penalty' | 'return',
    exitType: '' as '' | 'leave' | 'absconded',
    amount: null as number | null,
    reason: '',
    receipt: null as Attachment | null,
    requestId: ''
  })
  const rules: FormRules = {
    amount: [
      {
        validator: (_rule, value, callback) =>
          callback(
            !Number.isSafeInteger(value) || value <= 0
              ? new Error('请输入大于 0 的有效金额')
              : form.kind !== 'deposit' && (!account.value || value > account.value.balance)
                ? new Error('金额不能超过当前押金余额')
                : undefined
          ),
        trigger: 'blur'
      }
    ],
    reason: [
      { required: true, whitespace: true, message: '请填写原因或缴纳说明', trigger: 'blur' }
    ],
    exitType: [
      {
        validator: (_rule, value, callback) =>
          callback(
            form.kind !== 'deposit' && !value ? new Error('请选择退店或跑路场景') : undefined
          ),
        trigger: 'change'
      }
    ]
  }
  function reset(kind: 'deposit' | 'return') {
    Object.assign(form, {
      kind,
      exitType: '',
      amount: null,
      reason: '',
      receipt: null,
      requestId: crypto.randomUUID()
    })
    open.value = true
  }
  function openDeposit() {
    if (!busy.value && account.value && can('finance.withdrawals')) reset('deposit')
  }
  function openExit() {
    if (!busy.value && account.value && account.value.balance > 0 && can('finance.withdrawals'))
      reset('return')
  }
  async function save() {
    if (busy.value || !can('finance.withdrawals')) return
    saving.value = true
    try {
      if (!(await formRef.value?.validate().catch(() => false))) return
      await mutate('/player-deposit-transactions', {
        userId: props.player.id,
        kind: form.kind,
        exitType: form.kind === 'deposit' ? undefined : form.exitType,
        amount: form.amount,
        reason: form.reason.trim(),
        receipt: form.receipt,
        requestId: form.requestId
      })
      open.value = false
      ElMessage.success('押金台账已登记，报酬钱包保持独立')
      emit('updated')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '押金登记失败')
    } finally {
      saving.value = false
    }
    if (!open.value) await load()
  }
</script>

<style scoped lang="scss">
  .deposit-overview {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: 18px;
    align-items: stretch;
    margin-bottom: 20px;
  }

  .deposit-policy {
    padding: 22px;
    background: var(--el-fill-color-light);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 12px;
  }

  .deposit-policy h3 {
    margin-bottom: 10px;
    font-weight: 600;
  }

  .deposit-policy p {
    font-size: 14px;
    line-height: 1.8;
    color: var(--el-text-color-secondary);
  }

  @media (width < 768px) {
    .deposit-overview {
      grid-template-columns: 1fr;
    }
  }
</style>
