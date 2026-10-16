import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'
import { testMutate } from './helpers/current-intent.mjs'

const PASSWORD = 'secondary-record-isolated-password'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const fail = (fn, status) => assert.throws(fn, (e) => e instanceof ApiError && e.status === status)
function seed(service) {
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '精确记录读取等级', delaySeconds: 0 })
  const person = (username, role, permissionOverrides = {}) => mutate('/users', {
    username, name: username, role, status: 'active', password: PASSWORD,
    maxActiveOrders: 30, levelId: level.id, permissionOverrides
  })
  const finance = person('record-finance-only', 'hr', {
    'finance.withdrawals': true, 'finance.refunds': true, 'orders.view': false
  })
  const manager = person('record-personnel-admin', 'admin')
  const support = person('record-support', 'support')
  const players = Array.from({ length: 27 }, (_, i) => person(`record-player-${i}`, 'player'))
  const customers = ['record-customer', 'record-other-customer'].map((name) => mutate('/customers', {
    name, gameId: 'PRIVATE-CUSTOMER-GAME', contact: 'PRIVATE-CUSTOMER-CONTACT', remark: 'PRIVATE-CUSTOMER-REMARK'
  }))
  const receipt = service.upload('admin', { name: 'isolated-ledger.png', mime: 'image/png', data: PNG })
  const template = mutate('/templates', { name: '精确读取订单', game: '公开游戏', amount: 2000,
    reward: 1000, description: '公开内容', active: true })
  const order = (extra = {}) => mutate('/orders', { templateId: template.id, customerId: customers[0].id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: `PRIVATE-EXTERNAL-${randomUUID()}`,
    roomCode: 'PRIVATE-ROOM', gameId: 'PRIVATE-GAME', amount: 2000, reward: 1000,
    receivedAmount: 2000, paidAt: '2026-10-14T04:00:00Z', receipt,
    dispatchMode: 'direct', assignedTo: players[0].id, remark: 'PRIVATE-INTERNAL-REMARK', ...extra })
  const orders = Array.from({ length: 26 }, () => order())
  mutate(`/player/orders/${orders[0].id}/claim`, {}, players[0].id)
  mutate(`/orders/${orders[0].id}/action`, { action: 'release', reason: 'PRIVATE-OLD-RELEASE' })
  mutate(`/orders/${orders[0].id}/action`, { action: 'dispatch', dispatchMode: 'direct', assignedTo: players[1].id })
  const unrelated = order({ dispatchMode: 'pool', assignedTo: null })
  const credits = [], deposits = []
  for (let i = 0; i < 26; i++) {
    credits.push(mutate('/customer-transactions', { customerId: customers[0].id, kind: 'recharge',
      amount: 100, reason: '隔离充值', receipt }))
    deposits.push(mutate('/player-deposit-transactions', { userId: players[0].id, kind: 'deposit',
      amount: 100, reason: '隔离押金', receipt }))
  }
  const otherCredit = mutate('/customer-transactions', { customerId: customers[1].id, kind: 'recharge',
    amount: 200, reason: '另一客户隔离充值' })
  const otherDeposit = mutate('/player-deposit-transactions', { userId: players[1].id, kind: 'deposit',
    amount: 200, reason: '另一打手隔离押金' })
  return { service, mutate, finance, manager, support, players, customers, credits, deposits,
    orders, unrelated, otherCredit, otherDeposit }
}
function fixture(t) {
  const service = createStudioService({ dbPath: ':memory:', seed: false, password: PASSWORD,
    clock: () => new Date('2026-10-14T04:00:00Z') })
  t.after(() => service.close())
  return seed(service)
}

test('精确人员及资金记录跨当前页读取，投影与原分页一致，余额total不被精确读取改变', (t) => {
  const f = fixture(t), last = f.players.at(-1), owner = f.players[0], customer = f.customers[0]
  assert.ok(!f.service.players('admin', { size: 5 }).records.some((row) => row.id === last.id))
  assert.deepEqual(f.service.playerDetail('admin', last.id),
    f.service.players('admin', { size: 100 }).records.find((row) => row.id === last.id))
  const publicProfile = f.service.playerDetail(f.manager.id, last.id)
  assert.equal(publicProfile.wallet, undefined)
  assert.equal(publicProfile.depositBalance, undefined)
  assert.equal(publicProfile.permissionOverrides, undefined)
  assert.equal(publicProfile.password, undefined)
  const creditPage = f.service.customerTransactions(f.finance.id, customer.id, { size: 5 })
  const depositPage = f.service.playerDeposit(f.finance.id, owner.id, { size: 5 })
  assert.ok(!creditPage.records.some((row) => row.id === f.credits[0].id))
  assert.ok(!depositPage.records.some((row) => row.id === f.deposits[0].id))
  assert.deepEqual(f.service.customerTransactionDetail(f.finance.id, customer.id, f.credits[0].id), f.credits[0])
  assert.deepEqual(f.service.playerDepositTransactionDetail(f.finance.id, owner.id, f.deposits[0].id), f.deposits[0])
  assert.equal(creditPage.total, 26)
  assert.equal(depositPage.total, 26)
  assert.equal(f.service.customerTransactions(f.finance.id, customer.id).balance, 2600)
  assert.equal(f.service.playerDeposit(f.finance.id, owner.id).balance, 2600)
  assert.deepEqual(f.service.playerDepositTransactionDetail(owner.id, owner.id, f.deposits[0].id), f.deposits[0])
})

test('精确记录必须匹配对象及台账类别，跨账户和缺失为404，权限撤销实时拒绝', (t) => {
  const f = fixture(t), actor = f.finance.id, owner = f.players[0].id, customer = f.customers[0].id
  fail(() => f.service.customerTransactionDetail(actor, customer, f.otherCredit.id), 404)
  fail(() => f.service.customerTransactionDetail(actor, customer, f.deposits[0].id), 404)
  fail(() => f.service.playerDepositTransactionDetail(actor, owner, f.otherDeposit.id), 404)
  fail(() => f.service.playerDepositTransactionDetail(actor, owner, f.credits[0].id), 404)
  fail(() => f.service.playerDepositTransactionDetail(f.players[1].id, owner, f.deposits[0].id), 403)
  fail(() => f.service.playerDetail(actor, 'missing-player'), 404)
  fail(() => f.service.playerDetail(actor, f.support.id), 404)
  fail(() => f.service.playerHistoryDetail(actor, owner, f.unrelated.id), 404)
  fail(() => f.service.playerHistoryDetail(actor, owner, 'missing-order'), 404)
  for (const run of [
    () => f.service.customerTransactionDetail(f.support.id, customer, f.credits[0].id),
    () => f.service.playerDepositTransactionDetail(f.support.id, owner, f.deposits[0].id),
    () => f.service.playerDetail(f.support.id, owner)
  ]) fail(run, 403)
  f.mutate('/users', { ...f.finance, permissionOverrides: {
    'finance.withdrawals': false, 'finance.refunds': false, 'orders.view': false
  } })
  for (const run of [
    () => f.service.customerTransactionDetail(actor, customer, f.credits[0].id),
    () => f.service.playerDepositTransactionDetail(actor, owner, f.deposits[0].id),
    () => f.service.playerDetail(actor, owner),
    () => f.service.playerHistoryDetail(actor, owner, f.orders[0].id)
  ]) fail(run, 403)
})

test('精确历史复用原参与投影，财务独有权限不会恢复旧执行详情或全店订单', (t) => {
  const f = fixture(t), owner = f.players[0].id
  const page = f.service.playerHistory(f.finance.id, owner, { size: 5 })
  const outside = f.orders.find((row) => !page.records.some((record) => record.id === row.id))
  const financeDetail = f.service.playerHistoryDetail(f.finance.id, owner, outside.id)
  assert.deepEqual(financeDetail, f.service.playerHistory(f.finance.id, owner, { size: 100 }).records
    .find((row) => row.id === outside.id))
  const old = f.service.playerHistoryDetail(f.finance.id, owner, f.orders[0].id)
  for (const key of ['roomCode', 'gameId', 'remark', 'receipt', 'customerId', 'externalOrderNo', 'commissionSnapshot'])
    assert.equal(old[key], undefined, key)
  assert.ok(!JSON.stringify(old).includes('PRIVATE-'))
  const full = f.service.playerHistoryDetail(f.support.id, owner, f.orders[0].id)
  assert.deepEqual(full, f.service.playerHistory(f.support.id, owner, { size: 100 }).records
    .find((row) => row.id === full.id))
  assert.equal(full.roomCode, 'PRIVATE-ROOM')
  assert.equal(full.commissionSnapshot, undefined)
  fail(() => f.service.orderDetail(f.finance.id, f.orders[0].id), 403)
})

test('四类精确读取无业务/资金/审计DML，不建立新操作编号', (t) => {
  const f = fixture(t)
  const changes = f.service.db.prepare('SELECT total_changes() AS n').get().n
  const before = f.service.db.prepare('SELECT json FROM studio_state').get().json
  const fundsBefore = f.service.db.prepare('SELECT * FROM fund_accounts ORDER BY account_type,account_id').all()
  const requestCounts = () => ['financial_requests', 'business_requests', 'audit_logs'].map((table) =>
    f.service.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
  const originalCounts = requestCounts()
  for (let i = 0; i < 3; i++) {
    f.service.playerDetail(f.finance.id, f.players[0].id)
    f.service.playerHistoryDetail(f.finance.id, f.players[0].id, f.orders[0].id)
    f.service.customerTransactionDetail(f.finance.id, f.customers[0].id, f.credits[0].id)
    f.service.playerDepositTransactionDetail(f.finance.id, f.players[0].id, f.deposits[0].id)
  }
  assert.equal(f.service.db.prepare('SELECT total_changes() AS n').get().n, changes)
  assert.equal(f.service.db.prepare('SELECT json FROM studio_state').get().json, before)
  assert.deepEqual(f.service.db.prepare('SELECT * FROM fund_accounts ORDER BY account_type,account_id').all(), fundsBefore)
  assert.deepEqual(requestCounts(), originalCounts)
})

test('精确HTTP用真实会话及原角色边界，失效401且不扩大打手后台路径', async (t) => {
  const server = createStudioServer({ dbPath: ':memory:', password: PASSWORD, seed: false,
    clock: () => new Date('2026-10-14T04:00:00Z') })
  const f = seed(server.service)
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise((done) => server.close(done)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const paths = [ `/players/${f.players[0].id}`,
    `/players/${f.players[0].id}/orders/${f.orders[0].id}`,
    `/players/${f.players[0].id}/deposits/${f.deposits[0].id}`,
    `/customers/${f.customers[0].id}/transactions/${f.credits[0].id}` ]
  const login = server.service.login(f.finance.username, PASSWORD)
  const get = (path, cookie = `studio_session=${login.token}`, extra = {}) => fetch(base + path, {
    headers: { Cookie: cookie, ...extra }
  })
  for (const path of paths) {
    assert.equal((await fetch(base + path)).status, 401)
    const response = await get(path)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.ok(body.id)
    assert.equal(body.records, undefined)
  }
  assert.equal((await get(`/players/${f.players[0].id}/deposits/${f.otherDeposit.id}`)).status, 404)
  assert.equal((await get(`/customers/${f.customers[0].id}/transactions/${f.otherCredit.id}`)).status, 404)
  const player = server.service.login(f.players[0].username, PASSWORD, { requiredRole: 'player' })
  for (const path of paths)
    assert.equal((await get(path, `studio_player_session=${player.token}`, { 'X-Studio-Client': 'player' })).status, 403)
  server.service.logout(login.token)
  for (const path of paths) assert.equal((await get(path)).status, 401)
})
