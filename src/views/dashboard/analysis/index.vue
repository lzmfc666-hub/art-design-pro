<template>
  <div>
    <ArtSearchBar v-model="search" :items="searchItems" @search="reloadMonth" @reset="reloadMonth"
      ><template #month
        ><ElDatePicker
          v-model="selectedMonth"
          type="month"
          value-format="YYYY-MM"
          :clearable="false" /></template
    ></ArtSearchBar>
    <ElAlert
      class="mb-5"
      title="收款、退款和经营成本归属客户原付款日；日报不扣底薪，月利润扣除当月底薪。提成的工资归属按订单完成月份计算。"
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
              ><ElTag effect="plain">{{ data?.reports.month || selectedMonth }} 付款归属日</ElTag
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
          ><template #net="{ row }">{{ money(row.net) }}</template></ArtTable
        >
      </template>
    </ElCard>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { ElMessage } from 'element-plus'
  import { useStudio, money } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { ChannelReport, DayReport, Performance } from '@/types/studio'
  import TodaySales from './modules/today-sales.vue'
  import VisitorInsights from './modules/visitor-insights.vue'
  import TotalRevenue from './modules/total-revenue.vue'

  defineOptions({ name: 'Analysis' })
  const { data, loading, selectedMonth, refresh } = useStudio()
  const tab = ref('days')
  const search = ref<Record<string, unknown>>({})
  const searchItems = [
    {
      key: 'month',
      label: '经营月份',
      type: 'date',
      props: { type: 'month', valueFormat: 'YYYY-MM', clearable: false }
    }
  ]
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
    () => data.value?.reports.monthlyProfit == null || days.value.some((row) => row.incomplete)
  )
  const dayTable = useBusinessTable(days, 10)
  const channelTable = useBusinessTable(channels)
  const performanceTable = useBusinessTable(performance)
  const dayColumns = useTableColumns<DayReport>(() => [
    { prop: 'date', label: '付款归属日', minWidth: 135 },
    { prop: 'received', label: '客户收款', minWidth: 130, useSlot: true },
    { prop: 'refunds', label: '累计退款', minWidth: 125, useSlot: true },
    { prop: 'net', label: '净收入', minWidth: 130, useSlot: true },
    { prop: 'reward', label: '打手成本', minWidth: 170, useSlot: true },
    { prop: 'supportCommission', label: '客服提成', minWidth: 130, useSlot: true },
    { prop: 'operationsCommission', label: '运营提成', minWidth: 130, useSlot: true },
    { prop: 'expenses', label: '其他费用', minWidth: 130, useSlot: true },
    { prop: 'profit', label: '日报利润（不扣底薪）', minWidth: 190, useSlot: true, fixed: 'right' }
  ])
  const channelColumns = useTableColumns<ChannelReport>(() => [
    { prop: 'name', label: '平台 / 店铺', minWidth: 240, useSlot: true },
    { prop: 'orders', label: '订单数', minWidth: 120 },
    { prop: 'received', label: '收款', minWidth: 150, useSlot: true },
    { prop: 'refunds', label: '累计退款', minWidth: 150, useSlot: true },
    { prop: 'net', label: '净收入', minWidth: 155, useSlot: true }
  ])
  const performanceColumns = useTableColumns<Performance>(() => [
    { prop: 'name', label: '员工', minWidth: 180 },
    { prop: 'orders', label: '完成订单', minWidth: 140 },
    { prop: 'net', label: '完成订单净收入', minWidth: 180, useSlot: true }
  ])
  async function reloadMonth() {
    try {
      await refresh(selectedMonth.value)
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '查询失败')
    }
  }
  watch(selectedMonth, () => {
    dayTable.resetPage()
    channelTable.resetPage()
    performanceTable.resetPage()
    void reloadMonth()
  })
</script>
