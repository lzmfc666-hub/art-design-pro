<template>
  <section class="overview-metrics">
    <div v-if="cards.length" class="overview-metrics-grid">
      <OverviewMetricCard
        v-for="card in cards"
        :key="privacyKey + card.id"
        :title="card.title"
        :subtitle="card.subtitle"
        :value="card.value"
        :icon="card.icon"
        :color="card.color"
        :trend="card.trend"
        :points="card.points"
        :chart="card.chart"
        :details="card.details"
        :sensitive="card.sensitive"
        :loading="loading"
        :href="card.href"
        @details="openDetails(card.id)"
      />
    </div>
    <ElSkeleton v-else-if="loading" :rows="4" animated class="overview-loading" />
    <div v-else class="overview-empty"
      ><ArtSvgIcon icon="ri:bar-chart-box-line" /><span>{{
        report
          ? '当前账号暂无可见的统计数据，可从上方业务入口开始工作。'
          : '概览尚未加载，请刷新后查看。'
      }}</span></div
    >

    <BusinessDetailPanel
      v-model="dialogOpen"
      page-key="overview-metric"
      :record-id="selectedId"
      :restore-error="metricRestoreError"
      @restore="restoreMetric($event)"
      :title="activeCard ? activeCard.title + ' · 统计详情' : '统计详情'"
      width="min(1120px, 96vw)"
      class="business-detail-dialog overview-statistics-detail"
      destroy-on-close
    >
      <template #header="{ titleId }"
        ><div v-if="activeCard" :id="titleId"
          ><BusinessDetailHeader
            :title="`${activeCard.title} · 统计详情`"
            description="查看分类分布、具体记录和原业务统计口径。"
            :icon="activeCard.icon"
            badge="统计与明细" /></div
      ></template>
      <template v-if="activeCard">
        <div class="detail-period"
          ><ArtSvgIcon icon="ri:calendar-2-line" /><span>{{
            activeCard.periodLabel || `${report?.range.start} 至 ${report?.range.end}`
          }}</span
          ><ElTag size="small" effect="plain">{{ activeCard.subtitle }}</ElTag></div
        >
        <div v-if="activeCard.sensitive" class="detail-main-value"
          ><ElButton text @click="detailsRevealed = !detailsRevealed"
            ><ArtSvgIcon :icon="detailMasked ? 'ri:eye-off-line' : 'ri:eye-line'" class="mr-1" />{{
              detailMasked ? '显示金额' : '隐藏金额'
            }}</ElButton
          ></div
        >
        <BusinessDetailSummary
          :items="[
            {
              label: activeCard.title,
              value: detailMasked ? '••••••' : activeCard.value,
              tone: 'primary'
            },
            ...activeCard.details.map((item) => ({
              label: item.label,
              value: detailMasked ? '•••' : item.value
            }))
          ]"
        />
        <OverviewDetailExplorer
          v-if="report && !['salary', 'attendance'].includes(activeCard.id)"
          :key="privacyKey + activeCard.id"
          :metric="activeCard.id"
          :range="report.range"
          :masked="detailMasked"
          @refreshed="emit('refreshed', $event)"
          @navigate="dialogOpen = false"
        />
        <template v-else-if="!detailMasked && activeCard.id === 'salary'">
          <BusinessDetailSection
            title="本人月度核算明细"
            :description="`${data?.reports.month} 的原工资核算行；已发金额和待补差额按原模块区分，不按当前日期拆分。`"
          >
            <ElTable :data="salaryDetailLines" border
              ><ElTableColumn prop="name" label="员工" min-width="100" /><ElTableColumn
                label="底薪"
                min-width="120"
                ><template #default="{ row }">{{ money(row.base) }}</template></ElTableColumn
              ><ElTableColumn label="提成" min-width="120"
                ><template #default="{ row }">{{ money(row.commission) }}</template></ElTableColumn
              ><ElTableColumn label="扣回差额" min-width="120"
                ><template #default="{ row }">{{ money(row.deduction) }}</template></ElTableColumn
              ><ElTableColumn label="合计" min-width="120"
                ><template #default="{ row }">{{ money(row.total) }}</template></ElTableColumn
              ><ElTableColumn label="核算状态" min-width="120"
                ><template #default="{ row }">{{
                  row.incomplete ? '配置未齐' : '完整'
                }}</template></ElTableColumn
              ></ElTable
            >
          </BusinessDetailSection>
          <BusinessDetailSection
            title="本人已发放快照"
            description="保留原批次和发放金额，查看不产生重新发放或结算。"
            ><ElTable :data="salaryPaidLines" border
              ><ElTableColumn label="发放时间" min-width="180"
                ><template #default="{ row }">{{ formatTime(row.paidAt) }}</template></ElTableColumn
              ><ElTableColumn label="发放合计" min-width="120"
                ><template #default="{ row }">{{ money(row.total) }}</template></ElTableColumn
              ><ElTableColumn
                prop="payrollId"
                label="原批次编号"
                min-width="220"
                show-overflow-tooltip /></ElTable
          ></BusinessDetailSection>
        </template>
        <BusinessDetailSection
          v-else-if="activeCard.id === 'attendance'"
          title="本人选期考勤记录"
          description="仅本人已登记记录；班次计划与实际到岗分开，未登记不补造工时。"
          ><ElTable :data="attendanceDetailRows" border
            ><ElTableColumn prop="date" label="班次日期" min-width="120" /><ElTableColumn
              prop="start"
              label="开始"
              min-width="100" /><ElTableColumn
              prop="end"
              label="结束"
              min-width="100" /><ElTableColumn label="登记状态" min-width="120"
              ><template #default="{ row }">{{
                attendanceLabels[row.status] || row.status
              }}</template></ElTableColumn
            ><ElTableColumn prop="actualHours" label="人工登记工时" min-width="140" /><ElTableColumn
              prop="remark"
              label="本人考勤说明"
              min-width="220"
              show-overflow-tooltip /></ElTable
        ></BusinessDetailSection>
        <section class="detail-notes"
          ><h4><ArtSvgIcon icon="ri:information-line" />统计口径</h4
          ><p v-for="(note, index) in activeCard.notes" :key="index">{{ note }}</p></section
        >
        <p v-if="report" class="detail-updated">数据读取于 {{ formatTime(report.generatedAt) }}</p>
      </template>
      <template #footer
        ><ElButton @click="dialogOpen = false">关闭</ElButton
        ><ElButton v-if="activeCard?.href" type="primary" @click="goToModule"
          ><ArtSvgIcon icon="ri:arrow-right-up-line" class="mr-1" />进入业务模块</ElButton
        ></template
      >
    </BusinessDetailPanel>
  </section>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import OverviewMetricCard from '@/components/business/OverviewMetricCard.vue'
  import OverviewDetailExplorer from './overview-detail-explorer.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import { formatTime, money, useStudio } from '@/hooks/business/useStudio'
  import type { OverviewDay, OverviewMetrics, OverviewReport } from '@/types/overview'

  interface OverviewCard {
    id: string
    title: string
    subtitle: string
    value: string | number | null
    icon: string
    color: 'blue' | 'purple' | 'orange' | 'green'
    trend?: number | null
    points?: number[]
    chart?: 'line' | 'bar'
    details: { label: string; value: string | number }[]
    sensitive?: boolean
    href?: string
    periodLabel?: string
    notes: string[]
  }

  const props = defineProps<{ report: OverviewReport | null; loading: boolean }>()
  const emit = defineEmits<{ refreshed: [report: OverviewReport] }>()
  const { data, user, can } = useStudio()
  const router = useRouter()
  const permission = (key: string) => Boolean(props.report?.permissions.includes(key) && can(key))
  const privacyKey = computed(
    () =>
      `${user.value?.id || ''}:${props.report?.permissions.join('|') || ''}:${data.value?.permissions.join('|') || ''}:`
  )
  const cash = (value: number | null | undefined) => (value == null ? null : money(value))
  const amountText = (value: number | null | undefined) => cash(value) ?? '待配置'
  const countText = (value: number | null | undefined) =>
    value == null ? '—' : value.toLocaleString('zh-CN')
  const percentText = (value: number | null | undefined) =>
    value == null ? '暂无分母' : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`
  const seriesPoints = (key: keyof OverviewDay): number[] => {
    const values = props.report?.series.map((row) => row[key]) || []
    // 配置未齐的日值不能按零补线，也不跨缺失日连接，整张迷你图保持待核实。
    return values.every((value) => typeof value === 'number' && Number.isFinite(value))
      ? (values as number[])
      : []
  }
  const change = (key: keyof OverviewMetrics) => props.report?.changes[key] ?? null

  const cards = computed<OverviewCard[]>(() => {
    const report = props.report
    if (!report) return []
    const m = report.metrics
    const result: OverviewCard[] = []
    const profitVisible = permission('profit.view')
    const ownPlayerReport =
      user.value?.role === 'player' &&
      !report.permissions.includes('orders.view') &&
      !report.permissions.includes('finance.withdrawals')
    const ordersVisible = permission('orders.view') || ownPlayerReport
    const peopleVisible = ['users.manage', 'attendance.manage', 'salary.all'].some(permission)
    const walletVisible = permission('finance.withdrawals') || ownPlayerReport
    const ordersHref = permission('orders.view') ? '/orders/list' : undefined

    if (profitVisible) {
      result.push({
        id: 'received',
        title: '营业额',
        subtitle: '客户收款 · 未扣退款',
        value: cash(m.received),
        icon: 'ri:money-cny-circle-line',
        color: 'blue',
        trend: change('received'),
        points: seriesPoints('received'),
        href: '/dashboard/analysis',
        details: [
          { label: '净收入', value: amountText(m.net) },
          { label: '累计退款', value: amountText(m.refunds) },
          { label: '付款订单', value: countText(m.orderCount) }
        ],
        notes: [
          '营业额展示客户已收款金额，净收入为客户收款减去累计已退款金额。金额均以人民币元显示。',
          '收款与退款沿用客户原付款日归属；后续退款可能回改原付款日统计。',
          '对比使用紧邻所选区间之前的同长时段。前期为零或数据不完整时，不计算虚构增长率。'
        ]
      })
    } else if (permission('orders.view') && m.personalNet !== null) {
      result.push({
        id: 'personal',
        title: '本人完成业绩',
        subtitle: '按完成日期 · 仅本人归属',
        value: cash(m.personalNet),
        icon: 'ri:line-chart-line',
        color: 'blue',
        trend: change('personalNet'),
        points: seriesPoints('personalNet'),
        href: ordersHref,
        details: [
          { label: '完成订单', value: countText(m.personalCompletedOrders) },
          { label: '统计天数', value: report.range.days },
          { label: '截止日期', value: report.range.end }
        ],
        notes: [
          '仅展示服务器返回的本人完成业绩，不替代全店营业额或经营利润。',
          '按订单完成日期统计净收入；运营使用提成归属，其他员工使用订单创建人归属。',
          '完成业绩扣除该订单累计已退款金额，后续退款可能调整历史业绩。'
        ]
      })
    }

    if (ordersVisible && m.orderCount !== null) {
      result.push({
        id: 'orders',
        title: '订单统计',
        subtitle: '选期已付款订单数量',
        value: m.orderCount,
        icon: 'ri:file-list-3-line',
        color: 'purple',
        trend: change('orderCount'),
        points: seriesPoints('orders'),
        chart: 'bar',
        href: ordersHref,
        details: [
          { label: '创建订单', value: countText(m.createdOrders) },
          { label: '完成订单', value: countText(m.completedOrders) },
          { label: '取消订单', value: countText(m.canceledOrders) }
        ],
        notes: [
          '主指标统计在所选区间付款且已有收款的可见订单。迷你图按付款日期分布。',
          '底部创建、完成、取消分别按各自发生日期统计，不能作为同一批订单的状态比例。',
          '所有订单范围沿用服务器当前账号的数据权限。'
        ]
      })
    }

    if (profitVisible && permission('orders.view') && m.payingCustomers !== null) {
      result.push({
        id: 'customers',
        title: '客户消费',
        subtitle:
          m.averageOrderAmount === null
            ? '暂无付款订单，单均金额不可计算'
            : '单均收款 · 按付款订单统计',
        value: cash(m.averageOrderAmount),
        icon: 'ri:user-heart-line',
        color: 'orange',
        trend: change('averageOrderAmount'),
        points: seriesPoints('payingCustomers'),
        chart: 'bar',
        href:
          permission('orders.create') || permission('users.manage')
            ? '/personnel/customers'
            : ordersHref,
        details: [
          { label: '付费客户', value: countText(m.payingCustomers) },
          { label: '复购客户', value: countText(m.repeatCustomers) },
          { label: '复购率', value: percentText(m.customerRepeatRate) }
        ],
        notes: [
          '主指标为区间客户收款除以区间已付款订单数，不按客户人数计算客单价。迷你柱图展示每日付费客户人数。',
          '付费客户在选期内去重；复购客户指选期内付费且截至选期末的可见付款历史中至少有两笔订单的客户。',
          '没有付费客户时复购率没有有效分母，保持未知，不显示虚构的 0%。'
        ]
      })
    }

    if (profitVisible) {
      const fullMonths =
        report.range.start.endsWith('-01') &&
        new Date(`${report.range.end}T00:00:00Z`).getUTCDate() ===
          new Date(
            Date.UTC(Number(report.range.end.slice(0, 4)), Number(report.range.end.slice(5, 7)), 0)
          ).getUTCDate()
      const finalProfit = fullMonths ? m.fullMonthsProfit : m.periodOperatingProfit
      result.push({
        id: 'profit',
        title: fullMonths ? '经营利润' : '区间经营利润',
        subtitle: m.profitIncomplete
          ? '配置 / 补偿待确认，利润暂不完整'
          : fullMonths
            ? '完整月份 · 已扣月度底薪'
            : '未扣月度底薪，不按天摊分',
        value: cash(finalProfit),
        icon: 'ri:funds-line',
        color: 'green',
        trend: change(fullMonths ? 'fullMonthsProfit' : 'periodOperatingProfit'),
        points: seriesPoints('profit'),
        href: '/dashboard/analysis',
        details: [
          { label: '其他收入', value: amountText(m.otherIncome) },
          { label: '打手成本', value: amountText(m.reward) },
          { label: '预计成本', value: amountText(m.estimatedReward) },
          { label: '月度底薪', value: fullMonths ? amountText(m.monthlyBase) : '本区间未扣' }
        ],
        notes: [
          '区间经营利润为订单净收入加其他收入，再扣打手成本、客服 / 运营提成及费用；订单归属原付款日，其他收入按实际登记日统计。普通日期区间不扣员工底薪。',
          '其他收入仅含非订单客户扣款及离店 / 跑路押金没收。充值、押金缴纳与退还不计收入，订单余额支付只计一次订单收入。',
          '仅月初至月末覆盖完整月份时显示扣底薪后的利润。缺少工资配置或取消补偿未确认时，利润不按零处理。',
          '每日迷你图为未扣底薪的日利润；底部打手成本已包含未验收预计报酬，预计成本是其中一部分，不能重复扣除。',
          '提现发放不会再次扣减经营利润。'
        ]
      })
    }

    if (peopleVisible && (m.staffCount !== null || m.playerCount !== null)) {
      const coverage = report.creationDateCoverage
      const unknown = coverage.staff.unknown + coverage.players.unknown
      result.push({
        id: 'people',
        title: '人员新增',
        subtitle: unknown ? '旧档案缺少建档日期，无法完整追溯' : '区间新建员工与打手档案',
        value: m.newStaff === null || m.newPlayers === null ? null : m.newStaff + m.newPlayers,
        icon: 'ri:user-add-line',
        color: 'blue',
        trend: m.newStaff === null || m.newPlayers === null ? null : undefined,
        href: permission('users.manage')
          ? '/personnel/employees'
          : permission('attendance.manage')
            ? '/personnel/attendance'
            : permission('salary.all')
              ? '/finance/salary'
              : undefined,
        details: [
          { label: '现有员工', value: countText(m.staffCount) },
          { label: '现有打手', value: countText(m.playerCount) },
          { label: '可追溯新增', value: coverage.staff.inRange + coverage.players.inRange }
        ],
        notes: [
          '人员新增合计包含区间内新建的员工与打手，不包含客户档案。',
          `员工档案：${coverage.staff.known} 条有日期、${coverage.staff.unknown} 条缺日期；打手档案：${coverage.players.known} 条有日期、${coverage.players.unknown} 条缺日期。`,
          '任何可见档案缺少建档日期时，总新增人数保持未知；底部只显示有日期且落在选期内的真实新增，不将旧档案记作零新增。',
          '现有员工与现有打手是当前档案快照，不按所选区间回溯。'
        ]
      })
    }

    if (walletVisible && m.playerAvailable !== null && m.playerOccupied !== null) {
      result.push({
        id: 'wallet',
        title: user.value?.role === 'player' ? '本人待付报酬' : '打手待付余额',
        subtitle: '当前可提现 + 在途提现快照',
        value: cash(m.playerAvailable + m.playerOccupied),
        icon: 'ri:wallet-3-line',
        color: 'purple',
        sensitive: true,
        href: permission('finance.withdrawals') ? '/finance/settlement?tab=withdrawals' : undefined,
        periodLabel: '当前余额快照（不按所选日期回溯）',
        details: [
          { label: '可提现', value: amountText(m.playerAvailable) },
          { label: '申请占用', value: amountText(m.playerOccupied) },
          { label: '选期已发放', value: amountText(m.playerPaid) }
        ],
        notes: [
          '待付余额为当前已确认报酬中的可提现金额与在途提现占用之和，是当前快照，不是区间收入。',
          '可提现与申请占用不随日期筛选回溯，不计算区间增长率，也不绘制虚构的历史余额曲线。',
          '选期已发放按实际发放日期统计，与当前余额快照的时间口径不同。',
          user.value?.role === 'player'
            ? '仅显示本人服务器可见的报酬余额。'
            : '仅汇总当前财务权限允许查看的打手余额。'
        ]
      })
    }

    if (ordersVisible && m.playerAccepted !== null) {
      result.push({
        id: 'accepted',
        title: '接单统计',
        subtitle: '区间历史接单次数',
        value: m.playerAccepted,
        icon: 'ri:gamepad-line',
        color: 'orange',
        trend: change('playerAccepted'),
        points: seriesPoints('accepted'),
        chart: 'bar',
        href: ordersHref,
        details: [
          { label: '接单订单', value: countText(m.playerAcceptedOrders) },
          { label: '参与打手', value: countText(m.playerUnique) },
          { label: '完成率', value: percentText(m.playerCompletionRate) }
        ],
        notes: [
          '接单次数按历史接单时间统计；同一订单解除后重新接单会计为多次，不等于订单数量。',
          '接单订单按选期内出现接单记录的订单去重；参与打手按负责人去重。',
          '完成率为选期接单的去重订单中，在区间结束时已完成的比例。无接单订单时不生成 0% 完成率。'
        ]
      })
    }

    if ((profitVisible || permission('finance.expenses')) && m.expenses !== null) {
      result.push({
        id: 'expenses',
        title: '费用统计',
        subtitle: profitVisible ? '费用登记 + 报酬人工净调整' : '按实际发生日期 · 有效费用登记',
        value: cash(m.expenses),
        icon: 'ri:bill-line',
        color: 'green',
        trend: change('expenses'),
        points: seriesPoints('expenses'),
        chart: 'bar',
        href: permission('finance.expenses')
          ? '/finance/settlement?tab=expenses'
          : '/dashboard/analysis',
        details: [
          { label: '日均费用', value: money(m.expenses / report.range.days) },
          { label: '统计天数', value: report.range.days },
          { label: '截止日期', value: report.range.end }
        ],
        notes: [
          profitVisible
            ? '费用原合计包括有效费用登记及报酬人工净调整。关联订单的调整归原付款日，其他调整按登记日；分项不再次相加扣除。'
            : '只累计所选区间内按实际发生日期登记、尚未删除的费用，不是储值、存单或押金业务。',
          '日均费用为区间有效支出除以统计天数，显示金额四舍五入到分；主指标保持实际记录汇总。',
          '费用在经营利润中已经扣除，不因查看本卡重复记账。'
        ]
      })
    }

    if (!profitVisible && permission('salary.view') && data.value && user.value) {
      const month = data.value.reports.month
      const visible = data.value.reports.payroll.filter((row) => row.userId === user.value?.id)
      const snapshots = data.value.payrolls.filter((row) => row.month === month)
      const paid = snapshots.flatMap((row) =>
        row.lines.filter((line) => line.userId === user.value?.id)
      )
      const pending = visible.slice(paid.length)
      if (visible.length || paid.length) {
        const sumLines = (
          rows: typeof visible,
          key: 'base' | 'commission' | 'deduction' | 'total'
        ) =>
          rows.some((row) => row[key] === null)
            ? null
            : rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)
        result.push({
          id: 'salary',
          title: '本人工资',
          subtitle: `${month} 核算月份 · ${paid.length ? '待补结算差额' : '待结算工资'}`,
          value: cash(sumLines(pending, 'total')),
          icon: 'ri:money-cny-circle-line',
          color: 'purple',
          sensitive: true,
          href: '/finance/salary?tab=payroll',
          periodLabel: `${month} 工资核算（月度数据，独立于上方日期范围）`,
          details: [
            { label: '累计已发', value: amountText(sumLines(paid, 'total')) },
            { label: '待结算提成', value: amountText(sumLines(pending, 'commission')) },
            {
              label: '配置状态',
              value: pending.some((row) => row.incomplete) ? '配置未齐' : '核算完整'
            }
          ],
          notes: [
            `本卡使用已有工资模块的 ${month} 月核算数据，独立于上方区间筛选；不按天拆分工资，不提供区间增长率或工资曲线。`,
            '已发放快照保留原始金额；主指标仅显示尚未结算的工资或差额，不把历史已发金额再次计入待发。',
            '提成按订单完成月份核算；已发提成产生的退款差额在退款月份扣回。缺配置金额保持未知，不按零结算。',
            '只展示服务器当前权限可见的本人数据。'
          ]
        })
      }
    }

    if (
      !profitVisible &&
      ['attendance.manage', 'salary.view', 'salary.all'].some(permission) &&
      data.value &&
      user.value
    ) {
      const mine = data.value.attendance.filter((row) => row.userId === user.value?.id)
      const attendance = mine.filter(
        (row) => row.date >= report.range.start && row.date <= report.range.end
      )
      if (mine.length || permission('attendance.manage')) {
        const actual = attendance.filter((row) => row.status === 'present')
        result.push({
          id: 'attendance',
          title: '本人考勤',
          subtitle: '选期人工登记实际工时',
          value: `${actual.reduce((sum, row) => sum + row.actualHours, 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 小时`,
          icon: 'ri:calendar-check-line',
          color: 'green',
          href: permission('attendance.manage') ? '/personnel/attendance' : '/system/user-center',
          details: [
            { label: '实际到岗', value: actual.length },
            {
              label: '待登记班次',
              value: attendance.filter((row) => row.status === 'scheduled').length
            },
            {
              label: '请假 / 缺勤',
              value: attendance.filter((row) => ['leave', 'absent'].includes(row.status)).length
            }
          ],
          notes: [
            '按班次开始日期筛选本人服务器可见的考勤记录，实际工时使用人工登记原值。',
            '待登记排班、请假或缺勤不视为已工作，不自动累计为实际到岗工时。',
            '考勤不会自动产生工资扣款；进入业务模块后继续沿用现有权限。'
          ]
        })
      }
    }
    return result
  })

  const selectedId = ref('')
  const salaryDetailLines = computed(() =>
    (data.value?.reports.payroll || []).filter((row) => row.userId === user.value?.id)
  )
  const salaryPaidLines = computed(() =>
    (data.value?.payrolls || [])
      .filter((row) => row.month === data.value?.reports.month)
      .flatMap((row) =>
        row.lines
          .filter((line) => line.userId === user.value?.id)
          .map((line) => ({ ...line, paidAt: row.paidAt, payrollId: row.id }))
      )
  )
  const attendanceDetailRows = computed(() =>
    (data.value?.attendance || []).filter(
      (row) =>
        row.userId === user.value?.id &&
        props.report &&
        row.date >= props.report.range.start &&
        row.date <= props.report.range.end
    )
  )
  const attendanceLabels: Record<string, string> = {
    present: '实际到岗',
    scheduled: '待登记',
    normal: '已登记正常',
    rest: '休息',
    leave: '请假',
    absent: '缺勤'
  }
  const detailsRevealed = ref(false)
  const activeCard = computed(() => cards.value.find((card) => card.id === selectedId.value))
  const detailMasked = computed(() =>
    Boolean(activeCard.value?.sensitive && !detailsRevealed.value)
  )
  const dialogOpen = computed({
    get: () => Boolean(activeCard.value),
    set: (value: boolean) => {
      if (!value) selectedId.value = ''
    }
  })
  const route = useRoute()
  type RestoreMetric = { recordId?: string; isCurrent?: () => boolean }
  const pendingMetric = ref<RestoreMetric | null>(null)
  const metricRestoreError = ref('')
  function restoreMetric(payload: RestoreMetric) {
    pendingMetric.value = payload
    if (!props.loading && props.report) {
      pendingMetric.value = null
      if (payload.isCurrent?.() === false) return
      const target = payload.recordId || ''
      metricRestoreError.value = cards.value.some((card) => card.id === target && card.href)
        ? ''
        : '该统计在当前账号权限下不可见，请返回业务概览。'
      void openDetails(target, payload.isCurrent)
    }
  }
  watch([() => props.loading, cards], () => {
    if (!props.loading && props.report && pendingMetric.value) restoreMetric(pendingMetric.value)
  })
  async function openDetails(id: string, isCurrent?: () => boolean) {
    if (props.loading) return
    const card = cards.value.find((item) => item.id === id)
    if (!card?.href) return
    metricRestoreError.value = ''
    if (props.report)
      await router.replace({
        path: route.path,
        query: {
          ...route.query,
          overviewStart: props.report.range.start,
          overviewEnd: props.report.range.end
        }
      })
    if (isCurrent?.() === false) return
    detailsRevealed.value = !card.sensitive
    selectedId.value = id
  }
  async function goToModule() {
    const href = activeCard.value?.href
    if (href) {
      const failure = await router.push(href)
      if (!failure) selectedId.value = ''
    }
  }
  watch(
    [privacyKey, () => props.loading],
    () => {
      selectedId.value = ''
      detailsRevealed.value = false
    },
    { flush: 'sync' }
  )
</script>

<style scoped lang="scss">
  .overview-metrics {
    margin-bottom: 22px;
  }

  .overview-metrics-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 20px;
  }

  .overview-loading {
    padding: 22px;
    background: var(--el-bg-color);
    border: 1px solid var(--el-border-color-light);
    border-radius: 16px;
  }

  .overview-empty {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: center;
    padding: 26px 20px;
    font-size: 13px;
    line-height: 1.8;
    color: var(--el-text-color-secondary);
    background: var(--el-bg-color);
    border: 1px dashed var(--el-border-color);
    border-radius: 16px;
  }

  .detail-period {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--el-text-color-secondary);

    :deep(.el-tag) {
      max-width: 100%;
      height: auto;
      padding-block: 3px;
      line-height: 1.6;
      white-space: normal;
    }
  }

  .detail-main-value {
    display: flex;
    gap: 12px;
    align-items: center;
    margin: 22px 0 20px;

    strong {
      font-size: 30px;
      font-weight: 600;
      color: var(--el-text-color-primary);
      overflow-wrap: anywhere;
    }
  }

  .detail-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
    padding: 16px;
    background: var(--el-fill-color-light);
    border-radius: 12px;

    span {
      display: block;
      font-size: 12px;
      color: var(--el-text-color-secondary);
    }

    strong {
      display: block;
      margin-top: 8px;
      font-size: 15px;
      color: var(--el-text-color-primary);
      overflow-wrap: anywhere;
    }
  }

  .detail-notes {
    margin-top: 24px;

    h4 {
      display: flex;
      gap: 6px;
      align-items: center;
      font-size: 14px;
      font-weight: 600;
      color: var(--el-text-color-primary);
    }

    p {
      margin-top: 10px;
      font-size: 13px;
      line-height: 1.8;
      color: var(--el-text-color-secondary);
    }
  }

  .detail-updated {
    margin-top: 20px;
    font-size: 12px;
    color: var(--el-text-color-placeholder);
  }

  @media (width < 1400px) {
    .overview-metrics-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (width < 768px) {
    .overview-metrics-grid {
      grid-template-columns: 1fr;
      gap: 14px;
    }

    .overview-metrics {
      margin-bottom: 16px;
    }

    .detail-summary {
      gap: 10px;
      padding: 13px;
    }

    .detail-main-value {
      flex-wrap: wrap;
    }
  }
</style>
