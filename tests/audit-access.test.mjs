import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { buildExportSheets } from '../server/report-export.mjs'

const PASSWORD = 'audit-access-test-password-123'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

function fixture(t) {
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    clock: () => new Date('2026-10-13T04:00:00.000Z')
  })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, body)
  const level = mutate('/levels', { name: '审计测试等级', delaySeconds: 0 })
  const staff = (role, overrides = {}, username = `audit-${role}`) =>
    mutate('/users', {
      username,
      name: `测试${role}`,
      role,
      status: 'active',
      maxActiveOrders: 2,
      levelId: level.id,
      permissionOverrides: overrides,
      password: PASSWORD
    })
  const users = {
    hr: staff('hr', { 'logs.view': true }),
    support: staff('support', { 'logs.view': true }),
    admin: staff('admin'),
    owner: staff('owner'),
    finance: staff('finance'),
    player: staff('player', { 'logs.view': true }),
    otherPlayer: staff('player', {}, 'audit-other-player')
  }
  for (const role of ['hr', 'support', 'finance'])
    mutate('/salary-plans', {
      userId: users[role].id,
      mode: 'fixed',
      base: 123456,
      rate: null,
      platformRates: {},
      effectiveFrom: '2026-10-01',
      hourlyEnabled: false
    })
  const receipt = service.upload('admin', {
    name: '财务私有凭证.png',
    mime: 'image/png',
    data: PNG
  })
  const paymentReceipt = service.upload(users.support.id, {
    name: '客户付款凭证.png',
    mime: 'image/png',
    data: PNG
  })
  const customer = mutate('/customers', {
    name: '审计客户',
    contact: 'private-customer-contact',
    gameId: '00123',
    remark: ''
  })
  const template = mutate('/templates', {
    name: '审计项目',
    game: '测试',
    description: '',
    amount: 8812,
    reward: 7000,
    map: '不限',
    remark: '',
    active: true
  })
  const createOrder = (platformId) =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId,
        shopId: platformId === 'xianyu' ? 'jindun' : null,
        externalOrderNo: '000123-private-order',
        channel: '测试',
        roomCode: 'ROOM',
        gameId: '00123',
        amount: 8812,
        reward: 7000,
        receivedAmount: 8812,
        paidAt: '2026-10-12T10:00:00+08:00',
        receipt: platformId === 'hall' ? paymentReceipt : null,
        dispatchMode: 'pool'
      },
      users.support.id
    )
  const order = createOrder('xianyu')
  const refunded = mutate('/refunds', {
    orderId: order.id,
    amount: 812,
    reason: 'private-refund-reason'
  })
  const expense = mutate('/expenses', {
    category: '私有费用',
    amount: 45678,
    date: '2026-10-12',
    purpose: 'private-expense-purpose',
    receipt
  })
  const completed = createOrder('hall')
  mutate(`/player/orders/${completed.id}/claim`, {}, users.player.id)
  const screenshot = service.upload(users.player.id, {
    name: '完成截图.png',
    mime: 'image/png',
    data: PNG
  })
  mutate(
    `/player/orders/${completed.id}/submit`,
    { screenshots: [screenshot], teammateId: users.otherPlayer.id },
    users.player.id
  )
  mutate(`/orders/${completed.id}/action`, { action: 'review-pass' })
  const withdrawal = mutate('/player/withdrawals', { amount: 1200 }, users.player.id)
  const otherWithdrawal = mutate('/player/withdrawals', { amount: 600 }, users.otherPlayer.id)
  mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt })
  const attendance = mutate('/attendance', {
    userId: users.finance.id,
    date: '2026-10-12',
    start: '09:00',
    end: '18:00',
    status: 'present',
    actualHours: 8,
    remark: 'private-attendance-remark'
  })
  const snapshot = (actor) => service.bootstrap(actor, '2026-10', { exportMode: true })
  const exportedLogs = (actor) =>
    buildExportSheets(snapshot(actor), {
      month: '2026-10',
      modules: [
        { id: 'logs', fields: ['id', 'actorName', 'action', 'createdAt', 'before', 'after'] }
      ]
    }).sheets[0].rows
  return {
    service,
    mutate,
    staff,
    users,
    receipt,
    customer,
    template,
    order,
    completed,
    refunded,
    expense,
    withdrawal,
    otherWithdrawal,
    attendance,
    snapshot,
    exportedLogs
  }
}

test('审计详情遵循业务权限，日志查看不暴露人员账号、个人权限及无权财务记录', (t) => {
  const f = fixture(t)
  for (const actor of [f.users.hr.id, f.users.support.id, f.users.admin.id]) {
    const data = f.snapshot(actor)
    const log = (entityId) => data.logs.find((row) => row.entityId === entityId)
    const own = log(actor)
    assert.equal(own.after.username, data.user.username, '本人账号仍可见')
    const employee = log(f.users.finance.id)
    assert.equal(employee.after.name, f.users.finance.name)
    assert.equal(employee.after.role, 'finance')
    if (!data.permissions.includes('users.manage')) {
      assert.equal(Object.hasOwn(employee.after, 'username'), false)
      assert.equal(Object.hasOwn(employee.after, 'permissionOverrides'), false)
    } else assert.equal(employee.after.username, f.users.finance.username)
    assert.equal(log(f.expense.id).after, null)
    assert.equal(log(f.withdrawal.id).after, null)
    assert.ok(log(f.expense.id).id && log(f.expense.id).actorName && log(f.expense.id).createdAt)
    assert.equal(
      data.logs.some((row) => row.entity === 'salary-plan' || row.entity === 'payroll'),
      false
    )
    const exported = JSON.stringify(f.exportedLogs(actor))
    assert.equal(exported.includes('private-expense-purpose'), false)
    assert.equal(exported.includes('财务私有凭证.png'), false)
    if (!data.permissions.includes('users.manage'))
      assert.equal(exported.includes(f.users.finance.username), false)
    if (!data.permissions.includes('orders.view')) {
      assert.equal(log(f.order.id).after, null)
      assert.equal(log(f.refunded.id).after, null)
      assert.equal(exported.includes('private-customer-contact'), false)
      assert.equal(exported.includes('000123-private-order'), false)
    } else assert.equal(log(f.refunded.id).after.amount, 812)
    if (!data.permissions.includes('attendance.manage') && !data.permissions.includes('salary.all'))
      assert.equal(log(f.attendance.id).after, null)
  }
})

test('老板和默认财务保留授权财务历史，账号投影按人员权限，打手只看本人发放及脱敏订单', (t) => {
  const f = fixture(t)
  for (const actor of [f.users.owner.id, f.users.finance.id]) {
    const data = f.snapshot(actor)
    const expenseLog = data.logs.find((row) => row.entityId === f.expense.id)
    assert.equal(expenseLog.after.amount, 45678)
    assert.equal(expenseLog.after.receipt.url, f.receipt.url)
    assert.equal(
      data.logs.find((row) => row.entityId === f.withdrawal.id && row.action === '提现：pay').after
        .amount,
      1200
    )
    assert.ok(data.logs.some((row) => row.entity === 'salary-plan' && row.after.base === 123456))
    assert.ok(JSON.stringify(f.exportedLogs(actor)).includes('private-expense-purpose'))
    const employeeLog = data.logs.find((row) => row.entityId === f.users.support.id)
    assert.equal(
      Object.hasOwn(employeeLog.after, 'username'),
      data.permissions.includes('users.manage')
    )
  }
  const player = f.snapshot(f.users.player.id)
  const withdrawal = player.logs.find(
    (row) => row.entityId === f.withdrawal.id && row.action === '提现：pay'
  )
  assert.equal(withdrawal.after.amount, 1200)
  assert.equal(withdrawal.after.receipt.url, f.receipt.url)
  const completed = player.logs.find((row) => row.entityId === f.completed.id)
  assert.equal(completed.after.amount, 0)
  assert.equal(completed.after.externalOrderNo, '')
  assert.equal(completed.after.snapshot.amount, null)
  assert.equal(Object.hasOwn(completed.after, 'commissionSnapshot'), false)
  assert.equal(player.logs.find((row) => row.entityId === f.order.id).after.amount, 0)
  assert.equal(player.logs.find((row) => row.entityId === f.refunded.id).after, null)
  assert.equal(player.logs.find((row) => row.entityId === f.otherWithdrawal.id).after, null)
})

test('审计使用字段白名单并保留历史旧值，导出不重新泄露未知嵌套字段', (t) => {
  const f = fixture(t)
  const oldUsername = f.users.support.username
  f.mutate('/users', { ...f.users.support, username: 'audit-renamed-support' })
  const state = JSON.parse(
    f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  )
  const audit = state.logs.find(
    (row) => row.entityId === f.completed.id && row.after?.submissions?.length
  )
  audit.secretMetadata = 'private-extra-root'
  audit.after.privateExtra = 'private-extra-order'
  audit.after.snapshot.passwordHash = 'private-extra-template'
  if (audit.after.submissions[0]) {
    audit.after.submissions[0].debugToken = 'private-extra-submission'
    audit.after.submissions[0].screenshots[0].privateBlob = 'private-extra-attachment'
  }
  const userLog = state.logs.find((row) => row.entityId === f.users.support.id && row.after)
  userLog.after.passwordHash = 'private-extra-user'
  state.logs.push({
    id: 'unknown-audit',
    actorId: 'admin',
    actorName: '管理员',
    action: '旧版未知事件',
    entity: 'unknown',
    entityId: 'unknown',
    createdAt: '2026-10-12T00:00:00Z',
    before: { secret: 'private-unknown' },
    after: { secret: 'private-unknown' }
  })
  f.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  const data = f.snapshot(f.users.owner.id)
  const changed = data.logs.find(
    (row) => row.entity === 'user' && row.entityId === f.users.support.id && row.before
  )
  assert.equal(changed.before.username, oldUsername)
  assert.equal(changed.after.username, 'audit-renamed-support')
  const projected = data.logs.find((row) => row.id === audit.id)
  assert.equal(Object.hasOwn(projected, 'secretMetadata'), false)
  assert.equal(Object.hasOwn(projected.after.snapshot, 'passwordHash'), false)
  assert.equal(data.logs.find((row) => row.id === 'unknown-audit').after, null)
  assert.equal(JSON.stringify(data.logs).includes('private-extra-'), false)
  assert.equal(JSON.stringify(f.exportedLogs(f.users.owner.id)).includes('private-extra-'), false)
  assert.equal(JSON.stringify(f.exportedLogs(f.users.owner.id)).includes('private-unknown'), false)
})

test('全员月结同时要求工资管理和全员查看，本人管理授权仍可配置工资方案', (t) => {
  const f = fixture(t)
  const actor = f.users.hr
  const ownOnly = { ...actor, permissionOverrides: { 'logs.view': true, 'salary.manage': true } }
  f.mutate('/users', ownOnly)
  assert.ok(f.snapshot(actor.id).reports.payroll.every((row) => row.userId === actor.id))
  assert.throws(
    () => f.mutate('/payrolls', { month: '2026-10' }, actor.id),
    (error) => error instanceof ApiError && error.status === 403
  )
  f.mutate(
    '/salary-plans',
    {
      userId: actor.id,
      mode: 'fixed',
      base: 123456,
      rate: null,
      platformRates: {},
      effectiveFrom: '2026-11-01',
      hourlyEnabled: false
    },
    actor.id
  )
  f.mutate('/users', {
    ...ownOnly,
    permissionOverrides: { ...ownOnly.permissionOverrides, 'salary.all': true }
  })
  const paid = f.mutate('/payrolls', { month: '2026-10' }, actor.id)
  assert.ok(paid.lines.length > 1)
  assert.ok(paid.lines.some((row) => row.userId === actor.id))
  assert.ok(paid.lines.some((row) => row.userId === f.users.finance.id))
})
