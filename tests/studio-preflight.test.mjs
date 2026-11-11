import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  existsSync,
  realpathSync,
  lstatSync,
  copyFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { runPreflight } from '../scripts/studio-preflight.mjs'
import { buildFingerprint } from '../scripts/studio-release.mjs'
import { backupStudioDatabase } from '../scripts/studio-backup.mjs'
import { createBackupScheduler } from '../server/backup-scheduler.mjs'

const timestamp = Date.parse('2026-10-15T00:00:00.000Z')
const iso = new Date(timestamp).toISOString()
const hash = (value) => createHash('sha256').update(value).digest('hex')
const check = (report, code) => {
  const item = report.checks.find((row) => row.code === code)
  assert.ok(item, `missing check ${code}`)
  return item
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-preflight-fixture-'))
  const adminDirectory = join(root, 'dist'),
    playerDirectory = join(root, 'player-client', 'dist')
  const dataDirectory = join(root, '.data'),
    opsDirectory = join(root, '.ops'),
    backupDirectory = join(dataDirectory, 'backups')
  for (const directory of [
    adminDirectory,
    playerDirectory,
    dataDirectory,
    opsDirectory,
    backupDirectory
  ])
    mkdirSync(directory, { recursive: true })
  for (const [directory, label] of [
    [adminDirectory, 'admin'],
    [playerDirectory, 'player']
  ]) {
    mkdirSync(join(directory, 'assets'))
    writeFileSync(
      join(directory, 'index.html'),
      `<html><body>${label}<script src="assets/main.js"></script></body></html>`
    )
    writeFileSync(join(directory, 'assets', 'main.js'), `console.log('${label} fixture')`)
  }
  writeFileSync(join(opsDirectory, 'manager.log'), 'SAFE_FIXTURE_LIFECYCLE\n')
  const dbPath = join(dataDirectory, 'studio.sqlite')
  const state = {
    schemaVersion: 2,
    demo: false,
    users: [
      {
        id: 'admin-fixture',
        name: 'FAKE_PRIVATE_NAME',
        username: 'FAKE_PRIVATE_USERNAME',
        role: 'super_admin',
        status: 'active'
      },
      { id: 'finance-fixture', name: 'FAKE_PRIVATE_FINANCE', role: 'finance', status: 'active' },
      { id: 'player-disabled', role: 'player', status: 'active', playerAccess: { login: false } }
    ],
    passwords: {
      'admin-fixture': 'FAKE_HASH_SECRET_123',
      'finance-fixture': 'FAKE_PASSWORD_SECRET_456'
    },
    platforms: [
      { id: 'hall', name: '游戏大厅' },
      { id: 'source-fixture', name: 'FAKE_PRIVATE_SOURCE_NAME' }
    ],
    shops: [{ id: 'shop-fixture', name: 'FAKE_PRIVATE_SHOP_NAME' }],
    salaryPlans: [
      {
        id: 'plan-fixture',
        userId: 'finance-fixture',
        mode: 'fixed',
        base: 123456789,
        rate: null,
        effectiveFrom: '2026-01-01',
        platformRates: {}
      }
    ],
    templates: [
      {
        id: 'template-fixture',
        name: 'FAKE_PRIVATE_TEMPLATE',
        active: true,
        amount: 87654321,
        reward: 7654321
      }
    ],
    customers: [{ contact: 'FAKE_PRIVATE_CONTACT', gameId: 'FAKE_PRIVATE_GAME_ID' }],
    orders: [
      {
        amount: 987654321,
        roomCode: 'FAKE_PRIVATE_ROOM',
        remark: 'FAKE_PRIVATE_REMARK',
        receipt: 'FAKE_PRIVATE_RECEIPT'
      }
    ]
  }
  const database = new DatabaseSync(dbPath)
  database.exec('CREATE TABLE studio_state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)')
  database.prepare('INSERT INTO studio_state VALUES(1,?)').run(JSON.stringify(state))
  for (const table of [
    'sessions',
    'uploads',
    'fund_accounts',
    'fund_transactions',
    'audit_logs',
    'business_requests',
    'financial_requests',
    'player_notifications',
    'player_push_outbox'
  ])
    database.exec(`CREATE TABLE ${table}(id INTEGER)`)
  database.close()
  const facts = () => {
    const sourceFiles = { 'server/safe-fixture.mjs': hash('isolated safe source fixture') }
    const source = { files: sourceFiles, digest: hash(JSON.stringify(sourceFiles)) },
      admin = buildFingerprint(adminDirectory),
      player = buildFingerprint(playerDirectory)
    return {
      source,
      admin,
      player,
      id: hash([source.digest, admin.digest, player.digest].join(':'))
    }
  }
  const current = facts(),
    manifestPath = join(dataDirectory, 'release.json')
  const manifest = {
    format: 'studio-release-v1',
    id: current.id,
    generatedAt: iso,
    sourceDigest: current.source.digest,
    adminDigest: current.admin.digest,
    playerDigest: current.player.digest,
    sourceFiles: current.source.files,
    adminFiles: current.admin.files,
    playerFiles: current.player.files
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const evidencePaths = {}
  const evidenceFlags = {
    service: {
      installed: true,
      running: true,
      autostartConfigured: true,
      runAccountVerified: true,
      managerRecoveryVerified: true,
      bootActuallyTested: true,
      deploymentSecurityVerified: true,
      backupsEnabled: true,
      backupIntervalMinutes: 120,
      backupRetentionCount: 12
    },
    'external-monitor': { independentHostConfigured: true, running: true },
    firewall: { privatePortsBlocked: true, onlyPublicWebPorts: true },
    replication: {
      remoteIdentityVerified: true,
      independentHostConfigured: true,
      hashVerified: true,
      lastSuccessAt: iso
    },
    recovery: {
      integrityOk: true,
      sourceNewTransactionsPreserved: true,
      authPolicyVerified: true,
      noExternalSideEffects: true
    },
    alert: { acceptedByService: true }
  }
  const evidence = (kind, patch = {}) => {
    const path = join(opsDirectory, `${kind}.json`)
    const value = {
      format: 'studio-ops-evidence-v1',
      kind,
      environment: 'production',
      releaseId: current.id,
      verified: true,
      nonSimulated: true,
      checkedAt: iso,
      ...evidenceFlags[kind],
      ...patch
    }
    writeFileSync(path, JSON.stringify(value))
    evidencePaths[kind] = path
    return value
  }
  for (const kind of Object.keys(evidenceFlags)) evidence(kind)
  const backupPath = join(backupDirectory, 'fixture.sqlite')
  await backupStudioDatabase(dbPath, backupPath, {
    applicationRelease: current.id,
    clock: () => timestamp
  })
  const config = {
    format: 'studio-ops-config-v1',
    environment: 'production',
    mode: 'internal',
    expectedRelease: current.id,
    credentialEnv: 'STUDIO_MONITOR_TOKEN',
    endpoints: {
      admin: 'https://app.example.invalid/admin/',
      player: 'https://player.example.invalid/player/',
      live: 'https://app.example.invalid/api/studio/health/live',
      ready: 'https://app.example.invalid/api/studio/health/ready',
      summary: 'https://app.example.invalid/api/studio/ops/summary',
      diagnostics: 'https://app.example.invalid/api/studio/ops/diagnostics-summary'
    },
    storage: { dbPath, opsDir: opsDirectory, backupDir: backupDirectory },
    thresholds: { diskFreeBytes: 1, walBytes: 10000000, logBytes: 10000000 },
    deployment: {
      region: 'fixture-region',
      provider: 'fixture-provider',
      domain: 'example.invalid',
      os: 'windows',
      httpsConfigured: true,
      secureCookie: true,
      allowedOrigins: ['https://app.example.invalid', 'https://player.example.invalid'],
      trustedProxies: ['127.0.0.1/32'],
      exposedPorts: [80, 443],
      serviceEvidence: evidencePaths.service,
      externalMonitorEvidence: evidencePaths['external-monitor'],
      firewallEvidence: evidencePaths.firewall
    },
    backups: {
      enabled: true,
      intervalMinutes: 120,
      retentionCount: 12,
      directory: backupDirectory,
      latestMetadata: backupPath + '.json',
      replication: {
        enabled: true,
        kind: 'remote',
        targetId: 'remote-fixture-id',
        evidencePath: evidencePaths.replication
      }
    },
    recovery: { evidencePath: evidencePaths.recovery },
    alerts: {
      authorized: true,
      targetEnv: 'STUDIO_OPS_ALERT_WEBHOOK',
      evidencePath: evidencePaths.alert
    }
  }
  const requests = []
  const fetcher = async (url, options) => {
    requests.push({ url, options })
    const path = new URL(url).pathname
    if (path.endsWith('/health/live'))
      return Response.json({ status: 'ok', service: 'studio-api', release: current.id })
    if (path.endsWith('/health/ready'))
      return Response.json({
        status: 'ready',
        service: 'studio-api',
        release: current.id,
        checks: { database: true }
      })
    for (const [prefix, directory] of [
      ['/admin/', adminDirectory],
      ['/player/', playerDirectory]
    ])
      if (path.startsWith(prefix)) {
        const file = path.slice(prefix.length) || 'index.html'
        return new Response(readFileSync(join(directory, file)), {
          headers: {
            'Content-Type': file === 'index.html' ? 'text/html' : 'application/javascript'
          }
        })
      }
    assert.fail('unexpected endpoint request')
  }
  const run = (options = {}) =>
    runPreflight({
      configPlainObject: config,
      rootDirectory: root,
      releaseManifestPath: manifestPath,
      clock: () => timestamp,
      releaseFacts: facts,
      releaseReader: (path, { verify }) => {
        assert.equal(verify, true)
        return JSON.parse(readFileSync(path, 'utf8'))
      },
      fetcher,
      ...options
    })
  const editState = (edit) => {
    const db = new DatabaseSync(dbPath)
    try {
      edit(state)
      db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
    } finally {
      db.close()
    }
  }
  t.after(async () => {
    const target = resolve(root),
      intended = resolve(tmpdir())
    assert.ok(target.startsWith(intended + sep) && target !== intended)
    assert.ok(target.split(sep).at(-1).startsWith('studio-preflight-fixture-'))
    const deadline = Date.now() + 3000
    for (;;) {
      try {
        rmSync(target, { recursive: true, force: true })
        break
      } catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || Date.now() >= deadline) throw error
        await new Promise((done) => setTimeout(done, 10))
      }
    }
  })
  return {
    root,
    config,
    current,
    manifest,
    manifestPath,
    dbPath,
    backupPath,
    opsDirectory,
    requests,
    fetcher,
    run,
    evidence,
    editState
  }
}

test('preflight missing config is never ready; complete isolated attested production fixture separates four dimensions', async (t) => {
  const empty = await runPreflight({ clock: () => timestamp })
  assert.equal(empty.ready, false)
  assert.equal(check(empty, 'OPS_CONFIG_VALID').status, 'FAIL')
  const f = await fixture(t),
    report = await f.run()
  assert.equal(
    report.ready,
    true,
    JSON.stringify(report.checks.filter((row) => row.status !== 'PASS'))
  )
  assert.equal(report.productionRequiredEvidenceAllTrue, true)
  assert.deepEqual(
    new Set(report.checks.map((row) => row.dimension)),
    new Set(['configuration', 'code', 'enabled', 'verified'])
  )
  assert.equal(check(report, 'API_READY_RELEASE_MATCHES').facts.releaseMatches, true)
  assert.equal(check(report, 'ADMIN_SERVED_BUILD_MATCHES').facts.assetsChecked, 1)
  assert.equal(check(report, 'PLAYER_SERVED_BUILD_MATCHES').facts.assetsChecked, 1)
  for (const request of f.requests) {
    assert.equal(request.options.method, 'GET')
    assert.equal(request.options.credentials, 'omit')
    assert.equal(request.options.headers?.Authorization, undefined)
    assert.equal(request.options.headers?.cookie, undefined)
    assert.ok(!request.url.includes('/ops/'))
  }
})

test('example/local scope and missing formal parameters or evidence remain WARN and not production ready', async (t) => {
  const f = await fixture(t)
  f.config.environment = 'local'
  f.config.expectedRelease = null
  f.config.deployment = {
    region: null,
    provider: null,
    domain: null,
    os: null,
    httpsConfigured: false,
    secureCookie: false,
    allowedOrigins: [],
    trustedProxies: [],
    exposedPorts: []
  }
  f.config.backups = {
    enabled: false,
    intervalMinutes: 0,
    retentionCount: 7,
    directory: f.config.storage.backupDir,
    replication: { enabled: false, kind: 'none' }
  }
  f.config.alerts = { authorized: false, targetEnv: 'STUDIO_OPS_ALERT_WEBHOOK' }
  f.config.recovery = {}
  const report = await f.run()
  assert.equal(report.ready, false)
  assert.equal(check(report, 'REGION_PROVIDER_DECLARED').status, 'WARN')
  assert.equal(check(report, 'SERVICE_INSTALLED_RUNNING').status, 'WARN')
  assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').status, 'WARN')
  assert.equal(check(report, 'ALERT_CHANNEL_ACTUALLY_VERIFIED').status, 'WARN')
  assert.equal(check(report, 'BACKUP_SCHEDULE_CONFIGURED').facts.nominalCoverageHours, null)
})

test('old manifest, mismatched component fingerprints and wrong API release cannot pass', async (t) => {
  const f = await fixture(t)
  writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, sourceDigest: 'a'.repeat(64) }))
  const stale = await f.run()
  assert.equal(stale.ready, false)
  assert.equal(check(stale, 'RELEASE_SOURCE_BUILDS_VERIFIED').status, 'FAIL')
  assert.equal(check(stale, 'API_READY_RELEASE_MATCHES').status, 'FAIL')
  writeFileSync(
    f.manifestPath,
    JSON.stringify({
      ...f.manifest,
      adminFiles: { ...f.manifest.adminFiles, 'index.html': hash('old served entry') }
    })
  )
  const tamperedMap = await f.run()
  assert.equal(check(tamperedMap, 'RELEASE_SOURCE_BUILDS_VERIFIED').status, 'FAIL')
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest))
  const wrongAPI = await f.run({
    fetcher: async (url, options) =>
      new URL(url).pathname.endsWith('/health/ready')
        ? Response.json({
            status: 'ready',
            service: 'studio-api',
            release: 'f'.repeat(64),
            checks: { database: true }
          })
        : f.fetcher(url, options)
  })
  assert.equal(check(wrongAPI, 'RELEASE_SOURCE_BUILDS_VERIFIED').status, 'PASS')
  assert.equal(check(wrongAPI, 'API_READY_RELEASE_MATCHES').status, 'FAIL')
  assert.equal(wrongAPI.ready, false)
})

test('200 HTML health false positive and stale static asset are rejected despite valid current builds/index', async (t) => {
  const f = await fixture(t)
  const report = await f.run({
    fetcher: async (url, options) => {
      const path = new URL(url).pathname
      if (path.endsWith('/health/ready'))
        return new Response('<html>wrong upstream</html>', {
          headers: { 'Content-Type': 'text/html' }
        })
      if (path === '/admin/assets/main.js')
        return new Response('old asset', { headers: { 'Content-Type': 'application/javascript' } })
      return f.fetcher(url, options)
    }
  })
  assert.equal(check(report, 'RELEASE_SOURCE_BUILDS_VERIFIED').status, 'PASS')
  assert.equal(check(report, 'API_READY_RELEASE_MATCHES').status, 'FAIL')
  assert.equal(check(report, 'ADMIN_SERVED_BUILD_MATCHES').status, 'FAIL')
  assert.equal(check(report, 'PLAYER_SERVED_BUILD_MATCHES').status, 'PASS')
  assert.equal(report.ready, false)
})

test('account/demo/salary/template/source SQL reports only counts and booleans, never secret/private values', async (t) => {
  const f = await fixture(t)
  f.editState((state) => {
    state.demo = true
    delete state.passwords['finance-fixture']
    state.salaryPlans[0].base = null
    state.templates[0].amount = null
    state.users.push({
      id: 'unknown-role',
      role: 'FAKE_PRIVATE_ROLE',
      name: 'FAKE_PRIVATE_NAME',
      status: 'inactive'
    })
  })
  f.config.credentialValue = 'FAKE_AUTH_SECRET'
  const report = await f.run(),
    counts = check(report, 'DATABASE_CONFIGURATION_COUNTS').facts
  assert.equal(counts.roleCounts.super_admin, 1)
  assert.equal(counts.roleCounts.finance, 1)
  assert.equal(counts.roleCounts.unknown, 1)
  assert.equal(counts.missingCredentialAccounts, 1)
  // Match the existing payroll employee selection, which also retains inactive staff.
  assert.equal(counts.incompleteSalaryAccounts, 2)
  assert.equal(counts.incompleteActiveTemplates, 1)
  assert.equal(check(report, 'LOGIN_ACCOUNTS_HAVE_CREDENTIALS').status, 'FAIL')
  assert.equal(check(report, 'DEMO_DATA_DISABLED').status, 'FAIL')
  assert.equal(check(report, 'BUSINESS_SETUP_COMPLETE').status, 'FAIL')
  assert.doesNotMatch(
    JSON.stringify(report),
    /FAKE_PRIVATE|FAKE_HASH|FAKE_PASSWORD|FAKE_AUTH|87654321|7654321|987654321|123456789/
  )
})

test('all preflight database/backup/evidence/build file contents remain unchanged after inspection', async (t) => {
  const f = await fixture(t)
  const fingerprint = () => {
    const files = {}
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else files[path] = hash(readFileSync(path))
      }
    }
    visit(f.root)
    return files
  }
  const before = fingerprint()
  const report = await f.run()
  assert.equal(report.ready, true)
  assert.deepEqual(fingerprint(), before)
  const db = new DatabaseSync(f.dbPath, { readOnly: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM studio_state').get().n, 1)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'ops_%'").get().n,
    0
  )
  db.close()
})

test('same-release fresh non-simulated evidence is mandatory; wrong version, stale, release mismatch and simulations fail', async (t) => {
  const f = await fixture(t)
  f.evidence('service', { format: 'old-evidence', installed: true, running: true })
  f.evidence('external-monitor', { releaseId: 'b'.repeat(64) })
  f.evidence('firewall', { checkedAt: '2026-10-12T00:00:00.000Z' })
  f.evidence('recovery', { nonSimulated: false })
  f.evidence('alert', { verified: false, extra: 'FAKE_PRIVATE_SECRET' })
  const report = await f.run()
  for (const code of [
    'SERVICE_INSTALLED_RUNNING',
    'EXTERNAL_MONITOR_ACTUALLY_RUNNING',
    'FIREWALL_ACTUALLY_VERIFIED',
    'OFFLINE_RECOVERY_ACTUALLY_VERIFIED',
    'ALERT_CHANNEL_ACTUALLY_VERIFIED'
  ])
    assert.equal(check(report, code).status, 'FAIL')
  assert.equal(report.ready, false)
  assert.doesNotMatch(JSON.stringify(report), /FAKE_PRIVATE_SECRET/)
})

test('configured enabled is distinct from runtime/evidence: boot, backup runtime and independent remote host must be proven', async (t) => {
  const f = await fixture(t)
  f.evidence('service', {
    bootActuallyTested: false,
    backupsEnabled: false,
    deploymentSecurityVerified: false
  })
  f.evidence('replication', { independentHostConfigured: false })
  const report = await f.run()
  assert.equal(check(report, 'SERVICE_INSTALLED_RUNNING').status, 'PASS')
  assert.equal(check(report, 'SERVICE_AUTOSTART_RECOVERY_VERIFIED').status, 'FAIL')
  assert.equal(check(report, 'SECURE_COOKIE_CONFIGURED').status, 'PASS')
  assert.equal(check(report, 'DEPLOYMENT_SECURITY_ACTUALLY_VERIFIED').status, 'FAIL')
  assert.equal(check(report, 'BACKUP_SCHEDULE_CONFIGURED').status, 'PASS')
  assert.equal(check(report, 'BACKUP_RUNTIME_ENABLED_VERIFIED').status, 'FAIL')
  assert.equal(check(report, 'REMOTE_REPLICATION_CONFIGURED').status, 'PASS')
  assert.equal(check(report, 'REMOTE_REPLICATION_ACTUALLY_VERIFIED').status, 'FAIL')
  f.config.backups.replication.kind = 'simulation'
  f.evidence('replication')
  const simulated = await f.run()
  assert.equal(check(simulated, 'REMOTE_REPLICATION_CONFIGURED').status, 'FAIL')
  assert.equal(check(simulated, 'REMOTE_REPLICATION_ACTUALLY_VERIFIED').status, 'FAIL')
})

test('backup coverage is explicit nominal hours and actual recent completion hash must match bytes', async (t) => {
  const f = await fixture(t),
    valid = await f.run()
  assert.equal(check(valid, 'BACKUP_SCHEDULE_CONFIGURED').facts.nominalCoverageHours, 22)
  assert.equal(
    check(valid, 'BACKUP_SCHEDULE_CONFIGURED').facts.coverageAssumesConsecutiveSuccesses,
    true
  )
  assert.equal(check(valid, 'LATEST_BACKUP_SHA_VERIFIED').status, 'PASS')
  assert.doesNotMatch(
    JSON.stringify(check(valid, 'BACKUP_SCHEDULE_CONFIGURED')),
    /coverageDays|retentionDays/
  )
  const metadata = JSON.parse(readFileSync(f.backupPath + '.json', 'utf8'))
  writeFileSync(f.backupPath + '.json', JSON.stringify({ ...metadata, sha256: '0'.repeat(64) }))
  const corrupted = await f.run()
  assert.equal(check(corrupted, 'LATEST_BACKUP_SHA_VERIFIED').status, 'FAIL')
  assert.equal(corrupted.ready, false)
})

const managedMetadata = (path) => JSON.parse(readFileSync(path + '.json', 'utf8'))
const managedFiles = (directory) => readdirSync(directory)
  .filter((name) => /^studio-backup-.*\.sqlite$/.test(name))
  .map((name) => join(directory, name))
  .sort((a, b) => Date.parse(managedMetadata(a).completedAt) - Date.parse(managedMetadata(b).completedAt))
const unchangedFiles = (paths) => Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]))
async function scheduledCopies(f, count = 2) {
  const directory = f.config.storage.backupDir
  let now = timestamp - 60000
  const scheduler = createBackupScheduler({ dbPath: f.dbPath, directory, intervalMinutes: 60,
    retentionCount: 3, maxTotalBytes: 0, minFreeBytes: 0, failureWebhook: '', replication: {},
    applicationRelease: f.current.id, clock: () => now })
  const created = []
  try {
    for (let index = 0; index < count; index++) {
      now += 1000
      assert.deepEqual(await scheduler.run(), { ok: true })
      created.push(managedFiles(directory).at(-1))
    }
    f.config.backups.intervalMinutes = 60
    f.config.backups.retentionCount = 3
    f.evidence('service', { backupIntervalMinutes: 60, backupRetentionCount: 3 })
    return { created, retained: managedFiles(directory), metrics: scheduler.metrics() }
  } finally { scheduler.close() }
}
async function extraManagedCopy(f, { directory = f.config.storage.backupDir, at = timestamp + 1000,
  sourceId = hash(realpathSync(f.dbPath)), releaseId = f.current.id, matchingId = true } = {}) {
  const backupId = randomUUID(), stamp = new Date(at).toISOString().replace(/[-:.]/g, '')
  const path = join(directory, `studio-backup-${stamp}-${backupId}.sqlite`)
  await backupStudioDatabase(f.dbPath, path, { applicationRelease: releaseId, clock: () => at,
    ownership: { sourceId, backupId: matchingId ? backupId : randomUUID() } })
  return path
}

test('受管备份实际轮换四次后只读发现最新同源副本，不因三份保留删除固定指针而误报', async (t) => {
  const f = await fixture(t), copies = await scheduledCopies(f, 4)
  assert.equal(copies.retained.length, 3)
  assert.equal(copies.metrics.removedBackups, 1)
  assert.equal(existsSync(copies.created[0]), false)
  f.config.backups.latestMetadata = copies.created[0] + '.json'
  const paths = [f.dbPath, f.backupPath, f.backupPath + '.json',
    ...copies.retained.flatMap((path) => [path, path + '.json'])]
  const before = unchangedFiles(paths), configBefore = JSON.stringify(f.config)
  const report = await f.run()
  assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').status, 'PASS')
  assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').facts.selection, 'latest-managed-source-copy')
  assert.equal(check(report, 'BACKUP_SCHEDULE_CONFIGURED').facts.nominalCoverageHours, 2)
  assert.equal(report.ready, true)
  assert.deepEqual(unchangedFiles(paths), before)
  assert.equal(JSON.stringify(f.config), configBefore)
  assert.equal(existsSync(copies.created[0] + '.json'), false)
})

test('没有固定清单仍可发现受管副本，更晚他源或文件编号不匹配的清单不能取代本人源库', async (t) => {
  const f = await fixture(t), copies = await scheduledCopies(f)
  delete f.config.backups.latestMetadata
  const foreign = await extraManagedCopy(f, { sourceId: 'e'.repeat(64), releaseId: 'f'.repeat(64) })
  const mismatched = await extraManagedCopy(f, { at: timestamp + 2000,
    releaseId: 'f'.repeat(64), matchingId: false })
  const paths = [f.dbPath, ...[...copies.retained, foreign, mismatched].flatMap((path) => [path, path + '.json'])]
  const before = unchangedFiles(paths)
  const report = await f.run()
  assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').status, 'PASS')
  assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').facts.selection, 'latest-managed-source-copy')
  assert.equal(report.ready, true)
  assert.deepEqual(unchangedFiles(paths), before)
})

test('先选择最新声明完成的同源副本再验证，坏SHA及旧发布均不能退回旧好副本冒报通过', async (t) => {
  const f = await fixture(t), copies = await scheduledCopies(f)
  const oldest = copies.retained[0], newest = copies.retained.at(-1)
  f.config.backups.latestMetadata = oldest + '.json'
  const original = managedMetadata(newest)
  for (const patch of [{ sha256: '0'.repeat(64) }, { applicationRelease: 'f'.repeat(64) }]) {
    writeFileSync(newest + '.json', JSON.stringify({ ...original, ...patch }))
    const paths = [f.dbPath, oldest, oldest + '.json', newest, newest + '.json']
    const before = unchangedFiles(paths)
    const report = await f.run()
    assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').status, 'FAIL')
    assert.equal(report.ready, false)
    assert.deepEqual(unchangedFiles(paths), before)
    assert.equal(managedMetadata(oldest).applicationRelease, f.current.id)
  }
})

test('受管候选及完成清单链接、备份目录junction和静态目录不能成为已验证备份', async (t) => {
  const f = await fixture(t)
  delete f.config.backups.latestMetadata
  const outside = join(f.root, '.data', 'outside-backups')
  mkdirSync(outside)
  const source = await extraManagedCopy(f, { directory: outside })
  const name = source.split(sep).at(-1), directory = f.config.storage.backupDir
  const publicDirectory = join(f.root, 'dist', 'backups')
  mkdirSync(publicDirectory)
  copyFileSync(source, join(publicDirectory, name))
  copyFileSync(source + '.json', join(publicDirectory, name) + '.json')
  f.config.storage.backupDir = publicDirectory
  f.config.backups.directory = publicDirectory
  let report = await f.run()
  assert.equal(check(report, 'OPS_BACKUP_DIRECTORIES_PRIVATE').status, 'FAIL')
  assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').status, 'FAIL')
  f.config.storage.backupDir = directory
  f.config.backups.directory = directory
  for (const linkedManifest of [false, true]) {
    const target = join(directory, name)
    try {
      if (linkedManifest) {
        copyFileSync(source, target)
        symlinkSync(source + '.json', target + '.json', 'file')
      } else {
        symlinkSync(source, target, 'file')
        copyFileSync(source + '.json', target + '.json')
      }
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error
      t.diagnostic('文件symlink权限不可用，目录junction和公开目录保护仍实际验证')
      for (const path of [target, target + '.json']) rmSync(path, { force: true })
      break
    }
    const before = unchangedFiles([f.dbPath, source, source + '.json'])
    report = await f.run()
    assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').status, 'FAIL')
    assert.deepEqual(unchangedFiles([f.dbPath, source, source + '.json']), before)
    assert.equal(lstatSync(linkedManifest ? target + '.json' : target).isSymbolicLink(), true)
    for (const path of [target, target + '.json']) rmSync(path, { force: true })
  }
  const linkedDirectory = join(f.root, '.data', 'linked-backups')
  symlinkSync(outside, linkedDirectory, 'junction')
  f.config.storage.backupDir = linkedDirectory
  f.config.backups.directory = linkedDirectory
  report = await f.run()
  assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').status, 'FAIL')
  assert.equal(lstatSync(linkedDirectory).isSymbolicLink(), true)
})

test('空预约或未完成清单不冒充成功且不妨碍最近完成副本，发现扫描超限不截断后判通过', async (t) => {
  const f = await fixture(t), copies = await scheduledCopies(f, 1)
  delete f.config.backups.latestMetadata
  const directory = f.config.storage.backupDir
  const empty = join(directory, 'studio-backup-20261015T000001000Z-' + randomUUID() + '.sqlite.json')
  const unfinished = join(directory, 'studio-backup-20261015T000002000Z-' + randomUUID() + '.sqlite.json')
  writeFileSync(empty, '')
  writeFileSync(unfinished, JSON.stringify({ status: 'incomplete' }))
  const paths = [f.dbPath, copies.retained[0], copies.retained[0] + '.json', empty, unfinished]
  const before = unchangedFiles(paths)
  assert.equal(check(await f.run(), 'LATEST_BACKUP_SHA_VERIFIED').status, 'PASS')
  assert.deepEqual(unchangedFiles(paths), before)
  for (let index = 0; index < 1025; index++) writeFileSync(join(directory, `unmanaged-padding-${index}`), '')
  const report = await f.run()
  assert.equal(check(report, 'LATEST_BACKUP_SHA_VERIFIED').status, 'FAIL')
  assert.equal(report.ready, false)
  assert.deepEqual(unchangedFiles(paths), before)
})

test('memory/test/public paths and credential-bearing endpoint, broad origins/proxy and exposed private ports never pass', async (t) => {
  const f = await fixture(t)
  const original = f.config.storage.dbPath
  mkdirSync(join(f.root, '.qa'))
  symlinkSync(join(f.root, '.data'), join(f.root, '.qa', 'persistent-alias'), 'junction')
  for (const path of [
    ':memory:',
    join(f.root, '.qa', 'fixture.sqlite'),
    join(f.root, 'public', 'business.sqlite'),
    '.data/studio.sqlite',
    join(f.root, '.qa', 'persistent-alias', 'studio.sqlite')
  ]) {
    f.config.storage.dbPath = path
    const report = await f.run()
    assert.equal(check(report, 'DATABASE_PERSISTENT_PRIVATE_ABSOLUTE').status, 'FAIL')
    assert.equal(report.ready, false)
  }
  f.config.storage.dbPath = original
  f.config.endpoints.ready =
    'https://username:FAKE_AUTH_SECRET@example.invalid/ready?token=FAKE_AUTH_SECRET'
  f.config.deployment.allowedOrigins = ['*']
  f.config.deployment.trustedProxies = ['0.0.0.0/0']
  f.config.deployment.exposedPorts = [443, 3007]
  const unsafe = await f.run()
  for (const code of [
    'ENDPOINTS_PUBLIC_ONLY',
    'ALLOWED_ORIGINS_EXPLICIT',
    'TRUSTED_PROXY_EXPLICIT',
    'PUBLIC_PORTS_RESTRICTED'
  ])
    assert.equal(check(unsafe, code).status, 'FAIL')
  assert.doesNotMatch(JSON.stringify(unsafe), /FAKE_AUTH_SECRET|https:\/\//)
  assert.ok(!f.requests.some(({ url }) => url.includes('FAKE_AUTH_SECRET')))
})

test('CLI configuration parse failures print safe codes, never paths/raw secret or stack, and do not repair files', async (t) => {
  const f = await fixture(t),
    path = join(f.root, 'invalid-config.json')
  const raw = '{"credentialValue":"FAKE_AUTH_SECRET", malformed'
  writeFileSync(path, raw)
  const child = spawnSync(process.execPath, ['scripts/studio-preflight.mjs', '--config', path], {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(child.status, 1)
  const result = JSON.parse(child.stdout)
  assert.equal(result.ready, false)
  assert.equal(result.code, 'PREFLIGHT_CONFIG_REQUIRED')
  assert.doesNotMatch(
    child.stdout + child.stderr,
    /FAKE_AUTH_SECRET|SyntaxError|invalid-config| at /
  )
  assert.equal(readFileSync(path, 'utf8'), raw)
})

test('served gzip artifacts compare decoded HTTP content, while a different decoded build is rejected', async t => {
  const f = await fixture(t), body = Buffer.from("console.log('current gzip build')"), compressed = gzipSync(body)
  writeFileSync(join(f.root, 'dist/assets/precompressed.js.gz'), compressed)
  const admin = buildFingerprint(join(f.root, 'dist')), player = buildFingerprint(join(f.root, 'player-client/dist'))
  const id = hash([f.current.source.digest, admin.digest, player.digest].join(':'))
  Object.assign(f.current, { admin, player, id })
  Object.assign(f.manifest, { id, adminDigest: admin.digest, adminFiles: admin.files })
  f.config.expectedRelease = id
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest))
  let different = false
  const server = createServer((_, response) => response.writeHead(200, {
    'Content-Type': 'application/javascript', 'Content-Encoding': 'gzip'
  }).end(different ? gzipSync(Buffer.from('different deployed build')) : compressed))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise(done => server.close(done)))
  const fetcher = (url, options) => new URL(url).pathname.endsWith('.gz')
    ? fetch(`http://127.0.0.1:${server.address().port}/asset.gz`, options) : f.fetcher(url, options)
  const result = await f.run({ releaseFacts: () => f.current, fetcher })
  assert.equal(check(result, 'ADMIN_SERVED_BUILD_MATCHES').status, 'PASS')
  different = true
  const stale = await f.run({ releaseFacts: () => f.current, fetcher })
  assert.equal(check(stale, 'ADMIN_SERVED_BUILD_MATCHES').status, 'FAIL')
})
