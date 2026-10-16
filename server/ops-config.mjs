import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path'

export function privateOpsDirectory(path, root = process.cwd()) {
  const actual = value => {
    const missing = []
    while (!existsSync(value)) { const parent = dirname(value); if (parent === value) break; missing.unshift(basename(value)); value = parent }
    return join(realpathSync(value), ...missing)
  }
  const declared = resolve(root, path), canonical = actual(declared)
  for (const publicPath of ['dist', 'public', 'player-client/dist', 'player-client/public']) {
    for (const [parent, child] of [[resolve(root, publicPath), declared], [actual(resolve(root, publicPath)), canonical]]) {
      const distance = relative(parent, child)
      if (!distance || (!distance.startsWith('..') && !isAbsolute(distance))) throw new Error('OPS_CONFIG_INVALID')
    }
  }
  return declared
}

export function normalizeOpsConfig(input, { root = process.cwd() } = {}) {
  if (!input || input.format !== 'studio-ops-config-v1' ||
      !['local', 'test', 'staging', 'production'].includes(input.environment) ||
      !['internal', 'external'].includes(input.mode)) throw new Error('OPS_CONFIG_INVALID')
  const number = (key, fallback, minimum, maximum) => {
    const value = input[key] ?? fallback
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('OPS_CONFIG_INVALID')
    return value
  }
  const endpoints = {}
  for (const key of ['admin', 'player', 'live', 'ready', 'summary', 'diagnostics']) {
    const value = input.endpoints?.[key]
    if (!value) { endpoints[key] = null; continue }
    let url
    try { url = new URL(value) } catch { throw new Error('OPS_CONFIG_INVALID') }
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) ||
        (input.environment === 'production' && url.protocol !== 'https:') ||
        (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      throw new Error('OPS_CONFIG_INVALID')
    endpoints[key] = url.href
  }
  if (input.expectedRelease != null && !/^[a-f0-9]{64}$/.test(input.expectedRelease)) throw new Error('OPS_CONFIG_INVALID')
  for (const value of [input.credentialEnv, input.alerts?.targetEnv])
    if (value != null && !/^[A-Z][A-Z0-9_]{0,100}$/.test(value)) throw new Error('OPS_CONFIG_INVALID')
  const maintenance = (input.maintenance || []).map(window => {
    const start = Date.parse(window.start), end = Date.parse(window.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('OPS_CONFIG_INVALID')
    return { start, end }
  })
  const hours = input.diagnostics?.hoursUTC || []
  if (!Array.isArray(hours) || hours.some(hour => !Number.isInteger(hour) || hour < 0 || hour > 23)) throw new Error('OPS_CONFIG_INVALID')
  const defaults = { rssBytes: 1073741824, p95Ms: 1500, minimumSamples: 20, serverErrorRate: 0.05,
    minimumRequests: 20, diskFreeBytes: 1073741824, walBytes: 268435456, logBytes: 471859200,
    pushDueWaitMs: 300000, backupAgeMs: 7200000, replicationAgeMs: 86400000, certificateDays: 21, restartCount: 5 }
  const thresholds = { ...defaults, ...input.thresholds }
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Object.hasOwn(defaults, key) || !Number.isFinite(value) || value <= 0 ||
        (key === 'serverErrorRate' ? value > 1 : !Number.isSafeInteger(value))) throw new Error('OPS_CONFIG_INVALID')
  }
  const diagnosticInterval = input.diagnostics?.intervalMs ?? 86400000
  if (!Number.isSafeInteger(diagnosticInterval) || diagnosticInterval < 60000) throw new Error('OPS_CONFIG_INVALID')
  if (input.diagnostics?.enabled === true && !hours.length) throw new Error('OPS_CONFIG_INVALID')
  const pageFingerprints = { admin: input.pageFingerprints?.admin ?? null, player: input.pageFingerprints?.player ?? null }
  if (Object.values(pageFingerprints).some(value => value !== null && !/^[a-f0-9]{64}$/.test(value))) throw new Error('OPS_CONFIG_INVALID')
  const opsDir = privateOpsDirectory(input.storage?.opsDir || '.ops', root)
  return { ...input, root: resolve(root), endpoints, maintenance,
    intervalMs: number('intervalMs', 60000, 100, 86400000), timeoutMs: number('timeoutMs', 5000, 50, 60000),
    failureThreshold: number('failureThreshold', 3, 1, 100), recoveryThreshold: number('recoveryThreshold', 2, 1, 100),
    startupGraceMs: number('startupGraceMs', 60000, 0, 3600000),
    monitorLockPort: number('monitorLockPort', 3011, 1, 65535), thresholds, pageFingerprints,
    alerts: { authorized: input.alerts?.authorized === true, targetEnv: input.alerts?.targetEnv ?? null,
      evidencePath: input.alerts?.evidencePath ?? null },
    storage: { ...input.storage, opsDir },
    diagnostics: { enabled: input.diagnostics?.enabled === true, hoursUTC: hours,
      intervalMs: diagnosticInterval } }
}
export function loadOpsConfig(path) {
  try {
    if (statSync(path).size > 65536) throw new Error('LIMIT')
    return normalizeOpsConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch { throw new Error('OPS_CONFIG_INVALID') }
}
