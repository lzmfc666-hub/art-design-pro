import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { createStudioServer } from '../server/index.mjs'
import { merchantFixture, merchantPassword } from './helpers/merchant-fixture.mjs'

const TIER = 'special-small'
const stateOf = f => JSON.parse(f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
const current = (f, order) => f.service.orderDetail('admin', order.id).order
const forbidden = run => assert.throws(run, error => error.status === 403)
const blocked = (run, code) => assert.throws(run, error => error.status === 409 && error.code === code)
const intent = (f, order) => {
  const row = current(f, order)
  return {
    expectedRevision: row.revision, dispatchRound: row.dispatchRound,
    assignmentId: row.assignmentId, leaderId: row.leaderId, submissionId: row.submissionId
  }
}
const finances = f => {
  const state = stateOf(f)
  return {
    transactions: f.service.db.prepare('SELECT * FROM fund_transactions ORDER BY id').all(),
    refunds: state.refunds, credits: state.rewardCredits, adjustments: state.playerAdjustments,
    reviews: state.rewardReviews, reversals: state.statusCorrectionReversals,
    wallets: f.players.map(player => f.service.playerWallet(player.id))
  }
}
function owned(t, service) {
  const f = merchantFixture(t, service)
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.accounts[0].id })
  f.owner = f.accounts[0].id
  f.staff = f.accounts[1].id
  f.action = (order, action, body = {}, actor = f.staff) =>
    f.mutate(`/orders/${order.id}/action`, { action, reason: '生产兼容性验证', ...body }, actor)
  f.claim = (order, body = {}) => f.mutate(`/player/orders/${order.id}/claim`, body, f.players[0].id)
  f.submit = order => f.mutate(`/player/orders/${order.id}/submit`, {
    screenshots: [f.upload(f.players[0].id)]
  }, f.players[0].id)
  return f
}

test('merchant credit fulfills without fabricated cash and reviewed cancellation preserves production settlements', t => {
  const f = owned(t), order = f.order({}, f.staff)
  f.action(order, 'dispatch', { dispatchMode: 'direct', assignedTo: f.players[0].id })
  f.claim(order)
  f.submit(order)
  f.action(order, 'review-pass', {}, 'admin')
  const completed = current(f, order), funds = finances(f)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.receivedAmount, 0)
  assert.equal(completed.paidAt, null)
  assert.equal(f.service.playerWallet(f.players[0].id).earned, 6000)
  assert.equal(f.service.merchantOverview(f.owner).summary.outstandingAmount, 8000)
  forbidden(() => f.action(order, 'cancel'))
  forbidden(() => f.action(order, 'confirm-payment', { receivedAmount: 8000, paidAt: completed.completedAt }))
  forbidden(() => f.mutate('/refunds', { orderId: order.id, amount: 8000, reason: '商家不可走账' }, f.staff))
  assert.deepEqual(current(f, order), completed)
  assert.deepEqual(finances(f), funds)
})

test('merchant cancellation at every unreviewed stage retains permanent production reward closure and rejects old claim replay', t => {
  const f = owned(t)
  for (const phase of ['pending', 'active', 'review']) {
    const order = f.order({}, f.staff)
    const claimBody = { ...intent(f, order), requestId: randomUUID() }
    if (phase !== 'pending') f.claim(order, claimBody)
    if (phase === 'review') f.submit(order)
    const before = current(f, order), funds = finances(f)
    const body = { action: 'cancel', reason: '未验收整单终止', requestId: randomUUID() }
    const result = f.mutate(`/orders/${order.id}/action`, body, f.staff)
    assert.deepEqual(f.mutate(`/orders/${order.id}/action`, body, f.staff), result)
    const canceled = current(f, order)
    assert.equal(canceled.status, 'canceled')
    assert.equal(canceled.canceledFrom, phase)
    assert.equal(canceled.cancellationPolicyVersion, 1)
    assert.equal(canceled.reward, 6000)
    assert.equal(canceled.effectiveReward, 0)
    assert.equal(canceled.rewardDisposition.mode, 'zero-unsettled')
    assert.equal(canceled.rewardDisposition.trigger, 'cancel')
    assert.equal(canceled.compensationPending, false)
    assert.equal(canceled.compensationSettled, true)
    assert.ok(canceled.assignments.every(row => row.releasedAt))
    assert.deepEqual(canceled.submissions, before.submissions)
    assert.equal(canceled.countsTowardsCapacity, false)
    blocked(() => f.action(order, 'correct-status', { status: 'pending' }, 'admin'), 'ORDER_CANCELED')
    blocked(() => f.action(order, 'cancel-settle', { reward: 6000 }, 'admin'), 'ORDER_CANCELED')
    blocked(() => f.action(order, 'dispatch', { dispatchMode: 'pool' }), 'ORDER_CANCELED')
    assert.throws(() => f.claim(order, claimBody), error => [403, 409].includes(error.status))
    assert.deepEqual(finances(f), funds)
    assert.equal(current(f, order).rewardDisposition.mode, 'zero-unsettled')
  }
})

test('merchant credit exception never bypasses stored or durable legacy full-refund execution closures', t => {
  const f = owned(t), stored = f.order({}, f.staff)
  f.claim(stored)
  f.action(stored, 'store', {}, 'admin')
  blocked(() => f.submit(stored), 'ORDER_STORED')
  blocked(() => f.action(stored, 'release'), 'ORDER_STORED')
  f.action(stored, 'resume', {}, 'admin')
  f.submit(stored)
  assert.equal(current(f, stored).status, 'review')

  const refunded = f.order({}, f.staff)
  const oldClaim = { ...intent(f, refunded), requestId: randomUUID() }
  f.claim(refunded, oldClaim)
  const state = stateOf(f), legacy = state.orders.find(row => row.id === refunded.id)
  // A persisted closure remains binding even when historical amount corrections
  // mean the present paid-refund arithmetic alone no longer counts as full.
  legacy.receivedAmount = 9000
  legacy.paidAt = '2026-11-08T04:00:00.000Z'
  legacy.amount = 9000
  legacy.refundExecutionClosedAt = '2026-11-08T04:01:00.000Z'
  state.refunds.push({ id: randomUUID(), orderId: refunded.id, amount: 8000,
    status: 'paid', reason: '升级前已全退', requestedBy: 'admin', processedBy: 'admin',
    createdAt: legacy.paidAt, processedAt: legacy.refundExecutionClosedAt })
  f.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  const closed = current(f, refunded), funds = finances(f)
  assert.equal(closed.displayStatus, 'refunded')
  blocked(() => f.action(refunded, 'release'), 'ORDER_REFUNDED')
  blocked(() => f.submit(refunded), 'ORDER_REFUNDED')
  blocked(() => f.service.mutate(f.players[0].id, `/player/orders/${refunded.id}/claim`, oldClaim), 'ORDER_REFUNDED')
  blocked(() => f.action(refunded, 'correct-status', { status: 'review', leaderId: f.players[0].id }, 'admin'), 'ORDER_REFUNDED')
  assert.deepEqual(current(f, refunded), closed)
  assert.deepEqual(finances(f), funds)
})

test('merchant support cancellation invalidates an existing lottery code without deleting immutable draw history', t => {
  const f = owned(t)
  const template = f.mutate('/templates', { ...f.templates[0], playType: 'lottery', lotteryTier: TIER })
  f.mutate('/lottery/pools', { tier: TIER, revision: 0,
    prizes: Array.from({ length: 6 }, (_, index) => ({
      title: `保留奖项${index}`, image: f.upload(), probability: index === 0 ? '100' : '0'
    })) })
  const order = f.order({}, f.staff, template)
  f.claim(order)
  const code = f.service.lotteryOrderCode('admin', order.id)
  assert.equal(code.status, 'available')
  const drawn = f.service.drawLottery(TIER, code.code)
  const draw = f.service.db.prepare('SELECT * FROM lottery_draws').all()
  forbidden(() => f.service.lotteryOrderCode(f.accounts[2].id, order.id))
  f.action(order, 'cancel')
  const after = f.service.lotteryOrderCode('admin', order.id)
  assert.equal(after.status, 'void')
  assert.deepEqual(after.result, drawn.result)
  assert.equal(current(f, order).cancellationPolicyVersion, 1)
  assert.ok(current(f, order).lotteryVoidedAt)
  assert.throws(() => f.service.redeemLottery(TIER, code.code), error => error.code === 'LOTTERY_CODE_UNAVAILABLE')
  assert.throws(() => f.service.drawLottery(TIER, code.code), error => error.code === 'LOTTERY_CODE_UNAVAILABLE')
  assert.deepEqual(f.service.db.prepare('SELECT * FROM lottery_draws').all(), draw)
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM lottery_codes').get().n, 1)
  assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity='lottery-code' AND action='作废转盘兑换资格'").get().n, 1)
})

test('same-name support responsibility uses stable actor IDs after deletion and username reuse without cross-merchant audit access', t => {
  const f = owned(t), name = '轮班客服'
  f.mutate('/merchant/staff', { id: f.staff, name }, f.owner)
  const colleague = f.mutate('/merchant/staff', {
    username: 'same-name-colleague', name, password: merchantPassword
  }, f.owner)
  const order = f.order({}, f.staff)
  f.action(order, 'edit', { roomCode: 'COLLEAGUE-CHANGED' }, colleague.id)
  const historical = f.service.orderDetail('admin', order.id).logs
    .map(({ id, actorId, actorName, createdAt }) => ({ id, actorId, actorName, createdAt }))
  const before = f.service.orderDetail(f.owner, order.id)
  assert.ok(before.logs.some(row => row.actorId === f.staff && row.actorName === name))
  assert.ok(before.logs.some(row => row.actorId === colleague.id && row.actorName === name))
  f.mutate(`/merchant/staff/${f.staff}/delete`, {}, f.owner)
  const successor = f.mutate('/merchant/staff', {
    username: f.accounts[1].username.toUpperCase(), name, password: merchantPassword
  }, f.owner)
  assert.notEqual(successor.id, f.staff)
  const after = f.service.orderDetail(successor.id, order.id)
  assert.equal(after.order.creatorId, f.staff)
  assert.equal(after.order.roomCode, 'COLLEAGUE-CHANGED')
  assert.deepEqual(after.logs.map(({ id, actorId, actorName, createdAt }) =>
    ({ id, actorId, actorName, createdAt })), historical)
  assert.match(f.service.bootstrap(f.owner).users.find(row => row.id === f.staff).name, /已删除/)
  forbidden(() => f.service.orderDetail(f.accounts[2].id, order.id))
  forbidden(() => f.action(order, 'remark', { playerRemark: '其他商家不能跟进' }, f.accounts[2].id))
})

test('merchant image thumbnails retain production WebP and private authorization after cache warming and support deletion', async t => {
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password: merchantPassword,
    clock: () => new Date('2026-11-08T04:00:00Z'), maintenanceFromEnv: false,
    uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
    notifications: { publicKey: '', privateKey: '', subject: '' } })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const f = owned(t, server.service)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const cookieFor = async username => {
    const response = await fetch(base + '/api/studio/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'merchant' },
      body: JSON.stringify({ username, password: merchantPassword }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  const staffCookie = await cookieFor(f.accounts[1].username)
  const foreignCookie = await cookieFor(f.accounts[2].username)
  const ownerCookie = await cookieFor(f.accounts[0].username)
  const order = f.order({}, f.staff)
  f.claim(order)
  const data = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#227799' } }).png().toBuffer()
  const image = f.service.uploadBinary(f.players[0].id, { name: '交接凭证.png', mime: 'image/png', data })
  f.mutate(`/player/orders/${order.id}/submit`, { screenshots: [image] }, f.players[0].id)
  const url = new URL(f.service.orderDetail(f.staff, order.id).order.submissions[0].screenshots[0].url, base)
  url.searchParams.set('variant', 'thumb')
  const read = cookie => fetch(url, { headers: { Cookie: cookie } })
  const first = await read(staffCookie)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('content-type'), 'image/webp')
  assert.equal(first.headers.get('cache-control'), 'private, no-store')
  assert.ok((await first.arrayBuffer()).byteLength > 0)
  assert.ok(server.imageVariants.metrics().cached > 0)
  assert.equal((await read(foreignCookie)).status, 403)
  f.mutate(`/merchant/staff/${f.staff}/delete`, {}, f.owner)
  assert.equal((await read(staffCookie)).status, 401)
  const shared = await read(ownerCookie)
  assert.equal(shared.status, 200)
  assert.equal(shared.headers.get('content-type'), 'image/webp')
  await shared.arrayBuffer()
  assert.deepEqual(f.service.download('admin', image.id).data, data)
})
