import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStudioService, ApiError, shanghaiDate, ALL_PERMISSIONS } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'

const PASSWORD = 'test-only-password-248!'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const rejects = (fn, status) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status)

function fixture(t, { server = false, dbPath = ':memory:' } = {}) {
  let current = new Date('2026-10-12T04:00:00.000Z')
  const options = { dbPath, password: PASSWORD, seed: false, clock: () => current }
  const app = server ? createStudioServer(options) : null
  const service = app ? app.service : createStudioService(options)
  t.after(() => (app ? new Promise((resolve) => app.close(resolve)) : service.close()))
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, body)
  const level = mutate('/levels', { name: '测试优先等级', delaySeconds: 0 })
  const users = {}
  for (const [name, role] of [
    ['support', 'support'],
    ['operations', 'operations'],
    ['finance', 'finance'],
    ['player1', 'player'],
    ['player2', 'player']
  ])
    users[name] = mutate('/users', {
      username: name,
      name,
      role,
      status: 'active',
      maxActiveOrders: 1,
      levelId: level.id,
      permissionOverrides: {},
      password: PASSWORD
    })
  const customer = mutate('/customers', {
    name: '测试客户',
    contact: '',
    gameId: 'game-test',
    remark: ''
  })
  const template = mutate('/templates', {
    name: '测试订单',
    game: '三角洲行动',
    description: '测试',
    amount: 8800,
    reward: 7000,
    map: '不限',
    remark: '测试备注',
    active: true
  })
  const order = (overrides = {}, actor = users.support.id) =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId: 'xianyu',
        shopId: 'jindun',
        externalOrderNo: `TEST-${Math.random()}`,
        channel: '闲鱼',
        roomCode: 'ROOM1',
        gameId: '',
        amount: 8800,
        reward: 7000,
        receivedAmount: 8800,
        paidAt: '2026-10-10T18:00:00+08:00',
        dispatchMode: 'pool',
        ...overrides
      },
      actor
    )
  const upload = (actor) =>
    service.upload(actor, { name: 'test.png', mime: 'image/png', data: PNG })
  const complete = (record, { leader = users.player1.id, teammateId = null } = {}) => {
    mutate(`/player/orders/${record.id}/claim`, {}, leader)
    mutate(
      `/player/orders/${record.id}/submit`,
      { screenshots: [upload(leader)], teammateId },
      leader
    )
    return mutate(`/orders/${record.id}/action`, { action: 'review-pass' })
  }
  const salaries = (date = '2026-10-01') => {
    mutate('/salary-plans', {
      userId: users.support.id,
      mode: 'base_commission',
      base: 300000,
      rate: 1000,
      platformRates: {},
      effectiveFrom: date,
      hourlyEnabled: false
    })
    mutate('/salary-plans', {
      userId: users.operations.id,
      mode: 'base_commission',
      base: 400000,
      rate: null,
      platformRates: { xianyu: 500, xiaohongshu: 500 },
      effectiveFrom: date,
      hourlyEnabled: false
    })
    mutate('/salary-plans', {
      userId: users.finance.id,
      mode: 'fixed',
      base: 350000,
      rate: null,
      platformRates: {},
      effectiveFrom: date,
      hourlyEnabled: false
    })
  }
  return {
    service,
    app,
    mutate,
    users,
    level,
    customer,
    template,
    order,
    upload,
    complete,
    salaries,
    setTime: (value) => {
      current = new Date(value)
    },
    data: (month = '2026-10', actor = 'admin') => service.bootstrap(actor, month)
  }
}

test('真实登录使用哈希密码和会话，错误或停用账号不能登录', (t) => {
  const f = fixture(t)
  rejects(() => f.service.login('admin', 'incorrect'), 401)
  const loggedIn = f.service.login('admin', PASSWORD)
  assert.equal(f.service.session(loggedIn.token).id, 'admin')
  const stored = JSON.parse(f.service.db.prepare('SELECT json FROM studio_state').get().json)
  assert.ok(!JSON.stringify(stored).includes(PASSWORD))
  assert.equal(stored.passwords.admin.split(':').length, 2)
  f.service.logout(loggedIn.token)
  assert.equal(f.service.session(loggedIn.token), null)
  const player = f.users.player1
  f.mutate('/users', { ...player, status: 'disabled' })
  rejects(() => f.service.login(player.username, PASSWORD), 401)
})

test('超管拥有全部权限；普通管理员不能创建、修改或重置超管，管理员默认不开放财务', (t) => {
  const f = fixture(t)
  const root = f.data().user
  assert.equal(root.role, 'super_admin')
  assert.deepEqual(f.data().permissions, ALL_PERMISSIONS)
  const admin = f.mutate('/users', {
    username: 'normal-admin',
    name: '普通管理员',
    role: 'admin',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: PASSWORD
  })
  const adminData = f.data('2026-10', admin.id)
  assert.ok(adminData.permissions.includes('users.manage'))
  assert.ok(!adminData.permissions.includes('profit.view'))
  assert.ok(!adminData.permissions.includes('finance.review'))
  rejects(() => f.mutate('/users', { ...root, name: '越权修改' }, admin.id), 403)
  rejects(() => f.mutate('/users', { ...root, password: 'reset-not-allowed' }, admin.id), 403)
  rejects(() => f.mutate('/users', { ...admin, role: 'super_admin' }, admin.id), 403)
  rejects(() => f.mutate('/users', { ...root, role: 'admin' }), 400)
  f.mutate('/users', {
    ...root,
    permissionOverrides: { 'users.manage': false, 'profit.view': false }
  })
  assert.deepEqual(f.data().permissions, ALL_PERMISSIONS)
})

test('旧版管理员迁移为超管，重启仍保留原订单、密码和会话', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'studio-migration-'))
  const dbPath = join(folder, 'studio.sqlite')
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const first = createStudioService({ dbPath, password: PASSWORD, seed: true })
  const loggedIn = first.login('admin', PASSWORD)
  const oldState = JSON.parse(first.db.prepare('SELECT json FROM studio_state').get().json)
  oldState.users.find((u) => u.id === 'admin').role = 'admin'
  delete oldState.schemaVersion
  first.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(oldState))
  first.close()
  const second = createStudioService({ dbPath, seed: false })
  try {
    assert.equal(second.session(loggedIn.token).role, 'super_admin')
    assert.equal(second.login('admin', PASSWORD).user.id, 'admin')
    assert.deepEqual(second.bootstrap('admin').orders, oldState.orders)
  } finally {
    second.close()
  }
})

test('客服接口响应隐藏工资、利润、其他个人权限及计提快照，不能修改模板或审核', (t) => {
  const f = fixture(t)
  f.salaries()
  const order = f.complete(f.order())
  const own = f.data('2026-10', f.users.support.id)
  assert.equal(own.orders.length, 1)
  assert.equal(own.orders[0].commissionSnapshot, undefined)
  assert.deepEqual(own.salaryPlans, [])
  assert.deepEqual(own.payrolls, [])
  assert.deepEqual(own.reports.payroll, [])
  assert.equal(own.reports.monthlyProfit, null)
  assert.deepEqual(own.reports.days, [])
  assert.deepEqual(
    own.reports.performance.map((p) => p.userId),
    [f.users.support.id]
  )
  assert.deepEqual(own.users.find((u) => u.id === 'admin').permissionOverrides, {})
  const remark = f.mutate(
    `/orders/${order.id}/action`,
    { action: 'remark', remark: '完成后补充备注' },
    f.users.support.id
  )
  assert.equal(remark.commissionSnapshot, undefined)
  assert.equal(remark.creatorId, f.users.support.id)
  assert.ok(own.logs.every((log) => !JSON.stringify(log).includes('commissionSnapshot')))
  rejects(() => f.mutate('/templates', { ...f.template, amount: 10 }, f.users.support.id), 403)
  rejects(
    () =>
      f.mutate(
        `/orders/${order.id}/action`,
        { action: 'adjust', amount: 1, reward: 0, reason: '非法调整' },
        f.users.support.id
      ),
    403
  )
})

test('普通订单必须收款、非闲鱼必须凭证、落地付仅大厅、平台单号保留长文本', (t) => {
  const f = fixture(t)
  rejects(() => f.order({ receivedAmount: 0 }), 400)
  rejects(
    () => f.order({ platformId: 'xiaohongshu', shopId: null, externalOrderNo: '', receipt: null }),
    400
  )
  rejects(() => f.order({ payOnArrival: true }), 400)
  const hall = f.order({
    platformId: 'hall',
    shopId: null,
    externalOrderNo: '',
    payOnArrival: true,
    receivedAmount: 0,
    paidAt: null
  })
  assert.equal(hall.receivedAmount, 0)
  const receipt = f.upload(f.users.support.id)
  f.mutate(
    `/orders/${hall.id}/action`,
    { action: 'confirm-payment', receivedAmount: 8800, paidAt: '2026-10-11', receipt },
    f.users.support.id
  )
  rejects(
    () =>
      f.mutate(
        `/orders/${hall.id}/action`,
        { action: 'confirm-payment', receivedAmount: 8800, paidAt: '2026-10-11', receipt },
        f.users.support.id
      ),
    409
  )
  rejects(() => f.mutate('/refunds', { orderId: hall.id, amount: 100, reason: '大厅退款' }), 400)
  const number = '9999999999999999999999999999'
  assert.equal(f.order({ externalOrderNo: number }).externalOrderNo, number)
  rejects(() => f.order({ externalOrderNo: number }), 409)
})

test('等级延迟、指定接单、接单上限及解除后原负责人权限由服务端控制', (t) => {
  const f = fixture(t)
  const late = f.mutate('/levels', { name: '延迟等级', delaySeconds: 60 })
  f.mutate('/users', { ...f.users.player2, levelId: late.id })
  const first = f.order()
  rejects(() => f.mutate(`/player/orders/${first.id}/claim`, {}, f.users.player2.id), 403)
  f.mutate(`/player/orders/${first.id}/claim`, {}, f.users.player1.id)
  rejects(() => f.mutate(`/player/orders/${first.id}/claim`, {}, f.users.player1.id), 409)
  const second = f.order({ dispatchMode: 'direct', assignedTo: f.users.player1.id })
  rejects(() => f.mutate(`/player/orders/${second.id}/claim`, {}, f.users.player1.id), 409)
  rejects(() => f.mutate(`/player/orders/${second.id}/claim`, {}, f.users.player2.id), 403)
  f.mutate(
    `/orders/${first.id}/action`,
    { action: 'release', reason: '临时离开' },
    f.users.support.id
  )
  rejects(
    () =>
      f.mutate(
        `/player/orders/${first.id}/submit`,
        { screenshots: [f.upload(f.users.player1.id)] },
        f.users.player1.id
      ),
    403
  )
  f.mutate(`/player/orders/${second.id}/claim`, {}, f.users.player1.id)
  f.setTime('2026-10-12T04:02:00Z')
  f.mutate(`/player/orders/${first.id}/claim`, {}, f.users.player2.id)
  assert.equal(f.data().orders.find((o) => o.id === first.id).assignments.length, 2)
})

test('截图上报、退回、重复验收和单双人报酬只结算一次', (t) => {
  const f = fixture(t)
  const order = f.order()
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.users.player1.id)
  rejects(
    () => f.mutate(`/player/orders/${order.id}/submit`, { screenshots: [] }, f.users.player1.id),
    400
  )
  const screenshot = f.upload(f.users.player1.id)
  f.mutate(
    `/player/orders/${order.id}/submit`,
    { screenshots: [screenshot], teammateId: f.users.player2.id },
    f.users.player1.id
  )
  assert.equal(f.service.playerWallet(f.users.player1.id).earned, 0)
  f.mutate(`/orders/${order.id}/action`, { action: 'review-return', reason: '截图不完整' })
  f.mutate(
    `/player/orders/${order.id}/submit`,
    { screenshots: [screenshot], teammateId: f.users.player2.id },
    f.users.player1.id
  )
  f.mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  rejects(() => f.mutate(`/orders/${order.id}/action`, { action: 'review-pass' }), 409)
  assert.equal(f.service.playerWallet(f.users.player1.id).earned, 3500)
  assert.equal(f.service.playerWallet(f.users.player2.id).earned, 3500)
  assert.equal(f.data().orders[0].submissions.length, 2)
  assert.equal(f.data().orders[0].submissions[0].review, 'returned')
})

test('待验收不占名额；验收退回保留负责人且允许超上限，禁止继续接新单', (t) => {
  const f = fixture(t),
    first = f.order(),
    second = f.order(),
    third = f.order()
  f.mutate(`/player/orders/${first.id}/claim`, {}, f.users.player1.id)
  f.mutate(
    `/player/orders/${first.id}/submit`,
    { screenshots: [f.upload(f.users.player1.id)] },
    f.users.player1.id
  )
  f.mutate(`/player/orders/${second.id}/claim`, {}, f.users.player1.id)
  f.mutate(`/orders/${first.id}/action`, { action: 'review-return', reason: '需补材料' })
  assert.equal(f.data().users.find((u) => u.id === f.users.player1.id).activeOrders, 2)
  rejects(() => f.mutate(`/player/orders/${third.id}/claim`, {}, f.users.player1.id), 409)
})

test('取消保留执行历史和预计成本；财务单独确认补偿且不可重复结算', (t) => {
  const f = fixture(t)
  const untouched = f.order()
  f.mutate(
    `/orders/${untouched.id}/action`,
    { action: 'cancel', reason: '客户取消' },
    f.users.support.id
  )
  assert.equal(f.data().orders.find((o) => o.id === untouched.id).reward, 0)
  const executed = f.order()
  f.mutate(`/player/orders/${executed.id}/claim`, {}, f.users.player1.id)
  f.mutate(
    `/orders/${executed.id}/action`,
    { action: 'release', reason: '换人' },
    f.users.support.id
  )
  f.mutate(
    `/orders/${executed.id}/action`,
    { action: 'cancel', reason: '不再继续' },
    f.users.support.id
  )
  assert.equal(f.data().orders.find((o) => o.id === executed.id).compensationPending, true)
  assert.equal(f.data().orders.find((o) => o.id === executed.id).reward, 7000)
  f.mutate(`/orders/${executed.id}/action`, {
    action: 'cancel-settle',
    reward: 2000,
    teammateId: f.users.player2.id,
    reason: '按完成进度补偿'
  })
  rejects(
    () =>
      f.mutate(`/orders/${executed.id}/action`, {
        action: 'cancel-settle',
        reward: 2000,
        reason: '重复'
      }),
    409
  )
  assert.equal(f.service.playerWallet(f.users.player1.id).earned, 1000)
  assert.equal(f.service.playerWallet(f.users.player2.id).earned, 1000)
  assert.equal(
    f.data().reports.performance.find((p) => p.userId === f.users.support.id).completed,
    0
  )
})

test('提现占用避免重复申请，审核付款不可重复；已提现退款只标人工处理、不扣余额', (t) => {
  const f = fixture(t),
    order = f.complete(f.order())
  const withdrawal = f.mutate('/player/withdrawals', { amount: 7000 }, f.users.player1.id)
  assert.equal(f.service.playerWallet(f.users.player1.id).available, 0)
  rejects(() => f.mutate('/player/withdrawals', { amount: 1 }, f.users.player1.id), 409)
  rejects(
    () =>
      f.mutate(`/withdrawals/${withdrawal.id}/action`, {
        action: 'pay',
        receipt: f.upload('admin')
      }),
    409
  )
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  rejects(() => f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' }), 409)
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt: f.upload('admin') })
  rejects(
    () =>
      f.mutate(`/withdrawals/${withdrawal.id}/action`, {
        action: 'pay',
        receipt: f.upload('admin')
      }),
    409
  )
  const refund = f.mutate('/refunds', { orderId: order.id, amount: 2000, reason: '客户部分退款' })
  assert.equal(refund.manualRewardReview, true)
  f.mutate(`/orders/${order.id}/action`, {
    action: 'adjust',
    amount: 8800,
    reward: 5000,
    reason: '财务确认最终报酬差额线下处理'
  })
  assert.equal(f.service.playerWallet(f.users.player1.id).earned, 7000)
  assert.equal(f.service.playerWallet(f.users.player1.id).paid, 7000)
  f.mutate(`/refunds/${refund.id}/action`, {
    action: 'resolve',
    reason: '已与打手核对，差额由财务另行追踪并登记'
  })
  assert.ok(f.data().refunds[0].manualResolution)
  rejects(
    () => f.mutate(`/refunds/${refund.id}/action`, { action: 'resolve', reason: '重复处理' }),
    409
  )
})

test('经营统计回原付款日，工资计完成月，退款未发佣金按净额且不重复扣回', (t) => {
  const f = fixture(t)
  f.salaries()
  const order = f.order({ paidAt: '2026-09-30T18:00:00+08:00' })
  const pending = f.data('2026-09').reports.days.find((d) => d.date === '2026-09-30')
  assert.equal(pending.received, 8800)
  assert.equal(pending.reward, 7000)
  assert.equal(pending.supportCommission, 0)
  assert.equal(pending.estimatedReward, 7000)
  f.complete(order)
  f.mutate('/refunds', { orderId: order.id, amount: 2000, reason: '部分退款' })
  const september = f.data('2026-09').reports.days.find((d) => d.date === '2026-09-30')
  assert.equal(september.refunds, 2000)
  assert.equal(september.net, 6800)
  assert.equal(september.supportCommission, 680)
  assert.equal(september.operationsCommission, 340)
  assert.equal(f.data('2026-10').reports.days.find((d) => d.date === '2026-10-12').refunds, 0)
  const payroll = f.data().reports.payroll.find((l) => l.userId === f.users.support.id)
  assert.equal(payroll.commission, 680)
  assert.equal(payroll.deduction, 0)
  assert.equal(
    f.data('2026-09').reports.performance.find((p) => p.userId === f.users.support.id).net,
    0
  )
  assert.equal(
    f.data('2026-10').reports.performance.find((p) => p.userId === f.users.support.id).net,
    6800
  )
})

test('已发工资的直接退款和审批退款仅扣新增提成差额，重复结算无重复底薪', (t) => {
  const f = fixture(t)
  f.salaries()
  const order = f.complete(f.order())
  const payroll = f.mutate('/payrolls', { month: '2026-10' })
  assert.equal(payroll.lines.find((l) => l.userId === f.users.support.id).commission, 880)
  rejects(() => f.mutate('/payrolls', { month: '2026-10' }), 409)
  f.mutate('/refunds', { orderId: order.id, amount: 2000, reason: '第一次部分退款' })
  const application = f.mutate(
    '/refunds',
    { orderId: order.id, amount: 1000, reason: '第二次部分退款' },
    f.users.support.id
  )
  assert.equal(application.status, 'pending')
  const priorRows = f.data().reports.payroll.filter((l) => l.userId === f.users.support.id)
  assert.equal(priorRows.at(-1).deduction, 200)
  f.mutate(`/refunds/${application.id}/action`, { action: 'approve' })
  rejects(() => f.mutate(`/refunds/${application.id}/action`, { action: 'approve' }), 409)
  const correction = f.mutate('/payrolls', { month: '2026-10' })
  assert.equal(correction.lines.find((l) => l.userId === f.users.support.id).base, 0)
  assert.equal(correction.lines.find((l) => l.userId === f.users.support.id).deduction, 300)
  assert.equal(correction.lines.find((l) => l.userId === f.users.operations.id).deduction, 150)
  rejects(() => f.mutate('/payrolls', { month: '2026-10' }), 409)
  assert.equal(f.data().reports.monthlyBase, 1050000)
  const later = f.complete(f.order())
  const additional = f.mutate('/payrolls', { month: '2026-10' })
  assert.equal(additional.lines.find((l) => l.userId === f.users.support.id).commission, 880)
  assert.equal(additional.lines.find((l) => l.userId === f.users.support.id).base, 0)
  assert.equal(f.data().reports.monthlyBase, 1050000)
  assert.ok(later.id)
})

test('未配置比例不能静默按零发工资，固定工资不计提成，历史计提比例不随新方案变化', (t) => {
  const f = fixture(t),
    order = f.complete(f.order())
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-10').profit, null)
  rejects(() => f.mutate('/payrolls', { month: '2026-10' }), 409)
  f.salaries()
  assert.equal(f.data().orders[0].commissionSnapshot.supportRate, 1000)
  f.mutate('/salary-plans', {
    userId: f.users.support.id,
    mode: 'base_commission',
    base: 300000,
    rate: 2000,
    platformRates: {},
    effectiveFrom: '2026-10-13',
    hourlyEnabled: false
  })
  assert.equal(f.data().orders[0].commissionSnapshot.supportRate, 1000)
  rejects(
    () =>
      f.mutate('/salary-plans', {
        userId: f.users.support.id,
        mode: 'fixed',
        base: 1000,
        rate: null,
        effectiveFrom: '2026-11-01',
        hourlyEnabled: true
      }),
    400
  )
  assert.ok(order.id)
})

test('固定工资客服和运营订单提成明确为零，财务独立权限可取消完成单', (t) => {
  const f = fixture(t)
  for (const user of [f.users.support, f.users.operations, f.users.finance])
    f.mutate('/salary-plans', {
      userId: user.id,
      mode: 'fixed',
      base: 100000,
      rate: null,
      platformRates: {},
      effectiveFrom: '2026-10-01',
      hourlyEnabled: false
    })
  const order = f.complete(f.order())
  assert.equal(order.commissionSnapshot.supportRate, 0)
  assert.equal(order.commissionSnapshot.operationsRate, 0)
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-10').incomplete, false)
  f.mutate('/users', { ...f.users.finance, permissionOverrides: { 'orders.edit': false } })
  f.mutate(
    `/orders/${order.id}/action`,
    { action: 'cancel', reason: '财务取消已完成订单' },
    f.users.finance.id
  )
  assert.equal(f.data().orders[0].status, 'canceled')
})

test('完成时缺运营可补齐原归属，禁止将游戏大厅设为运营参与平台', (t) => {
  const f = fixture(t)
  f.salaries()
  rejects(
    () => f.mutate('/platforms', { id: 'hall', name: '游戏大厅', operatorCommission: true }),
    400
  )
  f.mutate('/users', { ...f.users.operations, status: 'disabled' })
  f.complete(f.order())
  assert.equal(f.data().orders[0].commissionSnapshot.operationsId, null)
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-10').profit, null)
  f.mutate('/users', { ...f.users.operations, status: 'active' })
  assert.equal(f.data().orders[0].commissionSnapshot.operationsId, f.users.operations.id)
  assert.equal(f.data().orders[0].commissionSnapshot.operationsRate, 500)
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-10').profit, 480)
})

test('月中改固定工资仍保留先前订单计提，发放快照底薪不被后续方案覆盖', (t) => {
  const f = fixture(t)
  f.salaries()
  f.complete(f.order())
  f.mutate('/salary-plans', {
    userId: f.users.support.id,
    mode: 'fixed',
    base: 500000,
    rate: null,
    platformRates: {},
    effectiveFrom: '2026-10-13',
    hourlyEnabled: false
  })
  const first = f.mutate('/payrolls', { month: '2026-10' })
  assert.equal(first.lines.find((l) => l.userId === f.users.support.id).commission, 880)
  assert.equal(f.data().reports.monthlyBase, 1250000)
  f.mutate('/salary-plans', {
    userId: f.users.support.id,
    mode: 'fixed',
    base: 600000,
    rate: null,
    platformRates: {},
    effectiveFrom: '2026-10-14',
    hourlyEnabled: false
  })
  assert.equal(f.data().reports.monthlyBase, 1250000)
})

test('执行中编辑保留创建人和模板快照，已收款更正回改原付款日报，完成后仅财务改金额', (t) => {
  const f = fixture(t),
    order = f.order()
  f.mutate(
    `/orders/${order.id}/action`,
    { action: 'edit', amount: 9000, reward: 7200, roomCode: 'NEW', reason: '纠正录入金额' },
    f.users.support.id
  )
  const edited = f.data().orders[0]
  assert.equal(edited.creatorId, f.users.support.id)
  assert.equal(edited.snapshot.amount, 8800)
  assert.equal(edited.roomCode, 'NEW')
  assert.equal(edited.receivedAmount, 9000)
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-10').received, 9000)
  f.complete(edited)
  rejects(
    () =>
      f.mutate(
        `/orders/${order.id}/action`,
        { action: 'edit', amount: 10000, reason: '非法修改' },
        f.users.support.id
      ),
    409
  )
  f.mutate(`/orders/${order.id}/action`, {
    action: 'adjust',
    amount: 10000,
    reward: 7500,
    reason: '财务更正'
  })
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-10').received, 10000)
})

test('费用删除可恢复且回改指定日利润；跨夜考勤工时校验；附件按关联权限读取', (t) => {
  const f = fixture(t),
    attachment = f.upload('admin')
  rejects(
    () =>
      f.service.upload('admin', {
        name: 'fake.png',
        mime: 'image/png',
        data: Buffer.from('fake image').toString('base64')
      }),
    400
  )
  rejects(() => f.service.download(f.users.player2.id, attachment.id), 403)
  const expense = f.mutate('/expenses', {
    category: '设备',
    amount: 10000,
    date: '2026-10-11',
    purpose: '测试设备',
    receipt: attachment
  })
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-11').expenses, 10000)
  f.mutate(`/expenses/${expense.id}/action`, { action: 'delete' })
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-11').expenses, 0)
  f.mutate(`/expenses/${expense.id}/action`, { action: 'restore' })
  assert.equal(f.data().reports.days.find((d) => d.date === '2026-10-11').expenses, 10000)
  const attendance = f.mutate('/attendance', {
    userId: f.users.support.id,
    date: '2026-10-11',
    start: '22:00',
    end: '06:00',
    status: 'present',
    actualHours: 8,
    remark: '跨夜测试'
  })
  assert.equal(attendance.actualHours, 8)
  assert.equal(attendance.start, '22:00')
  assert.equal(attendance.end, '06:00')
  rejects(() => f.mutate('/attendance', { ...attendance, actualHours: 9 }), 400)
  assert.equal(shanghaiDate('2026-10-11T17:00:00Z'), '2026-10-12')
})

test('HTTP鉴权、cookie和并发抢单/提现避免双重成功', async (t) => {
  const f = fixture(t, { server: true })
  await new Promise((resolve) => f.app.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${f.app.address().port}/api/studio`
  const request = (path, cookie, body) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
  assert.equal((await request('/bootstrap')).status, 401)
  const login = async (username) => {
    const response = await request('/login', null, { username, password: PASSWORD })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    return cookie.split(';')[0]
  }
  const firstCookie = await login('player1'),
    secondCookie = await login('player2')
  const order = f.order()
  const claims = await Promise.all([
    request(`/player/orders/${order.id}/claim`, firstCookie, {}),
    request(`/player/orders/${order.id}/claim`, secondCookie, {})
  ])
  assert.equal(claims.filter((r) => r.status === 200).length, 1)
  const leaderId = f.data().orders[0].leaderId
  f.mutate(`/player/orders/${order.id}/submit`, { screenshots: [f.upload(leaderId)] }, leaderId)
  f.mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  const winningCookie = leaderId === f.users.player1.id ? firstCookie : secondCookie
  const withdrawals = await Promise.all([
    request('/player/withdrawals', winningCookie, { amount: 7000 }),
    request('/player/withdrawals', winningCookie, { amount: 7000 })
  ])
  assert.equal(withdrawals.filter((r) => r.status === 200).length, 1)
  assert.equal(withdrawals.filter((r) => r.status === 409).length, 1)
  const unauthorized = await request('/payrolls', firstCookie, { month: '2026-10' })
  assert.equal(unauthorized.status, 403)
})

test('排班先待登记且不计工时，实际到岗后计入；非到岗及未来日期不得提前计工时', (t) => {
  const f = fixture(t)
  const scheduled = f.mutate('/attendance', {
    userId: f.users.support.id,
    date: '2026-10-13',
    start: '09:00',
    end: '18:00',
    status: 'scheduled',
    actualHours: 0,
    remark: '明日白班'
  })
  assert.equal(scheduled.actualHours, 0)
  assert.equal(f.data().attendance.find((a) => a.id === scheduled.id).status, 'scheduled')
  rejects(() => f.mutate('/attendance', { ...scheduled, status: 'present', actualHours: 8 }), 400)
  rejects(() => f.mutate('/attendance', { ...scheduled, status: 'scheduled', actualHours: 8 }), 400)
  rejects(() => f.mutate('/attendance', { ...scheduled, status: 'leave', actualHours: 1 }), 400)
  rejects(() => f.mutate('/attendance', { ...scheduled, status: 'absent', actualHours: 1 }), 400)
  f.setTime('2026-10-13T11:00:00+08:00')
  const present = f.mutate('/attendance', {
    ...scheduled,
    status: 'present',
    actualHours: 8,
    remark: '人工登记到岗，扣除休息1小时'
  })
  assert.equal(present.actualHours, 8)
  const { actualHours: omittedActualHours, ...noteFields } = present
  assert.equal(omittedActualHours, 8)
  const noteOnly = f.mutate('/attendance', { ...noteFields, remark: '仅修改备注' })
  assert.equal(noteOnly.actualHours, 8)
  assert.equal(noteOnly.status, 'present')
  const absence = f.mutate('/attendance', {
    ...noteOnly,
    status: 'absent',
    actualHours: 0,
    remark: '更正为缺勤'
  })
  assert.equal(absence.actualHours, 0)
})

test('SQLite重启保留业务、密码和会话，数据库与附件统一事务持久化', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'studio.sqlite')
  const first = createStudioService({ dbPath: path, password: PASSWORD, seed: false })
  const token = first.login('admin', PASSWORD).token
  const customer = first.mutate('admin', '/customers', {
    name: '持久客户',
    contact: '',
    gameId: '',
    remark: ''
  })
  const attachment = first.upload('admin', { name: 'persist.png', mime: 'image/png', data: PNG })
  first.close()
  const second = createStudioService({
    dbPath: path,
    password: 'ignored-new-password',
    seed: false
  })
  assert.equal(second.session(token).id, 'admin')
  assert.ok(second.bootstrap('admin').customers.some((c) => c.id === customer.id))
  assert.equal(second.download('admin', attachment.id).data.toString('base64'), PNG)
  second.close()
})
