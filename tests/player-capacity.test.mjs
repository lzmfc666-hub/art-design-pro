import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'
import { testMutate } from './helpers/current-intent.mjs'

const PASSWORD = 'isolated-player-capacity-v32-password'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const rejects = (callback, status = 400) =>
  assert.throws(callback, (error) => error instanceof ApiError && error.status === status)

function setup(service) {
  let current = new Date('2026-10-13T04:00:00Z')
  const mutate = (path, body = {}, userId = 'admin') => testMutate(service, userId, path, body)
  const level = mutate('/levels', { name: '分页验证', delaySeconds: 0 })
  const players = ['capacity-owner', 'capacity-teammate', 'capacity-other'].map((username) =>
    mutate('/users', {
      username, name: username, password: PASSWORD, role: 'player', status: 'active',
      levelId: level.id, maxActiveOrders: 30, permissionOverrides: {}
    })
  )
  const upload = (userId = 'admin') => service.upload(userId, { name: '隔离.png', mime: 'image/png', data: PNG })
  const receipt = upload()
  const customer = mutate('/customers', { name: 'CAPACITY-PRIVATE-CUSTOMER', contact: 'CAPACITY-PRIVATE-CONTACT', gameId: 'CAPACITY-PRIVATE-GAME' })
  const templates = new Map()
  const template = (name) => {
    if (!templates.has(name)) templates.set(name, mutate('/templates', {
      name, game: '游戏', description: '公开目标', map: '不限', amount: 2000, reward: 1001,
      active: true, remark: 'CAPACITY-PRIVATE-TEMPLATE'
    }))
    return templates.get(name)
  }
  const order = (name = '分页任务', extra = {}) => mutate('/orders', {
    templateId: template(name).id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun',
    externalOrderNo: `CAPACITY-PRIVATE-EXTERNAL-${randomUUID()}`, roomCode: 'CAPACITY-PRIVATE-ROOM',
    gameId: 'CAPACITY-PRIVATE-GAME', amount: 2000, reward: 1001, receivedAmount: 2000,
    paidAt: current.toISOString(), receipt, dispatchMode: 'pool', remark: 'CAPACITY-PRIVATE-REMARK',
    playerRemark: '明确公开说明', ...extra
  })
  const action = (row, action, extra = {}) => mutate(`/orders/${row.id}/action`, { action, ...extra })
  const claim = (row, player = players[0]) => mutate(`/player/orders/${row.id}/claim`, {}, player.id)
  const supplement = (amount = 10000, player = players[0]) => mutate('/player-adjustments', { userId: player.id, kind: 'supplement', amount, reason: '隔离测试补款' })
  const savePayment = (player = players[0]) => mutate('/player/payment-methods', { method: 'wechat', qrCode: upload(player.id) }, player.id)
  const withdraw = (amount = 100, player = players[0]) => mutate('/player/withdrawals', { amount, paymentMethod: 'wechat' }, player.id)
  return {
    service, mutate, players, upload, order, action, claim, supplement, savePayment, withdraw,
    get time() { return current },
    setTime(value) { current = new Date(value) }
  }
}

function fixture(t) {
  let f
  const service = createStudioService({ dbPath: ':memory:', seed: false, password: PASSWORD, clock: () => f?.time || new Date('2026-10-13T04:00:00Z') })
  t.after(() => service.close())
  f = setup(service)
  return f
}

test('本人参与历史含批准退单、拒绝、解除和旧队友，counts及总数先筛选再分页且不恢复私字段', (t) => {
  const f = fixture(t), [owner, teammate, other] = f.players
  const returned = f.order('历史-批准退单')
  f.claim(returned)
  const request = f.mutate(`/player/orders/${returned.id}/return-request`, { reason: '本人申请原因' }, owner.id).returnRequests[0]
  f.action(returned, 'return-approve', { returnRequestId: request.id, reason: '审批通过' })
  const rejected = f.order('历史-拒绝指定', { dispatchMode: 'direct', assignedTo: owner.id })
  f.mutate(`/player/orders/${rejected.id}/reject`, { reason: '本人拒绝原因' }, owner.id)
  f.action(rejected, 'dispatch', { dispatchMode: 'direct', assignedTo: other.id })
  const released = f.order('历史-后台解除')
  f.claim(released)
  f.action(released, 'release', { reason: 'CAPACITY-PRIVATE-RELEASE-NOTE' })
  f.action(released, 'dispatch', { dispatchMode: 'direct', assignedTo: other.id })
  const material = f.order('历史-曾参与材料')
  f.claim(material, teammate)
  f.mutate(`/player/orders/${material.id}/submit`, { screenshots: [f.upload(teammate.id)], teammateId: owner.id }, teammate.id)
  f.action(material, 'correct-status', { status: 'pending', reason: '重新核对', teammateId: null })
  f.action(material, 'dispatch', { dispatchMode: 'direct', assignedTo: other.id })
  const active = f.order('历史-当前进行')
  f.claim(active)
  f.order('历史-尚未接受', { dispatchMode: 'direct', assignedTo: owner.id })
  const first = f.service.playerOrdersPage(owner.id, { scope: 'mine', keyword: '历史-', current: 1, size: 2 })
  const second = f.service.playerOrdersPage(owner.id, { scope: 'mine', keyword: '历史-', current: 2, size: 2 })
  assert.equal(first.total, 5)
  assert.deepEqual(first.counts, second.counts)
  assert.equal(first.counts.all, 5)
  assert.equal(first.counts.pending, 4)
  assert.equal(first.counts.active, 1)
  assert.equal(new Set([...first.records, ...second.records].map((row) => row.id)).size, 4)
  const pending = f.service.playerOrdersPage(owner.id, { scope: 'mine', status: 'pending', size: 100 })
  assert.equal(pending.total, 4)
  assert.equal(pending.counts.all, 5)
  for (const row of pending.records) {
    assert.equal(row.participation, 'historical')
    assert.equal(row.historyOnly, true)
    assert.equal(row.canClaim, false)
    assert.equal(row.canSubmit, false)
    assert.ok(row.lastParticipationAt)
    assert.deepEqual(row.submissions, [])
    for (const key of ['roomCode', 'gameId', 'contact', 'customerId', 'receipt', 'remark', 'assignments']) assert.equal(Object.hasOwn(row, key), false)
    assert.equal(JSON.stringify(row).includes('CAPACITY-PRIVATE-'), false)
  }
  const rejection = pending.records.find((row) => row.id === rejected.id)
  assert.equal(rejection.rejections[0].reason, '本人拒绝原因')
  assert.equal(pending.records.find((row) => row.id === returned.id).returnRequests[0].status, 'approved')
  const current = f.service.playerOrderDetail(owner.id, active.id)
  assert.equal(current.participation, 'current')
  assert.equal(current.historyOnly, false)
})

test('参与排序只取本人事件，新轮次独立授权可接而旧历史没有操作资格', (t) => {
  const f = fixture(t), [owner, , other] = f.players
  const earlyCreated = f.order('先创建')
  f.setTime('2026-10-13T04:10:00Z')
  const laterCreated = f.order('后创建')
  f.claim(laterCreated)
  f.action(laterCreated, 'release', { reason: '解除' })
  f.setTime('2026-10-13T04:20:00Z')
  f.claim(earlyCreated)
  f.action(earlyCreated, 'release', { reason: '解除' })
  assert.equal(f.service.playerOrdersPage(owner.id, { scope: 'mine', sortBy: 'participatedAt' }).records[0].id, earlyCreated.id)
  assert.equal(f.service.playerOrdersPage(owner.id, { scope: 'mine', sortBy: 'participatedAt', sortOrder: 'asc' }).records[0].id, laterCreated.id)
  const newPool = f.service.playerOrderDetail(owner.id, earlyCreated.id)
  assert.equal(newPool.participation, 'historical')
  assert.equal(newPool.historyOnly, false)
  assert.equal(newPool.canClaim, true)
  assert.equal(Object.hasOwn(newPool, 'roomCode'), false)
  f.action(earlyCreated, 'dispatch', { dispatchMode: 'direct', assignedTo: other.id })
  const oldHistory = f.service.playerOrderDetail(owner.id, earlyCreated.id)
  assert.equal(oldHistory.historyOnly, true)
  assert.equal(oldHistory.canClaim, false)
  rejects(() => f.claim(earlyCreated), 403)
})

test('全局关键词仅标题及工作室编号，授权先于分页，counts是关键词筛选后的完整口径', (t) => {
  const f = fixture(t), [owner, , other] = f.players
  const rows = Array.from({ length: 5 }, (_, i) => f.order(`SAFE-Needle-${i}`))
  f.order('SAFE-Needle-不可见', { dispatchMode: 'direct', assignedTo: other.id })
  f.claim(rows[0])
  const page = f.service.playerOrdersPage(owner.id, { keyword: '  needle  ', size: 2, current: 2 })
  assert.equal(page.total, 5)
  assert.equal(page.records.length, 2)
  assert.equal(page.counts.all, 5)
  assert.equal(page.counts.active, 1)
  assert.equal(f.service.playerOrdersPage(owner.id, { keyword: 'needle', status: 'active', size: 1 }).total, 1)
  assert.equal(f.service.playerOrdersPage(owner.id, { keyword: rows[2].orderNo }).total, 1)
  for (const keyword of ['CAPACITY-PRIVATE-', rows[0].externalOrderNo, 'CAPACITY-PRIVATE-ROOM', 'CAPACITY-PRIVATE-CUSTOMER'])
    assert.equal(f.service.playerOrdersPage(owner.id, { keyword }).total, 0)
  rejects(() => f.service.playerOrdersPage(owner.id, { keyword: 'a'.repeat(101) }))
  rejects(() => f.service.playerOrdersPage(owner.id, { keyword: 1 }))
  rejects(() => f.service.playerOrdersPage(owner.id, { sortBy: 'remark' }))
  rejects(() => f.service.playerOrdersPage(owner.id, { dateKey: 'paidAt', start: '2026-10-13', end: '2026-10-13' }), 403)
  assert.equal(f.service.playerOrdersPage(owner.id, { dateKey: 'createdAt', start: '2026-10-13', end: '2026-10-13' }).total, 5)
  assert.equal(f.service.playerOrdersPage(owner.id, { dateKey: 'completedAt', start: '2026-10-13', end: '2026-10-13' }).total, 0)
  assert.equal(f.service.ordersPage('admin', { dateKey: 'paidAt', start: '2026-10-13', end: '2026-10-13' }).total, 6)
})

test('提现分页保留原金额和收款快照，状态及上海日期筛选、真实总数和本人隔离', (t) => {
  const f = fixture(t), [owner, , other] = f.players
  f.supplement(10000)
  f.supplement(10000, other)
  const original = f.savePayment()
  f.savePayment(other)
  f.setTime('2026-10-13T15:59:00Z')
  const a = f.withdraw(101)
  const b = f.withdraw(102)
  f.mutate(`/player/withdrawals/${b.id}/cancel`, {}, owner.id)
  f.setTime('2026-10-13T16:01:00Z')
  const c = f.withdraw(103)
  f.mutate(`/withdrawals/${c.id}/action`, { action: 'reject', reason: '财务驳回' })
  const d = f.withdraw(104)
  f.mutate(`/withdrawals/${d.id}/action`, { action: 'approve' })
  f.mutate(`/withdrawals/${d.id}/action`, { action: 'pay', receipt: f.upload() })
  f.withdraw(999, other)
  f.savePayment()
  const page = f.service.playerWithdrawalsPage(owner.id, { current: 1, size: 2, userId: other.id })
  assert.equal(page.total, 4)
  assert.equal(page.records.length, 2)
  assert.ok(page.records.every((row) => row.userId === owner.id))
  assert.ok(page.records.every((row) => row.paymentSnapshot.qrCode.id === original.qrCode.id))
  const firstDay = f.service.playerWithdrawalsPage(owner.id, { start: '2026-10-13', end: '2026-10-13' })
  assert.deepEqual(new Set(firstDay.records.map((row) => row.id)), new Set([a.id, b.id]))
  assert.equal(f.service.playerWithdrawalsPage(owner.id, { status: 'paid' }).records[0].amount, 104)
  assert.equal(f.service.playerWithdrawalsPage(owner.id, { status: 'pending' }).total, 1)
  assert.equal(f.service.playerWithdrawalsPage(owner.id, { current: 9, size: 2 }).total, 4)
  assert.deepEqual(f.service.playerWithdrawalsPage(owner.id, { current: 9, size: 2 }).records, [])
})

test('账本独立分页保留撤回释放和人工差额，钱包完整汇总不能由当前页计算', (t) => {
  const f = fixture(t), [owner, , other] = f.players
  f.supplement(10000)
  f.supplement(777, other)
  f.savePayment()
  const a = f.withdraw(100)
  f.mutate(`/player/withdrawals/${a.id}/cancel`, {}, owner.id)
  f.withdraw(200)
  f.mutate('/player-adjustments', { userId: owner.id, kind: 'deduction', amount: 12000, reason: '差额保留人工处理' })
  const legacy = f.service.playerWallet(owner.id)
  const summary = f.service.playerWallet(owner.id, { includeRecords: false })
  assert.deepEqual(summary, { ...legacy, withdrawals: [], ledger: [] })
  assert.equal(summary.occupied, 200)
  assert.equal(summary.available, 0)
  assert.equal(summary.weeklyUsed, 1)
  const page = f.service.playerLedgerPage(owner.id, { size: 2 })
  assert.equal(page.total, legacy.ledger.length)
  assert.equal(page.records.length, 2)
  assert.deepEqual(page.records, legacy.ledger.slice(0, 2))
  assert.notEqual(page.records.reduce((sum, row) => sum + row.delta, 0), summary.available)
  assert.equal(f.service.playerLedgerPage(owner.id, { kind: 'withdrawal-canceled' }).total, 1)
  const deduction = f.service.playerLedgerPage(owner.id, { kind: 'deduction' }).records[0]
  assert.equal(deduction.manualAmount, 2200)
  assert.equal(deduction.amount, 9800)
  assert.equal(f.service.playerLedgerPage(other.id, { size: 1, userId: owner.id }).records[0].amount, 777)
})

test('容量接口校验空结果的无效参数，关闭账号及后台账号不能读取本人接口', (t) => {
  const f = fixture(t), [owner] = f.players
  for (const read of [
    (query) => f.service.playerWithdrawalsPage(owner.id, query),
    (query) => f.service.playerLedgerPage(owner.id, query)
  ]) {
    for (const query of [{ current: 0 }, { current: -1 }, { size: 101 }, { start: '2026-02-30' }, { start: '2026-10-15', end: '2026-10-14' }]) rejects(() => read(query))
  }
  rejects(() => f.service.playerWithdrawalsPage(owner.id, { status: 'resolved' }))
  rejects(() => f.service.playerLedgerPage(owner.id, { kind: 'private' }))
  rejects(() => f.service.playerOrdersPage(owner.id, { dateKey: 'paidAt' }), 403)
  rejects(() => f.service.playerOrdersPage(owner.id, { keyword: '不存在的任务', dateKey: 'paidAt', start: '2026-10-13' }), 403)
  rejects(() => f.service.playerWithdrawalsPage('admin'), 403)
  rejects(() => f.service.playerLedgerPage('admin'), 403)
  f.mutate('/users', { ...owner, playerAccess: { login: false, claim: true, withdraw: true } })
  rejects(() => f.service.playerWithdrawalsPage(owner.id), 403)
  rejects(() => f.service.playerLedgerPage(owner.id), 403)
})

test('旧材料的他人图片关联权限随当前参与权限消失，不因历史查询重新授予', (t) => {
  const f = fixture(t), [owner, teammate, other] = f.players
  const row = f.order('材料历史安全')
  f.claim(row, teammate)
  const image = f.upload(teammate.id)
  f.mutate(`/player/orders/${row.id}/submit`, { screenshots: [image], teammateId: owner.id }, teammate.id)
  assert.ok(f.service.download(owner.id, image.id).data.length)
  f.action(row, 'correct-status', { status: 'pending', reason: '复核调整', teammateId: null })
  f.action(row, 'dispatch', { dispatchMode: 'direct', assignedTo: other.id })
  const history = f.service.playerOrdersPage(owner.id, { scope: 'mine' })
  assert.equal(history.total, 1)
  assert.equal(history.records[0].historyOnly, true)
  assert.deepEqual(history.records[0].submissions, [])
  rejects(() => f.service.download(owner.id, image.id), 403)
  assert.ok(f.service.download(teammate.id, image.id).data.length)
})

test('回到公共池仅授予接单前摘要，原成功POST不能恢复私有快照，GET仍可确认原操作', (t) => {
  const f = fixture(t), [owner] = f.players
  const row = f.order('公开池原结果隔离')
  const body = { requestId: randomUUID(), expectedRevision: row.revision, dispatchRound: row.dispatchRound }
  const path = `/player/orders/${row.id}/claim`
  const accepted = f.service.mutate(owner.id, path, body)
  assert.equal(accepted.roomCode, 'CAPACITY-PRIVATE-ROOM')
  f.action(row, 'release', { reason: '重新开放公共池' })
  const available = f.service.playerOrderDetail(owner.id, row.id)
  assert.equal(available.canClaim, true)
  assert.equal(available.historyOnly, false)
  assert.equal(Object.hasOwn(available, 'roomCode'), false)
  rejects(() => f.service.mutate(owner.id, path, body), 403)
  const confirmation = f.service.playerOperationResult(owner.id, body.requestId, 'claim')
  assert.equal(confirmation.status, 'succeeded')
  assert.equal(confirmation.result, 'confirmation-only')
  assert.equal(confirmation.order, undefined)
  const next = f.claim(row)
  assert.equal(next.leaderId, owner.id)
  assert.ok(next.dispatchRound > body.dispatchRound)

  for (const family of ['submit', 'return']) {
    const target = f.order(`公共池-${family}原结果`)
    const assignment = f.claim(target)
    const endpoint = `/player/orders/${target.id}/${family === 'return' ? 'return-request' : family}`
    const intent = {
      requestId: randomUUID(), expectedRevision: assignment.revision,
      assignmentId: assignment.assignmentId, leaderId: owner.id,
      ...(family === 'submit' ? { screenshots: [f.upload(owner.id)] } : { reason: '本人退单' })
    }
    const result = f.service.mutate(owner.id, endpoint, intent)
    if (family === 'submit') f.action(target, 'correct-status', { status: 'pending', reason: '重新核对' })
    else {
      f.action(target, 'return-approve', { returnRequestId: result.returnRequests.at(-1).id, reason: '允许退单' })
      f.action(target, 'dispatch', { dispatchMode: 'pool' })
    }
    assert.equal(f.service.playerOrderDetail(owner.id, target.id).canClaim, true)
    rejects(() => f.service.mutate(owner.id, endpoint, intent), 403)
    assert.equal(f.service.playerOperationResult(owner.id, intent.requestId, family).status, 'succeeded')
  }
})

test('新增读取通过隔离HTTP路径返回分页和钱包摘要，不能以userId查询他人资金', async (t) => {
  let f
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password: PASSWORD, clock: () => f?.time || new Date('2026-10-13T04:00:00Z') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  f = setup(server.service)
  const [owner, , other] = f.players
  f.supplement(10000)
  f.supplement(999, other)
  f.savePayment()
  f.withdraw(100)
  f.order('HTTP-Safe-Search')
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: owner.username, password: PASSWORD }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const read = async (path, status = 200) => {
    const response = await fetch(base + path, { headers: { Cookie: cookie } })
    const body = await response.json()
    assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`)
    return body
  }
  assert.equal((await read('/player/orders?keyword=safe')).total, 1)
  assert.equal((await read(`/player/withdrawals?current=1&size=1&userId=${other.id}`)).total, 1)
  assert.equal((await read('/player/wallet/ledger?current=1&size=1&kind=supplement')).records[0].amount, 10000)
  const summary = await read('/player/wallet?includeRecords=false')
  assert.equal(summary.earned, 10000)
  assert.equal(summary.available, 9900)
  assert.deepEqual(summary.withdrawals, [])
  assert.deepEqual(summary.ledger, [])
  assert.equal((await read('/player/wallet')).withdrawals.length, 1)
  await read('/player/withdrawals?size=101', 400)
  await read('/player/wallet/ledger?kind=private', 400)
  await read(`/player/orders?keyword=${'x'.repeat(101)}`, 400)
  await read('/player/orders?dateKey=paidAt&start=2026-10-13&end=2026-10-13', 403)
})
