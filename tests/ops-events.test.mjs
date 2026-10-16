import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createOpsEvents, isSafeOpsEvent } from '../server/ops-events.mjs'
import { createOpsWebhookSender } from '../server/ops-delivery.mjs'

const initialTime = Date.parse('2026-10-15T00:00:00.000Z')
const probe = (service = 'api', category = 'availability', healthy = false) => ({
  key: `${service}.${category}`,
  service,
  category,
  healthy,
  severity: 'critical',
  adviceCode: 'CHECK_SERVICE'
})
function fixture(t, defaults = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-ops-test-'))
  const path = join(directory, 'isolated-ops.sqlite')
  const instances = new Set()
  let time = initialTime
  const open = (options = {}) => {
    const instance = createOpsEvents({
      dbPath: path,
      environment: 'test',
      clock: () => time,
      timeoutMs: 100,
      leaseMs: 1000,
      baseRetryMs: 10,
      maxRetryMs: 100,
      ...defaults,
      ...options
    })
    instances.add(instance)
    return instance
  }
  const readRows = (sql) => {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }
  t.after(async () => {
    await Promise.all([...instances].map((instance) => instance.close()))
    const target = resolve(directory),
      intended = resolve(tmpdir())
    assert.ok(target.startsWith(intended + sep) && target !== intended)
    assert.ok(target.split(sep).at(-1).startsWith('studio-ops-test-'))
    rmSync(target, { recursive: true, force: true })
  })
  return {
    open,
    path,
    readRows,
    advance: (milliseconds) => {
      time += milliseconds
    }
  }
}
function gate() {
  let release, entered
  const waiting = new Promise((done) => {
    release = done
  })
  const started = new Promise((done) => {
    entered = done
  })
  return { waiting, started, release, entered }
}

test('ops active incident dedupe and one recovery survive reopening and independent connections', async (t) => {
  const f = fixture(t),
    first = f.open()
  assert.equal(first.observe(probe('api', 'availability', true)).changed, false)
  const failure = first.observe(probe())
  assert.equal(failure.deliveryStatus, 'disabled')
  const second = f.open()
  assert.deepEqual(second.observe(probe()), { changed: false, incidentId: failure.incidentId })
  assert.equal(second.observe({ ...probe(), severity: 'warning' }).changed, false)
  await first.close()
  const restarted = f.open()
  const recovery = restarted.observe(probe('api', 'availability', true))
  assert.equal(recovery.incidentId, failure.incidentId)
  assert.equal(restarted.observe(probe('api', 'availability', true)).changed, false)
  assert.deepEqual(
    restarted.events().map((event) => event.type),
    ['studio.ops.recovery', 'studio.ops.failure']
  )
  await restarted.close()
  const final = f.open()
  assert.equal(final.observe(probe('api', 'availability', true)).changed, false)
  assert.notEqual(final.observe(probe()).incidentId, failure.incidentId)
  assert.equal(final.snapshot().counts.events, 3)
  assert.equal(final.snapshot().activeIncidents.length, 1)
})

test('ops schema rejects private text, foreign databases and environment mismatch; unconfigured is explicitly disabled', async (t) => {
  const f = fixture(t),
    ops = f.open()
  for (const invalid of [
    { ...probe(), message: 'FAKE_CUSTOMER_998_PRIVATE' },
    { ...probe(), amount: 999 },
    { ...probe(), url: 'https://FAKE_PRIVATE_TOKEN.invalid' },
    { ...probe(), stack: 'FAKE_PRIVATE_STACK' },
    { ...probe(), key: 'api.customer-secret' },
    { ...probe(), service: 'FAKE_CUSTOMER_998_PRIVATE' },
    { ...probe(), adviceCode: 'FAKE_PRIVATE_STACK' }
  ])
    assert.throws(() => ops.observe(invalid), /OPS_EVENT_INVALID/)
  assert.equal(ops.snapshot().counts.events, 0)
  ops.observe(probe())
  assert.ok(ops.events().every(isSafeOpsEvent))
  assert.equal(ops.snapshot().delivery.state, 'disabled')
  assert.equal((await ops.flush()).claimed, 0)
  assert.equal(ops.snapshot().delivery.disabled, 1)
  assert.throws(() => f.open({ environment: 'production' }), /OPS_ENVIRONMENT_MISMATCH/)
  const foreignPath = join(resolve(f.path, '..'), 'foreign.sqlite')
  const foreign = new DatabaseSync(foreignPath)
  foreign.exec(
    'CREATE TABLE unrelated_business(id INTEGER PRIMARY KEY); INSERT INTO unrelated_business VALUES(7)'
  )
  foreign.close()
  assert.throws(() => createOpsEvents({ dbPath: foreignPath }), /OPS_DATABASE_NOT_ISOLATED/)
  const unchanged = new DatabaseSync(foreignPath)
  assert.equal(unchanged.prepare('SELECT id FROM unrelated_business').get().id, 7)
  assert.equal(
    unchanged.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'ops_%'").get().n,
    0
  )
  unchanged.close()
  await ops.close()
  assert.doesNotMatch(readFileSync(f.path).toString('utf8'), /FAKE_CUSTOMER|FAKE_PRIVATE/)
})

test('capacity reserves recovery and retention never removes active incidents; closed terminal history can be evicted', (t) => {
  const f = fixture(t, { maxEvents: 2, maxDeliveries: 2, maxIncidents: 1, retentionDays: 1 })
  const ops = f.open(),
    opened = ops.observe(probe())
  assert.deepEqual(ops.observe(probe('backup', 'backup')), {
    changed: false,
    code: 'OPS_CAPACITY_REACHED'
  })
  f.advance(90 * 86400000)
  assert.equal(ops.prune().pruned, 0)
  assert.equal(ops.snapshot().activeIncidents[0].id, opened.incidentId)
  assert.equal(ops.observe(probe('api', 'availability', true)).changed, true)
  assert.equal(ops.snapshot().counts.events, 2)
  assert.equal(ops.observe(probe('backup', 'backup')).changed, true)
  const state = ops.snapshot()
  assert.equal(state.counts.events, 1)
  assert.equal(state.counts.deliveries, 1)
  assert.equal(state.counts.incidents, 1)
  assert.equal(state.prunedIncidents, 1)
  assert.equal(state.capacityRejected, 1)
})

test('pending closed incidents cannot be discarded for capacity; successful delivery releases removable history', async (t) => {
  const f = fixture(t, { maxEvents: 2, maxDeliveries: 2, maxIncidents: 1 })
  const sent = [],
    ops = f.open({
      sender: async (event) => {
        sent.push(event.type)
        return { ok: true }
      }
    })
  ops.observe(probe())
  ops.observe(probe('api', 'availability', true))
  assert.equal(ops.observe(probe('backup', 'backup')).code, 'OPS_CAPACITY_REACHED')
  assert.equal((await ops.flush()).accepted, 2)
  assert.deepEqual(sent, ['studio.ops.failure', 'studio.ops.recovery'])
  assert.equal(ops.observe(probe('backup', 'backup')).changed, true)
})

test('rejected delivery uses bounded durable backoff, safe failure codes and same idempotency identity', async (t) => {
  const f = fixture(t),
    received = []
  let ops = f.open({
    sender: async (event, context) => {
      received.push(context.deliveryId)
      return { ok: false, code: 'https://FAKE_PRIVATE_TOKEN.invalid/secret' }
    }
  })
  const event = ops.observe(probe())
  assert.equal((await ops.flush()).failed, 1)
  assert.equal(ops.snapshot().delivery.lastErrorCode, 'DELIVERY_REJECTED')
  assert.equal(ops.snapshot().delivery.accepted, 0)
  f.advance(9)
  assert.equal((await ops.flush()).claimed, 0)
  f.advance(1)
  assert.equal((await ops.flush()).failed, 1)
  await ops.close()
  ops = f.open({
    sender: async (_, context) => {
      received.push(context.deliveryId)
      throw new Error('FAKE_PRIVATE_STACK')
    }
  })
  f.advance(19)
  assert.equal((await ops.flush()).claimed, 0)
  f.advance(1)
  assert.equal((await ops.flush()).failed, 1)
  f.advance(100000)
  assert.equal((await ops.flush()).claimed, 0)
  assert.deepEqual(received, [event.deliveryId, event.deliveryId, event.deliveryId])
  const state = ops.snapshot()
  assert.equal(state.delivery.failed, 1)
  assert.equal(state.delivery.failedAttempts, 3)
  assert.equal(state.delivery.state, 'degraded')
  assert.equal(state.delivery.lastErrorCode, 'DELIVERY_FAILED')
  assert.equal(f.readRows('SELECT attempts FROM ops_deliveries')[0].attempts, 3)
  assert.doesNotMatch(JSON.stringify(state), /FAKE_PRIVATE/)
})

test('timeout does not accept an unresolved send; closing aborts own active work and leaves durable retry', async (t) => {
  const f = fixture(t),
    firstStarted = gate()
  const timed = f.open({
    timeoutMs: 20,
    leaseMs: 200,
    sender: (_, { signal }) => {
      firstStarted.entered(signal)
      return new Promise(() => {})
    }
  })
  timed.observe(probe())
  const run = timed.flush(),
    signal = await firstStarted.started
  assert.equal((await run).failed, 1)
  assert.equal(signal.aborted, true)
  assert.equal(timed.snapshot().delivery.lastErrorCode, 'DELIVERY_TIMEOUT')
  assert.equal(timed.snapshot().delivery.accepted, 0)
  await timed.close()
  f.advance(10)
  const secondStarted = gate()
  const stopped = f.open({
    sender: (_, { signal: current }) => {
      secondStarted.entered(current)
      return new Promise(() => {})
    }
  })
  const pending = stopped.flush(),
    current = await secondStarted.started
  await stopped.close()
  assert.equal(current.aborted, true)
  assert.equal((await pending).failed, 1)
  const reopened = f.open()
  assert.equal(reopened.snapshot().delivery.pending, 1)
  assert.equal(reopened.snapshot().delivery.lastErrorCode, 'DELIVERY_ABORTED')
})

test('two independent senders lease a delivery once and recovery waits for preceding failure acceptance', async (t) => {
  const f = fixture(t),
    hold = gate(),
    calls = []
  const first = f.open({
    sender: async (event, context) => {
      calls.push([event.type, context.deliveryId])
      hold.entered()
      await hold.waiting
      return { ok: true }
    }
  })
  first.observe(probe())
  first.observe(probe('api', 'availability', true))
  const second = f.open({
    sender: async (event, context) => {
      calls.push([event.type, context.deliveryId])
      return { ok: true }
    }
  })
  const sending = first.flush()
  assert.equal(first.flush(), sending)
  await hold.started
  assert.equal((await second.flush()).claimed, 0)
  assert.equal(calls.length, 1)
  hold.release()
  assert.equal((await sending).accepted, 2)
  assert.equal((await second.flush()).claimed, 0)
  assert.deepEqual(
    calls.map(([type]) => type),
    ['studio.ops.failure', 'studio.ops.recovery']
  )
  assert.equal(first.snapshot().delivery.accepted, 2)
})

test('expired lease recovery is durable and stale lease owner cannot overwrite newer accepted result', async (t) => {
  const f = fixture(t),
    hold = gate()
  const first = f.open({
    sender: async () => {
      hold.entered()
      await hold.waiting
      return { ok: false }
    }
  })
  const original = first.observe(probe()),
    old = first.flush()
  await hold.started
  const identities = [],
    second = f.open({
      sender: async (_, context) => {
        identities.push(context.deliveryId)
        return { ok: true }
      }
    })
  f.advance(1001)
  assert.equal((await second.flush()).claimed, 0)
  assert.equal(second.snapshot().delivery.lastErrorCode, 'LEASE_EXPIRED')
  f.advance(10)
  assert.equal((await second.flush()).accepted, 1)
  hold.release()
  assert.equal((await old).stale, 1)
  assert.deepEqual(identities, [original.deliveryId])
  assert.equal(second.snapshot().delivery.accepted, 1)
  assert.equal(second.snapshot().delivery.failedAttempts, 1)
  assert.equal(second.snapshot().delivery.consecutiveFailures, 0)
})

test('alert-delivery incidents remain durable but suppressed, so delivery failures cannot recursively grow a queue', async (t) => {
  const f = fixture(t),
    ops = f.open({ sender: async () => ({ ok: false }) })
  ops.observe(probe())
  await ops.flush()
  const alert = { ...probe('alerts', 'alert-delivery'), adviceCode: 'CHECK_ALERT_DELIVERY' }
  assert.equal(ops.observe(alert).deliveryStatus, 'suppressed')
  for (let i = 0; i < 100; i++) assert.equal(ops.observe(alert).changed, false)
  assert.equal(ops.observe({ ...alert, healthy: true }).deliveryStatus, 'suppressed')
  assert.equal((await ops.flush()).claimed, 0)
  assert.equal(ops.snapshot().counts.events, 3)
  assert.equal(ops.snapshot().delivery.suppressed, 2)
  assert.equal(ops.snapshot().delivery.pending, 1)
})

test('webhook adapter rejects unsafe target and payload and does not expose resolver/fetch secrets', async (t) => {
  const f = fixture(t),
    ops = f.open()
  ops.observe(probe())
  const event = ops.events()[0],
    deliveryId = f.readRows('SELECT id FROM ops_deliveries')[0].id
  let calls = 0
  for (const raw of [
    '',
    'http://127.0.0.1:1',
    'https://user:FAKE_PRIVATE_TOKEN@example.invalid',
    'https://example.invalid/#secret'
  ]) {
    const sender = createOpsWebhookSender({
      resolveTarget: () => raw,
      fetcher: async () => {
        calls++
        return { ok: true }
      }
    })
    assert.equal((await sender(event, { deliveryId })).ok, false)
  }
  assert.equal(calls, 0)
  const throwing = createOpsWebhookSender({
    resolveTarget: () => {
      throw new Error('FAKE_PRIVATE_TOKEN')
    }
  })
  assert.deepEqual(await throwing(event, { deliveryId }), {
    ok: false,
    code: 'DELIVERY_CONFIG_INVALID'
  })
  const sent = [],
    sender = createOpsWebhookSender({
      resolveTarget: () => 'https://example.invalid/hook?token=FAKE_PRIVATE_TOKEN',
      fetcher: async (_, options) => {
        sent.push(options)
        return { ok: false }
      }
    })
  assert.equal(
    (await sender({ ...event, customer: 'FAKE_PRIVATE' }, { deliveryId })).code,
    'DELIVERY_CONFIG_INVALID'
  )
  assert.equal(
    (
      await sender(
        { ...event, id: { private: 'FAKE_PRIVATE', toString: () => event.id } },
        { deliveryId }
      )
    ).code,
    'DELIVERY_CONFIG_INVALID'
  )
  const result = await sender(event, { deliveryId })
  assert.deepEqual(result, { ok: false, code: 'DELIVERY_REJECTED' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers['Idempotency-Key'], deliveryId)
  assert.equal(sent[0].redirect, 'error')
  assert.deepEqual(JSON.parse(sent[0].body), event)
  assert.doesNotMatch(JSON.stringify(result) + sent[0].body, /FAKE_PRIVATE/)
})

test('real isolated loopback receiver observes explicit rejection then acceptance with stable id and safe body', async (t) => {
  const f = fixture(t),
    requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ id: request.headers['idempotency-key'], event: JSON.parse(body) })
    response.writeHead(requests.length === 1 ? 503 : 202).end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise((done) => server.close(done)))
  const port = server.address().port
  const ops = f.open({
    sender: async (event, { signal, deliveryId }) => {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        signal,
        headers: { 'Idempotency-Key': deliveryId },
        body: JSON.stringify(event)
      })
      return { ok: response.ok }
    }
  })
  const original = ops.observe(probe())
  assert.equal((await ops.flush()).failed, 1)
  assert.equal(ops.snapshot().delivery.accepted, 0)
  f.advance(10)
  assert.equal((await ops.flush()).accepted, 1)
  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map(({ id }) => id),
    [original.deliveryId, original.deliveryId]
  )
  assert.deepEqual(requests[0].event, requests[1].event)
  assert.ok(requests.every(({ event }) => isSafeOpsEvent(event)))
})
