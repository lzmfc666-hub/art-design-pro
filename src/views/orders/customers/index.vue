<template>
  <div class="customer-page art-full-height">
    <BusinessPageHeader
      title="客户档案"
      description="维护客户名称、来源、联系方式和游戏 ID，独立关联平台订单号。"
      icon="ri:contacts-book-line"
      :badge="`${data?.customers.length || 0} 位客户`"
    />
    <ArtSearchBar v-model="search" :items="searchItems" @search="resetPage" @reset="resetSearch" />
    <ElCard class="art-table-card">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload"
        ><template #left
          ><ElButton v-if="editable" type="primary" :disabled="editorBusy" @click="edit()"
            >新增客户</ElButton
          ><span class="ml-3 text-sm text-g-500"
            >关联编号仅用于档案记录，不产生业务订单或收入。</span
          ></template
        ></ArtTableHeader
      >
      <ArtTable
        :data="tableData"
        :columns="columns"
        :loading="loading"
        :pagination="pagination"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
      >
        <template #platformId="{ row }">{{ platformName(row.platformId) }}</template>
        <template #orderReferenceCount="{ row }">{{
          row.orderReferenceCount ?? row.orderReferences?.length ?? 0
        }}</template>
        <template #operation="{ row }"
          ><ElButton v-if="editable" link type="primary" :disabled="editorBusy" @click="edit(row)"
            >编辑与关联编号</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <ElDialog
      v-model="open"
      :title="form.id ? '编辑客户档案' : '新增客户档案'"
      width="min(840px, 96vw)"
      destroy-on-close
      :close-on-click-modal="!editorBusy"
      :close-on-press-escape="!editorBusy"
      :show-close="!editorBusy"
    >
      <ElForm
        ref="formRef"
        :model="form"
        :rules="rules"
        :disabled="editorBusy || !editable"
        label-position="top"
        @submit.prevent="save"
      >
        <ElRow :gutter="20"
          ><ElCol :xs="24" :sm="12"
            ><ElFormItem label="客户名称" prop="name"
              ><ElInput
                v-model="form.name"
                maxlength="60"
                placeholder="填写客户名称" /></ElFormItem></ElCol
          ><ElCol :xs="24" :sm="12"
            ><ElFormItem label="客户来源"
              ><ElSelect
                v-model="form.platformId"
                clearable
                class="w-full"
                placeholder="选择来源（可暂不指定）"
                ><ElOption
                  v-for="item in data?.platforms || []"
                  :key="item.id"
                  :value="item.id"
                  :label="item.name" /></ElSelect></ElFormItem></ElCol
          ><ElCol :xs="24" :sm="12"
            ><ElFormItem label="联系方式"
              ><ElInput
                v-model="form.contact"
                maxlength="120"
                placeholder="微信、QQ 或其他联系方式" /></ElFormItem></ElCol
          ><ElCol :xs="24" :sm="12"
            ><ElFormItem label="游戏 ID"
              ><ElInput v-model="form.gameId" maxlength="120" /></ElFormItem></ElCol
        ></ElRow>
        <ElFormItem label="备注"
          ><ElInput
            v-model="form.remark"
            type="textarea"
            :rows="2"
            maxlength="1000"
            show-word-limit
        /></ElFormItem>
      </ElForm>
      <ElDivider content-position="left">关联平台订单号</ElDivider>
      <ElAlert
        v-if="!form.id"
        title="先保存客户档案，再逐条添加关联编号。"
        type="info"
        :closable="false"
      />
      <template v-else>
        <p class="text-sm text-g-500 mb-4"
          >可添加多条编号，仅适用于要求平台订单号的来源；每次独立保存，列表按页读取。</p
        >
        <ElForm
          :model="reference"
          :disabled="editorBusy || !editable"
          label-position="top"
          @submit.prevent="addReference"
        >
          <ElRow :gutter="16"
            ><ElCol :xs="24" :sm="8"
              ><ElFormItem label="关联来源" required
                ><ElSelect v-model="reference.platformId" class="w-full" placeholder="选择来源"
                  ><ElOption
                    v-for="item in referencePlatforms"
                    :key="item.id"
                    :value="item.id"
                    :label="item.name" /></ElSelect></ElFormItem></ElCol
            ><ElCol v-if="referenceShops.length || referenceRules.requiresShop" :xs="24" :sm="8"
              ><ElFormItem label="关联店铺" :required="referenceRules.requiresShop"
                ><ElSelect
                  v-model="reference.shopId"
                  :clearable="!referenceRules.requiresShop"
                  class="w-full"
                  placeholder="选择同平台店铺"
                  ><ElOption
                    v-for="item in referenceShops"
                    :key="item.id"
                    :value="item.id"
                    :label="item.name" /></ElSelect></ElFormItem></ElCol
            ><ElCol :xs="24" :sm="referenceShops.length || referenceRules.requiresShop ? 8 : 16"
              ><ElFormItem label="平台订单号" required
                ><ElInput
                  v-model="reference.externalOrderNo"
                  maxlength="128"
                  placeholder="填写完整编号" /></ElFormItem></ElCol
          ></ElRow>
          <div class="flex justify-end mb-4"
            ><ElButton
              type="primary"
              plain
              native-type="submit"
              :loading="referenceSaving"
              :disabled="editorBusy || !referencePlatforms.length"
              >添加一条关联编号</ElButton
            ></div
          >
        </ElForm>
        <ElTable :data="references" v-loading="referenceLoading" size="small" border
          ><ElTableColumn label="来源" min-width="120"
            ><template #default="{ row }">{{
              platformName(row.platformId)
            }}</template></ElTableColumn
          ><ElTableColumn label="店铺" min-width="110"
            ><template #default="{ row }">{{ shopName(row.shopId) }}</template></ElTableColumn
          ><ElTableColumn
            prop="externalOrderNo"
            label="平台订单号"
            min-width="190"
            show-overflow-tooltip
          /><ElTableColumn label="操作" width="80"
            ><template #default="{ row }"
              ><ElButton
                link
                type="danger"
                :disabled="editorBusy || !editable"
                @click="removeReference(row)"
                >删除</ElButton
              ></template
            ></ElTableColumn
          ></ElTable
        >
        <div class="reference-pagination"
          ><span>共 {{ referencePagination.total }} 条关联记录</span
          ><ElPagination
            :current-page="referencePagination.current"
            :page-size="referencePagination.size"
            :total="referencePagination.total"
            :disabled="editorBusy"
            small
            layout="prev, pager, next"
            @current-change="changeReferencePage"
        /></div>
      </template>
      <template #footer
        ><ElButton :disabled="editorBusy" @click="open = false">关闭</ElButton
        ><ElButton
          type="primary"
          :loading="saving"
          :disabled="editorBusy || !editable"
          @click="save"
          >保存客户档案</ElButton
        ></template
      >
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, reactive, ref, watch } from 'vue'
  import { onBeforeRouteLeave, useRoute } from 'vue-router'
  import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { studioRequest } from '@/api/studio'
  import { rulesForPlatform } from '@/utils/business/platform-rules'
  import type { Customer } from '@/types/studio'

  defineOptions({ name: 'Customers' })
  interface CustomerReference {
    id: string
    platformId: string
    shopId: string | null
    externalOrderNo: string
  }
  const { data, user, loading, can, mutate, refresh, clearSession } = useStudio()
  const editable = computed(() => can('users.manage') || can('orders.create'))
  const emptySearch = () => ({ name: '', contact: '', gameId: '', remark: '', platformId: '' })
  const search = ref(emptySearch())
  const route = useRoute()
  const searchItems = computed(() => [
    ...[
      ['name', '客户名称'],
      ['contact', '联系方式'],
      ['gameId', '游戏 ID'],
      ['remark', '备注']
    ].map(([key, label]) => ({
      key,
      label,
      type: 'input',
      props: { clearable: true, placeholder: `按${label}搜索` }
    })),
    {
      key: 'platformId',
      label: '客户来源',
      type: 'select',
      props: {
        clearable: true,
        options: (data.value?.platforms || []).map((item) => ({ label: item.name, value: item.id }))
      }
    }
  ])
  const matches = (value: string, query?: string) =>
    !query || value.toLowerCase().includes(query.trim().toLowerCase())
  const rows = computed(() =>
    (data.value?.customers || []).filter(
      (row) =>
        matches(row.name, search.value.name) &&
        matches(row.contact, search.value.contact) &&
        matches(row.gameId, search.value.gameId) &&
        matches(row.remark, search.value.remark) &&
        (!search.value.platformId || row.platformId === search.value.platformId)
    )
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<Customer>(() => [
    { prop: 'name', label: '客户名称', minWidth: 140 },
    { prop: 'platformId', label: '客户来源', minWidth: 130, useSlot: true },
    { prop: 'contact', label: '联系方式', minWidth: 180, showOverflowTooltip: true },
    { prop: 'gameId', label: '游戏 ID', minWidth: 160, showOverflowTooltip: true },
    { prop: 'orderReferenceCount', label: '关联编号', width: 100, useSlot: true },
    { prop: 'remark', label: '备注', minWidth: 200, showOverflowTooltip: true },
    { prop: 'operation', label: '操作', width: 150, fixed: 'right', useSlot: true }
  ])
  watch(
    () => route.fullPath,
    () => {
      if (route.path !== '/orders/customers') return
      const keys = Object.keys(emptySearch()) as (keyof ReturnType<typeof emptySearch>)[]
      if (
        !keys.some((key) => typeof route.query[key] === 'string') &&
        typeof route.query.keyword !== 'string'
      )
        return
      search.value = emptySearch()
      keys.forEach((key) => {
        if (typeof route.query[key] === 'string') search.value[key] = route.query[key] as string
      })
      if (typeof route.query.keyword === 'string' && !search.value.name)
        search.value.name = route.query.keyword
      resetPage()
    },
    { immediate: true }
  )
  function resetSearch() {
    search.value = emptySearch()
    resetPage()
  }
  const platformName = (id?: string | null) =>
    data.value?.platforms.find((item) => item.id === id)?.name || '未指定来源'
  const shopName = (id?: string | null) =>
    data.value?.shops.find((item) => item.id === id)?.name || '—'
  const open = ref(false)
  const saving = ref(false)
  const referenceSaving = ref(false)
  const referenceLoading = ref(false)
  const editorBusy = computed(() => saving.value || referenceSaving.value || referenceLoading.value)
  const formRef = ref<FormInstance>()
  const form = reactive({
    id: '',
    name: '',
    contact: '',
    gameId: '',
    remark: '',
    platformId: null as string | null
  })
  const rules: FormRules = {
    name: [{ required: true, whitespace: true, message: '请填写客户名称', trigger: 'blur' }]
  }
  const reference = reactive({ platformId: '', shopId: '', externalOrderNo: '' })
  const references = ref<CustomerReference[]>([])
  const referencePagination = reactive({ current: 1, size: 20, total: 0 })
  const referencePlatforms = computed(() =>
    (data.value?.platforms || []).filter((item) => rulesForPlatform(item).requiresExternalOrderNo)
  )
  const referenceRules = computed(() =>
    rulesForPlatform(data.value?.platforms.find((item) => item.id === reference.platformId))
  )
  const referenceShops = computed(() =>
    (data.value?.shops || []).filter((item) => item.platformId === reference.platformId)
  )
  watch(
    () => reference.platformId,
    () => {
      reference.shopId = referenceRules.value.requiresShop ? referenceShops.value[0]?.id || '' : ''
    }
  )
  let referenceVersion = 0
  function edit(row?: Customer) {
    if (!editable.value || editorBusy.value) return
    Object.assign(form, {
      id: row?.id || '',
      name: row?.name || '',
      contact: row?.contact || '',
      gameId: row?.gameId || '',
      remark: row?.remark || '',
      platformId: row?.platformId || null
    })
    references.value = []
    referencePagination.current = 1
    referencePagination.total = row?.orderReferenceCount ?? row?.orderReferences?.length ?? 0
    Object.assign(reference, {
      platformId: referencePlatforms.value.some((item) => item.id === row?.platformId)
        ? row?.platformId
        : referencePlatforms.value[0]?.id || '',
      shopId: '',
      externalOrderNo: ''
    })
    open.value = true
    if (form.id) void loadReferences()
  }
  async function loadReferences() {
    if (!form.id) return
    const version = ++referenceVersion
    referenceLoading.value = true
    try {
      const result = await studioRequest<{
        records: CustomerReference[]
        total: number
        current: number
        size: number
      }>(
        `customers/${encodeURIComponent(form.id)}/order-references?current=${referencePagination.current}&size=${referencePagination.size}`
      )
      if (version === referenceVersion) {
        references.value = result.records
        referencePagination.total = result.total
        referencePagination.current = result.current
      }
    } catch (cause) {
      if ((cause as { status?: number })?.status === 401) clearSession()
      ElMessage.error(cause instanceof Error ? cause.message : '关联编号读取失败')
    } finally {
      if (version === referenceVersion) referenceLoading.value = false
    }
  }
  watch(
    [() => route.query.id, () => data.value?.customers],
    ([id]) => {
      if (route.path !== '/orders/customers' || typeof id !== 'string' || !id || editorBusy.value)
        return
      const row = data.value?.customers.find((item) => item.id === id)
      if (row && (!open.value || form.id !== id)) edit(row)
    },
    { immediate: true }
  )
  async function changeReferencePage(current: number) {
    if (editorBusy.value) return
    referencePagination.current = current
    await loadReferences()
  }
  async function addReference() {
    if (!editable.value || editorBusy.value || !form.id) return
    if (!referencePlatforms.value.some((item) => item.id === reference.platformId))
      return void ElMessage.warning('请选择要求平台订单号的来源')
    if (referenceRules.value.requiresShop && !reference.shopId)
      return void ElMessage.warning('请选择同平台店铺')
    if (!reference.externalOrderNo.trim()) return void ElMessage.warning('请填写平台订单号')
    referenceSaving.value = true
    try {
      await mutate('/customer-order-references', {
        customerId: form.id,
        platformId: reference.platformId,
        shopId: reference.shopId || null,
        externalOrderNo: reference.externalOrderNo.trim()
      })
      reference.externalOrderNo = ''
      referencePagination.current = 1
      await loadReferences()
      ElMessage.success('关联编号已独立保存')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '关联编号保存失败')
    } finally {
      referenceSaving.value = false
    }
  }
  async function removeReference(row: CustomerReference) {
    if (!editable.value || editorBusy.value) return
    referenceSaving.value = true
    try {
      await ElMessageBox.confirm(
        `删除关联编号“${row.externalOrderNo}”？已有业务订单保持原记录。`,
        '删除关联编号',
        { type: 'warning', confirmButtonText: '删除关联', cancelButtonText: '取消' }
      )
      await mutate('/customer-order-references', {
        customerId: form.id,
        id: row.id,
        action: 'remove'
      })
      referencePagination.current = Math.max(
        1,
        Math.min(
          referencePagination.current,
          Math.ceil((referencePagination.total - 1) / referencePagination.size)
        )
      )
      await loadReferences()
      ElMessage.success('关联编号已删除')
    } catch (cause) {
      if (cause !== 'cancel' && cause !== 'close')
        ElMessage.error(cause instanceof Error ? cause.message : '删除失败')
    } finally {
      referenceSaving.value = false
    }
  }
  async function save() {
    if (!editable.value || editorBusy.value) return
    saving.value = true
    try {
      if (!(await formRef.value?.validate().catch(() => false))) return
      const result = await mutate<Customer>('/customers', {
        id: form.id || undefined,
        name: form.name,
        contact: form.contact,
        gameId: form.gameId,
        remark: form.remark,
        platformId: form.platformId || null
      })
      form.id = result.id
      await loadReferences()
      ElMessage.success('客户档案已保存，可继续维护关联编号')
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
      /* 公共错误提示保留重试入口。 */
    }
  }
  onBeforeRouteLeave(() => {
    if (!user.value) return true
    if (editorBusy.value) {
      ElMessage.warning('正在保存或读取关联编号，请稍候离开')
      return false
    }
    return true
  })
  onMounted(reload)
</script>

<style scoped>
  .reference-pagination {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
</style>
