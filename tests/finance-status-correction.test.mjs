import { testMutate } from './helpers/current-intent.mjs'
import { withdrawalBody } from './player-test-helpers.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'

const PASSWORD = 'finance-status-isolated-test-123'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const statuses = ['pending', 'active', 'review', 'completed', 'canceled']
const rejected = (fn, status) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status)

function fixture(t) {
  const service = createStudioService({
    dbPath: ':memory:',
    seed: false,
    password: PASSWORD,
    clock: () => new Date('2026-10-13T04:00:00Z')
  })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '免截图测试', delaySeconds: 0 })
  const users = Object.fromEntries(
    ['finance', 'manager', 'owner', 'admin', 'player', 'support'].map((role) => [
      role,
      mutate('/users', {
        name: role,
        username: `finance-status-${role}`,
        role,
        password: PASSWORD,
        status: 'active',
        levelId: level.id,
        maxActiveOrders: 1,
        permissionOverrides: {}
      })
    ])
  )
  const upload = (actor = 'admin') =>
    service.upload(actor, { name: 'payment.png', mime: 'image/png', data: PNG })
  const receipt = upload()
  const customer = mutate('/customers', { name: '财务测试客户', platformId: 'hall', gameId: '1' })
  const template = mutate('/templates', {
    name: '免截图项目',
    game: '测试',
    amount: 8800,
    reward: 7000,
    active: true
  })
  const order = (overrides = {}) =>
    mutate('/orders', {
      templateId: template.id,
      customerId: customer.id,
      platformId: 'hall',
      roomCode: 'TEST',
      amount: 8800,
      reward: 7000,
      receivedAmount: 8800,
      paidAt: '2026-10-12T10:00:00+08:00',
      receipt,
      dispatchMode: 'pool',
      ...overrides
    })
  const correct = (record, status, actor = users.finance.id, overrides = {}) =>
    mutate(
      `/orders/${record.id}/action`,
      {
        action: 'correct-status',
        status,
        leaderId: users.player.id,
        reason: `财务核对改为${status}`,
        ...overrides
      },
      actor
    )
  return { service, mutate, users, upload, order, correct }
}

test('财务五种状态的20种不同状态转换均免截图，奖励和数据检查保持一致', (t) => {
  const f = fixture(t)
  for (const from of statuses) {
    for (const to of statuses.filter((value) => value !== from)) {
      let record = f.order()
      if (from !== 'pending') record = f.correct(record, from)
      const before = f.service.playerWallet(f.users.player.id).earned
      const after = f.correct(record, to)
      assert.equal(after.status, to, `${from} -> ${to}`)
      assert.ok(after.submissions.every((submission) => submission.screenshots.length === 0))
      assert.equal(
        f.service.playerWallet(f.users.player.id).earned,
        before + (to === 'completed' ? 7000 : 0) - (from === 'completed' ? 7000 : 0),
        `${from} -> ${to} reward`
      )
      if (to !== 'canceled') {
        assert.equal(after.reward, 7000)
        assert.equal(after.compensationPending, false)
        assert.equal(after.compensationSettled, false)
      }
      if (to === 'review') {
        assert.equal(after.submissions.at(-1).source, 'status-correction')
        assert.equal(after.submissions.at(-1).correctedBy, f.users.finance.id)
      }
    }
  }
  const report = f.service.diagnostics('admin')
  assert.equal(report.summary.errorCount, 0, JSON.stringify(report.issues))
})

test('免图登记在财务界面可正常验收、退回、再次送审，保留原因和审计', (t) => {
  const f = fixture(t)
  const record = f.order()
  const reviewed = f.correct(record, 'review')
  assert.equal(reviewed.submissions[0].correctionReason, '财务核对改为review')
  const returned = f.mutate(
    `/orders/${record.id}/action`,
    {
      action: 'review-return',
      reason: '请继续核实履约情况'
    },
    f.users.finance.id
  )
  assert.equal(returned.status, 'active')
  assert.equal(returned.submissions[0].review, 'returned')
  f.correct(record, 'review')
  const completed = f.mutate(
    `/orders/${record.id}/action`,
    { action: 'review-pass' },
    f.users.finance.id
  )
  assert.equal(completed.status, 'completed')
  assert.equal(completed.submissions.at(-1).review, 'passed')
  assert.equal(f.service.playerWallet(f.users.player.id).earned, 7000)
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
  const logs = f.service.logs('admin', { entity: 'order', source: 'all', size: 200 })
  assert.ok(
    logs.records.some((row) => row.entityId === record.id && row.action.includes('correct-status'))
  )
})

test('四种授权角色免图更正；普通管理员、客服和撤销编辑权限仍不能更正', (t) => {
  const f = fixture(t)
  for (const actor of [f.users.finance.id, f.users.manager.id, f.users.owner.id, 'admin']) {
    const result = f.correct(f.order(), 'review', actor)
    assert.equal(result.status, 'review')
    assert.equal(result.submissions.at(-1).correctedBy, actor)
  }
  for (const actor of [f.users.admin.id, f.users.support.id, f.users.player.id])
    rejected(() => f.correct(f.order(), 'review', actor), 403)
  rejected(() => f.correct(f.order(), 'review', f.users.finance.id, { reason: '' }), 400)
  f.mutate('/users', { ...f.users.finance, permissionOverrides: { 'orders.edit': false } })
  rejected(() => f.correct(f.order(), 'review'), 403)
})

test('状态更正免图不放开打手端提交要求，也不伪造未收款订单的完成', (t) => {
  const f = fixture(t)
  const record = f.order()
  f.mutate(`/player/orders/${record.id}/claim`, {}, f.users.player.id)
  rejected(
    () =>
      f.mutate(
        `/player/orders/${record.id}/submit`,
        {
          screenshots: [],
          source: 'status-correction',
          correctedBy: 'admin',
          correctionReason: '伪造'
        },
        f.users.player.id
      ),
    400
  )
  const submitted = f.mutate(
    `/player/orders/${record.id}/submit`,
    {
      screenshots: [f.upload(f.users.player.id)],
      source: 'status-correction',
      correctedBy: 'admin'
    },
    f.users.player.id
  )
  assert.equal(submitted.submissions.at(-1).source, undefined)
  const unpaid = f.order({ payOnArrival: true, receivedAmount: 0, receipt: null })
  rejected(() => f.correct(unpaid, 'completed'), 400)
  const stored = f.service.bootstrap('admin').orders.find((row) => row.id === unpaid.id)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.receivedAmount, 0)
})

test('后台更正可以记录超接单上限和已停用历史打手，取消重开恢复取消前报酬', (t) => {
  const f = fixture(t)
  const first = f.order()
  f.mutate(`/player/orders/${first.id}/claim`, {}, f.users.player.id)
  assert.equal(f.correct(f.order(), 'active').status, 'active')
  const third = f.order()
  rejected(() => f.mutate(`/player/orders/${third.id}/claim`, {}, f.users.player.id), 409)
  f.mutate('/users', { ...f.users.player, status: 'disabled' })
  assert.equal(f.correct(third, 'completed').status, 'completed')
  const canceled = f.order({ reward: 4567 })
  f.mutate(`/orders/${canceled.id}/action`, { action: 'cancel', reason: '尚未开工' })
  const reopened = f.correct(canceled, 'pending')
  assert.equal(reopened.reward, 4567)
  assert.equal(reopened.compensationPending, false)
  assert.equal(reopened.compensationSettled, false)
  assert.equal(f.correct(reopened, 'completed').reward, 4567)
})

test('已提现订单免图重新验收抵销待追回，重复请求不再次结算', (t) => {
  const f = fixture(t)
  const record = f.correct(f.order(), 'completed')
  const withdrawal = f.mutate(
    '/player/withdrawals',
    withdrawalBody(f.service, f.users.player.id, 7000),
    f.users.player.id
  )
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt: f.upload() })
  const requestId = crypto.randomUUID()
  const review = f.correct(record, 'review', f.users.finance.id, { requestId })
  assert.deepEqual(f.correct(record, 'review', f.users.finance.id, { requestId }), review)
  assert.equal(
    f.service.bootstrap('admin').playerAdjustments.filter((row) => row.status === 'manual').length,
    1
  )
  const completeBody = { action: 'review-pass', requestId: crypto.randomUUID() }
  const completed = f.mutate(`/orders/${record.id}/action`, completeBody, f.users.finance.id)
  assert.deepEqual(
    f.mutate(`/orders/${record.id}/action`, completeBody, f.users.finance.id),
    completed
  )
  assert.equal(completed.completedAt, record.completedAt)
  assert.equal(f.service.playerWallet(f.users.player.id).available, 0)
  assert.equal(f.service.playerWallet(f.users.player.id).paid, 7000)
  assert.equal(
    f.service.bootstrap('admin').playerAdjustments.filter((row) => row.status === 'manual').length,
    0
  )
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
})

test('取消后明确更正的报酬不被原报价覆盖；已完成后普通取消再重开也会冲正奖励', (t) => {
  const f = fixture(t)
  const canceled = f.order({ reward: 4567 })
  f.mutate(`/orders/${canceled.id}/action`, { action: 'cancel', reason: '原任务取消' })
  f.mutate(`/orders/${canceled.id}/action`, {
    action: 'adjust',
    amount: 8800,
    reward: 6000,
    reason: '财务核对后约定新报酬'
  })
  const changed = f.correct(canceled, 'completed')
  assert.equal(changed.reward, 6000)
  assert.equal(f.service.playerWallet(f.users.player.id).earned, 6000)
  f.mutate(`/orders/${changed.id}/action`, { action: 'cancel', reason: '完成后重新核对' })
  f.correct(changed, 'active')
  assert.equal(f.service.playerWallet(f.users.player.id).earned, 0)
  f.correct(changed, 'review')
  const restored = f.mutate(`/orders/${changed.id}/action`, { action: 'review-pass' })
  assert.equal(restored.reward, 6000)
  assert.equal(f.service.playerWallet(f.users.player.id).earned, 6000)
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
})

test('取消后财务明确将报酬或最终取消补偿确认成0，重开和完成仍为0', (t) => {
  const f = fixture(t)
  for (const action of ['adjust', 'cancel-settle']) {
    const record = f.order()
    if (action === 'cancel-settle') f.correct(record, 'active')
    f.mutate(`/orders/${record.id}/action`, { action: 'cancel', reason: '确认无补偿取消' })
    const settled = f.mutate(`/orders/${record.id}/action`, {
      action,
      amount: 8800,
      reward: 0,
      teammateId: null,
      reason: '财务明确确认最终打手报酬为0'
    })
    assert.equal(settled.rewardBeforeCancellation, 0)
    assert.equal(f.correct(record, 'active').reward, 0)
    assert.equal(f.correct(record, 'completed').reward, 0)
    assert.equal(f.service.playerWallet(f.users.player.id).earned, 0)
    assert.equal(f.service.playerWallet(f.users.player.id).available, 0)
  }
  assert.equal(f.service.diagnostics('admin').summary.errorCount, 0)
})

test('同一状态更正请求号仅允许完全相同重试，修改状态或负责人必须409且不改账', (t) => {
  const f = fixture(t)
  const other = f.mutate('/users', {
    username: 'status-other-player',
    name: '第二位打手',
    role: 'player',
    password: PASSWORD,
    status: 'active',
    levelId: f.users.player.levelId,
    maxActiveOrders: 1,
    permissionOverrides: {}
  })
  const record = f.order()
  const requestId = crypto.randomUUID()
  const overrides = { requestId, reason: '同一原因核对状态' }
  const first = f.correct(record, 'review', f.users.finance.id, overrides)
  assert.deepEqual(f.correct(record, 'review', f.users.finance.id, overrides), first)
  rejected(() => f.correct(record, 'completed', f.users.finance.id, overrides), 409)
  rejected(
    () => f.correct(record, 'review', f.users.finance.id, { ...overrides, leaderId: other.id }),
    409
  )
  const current = f.service.bootstrap('admin').orders.find((row) => row.id === record.id)
  assert.equal(current.status, 'review')
  assert.equal(current.leaderId, f.users.player.id)
  assert.equal(current.submissions.length, 1)
  assert.equal(f.service.playerWallet(f.users.player.id).earned, 0)
  assert.equal(f.service.playerWallet(other.id).earned, 0)

  // Old cached records did not bind these fields. Fail closed instead of replaying or guessing.
  const saved = f.service.db
    .prepare('SELECT payload_json FROM financial_requests WHERE request_id=?')
    .get(requestId)
  const legacy = JSON.parse(saved.payload_json)
  // Simulate a pre-v3 financial record without the new successful-request envelope.
  f.service.db.prepare('DELETE FROM business_requests WHERE request_id=?').run(requestId)
  delete legacy.status
  delete legacy.leaderId
  f.service.db
    .prepare('UPDATE financial_requests SET payload_json=? WHERE request_id=?')
    .run(JSON.stringify(legacy), requestId)
  rejected(() => f.correct(record, 'review', f.users.finance.id, overrides), 409)
  rejected(() => f.correct(record, 'completed', f.users.finance.id, overrides), 409)
  assert.equal(
    f.service.bootstrap('admin').orders.find((row) => row.id === record.id).status,
    'review'
  )
  assert.equal(f.service.playerWallet(f.users.player.id).earned, 0)
})
