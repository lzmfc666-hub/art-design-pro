<template>
  <div class="analysis-page">
    <BusinessPageHeader
      title="经营报表"
      description="从订单收款、退款、其他收入与经营成本，查看每月经营结果和渠道贡献。"
      icon="ri:bar-chart-box-line"
      :badge="loading ? '正在更新' : incomplete ? '利润待核实' : '月度经营核算'"
    >
      <template #actions>
        <ElButton v-if="can('reports.export')" type="primary" plain @click="exportCurrent"
          ><ArtSvgIcon icon="ri:file-excel-2-line" class="mr-1" />导出经营报表</ElButton
        >
      </template>
    </BusinessPageHeader>
    <ElCard class="mb-5" shadow="never">
      <div class="analysis-toolbar">
        <div class="flex items-center flex-wrap gap-3">
          <span class="font-medium">经营月份</span>
          <ElDatePicker
            v-model="selectedMonth"
            type="month"
            value-format="YYYY-MM"
            :clearable="false"
            :disabled="loading"
            class="!w-40"
          />
          <ElButton :loading="loading" @click="reloadMonth"
            ><ArtSvgIcon icon="ri:refresh-line" class="mr-1" />刷新报表</ElButton
          >
        </div>
        <span v-if="lastUpdatedAt" class="text-sm text-g-500"
          >更新于 {{ formatTime(lastUpdatedAt) }}</span
        >
      </div>
    </ElCard>
    <ElAlert
      class="mb-5"
      title="订单收入与成本归属原付款日；非订单客户扣款和离店 / 跑路押金没收按登记日计其他收入，并计入利润。充值及押金缴退不计经营收入，订单余额支付只计一次订单收入。日报不扣底薪，月利润再扣当月底薪。"
      type="info"
      :closable="false"
      show-icon
    />
    <ElAlert
      v-if="incomplete"
      class="mb-5"
      title="本月存在未配置工资 / 提成或待确认的取消补偿，利润暂不完整。未验收订单的预计打手成本已计入，不按零成本展示利润。"
      type="warning"
      :closable="false"
      show-icon
    />
    <TodaySales />
    <ElRow :gutter="20">
      <ElCol :xl="14" :xs="24"><VisitorInsights /></ElCol>
      <ElCol :xl="10" :xs="24"><TotalRevenue /></ElCol>
    </ElRow>
    <ElCard shadow="never">
      <ElTabs v-model="tab"
        ><ElTabPane label="每日经营明细" name="days" /><ElTabPane
          label="平台 / 店铺"
          name="channels" /><ElTabPane label="员工完成业绩" name="performance"
      /></ElTabs>
      <template v-if="tab === 'days'">
        <ArtTableHeader
          v-model:columns="dayColumns.columnChecks.value"
          :loading="loading"
          @refresh="reloadMonth"
          ><template #left
            ><ElSpace wrap
              ><ElTag effect="plain">{{ data?.reports.month || selectedMonth }} 经营归属日</ElTag
              ><span class="text-g-500"
                >月度底薪 {{ money(data?.reports.monthlyBase) }}</span
              ></ElSpace
            ></template
          ></ArtTableHeader
        >
        <ArtTable
          :data="dayTable.tableData.value"
          :columns="dayColumns.columns.value"
          :loading="loading"
          :pagination="dayTable.pagination"
          height="460"
          empty-height="260px"
          @pagination:size-change="dayTable.handleSizeChange"
          @pagination:current-change="dayTable.handleCurrentChange"
        >
          <template #received="{ row }">{{ money(row.received) }}</template
          ><template #refunds="{ row }">{{ money(row.refunds) }}</template
          ><template #net="{ row }"
            ><strong>{{ money(row.net) }}</strong></template
          >
          <template #otherIncome="{ row }">{{ money(row.otherIncome) }}</template>
          <template #reward="{ row }"
            ><div>{{ money(row.reward) }}</div
            ><small v-if="row.estimatedReward" class="text-warning"
              >含预计 {{ money(row.estimatedReward) }}</small
            ></template
          >
          <template #supportCommission="{ row }">{{ money(row.supportCommission) }}</template
          ><template #operationsCommission="{ row }">{{ money(row.operationsCommission) }}</template
          ><template #expenses="{ row }">{{ money(row.expenses) }}</template>
          <template #profit="{ row }"
            ><ElTag v-if="row.incomplete" type="warning">配置未齐</ElTag
            ><strong v-else>{{ money(row.profit) }}</strong></template
          >
          <template #operation="{ row }"
            ><ElButton link type="primary" @click="openReportDetail('days', row)"
              >查看日报详情</ElButton
            ></template
          >
        </ArtTable>
      </template>
      <template v-else-if="tab === 'channels'">
        <ArtTableHeader
          v-model:columns="channelColumns.columnChecks.value"
          :loading="loading"
          @refresh="reloadMonth"
          ><template #left
            ><span class="text-g-500"
              >平台汇总及所属店铺分项，父级和子级金额不重复相加。</span
            ></template
          ></ArtTableHeader
        >
        <ArtTable
          :data="channelTable.tableData.value"
          :columns="channelColumns.columns.value"
          :loading="loading"
          :pagination="channelTable.pagination"
          height="460"
          empty-height="260px"
          @pagination:size-change="channelTable.handleSizeChange"
          @pagination:current-change="channelTable.handleCurrentChange"
        >
          <template #name="{ row }"
            ><span :class="row.shopId ? 'pl-5 text-g-500' : 'font-medium'">{{
              row.name
            }}</span></template
          ><template #received="{ row }">{{ money(row.received) }}</template
          ><template #refunds="{ row }">{{ money(row.refunds) }}</template
          ><template #net="{ row }"
            ><strong>{{ money(row.net) }}</strong></template
          >
          <template #operation="{ row }"
            ><ElButton link type="primary" @click="openReportDetail('channels', row)"
              >查看渠道详情</ElButton
            ></template
          >
        </ArtTable>
      </template>
      <template v-else>
        <ArtTableHeader
          v-model:columns="performanceColumns.columnChecks.value"
          :loading="loading"
          @refresh="reloadMonth"
          ><template #left
            ><span class="text-g-500"
              >按完成月份统计；运营按提成归属，其他员工按创建人归属。</span
            ></template
          ></ArtTableHeader
        >
        <ArtTable
          :data="performanceTable.tableData.value"
          :columns="performanceColumns.columns.value"
          :loading="loading"
          :pagination="performanceTable.pagination"
          height="460"
          empty-height="260px"
          @pagination:size-change="performanceTable.handleSizeChange"
          @pagination:current-change="performanceTable.handleCurrentChange"
          ><template #net="{ row }">{{ money(row.net) }}</template
          ><template #operation="{ row }"
            ><ElButton link type="primary" @click="openReportDetail('performance', row)"
              >查看业绩详情</ElButton
            ></template
          ></ArtTable
        >
      </template>
    </ElCard>
    <BusinessDetailPanel
      v-model="reportDetailOpen"
      page-key="analysis-record"
      :record-id="`${selectedMonth}:${reportDetailType}:${reportDetailKey}`"
      :restore-error="reportRestoreError"
      @restore="restoreReportDetail($event)"
      title="经营报表记录详情"
      class="business-detail-dialog"
      width="min(1040px,96vw)"
    >
      <template v-if="reportDetailRow">
        <BusinessDetailHeader
          :title="
            reportDetailType === 'days'
              ? `${reportDetailKey} 日报`
              : String(reportDetailRow.name || '业务记录')
          "
          description="核对当前服务端报表中这一条记录的金额构成及归属，查看不新增结算或调整。"
          icon="ri:bar-chart-box-line"
          :context="`${selectedMonth} 核算月份 · 更新于 ${formatTime(lastUpdatedAt)}`"
        />
        <BusinessDetailSummary :items="reportDetailItems" />
        <BusinessDetailSection title="归属与统计说明">
          <p v-if="reportDetailType === 'days'" class="text-sm text-g-500 leading-7"
            >订单收入、退款及成本归原付款日，日报不扣员工月度底薪；打手成本已包含预计报酬，预计部分不再次扣除。费用保持原登记及报酬人工净调整口径，缺配置或取消补偿未确认时利润待核实。</p
          >
          <p v-else-if="reportDetailType === 'channels'" class="text-sm text-g-500 leading-7"
            >当前行是该平台或店铺的授权汇总。平台已包含所属店铺；父级和子级不能相加重复统计。退款归原客户付款日。</p
          >
          <p v-else class="text-sm text-g-500 leading-7"
            >仅服务端当前授权的员工完成业绩；按完成月份归属，运营按原提成归属，其他员工按创建人归属。净业绩扣除该订单已支付退款，不等于工资或已发金额。</p
          >
        </BusinessDetailSection>
      </template>
      <template #footer><ElButton @click="reportDetailOpen = false">关闭</ElButton></template>
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import { computed, onActivated, onMounted, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { useStudio, money, formatTime } from '@/hooks/business/useStudio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { ChannelReport, DayReport, Performance } from '@/types/studio'
  import TodaySales from './modules/today-sales.vue'
  import VisitorInsights from './modules/visitor-insights.vue'
  import TotalRevenue from './modules/total-revenue.vue'

  defineOptions({ name: 'Analysis' })
  const { data, loading, selectedMonth, refresh, lastUpdatedAt, can } = useStudio()
  const route = useRoute()
  const router = useRouter()
  const tab = ref('days')
  const reportDetailType = ref<'days' | 'channels' | 'performance'>('days')
  const reportDetailKey = ref('')
  const reportRestoreError = ref('')
  async function restoreReportDetail({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    reportRestoreError.value = '该记录在当前授权报表中不可见，请返回报表重新选择。'
    const month = recordId?.slice(0, 7) || ''
    const separator = recordId?.indexOf(':', 8) ?? -1
    const kind = separator < 0 ? '' : recordId!.slice(8, separator)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return
    if (!['days', 'channels', 'performance'].includes(kind)) return
    if (!data.value || selectedMonth.value !== month) {
      try {
        await refresh(month)
      } catch {
        return
      }
    }
    if (isCurrent?.() === false || data.value?.reports.month !== month) return
    reportDetailType.value = kind as 'days' | 'channels' | 'performance'
    reportDetailKey.value = recordId!.slice(separator + 1)
    if (reportDetailRow.value) reportRestoreError.value = ''
  }
  const reportDetailRow = computed(() => {
    const reports = data.value?.reports
    if (!reports) return undefined
    const row =
      reportDetailType.value === 'days'
        ? reports.days.find((row) => row.date === reportDetailKey.value)
        : reportDetailType.value === 'channels'
          ? reports.channels.find(
              (row) => `${row.platformId}/${row.shopId || ''}` === reportDetailKey.value
            )
          : reports.performance.find((row) => row.userId === reportDetailKey.value)
    return row as unknown as Record<string, string | number | boolean | null> | undefined
  })
  const reportDetailOpen = computed({
    get: () => Boolean(reportDetailRow.value),
    set: (value) => {
      if (!value) reportDetailKey.value = ''
    }
  })
  function openReportDetail(
    kind: 'days' | 'channels' | 'performance',
    row: DayReport | ChannelReport | Performance
  ) {
    reportDetailType.value = kind
    reportDetailKey.value =
      kind === 'days'
        ? (row as DayReport).date
        : kind === 'channels'
          ? `${(row as ChannelReport).platformId}/${(row as ChannelReport).shopId || ''}`
          : (row as Performance).userId
  }
  const reportDetailItems = computed(() => {
    const row = reportDetailRow.value
    if (!row) return []
    const fields =
      reportDetailType.value === 'days'
        ? [
            ['received', '客户收款'],
            ['refunds', '累计退款'],
            ['net', '净收入'],
            ['otherIncome', '其他收入'],
            ['reward', '打手成本（含预计）'],
            ['estimatedReward', '其中预计成本'],
            ['supportCommission', '客服提成'],
            ['operationsCommission', '运营提成'],
            ['expenses', '费用及人工净调整'],
            ['profit', '日报利润（不扣底薪）']
          ]
        : reportDetailType.value === 'channels'
          ? [
              ['received', '客户收款'],
              ['refunds', '累计退款'],
              ['net', '净收入']
            ]
          : [['net', '完成订单净业绩']]
    return [
      ...(reportDetailType.value === 'days'
        ? []
        : [{ label: '完成订单 / 渠道订单', value: Number(row.orders || 0) }]),
      ...fields.map(([key, label]) => ({
        label,
        value:
          key === 'profit' && row.incomplete
            ? '配置未齐 / 待核实'
            : money(typeof row[key] === 'number' ? (row[key] as number) : null)
      }))
    ]
  })
  const days = computed(() => data.value?.reports.days || [])
  const channels = computed(() => {
    const rows = data.value?.reports.channels || []
    return rows
      .filter((row) => !row.shopId)
      .flatMap((platform) => [
        platform,
        ...rows.filter((row) => row.shopId && row.platformId === platform.platformId)
      ])
  })
  const performance = computed(() =>
    [...(data.value?.reports.performance || [])].sort((a, b) => b.net - a.net)
  )
  const incomplete = computed(
    () =>
      !!data.value &&
      (data.value.reports.monthlyProfit == null || days.value.some((row) => row.incomplete))
  )
  watch(
    () => route.fullPath,
    () => {
      if (route.path !== '/dashboard/analysis') return
      const value = route.query.tab
      if (typeof value === 'string' && ['days', 'channels', 'performance'].includes(value))
        tab.value = value
      syncTabQuery(tab.value)
    },
    { immediate: true }
  )
  watch(tab, syncTabQuery)
  function syncTabQuery(value: string) {
    if (route.path !== '/dashboard/analysis') return
    if (route.query.tab !== value) void router.replace({ query: { ...route.query, tab: value } })
  }
  function exportCurrent() {
    if (!can('reports.export')) return
    const modules =
      tab.value === 'channels'
        ? 'channels'
        : tab.value === 'performance'
          ? 'performance'
          : 'overview,days'
    void router.push({ path: '/reports/export', query: { modules } })
  }
  const dayTable = useBusinessTable(days, 10)
  const channelTable = useBusinessTable(channels)
  const performanceTable = useBusinessTable(performance)
  const dayColumns = useTableColumns<DayReport>(() => [
    { prop: 'date', label: '经营归属日', minWidth: 135 },
    { prop: 'received', label: '客户收款', minWidth: 130, useSlot: true },
    { prop: 'refunds', label: '累计退款', minWidth: 125, useSlot: true },
    { prop: 'net', label: '净收入', minWidth: 130, useSlot: true },
    { prop: 'otherIncome', label: '其他收入', minWidth: 140, useSlot: true },
    { prop: 'reward', label: '打手成本', minWidth: 170, useSlot: true },
    { prop: 'supportCommission', label: '客服提成', minWidth: 130, useSlot: true },
    { prop: 'operationsCommission', label: '运营提成', minWidth: 130, useSlot: true },
    { prop: 'expenses', label: '其他费用', minWidth: 130, useSlot: true },
    { prop: 'profit', label: '日报利润（不扣底薪）', minWidth: 190, useSlot: true, fixed: 'right' },
    { prop: 'operation', label: '操作', width: 140, fixed: 'right', useSlot: true }
  ])
  const channelColumns = useTableColumns<ChannelReport>(() => [
    { prop: 'name', label: '平台 / 店铺', minWidth: 240, useSlot: true },
    { prop: 'orders', label: '订单数', minWidth: 120 },
    { prop: 'received', label: '收款', minWidth: 150, useSlot: true },
    { prop: 'refunds', label: '累计退款', minWidth: 150, useSlot: true },
    { prop: 'net', label: '净收入', minWidth: 155, useSlot: true },
    { prop: 'operation', label: '操作', width: 140, fixed: 'right', useSlot: true }
  ])
  const performanceColumns = useTableColumns<Performance>(() => [
    { prop: 'name', label: '员工', minWidth: 180 },
    { prop: 'orders', label: '完成订单', minWidth: 140 },
    { prop: 'net', label: '完成订单净收入', minWidth: 180, useSlot: true },
    { prop: 'operation', label: '操作', width: 140, fixed: 'right', useSlot: true }
  ])
  async function reloadMonth() {
    try {
      await refresh(selectedMonth.value)
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '查询失败')
    }
  }
  function refreshActiveReport() {
    if (route.path === '/dashboard/analysis' && can('profit.view')) void reloadMonth()
  }
  let firstActivation = true
  onMounted(refreshActiveReport)
  onActivated(() => {
    if (firstActivation) {
      firstActivation = false
      return
    }
    refreshActiveReport()
  })
  watch(selectedMonth, () => {
    dayTable.resetPage()
    channelTable.resetPage()
    performanceTable.resetPage()
    if (route.path === '/dashboard/analysis') void reloadMonth()
  })
</script>

<style scoped>
  .analysis-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
    justify-content: space-between;
  }
</style>
