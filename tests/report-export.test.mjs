import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { getExportCatalog, buildExportSheets } from '../server/report-export.mjs'

const password = 'report-export-test-password-123'
function fixture(t) {
  const service = createStudioService({ dbPath: ':memory:', password, seed: true })
  t.after(() => service.close())
  const customer = service.mutate('admin', '/customers', {
    name: '=1+1',
    contact: '+861234567',
    gameId: '00007',
    remark: '导出测试'
  })
  const template = service.mutate('admin', '/templates', {
    name: '导出项目',
    game: '测试游戏',
    description: '完整投影验证',
    amount: 8812,
    reward: 7000,
    map: '不限',
    remark: '测试',
    active: true
  })
  const order = service.mutate('admin', '/orders', {
    templateId: template.id,
    customerId: customer.id,
    platformId: 'xianyu',
    shopId: 'jindun',
    externalOrderNo: '00012345678901234567890',
    channel: '闲鱼',
    roomCode: '00100',
    gameId: '00007',
    amount: 8812,
    reward: 7000,
    receivedAmount: 8812,
    paidAt: '2026-10-01T16:01:00.000Z',
    dispatchMode: 'pool'
  })
  const staff = (role) =>
    service.mutate('admin', '/users', {
      username: `export-${role}`,
      name: `测试${role}`,
      role,
      status: 'active',
      levelId: 'priority',
      maxActiveOrders: 1,
      permissionOverrides: {},
      password
    })
  const snapshot = (actor = 'admin') => service.bootstrap(actor, '2026-10', { exportMode: true })
  const exportSheet = (data, id, keys, filters = {}) =>
    buildExportSheets(data, { month: '2026-10', modules: [{ id, fields: keys }], filters })
      .sheets[0]
  return { service, staff, snapshot, exportSheet, order, customer, template }
}

test('导出模块按角色数据权限开放，客服无工资利润、打手仅本人资料和钱包', (t) => {
  const f = fixture(t)
  const support = f.staff('support')
  const hr = f.staff('hr')
  const player = f.staff('player')
  const supportData = f.snapshot(support.id)
  const supportModules = getExportCatalog(supportData).modules.map((row) => row.id)
  assert.ok(supportModules.includes('orders') && supportModules.includes('customers'))
  for (const id of [
    'overview',
    'days',
    'payroll',
    'salaryPlans',
    'staff',
    'roles',
    'logs',
    'wallets',
    'withdrawals'
  ])
    assert.ok(!supportModules.includes(id), id)
  assert.throws(
    () => f.exportSheet(supportData, 'payroll', ['total']),
    (error) => error instanceof ApiError && error.status === 403
  )
  const hrData = f.snapshot(hr.id)
  assert.ok(hrData.reports.payroll.every((row) => row.userId === hr.id))
  assert.ok(getExportCatalog(hrData).modules.some((row) => row.id === 'payroll'))
  const playerData = f.snapshot(player.id)
  const playerModules = getExportCatalog(playerData).modules.map((row) => row.id)
  assert.ok(playerModules.includes('profile') && playerModules.includes('wallets'))
  assert.ok(!playerModules.includes('orders') && !playerModules.includes('staff'))
  const personal = f.exportSheet(playerData, 'profile', ['username'])
  assert.equal(personal.rows[0].username, player.username)
  const serialized = JSON.stringify(personal)
  assert.ok(
    !serialized.includes(password) &&
      !serialized.includes('passwordHash') &&
      !serialized.includes('token')
  )
})

test('自选字段仅输出指定列，数字金额和长编号前导零保留原类型', (t) => {
  const f = fixture(t)
  const sheet = f.exportSheet(f.snapshot(), 'orders', ['externalOrderNo', 'gameId', 'amount'], {
    keyword: '00012345678901234567890'
  })
  assert.equal(sheet.rowCount, 1)
  assert.deepEqual(Object.keys(sheet.rows[0]), ['externalOrderNo', 'gameId', 'amount'])
  assert.equal(sheet.rows[0].externalOrderNo, '00012345678901234567890')
  assert.equal(sheet.rows[0].gameId, '00007')
  assert.equal(sheet.rows[0].amount, 88.12)
  assert.throws(
    () => f.exportSheet(f.snapshot(), 'orders', ['commissionSnapshot']),
    (error) => error instanceof ApiError && error.status === 400
  )
  assert.throws(
    () => f.exportSheet(f.snapshot(), 'orders', ['amount', 'amount']),
    (error) => error instanceof ApiError && error.status === 400
  )
})

test('付款日期范围使用上海时区，预览限制不截总量，空筛选保留字段', (t) => {
  const f = fixture(t)
  const data = f.snapshot()
  const sheet = f.exportSheet(data, 'orders', ['orderNo'], {
    orderDateKey: 'paidAt',
    dateRange: ['2026-10-02', '2026-10-02']
  })
  assert.ok(sheet.rows.some((row) => row.orderNo === f.order.orderNo))
  const previous = f.exportSheet(data, 'orders', ['orderNo'], {
    orderDateKey: 'paidAt',
    dateRange: ['2026-10-01', '2026-10-01']
  })
  assert.ok(!previous.rows.some((row) => row.orderNo === f.order.orderNo))
  const empty = f.exportSheet(data, 'orders', ['amount'], { keyword: '无记录关键词' })
  assert.equal(empty.rowCount, 0)
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.fields[0].key, 'amount')
  const request = { modules: [{ id: 'orders', fields: ['orderNo'] }] }
  const preview = buildExportSheets(data, request, { previewLimit: 1 }).sheets[0]
  assert.equal(preview.rows.length, 1)
  assert.equal(preview.rowCount, data.orders.length)
  assert.throws(
    () => f.exportSheet(data, 'orders', ['orderNo'], { dateRange: ['2026-02-30', '2026-10-01'] }),
    (error) => error instanceof ApiError && error.status === 400
  )
})

test('批量覆盖业务模块，空配置保持待配置而非零，静态配置不被日期误排除', (t) => {
  const f = fixture(t)
  const data = f.snapshot()
  const catalog = getExportCatalog(data)
  assert.ok(catalog.modules.length >= 24)
  const result = buildExportSheets(data, {
    modules: catalog.modules.map((module) => ({
      id: module.id,
      fields: module.fields.map((field) => field.key)
    }))
  })
  assert.equal(result.sheets.length, catalog.modules.length)
  const template = result.sheets.find((row) => row.id === 'templates')
  assert.ok(template.rows.some((row) => row.amount === '待配置'))
  const customer = f.exportSheet(data, 'customers', ['name', 'gameId'], {
    dateRange: ['1900-01-01', '1900-01-01']
  })
  assert.ok(customer.rows.some((row) => row.name === '=1+1' && row.gameId === '00007'))
  assert.ok(
    result.sheets.every((sheet) =>
      sheet.rows.every((row) => !Object.keys(row).some((key) => key.startsWith('_')))
    )
  )
})
