import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readPlayerOperationResult } from '../server/operation-results.mjs'
import { createStudioService } from '../server/studio.mjs'

const player = { id: 'player-a', role: 'player', status: 'active' }
const stamp = '2026-10-14T05:00:00.000Z'

function receiptDatabase(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE business_requests(request_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,operation TEXT NOT NULL,payload_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE financial_requests(request_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,operation TEXT NOT NULL,payload_json TEXT NOT NULL,result_json TEXT NOT NULL);
  `)
  const add = (requestId, operation, actorId = player.id, legacy = false) => {
    const privateResult = '{malformed-private-old-snapshot:customer-amount:800000:receipt-secret}'
    if (legacy)
      db.prepare('INSERT INTO financial_requests VALUES(?,?,?,?,?)').run(
        requestId,
        actorId,
        operation,
        'private-old-target-and-attachments',
        privateResult
      )
    else
      db.prepare('INSERT INTO business_requests VALUES(?,?,?,?,?,?)').run(
        requestId,
        actorId,
        operation,
        'old-private-payload',
        privateResult,
        stamp
      )
  }
  return { db, add }
}

test('only the six personal operation families acknowledge success without reading old private JSON', (t) => {
  const { db, add } = receiptDatabase(t)
  const paths = {
    claim: '/player/orders/secret-order/claim',
    reject: '/player/orders/secret-order/reject',
    return: '/player/orders/secret-order/return-request',
    submit: '/player/orders/secret-order/submit',
    withdraw: '/player/withdrawals',
    'cancel-withdrawal': '/player/withdrawals/secret-withdrawal/cancel'
  }
  for (const [family, path] of Object.entries(paths)) {
    add(`success-${family}`, path)
    const result = readPlayerOperationResult(db, player, `success-${family}`, family, stamp)
    assert.deepEqual(result, {
      requestId: `success-${family}`,
      family,
      status: 'succeeded',
      operationConfirmed: true,
      result: 'confirmation-only',
      lateCommitPossible: false,
      canCreateNew: false,
      canRetryWithOriginal: false,
      createdAt: stamp
    })
    assert.ok(!JSON.stringify(result).includes('secret'))
  }
  add('unrelated', '/player/withdrawals/arbitrary/action')
  assert.equal(
    readPlayerOperationResult(db, player, 'unrelated', 'withdraw', stamp).status,
    'not-recorded'
  )
})

test('foreign IDs, wrong families and absent receipts are indistinguishable and cannot authorize a new intent', (t) => {
  const { db, add } = receiptDatabase(t)
  add('foreign', '/player/orders/private/claim', 'other-player')
  add('wrong-family', '/player/orders/private/submit')
  for (const requestId of ['missing', 'foreign', 'wrong-family']) {
    const result = readPlayerOperationResult(db, player, requestId, 'claim', stamp)
    assert.deepEqual(
      { ...result, requestId: 'normalized' },
      {
        requestId: 'normalized',
        family: 'claim',
        status: 'not-recorded',
        createdAt: null,
        operationConfirmed: false,
        result: 'confirmation-only',
        lateCommitPossible: true,
        canCreateNew: false,
        canRetryWithOriginal: true
      }
    )
  }
})

test('missing now is not failure proof, and a late committed receipt becomes a success acknowledgement', (t) => {
  const { db, add } = receiptDatabase(t)
  const before = readPlayerOperationResult(db, player, 'late', 'withdraw', '2099-01-01T00:00:00Z')
  assert.equal(before.lateCommitPossible, true)
  assert.equal(before.canCreateNew, false)
  add('late', '/player/withdrawals')
  const after = readPlayerOperationResult(db, player, 'late', 'withdraw', stamp)
  assert.equal(after.status, 'succeeded')
  assert.equal(after.operationConfirmed, true)
  assert.equal(after.canCreateNew, false)
})

test('current authentication, role and login access are checked before receipt lookup', (t) => {
  const { db, add } = receiptDatabase(t)
  add('known', '/player/orders/private/claim')
  const reject = (user, status, code) =>
    assert.throws(
      () => readPlayerOperationResult(db, user, 'known', 'claim', stamp),
      (error) => error.status === status && error.code === code
    )
  reject(null, 401, 'AUTH_REQUIRED')
  reject({ ...player, id: '' }, 401, 'AUTH_REQUIRED')
  reject({ ...player, role: 'finance' }, 403, 'PLAYER_REQUIRED')
  reject({ ...player, status: 'disabled' }, 403, 'PLAYER_DISABLED')
  reject({ ...player, playerAccess: { login: false } }, 403, 'PLAYER_DISABLED')
  assert.throws(
    () => readPlayerOperationResult(db, player, 'known', 'toString'),
    (error) => error.status === 400 && error.code === 'INVALID_OPERATION_FAMILY'
  )
  for (const value of ['', ' ', null, 4, 'a'.repeat(129)])
    assert.throws(
      () => readPlayerOperationResult(db, player, value, 'claim'),
      (error) => error.status === 400 && error.code === 'INVALID_REQUEST_ID'
    )
})

test('closed claim and withdrawal switches prohibit retries but do not erase personal success acknowledgement', (t) => {
  const { db, add } = receiptDatabase(t)
  const closed = { ...player, playerAccess: { login: true, claim: false, withdraw: false } }
  add('claimed', '/player/orders/private/claim')
  add('withdrew', '/player/withdrawals')
  for (const family of ['claim', 'withdraw']) {
    assert.equal(
      readPlayerOperationResult(db, closed, 'missing', family).canRetryWithOriginal,
      false
    )
    assert.equal(
      readPlayerOperationResult(db, closed, family === 'claim' ? 'claimed' : 'withdrew', family)
        .operationConfirmed,
      true
    )
  }
  assert.equal(
    readPlayerOperationResult(db, closed, 'missing', 'cancel-withdrawal').canRetryWithOriginal,
    true
  )
  assert.equal(
    readPlayerOperationResult(db, closed, 'missing', 'submit').canRetryWithOriginal,
    true
  )
})

test('legacy personal receipts confirm only their supported operation and never fabricate a creation date', (t) => {
  const { db, add } = receiptDatabase(t)
  add('legacy', '/player/withdrawals', player.id, true)
  const result = readPlayerOperationResult(db, player, 'legacy', 'withdraw')
  assert.equal(result.operationConfirmed, true)
  assert.equal(result.createdAt, null)
  assert.equal(result.legacy, true)
  assert.equal(result.result, 'confirmation-only')
  assert.equal(
    readPlayerOperationResult(db, { ...player, id: 'other-player' }, 'legacy', 'withdraw').status,
    'not-recorded'
  )
  assert.equal(readPlayerOperationResult(db, player, 'legacy', 'claim').status, 'not-recorded')
  assert.ok(!JSON.stringify(result).includes('receipt-secret'))
})

test('lost claim success can be personally acknowledged after reassignment without exposing the new order or old snapshot', (t) => {
  const s = createStudioService({
    dbPath: ':memory:',
    seed: false,
    password: 'isolated-operation-results-123',
    clock: () => new Date(stamp)
  })
  t.after(() => s.close())
  const level = s.mutate('admin', '/levels', { name: '查询隔离等级', delaySeconds: 0 })
  const createPlayer = (username) =>
    s.mutate('admin', '/users', {
      username,
      name: username,
      role: 'player',
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 1,
      permissionOverrides: {},
      password: 'isolated-operation-results-123'
    })
  const a = createPlayer('query-player-a'),
    b = createPlayer('query-player-b')
  const platform = s.mutate('admin', '/platforms', {
    name: '查询隔离来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const customer = s.mutate('admin', '/customers', { name: '私有客户', contact: 'PRIVATE-CONTACT' })
  const template = s.mutate('admin', '/templates', {
    name: '查询隔离项目',
    game: '隔离',
    amount: 10000,
    reward: 5000,
    active: true
  })
  const order = s.mutate('admin', '/orders', {
    requestId: randomUUID(),
    templateId: template.id,
    customerId: customer.id,
    platformId: platform.id,
    roomCode: 'PRIVATE-ROOM',
    amount: 10000,
    reward: 5000,
    receivedAmount: 10000,
    paidAt: stamp,
    dispatchMode: 'pool',
    remark: 'PRIVATE-INTERNAL-NOTE'
  })
  const requestId = randomUUID()
  // The success response is deliberately not consumed, while the real operation commits once.
  s.mutate(a.id, `/player/orders/${order.id}/claim`, {
    requestId,
    expectedRevision: order.revision,
    dispatchRound: order.dispatchRound
  })
  const active = s.orderDetail('admin', order.id).order
  s.mutate('admin', `/orders/${order.id}/action`, {
    requestId: randomUUID(),
    action: 'release',
    reason: '隔离重新指派',
    expectedRevision: active.revision,
    assignmentId: active.assignmentId,
    leaderId: a.id
  })
  const released = s.orderDetail('admin', order.id).order
  s.mutate('admin', `/orders/${order.id}/action`, {
    requestId: randomUUID(),
    action: 'dispatch',
    expectedRevision: released.revision,
    dispatchMode: 'direct',
    assignedTo: b.id
  })
  const result = readPlayerOperationResult(s.db, a, requestId, 'claim', stamp)
  assert.equal(result.operationConfirmed, true)
  assert.equal(result.result, 'confirmation-only')
  assert.equal(s.orderDetail('admin', order.id).order.assignedTo, b.id)
  assert.equal(
    s.db.prepare('SELECT COUNT(*) n FROM business_requests WHERE request_id=?').get(requestId).n,
    1
  )
  for (const forbidden of [
    order.id,
    b.id,
    'PRIVATE-ROOM',
    'PRIVATE-CONTACT',
    'PRIVATE-INTERNAL-NOTE',
    '10000'
  ])
    assert.ok(!JSON.stringify(result).includes(forbidden))
})
