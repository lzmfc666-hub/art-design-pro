import { ApiError, shanghaiDate } from './studio.mjs'

const DAY_MS = 86400000
const dateNumber = (date) => Date.parse(`${date}T00:00:00Z`)
const dateText = (timestamp) => new Date(timestamp).toISOString().slice(0, 10)
const dayOf = (value) => (value ? shanghaiDate(value) : null)
const inRange = (date, range) => Boolean(date && date >= range.start && date <= range.end)
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0)
const ratio = (value, total) => (total ? Math.round((value / total) * 10000) / 100 : null)
const metricKeys = [
  'received',
  'refunds',
  'net',
  'orderCount',
  'createdOrders',
  'completedOrders',
  'canceledOrders',
  'payingCustomers',
  'repeatCustomers',
  'customerRepeatRate',
  'averageOrderAmount',
  'estimatedReward',
  'reward',
  'expenses',
  'otherIncome',
  'supportCommission',
  'operationsCommission',
  'periodOperatingProfit',
  'fullMonthsProfit',
  'monthlyBase',
  'profitIncomplete',
  'playerAvailable',
  'playerOccupied',
  'playerPaid',
  'playerAccepted',
  'playerAcceptedOrders',
  'playerUnique',
  'playerCompletedOrders',
  'playerCompletionRate',
  'staffCount',
  'playerCount',
  'newStaff',
  'newPlayers',
  'newCustomers',
  'personalNet',
  'personalCompletedOrders'
]

export function normalizeOverviewRange(input = {}, today = shanghaiDate(new Date())) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ApiError('日期筛选格式无效')
  const validate = (value) => {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number(value.slice(0, 4)) < 1900 ||
      Number(value.slice(0, 4)) > 9998 ||
      !Number.isFinite(dateNumber(value)) ||
      dateText(dateNumber(value)) !== value
    )
      throw new ApiError('日期应为 1900-01-01 至 9998-12-31 内有效的 YYYY-MM-DD 格式')
    return value
  }
  const start = validate(input.start ?? today)
  const end = validate(input.end ?? today)
  const days = (dateNumber(end) - dateNumber(start)) / DAY_MS + 1
  if (days < 1 || days > 366) throw new ApiError('日期范围应按先后顺序选择，最多 366 天')
  const comparisonEnd = dateNumber(start) - DAY_MS
  return {
    range: { start, end, days },
    comparisonRange: {
      start: dateText(comparisonEnd - (days - 1) * DAY_MS),
      end: dateText(comparisonEnd),
      days
    }
  }
}

export function overviewMonths({ range, comparisonRange }) {
  const result = []
  const from = new Date(`${comparisonRange.start.slice(0, 7)}-01T00:00:00Z`)
  const until = dateNumber(range.end)
  while (from.getTime() <= until) {
    const month = from.toISOString().slice(0, 7)
    result.push(month)
    if (month === range.end.slice(0, 7)) break
    from.setUTCMonth(from.getUTCMonth() + 1)
  }
  return result
}

/** 只使用已经按当前用户权限过滤的 bootstrap 快照，金额始终为整数分。 */
export function buildOverviewReport(snapshots, dates, generatedAt) {
  if (!Array.isArray(snapshots) || !snapshots.length) throw new ApiError('概览数据尚未加载')
  const snapshot = snapshots[0]
  const permissions = [...snapshot.permissions]
  const can = (permission) => permissions.includes(permission)
  const profit = can('profit.view')
  const ordersVisible = can('orders.view') || snapshot.user.role === 'player'
  const peopleVisible = can('users.manage') || can('attendance.manage') || can('salary.all')
  const customersVisible = can('orders.view') || can('orders.create') || can('users.manage')
  const walletVisible = can('finance.withdrawals') || snapshot.user.role === 'player'
  const expensesVisible = profit || can('finance.expenses')
  const reportsByMonth = new Map(snapshots.map((row) => [row.reports.month, row.reports]))
  const orderRows = [
    ...new Map(snapshots.flatMap((row) => row.orders).map((row) => [row.id, row])).values()
  ]
  const refundRows = [
    ...new Map(snapshots.flatMap((row) => row.refunds).map((row) => [row.id, row])).values()
  ]
  const refundTotals = new Map()
  for (const refund of refundRows.filter((row) => row.status === 'paid'))
    refundTotals.set(refund.orderId, (refundTotals.get(refund.orderId) || 0) + refund.amount)
  const netOrder = (order) =>
    Math.max(0, Math.min(order.amount, order.receivedAmount) - (refundTotals.get(order.id) || 0))
  const personal = (order) =>
    snapshot.user.role === 'operations'
      ? order.commissionSnapshot?.operationsId === snapshot.user.id
      : order.creatorId === snapshot.user.id
  const creationCoverage = (rows, range) => ({
    known: rows.filter((row) => row.createdAt).length,
    unknown: rows.filter((row) => !row.createdAt).length,
    inRange: rows.filter((row) => inRange(dayOf(row.createdAt), range)).length
  })
  function aggregate(range) {
    const metrics = Object.fromEntries(metricKeys.map((key) => [key, null]))
    const series = Array.from({ length: range.days }, (_, index) => {
      const date = dateText(dateNumber(range.start) + index * DAY_MS)
      const report = reportsByMonth.get(date.slice(0, 7))?.days.find((row) => row.date === date)
      const paid = orderRows.filter((row) => row.receivedAmount > 0 && dayOf(row.paidAt) === date)
      const completed = orderRows.filter(
        (row) => row.status === 'completed' && dayOf(row.completedAt) === date
      )
      const accepted = orderRows.flatMap((order) =>
        (order.assignments || []).filter(
          (row) =>
            dayOf(row.acceptedAt) === date &&
            (can('orders.view') || row.leaderId === snapshot.user.id)
        )
      )
      return {
        date,
        received: profit ? (report?.received ?? null) : null,
        refunds: profit ? (report?.refunds ?? null) : null,
        net: profit ? (report?.net ?? null) : null,
        orders: ordersVisible ? paid.length : null,
        createdOrders: ordersVisible
          ? orderRows.filter((row) => dayOf(row.createdAt) === date).length
          : null,
        completedOrders: ordersVisible ? completed.length : null,
        canceledOrders: ordersVisible
          ? orderRows.filter((row) => dayOf(row.canceledAt) === date).length
          : null,
        payingCustomers:
          profit && can('orders.view')
            ? new Set(paid.map((row) => row.customerId).filter(Boolean)).size
            : null,
        profit: profit ? (report?.profit ?? null) : null,
        accepted: ordersVisible ? accepted.length : null,
        expenses: profit
          ? (report?.expenses ?? null)
          : expensesVisible
            ? snapshot.expenses
                .filter((row) => !row.deletedAt && row.date === date)
                .reduce((total, row) => total + row.amount, 0)
            : null,
        otherIncome: profit ? (report?.otherIncome ?? 0) : null,
        personalNet: can('orders.view')
          ? snapshot.personalPerformance
            ? snapshot.personalPerformance
                .filter((row) => row.date === date)
                .reduce((total, row) => total + row.net, 0)
            : completed.filter(personal).reduce((total, row) => total + netOrder(row), 0)
          : null,
        personalCompletedOrders: can('orders.view')
          ? snapshot.personalPerformance
            ? snapshot.personalPerformance.filter((row) => row.date === date).length
            : completed.filter(personal).length
          : null
      }
    })
    const periodDays = [...reportsByMonth.values()]
      .flatMap((row) => row.days)
      .filter((row) => inRange(row.date, range))
    if (profit) {
      const paid = orderRows.filter(
        (row) => row.receivedAmount > 0 && inRange(dayOf(row.paidAt), range)
      )
      const customers = new Set(paid.map((row) => row.customerId).filter(Boolean))
      // 复购人数：选期付费客户在截至选期末的可见付款历史中至少有两笔订单。
      const repeating = [...customers].filter(
        (id) =>
          orderRows.filter(
            (row) =>
              row.customerId === id &&
              row.receivedAmount > 0 &&
              dayOf(row.paidAt) &&
              dayOf(row.paidAt) <= range.end
          ).length >= 2
      ).length
      Object.assign(metrics, {
        received: sum(periodDays, 'received'),
        refunds: sum(periodDays, 'refunds'),
        net: sum(periodDays, 'net'),
        otherIncome: sum(periodDays, 'otherIncome'),
        estimatedReward: sum(periodDays, 'estimatedReward'),
        reward: sum(periodDays, 'reward'),
        supportCommission: periodDays.some((row) => row.incomplete)
          ? null
          : sum(periodDays, 'supportCommission'),
        operationsCommission: periodDays.some((row) => row.incomplete)
          ? null
          : sum(periodDays, 'operationsCommission'),
        payingCustomers: can('orders.view') ? customers.size : null,
        repeatCustomers: can('orders.view') ? repeating : null,
        customerRepeatRate: can('orders.view') ? ratio(repeating, customers.size) : null,
        averageOrderAmount:
          can('orders.view') && paid.length
            ? Math.round(sum(periodDays, 'received') / paid.length)
            : null,
        periodOperatingProfit: periodDays.some((row) => row.profit == null)
          ? null
          : sum(periodDays, 'profit'),
        profitIncomplete: periodDays.some((row) => row.incomplete) ? 1 : 0
      })
      const last = new Date(`${range.end.slice(0, 7)}-01T00:00:00Z`)
      last.setUTCMonth(last.getUTCMonth() + 1)
      const wholeMonths =
        range.start.endsWith('-01') && range.end === dateText(last.getTime() - DAY_MS)
      if (wholeMonths) {
        const reports = [...reportsByMonth.values()].filter(
          (row) => row.month >= range.start.slice(0, 7) && row.month <= range.end.slice(0, 7)
        )
        metrics.monthlyBase = reports.some((row) => row.monthlyBase == null)
          ? null
          : sum(reports, 'monthlyBase')
        metrics.fullMonthsProfit = reports.some((row) => row.monthlyProfit == null)
          ? null
          : sum(reports, 'monthlyProfit')
        if (reports.some((row) => row.monthlyProfit == null)) metrics.profitIncomplete = 1
      }
    }
    if (ordersVisible) {
      metrics.orderCount = sum(series, 'orders')
      metrics.createdOrders = sum(series, 'createdOrders')
      metrics.completedOrders = sum(series, 'completedOrders')
      metrics.canceledOrders = sum(series, 'canceledOrders')
      const assignments = orderRows.flatMap((order) =>
        (order.assignments || [])
          .filter(
            (row) =>
              inRange(dayOf(row.acceptedAt), range) &&
              (can('orders.view') || row.leaderId === snapshot.user.id)
          )
          .map((row) => ({ ...row, order }))
      )
      const acceptedOrders = [
        ...new Map(assignments.map((row) => [row.order.id, row.order])).values()
      ]
      metrics.playerAccepted = assignments.length
      metrics.playerAcceptedOrders = acceptedOrders.length
      metrics.playerUnique = new Set(assignments.map((row) => row.leaderId)).size
      metrics.playerCompletedOrders = orderRows.filter(
        (row) => row.status === 'completed' && inRange(dayOf(row.completedAt), range)
      ).length
      metrics.playerCompletionRate = ratio(
        acceptedOrders.filter(
          (row) => row.status === 'completed' && dayOf(row.completedAt) <= range.end
        ).length,
        acceptedOrders.length
      )
    }
    if (can('orders.view')) {
      metrics.personalNet = sum(series, 'personalNet')
      metrics.personalCompletedOrders = sum(series, 'personalCompletedOrders')
    }
    if (expensesVisible) metrics.expenses = sum(series, 'expenses')
    if (walletVisible) {
      metrics.playerAvailable = sum(snapshot.wallets, 'available')
      metrics.playerOccupied = sum(snapshot.wallets, 'occupied')
      metrics.playerPaid = snapshot.withdrawals
        .filter((row) => row.status === 'paid' && inRange(dayOf(row.paidAt), range))
        .reduce((total, row) => total + row.amount, 0)
    }
    const staff = snapshot.users.filter((row) => row.role !== 'player')
    const players = snapshot.users.filter((row) => row.role === 'player')
    const coverage = {
      staff: creationCoverage(staff, range),
      players: creationCoverage(players, range),
      customers: creationCoverage(snapshot.customers, range)
    }
    if (peopleVisible) {
      metrics.staffCount = staff.length
      metrics.playerCount = players.length
      metrics.newStaff = coverage.staff.unknown ? null : coverage.staff.inRange
      metrics.newPlayers = coverage.players.unknown ? null : coverage.players.inRange
    } else {
      coverage.staff = { known: 0, unknown: 0, inRange: 0 }
      coverage.players = { known: 0, unknown: 0, inRange: 0 }
    }
    if (customersVisible && (snapshot.user.role !== 'player' || can('orders.view')))
      metrics.newCustomers = coverage.customers.unknown ? null : coverage.customers.inRange
    else coverage.customers = { known: 0, unknown: 0, inRange: 0 }
    return { metrics, series, coverage }
  }
  const current = aggregate(dates.range)
  const previous = aggregate(dates.comparisonRange)
  const changes = Object.fromEntries(
    metricKeys.map((key) => {
      const before = previous.metrics[key],
        after = current.metrics[key]
      const comparable = ![
        'staffCount',
        'playerCount',
        'playerAvailable',
        'playerOccupied',
        'profitIncomplete'
      ].includes(key)
      return [
        key,
        comparable && before != null && after != null && before !== 0
          ? Math.round(((after - before) / Math.abs(before)) * 10000) / 100
          : null
      ]
    })
  )
  const scopeNotes = [
    '金额单位为分；客户收款、退款、打手成本和经营提成沿用原付款日归属，后续退款会回改原付款日。',
    '区间经营利润不扣员工底薪；仅开始于月初且结束于月末的完整月份区间提供扣底薪利润，底薪不按天摊分。',
    '打手成本包含未验收预计报酬；提现发放不会再次扣减经营利润。',
    '付费客户按原付款日去重；复购指选期客户截至选期末已有至少两笔付款订单，客单价为选期收款除以付款订单数。',
    '接单数包含重新接单次数；完成率按选期接过的去重订单截至选期末已完成比例统计。',
    '可提现及占用金额为当前钱包余额，不属于所选日期区间；已发放金额按实际发放日期统计。',
    '比较期为紧邻所选区间之前的相同天数；前期为零、无权限或配置缺失时不计算增长率。'
  ]
  if (Object.values(current.coverage).some((row) => row.unknown))
    scopeNotes.push(
      '部分历史人员或客户没有创建日期，新增总数显示待确认；创建日期覆盖信息仅统计有日期记录，不补造历史日期。'
    )
  if (!profit)
    scopeNotes.push(
      '当前账号无经营报表权限；经营收入和利润不提供数值，个人业绩按可见本人完成订单归属。'
    )
  return {
    ...dates,
    generatedAt,
    permissions,
    metrics: current.metrics,
    comparison: previous.metrics,
    changes,
    series: current.series,
    scopeNotes,
    creationDateCoverage: current.coverage
  }
}
