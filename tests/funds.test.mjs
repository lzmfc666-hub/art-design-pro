import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'
const PASSWORD = 'funds-tests-password-123'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const fail = (fn, status) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status)
function fixture(t, existingService) {
  let currentTime = new Date('2026-10-13T04:00:00Z')
  const service =
    existingService ||
    createStudioService({
      dbPath: ':memory:',
      seed: false,
      password: PASSWORD,
      clock: () => currentTime
    })
  if (!existingService) t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, body)
  const level = mutate('/levels', { name: '真实等级', delaySeconds: 0 })
  const users = {}
  for (const role of ['finance', 'support', 'player', 'admin'])
    users[role] = mutate('/users', {
      username: `fund-${role}`,
      name: `资金${role}`,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 10,
      permissionOverrides: {},
      password: PASSWORD
    })
  for (const role of ['finance', 'support'])
    mutate('/salary-plans', {
      userId: users[role].id,
      mode: 'fixed',
      base: 0,
      rate: null,
      platformRates: {},
      effectiveFrom: '2026-01-01',
      hourlyEnabled: false
    })
  const customer = mutate('/customers', {
    name: '老板客户',
    contact: '',
    gameId: '00000',
    remark: '',
    platformId: 'xianyu'
  })
  const template = mutate('/templates', {
    name: '余额项目',
    game: '游戏',
    description: '',
    amount: 8800,
    reward: 7000,
    map: '',
    remark: '',
    active: true
  })
  const upload = (actor = 'admin') =>
    service.upload(actor, { name: '资金凭证.png', mime: 'image/png', data: PNG })
  let seq = 0
  const recharge = (amount = 20000, changes = {}) =>
    mutate(
      '/customer-transactions',
      {
        customerId: customer.id,
        kind: 'recharge',
        amount,
        reason: '真实充值',
        requestId: `recharge-${++seq}`,
        ...changes
      },
      users.finance.id
    )
  const orderBody = (changes = {}) => ({
    templateId: template.id,
    customerId: customer.id,
    platformId: 'xianyu',
    shopId: 'jindun',
    externalOrderNo: `000${++seq}`,
    roomCode: 'ROOM',
    gameId: '00000',
    amount: 8800,
    reward: 7000,
    dispatchMode: 'direct',
    assignedTo: users.player.id,
    paymentMethod: 'balance',
    requestId: `order-${seq}`,
    ...changes
  })
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
    recharge,
    orderBody,
    complete,
    time: (value) => {
      currentTime = new Date(value)
    }
  }
}

test('客户充值只增加负债余额，客服可消费且订单收入只一次，退款原路恢复不额外现金退', (t) => {
  const f = fixture(t)
  const deposit = f.recharge()
  assert.equal(deposit.balanceAfter, 20000)
  assert.equal(
    f.service.bootstrap('admin').reports.days.find((row) => row.date === '2026-10-13').received,
    0
  )
  assert.equal(
    f.service.bootstrap('admin').reports.days.find((row) => row.date === '2026-10-13').profit,
    0
  )
  const body = f.orderBody()
  const order = f.mutate('/orders', body, f.users.support.id)
  const again = f.mutate('/orders', body, f.users.support.id)
  assert.equal(again.id, order.id)
  assert.equal(order.paymentMethod, 'balance')
  assert.equal(order.receivedAmount, 8800)
  assert.equal(order.paidAt, '2026-10-13T04:00:00.000Z')
  assert.equal(order.receipt, null)
  assert.equal(f.service.customerBalance(f.users.support.id, f.customer.id).balance, 11200)
  assert.equal(f.service.bootstrap('admin').orders.length, 1)
  const refundBody = {
    orderId: order.id,
    amount: 1800,
    reason: '部分储值退款',
    requestId: 'balance-refund-1'
  }
  const refund = f.mutate('/refunds', refundBody, f.users.finance.id)
  assert.equal(f.mutate('/refunds', refundBody, f.users.finance.id).id, refund.id)
  assert.equal(refund.refundMethod, 'balance')
  assert.equal(f.service.customerBalance('admin', f.customer.id).balance, 13000)
  const ledger = f.service.customerTransactions(f.users.finance.id, f.customer.id)
  assert.equal(ledger.total, 3)
  assert.equal(ledger.records.filter((row) => row.kind === 'order-refund').length, 1)
  const day = f.service.bootstrap('admin').reports.days.find((row) => row.date === '2026-10-13')
  assert.equal(day.received, 8800)
  assert.equal(day.refunds, 1800)
  assert.equal(day.net, 7000)
  assert.equal(day.otherIncome, 0)
  fail(
    () =>
      f.mutate(
        '/refunds',
        { ...refundBody, amount: 8800, requestId: 'over-refund' },
        f.users.finance.id
      ),
    409
  )
  fail(
    () =>
      f.mutate(`/orders/${order.id}/action`, {
        action: 'edit',
        amount: 9000,
        reason: '不能改台账'
      }),
    409
  )
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
})

test('储值requestId同内容复用、不同内容拒绝，金额及附件失败全部回滚，流水不可删改', (t) => {
  const f = fixture(t)
  const body = {
    customerId: f.customer.id,
    kind: 'recharge',
    amount: 10000,
    reason: '存入',
    requestId: 'same-customer-request'
  }
  const original = f.mutate('/customer-transactions', body, f.users.finance.id)
  assert.deepEqual(f.mutate('/customer-transactions', { ...body }, f.users.finance.id), original)
  fail(
    () => f.mutate('/customer-transactions', { ...body, amount: 20000 }, f.users.finance.id),
    409
  )
  for (const amount of [-1, 0, 1.25, NaN, Number.MAX_SAFE_INTEGER])
    fail(() => f.recharge(amount), 400)
  fail(() => f.recharge(100, { reason: '' }), 400)
  fail(() => f.recharge(100, { requestId: '' }), 400)
  const foreign = f.upload(f.users.support.id)
  fail(() => f.recharge(100, { receipt: foreign }), 403)
  const before = f.service.customerBalance('admin', f.customer.id).balance
  fail(
    () =>
      f.mutate(
        '/customer-transactions',
        {
          customerId: f.customer.id,
          kind: 'deduction',
          amount: before + 1,
          reason: '不得透支',
          requestId: 'insufficient-funds'
        },
        f.users.finance.id
      ),
    409
  )
  assert.equal(f.service.customerBalance('admin', f.customer.id).balance, before)
  assert.equal(f.service.customerTransactions('admin', f.customer.id).total, 1)
  assert.equal(
    f.service.db
      .prepare('SELECT request_id FROM financial_requests WHERE request_id=?')
      .get('insufficient-funds'),
    undefined
  )
  assert.throws(
    () => f.service.db.prepare('DELETE FROM fund_transactions WHERE id=?').run(original.id),
    /immutable/
  )
  assert.throws(
    () => f.service.db.prepare('UPDATE fund_transactions SET amount=1 WHERE id=?').run(original.id),
    /immutable/
  )
})

test('客户和打手资金权限分离，普通管理员不能改钱，客服无台账明细，押金本人范围受保护', (t) => {
  const f = fixture(t)
  f.recharge()
  const body = {
    userId: f.users.player.id,
    kind: 'deposit',
    amount: 5000,
    reason: '缴纳押金',
    requestId: 'deposit-permissions'
  }
  const deposit = f.mutate('/player-deposit-transactions', body, f.users.finance.id)
  for (const actor of [f.users.admin.id, f.users.support.id]) {
    fail(
      () =>
        f.mutate('/player-deposit-transactions', { ...body, requestId: `denied-${actor}` }, actor),
      403
    )
    fail(
      () =>
        f.mutate(
          '/customer-transactions',
          {
            customerId: f.customer.id,
            kind: 'recharge',
            amount: 100,
            reason: '未经授权',
            requestId: `deny-customer-${actor}`
          },
          actor
        ),
      403
    )
    fail(() => f.service.customerTransactions(actor, f.customer.id), 403)
    assert.equal(f.service.bootstrap(actor).playerDeposits.length, 0)
  }
  assert.equal(f.service.playerDeposit(f.users.player.id, f.users.player.id).balance, 5000)
  fail(() => f.service.playerDeposit(f.users.support.id, f.users.player.id), 403)
  const ordinary = f.service.players(f.users.admin.id).records[0]
  assert.equal(Object.hasOwn(ordinary, 'wallet'), false)
  assert.equal(Object.hasOwn(ordinary, 'depositBalance'), false)
  const finance = f.service.players(f.users.finance.id).records[0]
  assert.equal(finance.depositBalance, 5000)
  assert.equal(Object.hasOwn(finance, 'permissionOverrides'), false)
  const log = f.service.bootstrap(f.users.admin.id).logs.find((row) => row.entityId === deposit.id)
  assert.equal(log.after, null)
  assert.equal(
    f.service.bootstrap(f.users.finance.id).logs.find((row) => row.entityId === deposit.id).after
      .amount,
    5000
  )
})

test('押金只允许退店/跑路退还或没收，日常报酬扣款不碰押金；其他收入按实际日期入利润', (t) => {
  const f = fixture(t)
  f.recharge(10000)
  const deposit = {
    userId: f.users.player.id,
    kind: 'deposit',
    amount: 10000,
    reason: '缴纳',
    requestId: 'deposit-exit'
  }
  f.mutate('/player-deposit-transactions', deposit, f.users.finance.id)
  const wallet = f.service.playerWallet(f.users.player.id)
  const penalty = { ...deposit, kind: 'penalty', amount: 2000, requestId: 'exit-penalty' }
  fail(() => f.mutate('/player-deposit-transactions', penalty, f.users.finance.id), 400)
  const confiscation = f.mutate(
    '/player-deposit-transactions',
    { ...penalty, exitType: 'absconded' },
    f.users.finance.id
  )
  assert.equal(confiscation.exitType, 'absconded')
  f.mutate(
    '/player-deposit-transactions',
    {
      ...deposit,
      kind: 'return',
      amount: 8000,
      exitType: 'leave',
      reason: '离店退还余款',
      requestId: 'exit-return'
    },
    f.users.finance.id
  )
  assert.equal(f.service.playerDeposit('admin', f.users.player.id).balance, 0)
  assert.deepEqual(f.service.playerWallet(f.users.player.id), wallet)
  f.mutate(
    '/customer-transactions',
    {
      customerId: f.customer.id,
      kind: 'deduction',
      amount: 3000,
      reason: '非订单收费',
      requestId: 'customer-fee'
    },
    f.users.finance.id
  )
  f.mutate(
    '/customer-transactions',
    {
      customerId: f.customer.id,
      kind: 'return',
      amount: 1000,
      reason: '退余额',
      requestId: 'customer-return'
    },
    f.users.finance.id
  )
  const day = f.service.bootstrap('admin').reports.days.find((row) => row.date === '2026-10-13')
  assert.equal(day.received, 0)
  assert.equal(day.otherIncome, 5000)
  assert.equal(day.profit, 5000)
  const overview = f.service.overview('admin', { start: '2026-10-13', end: '2026-10-13' })
  assert.equal(overview.metrics.otherIncome, 5000)
  assert.equal(overview.metrics.periodOperatingProfit, 5000)
  assert.equal(overview.metrics.received, 0)
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
})

test('未付款订单后续储值确认幂等，余额不足不创建订单、收款或部分台账', (t) => {
  const f = fixture(t)
  const unpaid = f.mutate(
    '/orders',
    f.orderBody({
      platformId: 'hall',
      shopId: null,
      externalOrderNo: '',
      paymentMethod: 'cash',
      payOnArrival: true,
      receivedAmount: 0,
      paidAt: null,
      requestId: undefined
    }),
    f.users.support.id
  )
  const confirm = {
    action: 'confirm-payment',
    paymentMethod: 'balance',
    reason: '客户确认余额付款',
    requestId: 'confirm-balance'
  }
  fail(() => f.mutate(`/orders/${unpaid.id}/action`, confirm, f.users.support.id), 409)
  assert.equal(f.service.bootstrap('admin').orders[0].receivedAmount, 0)
  f.recharge(8800)
  const paid = f.mutate(`/orders/${unpaid.id}/action`, confirm, f.users.support.id)
  assert.deepEqual(f.mutate(`/orders/${unpaid.id}/action`, confirm, f.users.support.id), paid)
  assert.equal(f.service.customerBalance('admin', f.customer.id).balance, 0)
  fail(() => f.mutate('/orders', f.orderBody(), f.users.support.id), 409)
  assert.equal(f.service.bootstrap('admin').orders.length, 1)
  assert.equal(f.service.customerTransactions('admin', f.customer.id).total, 2)
})

test('三个打手开关独立鉴权，不影响已接提交、既有报酬与在途提现，登录关闭撤销会话', (t) => {
  const f = fixture(t)
  const active = f.mutate(
    '/orders',
    f.orderBody({
      paymentMethod: 'cash',
      receivedAmount: 8800,
      paidAt: '2026-10-12T10:00:00+08:00',
      receipt: null
    }),
    f.users.support.id
  )
  f.mutate(`/player/orders/${active.id}/claim`, {}, f.users.player.id)
  const player = f.service.bootstrap('admin').users.find((row) => row.id === f.users.player.id)
  const token = f.service.login(player.username, PASSWORD).token
  f.mutate('/users', { ...player, playerAccess: { login: true, claim: false, withdraw: false } })
  assert.ok(f.service.session(token))
  fail(
    () =>
      f.mutate(
        '/orders',
        f.orderBody({
          paymentMethod: 'cash',
          receivedAmount: 8800,
          paidAt: '2026-10-12T10:00:00+08:00'
        }),
        f.users.support.id
      ),
    400
  )
  f.mutate(`/player/orders/${active.id}/submit`, { screenshots: [f.upload(player.id)] }, player.id)
  f.mutate(`/orders/${active.id}/action`, { action: 'review-pass' })
  assert.equal(f.service.playerWallet(player.id).earned, 7000)
  fail(() => f.mutate('/player/withdrawals', { amount: 1000 }, player.id), 403)
  f.mutate('/users', { ...player, playerAccess: { login: true, claim: false, withdraw: true } })
  const withdrawal = f.mutate('/player/withdrawals', { amount: 1000 }, player.id)
  f.mutate('/users', { ...player, playerAccess: { login: false, claim: true, withdraw: true } })
  assert.equal(f.service.session(token), null)
  fail(() => f.service.login(player.username, PASSWORD), 401)
  fail(() => f.service.playerOrders(player.id), 403)
  const snapshot = f.service.bootstrap('admin')
  assert.equal(snapshot.withdrawals.find((row) => row.id === withdrawal.id).status, 'pending')
  assert.equal(snapshot.wallets.find((row) => row.userId === player.id).earned, 7000)
  fail(
    () =>
      f.mutate('/users', { ...player, playerAccess: { login: true, claim: 'no', withdraw: true } }),
    400
  )
})

test('流水导出真实筛选先于上限/取行，日周月总计不漏SQL早期日期，检查账户差异不写库', (t) => {
  const f = fixture(t)
  f.time('2026-08-01T04:00:00Z')
  const old = f.recharge(10000, { reason: '较早账户期初' })
  f.time('2026-10-13T04:00:00Z')
  f.recharge(10000)
  const request = {
    period: { type: 'total' },
    modules: [{ id: 'customerTransactions', fields: ['reason'] }],
    filters: { keywordField: 'reason', keyword: '账户期初', customerId: f.customer.id }
  }
  const exported = f.service.exportSnapshot('admin', request)
  assert.equal(exported.exportPeriod.start, '2026-08-01')
  assert.equal(exported.fundCounts.customerTransactions, 1)
  assert.equal(exported.customerTransactions[0].id, old.id)
  assert.equal(
    f.service.exportSnapshot('admin', {
      month: '2026-10',
      modules: [{ id: 'customerTransactions', fields: ['kind'] }],
      filters: { keywordField: 'kind', keyword: '充值' }
    }).customerTransactions.length,
    1
  )
  f.service.db
    .prepare('UPDATE fund_accounts SET balance=1 WHERE account_type=? AND account_id=?')
    .run('customer', f.customer.id)
  const before = f.service.db.prepare('SELECT total_changes() AS n').get().n
  f.service.db.exec('PRAGMA query_only=ON')
  const report = f.service.diagnostics('admin')
  assert.ok(
    report.issues.some(
      (row) => row.checkId === 'funds' && row.message.includes('独立流水累计不一致')
    )
  )
  assert.equal(f.service.db.prepare('SELECT total_changes() AS n').get().n, before)
  f.service.db.exec('PRAGMA query_only=OFF')
})

test('真实HTTP并发储值下单不透支，同requestId双请求只生成一笔扣款，资金接口鉴权', async (t) => {
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password: PASSWORD })
  const f = fixture(t, server.service)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const post = (path, body, cookie) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body)
    })
  const login = await post('/login', { username: f.users.support.username, password: PASSWORD })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  f.recharge(8800)
  const firstBody = f.orderBody()
  const results = await Promise.all([
    post('/orders', firstBody, cookie),
    post('/orders', firstBody, cookie)
  ])
  assert.deepEqual(
    results.map((row) => row.status),
    [200, 200]
  )
  assert.equal((await results[0].json()).id, (await results[1].json()).id)
  assert.equal(f.service.customerBalance('admin', f.customer.id).balance, 0)
  f.recharge(8800)
  const competing = await Promise.all([
    post('/orders', f.orderBody(), cookie),
    post('/orders', f.orderBody(), cookie)
  ])
  assert.deepEqual(competing.map((row) => row.status).sort(), [200, 409])
  assert.equal(f.service.customerBalance('admin', f.customer.id).balance, 0)
  assert.equal(
    f.service
      .customerTransactions('admin', f.customer.id)
      .records.filter((row) => row.kind === 'order-payment').length,
    2
  )
  assert.equal(
    (
      await post(
        '/customer-transactions',
        {
          customerId: f.customer.id,
          kind: 'recharge',
          amount: 1,
          reason: '禁止客服充值',
          requestId: 'forbidden-http'
        },
        cookie
      )
    ).status,
    403
  )
  assert.equal(
    (await fetch(`${base}/customers/${f.customer.id}/transactions`, { headers: { cookie } }))
      .status,
    403
  )
  assert.equal((await fetch(`${base}/players`, { headers: { cookie } })).status, 403)
})

test('有未结清资金或未完订单的打手不能换角色，关开关保留资金，客户余额不能绕台账编辑', (t) => {
  const f = fixture(t)
  const player = f.service.bootstrap('admin').users.find((row) => row.id === f.users.player.id)
  f.mutate(
    '/player-deposit-transactions',
    {
      userId: player.id,
      kind: 'deposit',
      amount: 1000,
      reason: '真实押金',
      requestId: 'role-deposit'
    },
    f.users.finance.id
  )
  fail(() => f.mutate('/users', { ...player, role: 'support' }), 409)
  f.mutate('/users', { ...player, playerAccess: { login: false, claim: false, withdraw: false } })
  assert.equal(f.service.playerDeposit('admin', player.id).balance, 1000)
  f.mutate(
    '/player-deposit-transactions',
    {
      userId: player.id,
      kind: 'return',
      amount: 1000,
      reason: '离店结清',
      exitType: 'leave',
      requestId: 'role-deposit-return'
    },
    f.users.finance.id
  )
  f.mutate('/users', { ...player, role: 'support' })
  assert.equal(
    f.service.bootstrap('admin').users.find((row) => row.id === player.id).role,
    'support'
  )
  fail(() => f.mutate('/customers', { ...f.customer, balance: 999999 }), 400)
  assert.equal(f.service.customerBalance('admin', f.customer.id).balance, 0)
})

test('SQLite资金凭证可由授权财务共享下载，余额查看/人员管理不能猜ID借用资金图片', (t) => {
  const f = fixture(t)
  const receipt = f.upload(f.users.finance.id)
  f.recharge(1000, { receipt })
  const another = f.mutate('/users', {
    username: 'second-funds-finance',
    name: '另一财务',
    role: 'finance',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: PASSWORD
  })
  assert.equal(f.service.download(another.id, receipt.id).size, receipt.size)
  for (const actor of [f.users.support.id, f.users.admin.id])
    fail(() => f.service.download(actor, receipt.id), 403)
  fail(
    () =>
      f.mutate(
        '/orders',
        f.orderBody({
          paymentMethod: 'cash',
          receivedAmount: 8800,
          paidAt: '2026-10-12T10:00:00+08:00',
          platformId: 'hall',
          shopId: null,
          externalOrderNo: '',
          receipt
        }),
        f.users.support.id
      ),
    403
  )
})

test('资金检查能在总额与各账户余额均对上时发现储值退款错退另一真实客户', (t) => {
  const f = fixture(t)
  f.recharge(10000)
  const other = f.mutate('/customers', { name: '另一个客户', contact: '', gameId: '', remark: '' })
  f.recharge(1200, { customerId: other.id })
  const order = f.mutate('/orders', f.orderBody(), f.users.support.id)
  const refund = f.mutate(
    '/refunds',
    {
      orderId: order.id,
      amount: 1800,
      reason: '原路退余额',
      requestId: 'wrong-destination-fixture'
    },
    f.users.finance.id
  )
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
  f.service.db.exec('DROP TRIGGER fund_transactions_immutable_update')
  f.service.db
    .prepare('UPDATE fund_transactions SET account_id=? WHERE id=?')
    .run(other.id, refund.balanceTransactionId)
  f.service.db
    .prepare('UPDATE fund_accounts SET balance=1200 WHERE account_type=? AND account_id=?')
    .run('customer', f.customer.id)
  f.service.db
    .prepare('UPDATE fund_accounts SET balance=3000 WHERE account_type=? AND account_id=?')
    .run('customer', other.id)
  const report = f.service.diagnostics('admin')
  assert.ok(
    report.issues.some(
      (row) => row.checkId === 'funds' && row.message.includes('订单原付款客户账户')
    )
  )
  assert.equal(
    report.issues.some(
      (row) => row.message.includes('账户余额') || row.message.includes('累计不一致')
    ),
    false,
    '不能只靠总额或余额检查，需验证原付款账户'
  )
})

test('审计容量失败与资金同事务回滚，不留下余额、台账或幂等成功凭据', (t) => {
  const service = createStudioService({
    dbPath: ':memory:',
    seed: false,
    password: PASSWORD,
    auditHotMaxRows: 1,
    auditArchiveMaxBytes: 100000
  })
  const f = fixture(t, service)
  t.after(() => service.close())
  const record = service.db.prepare('SELECT id,payload FROM audit_logs_archive LIMIT 1').get()
  const used = service.logStorage('admin').archiveBytes
  service.db
    .prepare('UPDATE audit_logs_archive SET payload=? WHERE id=?')
    .run(record.payload + ' '.repeat(100000 - used), record.id)
  fail(() => f.recharge(1000, { requestId: 'capacity-rolled-back-fund' }), 503)
  assert.equal(service.customerBalance('admin', f.customer.id).balance, 0)
  assert.equal(service.customerTransactions('admin', f.customer.id).total, 0)
  assert.equal(
    service.db
      .prepare('SELECT request_id FROM financial_requests WHERE request_id=?')
      .get('capacity-rolled-back-fund'),
    undefined
  )
  assert.equal(
    service.db
      .prepare('SELECT account_id FROM fund_accounts WHERE account_id=?')
      .get(f.customer.id),
    undefined
  )
})

test('直接打手补款和扣款携带同requestId重试不双计，旧无ID调用仍兼容', (t) => {
  const f = fixture(t)
  const supplementBody = {
    userId: f.users.player.id,
    kind: 'supplement',
    amount: 3000,
    reason: '补款重试',
    requestId: 'direct-supplement-idempotent'
  }
  const supplement = f.mutate('/player-adjustments', supplementBody, f.users.finance.id)
  assert.deepEqual(f.mutate('/player-adjustments', supplementBody, f.users.finance.id), supplement)
  assert.equal(f.service.playerWallet(f.users.player.id).available, 3000)
  const deductionBody = {
    userId: f.users.player.id,
    kind: 'deduction',
    amount: 1200,
    reason: '扣款重试',
    requestId: 'direct-deduction-idempotent'
  }
  const deduction = f.mutate('/player-adjustments', deductionBody, f.users.finance.id)
  assert.deepEqual(f.mutate('/player-adjustments', deductionBody, f.users.finance.id), deduction)
  assert.equal(f.service.playerWallet(f.users.player.id).available, 1800)
  assert.equal(f.service.bootstrap('admin').playerAdjustments.length, 2)
  f.mutate(
    '/player-adjustments',
    { userId: f.users.player.id, kind: 'supplement', amount: 50, reason: '旧调用未传ID' },
    f.users.finance.id
  )
  assert.equal(f.service.playerWallet(f.users.player.id).available, 1850)
  assert.equal(f.service.bootstrap('admin').playerAdjustments.length, 3)
})

test('直接扣补requestId不同内容409，财务权限撤销后不能读取旧成功缓存', (t) => {
  const f = fixture(t)
  const body = {
    userId: f.users.player.id,
    kind: 'supplement',
    amount: 2500,
    reason: '初次补款',
    requestId: 'direct-adjustment-permission-cache'
  }
  f.mutate('/player-adjustments', body, f.users.finance.id)
  fail(() => f.mutate('/player-adjustments', { ...body, amount: 3500 }, f.users.finance.id), 409)
  fail(
    () => f.mutate('/player-adjustments', { ...body, kind: 'deduction' }, f.users.finance.id),
    409
  )
  assert.equal(f.service.playerWallet(f.users.player.id).available, 2500)
  f.mutate('/users', { ...f.users.finance, permissionOverrides: { 'finance.withdrawals': false } })
  fail(() => f.mutate('/player-adjustments', body, f.users.finance.id), 403)
  assert.equal(f.service.playerWallet(f.users.player.id).available, 2500)
  assert.equal(f.service.bootstrap('admin').playerAdjustments.length, 1)
})

test('同一时刻客户与押金流水按真实登记倒序，分页和余额快照不被随机UUID打乱', (t) => {
  const f = fixture(t)
  const customerRows = [f.recharge(10000)]
  customerRows.push(
    f.mutate(
      '/customer-transactions',
      {
        customerId: f.customer.id,
        kind: 'deduction',
        amount: 3000,
        reason: '扣费',
        requestId: 'same-clock-customer-deduction'
      },
      f.users.finance.id
    )
  )
  customerRows.push(
    f.mutate(
      '/customer-transactions',
      {
        customerId: f.customer.id,
        kind: 'return',
        amount: 2000,
        reason: '退回余款',
        requestId: 'same-clock-customer-return'
      },
      f.users.finance.id
    )
  )
  const depositBody = {
    userId: f.users.player.id,
    kind: 'deposit',
    amount: 10000,
    reason: '押金缴纳',
    requestId: 'same-clock-deposit'
  }
  const depositRows = [f.mutate('/player-deposit-transactions', depositBody, f.users.finance.id)]
  depositRows.push(
    f.mutate(
      '/player-deposit-transactions',
      {
        ...depositBody,
        kind: 'return',
        amount: 4000,
        exitType: 'leave',
        reason: '先退还部分',
        requestId: 'same-clock-deposit-return'
      },
      f.users.finance.id
    )
  )
  depositRows.push(
    f.mutate(
      '/player-deposit-transactions',
      {
        ...depositBody,
        kind: 'penalty',
        amount: 6000,
        exitType: 'absconded',
        reason: '后没收余款',
        requestId: 'same-clock-deposit-penalty'
      },
      f.users.finance.id
    )
  )
  assert.equal(new Set([...customerRows, ...depositRows].map((row) => row.createdAt)).size, 1)
  const customer = f.service.customerTransactions('admin', f.customer.id)
  assert.deepEqual(
    customer.records.map((row) => row.id),
    customerRows.toReversed().map((row) => row.id)
  )
  assert.deepEqual(
    customer.records.map((row) => row.balanceAfter),
    [5000, 7000, 10000]
  )
  const deposit = f.service.playerDeposit('admin', f.users.player.id)
  assert.deepEqual(
    deposit.records.map((row) => row.id),
    depositRows.toReversed().map((row) => row.id)
  )
  assert.deepEqual(
    deposit.records.map((row) => row.balanceAfter),
    [0, 6000, 10000]
  )
  const secondPage = f.service.playerDeposit('admin', f.users.player.id, { current: 2, size: 1 })
  assert.equal(secondPage.records[0].id, depositRows[1].id)
  assert.equal(secondPage.records[0].balanceAfter, 6000)
})
