import test from 'node:test'
import assert from 'node:assert/strict'
import { paymentConfirmed, submitEligibility } from '../server/order-contract.mjs'

test('trusted merchant credit permits the current leader to submit without claiming cash was received', () => {
  const order = { status: 'active', leaderId: 'player', assignmentId: 'assignment', amount: 8000,
    receivedAmount: 0, paidAt: null, merchantId: 'merchant', settlementMode: 'merchant-credit' }
  assert.equal(paymentConfirmed(order), false)
  assert.equal(submitEligibility({ id: 'player' }, order).canSubmit, true)
  assert.equal(submitEligibility({ id: 'other' }, order).canSubmit, false)
})

test('ordinary unpaid orders and an unbound credit label remain blocked', () => {
  const order = { status: 'active', leaderId: 'player', assignmentId: 'assignment', amount: 8000,
    receivedAmount: 0, paidAt: null }
  assert.equal(submitEligibility({ id: 'player' }, order).canSubmit, false)
  assert.equal(submitEligibility({ id: 'player' }, { ...order, settlementMode: 'merchant-credit' }).canSubmit, false)
  assert.equal(submitEligibility({ id: 'player' }, { ...order, receivedAmount: 8000, paidAt: '2026-11-08T01:00:00Z' }).canSubmit, true)
})
