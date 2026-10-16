import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioService } from '../server/studio.mjs'
import { getExportCatalog, buildExportSheets } from '../server/report-export.mjs'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
function fixture(t) {
  let time = new Date('2026-10-01T00:00:00Z')
  const s = createStudioService({
    dbPath: ':memory:',
    seed: false,
    password: 'isolated-readonly-test-123',
    clock: () => time
  })
  t.after(() => s.close())
  const upload = () => s.upload('admin', { name: '隔离.png', mime: 'image/png', data: png })
  const customer = s.mutate('admin', '/customers', {
    name: '只读客户',
    contact: '',
    gameId: '',
    remark: ''
  })
  const template = s.mutate('admin', '/templates', {
    name: '只读订单',
    game: '隔离',
    amount: 10000,
    reward: 7000,
    active: true
  })
  const order = (extra = {}) =>
    s.mutate('admin', '/orders', {
      requestId: randomUUID(),
      customerId: customer.id,
      templateId: template.id,
      platformId: 'xianyu',
      shopId: 'jindun',
      externalOrderNo: randomUUID(),
      roomCode: 'room',
      dispatchMode: 'pool',
      receivedAmount: 10000,
      paidAt: time.toISOString(),
      ...extra
    })
  return {
    s,
    upload,
    customer,
    order,
    setTime: (value) => {
      time = new Date(value)
    }
  }
}

test('单个只读请求复用解析，业务提交仍在事务内重新读取权威状态', (t) => {
  const f = fixture(t),
    o = f.order(),
    login = f.s.login('admin', 'isolated-readonly-test-123')
  const prepare = f.s.db.prepare.bind(f.s.db)
  let reads = 0
  f.s.db.prepare = (sql) => {
    if (sql === 'SELECT json FROM studio_state WHERE id=1') reads++
    return prepare(sql)
  }
  f.s.withReadScope(() => {
    f.s.session(login.token)
    f.s.ordersPage('admin', {})
    f.s.orderDetail('admin', o.id)
  })
  assert.equal(reads, 1)
  f.s.withReadScope(() => {
    const old = f.s.orderDetail('admin', o.id).order
    f.s.mutate('admin', `/orders/${o.id}/action`, {
      requestId: randomUUID(),
      expectedRevision: old.revision,
      action: 'remark',
      playerRemark: '真实变更'
    })
    assert.equal(f.s.orderDetail('admin', o.id).order.playerRemark, '真实变更')
  })
  assert.ok(reads >= 3)
})

test('轻量bootstrap不返回订单/报表，元数据目录不代替实际预览总数', (t) => {
  const f = fixture(t)
  f.order()
  f.order()
  const slim = f.s.bootstrap('admin', '2026-10', { includeOrders: false, includeReports: false })
  assert.equal(slim.orders.length, 0)
  assert.equal(slim.orderCounts.all, 2)
  assert.equal(slim.reports.days.length, 0)
  const catalog = getExportCatalog(
    f.s.exportCatalogSnapshot('admin', {
      month: '2026-10',
      period: { type: 'weekly', date: '2026-10-01' }
    })
  )
  assert.equal(catalog.period.type, 'weekly')
  assert.ok(catalog.modules.every((m) => m.rowCount === null))
  const request = {
    month: '2026-10',
    modules: [{ id: 'orders', fields: ['orderNo', 'playerRemark'] }],
    filters: {}
  }
  const sheets = buildExportSheets(f.s.exportSnapshot('admin', request), request, {
    previewLimit: 1
  })
  assert.equal(sheets.sheets[0].rowCount, 2)
  assert.equal(sheets.sheets[0].rows.length, 1)
})

test('安全回收仅删除7天前未引用上传，当前/历史业务和成功请求保留引用', (t) => {
  const f = fixture(t),
    orphan = f.upload(),
    receipt = f.upload(),
    fundReceipt = f.upload(),
    draft = f.upload()
  const o = f.order({ receipt })
  f.s.mutate('admin', '/customer-transactions', {
    requestId: randomUUID(),
    customerId: f.customer.id,
    kind: 'recharge',
    amount: 100,
    reason: '隔离测试',
    receipt: fundReceipt
  })
  const content = f.s.mutate('admin', '/player-content', {
    type: 'banner',
    title: '历史图',
    text: '',
    body: '',
    imageId: draft.id,
    sortOrder: 0,
    startAt: null,
    endAt: null
  })
  f.s.mutate('admin', `/player-content/${content.id}/delete`, { revision: content.revision })
  f.setTime('2026-10-10T00:00:00Z')
  const fresh = f.upload()
  const result = f.s.collectAbandonedUploads()
  assert.equal(result.deleted, 1)
  assert.equal(f.s.db.prepare('SELECT 1 FROM uploads WHERE id=?').get(orphan.id), undefined)
  for (const id of [receipt.id, fundReceipt.id, draft.id, fresh.id])
    assert.ok(f.s.db.prepare('SELECT 1 FROM uploads WHERE id=?').get(id))
  assert.equal(f.s.orderDetail('admin', o.id).order.receipt.id, receipt.id)
  assert.throws(() => f.s.collectAbandonedUploads({ before: '2026-10-09T00:00:00Z' }), /7天/)
})

test('回收游标不会被首批受保护图片阻塞', (t) => {
  const f = fixture(t),
    protectedImage = f.upload(),
    orphan = f.upload()
  f.order({ receipt: protectedImage })
  f.setTime('2026-10-10T00:00:00Z')
  // Sort deterministically for the scan, retaining the real data and associations.
  f.s.db
    .prepare('UPDATE uploads SET created_at=? WHERE id=?')
    .run('2026-10-01T00:00:00.000Z', protectedImage.id)
  f.s.db
    .prepare('UPDATE uploads SET created_at=? WHERE id=?')
    .run('2026-10-01T00:00:01.000Z', orphan.id)
  assert.equal(f.s.collectAbandonedUploads({ limit: 1 }).deleted, 0)
  assert.equal(f.s.collectAbandonedUploads({ limit: 1 }).deleted, 1)
  assert.ok(f.s.db.prepare('SELECT 1 FROM uploads WHERE id=?').get(protectedImage.id))
})

test('回收中途数据库失败不留下部分删除，完整回滚后可再执行', (t) => {
  const f = fixture(t),
    first = f.upload(),
    second = f.upload()
  f.setTime('2026-10-10T00:00:00Z')
  const prepare = f.s.db.prepare.bind(f.s.db)
  let deletions = 0
  f.s.db.prepare = (sql) => {
    const statement = prepare(sql)
    if (sql !== 'DELETE FROM uploads WHERE id=?') return statement
    return {
      run(...args) {
        if (++deletions === 2) throw new Error('isolated GC failure')
        return statement.run(...args)
      }
    }
  }
  assert.throws(() => f.s.collectAbandonedUploads(), /isolated GC failure/)
  for (const id of [first.id, second.id])
    assert.ok(prepare('SELECT 1 FROM uploads WHERE id=?').get(id))
  f.s.db.prepare = prepare
  assert.equal(f.s.collectAbandonedUploads().deleted, 2)
})

test('概览只读派生缓存按账号权限隔离，成功提交后更新，返回副本不可污染缓存', (t) => {
  const f = fixture(t)
  f.order()
  const support = f.s.mutate('admin', '/users', {
    username: 'readonly-support',
    name: '只读客服',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: 'isolated-readonly-test-123'
  })
  const query = { start: '2026-10-01', end: '2026-10-01' }
  const report = f.s.overview('admin', query),
    amount = report.metrics.received
  report.metrics.received = -99
  assert.equal(f.s.overview('admin', query).metrics.received, amount)
  assert.equal(f.s.overview(support.id, query).metrics.received, null)
  f.order()
  assert.equal(f.s.overview('admin', query).metrics.received, amount * 2)
  f.s.mutate('admin', '/users', { ...support, permissionOverrides: { 'profit.view': true } })
  assert.equal(f.s.overview(support.id, query).metrics.received, amount * 2)
  f.s.mutate('admin', '/users', { ...support, permissionOverrides: { 'profit.view': false } })
  assert.equal(f.s.overview(support.id, query).metrics.received, null)
})
