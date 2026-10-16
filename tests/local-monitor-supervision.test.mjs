import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudioService } from '../server/studio.mjs'
import { localMonitorService, portProbe, runLocalManager, servicesConfiguration } from '../scripts/studio-local.mjs'
import { superviseServices } from '../scripts/studio-process-supervisor.mjs'
import { acquireProcessLock, readProcessOwner, requestProcessControl } from '../scripts/studio-service-control.mjs'

const monitorEntry = fileURLToPath(new URL('../scripts/studio-monitor.mjs', import.meta.url))
const pause = ms => new Promise(done => setTimeout(done, ms))
const cleanEnvironment = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]))
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(25)
  }
  assert.fail(message)
}
async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  assert.ok(port < 3006 || port > 3011)
  return port
}
async function fixture(t) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'studio-monitored-local-'))
  const runtime = join(projectRoot, 'runtime'), ops = join(projectRoot, '.ops')
  mkdirSync(runtime); mkdirSync(ops)
  const database = join(projectRoot, 'existing.sqlite')
  createStudioService({ dbPath: database, password: 'isolated-monitor-supervision-123', seed: false }).close()
  let apiUnavailable = false
  const pages = createServer((request, response) => {
    if (request.url.startsWith('/api/studio/health/')) {
      if (apiUnavailable) return response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"status":"unavailable"}')
      return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        status: request.url.endsWith('/ready') ? 'ready' : 'ok', service: 'studio-api', release: null,
        ...(request.url.endsWith('/ready') ? { checks: { database: true } } : {})
      }))
    }
    if (request.url.startsWith('/api/studio/ops/'))
      return response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"fixture-no-summary"}')
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><div id="app">Isolated monitor fixture</div></html>')
  })
  await new Promise(done => pages.listen(0, '127.0.0.1', done))
  const apiPort = pages.address().port, monitorPort = await freePort()
  const origin = `http://127.0.0.1:${apiPort}`
  const config = {
    format: 'studio-ops-config-v1', environment: 'local', mode: 'internal', localBinding: true,
    credentialEnv: 'STUDIO_MONITOR_TOKEN', intervalMs: 100, timeoutMs: 200,
    startupGraceMs: 0, failureThreshold: 3, recoveryThreshold: 2, monitorLockPort: monitorPort,
    storage: { dbPath: database, opsDir: ops }, supervisor: { stateDirectory: runtime },
    endpoints: { admin: origin + '/', player: origin + '/', live: origin + '/api/studio/health/live',
      ready: origin + '/api/studio/health/ready', summary: origin + '/api/studio/ops/summary' },
    alerts: { authorized: false }
  }
  const configPath = join(ops, 'local-monitor.json')
  const writeConfig = value => writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 })
  writeConfig(config)
  writeFileSync(join(ops, 'local-monitor-binding.json'), JSON.stringify({
    format: 'studio-local-monitor-binding-v1', environment: 'local', root: projectRoot,
    databasePath: database, host: '127.0.0.1', port: apiPort, token: randomBytes(32).toString('hex')
  }), { mode: 0o600 })
  const helperOptions = { projectRoot, directory: runtime, database, apiPort, adminPort: apiPort,
    playerPort: apiPort, env: cleanEnvironment() }
  const dummy = join(projectRoot, 'dummy.mjs')
  writeFileSync(dummy, `import {appendFileSync} from 'node:fs';
const file=process.argv[2];setInterval(()=>appendFileSync(file,'x'),20);
process.on('SIGTERM',()=>process.exit(0));`)
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    await new Promise(done => pages.close(done))
    assert.ok(resolve(projectRoot).startsWith(resolve(tmpdir()) + sep + 'studio-monitored-local-'))
    rmSync(projectRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  })
  return { projectRoot, runtime, ops, database, apiPort, monitorPort, config, configPath, writeConfig,
    helperOptions, dummy, cleanups, setApiUnavailable(value) { apiUnavailable = value } }
}

test('真实监控子进程退出仅恢复自己，API探测失败不重启监控，兄弟持续运行且停止优雅', async t => {
  const f = await fixture(t), events = []
  const monitoring = localMonitorService(f.helperOptions)
  assert.equal(monitoring.opsDirectory, f.ops)
  const sibling = name => ({ name, args: [f.dummy, join(f.projectRoot, name + '.ticks')],
    cwd: f.projectRoot, env: cleanEnvironment() })
  const supervisor = superviseServices({ services: [monitoring.service, sibling('sibling-a'), sibling('sibling-b')],
    directory: f.runtime, initialGraceMs: 100, healthIntervalMs: 100,
    healthTimeoutMs: 500, failureThreshold: 3, retryDelayMs: 50, maxRestarts: 2,
    restartWindowMs: 10000, stopGraceMs: 1500, onEvent: item => events.push(item) })
  f.cleanups.push(() => supervisor.stop())
  const state = name => supervisor.snapshot().find(row => row.name === name)
  await until(() => state('monitor').healthy === true && existsSync(join(f.projectRoot, 'sibling-a.ticks')) &&
    existsSync(join(f.projectRoot, 'sibling-b.ticks')), 'isolated monitor and siblings did not become ready')
  const monitorPid = state('monitor').pid
  const siblingPids = [state('sibling-a').pid, state('sibling-b').pid]
  f.setApiUnavailable(true)
  await until(() => {
    try { return JSON.parse(readFileSync(join(f.ops, 'monitor-state.json'))).lastRun.failedProbes === 2 }
    catch { return false }
  }, 'monitor did not record isolated API failures')
  await supervisor.checkNow()
  assert.equal(state('monitor').pid, monitorPid)
  assert.equal(state('monitor').restarts, 0)
  const owner = readProcessOwner(f.ops, 'monitor-owner.json', f.projectRoot)
  assert.equal(owner.pid, monitorPid)
  assert.ok(await requestProcessControl(owner, 'ping'))
  // Fault injection targets only the child just created and authenticated by this fixture.
  process.kill(monitorPid, 'SIGKILL')
  await until(() => state('monitor').healthy === true && Number.isInteger(state('monitor').pid) &&
    state('monitor').pid !== monitorPid && state('monitor').restarts === 1,
    'isolated monitor child was not recovered')
  assert.equal(state('monitor').restarts, 1)
  assert.deepEqual([state('sibling-a').pid, state('sibling-b').pid], siblingPids)
  assert.equal(state('sibling-a').restarts + state('sibling-b').restarts, 0)
  const before = readFileSync(join(f.projectRoot, 'sibling-a.ticks')).length
  await until(() => readFileSync(join(f.projectRoot, 'sibling-a.ticks')).length > before,
    'sibling work did not continue across monitor recovery')
  await supervisor.stop()
  assert.equal((await portProbe(f.monitorPort)).listening, false)
  assert.equal(events.filter(row => row.service === 'monitor' && row.type === 'forced-stop').length, 0)
})

test('已有独立监控占口时管理器拒绝启动，错误归属的健康/停止均不影响原监控', async t => {
  const f = await fixture(t)
  const outside = spawn(process.execPath, [monitorEntry, '--config', f.configPath], {
    cwd: f.projectRoot, env: cleanEnvironment(), windowsHide: true, stdio: 'ignore'
  })
  const exited = once(outside, 'exit')
  f.cleanups.push(async () => {
    const owner = readProcessOwner(f.ops, 'monitor-owner.json', f.projectRoot)
    if (owner?.pid === outside.pid) await requestProcessControl(owner, 'stop')
    if (outside.exitCode === null && outside.signalCode === null) {
      await Promise.race([exited, pause(2000)])
      if (outside.exitCode === null && outside.signalCode === null) outside.kill('SIGKILL')
    }
    await exited
  })
  await until(async () => {
    const owner = readProcessOwner(f.ops, 'monitor-owner.json', f.projectRoot)
    return owner?.pid === outside.pid && await requestProcessControl(owner, 'ping')
  }, 'independent fixture monitor did not start')
  const monitoring = localMonitorService(f.helperOptions)
  assert.equal((await monitoring.service.healthCheck({ child: { pid: outside.pid + 1 } })).healthy, false)
  await monitoring.service.gracefulStop({ child: { pid: outside.pid + 1 } })
  assert.equal((await portProbe(f.monitorPort)).listening, true)
  const fixtureConfig = join(f.projectRoot, 'fixture-manager.json')
  writeFileSync(fixtureConfig, JSON.stringify({ purpose: 'isolated-test', services: [{
    name: 'owned-test-monitor', port: f.monitorPort, cwd: f.projectRoot,
    args: [f.dummy, join(f.projectRoot, 'must-not-start.ticks')], env: cleanEnvironment()
  }] }))
  await assert.rejects(runLocalManager({ directory: join(f.projectRoot, 'refused-manager'),
    managerPort: await freePort(), managerConfig: fixtureConfig }), error => error.exitCode === 73)
  assert.equal(existsSync(join(f.projectRoot, 'must-not-start.ticks')), false)
  const owner = readProcessOwner(f.ops, 'monitor-owner.json', f.projectRoot)
  assert.equal(owner.pid, outside.pid)
  assert.ok(await requestProcessControl(owner, 'ping'))
})

test('本机监控纳管拒绝错环境、错误目标、库或身份范围，不泄露秘密', async t => {
  const f = await fixture(t)
  const rejected = value => {
    f.writeConfig(value)
    assert.throws(() => localMonitorService(f.helperOptions), { message: 'LOCAL_MONITOR_SUPERVISION_CONFIG_INVALID' })
  }
  rejected({ ...f.config, environment: 'production' })
  rejected({ ...f.config, localBinding: false })
  rejected({ ...f.config, alerts: { authorized: true } })
  rejected({ ...f.config, endpoints: { ...f.config.endpoints, summary: 'http://127.0.0.1:1/api/studio/ops/summary' } })
  rejected({ ...f.config, storage: { ...f.config.storage, dbPath: join(f.projectRoot, 'other.sqlite') } })
  rejected({ ...f.config, supervisor: { stateDirectory: join(f.projectRoot, 'wrong-runtime') } })
  rejected({ ...f.config, monitorLockPort: f.apiPort })
  rejected({ ...f.config, backups: { enabled: true, intervalMinutes: 0, retentionCount: 24, directory: '.ops/backups' } })
  rejected({ ...f.config, backups: { enabled: true, intervalMinutes: 35792, retentionCount: 24, directory: '.ops/backups' } })
  rejected({ ...f.config, backups: { enabled: true, intervalMinutes: 60, retentionCount: 0, directory: '.ops/backups' } })
  rejected({ ...f.config, backups: { enabled: true, intervalMinutes: 60, retentionCount: 91, directory: '.ops/backups' } })
  rejected({ ...f.config, backups: { enabled: true, intervalMinutes: 60, retentionCount: 24, directory: 'dist/backups' } })
  rejected({ ...f.config, backups: { enabled: true, intervalMinutes: 60, retentionCount: 24,
    directory: '.ops/backups', replication: { enabled: true } } })
  f.writeConfig(f.config)
  assert.throws(() => localMonitorService({ ...f.helperOptions,
    env: { ...cleanEnvironment(), STUDIO_OPS_DIRECTORY: join(f.projectRoot, 'different-events') } }),
  { message: 'LOCAL_MONITOR_SUPERVISION_CONFIG_INVALID' })
  assert.throws(() => localMonitorService({ ...f.helperOptions,
    env: { ...cleanEnvironment(), STUDIO_MONITOR_TOKEN: randomBytes(32).toString('hex') } }),
  { message: 'LOCAL_MONITOR_SUPERVISION_CONFIG_INVALID' })
})

test('只接通明确启用的本机计划备份，关闭时不继承旧外发或异机配置', async t => {
  const f = await fixture(t)
  assert.deepEqual(localMonitorService(f.helperOptions).backupEnvironment, {
    STUDIO_BACKUP_INTERVAL_MINUTES: '0', STUDIO_BACKUP_FAILURE_WEBHOOK: '',
    STUDIO_BACKUP_REPLICATION_CONFIG: ''
  })
  f.writeConfig({ ...f.config, backups: { enabled: true, intervalMinutes: 60,
    retentionCount: 24, directory: join(f.ops, 'scheduled-backups'), replication: { enabled: false } } })
  assert.deepEqual(localMonitorService(f.helperOptions).backupEnvironment, {
    STUDIO_BACKUP_INTERVAL_MINUTES: '60', STUDIO_BACKUP_RETENTION_COUNT: '24',
    STUDIO_BACKUP_DIR: join(f.ops, 'scheduled-backups'), STUDIO_BACKUP_FAILURE_WEBHOOK: '',
    STUDIO_BACKUP_REPLICATION_CONFIG: ''
  })
})

test('控制口仍响应但首次采样无界挂起会触发恢复，真实新采样即使业务失败仍健康', async t => {
  const f = await fixture(t)
  let now = Date.now(), lastRun = null
  const lock = await acquireProcessLock({ directory: f.ops, fileName: 'monitor-owner.json',
    root: f.projectRoot, port: f.monitorPort, kind: 'studio-monitor', onCommand() { return { lastRun } } })
  f.cleanups.push(() => lock.close())
  const monitoring = localMonitorService({ ...f.helperOptions, clock: () => now })
  const child = { pid: process.pid }
  assert.equal((await monitoring.service.healthCheck({ child })).healthy, true)
  now += f.config.intervalMs * 3 + f.config.timeoutMs * 6 + 1
  const stale = await monitoring.service.healthCheck({ child })
  assert.equal(stale.healthy, false)
  assert.equal(stale.restartable, true)
  lastRun = { observedAt: new Date(now).toISOString(), failedProbes: 4, summaryAvailable: false }
  assert.equal((await monitoring.service.healthCheck({ child })).healthy, true)
})

test('没有显式私有配置不增加服务，isolated-test配置忽略本机监控且原服务保持', async t => {
  const f = await fixture(t)
  const empty = join(f.projectRoot, 'unconfigured')
  mkdirSync(empty)
  assert.equal(localMonitorService({ projectRoot: empty }), null)
  f.writeConfig({ intentionally: 'invalid private config must not affect isolated-test fixtures' })
  const fixtureConfig = join(f.projectRoot, 'fixture-services.json')
  writeFileSync(fixtureConfig, JSON.stringify({ purpose: 'isolated-test', services: ['api', 'admin', 'player']
    .map(name => ({ name, port: f.apiPort, cwd: f.projectRoot, args: [f.dummy], env: {} })) }))
  const result = servicesConfiguration({ directory: f.runtime, managerConfig: fixtureConfig })
  assert.equal(result.testFixture, true)
  assert.equal(result.opsDirectory, undefined)
  assert.deepEqual(result.services.map(service => service.name), ['api', 'admin', 'player'])
})
