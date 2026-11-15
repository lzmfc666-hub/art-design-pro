<template>
  <div>
    <ElAlert
      title="扣款只扣当前可用余额；超过部分登记待追回。补款增加可用余额，原提现记录继续保留。"
      type="info"
      :closable="false"
      class="mb-4"
    />
    <ArtSearchBar v-model="search" :items="searchItems" @search="resetPage" @reset="resetSearch" />
    <ElCard shadow="never">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload">
        <template #left
          ><ElButton type="primary" :disabled="saving" @click="openAdjustment"
            >新增打手扣款 / 补款</ElButton
          ></template
        >
      </ArtTableHeader>
      <ArtTable
        :data="tableData"
        :columns="columns"
        :loading="loading"
        :pagination="pagination"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
      >
        <template #userId="{ row }">{{ staffName(row.userId) }}</template>
        <template #kind="{ row }"
          ><ElTag :type="row.kind === 'deduction' ? 'danger' : 'success'">{{
            row.kind === 'deduction' ? '扣款' : '补款'
          }}</ElTag></template
        >
        <template #amount="{ row }">{{ money(row.amount) }}</template>
        <template #appliedAmount="{ row }">{{ money(row.appliedAmount) }}</template>
        <template #manualAmount="{ row }">{{ money(row.manualAmount) }}</template>
        <template #status="{ row }">{{ statuses[row.status as keyof typeof statuses] }}</template>
        <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
        <template #operation="{ row }"
          ><ElButton link type="primary" @click="detailId = row.id">查看详情</ElButton
          ><ElButton
            v-if="row.status === 'manual'"
            type="primary"
            link
            :disabled="saving"
            @click="resolveTarget = row"
            >登记差额处理</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <ElCollapse v-if="data?.rewardReviews?.length" class="mt-5">
      <ElCollapseItem title="历史报酬更正 · 人工待处理记录" name="legacy">
        <ElAlert
          title="这些历史记录只保存整单应结报酬，需要财务核对实际差额；处理说明不会自动改写钱包或已发款。"
          type="info"
          :closable="false"
          class="mb-4"
        />
        <ElTable :data="legacyTable.tableData.value" border>
          <ElTableColumn label="关联订单" min-width="170"
            ><template #default="{ row }">{{
              data.orders.find((order) => order.id === row.orderId)?.orderNo || row.orderId
            }}</template></ElTableColumn
          >
          <ElTableColumn label="整单应结报酬" width="155"
            ><template #default="{ row }">{{ money(row.expectedReward) }}</template></ElTableColumn
          >
          <ElTableColumn prop="reason" label="原因" min-width="220" />
          <ElTableColumn prop="resolution" label="人工处理说明" min-width="220" />
          <ElTableColumn label="操作" width="220"
            ><template #default="{ row }"
              ><ElButton link type="primary" @click="legacyDetailId = row.id">查看详情</ElButton
              ><ElButton
                v-if="!row.resolvedAt"
                type="primary"
                link
                :disabled="saving"
                @click="openLegacyResolution(row.id)"
                >登记处理结果</ElButton
              ><span v-else>已处理</span></template
            ></ElTableColumn
          >
        </ElTable>
        <ElPagination
          class="mt-4"
          :current-page="legacyTable.pagination.current"
          :page-size="legacyTable.pagination.size"
          :total="legacyTable.pagination.total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @size-change="legacyTable.handleSizeChange"
          @current-change="legacyTable.handleCurrentChange"
        />
      </ElCollapseItem>
    </ElCollapse>
    <BusinessDetailPanel
      page-key="finance-adjustment-details"
      :record-id="detailId || undefined"
      @restore="queueRestore('detail', $event)"
      :restore-error="restoreError"
      :model-value="!!detailId"
      title="打手报酬调整详情"
      @update:model-value="!$event && !saving && (detailId = '')"
      @close="detailId = ''"
    >
      <template v-if="detail">
        <BusinessDetailHeader
          :title="staffName(detail.userId)"
          description="分别核对登记金额、已实际入账金额和人工差额。原提现与已发款记录继续保留。"
          icon="ri:exchange-dollar-line"
          :badge="statuses[detail.status]"
          :context="detail.id"
        />
        <BusinessDetailSummary
          :items="[
            {
              label: detail.kind === 'deduction' ? '登记扣款' : '登记补款',
              value: money(detail.amount),
              tone: detail.kind === 'deduction' ? 'danger' : 'success'
            },
            {
              label: '已入账',
              value: money(detail.appliedAmount),
              hint: '本记录实际影响钱包的金额'
            },
            { label: '人工差额', value: money(detail.manualAmount), tone: 'warning' },
            { label: '当前状态', value: statuses[detail.status] }
          ]"
        />
        <BusinessDetailSection title="调整依据">
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem label="原因">{{ detail.reason }}</ElDescriptionsItem
            ><ElDescriptionsItem label="关联订单">{{
              data?.orders.find((order) => order.id === detail?.orderId)?.orderNo ||
              detail.orderId ||
              '无关联订单'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="登记时间">{{
              formatTime(detail.createdAt)
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="登记人">{{
              staffName(detail.createdBy)
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="来源">{{
              detail.source === 'status-correction' ? '后台状态更正' : '人工登记'
            }}</ElDescriptionsItem></ElDescriptions
          >
        </BusinessDetailSection>
        <BusinessDetailSection
          title="人工差额处理"
          description="处理说明不改写原提现，也不会从未来收入自动扣款。"
        >
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem label="处理结果">{{
              detail.resolution === 'recovered'
                ? '已线下追回'
                : detail.resolution === 'waived'
                  ? '已免除剩余差额'
                  : '尚未登记'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="处理说明">{{
              detail.resolutionReason || '—'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="处理时间">{{
              detail.resolvedAt ? formatTime(detail.resolvedAt) : '—'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="处理人">{{
              detail.resolvedBy ? staffName(detail.resolvedBy) : '—'
            }}</ElDescriptionsItem></ElDescriptions
          >
        </BusinessDetailSection> </template
      ><ElEmpty v-else description="当前账号没有可读取的记录，请关闭后刷新列表" />
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-adjustment-register"
      @restore="queueRestore('new', $event)"
      :restore-error="restoreError"
      v-model="open"
      title="打手扣款 / 补款"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @closed="resetForm"
    >
      <BusinessDetailHeader
        description="登记当前报酬调整。扣款只扣当前可用余额，超过部分保留为人工待追回差额。"
        icon="ri:exchange-dollar-line"
        :badge="form.kind === 'deduction' ? '扣款' : '补款'"
      />
      <BusinessDetailSummary
        :items="[
          { label: '调整对象', value: form.userId ? staffName(form.userId) : '待选择' },
          {
            label: '登记金额',
            value: form.amount == null ? '待填写' : money(Math.round(form.amount * 100)),
            tone: 'primary'
          },
          {
            label: '入账方式',
            value: form.kind === 'deduction' ? '扣当前可用余额' : '增加可用余额',
            hint: '最终入账与差额由服务端核定'
          }
        ]"
      />
      <BusinessDetailSection title="调整对象与依据">
        <ElForm
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          :disabled="saving"
          @submit.prevent="save"
        >
          <ElFormItem label="打手" prop="userId"
            ><ElSelect v-model="form.userId" filterable class="w-full"
              ><ElOption
                v-for="player in players"
                :key="player.id"
                :label="player.name"
                :value="player.id" /></ElSelect
          ></ElFormItem>
          <ElFormItem label="类型"
            ><ElRadioGroup v-model="form.kind"
              ><ElRadioButton value="deduction">扣款</ElRadioButton
              ><ElRadioButton value="supplement">补款</ElRadioButton></ElRadioGroup
            ></ElFormItem
          >
          <ElFormItem label="金额（元）" prop="amount"
            ><ElInputNumber v-model="form.amount" :min="0.01" :precision="2" class="!w-full"
          /></ElFormItem>
          <ElFormItem label="关联订单（可选）"
            ><ElSelect v-model="form.orderId" filterable clearable class="w-full"
              ><ElOption
                v-for="order in data?.orders"
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
              placeholder="填写奖补、扣款或更正原因"
          /></ElFormItem>
        </ElForm>
      </BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving" @click="open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">确认登记</ElButton></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-adjustment-resolve"
      :record-id="resolveTarget?.id"
      @restore="queueRestore('resolve', $event)"
      :restore-error="restoreError"
      :model-value="!!resolveTarget"
      title="登记待追回差额处理"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @update:model-value="
        (value) => {
          if (!value && !saving) resolveTarget = null
        }
      "
    >
      <BusinessDetailHeader
        :title="staffName(resolveTarget?.userId || '')"
        description="登记已经发生的线下追回，或确认免除剩余差额。保存处理结果不重写原提现。"
        icon="ri:file-check-line"
        :context="resolveTarget?.id"
      />
      <BusinessDetailSummary
        :items="[
          { label: '原调整金额', value: money(resolveTarget?.amount || 0) },
          { label: '已入账', value: money(resolveTarget?.appliedAmount || 0) },
          { label: '本次人工差额', value: money(resolveTarget?.manualAmount || 0), tone: 'warning' }
        ]"
      />
      <BusinessDetailSection title="实际处理结果与依据">
        <ElForm label-position="top" :disabled="saving">
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
              placeholder="填写实际处理方式、凭据或免除依据"
          /></ElFormItem>
        </ElForm>
      </BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving" @click="resolveTarget = null">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="resolve"
          >保存处理结果</ElButton
        ></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-legacy-reward-details"
      :record-id="legacyDetailId || undefined"
      @restore="queueRestore('legacy-detail', $event)"
      :restore-error="restoreError"
      :model-value="!!legacyDetailId"
      title="历史报酬更正详情"
      @update:model-value="!$event && !saving && (legacyDetailId = '')"
      @close="legacyDetailId = ''"
    >
      <template v-if="legacyDetail">
        <BusinessDetailHeader
          :title="
            data?.orders.find((order) => order.id === legacyDetail?.orderId)?.orderNo ||
            legacyDetail.orderId
          "
          description="保留历史整单应结报酬及人工核对结果。这笔记录不代表钱包已入账的实际差额。"
          icon="ri:history-line"
          :badge="legacyDetail.resolvedAt ? '已登记处理' : '待人工核对'"
          :context="legacyDetail.id"
        />
        <BusinessDetailSummary
          :items="[
            {
              label: '整单应结报酬',
              value: money(legacyDetail.expectedReward),
              tone: 'primary',
              hint: '实际差额需要财务核对'
            },
            { label: '登记时间', value: formatTime(legacyDetail.createdAt) },
            { label: '登记人', value: staffName(legacyDetail.actorId) }
          ]"
        />
        <BusinessDetailSection title="原始依据与人工结果"
          ><ElDescriptions :column="1" border
            ><ElDescriptionsItem label="更正原因">{{ legacyDetail.reason }}</ElDescriptionsItem
            ><ElDescriptionsItem label="人工处理说明">{{
              legacyDetail.resolution || '尚未登记'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="处理时间">{{
              legacyDetail.resolvedAt ? formatTime(legacyDetail.resolvedAt) : '—'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="经办人">{{
              legacyDetail.resolvedBy ? staffName(legacyDetail.resolvedBy) : '—'
            }}</ElDescriptionsItem></ElDescriptions
          ></BusinessDetailSection
        > </template
      ><ElEmpty v-else description="当前账号没有可读取的历史更正记录" />
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-legacy-reward-resolve"
      :record-id="legacyResolutionId || undefined"
      @restore="queueRestore('legacy-resolve', $event)"
      :restore-error="restoreError"
      :model-value="!!legacyResolutionId"
      title="历史报酬人工处理"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @update:model-value="!$event && !saving && (legacyResolutionId = '')"
      @close="legacyResolutionId = ''"
    >
      <BusinessDetailHeader
        description="填写实际核对差额与处理结果。保存说明不会自动改写钱包或已发款。"
        icon="ri:file-check-line"
        :context="legacyResolutionId"
      />
      <BusinessDetailSummary
        v-if="legacyResolutionRecord"
        :items="[
          {
            label: '关联订单',
            value:
              data?.orders.find((order) => order.id === legacyResolutionRecord?.orderId)?.orderNo ||
              legacyResolutionRecord.orderId
          },
          {
            label: '整单应结报酬',
            value: money(legacyResolutionRecord.expectedReward),
            hint: '不能直接当作待追回金额'
          },
          { label: '原更正原因', value: legacyResolutionRecord.reason }
        ]"
      />
      <BusinessDetailSection title="实际差额与处理依据"
        ><ElInput
          v-model="legacyResolutionReason"
          :disabled="saving"
          type="textarea"
          :rows="4"
          placeholder="填写实际核对差额和处理结果；原已发款继续保留。"
      /></BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving" @click="legacyResolutionId = ''">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="resolveLegacy(legacyResolutionId)"
          >保存处理说明</ElButton
        ></template
      >
    </BusinessDetailPanel>
  </div>
</template>
<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, reactive, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import { useStudio, money, formatTime } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { PlayerAdjustment } from '@/types/studio'
  import { createStudioMutationIntent } from '@/api/studio-mutation'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  const emit = defineEmits<{ busy: [value: boolean] }>()
  const route = useRoute()
  const { data, loading, mutate, refresh, can } = useStudio()
  const saving = ref(false),
    open = ref(false)
  const adjustmentIntent = createStudioMutationIntent()
  const resolutionIntent = createStudioMutationIntent()
  const legacyIntent = createStudioMutationIntent()
  watch(saving, (value) => emit('busy', value))
  const statuses = { applied: '已入账', manual: '差额待人工处理', resolved: '差额已处理' }
  const detailId = ref('')
  const detail = computed(() =>
    data.value?.playerAdjustments?.find((row) => row.id === detailId.value)
  )
  const legacyRows = computed(() => data.value?.rewardReviews || [])
  const legacyTable = useBusinessTable(legacyRows)
  const legacyDetailId = ref('')
  const legacyDetail = computed(() =>
    legacyRows.value.find((row) => row.id === legacyDetailId.value)
  )
  const legacyResolutionId = ref('')
  const legacyResolutionReason = ref('')
  const legacyResolutionRecord = computed(() =>
    legacyRows.value.find((row) => row.id === legacyResolutionId.value)
  )
  const search = ref({ userId: '', kind: '', status: '', reason: '' })
  const players = computed(() => (data.value?.users || []).filter((row) => row.role === 'player'))
  const staffName = (id: string) => data.value?.users.find((row) => row.id === id)?.name || id
  const searchItems = computed(() => [
    {
      key: 'userId',
      label: '打手',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        options: players.value.map((row) => ({ value: row.id, label: row.name }))
      }
    },
    {
      key: 'kind',
      label: '调整类型',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { value: 'deduction', label: '扣款' },
          { value: 'supplement', label: '补款' }
        ]
      }
    },
    {
      key: 'status',
      label: '处理状态',
      type: 'select',
      props: {
        clearable: true,
        options: Object.entries(statuses).map(([value, label]) => ({ value, label }))
      }
    },
    {
      key: 'reason',
      label: '原因',
      type: 'input',
      props: { clearable: true, placeholder: '按调整原因查询' }
    }
  ])
  const rows = computed(() =>
    (data.value?.playerAdjustments || [])
      .filter(
        (row) =>
          (!search.value.userId || row.userId === search.value.userId) &&
          (!search.value.kind || row.kind === search.value.kind) &&
          (!search.value.status || row.status === search.value.status) &&
          row.reason.includes(search.value.reason || '')
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<PlayerAdjustment>(() => [
    { prop: 'userId', label: '打手', minWidth: 120, useSlot: true },
    { prop: 'kind', label: '类型', width: 90, useSlot: true },
    { prop: 'amount', label: '申请金额', width: 130, useSlot: true },
    { prop: 'appliedAmount', label: '已入账金额', width: 140, useSlot: true },
    { prop: 'manualAmount', label: '人工差额', width: 130, useSlot: true },
    { prop: 'status', label: '处理状态', minWidth: 150, useSlot: true },
    { prop: 'reason', label: '原因', minWidth: 210, showOverflowTooltip: true },
    { prop: 'createdAt', label: '登记时间', minWidth: 180, useSlot: true },
    { prop: 'operation', label: '操作', width: 230, fixed: 'right', useSlot: true }
  ])
  const emptyForm = () => ({
    userId: '',
    kind: 'deduction' as 'deduction' | 'supplement',
    amount: null as number | null,
    orderId: '',
    reason: ''
  })
  const form = reactive(emptyForm()),
    formRef = ref<FormInstance>()
  const rules: FormRules = {
    userId: [{ required: true, message: '请选择打手', trigger: 'change' }],
    amount: [{ required: true, message: '请填写金额', trigger: 'change' }],
    reason: [{ required: true, whitespace: true, message: '请填写原因', trigger: 'blur' }]
  }
  const resetForm = () => Object.assign(form, emptyForm())
  function openAdjustment() {
    if (saving.value) return
    resetForm()
    open.value = true
  }
  let consumedOrderLink = ''
  watch(
    [() => route.query.adjustOrderId, () => route.query.adjustPlayerId, data, loading],
    () => {
      const id = route.query.adjustOrderId
      if (
        typeof id !== 'string' ||
        !data.value ||
        loading.value ||
        saving.value ||
        open.value ||
        !can('finance.withdrawals')
      )
        return
      const key = `${data.value.user.id}:${id}:${String(route.query.adjustPlayerId || '')}`
      if (consumedOrderLink === key) return
      const order = data.value.orders.find((row) => row.id === id)
      if (!order) return
      consumedOrderLink = key
      const target =
        typeof route.query.adjustPlayerId === 'string' ? route.query.adjustPlayerId : ''
      const participant =
        target &&
        (order.leaderId === target ||
          order.teammateId === target ||
          order.assignments.some((row) => row.leaderId === target) ||
          order.submissions.some((row) => [row.leaderId, row.teammateId].includes(target)))
      resetForm()
      form.orderId = id
      form.userId = participant && players.value.some((row) => row.id === target) ? target : ''
      open.value = true
    },
    { immediate: true }
  )
  const restoreError = ref('')
  const pendingRestore = ref<{
    kind: 'detail' | 'new' | 'resolve' | 'legacy-detail' | 'legacy-resolve'
    recordId?: string
    isCurrent?: () => boolean
  } | null>(null)
  function queueRestore(
    kind: 'detail' | 'new' | 'resolve' | 'legacy-detail' | 'legacy-resolve',
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
    if (!pendingRestore.value || loading.value || saving.value || !data.value) return
    const request = pendingRestore.value
    pendingRestore.value = null
    if (!can('finance.withdrawals')) {
      restoreError.value = '当前账号没有报酬调整权限，请返回财务列表。'
      return
    }
    if (request.kind === 'new') return openAdjustment()
    if (request.kind === 'legacy-detail' || request.kind === 'legacy-resolve') {
      const row = legacyRows.value.find((item) => item.id === request.recordId)
      if (!row) restoreError.value = '当前账号没有可读取的历史更正记录，请返回列表重新核对。'
      else if (request.kind === 'legacy-detail') legacyDetailId.value = row.id
      else if (!row.resolvedAt) openLegacyResolution(row.id)
      else restoreError.value = '这笔历史更正已处理，请返回列表查看结果。'
      return
    }
    const row = data.value.playerAdjustments?.find((item) => item.id === request.recordId)
    if (!row) restoreError.value = '这笔调整不存在或当前账号无权读取，请返回列表。'
    else if (request.kind === 'detail') detailId.value = row.id
    else if (row.status === 'manual') resolveTarget.value = row
    else restoreError.value = '这笔调整已处理，请返回列表查看最新结果。'
  }
  watch([data, loading, saving], resumeRestore)
  function resetSearch() {
    search.value = { userId: '', kind: '', status: '', reason: '' }
    resetPage()
  }
  const resolveTarget = ref<PlayerAdjustment | null>(null),
    resolution = ref<'recovered' | 'waived'>('recovered'),
    resolutionReason = ref('')
  watch(resolveTarget, () => {
    resolution.value = 'recovered'
    resolutionReason.value = ''
  })
  async function save() {
    if (saving.value || !can('finance.withdrawals')) return
    if (!(await formRef.value?.validate().catch(() => false))) return
    saving.value = true
    try {
      await mutate(
        '/player-adjustments',
        adjustmentIntent.prepare('/player-adjustments', {
          ...form,
          amount: Math.round(Number(form.amount) * 100),
          orderId: form.orderId || null
        })
      )
      adjustmentIntent.complete()
      open.value = false
      ElMessage.success('扣款 / 补款已登记')
    } catch (error) {
      adjustmentIntent.fail(error)
      ElMessage.error(error instanceof Error ? error.message : '登记失败')
    } finally {
      saving.value = false
    }
  }
  async function resolve() {
    if (saving.value || !resolveTarget.value || !can('finance.withdrawals')) return
    if (!resolutionReason.value.trim()) return void ElMessage.warning('请填写处理说明')
    saving.value = true
    try {
      const path = `/player-adjustments/${resolveTarget.value.id}/action`
      await mutate(
        path,
        resolutionIntent.prepare(path, {
          action: 'resolve',
          resolution: resolution.value,
          reason: resolutionReason.value
        })
      )
      resolutionIntent.complete()
      resolveTarget.value = null
      ElMessage.success('差额处理已保存')
    } catch (error) {
      resolutionIntent.fail(error)
      ElMessage.error(error instanceof Error ? error.message : '处理失败')
    } finally {
      saving.value = false
    }
  }
  async function reload() {
    try {
      await refresh()
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '读取失败')
    }
  }
  function openLegacyResolution(id: string) {
    if (saving.value || !can('finance.withdrawals')) return
    legacyResolutionId.value = id
    legacyResolutionReason.value = ''
  }
  async function resolveLegacy(id: string) {
    if (saving.value || !can('finance.withdrawals')) return
    const value = legacyResolutionReason.value
    if (!value.trim()) return void ElMessage.warning('请填写处理说明')
    try {
      saving.value = true
      const path = `/reward-reviews/${id}/action`
      await mutate(path, legacyIntent.prepare(path, { action: 'resolve', reason: value }))
      legacyIntent.complete()
      legacyResolutionId.value = ''
      ElMessage.success('人工处理说明已保存')
    } catch (error) {
      if (saving.value) legacyIntent.fail(error)
      if (error instanceof Error) ElMessage.error(error.message)
    } finally {
      saving.value = false
    }
  }
</script>
