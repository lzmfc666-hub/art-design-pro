<template>
  <div>
    <ElCard class="mb-5" shadow="never">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 class="text-xl font-semibold">数据报表导出</h2>
          <p class="mt-2 text-sm text-g-500"
            >选择业务模块、字段与范围，一次导出为多个 Excel 工作表。</p
          >
        </div>
        <ElTag effect="plain">沿用当前账号的查看权限</ElTag>
      </div>
    </ElCard>
    <ElAlert
      v-if="pageError"
      :title="pageError"
      type="error"
      :closable="false"
      show-icon
      class="mb-5"
    />
    <ElCard class="mb-5" shadow="never">
      <template #header><span class="font-semibold">1. 设置导出范围</span></template>
      <ElForm label-position="top" :disabled="busy || catalogLoading">
        <ElRow :gutter="20">
          <ElCol :xs="24" :sm="12" :lg="6">
            <ElFormItem label="经营 / 工资核算月份">
              <ElDatePicker
                v-model="month"
                type="month"
                value-format="YYYY-MM"
                :clearable="false"
                class="!w-full"
              />
            </ElFormItem>
          </ElCol>
          <ElCol :xs="24" :sm="12" :lg="6">
            <ElFormItem label="订单日期口径">
              <ElSelect v-model="filters.orderDateKey" class="w-full">
                <ElOption label="订单创建日期" value="createdAt" />
                <ElOption label="客户付款日期" value="paidAt" />
                <ElOption label="订单完成日期" value="completedAt" />
              </ElSelect>
            </ElFormItem>
          </ElCol>
          <ElCol :xs="24" :lg="12">
            <ElFormItem label="明细日期范围（留空导出全部可见明细）">
              <ElDatePicker
                v-model="dateRange"
                type="daterange"
                value-format="YYYY-MM-DD"
                start-placeholder="开始日期"
                end-placeholder="结束日期"
                range-separator="至"
                class="!w-full"
              />
            </ElFormItem>
          </ElCol>
          <ElCol :xs="24" :sm="12" :lg="6"
            ><ElFormItem label="相关人员"
              ><ElSelect
                v-model="filters.personId"
                clearable
                filterable
                placeholder="全部可见人员"
                class="w-full"
                ><ElOption
                  v-for="person in data?.users || []"
                  :key="person.id"
                  :label="person.name"
                  :value="person.id" /></ElSelect></ElFormItem
          ></ElCol>
          <ElCol :xs="24" :sm="12" :lg="6"
            ><ElFormItem label="来源平台"
              ><ElSelect
                v-model="filters.platformId"
                clearable
                placeholder="全部平台"
                class="w-full"
                ><ElOption
                  v-for="platform in data?.platforms || []"
                  :key="platform.id"
                  :label="platform.name"
                  :value="platform.id" /></ElSelect></ElFormItem
          ></ElCol>
          <ElCol :xs="24" :sm="12" :lg="6"
            ><ElFormItem label="记录状态"
              ><ElSelect v-model="filters.status" clearable placeholder="全部状态" class="w-full"
                ><ElOption
                  v-for="option in statusOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value" /></ElSelect></ElFormItem
          ></ElCol>
          <ElCol :xs="24" :sm="12" :lg="6"
            ><ElFormItem label="关键词"
              ><ElInput
                v-model="filters.keyword"
                clearable
                maxlength="100"
                placeholder="订单号、客户、姓名、用途等" /></ElFormItem
          ></ElCol>
        </ElRow>
      </ElForm>
      <p class="text-sm text-g-500"
        >经营和工资报表使用核算月份；日期范围按各模块注明的日期筛选。人员、角色和业务配置导出当前配置。</p
      >
    </ElCard>
    <ElCard class="mb-5" shadow="never" v-loading="catalogLoading">
      <template #header>
        <div class="flex justify-between items-center flex-wrap gap-3"
          ><span class="font-semibold">2. 选择模块与字段</span
          ><ElSpace
            ><ElButton :disabled="busy || catalogLoading" @click="selectAll">全选模块</ElButton
            ><ElButton :disabled="busy || catalogLoading" @click="selectedIds = []"
              >清空选择</ElButton
            ><ElButton :disabled="busy || catalogLoading" @click="reloadCatalog"
              >刷新数据</ElButton
            ></ElSpace
          ></div
        >
      </template>
      <template v-for="group in groups" :key="group.name">
        <h3 class="font-medium mb-3 mt-3">{{ group.name }}</h3>
        <ElCheckboxGroup
          v-model="selectedIds"
          :disabled="busy || catalogLoading"
          class="flex flex-wrap gap-x-5 gap-y-2 mb-5"
        >
          <ElCheckbox v-for="item in group.modules" :key="item.id" :value="item.id"
            ><span>{{ item.label }}</span
            ><ElTag class="ml-2" size="small" type="info">{{ item.rowCount }} 条</ElTag></ElCheckbox
          >
        </ElCheckboxGroup>
      </template>
      <ElEmpty v-if="!catalogLoading && !catalog.length" description="暂无可导出的业务数据模块" />
      <ElDivider v-if="selectedModules.length" />
      <ElCollapse v-model="expanded">
        <ElCollapseItem v-for="item in selectedModules" :key="item.id" :name="item.id">
          <template #title
            ><div class="flex gap-3 items-center"
              ><span>{{ item.label }}</span
              ><ElTag size="small"
                >已选 {{ selectedFields[item.id]?.length || 0 }} /
                {{ item.fields.length }} 项字段</ElTag
              ></div
            ></template
          >
          <p class="text-sm text-g-500 mb-3"
            >{{ item.description }}{{ item.dateLabel ? ' · 日期口径：' + item.dateLabel : '' }}</p
          >
          <ElSpace class="mb-3"
            ><ElButton size="small" :disabled="busy" @click="setFields(item.id, 'all')"
              >全部字段</ElButton
            ><ElButton size="small" :disabled="busy" @click="setFields(item.id, 'default')"
              >常用字段</ElButton
            ><ElButton size="small" :disabled="busy" @click="setFields(item.id, 'none')"
              >清空字段</ElButton
            ></ElSpace
          >
          <ElCheckboxGroup
            v-model="selectedFields[item.id]"
            :disabled="busy"
            class="flex flex-wrap gap-x-5 gap-y-2"
            ><ElCheckbox v-for="field in item.fields" :key="field.key" :value="field.key">{{
              field.label
            }}</ElCheckbox></ElCheckboxGroup
          >
          <p v-if="!selectedFields[item.id]?.length" class="text-sm text-danger mt-2"
            >请至少选择一项字段。</p
          >
        </ElCollapseItem>
      </ElCollapse>
    </ElCard>
    <ElCard class="mb-5" shadow="never">
      <template #header><span class="font-semibold">3. 预览与下载</span></template>
      <div class="flex gap-3 flex-wrap items-end mb-4">
        <div class="flex-1 min-w-48"
          ><label for="report-filename" class="text-sm block mb-2">文件名称</label
          ><ElInput
            id="report-filename"
            v-model="filename"
            :disabled="busy"
            maxlength="100"
            placeholder="工作室数据报表"
        /></div>
        <ElCheckbox v-model="autoIndex" :disabled="busy">附加序号列</ElCheckbox>
        <ElButton
          type="primary"
          plain
          :loading="previewLoading"
          :disabled="!ready || exporting"
          @click="preview"
          >预览所选内容</ElButton
        >
        <ArtExcelExport
          :prepare-export="prepareExport"
          :disabled="!ready || previewLoading"
          :filename="filename.trim() || '工作室数据报表'"
          :auto-index="autoIndex"
          :max-rows="100000"
          :show-success-message="false"
          @before-export="exporting = true"
          @export-success="exportSuccess"
          @export-error="exportFailure"
          >下载 Excel（{{ selectedIds.length }} 个模块）</ArtExcelExport
        >
      </div>
      <p class="text-sm text-g-500 mb-4"
        >导出包含筛选后的全部记录，按模块分工作表；预览每表最多显示 20 条。金额单位为元，比例单位为
        %，凭证导出名称与地址。</p
      >
      <ElAlert
        v-if="previewStale && previewResult"
        title="选择或范围已更改，请重新预览。下载时按当前选择重新核验权限并读取数据。"
        type="warning"
        :closable="false"
        class="mb-4"
      />
      <template v-if="previewResult">
        <ElTabs v-model="previewTab"
          ><ElTabPane
            v-for="sheet in previewResult.sheets"
            :key="sheet.id"
            :name="sheet.id"
            :label="sheet.name + '（' + sheet.rowCount + ' 条）'"
        /></ElTabs>
        <template v-if="previewSheet"
          ><ArtTable
            :data="previewSheet.rows"
            :columns="previewColumns"
            height="420"
            empty-height="220px"
            empty-text="该范围内没有记录，Excel 将保留所选表头"
          /><p class="text-sm text-g-500 mt-3"
            >共 {{ previewSheet.rowCount }} 条记录，预览 {{ previewSheet.rows.length }} 条 ·
            数据读取于 {{ formatTime(previewResult.generatedAt) }}</p
          ></template
        >
      </template>
      <ElEmpty v-else description="选择模块和字段后，可先预览再下载。" />
    </ElCard>
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, reactive, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { useStudio, formatTime } from '@/hooks/business/useStudio'
  import {
    getExportCatalog,
    previewReports,
    downloadReports,
    type ReportModule,
    type ReportFilters,
    type ReportResult,
    type ReportRequest
  } from '@/api/report-export'

  defineOptions({ name: 'ReportExport' })
  const route = useRoute()
  const { data, selectedMonth } = useStudio()
  const month = ref(selectedMonth.value)
  const catalog = ref<ReportModule[]>([])
  const catalogLoading = ref(false)
  const previewLoading = ref(false)
  const exporting = ref(false)
  const busy = computed(() => previewLoading.value || exporting.value)
  const pageError = ref('')
  const selectedIds = ref<string[]>([])
  const selectedFields = reactive<Record<string, string[]>>({})
  const expanded = ref<string[]>([])
  const dateRange = ref<[string, string] | null>(null)
  const filters = reactive<ReportFilters>({
    keyword: '',
    personId: '',
    platformId: '',
    status: '',
    orderDateKey: 'createdAt'
  })
  const filename = ref('工作室数据报表')
  const autoIndex = ref(true)
  const previewResult = ref<ReportResult | null>(null)
  const previewTab = ref('')
  const previewStale = ref(false)
  let catalogVersion = 0
  const statusOptions = [
    { value: 'pending', label: '待接单 / 待审核' },
    { value: 'active', label: '接单中 / 账号启用' },
    { value: 'review', label: '待验收' },
    { value: 'completed', label: '已完成' },
    { value: 'canceled', label: '已取消' },
    { value: 'approved', label: '审核通过' },
    { value: 'paid', label: '已退款 / 已发放' },
    { value: 'rejected', label: '已驳回' },
    { value: 'scheduled', label: '排班待登记' },
    { value: 'present', label: '实际到岗' },
    { value: 'leave', label: '请假' },
    { value: 'absent', label: '缺勤' },
    { value: 'disabled', label: '账号停用' },
    { value: 'deleted', label: '费用已删除' }
  ]
  const groups = computed(() =>
    [...new Set(catalog.value.map((item) => item.group))].map((name) => ({
      name,
      modules: catalog.value.filter((item) => item.group === name)
    }))
  )
  const selectedModules = computed(() =>
    catalog.value.filter((item) => selectedIds.value.includes(item.id))
  )
  const ready = computed(
    () =>
      !catalogLoading.value &&
      !pageError.value &&
      selectedModules.value.length > 0 &&
      selectedModules.value.every((item) => selectedFields[item.id]?.length)
  )
  const previewSheet = computed(() =>
    previewResult.value?.sheets.find((item) => item.id === previewTab.value)
  )
  const previewColumns = computed(
    () =>
      previewSheet.value?.fields.map((field) => ({
        prop: field.key,
        label: field.label,
        minWidth: field.type === 'number' ? 140 : 180,
        showOverflowTooltip: true
      })) || []
  )
  const errorText = (cause: unknown) =>
    cause instanceof Error ? cause.message : '加载失败，请稍后重试'
  function requestBody(): ReportRequest {
    return {
      month: month.value,
      modules: selectedModules.value.map((item) => ({
        id: item.id,
        fields: [...selectedFields[item.id]]
      })),
      filters: { ...filters, dateRange: dateRange.value || undefined }
    }
  }
  function setFields(id: string, mode: 'all' | 'default' | 'none') {
    const item = catalog.value.find((item) => item.id === id)
    selectedFields[id] = item
      ? item.fields
          .filter((field) => mode === 'all' || (mode === 'default' && field.default !== false))
          .map((field) => field.key)
      : []
    if (mode === 'none') selectedFields[id] = []
  }
  function selectAll() {
    selectedIds.value = catalog.value.map((item) => item.id)
  }
  function routeSelection() {
    const requested =
      typeof route.query.modules === 'string'
        ? route.query.modules.split(',')
        : [typeof route.query.module === 'string' ? route.query.module : 'orders']
    return catalog.value.filter((item) => requested.includes(item.id)).map((item) => item.id)
  }
  async function reloadCatalog() {
    const version = ++catalogVersion
    catalogLoading.value = true
    pageError.value = ''
    previewResult.value = null
    try {
      const result = await getExportCatalog(month.value)
      if (version !== catalogVersion) return
      catalog.value = result.modules
      for (const item of result.modules) {
        const allowed = new Set(item.fields.map((field) => field.key))
        selectedFields[item.id] =
          selectedFields[item.id]?.filter((key) => allowed.has(key)) ||
          item.fields.filter((field) => field.default !== false).map((field) => field.key)
      }
      selectedIds.value = selectedIds.value.filter((id) =>
        result.modules.some((item) => item.id === id)
      )
      if (!selectedIds.value.length) {
        const preferred = routeSelection()
        selectedIds.value = preferred.length
          ? preferred
          : result.modules.slice(0, 1).map((item) => item.id)
      }
      expanded.value = selectedIds.value.slice(0, 1)
    } catch (cause) {
      if (version === catalogVersion) pageError.value = errorText(cause)
    } finally {
      if (version === catalogVersion) catalogLoading.value = false
    }
  }
  async function preview() {
    if (!ready.value || busy.value) return
    previewLoading.value = true
    try {
      previewResult.value = await previewReports(requestBody())
      previewTab.value = previewResult.value.sheets[0]?.id || ''
      previewStale.value = false
    } catch (cause) {
      ElMessage.error(errorText(cause))
      previewResult.value = null
    } finally {
      previewLoading.value = false
    }
  }
  async function prepareExport() {
    if (!ready.value || previewLoading.value) throw new Error('请先选择模块与字段')
    exporting.value = true
    try {
      const result = await downloadReports(requestBody())
      return result.sheets
    } catch (cause) {
      exporting.value = false
      throw cause
    }
  }
  function exportSuccess(_name: string, count: number) {
    exporting.value = false
    ElMessage.success(`已导出 ${selectedIds.value.length} 个模块，共 ${count} 条记录`)
  }
  function exportFailure() {
    exporting.value = false
  }
  watch(
    [month, dateRange, filters, selectedIds, selectedFields],
    () => {
      previewStale.value = true
    },
    { deep: true }
  )
  watch(month, (value) => {
    if (value) void reloadCatalog()
  })
  watch(
    () => data.value?.permissions.join('|'),
    (value, previous) => {
      if (value !== previous && previous !== undefined) void reloadCatalog()
    }
  )
  watch(
    () => [route.query.module, route.query.modules],
    () => {
      const preferred = routeSelection()
      if (preferred.length) {
        selectedIds.value = preferred
        expanded.value = preferred.slice(0, 1)
      }
    }
  )
  onMounted(reloadCatalog)
</script>
