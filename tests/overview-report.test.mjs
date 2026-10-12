import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'

const PASSWORD = 'overview-period-test-password-123'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

function fixture(t) {
  let clock = new Date('2026-09-01T02:00:00Z')
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    clock: () => clock
  })
  t.after(() => service.close())
  const time = (date) => {
    clock = new Date(date)
  }
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, body)
  const level = mutate('/levels', { name: '即时接单', delaySeconds: 0 })
  const users = {}
  for (const role of ['support', 'operations', 'finance', 'hr', 'player'])
    users[role] = mutate('/users', {
      username: `period-${role}`,
      name: `测试${role}`,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 3,
      permissionOverrides: {},
      password: PASSWORD
    })
  mutate('/salary-plans', {
    userId: users.support.id,
    mode: 'base_commission',
    base: 100000,
    rate: 1000,
    platformRates: {},
    effectiveFrom: '2026-09-01',
    hourlyEnabled: false
  })
  mutate('/salary-plans', {
    userId: users.operations.id,
    mode: 'base_commission',
    base: 200000,
    rate: null,
    platformRates: { xianyu: 500, xiaohongshu: 500 },
    effectiveFrom: '2026-09-01',
    hourlyEnabled: false
  })
  for (const role of ['finance', 'hr'])
    mutate('/salary-plans', {
      userId: users[role].id,
      mode: 'fixed',
      base: 0,
      rate: null,
      platformRates: {},
      effectiveFrom: '2026-09-01',
      hourlyEnabled: false
    })
  const customer = mutate('/customers', {
    name: '复购客户',
    contact: '',
    gameId: '0001',
    remark: ''
  })
  const template = mutate('/templates', {
    name: '区间订单',
    game: '测试',
    description: '',
    amount: 10000,
    reward: 7000,
    map: '不限',
    remark: '',
    active: true
  })
  const order = ({ amount, reward, paidAt, customerId = customer.id }) =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId,
        platformId: 'xianyu',
        shopId: 'jindun',
        externalOrderNo: `PERIOD-${paidAt}-${customerId}`,
        channel: '闲鱼',
        roomCode: 'ROOM',
        gameId: '0001',
        amount,
        reward,
        receivedAmount: amount,
        paidAt,
        dispatchMode: 'pool'
      },
      users.support.id
    )
  const upload = (actor = 'admin') =>
    service.upload(actor, { name: 'period.png', mime: 'image/png', data: PNG })
  const complete = (row) => {
    mutate(`/player/orders/${row.id}/claim`, {}, users.player.id)
    mutate(
      `/player/orders/${row.id}/submit`,
      { screenshots: [upload(users.player.id)] },
      users.player.id
    )
    mutate(`/orders/${row.id}/action`, { action: 'review-pass' })
  }
  time('2026-09-30T12:00:00Z')
  const first = order({ amount: 10000, reward: 7000, paidAt: '2026-09-30T16:10:00+08:00' })
  time('2026-10-01T02:00:00Z')
  complete(first)
  time('2026-10-05T04:00:00Z')
  const second = order({ amount: 20000, reward: 10000, paidAt: '2026-10-05T11:00:00+08:00' })
  time('2026-10-06T02:00:00Z')
  complete(second)
  const expense = mutate('/expenses', {
    category: '房租',
    amount: 1500,
    date: '2026-10-06',
    purpose: '统计测试',
    receipt: upload()
  })
  time('2026-10-10T02:00:00Z')
  mutate('/refunds', { orderId: first.id, amount: 1000, reason: '十月退款回改九月付款' })
  const withdrawal = mutate('/player/withdrawals', { amount: 1000 }, users.player.id)
  mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt: upload() })
  time('2026-10-13T02:00:00Z')
  const newCustomer = mutate('/customers', { name: '新客户', contact: '', gameId: '', remark: '' })
  const pending = order({
    amount: 6000,
    reward: 3000,
    paidAt: '2026-10-13T09:00:00+08:00',
    customerId: newCustomer.id
  })
  const overview = (start, end, actor = 'admin') => service.overview(actor, { start, end })
  return {
    service,
    time,
    mutate,
    users,
    customer,
    newCustomer,
    first,
    second,
    pending,
    expense,
    order,
    complete,
    overview
  }
}

test('区间沿用付款日会计，跨月退款回改原日，个人业绩按完成日和运营归属', (t) => {
  const f = fixture(t)
  const september = f.overview('2026-09-30', '2026-09-30')
  assert.equal(september.metrics.received, 10000)
  assert.equal(september.metrics.refunds, 1000)
  assert.equal(september.metrics.net, 9000)
  assert.equal(september.metrics.reward, 7000)
  assert.equal(september.metrics.supportCommission, 900)
  assert.equal(september.metrics.operationsCommission, 450)
  assert.equal(september.metrics.periodOperatingProfit, 650)
  assert.equal(september.metrics.fullMonthsProfit, null)
  const october = f.overview('2026-10-01', '2026-10-13')
  assert.deepEqual(october.range, { start: '2026-10-01', end: '2026-10-13', days: 13 })
  assert.deepEqual(october.comparisonRange, { start: '2026-09-18', end: '2026-09-30', days: 13 })
  assert.equal(october.metrics.received, 26000)
  assert.equal(october.metrics.refunds, 0)
  assert.equal(october.metrics.estimatedReward, 3000)
  assert.equal(october.metrics.reward, 13000)
  assert.equal(october.metrics.expenses, 1500)
  assert.equal(october.metrics.periodOperatingProfit, 8500)
  assert.equal(october.metrics.payingCustomers, 2)
  assert.equal(october.metrics.repeatCustomers, 1)
  assert.equal(october.metrics.customerRepeatRate, 50)
  assert.equal(october.metrics.averageOrderAmount, 13000)
  assert.equal(october.comparison.received, 10000)
  assert.equal(october.changes.received, 160)
  assert.equal(october.metrics.playerPaid, 1000)
  assert.equal(october.metrics.playerAvailable, 16000)
  assert.equal(october.changes.playerAvailable, null)
  assert.equal(october.metrics.playerAccepted, 2)
  assert.equal(october.metrics.playerUnique, 1)
  assert.equal(october.metrics.playerCompletionRate, 100)
  const support = f.overview('2026-10-01', '2026-10-13', f.users.support.id)
  assert.equal(support.metrics.personalCompletedOrders, 2)
  assert.equal(support.metrics.personalNet, 29000)
  assert.equal(support.metrics.net, null)
  const operations = f.overview('2026-10-01', '2026-10-13', f.users.operations.id)
  assert.equal(operations.metrics.personalCompletedOrders, 2)
  assert.equal(operations.metrics.personalNet, 29000)
  assert.equal(operations.series.find((row) => row.date === '2026-10-01').personalNet, 9000)
})

test('完整月份才扣真实月度底薪，任意区间不日均摊工资，缺配置不会当零利润', (t) => {
  const f = fixture(t)
  const partial = f.overview('2026-09-30', '2026-10-06')
  assert.equal(partial.metrics.monthlyBase, null)
  assert.equal(partial.metrics.fullMonthsProfit, null)
  assert.equal(partial.metrics.periodOperatingProfit, 6150)
  const whole = f.overview('2026-09-01', '2026-10-31')
  assert.equal(whole.metrics.monthlyBase, 600000)
  assert.equal(whole.metrics.fullMonthsProfit, -590850)
  assert.equal(whole.metrics.profitIncomplete, 0)
  f.mutate('/salary-plans', {
    userId: f.users.support.id,
    mode: 'base_commission',
    base: null,
    rate: null,
    platformRates: {},
    effectiveFrom: '2026-11-01',
    hourlyEnabled: false
  })
  const unknownBase = f.overview('2026-11-01', '2026-11-30')
  assert.equal(unknownBase.metrics.monthlyBase, null)
  assert.equal(unknownBase.metrics.fullMonthsProfit, null)
  assert.equal(unknownBase.metrics.profitIncomplete, 1)
  assert.equal(unknownBase.metrics.periodOperatingProfit, 0)
  // 空白历史月的比较基数不假造为增长100%。
  assert.equal(unknownBase.changes.received, -100)
  assert.equal(f.overview('1900-01-01', '1900-01-31').changes.received, null)
  f.time('2026-11-02T02:00:00Z')
  const unconfigured = f.order({ amount: 10000, reward: 7000, paidAt: '2026-11-02T09:00:00+08:00' })
  f.complete(unconfigured)
  const incomplete = f.overview('2026-11-02', '2026-11-02')
  assert.equal(incomplete.metrics.periodOperatingProfit, null)
  assert.equal(incomplete.metrics.supportCommission, null)
  assert.equal(incomplete.metrics.profitIncomplete, 1)
  assert.equal(incomplete.series[0].profit, null)
})

test('当前角色实时权限保护概览，费用仅授权可见，私有钱包不泄露其他打手', (t) => {
  const f = fixture(t)
  const hr = f.overview('2026-10-01', '2026-10-13', f.users.hr.id)
  for (const key of [
    'received',
    'refunds',
    'net',
    'reward',
    'periodOperatingProfit',
    'fullMonthsProfit',
    'expenses',
    'payingCustomers',
    'playerAvailable',
    'playerPaid'
  ])
    assert.equal(hr.metrics[key], null, key)
  assert.ok(
    hr.series.every((row) => row.received === null && row.net === null && row.profit === null)
  )
  const player = f.overview('2026-10-01', '2026-10-13', f.users.player.id)
  assert.equal(player.metrics.playerAvailable, 16000)
  assert.equal(player.metrics.received, null)
  assert.equal(player.metrics.newCustomers, null)
  f.mutate('/users', { ...f.users.hr, permissionOverrides: { 'finance.expenses': true } })
  assert.equal(f.overview('2026-10-01', '2026-10-13', f.users.hr.id).metrics.expenses, 1500)
  f.mutate('/users', { ...f.users.hr, permissionOverrides: { 'profit.view': true } })
  const profitOnly = f.overview('2026-10-01', '2026-10-13', f.users.hr.id)
  assert.equal(profitOnly.metrics.received, 26000)
  assert.equal(profitOnly.metrics.payingCustomers, null)
  assert.ok(profitOnly.series.every((row) => row.payingCustomers === null))
  assert.equal(profitOnly.metrics.playerAvailable, null)
  f.mutate('/users', { ...f.users.hr, status: 'disabled' })
  assert.throws(
    () => f.overview('2026-10-01', '2026-10-13', f.users.hr.id),
    (error) => error instanceof ApiError && error.status === 403
  )
})

test('旧人员客户创建日期缺失保持未知，编辑保留历史，新记录使用真实创建时间', (t) => {
  const f = fixture(t)
  const state = JSON.parse(f.service.db.prepare('SELECT json FROM studio_state').get().json)
  delete state.users.find((row) => row.id === f.users.hr.id).createdAt
  delete state.customers.find((row) => row.id === f.customer.id).createdAt
  f.service.db.prepare('UPDATE studio_state SET json=?').run(JSON.stringify(state))
  f.time('2026-10-14T03:00:00Z')
  f.mutate('/users', { ...f.users.hr, name: '旧账号编辑' })
  f.mutate('/customers', { ...f.customer, name: '旧客户编辑' })
  f.mutate('/users', { ...f.users.player, name: '有日期账号编辑' })
  f.mutate('/customers', { ...f.newCustomer, name: '有日期客户编辑' })
  const report = f.overview('2026-10-01', '2026-10-14')
  assert.equal(report.metrics.newStaff, null)
  assert.equal(report.metrics.newCustomers, null)
  assert.equal(report.metrics.newPlayers, 0)
  assert.equal(report.creationDateCoverage.staff.unknown, 1)
  assert.equal(report.creationDateCoverage.customers.unknown, 1)
  assert.equal(report.creationDateCoverage.customers.inRange, 1)
  const data = f.service.bootstrap('admin', '2026-10')
  assert.equal(data.users.find((row) => row.id === f.users.hr.id).createdAt, undefined)
  assert.equal(data.customers.find((row) => row.id === f.customer.id).createdAt, undefined)
  assert.equal(
    data.users.find((row) => row.id === f.users.player.id).createdAt,
    '2026-09-01T02:00:00.000Z'
  )
  assert.equal(
    data.customers.find((row) => row.id === f.newCustomer.id).createdAt,
    '2026-10-13T02:00:00.000Z'
  )
  assert.ok(report.scopeNotes.some((note) => note.includes('不补造历史日期')))
})

test('日期校验、上海跨日和最长366天范围不会扩大或伪造比较数据', (t) => {
  const f = fixture(t)
  for (const input of [
    null,
    [],
    { start: '2026-02-30', end: '2026-03-01' },
    { start: '0000-01-01', end: '0000-01-02' },
    { start: '9999-12-30', end: '9999-12-31' },
    { start: '1899-12-31', end: '1900-01-01' },
    { start: '2026-10-03', end: '2026-10-01' },
    { start: '2025-01-01', end: '2026-01-02' },
    { start: '2026-01-01 OR 1=1', end: '2026-01-02' }
  ])
    assert.throws(
      () => f.service.overview('admin', input),
      (error) => error instanceof ApiError && error.status === 400
    )
  const valid = f.overview('2024-01-01', '2024-12-31')
  assert.equal(valid.range.days, 366)
  assert.equal(valid.comparisonRange.days, 366)
  const defaults = f.service.overview('admin')
  assert.equal(defaults.range.start, '2026-10-13')
  assert.equal(defaults.generatedAt, '2026-10-13T02:00:00.000Z')
  assert.equal(defaults.changes.net, null)
  const upperBound = f.overview('9998-12-31', '9998-12-31')
  assert.equal(upperBound.series.length, 1)
  assert.equal(upperBound.comparisonRange.start, '9998-12-30')
  const lowerBound = f.overview('1900-01-01', '1900-01-01')
  assert.equal(lowerBound.series.length, 1)
  assert.equal(lowerBound.comparisonRange.end, '1899-12-31')
})
