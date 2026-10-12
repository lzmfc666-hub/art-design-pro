<template>
  <div class="report-export-page">
    <BusinessPageHeader
      title="自选数据导出"
      description="先选业务模块，再选需要的内容，合并下载为一个 Excel 文件。"
      icon="ri:file-excel-2-line"
      badge="按当前账号权限导出"
      ><template #actions
        ><ElButton :loading="catalogLoading" :disabled="busy" @click="reloadCatalog"
          ><ArtSvgIcon icon="ri:refresh-line" class="mr-1" />刷新可见模块</ElButton
        ></template
      ></BusinessPageHeader
    >
    <div class="export-stats">
      <BusinessStatCard
        label="已选业务模块"
        :value="selectedModules.length"
        icon="ri:stack-line"
        tone="primary"
        :description="`当前可选 ${catalog.length} 个模块 · 每个模块一张工作表`"
      />
      <BusinessStatCard
        label="已选导出字段"
        :value="selectedFieldCount"
        icon="ri:list-check-3"
        :tone="missingFields ? 'warning' : 'success'"
        :description="
          missingFields
            ? `${missingFields} 个模块尚未选择字段`
            : '只导出勾选内容，每个模块可独立选字段'
        "
      />
      <BusinessStatCard
        :label="previewResult && !previewStale ? '筛选后的记录' : '所选模块可见记录'"
        :value="catalogLoading ? '—' : visibleRecordCount"
        icon="ri:database-2-line"
        tone="info"
        :description="
          previewResult && !previewStale
            ? '已按当前选择预览 · 下载时读取最新数据'
            : '筛选前记录数 · 可先预览核对导出范围'
        "
      />
    </div>
    <ElAlert
      v-if="pageError"
      :title="pageError"
      type="error"
      :closable="false"
      show-icon
      class="mb-5"
    />
    <ElCard class="mb-5" shadow="never">
      <template #header
        ><div class="step-heading"
          ><span class="step-number">1</span
          ><div><h3>设置导出范围</h3><p>核算月份与明细日期分开选择</p></div></div
        ></template
      >
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
          ><div class="step-heading"
            ><span class="step-number">2</span
            ><div><h3>选择模块与字段</h3><p>按业务分组选取，再展开模块选择具体内容</p></div></div
          >
          ><ElSpace
            ><ElButton :disabled="busy || catalogLoading" @click="selectAll">全选模块</ElButton
            ><ElButton :disabled="busy || catalogLoading" @click="selectedIds = []"
              >清空选择</ElButton
            ></ElSpace
          ></div
        >
      </template>
      <div class="module-grid">
        <section v-for="group in groups" :key="group.name" class="module-group">
          <div class="module-group-heading"
            ><h3><ArtSvgIcon :icon="groupIcon(group.name)" />{{ group.name }}</h3
            ><ElButton
              link
              type="primary"
              :disabled="busy || catalogLoading"
              @click="toggleGroup(group.modules)"
              >{{
                group.modules.every((item) => selectedIds.includes(item.id))
                  ? '取消本组'
                  : '选择本组'
              }}</ElButton
            ></div
          >
          <ElCheckboxGroup
            v-model="selectedIds"
            :disabled="busy || catalogLoading"
            class="module-list"
          >
            <ElCheckbox
              v-for="item in group.modules"
              :key="item.id"
              :value="item.id"
              class="module-option"
              ><span class="module-label">{{ item.label }}</span
              ><span class="module-record-count">{{ item.rowCount }} 条</span></ElCheckbox
            >
          </ElCheckboxGroup>
        </section>
      </div>
      <ElEmpty v-if="!catalogLoading && !catalog.length" description="暂无可导出的业务数据模块" />
      <ElDivider v-if="selectedModules.length" />
      <div v-if="selectedModules.length" class="selection-heading"
        ><h3
          >已选内容
          <span>{{ selectedModules.length }} 个模块 · {{ selectedFieldCount }} 项字段</span></h3
        ><ElTag v-if="missingFields" type="warning" effect="plain"
          >{{ missingFields }} 个模块需选择字段</ElTag
        ><ElButton
          v-else
          link
          type="primary"
          :disabled="busy"
          @click="expanded = expanded.length ? [] : selectedModules.map((item) => item.id)"
          >{{ expanded.length ? '收起字段' : '展开字段' }}</ElButton
        ></div
      >
      <ElCollapse v-model="expanded">
        <ElCollapseItem v-for="item in selectedModules" :key="item.id" :name="item.id">
          <template #title
            ><div class="field-module-heading"
              ><span>{{ item.label }}</span
              ><ElTag size="small" :type="selectedFields[item.id]?.length ? 'primary' : 'warning'"
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
          <ElCheckboxGroup v-model="selectedFields[item.id]" :disabled="busy" class="field-options"
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
      <template #header
        ><div class="step-heading"
          ><span class="step-number">3</span
          ><div
            ><h3>核对内容，下载报表</h3><p>{{ rangeSummary }}</p></div
          ></div
        ></template
      >
      <div v-if="selectedModules.length" class="selected-module-tags"
        ><ElTag
          v-for="item in selectedModules"
          :key="item.id"
          :type="selectedFields[item.id]?.length ? 'info' : 'warning'"
          effect="plain"
          >{{ item.label }} · {{ selectedFields[item.id]?.length || 0 }} 项</ElTag
        ></div
      >
      <div class="flex gap-3 flex-wrap items-end mb-4">
        <div class="filename-control"
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
        <ElTabs v-model="previewTab" :before-leave="() => !busy"
          ><ElTabPane
            v-for="sheet in previewResult.sheets"
            :key="sheet.id"
            :name="sheet.id"
            :label="sheet.name + '（' + sheet.rowCount + ' 条）'"
            :disabled="busy"
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
      <div v-else class="preview-placeholder"
        ><div class="preview-placeholder-icon"><ArtSvgIcon icon="ri:file-search-line" /></div
        ><div
          ><h4>先预览，核对后再下载</h4
          ><p>展示每个模块的前 20 条记录，下载包含所选范围内的全部记录。</p></div
        ></div
      >
    </ElCard>
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, reactive, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { useStudio, formatTime } from '@/hooks/business/useStudio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
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
  const router = useRouter()
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
  const selectedFieldCount = computed(() =>
    selectedModules.value.reduce((sum, item) => sum + (selectedFields[item.id]?.length || 0), 0)
  )
  const missingFields = computed(
    () => selectedModules.value.filter((item) => !selectedFields[item.id]?.length).length
  )
  const visibleRecordCount = computed(() =>
    previewResult.value && !previewStale.value
      ? previewResult.value.sheets.reduce((sum, item) => sum + item.rowCount, 0)
      : selectedModules.value.reduce((sum, item) => sum + item.rowCount, 0)
  )
  const rangeSummary = computed(() => {
    const parts = [
      `核算 ${month.value}`,
      dateRange.value ? `${dateRange.value[0]} 至 ${dateRange.value[1]}` : '全部可见明细'
    ]
    if (filters.personId)
      parts.push(data.value?.users.find((item) => item.id === filters.personId)?.name || '已选人员')
    if (filters.platformId)
      parts.push(
        data.value?.platforms.find((item) => item.id === filters.platformId)?.name || '已选平台'
      )
    if (filters.status)
      parts.push(
        statusOptions.find((item) => item.value === filters.status)?.label || filters.status
      )
    if (filters.keyword?.trim()) parts.push(`关键词：${filters.keyword.trim()}`)
    return parts.join(' · ')
  })
  const groupIcons: Record<string, string> = {
    经营报表: 'ri:bar-chart-box-line',
    订单业务: 'ri:file-list-3-line',
    财务结算: 'ri:bank-card-line',
    工资与提成: 'ri:money-cny-circle-line',
    人员管理: 'ri:team-line',
    客户与配置: 'ri:settings-3-line',
    审计与个人: 'ri:shield-user-line'
  }
  const groupIcon = (group: string) => groupIcons[group] || 'ri:folder-3-line'
  function toggleGroup(items: ReportModule[]) {
    if (busy.value || catalogLoading.value) return
    const ids = new Set(items.map((item) => item.id))
    selectedIds.value = items.every((item) => selectedIds.value.includes(item.id))
      ? selectedIds.value.filter((id) => !ids.has(id))
      : [...new Set([...selectedIds.value, ...ids])]
  }
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
    if (busy.value || catalogLoading.value) return
    const item = catalog.value.find((item) => item.id === id)
    selectedFields[id] = item
      ? item.fields
          .filter((field) => mode === 'all' || (mode === 'default' && field.default !== false))
          .map((field) => field.key)
      : []
    if (mode === 'none') selectedFields[id] = []
  }
  function selectAll() {
    if (busy.value || catalogLoading.value) return
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
      const preferred = typeof route.query.tab === 'string' ? route.query.tab : ''
      previewTab.value = previewResult.value.sheets.some((item) => item.id === preferred)
        ? preferred
        : previewResult.value.sheets[0]?.id || ''
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
  watch(selectedIds, (ids, previous) => {
    expanded.value = expanded.value.filter((id) => ids.includes(id))
    const added = ids.find((id) => !previous.includes(id))
    if (added && !expanded.value.includes(added)) expanded.value.push(added)
  })
  watch(previewTab, (value) => {
    if (route.path !== '/reports/export') return
    if (value && route.query.tab !== value)
      void router.replace({ query: { ...route.query, tab: value } })
  })
  watch(
    () => route.fullPath,
    () => {
      if (route.path !== '/reports/export') return
      const value = route.query.tab
      if (busy.value) {
        if (previewTab.value && value !== previewTab.value)
          void router.replace({ query: { ...route.query, tab: previewTab.value } })
        return
      }
      if (typeof value !== 'string') return
      if (previewResult.value?.sheets.some((item) => item.id === value)) previewTab.value = value
    }
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
  watch([() => route.query.module, () => route.query.modules], () => {
    if (route.path !== '/reports/export' || busy.value) return
    const preferred = routeSelection()
    if (preferred.length) {
      selectedIds.value = preferred
      expanded.value = preferred.slice(0, 1)
    }
  })
  onMounted(reloadCatalog)
</script>

<style scoped lang="scss">
  .export-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
    margin-bottom: 20px;
  }

  .step-heading {
    display: flex;
    gap: 12px;
    align-items: center;
    min-width: 0;

    h3 {
      font-size: 15px;
      font-weight: 600;
    }

    p {
      margin-top: 4px;
      font-size: 12px;
      line-height: 1.6;
      color: var(--el-text-color-secondary);
    }
  }

  .step-number {
    display: grid;
    flex: 0 0 34px;
    place-items: center;
    height: 34px;
    font-size: 16px;
    font-weight: 600;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-radius: 10px;
  }

  .module-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }

  .module-group {
    padding: 14px 16px;
    background: var(--el-fill-color-extra-light);
    border: 1px solid var(--el-border-color-light);
    border-radius: 12px;
  }

  .module-group-heading {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;

    h3 {
      display: inline-flex;
      gap: 7px;
      align-items: center;
      font-size: 14px;
      font-weight: 600;
    }
  }

  .module-list {
    display: flex;
    flex-direction: column;
  }

  .module-option {
    height: auto;
    min-height: 36px;
    padding: 6px 0;
    margin-right: 0;

    :deep(.el-checkbox__label) {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-width: 0;
    }
  }

  .module-label {
    line-height: 1.5;
    white-space: normal;
  }

  .module-record-count {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .selection-heading {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;

    h3 {
      font-size: 14px;
      font-weight: 600;
    }

    h3 span {
      margin-left: 10px;
      font-size: 12px;
      font-weight: 400;
      color: var(--el-text-color-secondary);
    }
  }

  .field-module-heading {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
    padding: 8px 0;
  }

  .field-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px 16px;
    padding: 12px 16px;
    background: var(--el-fill-color-extra-light);
    border-radius: 10px;

    :deep(.el-checkbox) {
      height: auto;
      min-height: 34px;
      margin-right: 0;
    }

    :deep(.el-checkbox__label) {
      line-height: 1.6;
      white-space: normal;
    }
  }

  .selected-module-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 18px;
  }

  .filename-control {
    flex: 1;
    min-width: 190px;
    max-width: 420px;
  }

  .preview-placeholder {
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
    background: var(--el-fill-color-extra-light);
    border: 1px dashed var(--el-border-color);
    border-radius: 12px;

    h4 {
      font-size: 14px;
      font-weight: 500;
    }

    p {
      margin-top: 6px;
      font-size: 13px;
      line-height: 1.7;
      color: var(--el-text-color-secondary);
    }
  }

  .preview-placeholder-icon {
    display: grid;
    flex: 0 0 44px;
    place-items: center;
    height: 44px;
    font-size: 25px;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-radius: 12px;
  }

  @media (width <= 1100px) {
    .module-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .field-options {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (width <= 640px) {
    .export-stats,
    .module-grid,
    .field-options {
      grid-template-columns: 1fr;
    }

    .export-stats {
      gap: 12px;
      margin-bottom: 16px;
    }

    .module-grid {
      gap: 12px;
    }

    .field-options {
      padding: 10px 12px;
    }

    .filename-control {
      flex-basis: 100%;
      max-width: none;
    }

    .preview-placeholder {
      align-items: flex-start;
      padding: 18px 12px;
    }
  }
</style>
