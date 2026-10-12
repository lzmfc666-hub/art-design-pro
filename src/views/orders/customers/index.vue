<template>
  <div class="customer-page art-full-height">
    <BusinessPageHeader
      title="客户档案"
      description="维护客户称呼、联系方式和游戏 ID，下单时直接选择已有档案。"
      icon="ri:contacts-book-line"
      :badge="`${data?.customers.length || 0} 位客户`"
    />
    <ArtSearchBar v-model="search" :items="searchItems" @search="resetPage" @reset="resetSearch" />
    <ElCard class="art-table-card">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload">
        <template #left>
          <ElButton v-if="editable" type="primary" :disabled="saving" @click="edit()" v-ripple
            >新增客户</ElButton
          >
          <span class="ml-3 text-sm text-g-500"
            >客户档案供下单时选择，修改不会改变历史订单归属。</span
          >
        </template>
      </ArtTableHeader>
      <ArtTable
        :data="tableData"
        :columns="columns"
        :loading="loading"
        :pagination="pagination"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
      >
        <template #operation="{ row }"
          ><ElButton v-if="editable" link type="primary" :disabled="saving" @click="edit(row)"
            >编辑档案</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <ElDialog
      v-model="open"
      :title="form.id ? '编辑客户档案' : '新增客户档案'"
      width="min(540px, 94vw)"
      destroy-on-close
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <ElForm
        ref="formRef"
        :model="form"
        :rules="rules"
        :disabled="saving"
        label-position="top"
        @submit.prevent="save"
      >
        <ElFormItem label="客户称呼" prop="name"
          ><ElInput v-model="form.name" maxlength="60" placeholder="填写客户姓名或称呼"
        /></ElFormItem>
        <ElFormItem label="联系方式"
          ><ElInput v-model="form.contact" maxlength="120" placeholder="微信、QQ 或其他联系方式"
        /></ElFormItem>
        <ElFormItem label="游戏 ID"><ElInput v-model="form.gameId" maxlength="120" /></ElFormItem>
        <ElFormItem label="备注"
          ><ElInput
            v-model="form.remark"
            type="textarea"
            :rows="3"
            maxlength="1000"
            show-word-limit
        /></ElFormItem>
      </ElForm>
      <template #footer
        ><ElButton :disabled="saving" @click="open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存档案</ElButton></template
      >
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { computed, onMounted, reactive, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import { useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Customer } from '@/types/studio'

  defineOptions({ name: 'Customers' })
  const { data, loading, can, mutate, refresh } = useStudio()
  const editable = computed(() => can('users.manage') || can('orders.create'))
  const search = ref({ query: '' })
  const route = useRoute()
  watch(
    () => route.query.keyword,
    (value) => {
      search.value.query = typeof value === 'string' ? value : ''
    },
    { immediate: true }
  )
  const searchItems = [
    {
      key: 'query',
      label: '客户搜索',
      type: 'input',
      props: { clearable: true, placeholder: '称呼 / 联系方式 / 游戏 ID' }
    }
  ]
  const rows = computed(() =>
    (data.value?.customers || []).filter((row) =>
      `${row.name} ${row.contact} ${row.gameId} ${row.remark}`
        .toLowerCase()
        .includes((search.value.query || '').trim().toLowerCase())
    )
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<Customer>(() => [
    { prop: 'name', label: '客户称呼', minWidth: 140 },
    { prop: 'contact', label: '联系方式', minWidth: 180, showOverflowTooltip: true },
    { prop: 'gameId', label: '游戏 ID', minWidth: 180, showOverflowTooltip: true },
    { prop: 'remark', label: '备注', minWidth: 240, showOverflowTooltip: true },
    { prop: 'operation', label: '操作', width: 110, fixed: 'right', useSlot: true }
  ])
  function resetSearch() {
    search.value = { query: '' }
    resetPage()
  }
  const open = ref(false)
  const saving = ref(false)
  const formRef = ref<FormInstance>()
  const form = reactive({ id: '', name: '', contact: '', gameId: '', remark: '' })
  const rules: FormRules = {
    name: [{ required: true, whitespace: true, message: '请填写客户称呼', trigger: 'blur' }]
  }
  function edit(row?: Customer) {
    if (!editable.value || saving.value) return
    Object.assign(form, { id: '', name: '', contact: '', gameId: '', remark: '' }, row || {})
    open.value = true
  }
  async function save() {
    if (!editable.value || saving.value) return
    saving.value = true
    try {
      if (!(await formRef.value?.validate().catch(() => false))) return
      await mutate('/customers', { ...form, id: form.id || undefined })
      open.value = false
      ElMessage.success('客户档案已保存')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      saving.value = false
    }
  }
  async function reload() {
    try {
      await refresh()
    } catch {
      /* 页面公共错误提示保留重试入口。 */
    }
  }
  onMounted(reload)
</script>
