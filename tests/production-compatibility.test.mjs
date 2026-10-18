import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectStudioLifecycleCompatibility, LIFECYCLE_CAPABILITIES } from '../scripts/studio-lifecycle-compatibility.mjs'
import { backupStudioDatabase, restoreStudioDatabase, verifyStudioBackup } from '../scripts/studio-backup.mjs'
import { createStudioService } from '../server/studio.mjs'
import { startProductionFixesPreview, parsePreviewArguments } from '../scripts/studio-production-fixes-preview.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-lifecycle-compat-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const privateDirectory = join(root, 'private'); mkdirSync(privateDirectory, { mode: 0o700 })
  const fixture = { root, privateDirectory, beforeCleanup: undefined }
  t.after(() => { fixture.beforeCleanup?.(); rmSync(root, { recursive: true, force: true }) })
  return fixture
}
function manifest(root, capabilities = LIFECYCLE_CAPABILITIES, name = 'release.json') {
  const files = ['source', 'admin', 'player'].map(key => ({ [`${key}.mjs`]: hash(key) }))
  const digests = files.map(value => hash(JSON.stringify(value)))
  const value = { format: 'studio-release-v1', id: hash(digests.join(':')),
    sourceFiles: files[0], adminFiles: files[1], playerFiles: files[2],
    sourceDigest: digests[0], adminDigest: digests[1], playerDigest: digests[2],
    ...(capabilities === null ? {} : { runtimeCapabilities: capabilities }) }
  const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path
}
function fixture(t, state = { schemaVersion: 2, users: [{ id: 'PRIVATE-ACCOUNT', name: 'PRIVATE-NAME' }], orders: [], refunds: [] }) {
  const f = temporary(t), databasePath = join(f.root, 'source.sqlite'), manifestPath = manifest(f.root)
  const db = new DatabaseSync(databasePath)
  db.exec('CREATE TABLE studio_state(id INTEGER PRIMARY KEY,json TEXT); CREATE TABLE uploads(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE extra_blobs(id INTEGER PRIMARY KEY,first BLOB,second BLOB)')
  db.prepare('INSERT INTO studio_state VALUES(1,?)').run(JSON.stringify(state))
  db.prepare('INSERT INTO uploads VALUES(?,?)').run('PRIVATE-IMAGE', Buffer.from('ORIGINAL-IMAGE-BYTES'))
  db.prepare('INSERT INTO extra_blobs VALUES(1,?,?)').run(Buffer.from([0, 255, 0, 2]), Buffer.from('MORE-PRIVATE-BLOB'))
  db.close()
  return { ...f, databasePath, manifestPath }
}
function stateOf(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return JSON.parse(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json) } finally { db.close() }
}
function snapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true }), entries = []
  try {
    db.exec('PRAGMA query_only=ON; BEGIN')
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const escaped = `"${name.replaceAll('"', '""')}"`
      const rows = db.prepare(`SELECT * FROM ${escaped}`).all()
      for (const [index, row] of rows.entries()) for (const [column, value] of Object.entries(row))
        if (value instanceof Uint8Array) entries.push([name, index, column, hash(value)])
    }
    return { state: hash(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json), allBlobs: entries }
  } finally { db.close() }
}
const oldOrder = (id, status = 'pending', extra = {}) => ({ id, status, receivedAmount: 1000, ...extra })

test('兼容检查以readonly/query_only读取，全部状态及所有BLOB与数据库字节保持不变', t => {
  const state = { schemaVersion: 2, users: [{ id: 'PRIVATE-ACCOUNT', password: 'PRIVATE-SECRET' }],
    orders: [oldOrder('PRIVATE-ORDER', 'active', { leaderId: 'PRIVATE-LEADER', assignments: [{ id: 'a' }] })],
    refunds: [{ orderId: 'PRIVATE-ORDER', status: 'paid', amount: 1000 }] }
  const f = fixture(t, state), before = snapshot(f.databasePath), fileBefore = hash(readFileSync(f.databasePath))
  const result = inspectStudioLifecycleCompatibility(f)
  assert.equal(result.readOnly, true); assert.equal(result.queryOnly, true); assert.equal(result.compatible, true)
  assert.equal(result.counts.fullRefundOpenFulfillment, 1)
  assert.equal(result.counts.fullRefundAfterAssignment, 1)
  assert.deepEqual(result.requiredCapabilities, ['refund-execution-v1'])
  assert.deepEqual(snapshot(f.databasePath), before)
  assert.equal(hash(readFileSync(f.databasePath)), fileBefore)
  assert.equal(stateOf(f.databasePath).orders[0].status, 'active', 'no automatic state or money repair')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|ORIGINAL-|source\.sqlite|password|leaderId|orderId/)
})

test('空旧业务库允许旧版本；全退、待全退、存单历史、免名额、问题历史逐项要求兼容能力', t => {
  const f = fixture(t), oldManifest = manifest(f.root, null, 'old-release.json')
  assert.equal(inspectStudioLifecycleCompatibility({ ...f, manifestPath: oldManifest }).compatible, true)
  const cases = [
    { order: oldOrder('pending-refunded'), refunds: [{ orderId: 'pending-refunded', status: 'paid', amount: 1000 }], capability: 'refund-execution-v1', count: 'fullRefundOpenFulfillment' },
    { order: oldOrder('review-refunded', 'review'), refunds: [{ orderId: 'review-refunded', status: 'paid', amount: 1000 }], capability: 'refund-execution-v1', count: 'fullRefundOpenFulfillment' },
    { order: oldOrder('pending-full', 'active'), refunds: [{ orderId: 'pending-full', status: 'paid', amount: 400 }, { orderId: 'pending-full', status: 'pending', amount: 600 }], capability: 'refund-execution-v1', count: 'fullRefundPendingOrders' },
    { order: oldOrder('durable-closure', 'completed', { refundExecutionClosedAt: '2026-10-18T01:00:00Z' }), capability: 'refund-execution-v1', count: 'fullRefundCompletedOrders' },
    { order: oldOrder('stored', 'active', { storage: { active: true } }), capability: 'stored-orders-v1', count: 'activeStoredOrders' },
    { order: oldOrder('history', 'completed', { storageHistory: [{ active: false }] }), capability: 'stored-orders-v1', count: 'storageHistoryOrders' },
    { order: oldOrder('resumed', 'active', { capacityExemption: { storageId: 's' } }), capability: 'stored-orders-v1', count: 'resumedCapacityExemptOrders' },
    { order: oldOrder('problem', 'completed', { problem: { status: 'open' } }), capability: 'problem-orders-v1', count: 'openProblemOrders' },
    { order: oldOrder('problem-history', 'completed', { problemHistory: [{ status: 'closed' }] }), capability: 'problem-orders-v1', count: 'problemHistoryOrders' }
  ]
  for (const example of cases) {
    const db = new DatabaseSync(f.databasePath)
    db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify({ schemaVersion: 2, orders: [example.order], refunds: example.refunds || [] }))
    db.close()
    const rejected = inspectStudioLifecycleCompatibility({ ...f, manifestPath: oldManifest })
    assert.equal(rejected.compatible, false)
    assert.deepEqual(rejected.missingCapabilities, example.capability === 'problem-orders-v1'
      ? ['problem-orders-v1', 'problem-staff-only-v1'] : [example.capability])
    assert.equal(rejected.counts[example.count], 1)
    const upgraded = inspectStudioLifecycleCompatibility(f)
    assert.equal(upgraded.compatible, true); assert.deepEqual(upgraded.missingCapabilities, [])
  }
})

test('私人复核清单仅明确指定时独占生成，默认报告不含订单编号，公开或源码位置拒绝', t => {
  const f = fixture(t, { schemaVersion: 2, orders: [oldOrder('PRIVATE-ANOMALY')], refunds: [{ orderId: 'PRIVATE-ANOMALY', status: 'paid', amount: 1000 }] })
  const output = join(f.privateDirectory, 'anomalies.private.json')
  const result = inspectStudioLifecycleCompatibility({ ...f, privateAnomaliesFile: output })
  assert.equal(result.privateAnomaliesWritten, true)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-ANOMALY|private\.json/)
  const privateList = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual(privateList.anomalies, [{ orderId: 'PRIVATE-ANOMALY', codes: ['LEGACY_FULL_REFUND_RAW_PENDING'] }])
  assert.deepEqual(privateList.financialReviews, [])
  assert.doesNotMatch(JSON.stringify(privateList), /receivedAmount|users|refunds|amount|source\.sqlite/)
  assert.throws(() => inspectStudioLifecycleCompatibility({ ...f, privateAnomaliesFile: output }), error => error.code === 'PRIVATE_OUTPUT_INVALID')
  mkdirSync(join(f.root, 'public'))
  assert.throws(() => inspectStudioLifecycleCompatibility({ ...f, privateAnomaliesFile: join(f.root, 'public', 'ids.json') }), error => error.code === 'PRIVATE_OUTPUT_INVALID')
  assert.equal(existsSync(join(f.root, 'public', 'ids.json')), false)
  assert.throws(() => inspectStudioLifecycleCompatibility({ ...f, privateAnomaliesFile: resolve('docs/private-order-ids.json') }), error => error.code === 'PRIVATE_OUTPUT_INVALID')
})

test('新全退保留原履约状态且已有闭锁时不误报遗留执行异常，财务复核单独计数', t => {
  const f = fixture(t, { schemaVersion: 2, orders: [
    oldOrder('PRIVATE-NEW-PENDING', 'pending', { refundExecutionClosedAt: '2026-10-18T04:00:00Z' }),
    oldOrder('PRIVATE-NEW-ACTIVE', 'active', { leaderId: 'PRIVATE-LEADER', assignments: [{ id: 'PRIVATE-ASSIGNMENT' }], refundExecutionClosedAt: '2026-10-18T04:00:00Z' }),
    oldOrder('PRIVATE-LEGACY', 'pending')
  ], refunds: ['PRIVATE-NEW-PENDING', 'PRIVATE-NEW-ACTIVE', 'PRIVATE-LEGACY'].map(orderId => ({ orderId, status: 'paid', amount: 1000 })) })
  const privateAnomaliesFile = join(f.privateDirectory, 'review.private.json')
  const report = inspectStudioLifecycleCompatibility({ ...f, privateAnomaliesFile })
  assert.equal(report.compatible, true)
  assert.equal(report.counts.fullRefundedOrders, 3)
  assert.equal(report.counts.fullRefundOpenFulfillment, 3, 'all three retain raw fulfillment and require the current execution guard')
  assert.equal(report.counts.durablyClosedFullRefundOrders, 2)
  assert.equal(report.counts.legacyFullRefundOpenFulfillment, 1)
  assert.equal(report.counts.anomalyOrders, 1)
  assert.equal(report.counts.financialReviewOrders, 1)
  const privateList = JSON.parse(readFileSync(privateAnomaliesFile, 'utf8'))
  assert.deepEqual(privateList.anomalies.map(row => row.orderId), ['PRIVATE-LEGACY'])
  assert.deepEqual(privateList.financialReviews.map(row => row.orderId), ['PRIVATE-NEW-ACTIVE'])
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-/)
  const db = new DatabaseSync(f.databasePath)
  const state = stateOf(f.databasePath)
  state.orders = [state.orders[0]]; state.refunds = [state.refunds[0]]
  db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state)); db.close()
  const normal = inspectStudioLifecycleCompatibility(f)
  assert.equal(normal.counts.fullRefundedOrders, 1)
  assert.equal(normal.counts.anomalyOrders, 0)
  assert.equal(normal.executionAnomaliesRequireReview, false)
  assert.equal(normal.financialReviewRequired, false)
  assert.equal(normal.findingsRequireOperatorReview, false)
  assert.deepEqual(normal.requiredCapabilities, ['refund-execution-v1'])
})

test('预览命令明确选择两份独立构建或状态检查，拒绝遗漏、重复或混合参数', () => {
  const args = ['--admin-directory', '.qa/production-fixes-20261018/preview-builds/admin', '--player-directory', '.qa/production-fixes-20261018/preview-builds/player']
  assert.deepEqual(parsePreviewArguments(args), { adminDirectory: resolve(args[1]), playerDirectory: resolve(args[3]) })
  assert.deepEqual(parsePreviewArguments([]), {})
  assert.deepEqual(parsePreviewArguments(['--status']), { status: true })
  for (const invalid of [['--admin-directory', args[1]], ['--player-directory'], ['--status', '--admin-directory', args[1]], ['--admin-directory', args[1], '--admin-directory', args[1]]])
    assert.throws(() => parsePreviewArguments(invalid))
})

test('CLI必须指定两个输入，不创建缺失数据库；旧回退版本不兼容退出1且异常输出不泄漏路径或记录', t => {
  const f = fixture(t, { schemaVersion: 2, orders: [oldOrder('PRIVATE-ORDER', 'active', { storage: { active: true, reason: 'PRIVATE-REASON' } })], refunds: [] })
  const oldManifest = manifest(f.root, [], 'old-release.json')
  const cli = resolve('scripts/studio-lifecycle-compatibility.mjs')
  const execute = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  assert.equal(execute([]).status, 2)
  const missing = join(f.root, 'does-not-exist.sqlite')
  const noDatabase = execute(['--database', missing, '--manifest', f.manifestPath])
  assert.equal(noDatabase.status, 2); assert.equal(existsSync(missing), false)
  assert.doesNotMatch(noDatabase.stdout + noDatabase.stderr, /does-not-exist|PRIVATE-|C:\\|Error:/)
  const rejected = execute(['--database', f.databasePath, '--manifest', oldManifest])
  assert.equal(rejected.status, 1)
  assert.deepEqual(JSON.parse(rejected.stdout).missingCapabilities, ['stored-orders-v1'])
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /PRIVATE-|source\.sqlite|old-release\.json/)
  assert.equal(execute(['--database', f.databasePath, '--manifest', f.manifestPath]).status, 0)
  writeFileSync(f.manifestPath, '{"format":"studio-release-v1","id":"invalid"}')
  const invalid = execute(['--database', f.databasePath, '--manifest', f.manifestPath])
  assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).code, 'MANIFEST_INVALID')
})

test('隔离真实业务备份恢复保留存单/问题/退款身份和原图，源库备份后新增交易不被旧快照覆盖', async t => {
  const f = temporary(t), databasePath = join(f.root, 'source.sqlite'), manifestPath = manifest(f.root)
  const service = createStudioService({ dbPath: databasePath, seed: false, password: 'isolated-compatibility-only-password', clock: () => new Date('2026-10-18T04:00:00Z') })
  f.beforeCleanup = () => service.close()
  const snapshotState = () => JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, { requestId: randomUUID(), ...body })
  const level = mutate('/levels', { name: '隔离恢复测试', delaySeconds: 0 })
  const player = mutate('/users', { username: 'isolated-restore-player', name: '隔离打手', role: 'player', status: 'active', maxActiveOrders: 5, levelId: level.id, permissionOverrides: {}, password: 'isolated-compatibility-only-password' })
  const customer = mutate('/customers', { name: '隔离客户', contact: 'PRIVATE-RESTORE-CONTACT', gameId: 'PRIVATE-RESTORE-GAME' })
  const template = mutate('/templates', { name: '隔离恢复订单', game: '测试游戏', description: '隔离恢复要求', amount: 2000, reward: 1000, active: true })
  const image = service.upload('admin', { name: 'isolated-original.png', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=' })
  const newOrder = () => mutate('/orders', { customerId: customer.id, templateId: template.id, platformId: 'xianyu', shopId: 'jindun', externalOrderNo: randomUUID(), roomCode: 'PRIVATE-RESTORE-ROOM', amount: 2000, reward: 1000, receivedAmount: 2000, paidAt: '2026-10-18T04:00:00Z', receipt: image, dispatchMode: 'pool' })
  const target = order => {
    const row = service.orderDetail('admin', order.id).order
    return { expectedRevision: row.revision, dispatchRound: row.dispatchRound, assignmentId: row.assignmentId, leaderId: row.leaderId }
  }
  const action = (order, action, extra = {}) => mutate(`/orders/${order.id}/action`, { ...target(order), action, reason: '隔离恢复原因', ...extra })
  const continuing = newOrder(), stored = newOrder(), refunded = newOrder()
  for (const order of [continuing, stored]) mutate(`/player/orders/${order.id}/claim`, target(order), player.id)
  action(continuing, 'store'); action(continuing, 'resume', { mode: 'original' })
  const problem = action(continuing, 'problem-open').problem
  // An earlier release allowed feedback. Preserve its historical data without
  // re-enabling a now-forbidden production operation just to make a fixture.
  const legacyState = snapshotState(), legacyProblem = legacyState.orders.find(row => row.id === continuing.id).problem
  legacyProblem.feedback.push({ id: 'legacy-feedback', userId: player.id, userName: player.name,
    message: '旧版隔离恢复反馈', createdAt: '2026-10-18T04:00:00Z' })
  assert.equal(legacyProblem.id, problem.id)
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(legacyState))
  action(stored, 'store')
  mutate('/refunds', { orderId: refunded.id, ...target(refunded), amount: 2000, reason: '隔离全额退款' })
  const sourceBeforeBackup = snapshot(databasePath), backup = join(f.root, 'backup.sqlite'), restored = join(f.root, 'restored.sqlite')
  const completed = await backupStudioDatabase(databasePath, backup, { applicationRelease: 'isolated-lifecycle-recovery' })
  assert.equal(completed.metadata.status, 'complete')
  assert.equal((await verifyStudioBackup(backup)).hashVerification, 'verified')
  const later = newOrder()
  const sourceAfterNewOrder = snapshot(databasePath)
  assert.notEqual(sourceAfterNewOrder.state, sourceBeforeBackup.state)
  const restoredResult = await restoreStudioDatabase(backup, restored)
  assert.equal(restoredResult.sourceVerification.hashVerification, 'verified')
  assert.deepEqual(snapshot(restored), sourceBeforeBackup)
  assert.deepEqual(snapshot(databasePath), sourceAfterNewOrder, 'restore creates a separate file and cannot overwrite later business transactions')
  assert.ok(snapshotState().orders.some(row => row.id === later.id))
  assert.equal(stateOf(restored).orders.some(row => row.id === later.id), false)
  const recoveryReport = inspectStudioLifecycleCompatibility({ databasePath: restored, manifestPath })
  assert.equal(recoveryReport.compatible, true); assert.deepEqual(recoveryReport.requiredCapabilities, LIFECYCLE_CAPABILITIES)
  assert.equal(recoveryReport.counts.activeStoredOrders, 1); assert.equal(recoveryReport.counts.resumedCapacityExemptOrders, 1)
  assert.equal(recoveryReport.counts.openProblemOrders, 1); assert.equal(recoveryReport.counts.fullRefundedOrders, 1)
  assert.equal(recoveryReport.counts.anomalyOrders, 0, 'a current successful full refund carries its execution closure')
  const priorCandidate = manifest(f.root, LIFECYCLE_CAPABILITIES.filter(value => value !== 'problem-staff-only-v1'), 'prior-candidate.json')
  assert.deepEqual(inspectStudioLifecycleCompatibility({ databasePath: restored, manifestPath: priorCandidate }).missingCapabilities, ['problem-staff-only-v1'])
  const oldManifest = manifest(f.root, [], 'old-release.json')
  assert.equal(inspectStudioLifecycleCompatibility({ databasePath: restored, manifestPath: oldManifest }).compatible, false)
  await assert.rejects(() => restoreStudioDatabase(backup, databasePath), /已存在/)
  assert.deepEqual(snapshot(databasePath), sourceAfterNewOrder)
  t.diagnostic('隔离恢复通过：3笔备份订单及全部BLOB完整；源库第4笔新交易保留；旧无能力清单回退被拒绝。')
})

test('隔离预览用随机端口验证双端登录、演示状态及重启不重置已修改的人员与订单', async t => {
  const directory = resolve('.qa/production-fixes-20261018', `preview-helper-check-${randomUUID()}`)
  assert.ok(directory.startsWith(resolve('.qa/production-fixes-20261018') + sep))
  const adminDirectory = join(directory, 'admin-fixture'), playerDirectory = join(directory, 'player-fixture')
  for (const folder of [adminDirectory, playerDirectory]) {
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Isolated proxy fixture</title>')
  }
  const options = { directory, adminDirectory, playerDirectory, ports: { admin: 0, api: 0, player: 0 } }
  let preview
  t.after(async () => { await preview?.stop(); rmSync(directory, { recursive: true, force: true }) })
  preview = await startProductionFixesPreview(options)
  assert.equal(preview.production, false); assert.equal(preview.seededNewDatabase, true)
  assert.deepEqual(preview.jobs, { externalPush: false, backup: false, imageCleanup: false, externalMonitor: false })
  const raw = () => JSON.parse(preview.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const source = raw()
  assert.equal(source.orders.length, 8)
  assert.equal(source.orders.filter(row => row.storage?.active).length, 2)
  assert.equal(source.orders.filter(row => row.capacityExemption).length, 1)
  assert.equal(source.orders.filter(row => row.problem?.status === 'open').length, 1)
  assert.equal(source.refunds.filter(row => row.status === 'paid').length, 1)
  assert.equal(source.refunds.filter(row => row.status === 'pending').length, 1)
  assert.ok(source.workSchedules.every(row => source.users.find(user => user.id === row.userId)?.role !== 'player'))
  const adminBase = new URL(preview.urls.admin).origin, playerBase = new URL(preview.urls.player).origin
  assert.equal((await fetch(adminBase)).status, 200)
  assert.equal((await fetch(playerBase)).status, 200)
  const identity = await (await fetch(`${adminBase}/__preview/status`)).json()
  assert.equal(identity.instanceId, preview.instanceId)
  const login = await fetch(`${adminBase}/api/studio/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Client': 'player' },
    body: JSON.stringify(preview.credentials.accounts.admin) })
  assert.equal(login.status, 200); assert.equal((await login.json()).user.role, 'super_admin')
  const adminCookie = login.headers.get('set-cookie').split(';')[0]
  assert.match(adminCookie, /^studio_session=/)
  const cross = await (await fetch(`${playerBase}/api/studio/session`, { headers: { Cookie: adminCookie } })).json()
  assert.equal(cross.user, null, 'admin cookie must not authenticate in player proxy')
  const playerLogin = await fetch(`${playerBase}/api/studio/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preview.credentials.accounts.player) })
  assert.equal(playerLogin.status, 200); assert.equal((await playerLogin.json()).user.role, 'player')
  const user = source.users.find(row => row.role === 'player')
  preview.service.mutate(user.id, '/profile', { name: '验收后手动修改的演示打手', requestId: randomUUID() })
  const changed = hash(preview.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const credentials = preview.credentials
  await preview.stop()
  await assert.rejects(() => startProductionFixesPreview({ ...options, adminDirectory: directory }), /隔离预览/)
  writeFileSync(join(adminDirectory, 'accidental.sqlite'), 'not allowed in a static preview tree')
  await assert.rejects(() => startProductionFixesPreview(options), /隔离预览/)
  rmSync(join(adminDirectory, 'accidental.sqlite'))
  preview = await startProductionFixesPreview(options)
  assert.equal(preview.seededNewDatabase, false)
  assert.deepEqual(preview.credentials, credentials)
  assert.equal(hash(preview.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json), changed)
  assert.equal(raw().users.find(row => row.id === user.id).name, '验收后手动修改的演示打手')
  assert.equal(raw().orders.length, 8)
})
