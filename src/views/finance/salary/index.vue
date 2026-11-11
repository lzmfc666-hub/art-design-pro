<template>
  <div class="salary-page">
    <BusinessPageHeader
      title="工资与提成"
      description="按核算月份查看工资、核对发放快照，让新增提成和退款差额单独结算。"
      icon="ri:money-cny-circle-line"
      :badge="can('salary.all') ? '全员工资核算' : '本人工资'"
    >
      <template #actions>
        <ElButton
          v-if="can('reports.export')"
          type="primary"
          plain
          :disabled="saving"
          @click="exportCurrent"
        >
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
          <template #actions="{ row }"
            ><ElButton link type="primary" @click="lineDetailId = row.userId"
              >查看核算明细</ElButton
            ></template
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
            ><ElButton link type="primary" @click="snapshotId = row.id"
              >查看发放明细</ElButton
            ></template
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
            ><ElButton link type="primary" @click="planDetailId = row.id">查看详情</ElButton
            ><ElButton link type="primary" :disabled="saving" @click="editPlan(row)"
              >编辑方案</ElButton
            ></template
          >
        </ArtTable>
      </template>
    </ElCard>
    <BusinessDetailPanel
      page-key="salary-calculation-details"
      :record-id="lineDetailId ? selectedMonth + ':' + lineDetailId : undefined"
      @restore="queueRestore('line', $event)"
      :restore-error="restoreError"
      :model-value="!!lineDetailId"
      title="工资核算明细"
      @update:model-value="!$event && !saving && (lineDetailId = '')"
      @close="lineDetailId = ''"
    >
      <template v-if="lineDetail">
        <BusinessDetailHeader
          :title="lineDetail.name"
          description="查看所选月份当前待结算的工资或差额，金额以本次核算结果为准。"
          icon="ri:money-cny-circle-line"
          :badge="lineDetail.incomplete ? '配置未齐' : '可结算'"
          :context="selectedMonth + ' · ' + roleLabels[lineDetail.role]"
        />
        <BusinessDetailSummary
          :items="[
            { label: '底薪', value: money(lineDetail.base) },
            { label: '当月提成', value: money(lineDetail.commission) },
            {
              label: '退款提成扣回',
              value: money(lineDetail.deduction),
              hint: '按现有退款月份口径'
            },
            {
              label: '应发合计',
              value: money(lineDetail.total),
              tone: 'primary',
              hint: lineDetail.incomplete ? '配置未齐，不能登记月结' : '以核算结果登记实际发放'
            }
          ]"
        />
        <BusinessDetailSection
          title="核算口径"
          description="提成按订单完成月份计提；已发提成的退款差额在退款当月扣回。"
        >
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem label="核算月份">{{ selectedMonth }}</ElDescriptionsItem
            ><ElDescriptionsItem label="可见范围">{{
              can('salary.all') ? '当前账号允许查看全员工资' : '仅本人工资'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="发放处理"
              >已发快照保留，新增差额另行结算；考勤不会自动扣款。</ElDescriptionsItem
            ></ElDescriptions
          >
        </BusinessDetailSection> </template
      ><ElEmpty v-else description="当前月份没有可读取的核算明细，请刷新后查看" />
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="salary-plan-details"
      :record-id="planDetailId || undefined"
      @restore="queueRestore('plan-detail', $event)"
      :restore-error="restoreError"
      :model-value="!!planDetailId"
      title="工资方案详情"
      @update:model-value="!$event && !saving && (planDetailId = '')"
      @close="planDetailId = ''"
    >
      <template v-if="planDetail">
        <BusinessDetailHeader
          :title="personName(planDetail.userId)"
          description="查看生效日期、工资模式与现有比例；历史发放快照不会随方案编辑改写。"
          icon="ri:settings-3-line"
          :badge="modeLabels[planDetail.mode]"
          :context="planDetail.id"
        />
        <BusinessDetailSummary
          :items="[
            { label: '生效日期', value: planDetail.effectiveFrom },
            { label: '工资模式', value: modeLabels[planDetail.mode] },
            {
              label: '底薪 / 固定工资',
              value: planDetail.mode === 'commission' ? '不适用' : money(planDetail.base),
              tone: 'primary'
            },
            { label: '工时计薪', value: '暂未启用' }
          ]"
        />
        <BusinessDetailSection
          title="提成配置"
          description="金额或比例留空表示待配置，0 表示不计提。"
          ><ElDescriptions :column="1" border
            ><ElDescriptionsItem label="现有比例">{{
              rateSummary(planDetail)
            }}</ElDescriptionsItem></ElDescriptions
          ></BusinessDetailSection
        > </template
      ><ElEmpty v-else description="当前账号没有可读取的工资方案" />
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="salary-plan-editor"
      :record-id="plan.id || undefined"
      @restore="queueRestore('plan-edit', $event)"
      :restore-error="restoreError"
      v-model="planOpen"
      title="工资方案配置"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      destroy-on-close
    >
      <BusinessDetailHeader
        :title="plan.userId ? personName(plan.userId) : '选择员工'"
        description="维护原工资方案与生效日期。历史发放金额继续保留，后续核算按现有规则生成差额。"
        icon="ri:settings-3-line"
        :badge="plan.id ? '编辑方案' : '新增方案'"
      />
      <BusinessDetailSummary
        :items="[
          { label: '工资模式', value: modeLabels[plan.mode] },
          {
            label: '底薪 / 固定工资',
            value: plan.mode === 'commission' ? '不适用' : money(plan.base)
          },
          { label: '生效日期', value: plan.effectiveFrom || '待选择' }
        ]"
      />
      <BusinessDetailSection
        title="员工、金额与比例"
        description="填写已确认的工资配置；未确定的金额或比例保持留空。"
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
      </BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving" @click="planOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="savePlan">保存方案</ElButton></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="salary-paid-snapshot"
      :record-id="snapshotId || undefined"
      @restore="queueRestore('snapshot', $event)"
      :restore-error="restoreError"
      :model-value="!!snapshot"
      :title="`${snapshot?.month || ''} 工资发放快照`"
      @update:model-value="!$event && !saving && (snapshotId = '')"
      @close="snapshotId = ''"
    >
      <template v-if="snapshot">
        <BusinessDetailHeader
          :title="snapshot.month + ' 工资发放记录'"
          description="以下保存当次已登记发放的金额，不随退款或新完成订单改写。"
          icon="ri:file-list-3-line"
          badge="已发放快照"
          :context="snapshot.id"
        />
        <BusinessDetailSummary
          :items="[
            {
              label: '可见实发合计',
              value: snapshotTotal(snapshot),
              tone: 'primary',
              hint: can('salary.all') ? '本快照可见全员合计' : '仅本账号可见工资'
            },
            { label: '可见员工', value: snapshotLines.length + ' 人' },
            { label: '发放登记时间', value: formatTime(snapshot.paidAt) },
            { label: '经办人', value: personName(snapshot.paidBy) }
          ]"
        />
        <BusinessDetailSection
          title="原始发放明细"
          description="明细分页只改变展示范围，不改变本次快照金额。"
        >
          <ArtTable
            :data="snapshotTable.tableData.value"
            :columns="snapshotColumns.columns.value"
            height="390"
            empty-height="240px"
            :show-table-header="false"
            :pagination="snapshotTable.pagination"
            @pagination:size-change="snapshotTable.handleSizeChange"
            @pagination:current-change="snapshotTable.handleCurrentChange"
          >
            <template #base="{ row }">{{ money(row.base) }}</template
            ><template #commission="{ row }">{{ money(row.commission) }}</template
            ><template #deduction="{ row }">{{ money(row.deduction) }}</template
            ><template #total="{ row }"
              ><strong>{{ money(row.total) }}</strong></template
            >
          </ArtTable>
        </BusinessDetailSection> </template
      ><ElEmpty v-else description="当前账号没有可读取的发放快照" />
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, onActivated, onMounted, reactive, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { formatTime, money, roleLabels, useStudio } from '@/hooks/business/useStudio'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import type { Payroll, PayrollLine, Role, SalaryPlan } from '@/types/studio'
  import { useFinanceActions } from '../modules/useFinanceActions'
  import { businessConfirmMessage } from '@/utils/business/confirm-message'

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
  const snapshotId = ref('')
  const snapshot = computed(
    () => data.value?.payrolls.find((row) => row.id === snapshotId.value) || null
  )
  const snapshotLines = computed(() => (snapshot.value?.lines || []).filter(visibleLine))
  const snapshotTable = useBusinessTable(snapshotLines)
  const lineDetailId = ref('')
  const lineDetail = computed(() => allLines.value.find((row) => row.userId === lineDetailId.value))
  const planDetailId = ref('')
  const planDetail = computed(() => plans.value.find((row) => row.id === planDetailId.value))
  watch(snapshotId, () => snapshotTable.resetPage())
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
    { prop: 'incomplete', label: '核算状态', minWidth: 110, useSlot: true },
    { prop: 'actions', label: '明细', width: 150, fixed: 'right', useSlot: true }
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
    { prop: 'actions', label: '操作', width: 200, fixed: 'right', useSlot: true }
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
    (data.value?.platforms || []).filter((row) => row.id !== 'hall' && row.name !== '游戏大厅')
  )
  const restoreError = ref('')
  const pendingRestore = ref<{
    kind: 'line' | 'plan-detail' | 'plan-edit' | 'snapshot'
    recordId?: string
    isCurrent?: () => boolean
  } | null>(null)
  function queueRestore(
    kind: 'line' | 'plan-detail' | 'plan-edit' | 'snapshot',
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
    if (!pendingRestore.value || loading.value || saving.value || !data.value) return
    const request = pendingRestore.value
    if (!(can('salary.view') || can('salary.all'))) {
      pendingRestore.value = null
      restoreError.value = '当前账号没有工资查看权限，请返回工资列表。'
      return
    }
    if (request.kind === 'line') {
      const match = /^(\d{4}-(?:0[1-9]|1[0-2])):(.+)$/.exec(request.recordId || '')
      if (!match) {
        pendingRestore.value = null
        restoreError.value = '核算记录标识无效，请返回工资列表重新选择月份。'
        return
      }
      if (selectedMonth.value !== match[1]) {
        selectedMonth.value = match[1]
        return
      }
      if (data.value.reports.month !== match[1]) {
        if (error.value) {
          pendingRestore.value = null
          restoreError.value = '当前月份核算读取失败，请返回工资列表重新选择月份后核对。'
        }
        return
      }
      pendingRestore.value = null
      const row = allLines.value.find((item) => item.userId === match[2])
      if (row) lineDetailId.value = row.userId
      else restoreError.value = '当前月份没有这条可读取的待结算明细，请返回工资列表核对。'
      return
    }
    pendingRestore.value = null
    if (request.kind === 'snapshot') {
      const row = data.value.payrolls.find((item) => item.id === request.recordId)
      if (row) snapshotId.value = row.id
      else restoreError.value = '当前账号没有可读取的发放快照，请返回工资历史列表。'
      return
    }
    if (request.kind === 'plan-edit' && !can('salary.manage')) {
      restoreError.value = '当前账号没有工资方案管理权限，请返回工资列表。'
      return
    }
    if (request.kind === 'plan-edit' && !request.recordId) return editPlan()
    const row = data.value.salaryPlans.find(
      (item) =>
        item.id === request.recordId && (can('salary.all') || item.userId === user.value?.id)
    )
    if (!row) restoreError.value = '当前账号没有可读取的工资方案，请返回方案列表。'
    else if (request.kind === 'plan-detail') planDetailId.value = row.id
    else editPlan(row)
  }
  watch([data, loading, saving, selectedMonth, error], resumeRestore)
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
  function refreshActiveSalary() {
    if (
      route.path === '/finance/salary' &&
      !saving.value &&
      (can('salary.view') || can('salary.all'))
    )
      void reloadMonth()
  }
  let firstActivation = true
  onMounted(refreshActiveSalary)
  onActivated(() => {
    if (firstActivation) {
      firstActivation = false
      return
    }
    refreshActiveSalary()
  })
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
    if (!can('reports.export')) return
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
        businessConfirmMessage(
          snapshots.value.length
            ? `确认 ${month} 新产生的工资差额已由财务结算？本次不会重复发放已结算金额。`
            : `确认 ${month} 工资已实际发放？系统将保存本次金额及提成快照，后续退款差额另记扣回。`,
          [
            { label: '核算月份', value: month },
            {
              label: snapshots.value.length ? '本次待结算差额' : '本次待结算工资',
              value: money(pendingTotal.value)
            },
            { label: '待结算员工', value: allLines.value.length + ' 人' },
            { label: '本月累计已发放', value: money(paidTotal.value) },
            { label: '本月原发放快照', value: snapshots.value.length + ' 次' }
          ],
          '摘要使用当前完整授权核算结果，分页和姓名筛选不改变待结金额；原发放快照继续保留。'
        ),
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
