import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createStudioServer } from '../server/index.mjs'
import { createLifecycleContext, orderLifecycle } from '../server/order-lifecycle.mjs'

// These regressions intentionally use unadapted HTTP: no current-intent helper
// or patched fetch can add missing revisions, actor headers or request IDs.
const password = 'isolated-raw-http-production-fixes-20261018'
const clock = () => new Date('2026-10-18T04:00:00Z')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

async function fixture(t) {
  const server = createStudioServer({ dbPath: ':memory:', password, seed: false, clock,
    maintenanceFromEnv: false, uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
    notifications: { publicKey: '', privateKey: '', subject: '' } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  assert.equal(server.service.db.prepare('PRAGMA database_list').get().file, '')
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  assert.ok(![3006, 3007, 3008, 3011].includes(server.address().port))
  async function login(username, player = false) {
    const response = await fetch(base + '/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(player ? { 'X-Studio-Client': 'player' } : {}) },
      body: JSON.stringify({ username, password }) })
    const data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data))
    return { user: data.user, cookie: response.headers.get('set-cookie').split(';')[0], player }
  }
  const admin = await login('admin')
  async function call(path, { actor = admin, body, headers = {} } = {}) {
    const started = performance.now()
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: actor.cookie, ...(actor.player ? { 'X-Studio-Client': 'player' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Studio-Actor': actor.user.id }),
        ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json()
    return { status: response.status, data, elapsedMs: performance.now() - started }
  }
  async function ok(path, options) {
    const response = await call(path, options)
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.data)}`)
    return response.data
  }
  const level = await ok('/levels', { body: { name: 'HTTP立即开放', delaySeconds: 0 } })
  const users = []
  for (const name of ['http-leader', 'http-outsider']) users.push(await ok('/users', {
    body: { username: name, name, role: 'player', status: 'active', levelId: level.id,
      maxActiveOrders: 1, permissionOverrides: {}, password }
  }))
  const player = await login(users[0].username, true), outsider = await login(users[1].username, true)
  const customer = await ok('/customers', { body: { name: 'HTTP隔离客户', contact: 'PRIVATE', gameId: 'PRIVATE', remark: '' } })
  const template = await ok('/templates', { body: { name: 'HTTP隔离服务', game: '隔离游戏', description: '要求',
    map: '不限', amount: 2000, reward: 1000, active: true, remark: '' } })
  const order = () => ok('/orders', { body: { requestId: randomUUID(), customerId: customer.id, templateId: template.id,
    platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'PRIVATE-ROOM',
    receivedAmount: 2000, paidAt: clock().toISOString(), dispatchMode: 'pool' } })
  const current = async row => (await ok(`/orders/${row.id}`)).order
  const intent = row => ({ requestId: randomUUID(), expectedRevision: row.revision,
    dispatchRound: row.dispatchRound, assignmentId: row.assignmentId, leaderId: row.leaderId, submissionId: row.submissionId })
  const action = async (row, type, fields = {}) => ok(`/orders/${row.id}/action`, {
    body: { ...intent(await current(row)), action: type, reason: 'HTTP隔离业务原因', ...fields } })
  const claim = async row => ok(`/player/orders/${row.id}/claim`, { actor: player, body: intent(await current(row)) })
  const refund = async row => ok('/refunds', { body: { ...intent(await current(row)), orderId: row.id, amount: 2000, reason: '实际全额退款' } })
  const upload = () => ok('/uploads', { actor: player, body: { name: 'HTTP原始凭证.png', mime: 'image/png', data: png } })
  const submit = async row => ok(`/player/orders/${row.id}/submit`, { actor: player,
    body: { ...intent(await current(row)), screenshots: [await upload()], teammateId: null } })
  const activeCount = async () => (await ok('/player/changes', { actor: player })).activeOrders
  const snapshot = () => JSON.parse(server.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  return { server, base, admin, player, outsider, call, ok, order, current, intent, action, claim, refund, submit, activeCount, snapshot }
}

test('真实HTTP问题反馈可通过打手通道且校验会话、当前负责人、版本及幂等', async t => {
  const f = await fixture(t), order = await f.order()
  await f.claim(order)
  const opened = await f.action(order, 'problem-open', { reason: 'HTTP实际问题原因' })
  const path = `/player/orders/${order.id}/problem-feedback`
  const body = { ...f.intent(opened), problemId: opened.problem.id, message: '打手已联系处理' }
  const forged = await f.call(path, { actor: f.player, body, headers: { 'X-Studio-Actor': f.outsider.user.id } })
  assert.equal(forged.status, 409)
  const unauthorized = await f.call(path, { actor: f.outsider, body: { ...body, requestId: randomUUID() } })
  assert.equal(unauthorized.status, 403)
  const success = await f.call(path, { actor: f.player, body })
  assert.equal(success.status, 200, JSON.stringify(success.data))
  assert.equal(success.data.problem.feedback.length, 1)
  assert.equal((await f.call(path, { actor: f.player, body })).status, 200)
  assert.equal((await f.current(order)).problem.feedback.length, 1)
  const stale = await f.call(path, { actor: f.player, body: { ...body, requestId: randomUUID(), message: '旧页面再次反馈' } })
  assert.equal(stale.status, 409)
  const notices = await f.ok('/player/notifications', { actor: f.player })
  assert.ok(notices.records.some(row => row.type === 'problem-open' && row.target.problemId === opened.problem.id))
  await f.action(order, 'problem-close', { problemId: opened.problem.id, reason: '后台确认处理完成' })
  const closed = await f.call(path, { actor: f.player,
    body: { ...f.intent(await f.current(order)), problemId: opened.problem.id, message: '已关闭不能继续反馈' } })
  assert.equal(closed.status, 409)
  assert.equal(closed.data.code, 'PROBLEM_CHANGED')
  assert.equal(await f.activeCount(), 1)
})

test('真实HTTP全额退款显示已退款、移出大厅，旧意图和当前意图均不能再接单', async t => {
  const f = await fixture(t), order = await f.order(), stale = f.intent(order)
  assert.ok((await f.ok('/player/orders?status=pending&size=20', { actor: f.player })).records.some(row => row.id === order.id))
  assert.equal((await f.refund(order)).status, 'paid')
  const refunded = await f.current(order)
  assert.equal(refunded.displayStatus, 'refunded')
  assert.equal(refunded.receivedAmount, 2000)
  assert.equal(refunded.paidAt, order.paidAt)
  assert.equal((await f.ok('/player/orders?status=pending&size=20', { actor: f.player })).records.some(row => row.id === order.id), false)
  assert.equal((await f.call(`/player/orders/${order.id}/claim`, { actor: f.player, body: stale })).status, 409)
  const blocked = await f.call(`/player/orders/${order.id}/claim`, { actor: f.player, body: f.intent(refunded) })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.data.code, 'ORDER_REFUNDED')
  assert.equal(await f.activeCount(), 0)
  assert.equal((await f.ok('/orders?status=refunded&size=20')).total, 1)
  assert.equal(f.snapshot().orders[0].assignments.length, 0)
})

test('真实HTTP并发退款与抢单只有一个旧版本写入成功，退款最终阻止履约且不重复扣退', async t => {
  const f = await fixture(t), order = await f.order(), before = await f.current(order)
  const refundBody = { ...f.intent(before), orderId: order.id, amount: 2000, reason: '与抢单同时全退' }
  const claimBody = f.intent(before)
  const [refund, claim] = await Promise.all([
    f.call('/refunds', { body: refundBody }),
    f.call(`/player/orders/${order.id}/claim`, { actor: f.player, body: claimBody })
  ])
  assert.deepEqual([refund.status, claim.status].sort(), [200, 409])
  if (refund.status !== 200) await f.refund(order)
  const after = await f.current(order)
  assert.equal(after.displayStatus, 'refunded')
  assert.equal(after.countsTowardsCapacity, false)
  assert.equal(await f.activeCount(), 0)
  assert.ok(after.assignments.length <= 1)
  assert.equal(f.snapshot().refunds.filter(row => row.orderId === order.id && row.status === 'paid').length, 1)
  assert.equal(f.snapshot().refunds.filter(row => row.orderId === order.id).reduce((sum, row) => sum + row.amount, 0), 2000)
  if (claim.status === 200) {
    const blocked = await f.call(`/player/orders/${order.id}/submit`, { actor: f.player,
      body: { ...f.intent(after), screenshots: [], teammateId: null } })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.data.code, 'ORDER_REFUNDED')
  }
})

test('真实HTTP并发全退与验收只接受一个相同版本操作，无法重复验收或生成第二份报酬', async t => {
  const f = await fixture(t), order = await f.order()
  await f.claim(order); await f.submit(order)
  const before = await f.current(order)
  const [refund, review] = await Promise.all([
    f.call('/refunds', { body: { ...f.intent(before), orderId: order.id, amount: 2000, reason: '与验收同时退款' } }),
    f.call(`/orders/${order.id}/action`, { body: { ...f.intent(before), action: 'review-pass' } })
  ])
  assert.deepEqual([refund.status, review.status].sort(), [200, 409])
  if (refund.status !== 200) await f.refund(order)
  const after = await f.current(order)
  assert.equal(after.displayStatus, 'refunded')
  assert.equal(after.submissions.length, 1)
  if (review.status === 200) {
    assert.equal(after.status, 'completed')
    assert.equal(after.submissions[0].review, 'passed')
    assert.ok(after.completedAt)
  } else {
    assert.equal(after.status, 'review')
    assert.equal(after.submissions[0].review, undefined)
  }
  const retry = await f.call(`/orders/${order.id}/action`, { body: { ...f.intent(after), action: 'review-pass' } })
  assert.equal(retry.status, 409)
  assert.equal(retry.data.code, 'ORDER_REFUNDED')
  assert.equal(f.snapshot().refunds.filter(row => row.orderId === order.id && row.status === 'paid').length, 1)
  assert.ok(f.snapshot().rewardCredits.filter(row => row.orderId === order.id && row.userId === f.player.user.id).length <= 1)
  assert.equal(await f.activeCount(), 0)
})

test('真实HTTP双并发存单与恢复各只有一次成功，原打手满额恢复仍免名额且旧上报失败', async t => {
  const f = await fixture(t), stored = await f.order()
  await f.claim(stored)
  const before = await f.current(stored), oldSubmit = f.intent(before)
  const storeResponses = await Promise.all([1, 2].map(() => f.call(`/orders/${stored.id}/action`, {
    body: { ...f.intent(before), action: 'store', reason: '客户暂时不继续' }
  })))
  assert.deepEqual(storeResponses.map(row => row.status).sort(), [200, 409])
  assert.equal(await f.activeCount(), 0)
  const normal = await f.order(); await f.claim(normal)
  assert.equal(await f.activeCount(), 1)
  const held = await f.current(stored)
  const resumeResponses = await Promise.all([1, 2].map(() => f.call(`/orders/${stored.id}/action`, {
    body: { ...f.intent(held), action: 'resume', reason: '客户恢复服务', mode: 'original' }
  })))
  assert.deepEqual(resumeResponses.map(row => row.status).sort(), [200, 409])
  const restored = await f.current(stored)
  assert.equal(restored.capacityExempt, true)
  assert.equal(restored.countsTowardsCapacity, false)
  assert.equal(restored.leaderId, f.player.user.id)
  assert.equal(await f.activeCount(), 1)
  const stale = await f.call(`/player/orders/${stored.id}/submit`, { actor: f.player,
    body: { ...oldSubmit, screenshots: [], teammateId: null } })
  assert.equal(stale.status, 409)
  const excess = await f.order()
  const capped = await f.call(`/player/orders/${excess.id}/claim`, { actor: f.player, body: f.intent(excess) })
  assert.equal(capped.status, 409)
  assert.equal(capped.data.code, 'CLAIM_CAPACITY_REACHED')
  assert.equal((await f.ok('/player/orders?scope=mine&status=active&size=20', { actor: f.player })).total, 2)
})

test('1000单及退款隔离快照的HTTP分页、计数与退款上下文一致，记录实测耗时', async t => {
  const f = await fixture(t), original = await f.order(), state = f.snapshot()
  state.orders = Array.from({ length: 1000 }, (_, index) => ({ ...structuredClone(original),
    id: `http-bench-order-${index}`, orderNo: `HTTP-BENCH-${index}`, externalOrderNo: `HTTP-BENCH-${index}` }))
  state.refunds = state.orders.map((order, index) => ({ id: `http-bench-refund-${index}`, orderId: order.id,
    amount: index % 4 === 2 ? 500 : 2000, status: index % 4 === 1 ? 'pending' : index % 4 === 3 ? 'rejected' : 'paid',
    reason: '仅隔离性能快照', requestedBy: 'admin', createdAt: clock().toISOString() }))
  f.server.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  const source = f.server.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  const started = performance.now(), context = createLifecycleContext(state)
  const indexed = state.orders.map(row => orderLifecycle(state, row, context).displayStatus)
  const indexedMs = performance.now() - started
  const scannedAt = performance.now(), scanned = state.orders.map(row => orderLifecycle(state, row).displayStatus)
  const scannedMs = performance.now() - scannedAt
  assert.deepEqual(indexed, scanned)
  assert.equal(indexed.filter(value => value === 'refunded').length, 250)
  assert.equal(indexed.filter(value => value === 'refund-pending').length, 250)
  const readings = []
  for (let run = 0; run < 5; run++) {
    for (const [name, path, actor, expectedTotal] of [
      ['admin-orders', '/orders?current=1&size=50', f.admin, 1000],
      ['player-lobby', '/player/orders?status=pending&current=1&size=50', f.player, 500]
    ]) {
      const result = await f.call(path, { actor })
      assert.equal(result.status, 200, JSON.stringify(result.data))
      assert.equal(result.data.total, expectedTotal)
      assert.equal(result.data.records.length, 50)
      readings.push({ name, run, elapsedMs: Number(result.elapsedMs.toFixed(3)), total: result.data.total })
    }
  }
  assert.equal((await f.ok('/orders?status=refunded&size=50')).total, 250)
  assert.equal((await f.ok('/orders?status=refund-pending&size=50')).total, 250)
  assert.equal(f.server.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json, source)
  const report = { format: 'studio-production-fixes-http-perf-v1', generatedAt: new Date().toISOString(),
    scope: 'isolated in-memory SQLite; loopback random port; not production capacity evidence',
    orders: 1000, refunds: 1000, context: { indexedMs: Number(indexedMs.toFixed(3)), scannedMs: Number(scannedMs.toFixed(3)), equal: true }, readings }
  const directory = resolve('.qa/production-fixes-20261018')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'http-perf-report.json'), JSON.stringify(report, null, 2) + '\n')
})
