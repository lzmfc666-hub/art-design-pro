import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ApiError, createStudioService } from '../server/studio.mjs'
import { testMutate } from './helpers/current-intent.mjs'

const TIER = 'special-small'
const START = '2026-10-26T08:00:00.000Z'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const rejected = (run, code) => assert.throws(run, error =>
  error instanceof ApiError && error.status >= 400 && (!code || error.code === code))
const unavailable = run => rejected(run, 'LOTTERY_CODE_UNAVAILABLE')

function fixture(t) {
  let time = new Date(START), failRefund = false
  const service = createStudioService({
    dbPath: ':memory:', seed: false, password: 'isolated-unified-lottery-password',
    clock: () => time,
    onTransaction({ state, beforeState }) {
      if (failRefund && state.refunds.length > beforeState.refunds.length)
        throw new Error('isolated refund commit failure')
    }
  })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const state = () => JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const current = order => service.orderDetail('admin', order.id).order
  const level = mutate('/levels', { name: '转盘即时接单', delaySeconds: 0 })
  const createUser = (name, role) => mutate('/users', {
    username: `unified-lottery-${randomUUID()}`, name, role, status: 'active', levelId: level.id,
    maxActiveOrders: 1, permissionOverrides: {}, password: 'isolated-unified-lottery-password'
  })
  const players = [createUser('一号打手', 'player'), createUser('二号打手', 'player')]
  const support = createUser('客服', 'support')
  const customer = mutate('/customers', { name: '隔离客户', contact: 'isolated', gameId: 'isolated' })
  const platform = mutate('/platforms', {
    name: '隔离转盘来源', rules: {
      requiresShop: false, requiresExternalOrderNo: false, requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const template = mutate('/templates', {
    name: '隔离转盘', game: '游戏', amount: 10000, reward: 7000,
    playType: 'lottery', lotteryTier: TIER, active: true
  })
  const upload = (actor = 'admin') => service.upload(actor, { name: 'isolated.png', mime: 'image/png', data: PNG })
  mutate('/lottery/pools', {
    tier: TIER, revision: 0,
    prizes: Array.from({ length: 6 }, (_, index) => ({
      title: `隔离奖项${index + 1}`, image: upload(), probability: index === 0 ? '100' : '0'
    }))
  })
  const order = () => mutate('/orders', {
    templateId: template.id, customerId: customer.id, platformId: platform.id,
    roomCode: 'isolated-room', amount: 10000, reward: 7000, receivedAmount: 10000,
    paidAt: START, dispatchMode: 'pool', playerRemark: '原人工备注'
  }, support.id)
  const action = (order, action, extra = {}) => mutate(`/orders/${order.id}/action`, {
    action, reason: '隔离操作原因', ...extra
  })
  const claim = (order, player = players[0]) => mutate(`/player/orders/${order.id}/claim`, {}, player.id)
  const submit = (order, player = players[0]) => mutate(`/player/orders/${order.id}/submit`, {
    screenshots: [upload(player.id)]
  }, player.id)
  const refund = (order, amount = 10000, actor = 'admin', extra = {}) => mutate('/refunds', {
    orderId: order.id, amount, reason: '隔离退款', destination: 'cash', channel: 'wechat',
    actualRefundConfirmed: true, ...extra
  }, actor)
  const code = order => service.lotteryOrderCode(support.id, order.id)
  const draw = token => service.drawLottery(TIER, token)
  const read = token => service.redeemLottery(TIER, token)
  const counts = () => ({
    codes: service.db.prepare('SELECT count(*) AS n FROM lottery_codes').get().n,
    draws: service.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n
  })
  return {
    service, mutate, state, current, players, support, order, action, claim, submit,
    refund, code, draw, read, counts,
    setTime(value) { time = new Date(value) },
    failRefund(value) { failRefund = value }
  }
}

test('转盘统一取消退款只提交一次，基础报酬持久归零且不增加旧补偿步骤', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const token = f.code(order).code
  const body = {
    action: 'cancel-refund', reason: '老板取消', refundAmount: 10000,
    refundDestination: 'cash', refundChannel: 'wechat', actualRefundConfirmed: true,
    requestId: randomUUID()
  }
  const result = f.mutate(`/orders/${order.id}/action`, body)
  assert.deepEqual(f.mutate(`/orders/${order.id}/action`, body), result)
  const after = f.current(order)
  assert.equal(after.status, 'canceled')
  assert.equal(after.displayStatus, 'refunded')
  assert.equal(after.reward, 7000)
  assert.equal(after.effectiveReward, 0)
  assert.equal(after.rewardDisposition.mode, 'zero-unsettled')
  assert.equal(after.cancellationPolicyVersion, 1)
  assert.equal(after.compensationPending, false)
  assert.equal(after.countsTowardsCapacity, false)
  assert.equal(f.state().refunds.length, 1)
  assert.equal(f.state().rewardCredits.length, 0)
  assert.equal(f.code(order).status, 'void')
  unavailable(() => f.read(token))
  unavailable(() => f.draw(token))
  assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity='lottery-code' AND action='作废转盘兑换资格'").get().n, 1)
  rejected(() => f.action(order, 'correct-status', { status: 'pending' }), 'ORDER_CANCELED')
})

test('接单前仅取消不发码、不退款，状态更正取消沿相同规则永久结束', t => {
  const f = fixture(t), order = f.order()
  f.action(order, 'correct-status', { status: 'canceled' })
  assert.equal(f.current(order).effectiveReward, 0)
  assert.equal(f.current(order).cancellationPolicyVersion, 1)
  assert.equal(f.code(order).status, 'void')
  assert.equal(f.code(order).code, null)
  assert.deepEqual(f.counts(), { codes: 0, draws: 0 })
  assert.equal(f.state().refunds.length, 0)
  rejected(() => f.claim(order))
})

test('实际部分退款作废已中奖码但保持原履约与原报酬，重试不重复退款', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const token = f.code(order).code, drawn = f.draw(token)
  const requestId = randomUUID(), first = f.refund(order, 1, 'admin', { requestId })
  assert.deepEqual(f.refund(order, 1, 'admin', { requestId }), first)
  const after = f.current(order)
  assert.equal(after.status, 'active')
  assert.equal(after.effectiveReward, 7000)
  assert.equal(after.rewardDisposition, undefined)
  assert.equal(after.countsTowardsCapacity, true)
  assert.equal(f.code(order).status, 'void')
  assert.deepEqual(f.code(order).result, drawn.result)
  assert.equal(f.state().refunds.length, 1)
  unavailable(() => f.draw(token))
  f.submit(order)
  f.action(order, 'review-pass')
  assert.equal(f.service.playerWallet(f.players[0].id).earned, 7000)
})

test('未结算转盘全退自动取消退出日常列表，不改写原报价或开启补偿', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const token = f.code(order).code
  f.refund(order)
  const after = f.current(order)
  assert.equal(after.status, 'canceled')
  assert.equal(after.displayStatus, 'refunded')
  assert.equal(after.cancellationPolicyVersion, 1)
  assert.equal(after.canceledFrom, 'active')
  assert.ok(after.assignments.every(row => row.releasedAt))
  assert.equal(after.reward, 7000)
  assert.equal(after.effectiveReward, 0)
  assert.equal(after.rewardDisposition.trigger, 'full-refund')
  assert.equal(after.countsTowardsCapacity, false)
  assert.notEqual(after.compensationPending, true)
  assert.equal(after.paidAt, START)
  assert.equal(after.receivedAmount, 10000)
  assert.equal(f.code(order).status, 'void')
  unavailable(() => f.draw(token))
  rejected(() => f.submit(order), 'ORDER_REFUNDED')
  assert.equal(f.service.ordersPage('admin', {}).records.some(row => row.id === order.id), false)
  rejected(() => f.action(order, 'correct-status', { status: 'pending' }), 'ORDER_CANCELED')
  f.claim(f.order())
})

test('全退待审批只暂停打手履约，原客户码不永久作废，驳回后不重发或延时', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const original = f.code(order)
  const pending = f.refund(order, 10000, f.support.id)
  assert.equal(pending.status, 'pending')
  assert.equal(f.current(order).displayStatus, 'refund-pending')
  assert.equal(f.current(order).effectiveReward, 7000)
  assert.equal(f.current(order).countsTowardsCapacity, true)
  rejected(() => f.submit(order), 'REFUND_PENDING')
  assert.equal(f.code(order).status, 'available')
  const drawn = f.draw(original.code)
  f.mutate(`/refunds/${pending.id}/action`, { action: 'reject', reason: '继续服务' })
  assert.equal(f.current(order).displayStatus, 'active')
  assert.equal(f.code(order).code, original.code)
  assert.equal(f.code(order).expiresAt, original.expiresAt)
  assert.deepEqual(f.draw(original.code), drawn)
  assert.deepEqual(f.counts(), { codes: 1, draws: 1 })
})

test('审批实际全退时才作废码并零元决定，审批重试不改变付款和历史结果', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const original = f.code(order), drawn = f.draw(original.code)
  const pending = f.refund(order, 10000, f.support.id)
  const body = { action: 'approve', actualRefundConfirmed: true, requestId: randomUUID() }
  const approved = f.mutate(`/refunds/${pending.id}/action`, body)
  assert.deepEqual(f.mutate(`/refunds/${pending.id}/action`, body), approved)
  assert.equal(f.current(order).displayStatus, 'refunded')
  assert.equal(f.current(order).status, 'canceled')
  assert.equal(f.current(order).cancellationPolicyVersion, 1)
  assert.equal(f.current(order).effectiveReward, 0)
  assert.equal(f.current(order).paidAt, START)
  assert.equal(f.code(order).status, 'void')
  assert.deepEqual(f.code(order).result, drawn.result)
  unavailable(() => f.read(original.code))
  rejected(() => f.submit(order), 'ORDER_REFUNDED')
  assert.deepEqual(f.counts(), { codes: 1, draws: 1 })
  assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity='lottery-code' AND action='作废转盘兑换资格'").get().n, 1)
})

test('存单及原人恢复和放回大厅换人均保留一码一期一结果，打手暂停规则有效', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const original = f.code(order)
  f.action(order, 'store')
  assert.equal(f.current(order).countsTowardsCapacity, false)
  rejected(() => f.submit(order), 'ORDER_STORED')
  const drawn = f.draw(original.code)
  f.action(order, 'resume')
  assert.equal(f.current(order).capacityExempt, true)
  assert.equal(f.current(order).leaderId, f.players[0].id)
  f.action(order, 'store')
  f.action(order, 'resume', { mode: 'pool' })
  f.claim(order, f.players[1])
  assert.equal(f.current(order).countsTowardsCapacity, true)
  assert.equal(f.current(order).leaderId, f.players[1].id)
  assert.equal(f.code(order).code, original.code)
  assert.equal(f.code(order).expiresAt, original.expiresAt)
  assert.deepEqual(f.draw(original.code), drawn)
  assert.equal(f.service.playerOrderDetail(f.players[1].id, order.id).playerRemark,
    '原人工备注\n【转盘中奖·特惠小转盘】隔离奖项1')
  assert.deepEqual(f.counts(), { codes: 1, draws: 1 })
  f.setTime(original.expiresAt)
  unavailable(() => f.read(original.code))
})

test('问题单仍由客服处理，客户开奖结果保护备注不被编辑擦除且关闭不重发码', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const original = f.code(order)
  const problem = f.action(order, 'problem-open').problem
  rejected(() => f.submit(order), 'ORDER_PROBLEM')
  const drawn = f.draw(original.code)
  f.action(order, 'remark', { playerRemark: '客服更新备注', lotteryNote: '伪造奖项' })
  assert.equal(f.service.playerOrderDetail(f.players[0].id, order.id).playerRemark,
    '客服更新备注\n【转盘中奖·特惠小转盘】隔离奖项1')
  f.action(order, 'problem-close', { problemId: problem.id })
  assert.equal(f.code(order).code, original.code)
  assert.equal(f.code(order).expiresAt, original.expiresAt)
  assert.deepEqual(f.draw(original.code), drawn)
  f.submit(order)
  assert.equal(f.current(order).status, 'review')
})

test('完成后全退保留完成验收与已结算打手收入，码仅永久作废不抹中奖历史', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const original = f.code(order), drawn = f.draw(original.code)
  f.submit(order)
  f.action(order, 'review-pass')
  const completed = f.current(order)
  const credits = f.state().rewardCredits.filter(row => row.orderId === order.id)
  const wallet = f.service.playerWallet(f.players[0].id)
  assert.equal(wallet.earned, 7000)
  f.refund(order)
  const after = f.current(order)
  assert.equal(after.status, 'completed')
  assert.equal(after.completedAt, completed.completedAt)
  assert.deepEqual(after.submissions, completed.submissions)
  assert.equal(after.paidAt, START)
  assert.equal(after.receivedAmount, 10000)
  assert.equal(after.displayStatus, 'refunded')
  assert.equal(after.effectiveReward, 7000)
  assert.equal(after.rewardDisposition.mode, 'preserve-settled')
  assert.deepEqual(f.state().rewardCredits.filter(row => row.orderId === order.id), credits)
  assert.deepEqual(f.service.playerWallet(f.players[0].id), wallet)
  assert.equal(f.code(order).status, 'void')
  assert.deepEqual(f.code(order).result, drawn.result)
  unavailable(() => f.draw(original.code))
})

test('非完成转盘单有既有财务补款时全退不覆盖原履约和资金历史', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const adjustment = f.mutate('/player-adjustments', {
    userId: f.players[0].id, orderId: order.id,
    kind: 'supplement', amount: 200, reason: '已人工支付的特殊报酬'
  })
  const wallet = f.service.playerWallet(f.players[0].id)
  assert.equal(wallet.available, 200)
  f.refund(order)
  const after = f.current(order)
  assert.equal(after.status, 'active')
  assert.equal(after.cancellationPolicyVersion, undefined)
  assert.equal(after.displayStatus, 'refunded')
  assert.equal(after.rewardDisposition.mode, 'preserve-settled')
  assert.equal(after.countsTowardsCapacity, false)
  assert.deepEqual(f.state().playerAdjustments.find(row => row.id === adjustment.id), adjustment)
  assert.deepEqual(f.service.playerWallet(f.players[0].id), wallet)
  assert.equal(f.code(order).status, 'void')
  rejected(() => f.submit(order), 'ORDER_REFUNDED')
})

test('退款事务失败同时回滚码作废、报酬决定、退款和订单版本', t => {
  const f = fixture(t), order = f.order()
  f.claim(order)
  const original = f.code(order), before = f.current(order), refunds = f.state().refunds
  f.failRefund(true)
  assert.throws(() => f.refund(order), /isolated refund commit failure/)
  assert.deepEqual(f.current(order), before)
  assert.deepEqual(f.code(order), original)
  assert.deepEqual(f.state().refunds, refunds)
  assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity='lottery-code' AND action='作废转盘兑换资格'").get().n, 0)
  f.failRefund(false)
  f.refund(order)
  assert.equal(f.current(order).displayStatus, 'refunded')
  assert.equal(f.code(order).status, 'void')
})
