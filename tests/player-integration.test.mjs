import { testMutate, installTestClientFetch } from './helpers/current-intent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createECDH, randomBytes } from 'node:crypto'
import webpush from 'web-push'
import { createStudioServer } from '../server/index.mjs'
import { buildDiagnosticsReport } from '../server/diagnostics.mjs'

const password = 'isolated-player-integration-123'
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

async function fixture(t, options = {}) {
  let current = new Date('2026-10-13T04:00:00Z')
  const server = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password,
    clock: () => current,
    ...options
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const cookies = {}
  async function login(role, username = role) {
    const response = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    assert.equal(response.status, 200)
    cookies[role] = response.headers.get('set-cookie').split(';')[0]
    return response.json()
  }
  async function api(path, body, role = 'admin', expected = 200) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookies[role],
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const result = await response.json()
    assert.equal(
      response.status,
      expected,
      `${role} ${path}: ${result.message || JSON.stringify(result)}`
    )
    return result
  }
  await login('admin')
  const level = await api('/levels', { name: '手机联调等级', delaySeconds: 0 })
  const users = {}
  for (const [name, role] of [
    ['support', 'support'],
    ['finance', 'finance'],
    ['player1', 'player'],
    ['player2', 'player']
  ]) {
    users[name] = await api('/users', {
      username: `integration-${name}`,
      name: `联调${name}`,
      role,
      password,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 1,
      permissionOverrides: {}
    })
    await login(name, users[name].username)
  }
  const customer = await api('/customers', {
    name: '敏感客户称呼',
    contact: 'private-customer-contact-123',
    gameId: 'private-game-id-123',
    remark: 'private-customer-note-123'
  })
  const template = await api('/templates', {
    name: '手机联调项目',
    game: '联调游戏',
    description: '公开服务要求',
    remark: 'private-template-note-123',
    amount: 2000,
    reward: 1001,
    active: true
  })
  const upload = (actor = 'player1', name = '联调图片.png') =>
    api('/uploads', { name, mime: 'image/png', data: png }, actor)
  const order = (changes = {}) =>
    api(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId: 'xianyu',
        shopId: 'jindun',
        externalOrderNo: randomUUID(),
        roomCode: 'private-room-code-123',
        gameId: customer.gameId,
        amount: 2000,
        reward: 1001,
        receivedAmount: 2000,
        paidAt: '2026-10-13T11:00:00+08:00',
        dispatchMode: 'direct',
        assignedTo: users.player1.id,
        remark: 'private-order-note-123',
        ...changes
      },
      'support'
    )
  const action = (record, body, expected = 200) =>
    api(`/orders/${record.id}/action`, body, 'support', expected)
  const correct = (record, status, changes = {}) =>
    api(
      `/orders/${record.id}/action`,
      {
        action: 'correct-status',
        status,
        leaderId: users.player1.id,
        reason: '财务核验更正',
        ...changes
      },
      'finance'
    )
  const withdraw = (amount = 1, actor = 'player1', requestId = randomUUID()) =>
    api('/player/withdrawals', { amount, paymentMethod: 'wechat', requestId }, actor)
  const snapshot = () => api('/bootstrap')
  const diagnostics = () => api('/diagnostics')
  return {
    server,
    base,
    cookies,
    api,
    login,
    users,
    upload,
    order,
    action,
    correct,
    withdraw,
    snapshot,
    diagnostics,
    setTime: (value) => {
      current = new Date(value)
    }
  }
}

test('真实HTTP权限投影：接单前隐去执行信息，账号覆盖权限不暴露客户与他人收款码', async (t) => {
  const f = await fixture(t)
  const record = await f.order()
  const before = await f.api(`/player/orders/${record.id}`, undefined, 'player1')
  assert.equal(before.reward, 1001)
  for (const key of [
    'customerId',
    'amount',
    'receivedAmount',
    'receipt',
    'roomCode',
    'gameId',
    'remark',
    'commissionSnapshot'
  ])
    assert.equal(Object.hasOwn(before, key), false, key)
  await f.api(`/player/orders/${record.id}`, undefined, 'player2', 403)
  await f.api(`/player/orders/${record.id}/claim`, {}, 'player1')
  const active = await f.api(`/player/orders/${record.id}`, undefined, 'player1')
  assert.equal(active.roomCode, 'private-room-code-123')
  assert.equal(active.gameId, 'private-game-id-123')
  assert.equal(Object.hasOwn(active, 'amount'), false)
  const qrCode = await f.upload('player1', '私人微信收款码.png')
  await f.api('/player/payment-methods', { method: 'wechat', qrCode }, 'player1')
  await f.api('/users', {
    ...f.users.player2,
    permissionOverrides: {
      'orders.view': true,
      'finance.withdrawals': true,
      'users.manage': true,
      'profit.view': true,
      'salary.all': true,
      'logs.view': true
    }
  })
  const other = await f.api('/bootstrap', undefined, 'player2')
  const serialized = JSON.stringify(other)
  for (const secret of [
    'private-customer-contact-123',
    '敏感客户称呼',
    'private-template-note-123',
    'private-order-note-123',
    qrCode.id
  ])
    assert.equal(serialized.includes(secret), false, secret)
  for (const periodType of ['monthly', 'daily', 'total']) {
    const catalog = await f.api(
      `/exports/catalog?periodType=${periodType}&periodDate=2026-10-13&month=2026-10`,
      undefined,
      'player2'
    )
    for (const module of [
      'orders',
      'orderReturns',
      'orderRejections',
      'customers',
      'overview',
      'days',
      'salaryPlans',
      'payroll',
      'staff',
      'logs'
    ])
      assert.equal(
        catalog.modules.some((row) => row.id === module),
        false,
        module
      )
    await f.api(
      '/exports/download',
      {
        month: '2026-10',
        period: { type: periodType, date: '2026-10-13' },
        modules: [{ id: 'orders', fields: ['amount'] }]
      },
      'player2',
      403
    )
  }
  const denied = await fetch(f.base + `/uploads/${qrCode.id}`, {
    headers: { Cookie: f.cookies.player2 }
  })
  assert.equal(denied.status, 403)
  const publicDenied = await fetch(f.base + `/appearance/assets/${qrCode.id}`)
  assert.notEqual(publicDenied.status, 200)
  for (const path of [
    '/players',
    `/players/${f.users.player1.id}/orders`,
    `/players/${f.users.player1.id}/deposit`,
    `/players/${f.users.player1.id}/deposit-transactions`,
    '/customers/guessed-customer/balance',
    '/customers/guessed-customer/transactions',
    '/logs',
    '/logs/storage',
    '/diagnostics',
    '/overview',
    '/notifications',
    '/notifications/delivery-status'
  ])
    await f.api(path, undefined, 'player2', 403)
  assert.deepEqual(
    await f.api('/player/payment-methods?userId=' + f.users.player1.id, undefined, 'player2'),
    []
  )
  const ownWallet = await f.api('/player/wallet?userId=' + f.users.player1.id, undefined, 'player2')
  assert.equal(ownWallet.userId, f.users.player2.id)
  assert.equal(ownWallet.withdrawals.length, 0)
})

test('真实HTTP拒单和退单：待客服批准继续占名额，批准进入待分配，重复或旧申请不能释放新负责人', async (t) => {
  const f = await fixture(t)
  const record = await f.order()
  await f.api(`/player/orders/${record.id}/reject`, { reason: '' }, 'player1', 400)
  const rejected = await f.api(
    `/player/orders/${record.id}/reject`,
    { reason: '当前无法接单' },
    'player1'
  )
  assert.equal(rejected.status, 'pending')
  assert.equal(rejected.dispatchState, 'unassigned')
  await f.api(`/player/orders/${record.id}/claim`, {}, 'player2', 409)
  await f.action(record, { action: 'dispatch', dispatchMode: 'pool' })
  await f.api(`/player/orders/${record.id}/claim`, {}, 'player1')
  const requested = await f.api(
    `/player/orders/${record.id}/return-request`,
    { reason: '执行发生问题' },
    'player1'
  )
  const request = requested.returnRequests.at(-1)
  assert.equal(request.status, 'pending')
  assert.equal(requested.status, 'active')
  const second = await f.order({ dispatchMode: 'pool', assignedTo: null })
  await f.api(`/player/orders/${second.id}/claim`, {}, 'player1', 409)
  await f.api(`/player/orders/${record.id}/return-request`, { reason: '重复提交' }, 'player1', 409)
  const approved = await f.action(record, {
    action: 'return-approve',
    returnRequestId: request.id,
    reason: '客服确认需重派'
  })
  assert.equal(approved.dispatchState, 'unassigned')
  assert.equal(approved.leaderId, null)
  assert.equal(approved.returnRequests.at(-1).processedBy, f.users.support.id)
  await f.api(`/player/orders/${record.id}/claim`, {}, 'player2', 409)
  await f.action(
    record,
    { action: 'return-approve', returnRequestId: request.id, reason: '重复批准' },
    409
  )
  await f.action(record, {
    action: 'dispatch',
    dispatchMode: 'direct',
    assignedTo: f.users.player2.id
  })
  await f.api(`/player/orders/${record.id}/claim`, {}, 'player2')
  await f.action(
    record,
    { action: 'return-approve', returnRequestId: request.id, reason: '旧申请重放' },
    409
  )
  assert.equal(
    (await f.snapshot()).orders.find((row) => row.id === record.id).leaderId,
    f.users.player2.id
  )
  const request2 = (
    await f.api(
      `/player/orders/${record.id}/return-request`,
      { reason: '申请后财务更正' },
      'player2'
    )
  ).returnRequests.at(-1)
  await f.correct(record, 'review', { leaderId: f.users.player2.id })
  await f.action(
    record,
    { action: 'return-approve', returnRequestId: request2.id, reason: '过期处理' },
    409
  )
  assert.equal((await f.diagnostics()).summary.errorCount, 0)
  const exported = await f.api('/exports/download', {
    month: '2026-10',
    modules: [
      { id: 'orderReturns', fields: ['leaderName', 'reason', 'status', 'processedName'] },
      { id: 'orderRejections', fields: ['playerName', 'reason'] }
    ]
  })
  assert.equal(exported.sheets[0].rowCount, 2)
  assert.equal(exported.sheets[1].rows[0].reason, '当前无法接单')
  const canceled = await f.order()
  await f.api(`/player/orders/${canceled.id}/reject`, { reason: '无法接受，交回客服' }, 'player1')
  const canceledResult = await f.action(canceled, {
    action: 'cancel',
    reason: '客服取消待分配订单'
  })
  assert.equal(canceledResult.status, 'canceled')
  assert.equal((await f.diagnostics()).summary.errorCount, 0)
})

test('真实HTTP双人奇数分：提交验收、后台免图更正、冲正恢复和数据检查保持金额守恒', async (t) => {
  const f = await fixture(t)
  const record = await f.order()
  await f.api(`/player/orders/${record.id}/claim`, {}, 'player1')
  await f.api(
    `/player/orders/${record.id}/submit`,
    { screenshots: [await f.upload()], teammateId: f.users.player2.id },
    'player1'
  )
  await f.api(`/orders/${record.id}/action`, { action: 'review-pass' }, 'finance')
  assert.equal((await f.api('/player/wallet', undefined, 'player1')).earned, 501)
  assert.equal((await f.api('/player/wallet', undefined, 'player2')).earned, 500)
  assert.equal((await f.diagnostics()).summary.errorCount, 0)
  await f.correct(record, 'active', { teammateId: f.users.player2.id })
  assert.equal((await f.api('/player/wallet', undefined, 'player1')).earned, 0)
  assert.equal((await f.api('/player/wallet', undefined, 'player2')).earned, 0)
  const completed = await f.correct(record, 'completed', { teammateId: f.users.player2.id })
  assert.equal(completed.submissions.at(-1).source, 'status-correction')
  assert.equal(completed.submissions.at(-1).screenshots.length, 0)
  assert.equal((await f.api('/player/wallet', undefined, 'player1')).earned, 501)
  assert.equal((await f.api('/player/wallet', undefined, 'player2')).earned, 500)
  await f.api(
    `/orders/${record.id}/action`,
    { action: 'cancel', reason: '财务取消核对' },
    'finance'
  )
  await f.api(`/orders/${record.id}/action`, { action: 'correct-status', status: 'active', teammateId: f.users.player2.id, reason: '已取消不能恢复' }, 'finance', 409)
  await f.api(`/orders/${record.id}/action`, { action: 'correct-status', status: 'completed', teammateId: f.users.player2.id, reason: '已取消不能重新结算' }, 'finance', 409)
  assert.equal((await f.api('/player/wallet', undefined, 'player1')).earned, 501)
  assert.equal((await f.api('/player/wallet', undefined, 'player2')).earned, 500)
  assert.equal((await f.diagnostics()).summary.errorCount, 0)
})

test('真实HTTP提现：快照不可替换、撤回和审核竞争、7次自然周及跨周释放和导出', async (t) => {
  const f = await fixture(t)
  await f.api(
    '/player-adjustments',
    {
      userId: f.users.player1.id,
      kind: 'supplement',
      amount: 2000,
      reason: '联调补款',
      requestId: randomUUID()
    },
    'finance'
  )
  const oldQr = await f.upload('player1', '旧收款码.png')
  await f.api('/player/payment-methods', { method: 'wechat', qrCode: oldQr }, 'player1')
  const first = await f.withdraw(10)
  const newQr = await f.upload('player1', '新收款码.png')
  await f.api('/player/payment-methods', { method: 'wechat', qrCode: newQr }, 'player1')
  const second = await f.withdraw(5)
  assert.equal(first.paymentSnapshot.qrCode.id, oldQr.id)
  assert.equal(second.paymentSnapshot.qrCode.id, newQr.id)
  const cancelBody = { requestId: randomUUID() }
  const canceled = await f.api(`/player/withdrawals/${first.id}/cancel`, cancelBody, 'player1')
  assert.equal(canceled.status, 'canceled')
  assert.deepEqual(
    await f.api(`/player/withdrawals/${first.id}/cancel`, cancelBody, 'player1'),
    canceled
  )
  await f.api(`/withdrawals/${first.id}/action`, { action: 'approve' }, 'finance', 409)
  await f.api(`/withdrawals/${second.id}/action`, { action: 'approve' }, 'finance')
  await f.api(
    `/player/withdrawals/${second.id}/cancel`,
    { requestId: randomUUID() },
    'player1',
    409
  )
  const payBody = { action: 'pay', receipt: await f.upload('finance'), requestId: randomUUID() }
  const paid = await f.api(`/withdrawals/${second.id}/action`, payBody, 'finance')
  assert.deepEqual(await f.api(`/withdrawals/${second.id}/action`, payBody, 'finance'), paid)
  const more = []
  for (let index = 0; index < 6; index++) more.push(await f.withdraw())
  assert.equal((await f.api('/player/wallet', undefined, 'player1')).weeklyUsed, 7)
  await f.api(
    '/player/withdrawals',
    { amount: 1, paymentMethod: 'wechat', requestId: randomUUID() },
    'player1',
    409
  )
  f.setTime('2026-10-18T16:00:00Z')
  await f.login('player1', f.users.player1.username)
  await f.login('finance', f.users.finance.username)
  await f.login('admin')
  assert.equal((await f.api('/player/wallet', undefined, 'player1')).weeklyRemaining, 7)
  await f.api(`/player/withdrawals/${more[0].id}/cancel`, { requestId: randomUUID() }, 'player1')
  assert.equal((await f.api('/player/wallet', undefined, 'player1')).weeklyRemaining, 7)
  const nextWeek = await f.withdraw()
  assert.equal(nextWeek.weekStart, '2026-10-19')
  const exported = await f.api('/exports/download', {
    month: '2026-10',
    modules: [
      {
        id: 'withdrawals',
        fields: ['status', 'weekStart', 'paymentQrCodeName', 'paymentQrCodeUrl', 'canceledAt']
      }
    ]
  })
  assert.ok(
    exported.sheets[0].rows.some(
      (row) => row.status === '已撤回' && row.paymentQrCodeName === oldQr.name && row.canceledAt
    )
  )
  assert.equal((await f.diagnostics()).summary.errorCount, 0)
})

test('真实并发请求：同单唯一负责人、同人执行上限、提现重复创建和撤回审核只有一个有效结果', async (t) => {
  const f = await fixture(t)
  async function post(path, body, actor) {
    const response = await fetch(f.base + path, {
      method: 'POST',
      headers: { Cookie: f.cookies[actor], 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: response.status, data: await response.json() }
  }
  const pool = await f.order({ dispatchMode: 'pool', assignedTo: null })
  const claim = await Promise.all(
    ['player1', 'player2'].map((actor) => post(`/player/orders/${pool.id}/claim`, {}, actor))
  )
  assert.deepEqual(claim.map((row) => row.status).sort(), [200, 409])
  const winner = claim[0].status === 200 ? 'player1' : 'player2'
  const loser = winner === 'player1' ? 'player2' : 'player1'
  const next = await Promise.all([
    f.order({ dispatchMode: 'pool', assignedTo: null }),
    f.order({ dispatchMode: 'pool', assignedTo: null })
  ])
  const attempts = await Promise.all(
    next.map((record) => post(`/player/orders/${record.id}/claim`, {}, loser))
  )
  assert.deepEqual(attempts.map((row) => row.status).sort(), [200, 409])
  assert.equal(
    (await f.snapshot()).orders.filter(
      (row) => row.status === 'active' && row.leaderId === f.users[loser].id
    ).length,
    1
  )

  await f.api(
    '/player-adjustments',
    {
      userId: f.users.player1.id,
      kind: 'supplement',
      amount: 100,
      reason: '并发提现测试',
      requestId: randomUUID()
    },
    'finance'
  )
  const qrCode = await f.upload()
  await f.api('/player/payment-methods', { method: 'wechat', qrCode }, 'player1')
  const body = { amount: 10, paymentMethod: 'wechat', requestId: randomUUID() }
  const created = await Promise.all([
    post('/player/withdrawals', body, 'player1'),
    post('/player/withdrawals', body, 'player1')
  ])
  assert.deepEqual(
    created.map((row) => row.status),
    [200, 200]
  )
  assert.deepEqual(created[0].data, created[1].data)
  assert.equal((await f.api('/player/wallet', undefined, 'player1')).occupied, 10)
  const id = created[0].data.id
  const race = await Promise.all([
    post(`/player/withdrawals/${id}/cancel`, { requestId: randomUUID() }, 'player1'),
    post(`/withdrawals/${id}/action`, { action: 'approve', requestId: randomUUID() }, 'finance')
  ])
  assert.deepEqual(race.map((row) => row.status).sort(), [200, 409])
  const wallet = await f.api('/player/wallet', undefined, 'player1')
  assert.equal(wallet.withdrawals.length, 1)
  assert.equal(wallet.occupied, wallet.withdrawals[0].status === 'canceled' ? 0 : 10)
  assert.equal(wallet.weeklyUsed, wallet.withdrawals[0].status === 'canceled' ? 0 : 1)
  assert.equal((await f.diagnostics()).summary.errorCount, 0)
})

test('新增派单、退单和提现检查可识别损坏记录，格式错误不会使只读检查崩溃', () => {
  const state = {
    users: [
      { id: 'player', role: 'player' },
      { id: 'admin', role: 'super_admin' }
    ],
    customers: [{ id: 'customer' }],
    platforms: [{ id: 'platform' }],
    templates: [{ id: 'template' }],
    orders: [
      {
        id: 'order',
        customerId: 'customer',
        platformId: 'platform',
        templateId: 'template',
        creatorId: 'admin',
        status: 'active',
        dispatchMode: 'direct',
        dispatchState: 'unassigned',
        leaderId: 'player',
        amount: 100,
        reward: 101,
        receivedAmount: 0,
        returnRequests: [
          {
            id: 'return',
            leaderId: 'player',
            status: 'approved',
            requestedAt: '2026-10-13T04:00:00Z',
            reason: 123,
            processReason: 123
          }
        ]
      }
    ],
    withdrawals: [
      {
        id: 'withdrawal',
        userId: 'player',
        amount: 1,
        status: 'canceled',
        createdAt: '2026-10-13T04:00:00Z',
        weekStart: '2026-10-19',
        paymentMethod: 'wechat',
        paymentSnapshot: { method: 'alipay', qrCode: { id: 'missing' }, updatedAt: 'invalid' }
      }
    ]
  }
  const report = buildDiagnosticsReport({ state, now: '2026-10-13T04:00:00Z' })
  for (const text of [
    '待分配订单',
    '退单申请缺少有效状态',
    '已处理退单申请缺少处理人',
    '自然周与申请时间不一致',
    '缺少撤回时间',
    '收款资料快照缺少',
    '收款码快照关联的上传图片不存在'
  ])
    assert.ok(
      report.issues.some((row) => row.message.includes(text)),
      text
    )
})

test('业务事务后置通知失败时，订单、消息和审计一起回滚', async (t) => {
  let failNextOrder = false
  const f = await fixture(t, {
    onTransaction: ({ state, beforeState }) => {
      if (failNextOrder && state.orders.length > beforeState.orders.length)
        throw new Error('通知事务回滚测试')
    }
  })
  const first = await f.order()
  const db = f.server.service.db
  const beforeNotices = db.prepare('SELECT COUNT(*) AS count FROM player_notifications').get().count
  const beforeLogs = db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count
  failNextOrder = true
  assert.throws(
    () =>
      testMutate(f.server.service, 'admin', '/orders', { ...first, externalOrderNo: randomUUID() }),
    /通知事务回滚测试/
  )
  assert.equal((await f.snapshot()).orders.length, 1)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM player_notifications').get().count,
    beforeNotices
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, beforeLogs)
})

test('推送订阅永久失效时，超过单批20条的积压也释放为跳过，不留下永远待发送的孤立队列', async (t) => {
  const f = await fixture(t, {
    notifications: {
      ...webpush.generateVAPIDKeys(),
      subject: 'mailto:integration@example.com',
      clock: () => new Date('2026-10-13T04:00:00Z'),
      pushSender: async () => {
        throw Object.assign(new Error('测试过期订阅'), { statusCode: 410 })
      }
    }
  })
  const key = createECDH('prime256v1')
  key.generateKeys()
  await f.api(
    '/player/push-subscriptions',
    {
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/integration-expired-subscription',
        keys: {
          p256dh: key.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url')
        }
      }
    },
    'player1'
  )
  await Promise.all(Array.from({ length: 25 }, () => f.order()))
  const db = f.server.service.db
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM player_push_outbox WHERE status='pending'").get()
      .count,
    25
  )
  await f.server.notifications.flushPush()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM player_push_outbox WHERE status='pending'").get()
      .count,
    0
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM player_push_subscriptions').get().count, 0)
  assert.equal((await f.api('/player/notifications', undefined, 'player1')).total, 25)
})

installTestClientFetch()
