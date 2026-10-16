import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createSign, generateKeyPairSync, X509Certificate, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createOpsEvents } from '../server/ops-events.mjs'
import { createOpsMonitor } from '../server/ops-monitor.mjs'
import { probeHttp } from '../server/ops-probe.mjs'
import { normalizeOpsConfig } from '../server/ops-config.mjs'

const release = 'a'.repeat(64),
  fakeToken = 'FIXTURE_MONITOR_CREDENTIAL_'.padEnd(48, 'x')
const initialTime = Date.parse('2026-10-15T00:00:00.000Z')
const clone = (value) => JSON.parse(JSON.stringify(value))
function healthyMetrics(time = initialTime) {
  return {
    status: 'ready',
    source: 'actual-runtime',
    release,
    http: {
      requests: 100,
      errors: 0,
      sampleCount: 20,
      p95Ms: 10,
      classifications: {
        unauthorized401: 0,
        forbidden403: 0,
        conflict409: 0,
        limited429: 0,
        otherClient: 0
      }
    },
    process: { rssBytes: 1000, heapUsedBytes: 500 },
    storage: { freeBytes: 10 * 1024 ** 3, walBytes: 0 },
    logs: [{ bytes: 0 }],
    push: { pendingDue: 0, oldestDueWaitMs: 0 },
    backups: {
      enabled: true,
      ageMs: 0,
      lastCompletedAt: new Date(time).toISOString(),
      lastFailureAt: null,
      lastErrorCode: null,
      replication: {
        enabled: true,
        lastSuccessAt: new Date(time).toISOString(),
        lastErrorCode: null
      }
    }
  }
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-monitor-fixture-'))
  let time = initialTime
  const controls = {
    ready: 'healthy',
    live: 'healthy',
    summaryStatus: 200,
    summaryRetainShapeOnFailure: false,
    summary: healthyMetrics(),
    diagnosticStatus: 200,
    diagnosticErrors: 0,
    token: fakeToken,
    host: null,
    requests: []
  }
  const sockets = new Set(),
    monitors = [],
    eventStores = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    controls.requests.push({
      path,
      cookiePresent: Boolean(request.headers.cookie),
      authorized: request.headers.authorization === `Bearer ${fakeToken}`
    })
    const json = (status, body) =>
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (['/admin', '/player'].includes(path))
      return response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<html><div id="app">Fixture</div></html>')
    if (path === '/live' || path === '/ready') {
      const mode = controls[path.slice(1)]
      if (mode === 'hang') return
      if (mode === 'html')
        return response
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end('<html>FAKE_PRIVATE_BODY</html>')
      if (mode === 'null') return json(200, null)
      if (mode === 'array') return json(200, [])
      if (mode === 'database')
        return json(503, {
          status: 'not-ready',
          service: 'studio-api',
          release,
          category: 'database',
          message: 'FAKE_PRIVATE_DATABASE_DETAILS'
        })
      if (mode === 'wrong') return json(200, { status: 'ready', service: 'wrong-service', release })
      if (mode === 'old')
        return json(200, {
          status: path === '/live' ? 'ok' : 'ready',
          service: 'studio-api',
          release: 'b'.repeat(64),
          checks: { database: true }
        })
      if (typeof mode === 'number')
        return json(mode, {
          status: 'ready',
          service: 'studio-api',
          release,
          checks: { database: true },
          message: 'FAKE_PRIVATE_ERROR_DETAILS'
        })
      return json(200, {
        status: path === '/live' ? 'ok' : 'ready',
        service: 'studio-api',
        release,
        checks: { database: true }
      })
    }
    if (path === '/summary') {
      if (controls.summaryStatus !== 200 && !controls.summaryRetainShapeOnFailure)
        return json(controls.summaryStatus, {
          code: 'REJECTED',
          message: 'FAKE_PRIVATE_AUTH_DETAILS'
        })
      return json(controls.summaryStatus, controls.summary)
    }
    if (path === '/diagnostics')
      return json(controls.diagnosticStatus, {
        source: 'actual-diagnostics',
        release,
        generatedAt: new Date(time).toISOString(),
        errorCount: controls.diagnosticErrors,
        warningCount: 0
      })
    if (path === '/redirect') return response.writeHead(302, { Location: '/not-followed' }).end()
    if (path === '/oversized')
      return response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('x'.repeat(1048577))
    json(404, { code: 'FIXTURE_NOT_FOUND' })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  const rawConfig = {
    format: 'studio-ops-config-v1',
    environment: 'test',
    mode: 'internal',
    expectedRelease: release,
    credentialEnv: 'STUDIO_MONITOR_TOKEN',
    storage: { opsDir: '.ops' },
    startupGraceMs: 0,
    failureThreshold: 3,
    recoveryThreshold: 2,
    timeoutMs: 100,
    intervalMs: 1000,
    endpoints: {
      admin: base + '/admin',
      player: base + '/player',
      live: base + '/live',
      ready: base + '/ready',
      summary: base + '/summary',
      diagnostics: base + '/diagnostics'
    },
    diagnostics: { enabled: false, hoursUTC: [0], intervalMs: 60000 },
    maintenance: []
  }
  const config = normalizeOpsConfig(rawConfig, { root })
  const statePath = join(root, 'state.json'),
    dbPath = join(root, 'ops.sqlite')
  function open(options = {}) {
    const events = createOpsEvents({
      dbPath,
      environment: 'test',
      clock: () => time,
      ...options.events
    })
    const monitor = createOpsMonitor({
      config,
      events,
      statePath,
      clock: () => time,
      secretReader: () => controls.token,
      hostSample: () => controls.host,
      ...options.monitor
    })
    eventStores.push(events)
    monitors.push(monitor)
    return { events, monitor }
  }
  t.after(async () => {
    for (const monitor of monitors) await monitor.close()
    for (const events of eventStores) await events.close()
    for (const socket of sockets) socket.destroy()
    await new Promise((done) => server.close(done))
    const target = resolve(root),
      intended = resolve(tmpdir())
    assert.ok(target.startsWith(intended + sep) && target !== intended)
    assert.ok(target.split(sep).at(-1).startsWith('studio-monitor-fixture-'))
    rmSync(target, { recursive: true, force: true })
  })
  const advance = (ms) => {
    time += ms
  }
  const cycle = async (monitor, n = 1, step = 1000) => {
    for (let index = 0; index < n; index++) {
      await monitor.cycle()
      advance(step)
    }
  }
  return {
    root,
    controls,
    server,
    base,
    config,
    rawConfig,
    statePath,
    open,
    advance,
    cycle,
    now: () => time
  }
}
const incident = (events, key) => events.snapshot().activeIncidents.find((row) => row.key === key)
const transitions = (events, key) =>
  events
    .events({ limit: 1000 })
    .filter((row) => row.key === key)
    .map((row) => row.type)

test('config rejects invalid numeric controls, unsafe public targets/secrets and static ops paths including existing junction', async (t) => {
  const f = await fixture(t)
  const invalid = [
    { intervalMs: -1 },
    { timeoutMs: NaN },
    { failureThreshold: 0 },
    { recoveryThreshold: -1 },
    { thresholds: { p95Ms: -1 } },
    { thresholds: { serverErrorRate: 2 } },
    { thresholds: { diskFreeBytes: NaN } },
    { thresholds: { arbitrarySecretThreshold: 1 } },
    { diagnostics: { hoursUTC: [24] } },
    { diagnostics: { intervalMs: -1 } },
    { maintenance: [{ start: 'bad', end: 'bad' }] },
    { endpoints: { ready: 'http://public.example.invalid/ready' } },
    { endpoints: { ready: 'https://user:FAKE_PRIVATE_SECRET@example.invalid' } },
    { endpoints: { ready: 'https://example.invalid/ready?token=FAKE_PRIVATE_SECRET' } },
    { endpoints: { ready: 'https://example.invalid/#FAKE_PRIVATE_SECRET' } },
    { environment: 'production', endpoints: { ready: f.base + '/ready' } },
    ...['dist/ops', 'public/ops', 'player-client/dist/ops', 'player-client/public/ops'].map(
      (opsDir) => ({ storage: { opsDir } })
    )
  ]
  for (const patch of invalid)
    assert.throws(
      () => normalizeOpsConfig({ ...f.rawConfig, ...patch }, { root: f.root }),
      /^Error: OPS_CONFIG_INVALID$/
    )
  mkdirSync(join(f.root, 'public'))
  symlinkSync(join(f.root, 'public'), join(f.root, 'private-named-alias'), 'junction')
  assert.throws(
    () =>
      normalizeOpsConfig(
        { ...f.rawConfig, storage: { opsDir: 'private-named-alias/new-ops' } },
        { root: f.root }
      ),
    /OPS_CONFIG_INVALID/
  )
  assert.equal(f.config.failureThreshold, 3)
  assert.equal(f.config.recoveryThreshold, 2)
})

test('real loopback page/live/ready distinguish frontend availability from database health, malformed/HTML/version and auth statuses', async (t) => {
  const f = await fixture(t),
    options = { expectedRelease: release, timeoutMs: 100 }
  f.controls.ready = 'database'
  assert.equal((await probeHttp(f.base + '/admin', { ...options, kind: 'page' })).healthy, true)
  assert.equal((await probeHttp(f.base + '/live', { ...options, kind: 'live' })).healthy, true)
  assert.equal((await probeHttp(f.base + '/ready', options)).code, 'DATABASE_NOT_READY')
  for (const mode of ['html', 'null', 'array', 'wrong', 'old']) {
    f.controls.ready = mode
    const result = await probeHttp(f.base + '/ready', options)
    assert.equal(result.healthy, false)
    assert.doesNotMatch(JSON.stringify(result), /FAKE_PRIVATE/)
    if (mode === 'old') assert.equal(result.code, 'RELEASE_MISMATCH')
    if (['null', 'array', 'html'].includes(mode)) assert.equal(result.code, 'JSON_CONTENT')
  }
  for (const [status, code] of [
    [401, 'CREDENTIALS_INVALID'],
    [403, 'CREDENTIALS_INVALID'],
    [429, 'PROBE_RATE_LIMITED']
  ]) {
    f.controls.ready = status
    const result = await probeHttp(f.base + '/ready', options)
    assert.equal(result.healthy, false)
    assert.equal(result.code, code)
  }
  f.controls.ready = 409
  assert.equal((await probeHttp(f.base + '/ready', options)).healthy, false)
  assert.equal((await probeHttp(null)).healthy, null)
  assert.ok(f.controls.requests.every((row) => !row.cookiePresent))
})

test('real HTTP timeout/body cap/redirect are bounded and do not follow a second target', async (t) => {
  const f = await fixture(t)
  f.controls.ready = 'hang'
  assert.equal((await probeHttp(f.base + '/ready', { timeoutMs: 50 })).code, 'TIMEOUT')
  assert.equal((await probeHttp(f.base + '/oversized', { timeoutMs: 100 })).code, 'BODY_LIMIT')
  assert.equal((await probeHttp(f.base + '/redirect', { timeoutMs: 100 })).code, 'REDIRECT')
  assert.equal(f.controls.requests.filter((row) => row.path === '/not-followed').length, 0)
})

test('monitor uses three bad API cycles and two successful recoveries across both process-state and ops database reopen', async (t) => {
  const f = await fixture(t)
  f.controls.token = null
  f.controls.ready = 'database'
  let pair = f.open()
  await f.cycle(pair.monitor, 2)
  assert.equal(pair.events.snapshot().counts.events, 0)
  assert.equal(pair.monitor.snapshot().observations['api.availability'].failures, 2)
  assert.equal(pair.monitor.snapshot().observations['admin.availability'].healthy, true)
  await pair.monitor.close()
  await pair.events.close()
  pair = f.open()
  await f.cycle(pair.monitor)
  assert.ok(incident(pair.events, 'api.availability'))
  assert.equal(incident(pair.events, 'api.availability').adviceCode, 'CHECK_DATABASE')
  f.controls.ready = 'healthy'
  await f.cycle(pair.monitor)
  assert.ok(incident(pair.events, 'api.availability'))
  await pair.monitor.close()
  await pair.events.close()
  pair = f.open()
  await f.cycle(pair.monitor)
  assert.equal(incident(pair.events, 'api.availability'), undefined)
  assert.deepEqual(transitions(pair.events, 'api.availability'), [
    'studio.ops.recovery',
    'studio.ops.failure'
  ])
  assert.doesNotMatch(readFileSync(f.statePath, 'utf8'), /FAKE_PRIVATE|FIXTURE_MONITOR_CREDENTIAL/)
})

test('startup grace suppresses incidents and maintenance neither probes nor falsely recovers an active failure', async (t) => {
  const f = await fixture(t)
  f.controls.token = null
  f.controls.ready = 'database'
  f.config.startupGraceMs = 60000
  const { monitor, events } = f.open()
  await f.cycle(monitor, 3)
  assert.equal(events.snapshot().counts.events, 0)
  f.advance(60000)
  await f.cycle(monitor)
  assert.ok(incident(events, 'api.availability'))
  f.config.maintenance = [{ start: f.now(), end: f.now() + 60000 }]
  const before = f.controls.requests.length
  const maintenance = await monitor.cycle()
  assert.equal(maintenance.maintenance, true)
  assert.equal(f.controls.requests.length, before)
  assert.equal(monitor.snapshot().observations['api.availability'].failures, 0)
  assert.ok(incident(events, 'api.availability'))
  assert.equal(transitions(events, 'api.availability').length, 1)
  f.advance(60000)
  f.controls.ready = 'healthy'
  await f.cycle(monitor)
  assert.ok(incident(events, 'api.availability'))
  await f.cycle(monitor)
  assert.equal(incident(events, 'api.availability'), undefined)
})

test('lost/malformed summary changes prior metric success to unknown and cannot resolve an existing incident', async (t) => {
  const f = await fixture(t),
    { monitor, events } = f.open()
  f.controls.summary.storage.freeBytes = 0
  await f.cycle(monitor, 3)
  assert.ok(incident(events, 'storage.disk'))
  assert.equal(monitor.snapshot().observations['api.resource'].healthy, true)
  f.controls.token = null
  await f.cycle(monitor)
  for (const key of [
    'api.resource',
    'api.error-rate',
    'api.slow-response',
    'api.push-backlog',
    'storage.disk',
    'storage.wal',
    'backup.backup',
    'backup.backup-stale',
    'replication.replication'
  ]) {
    assert.equal(monitor.snapshot().observations[key].healthy, null, key)
    assert.equal(monitor.snapshot().observations[key].state, 'unknown', key)
  }
  assert.ok(incident(events, 'storage.disk'))
  assert.equal(transitions(events, 'storage.disk').length, 1)
  f.controls.token = fakeToken
  f.controls.summary = { ...healthyMetrics(f.now()), storage: undefined }
  await f.cycle(monitor)
  assert.equal(monitor.snapshot().lastRun.summaryAvailable, false)
  assert.equal(monitor.snapshot().observations['storage.disk'].healthy, null)
  assert.ok(incident(events, 'storage.disk'))
})

test('401/403/409/429 classifications do not count as server errors; delta reset/sample minimum remain unknown', async (t) => {
  const f = await fixture(t),
    { monitor, events } = f.open(),
    metrics = f.controls.summary
  metrics.http.sampleCount = 0
  metrics.http.p95Ms = 10000
  await f.cycle(monitor)
  for (let index = 0; index < 3; index++) {
    metrics.http.requests += 100
    for (const key of ['unauthorized401', 'forbidden403', 'conflict409', 'limited429'])
      metrics.http.classifications[key] += 20
    await f.cycle(monitor)
  }
  assert.equal(incident(events, 'api.error-rate'), undefined)
  assert.equal(monitor.snapshot().observations['api.error-rate'].healthy, true)
  assert.equal(monitor.snapshot().observations['api.slow-response'].healthy, null)
  for (let index = 0; index < 3; index++) {
    metrics.http.requests += 100
    metrics.http.errors += 10
    await f.cycle(monitor)
  }
  assert.ok(incident(events, 'api.error-rate'))
  metrics.http.requests = 10
  metrics.http.errors = 0
  await f.cycle(monitor)
  assert.equal(monitor.snapshot().observations['api.error-rate'].healthy, null)
  assert.ok(incident(events, 'api.error-rate'))
  for (let index = 0; index < 2; index++) {
    metrics.http.requests += 100
    await f.cycle(monitor)
  }
  assert.equal(incident(events, 'api.error-rate'), undefined)
  metrics.http.sampleCount = 20
  await f.cycle(monitor, 3)
  assert.ok(incident(events, 'api.slow-response'))
})

test('disk/WAL/log/resource/push/backup/stale/replica/supervisor indicators alarm and recover from genuine later samples', async (t) => {
  const f = await fixture(t),
    { monitor, events } = f.open(),
    metrics = f.controls.summary,
    thresholds = f.config.thresholds
  metrics.storage.freeBytes = 0
  metrics.storage.walBytes = thresholds.walBytes + 1
  metrics.logs[0].bytes = thresholds.logBytes + 1
  metrics.process.rssBytes = thresholds.rssBytes + 1
  metrics.push = { pendingDue: 1, oldestDueWaitMs: thresholds.pushDueWaitMs + 1 }
  metrics.backups.lastFailureAt = new Date(f.now()).toISOString()
  metrics.backups.lastCompletedAt = new Date(f.now() - thresholds.backupAgeMs - 1).toISOString()
  metrics.backups.lastErrorCode = 'BACKUP_FAILED'
  metrics.backups.replication.lastSuccessAt = new Date(
    f.now() - thresholds.replicationAgeMs - 1
  ).toISOString()
  metrics.backups.replication.lastErrorCode = 'REPLICATION_FAILED'
  f.controls.host = { managerHealthy: false, restartBudgetExhausted: true, logBytes: 0 }
  for (let index = 0; index < 2; index++) {
    await f.cycle(monitor)
    assert.equal(monitor.snapshot().observations['storage.log-capacity'].failures, index + 1)
    assert.equal(incident(events, 'storage.log-capacity'), undefined)
  }
  await f.cycle(monitor)
  const keys = [
    'storage.disk',
    'storage.wal',
    'storage.log-capacity',
    'api.resource',
    'api.push-backlog',
    'backup.backup',
    'backup.backup-stale',
    'replication.replication',
    'supervisor.availability',
    'supervisor.restart-budget'
  ]
  for (const key of keys) assert.ok(incident(events, key), key)
  metrics.logs[0].bytes = 0
  f.controls.host.logBytes = thresholds.logBytes + 1
  await f.cycle(monitor, 2)
  assert.ok(incident(events, 'storage.log-capacity'))
  assert.equal(transitions(events, 'storage.log-capacity').length, 1)
  Object.assign(metrics, healthyMetrics(f.now()))
  // Scheduler's last failure code can remain historic after an actual later completed backup.
  metrics.backups.lastErrorCode = 'BACKUP_FAILED'
  metrics.backups.lastFailureAt = new Date(f.now() - 1000).toISOString()
  f.controls.host = { managerHealthy: true, restartBudgetExhausted: false, logBytes: 0 }
  await f.cycle(monitor, 2)
  for (const key of keys) assert.equal(incident(events, key), undefined, key)
})

test('API/monitor restart cannot reset durable backup age after a known success or a never-successful first observation', async (t) => {
  for (const hadSuccess of [true, false]) {
    const f = await fixture(t),
      metrics = f.controls.summary
    metrics.backups.lastCompletedAt = hadSuccess ? new Date(initialTime).toISOString() : null
    let pair = f.open()
    await f.cycle(pair.monitor)
    assert.equal(pair.monitor.snapshot().backupEnabledAt, initialTime)
    assert.equal(pair.monitor.snapshot().backupSuccessAt, hadSuccess ? initialTime : undefined)
    f.advance(60000)
    // A fresh API process loses its in-memory completion metric and starts age/count at zero.
    metrics.http.requests = 1
    metrics.http.errors = 0
    metrics.backups.lastCompletedAt = null
    metrics.backups.ageMs = 0
    await f.cycle(pair.monitor)
    await pair.monitor.close()
    await pair.events.close()
    f.advance(f.config.thresholds.backupAgeMs + 1000)
    pair = f.open()
    assert.equal(pair.monitor.snapshot().backupEnabledAt, initialTime)
    assert.equal(pair.monitor.snapshot().backupSuccessAt, hadSuccess ? initialTime : undefined)
    await f.cycle(pair.monitor)
    assert.equal(pair.monitor.snapshot().observations['backup.backup-stale'].healthy, false)
    await f.cycle(pair.monitor, 2)
    assert.ok(incident(pair.events, 'backup.backup-stale'))
    assert.equal(incident(pair.events, 'backup.backup-stale').adviceCode, 'CHECK_BACKUP')
  }
})

test('protected summary rejection alarms credentials separately and is never echoed with token or private error content', async (t) => {
  const f = await fixture(t),
    { monitor, events } = f.open()
  await f.cycle(monitor)
  f.controls.summaryStatus = 401
  await f.cycle(monitor, 3)
  assert.ok(incident(events, 'monitor.credentials'))
  assert.equal(monitor.snapshot().observations['api.resource'].healthy, null)
  assert.equal(monitor.snapshot().lastRun.summaryAvailable, false)
  assert.ok(
    f.controls.requests
      .filter((row) => row.path === '/summary')
      .every((row) => row.authorized && !row.cookiePresent)
  )
  assert.doesNotMatch(
    readFileSync(f.statePath, 'utf8') + JSON.stringify(events.snapshot()),
    /FIXTURE_MONITOR_CREDENTIAL|FAKE_PRIVATE/
  )
  f.controls.summaryStatus = 200
  await f.cycle(monitor, 2)
  assert.equal(incident(events, 'monitor.credentials'), undefined)
})

test('summary typed metrics require success status and reject malformed null rows without hanging or returning private body', async (t) => {
  const f = await fixture(t),
    options = { kind: 'summary', token: fakeToken, expectedRelease: release, timeoutMs: 100 }
  f.controls.summaryStatus = 503
  f.controls.summaryRetainShapeOnFailure = true
  const unavailable = await probeHttp(f.base + '/summary', options)
  assert.equal(unavailable.healthy, false)
  assert.equal(unavailable.metrics, undefined)
  f.controls.summaryStatus = 200
  const malformed = [
    null,
    { ...healthyMetrics(), logs: [null] },
    { ...healthyMetrics(), storage: { freeBytes: -1, walBytes: 0 } },
    { ...healthyMetrics(), http: { ...healthyMetrics().http, requests: 1, errors: 2 } }
  ]
  for (const body of malformed) {
    f.controls.summary = body
    const result = await probeHttp(f.base + '/summary', options)
    assert.equal(result.healthy, false)
    assert.equal(result.metrics, undefined)
  }
})

test('monitor observes durable alert delivery degradation and recovery without sending its own failure incident', async (t) => {
  const f = await fixture(t),
    received = []
  let accepts = false
  f.controls.ready = 'database'
  const { monitor, events } = f.open({
    events: {
      sender: async (event) => {
        received.push(event.category)
        return { ok: accepts }
      }
    }
  })
  await f.cycle(monitor, 5)
  assert.ok(incident(events, 'alerts.alert-delivery'))
  assert.equal(monitor.snapshot().lastRun.alertDelivery, 'degraded')
  assert.ok(received.length > 0)
  assert.ok(received.every((category) => category !== 'alert-delivery'))
  accepts = true
  f.controls.ready = 'healthy'
  f.advance(30000)
  await f.cycle(monitor, 2)
  assert.equal(incident(events, 'alerts.alert-delivery'), undefined)
  assert.ok(received.every((category) => category !== 'alert-delivery'))
})

test('scheduled diagnostics explicitly report one confirmed error and need two later successful diagnostic executions to recover', async (t) => {
  const f = await fixture(t),
    { monitor, events } = f.open()
  f.config.diagnostics.enabled = true
  f.controls.diagnosticErrors = 1
  await f.cycle(monitor)
  assert.ok(incident(events, 'diagnostics.diagnostics'))
  assert.equal(incident(events, 'diagnostics.diagnostics').adviceCode, 'CHECK_DIAGNOSTICS')
  const reads = f.controls.requests.filter((row) => row.path === '/diagnostics').length
  await f.cycle(monitor)
  assert.equal(f.controls.requests.filter((row) => row.path === '/diagnostics').length, reads)
  f.controls.diagnosticErrors = 0
  f.advance(60000)
  await f.cycle(monitor)
  assert.ok(incident(events, 'diagnostics.diagnostics'))
  f.advance(60000)
  await f.cycle(monitor)
  assert.equal(incident(events, 'diagnostics.diagnostics'), undefined)
  assert.deepEqual(transitions(events, 'diagnostics.diagnostics'), [
    'studio.ops.recovery',
    'studio.ops.failure'
  ])
  assert.ok(
    f.controls.requests.filter((row) => row.path === '/diagnostics').every((row) => row.authorized)
  )
})

test('failed diagnostics transport cannot recover an error and still respects the configured attempt interval', async (t) => {
  const f = await fixture(t),
    { monitor, events } = f.open()
  f.config.diagnostics.enabled = true
  f.controls.diagnosticErrors = 1
  await f.cycle(monitor)
  assert.ok(incident(events, 'diagnostics.diagnostics'))
  f.controls.diagnosticErrors = 0
  f.controls.diagnosticStatus = 503
  f.advance(60000)
  await f.cycle(monitor)
  assert.equal(monitor.snapshot().observations['diagnostics.diagnostics'].healthy, null)
  assert.ok(incident(events, 'diagnostics.diagnostics'))
  const afterFailure = f.controls.requests.filter((row) => row.path === '/diagnostics').length
  await f.cycle(monitor)
  assert.equal(
    f.controls.requests.filter((row) => row.path === '/diagnostics').length,
    afterFailure
  )
  f.advance(60000)
  await f.cycle(monitor)
  assert.ok(incident(events, 'diagnostics.diagnostics'))
  assert.equal(transitions(events, 'diagnostics.diagnostics').length, 1)
})

test('certificate-day monitor threshold uses three failing metrics and two fresh successes', async (t) => {
  const f = await fixture(t)
  let days = 2
  const { monitor, events } = f.open({
    monitor: {
      probe: async (target, options) => ({
        ...(await probeHttp(target, options)),
        certificateDays: options.kind === 'page' ? days : null
      })
    }
  })
  await f.cycle(monitor, 2)
  assert.equal(incident(events, 'certificate.certificate'), undefined)
  await f.cycle(monitor)
  assert.equal(incident(events, 'certificate.certificate').severity, 'warning')
  days = 90
  await f.cycle(monitor, 2)
  assert.equal(incident(events, 'certificate.certificate'), undefined)
})

test('monitor state sanitizes restart input, bounds history and does not copy arbitrary stored private fields', async (t) => {
  const f = await fixture(t)
  writeFileSync(
    f.statePath,
    JSON.stringify({
      format: 'studio-monitor-state-v1',
      observations: {
        'api.availability': {
          healthy: true,
          failures: 0,
          successes: 2,
          observedAt: new Date(initialTime).toISOString(),
          state: 'healthy',
          password: 'FAKE_PRIVATE_SECRET'
        },
        'private.customer': {
          healthy: true,
          failures: 0,
          successes: 0,
          private: 'FAKE_PRIVATE_SECRET'
        }
      },
      history: [{ private: 'FAKE_PRIVATE_SECRET' }],
      extra: 'FAKE_PRIVATE_SECRET'
    })
  )
  const { monitor, events } = f.open({
    monitor: { secretReader: () => null, probe: async () => ({ healthy: true, code: 'FIXTURE' }) }
  })
  assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /FAKE_PRIVATE|password|private\.customer/)
  await f.cycle(monitor, 110)
  const state = monitor.snapshot()
  assert.equal(state.history.length, 100)
  assert.ok(Object.keys(state.observations).length <= 100)
  assert.equal(events.snapshot().counts.events, 0)
  assert.doesNotMatch(readFileSync(f.statePath, 'utf8'), /FAKE_PRIVATE/)
})

// Build a fresh test-only self-signed certificate with Node crypto, without tools,
// global trust changes, stored keys, or copied credentials from the environment.
function ephemeralCertificate({ expired = false } = {}) {
  const length = (n) => {
    if (n < 128) return Buffer.from([n])
    const bytes = []
    for (; n; n >>= 8) bytes.unshift(n & 255)
    return Buffer.from([128 | bytes.length, ...bytes])
  }
  const der = (tag, content) => Buffer.concat([Buffer.from([tag]), length(content.length), content])
  const seq = (...items) => der(0x30, Buffer.concat(items)),
    set = (...items) => der(0x31, Buffer.concat(items))
  const integer = (n) => der(2, Buffer.from([n])),
    bool = (value) => der(1, Buffer.from([value ? 255 : 0]))
  const oid = (hex) => Buffer.from(hex, 'hex'),
    octet = (content) => der(4, content)
  const algorithm = seq(oid('06092a864886f70d01010b'), Buffer.from([5, 0]))
  const commonName = seq(set(seq(oid('0603550403'), der(12, Buffer.from('localhost')))))
  const when = (value) =>
    der(
      24,
      Buffer.from(
        new Date(value)
          .toISOString()
          .replace(/[-:T]/g, '')
          .replace(/\.\d{3}/, '')
      )
    )
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const serial = randomBytes(8)
  serial[0] = serial[0] & 0x7f || 1
  const now = Date.now(),
    validity = expired
      ? seq(when(now - 3 * 86400000), when(now - 86400000))
      : seq(when(now - 60000), when(now + 2 * 86400000))
  const extensions = der(
    0xa3,
    seq(
      seq(oid('0603551d13'), bool(true), octet(seq(bool(true)))),
      seq(
        oid('0603551d11'),
        octet(seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1]))))
      )
    )
  )
  const tbs = seq(
    der(0xa0, integer(2)),
    der(2, serial),
    algorithm,
    commonName,
    validity,
    commonName,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions
  )
  const signature = createSign('RSA-SHA256').update(tbs).sign(privateKey)
  const certificate = seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), signature])))
  const pem =
    '-----BEGIN CERTIFICATE-----\n' +
    certificate
      .toString('base64')
      .match(/.{1,64}/g)
      .join('\n') +
    '\n-----END CERTIFICATE-----\n'
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem }
}

test('real ephemeral loopback TLS checks trusted certificate expiry days and rejects untrusted/expired certificates', async (t) => {
  for (const expired of [false, true]) {
    const certificate = ephemeralCertificate({ expired })
    const parsed = new X509Certificate(certificate.cert)
    assert.ok(Number.isFinite(Date.parse(parsed.validTo)))
    assert.equal(Date.parse(parsed.validTo) < Date.now(), expired)
    const server = createHttpsServer(certificate, (_, response) =>
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          status: 'ready',
          service: 'studio-api',
          release,
          checks: { database: true }
        })
      )
    )
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    t.after(() => new Promise((done) => server.close(done)))
    const url = `https://127.0.0.1:${server.address().port}/ready`
    const trusted = await probeHttp(url, {
      ca: certificate.cert,
      expectedRelease: release,
      timeoutMs: 1000
    })
    if (expired) assert.equal(trusted.code, 'CERTIFICATE_INVALID')
    else {
      assert.equal(trusted.healthy, true, JSON.stringify(trusted))
      assert.ok(trusted.certificateDays >= 0 && trusted.certificateDays <= 2)
      const untrusted = await probeHttp(url, { expectedRelease: release, timeoutMs: 1000 })
      assert.equal(untrusted.healthy, false)
      assert.equal(untrusted.code, 'CERTIFICATE_INVALID')
    }
  }
})
