import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const critical = (path) =>
  /^\/(?:orders(?:\/[^/]+\/action)?|refunds(?:\/[^/]+\/action)?|withdrawals\/[^/]+\/action|expenses(?:\/[^/]+\/action)?|payrolls|player-adjustments(?:\/[^/]+\/action)?|reward-reviews\/[^/]+\/action|customer-transactions|player-deposit-transactions|player\/orders\/[^/]+\/(?:claim|reject|submit|return-request|problem-feedback)|player\/withdrawals(?:\/[^/]+\/cancel)?)$/.test(
    path
  )
const serviceIntents = new WeakMap()
const fetchIntents = new Map()
const originalFetch = globalThis.fetch

function assertIsolated(service) {
  const path = service.db
    .prepare('PRAGMA database_list')
    .all()
    .find((row) => row.name === 'main')?.file
  if (!path) return
  const source = resolve(path),
    allowed = [resolve(tmpdir()), resolve('.qa')]
  if (!allowed.some((root) => source.startsWith(root + sep)))
    throw new Error('Test intent adapter refuses databases outside temporary/QA directories')
}

function identityFields(path, body, order) {
  if (!order) return {}
  const action = body.action || path.split('/').at(-1)
  const fields = { expectedRevision: order.revision }
  if (['claim', 'reject'].includes(action)) fields.dispatchRound = order.dispatchRound
  if (['release', 'submit', 'return-request', 'return-approve', 'return-reject', 'problem-feedback'].includes(action)) {
    fields.assignmentId = order.assignmentId
    fields.leaderId = order.leaderId
  }
  if (['review-pass', 'review-return'].includes(action)) fields.submissionId = order.submissionId
  if (['edit', 'adjust'].includes(action) && body.amount != null && body.amount !== order.amount) {
    fields.amountChangeKind = 'historical-correction'
    fields.affectsHistoricalReceived = order.paymentMethod !== 'balance' && order.receivedAmount > 0
  }
  return fields
}

/** Test-only explicit client adaptation. The actual service remains strict. */
export function testMutate(service, actor, path, body = {}) {
  if (!critical(path) || !body || typeof body !== 'object' || Array.isArray(body))
    return service.mutate(actor, path, body)
  assertIsolated(service)
  const requestId = body.requestId ?? randomUUID()
  let intents = serviceIntents.get(service)
  if (!intents) {
    intents = new Map()
    serviceIntents.set(service, intents)
  }
  const key = JSON.stringify([actor, path, requestId])
  let fields = intents.get(key)
  if (!fields) {
    const directOrderId = path.match(/^\/(?:player\/)?orders\/([^/]+)\//)?.[1] || (path === '/refunds' ? body.orderId : null)
    const refundId = path.match(/^\/refunds\/([^/]+)\/action$/)?.[1]
    const state = directOrderId || refundId
      ? JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
      : null
    const orderId = directOrderId || state?.refunds.find(row => row.id === refundId)?.orderId
    fields = identityFields(
      path,
      body,
      state?.orders.find((order) => order.id === orderId)
    )
    intents.set(key, fields)
  }
  return service.mutate(actor, path, { ...fields, ...body, requestId })
}

/** Install only in legacy isolated test files. New strict regressions keep raw fetch. */
export function installTestClientFetch() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (
      init?.method?.toUpperCase() !== 'POST' ||
      !url.pathname.startsWith('/api/studio/') ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
      return originalFetch(input, init)
    const path = url.pathname.slice('/api/studio'.length)
    if (!critical(path) || typeof init.body !== 'string') return originalFetch(input, init)
    if (['3006', '3007', '3008'].includes(url.port))
      throw new Error('Test HTTP adapter refuses live development ports')
    let body
    try {
      body = JSON.parse(init.body)
    } catch {
      return originalFetch(input, init)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return originalFetch(input, init)
    const headers = new Headers(init.headers),
      requestId = body.requestId ?? randomUUID()
    const key = JSON.stringify([url.origin, headers.get('cookie'), path, requestId])
    let intent = fetchIntents.get(key)
    if (!intent) {
      intent = (async () => {
        let orderId = path.match(/^\/(?:player\/)?orders\/([^/]+)\//)?.[1] || (path === '/refunds' ? body.orderId : null)
        const refundId = path.match(/^\/refunds\/([^/]+)\/action$/)?.[1]
        if (refundId) {
          const snapshotResponse = await originalFetch(`${url.origin}/api/studio/bootstrap`, { headers })
          if (snapshotResponse.ok) {
            const snapshot = await snapshotResponse.json()
            orderId = snapshot.refunds?.find(row => row.id === refundId)?.orderId
          }
        }
        if (orderId) {
          const detailPath = path.startsWith('/player/')
            ? `/player/orders/${orderId}`
            : `/orders/${orderId}`
          const response = await originalFetch(`${url.origin}/api/studio${detailPath}`, { headers })
          if (response.ok) {
            const data = await response.json(),
              order = data.order || data
            return identityFields(path, body, order)
          }
        }
        return {}
      })()
      // Reserve the initial read before yielding; concurrent retries share it.
      fetchIntents.set(key, intent)
    }
    const fields = await intent
    if (!headers.has('X-Studio-Actor')) {
      const sessionResponse = await originalFetch(`${url.origin}/api/studio/session`, { headers })
      if (sessionResponse.ok) {
        const session = await sessionResponse.json()
        if (session.user?.id) headers.set('X-Studio-Actor', session.user.id)
      }
    }
    return originalFetch(input, {
      ...init,
      headers,
      body: JSON.stringify({ ...fields, ...body, requestId })
    })
  }
}
