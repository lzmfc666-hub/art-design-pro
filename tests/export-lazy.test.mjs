import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_PERMISSIONS, ApiError, createStudioService } from '../server/studio.mjs'
import { buildExportSheets, getExportCatalog } from '../server/report-export.mjs'
import { buildPeriodExportSnapshot } from '../server/export-period.mjs'
import { testMutate } from './helpers/current-intent.mjs'

const forbid = (target, names) => {
  for (const name of names)
    Object.defineProperty(target, name, {
      configurable: true,
      get() {
        throw new Error(`Unselected ${name} was read`)
      }
    })
  return target
}
const tables = [
  'users',
  'customers',
  'platforms',
  'shops',
  'levels',
  'templates',
  'orders',
  'refunds',
  'withdrawals',
  'wallets',
  'expenses',
  'payrolls',
  'salaryPlans',
  'attendance',
  'workSchedules',
  'roleDefaults',
  'appearance',
  'logs',
  'playerAdjustments',
  'rewardReviews',
  'customerBalances',
  'customerTransactions',
  'playerDeposits',
  'playerDepositTransactions'
]
const metadata = () => ({
  user: { id: 'admin', name: '测试超管', username: 'admin', role: 'super_admin', status: 'active' },
  permissions: [...ALL_PERMISSIONS],
  reports: { month: '2026-10' }
})

test('元数据目录只构造37个授权模块的字段，不读取业务集合、图片或报表行', () => {
  const snapshot = forbid({ ...metadata(), catalogOnly: true }, tables)
  forbid(snapshot.reports, [
    'days',
    'channels',
    'performance',
    'payroll',
    'monthlyBase',
    'monthlyProfit'
  ])
  const result = getExportCatalog(snapshot)
  assert.equal(result.modules.length, 37)
  assert.ok(result.modules.every((module) => module.rowCount === null))
  const orders = result.modules.find((module) => module.id === 'orders')
  assert.equal(orders.fields.find((field) => field.key === 'remark').label, '内部备注')
  assert.equal(orders.fields.find((field) => field.key === 'playerRemark').label, '打手备注')
  assert.equal(JSON.stringify(result).includes('rows'), false)
})

test('仅导出本人资料不会读取未选择的订单、资金、人员、工资和配置集合', () => {
  const snapshot = forbid(metadata(), tables)
  forbid(snapshot.reports, [
    'days',
    'channels',
    'performance',
    'payroll',
    'monthlyBase',
    'monthlyProfit'
  ])
  const result = buildExportSheets(snapshot, {
    modules: [{ id: 'profile', fields: ['name', 'username'] }]
  })
  assert.deepEqual(result.sheets[0].rows, [{ name: '测试超管', username: 'admin' }])
  assert.equal(result.sheets[0].rowCount, 1)
})

test('无权限/字段无效先拒绝，不能为了校验先构造允许模块的业务行', () => {
  const snapshot = forbid(
    {
      ...metadata(),
      user: { ...metadata().user, role: 'hr' },
      permissions: ['reports.export', 'salary.view']
    },
    tables
  )
  assert.throws(
    () =>
      buildExportSheets(snapshot, {
        modules: [
          { id: 'profile', fields: ['name'] },
          { id: 'orders', fields: ['amount'] }
        ]
      }),
    (error) => error instanceof ApiError && error.status === 403
  )
  assert.throws(
    () => buildExportSheets(snapshot, { modules: [{ id: 'profile', fields: ['password'] }] }),
    /字段无效/
  )
})

test('预览流式处理只存所选字段和前20个匹配，先筛选再限量且保留真实总数', () => {
  const snapshot = forbid(
    metadata(),
    tables.filter((name) => name !== 'customers')
  )
  snapshot.customers = Array.from({ length: 250 }, (_, index) => ({
    id: `customer-${index}`,
    name: index % 2 ? `匹配-${index}` : `其他-${index}`,
    contact: 'PRIVATE-CONTACT'
  }))
  const result = buildExportSheets(
    snapshot,
    {
      modules: [{ id: 'customers', fields: ['name'] }],
      filters: { keyword: '匹配', keywordField: 'name' }
    },
    { previewLimit: 20 }
  )
  assert.equal(result.sheets[0].rowCount, 125)
  assert.equal(result.sheets[0].rows.length, 20)
  assert.deepEqual(result.sheets[0].rows[0], { name: '匹配-1' })
  assert.equal(JSON.stringify(result.sheets).includes('PRIVATE-CONTACT'), false)
})

test('选择员工周报且skipReportComputation时不计算跨月经营、工资及业绩', () => {
  const base = forbid({ ...metadata(), skipReportComputation: true }, [
    'orders',
    'refunds',
    'payrolls'
  ])
  const state = forbid({}, ['orders', 'refunds', 'payrolls', 'users', 'platforms', 'shops'])
  const result = buildPeriodExportSnapshot({
    base,
    state,
    request: { period: { type: 'weekly', date: '2026-10-01' } },
    now: '2026-10-14T00:00:00Z',
    monthReport() {
      throw new Error('Unrequested monthly reports computed')
    }
  })
  assert.equal(result.exportPeriod.start, '2026-09-28')
  assert.equal(result.exportPeriod.end, '2026-10-04')
  assert.equal(result.reports, base.reports)
})

test('日志预览没有选择修改前后时不序列化大型审计快照', () => {
  const snapshot = forbid(
    metadata(),
    tables.filter((name) => name !== 'logs')
  )
  const expensive = {
    toJSON() {
      throw new Error('Unselected audit snapshot serialized')
    }
  }
  snapshot.logs = [
    {
      id: 'audit-1',
      actorName: '测试财务',
      action: '调整订单',
      createdAt: '2026-10-14T00:00:00Z',
      before: expensive,
      after: expensive
    }
  ]
  const result = buildExportSheets(
    snapshot,
    { modules: [{ id: 'logs', fields: ['actorName'] }] },
    { previewLimit: 20 }
  )
  assert.deepEqual(result.sheets[0].rows, [{ actorName: '测试财务' }])
  assert.equal(result.sheets[0].rowCount, 1)
})

test('订单内部备注和明确打手备注分开导出，打手仍不能取得任一后台订单字段', (t) => {
  const service = createStudioService({
    dbPath: ':memory:',
    seed: true,
    password: 'lazy-export-test-only-123'
  })
  t.after(() => service.close())
  const snapshot = service.exportSnapshot('admin', { month: '2026-10' })
  snapshot.orders = [
    {
      id: 'test-order',
      orderNo: 'TEST-1',
      status: 'pending',
      amount: 100,
      reward: 50,
      receivedAmount: 100,
      createdAt: '2026-10-12T04:00:00Z',
      remark: 'PRIVATE-INTERNAL',
      playerRemark: 'PUBLIC-SERVICE-INSTRUCTION'
    }
  ]
  const exported = buildExportSheets(snapshot, {
    modules: [{ id: 'orders', fields: ['remark', 'playerRemark'] }]
  }).sheets[0]
  assert.deepEqual(exported.rows, [
    { remark: 'PRIVATE-INTERNAL', playerRemark: 'PUBLIC-SERVICE-INSTRUCTION' }
  ])
  const player = testMutate(service, 'admin', '/users', {
    username: 'lazy-export-player',
    name: '测试打手',
    role: 'player',
    status: 'active',
    levelId: 'priority',
    maxActiveOrders: 1,
    permissionOverrides: { 'orders.view': true },
    password: 'lazy-export-test-only-123'
  })
  const playerSnapshot = service.exportSnapshot(player.id, { month: '2026-10' })
  assert.throws(
    () =>
      buildExportSheets(playerSnapshot, {
        modules: [{ id: 'orders', fields: ['remark', 'playerRemark', 'amount'] }]
      }),
    (error) => error instanceof ApiError && error.status === 403
  )
})
