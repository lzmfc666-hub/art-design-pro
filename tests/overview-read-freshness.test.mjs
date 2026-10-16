import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStudioService } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'
import { createFundsStore } from '../server/funds-store.mjs'
import { testMutate } from './helpers/current-intent.mjs'

const PASSWORD = 'overview-freshness-isolated-password'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const RANGE = { start: '2026-10-01', end: '2026-10-31' }
const changes = (service) => service.db.prepare('SELECT total_changes() AS n').get().n
const stateText = (service) =>
  service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
const dataVersion = (service) => service.db.prepare('PRAGMA data_version').get().data_version

function populate(service) {
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '读取新鲜度即时等级', delaySeconds: 0 })
  let sequence = 0
  const user = (role, permissionOverrides = {}) =>
    mutate('/users', {
      username: `freshness-${++sequence}`,
      name: `隔离${role}${sequence}`,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 5,
      password: PASSWORD,
      permissionOverrides
    })
  const supportA = user('support'),
    supportB = user('support'),
    player = user('player')
  const customer = mutate('/customers', {
    name: '读取新鲜度客户',
    contact: '',
    gameId: '',
    remark: ''
  })
  const template = mutate('/templates', {
    name: '读取新鲜度任务',
    game: '三角洲',
    description: '',
    amount: 10000,
    reward: 2000,
    map: '不限',
    remark: '',
    active: true
  })
  const upload = (actor = 'admin') =>
    service.upload(actor, {
      name: 'isolated-freshness.png',
      mime: 'image/png',
      data: PNG
    })
  const order = (actor, amount, paidAt = '2026-10-15T07:00:00+08:00') =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId: 'hall',
        amount,
        reward: 2000,
        receivedAmount: amount,
        paidAt,
        receipt: upload(actor),
        roomCode: 'ISOLATED-ROOM',
        gameId: 'ISOLATED-GAME',
        dispatchMode: 'pool'
      },
      actor
    )
  const complete = (row) => {
    mutate(`/player/orders/${row.id}/claim`, {}, player.id)
    mutate(`/player/orders/${row.id}/submit`, { screenshots: [upload(player.id)] }, player.id)
    mutate(`/orders/${row.id}/action`, { action: 'review-pass' })
  }
  const overview = (actor = 'admin', input = RANGE) => service.overview(actor, input)
  const detail = (metric, view, actor = 'admin', input = RANGE) =>
    service.overviewDetails(actor, {
      ...input,
      metric,
      view,
      size: 100
    })
  return {
    service,
    mutate,
    user,
    supportA,
    supportB,
    player,
    customer,
    upload,
    order,
    complete,
    overview,
    detail
  }
}

function fixture(t, initialTime = '2026-10-15T00:00:00Z') {
  let time = new Date(initialTime)
  const service = createStudioService({
    dbPath: ':memory:',
    seed: false,
    password: PASSWORD,
    clock: () => time
  })
  t.after(() => service.close())
  return {
    ...populate(service),
    setTime: (value) => {
      time = new Date(value)
    }
  }
}

test('相同角色和权限的两账号交替读取同日期本人业绩，不串记录、总数或金额', (t) => {
  const f = fixture(t)
  const first = f.order(f.supportA.id, 13000),
    second = f.order(f.supportB.id, 24000)
  f.complete(first)
  f.complete(second)
  assert.deepEqual(
    f.service.bootstrap(f.supportA.id).permissions,
    f.service.bootstrap(f.supportB.id).permissions
  )
  for (const [actor, expectedOrder, expectedAmount] of [
    [f.supportA.id, first, 13000],
    [f.supportB.id, second, 24000],
    [f.supportA.id, first, 13000],
    [f.supportB.id, second, 24000]
  ]) {
    const overview = f.overview(actor)
    const details = f.detail('personal', 'completed-orders', actor)
    assert.equal(overview.metrics.personalNet, expectedAmount)
    assert.equal(details.total, 1)
    assert.deepEqual(
      details.records.map((row) => row.id),
      [expectedOrder.id]
    )
    assert.equal(details.records[0].net, expectedAmount)
    assert.deepEqual(details.summary, overview.metrics)
  }
})

test('已预热读取仍即时执行撤权，同日无数据库写入的会话过期不能读取旧结果', async (t) => {
  let time = new Date('2026-10-14T16:01:00Z') // 上海10月15日00:01，12小时过期仍在同一天。
  const server = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password: PASSWORD,
    clock: () => time,
    maintenanceFromEnv: false,
    trustedProxies: '',
    backups: { intervalMinutes: 0 },
    uploadCleanup: { enabled: false },
    notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] }
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  t.after(() => new Promise((done) => server.close(done)))
  const f = populate(server.service)
  let actor = f.user('hr', { 'profit.view': true, 'orders.view': true })
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  assert.ok(![3006, 3007, 3008].includes(server.address().port))
  const login = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: actor.username, password: PASSWORD })
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const get = (path) => fetch(base + path, { headers: { Cookie: cookie } })
  const overviewPath = '/overview?start=2026-10-01&end=2026-10-31'
  const detailsPath =
    '/overview/details?metric=received&view=paid-orders&start=2026-10-01&end=2026-10-31'
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal((await get(overviewPath)).status, 200)
    assert.equal((await get(detailsPath)).status, 200)
  }
  actor = f.mutate('/users', {
    ...actor,
    permissionOverrides: {
      'profit.view': false,
      'orders.view': true
    }
  })
  assert.equal((await get(detailsPath)).status, 403)
  assert.equal((await (await get(overviewPath)).json()).metrics.received, null)
  actor = f.mutate('/users', {
    ...actor,
    permissionOverrides: {
      'profit.view': true,
      'orders.view': true
    }
  })
  assert.equal((await get(overviewPath)).status, 200)
  assert.equal((await get(detailsPath)).status, 200)
  const before = changes(server.service),
    jsonBefore = stateText(server.service)
  time = new Date('2026-10-15T04:02:00Z') // 上海同日12:02，输入日期和数据库内容均不改变。
  assert.equal((await get(overviewPath)).status, 401)
  assert.equal((await get(detailsPath)).status, 401)
  assert.equal(changes(server.service), before)
  assert.equal(stateText(server.service), jsonBefore)
})

test('仅合法资金新流水变化也刷新其他收入，业务版本未变不允许继续复用旧汇总', (t) => {
  const f = fixture(t),
    funds = createFundsStore(f.service.db)
  f.mutate('/customer-transactions', {
    customerId: f.customer.id,
    kind: 'recharge',
    amount: 1000,
    reason: '隔离期初合法充值'
  })
  assert.equal(f.overview().metrics.otherIncome, 0)
  assert.equal(f.detail('profit', 'days').summary.otherIncome, 0)
  const jsonBefore = stateText(f.service),
    ownChanges = changes(f.service)
  f.service.db.exec('BEGIN IMMEDIATE')
  try {
    // Store-layer fixture: append a new complete, nonnegative ledger entry, never edit history.
    funds.append({
      type: 'customer',
      accountId: f.customer.id,
      kind: 'deduction',
      amount: 125,
      direction: -1,
      reason: '隔离资金表读取新鲜度',
      actor: { id: 'admin', name: '隔离管理员' },
      requestId: randomUUID(),
      sourceId: randomUUID(),
      id: randomUUID(),
      now: '2026-10-15T00:00:00Z'
    })
    f.service.db.exec('COMMIT')
  } catch (error) {
    f.service.db.exec('ROLLBACK')
    throw error
  }
  assert.equal(stateText(f.service), jsonBefore)
  assert.ok(changes(f.service) > ownChanges)
  assert.equal(f.service.customerBalance('admin', f.customer.id).balance, 875)
  const fresh = f.detail('profit', 'days')
  assert.equal(fresh.summary.otherIncome, 125)
  assert.equal(fresh.records.find((row) => row.date === '2026-10-15').otherIncome, 125)
  assert.deepEqual(fresh.summary, f.overview().metrics)
  f.mutate('/customer-transactions', {
    customerId: f.customer.id,
    kind: 'deduction',
    amount: 75,
    reason: '隔离原资金业务再次更新'
  })
  assert.equal(f.overview().metrics.otherIncome, 200)
  assert.equal(f.detail('profit', 'days').summary.otherIncome, 200)
})

test('真实磁盘另一连接提交后，自身total_changes不变的读连接也取得新明细和汇总', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-overview-freshness-'))
  const dbPath = join(directory, 'isolated.sqlite')
  const options = {
    dbPath,
    seed: false,
    password: PASSWORD,
    clock: () => new Date('2026-10-15T00:00:00Z')
  }
  const reader = createStudioService(options)
  let writer
  t.after(() => {
    writer?.close()
    reader.close()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'studio-overview-freshness-'))
    rmSync(directory, { recursive: true, force: true })
  })
  const f = populate(reader)
  writer = createStudioService(options)
  const receipt = writer.upload('admin', {
    name: 'isolated-expense.png',
    mime: 'image/png',
    data: PNG
  })
  assert.equal(f.overview().metrics.expenses, 0)
  assert.equal(f.detail('expenses', 'expense-records').total, 0)
  const ownChanges = changes(reader),
    version = dataVersion(reader)
  const expense = testMutate(writer, 'admin', '/expenses', {
    category: '隔离费用',
    amount: 900,
    date: '2026-10-15',
    purpose: '跨连接真实提交',
    receipt
  })
  assert.equal(changes(reader), ownChanges)
  assert.notEqual(dataVersion(reader), version)
  reader.withReadScope(() => {
    const details = f.detail('expenses', 'expense-records')
    assert.equal(details.total, 1)
    assert.equal(details.records[0].id, expense.id)
    assert.equal(details.records[0].amount, 900)
    assert.equal(details.summary.expenses, 900)
    assert.deepEqual(details.summary, f.overview().metrics)
  })
})

test('上海跨月仅推进时钟不写库，默认区间切换且旧日期读取不被新月份覆盖', (t) => {
  const f = fixture(t, '2026-10-31T15:59:00Z') // 上海10月31日23:59。
  const order = f.order(f.supportA.id, 11000, '2026-10-31T20:00:00+08:00')
  const before = f.overview('admin', {})
  assert.equal(before.range.start, '2026-10-31')
  assert.equal(before.metrics.received, 11000)
  assert.equal(f.detail('received', 'days', 'admin', {}).records[0].date, '2026-10-31')
  const jsonBefore = stateText(f.service),
    ownChanges = changes(f.service)
  f.setTime('2026-10-31T16:01:00Z') // UTC日期未变，上海已到11月1日00:01。
  const after = f.overview('admin', {})
  assert.equal(after.range.start, '2026-11-01')
  assert.equal(after.range.end, '2026-11-01')
  assert.equal(after.metrics.received, 0)
  const details = f.detail('received', 'days', 'admin', {})
  assert.equal(details.records[0].date, '2026-11-01')
  assert.equal(details.records[0].received, 0)
  assert.deepEqual(details.summary, after.metrics)
  const old = f.detail('received', 'paid-orders', 'admin', {
    start: '2026-10-31',
    end: '2026-10-31'
  })
  assert.equal(old.records[0].id, order.id)
  assert.equal(old.summary.received, 11000)
  assert.equal(stateText(f.service), jsonBefore)
  assert.equal(changes(f.service), ownChanges)
})
