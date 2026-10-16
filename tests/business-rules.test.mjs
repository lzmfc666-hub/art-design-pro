import { testMutate, installTestClientFetch } from './helpers/current-intent.mjs'
import { withdrawalBody } from './player-test-helpers.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'
import { defaultAppearance } from '../server/appearance.mjs'
import { createAuditStore } from '../server/audit-store.mjs'

const PASSWORD = 'business-rules-test-password-123'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const rejected = (fn, status) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status)
function fixture(t, options = {}) {
  let clock = new Date('2026-10-12T04:00:00Z')
  const service = createStudioService({
    dbPath: ':memory:',
    seed: false,
    password: PASSWORD,
    clock: () => clock,
    ...options
  })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '测试级别', delaySeconds: 0 })
  const users = {}
  for (const role of ['support', 'support_lead', 'manager', 'finance', 'admin', 'hr', 'player'])
    users[role] = mutate('/users', {
      username: `new-${role}`,
      name: role,
      role,
      status: 'active',
      maxActiveOrders: 2,
      levelId: level.id,
      permissionOverrides: {},
      password: PASSWORD
    })
  for (const role of ['support', 'support_lead', 'manager', 'finance', 'hr'])
    mutate('/salary-plans', {
      userId: users[role].id,
      mode: 'fixed',
      base: 0,
      rate: null,
      platformRates: {},
      effectiveFrom: '2026-10-01',
      hourlyEnabled: false
    })
  const upload = (actor = 'admin') =>
    service.upload(actor, { name: 'business.png', mime: 'image/png', data: PNG })
  const customer = mutate('/customers', {
    name: '客户名称',
    platformId: 'hall',
    contact: '',
    gameId: '00007',
    remark: ''
  })
  const template = mutate('/templates', {
    name: '测试项目',
    game: '测试',
    description: '',
    amount: 8800,
    reward: 7000,
    map: '不限',
    remark: '',
    active: true
  })
  const order = (changes = {}) =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId: 'hall',
        shopId: null,
        externalOrderNo: '',
        channel: '应该忽略的新渠道',
        roomCode: 'ROOM',
        gameId: '00007',
        amount: 8800,
        reward: 7000,
        receivedAmount: 8800,
        paidAt: '2026-10-10T18:00:00+08:00',
        receipt: upload(users.support.id),
        dispatchMode: 'direct',
        assignedTo: users.player.id,
        ...changes
      },
      users.support.id
    )
  const complete = (record) => {
    mutate(`/player/orders/${record.id}/claim`, {}, users.player.id)
    mutate(
      `/player/orders/${record.id}/submit`,
      { screenshots: [upload(users.player.id)] },
      users.player.id
    )
    return mutate(`/orders/${record.id}/action`, { action: 'review-pass' })
  }
  return {
    service,
    mutate,
    users,
    customer,
    template,
    upload,
    order,
    complete,
    time: (value) => {
      clock = new Date(value)
    }
  }
}

test('平台规则实际控制店铺、编号、截图与落地付，店铺按平台唯一，新下单不再保存沟通渠道', (t) => {
  const f = fixture(t)
  const rules = {
    requiresShop: true,
    requiresExternalOrderNo: true,
    requiresReceipt: false,
    allowPayOnArrival: true
  }
  const platform = f.mutate('/platforms', { name: '自定义来源', rules })
  const shop = f.mutate('/shops', { name: '同名店铺', platformId: platform.id })
  const other = f.mutate('/shops', { name: '同名店铺', platformId: 'xianyu' })
  assert.ok(other.id !== shop.id)
  rejected(() => f.mutate('/shops', { name: '同名店铺', platformId: platform.id }), 409)
  rejected(
    () => f.order({ platformId: platform.id, shopId: null, externalOrderNo: '123', receipt: null }),
    400
  )
  const created = f.order({
    platformId: platform.id,
    shopId: shop.id,
    externalOrderNo: '000123',
    receipt: null,
    payOnArrival: true,
    receivedAmount: 0,
    paidAt: null
  })
  assert.equal(created.channel, '')
  assert.equal(created.externalOrderNo, '000123')
  assert.equal(created.receivedAmount, 0)
  const snapshot = f.service.bootstrap('admin')
  assert.deepEqual(snapshot.platforms.find((row) => row.id === platform.id).rules, rules)
  assert.equal(snapshot.platforms.find((row) => row.id === 'xianyu').rules.requiresReceipt, false)
})

test('客户独立编号逐条新增删除和分页，无固定记录上限，不创建订单或增加收入', (t) => {
  const f = fixture(t)
  for (let index = 0; index < 35; index++)
    f.mutate(
      '/customer-order-references',
      {
        customerId: f.customer.id,
        platformId: 'xianyu',
        shopId: 'jindun',
        externalOrderNo: `000-${index}`
      },
      f.users.support.id
    )
  const page = f.service.customerReferences(f.users.support.id, f.customer.id, {
    current: 2,
    size: 20
  })
  assert.equal(page.total, 35)
  assert.equal(page.records.length, 15)
  assert.equal(f.service.bootstrap('admin').customers[0].orderReferences.length, 20)
  assert.equal(f.service.bootstrap('admin').customers[0].orderReferenceCount, 35)
  assert.equal(f.service.bootstrap('admin').orders.length, 0)
  assert.equal(
    f.service.overview('admin', { start: '2026-10-01', end: '2026-10-31' }).metrics.received,
    0
  )
  rejected(
    () =>
      f.mutate('/customer-order-references', {
        customerId: f.customer.id,
        platformId: 'hall',
        externalOrderNo: 'not-required'
      }),
    400
  )
  rejected(
    () =>
      f.mutate('/customer-order-references', {
        customerId: f.customer.id,
        platformId: 'xianyu',
        shopId: 'jindun',
        externalOrderNo: '000-0'
      }),
    409
  )
  f.mutate('/customer-order-references', {
    customerId: f.customer.id,
    id: page.records[0].id,
    action: 'remove'
  })
  assert.equal(f.service.customerReferences('admin', f.customer.id).total, 34)
  const exportData = f.service.exportSnapshot('admin', {
    period: { type: 'total' },
    modules: [{ id: 'customerOrderReferences', fields: ['externalOrderNo'] }]
  })
  assert.equal(exportData.customerOrderReferenceCount, 34)
  assert.equal(exportData.customers[0].orderReferences.length, 34)
})

test('扣款只扣可用额，超额独立待追回，补款入钱包且不更改已付和在途；原玩家接口仍可操作', (t) => {
  const f = fixture(t)
  const pending = f.order()
  assert.ok(f.service.playerOrders(f.users.player.id).some((row) => row.id === pending.id))
  f.complete(pending)
  const paid = f.mutate(
    '/player/withdrawals',
    withdrawalBody(f.service, f.users.player.id, 3000),
    f.users.player.id
  )
  f.mutate(`/withdrawals/${paid.id}/action`, { action: 'approve' })
  f.mutate(`/withdrawals/${paid.id}/action`, { action: 'pay', receipt: f.upload() })
  f.mutate(
    '/player/withdrawals',
    withdrawalBody(f.service, f.users.player.id, 2000),
    f.users.player.id
  )
  const adjustment = f.mutate(
    '/player-adjustments',
    {
      userId: f.users.player.id,
      kind: 'deduction',
      amount: 2500,
      reason: '扣款测试',
      orderId: pending.id
    },
    f.users.finance.id
  )
  assert.equal(adjustment.appliedAmount, 2000)
  assert.equal(adjustment.manualAmount, 500)
  assert.equal(adjustment.status, 'manual')
  const wallet = f.service.playerWallet(f.users.player.id)
  assert.equal(wallet.available, 0)
  assert.equal(wallet.paid, 3000)
  assert.equal(wallet.occupied, 2000)
  rejected(
    () =>
      f.mutate(
        '/player/withdrawals',
        withdrawalBody(f.service, f.users.player.id, 1),
        f.users.player.id
      ),
    409
  )
  f.mutate(`/player-adjustments/${adjustment.id}/action`, {
    action: 'resolve',
    resolution: 'recovered',
    reason: '线下已收回500分'
  })
  rejected(
    () =>
      f.mutate(`/player-adjustments/${adjustment.id}/action`, {
        action: 'resolve',
        resolution: 'recovered',
        reason: '不能重复'
      }),
    409
  )
  f.mutate('/player-adjustments', {
    userId: f.users.player.id,
    kind: 'supplement',
    amount: 1000,
    reason: '补款测试'
  })
  assert.equal(f.service.playerWallet(f.users.player.id).available, 1000)
  assert.equal(f.service.playerWallet(f.users.player.id).paid, 3000)
  assert.equal(
    f.service.bootstrap('admin', '2026-10').reports.days.find((row) => row.date === '2026-10-10')
      .expenses,
    -2500
  )
  assert.equal(
    f.service.bootstrap('admin', '2026-10').reports.days.find((row) => row.date === '2026-10-12')
      .expenses,
    1000
  )
})

test('状态更正显式角色保护、无负责人拒绝，已结算跨月回退恢复不重发报酬或改完成月份', (t) => {
  const f = fixture(t)
  const unassigned = f.order({ dispatchMode: 'pool', assignedTo: null })
  rejected(
    () =>
      f.mutate(`/orders/${unassigned.id}/action`, {
        action: 'correct-status',
        status: 'completed',
        reason: '无负责人'
      }),
    400
  )
  f.mutate('/users', { ...f.users.admin, permissionOverrides: { 'finance.review': true } })
  rejected(
    () =>
      f.mutate(
        `/orders/${unassigned.id}/action`,
        {
          action: 'correct-status',
          status: 'active',
          leaderId: f.users.player.id,
          reason: '普通管理员不可'
        },
        f.users.admin.id
      ),
    403
  )
  const completed = f.complete(f.order())
  const before = f.service.playerWallet(f.users.player.id).earned
  f.time('2026-11-02T02:00:00Z')
  const active = f.mutate(
    `/orders/${completed.id}/action`,
    {
      action: 'correct-status',
      status: 'active',
      reason: '财务更正材料',
      leaderId: f.users.player.id
    },
    f.users.manager.id
  )
  assert.equal(active.status, 'active')
  assert.equal(f.service.playerWallet(f.users.player.id).earned, 0)
  assert.ok(f.service.playerOrders(f.users.player.id).some((row) => row.id === completed.id))
  const restored = f.mutate(
    `/orders/${completed.id}/action`,
    {
      action: 'correct-status',
      status: 'completed',
      reason: '核对完成恢复',
      leaderId: f.users.player.id
    },
    f.users.finance.id
  )
  assert.equal(restored.completedAt, completed.completedAt)
  assert.equal(f.service.playerWallet(f.users.player.id).earned, before)
  rejected(
    () =>
      f.mutate(`/orders/${completed.id}/action`, {
        action: 'correct-status',
        status: 'completed',
        reason: '重复恢复',
        leaderId: f.users.player.id
      }),
    409
  )
  assert.equal(
    f.service
      .bootstrap('admin', '2026-11')
      .reports.performance.find((row) => row.userId === f.users.support.id).completed,
    0
  )
})

test('店长更正状态不扩展验收和金额权限，普通管理员授予订单编辑仍不能更正状态', (t) => {
  const f = fixture(t)
  const completed = f.complete(f.order())
  const managerId = f.users.manager.id
  const managerPermissions = f.service.bootstrap(managerId).permissions
  assert.ok(managerPermissions.includes('orders.edit'))
  assert.equal(managerPermissions.includes('finance.review'), false)
  rejected(
    () =>
      f.mutate(
        `/orders/${completed.id}/action`,
        { action: 'adjust', amount: 9900, reward: 8000, reason: '不应获得金额更正权限' },
        managerId
      ),
    403
  )
  const reviewing = f.mutate(
    `/orders/${completed.id}/action`,
    { action: 'correct-status', status: 'review', reason: '店长核对材料' },
    managerId
  )
  assert.equal(reviewing.status, 'review')
  rejected(
    () => f.mutate(`/orders/${completed.id}/action`, { action: 'review-pass' }, managerId),
    403
  )
  const canceled = f.mutate(
    `/orders/${completed.id}/action`,
    { action: 'correct-status', status: 'canceled', reason: '店长更正终态' },
    managerId
  )
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.compensationPending, true)
  rejected(
    () =>
      f.mutate(
        `/orders/${completed.id}/action`,
        { action: 'cancel-settle', reward: 5000, reason: '不应获得取消补偿金额权限' },
        managerId
      ),
    403
  )
  const restored = f.mutate(
    `/orders/${completed.id}/action`,
    { action: 'correct-status', status: 'completed', reason: '店长恢复核对后的原状态' },
    managerId
  )
  assert.equal(restored.status, 'completed')
  assert.equal(restored.amount, completed.amount)
  assert.equal(restored.reward, completed.reward)
  assert.equal(f.service.playerWallet(f.users.player.id).earned, completed.reward)
  f.mutate('/users', {
    ...f.users.admin,
    permissionOverrides: { 'orders.edit': true }
  })
  rejected(
    () =>
      f.mutate(
        `/orders/${completed.id}/action`,
        { action: 'correct-status', status: 'active', reason: '普通管理员不在已授权角色内' },
        f.users.admin.id
      ),
    403
  )
  f.mutate('/users', {
    ...f.users.manager,
    permissionOverrides: { 'orders.edit': false }
  })
  rejected(
    () =>
      f.mutate(
        `/orders/${completed.id}/action`,
        { action: 'correct-status', status: 'active', reason: '已撤销订单编辑权限' },
        managerId
      ),
    403
  )
})

test('正常考勤不自动生成实际工时，未来正常与休息只是计划，班次可空，已登记工时单独保护', (t) => {
  const f = fixture(t)
  const normal = f.mutate('/attendance', {
    userId: f.users.hr.id,
    date: '2026-10-12',
    start: '',
    end: '',
    status: 'normal',
    actualHours: null,
    remark: ''
  })
  assert.equal(normal.actualHours, 0)
  assert.equal(normal.hoursRegistered, false)
  const registered = f.mutate('/attendance', { ...normal, actualHours: 8 })
  assert.equal(registered.actualHours, 8)
  assert.equal(registered.hoursRegistered, true)
  const future = f.mutate('/attendance', {
    userId: f.users.hr.id,
    date: '2026-10-20',
    start: '',
    end: '',
    status: 'normal',
    actualHours: null,
    remark: ''
  })
  assert.equal(future.hoursRegistered, false)
  rejected(() => f.mutate('/attendance', { ...future, actualHours: 8 }), 400)
  const rest = f.mutate('/attendance', {
    userId: f.users.hr.id,
    date: '2026-10-21',
    start: '',
    end: '',
    status: 'rest',
    actualHours: 0,
    remark: ''
  })
  assert.equal(rest.actualHours, 0)
  rejected(() => f.mutate('/attendance', { ...rest, actualHours: 1 }), 400)
})

test('已提现且已发佣金订单的跨月状态冲正创建待追回，恢复抵销当月佣金差额而不再计一次原佣金', (t) => {
  const f = fixture(t)
  f.mutate('/salary-plans', {
    userId: f.users.support.id,
    mode: 'base_commission',
    base: 0,
    rate: 1000,
    platformRates: {},
    effectiveFrom: '2026-10-01',
    hourlyEnabled: false
  })
  const completed = f.complete(f.order())
  const payroll = f.mutate('/payrolls', { month: '2026-10' })
  assert.equal(payroll.lines.find((row) => row.userId === f.users.support.id).commission, 880)
  const withdrawal = f.mutate(
    '/player/withdrawals',
    withdrawalBody(f.service, f.users.player.id, 7000),
    f.users.player.id
  )
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt: f.upload() })
  f.time('2026-11-02T02:00:00Z')
  f.mutate(`/orders/${completed.id}/action`, {
    action: 'correct-status',
    status: 'active',
    reason: '补充材料后重新核对',
    leaderId: f.users.player.id
  })
  const manual = f.service
    .bootstrap('admin')
    .playerAdjustments.find((row) => row.orderId === completed.id && row.status === 'manual')
  assert.equal(manual.appliedAmount, 0)
  assert.equal(manual.manualAmount, 7000)
  assert.equal(f.service.playerWallet(f.users.player.id).paid, 7000)
  assert.equal(
    f.service
      .bootstrap('admin', '2026-11')
      .reports.payroll.find((row) => row.userId === f.users.support.id).deduction,
    880
  )
  f.mutate(`/orders/${completed.id}/action`, {
    action: 'correct-status',
    status: 'completed',
    reason: '材料核对恢复原结算',
    leaderId: f.users.player.id
  })
  const november = f.service
    .bootstrap('admin', '2026-11')
    .reports.payroll.find((row) => row.userId === f.users.support.id)
  assert.equal(november.commission, 0)
  assert.equal(november.deduction, 0)
  assert.equal(f.service.playerWallet(f.users.player.id).available, 0)
  assert.equal(
    f.service
      .bootstrap('admin', '2026-10')
      .payrolls[0].lines.find((row) => row.userId === f.users.support.id).commission,
    880
  )
  assert.equal(
    f.service.bootstrap('admin').playerAdjustments.find((row) => row.id === manual.id).status,
    'resolved'
  )
})

test('日志动作和指定关键词字段独立筛选，存储计数迁移后与真实bytes一致', (t) => {
  const f = fixture(t, { auditHotMaxRows: 3 })
  const byAction = f.service.logs('admin', { source: 'all', action: '账号创建', size: 200 })
  assert.ok(byAction.total > 0)
  assert.ok(byAction.records.every((row) => row.action.includes('账号创建')))
  const actor = f.service.exportSnapshot('admin', {
    period: { type: 'total' },
    modules: [{ id: 'logs', fields: ['action'] }],
    filters: { keyword: '账号创建', keywordField: 'actorName' }
  })
  assert.equal(actor.auditLogCount, 0)
  assert.equal(actor.logs.length, 0)
  const action = f.service.exportSnapshot('admin', {
    period: { type: 'total' },
    modules: [{ id: 'logs', fields: ['action'] }],
    filters: { keyword: '账号创建', keywordField: 'action' }
  })
  assert.equal(action.auditLogCount, byAction.total)
  const total = f.service.logStorage('admin')
  const actual = f.service.db
    .prepare(
      'SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM audit_logs_archive'
    )
    .get()
  assert.equal(total.archiveRows, actual.n)
  assert.equal(total.archiveBytes, actual.bytes)
})

test('已完成更正为待验收保留原审核材料，财务复核可以正常验收且循环恢复不重复奖励', (t) => {
  const f = fixture(t)
  const completed = f.complete(f.order())
  for (let index = 0; index < 2; index++) {
    const review = f.mutate(`/orders/${completed.id}/action`, {
      action: 'correct-status',
      status: 'review',
      reason: '财务复核旧材料',
      leaderId: f.users.player.id
    })
    assert.equal(review.status, 'review')
    assert.equal(review.submissions[0].review, 'passed')
    assert.equal(review.submissions.at(-1).recheckBy, 'admin')
    assert.equal(review.submissions.at(-1).submittedAt, completed.submissions[0].submittedAt)
    assert.equal(f.service.playerWallet(f.users.player.id).available, 0)
    const restored = f.mutate(`/orders/${completed.id}/action`, { action: 'review-pass' })
    assert.equal(restored.completedAt, completed.completedAt)
    assert.equal(f.service.playerWallet(f.users.player.id).earned, 7000)
  }
})

test('日志迁出JSON并按条件索引分页，归档不丢历史，客服即使权限覆盖也硬禁导出', (t) => {
  const f = fixture(t, { auditHotMaxRows: 3 })
  const storage = f.service.logStorage('admin')
  assert.ok(storage.hotRows <= 3)
  assert.ok(storage.archiveRows > 0)
  assert.deepEqual(
    JSON.parse(f.service.db.prepare('SELECT json FROM studio_state').get().json).logs,
    []
  )
  const page = f.service.logs('admin', { source: 'archive', entity: 'user', current: 1, size: 2 })
  assert.equal(page.records.length, 2)
  assert.ok(page.total > 2)
  assert.equal(f.service.logDetail('admin', page.records[0].id).entity, 'user')
  assert.ok(
    f.service.exportSnapshot('admin', {
      period: { type: 'total' },
      filters: { archived: 'archive' },
      modules: [{ id: 'logs', fields: ['action'] }]
    }).logs.length >= page.total
  )
  for (const role of ['support', 'support_lead']) {
    f.mutate('/users', { ...f.users[role], permissionOverrides: { 'reports.export': true } })
    assert.equal(
      f.service.bootstrap(f.users[role].id).permissions.includes('reports.export'),
      false
    )
    rejected(
      () =>
        f.service.exportSnapshot(f.users[role].id, {
          modules: [{ id: 'profile', fields: ['name'] }]
        }),
      403
    )
  }
})

test('归档达到容量时事务503不部分保存；备份确认与原因缺失不可清理，清理后保留维护日志', (t) => {
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    auditHotMaxRows: 1,
    auditArchiveMaxBytes: 10000
  })
  t.after(() => service.close())
  testMutate(service, 'admin', '/profile', { name: '首次名称' })
  testMutate(service, 'admin', '/profile', { name: '第二次名称' })
  const old = service.db.prepare('SELECT id,payload FROM audit_logs_archive LIMIT 1').get()
  service.db
    .prepare('UPDATE audit_logs_archive SET payload=? WHERE id=?')
    .run(old.payload + ' '.repeat(10000 - Buffer.byteLength(old.payload)), old.id)
  const before = service.bootstrap('admin').user.name
  rejected(() => testMutate(service, 'admin', '/profile', { name: '不能部分保存' }), 503)
  assert.equal(service.bootstrap('admin').user.name, before)
  assert.equal(service.logStorage('admin').warning, true)
  rejected(
    () =>
      testMutate(service, 'admin', '/logs/maintenance', {
        action: 'purge-archive',
        beforeDate: '2099-01-01',
        reason: '缺备份确认'
      }),
    400
  )
  rejected(
    () =>
      testMutate(service, 'admin', '/logs/maintenance', {
        action: 'purge-archive',
        beforeDate: '2099-01-01',
        backupConfirmed: true,
        reason: ''
      }),
    400
  )
  const backup = service.prepareArchiveBackup('admin', '2099-01-01')
  assert.equal([...backup.records].length, 1)
  service.completeArchiveBackup('admin', backup.backupToken, backup.beforeDate)
  testMutate(service, 'admin', '/logs/maintenance', {
    action: 'purge-archive',
    beforeDate: '2099-01-01',
    backupConfirmed: true,
    backupToken: backup.backupToken,
    reason: '管理员已保存导出备份'
  })
  assert.ok(
    service.logs('admin', { source: 'all', entity: 'audit-maintenance' }).records.length > 0
  )
})

test('完整归档备份必须具备全部审计权限，清理绑定完成、同人同日期、未变化且未过期的凭据', (t) => {
  const f = fixture(t, { auditHotMaxRows: 3 })
  assert.equal(f.service.logStorage(f.users.admin.id).canBackup, false)
  rejected(() => f.service.prepareArchiveBackup(f.users.admin.id, '2099-01-01'), 403)
  const pending = f.service.prepareArchiveBackup('admin', '2099-01-01')
  rejected(
    () =>
      f.mutate('/logs/maintenance', {
        action: 'purge-archive',
        beforeDate: '2099-01-01',
        backupToken: pending.backupToken,
        backupConfirmed: true,
        reason: '未完成不可删'
      }),
    409
  )
  const rows = [...pending.records].map((row) => JSON.parse(row.payload))
  assert.ok(rows.some((row) => row.entity === 'salary-plan' && row.after.base === 0))
  f.service.completeArchiveBackup('admin', pending.backupToken, pending.beforeDate)
  rejected(
    () =>
      f.mutate('/logs/maintenance', {
        action: 'purge-archive',
        beforeDate: '2098-01-01',
        backupToken: pending.backupToken,
        backupConfirmed: true,
        reason: '不能换日期'
      }),
    409
  )
  f.mutate('/profile', { name: '备份后归档新增' })
  rejected(
    () =>
      f.mutate('/logs/maintenance', {
        action: 'purge-archive',
        beforeDate: '2099-01-01',
        backupToken: pending.backupToken,
        backupConfirmed: true,
        reason: '不能删新记录'
      }),
    409
  )
  const fresh = f.service.prepareArchiveBackup('admin', '2099-01-01')
  assert.ok([...fresh.records].length > 0)
  f.service.completeArchiveBackup('admin', fresh.backupToken, fresh.beforeDate)
  const result = f.mutate('/logs/maintenance', {
    action: 'purge-archive',
    beforeDate: '2099-01-01',
    backupToken: fresh.backupToken,
    backupConfirmed: true,
    reason: '已保存完整备份'
  })
  assert.ok(result.affectedRows > 0)
  rejected(
    () =>
      f.mutate('/logs/maintenance', {
        action: 'purge-archive',
        beforeDate: '2099-01-01',
        backupToken: fresh.backupToken,
        backupConfirmed: true,
        reason: '凭据不可复用'
      }),
    409
  )
})

test('HTTP匿名只公开登录外观与指定公开图片，品牌与私有背景分离；客服三个导出入口都403', async (t) => {
  const server = createStudioServer({ dbPath: ':memory:', password: PASSWORD, seed: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const service = server.service
  const logo = service.upload('admin', { name: 'public.png', mime: 'image/png', data: PNG })
  const privateImage = service.upload('admin', {
    name: 'private.png',
    mime: 'image/png',
    data: PNG
  })
  testMutate(service, 'admin', '/appearance', {
    revision: 0,
    config: {
      ...defaultAppearance(),
      logo,
      page: { ...defaultAppearance().page, mode: 'image', image: privateImage }
    }
  })
  const publicConfig = await fetch(`${base}/appearance/public`).then((row) => row.json())
  assert.deepEqual(Object.keys(publicConfig).sort(), ['glass', 'login', 'logo', 'studioName'])
  assert.equal(
    (await fetch(`${base}${publicConfig.logo.url.replace('/api/studio', '')}`)).status,
    200
  )
  assert.equal((await fetch(`${base}/public-assets/${privateImage.id}`)).status, 404)
  assert.equal((await fetch(`${base}/uploads/${logo.id}`)).status, 401)
  const actor = testMutate(service, 'admin', '/users', {
    username: 'http-support',
    name: '客服',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: { 'reports.export': true },
    password: PASSWORD
  })
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: actor.username, password: PASSWORD })
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(`${base}/exports/catalog`, { headers: { cookie } })).status, 403)
  for (const endpoint of ['preview', 'download'])
    assert.equal(
      (
        await fetch(`${base}/exports/${endpoint}`, {
          method: 'POST',
          headers: { cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ modules: [{ id: 'profile', fields: ['name'] }] })
        })
      ).status,
      403
    )
})

test('HTTP完整备份流包含原始财务审计，普通管理员403，下载完成的header凭据可清理其范围', async (t) => {
  const server = createStudioServer({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    auditHotMaxRows: 1
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const service = server.service
  const ordinary = testMutate(service, 'admin', '/users', {
    username: 'raw-backup-admin',
    name: '普通管理员',
    role: 'admin',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: PASSWORD
  })
  const finance = testMutate(service, 'admin', '/users', {
    username: 'raw-backup-finance',
    name: '财务',
    role: 'finance',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: PASSWORD
  })
  testMutate(service, 'admin', '/salary-plans', {
    userId: finance.id,
    mode: 'fixed',
    base: 12345,
    rate: null,
    platformRates: {},
    effectiveFrom: '2026-10-01',
    hourlyEnabled: false
  })
  testMutate(service, 'admin', '/profile', { name: '完整备份管理员' })
  const login = async (username) => {
    const response = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD })
    })
    return response.headers.get('set-cookie').split(';')[0]
  }
  assert.equal((await fetch(`${base}/logs/archive-backup?beforeDate=2099-01-01`)).status, 401)
  const plainCookie = await login(ordinary.username)
  assert.equal(
    (
      await fetch(`${base}/logs/archive-backup?beforeDate=2099-01-01`, {
        headers: { cookie: plainCookie }
      })
    ).status,
    403
  )
  const cookie = await login('admin')
  const response = await fetch(`${base}/logs/archive-backup?beforeDate=2099-01-01`, {
    headers: { cookie }
  })
  assert.equal(response.status, 200)
  assert.ok(
    response.headers
      .get('content-disposition')
      .includes('studio-audit-archive-before-2099-01-01.json')
  )
  const backupToken = response.headers.get('x-studio-backup-token')
  assert.ok(backupToken)
  const backup = await response.json()
  assert.equal(backup.format, 'studio-audit-archive-v1')
  assert.ok(backup.records.some((row) => row.entity === 'salary-plan' && row.after.base === 12345))
  assert.equal(backup.records.length, Number(response.headers.get('x-studio-backup-count')))
  const purge = await fetch(`${base}/logs/maintenance`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'purge-archive',
      beforeDate: '2099-01-01',
      backupToken,
      backupConfirmed: true,
      reason: '完整原始JSON已经保存'
    })
  })
  assert.equal(purge.status, 200)
  assert.equal((await purge.json()).affectedRows, backup.records.length)
})

test('HTTP归档满时完整维护账号可安全登录备份清理，失败登录不残留会话且业务仍阻断', async (t) => {
  const server = createStudioServer({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    auditHotMaxRows: 1,
    auditArchiveMaxBytes: 100000,
    clock: () => new Date('2026-10-13T04:00:00Z')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const service = server.service
  const ordinary = testMutate(service, 'admin', '/users', {
    username: 'capacity-admin',
    name: '普通管理员',
    role: 'admin',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: PASSWORD
  })
  const post = (path, body, cookie) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body)
    })
  await post('/login', { username: 'admin', password: PASSWORD })
  const ordinaryLogin = await post('/login', { username: ordinary.username, password: PASSWORD })
  const ordinaryCookie = ordinaryLogin.headers.get('set-cookie').split(';')[0]
  service.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run('admin')
  const archived = service.db.prepare('SELECT id,payload FROM audit_logs_archive LIMIT 1').get()
  const archiveBytes = service.logStorage('admin').archiveBytes
  service.db
    .prepare('UPDATE audit_logs_archive SET payload=? WHERE id=?')
    .run(archived.payload + ' '.repeat(100000 - archiveBytes), archived.id)
  const sessionCount = () =>
    Number(service.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n)
  const beforeSessions = sessionCount()
  const wrongPassword = await post('/login', { username: 'admin', password: 'incorrect' })
  assert.equal(wrongPassword.status, 401)
  assert.equal(wrongPassword.headers.get('set-cookie'), null)
  assert.equal(sessionCount(), beforeSessions)
  const denied = await post('/login', { username: ordinary.username, password: PASSWORD })
  assert.equal(denied.status, 503)
  assert.equal(denied.headers.get('set-cookie'), null)
  assert.equal(sessionCount(), beforeSessions)
  const blocked = await post('/profile', { name: '不能绕过日志容量修改' }, ordinaryCookie)
  assert.equal(blocked.status, 503)
  assert.equal(service.bootstrap(ordinary.id).user.name, ordinary.name)

  const recovery = await post('/login', { username: 'admin', password: PASSWORD })
  assert.equal(recovery.status, 200)
  const recoveryBody = await recovery.json()
  assert.ok(recoveryBody.maintenanceNotice.includes('完整备份'))
  const cookie = recovery.headers.get('set-cookie').split(';')[0]
  assert.equal(sessionCount(), 2, '保留普通账号原会话及一条新的维护会话，过期和失败会话不存在')
  assert.equal(
    Number(service.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at=0').get().n),
    0
  )
  assert.equal((await post('/profile', { name: '维护登录不豁免业务写入' }, cookie)).status, 503)
  const storage = await fetch(`${base}/logs/storage`, { headers: { cookie } }).then((r) => r.json())
  assert.equal(storage.maintenanceMode, true)
  assert.equal(storage.warning, true)
  assert.equal(storage.emergencyLoginRows, 1)
  assert.equal(storage.emergencyLoginMaxRows, 1000)
  assert.equal(storage.emergencyLoginRetentionDays, 30)
  const emergencyLogs = service.logs('admin', { source: 'hot', entity: 'session' }).records
  const emergency = emergencyLogs.find((row) => row.action === '登录（日志容量维护）')
  assert.equal(emergency.after.userId, 'admin')
  assert.equal(JSON.stringify(emergency).includes(PASSWORD), false)
  assert.equal(Object.hasOwn(emergency, 'token'), false)
  assert.equal(service.logDetail('admin', emergency.id).action, emergency.action)
  assert.equal(service.logs('admin', { source: 'archive', action: '日志容量维护' }).total, 0)
  const backup = await fetch(`${base}/logs/archive-backup?beforeDate=2099-01-01`, {
    headers: { cookie }
  })
  assert.equal(backup.status, 200)
  const backupToken = backup.headers.get('x-studio-backup-token')
  const records = (await backup.json()).records
  assert.ok(records.length > 0)
  const purge = await post(
    '/logs/maintenance',
    {
      action: 'purge-archive',
      beforeDate: '2099-01-01',
      backupToken,
      backupConfirmed: true,
      reason: '容量维护完整备份已保存'
    },
    cookie
  )
  assert.equal(purge.status, 200)
  assert.equal((await purge.json()).affectedRows, records.length)
  assert.equal(service.logStorage('admin').maintenanceMode, false)
  assert.equal((await post('/profile', { name: '恢复正常业务写入' }, cookie)).status, 200)
  assert.equal(service.bootstrap('admin').user.name, '恢复正常业务写入')

  service.db.exec(
    "CREATE TRIGGER fail_login_audit BEFORE INSERT ON audit_logs WHEN NEW.entity='session' BEGIN SELECT RAISE(ABORT,'unrelated audit write failure'); END"
  )
  const beforeUnexpected = sessionCount()
  const unexpected = await post('/login', { username: 'admin', password: PASSWORD })
  assert.equal(unexpected.status, 500, '其他审计错误不能被维护登录吞掉')
  assert.equal(unexpected.headers.get('set-cookie'), null)
  assert.equal(sessionCount(), beforeUnexpected)
  assert.equal(service.logStorage('admin').emergencyLoginRows, 1)
  service.db.exec('DROP TRIGGER fail_login_audit')
})

test('应急登录安全日志最多1000条并保留30天，不将业务或凭据内容写入环形日志', (t) => {
  let clock = new Date('2026-10-13T04:00:00Z')
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    clock: () => clock
  })
  t.after(() => service.close())
  const store = createAuditStore(service.db, { clock: () => clock })
  for (let index = 0; index < 1003; index++)
    store.appendEmergencyLogin({
      id: `security-${String(index).padStart(4, '0')}`,
      actorId: 'admin',
      actorName: '维护管理员',
      createdAt: clock.toISOString(),
      password: PASSWORD,
      token: 'must-not-be-persisted',
      after: { financialSecret: 'must-not-be-persisted' }
    })
  assert.equal(store.storage().emergencyLoginRows, 1000)
  const record = store.rows({ entity: 'session', limit: 1 })[0]
  assert.deepEqual(record.after, { userId: 'admin' })
  assert.equal(JSON.stringify(record).includes('must-not-be-persisted'), false)
  clock = new Date('2026-11-13T04:00:00Z')
  assert.equal(store.storage().emergencyLoginRows, 0)
  assert.equal(store.rows({ entity: 'session' }).length, 0)
  store.appendEmergencyLogin({
    id: 'security-fresh',
    actorId: 'admin',
    actorName: '维护管理员',
    createdAt: clock.toISOString()
  })
  assert.equal(
    Number(service.db.prepare('SELECT COUNT(*) AS n FROM audit_emergency_logins').get().n),
    1
  )
})

installTestClientFetch()
