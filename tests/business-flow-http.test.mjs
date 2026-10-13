import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'

const password = 'isolated-end-to-end-123'
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

test('真实HTTP跨模块：人员来源→储值订单→免图验收→钱包提现→退款→工资考勤→全模块四种报表→数据检查', async (t) => {
  const server = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password,
    clock: () => new Date('2026-10-13T04:00:00Z')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const cookies = {}
  async function call(path, body, role = 'admin', expected = 200) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookies[role] ? { Cookie: cookies[role] } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const result = await response.json()
    assert.equal(response.status, expected, `${role} ${path}: ${result.message}`)
    return result
  }
  async function login(role, username = role) {
    const response = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    assert.equal(response.status, 200)
    cookies[role] = response.headers.get('set-cookie').split(';')[0]
    await response.json()
  }
  await login('admin')
  const level = await call('/levels', { name: '联动等级', delaySeconds: 0 })
  const platform = await call('/platforms', {
    name: '联动外部平台',
    rules: {
      requiresShop: true,
      requiresExternalOrderNo: true,
      requiresReceipt: false,
      allowPayOnArrival: false
    }
  })
  const shop = await call('/shops', { name: '联动店铺', platformId: platform.id })
  const users = {}
  for (const role of ['finance', 'hr', 'support', 'operations', 'player']) {
    users[role] = await call('/users', {
      username: `flow-${role}`,
      name: `联动${role}`,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 3,
      permissionOverrides: {},
      password
    })
    await login(role, users[role].username)
    if (role !== 'player')
      await call(
        '/salary-plans',
        {
          userId: users[role].id,
          mode: 'fixed',
          base: 10000,
          rate: null,
          platformRates: {},
          effectiveFrom: '2026-10-01',
          hourlyEnabled: false
        },
        'finance'
      )
  }
  const customer = await call(
    '/customers',
    { name: '联动老板', platformId: platform.id, contact: '', gameId: '0000123' },
    'support'
  )
  const externalOrderNo = '000012345678901234567890'
  await call(
    '/customer-order-references',
    { customerId: customer.id, platformId: platform.id, shopId: shop.id, externalOrderNo },
    'support'
  )
  assert.equal(
    (await call(`/customers/${customer.id}/order-references`, undefined, 'support')).total,
    1
  )
  const template = await call('/templates', {
    name: '联动项目',
    game: '联动游戏',
    amount: 10000,
    reward: 7000,
    active: true
  })
  await call(
    '/customer-transactions',
    {
      customerId: customer.id,
      kind: 'recharge',
      amount: 20000,
      reason: '充值',
      requestId: 'flow-recharge'
    },
    'finance'
  )
  await call(
    '/player-deposit-transactions',
    {
      userId: users.player.id,
      kind: 'deposit',
      amount: 10000,
      reason: '入店押金',
      requestId: 'flow-deposit'
    },
    'finance'
  )
  const order = await call(
    '/orders',
    {
      templateId: template.id,
      customerId: customer.id,
      platformId: platform.id,
      shopId: shop.id,
      externalOrderNo,
      gameId: '0000123',
      amount: 10000,
      reward: 7000,
      dispatchMode: 'direct',
      assignedTo: users.player.id,
      paymentMethod: 'balance',
      requestId: 'flow-order'
    },
    'support'
  )
  assert.equal(order.status, 'pending')
  assert.equal(
    (await call(`/customers/${customer.id}/balance`, undefined, 'support')).balance,
    10000
  )
  await call(
    `/orders/${order.id}/action`,
    {
      action: 'correct-status',
      status: 'review',
      leaderId: users.player.id,
      reason: '后台核验，无需截图'
    },
    'finance'
  )
  const reviewed = await call(`/orders/${order.id}/action`, { action: 'review-pass' }, 'finance')
  assert.equal(reviewed.status, 'completed')
  assert.equal(reviewed.submissions.at(-1).screenshots.length, 0)
  assert.equal(
    (await call(`/players/${users.player.id}/orders`, undefined, 'finance')).records[0].id,
    order.id
  )
  assert.equal((await call('/player/wallet', undefined, 'player')).available, 7000)
  const withdrawal = await call('/player/withdrawals', { amount: 7000 }, 'player')
  await call(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' }, 'finance')
  const receipt = await call(
    '/uploads',
    { name: '真实资金凭证测试.png', mime: 'image/png', data: png },
    'finance'
  )
  await call(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt }, 'finance')
  const refund = await call(
    '/refunds',
    { orderId: order.id, amount: 1000, reason: '部分退款', requestId: 'flow-refund' },
    'finance'
  )
  assert.equal(refund.manualRewardReview, true)
  assert.equal(
    (await call(`/customers/${customer.id}/balance`, undefined, 'finance')).balance,
    11000
  )
  await call(
    `/refunds/${refund.id}/action`,
    { action: 'resolve', reason: '已人工核对无需追回' },
    'finance'
  )
  await call(
    '/player-adjustments',
    {
      userId: users.player.id,
      kind: 'supplement',
      amount: 1000,
      reason: '补款',
      requestId: 'flow-supplement'
    },
    'finance'
  )
  const deduction = await call(
    '/player-adjustments',
    {
      userId: users.player.id,
      kind: 'deduction',
      amount: 1500,
      reason: '扣款',
      requestId: 'flow-deduction'
    },
    'finance'
  )
  assert.equal(deduction.manualAmount, 500)
  await call(
    `/player-adjustments/${deduction.id}/action`,
    { action: 'resolve', resolution: 'recovered', reason: '线下已追回' },
    'finance'
  )
  assert.equal(
    (await call(`/players/${users.player.id}/deposit`, undefined, 'finance')).balance,
    10000
  )
  await call(
    '/work-schedules',
    {
      userId: users.support.id,
      effectiveFrom: '2026-10-13',
      enabled: true,
      start: '20:00',
      end: '04:00',
      remark: '夜班'
    },
    'hr'
  )
  assert.equal((await call('/bootstrap', undefined, 'hr')).attendance.length, 0)
  await call(
    '/attendance',
    {
      userId: users.support.id,
      date: '2026-10-13',
      start: '20:00',
      end: '04:00',
      status: 'normal',
      actualHours: 6,
      remark: '单独登记工时'
    },
    'hr'
  )
  const expense = await call(
    '/expenses',
    { category: '设备', amount: 1000, date: '2026-10-13', purpose: '设备费用', receipt },
    'finance'
  )
  await call(`/expenses/${expense.id}/action`, { action: 'delete' }, 'finance')
  await call(`/expenses/${expense.id}/action`, { action: 'restore' }, 'finance')
  const payroll = await call('/payrolls', { month: '2026-10' }, 'finance')
  assert.equal(payroll.lines.length, 4)
  const overview = await call('/overview?start=2026-10-13&end=2026-10-13')
  assert.equal(overview.metrics.received, 10000)
  const catalog = await call('/exports/catalog?month=2026-10')
  assert.ok(catalog.modules.some((module) => module.id === 'workSchedules'))
  const modules = catalog.modules.map((module) => ({
    id: module.id,
    fields: module.fields.map((field) => field.key)
  }))
  for (const type of ['daily', 'weekly', 'monthly', 'total']) {
    const body = { month: '2026-10', period: { type, date: '2026-10-13' }, modules }
    const preview = await call('/exports/preview', body)
    const download = await call('/exports/download', body)
    assert.equal(download.sheets.length, modules.length)
    assert.deepEqual(
      preview.sheets.map((sheet) => sheet.rowCount),
      download.sheets.map((sheet) => sheet.rowCount)
    )
    const schedule = download.sheets.find((sheet) => sheet.id === 'workSchedules')
    assert.equal(schedule.rowCount, 1)
  }
  await call('/exports/catalog', undefined, 'support', 403)
  const archive = await call('/logs/maintenance', { action: 'archive' })
  assert.equal(archive.affectedRows, 0)
  assert.ok((await call('/logs?entity=work-schedule')).total > 0)
  const diagnostics = await call('/diagnostics')
  assert.equal(diagnostics.summary.errorCount, 0, JSON.stringify(diagnostics.issues))
  const saved = await call('/bootstrap')
  assert.equal(saved.orders.length, 1)
  const finalWallet = await call('/player/wallet', undefined, 'player')
  assert.equal(finalWallet.earned, 7000)
  assert.equal(finalWallet.paid, 7000)
  assert.equal(finalWallet.available, 0)
  assert.equal(saved.attendance[0].actualHours, 6)
})

test('固定班次检查发现损坏和重复版本，旧数据无此字段兼容', (t) => {
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password })
  t.after(() => server.service.close())
  const service = server.service
  const state = JSON.parse(
    service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  )
  state.workSchedules = [
    {
      id: 'a',
      userId: 'admin',
      effectiveFrom: '2026-10-13',
      enabled: true,
      start: '09:00',
      end: '09:00'
    },
    {
      id: 'b',
      userId: 'admin',
      effectiveFrom: '2026-10-13',
      enabled: true,
      start: '09:00',
      end: '18:00'
    }
  ]
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  const report = service.diagnostics('admin')
  assert.ok(
    report.issues.some((row) => row.entity === 'work-schedule' && row.message.includes('时间无效'))
  )
  assert.ok(
    report.issues.some((row) => row.entity === 'work-schedule' && row.message.includes('重复'))
  )
})
