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
          ><ElButton type="primary" :disabled="saving" @click="open = true"
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
        <ElTable :data="data.rewardReviews" border>
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
          <ElTableColumn label="操作" width="140"
            ><template #default="{ row }"
              ><ElButton
                v-if="!row.resolvedAt"
                type="primary"
                link
                :disabled="saving"
                @click="resolveLegacy(row.id)"
                >登记处理结果</ElButton
              ><span v-else>已处理</span></template
            ></ElTableColumn
          >
        </ElTable>
      </ElCollapseItem>
    </ElCollapse>
    <ElDialog
      v-model="open"
      title="打手扣款 / 补款"
      width="min(580px,94vw)"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @closed="resetForm"
    >
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
      <template #footer
        ><ElButton :disabled="saving" @click="open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">确认登记</ElButton></template
      >
    </ElDialog>
    <ElDialog
      :model-value="!!resolveTarget"
      title="登记待追回差额处理"
      width="min(560px,94vw)"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @update:model-value="
        (value) => {
          if (!value && !saving) resolveTarget = null
        }
      "
    >
      <p class="mb-4"
        >{{ staffName(resolveTarget?.userId || '') }} · 待处理
        {{ money(resolveTarget?.manualAmount || 0) }}</p
      >
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
      <template #footer
        ><ElButton :disabled="saving" @click="resolveTarget = null">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="resolve"
          >保存处理结果</ElButton
        ></template
      >
    </ElDialog>
  </div>
</template>
<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
  import { useStudio, money, formatTime } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { PlayerAdjustment } from '@/types/studio'
  const emit = defineEmits<{ busy: [value: boolean] }>()
  const { data, loading, mutate, refresh, can } = useStudio()
  const saving = ref(false),
    open = ref(false)
  watch(saving, (value) => emit('busy', value))
  const statuses = { applied: '已入账', manual: '差额待人工处理', resolved: '差额已处理' }
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
    { prop: 'operation', label: '操作', width: 145, fixed: 'right', useSlot: true }
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
      await mutate('/player-adjustments', {
        ...form,
        amount: Math.round(Number(form.amount) * 100),
        orderId: form.orderId || null
      })
      open.value = false
      ElMessage.success('扣款 / 补款已登记')
    } catch (error) {
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
      await mutate(`/player-adjustments/${resolveTarget.value.id}/action`, {
        action: 'resolve',
        resolution: resolution.value,
        reason: resolutionReason.value
      })
      resolveTarget.value = null
      ElMessage.success('差额处理已保存')
    } catch (error) {
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
  async function resolveLegacy(id: string) {
    if (saving.value || !can('finance.withdrawals')) return
    try {
      const { value } = await ElMessageBox.prompt(
        '填写实际核对差额和处理结果；原已发款继续保留。',
        '历史报酬人工处理',
        {
          inputType: 'textarea',
          inputValidator: (value) => !!value?.trim() || '请填写处理说明',
          confirmButtonText: '保存处理说明'
        }
      )
      saving.value = true
      await mutate(`/reward-reviews/${id}/action`, { action: 'resolve', reason: value })
      ElMessage.success('人工处理说明已保存')
    } catch (error) {
      if (error instanceof Error) ElMessage.error(error.message)
    } finally {
      saving.value = false
    }
  }
</script>
