import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import {
  createStudioRequestId,
  createStudioMutationIntent,
  setStudioMutationActorResolver
} from '../src/api/studio-mutation.ts'

function useBrowserCrypto(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else delete globalThis.crypto
  })
}

test('公网 HTTP 缺少 randomUUID 时仍能提交，未知结果重试保持原编号且禁止改内容', (t) => {
  useBrowserCrypto(t, { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
  assert.equal(typeof globalThis.crypto.randomUUID, 'undefined')
  const intent = createStudioMutationIntent()
  const body = { amount: 1000, reason: 'HTTP 隔离资金意图' }
  const first = intent.prepare('/player-adjustments', body)
  assert.match(
    first.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
  intent.fail(new TypeError('response lost'))
  assert.equal(intent.prepare('/player-adjustments', { ...body }), first)
  assert.throws(() => intent.prepare('/player-adjustments', { ...body, amount: 2000 }), {
    code: 'LOCAL_PENDING_REQUEST'
  })
  intent.complete()
  assert.notEqual(intent.prepare('/player-adjustments', body).requestId, first.requestId)
})

test('支持 randomUUID 的 HTTPS 浏览器继续使用原生函数并保留方法接收者', (t) => {
  const expected = 'bed8cc23-419a-413b-879c-cf703412675b'
  const browserCrypto = {
    randomUUID() {
      assert.equal(this, browserCrypto)
      return expected
    },
    getRandomValues() {
      assert.fail('原生 randomUUID 可用时不应调用兼容分支')
    }
  }
  useBrowserCrypto(t, browserCrypto)
  assert.equal(createStudioRequestId(), expected)
})

test('缺少强随机能力时明确失败，不生成弱随机请求编号', (t) => {
  useBrowserCrypto(t, undefined)
  assert.throws(() => createStudioRequestId(), /不支持安全随机数/)
})

test('后台未知结果的原意图保留原账号，换号不会把原请求改成新账号发送', (t) => {
  let actor = 'account-a'
  setStudioMutationActorResolver(() => actor)
  t.after(() => setStudioMutationActorResolver(() => undefined))
  const intent = createStudioMutationIntent(),
    body = { amount: 100, reason: '隔离资金意图' }
  const first = intent.prepare('/player-adjustments', body)
  intent.fail(new TypeError('response lost'))
  actor = 'account-b'
  const retried = intent.prepare('/player-adjustments', body)
  assert.equal(retried.expectedActorId, 'account-a')
  assert.equal(retried.requestId, first.requestId)
  intent.complete()
  assert.equal(intent.prepare('/player-adjustments', body).expectedActorId, 'account-b')
})

test('后台提交丢失响应后保留原编号、原版本与完整内容', () => {
  const intent = createStudioMutationIntent()
  const source = {
    action: 'release',
    expectedRevision: 7,
    assignmentId: 'assignment-old',
    leaderId: 'player-old'
  }
  const first = intent.prepare('/orders/order/action', source)
  source.assignmentId = 'assignment-new'
  intent.fail(new TypeError('network error'))
  const retry = intent.prepare('/orders/order/action', {
    ...source,
    assignmentId: 'assignment-old'
  })
  assert.equal(retry.requestId, first.requestId)
  assert.equal(retry.assignmentId, 'assignment-old')
  assert.equal(retry.expectedRevision, 7)
  assert.throws(() => intent.prepare('/orders/order/action', { ...source, expectedRevision: 8 }), {
    code: 'LOCAL_PENDING_REQUEST'
  })
})

test('后台结果未确认时不允许换目标或内容制造第二次资金提交', () => {
  const intent = createStudioMutationIntent()
  const first = intent.prepare('/expenses', {
    amount: 1000,
    purpose: '费用',
    receipt: { id: 'receipt-1' }
  })
  intent.fail({ status: 503 })
  let conflict
  try {
    intent.prepare('/expenses', { amount: 2000, purpose: '费用', receipt: { id: 'receipt-1' } })
  } catch (cause) {
    conflict = cause
  }
  intent.fail(conflict)
  assert.equal(intent.uncertain, true)
  assert.throws(() => intent.prepare('/refunds', { orderId: 'other', amount: 1000 }))
  const retry = intent.prepare('/expenses', {
    amount: 1000,
    purpose: '费用',
    receipt: { id: 'receipt-1' }
  })
  assert.deepEqual(retry, first)
})

test('确定失败可重新确认；成功后的独立同内容意图取得新编号', () => {
  const intent = createStudioMutationIntent()
  const first = intent.prepare('/orders/order/action', {
    action: 'edit',
    expectedRevision: 4,
    roomCode: 'a'
  })
  intent.fail({ status: 409, code: 'ORDER_REVISION_CONFLICT' })
  const renewed = intent.prepare('/orders/order/action', {
    action: 'edit',
    expectedRevision: 5,
    roomCode: 'a'
  })
  assert.notEqual(renewed.requestId, first.requestId)
  intent.complete()
  const next = intent.prepare('/orders/order/action', {
    action: 'edit',
    expectedRevision: 5,
    roomCode: 'a'
  })
  assert.notEqual(next.requestId, renewed.requestId)
})
