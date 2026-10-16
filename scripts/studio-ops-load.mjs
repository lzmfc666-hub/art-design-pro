import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createPlayerClientServer } from './player-client-server.mjs'
import { createOpsEvents } from '../server/ops-events.mjs'
import { normalizeOpsConfig } from '../server/ops-config.mjs'
import { createOpsMonitor } from '../server/ops-monitor.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'
import { readReleaseManifest } from './studio-release.mjs'

// Reuses the existing 1000-order real-disk regression fixture. No live ports,
// production data, passwords or outbound push/alert configuration is consumed.
const output = resolve(process.env.STUDIO_FINAL_QA_ROOT || '.qa/ops-closure-20261015', `load-${Date.now()}`)
mkdirSync(output, { recursive: true })
const before = sourceFingerprint(), manifest = readReleaseManifest(), token = randomUUID() + randomUUID()
const child = fork(resolve('scripts/studio-secondary-details-pressure.mjs'), ['--worker'], {
  windowsHide: true, env: { ...process.env, STUDIO_FINAL_QA_ROOT: output }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
const pending = new Map()
child.on('message', message => {
  if (message.kind === 'progress') return
  const task = pending.get(message.id); if (!task) return
  clearTimeout(task.timer); pending.delete(message.id)
  if (message.kind === 'error') task.reject(new Error('ISOLATED_FIXTURE_FAILED')); else task.resolve(message)
})
child.on('exit', () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('ISOLATED_WORKER_EXITED')) }; pending.clear() })
const rpc = (kind, extra = {}) => new Promise((done, reject) => {
  const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('ISOLATED_RPC_TIMEOUT')) }, 180000)
  pending.set(id, { resolve: done, reject, timer }); child.send({ id, kind, ...extra })
})
const round = number => Math.round(number * 100) / 100
const summary = rows => {
  const values = rows.map(row => row.ms).sort((a, b) => a - b)
  return { requests: rows.length, p50Ms: round(values[Math.max(0, Math.ceil(values.length * .5) - 1)] || 0),
    p95Ms: round(values[Math.max(0, Math.ceil(values.length * .95) - 1)] || 0), maxMs: round(values.at(-1) || 0),
    unexpectedErrors: rows.filter(row => row.status !== 200).length }
}
let ready, playerServer, monitor, events, result
try {
  ready = await rpc('start', { monitor: { token }, releaseId: manifest?.id || null })
  playerServer = createPlayerClientServer({ staticRoot: resolve('player-client/dist'),
    apiTarget: new URL('/', ready.base).href, trustedProxies: [] })
  await new Promise(done => playerServer.listen(0, '127.0.0.1', done))
  const config = normalizeOpsConfig({ format: 'studio-ops-config-v1', environment: 'test', mode: 'internal',
    startupGraceMs: 0, credentialEnv: 'ISOLATED_MONITOR_TOKEN', expectedRelease: manifest?.id || null,
    pageFingerprints: { admin: manifest?.adminFiles['index.html'] || null, player: manifest?.playerFiles['index.html'] || null },
    endpoints: { admin: new URL('/', ready.base).href, player: `http://127.0.0.1:${playerServer.address().port}/`,
      live: ready.base + '/health/live', ready: ready.base + '/health/ready', summary: ready.base + '/ops/summary' },
    storage: { opsDir: join(output, 'ops') }, diagnostics: { enabled: false } })
  events = createOpsEvents({ dbPath: join(output, 'ops/events.sqlite'), environment: 'test' })
  const monitorRequests = []
  const { probeHttp } = await import('../server/ops-probe.mjs')
  monitor = createOpsMonitor({ config, events, statePath: join(output, 'ops/state.json'), secretReader: () => token,
    async probe(target, options) { const row = await probeHttp(target, options); monitorRequests.push({
      kind: options.kind, healthy: row.healthy, durationMs: row.durationMs }); return row } })
  assert.equal((await fetch(ready.base + '/health/ready')).status, 200)
  const paths = ['/player/profile', '/player/changes', '/player/orders?current=1&size=20&scope=all',
    '/player/orders?current=2&size=20&scope=mine&keyword=', '/player/wallet?includeRecords=false',
    '/player/withdrawals?current=1&size=20', '/player/wallet/ledger?current=1&size=20']
  const phases = [], requests = []
  for (const [index, active] of [false, true, true, false].entries()) {
    const initialCount = monitorRequests.length, started = performance.now(), phaseRows = []
    if (active) monitor.start()
    let next = 0
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < 480) {
        const number = next++, admin = number % 6 === 0
        const path = admin ? '/overview/details?metric=received&view=paid-orders&start=2025-10-14&end=2026-10-14&current=1&size=20'
          : paths[number % paths.length]
        const startedRequest = performance.now(), response = await fetch(ready.base + path,
          { headers: { Cookie: admin ? ready.cookies.admin : ready.cookies.players[number % 100], 'X-Studio-Client': admin ? 'admin' : 'player' } })
        const body = await response.json()
        const row = { phase: index, kind: admin ? 'admin-detail' : 'player-read', status: response.status, ms: performance.now() - startedRequest }
        phaseRows.push(row); requests.push(row)
        assert.equal(response.status, 200)
        if (path.includes('current=')) { assert.ok(Number.isInteger(body.total)); assert.ok(body.records.length <= 20) }
      }
    }))
    // Let the immediate asynchronous monitor cycle finish; the production
    // interval remains 60s, rather than polling on every business request.
    const waitStarted = performance.now()
    while (active && monitorRequests.length === initialCount && performance.now() - waitStarted < 10000)
      await new Promise(done => setTimeout(done, 10))
    if (active) { await monitor.close(); monitor = createOpsMonitor({ config, events, statePath: join(output, 'ops/state.json'),
      secretReader: () => token, async probe(target, options) { const row = await probeHttp(target, options);
        monitorRequests.push({ kind: options.kind, healthy: row.healthy, durationMs: row.durationMs }); return row } }) }
    const elapsedMs = performance.now() - started
    phases.push({ order: index, monitorEnabled: active, concurrency: 8, elapsedMs: round(elapsedMs),
      throughputRequestsPerSecond: round(480000 / elapsedMs), monitorRequests: monitorRequests.length - initialCount,
      all: summary(phaseRows), player: summary(phaseRows.filter(row => row.kind === 'player-read')) })
  }
  assert.ok(monitorRequests.length >= 10)
  assert.ok(monitorRequests.every(row => row.healthy === true), 'every configured public and protected monitoring probe must validate')
  const snapshot = await rpc('snapshot')
  assert.deepEqual(snapshot.invariant, ready.invariant, 'read-only monitored traffic must not alter funds/orders/notifications/audit')
  assert.equal(snapshot.pushCalls, 0)
  assert.equal(events.snapshot().delivery.state, 'disabled')
  const after = sourceFingerprint(); assert.equal(before.digest, after.digest)
  result = { success: true, generatedAt: new Date().toISOString(), output, sourceBefore: before, sourceAfter: after,
    release: manifest?.id || null, counts: { orders: 1000, players: 100, customers: 50 }, intervalMs: config.intervalMs,
    totalBusinessRequests: requests.length, totalMonitorRequests: monitorRequests.length, phases,
    monitorSamples: monitorRequests,
    monitorLatency: summary(monitorRequests.map(row => ({ ms: row.durationMs, status: row.healthy ? 200 : 503 }))),
    memorySamples: snapshot.memory, monitorParentMemory: process.memoryUsage(), invariantsPreserved: true,
    externalAlertSends: 0, externalPushSends: 0,
    limitations: ['Random loopback ports and isolated real SQLite; no formal server capacity claim.',
      'Immediate cycles plus 60s timers; phases shorter than one minute are not a full-day monitoring soak.',
      'Eight request workers cannot be converted into online-user capacity.'] }
  writeFileSync(join(output, 'requests.json'), JSON.stringify(requests, null, 2))
  writeFileSync(join(output, 'report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ success: true, report: join(output, 'report.json'), phases }))
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ success: false, code: error.code || error.message,
    sourceBefore: before.digest, sourceAfter: sourceFingerprint().digest }, null, 2)); throw error
} finally {
  await monitor?.close(); await events?.close()
  if (playerServer) await new Promise(done => playerServer.close(done))
  try { await rpc('stop') } catch { child.kill() }
}
