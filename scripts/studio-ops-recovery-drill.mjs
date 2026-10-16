import assert from 'node:assert/strict'
import { createHash, createECDH, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import webpush from 'web-push'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createPlayerNotifications } from '../server/player-notifications.mjs'
import { testMutate } from '../tests/helpers/current-intent.mjs'
import { withdrawalBody } from '../tests/player-test-helpers.mjs'
import { backupStudioDatabase, restoreStudioDatabase, verifyStudioBackup, backupFileDigest } from './studio-backup.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const qaRoot = join(root, '.qa', 'ops-closure-20261015')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const round = value => Math.round(value * 100) / 100
const stateOf = database => JSON.parse(database.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
const scalar = (database, sql) => Number(Object.values(database.prepare(sql).get())[0])
const serviceOptions = { seed: false, auditRetentionDays: 90, auditHotMaxRows: 20, auditArchiveMaxBytes: 20 * 1024 ** 2 }

// Reuse the complete-table/BLOB digest procedure from studio-stability-pressure.
// Table names come from SQLite's own schema, never from a supplied filename or ID.
function tableSummaries(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    const hash = createHash('sha256')
    let rows = 0
    for (const record of database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).iterate()) {
      const safe = Object.fromEntries(Object.entries(record).map(([key, value]) => [key,
        value instanceof Uint8Array ? { bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') } : value]))
      hash.update(JSON.stringify(safe)); rows++
    }
    return [name, { rows, sha256: hash.digest('hex') }]
  }))
}
const schemaSummary = database => createHash('sha256').update(JSON.stringify(database.prepare(
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
).all())).digest('hex')
const reject = (callback, status, code) => assert.throws(callback,
  error => error instanceof ApiError && error.status === status && (!code || error.code === code))

export async function runRecoveryDrill({ finalEvidence = false } = {}) {
  mkdirSync(qaRoot, { recursive: true })
  const directory = join(qaRoot, `recovery-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  // A fresh, bounded, explicitly owned directory. There are no delete/overwrite operations.
  assert.ok(directory.startsWith(qaRoot + sep))
  assert.equal(existsSync(directory), false)
  mkdirSync(directory)
  const sourcePath = join(directory, 'source', 'studio.sqlite')
  const backupPath = join(directory, 'backup', 'completed.sqlite')
  const restoredPath = join(directory, 'restored-readonly', 'studio.sqlite')
  const policyPath = join(directory, 'offline-switch-probe', 'studio.sqlite')
  const fingerprintBefore = sourceFingerprint()
  writeFileSync(join(directory, 'source-before.json'), JSON.stringify(fingerprintBefore, null, 2))
  const started = performance.now(), startedAt = new Date().toISOString()
  const report = { kind: 'isolated-offline-recovery-drill', success: false, finalAcceptance: false,
    evidencePhase: finalEvidence ? 'final-frozen-source-drill' : 'development-validation', directory, startedAt,
    applicationRelease: fingerprintBefore.digest, timingsMs: {}, stages: [], checks: [],
    isolation: { realDiskSQLite: true, allPathsNew: true, formalDatabaseAccessed: false,
      httpListeners: 0, maintenance: false, scheduledBackup: false, uploadCleanup: false,
      monitorAndAlerts: false, realPushCalls: 0, remoteReplication: false, externalConfigurationInherited: false },
    notes: [
      'Source fixture uses the existing isolated funds/current-intent/withdrawal helpers. No formal database, password, push key, alert target or environment file is read.',
      'All-table row counts and SHA256 (including BLOB content) reuse the existing stability-pressure recovery procedure; empty operational tables remain part of the exact comparison.',
      'The only source sender is an explicitly invoked in-memory fake receiver with fresh generated test keys. Its one held request proves a processing lease; it is not a phone delivery or external provider acknowledgement.',
      'The pristine restored artifact is checked read-only. Session expiry/revocation, authorization and queue reset are exercised only on a second new disposable offline copy.',
      'The 13-hour clock advance is only an expiry-rule simulation. Recovery/copy/check durations use the monotonic real clock.',
      'The source fingerprint is an isolated drill application identifier, not proof that a formal application release was deployed.',
      'Measured recovery time excludes authorized production service cutover, client reconnect, remote transfer and operator reaction; no production RTO/RPO guarantee is inferred.'
    ] }
  let source, sourceNotifications, policy, policyNotifications, replacementNotifications, heldFlush, releaseSender
  let fakeSenderCalls = 0, forbiddenOfflineSenderCalls = 0
  const timed = async (stage, callback) => {
    report.stages.push({ stage, startedAt: new Date().toISOString() })
    const begin = performance.now()
    try { return await callback() }
    finally { report.timingsMs[stage] = round(performance.now() - begin) }
  }
  try {
    const password = `isolated-recovery-${randomUUID()}`
    const mockKeys = webpush.generateVAPIDKeys()
    const receiverGate = new Promise(done => { releaseSender = done })
    source = createStudioService({ ...serviceOptions, dbPath: sourcePath, password,
      onTransaction: context => sourceNotifications?.onTransaction(context),
      playerExtraMutate: context => sourceNotifications?.mutate(context) })
    sourceNotifications = createPlayerNotifications(source.db, { ...mockKeys,
      subject: 'mailto:isolated-recovery@example.invalid', allowedPushHosts: [],
      sendBatchSize: 1, sendConcurrency: 1, leaseMs: 300000,
      pushSender: async () => { fakeSenderCalls++; await receiverGate } })
    const mutate = (path, body, actor = 'admin') => testMutate(source, actor, path, body)
    const fixture = await timed('seed', () => {
      const level = mutate('/levels', { name: '恢复演练等级', delaySeconds: 0 })
      const users = {}
      for (const role of ['support', 'finance', 'operations', 'player', 'otherPlayer', 'unrelatedPlayer']) {
        users[role] = mutate('/users', { username: `recovery-${role}`, name: `隔离${role}`,
          role: role.includes('Player') ? 'player' : role, status: 'active', levelId: level.id,
          maxActiveOrders: 5, permissionOverrides: {}, password })
      }
      const platforms = source.bootstrap('admin', undefined, { includeOrders: false, includeReports: false }).platforms
      for (const role of ['support', 'finance', 'operations']) mutate('/salary-plans', {
        userId: users[role].id, mode: role === 'finance' ? 'fixed' : 'base_commission',
        base: role === 'finance' ? 12000 : 6000, rate: role === 'support' ? 0 : null,
        platformRates: role === 'operations' ? Object.fromEntries(platforms.map(row => [row.id, 0])) : {},
        effectiveFrom: '2026-01-01', hourlyEnabled: false })
      const customer = mutate('/customers', { name: '隔离储值客户', contact: 'FIXTURE-CONTACT',
        gameId: 'FIXTURE-GAME', remark: 'FIXTURE-CUSTOMER-PRIVATE', platformId: 'xianyu' })
      const template = mutate('/templates', { name: '恢复演练项目', game: '隔离游戏',
        amount: 12000, reward: 8000, active: true })
      const financeImage = source.upload(users.finance.id, { name: '隔离付款凭证.png', mime: 'image/png', data: PNG })
      const rechargeBody = { customerId: customer.id, kind: 'recharge', amount: 50000,
        reason: '隔离充值', receipt: financeImage, requestId: randomUUID() }
      const recharge = mutate('/customer-transactions', rechargeBody, users.finance.id)
      mutate('/player-deposit-transactions', { userId: users.player.id, kind: 'deposit',
        amount: 5000, reason: '隔离押金', receipt: financeImage }, users.finance.id)
      const order = mutate('/orders', { templateId: template.id, customerId: customer.id,
        platformId: 'xianyu', shopId: 'jindun', externalOrderNo: 'RECOVERY-COMPLETED',
        roomCode: 'FIXTURE-ROOM', gameId: 'FIXTURE-GAME', playerRemark: '隔离可见说明',
        remark: 'FIXTURE-INTERNAL', amount: 12000, reward: 8000, dispatchMode: 'direct',
        assignedTo: users.player.id, paymentMethod: 'balance' }, users.support.id)
      const current = stateOf(source.db).orders.find(row => row.id === order.id)
      const claimBody = { requestId: randomUUID(), expectedRevision: current.revision, dispatchRound: current.dispatchRound }
      source.mutate(users.player.id, `/player/orders/${order.id}/claim`, claimBody)
      const screenshot = source.upload(users.player.id, { name: '隔离上报.png', mime: 'image/png', data: PNG })
      mutate(`/player/orders/${order.id}/submit`, { screenshots: [screenshot], teammateId: users.otherPlayer.id }, users.player.id)
      mutate(`/orders/${order.id}/action`, { action: 'review-pass' }, users.finance.id)
      mutate('/player-adjustments', { userId: users.player.id, kind: 'supplement', amount: 250,
        reason: '隔离报酬补款' }, users.finance.id)
      const withdrawalRequest = withdrawalBody(source, users.player.id, 1000)
      const withdrawal = mutate('/player/withdrawals', withdrawalRequest, users.player.id)
      mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' }, users.finance.id)
      mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'pay', receipt: financeImage }, users.finance.id)
      const otherWithdrawal = mutate('/player/withdrawals', withdrawalBody(source, users.otherPlayer.id, 500), users.otherPlayer.id)
      mutate('/refunds', { orderId: order.id, amount: 1000, reason: '隔离储值退款' }, users.finance.id)
      mutate('/expenses', { category: '隔离费用', amount: 700,
        date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), purpose: '隔离登记费用', receipt: financeImage }, users.finance.id)
      mutate('/attendance', { userId: users.finance.id, date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
        start: '09:00', end: '18:00', status: 'normal', actualHours: null, remark: '隔离考勤' })
      const month = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7)
      const payroll = mutate('/payrolls', { month })
      const pending = mutate('/orders', { templateId: template.id, customerId: customer.id,
        platformId: 'xianyu', shopId: 'jindun', externalOrderNo: 'RECOVERY-PENDING-PAID',
        roomCode: 'FIXTURE-PENDING-ROOM', gameId: 'FIXTURE-GAME', amount: 6000, reward: 4000,
        dispatchMode: 'direct', assignedTo: users.player.id, paymentMethod: 'balance' }, users.support.id)
      mutate('/orders', { templateId: template.id, customerId: customer.id,
        platformId: 'hall', externalOrderNo: 'RECOVERY-POOL-UNPAID',
        roomCode: 'FIXTURE-POOL-ROOM', gameId: 'FIXTURE-GAME', amount: 7000, reward: 4000,
        dispatchMode: 'pool', paymentMethod: 'cash', payOnArrival: true }, users.support.id)
      const appearance = source.getAppearance('admin')
      const cardImage = source.upload('admin', { name: '隔离全局订单卡图.png', mime: 'image/png', data: PNG })
      mutate('/appearance', { revision: appearance.revision,
        config: { ...appearance, studioName: '隔离恢复演练', playerOrderCardImage: cardImage } })
      mutate('/player/notification-settings', { pool: true, push: true }, users.player.id)
      const deviceKeys = createECDH('prime256v1'); deviceKeys.generateKeys()
      mutate('/player/push-subscriptions', { subscription: { endpoint: `https://fcm.googleapis.com/recovery-fixture/${randomUUID()}`,
        keys: { p256dh: deviceKeys.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } }, users.player.id)
      mutate('/player/push-subscriptions/test', {}, users.player.id)
      mutate('/player/push-subscriptions/test', {}, users.player.id)
      const sessions = {}
      for (const role of ['finance', 'player', 'otherPlayer', 'support'])
        sessions[role] = source.login(users[role].username, password).token
      const privateQr = source.playerPaymentMethods(users.player.id)[0].qrCode
      return { users, customer, order, pending, recharge, rechargeBody, claimBody,
        withdrawal, withdrawalRequest, otherWithdrawal, payroll, screenshot, privateQr, cardImage, sessions }
    })
    const cutState = stateOf(source.db)
    const businessSummary = service => ({
      customerBalance: service.customerBalance('admin', fixture.customer.id).balance,
      customerTransactions: service.customerTransactions('admin', fixture.customer.id).total,
      playerDeposit: service.playerDeposit('admin', fixture.users.player.id).balance,
      playerDepositTransactions: service.playerDeposit('admin', fixture.users.player.id).total,
      wallets: ['player', 'otherPlayer'].map(role => service.playerWallet(fixture.users[role].id, { includeRecords: false }))
    })
    const atCut = businessSummary(source)
    assert.ok(cutState.orders.length >= 3 && cutState.payrolls.length === 1 && cutState.payrolls[0].lines.some(row => row.total > 0))
    assert.ok(atCut.customerBalance > 0 && atCut.playerDeposit > 0 && atCut.wallets.every(row => row.earned > 0))
    heldFlush = sourceNotifications.flushPush()
    assert.equal(fakeSenderCalls, 1)
    assert.equal(scalar(source.db, "SELECT COUNT(*) FROM player_push_outbox WHERE status='processing' AND lease_token IS NOT NULL"), 1)
    assert.ok(scalar(source.db, "SELECT COUNT(*) FROM player_push_outbox WHERE status='pending'") >= 1)
    const cutTables = tableSummaries(source.db)
    assert.ok(cutTables.audit_logs.rows > 0 && cutTables.audit_logs_archive.rows > 0 && cutTables.uploads.rows >= 4)
    assert.ok(cutTables.fund_transactions.rows >= 5 && cutTables.business_requests.rows > 0 && cutTables.financial_requests.rows > 0)
    report.fixture = { orders: cutState.orders.length, players: cutState.users.filter(row => row.role === 'player').length,
      customers: cutState.customers.length, payrolls: cutState.payrolls.length, payrollTotal: cutState.payrolls[0].lines.reduce((sum, row) => sum + row.total, 0),
      withdrawals: cutState.withdrawals.length, rewardCredits: cutState.rewardCredits.length, expenses: cutState.expenses.length,
      manualRewardReviews: cutState.rewardReviews.length, business: atCut }
    const backup = await timed('backup', () => backupStudioDatabase(sourcePath, backupPath, { applicationRelease: fingerprintBefore.digest }))
    const verified = await timed('backupVerification', () => verifyStudioBackup(backupPath))
    assert.equal(verified.hashVerification, 'verified'); assert.equal(verified.schemaVersion, 2)
    report.backup = { ...verified, status: backup.metadata.status }
    report.recoveryPoint = { startedAt: backup.metadata.startedAt, completedAt: backup.metadata.completedAt,
      dataVersion: cutState.dataVersion, exactFixtureStateCaptured: true, sourceWritesDuringCopy: 0,
      rule: 'SQLite snapshot is consistent; this controlled fixture performed no transaction during the copy.' }
    const later = await timed('sourcePostBackupTransactions', () => ({
      recharge: mutate('/customer-transactions', { customerId: fixture.customer.id, kind: 'recharge', amount: 777,
        reason: '备份后源库新增充值保持', requestId: randomUUID() }, fixture.users.finance.id),
      deposit: mutate('/player-deposit-transactions', { userId: fixture.users.player.id, kind: 'deposit', amount: 333,
        reason: '备份后源库新增押金保持', requestId: randomUUID() }, fixture.users.finance.id),
      supplement: mutate('/player-adjustments', { userId: fixture.users.player.id, kind: 'supplement', amount: 111,
        reason: '备份后源库新增补款保持', requestId: randomUUID() }, fixture.users.finance.id)
    }))
    const sourceAfterTransactionsTables = tableSummaries(source.db)
    await timed('restorePristineCopy', () => restoreStudioDatabase(backupPath, restoredPath))
    await timed('verifyPristineCopyReadOnly', () => {
      const baseline = new DatabaseSync(backupPath, { readOnly: true }), recovered = new DatabaseSync(restoredPath, { readOnly: true })
      try {
        recovered.exec('PRAGMA query_only=ON')
        assert.ok(recovered.prepare('PRAGMA integrity_check').all().every(row => Object.values(row)[0] === 'ok'))
        assert.deepEqual(stateOf(recovered), cutState)
        const recoveredTables = tableSummaries(recovered)
        assert.deepEqual(tableSummaries(baseline), cutTables)
        assert.deepEqual(recoveredTables, cutTables)
        assert.equal(schemaSummary(recovered), schemaSummary(baseline))
        report.restored = { integrity: 'ok', schemaVersion: stateOf(recovered).schemaVersion,
          schemaSha256: schemaSummary(recovered), tables: recoveredTables, tableCount: Object.keys(recoveredTables).length,
          sameExactRecords: true, sameBlobBytes: true, sameSchemaIndexesAndTriggers: true, initializedApplication: false }
      } finally { recovered.close(); baseline.close() }
    })
    await timed('restoreOfflineSwitchProbe', () => restoreStudioDatabase(backupPath, policyPath))
    let policyTime = new Date()
    policy = createStudioService({ ...serviceOptions, dbPath: policyPath, password: 'unused-offline-copy-password', clock: () => policyTime })
    policyNotifications = createPlayerNotifications(policy.db, { clock: () => policyTime,
      publicKey: '', privateKey: '', subject: '', allowedPushHosts: [],
      pushSender: async () => { forbiddenOfflineSenderCalls++; throw new Error('Offline sends forbidden') } })
    await timed('authorizationAndSwitchPolicy', async () => {
      assert.deepEqual(businessSummary(policy), atCut)
      assert.equal(policy.download(fixture.users.player.id, fixture.screenshot.id).data.byteLength, Buffer.from(PNG, 'base64').byteLength)
      assert.equal(policy.getAppearance('admin').playerOrderCardImage.id, fixture.cardImage.id)
      assert.ok(policy.session(fixture.sessions.player, { readOnly: true }))
      assert.ok(policy.session(fixture.sessions.finance, { readOnly: true }))
      reject(() => policy.download(fixture.users.unrelatedPlayer.id, fixture.privateQr.id), 403)
      reject(() => policy.playerOrderDetail(fixture.users.unrelatedPlayer.id, fixture.order.id), 403)
      const ownOrder = policy.playerOrderDetail(fixture.users.player.id, fixture.order.id)
      assert.equal(Object.hasOwn(ownOrder, 'remark'), false)
      assert.equal(Object.hasOwn(ownOrder, 'customerId'), false)
      reject(() => policy.customerTransactions(fixture.users.support.id, fixture.customer.id), 403)
      reject(() => policy.playerDeposit(fixture.users.player.id, fixture.users.otherPlayer.id), 403)
      const beforeRetry = tableSummaries(policy.db)
      const replay = policy.mutate(fixture.users.finance.id, '/customer-transactions', fixture.rechargeBody, {
        sessionToken: fixture.sessions.finance, expectedActorId: fixture.users.finance.id, requireActor: true })
      assert.equal(replay.id, fixture.recharge.id)
      const originalWithdrawal = policy.mutate(fixture.users.player.id, '/player/withdrawals', fixture.withdrawalRequest, {
        sessionToken: fixture.sessions.player, expectedActorId: fixture.users.player.id, requireActor: true })
      assert.equal(originalWithdrawal.id, fixture.withdrawal.id)
      assert.equal(originalWithdrawal.status, 'pending')
      assert.equal(policy.playerWithdrawalsPage(fixture.users.player.id).records.find(row => row.id === originalWithdrawal.id).status, 'paid')
      const originalResult = policy.playerOperationResult(fixture.users.player.id, fixture.claimBody.requestId, 'claim')
      assert.equal(originalResult.status, 'succeeded')
      assert.equal(originalResult.canCreateNew, false)
      assert.equal(originalResult.result, 'confirmation-only')
      reject(() => policy.mutate(fixture.users.player.id, `/player/orders/${fixture.order.id}/claim`,
        { ...fixture.claimBody, requestId: randomUUID() }), 409)
      reject(() => policy.mutate(fixture.users.finance.id, '/customer-transactions', { ...fixture.rechargeBody, amount: 50001 }), 409)
      reject(() => policy.mutate(fixture.users.finance.id, '/customer-transactions', fixture.rechargeBody, {
        sessionToken: fixture.sessions.finance, expectedActorId: fixture.users.player.id, requireActor: true }), 409, 'PRINCIPAL_CHANGED')
      const otherActorResult = policy.playerOperationResult(fixture.users.otherPlayer.id, fixture.claimBody.requestId, 'claim')
      assert.equal(otherActorResult.status, 'not-recorded')
      assert.equal(otherActorResult.canCreateNew, false)
      assert.deepEqual(tableSummaries(policy.db), beforeRetry)
      policyTime = new Date(policyTime.getTime() + 13 * 3600000)
      assert.equal(policy.session(fixture.sessions.player, { readOnly: true }), null)
      policyTime = new Date()
      policy.logout(fixture.sessions.player)
      assert.equal(policy.session(fixture.sessions.player, { readOnly: true }), null)
      const financeUser = stateOf(policy.db).users.find(row => row.id === fixture.users.finance.id)
      testMutate(policy, 'admin', '/users', { ...financeUser, permissionOverrides: { ...financeUser.permissionOverrides, 'finance.refunds': false } })
      const afterRevocation = tableSummaries(policy.db)
      reject(() => policy.mutate(fixture.users.finance.id, '/customer-transactions', fixture.rechargeBody, {
        sessionToken: fixture.sessions.finance, expectedActorId: fixture.users.finance.id, requireActor: true }), 403)
      assert.deepEqual(tableSummaries(policy.db), afterRevocation)
      const beforeQueue = { sessions: scalar(policy.db, 'SELECT COUNT(*) FROM sessions'),
        subscriptions: scalar(policy.db, 'SELECT COUNT(*) FROM player_push_subscriptions'),
        pending: scalar(policy.db, "SELECT COUNT(*) FROM player_push_outbox WHERE status='pending'"),
        processing: scalar(policy.db, "SELECT COUNT(*) FROM player_push_outbox WHERE status='processing'"),
        leases: scalar(policy.db, 'SELECT COUNT(*) FROM player_push_outbox WHERE lease_token IS NOT NULL') }
      assert.ok(beforeQueue.sessions > 0 && beforeQueue.subscriptions > 0 && beforeQueue.pending > 0 && beforeQueue.processing > 0 && beforeQueue.leases > 0)
      const beforeDisabledFlush = tableSummaries(policy.db)
      assert.deepEqual(await policyNotifications.flushPush(), { claimed: 0, sent: 0 })
      assert.deepEqual(tableSummaries(policy.db), beforeDisabledFlush)
      const businessBeforeSwitch = businessSummary(policy), stateBeforeSwitch = stateOf(policy.db)
      policy.db.exec('BEGIN IMMEDIATE')
      try {
        policy.db.prepare('DELETE FROM sessions').run()
        for (const { user_id } of policy.db.prepare('SELECT DISTINCT user_id FROM player_push_subscriptions').all()) policyNotifications.revoke(user_id)
        policy.db.exec('COMMIT')
      } catch (error) { policy.db.exec('ROLLBACK'); throw error }
      const afterQueue = { sessions: scalar(policy.db, 'SELECT COUNT(*) FROM sessions'),
        subscriptions: scalar(policy.db, 'SELECT COUNT(*) FROM player_push_subscriptions'),
        pending: scalar(policy.db, "SELECT COUNT(*) FROM player_push_outbox WHERE status='pending'"),
        processing: scalar(policy.db, "SELECT COUNT(*) FROM player_push_outbox WHERE status='processing'"),
        leases: scalar(policy.db, 'SELECT COUNT(*) FROM player_push_outbox WHERE lease_token IS NOT NULL') }
      assert.deepEqual(afterQueue, { sessions: 0, subscriptions: 0, pending: 0, processing: 0, leases: 0 })
      assert.deepEqual(stateOf(policy.db), stateBeforeSwitch)
      assert.deepEqual(businessSummary(policy), businessBeforeSwitch)
      for (const token of Object.values(fixture.sessions)) assert.equal(policy.session(token, { readOnly: true }), null)
      reject(() => policy.mutate(fixture.users.finance.id, '/customer-transactions', fixture.rechargeBody, {
        sessionToken: fixture.sessions.finance, expectedActorId: fixture.users.finance.id, requireActor: true }), 401, 'SESSION_EXPIRED')
      replacementNotifications = createPlayerNotifications(policy.db, { ...webpush.generateVAPIDKeys(),
        subject: 'mailto:isolated-replacement@example.invalid', allowedPushHosts: [], clock: () => policyTime,
        pushSender: async () => { forbiddenOfflineSenderCalls++; throw new Error('No old binding may send') } })
      assert.deepEqual(await replacementNotifications.flushPush(), { claimed: 0, sent: 0 })
      const beforeSourceAcknowledgement = tableSummaries(policy.db)
      assert.deepEqual(tableSummaries(source.db), sourceAfterTransactionsTables)
      releaseSender(); const flushed = await heldFlush; heldFlush = null
      assert.equal(flushed.sent, 1)
      assert.deepEqual(tableSummaries(policy.db), beforeSourceAcknowledgement)
      assert.equal(forbiddenOfflineSenderCalls, 0)
      assert.equal(source.session(fixture.sessions.player, { readOnly: true }).id, fixture.users.player.id)
      assert.equal(scalar(source.db, 'SELECT COUNT(*) FROM player_push_subscriptions'), beforeQueue.subscriptions)
      report.switchPolicy = { originalSessionAcceptedUntilExpiry: true, simulatedExpiryHours: 13, logoutRevoked: true,
        originalSuccessRetryWithoutAnyRecordChange: true, changedBodyRejected: true, actorMismatchRejected: true,
        originalResponseThenLatestStateKeepsPaidWithdrawal: true, staleNewRequestRejected: true,
        otherActorResultNotRecorded: true, currentPermissionRevocationCheckedBeforeOriginalSuccessRetry: true,
        privateAttachmentsAndFundsDenied: true, unconfiguredFlushReadOnly: true,
        before: beforeQueue, after: afterQueue, explicitResetOnlyOnProbe: true,
        businessAndConfigurationUnaffectedBySessionSubscriptionReset: true, replacementClaimedOldQueue: 0,
        originalSourceLateAcknowledgementDidNotTouchProbe: true, sourceSessionsAndSubscriptionsPreserved: true,
        fakeSourceReceiverCalls: fakeSenderCalls, realExternalSends: 0 }
    })
    const sourceBeforeFinalVerification = tableSummaries(source.db), sourceAfter = businessSummary(source)
    const withoutOutbox = tables => Object.fromEntries(Object.entries(tables).filter(([name]) => name !== 'player_push_outbox'))
    assert.deepEqual(withoutOutbox(sourceBeforeFinalVerification), withoutOutbox(sourceAfterTransactionsTables))
    assert.equal(sourceAfter.customerBalance, atCut.customerBalance + 777)
    assert.equal(sourceAfter.playerDeposit, atCut.playerDeposit + 333)
    assert.equal(sourceAfter.wallets[0].earned, atCut.wallets[0].earned + 111)
    assert.equal(sourceAfter.customerTransactions, atCut.customerTransactions + 1)
    assert.equal(sourceAfter.playerDepositTransactions, atCut.playerDepositTransactions + 1)
    assert.ok(stateOf(source.db).playerAdjustments.some(row => row.id === later.supplement.id))
    const restored = new DatabaseSync(restoredPath, { readOnly: true })
    try { assert.deepEqual(tableSummaries(restored), cutTables) }
    finally { restored.close() }
    assert.deepEqual(tableSummaries(source.db), sourceBeforeFinalVerification)
    assert.deepEqual(await backupFileDigest(backupPath), { bytes: verified.bytes, sha256: verified.sha256 })
    report.sourcePreservation = { sourceNewOperations: 3, amountsCents: { recharge: 777, deposit: 333, supplement: 111 },
      before: atCut, after: sourceAfter, allNewRecordsStillPresent: true, offlineProbeDidNotWriteSource: true,
      allSourceTablesUnchangedByRestoresAndProbe: true, soleExpectedTableChangeFromOwnHeldSender: 'player_push_outbox',
      sourceNewDataVersion: stateOf(source.db).dataVersion }
    report.possibleLossRange = { observedPostSnapshotOperationsExcludedFromRestore: 3,
      firstPostSnapshotAt: later.recharge.createdAt, lastPostSnapshotAt: later.supplement.createdAt,
      observedSnapshotToLastTransactionMs: Math.max(0, Date.parse(later.supplement.createdAt) - Date.parse(verified.completedAt)),
      noAutomaticMergeOrSourceOverwrite: true,
      note: 'A production switch would exclude transactions after the selected snapshot unless separately reconciled. This drill preserves all three in the still-independent source and intentionally restores the earlier point.' }
    report.checks.push('Exact schema and every table/BLOB restored into a new read-only copy',
      'Nonempty orders, split rewards, wallet, stored balance, deposit, paid/pending withdrawals, salary, payroll, receipts, hot/cold audit, notifications, idempotency and appearance configuration',
      'Restored duplicate operation returns original result with zero table changes; changed payload, actor mismatch, revoked permission and private-data access remain rejected',
      'Old session expiry/logout/reset and subscription/pending/processing/lease reset tested on separate offline probe; new sender claims no old queue',
      'Source post-backup recharge/deposit/reward supplement survives all restores and policy checks')
    report.localRecoveryMs = round(report.timingsMs.restorePristineCopy + report.timingsMs.verifyPristineCopyReadOnly +
      report.timingsMs.restoreOfflineSwitchProbe + report.timingsMs.authorizationAndSwitchPolicy)
    report.success = true
  } catch (error) {
    report.failure = { stage: report.stages.at(-1)?.stage ?? 'setup', name: error.name,
      code: error.code ?? null, message: error.message, stack: error.stack }
  } finally {
    releaseSender?.()
    if (heldFlush) await heldFlush.catch(() => {})
    replacementNotifications?.close(); policyNotifications?.close(); policy?.close()
    sourceNotifications?.close(); source?.close()
    report.completedAt = new Date().toISOString()
    report.timingsMs.total = round(performance.now() - started)
    const fingerprintAfter = sourceFingerprint()
    writeFileSync(join(directory, 'source-after.json'), JSON.stringify(fingerprintAfter, null, 2))
    report.source = { before: fingerprintBefore.digest, after: fingerprintAfter.digest,
      files: Object.keys(fingerprintBefore.files).length, unchanged: fingerprintBefore.digest === fingerprintAfter.digest }
    if (!report.source.unchanged) {
      report.success = false
      report.source.changedFiles = [...new Set([...Object.keys(fingerprintBefore.files), ...Object.keys(fingerprintAfter.files)])]
        .filter(name => fingerprintBefore.files[name] !== fingerprintAfter.files[name])
    }
    report.finalAcceptance = Boolean(finalEvidence && report.success && report.source.unchanged)
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(argument => argument !== '--final')) throw new Error('Only --final is supported; no custom business-database path is accepted')
  const report = await runRecoveryDrill({ finalEvidence: process.argv.includes('--final') })
  console.log(JSON.stringify({ success: report.success, directory: report.directory, source: report.source,
    tables: report.restored?.tableCount ?? 0, timingsMs: report.timingsMs, failure: report.failure ?? null }, null, 2))
  if (!report.success) process.exitCode = 1
}
