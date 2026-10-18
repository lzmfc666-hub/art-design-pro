import { testMutate } from './helpers/current-intent.mjs'
import { legacyCancellationFixture } from './helpers/legacy-cancellation.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStudioService, ApiError } from '../server/studio.mjs'

const PASSWORD = 'isolated-player-core-test-password'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const fails = (callback, status = 409) =>
  assert.throws(callback, (error) => error instanceof ApiError && error.status === status)

function fixture(t, options = {}) {
  let time = new Date('2026-10-13T04:00:00Z')
  const service = createStudioService({
    dbPath: ':memory:',
    seed: false,
    password: PASSWORD,
    clock: () => time,
    ...options
  })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '优先', delaySeconds: 0 })
  const players = ['leader', 'teammate', 'stranger'].map((name) =>
    mutate('/users', {
      username: name,
      name,
      role: 'player',
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 1,
      permissionOverrides: {},
      password: PASSWORD
    })
  )
  const finance = mutate('/users', {
    username: 'finance',
    name: '财务',
    role: 'finance',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: PASSWORD
  })
  const upload = (actor = 'admin', name = 'picture.png') =>
    service.upload(actor, { name, mime: 'image/png', data: PNG })
  const receipt = upload()
  const customer = mutate('/customers', {
    name: '客户',
    contact: 'SECRET-CONTACT',
    gameId: 'CLIENT-GAME',
    remark: 'SECRET-CUSTOMER-REMARK'
  })
  const template = mutate('/templates', {
    name: '项目',
    game: '游戏',
    description: '完成服务目标',
    map: '不限',
    amount: 2000,
    reward: 1001,
    remark: 'SECRET-TEMPLATE-REMARK',
    active: true
  })
  const order = (extra = {}) =>
    mutate('/orders', {
      customerId: customer.id,
      templateId: template.id,
      platformId: 'xianyu',
      shopId: 'jindun',
      externalOrderNo: randomUUID(),
      roomCode: 'PRIVATE-ROOM',
      gameId: 'PRIVATE-GAME-ID',
      amount: 2000,
      reward: 1001,
      receivedAmount: 2000,
      paidAt: time.toISOString(),
      receipt,
      dispatchMode: 'pool',
      remark: 'SECRET-ORDER-REMARK',
      ...extra
    })
  const claim = (row, player = players[0]) =>
    mutate(`/player/orders/${row.id}/claim`, {}, player.id)
  const submit = (row, teammateId = null) =>
    mutate(
      `/player/orders/${row.id}/submit`,
      { screenshots: [upload(players[0].id)], teammateId },
      players[0].id
    )
  const action = (row, action, extra = {}) =>
    mutate(`/orders/${row.id}/action`, { action, ...extra })
  const qr = (actor = players[0].id) => {
    const qrCode = upload(actor, 'private-qr.png')
    mutate('/player/payment-methods', { method: 'wechat', qrCode }, actor)
    return qrCode
  }
  const withdraw = (amount, requestId = randomUUID(), actor = players[0].id) =>
    mutate('/player/withdrawals', { amount, paymentMethod: 'wechat', requestId }, actor)
  const supplement = (amount, actor = players[0].id) =>
    mutate('/player-adjustments', {
      userId: actor,
      kind: 'supplement',
      amount,
      reason: '财务补款',
      requestId: randomUUID()
    })
  return {
    service,
    mutate,
    players,
    finance,
    upload,
    order,
    claim,
    submit,
    action,
    qr,
    withdraw,
    supplement,
    setTime: (next) => {
      time = new Date(next)
    }
  }
}

test('打手订单与 bootstrap 使用白名单，接受后才提供执行信息，授权覆盖不扩大手机数据', (t) => {
  const f = fixture(t)
  const [leader] = f.players
  f.mutate('/users', {
    ...leader,
    permissionOverrides: {
      'orders.view': true,
      'finance.withdrawals': true,
      'profit.view': true,
      'salary.all': true
    }
  })
  const order = f.order({ dispatchMode: 'direct', assignedTo: leader.id })
  const before = f.service.playerOrderDetail(leader.id, order.id)
  for (const key of [
    'roomCode',
    'gameId',
    'amount',
    'receivedAmount',
    'receipt',
    'customerId',
    'externalOrderNo',
    'remark',
    'commissionSnapshot'
  ])
    assert.equal(Object.hasOwn(before, key), false)
  assert.deepEqual(Object.keys(before.snapshot).sort(), ['description', 'game', 'map', 'name'])
  const bootstrap = f.service.bootstrap(leader.id)
  assert.deepEqual(bootstrap.customers, [])
  assert.deepEqual(bootstrap.customerBalances, [])
  assert.deepEqual(bootstrap.logs, [])
  assert.equal(bootstrap.withdrawals.length, 0)
  assert.equal(JSON.stringify(bootstrap).includes('SECRET-'), false)
  const after = f.claim(order)
  assert.equal(after.roomCode, 'PRIVATE-ROOM')
  assert.equal(after.gameId, 'PRIVATE-GAME-ID')
  assert.equal(JSON.stringify(after).includes('SECRET-'), false)
  f.action(order, 'correct-status', { status: 'review', reason: 'SECRET-INTERNAL-CORRECTION' })
  const own = f.service.playerOrderDetail(leader.id, order.id)
  assert.equal(JSON.stringify(own).includes('SECRET-'), false)
  assert.equal(own.submissions.at(-1).source, 'status-correction')
  fails(() => f.service.playerOrderDetail(f.players[2].id, order.id), 403)
})

test('拒绝指定单进入待分配，保留本人结果，客服再次派单之前任何人不能抢', (t) => {
  const f = fixture(t),
    [leader, teammate] = f.players
  const order = f.order({ dispatchMode: 'direct', assignedTo: leader.id })
  fails(() => f.mutate(`/player/orders/${order.id}/reject`, { reason: '' }, leader.id), 400)
  fails(() => f.mutate(`/player/orders/${order.id}/reject`, { reason: '无空闲' }, teammate.id), 403)
  const rejected = f.mutate(`/player/orders/${order.id}/reject`, { reason: '无空闲' }, leader.id)
  assert.equal(rejected.status, 'pending')
  assert.equal(rejected.dispatchState, 'unassigned')
  assert.equal(
    f.service.playerOrders(teammate.id).some((row) => row.id === order.id),
    false
  )
  fails(() => f.claim(order))
  fails(() => f.claim(order, teammate))
  f.action(order, 'dispatch', { dispatchMode: 'direct', assignedTo: teammate.id })
  fails(() => f.claim(order), 403)
  assert.equal(f.claim(order, teammate).leaderId, teammate.id)
  assert.equal(f.service.playerOrderDetail(leader.id, order.id).rejections[0].reason, '无空闲')
  assert.equal(Object.hasOwn(f.service.playerOrderDetail(leader.id, order.id), 'roomCode'), false)
})

test('退单申请保留负责人和名额，处理终态防重复，提交或后台更正使旧申请失效', (t) => {
  const f = fixture(t),
    [leader, teammate] = f.players
  const order = f.order()
  f.claim(order)
  const apply = () =>
    f.mutate(`/player/orders/${order.id}/return-request`, { reason: '暂时无法执行' }, leader.id)
  let request = apply().returnRequests[0]
  const next = f.order()
  fails(() => f.claim(next))
  fails(apply)
  f.action(order, 'return-reject', { returnRequestId: request.id, reason: '继续执行' })
  assert.equal(f.service.playerOrderDetail(leader.id, order.id).status, 'active')
  request = apply().returnRequests.at(-1)
  const approved = f.action(order, 'return-approve', {
    returnRequestId: request.id,
    reason: '同意交回客服'
  })
  assert.equal(approved.dispatchState, 'unassigned')
  assert.equal(approved.leaderId, null)
  fails(() => f.action(order, 'return-approve', { returnRequestId: request.id, reason: '重复' }))
  fails(() => f.claim(order, teammate))
  assert.equal(
    f.service.playerOrderDetail(leader.id, order.id).returnRequests.at(-1).status,
    'approved'
  )
  f.claim(next)
  const pending = f.mutate(
    `/player/orders/${next.id}/return-request`,
    { reason: '申请' },
    leader.id
  )
  f.submit(next)
  assert.equal(f.service.playerOrderDetail(leader.id, next.id).returnRequests[0].status, 'obsolete')
  fails(() =>
    f.action(next, 'return-approve', {
      returnRequestId: pending.returnRequests[0].id,
      reason: '晚到审批'
    })
  )
  assert.equal(f.service.playerOrderDetail(leader.id, next.id).status, 'review')
})

test('奇数分双人报酬负责人多一分，调整、冲正恢复与旧取消补偿总額守恒', (t) => {
  const f = fixture(t),
    [leader, teammate] = f.players
  const order = f.order()
  f.claim(order)
  f.submit(order, teammate.id)
  f.action(order, 'review-pass')
  assert.equal(f.service.playerWallet(leader.id).earned, 501)
  assert.equal(f.service.playerWallet(teammate.id).earned, 500)
  f.action(order, 'adjust', { amount: 2000, reward: 1003, reason: '更正奇数分' })
  assert.equal(f.service.playerWallet(leader.id).earned, 502)
  assert.equal(f.service.playerWallet(teammate.id).earned, 501)
  f.action(order, 'correct-status', { status: 'active', reason: '重新验收' })
  assert.equal(f.service.playerWallet(leader.id).earned, 0)
  f.action(order, 'correct-status', { status: 'completed', reason: '后台确认完成' })
  assert.equal(f.service.playerWallet(leader.id).earned, 502)
  assert.equal(f.service.playerWallet(teammate.id).earned, 501)
  fails(() => f.action(order, 'review-pass'))
  const canceled = f.order()
  f.claim(canceled)
  legacyCancellationFixture(f.service, canceled, '客户终止')
  f.action(canceled, 'cancel-settle', {
    reward: 1001,
    teammateId: teammate.id,
    reason: '财务登记补偿'
  })
  assert.equal(f.service.playerWallet(leader.id).earned, 1003)
  assert.equal(f.service.playerWallet(teammate.id).earned, 1001)
})

test('提现快照与收款码保护，幂等重试只占一次，审核后不能本人撤回', (t) => {
  const f = fixture(t),
    [leader, teammate] = f.players
  f.supplement(1000)
  fails(() => f.mutate('/player/withdrawals', { amount: 10 }, leader.id), 400)
  const oldQR = f.qr(),
    requestId = randomUUID()
  const row = f.withdraw(10, requestId)
  const newQR = f.qr()
  assert.equal(f.withdraw(10, requestId).id, row.id)
  assert.equal(f.service.playerWallet(leader.id).occupied, 10)
  assert.equal(f.service.playerWallet(leader.id).weeklyUsed, 1)
  assert.equal(f.service.playerWallet(leader.id).withdrawals[0].paymentSnapshot.qrCode.id, oldQR.id)
  assert.equal(f.service.playerPaymentMethods(leader.id)[0].qrCode.id, newQR.id)
  fails(() => f.withdraw(11, requestId))
  fails(() => f.service.download(teammate.id, oldQR.id), 403)
  assert.ok(f.service.download(f.finance.id, oldQR.id).data.length > 0)
  fails(() => f.service.publicAsset(oldQR.id), 404)
  fails(() => f.mutate('/profile', { name: leader.name, avatar: newQR }, leader.id), 400)
  f.mutate(`/withdrawals/${row.id}/action`, { action: 'approve', requestId: randomUUID() })
  fails(() =>
    f.mutate(`/player/withdrawals/${row.id}/cancel`, { requestId: randomUUID() }, leader.id)
  )
  const next = f.withdraw(20)
  const cancelId = randomUUID()
  const canceled = f.mutate(
    `/player/withdrawals/${next.id}/cancel`,
    { requestId: cancelId },
    leader.id
  )
  assert.equal(canceled.status, 'canceled')
  assert.equal(
    f.mutate(`/player/withdrawals/${next.id}/cancel`, { requestId: cancelId }, leader.id).id,
    next.id
  )
  fails(() => f.mutate(`/withdrawals/${next.id}/action`, { action: 'approve' }))
  assert.equal(f.service.playerWallet(leader.id).weeklyUsed, 1)
  assert.equal(
    f.service.playerWallet(leader.id).ledger.reduce((sum, item) => sum + item.delta, 0),
    990
  )
})

test('北京时间周一重置次数，跨周撤回按申请周释放；次数与幂等结果重启仍保留', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'player-week-'))
  const dbPath = join(directory, 'studio.sqlite')
  const f = fixture(t, { dbPath }),
    [leader] = f.players
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  f.setTime('2026-10-18T15:59:59Z')
  f.supplement(1000)
  f.qr()
  const requests = Array.from({ length: 7 }, () => f.withdraw(1))
  assert.equal(f.service.playerWallet(leader.id).weekStart, '2026-10-12')
  fails(() => f.withdraw(1))
  f.setTime('2026-10-18T16:00:00Z')
  assert.equal(f.service.playerWallet(leader.id).weeklyRemaining, 7)
  const current = f.withdraw(1)
  f.mutate(`/player/withdrawals/${requests[0].id}/cancel`, { requestId: randomUUID() }, leader.id)
  assert.equal(f.service.playerWallet(leader.id).weeklyRemaining, 6)
  const second = createStudioService({
    dbPath,
    seed: false,
    password: PASSWORD,
    clock: () => new Date('2026-10-18T16:00:00Z')
  })
  try {
    assert.equal(second.playerWallet(leader.id).weeklyUsed, 1)
    assert.equal(
      testMutate(second, leader.id, '/player/withdrawals', {
        amount: current.amount,
        paymentMethod: 'wechat',
        requestId: current.requestId
      }).id,
      current.id
    )
    assert.equal(second.playerWallet(leader.id).occupied, 7)
  } finally {
    second.close()
  }
})

test('排行榜负责人独计一单，退款与状态更正反映有效结果，提现按发放月且不返回他人付款资料', (t) => {
  const f = fixture(t),
    [leader, teammate] = f.players
  const order = f.order()
  f.claim(order)
  f.submit(order, teammate.id)
  f.action(order, 'review-pass')
  const ranking = () => f.service.playerLeaderboard(leader.id, { month: '2026-10', type: 'orders' })
  assert.equal(ranking().records[0].orderCount, 1)
  assert.equal(
    ranking().records.some((row) => row.userId === teammate.id),
    false
  )
  f.mutate('/refunds', {
    orderId: order.id,
    amount: 1,
    reason: '部分退款',
    requestId: randomUUID()
  })
  assert.equal(ranking().records[0].orderCount, 1)
  f.action(order, 'correct-status', { status: 'active', reason: '重新确认' })
  assert.equal(ranking().records.length, 0)
  f.action(order, 'correct-status', { status: 'completed', reason: '重新完成' })
  assert.equal(ranking().records[0].orderCount, 1)
  f.mutate('/refunds', {
    orderId: order.id,
    amount: 1999,
    reason: '全额退款',
    requestId: randomUUID()
  })
  assert.equal(ranking().records.length, 0)
  f.qr(teammate.id)
  const withdrawal = f.withdraw(100, randomUUID(), teammate.id)
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  f.setTime('2026-11-01T00:00:00Z')
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt: f.upload() })
  assert.equal(
    f.service.playerLeaderboard(leader.id, { month: '2026-10', type: 'withdrawals' }).total,
    0
  )
  const payout = f.service.playerLeaderboard(leader.id, { month: '2026-11', type: 'withdrawals' })
  assert.equal(payout.records[0].amount, 100)
  assert.equal(payout.records[0].userId, teammate.id)
  assert.deepEqual(Object.keys(payout.records[0]).sort(), ['amount', 'name', 'rank', 'userId'])
})

test('报酬收支流水保留实际更正日期与差额，不改写原入账金额和时间', (t) => {
  const f = fixture(t),
    [leader] = f.players
  const order = f.order({ reward: 1001 })
  f.claim(order)
  f.submit(order)
  f.action(order, 'review-pass')
  const original = f.service.playerWallet(leader.id).ledger.find((row) => row.kind === 'reward')
  assert.equal(original.amount, 1001)
  f.setTime('2026-10-14T04:00:00Z')
  f.action(order, 'adjust', { amount: 2000, reward: 1003, reason: '调整为1003分' })
  f.setTime('2026-10-15T04:00:00Z')
  f.action(order, 'adjust', { amount: 2000, reward: 1001, reason: '调整回1001分' })
  const wallet = f.service.playerWallet(leader.id)
  assert.deepEqual(
    wallet.ledger.find((row) => row.id === original.id),
    original
  )
  const corrections = wallet.ledger.filter((row) => row.kind === 'reward-correction')
  assert.deepEqual(
    corrections.map((row) => [row.delta, row.createdAt]),
    [
      [-2, '2026-10-15T04:00:00.000Z'],
      [2, '2026-10-14T04:00:00.000Z']
    ]
  )
  assert.equal(
    wallet.ledger.reduce((total, row) => total + row.delta, 0),
    wallet.available
  )
})

test('打手带后台权限覆盖仍只能导出本人押金，全部期间不泄露他人的历史起始日期', (t) => {
  const f = fixture(t),
    [leader, teammate] = f.players
  f.mutate('/users', {
    ...leader,
    permissionOverrides: {
      'finance.withdrawals': true,
      'finance.refunds': true,
      'profit.view': true,
      'salary.all': true,
      'orders.view': true,
      'logs.view': true
    }
  })
  f.setTime('2020-01-01T00:00:00Z')
  const foreign = f.mutate('/player-deposit-transactions', {
    userId: teammate.id,
    kind: 'deposit',
    amount: 1000,
    reason: '他人旧押金',
    requestId: randomUUID()
  })
  f.setTime('2026-10-13T04:00:00Z')
  const own = f.mutate('/player-deposit-transactions', {
    userId: leader.id,
    kind: 'deposit',
    amount: 500,
    reason: '本人押金',
    requestId: randomUUID()
  })
  const snapshot = f.service.exportSnapshot(leader.id, {
    period: { type: 'total' },
    modules: [{ id: 'playerDepositTransactions' }]
  })
  assert.equal(snapshot.exportPeriod.start, '2026-10-13')
  assert.deepEqual(
    snapshot.playerDepositTransactions.map((row) => row.id),
    [own.id]
  )
  assert.equal(JSON.stringify(snapshot).includes(foreign.id), false)
  assert.equal(snapshot.auditLogCount, 0)
  assert.equal(snapshot.fundCounts.customerTransactions, 0)
  assert.equal(snapshot.fundCounts.playerDepositTransactions, 1)
})
