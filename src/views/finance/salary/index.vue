<template>
  <div class="salary-page">
    <BusinessPageHeader
      title="工资与提成"
      description="按核算月份查看工资、核对发放快照，让新增提成和退款差额单独结算。"
      icon="ri:money-cny-circle-line"
      :badge="can('salary.all') ? '全员工资核算' : '本人工资'"
    >
      <template #actions>
        <ElButton type="primary" plain :disabled="saving" @click="exportCurrent">
          <ArtSvgIcon icon="ri:file-excel-2-line" class="mr-1" />导出工资报表
        </ElButton>
      </template>
    </BusinessPageHeader>
    <div class="salary-stats">
      <BusinessStatCard
        :label="snapshots.length ? '待补结算差额' : '所选月份待结算工资'"
        :value="monthReady ? money(pendingTotal) : '—'"
        icon="ri:wallet-3-line"
        :tone="incompleteCount ? 'warning' : 'primary'"
        :description="
          incompleteCount
            ? `${incompleteCount} 人配置未齐，金额待核实`
            : `${allLines.length} 人待结算 · ${selectedMonth}`
        "
      />
      <BusinessStatCard
        label="所选月份累计已发放"
        :value="monthReady ? money(paidTotal) : '—'"
        icon="ri:checkbox-circle-line"
        tone="success"
        :description="`${snapshots.length} 次发放记录 · 保存原始金额快照`"
      />
      <BusinessStatCard
        label="工资配置状态"
        :value="monthReady ? (incompleteCount ? `${incompleteCount} 人待补齐` : '配置完整') : '—'"
        icon="ri:settings-3-line"
        :tone="incompleteCount ? 'warning' : 'success'"
        :description="
          incompleteCount
            ? '底薪或提成未配置，暂不能登记月结'
            : snapshots.length
              ? '已发金额保留，后续变化按差额结算'
              : '核实工资后登记实际发放'
        "
      />
    </div>
    <ArtSearchBar v-model="search" :items="searchItems" @search="applySearch" @reset="resetSearch"
      ><template #month
        ><ElDatePicker
          v-model="selectedMonth"
          type="month"
          value-format="YYYY-MM"
          :clearable="false"
          :disabled="saving" /></template
    ></ArtSearchBar>
    <ElAlert
      class="mb-5"
      title="提成按订单完成月份计提；已发提成产生的退款差额在退款当月扣回。金额、比例留空表示待配置，配置未齐阻止月结。"
      type="info"
      :closable="false"
      show-icon
    />
    <ElAlert
      v-if="can('salary.manage') && !can('salary.all')"
      class="mb-5"
      title="当前仅可查看本人工资。全员月结登记需要全员工资查看权限，请由有权限的财务核实后处理。"
      type="warning"
      :closable="false"
      show-icon
    />
    <ElCard shadow="never">
      <ElTabs v-model="tab" :before-leave="() => !saving">
        <ElTabPane
          :label="
            snapshots.length ? '待结算工资差额' : can('salary.all') ? '全员工资核算' : '本人工资'
          "
          name="payroll"
          :disabled="saving"
        />
        <ElTabPane label="发放快照" name="history" :disabled="saving" />
        <ElTabPane v-if="can('salary.manage')" label="工资方案" name="plans" :disabled="saving" />
      </ElTabs>
      <template v-if="tab === 'payroll'">
        <ArtTableHeader
          v-model:columns="payrollColumns.columnChecks.value"
          :loading="loading"
          @refresh="reloadMonth"
        >
          <template #left>
            <ElSpace wrap
              ><ElTag effect="plain">{{ data?.reports.month || selectedMonth }}</ElTag>
              <ElButton
                v-if="can('salary.manage') && can('salary.all')"
                type="primary"
                :loading="saving"
                :disabled="!canSettle"
                @click="pay"
                >{{ snapshots.length ? '登记全员差额已结算' : '登记全员月结已发放' }}</ElButton
              >
            </ElSpace>
          </template>
        </ArtTableHeader>
        <ArtTable
          :data="payrollTable.tableData.value"
          :columns="payrollColumns.columns.value"
          :loading="loading"
          :pagination="payrollTable.pagination"
          height="460"
          empty-height="260px"
          :empty-text="
            snapshots.length ? '本月工资已发放，没有待结算差额' : '当前月份暂无可见工资数据'
          "
          @pagination:size-change="payrollTable.handleSizeChange"
          @pagination:current-change="payrollTable.handleCurrentChange"
        >
          <template #role="{ row }">{{ roleLabels[row.role as Role] }}</template>
          <template #base="{ row }">{{ money(row.base) }}</template>
          <template #commission="{ row }">{{ money(row.commission) }}</template>
          <template #deduction="{ row }">{{ money(row.deduction) }}</template>
          <template #total="{ row }"
            ><strong>{{ money(row.total) }}</strong></template
          >
          <template #incomplete="{ row }"
            ><ElTag :type="row.incomplete ? 'warning' : 'success'">{{
              row.incomplete ? '配置未齐' : '可结算'
            }}</ElTag></template
          >
        </ArtTable>
        <p class="text-g-500 mt-4"
          >{{
            can('salary.all')
              ? '客服工资纳入财务核算，其本人账号不开放工资查看。'
              : '仅展示当前账号的工资数据。'
          }}
          发放记录保存后不会重复发放，后续差额单独结算。</p
        >
      </template>
      <template v-else-if="tab === 'history'">
        <ArtTableHeader
          v-model:columns="historyColumns.columnChecks.value"
          :loading="loading"
          @refresh="reloadMonth"
          ><template #left
            ><ElTag effect="plain">{{ selectedMonth }} 发放历史</ElTag></template
          ></ArtTableHeader
        >
        <ArtTable
          :data="historyTable.tableData.value"
          :columns="historyColumns.columns.value"
          :loading="loading"
          :pagination="historyTable.pagination"
          height="460"
          empty-height="260px"
          empty-text="该月尚未登记工资发放"
          @pagination:size-change="historyTable.handleSizeChange"
          @pagination:current-change="historyTable.handleCurrentChange"
        >
          <template #paidAt="{ row }">{{ formatTime(row.paidAt) }}</template>
          <template #paidBy="{ row }">{{ personName(row.paidBy) }}</template>
          <template #total="{ row }">{{ snapshotTotal(row) }}</template>
          <template #actions="{ row }"
            ><ElButton link type="primary" @click="snapshot = row">查看发放明细</ElButton></template
          >
        </ArtTable>
        <p class="text-g-500 mt-4"
          >快照保留当次实际发放金额，后续退款或新增完成订单不改写历史记录。</p
        >
      </template>
      <template v-else-if="tab === 'plans' && can('salary.manage')">
        <ArtTableHeader
          v-model:columns="planColumns.columnChecks.value"
          :loading="loading"
          @refresh="reloadMonth"
          ><template #left
            ><ElButton type="primary" :disabled="saving" @click="editPlan()"
              ><ArtSvgIcon icon="ri:add-line" class="mr-1" />新增工资方案</ElButton
            ></template
          ></ArtTableHeader
        >
        <ArtTable
          :data="planTable.tableData.value"
          :columns="planColumns.columns.value"
          :loading="loading"
          :pagination="planTable.pagination"
          height="460"
          empty-height="260px"
          @pagination:size-change="planTable.handleSizeChange"
          @pagination:current-change="planTable.handleCurrentChange"
        >
          <template #userId="{ row }">{{ personName(row.userId) }}</template>
          <template #mode="{ row }">{{ modeLabels[row.mode as SalaryPlan['mode']] }}</template>
          <template #base="{ row }">{{
            row.mode === 'commission' ? '不适用' : money(row.base)
          }}</template>
          <template #rate="{ row }">{{ rateSummary(row) }}</template>
          <template #actions="{ row }"
            ><ElButton link type="primary" :disabled="saving" @click="editPlan(row)"
              >编辑方案</ElButton
            ></template
          >
        </ArtTable>
      </template>
    </ElCard>
    <ElDialog
      v-model="planOpen"
      title="工资方案配置"
      width="min(600px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      destroy-on-close
    >
      <ElForm label-position="top" :disabled="saving" @submit.prevent="savePlan">
        <ElFormItem label="员工" required
          ><ElSelect v-model="plan.userId" :disabled="!!plan.id" filterable class="w-full"
            ><ElOption
              v-for="item in staff"
              :key="item.id"
              :value="item.id"
              :label="`${item.name} · ${roleLabels[item.role]}`" /></ElSelect
        ></ElFormItem>
        <ElFormItem label="工资模式"
          ><ElSelect v-model="plan.mode" class="w-full"
            ><ElOption
              v-for="(label, key) in modeLabels"
              :key="key"
              :label="label"
              :value="key" /></ElSelect
        ></ElFormItem>
        <ElFormItem v-if="plan.mode !== 'commission'" label="底薪 / 固定工资（元）"
          ><BusinessAmount v-model="plan.base"
        /></ElFormItem>
        <template v-if="plan.mode !== 'fixed'">
          <template v-if="planRole === 'operations'"
            ><ElFormItem
              v-for="item in participating"
              :key="item.id"
              :label="`${item.name} 运营提成（%）`"
              ><BusinessAmount
                :model-value="plan.platformRates[item.id] ?? null"
                @update:model-value="plan.platformRates[item.id] = $event" /></ElFormItem
          ></template>
          <ElFormItem v-else label="客服提成比例（%）"
            ><BusinessAmount v-model="plan.rate"
          /></ElFormItem>
        </template>
        <ElFormItem label="生效日期" required
          ><ElDatePicker
            v-model="plan.effectiveFrom"
            type="date"
            value-format="YYYY-MM-DD"
            class="!w-full"
        /></ElFormItem>
        <ElAlert
          title="金额或比例可留空待配置。按工时计薪暂未启用，考勤不会自动产生工资扣款。"
          type="info"
          :closable="false"
        />
      </ElForm>
      <template #footer
        ><ElButton :disabled="saving" @click="planOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="savePlan">保存方案</ElButton></template
      >
    </ElDialog>
    <ElDialog
      :model-value="!!snapshot"
      :title="`${snapshot?.month || ''} 工资发放快照`"
      width="min(960px, 94vw)"
      @close="snapshot = null"
    >
      <ArtTable
        :data="snapshotLines"
        :columns="snapshotColumns.columns.value"
        height="390"
        empty-height="240px"
        :show-table-header="false"
      >
        <template #base="{ row }">{{ money(row.base) }}</template
        ><template #commission="{ row }">{{ money(row.commission) }}</template
        ><template #deduction="{ row }">{{ money(row.deduction) }}</template
        ><template #total="{ row }"
          ><strong>{{ money(row.total) }}</strong></template
        >
      </ArtTable>
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { formatTime, money, roleLabels, useStudio } from '@/hooks/business/useStudio'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import type { Payroll, PayrollLine, Role, SalaryPlan } from '@/types/studio'
  import { useFinanceActions } from '../modules/useFinanceActions'

  defineOptions({ name: 'Salary' })
  const { data, user, can, loading, error, selectedMonth, refresh } = useStudio()
  const { saving, submit } = useFinanceActions()
  const route = useRoute()
  const router = useRouter()
  const tab = ref('payroll')
  const appliedKeyword = ref('')
  const search = ref({ keyword: '' })
  const searchItems = [
    {
      key: 'month',
      label: '核算月份',
      type: 'date',
      props: { type: 'month', valueFormat: 'YYYY-MM', clearable: false }
    },
    {
      key: 'keyword',
      label: '员工姓名',
      type: 'input',
      props: { placeholder: '查询员工', clearable: true }
    }
  ]
  const staff = computed(() => (data.value?.users || []).filter((row) => row.role !== 'player'))
  const visibleLine = (row: PayrollLine) => can('salary.all') || row.userId === user.value?.id
  const snapshots = computed(() =>
    (data.value?.payrolls || []).filter((row) => row.month === selectedMonth.value)
  )
  const allLines = computed(() => {
    const visible = (data.value?.reports.payroll || []).filter(visibleLine)
    const paidCount = snapshots.value.reduce(
      (sum, row) => sum + row.lines.filter(visibleLine).length,
      0
    )
    return visible.slice(paidCount)
  })
  const lines = computed(() =>
    allLines.value.filter((row) => !appliedKeyword.value || row.name.includes(appliedKeyword.value))
  )
  const plans = computed(() =>
    (data.value?.salaryPlans || []).filter(
      (row) =>
        (can('salary.all') || row.userId === user.value?.id) &&
        (!appliedKeyword.value || personName(row.userId).includes(appliedKeyword.value))
    )
  )
  const snapshot = ref<Payroll | null>(null)
  const snapshotLines = computed(() => (snapshot.value?.lines || []).filter(visibleLine))
  const monthReady = computed(
    () =>
      !!data.value &&
      !loading.value &&
      !error.value &&
      data.value.reports.month === selectedMonth.value
  )
  const incompleteCount = computed(() => allLines.value.filter((row) => row.incomplete).length)
  const pendingTotal = computed(() =>
    allLines.value.some((row) => row.total == null)
      ? null
      : allLines.value.reduce((sum, row) => sum + (row.total ?? 0), 0)
  )
  const paidLines = computed(() => snapshots.value.flatMap((row) => row.lines.filter(visibleLine)))
  const paidTotal = computed(() =>
    paidLines.value.some((row) => row.total == null)
      ? null
      : paidLines.value.reduce((sum, row) => sum + (row.total ?? 0), 0)
  )
  const canSettle = computed(
    () =>
      can('salary.manage') &&
      can('salary.all') &&
      !loading.value &&
      !error.value &&
      data.value?.reports.month === selectedMonth.value &&
      allLines.value.length > 0 &&
      !allLines.value.some((row) => row.incomplete)
  )
  const payrollTable = useBusinessTable(lines)
  const historyTable = useBusinessTable(snapshots)
  const planTable = useBusinessTable(plans)
  const payrollColumns = useTableColumns<PayrollLine>(() => [
    { prop: 'name', label: '员工', minWidth: 125 },
    { prop: 'role', label: '角色', minWidth: 120, useSlot: true },
    { prop: 'base', label: '底薪', minWidth: 130, useSlot: true },
    { prop: 'commission', label: '当月提成', minWidth: 130, useSlot: true },
    { prop: 'deduction', label: '退款提成扣回', minWidth: 150, useSlot: true },
    { prop: 'total', label: '应发合计', minWidth: 140, useSlot: true },
    { prop: 'incomplete', label: '核算状态', minWidth: 110, useSlot: true }
  ])
  const historyColumns = useTableColumns<Payroll>(() => [
    { prop: 'month', label: '所属月份', minWidth: 140 },
    { prop: 'paidAt', label: '发放登记时间', minWidth: 190, useSlot: true },
    { prop: 'paidBy', label: '经办人', minWidth: 130, useSlot: true },
    { prop: 'total', label: '实发合计', minWidth: 145, useSlot: true },
    { prop: 'actions', label: '操作', width: 150, fixed: 'right', useSlot: true }
  ])
  const planColumns = useTableColumns<SalaryPlan>(() => [
    { prop: 'userId', label: '员工', minWidth: 130, useSlot: true },
    { prop: 'mode', label: '工资模式', minWidth: 150, useSlot: true },
    { prop: 'base', label: '底薪 / 固定工资', minWidth: 155, useSlot: true },
    { prop: 'rate', label: '提成比例', minWidth: 260, useSlot: true, showOverflowTooltip: true },
    { prop: 'effectiveFrom', label: '生效日期', minWidth: 140 },
    { prop: 'actions', label: '操作', width: 120, fixed: 'right', useSlot: true }
  ])
  const snapshotColumns = useTableColumns<PayrollLine>(() => [
    { prop: 'name', label: '员工', minWidth: 130 },
    { prop: 'base', label: '底薪', minWidth: 130, useSlot: true },
    { prop: 'commission', label: '提成', minWidth: 130, useSlot: true },
    { prop: 'deduction', label: '退款提成扣回', minWidth: 155, useSlot: true },
    { prop: 'total', label: '实发合计', minWidth: 140, useSlot: true }
  ])
  const planOpen = ref(false)
  const plan = reactive<{
    id?: string
    userId: string
    mode: SalaryPlan['mode']
    base: number | null
    rate: number | null
    platformRates: Record<string, number | null>
    effectiveFrom: string
    hourlyEnabled: boolean
  }>({
    userId: '',
    mode: 'base_commission',
    base: null,
    rate: null,
    platformRates: {},
    effectiveFrom: '',
    hourlyEnabled: false
  })
  const planRole = computed(() => staff.value.find((row) => row.id === plan.userId)?.role)
  const modeLabels = { base_commission: '底薪 + 提成', commission: '纯提成', fixed: '固定工资' }
  const participating = computed(() =>
    (data.value?.platforms || []).filter((row) => row.operatorCommission)
  )
  function personName(id: string) {
    return data.value?.users.find((row) => row.id === id)?.name || id
  }
  function snapshotTotal(row: Payroll) {
    const visible = row.lines.filter(visibleLine)
    return visible.some((line) => line.total == null)
      ? '待配置'
      : money(visible.reduce((sum, line) => sum + (line.total || 0), 0))
  }
  function rateSummary(row: SalaryPlan) {
    if (row.mode === 'fixed') return '不适用'
    if (staff.value.find((item) => item.id === row.userId)?.role === 'operations')
      return (
        participating.value
          .map(
            (item) =>
              `${item.name} ${row.platformRates[item.id] == null ? '待配置' : (row.platformRates[item.id]! / 100).toFixed(2) + '%'}`
          )
          .join(' / ') || '无参与平台'
      )
    return row.rate == null ? '待配置' : `${(row.rate / 100).toFixed(2)}%`
  }
  async function reloadMonth() {
    try {
      await refresh(selectedMonth.value)
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '查询失败')
    }
  }
  function applySearch() {
    appliedKeyword.value = search.value.keyword || ''
    payrollTable.resetPage()
    planTable.resetPage()
    void reloadMonth()
  }
  function resetSearch() {
    search.value = { keyword: '' }
    applySearch()
  }
  watch(selectedMonth, () => {
    payrollTable.resetPage()
    historyTable.resetPage()
    if (route.path === '/finance/salary') void reloadMonth()
  })
  watch(
    () => can('salary.manage'),
    (allowed) => {
      if (!allowed && tab.value === 'plans') tab.value = 'payroll'
    }
  )
  const allowedTabs = computed(() => [
    'payroll',
    'history',
    ...(can('salary.manage') ? ['plans'] : [])
  ])
  watch(
    () => (data.value ? route.fullPath : ''),
    () => {
      if (route.path !== '/finance/salary' || !data.value) return
      const value = route.query.tab
      if (saving.value) return syncTabQuery(tab.value)
      const requested = typeof value === 'string' ? value : ''
      if (allowedTabs.value.includes(requested)) tab.value = requested
      syncTabQuery(tab.value)
    },
    { immediate: true }
  )
  watch(tab, syncTabQuery)
  function syncTabQuery(value: string) {
    if (route.path !== '/finance/salary') return
    if (route.query.tab !== value) void router.replace({ query: { ...route.query, tab: value } })
  }
  function exportCurrent() {
    if (saving.value) return
    const modules =
      tab.value === 'history' ? 'payrollHistory' : tab.value === 'plans' ? 'salaryPlans' : 'payroll'
    void router.push({ path: '/reports/export', query: { modules } })
  }
  function editPlan(row?: SalaryPlan) {
    if (saving.value) return
    Object.assign(
      plan,
      {
        id: undefined,
        userId: '',
        mode: 'base_commission',
        base: null,
        rate: null,
        platformRates: {},
        effectiveFrom: `${selectedMonth.value}-01`,
        hourlyEnabled: false
      },
      row || {}
    )
    plan.platformRates = Object.fromEntries(
      (data.value?.platforms || []).map((item) => [item.id, row?.platformRates[item.id] ?? null])
    )
    planOpen.value = true
  }
  async function savePlan() {
    if (!plan.userId || !plan.effectiveFrom) return void ElMessage.warning('请选择员工和生效日期')
    if (
      (plan.rate != null && plan.rate > 10000) ||
      Object.values(plan.platformRates).some((value) => value != null && value > 10000)
    )
      return void ElMessage.warning('提成比例不能超过 100%')
    if (
      await submit(
        '/salary-plans',
        { ...plan, platformRates: { ...plan.platformRates } },
        '工资方案已保存'
      )
    )
      planOpen.value = false
  }
  async function pay() {
    if (!canSettle.value) return void ElMessage.warning('请等待当前月份核算完成并补齐工资配置')
    const month = selectedMonth.value
    try {
      await ElMessageBox.confirm(
        snapshots.value.length
          ? `确认 ${month} 新产生的工资差额已由财务结算？本次不会重复发放已结算金额。`
          : `确认 ${month} 工资已实际发放？系统将保存本次金额及提成快照，后续退款差额另记扣回。`,
        snapshots.value.length ? '工资差额补结算' : '月结工资发放',
        { confirmButtonText: '确认已结算', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return
    }
    if (month !== selectedMonth.value || !canSettle.value)
      return void ElMessage.warning('核算月份或数据已变化，请重新确认')
    await submit('/payrolls', { month }, '工资发放快照已保存')
  }
</script>

<style scoped>
  .salary-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
    margin-bottom: 20px;
  }

  @media (width <= 900px) {
    .salary-stats {
      grid-template-columns: 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }
  }
</style>
