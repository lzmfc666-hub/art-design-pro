import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { exportPeriod } from '../server/export-period.mjs'
import { buildExportSheets, getExportCatalog } from '../server/report-export.mjs'

const PASSWORD = 'export-period-test-password-123'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const rejected = (fn, status = 400) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status)

function fixture(t) {
  let clock = new Date('2026-09-01T02:00:00Z')
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    clock: () => clock
  })
  t.after(() => service.close())
  const time = (value) => {
    clock = new Date(value)
  }
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, body)
  const level = mutate('/levels', { name: '即时接单', delaySeconds: 0 })
  const users = {}
  for (const role of ['support', 'operations', 'finance', 'player'])
    users[role] = mutate('/users', {
      username: `export-period-${role}`,
      name: `测试${role}`,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 3,
      permissionOverrides: {},
      password: PASSWORD
    })
  const platforms = service.bootstrap('admin').platforms
  for (const role of ['support', 'operations', 'finance'])
    mutate('/salary-plans', {
      userId: users[role].id,
      mode: role === 'finance' ? 'fixed' : 'base_commission',
      base: role === 'finance' ? 10000 : 0,
      rate: role === 'support' ? 0 : null,
      platformRates: Object.fromEntries(platforms.map((row) => [row.id, 0])),
      effectiveFrom: '2026-09-01',
      hourlyEnabled: false
    })
  const customer = mutate('/customers', {
    name: '区间客户',
    contact: 'CONTACT-ONLY',
    gameId: 'GAME-ONLY',
    remark: ''
  })
  const template = mutate('/templates', {
    name: '真实跨月项目',
    game: '测试',
    description: '',
    amount: 10000,
    reward: 6000,
    map: '不限',
    remark: '',
    active: true
  })
  const upload = (actor = 'admin') =>
    service.upload(actor, { name: 'period.png', mime: 'image/png', data: PNG })
  const order = (externalOrderNo, amount, reward, paidAt) =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId: 'xianyu',
        shopId: 'jindun',
        externalOrderNo,
        roomCode: 'ROOM-ONLY',
        gameId: 'GAME-ONLY',
        amount,
        reward,
        receivedAmount: amount,
        paidAt,
        dispatchMode: 'pool'
      },
      users.support.id
    )
  const complete = (row) => {
    mutate(`/player/orders/${row.id}/claim`, {}, users.player.id)
    mutate(
      `/player/orders/${row.id}/submit`,
      { screenshots: [upload(users.player.id)] },
      users.player.id
    )
    mutate(`/orders/${row.id}/action`, { action: 'review-pass' })
  }
  time('2026-09-30T04:00:00Z')
  const first = order('000-SEPTEMBER', 10000, 6000, '2026-09-30T10:00:00+08:00')
  time('2026-10-01T04:00:00Z')
  const second = order('000-OCTOBER', 20000, 12000, '2026-10-01T10:00:00+08:00')
  mutate('/expenses', {
    category: '统计费用',
    amount: 1500,
    date: '2026-10-01',
    purpose: '跨月费用',
    receipt: upload()
  })
  time('2026-10-02T04:00:00Z')
  complete(first)
  complete(second)
  time('2026-10-03T04:00:00Z')
  mutate('/refunds', { orderId: first.id, amount: 1000, reason: '跨月部分退款' })
  const payroll = mutate('/payrolls', { month: '2026-09' })
  mutate('/attendance', {
    userId: users.finance.id,
    date: '2035-01-01',
    start: '',
    end: '',
    status: 'normal',
    actualHours: null,
    remark: '未来排班'
  })
  const snapshot = (period, actor = 'admin', extra = {}) =>
    service.exportSnapshot(actor, { month: '2026-10', period, ...extra })
  const sheet = (data, id, fields, filters) =>
    buildExportSheets(data, { modules: [{ id, fields }], filters }).sheets[0]
  return { service, mutate, time, users, customer, first, second, payroll, snapshot, sheet }
}

test('上海日历自然周、闰月与旧版月报请求保持有效且拒绝不存在的日期', () => {
  const now = new Date('2026-10-03T16:10:00Z')
  assert.deepEqual(exportPeriod({ period: { type: 'weekly', date: '2026-10-04' } }, {}, now), {
    type: 'weekly',
    start: '2026-09-28',
    end: '2026-10-04',
    label: '周报',
    note: '自然周：周一至周日'
  })
  assert.equal(exportPeriod({ period: { type: 'daily' } }, {}, now).start, '2026-10-04')
  assert.equal(exportPeriod({ month: '2024-02' }, {}, now).end, '2024-02-29')
  const yearWeek = exportPeriod({ period: { type: 'weekly', date: '2027-01-03' } }, {}, now)
  assert.deepEqual([yearWeek.start, yearWeek.end], ['2026-12-28', '2027-01-03'])
  for (const request of [
    { month: '2026-13' },
    { month: '1899-12' },
    { period: { type: 'daily', date: '2026-02-30' } },
    { period: { type: 'weekly', date: '2026-10' } },
    { period: { type: 'unknown' } },
    { period: null },
    { period: [] }
  ])
    rejected(() => exportPeriod(request, {}, now))
})

test('真实跨月周报聚合原付款日退款和费用，业绩独立使用完成日，不摊月度底薪', (t) => {
  const f = fixture(t)
  const week = f.snapshot({ type: 'weekly', date: '2026-10-02' })
  assert.deepEqual([week.exportPeriod.start, week.exportPeriod.end], ['2026-09-28', '2026-10-04'])
  assert.equal(week.reports.days.length, 7)
  const september = week.reports.days.find((row) => row.date === '2026-09-30')
  const october = week.reports.days.find((row) => row.date === '2026-10-01')
  assert.equal(september.received, 10000)
  assert.equal(september.refunds, 1000)
  assert.equal(september.net, 9000)
  assert.equal(september.profit, 3000)
  assert.equal(october.received, 20000)
  assert.equal(october.refunds, 0)
  assert.equal(october.expenses, 1500)
  assert.equal(october.profit, 6500)
  assert.equal(week.reports.monthlyBase, null)
  assert.equal(week.reports.monthlyProfit, null)
  const summary = f.sheet(week, 'overview', [
    'received',
    'refunds',
    'operatingProfit',
    'monthlyProfit'
  ])
  assert.deepEqual(summary.rows, [
    { received: 300, refunds: 10, operatingProfit: 95, monthlyProfit: '待配置' }
  ])
  const channel = week.reports.channels.find((row) => row.platformId === 'xianyu' && !row.shopId)
  assert.deepEqual(
    [channel.orders, channel.received, channel.refunds, channel.net],
    [2, 30000, 1000, 29000]
  )
  const completionDay = f.snapshot({ type: 'daily', date: '2026-10-02' })
  const performance = completionDay.reports.performance.find(
    (row) => row.userId === f.users.support.id
  )
  assert.deepEqual([performance.orders, performance.completed, performance.net], [2, 2, 29000])
  assert.equal(completionDay.reports.days[0].received, 0)
  const orders = f.sheet(week, 'orders', ['externalOrderNo'], { orderDateKey: 'paidAt' })
  assert.deepEqual(
    orders.rows.map((row) => row.externalOrderNo),
    ['000-SEPTEMBER', '000-OCTOBER']
  )
})

test('日报周报工资只计实际发放，旧版月报保留真实核算月份和次月发放快照', (t) => {
  const f = fixture(t)
  const previousDay = f.snapshot({ type: 'daily', date: '2026-09-30' })
  assert.equal(previousDay.payrolls.length, 0)
  assert.equal(previousDay.reports.payroll.length, 0)
  const payDay = f.snapshot({ type: 'daily', date: '2026-10-03' })
  const finance = payDay.reports.payroll.find((row) => row.userId === f.users.finance.id)
  assert.equal(finance.total, 10000)
  const actual = f
    .sheet(payDay, 'payroll', ['month', 'name', 'total', 'settlementState'])
    .rows.find((row) => row.name === f.users.finance.name)
  assert.equal(actual.total, 100)
  assert.equal(actual.month, '日报 2026-10-03 至 2026-10-03')
  assert.equal(actual.settlementState, '实际已发汇总')
  const september = f.service.exportSnapshot('admin', { month: '2026-09' })
  assert.equal(september.exportPeriod.type, 'monthly')
  assert.equal(september.reports.days.length, 30)
  assert.equal(september.reports.monthlyBase, 10000)
  assert.equal(september.reports.monthlyProfit, -7000)
  const history = f.sheet(september, 'payrollHistory', ['month', 'paidAt', 'total', 'payrollId'])
  assert.ok(
    history.rows.some(
      (row) => row.month === '2026-09' && row.payrollId === f.payroll.id && row.total === 100
    )
  )
  assert.ok(history.rows.every((row) => row.paidAt.startsWith('2026-10-03')))
  const explicitDate = f.sheet(september, 'payrollHistory', ['payrollId'], {
    dateRange: ['2026-09-01', '2026-09-30']
  })
  assert.equal(explicitDate.rowCount, 0)
})

test('总计到上海当天止，未来考勤不延伸日期；员工区间报表继续使用权限投影', (t) => {
  const f = fixture(t)
  const total = f.snapshot({ type: 'total' })
  assert.equal(total.exportPeriod.start, '2026-09-01')
  assert.equal(total.exportPeriod.end, '2026-10-03')
  assert.equal(f.sheet(total, 'attendance', ['date', 'status']).rowCount, 0)
  const future = f.snapshot({ type: 'daily', date: '2035-01-01' })
  assert.deepEqual(f.sheet(future, 'attendance', ['date', 'status']).rows, [
    { date: '2035-01-01', status: '正常' }
  ])
  const employee = f.snapshot({ type: 'weekly', date: '2026-10-02' }, f.users.operations.id)
  assert.deepEqual(employee.reports.days, [])
  assert.deepEqual(employee.reports.channels, [])
  assert.equal(employee.reports.monthlyBase, null)
  assert.equal(employee.reports.monthlyProfit, null)
  assert.ok(employee.reports.performance.every((row) => row.userId === f.users.operations.id))
  assert.ok(employee.reports.payroll.every((row) => row.userId === f.users.operations.id))
  assert.ok(
    employee.payrolls.every((row) =>
      row.lines.every((line) => line.userId === f.users.operations.id)
    )
  )
  assert.ok(!getExportCatalog(employee).modules.some((row) => row.id === 'overview'))
  rejected(() => f.sheet(employee, 'overview', ['operatingProfit']), 403)
  for (const hidden of [PASSWORD, 'passwordHash', 'commissionPaid', 'rewardCredits'])
    assert.equal(JSON.stringify(employee).includes(hidden), false)
})

test('客户编号全量导出超过档案预载20条，字段搜索只匹配所选字段', (t) => {
  const f = fixture(t)
  for (let index = 0; index < 25; index++)
    f.mutate('/customer-order-references', {
      customerId: f.customer.id,
      platformId: 'xianyu',
      shopId: 'jindun',
      externalOrderNo: `000000-${index}`
    })
  assert.equal(f.service.bootstrap('admin').customers[0].orderReferences.length, 20)
  const request = {
    modules: [{ id: 'customerOrderReferences', fields: ['externalOrderNo'] }]
  }
  const selected = f.snapshot({ type: 'total' }, 'admin', request)
  assert.equal(
    getExportCatalog(selected).modules.find((row) => row.id === 'customerOrderReferences').rowCount,
    25
  )
  const references = buildExportSheets(selected, request).sheets[0]
  assert.equal(references.rowCount, 25)
  assert.ok(
    references.rows.every(
      (row) => Object.keys(row).length === 1 && row.externalOrderNo.startsWith('000000-')
    )
  )
  assert.equal(selected.orders.length, 2)
  assert.equal(
    f.sheet(selected, 'customers', ['name'], { keyword: 'GAME-ONLY', keywordField: 'contact' })
      .rowCount,
    0
  )
  assert.equal(
    f.sheet(selected, 'customers', ['name'], { keyword: 'GAME-ONLY', keywordField: 'gameId' })
      .rowCount,
    1
  )
  rejected(() => f.sheet(selected, 'customers', ['name'], { keyword: 'GAME-ONLY' }))
  rejected(() =>
    f.sheet(selected, 'customers', ['name'], { keyword: 'GAME-ONLY', keywordField: 'password' })
  )
})
