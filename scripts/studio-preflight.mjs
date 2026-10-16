import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { currentReleaseFacts, readReleaseManifest } from './studio-release.mjs'
import { verifyStudioBackup } from './studio-backup.mjs'
import { createReadinessProbe } from '../server/health-probe.mjs'
import { normalizeOpsConfig } from '../server/ops-config.mjs'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const environments = ['local', 'test', 'staging', 'production']
const roles = [
  'super_admin',
  'owner',
  'manager',
  'finance',
  'hr',
  'operations',
  'support_lead',
  'support',
  'admin',
  'player'
]
const hashPattern = /^[a-f0-9]{64}$/
const evidenceKinds = [
  'service',
  'external-monitor',
  'firewall',
  'replication',
  'recovery',
  'alert'
]
const requiredServiceFlags = [
  'installed',
  'running',
  'autostartConfigured',
  'runAccountVerified',
  'managerRecoveryVerified',
  'bootActuallyTested'
]
const hash = (text) => createHash('sha256').update(text).digest('hex')
const plain = (value) =>
  Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      [null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const nonempty = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200
function publicURL(value) {
  if (typeof value !== 'string' || value.length > 2000) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null
  } catch {
    return null
  }
}
function proxyAddress(value) {
  if (typeof value !== 'string') return false
  const [ip, prefix, extra] = value.split('/')
  const version = isIP(ip)
  return (
    !extra &&
    version > 0 &&
    (prefix === undefined ||
      (/^\d+$/.test(prefix) && integer(Number(prefix), 1, version === 4 ? 32 : 128)))
  )
}
function boundedJSON(path, maxBytes = 65536) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    throw new Error('PREFLIGHT_FILE_INVALID')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!plain(value)) throw new Error('PREFLIGHT_FILE_INVALID')
  return value
}
const within = (path, root) => path === root || path.startsWith(root + sep)
function privatePath(value, root, { database = false } = {}) {
  if (!nonempty(value) || value === ':memory:') return null
  const path = resolve(root, value)
  let canonical
  try {
    canonical = existsSync(path) ? realpathSync(path) : path
  } catch {
    return null
  }
  const paths = [path, canonical]
  if (
    [
      join(root, 'dist'),
      join(root, 'public'),
      join(root, 'player-client', 'dist'),
      join(root, 'player-client', 'public')
    ].some((directory) => paths.some((check) => within(check, directory))) ||
    paths.some((check) => /(?:^|[\\/])(?:dist|public)(?:[\\/]|$)/i.test(check)) ||
    (database &&
      paths.some((check) =>
        /(?:^|[\\/])(?:\.qa|tests?|__tests__|fixtures?|node_modules)(?:[\\/]|$)/i.test(check)
      ))
  )
    return null
  return path
}
function dateFresh(value, timestamp, maxAgeMs) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false
  const time = Date.parse(value)
  return Number.isFinite(time) && time <= timestamp + 300000 && time >= timestamp - maxAgeMs
}

async function boundedResponse(response, limit) {
  if (!response.body) return Buffer.alloc(0)
  let bytes = 0
  const chunks = []
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > limit) throw new Error('PREFLIGHT_RESPONSE_INVALID')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, bytes)
}

/** Return counts and booleans only. Never select names, contacts, IDs, passwords or complete JSON. */
function businessCounts(path, timestamp) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=150; BEGIN')
    const state = db
      .prepare(
        "SELECT json_valid(json) AS valid,json_extract(json,'$.schemaVersion') AS schemaVersion,COALESCE(json_extract(json,'$.demo'),1) AS demo FROM studio_state WHERE id=1"
      )
      .get()
    if (!state || state.valid !== 1 || ![1, 2].includes(state.schemaVersion))
      throw new Error('PREFLIGHT_DATABASE_INVALID')
    const roleNames = roles.map((role) => `'${role}'`).join(',')
    const roleCounts = Object.fromEntries(roles.map((role) => [role, 0]))
    for (const row of db
      .prepare(
        `SELECT CASE WHEN json_extract(u.value,'$.role') IN (${roleNames}) THEN json_extract(u.value,'$.role') ELSE 'unknown' END AS role,COUNT(*) AS n FROM studio_state s,json_each(s.json,'$.users') u WHERE s.id=1 GROUP BY role`
      )
      .all())
      roleCounts[row.role] = Number(row.n)
    const account = db
      .prepare(
        `WITH accounts AS (
      SELECT json_extract(u.value,'$.role') AS role,
        json_extract(u.value,'$.status')='active' AND COALESCE(json_extract(u.value,'$.loginEnabled'),1)!=0 AND
        (json_extract(u.value,'$.role')!='player' OR COALESCE(json_extract(u.value,'$.playerAccess.login'),1)!=0) AS enabled,
        EXISTS(SELECT 1 FROM json_each(s.json,'$.passwords') p WHERE p.key=json_extract(u.value,'$.id') AND p.type='text' AND length(p.value)>0) AS credential
      FROM studio_state s,json_each(s.json,'$.users') u WHERE s.id=1
    ) SELECT COALESCE(SUM(enabled),0) AS enabledAccounts,
      COALESCE(SUM(enabled AND credential),0) AS credentialReadyAccounts,
      COALESCE(SUM(enabled AND NOT credential),0) AS missingCredentialAccounts,
      COALESCE(SUM(enabled AND credential AND role='super_admin'),0) AS activeSuperAdmins FROM accounts`
      )
      .get()
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit'
      })
        .formatToParts(new Date(timestamp))
        .map((part) => [part.type, part.value])
    )
    const payrollDate = `${parts.year}-${parts.month}-31`
    const salary = db
      .prepare(
        `WITH users AS (
        SELECT u.value AS user FROM studio_state s,json_each(s.json,'$.users') u WHERE s.id=1
      ), plans AS (
        SELECT p.value AS plan,ROW_NUMBER() OVER(PARTITION BY json_extract(p.value,'$.userId') ORDER BY json_extract(p.value,'$.effectiveFrom') DESC,json_extract(p.value,'$.id') DESC) AS ranking
        FROM studio_state s,json_each(s.json,'$.salaryPlans') p WHERE s.id=1 AND json_extract(p.value,'$.effectiveFrom')<=?
      ), employees AS (
        SELECT user,plan FROM users LEFT JOIN plans ON ranking=1 AND json_extract(plan,'$.userId')=json_extract(user,'$.id')
        WHERE json_extract(user,'$.role')!='player' AND (json_extract(user,'$.role') NOT IN ('super_admin','admin','owner') OR EXISTS(
          SELECT 1 FROM studio_state s,json_each(s.json,'$.salaryPlans') p WHERE s.id=1 AND json_extract(p.value,'$.userId')=json_extract(user,'$.id')
        ))
      ) SELECT COUNT(*) AS salaryRequiredAccounts,COALESCE(SUM(plan IS NULL OR
        (json_extract(plan,'$.mode')!='commission' AND json_extract(plan,'$.base') IS NULL) OR
        (json_extract(plan,'$.mode')!='fixed' AND json_extract(user,'$.role') IN ('support','support_lead') AND json_extract(plan,'$.rate') IS NULL) OR
        (json_extract(plan,'$.mode')!='fixed' AND json_extract(user,'$.role')='operations' AND EXISTS(
          SELECT 1 FROM studio_state s,json_each(s.json,'$.platforms') source WHERE s.id=1 AND json_extract(source.value,'$.id')!='hall' AND json_extract(source.value,'$.name')!='游戏大厅' AND NOT EXISTS(
            SELECT 1 FROM json_each(plan,'$.platformRates') rate WHERE rate.key=json_extract(source.value,'$.id') AND rate.type!='null'
          )
        ))),0) AS incompleteSalaryAccounts FROM employees`
      )
      .get(payrollDate)
    const templates = db
      .prepare(
        "SELECT COUNT(*) AS templates,COALESCE(SUM(COALESCE(json_extract(t.value,'$.active'),0)=1),0) AS activeTemplates,COALESCE(SUM(COALESCE(json_extract(t.value,'$.active'),0)=1 AND (json_extract(t.value,'$.amount') IS NULL OR json_extract(t.value,'$.reward') IS NULL)),0) AS incompleteActiveTemplates FROM studio_state s,json_each(s.json,'$.templates') t WHERE s.id=1"
      )
      .get()
    const sources = db
      .prepare(
        "SELECT COALESCE(json_array_length(json,'$.platforms'),0) AS sources,COALESCE(json_array_length(json,'$.shops'),0) AS shops,COALESCE(json_array_length(json,'$.salaryPlans'),0) AS salaryPlans FROM studio_state WHERE id=1"
      )
      .get()
    db.exec('ROLLBACK')
    return {
      schemaVersion: state.schemaVersion,
      demo: state.demo !== 0,
      roleCounts,
      ...Object.fromEntries(
        Object.entries({ ...account, ...salary, ...templates, ...sources }).map(([key, value]) => [
          key,
          Number(value)
        ])
      )
    }
  } finally {
    db.close()
  }
}

function directoryStats(path) {
  let files = 0,
    bytes = 0,
    truncated = false
  const visit = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++files > 1000) {
        truncated = true
        return
      }
      const target = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isFile()) bytes += lstatSync(target).size
      else if (entry.isDirectory() && depth < 2) visit(target, depth + 1)
      else if (entry.isDirectory()) truncated = true
      if (truncated && files > 1000) return
    }
  }
  visit(path, 0)
  return { entriesSampled: Math.min(files, 1000), bytesSampled: bytes, truncated }
}

/** Read-only launch assessment; missing production inputs and evidence never become PASS. */
export async function runPreflight({
  configPlainObject,
  rootDirectory = projectRoot,
  releaseManifestPath,
  clock = Date.now,
  fetcher = fetch,
  releaseReader = readReleaseManifest,
  releaseFacts = currentReleaseFacts,
  evidenceMaxAgeMs = 86400000,
  httpTimeoutMs = 5000
} = {}) {
  const timestamp = Number(new Date(clock()))
  if (
    !Number.isFinite(timestamp) ||
    !integer(evidenceMaxAgeMs, 1000, 7 * 86400000) ||
    !integer(httpTimeoutMs, 50, 30000)
  )
    throw new Error('PREFLIGHT_OPTIONS_INVALID')
  const root = resolve(rootDirectory),
    checks = []
  const configValid =
    plain(configPlainObject) &&
    configPlainObject.format === 'studio-ops-config-v1' &&
    environments.includes(configPlainObject.environment)
  const config = configValid ? configPlainObject : {}
  const environment = configValid ? config.environment : 'unknown',
    production = environment === 'production'
  const add = (
    dimension,
    code,
    status,
    adviceCode,
    facts = {},
    required = true,
    basis = 'configuration'
  ) => {
    checks.push({
      dimension,
      code,
      status,
      adviceCode,
      requiredForProduction: required,
      basis,
      facts
    })
  }
  const assess = (
    dimension,
    code,
    ok,
    adviceCode,
    facts = {},
    required = true,
    basis = 'configuration'
  ) =>
    add(
      dimension,
      code,
      ok ? 'PASS' : production ? 'FAIL' : 'WARN',
      adviceCode,
      facts,
      required,
      basis
    )
  add('configuration', 'OPS_CONFIG_VALID', configValid ? 'PASS' : 'FAIL', 'PROVIDE_OPS_CONFIG')
  if (!configValid) return finish()
  let runtimeSchemaValid = false
  try {
    normalizeOpsConfig(config, { root })
    runtimeSchemaValid = true
  } catch {}
  add(
    'configuration',
    'OPS_RUNTIME_CONFIG_VALID',
    runtimeSchemaValid ? 'PASS' : 'FAIL',
    'PROVIDE_OPS_CONFIG'
  )
  assess(
    'configuration',
    'OPS_MODE_VALID',
    ['internal', 'external'].includes(config.mode),
    'CONFIGURE_MONITOR_MODE'
  )
  const deployment = plain(config.deployment) ? config.deployment : {},
    storage = plain(config.storage) ? config.storage : {}
  const backups = plain(config.backups) ? config.backups : {},
    replication = plain(backups.replication) ? backups.replication : {}
  const alerts = plain(config.alerts) ? config.alerts : {},
    recovery = plain(config.recovery) ? config.recovery : {}
  const endpoints = plain(config.endpoints) ? config.endpoints : {}
  const urls = Object.fromEntries(
    ['admin', 'player', 'live', 'ready', 'summary', 'diagnostics'].map((name) => [
      name,
      publicURL(endpoints[name])
    ])
  )
  const unsafeEndpoint = Object.keys(urls).some((name) => endpoints[name] != null && !urls[name])
  add(
    'configuration',
    'ENDPOINTS_PUBLIC_ONLY',
    unsafeEndpoint
      ? 'FAIL'
      : Object.values(urls).every(Boolean)
        ? 'PASS'
        : production
          ? 'FAIL'
          : 'WARN',
    'CONFIGURE_PUBLIC_ENDPOINTS',
    { allDeclared: Object.values(urls).every(Boolean), containsUnsafeEndpoint: unsafeEndpoint }
  )
  assess(
    'configuration',
    'ENVIRONMENT_PRODUCTION_DECLARED',
    production,
    'SELECT_PRODUCTION_SCOPE',
    {},
    true
  )
  assess(
    'configuration',
    'REGION_PROVIDER_DECLARED',
    nonempty(deployment.region) && nonempty(deployment.provider),
    'REGION_PROVIDER_PENDING',
    { regionDeclared: nonempty(deployment.region), providerDeclared: nonempty(deployment.provider) }
  )
  const domain =
    typeof deployment.domain === 'string' &&
    deployment.domain.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(deployment.domain)
      ? deployment.domain.toLowerCase()
      : null
  const hostMatches = Boolean(
    domain &&
      Object.values(urls).every(
        (url) => url && (url.hostname === domain || url.hostname.endsWith('.' + domain))
      )
  )
  assess('configuration', 'FORMAL_DOMAIN_MATCHES', hostMatches, 'CONFIGURE_FORMAL_DOMAIN', {
    domainDeclared: Boolean(domain),
    endpointHostsMatch: hostMatches
  })
  assess(
    'configuration',
    'HTTPS_CONFIGURED',
    deployment.httpsConfigured === true &&
      Object.values(urls).every((url) => url?.protocol === 'https:'),
    'CONFIGURE_HTTPS',
    {
      configured: deployment.httpsConfigured === true,
      endpointsHttps: Object.values(urls).every((url) => url?.protocol === 'https:')
    }
  )
  assess(
    'configuration',
    'SECURE_COOKIE_CONFIGURED',
    deployment.secureCookie === true,
    'CONFIGURE_SECURE_COOKIE'
  )
  const origins = Array.isArray(deployment.allowedOrigins) ? deployment.allowedOrigins : []
  const originsValid =
    origins.length > 0 &&
    origins.length <= 20 &&
    origins.every((origin) => {
      const url = publicURL(origin)
      return url && url.origin === origin && (!production || url.protocol === 'https:')
    }) &&
    ['admin', 'player'].every((name) => urls[name] && origins.includes(urls[name].origin))
  assess('configuration', 'ALLOWED_ORIGINS_EXPLICIT', originsValid, 'CONFIGURE_ALLOWED_ORIGINS', {
    count: origins.length,
    includesBothClients: originsValid
  })
  const proxies = Array.isArray(deployment.trustedProxies) ? deployment.trustedProxies : []
  assess(
    'configuration',
    'TRUSTED_PROXY_EXPLICIT',
    proxies.length > 0 && proxies.length <= 20 && proxies.every(proxyAddress),
    'CONFIGURE_TRUSTED_PROXY',
    { count: proxies.length }
  )
  const ports = Array.isArray(deployment.exposedPorts) ? deployment.exposedPorts : []
  assess(
    'configuration',
    'PUBLIC_PORTS_RESTRICTED',
    ports.length > 0 &&
      ports.length <= 4 &&
      ports.every((port) => [80, 443].includes(port)) &&
      ports.includes(443),
    'RESTRICT_PUBLIC_PORTS',
    {
      count: ports.length,
      onlyWebPorts: ports.length > 0 && ports.every((port) => [80, 443].includes(port))
    }
  )
  assess(
    'configuration',
    'SERVICE_OS_DECLARED',
    ['windows', 'linux'].includes(deployment.os),
    'CONFIGURE_SERVICE_OS'
  )
  const credentialNameSafe = config.credentialEnv === 'STUDIO_MONITOR_TOKEN'
  assess(
    'configuration',
    'MONITOR_CREDENTIAL_REFERENCE',
    credentialNameSafe,
    'CONFIGURE_MONITOR_CREDENTIAL',
    { referenceDeclared: credentialNameSafe }
  )
  const expectedValid =
    typeof config.expectedRelease === 'string' && hashPattern.test(config.expectedRelease)
  assess('configuration', 'EXPECTED_RELEASE_DECLARED', expectedValid, 'RECORD_EXPECTED_RELEASE')
  let facts, manifest
  try {
    facts = releaseFacts()
    manifest = releaseReader(
      releaseManifestPath || join(root, '.data', 'releases', 'current.json'),
      { verify: true }
    )
  } catch {}
  const releaseValid = Boolean(
    manifest?.format === 'studio-release-v1' &&
      hashPattern.test(manifest.id) &&
      facts?.id === manifest.id &&
      hashPattern.test(facts.source?.digest) &&
      hashPattern.test(facts.admin?.digest) &&
      hashPattern.test(facts.player?.digest) &&
      plain(manifest.sourceFiles) &&
      plain(manifest.adminFiles) &&
      plain(manifest.playerFiles) &&
      hash(JSON.stringify(manifest.sourceFiles)) === manifest.sourceDigest &&
      hash(JSON.stringify(manifest.adminFiles)) === manifest.adminDigest &&
      hash(JSON.stringify(manifest.playerFiles)) === manifest.playerDigest &&
      manifest.sourceDigest === facts.source.digest &&
      manifest.adminDigest === facts.admin.digest &&
      manifest.playerDigest === facts.player.digest &&
      manifest.id === hash([facts.source.digest, facts.admin.digest, facts.player.digest].join(':'))
  )
  assess(
    'code',
    'RELEASE_SOURCE_BUILDS_VERIFIED',
    releaseValid,
    'BUILD_AND_RECORD_RELEASE',
    {
      sourceMatches: Boolean(releaseValid),
      adminBuildMatches: Boolean(releaseValid),
      playerBuildMatches: Boolean(releaseValid)
    },
    true,
    'direct-read'
  )
  assess(
    'code',
    'EXPECTED_RELEASE_MATCHES',
    releaseValid && expectedValid && manifest.id === config.expectedRelease,
    'RECORD_EXPECTED_RELEASE',
    {},
    true,
    'direct-read'
  )

  function evidence(pathValue, kind) {
    if (!nonempty(pathValue) || !evidenceKinds.includes(kind)) return { ok: false, missing: true }
    try {
      const path = privatePath(pathValue, root)
      if (!path) return { ok: false, invalid: true }
      const value = boundedJSON(path)
      const ok =
        value.format === 'studio-ops-evidence-v1' &&
        value.kind === kind &&
        value.environment === environment &&
        releaseValid &&
        value.releaseId === manifest.id &&
        value.verified === true &&
        value.nonSimulated === true &&
        dateFresh(value.checkedAt, timestamp, evidenceMaxAgeMs)
      return { ok, invalid: !ok, value: ok ? value : null }
    } catch {
      return { ok: false, invalid: true }
    }
  }
  const serviceEvidence = evidence(deployment.serviceEvidence, 'service')
  const externalEvidence = evidence(deployment.externalMonitorEvidence, 'external-monitor')
  const firewallEvidence = evidence(deployment.firewallEvidence, 'firewall')
  const remoteEvidence = evidence(replication.evidencePath, 'replication')
  const recoveryEvidence = evidence(recovery.evidencePath, 'recovery')
  const alertEvidence = evidence(alerts.evidencePath, 'alert')
  const assessEvidence = (code, item, flags, adviceCode, dimension = 'verified') => {
    const passed = item.ok && flags.every((flag) => item.value[flag] === true)
    add(
      dimension,
      code,
      passed ? 'PASS' : item.invalid || production ? 'FAIL' : 'WARN',
      adviceCode,
      {
        supplied: !item.missing,
        schemaAndFreshnessVerified: item.ok,
        requiredFlagsVerified: Boolean(passed)
      },
      true,
      'operator-evidence'
    )
    return passed
  }
  assessEvidence(
    'SERVICE_INSTALLED_RUNNING',
    serviceEvidence,
    ['installed', 'running'],
    'INSTALL_AND_VERIFY_SERVICE',
    'enabled'
  )
  assessEvidence(
    'SERVICE_AUTOSTART_RECOVERY_VERIFIED',
    serviceEvidence,
    requiredServiceFlags,
    'VERIFY_BOOT_AND_MANAGER_RECOVERY'
  )
  assessEvidence(
    'DEPLOYMENT_SECURITY_ACTUALLY_VERIFIED',
    serviceEvidence,
    ['deploymentSecurityVerified'],
    'VERIFY_COOKIE_ORIGIN_PROXY_SECURITY'
  )
  assessEvidence(
    'FIREWALL_ACTUALLY_VERIFIED',
    firewallEvidence,
    ['privatePortsBlocked', 'onlyPublicWebPorts'],
    'VERIFY_PUBLIC_FIREWALL'
  )
  assessEvidence(
    'EXTERNAL_MONITOR_ACTUALLY_RUNNING',
    externalEvidence,
    ['independentHostConfigured', 'running'],
    'VERIFY_INDEPENDENT_MONITOR',
    'enabled'
  )

  const dbPath = privatePath(storage.dbPath, root, { database: true })
  const dbDeclared = Boolean(dbPath && isAbsolute(storage.dbPath))
  assess(
    'configuration',
    'DATABASE_PERSISTENT_PRIVATE_ABSOLUTE',
    dbDeclared,
    'CONFIGURE_PRIVATE_DATABASE_PATH',
    {
      absoluteDeclared: typeof storage.dbPath === 'string' && isAbsolute(storage.dbPath),
      persistentPrivatePath: Boolean(dbPath)
    }
  )
  const opsDir = privatePath(storage.opsDir, root),
    backupDir = privatePath(backups.directory || storage.backupDir, root)
  const sameBackupDir = Boolean(backupDir && privatePath(storage.backupDir, root) === backupDir)
  assess(
    'configuration',
    'OPS_BACKUP_DIRECTORIES_PRIVATE',
    Boolean(opsDir && backupDir && sameBackupDir && opsDir !== dbPath && backupDir !== dbPath),
    'CONFIGURE_PRIVATE_STORAGE',
    {
      opsPrivate: Boolean(opsDir),
      backupPrivate: Boolean(backupDir),
      backupDirectoryConsistent: sameBackupDir
    }
  )
  let counts
  if (dbPath && existsSync(dbPath)) {
    try {
      counts = businessCounts(dbPath, timestamp)
      add(
        'verified',
        'DATABASE_CONFIGURATION_COUNTS',
        'PASS',
        'REVIEW_BUSINESS_CONFIGURATION',
        counts,
        true,
        'direct-read'
      )
      const readiness = createReadinessProbe({ dbPath, cacheMs: 0 })
      let ready = false
      try {
        ready = await readiness.check()
      } finally {
        readiness.close()
      }
      assess(
        'verified',
        'DATABASE_READINESS_READ',
        ready,
        'CHECK_DATABASE',
        { actualReadSucceeded: ready },
        true,
        'direct-read'
      )
      assess(
        'configuration',
        'DEMO_DATA_DISABLED',
        !counts.demo,
        'REMOVE_DEMO_DATA',
        { demo: counts.demo },
        true,
        'direct-read'
      )
      assess(
        'configuration',
        'LOGIN_ACCOUNTS_HAVE_CREDENTIALS',
        counts.activeSuperAdmins > 0 && counts.missingCredentialAccounts === 0,
        'CONFIGURE_FORMAL_ACCOUNTS',
        {
          activeSuperAdmins: counts.activeSuperAdmins,
          enabledAccounts: counts.enabledAccounts,
          missingCredentialAccounts: counts.missingCredentialAccounts
        },
        true,
        'direct-read'
      )
      assess(
        'configuration',
        'BUSINESS_SETUP_COMPLETE',
        counts.activeTemplates > 0 &&
          counts.incompleteActiveTemplates === 0 &&
          counts.sources > 0 &&
          counts.incompleteSalaryAccounts === 0,
        'REVIEW_BUSINESS_CONFIGURATION',
        {
          activeTemplates: counts.activeTemplates,
          incompleteActiveTemplates: counts.incompleteActiveTemplates,
          sources: counts.sources,
          salaryRequiredAccounts: counts.salaryRequiredAccounts,
          incompleteSalaryAccounts: counts.incompleteSalaryAccounts
        },
        true,
        'direct-read'
      )
    } catch {
      add(
        'verified',
        'DATABASE_READINESS_READ',
        'FAIL',
        'CHECK_DATABASE',
        { actualReadSucceeded: false },
        true,
        'direct-read'
      )
    }
  } else
    assess(
      'verified',
      'DATABASE_READINESS_READ',
      false,
      'CONFIGURE_PRIVATE_DATABASE_PATH',
      { exists: false },
      true,
      'direct-read'
    )
  if (dbPath && existsSync(dbPath)) {
    try {
      const disk = statfsSync(dirname(dbPath)),
        availableBytes = Number(disk.bavail) * Number(disk.bsize),
        capacityBytes = Number(disk.blocks) * Number(disk.bsize)
      const thresholdBytes = integer(config.thresholds?.diskFreeBytes, 1, Number.MAX_SAFE_INTEGER)
        ? config.thresholds.diskFreeBytes
        : 1024 * 1024 * 1024
      const lowSpace = availableBytes < thresholdBytes
      add(
        'verified',
        'DISK_CAPACITY_MEASURED',
        availableBytes <= 0 ? 'FAIL' : lowSpace ? 'WARN' : 'PASS',
        'CHECK_DISK',
        { availableBytes, capacityBytes, thresholdBytes, lowSpace },
        true,
        'direct-read'
      )
      const walBytes = existsSync(dbPath + '-wal') ? lstatSync(dbPath + '-wal').size : 0
      const walLimit = integer(config.thresholds?.walBytes, 1, Number.MAX_SAFE_INTEGER)
        ? config.thresholds.walBytes
        : 256 * 1024 * 1024
      add(
        'verified',
        'WAL_CAPACITY_MEASURED',
        walBytes > walLimit ? 'WARN' : 'PASS',
        'CHECK_DATABASE',
        { walBytes, thresholdBytes: walLimit },
        true,
        'direct-read'
      )
    } catch {
      assess('verified', 'DISK_CAPACITY_MEASURED', false, 'CHECK_DISK', {}, true, 'direct-read')
    }
  } else assess('verified', 'DISK_CAPACITY_MEASURED', false, 'CHECK_DISK', {}, true, 'direct-read')
  if (opsDir && existsSync(opsDir)) {
    try {
      const stats = directoryStats(opsDir)
      const thresholdBytes = integer(config.thresholds?.logBytes, 1, Number.MAX_SAFE_INTEGER)
        ? config.thresholds.logBytes
        : 450 * 1024 * 1024
      add(
        'verified',
        'OPS_LOG_STORAGE_MEASURED',
        stats.truncated || stats.bytesSampled > thresholdBytes ? 'WARN' : 'PASS',
        'CHECK_LOG_RETENTION',
        { ...stats, thresholdBytes },
        true,
        'direct-read'
      )
    } catch {
      assess(
        'verified',
        'OPS_LOG_STORAGE_MEASURED',
        false,
        'CHECK_LOG_RETENTION',
        {},
        true,
        'direct-read'
      )
    }
  } else
    assess(
      'verified',
      'OPS_LOG_STORAGE_MEASURED',
      false,
      'CONFIGURE_PRIVATE_STORAGE',
      {},
      true,
      'direct-read'
    )

  const backupConfigured =
    backups.enabled === true &&
    integer(backups.intervalMinutes, 1, 525600) &&
    integer(backups.retentionCount, 1, 90) &&
    Boolean(backupDir)
  assess(
    'configuration',
    'BACKUP_SCHEDULE_CONFIGURED',
    backupConfigured,
    'CONFIGURE_BACKUP_SCHEDULE',
    {
      configured: backupConfigured,
      intervalMinutes: integer(backups.intervalMinutes, 0, 525600) ? backups.intervalMinutes : null,
      retentionCount: integer(backups.retentionCount, 1, 90) ? backups.retentionCount : null,
      nominalCoverageHours: backupConfigured
        ? (backups.retentionCount * backups.intervalMinutes) / 60
        : null,
      coverageAssumesConsecutiveSuccesses: true
    }
  )
  const backupRuntime =
    backupConfigured &&
    serviceEvidence.ok &&
    serviceEvidence.value.backupsEnabled === true &&
    serviceEvidence.value.backupIntervalMinutes === backups.intervalMinutes &&
    serviceEvidence.value.backupRetentionCount === backups.retentionCount
  assess(
    'enabled',
    'BACKUP_RUNTIME_ENABLED_VERIFIED',
    backupRuntime,
    'VERIFY_BACKUP_RUNTIME',
    { matchesConfiguredSchedule: Boolean(backupRuntime) },
    true,
    'operator-evidence'
  )
  let backupVerified = false
  if (nonempty(backups.latestMetadata)) {
    try {
      const metadataPath = privatePath(backups.latestMetadata, root)
      if (
        !metadataPath ||
        !backupDir ||
        !within(metadataPath, backupDir) ||
        !metadataPath.endsWith('.sqlite.json')
      )
        throw new Error('PREFLIGHT_BACKUP_INVALID')
      const metadata = boundedJSON(metadataPath)
      const source = metadataPath.slice(0, -5)
      const verification = await verifyStudioBackup(source)
      backupVerified =
        metadata.status === 'complete' &&
        verification.hashVerification === 'verified' &&
        verification.applicationRelease === manifest?.id &&
        verification.schemaVersion <= 2 &&
        dateFresh(
          verification.completedAt,
          timestamp,
          backupConfigured ? Math.max(3600000, backups.intervalMinutes * 120000) : evidenceMaxAgeMs
        )
      assess(
        'verified',
        'LATEST_BACKUP_SHA_VERIFIED',
        backupVerified,
        'VERIFY_LATEST_BACKUP',
        {
          completed: metadata.status === 'complete',
          shaVerified: verification.hashVerification === 'verified',
          schemaCompatible: verification.schemaVersion <= 2,
          releaseMatches: verification.applicationRelease === manifest?.id,
          recent: backupVerified
        },
        true,
        'direct-read'
      )
    } catch {
      add(
        'verified',
        'LATEST_BACKUP_SHA_VERIFIED',
        'FAIL',
        'VERIFY_LATEST_BACKUP',
        { shaVerified: false },
        true,
        'direct-read'
      )
    }
  } else
    assess(
      'verified',
      'LATEST_BACKUP_SHA_VERIFIED',
      false,
      'VERIFY_LATEST_BACKUP',
      {},
      true,
      'direct-read'
    )
  const remoteConfigured =
    replication.enabled === true && replication.kind === 'remote' && nonempty(replication.targetId)
  assess(
    'configuration',
    'REMOTE_REPLICATION_CONFIGURED',
    remoteConfigured,
    'CONFIGURE_REAL_REMOTE_BACKUP',
    {
      configured: replication.enabled === true,
      realRemoteKind: replication.kind === 'remote',
      simulated: replication.kind === 'simulation'
    }
  )
  const remoteActual =
    remoteConfigured &&
    remoteEvidence.ok &&
    remoteEvidence.value.remoteIdentityVerified === true &&
    remoteEvidence.value.independentHostConfigured === true &&
    remoteEvidence.value.hashVerified === true &&
    dateFresh(remoteEvidence.value.lastSuccessAt, timestamp, evidenceMaxAgeMs)
  assess(
    'enabled',
    'REMOTE_REPLICATION_ACTUALLY_VERIFIED',
    remoteActual,
    'VERIFY_REAL_REMOTE_BACKUP',
    { independentHostVerified: Boolean(remoteActual), hashVerified: Boolean(remoteActual) },
    true,
    'operator-evidence'
  )
  assessEvidence(
    'OFFLINE_RECOVERY_ACTUALLY_VERIFIED',
    recoveryEvidence,
    [
      'integrityOk',
      'sourceNewTransactionsPreserved',
      'authPolicyVerified',
      'noExternalSideEffects'
    ],
    'VERIFY_OFFLINE_RECOVERY'
  )
  assess(
    'configuration',
    'ALERT_AUTHORIZATION_CONFIGURED',
    alerts.authorized === true && alerts.targetEnv === 'STUDIO_OPS_ALERT_WEBHOOK',
    'AUTHORIZE_ALERT_CHANNEL',
    {
      authorized: alerts.authorized === true,
      referenceDeclared: alerts.targetEnv === 'STUDIO_OPS_ALERT_WEBHOOK'
    }
  )
  assessEvidence(
    'ALERT_CHANNEL_ACTUALLY_VERIFIED',
    alertEvidence,
    ['acceptedByService'],
    'VERIFY_ALERT_DELIVERY',
    'enabled'
  )

  await Promise.all(
    ['live', 'ready', 'admin', 'player'].map(async (name) => {
      const url = urls[name],
        code =
          name === 'live'
            ? 'API_LIVE_RELEASE_MATCHES'
            : name === 'ready'
              ? 'API_READY_RELEASE_MATCHES'
              : `${name.toUpperCase()}_SERVED_BUILD_MATCHES`
      if (!url) {
        assess('verified', code, false, 'CONFIGURE_PUBLIC_ENDPOINTS', {}, true, 'direct-http')
        return
      }
      try {
        const response = await fetcher(url.href, {
          method: 'GET',
          headers: {
            Accept: name === 'live' || name === 'ready' ? 'application/json' : 'text/html'
          },
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(httpTimeoutMs)
        })
        const content = await boundedResponse(
          response,
          name === 'live' || name === 'ready' ? 16384 : 2 * 1024 * 1024
        )
        const body = content.toString('utf8'),
          type = response.headers.get('content-type') || ''
        let matches = false
        if (name === 'live' || name === 'ready') {
          const data =
            type.includes('application/json') && body.length <= 16384 ? JSON.parse(body) : null
          matches =
            response.status === 200 &&
            releaseValid &&
            data?.service === 'studio-api' &&
            data.release === manifest.id &&
            (name === 'live'
              ? data.status === 'ok'
              : data.status === 'ready' && data.checks?.database === true)
        } else
          matches =
            response.status === 200 &&
            type.includes('text/html') &&
            releaseValid &&
            hash(content) === manifest[`${name}Files`]?.['index.html']
        let assetsChecked = 0
        if (matches && ['admin', 'player'].includes(name)) {
          const files = manifest[`${name}Files`]
          const entries = Object.entries(files).filter(([file]) => file !== 'index.html')
          if (
            entries.length > 512 ||
            entries.some(
              ([file, digest]) =>
                file.startsWith('/') ||
                file.includes('\\') ||
                file.split('/').some((part) => !part || part === '.' || part === '..') ||
                !hashPattern.test(digest)
            )
          )
            matches = false
          else {
            const deadline = AbortSignal.timeout(30000)
            let cursor = 0,
              bytes = 0
            const base = new URL(url.href)
            if (!base.pathname.endsWith('/')) base.pathname += '/'
            await Promise.all(
              Array.from({ length: Math.min(4, entries.length) }, async () => {
                while (matches && cursor < entries.length) {
                  const [file, digest] = entries[cursor++]
                  const asset = new URL(file, base)
                  if (asset.origin !== base.origin) {
                    matches = false
                    break
                  }
                  const fetched = await fetcher(asset.href, {
                    method: 'GET',
                    credentials: 'omit',
                    redirect: 'error',
                    signal: AbortSignal.any([deadline, AbortSignal.timeout(httpTimeoutMs)])
                  })
                  const content = await boundedResponse(fetched, 8 * 1024 * 1024)
                  bytes += content.byteLength
                  const receivedDigest = hash(content)
                  let contentMatches = receivedDigest === digest
                  // fetch decodes Content-Encoding but retains its header. A
                  // precompressed artifact must be compared in that same representation.
                  if (!contentMatches && file.endsWith('.gz') &&
                    (fetched.headers.get('content-encoding') || '').trim().toLowerCase() === 'gzip') {
                    const compressed = readFileSync(join(root, name === 'admin' ? 'dist' : 'player-client/dist', file))
                    if (hash(compressed) === digest)
                      contentMatches = receivedDigest === hash(gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 }))
                  }
                  if (
                    fetched.status !== 200 ||
                    content.byteLength > 8 * 1024 * 1024 ||
                    bytes > 64 * 1024 * 1024 ||
                    !contentMatches
                  )
                    matches = false
                  else assetsChecked++
                }
              })
            )
          }
        }
        add(
          'verified',
          code,
          matches ? 'PASS' : 'FAIL',
          'VERIFY_RUNNING_RELEASE',
          {
            httpOk: response.status === 200,
            releaseMatches: Boolean(matches),
            ...(['admin', 'player'].includes(name) ? { assetsChecked } : {})
          },
          true,
          'direct-http'
        )
      } catch {
        assess(
          'verified',
          code,
          false,
          'VERIFY_RUNNING_RELEASE',
          { requestSucceeded: false },
          true,
          'direct-http'
        )
      }
    })
  )
  return finish()

  function finish() {
    const summary = Object.fromEntries(
      ['PASS', 'WARN', 'FAIL'].map((status) => [
        status.toLowerCase(),
        checks.filter((check) => check.status === status).length
      ])
    )
    const requiredEvidenceAllTrue =
      checks.length > 0 &&
      checks
        .filter((check) => check.requiredForProduction)
        .every((check) => check.status === 'PASS')
    return {
      format: 'studio-preflight-v1',
      checkedAt: new Date(timestamp).toISOString(),
      environment,
      ready: production && summary.fail === 0 && requiredEvidenceAllTrue,
      productionRequiredEvidenceAllTrue: requiredEvidenceAllTrue,
      summary,
      checks
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== '--config') throw new Error('PREFLIGHT_CONFIG_REQUIRED')
    result = await runPreflight({ configPlainObject: boundedJSON(resolve(args[1])) })
  } catch {
    result = {
      format: 'studio-preflight-v1',
      ready: false,
      code: 'PREFLIGHT_CONFIG_REQUIRED',
      adviceCode: 'PROVIDE_OPS_CONFIG'
    }
  }
  console.log(JSON.stringify(result, null, 2))
  if (!result.ready) process.exitCode = 1
}
