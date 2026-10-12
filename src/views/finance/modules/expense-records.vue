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
        ><ElButton
          link
          :type="row.deletedAt ? 'primary' : 'danger'"
          :disabled="saving"
          @click="removeExpense(row)"
          >{{ row.deletedAt ? '恢复' : '删除' }}</ElButton
        ></template
      >
    </ArtTable>
    <ElDialog
      v-model="expense.open"
      title="录入费用（提交即入账）"
      width="min(560px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving && !uploading"
      :show-close="!saving && !uploading"
      destroy-on-close
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
      <template #footer
        ><ElButton :disabled="saving || uploading" @click="expense.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" :disabled="uploading" @click="saveExpense"
          >提交入账</ElButton
        ></template
      >
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { money, useStudio } from '@/hooks/business/useStudio'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessUpload from '@/components/business/BusinessUpload.vue'
  import type { Attachment, Expense } from '@/types/studio'
  import { useFinanceActions } from './useFinanceActions'

  const { data, loading } = useStudio()
  const { saving, submit, reload } = useFinanceActions()
  const uploading = ref(false)
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
    { prop: 'actions', label: '操作', width: 100, fixed: 'right', useSlot: true }
  ])
  const expense = reactive({
    open: false,
    category: '',
    amount: null as number | null,
    date: today(),
    purpose: '',
    receipt: null as Attachment | null
  })
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
        restore
          ? '恢复这笔费用并重新计入统计？'
          : '删除这笔费用并撤回统计影响？原记录及日志仍保留，可恢复。',
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
