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
      title="费用提交即入账；误录可删除并恢复，原记录和经办日志一直保留。"
      type="info"
      :closable="false"
      show-icon
    />
    <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload"
      ><template #left
        ><ElButton type="primary" :disabled="saving || uploading" @click="newExpense"
          ><ArtSvgIcon icon="ri:add-line" class="mr-1" />录入费用</ElButton
        ></template
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
      <template #amount="{ row }">{{ money(row.amount) }}</template>
      <template #createdBy="{ row }">{{ personName(row.createdBy) }}</template>
      <template #deletedAt="{ row }"
        ><ElTag :type="row.deletedAt ? 'info' : 'success'">{{
          row.deletedAt ? '已删除' : '已入账'
        }}</ElTag></template
      >
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
      <template #actions="{ row }"
        ><ElButton link type="primary" @click="detailId = row.id">查看详情</ElButton
        ><ElButton
          link
          :type="row.deletedAt ? 'primary' : 'danger'"
          :disabled="saving"
          @click="removeExpense(row)"
          >{{ row.deletedAt ? '恢复' : '删除' }}</ElButton
        ></template
      >
    </ArtTable>
    <BusinessDetailPanel
      page-key="finance-expense-details"
      :record-id="detailId || undefined"
      @restore="queueRestore('detail', $event)"
      :restore-error="restoreError"
      :model-value="!!detailId"
      title="费用记录详情"
      @update:model-value="!$event && !saving && !uploading && (detailId = '')"
      @close="detailId = ''"
    >
      <template v-if="detail">
        <BusinessDetailHeader
          :title="detail.category"
          description="查看实际支出的用途、凭证和统计状态。删除为撤回统计影响，原记录继续保留。"
          icon="ri:receipt-line"
          :badge="detail.deletedAt ? '已删除' : '已入账'"
          :context="detail.id"
        />
        <BusinessDetailSummary
          :items="[
            { label: '实际支出', value: money(detail.amount), tone: 'primary' },
            { label: '发生日期', value: detail.date },
            { label: '经办人', value: personName(detail.createdBy) },
            { label: '统计状态', value: detail.deletedAt ? '不计入费用' : '计入费用' }
          ]"
        />
        <BusinessDetailSection title="用途与留存凭证">
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem label="费用用途">{{ detail.purpose }}</ElDescriptionsItem
            ><ElDescriptionsItem label="删除时间">{{
              detail.deletedAt ? formatTime(detail.deletedAt) : '—'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="费用凭证"
              ><ElImage
                v-if="detail.receipt"
                :src="detail.receipt.url"
                :preview-src-list="[detail.receipt.url]"
                preview-teleported
                fit="contain"
                style="width: 220px; height: 180px"
              /><span v-else>未登记</span></ElDescriptionsItem
            ></ElDescriptions
          >
        </BusinessDetailSection> </template
      ><ElEmpty v-else description="当前账号没有可读取的记录，请关闭后刷新列表" />
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="finance-expense-register"
      @restore="queueRestore('new', $event)"
      :restore-error="restoreError"
      v-model="expense.open"
      title="录入费用（提交即入账）"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving && !uploading"
      :show-close="!saving && !uploading"
      destroy-on-close
    >
      <BusinessDetailHeader
        description="填写已经发生的真实支出。提交即计入费用，误录可在列表删除并恢复。"
        icon="ri:receipt-line"
        badge="提交即入账"
      />
      <BusinessDetailSummary
        :items="[
          { label: '费用类别', value: expense.category || '待填写' },
          {
            label: '实际支出',
            value: expense.amount == null ? '待填写' : money(expense.amount),
            tone: 'primary'
          },
          { label: '发生日期', value: expense.date || '待选择' }
        ]"
      />
      <BusinessDetailSection
        title="支出信息与凭证"
        description="金额、发生日期和用途共同用于财务核对；凭证保留原上传记录。"
      >
        <ElForm label-position="top" :disabled="saving || uploading" @submit.prevent="saveExpense">
          <ElFormItem label="费用类别" required
            ><ElInput
              v-model="expense.category"
              placeholder="如房租、设备、推广、日常支出"
              maxlength="100"
          /></ElFormItem>
          <ElFormItem label="实际支出金额（元）" required
            ><BusinessAmount v-model="expense.amount" placeholder="填写实际支出"
          /></ElFormItem>
          <ElFormItem label="发生日期" required
            ><ElDatePicker
              v-model="expense.date"
              type="date"
              value-format="YYYY-MM-DD"
              class="!w-full"
          /></ElFormItem>
          <ElFormItem label="费用用途" required
            ><ElInput
              v-model="expense.purpose"
              type="textarea"
              :rows="3"
              maxlength="1000"
              show-word-limit
          /></ElFormItem>
          <ElFormItem label="费用凭证" required
            ><BusinessUpload v-model="expense.receipt" @busy="uploading = $event"
          /></ElFormItem>
        </ElForm>
      </BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving || uploading" @click="expense.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" :disabled="uploading" @click="saveExpense"
          >提交入账</ElButton
        ></template
      >
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { money, formatTime, useStudio } from '@/hooks/business/useStudio'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessUpload from '@/components/business/BusinessUpload.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import type { Attachment, Expense } from '@/types/studio'
  import { useFinanceActions } from './useFinanceActions'
  import { businessConfirmMessage } from '@/utils/business/confirm-message'

  const { data, loading } = useStudio()
  const { saving, submit, reload } = useFinanceActions()
  const uploading = ref(false)
  const detailId = ref('')
  const detail = computed(() => data.value?.expenses.find((row) => row.id === detailId.value))
  const emit = defineEmits<{ busy: [value: boolean] }>()
  watch([saving, uploading], ([saving, uploading]) => emit('busy', saving || uploading), {
    immediate: true
  })
  const today = () =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
  const search = ref({ category: '', purpose: '', status: 'active' })
  const applied = ref({ ...search.value })
  const searchItems = [
    {
      key: 'category',
      label: '费用类别',
      type: 'input',
      props: { placeholder: '按类别搜索', clearable: true }
    },
    {
      key: 'purpose',
      label: '费用用途',
      type: 'input',
      props: { placeholder: '按用途搜索', clearable: true }
    },
    {
      key: 'status',
      label: '入账状态',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { label: '已入账', value: 'active' },
          { label: '已删除', value: 'deleted' }
        ]
      }
    }
  ]
  const rows = computed(() =>
    (data.value?.expenses || [])
      .filter(
        (row) =>
          (!applied.value.status ||
            (applied.value.status === 'deleted' ? !!row.deletedAt : !row.deletedAt)) &&
          row.category.toLowerCase().includes(applied.value.category.trim().toLowerCase()) &&
          row.purpose.toLowerCase().includes(applied.value.purpose.trim().toLowerCase())
      )
      .sort((a, b) => b.date.localeCompare(a.date))
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<Expense>(() => [
    { prop: 'date', label: '发生日期', minWidth: 130 },
    { prop: 'category', label: '费用类别', minWidth: 130 },
    { prop: 'amount', label: '支出金额', minWidth: 130, useSlot: true },
    { prop: 'purpose', label: '用途', minWidth: 220, showOverflowTooltip: true },
    { prop: 'createdBy', label: '经办人', minWidth: 120, useSlot: true },
    { prop: 'deletedAt', label: '状态', minWidth: 100, useSlot: true },
    { prop: 'receipt', label: '费用凭证', minWidth: 100, useSlot: true },
    { prop: 'actions', label: '操作', width: 180, fixed: 'right', useSlot: true }
  ])
  const expense = reactive({
    open: false,
    category: '',
    amount: null as number | null,
    date: today(),
    purpose: '',
    receipt: null as Attachment | null
  })
  const restoreError = ref('')
  const pendingRestore = ref<{
    kind: 'detail' | 'new'
    recordId?: string
    isCurrent?: () => boolean
  } | null>(null)
  function queueRestore(
    kind: 'detail' | 'new',
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
    if (!data.value.permissions.includes('finance.expenses')) {
      restoreError.value = '当前账号没有费用管理权限，请返回费用列表。'
      return
    }
    if (request.kind === 'new') return newExpense()
    const row = data.value.expenses.find((item) => item.id === request.recordId)
    if (row) detailId.value = row.id
    else restoreError.value = '这笔费用不存在或当前账号无权读取，请返回费用列表重新选择。'
  }
  watch([data, loading, saving, uploading], resumeRestore)
  function applySearch() {
    applied.value = { ...search.value }
    resetPage()
  }
  function resetSearch() {
    search.value = { category: '', purpose: '', status: 'active' }
    applySearch()
  }
  function personName(id: string) {
    return data.value?.users.find((row) => row.id === id)?.name || id
  }
  function newExpense() {
    if (saving.value || uploading.value) return
    uploading.value = false
    Object.assign(expense, {
      open: true,
      category: '',
      amount: null,
      date: today(),
      purpose: '',
      receipt: null
    })
  }
  async function saveExpense() {
    if (
      uploading.value ||
      !expense.category.trim() ||
      !expense.purpose.trim() ||
      !expense.date ||
      expense.amount == null ||
      expense.amount <= 0 ||
      !expense.receipt
    )
      return void ElMessage.warning('请填写类别、有效金额、日期、用途并上传费用凭证')
    const { category, amount, date, purpose, receipt } = expense
    if (await submit('/expenses', { category, amount, date, purpose, receipt }, '费用已直接入账'))
      expense.open = false
  }
  async function removeExpense(row: Expense) {
    const restore = !!row.deletedAt
    try {
      await ElMessageBox.confirm(
        businessConfirmMessage(
          restore
            ? '恢复这笔费用并重新计入统计？'
            : '删除这笔费用并撤回统计影响？原记录及日志仍保留，可恢复。',
          [
            { label: '费用编号', value: row.id },
            { label: '具体类别', value: row.category },
            { label: '原支出金额', value: money(row.amount) },
            { label: '发生日期', value: row.date },
            { label: '经办人', value: personName(row.createdBy) },
            {
              label: '当前统计状态',
              value: row.deletedAt ? '已删除，不计入费用' : '已入账，计入费用'
            }
          ],
          '本次只改变这笔费用的统计状态，原支出记录、上传凭证和审计继续保留。'
        ),
        restore ? '恢复费用' : '删除费用',
        { type: 'warning', confirmButtonText: restore ? '恢复' : '删除', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    await submit(
      `/expenses/${row.id}/action`,
      { action: restore ? 'restore' : 'delete' },
      restore ? '费用已恢复' : '费用已删除，可恢复'
    )
  }
</script>
