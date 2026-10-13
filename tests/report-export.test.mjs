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
  const staff = (role, permissionOverrides = {}) =>
    service.mutate('admin', '/users', {
      username: `export-${role}`,
      name: `测试${role}`,
      role,
      status: 'active',
      levelId: 'priority',
      maxActiveOrders: 1,
      permissionOverrides,
      password
    })
  const snapshot = (actor = 'admin', request = {}) =>
    service.exportSnapshot(actor, { month: '2026-10', ...request })
  const exportSheet = (data, id, keys, filters = {}) =>
    buildExportSheets(data, { month: '2026-10', modules: [{ id, fields: keys }], filters })
      .sheets[0]
  return { service, staff, snapshot, exportSheet, order, customer, template }
}

test('客服与主管即使覆盖授权也禁导，其他账号仅导出各自业务权限内的数据', (t) => {
  const f = fixture(t)
  const support = f.staff('support', { 'reports.export': true })
  const supportLead = f.staff('support_lead', { 'reports.export': true })
  const operations = f.staff('operations')
  const hr = f.staff('hr')
  const player = f.staff('player')
  for (const actor of [support, supportLead]) {
    const denied = f.service.bootstrap(actor.id, '2026-10')
    assert.throws(
      () => getExportCatalog(denied),
      (error) => error instanceof ApiError && error.status === 403
    )
    assert.throws(
      () => f.exportSheet(denied, 'profile', ['username']),
      (error) => error instanceof ApiError && error.status === 403
    )
    assert.throws(
      () => f.snapshot(actor.id),
      (error) => error instanceof ApiError && error.status === 403
    )
  }
  const operationsData = f.snapshot(operations.id)
  const operationsModules = getExportCatalog(operationsData).modules.map((row) => row.id)
  assert.ok(operationsModules.includes('orders') && operationsModules.includes('customers'))
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
    if (!['payroll', 'salaryPlans'].includes(id)) assert.ok(!operationsModules.includes(id), id)
  assert.throws(
    () => f.exportSheet(operationsData, 'overview', ['net']),
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
    keywordField: 'externalOrderNo',
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
  const empty = f.exportSheet(data, 'orders', ['amount'], {
    keywordField: 'orderNo',
    keyword: '无记录关键词'
  })
  assert.equal(empty.rowCount, 0)
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.fields[0].key, 'amount')
  const request = { modules: [{ id: 'orders', fields: ['orderNo'] }] }
  const preview = buildExportSheets(data, request, { previewLimit: 1 }).sheets[0]
  assert.equal(preview.rows.length, 1)
  assert.equal(
    preview.rowCount,
    data.orders.filter((row) => row.createdAt.startsWith('2026-10')).length
  )
  assert.throws(
    () => f.exportSheet(data, 'orders', ['orderNo'], { dateRange: ['2026-02-30', '2026-10-01'] }),
    (error) => error instanceof ApiError && error.status === 400
  )
})

test('批量覆盖业务模块，空配置保持待配置而非零，静态配置不被日期误排除', (t) => {
  const f = fixture(t)
  const data = f.snapshot()
  const catalog = getExportCatalog(data)
  assert.equal(catalog.modules.length, 35)
  assert.ok(catalog.modules.some((module) => module.id === 'workSchedules'))
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
  const sources = result.sheets.find((row) => row.id === 'platforms')
  assert.ok(!sources.fields.some((field) => field.key === 'operatorCommission'))
  const xianyu = sources.rows.find((row) => row.id === 'xianyu')
  assert.deepEqual(
    [
      xianyu.requiresShop,
      xianyu.requiresExternalOrderNo,
      xianyu.requiresReceipt,
      xianyu.allowPayOnArrival
    ],
    ['是', '是', '否', '否']
  )
  const hall = sources.rows.find((row) => row.id === 'hall')
  assert.deepEqual(
    [hall.requiresShop, hall.requiresExternalOrderNo, hall.requiresReceipt, hall.allowPayOnArrival],
    ['否', '否', '是', '是']
  )
})

test('界面外观导出只投影所选配置和站内图片地址，普通账号无法导出', (t) => {
  const f = fixture(t)
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
  const image = (name) => f.service.upload('admin', { name, mime: 'image/png', data: png })
  const logo = image('导出标志.png')
  const page = image('页面背景.png')
  const hero = image('欢迎横幅.png')
  const previous = f.snapshot().appearance
  f.service.mutate('admin', '/appearance', {
    revision: previous.revision,
    config: {
      ...previous,
      studioName: '外观导出工作室',
      logo,
      page: { mode: 'image', color: '#aabbcc', image: page, overlay: 65 },
      hero: { mode: 'image', color: '#80b7ff', image: hero, overlay: 40, showDecoration: false },
      icons: { dashboard: 'ri:gamepad-line', export: 'ri:download-2-line' }
    }
  })
  const adminData = f.snapshot()
  const module = getExportCatalog(adminData).modules.find((item) => item.id === 'appearance')
  assert.ok(module)
  assert.equal(module.rowCount, 1)
  const keys = module.fields.map((field) => field.key)
  const sheet = f.exportSheet(adminData, 'appearance', keys, {
    dateRange: ['1900-01-01', '1900-01-01']
  })
  assert.equal(sheet.rowCount, 1)
  assert.deepEqual(Object.keys(sheet.rows[0]), keys)
  const row = sheet.rows[0]
  assert.equal(row.studioName, '外观导出工作室')
  assert.equal(row.logoName, logo.name)
  assert.equal(row.logoUrl, `/api/studio/uploads/${logo.id}`)
  assert.equal(row.pageImageName, page.name)
  assert.equal(row.pageImageUrl, `/api/studio/uploads/${page.id}`)
  assert.equal(row.heroImageName, hero.name)
  assert.equal(row.heroImageUrl, `/api/studio/uploads/${hero.id}`)
  assert.equal(row.pageMode, '图片')
  assert.equal(row.pageColor, '#aabbcc')
  assert.equal(row.pageOverlay, 65)
  assert.equal(row.heroOverlay, 40)
  assert.equal(row.showDecoration, '否')
  assert.equal(row.revision, 1)
  assert.match(row.updatedAt, /^\d{4}-\d{2}-\d{2} /)
  assert.ok(row.icons.includes('工作台：ri:gamepad-line'))
  assert.ok(row.icons.includes('财务管理：ri:wallet-3-line'))
  assert.ok(!JSON.stringify(sheet).includes(png))
  assert.ok(!JSON.stringify(sheet).includes('base64'))
  assert.ok(!keys.includes('data') && !keys.includes('logo') && !keys.includes('updatedBy'))
  assert.deepEqual(f.exportSheet(adminData, 'appearance', ['studioName', 'logoUrl']).rows, [
    { studioName: '外观导出工作室', logoUrl: `/api/studio/uploads/${logo.id}` }
  ])
  assert.throws(
    () => f.exportSheet(adminData, 'appearance', ['data']),
    (error) => error instanceof ApiError && error.status === 400
  )
  const hr = f.staff('hr')
  const hrData = f.snapshot(hr.id)
  assert.equal(hrData.appearance.studioName, '外观导出工作室')
  assert.ok(!getExportCatalog(hrData).modules.some((item) => item.id === 'appearance'))
  assert.throws(
    () => f.exportSheet(hrData, 'appearance', ['studioName', 'logoUrl']),
    (error) => error instanceof ApiError && error.status === 403
  )
})

function largeReferenceFixture(t) {
  const service = createStudioService({ dbPath: ':memory:', password, seed: false })
  t.after(() => service.close())
  const customer = service.mutate('admin', '/customers', { name: '旧客户 ÉTHAN' })
  const other = service.mutate('admin', '/customers', { name: '其他客户' })
  const platform = service.mutate('admin', '/platforms', {
    name: '独立来源É',
    rules: {
      requiresShop: true,
      requiresExternalOrderNo: true,
      requiresReceipt: false,
      allowPayOnArrival: false
    }
  })
  const shop = service.mutate('admin', '/shops', { platformId: platform.id, name: '旧店铺É' })
  const target = service.mutate('admin', '/customer-order-references', {
    customerId: customer.id,
    platformId: platform.id,
    shopId: shop.id,
    externalOrderNo: '000-É-Référence'
  })
  // 直接填充合法关联表作为大数据夹具，避免生成十万条无关审计操作。
  const insert = service.db.prepare('INSERT INTO customer_order_references VALUES(?,?,?,?,?)')
  service.db.exec('BEGIN')
  for (let index = 0; index < 100001; index++)
    insert.run(`export-bulk-${index}`, other.id, 'xianyu', 'jindun', `BULK-${index}`)
  service.db.exec('COMMIT')
  const request = (
    filters = {},
    modules = [{ id: 'customerOrderReferences', fields: ['externalOrderNo'] }]
  ) => ({
    month: '2026-10',
    period: { type: 'total' },
    modules,
    filters
  })
  const exportRows = (body) => {
    const snapshot = service.exportSnapshot('admin', body)
    return { snapshot, result: buildExportSheets(snapshot, body) }
  }
  return { service, customer, platform, shop, target, request, exportRows }
}

test('十万条之后的旧客户编号按所选字段和来源在SQL截取前筛选，Unicode大小写与导出一致', (t) => {
  const f = largeReferenceFixture(t)
  for (const filters of [
    { keywordField: 'externalOrderNo', keyword: 'é-référence' },
    { keywordField: 'customerName', keyword: 'éthan' },
    { keywordField: 'platformName', keyword: '独立来源é' },
    { keywordField: 'shopName', keyword: '旧店铺é' },
    { platformId: f.platform.id },
    { platformId: f.platform.id, keywordField: 'externalOrderNo', keyword: '000-É' }
  ]) {
    const { snapshot, result } = f.exportRows(f.request(filters))
    assert.equal(snapshot.customerOrderReferenceCount, 1)
    assert.equal(
      getExportCatalog(snapshot).modules.find((row) => row.id === 'customerOrderReferences')
        .rowCount,
      1
    )
    assert.equal(result.sheets[0].rowCount, 1)
    assert.deepEqual(result.sheets[0].rows, [{ externalOrderNo: f.target.externalOrderNo }])
  }
  const unmatched = f.exportRows(
    f.request({ keywordField: 'customerName', keyword: f.target.externalOrderNo })
  )
  assert.equal(unmatched.snapshot.customerOrderReferenceCount, 0)
  assert.equal(unmatched.result.sheets[0].rowCount, 0)
  assert.equal(f.service.bootstrap('admin').orders.length, 0)
})

test('客户编号匹配超限明确拒绝且未选择该模块不受影响，筛选可缩小到完整可导出结果', (t) => {
  const f = largeReferenceFixture(t)
  const catalog = f.service.exportSnapshot('admin', { month: '2026-10' })
  assert.equal(catalog.customerOrderReferenceCount, 100002)
  for (const filters of [
    {},
    { platformId: 'xianyu' },
    { keywordField: 'externalOrderNo', keyword: 'BULK-' }
  ])
    assert.throws(
      () => f.service.exportSnapshot('admin', f.request(filters)),
      (error) => error instanceof ApiError && error.status === 400 && error.message.includes('缩小')
    )
  const own = f.exportRows(f.request({}, [{ id: 'profile', fields: ['username'] }]))
  assert.deepEqual(own.result.sheets[0].rows, [{ username: 'admin' }])
  const empty = f.exportRows(
    f.request({ platformId: f.platform.id, keywordField: 'externalOrderNo', keyword: 'BULK-' })
  )
  assert.equal(empty.snapshot.customerOrderReferenceCount, 0)
  assert.deepEqual(empty.result.sheets[0].rows, [])
  assert.throws(
    () => f.exportRows(f.request({ keywordField: '__proto__', keyword: 'test' })),
    (error) => error instanceof ApiError && error.status === 400
  )
})
