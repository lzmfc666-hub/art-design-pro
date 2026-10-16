import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer, connect } from 'node:net'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'

const cli = fileURLToPath(new URL('../scripts/studio-monitor.mjs', import.meta.url))
const reservedPorts = new Set([3006, 3007, 3008, 3009, 3010, 3011])
const release = 'd'.repeat(64)
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const bounded = async (promise, message, timeoutMs = 8000) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function until(predicate, message, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(20)
  }
  assert.fail(message)
}
const parseOutput = output => JSON.parse(output.trim())

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-monitor-cli-test-'))
  const children = [], servers = [], sockets = new Set(), requests = []
  const controls = { ready: false }
  t.after(async () => {
    // Only exact child objects launched by this test can be terminated.
    for (const entry of children) {
      if (!entry.closed) entry.child.kill()
      await bounded(entry.completed, 'Owned monitor child did not close').catch(error => {
        if (!entry.closed) entry.child.kill('SIGKILL')
        throw error
      })
    }
    for (const socket of sockets) socket.destroy()
    for (const server of servers) if (server.listening) await new Promise(done => server.close(done))
    const absolute = resolve(directory)
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep + 'studio-monitor-cli-test-'))
    rmSync(absolute, { recursive: true, force: true })
  })
  const track = server => {
    servers.push(server)
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    return server
  }
  const listenRandom = async server => {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const port = server.address().port
    assert.equal(reservedPorts.has(port), false, 'The fixture must not use an everyday service port')
    return port
  }
  const http = track(createHttpServer((request, response) => {
    requests.push({ path: request.url, method: request.method,
      authorization: Boolean(request.headers.authorization), cookie: Boolean(request.headers.cookie) })
    if (['/admin', '/player'].includes(request.url))
      return response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html><body><div id="app">Isolated fixture</div></body></html>')
    if (request.url === '/live')
      return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', service: 'studio-api', release }))
    if (request.url === '/ready')
      return response.writeHead(controls.ready ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(controls.ready
        ? { status: 'ready', service: 'studio-api', release, checks: { database: true } }
        : { status: 'not-ready', service: 'studio-api', release, category: 'database', adviceCode: 'CHECK_DATABASE' }))
    response.writeHead(404).end()
  }))
  const base = `http://127.0.0.1:${await listenRandom(http)}`
  const freePort = async () => {
    const probe = track(createTcpServer()), port = await listenRandom(probe)
    await new Promise(done => probe.close(done))
    return port
  }
  const config = async (name, port) => {
    port ??= await freePort()
    const opsDir = join(directory, name)
    mkdirSync(opsDir)
    const configPath = join(directory, name + '.json')
    writeFileSync(configPath, JSON.stringify({ format: 'studio-ops-config-v1', environment: 'test', mode: 'external',
      expectedRelease: release, credentialEnv: null, monitorLockPort: port,
      startupGraceMs: 0, failureThreshold: 1, recoveryThreshold: 1, timeoutMs: 500, intervalMs: 200,
      storage: { opsDir }, endpoints: { admin: base + '/admin', player: base + '/player', live: base + '/live', ready: base + '/ready' },
      diagnostics: { enabled: false, hoursUTC: [], intervalMs: 60000 }, maintenance: [],
      alerts: { authorized: false, targetEnv: null } }, null, 2))
    return { path: configPath, opsDir, port, ownerPath: join(opsDir, 'monitor-owner.json'), statePath: join(opsDir, 'monitor-state.json') }
  }
  const launch = (settings, args = []) => {
    const child = spawn(process.execPath, [cli, '--config', settings.path, ...args], {
      cwd: directory, env: {}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    const entry = { child, closed: false, stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { entry.stdout += chunk })
    child.stderr.on('data', chunk => { entry.stderr += chunk })
    entry.completed = new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { entry.closed = true; done({ code, signal, stdout: entry.stdout, stderr: entry.stderr }) })
    })
    children.push(entry)
    return entry
  }
  const run = async (settings, args) => bounded(launch(settings, args).completed, 'Monitor CLI command did not finish')
  const status = async settings => {
    const result = await run(settings, ['--status'])
    assert.equal(result.code, 0)
    return parseOutput(result.stdout)
  }
  const start = async settings => {
    const entry = launch(settings)
    await until(() => entry.closed ? assert.fail('Isolated monitor exited before startup') : entry.stdout.includes('"enabled":true'), 'Daemon never reported startup')
    assert.deepEqual(parseOutput(entry.stdout), { enabled: true, scope: 'external', environment: 'test',
      intervalMs: 200, realDeliveryEnabled: false, externalHostVerified: false })
    const sampled = await until(async () => {
      const value = await status(settings)
      return value.enabled && value.sampled ? value : null
    }, 'Daemon did not complete a sample and authenticated status handshake')
    assert.equal(sampled.summaryAvailable, undefined)
    assert.equal(sampled.lastRun.summaryAvailable, false)
    const owner = JSON.parse(readFileSync(settings.ownerPath, 'utf8'))
    assert.equal(owner.pid, entry.child.pid)
    assert.equal(owner.kind, 'studio-monitor')
    assert.equal(owner.root, resolve(directory))
    assert.equal(owner.port, settings.port)
    return entry
  }
  return { directory, controls, requests, sockets, config, launch, run, status, start, track, listenRandom }
}

test('真实monitor CLI启动/采样/身份握手可用，故障仅写隔离事件且默认发送器disabled', { timeout: 20000 }, async t => {
  const f = await fixture(t), settings = await f.config('first')
  const daemon = await f.start(settings)
  assert.equal(daemon.closed, false)
  const state = JSON.parse(readFileSync(settings.statePath, 'utf8'))
  assert.equal(state.lastRun.alertDelivery, 'disabled')
  const db = new DatabaseSync(join(settings.opsDir, 'events.sqlite'), { readOnly: true })
  try {
    assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n) > 0)
    const deliveries = db.prepare('SELECT status,attempts FROM ops_deliveries').all()
    assert.ok(deliveries.length > 0)
    assert.ok(deliveries.every(row => row.status === 'disabled' && row.attempts === 0))
  } finally { db.close() }
  assert.ok(f.requests.length >= 4)
  assert.ok(f.requests.every(request => ['/admin', '/player', '/live', '/ready'].includes(request.path) &&
    request.method === 'GET' && !request.authorization && !request.cookie))
  const status = await f.status(settings)
  assert.equal(status.enabled, true)
  assert.equal(status.stopRequested, false)
  assert.equal(status.independentExternalHostVerified, false)
  assert.equal(/nonce|pid|targetEnv|Bearer|credentialEnv/.test(JSON.stringify(status)), false)
})

test('重复daemon及--once拒绝已占用锁且不覆盖第一owner，不依据错误nonce或root停止原进程', { timeout: 20000 }, async t => {
  const f = await fixture(t), settings = await f.config('exclusive')
  const daemon = await f.start(settings), original = readFileSync(settings.ownerPath, 'utf8')
  for (const arguments_ of [[], ['--once']]) {
    const duplicate = await f.run(settings, arguments_)
    assert.notEqual(duplicate.code, 0)
    assert.match(duplicate.stderr, /EADDRINUSE/)
    assert.equal(readFileSync(settings.ownerPath, 'utf8'), original)
    assert.equal((await f.status(settings)).enabled, true)
    assert.equal(daemon.closed, false)
  }
  const saved = JSON.parse(original)
  for (const altered of [{ ...saved, nonce: randomUUID() }, { ...saved, root: join(f.directory, 'different-owner-root') }]) {
    writeFileSync(settings.ownerPath, JSON.stringify(altered))
    assert.equal((await f.status(settings)).enabled, false)
    const stop = parseOutput((await f.run(settings, ['--stop'])).stdout)
    assert.equal(stop.stopRequested, false)
    assert.equal(daemon.closed, false)
  }
  writeFileSync(settings.ownerPath, original)
  assert.equal((await f.status(settings)).enabled, true)
})

test('--stop只关闭匹配自己的monitor，旧owner及残留采样不能冒充活进程或停止兄弟', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = await f.config('owner-one'), second = await f.config('owner-two')
  const one = await f.start(first), two = await f.start(second), oldOwner = readFileSync(first.ownerPath, 'utf8')
  const stopped = await f.run(first, ['--stop'])
  assert.equal(stopped.code, 0)
  assert.equal(parseOutput(stopped.stdout).stopRequested, true)
  const closed = await bounded(one.completed, 'Owned stop did not close the daemon')
  assert.equal(closed.code, 0)
  assert.equal(existsSync(first.ownerPath), false)
  assert.equal(two.closed, false)
  assert.equal((await f.status(second)).enabled, true)
  writeFileSync(first.ownerPath, oldOwner)
  const stale = await f.status(first)
  assert.equal(stale.enabled, false)
  assert.equal(stale.sampled, true)
  assert.equal(stale.stopRequested, false)
  assert.equal(parseOutput((await f.run(first, ['--stop'])).stdout).stopRequested, false)
  assert.equal(two.closed, false)
  assert.equal((await f.status(second)).enabled, true)
})

test('未知回环端口占用时daemon/once拒绝接管且不覆盖外来metadata，status/stop不终止外来服务', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  let connections = 0
  const outside = f.track(createTcpServer(socket => { connections++; socket.on('data', () => socket.end('UNMANAGED-FIXTURE')) }))
  const port = await f.listenRandom(outside), settings = await f.config('foreign-lock', port)
  const foreign = JSON.stringify({ protocol: 2, root: resolve(f.directory), kind: 'unmanaged-fixture',
    nonce: randomUUID(), port, pid: process.pid, startedAt: new Date().toISOString() })
  writeFileSync(settings.ownerPath, foreign)
  for (const arguments_ of [[], ['--once']]) {
    const result = await f.run(settings, arguments_)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /EADDRINUSE/)
    assert.equal(readFileSync(settings.ownerPath, 'utf8'), foreign)
    assert.equal(existsSync(join(settings.opsDir, 'events.sqlite')), false)
  }
  assert.equal((await f.status(settings)).enabled, false)
  assert.equal(parseOutput((await f.run(settings, ['--stop'])).stdout).stopRequested, false)
  assert.equal(connections, 0)
  const response = await bounded(new Promise((done, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let body = ''
    socket.once('connect', () => socket.write('fixture-alive'))
    socket.on('data', chunk => { body += chunk })
    socket.once('end', () => { socket.destroy(); done(body) })
    socket.once('error', reject)
  }), 'Unmanaged fixture was no longer responsive')
  assert.equal(response, 'UNMANAGED-FIXTURE')
  assert.equal(outside.listening, true)
  assert.equal(readFileSync(settings.ownerPath, 'utf8'), foreign)
})

test('畸形或超大监控配置只打印安全错误代码，JSON片段和秘密不进日志', async t => {
  const f = await fixture(t), settings = await f.config('invalid-config')
  const secret = 'FAKE_WEBHOOK_SECRET_MUST_NOT_APPEAR_987654321'
  for (const content of [secret + ' {not-json}', JSON.stringify({secret, oversized:'x'.repeat(70000)})]) {
    writeFileSync(settings.path, content)
    const result = await f.run(settings)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /OPS_CONFIG_INVALID/)
    assert.equal((result.stdout + result.stderr).includes(secret), false)
    assert.equal(existsSync(join(settings.opsDir, 'events.sqlite')), false)
    assert.equal(existsSync(settings.ownerPath), false)
  }
})
