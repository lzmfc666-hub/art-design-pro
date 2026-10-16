import { ApiError, shanghaiDate } from './studio.mjs'

const DAY = 86400000
const dateOf = (value) => {
  if (!value) return null
  try {
    return shanghaiDate(value)
  } catch {
    return null
  }
}
const dayValue = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number(value.slice(0, 4)) < 1900 ||
    Number(value.slice(0, 4)) > 9998
  )
    throw new ApiError('请选择有效报表日期（1900 至 9998 年）')
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new ApiError('报表日期无效')
  return parsed
}
const iso = (date) => date.toISOString().slice(0, 10)
const lastDay = (month) => {
  const first = dayValue(`${month}-01`)
  first.setUTCMonth(first.getUTCMonth() + 1)
  return iso(new Date(first.getTime() - DAY))
}

export function exportPeriod(request = {}, state = {}, now = new Date()) {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new ApiError('报表请求格式无效')
  if (
    request.period !== undefined &&
    (!request.period || typeof request.period !== 'object' || Array.isArray(request.period))
  )
    throw new ApiError('报表类型格式无效')
  const type = request.period?.type ?? 'monthly'
  if (!['daily', 'weekly', 'monthly', 'total'].includes(type)) throw new ApiError('报表类型无效')
  if (request.month !== undefined) {
    if (typeof request.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(request.month))
      throw new ApiError('请选择有效月份')
    dayValue(`${request.month}-01`)
  }
  if (request.period?.date !== undefined) dayValue(request.period.date)
  const today = shanghaiDate(now)
  let start, end
  if (type === 'monthly') {
    const month = request.month || today.slice(0, 7)
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new ApiError('请选择有效月份')
    start = iso(dayValue(`${month}-01`))
    end = lastDay(month)
  } else if (type === 'total') {
    const dates = [today]
    const include = (value) => {
      const date = dateOf(value)
      if (date && date <= today) dates.push(date)
    }
    for (const value of state.exportOnlyDates || []) include(value)
    for (const order of state.orders || []) {
      for (const key of ['createdAt', 'paidAt', 'completedAt', 'canceledAt']) include(order[key])
      for (const row of order.returnRequests || []) {
        include(row.requestedAt)
        include(row.processedAt)
      }
      for (const row of order.rejections || []) include(row.rejectedAt)
    }
    for (const table of [
      'refunds',
      'withdrawals',
      'expenses',
      'playerAdjustments',
      'rewardReviews',
      'payrolls',
      'attendance',
      'logs'
    ])
      for (const row of state[table] || []) {
        for (const key of [
          'date',
          'createdAt',
          'processedAt',
          'paidAt',
          'resolvedAt',
          'canceledAt'
        ])
          include(row[key])
        if (table === 'payrolls' && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.month || ''))
          include(`${row.month}-01`)
      }
    dates.sort()
    start = dates[0]
    end = today
  } else {
    const anchor = dayValue(request.period?.date ?? today)
    if (type === 'daily') start = end = iso(anchor)
    else {
      const monday = new Date(anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * DAY)
      start = iso(monday)
      end = iso(new Date(monday.getTime() + 6 * DAY))
    }
  }
  const names = { daily: '日报', weekly: '周报', monthly: '月报', total: '总计报表' }
  return {
    type,
    start,
    end,
    label: names[type],
    note: type === 'weekly' ? '自然周：周一至周日' : ''
  }
}

/** 原始状态只用于内部计算；输出保留 base 的授权投影，不返回原始业务集合。 */
export function buildPeriodExportSnapshot({ base, state, request, now, monthReport }) {
  const period = exportPeriod(request, state, now)
  const result = { ...base, exportPeriod: period }
  if (period.type === 'monthly') {
    if (base.reports.month !== period.start.slice(0, 7))
      throw new ApiError('核算月份与当前数据不一致')
    return result
  }
  if (base.skipReportComputation) return result
  const inRange = (value) => {
    const date = dateOf(value)
    return Boolean(date && date >= period.start && date <= period.end)
  }
  const profitVisible =
    !base.skipReportComputation &&
    base.user.role !== 'player' &&
    base.permissions.includes('profit.view')
  const months = []
  const cursor = dayValue(`${period.start.slice(0, 7)}-01`)
  const finalMonth = period.end.slice(0, 7)
  while (iso(cursor).slice(0, 7) <= finalMonth) {
    if (months.length >= 1200) throw new ApiError('报表跨度超过100年，请缩小范围')
    months.push(iso(cursor).slice(0, 7))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  const reports = profitVisible ? months.map(monthReport) : []
  const days = reports
    .flatMap((row) => row.days)
    .filter((row) => row.date >= period.start && row.date <= period.end)
  const refundTotals = new Map()
  for (const row of state.refunds || [])
    if (row.status === 'paid')
      refundTotals.set(row.orderId, (refundTotals.get(row.orderId) || 0) + row.amount)
  const paidRefunds = (orderId) => refundTotals.get(orderId) || 0
  const netOrder = (order) =>
    Math.max(0, Math.min(order.amount, order.receivedAmount) - paidRefunds(order.id))
  const orders = (state.orders || []).filter((row) => row.receivedAmount > 0 && inRange(row.paidAt))
  const channel = (platformId, shopId, name) => {
    const rows = orders.filter(
      (row) => row.platformId === platformId && (shopId === undefined || row.shopId === shopId)
    )
    const received = rows.reduce((sum, row) => sum + row.receivedAmount, 0)
    const refunds = rows.reduce((sum, row) => sum + paidRefunds(row.id), 0)
    return {
      platformId,
      ...(shopId === undefined ? {} : { shopId }),
      name,
      orders: rows.length,
      received,
      refunds,
      net: received - refunds
    }
  }
  const channels = profitVisible
    ? [
        ...(state.platforms || []).map((row) => channel(row.id, undefined, row.name)),
        ...(state.shops || []).map((row) => channel(row.platformId, row.id, row.name))
      ]
    : []
  const performanceIds = new Set(base.reports.performance.map((row) => row.userId))
  const completedOrders = (state.orders || []).filter(
    (row) => row.status === 'completed' && row.receivedAmount > 0 && inRange(row.completedAt)
  )
  const performance = (state.users || [])
    .filter((row) => performanceIds.has(row.id))
    .map((user) => {
      const rows = completedOrders.filter((row) =>
        user.role === 'operations'
          ? row.commissionSnapshot?.operationsId === user.id
          : row.creatorId === user.id
      )
      return {
        userId: user.id,
        name: user.name,
        orders: rows.length,
        completed: rows.length,
        net: rows.reduce((sum, row) => sum + netOrder(row), 0)
      }
    })
  const salaryVisible =
    base.user.role !== 'player' &&
    (base.permissions.includes('salary.all') || base.permissions.includes('salary.view'))
  const allSalary = base.permissions.includes('salary.all')
  const payrolls = salaryVisible
    ? (state.payrolls || [])
        .filter((row) => inRange(row.paidAt))
        .map((row) => ({
          ...row,
          lines: row.lines.filter((line) => allSalary || line.userId === base.user.id)
        }))
        .filter((row) => row.lines.length)
    : []
  const byUser = new Map()
  for (const line of payrolls.flatMap((row) => row.lines)) {
    const value = byUser.get(line.userId) || {
      ...line,
      base: 0,
      commission: 0,
      deduction: 0,
      total: 0,
      incomplete: false
    }
    for (const key of ['base', 'commission', 'deduction', 'total'])
      value[key] = value[key] == null || line[key] == null ? null : value[key] + line[key]
    value.incomplete ||= line.incomplete
    byUser.set(line.userId, value)
  }
  const fullPeriodMonths =
    period.start.endsWith('-01') && period.end === lastDay(period.end.slice(0, 7))
  const monthlyBase =
    profitVisible && fullPeriodMonths && reports.every((row) => row.monthlyBase != null)
      ? reports.reduce((sum, row) => sum + row.monthlyBase, 0)
      : null
  const monthlyProfit =
    monthlyBase != null && days.every((row) => row.profit != null)
      ? days.reduce((sum, row) => sum + row.profit, 0) - monthlyBase
      : null
  result.reports = {
    ...base.reports,
    days,
    channels,
    performance,
    payroll: [...byUser.values()],
    monthlyBase,
    monthlyProfit
  }
  result.payrolls = payrolls
  return result
}
