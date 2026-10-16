<template>
  <div class="player-wallet">
    <BusinessDetailHeader
      :title="player.name"
      description="报酬钱包与扣补处理；账户汇总来自服务端权威钱包，扣补明细使用已授权完整记录并在本地分页。"
      icon="ri:wallet-3-line"
      :context="player.username"
    />
    <BusinessDetailSummary
      :items="[
        {
          label: '累计已赚报酬',
          value: amount(player.wallet?.earned),
          hint: '账户完整口径，不由本页扣补记录相加'
        }
      ]"
    />
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
    <BusinessDetailSection
      title="报酬扣补记录"
      description="这里展示报酬补款、扣款及人工差额处理，不代表完整报酬账本。"
    >
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
          ><ElButton link type="primary" :disabled="busy" @click="detailId = row.id"
            >查看明细</ElButton
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
    </BusinessDetailSection>
    <BusinessDetailPanel
      page-key="player-adjustment-editor"
      :record-id="`${form.kind}:${player.id}`"
      @restore="restoreAdjustmentEditor"
      class="business-detail-dialog"
      v-model="adjustmentOpen"
      :title="form.kind === 'supplement' ? '打手报酬补款' : '打手报酬扣款'"
      width="min(820px,94vw)"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      destroy-on-close
    >
      <BusinessDetailHeader
        :title="player.name"
        :description="
          form.kind === 'supplement'
            ? '登记实际报酬补款，不改写已有提现记录。'
            : '扣款从可用报酬生效，超过余额部分登记待人工追回；押金保持独立。'
        "
        icon="ri:money-cny-circle-line"
        :context="player.username"
      />
      <ElForm
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        :disabled="busy"
        @submit.prevent="save"
      >
        <BusinessDetailSection
          title="登记内容"
          description="核对金额、关联订单与具体原因，原金额和资金记录继续保留。"
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
        </BusinessDetailSection>
      </ElForm>
      <template #footer
        ><ElButton :disabled="busy" @click="adjustmentOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">确认登记</ElButton></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="player-adjustment-resolution"
      :record-id="resolveTarget?.id"
      @restore="restoreResolution"
      class="business-detail-dialog"
      :model-value="!!resolveTarget"
      title="登记待追回差额处理"
      width="min(820px,94vw)"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      @update:model-value="closeResolution"
    >
      <BusinessDetailHeader
        :title="player.name"
        description="核对原扣款与尚未追回的人工差额，记录实际追回或免除依据。"
        icon="ri:history-line"
        :context="player.username"
      />
      <BusinessDetailSummary
        :items="[
          { label: '原登记金额', value: money(resolveTarget?.amount) },
          { label: '已生效扣款', value: money(resolveTarget?.appliedAmount) },
          { label: '待处理差额', value: money(resolveTarget?.manualAmount), tone: 'warning' }
        ]"
      />
      <p class="mb-4">{{ player.name }} · 待处理 {{ money(resolveTarget?.manualAmount || 0) }}</p>
      <ElForm label-position="top" :disabled="busy">
        <BusinessDetailSection
          title="差额处理结果"
          description="处理说明会与原扣款记录一起保留，不改变押金账户。"
        >
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
        </BusinessDetailSection>
      </ElForm>
      <template #footer
        ><ElButton :disabled="busy" @click="resolveTarget = null">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="resolve"
          >保存处理结果</ElButton
        ></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="player-adjustment-detail"
      :record-id="detailId"
      @restore="restoreAdjustmentDetail"
      :model-value="!!detailId && can('finance.withdrawals')"
      class="business-detail-dialog"
      title="报酬扣补记录详情"
      width="min(900px,94vw)"
      append-to-body
      @update:model-value="detailId = ''"
    >
      <template v-if="adjustmentDetail">
        <BusinessDetailHeader
          :title="player.name"
          :description="adjustmentDetail.kind === 'supplement' ? '报酬补款记录' : '报酬扣款记录'"
          icon="ri:history-line"
          :badge="statusLabels[adjustmentDetail.status]"
          :context="formatTime(adjustmentDetail.createdAt)"
        />
        <BusinessDetailSummary
          :items="[
            { label: '登记金额', value: money(adjustmentDetail.amount) },
            { label: '实际入账 / 扣款', value: money(adjustmentDetail.appliedAmount) },
            { label: '人工差额', value: money(adjustmentDetail.manualAmount), tone: 'warning' }
          ]"
        />
        <BusinessDetailSection title="登记依据">
          <ElDescriptions :column="2" border>
            <ElDescriptionsItem label="经办人">{{
              staffName(adjustmentDetail.createdBy)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="登记时间">{{
              formatTime(adjustmentDetail.createdAt)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="关联订单" :span="2"
              ><ElButton
                v-if="adjustmentDetail.orderId && can('orders.view')"
                link
                type="primary"
                @click="
                  router.push({ path: '/orders/list', query: { id: adjustmentDetail.orderId } })
                "
                >查看订单</ElButton
              ><span v-else>无关联订单或当前账号无查看权限</span></ElDescriptionsItem
            >
            <ElDescriptionsItem label="原因" :span="2"
              ><p class="whitespace-pre-wrap break-all">{{
                adjustmentDetail.reason || '未填写'
              }}</p></ElDescriptionsItem
            >
          </ElDescriptions>
        </BusinessDetailSection>
        <BusinessDetailSection
          title="人工差额处理"
          description="仅展示该笔记录已有处理结果，未处理不等于已追回。"
        >
          <ElDescriptions :column="2" border>
            <ElDescriptionsItem label="处理结果">{{
              adjustmentDetail.resolution === 'recovered'
                ? '已线下追回'
                : adjustmentDetail.resolution === 'waived'
                  ? '剩余差额已免除'
                  : '未登记处理结果'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="处理人">{{
              staffName(adjustmentDetail.resolvedBy)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="处理时间" :span="2">{{
              formatTime(adjustmentDetail.resolvedAt)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="处理说明" :span="2"
              ><p class="whitespace-pre-wrap break-all">{{
                adjustmentDetail.resolutionReason || '未填写'
              }}</p></ElDescriptionsItem
            >
          </ElDescriptions>
        </BusinessDetailSection>
      </template>
      <ElEmpty v-else description="记录已变化或当前账号无权查看，请刷新账户" />
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import { createStudioRequestId } from '@/api/studio-mutation'
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, onUnmounted, reactive, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import { formatTime, money, useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { PlayerAdjustment, PlayerListRecord } from '@/types/studio'
  import { createStudioMutationIntent } from '@/api/studio-mutation'

  const props = defineProps<{ player: PlayerListRecord }>()
  const emit = defineEmits<{ updated: []; busy: [value: boolean] }>()
  const { data, can, mutate, refresh, loading } = useStudio()
  const router = useRouter()
  const saving = ref(false)
  const adjustmentIntent = createStudioMutationIntent()
  const resolutionIntent = createStudioMutationIntent()
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
  const detailId = ref('')
  const adjustmentDetail = computed(() => rows.value.find((row) => row.id === detailId.value))
  async function restoreAdjustmentDetail({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (can('finance.withdrawals') && rows.value.some((row) => row.id === recordId))
        detailId.value = recordId!
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  async function restoreAdjustmentEditor({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (adjustmentIntent.uncertain) return
      if (recordId === `supplement:${props.player.id}`) openAdjustment('supplement')
      else if (recordId === `deduction:${props.player.id}`) openAdjustment('deduction')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  async function restoreResolution({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (resolutionIntent.uncertain) return
      const row = rows.value.find((item) => item.id === recordId && item.status === 'manual')
      if (row) openResolution(row)
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  const staffName = (id?: string) =>
    data.value?.users.find((row) => row.id === id)?.name || '未提供'
  const { tableData, pagination, handleSizeChange, handleCurrentChange } = useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<PlayerAdjustment>(() => [
    { prop: 'kind', label: '类型', width: 90, useSlot: true },
    { prop: 'amount', label: '登记金额', width: 125, useSlot: true },
    { prop: 'appliedAmount', label: '实际入账', width: 125, useSlot: true },
    { prop: 'manualAmount', label: '人工差额', width: 125, useSlot: true },
    { prop: 'status', label: '状态', minWidth: 150, useSlot: true },
    { prop: 'reason', label: '原因', minWidth: 220, showOverflowTooltip: true },
    { prop: 'createdAt', label: '登记时间', minWidth: 175, useSlot: true },
    { prop: 'operation', label: '处理', width: 250, fixed: 'right', useSlot: true }
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
      requestId: createStudioRequestId()
    })
    adjustmentOpen.value = true
  }
  async function save() {
    if (busy.value || !can('finance.withdrawals')) return
    saving.value = true
    try {
      if (!(await formRef.value?.validate().catch(() => false))) return
      const result = await mutate<PlayerAdjustment>(
        '/player-adjustments',
        adjustmentIntent.prepare('/player-adjustments', {
          userId: props.player.id,
          kind: form.kind,
          amount: form.amount,
          orderId: form.orderId || null,
          reason: form.reason.trim(),
          requestId: form.requestId
        })
      )
      adjustmentIntent.complete()
      adjustmentOpen.value = false
      ElMessage.success(
        result.manualAmount > 0
          ? `已扣可用报酬 ${money(result.appliedAmount)}，待追回 ${money(result.manualAmount)}`
          : '报酬扣补已登记'
      )
      emit('updated')
    } catch (error) {
      adjustmentIntent.fail(error)
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
      const path = `/player-adjustments/${resolveTarget.value.id}/action`
      await mutate(
        path,
        resolutionIntent.prepare(path, {
          action: 'resolve',
          resolution: resolution.value,
          reason: resolutionReason.value.trim()
        })
      )
      resolutionIntent.complete()
      resolveTarget.value = null
      ElMessage.success('差额处理已保存')
      emit('updated')
    } catch (error) {
      resolutionIntent.fail(error)
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
