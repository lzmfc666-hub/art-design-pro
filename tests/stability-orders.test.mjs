import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioService } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'

const password = 'isolated-stability-order-123'
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
function setup(t, server = false, options = {}) {
  const target = server
    ? createStudioServer({
        dbPath: ':memory:',
        seed: false,
        password,
        notificationIntervalMs: 3600000,
        ...options
      })
    : createStudioService({ dbPath: ':memory:', seed: false, password, ...options })
  const s = server ? target.service : target
  if (!server) t.after(() => s.close())
  const level = s.mutate('admin', '/levels', { name: '稳定性等级', delaySeconds: 0 })
  const platform = s.mutate('admin', '/platforms', {
    name: '稳定性来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const customer = s.mutate('admin', '/customers', {
    name: '隔离客户',
    contact: '',
    gameId: '',
    remark: ''
  })
  const template = s.mutate('admin', '/templates', {
    name: '隔离订单',
    game: '隔离',
    amount: 10000,
    reward: 7000,
    active: true
  })
  const staff = (username, role) =>
    s.mutate('admin', '/users', {
      username,
      name: username,
      role,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 1,
      permissionOverrides: {},
      password
    })
  const p = staff('stability-player', 'player'),
    q = staff('stability-other', 'player'),
    finance = staff('stability-finance', 'finance')
  const order = (extra = {}) =>
    s.mutate('admin', '/orders', {
      requestId: randomUUID(),
      templateId: template.id,
      customerId: customer.id,
      platformId: platform.id,
      roomCode: 'room',
      gameId: '',
      map: '不限',
      dispatchMode: 'pool',
      amount: 10000,
      reward: 7000,
      receivedAmount: 10000,
      paidAt: new Date().toISOString(),
      remark: '内部秘密不公开',
      playerRemark: '打手明确说明',
      ...extra
    })
  const current = (id) => s.orderDetail('admin', id).order
  const intent = (id, body = {}) => {
    const row = current(id)
    return {
      requestId: randomUUID(),
      expectedRevision: row.revision,
      dispatchRound: row.dispatchRound,
      assignmentId: row.assignmentId,
      submissionId: row.submissionId,
      leaderId: row.leaderId,
      ...body
    }
  }
  const act = (id, action, extra = {}, actor = 'admin') =>
    s.mutate(actor, `/orders/${id}/action`, intent(id, { action, ...extra }))
  const claim = (id, actor = p.id, body) =>
    s.mutate(actor, `/player/orders/${id}/claim`, body || intent(id))
  const shot = (actor = p.id) => s.upload(actor, { name: '完成.png', mime: 'image/png', data: png })
  const submit = (id, actor = p.id) =>
    s.mutate(actor, `/player/orders/${id}/submit`, intent(id, { screenshots: [shot(actor)] }))
  const rejected = (cb, code) => assert.throws(cb, (e) => e.status === 409 && e.code === code)
  return {
    s,
    target,
    p,
    q,
    finance,
    order,
    current,
    intent,
    act,
    claim,
    submit,
    shot,
    rejected,
    customer
  }
}

test('缺少校验字段的旧客户端拒绝；旧派单及旧解除不能操作新轮次或新负责人', (t) => {
  const f = setup(t),
    o = f.order()
  f.rejected(() => f.s.mutate(f.p.id, `/player/orders/${o.id}/claim`, {}), 'PRECONDITION_REQUIRED')
  const oldDispatch = f.intent(o.id)
  f.act(o.id, 'dispatch', { dispatchMode: 'direct', assignedTo: f.p.id })
  f.rejected(() => f.claim(o.id, f.p.id, oldDispatch), 'DISPATCH_ROUND_CONFLICT')
  f.claim(o.id)
  const oldRelease = f.intent(o.id, { action: 'release', reason: '原解除' })
  f.act(o.id, 'release', { reason: '重新派单' })
  f.claim(o.id, f.q.id)
  f.rejected(() => f.s.mutate('admin', `/orders/${o.id}/action`, oldRelease), 'ASSIGNMENT_CONFLICT')
  assert.equal(f.current(o.id).leaderId, f.q.id)
})

test('旧验收请求不能审核新材料，验收退回保留接单记录和已有超限订单', (t) => {
  const f = setup(t),
    o = f.order()
  f.claim(o.id)
  f.submit(o.id)
  const oldReview = f.intent(o.id, { action: 'review-pass' })
  const assignment = f.current(o.id).assignmentId
  const extra = f.order()
  f.claim(extra.id)
  f.act(o.id, 'review-return', { reason: '重新截图' })
  assert.equal(f.s.dispatchTargets('admin').records.find((r) => r.id === f.p.id).activeOrders, 2)
  assert.equal(f.current(o.id).assignmentId, assignment)
  assert.equal(f.s.playerOrderDetail(f.p.id, o.id).canClaim, false)
  f.submit(o.id)
  f.rejected(() => f.s.mutate('admin', `/orders/${o.id}/action`, oldReview), 'SUBMISSION_CONFLICT')
  assert.equal(f.current(o.id).status, 'review')
})

test('多人编辑不覆盖，成功响应丢失后的同意图重试不因版本变化失败', (t) => {
  const f = setup(t),
    o = f.order(),
    first = f.intent(o.id, { action: 'remark', playerRemark: '新说明' }),
    stale = f.intent(o.id, { action: 'remark', playerRemark: '过期内容' })
  const result = f.s.mutate('admin', `/orders/${o.id}/action`, first)
  const version = f.s.staffChanges('admin').version
  assert.deepEqual(f.s.mutate('admin', `/orders/${o.id}/action`, first), result)
  assert.equal(f.s.staffChanges('admin').version, version)
  f.rejected(() => f.s.mutate('admin', `/orders/${o.id}/action`, stale), 'ORDER_REVISION_CONFLICT')
  f.rejected(
    () => f.s.mutate('admin', `/orders/${o.id}/action`, { ...first, playerRemark: '编号复用' }),
    'REQUEST_ID_CONFLICT'
  )
  assert.equal(f.current(o.id).playerRemark, '新说明')
})

test('落地付可接单，但未足额付款不允许上报；付款后待验收释放名额且验收才记报酬', (t) => {
  const f = setup(t),
    o = f.order({ payOnArrival: true, receivedAmount: 0, paidAt: null })
  const accepted = f.claim(o.id)
  assert.equal(accepted.paymentConfirmed, false)
  assert.equal(accepted.canSubmit, false)
  f.rejected(() => f.submit(o.id), 'PAYMENT_NOT_CONFIRMED')
  f.act(o.id, 'confirm-payment', {
    receivedAmount: 10000,
    paidAt: new Date().toISOString(),
    paymentMethod: 'cash'
  })
  assert.equal(f.s.playerOrderDetail(f.p.id, o.id).canSubmit, true)
  f.submit(o.id)
  assert.equal(f.s.dispatchTargets('admin').records.find((r) => r.id === f.p.id).activeOrders, 0)
  assert.equal(f.s.playerWallet(f.p.id).earned, 0)
  f.act(o.id, 'review-pass', {}, f.finance.id)
  assert.equal(f.s.playerWallet(f.p.id).earned, 7000)
})

test('退单待审批继续占名额，批准后释放；队友和指定待接受不占名额', (t) => {
  const f = setup(t),
    o = f.order()
  f.claim(o.id)
  f.s.mutate(
    f.p.id,
    `/player/orders/${o.id}/return-request`,
    f.intent(o.id, { reason: '测试退单' })
  )
  const other = f.order()
  assert.equal(f.s.playerOrderDetail(f.p.id, other.id).canClaim, false)
  const request = f.current(o.id).returnRequests.at(-1)
  f.act(o.id, 'return-approve', { returnRequestId: request.id, reason: '确认退单' })
  assert.equal(f.s.playerOrderDetail(f.p.id, other.id).canClaim, true)
  f.act(o.id, 'dispatch', { dispatchMode: 'direct', assignedTo: f.q.id })
  assert.equal(
    f.s.dispatchTargets('admin').records.find((r) => r.id === f.q.id).pendingAssignments,
    1
  )
  assert.equal(f.s.dispatchTargets('admin').records.find((r) => r.id === f.q.id).activeOrders, 0)
})

test('权限和当前可见范围撤销均先于成功缓存，不读取失去权限的历史结果', (t) => {
  const f = setup(t),
    o = f.order(),
    intent = f.intent(o.id)
  f.claim(o.id, f.p.id, intent)
  f.act(o.id, 'release', { reason: '后续解除' })
  f.claim(o.id, f.q.id)
  assert.throws(
    () => f.claim(o.id, f.p.id, intent),
    (e) => e.status === 403
  )
  assert.equal(f.current(o.id).leaderId, f.q.id)
  f.s.mutate('admin', '/users', {
    ...f.p,
    playerAccess: { login: true, claim: false, withdraw: true }
  })
  assert.throws(
    () => f.claim(o.id, f.p.id, intent),
    (e) => e.status === 403
  )
})

test('内部备注从不公开，分页、摘要、目录保持权限隔离和权限变化失效', (t) => {
  const f = setup(t)
  for (let i = 0; i < 5; i++) f.order()
  const page = f.s.playerOrdersPage(f.p.id, { current: 2, size: 2 })
  assert.equal(page.total, 5)
  assert.equal(page.records.length, 2)
  for (const row of page.records) {
    assert.equal(row.playerRemark, '打手明确说明')
    for (const field of ['amount', 'receivedAmount', 'receipt', 'remark', 'customerId'])
      assert.equal(field in row, false)
  }
  const summary = f.s.playerChanges(f.p.id)
  assert.equal(f.s.playerChanges(f.p.id, summary.version).changed, false)
  f.s.mutate('admin', '/users', { ...f.p, maxActiveOrders: 2 })
  assert.equal(f.s.playerChanges(f.p.id, summary.version).changed, true)
  assert.throws(
    () => f.s.ordersPage(f.p.id, {}),
    (e) => e.status === 403
  )
  assert.equal(f.s.exportCatalogSnapshot('admin').catalogOnly, true)
})

test('现金更正须明确历史录错影响，不用普通改价伪造追加实收', (t) => {
  const f = setup(t),
    o = f.order(),
    paidAt = o.paidAt
  f.rejected(
    () => f.act(o.id, 'edit', { amount: 11000, reason: '真实加价' }),
    'PRECONDITION_REQUIRED'
  )
  f.rejected(
    () =>
      f.act(o.id, 'edit', {
        amount: 11000,
        reason: '真实加价',
        amountChangeKind: 'price-change',
        affectsHistoricalReceived: false
      }),
    'PAYMENT_ADJUSTMENT_REQUIRED'
  )
  f.act(o.id, 'edit', {
    amount: 11000,
    reason: '核实原金额录错',
    amountChangeKind: 'historical-correction',
    affectsHistoricalReceived: true
  })
  assert.equal(f.current(o.id).receivedAmount, 11000)
  assert.equal(f.current(o.id).paidAt, paidAt)
})

test('事务后置失败时订单、审计和幂等结果同时回滚，原编号可正常重新执行', (t) => {
  let fail = false
  const f = setup(t, false, {
      onTransaction: () => {
        if (fail) throw new Error('isolated rollback')
      }
    }),
    o = f.order(),
    body = f.intent(o.id, { action: 'remark', playerRemark: '不能残留' })
  const logs = f.s.logs('admin', {}).total
  fail = true
  assert.throws(() => f.s.mutate('admin', `/orders/${o.id}/action`, body), /isolated rollback/)
  assert.equal(f.current(o.id).revision, o.revision)
  assert.equal(f.s.logs('admin', {}).total, logs)
  assert.equal(
    f.s.db
      .prepare('SELECT COUNT(*) AS n FROM business_requests WHERE request_id=?')
      .get(body.requestId).n,
    0
  )
  fail = false
  f.s.mutate('admin', `/orders/${o.id}/action`, body)
  assert.equal(f.current(o.id).playerRemark, '不能残留')
})

test('升级前仅有旧资金成功记录的编号不能用新字段伪造成功确认，历史资金不删除', (t) => {
  const f = setup(t),
    requestId = randomUUID(),
    body = {
      requestId,
      customerId: f.customer.id,
      kind: 'recharge',
      amount: 100,
      reason: '历史充值'
    }
  f.s.mutate('admin', '/customer-transactions', body)
  f.s.db.prepare('DELETE FROM business_requests WHERE request_id=?').run(requestId)
  f.rejected(
    () => f.s.mutate('admin', '/customer-transactions', { ...body, reason: '新的含义' }),
    'REQUEST_ID_CONFLICT'
  )
  assert.equal(f.s.customerBalance('admin', f.customer.id).balance, 100)
  assert.equal(
    f.s.db.prepare('SELECT COUNT(*) AS n FROM fund_transactions WHERE request_id=?').get(requestId)
      .n,
    1
  )
})

test('真实HTTP原始客户端：缺字段409、同单及同人竞争不超抢、原响应丢失重试成功', async (t) => {
  const f = setup(t, true),
    server = f.target
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const actors = new Map()
  const post = async (path, body, cookie) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Studio-Client': 'player',
        ...(cookie ? { Cookie: cookie, 'X-Studio-Actor': actors.get(cookie) } : {})
      },
      body: JSON.stringify(body)
    })
    const response = {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0]
    }
    if (response.cookie && response.body.user?.id)
      actors.set(response.cookie, response.body.user.id)
    return response
  }
  const a = (await post('/login', { username: f.p.username, password })).cookie,
    b = (await post('/login', { username: f.q.username, password })).cookie
  const o = f.order(),
    path = `/player/orders/${o.id}/claim`
  const missing = await post(path, {}, a)
  assert.equal(missing.status, 409)
  assert.equal(missing.body.code, 'PRECONDITION_REQUIRED')
  const bodyA = f.intent(o.id),
    bodyB = f.intent(o.id)
  const results = await Promise.all([post(path, bodyA, a), post(path, bodyB, b)])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  const successIndex = results.findIndex((r) => r.status === 200)
  assert.deepEqual(
    (await post(path, successIndex ? bodyB : bodyA, successIndex ? b : a)).body,
    results[successIndex].body
  )
  const winner = successIndex ? f.q : f.p,
    cookie = successIndex ? b : a
  const first = f.order(),
    second = f.order()
  f.s.mutate('admin', '/users', { ...winner, maxActiveOrders: 2 })
  const other = await Promise.all([
    post(`/player/orders/${first.id}/claim`, f.intent(first.id), cookie),
    post(`/player/orders/${second.id}/claim`, f.intent(second.id), cookie)
  ])
  assert.deepEqual(other.map((r) => r.status).sort(), [200, 409])
})
