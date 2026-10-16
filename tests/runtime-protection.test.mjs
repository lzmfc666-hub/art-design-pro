import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTrustedProxyResolver,
  sanitizedProxyHeaders,
  createRuntimeProtection
} from '../server/runtime-protection.mjs'
import { createStudioServer } from '../server/index.mjs'
import { ApiError } from '../server/studio.mjs'
import { createBackupScheduler } from '../server/backup-scheduler.mjs'
import { restoreStudioDatabase } from '../scripts/studio-backup.mjs'

const request = (address, forwarded = '') => ({
  socket: { remoteAddress: address },
  headers: { 'x-forwarded-for': forwarded }
})

test('代理：默认忽略转发头，显式可信链从右向左解析，伪造及畸形头不能绕过', () => {
  assert.equal(createTrustedProxyResolver()(request('127.0.0.1', '198.51.100.21')), '127.0.0.1')
  const trusted = createTrustedProxyResolver('127.0.0.1,10.1.0.0/16,2001:db8:1::/48')
  assert.equal(trusted(request('::ffff:127.0.0.1', '198.51.100.21, 10.1.2.3')), '198.51.100.21')
  assert.equal(trusted(request('127.0.0.1', '198.51.100.99, 198.51.100.21')), '198.51.100.21')
  assert.equal(trusted(request('198.51.100.21', '198.51.100.99')), '198.51.100.21')
  assert.equal(trusted(request('2001:db8:1::4', '2001:db8:2::8')), '2001:db8:2::8')
  assert.equal(trusted(request('127.0.0.1', 'garbage, 198.51.100.21')), '127.0.0.1')
  assert.equal(
    trusted(request('127.0.0.1', Array(17).fill('198.51.100.21').join(','))),
    '127.0.0.1'
  )
  assert.throws(() => createTrustedProxyResolver('all'), /IP 或 CIDR/)
  assert.throws(() => createTrustedProxyResolver('10.0.0.1/40'), /IP 或 CIDR/)
  const input = {
    ...request('198.51.100.21', '1.2.3.4'),
    headers: {
      forwarded: 'for=1.2.3.4',
      'x-real-ip': '1.2.3.4',
      'x-forwarded-host': 'evil',
      'x-forwarded-proto': 'https',
      cookie: 'own=test'
    }
  }
  assert.deepEqual(sanitizedProxyHeaders(input), {
    cookie: 'own=test',
    'x-forwarded-for': '198.51.100.21'
  })
})

test('HTTP：可信代理后真实来源独立限流，不可信请求不能伪造来源绕过锁定', async (t) => {
  const server = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password: 'runtime-test-only-123',
    trustedProxies: ['127.0.0.1']
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  server.service.login = () => {
    throw new ApiError('测试密码错误', 401)
  }
  const login = (address) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/studio/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
      body: JSON.stringify({ username: 'runtime-admin', password: 'invalid' })
    })
  for (let count = 0; count < 15; count++) assert.equal((await login('198.51.100.21')).status, 401)
  assert.equal((await login('198.51.100.21')).status, 429)
  assert.equal((await login('198.51.100.22')).status, 401)
  assert.equal((await login('untrusted garbage')).status, 401)
})

test('限流和并发：用户与来源双限制，上传槽释放，磁盘不足拒绝上传', () => {
  let now = 1000000
  const runtime = createRuntimeProtection({
    clock: () => now,
    claimRate: 2,
    uploadConcurrency: 2,
    uploadPerUser: 1
  })
  runtime.claim('player-1', 'address-1')
  runtime.claim('player-1', 'address-1')
  assert.throws(
    () => runtime.claim('player-1', 'address-2'),
    (error) => error.status === 429 && error.code === 'RATE_LIMITED'
  )
  now += 60000
  runtime.claim('player-1', 'address-1')
  const first = runtime.acquireUpload('player-1', 'address-1')
  assert.throws(
    () => runtime.acquireUpload('player-1', 'address-1'),
    (error) => error.code === 'UPLOAD_CONCURRENCY'
  )
  const second = runtime.acquireUpload('player-2', 'address-2')
  assert.throws(
    () => runtime.acquireUpload('player-3', 'address-3'),
    (error) => error.code === 'UPLOAD_CONCURRENCY'
  )
  first()
  first()
  second()
  runtime.acquireUpload('player-1', 'address-1')()
  const lowDisk = createRuntimeProtection({
    dbPath: join(tmpdir(), 'test-only-not-created.sqlite'),
    diskProbe: () => ({ bavail: 1, bsize: 4096 })
  })
  assert.deepEqual(lowDisk.storage().warnings, ['DISK_FREE_LOW'])
  assert.throws(
    () => lowDisk.acquireUpload('player-1', 'address-1'),
    (error) => error.status === 507 && error.code === 'UPLOAD_DISK_PRESSURE'
  )
  runtime.close()
  lowDisk.close()
})

test('导出：原子槽位、有限排队、超时及停止释放，等待时间有记录', async () => {
  const runtime = createRuntimeProtection({
    exportConcurrency: 1,
    exportQueueLimit: 1,
    exportWaitMs: 30
  })
  const release = await runtime.acquireExport()
  const pending = runtime.acquireExport()
  await assert.rejects(runtime.acquireExport(), (error) => error.code === 'EXPORT_BUSY')
  release()
  const nextRelease = await pending
  const timedOut = runtime.acquireExport()
  await assert.rejects(timedOut, (error) => error.code === 'EXPORT_WAIT_TIMEOUT')
  nextRelease()
  const stopRelease = await runtime.acquireExport(),
    onStop = runtime.acquireExport()
  runtime.close()
  await assert.rejects(onStop, (error) => error.code === 'SERVER_STOPPING')
  stopRelease()
})

test('HTTP：错误码保留且运行指标为真实请求统计，客服不得读取', async (t) => {
  const password = 'runtime-test-only-123'
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const login = async (username) => {
    const response = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    assert.equal(response.status, 200)
    return response.headers.getSetCookie()[0].split(';')[0]
  }
  const adminCookie = await login('admin')
  server.service.mutate('admin', '/users', {
    username: 'runtime-support',
    name: '测试客服',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password
  })
  const supportCookie = await login('runtime-support')
  assert.equal(
    (await fetch(base + '/runtime/metrics', { headers: { Cookie: supportCookie } })).status,
    403
  )
  const original = server.service.mutate
  server.service.mutate = () => {
    throw Object.assign(new ApiError('订单版本已变更', 409), {
      code: 'ORDER_REVISION_CONFLICT',
      details: { expectedRevision: 2 }
    })
  }
  const conflict = await fetch(base + '/test-only-conflict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: '{}'
  })
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), {
    message: '订单版本已变更',
    code: 'ORDER_REVISION_CONFLICT',
    details: { expectedRevision: 2 }
  })
  server.service.mutate = original
  const response = await fetch(base + '/runtime/metrics', { headers: { Cookie: adminCookie } }),
    metrics = await response.json()
  assert.equal(response.status, 200)
  assert.equal(metrics.source, 'actual-runtime')
  assert.ok(metrics.http.requests >= 4)
  assert.ok(metrics.http.clientErrors >= 2)
  assert.ok(metrics.process.memory.rss > 0)
  assert.equal(metrics.storage.persistent, false)
  assert.equal(metrics.backups.enabled, false)
  assert.equal(metrics.http.errors, 0)
})

test('计划备份：隔离磁盘副本恢复、保留上限及失败提醒，不覆盖现有文件', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-runtime-backup-'))
  const sourcePath = join(directory, 'isolated.sqlite'),
    backupDir = join(directory, 'backups'),
    restoredPath = join(directory, 'isolated-restored.sqlite')
  const server = createStudioServer({
    dbPath: sourcePath,
    seed: false,
    password: 'backup-runtime-only-123'
  })
  let restored
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    if (restored) await new Promise((resolve) => restored.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  })
  let now = Date.parse('2026-10-14T00:00:00Z')
  const scheduler = createBackupScheduler({
    dbPath: sourcePath,
    directory: backupDir,
    intervalMinutes: 0,
    failureWebhook: '',
    retentionCount: 2,
    clock: () => now
  })
  for (let count = 0; count < 3; count++) {
    assert.deepEqual(await scheduler.run(), { ok: true })
    now += 1000
  }
  const files = readdirSync(backupDir).filter((file) => file.endsWith('.sqlite'))
  assert.equal(files.length, 2)
  assert.equal(scheduler.metrics().completed, 3)
  await restoreStudioDatabase(join(backupDir, files.sort().at(-1)), restoredPath)
  restored = createStudioServer({ dbPath: restoredPath, seed: false })
  assert.equal(restored.service.bootstrap('admin').user.username, 'admin')
  await assert.rejects(
    () => restoreStudioDatabase(join(backupDir, files[0]), restoredPath),
    /已存在/
  )
  const notices = []
  const failed = createBackupScheduler({
    dbPath: sourcePath,
    directory: backupDir,
    intervalMinutes: 0,
    retentionCount: 7,
    failureWebhook: '',
    backup: async () => {
      throw new Error('secret path must not leak')
    },
    notifyFailure: (event) => notices.push(event)
  })
  assert.deepEqual(await failed.run(), { ok: false, code: 'BACKUP_FAILED' })
  assert.equal(notices.length, 1)
  assert.equal(JSON.stringify(notices).includes('secret'), false)
  assert.equal(failed.metrics().failed, 1)
  const ordinary = join(backupDir, 'keep-other-file.sqlite')
  writeFileSync(ordinary, 'private unrelated file')
  await scheduler.run()
  assert.equal(readdirSync(backupDir).includes('keep-other-file.sqlite'), true)
  scheduler.close()
  failed.close()
})
