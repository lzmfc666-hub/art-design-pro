import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createStudioService } from '../server/studio.mjs'
import { normalizeOpsConfig } from '../server/ops-config.mjs'
import { createConfiguredMonitor } from '../scripts/studio-monitor.mjs'

const entry = fileURLToPath(new URL('../server/index.mjs', import.meta.url))
const password = 'isolated-local-binding-account-123'
const digest = value => createHash('sha256').update(value).digest('hex')
const cleanups = new WeakMap()
const after = (t, callback) => cleanups.get(t).push(callback)

async function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-local-binding-'))
  cleanups.set(t, [])
  t.after(async () => {
    for (const cleanup of cleanups.get(t).reverse()) await cleanup()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  })
  return root
}
async function availablePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  assert.ok(port < 3006 || port > 3011)
  return port
}
function databaseSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      state: digest(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json),
      sessions: digest(JSON.stringify(db.prepare('SELECT * FROM sessions ORDER BY token_hash').all())),
      funds: digest(JSON.stringify(db.prepare('SELECT * FROM fund_transactions ORDER BY rowid').all()))
    }
  } finally { db.close() }
}
function prepareDatabase(root) {
  const databasePath = join(root, 'existing.sqlite')
  const service = createStudioService({ dbPath: databasePath, password, seed: false })
  let actor, login
  try {
    actor = service.mutate('admin', '/users', {
      username: 'existing-local-user', name: '隔离保留账号', role: 'support', status: 'active',
      maxActiveOrders: 1, permissionOverrides: {}, password
    })
    service.mutate('admin', '/customers', {
      name: '隔离保留客户', contact: '', gameId: 'fixture-only', remark: '', platformId: 'xianyu'
    })
    login = service.login(actor.username, password)
  } finally { service.close() }
  return { databasePath, actor, login, before: databaseSnapshot(databasePath) }
}
function writeBinding(root, databasePath, port, extra = {}) {
  const binding = {
    format: 'studio-local-monitor-binding-v1', environment: 'local', root, host: '127.0.0.1',
    databasePath, port, token: randomBytes(32).toString('hex'), ...extra
  }
  mkdirSync(join(root, '.ops'), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, '.ops/local-monitor-binding.json'), JSON.stringify(binding), { mode: 0o600 })
  return binding
}
function startApi(t, root, databasePath, port, extraEnvironment = {}) {
  // Do not inherit the operator's credentials, push configuration or backup targets.
  const env = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    STUDIO_HOST: '127.0.0.1', STUDIO_PORT: String(port), STUDIO_DB_PATH: databasePath,
    STUDIO_DEMO: 'false', STUDIO_BACKUP_INTERVAL_MINUTES: '0', STUDIO_UPLOAD_GC_ENABLED: 'false',
    ...extraEnvironment
  }
  const child = spawn(process.execPath, [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  const exited = once(child, 'exit')
  after(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
  })
  return { child, exited, output: () => output }
}
async function waitForReady(running, base) {
  const until = Date.now() + 15000
  while (Date.now() < until) {
    assert.equal(running.child.exitCode, null, 'isolated API must stay running')
    try {
      const response = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(1000) })
      if (response.status === 200) return response.json()
    } catch {}
    await new Promise(done => setTimeout(done, 50))
  }
  assert.fail('isolated API did not become database-ready within the bounded startup wait')
}

test('本机私有绑定启动实际 API 与监控，保留原业务、账号和会话，独立身份不能访问业务', async t => {
  const root = await temporaryRoot(t)
  const existing = prepareDatabase(root), port = await availablePort()
  const binding = writeBinding(root, existing.databasePath, port)
  const running = startApi(t, root, existing.databasePath, port)
  const origin = `http://127.0.0.1:${port}`, base = origin + '/api/studio'
  const ready = await waitForReady(running, base)
  assert.equal(ready.service, 'studio-api')
  assert.deepEqual(ready.checks, { database: true })
  assert.equal((await fetch(base + '/ops/summary')).status, 401)
  const headers = { Authorization: `Bearer ${binding.token}` }
  const summaryResponse = await fetch(base + '/ops/summary', { headers })
  assert.equal(summaryResponse.status, 200)
  const summary = await summaryResponse.json()
  assert.equal(summary.source, 'actual-runtime')
  assert.equal(summary.backups.enabled, false)
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(binding.token))
  assert.equal((await fetch(base + '/orders', { headers })).status, 401)
  assert.equal((await fetch(base + '/customers', { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'must-not-create' }) })).status, 401)
  const session = await fetch(base + '/session', { headers: { Cookie: `studio_session=${existing.login.token}` } })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).user.id, existing.actor.id)

  const pageRequests = []
  const pages = createServer((request, response) => {
    pageRequests.push({ cookie: request.headers.cookie, authorization: request.headers.authorization })
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><div id="app">Isolated fixture</div></html>')
  })
  await new Promise(done => pages.listen(0, '127.0.0.1', done))
  after(t, () => new Promise(done => pages.close(done)))
  const pageOrigin = `http://127.0.0.1:${pages.address().port}`
  const config = normalizeOpsConfig({
    format: 'studio-ops-config-v1', environment: 'local', mode: 'internal', localBinding: true,
    credentialEnv: 'STUDIO_MONITOR_TOKEN', startupGraceMs: 0, timeoutMs: 2000,
    ...(ready.release ? { expectedRelease: ready.release } : {}),
    storage: { opsDir: '.ops/monitor', dbPath: existing.databasePath },
    endpoints: { admin: pageOrigin + '/admin', player: pageOrigin + '/player',
      live: base + '/health/live', ready: base + '/health/ready', summary: base + '/ops/summary' }
  }, { root })
  const previousToken = process.env.STUDIO_MONITOR_TOKEN
  delete process.env.STUDIO_MONITOR_TOKEN
  after(t, () => { if (previousToken === undefined) delete process.env.STUDIO_MONITOR_TOKEN
    else process.env.STUDIO_MONITOR_TOKEN = previousToken })
  const monitoring = createConfiguredMonitor(config)
  after(t, () => monitoring.close())
  const cycle = await monitoring.monitor.cycle()
  assert.equal(cycle.errorCode, undefined)
  assert.equal(cycle.samples, 4)
  assert.equal(cycle.failedProbes, 0)
  assert.equal(cycle.summaryAvailable, true)
  assert.equal(cycle.alertDelivery, 'disabled')
  assert.equal(pageRequests.length, 2)
  assert.ok(pageRequests.every(request => !request.cookie && !request.authorization))
  assert.deepEqual(databaseSnapshot(existing.databasePath), existing.before)
  assert.doesNotMatch(running.output(), new RegExp(binding.token))
})

test('API CLI 本机绑定与环境凭据冲突时，在开放端口前拒绝且不泄露秘密', async t => {
  const root = await temporaryRoot(t), existing = prepareDatabase(root)
  const port = await availablePort(), binding = writeBinding(root, existing.databasePath, port)
  const otherToken = randomBytes(32).toString('hex')
  const running = startApi(t, root, existing.databasePath, port, { STUDIO_MONITOR_TOKEN: otherToken })
  const [exitCode] = await Promise.race([running.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('isolated rejection timed out')), 10000).unref())])
  assert.notEqual(exitCode, 0)
  assert.match(running.output(), /LOCAL_MONITOR_BINDING_INVALID/)
  assert.doesNotMatch(running.output(), new RegExp(binding.token + '|' + otherToken))
  assert.deepEqual(databaseSnapshot(existing.databasePath), existing.before)
})

test('监控绑定拒绝凭据冲突、跨 Origin 和错误数据库范围，不降级为匿名成功', async t => {
  const root = await temporaryRoot(t), existing = prepareDatabase(root), port = await availablePort()
  const binding = writeBinding(root, existing.databasePath, port)
  const base = `http://127.0.0.1:${port}/api/studio`
  const raw = { format: 'studio-ops-config-v1', environment: 'local', mode: 'internal', localBinding: true,
    credentialEnv: 'STUDIO_MONITOR_TOKEN', storage: { opsDir: '.ops/monitor', dbPath: existing.databasePath },
    endpoints: { live: base + '/health/live', ready: base + '/health/ready', summary: base + '/ops/summary' } }
  const previousToken = process.env.STUDIO_MONITOR_TOKEN
  const otherToken = randomBytes(32).toString('hex')
  process.env.STUDIO_MONITOR_TOKEN = otherToken
  after(t, () => { if (previousToken === undefined) delete process.env.STUDIO_MONITOR_TOKEN
    else process.env.STUDIO_MONITOR_TOKEN = previousToken })
  const genericFailure = error => error.message === 'LOCAL_MONITOR_BINDING_INVALID' &&
    !error.message.includes(binding.token) && !error.message.includes(otherToken)
  assert.throws(() => createConfiguredMonitor(normalizeOpsConfig(raw, { root })), genericFailure)
  delete process.env.STUDIO_MONITOR_TOKEN
  assert.throws(() => createConfiguredMonitor(normalizeOpsConfig({ ...raw,
    endpoints: { ...raw.endpoints, ready: 'http://localhost:1/api/studio/health/ready' } }, { root })), genericFailure)
  assert.throws(() => createConfiguredMonitor(normalizeOpsConfig({ ...raw,
    storage: { ...raw.storage, dbPath: join(root, 'different.sqlite') } }, { root })), genericFailure)
  assert.deepEqual(databaseSnapshot(existing.databasePath), existing.before)
})
