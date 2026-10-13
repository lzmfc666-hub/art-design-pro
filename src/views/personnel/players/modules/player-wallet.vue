<template>
  <div class="player-wallet">
    <div class="account-stats">
      <BusinessStatCard
        label="可用报酬"
        :value="amount(player.wallet?.available)"
        icon="ri:wallet-3-line"
        description="扣款仅从这部分余额生效"
      />
      <BusinessStatCard
        label="在途提现"
        :value="amount(player.wallet?.occupied)"
        icon="ri:time-line"
        tone="warning"
        description="待审核和待发放申请占用"
      />
      <BusinessStatCard
        label="已发提现"
        :value="amount(player.wallet?.paid)"
        icon="ri:bank-card-line"
        tone="success"
        description="历史发放继续保留"
      />
    </div>
    <ElAlert
      title="日常扣款只扣可用报酬；超过部分登记待追回。押金账户保持独立，补款也不会改变原提现记录。"
      type="info"
      :closable="false"
      class="mb-4"
    />
    <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload">
      <template #left
        ><ElSpace wrap
          ><ElButton type="primary" :disabled="busy" @click="openAdjustment('supplement')"
            >补款</ElButton
          ><ElButton type="danger" plain :disabled="busy" @click="openAdjustment('deduction')"
            >扣款</ElButton
          ><span class="text-sm text-g-500">报酬扣补记录 {{ rows.length }} 笔</span></ElSpace
        ></template
      >
    </ArtTableHeader>
    <ArtTable
      :data="tableData"
      :columns="columns"
      :pagination="pagination"
      :loading="loading"
      height="360"
      @pagination:size-change="handleSizeChange"
      @pagination:current-change="handleCurrentChange"
    >
      <template #kind="{ row }"
        ><ElTag :type="row.kind === 'supplement' ? 'success' : 'danger'">{{
          row.kind === 'supplement' ? '补款' : '扣款'
        }}</ElTag></template
      >
      <template #amount="{ row }">{{ money(row.amount) }}</template>
      <template #appliedAmount="{ row }">{{ money(row.appliedAmount) }}</template>
      <template #manualAmount="{ row }">{{ money(row.manualAmount) }}</template>
      <template #status="{ row }">{{
        statusLabels[row.status as PlayerAdjustment['status']]
      }}</template>
      <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
      <template #operation="{ row }"
        ><ElButton
          v-if="row.status === 'manual'"
          link
          type="primary"
          :disabled="busy"
          @click="openResolution(row)"
          >登记差额处理</ElButton
        ><span v-else>{{
          row.resolution === 'recovered'
            ? '已线下追回'
            : row.resolution === 'waived'
              ? '剩余差额已免除'
              : '—'
        }}</span></template
      >
    </ArtTable>
    <ElDialog
      v-model="adjustmentOpen"
      :title="form.kind === 'supplement' ? '打手报酬补款' : '打手报酬扣款'"
      width="min(560px,94vw)"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      destroy-on-close
    >
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
          ><ElDescriptionsItem label="当前可用报酬">{{
            amount(player.wallet?.available)
          }}</ElDescriptionsItem></ElDescriptions
        >
        <ElFormItem label="金额（元）" prop="amount"
          ><BusinessAmount v-model="form.amount" placeholder="填写实际金额"
        /></ElFormItem>
        <ElAlert
          v-if="
            form.kind === 'deduction' &&
            form.amount != null &&
            player.wallet &&
            form.amount > player.wallet.available
          "
          :title="`超过可用报酬的 ${money(form.amount - player.wallet.available)} 将登记人工待追回，押金不受影响。`"
          type="warning"
          :closable="false"
          class="mb-4"
        />
        <ElFormItem v-if="data?.orders.length" label="关联订单（可选）"
          ><ElSelect v-model="form.orderId" filterable clearable class="w-full"
            ><ElOption
              v-for="order in data.orders"
              :key="order.id"
              :value="order.id"
              :label="order.orderNo + ' · ' + order.title" /></ElSelect
        ></ElFormItem>
        <ElFormItem label="原因" prop="reason"
          ><ElInput
            v-model="form.reason"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            placeholder="填写补款、扣款或更正的具体原因"
        /></ElFormItem>
      </ElForm>
      <template #footer
        ><ElButton :disabled="busy" @click="adjustmentOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">确认登记</ElButton></template
      >
    </ElDialog>
    <ElDialog
      :model-value="!!resolveTarget"
      title="登记待追回差额处理"
      width="min(560px,94vw)"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      @update:model-value="closeResolution"
    >
      <p class="mb-4">{{ player.name }} · 待处理 {{ money(resolveTarget?.manualAmount || 0) }}</p>
      <ElForm label-position="top" :disabled="busy">
        <ElFormItem label="处理结果"
          ><ElRadioGroup v-model="resolution"
            ><ElRadioButton value="recovered">已线下追回</ElRadioButton
            ><ElRadioButton value="waived">免除剩余差额</ElRadioButton></ElRadioGroup
          ></ElFormItem
        >
        <ElFormItem label="处理说明" required
          ><ElInput
            v-model="resolutionReason"
            type="textarea"
            :rows="3"
            maxlength="2000"
            placeholder="填写实际追回凭据或免除依据"
        /></ElFormItem>
      </ElForm>
      <template #footer
        ><ElButton :disabled="busy" @click="resolveTarget = null">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="resolve"
          >保存处理结果</ElButton
        ></template
      >
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import { computed, onUnmounted, reactive, ref, watch } from 'vue'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import { formatTime, money, useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { PlayerAdjustment, PlayerListRecord } from '@/types/studio'

  const props = defineProps<{ player: PlayerListRecord }>()
  const emit = defineEmits<{ updated: []; busy: [value: boolean] }>()
  const { data, can, mutate, refresh, loading } = useStudio()
  const saving = ref(false)
  const busy = computed(() => saving.value)
  watch(busy, (value) => emit('busy', value))
  onUnmounted(() => emit('busy', false))
  const amount = (value?: number | null) => (value == null ? '—' : money(value))
  const statusLabels = { applied: '已入账', manual: '差额待人工处理', resolved: '差额已处理' }
  const rows = computed(() =>
    (data.value?.playerAdjustments || [])
      .filter((row) => row.userId === props.player.id)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange } = useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<PlayerAdjustment>(() => [
    { prop: 'kind', label: '类型', width: 90, useSlot: true },
    { prop: 'amount', label: '登记金额', width: 125, useSlot: true },
    { prop: 'appliedAmount', label: '实际入账', width: 125, useSlot: true },
    { prop: 'manualAmount', label: '人工差额', width: 125, useSlot: true },
    { prop: 'status', label: '状态', minWidth: 150, useSlot: true },
    { prop: 'reason', label: '原因', minWidth: 220, showOverflowTooltip: true },
    { prop: 'createdAt', label: '登记时间', minWidth: 175, useSlot: true },
    { prop: 'operation', label: '处理', width: 155, fixed: 'right', useSlot: true }
  ])
  const formRef = ref<FormInstance>()
  const adjustmentOpen = ref(false)
  const form = reactive({
    kind: 'supplement' as 'supplement' | 'deduction',
    amount: null as number | null,
    orderId: '',
    reason: '',
    requestId: ''
  })
  const rules: FormRules = {
    amount: [
      {
        validator: (_rule, value, callback) =>
          callback(
            Number.isSafeInteger(value) && value > 0
              ? undefined
              : new Error('请输入大于 0 的有效金额')
          ),
        trigger: 'blur'
      }
    ],
    reason: [{ required: true, whitespace: true, message: '请填写原因', trigger: 'blur' }]
  }
  function openAdjustment(kind: 'supplement' | 'deduction') {
    if (busy.value || !can('finance.withdrawals')) return
    Object.assign(form, {
      kind,
      amount: null,
      orderId: '',
      reason: '',
      requestId: crypto.randomUUID()
    })
    adjustmentOpen.value = true
  }
  async function save() {
    if (busy.value || !can('finance.withdrawals')) return
    saving.value = true
    try {
      if (!(await formRef.value?.validate().catch(() => false))) return
      const result = await mutate<PlayerAdjustment>('/player-adjustments', {
        userId: props.player.id,
        kind: form.kind,
        amount: form.amount,
        orderId: form.orderId || null,
        reason: form.reason.trim(),
        requestId: form.requestId
      })
      adjustmentOpen.value = false
      ElMessage.success(
        result.manualAmount > 0
          ? `已扣可用报酬 ${money(result.appliedAmount)}，待追回 ${money(result.manualAmount)}`
          : '报酬扣补已登记'
      )
      emit('updated')
    } catch (error) {
      const status = (error as { status?: number }).status
      if (typeof status !== 'number' || status >= 500)
        ElMessage.warning('结果未确认，核对流水后再新操作。可重试本次登记。')
      else ElMessage.error(error instanceof Error ? error.message : '登记失败')
    } finally {
      saving.value = false
    }
  }
  const resolveTarget = ref<PlayerAdjustment | null>(null)
  const resolution = ref<'recovered' | 'waived'>('recovered')
  const resolutionReason = ref('')
  function openResolution(row: PlayerAdjustment) {
    if (busy.value || !can('finance.withdrawals')) return
    resolveTarget.value = row
    resolution.value = 'recovered'
    resolutionReason.value = ''
  }
  function closeResolution(value: boolean) {
    if (!value && !busy.value) resolveTarget.value = null
  }
  async function resolve() {
    if (busy.value || !resolveTarget.value || !can('finance.withdrawals')) return
    if (!resolutionReason.value.trim()) return void ElMessage.warning('请填写处理说明')
    saving.value = true
    try {
      await mutate(`/player-adjustments/${resolveTarget.value.id}/action`, {
        action: 'resolve',
        resolution: resolution.value,
        reason: resolutionReason.value.trim()
      })
      resolveTarget.value = null
      ElMessage.success('差额处理已保存')
      emit('updated')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '处理失败')
    } finally {
      saving.value = false
    }
  }
  async function reload() {
    if (busy.value) return
    try {
      await refresh()
      emit('updated')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '刷新失败')
    }
  }
</script>

<style scoped lang="scss">
  .account-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 18px;
  }

  @media (width < 768px) {
    .account-stats {
      grid-template-columns: 1fr;
    }
  }
</style>
