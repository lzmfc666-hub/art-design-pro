import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { createStudioServer } from '../server/index.mjs'
import { createReadinessProbe } from '../server/health-probe.mjs'
import { createMonitorAuthority } from '../server/ops-summary.mjs'

const credential = 'ops-test-only-'.repeat(4)
const releaseId = 'a'.repeat(64)
async function fixture(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-health-'))
  const server = createStudioServer({ dbPath: join(directory, 'test.sqlite'), seed: false,
    password: 'isolated-health-password', releaseId, health: { cacheMs: 0 }, monitor: { token: credential }, ...extra })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise(done => server.close(done)))
  return { server, base: `http://127.0.0.1:${server.address().port}/api/studio` }
}
test('公开就绪探针真实读库，仅最小字段；API连接失效不能被健康磁盘文件掩盖', async t => {
  const { server, base } = await fixture(t)
  const read = async path => { const response = await fetch(base + path); return { status: response.status, body: await response.json() } }
  assert.deepEqual(await read('/health/ready'), { status: 200,
    body: { status: 'ready', service: 'studio-api', release: releaseId, checks: { database: true } } })
  server.service.db.exec('ALTER TABLE fund_transactions RENAME TO isolated_missing_funds')
  const missing = await read('/health/ready')
  assert.equal(missing.status, 503)
  assert.deepEqual(Object.keys(missing.body).sort(), ['adviceCode', 'category', 'release', 'service', 'status'])
  assert.equal((await read('/health/live')).status, 200)
  // Restore the table, then close only this fixture's owned connection.
  server.service.db.exec('ALTER TABLE isolated_missing_funds RENAME TO fund_transactions')
  assert.equal((await read('/health/ready')).status, 200)
  server.service.db.close()
  assert.equal((await read('/health/ready')).status, 503)
  assert.equal((await read('/health/live')).status, 200)
})
test('就绪worker有受控超时、合并并发及重建，不把无响应当200', async () => {
  let created = 0, terminated = 0
  const probe = createReadinessProbe({ dbPath: 'not-accessed-test.sqlite', timeoutMs: 55, cacheMs: 0,
    workerFactory() { created++; const worker = new EventEmitter(); worker.postMessage = () => {};
      worker.terminate = () => { terminated++; return Promise.resolve() }; return worker } })
  try {
    assert.deepEqual(await Promise.all([probe.check(), probe.check(), probe.check()]), [false, false, false])
    assert.equal(created, 1); assert.equal(terminated, 1)
    assert.equal(await probe.check(), false); assert.equal(created, 2)
    assert.equal(probe.metrics().timeouts, 2)
  } finally { probe.close() }
})
test('监控凭据独立只读，不授予管理员业务权限，不接受浏览器Cookie或向外暴露明细', async t => {
  const { base } = await fixture(t)
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'isolated-health-password' }) })
  const cookie = login.headers.getSetCookie()[0].split(';')[0]
  assert.equal((await fetch(base + '/ops/summary', { headers: { Cookie: cookie } })).status, 401)
  assert.equal((await fetch(base + '/ops/summary', { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  const headers = { Authorization: `Bearer ${credential}` }
  const response = await fetch(base + '/ops/summary', { headers }), data = await response.json()
  assert.equal(response.status, 200); assert.equal(data.source, 'actual-runtime')
  assert.equal(data.release, releaseId); assert.equal(data.backups.enabled, false)
  assert.equal((await fetch(base + '/orders', { headers })).status, 401)
  assert.equal((await fetch(base + '/ops/summary', { method: 'POST', headers })).status, 405)
  assert.equal((await fetch(base + '/ops/diagnostics-summary', { headers })).status, 409)
  assert.doesNotMatch(JSON.stringify(data), /studio-health-|password|contact|customerId|endpoint|privateKey|Cookie/)
})
test('低峰诊断仅摘要、缓存限频，不扩大原业务诊断权限或新增写入', async t => {
  const { server, base } = await fixture(t, { monitor: { token: credential, diagnosticHoursUTC: [new Date().getUTCHours()] } })
  const before = server.service.db.prepare('SELECT total_changes() count').get().count
  const first = await fetch(base + '/ops/diagnostics-summary', { headers: { Authorization: `Bearer ${credential}` } })
  const data = await first.json()
  assert.equal(first.status, 200); assert.equal(data.cached, false)
  assert.ok(Number.isInteger(data.errorCount)); assert.equal(data.issues, undefined)
  const next = await fetch(base + '/ops/diagnostics-summary', { headers: { Authorization: `Bearer ${credential}` } })
  assert.equal((await next.json()).cached, true)
  assert.equal(server.service.db.prepare('SELECT total_changes() count').get().count, before)
})
test('畸形监控及健康配置在初始化业务库之前拒绝', () => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-health-invalid-')), dbPath = join(directory, 'test.sqlite')
  for (const invalid of [{ health: { timeoutMs: 1 } }, { monitor: { token: 'short' } },
    { monitor: { diagnosticHoursUTC: [24] } }, { releaseId: 'old-version' }]) {
    assert.throws(() => createStudioServer({ dbPath, seed: false, ...invalid }))
    assert.equal(existsSync(dbPath), false)
  }
  assert.throws(() => createMonitorAuthority('has whitespace '.repeat(4)))
})

test('新增复制配置只在明确维护环境读取，畸形配置不初始化业务库', async t => {
  const previous = process.env.STUDIO_BACKUP_REPLICATION_CONFIG
  const directory = mkdtempSync(join(tmpdir(), 'studio-replica-config-'))
  process.env.STUDIO_BACKUP_REPLICATION_CONFIG = join(directory, 'missing-private.json')
  t.after(() => { if (previous === undefined) delete process.env.STUDIO_BACKUP_REPLICATION_CONFIG;
    else process.env.STUDIO_BACKUP_REPLICATION_CONFIG = previous })
  await fixture(t)
  const dbPath = join(directory, 'must-not-create.sqlite')
  assert.throws(() => createStudioServer({ dbPath, maintenanceFromEnv: true, password: 'isolated-config-password',
    monitor: { token: credential }, opsEvents: { observe() {} },
    backups: { intervalMinutes: 0, directory: join(directory, 'backups'), failureWebhook: '' },
    notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] } }), /BACKUP_REPLICATION_CONFIG_INVALID/)
  assert.equal(existsSync(dbPath), false)
})
