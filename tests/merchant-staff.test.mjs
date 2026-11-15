import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { merchantFixture, merchantPassword } from './helpers/merchant-fixture.mjs'

const forbidden = (fn) => assert.throws(fn, (error) => error.status === 403)
const invalid = (fn) => assert.throws(fn, (error) => [400, 403, 409].includes(error.status))
const stateOf = (f) => JSON.parse(f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
function owned(t) {
  const f = merchantFixture(t)
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.accounts[0].id })
  return f
}

test('legacy merchant accounts stay support until a super administrator assigns exactly one owner', (t) => {
  const f = merchantFixture(t)
  assert.equal(f.service.merchants('admin')[0].ownerUserId, null)
  assert.equal(f.service.bootstrap(f.accounts[0].id).user.merchantRole, 'support')
  forbidden(() => f.mutate('/merchant/staff', { username: 'premature', name: '客服', password: merchantPassword }, f.accounts[0].id))
  const merchant = f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.accounts[0].id })
  assert.equal(merchant.ownerUserId, f.accounts[0].id)
  assert.equal(f.service.bootstrap(f.accounts[0].id).user.merchantRole, 'owner')
  assert.equal(f.service.bootstrap(f.accounts[1].id).user.merchantRole, 'support')
  assert.equal(f.service.bootstrap(f.accounts[0].id).user.deletedAt, null)
})

test('owner creates and manages only own merchant support with safe shared financial scope', (t) => {
  const f = owned(t), owner = f.accounts[0].id
  const staff = f.mutate('/merchant/staff', { username: 'own-staff', name: '自家客服', password: merchantPassword }, owner)
  assert.equal(staff.role, 'merchant')
  assert.equal(staff.merchantId, f.merchants[0].id)
  assert.equal(staff.merchantRole, 'support')
  assert.equal(staff.status, 'active')
  const order = f.order({}, staff.id)
  assert.equal(f.service.merchantOverview(owner).summary.outstandingAmount, 8000)
  assert.equal(f.service.merchantOverview(staff.id).summary.outstandingAmount, 8000)
  assert.equal(f.service.ordersPage(staff.id).records[0].id, order.id)
  assert.equal(f.service.bootstrap(staff.id).user.deletedAt, null)
  const rows = f.service.merchantStaff(owner).records
  assert.ok(rows.some((row) => row.id === staff.id))
  assert.ok(rows.every((row) => row.merchantId === f.merchants[0].id))
  assert.equal(JSON.stringify(rows).includes('password'), false)
  assert.equal(f.service.bootstrap(owner).users.some((row) => row.id === staff.id), true)
})

test('staff management rejects cross merchant targets, role injection and support privilege escalation', (t) => {
  const f = owned(t), owner = f.accounts[0].id, staff = f.accounts[1].id, foreign = f.accounts[2].id
  forbidden(() => f.service.merchantStaff(staff))
  forbidden(() => f.mutate('/merchant/staff', { id: foreign, name: '越权', status: 'disabled' }, owner))
  forbidden(() => f.mutate('/merchant/staff', { id: owner, name: '改主账号', status: 'disabled' }, owner))
  forbidden(() => f.mutate('/merchant/staff', { username: 'illegal', name: '越权', password: merchantPassword }, staff))
  for (const extra of [{ role: 'super_admin' }, { merchantRole: 'owner' }, { merchantId: f.merchants[1].id }, { permissionOverrides: { 'finance.refunds': true } }]) {
    invalid(() => f.mutate('/merchant/staff', { username: 'injection', name: '越权', password: merchantPassword, ...extra }, owner))
  }
  forbidden(() => f.mutate('/users', { ...f.accounts[1], password: merchantPassword }, owner))
  forbidden(() => f.mutate(`/merchant/staff/${foreign}/delete`, {}, owner))
  forbidden(() => f.mutate(`/merchant/staff/${owner}/delete`, {}, owner))
})

test('disabling and password reset revoke support sessions while retaining creator and order access for colleagues', (t) => {
  const f = owned(t), owner = f.accounts[0].id, staff = f.accounts[1]
  const order = f.order({}, staff.id)
  const login = f.service.login(staff.username, merchantPassword)
  f.mutate('/merchant/staff', { id: staff.id, status: 'disabled' }, owner)
  assert.equal(f.service.session(login.token), null)
  forbidden(() => f.service.ordersPage(staff.id))
  assert.equal(f.service.orderDetail(owner, order.id).order.creatorId, staff.id)
  f.mutate('/merchant/staff', { id: staff.id, status: 'active' }, owner)
  const relogin = f.service.login(staff.username, merchantPassword)
  f.mutate('/merchant/staff', { id: staff.id, password: 'isolated-new-staff-password' }, owner)
  assert.equal(f.service.session(relogin.token), null)
  assert.throws(() => f.service.login(staff.username, merchantPassword), (e) => e.status === 401)
  assert.equal(f.service.login(staff.username, 'isolated-new-staff-password').user.id, staff.id)
})

test('support deletion preserves stable history, revokes sessions and safely allows a new account to reuse username', (t) => {
  const f = owned(t), owner = f.accounts[0].id, staff = f.accounts[1]
  const order = f.order({}, staff.id)
  const login = f.service.login(staff.username, merchantPassword)
  const deleted = f.mutate(`/merchant/staff/${staff.id}/delete`, {}, owner)
  assert.equal(deleted.id, staff.id)
  assert.ok(deleted.deletedAt)
  assert.equal(deleted.status, 'disabled')
  assert.match(deleted.name, /已删除/)
  assert.equal(f.service.session(login.token), null)
  assert.throws(() => f.service.login(staff.username, merchantPassword), (e) => e.status === 401)
  forbidden(() => f.service.ordersPage(staff.id))
  const reused = f.mutate('/merchant/staff', { username: staff.username.toUpperCase(), name: '接班客服', password: merchantPassword }, owner)
  assert.notEqual(reused.id, staff.id)
  assert.equal(f.service.login(staff.username, merchantPassword).user.id, reused.id)
  const detail = f.service.orderDetail(owner, order.id)
  assert.equal(detail.order.creatorId, staff.id)
  assert.equal(detail.order.status, 'pending')
  assert.ok(detail.logs.some((row) => row.actorName === staff.name))
  const tombstone = f.service.bootstrap(owner).users.find((row) => row.id === staff.id)
  assert.match(tombstone.name, /已删除/)
  assert.equal('permissionOverrides' in tombstone, false)
  assert.equal('username' in tombstone, false)
  forbidden(() => f.mutate('/users', { ...staff, status: 'active' }))
})

test('only super administrator may delete merchant support from total backend and never an owner or employee', (t) => {
  const f = owned(t)
  const admin = f.mutate('/users', { username: 'limited-admin', name: '管理员', role: 'admin', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: merchantPassword })
  forbidden(() => f.mutate(`/users/${f.accounts[1].id}/delete`, {}, admin.id))
  forbidden(() => f.mutate(`/users/${f.accounts[0].id}/delete`, {}))
  forbidden(() => f.mutate(`/users/${admin.id}/delete`, {}))
  const result = f.mutate(`/users/${f.accounts[1].id}/delete`, {})
  assert.ok(result.deletedAt)
})

test('owner transfer is atomic, disables old owner, restores new owner, and blocks /users bypass', (t) => {
  const f = owned(t), oldOwner = f.accounts[0], nextOwner = f.accounts[1]
  const oldLogin = f.service.login(oldOwner.username, merchantPassword)
  const newLogin = f.service.login(nextOwner.username, merchantPassword)
  const limited = f.mutate('/users', { username: 'transfer-limited-admin', name: '管理员', role: 'admin', status: 'active', maxActiveOrders: 1, permissionOverrides: {}, password: merchantPassword })
  forbidden(() => f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: nextOwner.id }, limited.id))
  invalid(() => f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: f.accounts[2].id }))
  forbidden(() => f.mutate('/users', { ...oldOwner, name: '非超管修改' }, limited.id))
  invalid(() => f.mutate('/users', { ...oldOwner, merchantId: f.merchants[1].id }))
  invalid(() => f.mutate('/users', { ...oldOwner, role: 'support' }))
  f.mutate('/users', { ...nextOwner, status: 'disabled' })
  const moved = f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: nextOwner.id })
  assert.equal(moved.ownerUserId, nextOwner.id)
  assert.equal(f.service.session(oldLogin.token), null)
  assert.equal(f.service.session(newLogin.token), null)
  assert.equal(stateOf(f).users.find((row) => row.id === oldOwner.id).status, 'disabled')
  assert.equal(f.service.login(nextOwner.username, merchantPassword).user.merchantRole, 'owner')
  invalid(() => f.mutate('/users', { ...oldOwner, merchantRole: 'owner' }))
})

test('merchant whole-order cancellation remains available before acceptance review, but completed orders and actual refunds stay internal', (t) => {
  const f = owned(t), staff = f.accounts[1].id
  const pending = f.order({}, staff)
  assert.equal(f.mutate(`/orders/${pending.id}/action`, { action: 'cancel', reason: '未接单取消' }, staff).status, 'canceled')
  const accepted = f.order({}, staff)
  f.mutate(`/player/orders/${accepted.id}/claim`, {}, f.players[0].id)
  forbidden(() => f.mutate('/refunds', { orderId: accepted.id, amount: 100, reason: '无权退款' }, staff))
  assert.equal(f.mutate(`/orders/${accepted.id}/action`, { action: 'cancel', reason: '已接单未验收整单取消' }, staff).status, 'canceled')
  const canceled = f.service.orderDetail('admin', accepted.id)
  assert.equal(canceled.order.compensationPending, false)
  assert.equal(canceled.order.compensationSettled, true)
  assert.equal(canceled.order.cancellationPolicyVersion, 1)
  assert.equal(canceled.order.rewardDisposition.mode, 'zero-unsettled')
  assert.ok(canceled.order.assignments.every((row) => row.releasedAt))
  assert.equal(canceled.order.receivedAmount, 0)
  assert.equal(canceled.refunds.length, 0)
  const submitted = f.order({}, staff)
  f.mutate(`/player/orders/${submitted.id}/claim`, {}, f.players[0].id)
  f.mutate(`/player/orders/${submitted.id}/submit`, { screenshots: [f.upload(f.players[0].id)] }, f.players[0].id)
  assert.equal(f.mutate(`/orders/${submitted.id}/action`, { action: 'cancel', reason: '待验收整单取消' }, staff).status, 'canceled')
  const canceledReview = f.service.orderDetail('admin', submitted.id).order
  assert.equal(canceledReview.compensationPending, false)
  assert.equal(canceledReview.compensationSettled, true)
  assert.equal(canceledReview.cancellationPolicyVersion, 1)
  assert.equal(canceledReview.rewardDisposition.mode, 'zero-unsettled')
  const completed = f.order({}, staff)
  f.mutate(`/player/orders/${completed.id}/claim`, {}, f.players[0].id)
  f.mutate(`/player/orders/${completed.id}/submit`, { screenshots: [f.upload(f.players[0].id)] }, f.players[0].id)
  f.mutate(`/orders/${completed.id}/action`, { action: 'review-pass' })
  forbidden(() => f.mutate(`/orders/${completed.id}/action`, { action: 'cancel', reason: '已验收须总后台' }, staff))
  assert.equal(f.service.orderDetail('admin', completed.id).order.status, 'completed')
})

test('merchant dispatch targets contain only dispatch eligible players and safe public fields', (t) => {
  const f = owned(t)
  const blocked = f.players[1]
  f.mutate('/users', { ...blocked, playerAccess: { login: false, claim: false, withdraw: true } })
  const result = f.service.dispatchTargets(f.accounts[1].id)
  assert.deepEqual(result.records.map((row) => row.id), [f.players[0].id])
  for (const row of result.records) {
    assert.equal('username' in row, false)
    assert.equal('permissionOverrides' in row, false)
    assert.equal('playerAccess' in row, false)
    assert.equal('reward' in row, false)
  }
})

test('management retry creates only one support identity and does not store the plaintext password', (t) => {
  const f = owned(t), owner = f.accounts[0].id
  const payload = { username: 'retry-account', name: '重试客服', password: 'isolated-retry-secret-password', requestId: randomUUID() }
  const first = f.mutate('/merchant/staff', payload, owner)
  const second = f.mutate('/merchant/staff', payload, owner)
  assert.equal(second.id, first.id)
  assert.equal(stateOf(f).users.filter((row) => row.username === payload.username).length, 1)
  const requests = f.service.db.prepare('SELECT * FROM business_requests').all()
  assert.equal(JSON.stringify(requests).includes(payload.password), false)
  const rawPayload = { name: payload.name, password: payload.password, username: payload.username }
  const fastPasswordVerifier = createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex')
  assert.notEqual(requests.find((row) => row.request_id === payload.requestId).payload_hash, fastPasswordVerifier,
    'idempotency must not expose a fast unsalted SHA256 password verifier')
  assert.throws(() => f.mutate('/merchant/staff', { ...payload, password: 'different-isolated-password' }, owner),
    (error) => error.status === 409 && error.code === 'REQUEST_ID_CONFLICT')
  const audits = f.service.db.prepare('SELECT payload FROM audit_logs').all()
  assert.equal(JSON.stringify(audits).includes(payload.password), false)
})

test('management delete and transfer retries return original success without deleting a reused identity or disabling a later owner', (t) => {
  const f = owned(t), oldOwner = f.accounts[0].id, staff = f.accounts[1]
  const deleteBody = { requestId: randomUUID() }
  const deleted = f.mutate(`/merchant/staff/${staff.id}/delete`, deleteBody, oldOwner)
  const reused = f.mutate('/merchant/staff', { username: staff.username, name: '新客服', password: merchantPassword }, oldOwner)
  assert.deepEqual(f.mutate(`/merchant/staff/${staff.id}/delete`, deleteBody, oldOwner), deleted)
  assert.equal(f.service.login(staff.username, merchantPassword).user.id, reused.id)
  const transferBody = { userId: reused.id, requestId: randomUUID() }
  const moved = f.mutate(`/merchants/${f.merchants[0].id}/owner`, transferBody)
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: oldOwner })
  assert.deepEqual(f.mutate(`/merchants/${f.merchants[0].id}/owner`, transferBody), moved)
  assert.equal(f.service.merchants('admin')[0].ownerUserId, oldOwner)
  assert.equal(stateOf(f).users.find((row) => row.id === oldOwner).status, 'active')
  forbidden(() => f.mutate(`/merchant/staff/${staff.id}/delete`, deleteBody, reused.id))
})
