import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'
import { testMutate } from './helpers/current-intent.mjs'
import { withdrawalBody } from './player-test-helpers.mjs'

const PASSWORD = 'overview-details-isolated-password'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const dates = { start: '2026-10-01', end: '2026-10-14' }

function fixture(t, count = 4) {
  let clock = new Date('2026-10-10T02:00:00Z')
  const service = createStudioService({ dbPath: ':memory:', password: PASSWORD, seed: false,
    clock: () => clock })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '即时等级', delaySeconds: 0 })
  let userNumber = 0
  const user = (name, role, permissionOverrides = {}) => mutate('/users', {
    username: `detail-${++userNumber}`, name, role, status: 'active', maxActiveOrders: 5, levelId: level.id,
    permissionOverrides, password: PASSWORD
  })
  const support = user('客服', 'support')
  const player = user('打手', 'player')
  const profit = user('仅经营', 'hr', { 'profit.view': true, 'attendance.manage': false })
  const expense = user('仅费用', 'hr', { 'finance.expenses': true, 'attendance.manage': false })
  const none = user('无明细', 'hr', { 'attendance.manage': false })
  const customer = mutate('/customers', {
    name: '授权客户', contact: 'CONTACT-PRIVATE', gameId: 'CUSTOMER-PRIVATE', remark: 'CUSTOMER-REMARK'
  })
  const template = mutate('/templates', {
    name: '公开任务', game: '三角洲', description: 'TEMPLATE-PRIVATE', amount: 10000,
    reward: 2000, map: '不限', remark: '', active: true
  })
  const create = (options = {}, actor = support.id) => mutate('/orders', {
    templateId: template.id, customerId: customer.id, platformId: 'hall',
    roomCode: 'ROOM-PRIVATE', gameId: 'GAME-PRIVATE', receivedAmount: 10000,
    receipt: service.upload(actor, { name: 'private-receipt.png', mime: 'image/png', data: PNG }),
    paidAt: '2026-10-05T10:00:00+08:00', dispatchMode: 'pool',
    remark: 'NOTE-PRIVATE', ...options
  }, actor)
  const orders = Array.from({ length: count }, () => create())
  const details = (metric, view, input = {}, actor = 'admin') =>
    service.overviewDetails(actor, { ...dates, metric, ...(view ? { view } : {}), ...input })
  const time = (value) => { clock = new Date(value) }
  const upload = (actor = 'admin') => service.upload(actor, { name: 'private.png', mime: 'image/png', data: PNG })
  const complete = (order) => {
    mutate(`/player/orders/${order.id}/claim`, {}, player.id)
    mutate(`/player/orders/${order.id}/submit`, { screenshots: [upload(player.id)] }, player.id)
    mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  }
  const legacyPartial = (order, amount) => {
    // Older stored orders may contain partial receipts; the new read must include them
    // without weakening current full-payment creation or submission rules.
    const state = JSON.parse(service.db.prepare('SELECT json FROM studio_state').get().json)
    state.orders.find((row) => row.id === order.id).receivedAmount = amount
    service.db.prepare('UPDATE studio_state SET json=?').run(JSON.stringify(state))
    return { ...order, receivedAmount: amount }
  }
  return { service, mutate, support, player, profit, expense, none, customer, template,
    orders, create, details, time, upload, complete, legacyPartial }
}

test('明细使用全量授权订单而非当前页，summary与同次overview一致，部分收款也在付款集合', (t) => {
  const f = fixture(t, 27)
  const partial = f.legacyPartial(f.create(), 1700)
  const page = f.details('received', 'paid-orders', { size: 3, current: 4 })
  assert.equal(page.total, 28)
  assert.equal(page.records.length, 3)
  assert.equal(page.summary.received, 271700)
  assert.equal(page.summary.orderCount, 28)
  assert.deepEqual(page.summary, page.overview.metrics)
  assert.deepEqual(page.overview, f.service.overview('admin', dates))
  const hit = f.details('received', 'paid-orders', { keyword: partial.orderNo, size: 1 })
  assert.equal(hit.total, 1)
  assert.equal(hit.records[0].received, 1700)
  assert.equal(hit.summary.received, page.summary.received)
  assert.equal(f.service.ordersPage('admin', { payment: 'paid', size: 100 }).total, 27)
  const beyond = f.details('received', 'paid-orders', { current: 99, size: 3 })
  assert.equal(beyond.total, 28)
  assert.deepEqual(beyond.records, [])
})

test('分类聚合使用全匹配集且明确100组截断，项目使用历史价格快照', (t) => {
  const f = fixture(t, 0)
  // Durable legacy snapshots exercise classification capacity without manufacturing current templates.
  const state = JSON.parse(f.service.db.prepare('SELECT json FROM studio_state').get().json)
  for (let i = 0; i < 105; i++) state.orders.push({
    id: `legacy-${i}`, orderNo: `LEGACY-${i}`, title: '历史任务', customerId: f.customer.id,
    platformId: 'hall', shopId: null, amount: 1000, reward: 200, receivedAmount: 1000,
    paidAt: '2026-10-03T01:00:00Z', createdAt: '2026-10-03T01:00:00Z', creatorId: f.support.id,
    status: 'pending', assignments: [], submissions: [], snapshot: {
      name: '同名项目', game: `游戏${i}`, amount: 1000 + i, reward: 200
    }
  })
  f.service.db.prepare('UPDATE studio_state SET json=?').run(JSON.stringify(state))
  const result = f.details('received', 'by-game', { size: 1 })
  assert.equal(result.total, 105)
  assert.equal(result.records.length, 1)
  assert.equal(result.groups.length, 100)
  assert.deepEqual(result.groupsInfo, { dimension: 'game', total: 105, returned: 100, truncated: true,
    amountLabel: '收款', countLabel: '付款订单数' })
  assert.equal(result.groups.reduce((sum, row) => sum + row.count, 0), 100)
  assert.equal(result.summary.received, 105000)
  const projects = f.details('received', 'by-project', { size: 100 })
  assert.equal(projects.total, 105)
  assert.ok(projects.records.every((row) => row.label === '同名项目' && Number.isInteger(row.snapshotAmount)))
  assert.equal(f.details('received', 'by-game', { keyword: '游戏104' }).total, 1)
})

test('各事件集合独立，客户复购截至期末历史，平均金额仍按付款单数', (t) => {
  const f = fixture(t, 0)
  f.create({ paidAt: '2026-09-30T10:00:00+08:00' })
  const current = f.legacyPartial(f.create(), 3000)
  const canceled = f.create()
  f.time('2026-10-11T02:00:00Z')
  f.mutate(`/orders/${canceled.id}/action`, { action: 'cancel', reason: '测试取消' })
  const customers = f.details('customers', 'paying-customers')
  assert.equal(customers.total, 1)
  assert.equal(customers.records[0].paidOrders, 2)
  assert.equal(customers.records[0].lifetimePaidOrdersUntilEnd, 3)
  assert.equal(customers.records[0].repeat, '复购')
  assert.equal(customers.summary.averageOrderAmount, 6500)
  assert.equal(f.details('customers', 'repeat-customers').total, 1)
  assert.equal(f.details('orders', 'created-orders').total, 3)
  assert.equal(f.details('orders', 'paid-orders').total, 2)
  assert.equal(f.details('orders', 'canceled-orders').total, 1)
  const byStatus = f.details('orders', 'by-status')
  assert.equal(byStatus.groups.reduce((sum, row) => sum + row.count, 0), 2)
  assert.equal(f.details('received', 'paid-orders', { keyword: current.orderNo }).total, 1)
})

test('有退款的收入分类仍画原收款，个人分类画本人净业绩且元数据明确金额和数量', (t) => {
  const f = fixture(t, 0)
  const orders = [0, 1].map((index) => f.create({ platformId: 'xianyu', shopId: 'jindun',
    externalOrderNo: `GROUP-REFUND-${index}` }))
  for (const order of orders) f.complete(order)
  f.mutate('/refunds', { orderId: orders[0].id, amount: 2000, reason: '分类口径退款测试' })
  for (const [metric, view] of [['received', 'by-game'], ['received', 'by-project'],
    ['received', 'by-platform'], ['orders', 'by-status'], ['customers', 'by-game']]) {
    const result = f.details(metric, view)
    assert.equal(result.summary.received, 20000)
    assert.equal(result.summary.net, 18000)
    assert.equal(result.groups.reduce((sum, row) => sum + row.amount, 0), result.summary.received)
    assert.notEqual(result.groups.reduce((sum, row) => sum + row.amount, 0), result.summary.net)
    assert.equal(result.groupsInfo.amountLabel, result.columns.find((row) => row.key === 'received').label)
    assert.ok(result.groupsInfo.countLabel.includes(metric === 'customers' ? '付费客户数' : '付款订单数'))
  }
  for (const view of ['by-game', 'completed-orders']) {
    const result = f.details('personal', view, {}, f.support.id)
    assert.equal(result.groups.reduce((sum, row) => sum + row.amount, 0), 18000)
    assert.equal(result.groups.reduce((sum, row) => sum + row.amount, 0), result.summary.personalNet)
    assert.equal(result.groupsInfo.amountLabel, result.columns.find((row) => row.key === 'net').label)
    assert.equal(result.groupsInfo.countLabel, '本人完成订单数')
  }
})

test('钱包、费用、日期与接单分类caption来自真实字段，空分类仍保持当前视图口径', (t) => {
  const f = fixture(t, 0)
  const cases = [
    ['wallet', 'balances', 'available', '打手钱包数'],
    ['wallet', 'paid-withdrawals', 'amount', '已发提现记录数'],
    ['wallet', 'in-flight-withdrawals', 'amount', '在途提现记录数'],
    ['expenses', 'expense-records', 'amount', '费用登记记录数'],
    ['expenses', 'reward-adjustments', 'expenseDelta', '报酬调整记录数'],
    ['profit', 'days', 'profit', '自然日数'],
    ['received', 'days', 'received', '自然日数'],
    ['accepted', 'assignments', null, '接单次数'],
    ['accepted', 'accepted-orders', null, '去重接单订单数'],
    ['accepted', 'by-player', null, '接单次数'],
    ['people', 'new-staff', null, '员工档案数'],
    ['people', 'new-players', null, '打手档案数'],
    ['people', 'current-people', null, '人员档案数'],
    ['people', 'unknown-date', null, '日期待确认档案数']
  ]
  for (const [metric, view, field, countLabel] of cases) {
    const result = f.details(metric, view)
    assert.equal(result.groupsInfo.countLabel, countLabel)
    assert.equal(result.groupsInfo.amountLabel, field ?
      result.columns.find((row) => row.key === field).label : '无金额口径')
  }
  const emptyIncome = f.details('received', 'by-game')
  assert.equal(emptyIncome.groupsInfo.dimension, 'game')
  assert.equal(emptyIncome.groupsInfo.amountLabel, '收款')
  assert.equal(emptyIncome.groupsInfo.countLabel, '付款订单数')
  assert.deepEqual(emptyIncome.groups, [])
})

test('费用分项保留登记、补款和已追回扣款净额，关联调整归原付款日', (t) => {
  const f = fixture(t, 1)
  f.mutate('/expenses', { category: '房租', amount: 1200, date: '2026-10-05',
    purpose: 'EXPENSE-PRIVATE', receipt: f.upload() })
  f.mutate('/player-adjustments', { userId: f.player.id, kind: 'supplement', amount: 1000,
    orderId: f.orders[0].id, reason: 'ADJUSTMENT-PRIVATE' })
  const deduction = f.mutate('/player-adjustments', { userId: f.player.id, kind: 'deduction',
    amount: 1500, orderId: f.orders[0].id, reason: '扣款' })
  f.mutate(`/player-adjustments/${deduction.id}/action`, {
    action: 'resolve', resolution: 'recovered', reason: '已追回500'
  })
  const options = { start: '2026-10-05', end: '2026-10-05' }
  const registered = f.details('expenses', 'expense-records', options)
  const adjusted = f.details('expenses', 'reward-adjustments', options)
  assert.equal(registered.total, 1)
  assert.equal(adjusted.total, 2)
  assert.equal(adjusted.records.reduce((sum, row) => sum + row.expenseDelta, 0), -500)
  assert.equal(adjusted.summary.expenses, 700)
  assert.ok(adjusted.records.every((row) => row.effectiveDate === '2026-10-05'))
  assert.equal(f.details('expenses', 'reward-adjustments', {
    start: '2026-10-10', end: '2026-10-10'
  }).total, 0)
  const expenseOnly = f.details('expenses', 'expense-records', options, f.expense.id)
  assert.equal(expenseOnly.summary.expenses, 1200)
  assert.throws(() => f.details('expenses', 'reward-adjustments', options, f.expense.id),
    (error) => error instanceof ApiError && error.status === 403)
  assert.throws(() => f.details('expenses', 'reward-adjustments', options, f.profit.id),
    (error) => error.status === 403)
})

test('逐次接单与去重订单分开，本人完成业绩不能变全店业绩，未知成本不补零', (t) => {
  const f = fixture(t, 2)
  const order = f.orders[0]
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.player.id)
  f.mutate(`/orders/${order.id}/action`, { action: 'release', reason: '重新分配' })
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.player.id)
  f.mutate(`/player/orders/${order.id}/submit`, { screenshots: [f.upload(f.player.id)] }, f.player.id)
  f.mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  const other = f.create({}, 'admin')
  f.complete(other)
  assert.equal(f.details('accepted', 'assignments').total, 3)
  assert.equal(f.details('accepted', 'accepted-orders').total, 2)
  const byPlayer = f.details('accepted', 'by-player').records[0]
  assert.equal(byPlayer.count, 3)
  assert.equal(byPlayer.acceptedOrders, 2)
  assert.equal(byPlayer.completedOrders, 2)
  assert.equal(byPlayer.completionRate, 100)
  const personal = f.details('personal', 'completed-orders', {}, f.support.id)
  assert.equal(personal.total, 1)
  assert.equal(personal.records[0].id, order.id)
  assert.equal(personal.records[0].net, personal.summary.personalNet)
  assert.equal(personal.summary.personalCompletedOrders, 1)
  const costs = f.details('profit', 'cost-orders')
  const unknown = costs.records.find((row) => row.id === order.id)
  assert.equal(unknown.supportCommission, null)
  assert.equal(unknown.incomplete, '待确认')
  assert.equal(costs.summary.periodOperatingProfit, null)
})

test('当前钱包和在途占用不受日期过滤，已发按实际发放日且不公开支付图片', (t) => {
  const f = fixture(t, 1)
  f.complete(f.orders[0])
  const pending = f.mutate('/player/withdrawals', withdrawalBody(f.service, f.player.id, 500), f.player.id)
  f.time('2026-10-12T02:00:00Z')
  const paid = f.mutate('/player/withdrawals', withdrawalBody(f.service, f.player.id, 600), f.player.id)
  f.mutate(`/withdrawals/${paid.id}/action`, { action: 'approve' })
  f.mutate(`/withdrawals/${paid.id}/action`, { action: 'pay', receipt: f.upload() })
  f.mutate('/users', { ...f.player, status: 'disabled' })
  const old = { start: '2026-01-01', end: '2026-01-01' }
  const balances = f.details('wallet', 'balances', old)
  assert.equal(balances.total, 1)
  assert.equal(balances.records[0].status, 'disabled')
  assert.equal(balances.records[0].occupied, 500)
  assert.equal(balances.records[0].available, 900)
  assert.equal(f.details('wallet', 'in-flight-withdrawals', old).records[0].id, pending.id)
  assert.equal(f.details('wallet', 'paid-withdrawals', old).total, 0)
  const issued = f.details('wallet', 'paid-withdrawals', { start: '2026-10-12', end: '2026-10-12' })
  assert.equal(issued.total, 1)
  assert.equal(issued.summary.playerPaid, 600)
  assert.equal(issued.records[0].paidAt.slice(0, 10), '2026-10-12')
  assert.ok(!JSON.stringify(issued).includes('paymentSnapshot'))
  assert.ok(!JSON.stringify(issued).includes('/uploads/'))
})

test('人员缺日期保留未知，分页总数来自全档案且权限逐视图裁决', (t) => {
  const f = fixture(t, 1)
  const state = JSON.parse(f.service.db.prepare('SELECT json FROM studio_state').get().json)
  delete state.users.find((row) => row.id === f.support.id).createdAt
  f.service.db.prepare('UPDATE studio_state SET json=?').run(JSON.stringify(state))
  const unknown = f.details('people', 'unknown-date', { size: 1 })
  assert.ok(unknown.total >= 1)
  assert.equal(unknown.summary.newStaff, null)
  const support = f.details('people', 'unknown-date', { keyword: '客服' })
  assert.equal(support.total, 1)
  assert.equal(support.records[0].createdAt, null)
  assert.equal(f.details('people', 'new-staff', { keyword: '客服' }).total, 0)
  assert.equal(f.details('people', 'current-people', { size: 1 }).total, state.users.length)
  assert.throws(() => f.details('people', 'current-people', {}, f.profit.id), (e) => e.status === 403)
})

test('白名单搜索不命中私人字段，无权和打手override拒绝，所有读取保持无副作用', (t) => {
  const f = fixture(t, 4)
  assert.equal(f.service.orderDetail('admin', f.orders[0].id).order.remark, 'NOTE-PRIVATE')
  for (const keyword of ['NOTE-PRIVATE', 'ROOM-PRIVATE', 'GAME-PRIVATE', 'CONTACT-PRIVATE', 'TEMPLATE-PRIVATE'])
    assert.equal(f.details('received', 'paid-orders', { keyword }).total, 0)
  const json = JSON.stringify(f.details('received', 'paid-orders'))
  for (const privateValue of ['NOTE-PRIVATE', 'ROOM-PRIVATE', 'GAME-PRIVATE', 'CONTACT-PRIVATE', 'CUSTOMER-PRIVATE'])
    assert.ok(!json.includes(privateValue))
  const profit = f.details('received', 'days', {}, f.profit.id)
  assert.equal(profit.capabilities.views.find((row) => row.id === 'paid-orders').allowed, false)
  assert.throws(() => f.details('received', 'paid-orders', {}, f.profit.id), (e) => e.status === 403)
  assert.throws(() => f.details('orders', null, {}, f.none.id), (e) => e.status === 403)
  f.mutate('/users', { ...f.player, permissionOverrides: { 'orders.view': true, 'profit.view': true } })
  assert.throws(() => f.details('received', 'paid-orders', {}, f.player.id), (e) => e.status === 403)
  const before = f.service.db.prepare('SELECT total_changes() AS n').get().n
  const stateBefore = f.service.db.prepare('SELECT json FROM studio_state').get().json
  const first = f.details('received', 'days')
  for (const metric of ['received', 'orders', 'customers', 'profit', 'people', 'wallet', 'accepted', 'expenses', 'personal']) {
    const initial = f.details(metric)
    for (const view of initial.capabilities.views.filter((row) => row.allowed)) f.details(metric, view.id)
  }
  assert.equal(f.service.db.prepare('SELECT total_changes() AS n').get().n, before)
  assert.equal(f.service.db.prepare('SELECT json FROM studio_state').get().json, stateBefore)
  assert.equal(first.summary.received, 40000)
})

test('严格参数与未确认终端明确拒绝，HTTP会话撤销和打手隔离仍有效', async (t) => {
  const server = createStudioServer({ dbPath: ':memory:', password: PASSWORD, seed: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const endpoint = '/overview/details?metric=received&start=2026-10-01&end=2026-10-14'
  assert.equal((await fetch(base + endpoint)).status, 401)
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = (path) => fetch(base + path, { headers: { Cookie: cookie } })
  const response = await get(endpoint)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  for (const suffix of ['&current=0', '&size=101', '&size=0', '&current=1.5', '&view=missing',
    '&keyword=' + 'a'.repeat(101), '&start=2026-02-30', '&end=2026-09-30'])
    assert.equal((await get(endpoint + suffix)).status, 400, suffix)
  const unsupported = await get(endpoint + '&view=by-terminal')
  assert.equal(unsupported.status, 400)
  assert.equal((await unsupported.json()).code, 'OVERVIEW_VIEW_UNSUPPORTED')
  const level = testMutate(server.service, 'admin', '/levels', { name: 'HTTP等级', delaySeconds: 0 })
  const player = testMutate(server.service, 'admin', '/users', { username: 'http-player-details', name: '打手', levelId: level.id,
    role: 'player', status: 'active', maxActiveOrders: 1, password: PASSWORD,
    permissionOverrides: { 'profit.view': true, 'orders.view': true } })
  const playerLogin = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: player.username, password: PASSWORD }) })
  const playerCookie = playerLogin.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(base + endpoint, { headers: { Cookie: playerCookie } })).status, 403)
  await fetch(base + '/logout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal((await get(endpoint)).status, 401)
})
