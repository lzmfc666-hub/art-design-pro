import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'

const PASSWORD = 'diagnostics-test-password-123'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
function fixture(t, service) {
  const providedService = Boolean(service)
  service ||= createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    clock: () => new Date('2026-10-13T04:00:00Z')
  })
  if (!providedService) t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, body)
  const level = mutate('/levels', { name: '检查等级', delaySeconds: 0 })
  const staff = (role, overrides = {}) =>
    mutate('/users', {
      username: `check-${role}`,
      name: `检查${role}`,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 10,
      permissionOverrides: overrides,
      password: PASSWORD
    })
  const users = Object.fromEntries(
    ['owner', 'admin', 'finance', 'support', 'player'].map((role) => [role, staff(role)])
  )
  const customer = mutate('/customers', {
    name: '检查客户',
    contact: 'private-diagnostic-contact',
    gameId: '0001',
    remark: '',
    platformId: 'xianyu'
  })
  const template = mutate('/templates', {
    name: '检查项目',
    game: '测试',
    description: '',
    amount: 8800,
    reward: 7000,
    map: '',
    remark: '',
    active: true
  })
  const upload = (actor = 'admin') =>
    service.upload(actor, { name: '检查凭证.png', mime: 'image/png', data: PNG })
  const order = (changes = {}) =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId: 'hall',
        shopId: null,
        externalOrderNo: '',
        roomCode: 'ROOM',
        gameId: '0001',
        receivedAmount: 8800,
        amount: 8800,
        reward: 7000,
        paidAt: '2026-10-12T10:00:00+08:00',
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
  const savedState = () =>
    JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const changeState = (change) => {
    const state = savedState()
    change(state)
    service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
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
    savedState,
    changeState
  }
}
const has = (report, entity, message, severity = 'error') =>
  report.issues.some(
    (row) => row.entity === entity && row.severity === severity && row.message.includes(message)
  )

test('真实有效待办、指定待接单、冲正和恢复不误报，缺配置与人工差额只列提醒', (t) => {
  const f = fixture(t)
  f.order()
  const complete = f.complete(f.order())
  const withdrawal = f.mutate('/player/withdrawals', { amount: 7000 }, f.users.player.id)
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt: f.upload() })
  f.mutate(`/orders/${complete.id}/action`, {
    action: 'correct-status',
    status: 'active',
    reason: '核对状态'
  })
  const manual = f.savedState().playerAdjustments.find((row) => row.orderId === complete.id)
  assert.equal(manual.manualAmount, 7000)
  f.mutate('/attendance', {
    userId: f.users.finance.id,
    date: '2026-10-20',
    start: '',
    end: '',
    status: 'normal',
    actualHours: null,
    remark: ''
  })
  f.mutate('/attendance', {
    userId: f.users.finance.id,
    date: '2026-10-21',
    start: '',
    end: '',
    status: 'rest',
    actualHours: 0,
    remark: ''
  })
  const canceled = f.order()
  f.mutate(`/player/orders/${canceled.id}/claim`, {}, f.users.player.id)
  f.mutate(`/orders/${canceled.id}/action`, { action: 'cancel', reason: '等待补偿核对' })
  const report = f.service.diagnostics('admin')
  assert.equal(report.summary.errorCount, 0)
  assert.equal(report.status, 'warning')
  assert.ok(has(report, 'player-adjustment', '线下待追回', 'warning'))
  assert.ok(has(report, 'order', '最终补偿', 'warning'))
  assert.ok(has(report, 'user', '配置未齐', 'warning'))
  assert.equal(has(report, 'attendance', '未来'), false)
  f.mutate(`/player-adjustments/${manual.id}/action`, {
    action: 'resolve',
    resolution: 'recovered',
    reason: '线下已收回'
  })
  f.mutate(`/orders/${complete.id}/action`, {
    action: 'correct-status',
    status: 'completed',
    reason: '恢复原结算'
  })
  const restored = f.service.diagnostics('admin')
  assert.equal(
    restored.summary.errorCount,
    0,
    '恢复可额外补回线下追回金额，不用当前订单报酬硬比钱包'
  )
  const reduced = f.complete(f.order())
  f.mutate(`/orders/${reduced.id}/action`, {
    action: 'adjust',
    amount: 8800,
    reward: 6000,
    reason: '已提现后的旧报酬核对'
  })
  assert.equal(
    f.service.diagnostics('admin').summary.errorCount,
    0,
    '有历史人工差额时不强行要求旧到账等于现报酬'
  )
})

test('取消补偿结算后合法恢复执行保留历史标记，检查不将其误认为仍处结算终态', (t) => {
  const f = fixture(t)
  const order = f.order()
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.users.player.id)
  f.mutate(`/orders/${order.id}/action`, { action: 'cancel', reason: '实际任务取消' })
  const settled = f.mutate(`/orders/${order.id}/action`, {
    action: 'cancel-settle',
    reward: 5000,
    teammateId: null,
    reason: '确认取消补偿'
  })
  assert.equal(settled.compensationSettled, true)
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
  const active = f.mutate(`/orders/${order.id}/action`, {
    action: 'correct-status',
    status: 'active',
    reason: '核对后恢复执行'
  })
  assert.equal(active.compensationSettled, true, '合法历史字段保持不变，不修改业务迁就检查')
  assert.equal(f.savedState().statusCorrectionReversals[order.id].active, true)
  const report = f.service.diagnostics('admin')
  assert.equal(report.summary.errorCount, 0)
  assert.equal(has(report, 'order', '已结算但仍'), false)
})

test('冲正总额相同但扣款挂错现存打手时按收款人核对检测真实遗漏', (t) => {
  const f = fixture(t)
  const other = f.mutate('/users', {
    username: 'other-reversal-player',
    name: '另一个真实打手',
    role: 'player',
    status: 'active',
    levelId: f.users.player.levelId,
    maxActiveOrders: 10,
    permissionOverrides: {},
    password: PASSWORD
  })
  const order = f.complete(f.order())
  f.mutate(`/orders/${order.id}/action`, {
    action: 'correct-status',
    status: 'active',
    reason: '重新执行'
  })
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
  f.changeState((state) => {
    const id = state.statusCorrectionReversals[order.id].adjustmentIds[0]
    Object.assign(
      state.playerAdjustments.find((row) => row.id === id),
      {
        userId: other.id,
        appliedAmount: 0,
        manualAmount: 7000,
        status: 'manual'
      }
    )
  })
  const report = f.service.diagnostics('admin')
  assert.ok(has(report, 'order', '到账人员或金额不一致'))
  assert.ok(report.checks.find((row) => row.id === 'rewards').errorCount > 0)
  assert.equal(
    has(report, 'wallet', '超过有效报酬'),
    false,
    '本例钱包总量无缺口，问题由按人冲正核对检出'
  )
})

test('双人冲正重复引用一位打手流水即使总额相等也被明确检出', (t) => {
  const f = fixture(t)
  const other = f.mutate('/users', {
    username: 'teammate-reversal-player',
    name: '实际队友',
    role: 'player',
    status: 'active',
    levelId: f.users.player.levelId,
    maxActiveOrders: 10,
    permissionOverrides: {},
    password: PASSWORD
  })
  const order = f.order()
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.users.player.id)
  f.mutate(
    `/player/orders/${order.id}/submit`,
    {
      screenshots: [f.upload(f.users.player.id)],
      teammateId: other.id
    },
    f.users.player.id
  )
  f.mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  f.mutate(`/orders/${order.id}/action`, {
    action: 'correct-status',
    status: 'active',
    reason: '双人任务重做'
  })
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
  f.changeState((state) => {
    const reversal = state.statusCorrectionReversals[order.id]
    assert.equal(reversal.adjustmentIds.length, 2)
    const firstId = reversal.adjustmentIds[0]
    const first = state.playerAdjustments.find((row) => row.id === firstId)
    assert.equal(first.amount * 2, order.reward, '错误引用的合计仍等于原整单报酬')
    reversal.adjustmentIds = [firstId, firstId]
  })
  const report = f.service.diagnostics('admin')
  assert.ok(has(report, 'order', '重复引用同一扣款流水'))
  assert.ok(has(report, 'order', '到账人员或金额不一致'))
})

test('发现真实关联、重复到账、钱包缺口、客户来源和已发工资算术异常', (t) => {
  const f = fixture(t)
  const completed = f.complete(f.order())
  const reference = f.mutate('/customer-order-references', {
    customerId: f.customer.id,
    platformId: 'xianyu',
    shopId: 'jindun',
    externalOrderNo: '000123'
  })
  f.service.db
    .prepare('UPDATE customer_order_references SET platform_id=? WHERE id=?')
    .run('hall', reference.id)
  f.changeState((state) => {
    const record = state.orders.find((row) => row.id === completed.id)
    record.customerId = 'missing-customer'
    record.leaderId = null
    record.receivedAmount = 8800.5
    state.rewardCredits.push({ ...state.rewardCredits[0], id: 'duplicate-credit' })
    state.withdrawals.push({
      id: 'unfunded-withdrawal',
      userId: f.users.player.id,
      amount: 100000,
      status: 'pending',
      createdAt: '2026-10-13T04:00:00Z'
    })
    state.payrolls.push({
      id: 'bad-payroll',
      month: '2026-10',
      status: 'paid',
      paidAt: '2026-10-13T04:00:00Z',
      paidBy: 'admin',
      lines: [
        {
          userId: f.users.finance.id,
          name: '财务',
          role: 'finance',
          base: 2000,
          commission: 300,
          deduction: -50,
          total: 2300,
          incomplete: false
        }
      ]
    })
  })
  const report = f.service.diagnostics('admin')
  assert.equal(report.status, 'error')
  assert.ok(has(report, 'order', '客户关联不存在'))
  assert.ok(has(report, 'order', '缺少实际负责人'))
  assert.ok(has(report, 'order', '整数分'))
  assert.ok(has(report, 'reward-credit', '重复基础到账'))
  assert.ok(has(report, 'wallet', '超过有效报酬'))
  assert.ok(has(report, 'customer-reference', '店铺与来源不一致'))
  assert.ok(has(report, 'payroll', '快照合计'))
  assert.ok(report.checks.find((row) => row.id === 'payroll').errorCount > 0)
  const json = JSON.stringify(report)
  for (const secret of [
    PASSWORD,
    'private-diagnostic-contact',
    'passwords',
    'permissionOverrides',
    'receipt',
    '2300'
  ])
    assert.equal(json.includes(secret), false)
})

test('合法差额和负工资快照不被当前方案重算，同月重复正底薪及退款在途超额可检测', (t) => {
  const f = fixture(t)
  const order = f.order({
    platformId: 'xianyu',
    shopId: 'jindun',
    externalOrderNo: '000-REFUND',
    receipt: null
  })
  f.changeState((state) => {
    state.payrolls.push({
      id: 'historic-payroll',
      month: '2026-09',
      status: 'paid',
      paidAt: '2026-10-01T04:00:00Z',
      paidBy: 'admin',
      lines: [
        {
          userId: f.users.finance.id,
          name: '历史名',
          role: 'finance',
          base: 1000,
          commission: 0,
          deduction: 2000,
          total: -1000,
          incomplete: false
        }
      ]
    })
  })
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
  f.changeState((state) => {
    state.payrolls.push({ ...state.payrolls[0], id: 'duplicate-base' })
    state.refunds.push(
      { id: 'refunded', orderId: order.id, amount: 7000, status: 'paid' },
      { id: 'reserved', orderId: order.id, amount: 2000, status: 'pending' },
      { id: 'rejected-refund', orderId: order.id, amount: 99999, status: 'rejected' }
    )
  })
  const report = f.service.diagnostics('admin')
  assert.ok(has(report, 'payroll', '重复发放正底薪'))
  assert.ok(has(report, 'order', '在途申请合计超过'))
  assert.equal(report.issues.filter((row) => row.message.includes('在途申请合计超过')).length, 1)
})

test('最多返回100条且统计全部异常，错误优先于正常待办提醒', (t) => {
  const f = fixture(t)
  f.changeState((state) => {
    for (let index = 0; index < 125; index++)
      state.withdrawals.push({
        id: `invalid-${index}`,
        userId: f.users.player.id,
        amount: -1,
        status: 'pending'
      })
  })
  const report = f.service.diagnostics('admin')
  assert.equal(report.issues.length, 100)
  assert.equal(report.summary.returnedIssues, 100)
  assert.equal(report.summary.truncated, true)
  assert.equal(report.summary.errorCount, 125)
  assert.ok(report.summary.warningCount > 0)
  assert.ok(report.issues.every((row) => row.severity === 'error'))
  assert.equal(report.summary.issueCount, report.summary.errorCount + report.summary.warningCount)
})

test('真实HTTP诊断含鉴权链严格零写入，旧JSON日志不迁移，普通管理员财务和客服均不能读取', async (t) => {
  const server = createStudioServer({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    clock: () => new Date('2026-10-13T04:00:00Z')
  })
  const f = fixture(t, server.service)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  f.complete(f.order())
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const login = async (username) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD })
    })
    assert.equal(res.status, 200)
    return res.headers.get('set-cookie').split(';')[0]
  }
  const cookies = Object.fromEntries(
    await Promise.all(
      ['owner', 'admin', 'finance', 'support'].map(async (role) => [
        role,
        await login(f.users[role].username)
      ])
    )
  )
  f.mutate('/users', {
    ...f.users.support,
    permissionOverrides: Object.fromEntries(
      f.service.bootstrap('admin').permissions.map((key) => [key, true])
    )
  })
  const superCookie = await login('admin')
  f.changeState((state) => {
    state.logs.push({
      id: 'legacy-not-migrated',
      actorId: 'admin',
      actorName: '旧日志',
      action: '旧事件',
      entity: 'expense',
      entityId: 'old',
      createdAt: '2026-10-01T00:00:00Z',
      before: null,
      after: { financialSecret: 'must-stay-in-database' }
    })
  })
  const beforeJson = f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  const changes = () => Number(f.service.db.prepare('SELECT total_changes() AS n').get().n)
  const beforeChanges = changes()
  f.service.db.exec('PRAGMA query_only=ON')
  for (const cookie of [superCookie, cookies.owner, superCookie]) {
    const response = await fetch(`${base}/diagnostics`, { headers: { cookie } })
    assert.equal(response.status, 200)
    const report = await response.json()
    assert.equal(report.readOnly, true)
    assert.equal(report.summary.errorCount, 0)
    assert.equal(JSON.stringify(report).includes('must-stay-in-database'), false)
  }
  assert.equal((await fetch(`${base}/diagnostics`)).status, 401)
  for (const role of ['admin', 'finance', 'support'])
    assert.equal(
      (await fetch(`${base}/diagnostics`, { headers: { cookie: cookies[role] } })).status,
      403
    )
  assert.throws(
    () => f.service.diagnostics(f.users.support.id),
    (error) => error instanceof ApiError && error.status === 403,
    '客服硬禁导出使完整检查权限组合不成立'
  )
  assert.equal(changes(), beforeChanges)
  assert.equal(
    f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json,
    beforeJson
  )
  assert.equal(
    f.service.db.prepare('SELECT id FROM audit_logs WHERE id=?').get('legacy-not-migrated'),
    undefined
  )
  f.service.db.exec('PRAGMA query_only=OFF')
})

test('主动归档无候选不写新日志，过期候选按实际移动数量回报', (t) => {
  let clock = new Date('2026-10-13T04:00:00Z')
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    auditHotMaxRows: 3,
    clock: () => clock
  })
  t.after(() => service.close())
  for (let index = 0; index < 3; index++)
    service.mutate('admin', '/profile', { name: `归档测试${index}` })
  const before = service.logStorage('admin')
  const logs = service.logs('admin', { source: 'all' }).records
  const result = service.mutate('admin', '/logs/maintenance', { action: 'archive' })
  assert.equal(result.affectedRows, 0)
  assert.deepEqual(service.logStorage('admin'), before)
  assert.deepEqual(service.logs('admin', { source: 'all' }).records, logs)
  clock = new Date('2027-01-13T04:00:00Z')
  const archived = service.mutate('admin', '/logs/maintenance', { action: 'archive' })
  assert.equal(archived.affectedRows, 3)
  assert.equal(archived.storage.archiveRows, 3)
  assert.equal(archived.storage.hotRows, 1)
  assert.equal(service.logs('admin', { source: 'archive' }).total, 3)
})

test('主动归档移动后恰好达到热阈值，响应包含维护审计附带的自动归档条数', (t) => {
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    auditHotMaxRows: 3,
    clock: () => new Date('2026-10-13T04:00:00Z')
  })
  t.after(() => service.close())
  for (let index = 0; index < 3; index++)
    service.mutate('admin', '/profile', { name: `边界${index}` })
  const raw = {
    id: 'extra-old-candidate',
    actorId: 'admin',
    actorName: '管理员',
    action: '旧版候选',
    entity: 'session',
    entityId: 'admin',
    createdAt: '2026-10-01T00:00:00Z',
    before: null,
    after: { userId: 'admin' }
  }
  const payload = JSON.stringify(raw)
  service.db
    .prepare('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)')
    .run(
      raw.id,
      raw.actorId,
      raw.action,
      raw.entity,
      raw.entityId,
      raw.createdAt,
      payload,
      Buffer.byteLength(payload)
    )
  const before = service.logStorage('admin').archiveRows
  const result = service.mutate('admin', '/logs/maintenance', { action: 'archive' })
  assert.equal(result.candidateRows, 1)
  assert.equal(result.automaticArchiveRows, 1)
  assert.equal(result.affectedRows, 2)
  assert.equal(result.storage.archiveRows - before, result.affectedRows)
  assert.equal(result.storage.hotRows, 3)
  const maintenance = service.logs('admin', { source: 'all', entity: 'audit-maintenance' })
    .records[0]
  assert.equal(maintenance.after.candidateRows, 1)
})
