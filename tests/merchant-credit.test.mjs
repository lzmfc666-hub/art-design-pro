import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../server/studio.mjs'
import { withdrawalBody } from './player-test-helpers.mjs'
import { merchantFixture } from './helpers/merchant-fixture.mjs'

test('unpaid merchant credit is accepted and pays the existing two-player wallets; later real receipt never pays rewards twice', (t) => {
  const f = merchantFixture(t)
  const created = f.order()
  const [leader, teammate] = f.players
  f.mutate(`/player/orders/${created.id}/claim`, {}, leader.id)
  const active = f.service.playerOrderDetail(leader.id, created.id)
  assert.equal(active.paymentConfirmed, false)
  assert.equal(active.fulfillmentAuthorized, true)
  assert.equal(active.canSubmit, true)
  f.mutate(`/player/orders/${created.id}/submit`, { screenshots: [f.upload(leader.id)], teammateId: teammate.id }, leader.id)
  f.mutate(`/orders/${created.id}/action`, { action: 'review-pass' })
  const diagnostics = f.service.diagnostics('admin')
  assert.equal(diagnostics.summary.errorCount, 0, JSON.stringify(diagnostics.issues))
  assert.equal(f.service.playerWallet(leader.id).available, 3000)
  assert.equal(f.service.playerWallet(teammate.id).available, 3000)
  const withdrawal = f.mutate('/player/withdrawals', withdrawalBody(f.service, leader.id, 3000), leader.id)
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  f.mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt: f.upload() })
  assert.equal(f.service.playerWallet(leader.id).paid, 3000)
  assert.equal(f.service.orderDetail('admin', created.id).order.receivedAmount, 0)
  assert.throws(
    () => f.mutate(`/orders/${created.id}/action`, { action: 'confirm-payment', receivedAmount: 8000, paidAt: '2026-11-08T04:00:00Z' }, f.accounts[0].id),
    (error) => error instanceof ApiError && error.status === 403
  )
  const receiptBody = { action: 'confirm-payment', receivedAmount: 8000, paidAt: '2026-11-08T04:00:00Z', receipt: f.upload(), requestId: 'merchant-later-receipt-001' }
  f.mutate(`/orders/${created.id}/action`, receiptBody)
  f.mutate(`/orders/${created.id}/action`, receiptBody)
  const actual = f.service.orderDetail('admin', created.id).order
  assert.equal(actual.receivedAmount, 8000)
  assert.equal(f.service.playerWallet(leader.id).earned, 3000)
  assert.equal(f.service.playerWallet(leader.id).paid, 3000)
  assert.equal(f.service.playerWallet(teammate.id).earned, 3000)
  const ledger = f.service.playerWallet(leader.id).ledger
  assert.equal(ledger.filter((row) => row.orderId === created.id).reduce((sum, row) => sum + row.delta, 0), 3000)
})

test('merchant board shows its receivable and actual receipt without exposing player costs or other merchant orders', (t) => {
  const f = merchantFixture(t)
  const a = f.order()
  f.order({}, f.accounts[2].id, f.templates[1])
  const first = f.service.merchantOverview(f.accounts[1].id).summary
  assert.equal(first.orders, 1)
  assert.equal(first.pending, 1)
  assert.equal(first.merchantCustomerAmount, 10000)
  assert.equal(first.receivableAmount, 8000)
  assert.equal(first.receivedAmount, 0)
  assert.equal(first.outstandingAmount, 8000)
  f.mutate(`/orders/${a.id}/action`, { action: 'confirm-payment', receivedAmount: 8000, paidAt: '2026-11-08T04:00:00Z', receipt: f.upload() })
  const paid = f.service.merchantOverview(f.accounts[0].id)
  assert.equal(paid.summary.receivedAmount, 8000)
  assert.equal(paid.summary.outstandingAmount, 0)
  for (const field of ['reward', 'cost', 'profit', 'commissionSnapshot'])
    assert.equal(JSON.stringify(paid).includes(`"${field}"`), false)
})

test('internal merchant credit summary retains accepted reward liability before cash receipt and never exposes it to merchants', (t) => {
  const f = merchantFixture(t)
  const order = f.order()
  const leader = f.players[0]
  f.mutate(`/player/orders/${order.id}/claim`, {}, leader.id)
  f.mutate(`/player/orders/${order.id}/submit`, { screenshots: [f.upload(leader.id)] }, leader.id)
  f.mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
  assert.deepEqual(f.service.bootstrap('admin', '2026-11').reports.merchantCredit, {
    orders: 1, receivableAmount: 8000, receivedAmount: 0,
    outstandingAmount: 8000, acceptedRewardAmount: 6000
  })
  assert.equal(f.service.bootstrap(f.accounts[0].id, '2026-11').reports?.merchantCredit, undefined)
  f.mutate(`/orders/${order.id}/action`, {
    action: 'confirm-payment', receivedAmount: 8000, paidAt: '2026-11-08T04:00:00Z', receipt: f.upload()
  })
  assert.deepEqual(f.service.bootstrap('admin', '2026-11').reports.merchantCredit, {
    orders: 1, receivableAmount: 8000, receivedAmount: 8000,
    outstandingAmount: 0, acceptedRewardAmount: 6000
  })
})
