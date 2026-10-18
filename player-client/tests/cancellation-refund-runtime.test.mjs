import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(resolve(tmpdir(), 'studio-player-cancellation-'))
const require = createRequire(await realpath(resolve(clientRoot, 'node_modules/vite/package.json')))
const { build } = require('esbuild')
await build({ stdin: { contents: `
  export * from './src/api/orderPresentation'
  export * from './src/api/orderAccess'
  export * from './src/api/orderTarget'
  export { playerApi } from './src/api/player'
  export { setPrincipalVerifier, setRequestActorProvider } from './src/api/studio'
  export { useSessionStore } from './src/stores/session'
  export { createPinia, setActivePinia } from 'pinia'
`, resolveDir: clientRoot, sourcefile: 'cancellation-refund-runtime-entry.ts', loader: 'ts' },
  outfile: resolve(output, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', tsconfig: resolve(clientRoot, 'tsconfig.json') })
const api = await import(pathToFileURL(resolve(output, 'runtime.mjs')).href)
const order = extra => ({ id: 'order-a', orderNo: 'QA-A', title: '隔离订单', reward: 1201, status: 'active',
  revision: 4, dispatchRound: 2, assignmentId: 'assignment-a', leaderId: 'player-a', canClaim: true, canSubmit: true, ...extra })

await test('effective reward follows only the server decision and preserves original history', () => {
  for (const trigger of ['cancel', 'full-refund']) {
    const zero = Object.freeze(order({ status: trigger === 'cancel' ? 'canceled' : 'active', fullRefund: trigger === 'full-refund',
      effectiveReward: 0, rewardDisposition: { mode: 'zero-unsettled', trigger, policyVersion: 1, decidedAt: '2026-10-18T00:00:00Z', decidedBy: 'admin' } }))
    assert.equal(api.effectiveOrderReward(zero), 0)
    assert.equal(zero.reward, 1201)
    const settled = Object.freeze({ ...zero, effectiveReward: 1201, rewardDisposition: { ...zero.rewardDisposition, mode: 'preserve-settled' } })
    assert.equal(api.effectiveOrderReward(settled), 1201)
  }
  // No client-side settlement guesses for legacy, pending or partial refunds.
  for (const legacy of [{ status: 'canceled' }, { fullRefund: true }, { refundPending: true }, { status: 'completed' }, {}])
    assert.equal(api.effectiveOrderReward(order(legacy)), 1201)
  assert.equal(api.effectiveOrderReward(order({ effectiveReward: 800 })), 800)
})

await test('daily lists remove raw canceled rows even when full-refund overrides the display label', () => {
  const canceled = order({ id: 'canceled', status: 'canceled', displayStatus: 'refunded', problem: { id: 'p', status: 'open' } })
  const refunded = order({ id: 'refunded', displayStatus: 'refunded', fullRefund: true, effectiveReward: 0 })
  const active = order({ id: 'active' })
  const page = { records: [canceled, refunded, active], total: 3, current: 1, size: 20,
    counts: { all: 3, canceled: 0, refunded: 2, active: 1, problem: 1 } }
  const before = structuredClone(page)
  const clean = api.dailyPlayerOrderPage(page)
  assert.deepEqual(clean.records.map(row => row.id), ['refunded', 'active'])
  assert.equal(clean.total, 2)
  assert.deepEqual(clean.counts, { all: 2, canceled: 0, refunded: 1, active: 1, problem: 0 })
  assert.deepEqual(page, before, 'Do not mutate cached responses or historical reward fields')
  assert.deepEqual(api.dailyPlayerOrderPage(clean), clean, 'Normalization must be idempotent')
  const empty = api.dailyPlayerOrderPage({ ...page, records: [canceled], total: 1, counts: { refunded: 1 } })
  assert.equal(empty.records.length, 0); assert.equal(empty.total, 0); assert.equal(empty.counts.refunded, 0)
})

await test('legacy canceled detail is read-only and cannot construct claim/submit/retry targets', () => {
  const canceled = order({ status: 'canceled', displayStatus: 'refunded' })
  assert.equal(api.playerOrderBlockedReason(canceled).code, 'ORDER_CANCELED')
  for (const create of [() => api.dispatchTarget(canceled), () => api.assignmentTarget(canceled, 'player-a')])
    assert.throws(create, error => error.status === 409 && error.code === 'ORDER_CANCELED')
  assert.notEqual(api.orderTargetKey(canceled), api.orderTargetKey(order({ status: 'active' })))
  assert.equal(api.playerOrderBlockedReason(order({ status: 'canceled', fullRefund: true, playerOperationBlockedReason: { code: 'ORDER_REFUNDED', message: '服务器退款闭锁' } })).code, 'ORDER_REFUNDED')
  for (const [extra, code] of [[{ stored: true }, 'ORDER_STORED'], [{ problem: { status: 'open' } }, 'ORDER_PROBLEM'], [{ refundPending: true }, 'REFUND_PENDING']])
    assert.equal(api.playerOrderBlockedReason(order(extra)).code, code)
})

await test('actual API list normalization replaces an old active row after cancellation; direct detail stays readable', async () => {
  let current = order(), requests = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url })
    response.setHeader('Content-Type', 'application/json'); response.setHeader('X-Studio-User', 'player-a')
    const page = { records: [current], total: 1, current: 1, size: 20, counts: { [current.displayStatus || current.status]: 1 } }
    response.end(JSON.stringify(request.url.includes('/orders/order-a') ? current : request.url.includes('?') ? page : [current]))
  })
  const originalFetch = globalThis.fetch
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const base = `http://127.0.0.1:${server.address().port}`
    globalThis.fetch = (url, options) => originalFetch(new URL(url, base), options)
    api.setActivePinia(api.createPinia())
    const session = api.useSessionStore()
    session.acceptUser({ id: 'player-a', username: 'player-a', name: '隔离打手', role: 'player', status: 'active', maxActiveOrders: 3 })
    api.setPrincipalVerifier(id => id === session.user?.id)
    api.setRequestActorProvider(() => session.user?.id)
    const query = { current: 1, size: 20, scope: 'mine' }
    assert.equal((await api.playerApi.ordersPage(query)).records.length, 1)
    current = order({ status: 'canceled', displayStatus: 'refunded', fullRefund: true, effectiveReward: 0 })
    const refreshed = await api.playerApi.ordersPage(query)
    assert.deepEqual(refreshed.records, []); assert.equal(refreshed.total, 0); assert.equal(refreshed.counts.refunded, 0)
    assert.deepEqual(await api.playerApi.orders(), [])
    const detail = await api.playerApi.order('order-a')
    assert.equal(detail.status, 'canceled'); assert.equal(detail.reward, 1201); assert.equal(api.effectiveOrderReward(detail), 0)
    assert.equal(api.playerOrderBlockedReason(detail).code, 'ORDER_CANCELED')
    assert.ok(requests.length >= 4); assert.ok(requests.every(request => request.method === 'GET'))
  } finally {
    globalThis.fetch = originalFetch
    server.closeAllConnections()
    if (server.listening) await new Promise(done => server.close(done))
  }
})
