import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { probeHttp } from './ops-probe.mjs'
import { OPS_SERVICES, OPS_CATEGORIES } from './ops-events.mjs'

export function createOpsMonitor({ config, events, statePath, clock = Date.now, probe = probeHttp,
  secretReader = name => process.env[name], hostSample = () => null } = {}) {
  let running = false, closed = false, timer
  const initial = { format: 'studio-monitor-state-v1', observations: {}, history: [], previousHttp: null, diagnosticAt: 0 }
  let state = initial
  if (existsSync(statePath)) {
    try {
      if (statSync(statePath).size > 262144) throw new Error('STATE_LIMIT')
      const saved = JSON.parse(readFileSync(statePath, 'utf8'))
      if (saved.format === initial.format && Object.keys(saved.observations || {}).length <= 100) {
        for (const [key, value] of Object.entries(saved.observations || {})) {
          const [service, category] = key.split('.')
          if (!OPS_SERVICES.includes(service) || !OPS_CATEGORIES.includes(category) || key !== `${service}.${category}`) continue
          if (![true, false, null].includes(value.healthy) || !Number.isSafeInteger(value.failures) || !Number.isSafeInteger(value.successes)) continue
          state.observations[key] = { healthy: value.healthy, failures: Math.max(0, Math.min(config.failureThreshold, value.failures)),
            successes: Math.max(0, Math.min(config.recoveryThreshold, value.successes)),
            observedAt: Number.isFinite(Date.parse(value.observedAt)) ? new Date(value.observedAt).toISOString() : null,
            state: ['unknown', 'healthy', 'pending-failure', 'fault'].includes(value.state) ? value.state : 'unknown' }
        }
        if (Number.isSafeInteger(saved.previousHttp?.requests) && Number.isSafeInteger(saved.previousHttp?.errors))
          state.previousHttp = { requests: saved.previousHttp.requests, errors: saved.previousHttp.errors }
        if (Number.isFinite(saved.diagnosticAt)) state.diagnosticAt = saved.diagnosticAt
        for (const key of ['backupEnabledAt', 'backupSuccessAt'])
          if (Number.isFinite(saved[key]) && saved[key] >= 0) state[key] = saved[key]
        // Incidents and delivery deduplication survive in SQLite; untrusted saved
        // metric history is not echoed into a new process's public status.
      }
    } catch {}
  }
  const startedAt = Number(new Date(clock()))
  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(statePath + '.tmp', statePath)
  }
  const event = (service, category, healthy, adviceCode = 'CHECK_SERVICE', severity = 'critical', confirmed = false) => {
    const key = `${service}.${category}`, now = Number(new Date(clock()))
    const failureThreshold = confirmed ? 1 : config.failureThreshold
    const previous = state.observations[key] || { failures: 0, successes: 0 }
    const observation = { ...previous, observedAt: new Date(now).toISOString(), healthy }
    if (healthy === null) { observation.failures = 0; observation.successes = 0; observation.state = 'unknown' }
    else if (healthy) { observation.failures = 0; observation.successes = Math.min(config.recoveryThreshold, previous.successes + 1); observation.state = 'healthy' }
    else { observation.successes = 0; observation.failures = Math.min(failureThreshold, previous.failures + 1); observation.state = 'pending-failure' }
    state.observations[key] = observation
    if (now - startedAt < config.startupGraceMs) return
    if ((healthy === false && observation.failures >= failureThreshold) ||
        (healthy === true && observation.successes >= config.recoveryThreshold)) {
      events.observe({ key, service, category, healthy, adviceCode, severity })
      if (!healthy) observation.state = 'fault'
    }
  }
  async function cycle() {
    if (running || closed) return { skipped: true }
    running = true
    const now = Number(new Date(clock())), observedAt = new Date(now).toISOString()
    try {
      const maintenance = config.maintenance.some(window => now >= window.start && now < window.end)
      if (maintenance) {
        for (const observation of Object.values(state.observations)) { observation.failures = 0; observation.successes = 0 }
        state.lastRun = { observedAt, maintenance: true, samples: 0 }; save(); return state.lastRun
      }
      const options = { timeoutMs: config.timeoutMs, expectedRelease: config.expectedRelease }
      // At most five concurrent lightweight probes, no full business reads.
      const [admin, player, live, ready] = await Promise.all([
        probe(config.endpoints.admin, { ...options, kind: 'page', expectedPageSha256: config.pageFingerprints?.admin }),
        probe(config.endpoints.player, { ...options, kind: 'page', expectedPageSha256: config.pageFingerprints?.player }),
        probe(config.endpoints.live, { ...options, kind: 'live' }),
        probe(config.endpoints.ready, { ...options, kind: 'ready' })
      ])
      event('admin', 'availability', admin.healthy)
      event('player', 'availability', player.healthy)
      const apiGood = live.healthy === null || ready.healthy === null ? null : live.healthy && ready.healthy
      event('api', 'availability', apiGood, ready.code === 'DATABASE_NOT_READY' ? 'CHECK_DATABASE' : 'CHECK_SERVICE')
      event('api', 'responsiveness', live.code === 'TIMEOUT' && ready.code === 'TIMEOUT' ? false : apiGood === null ? null : true)
      const tls = [admin, player, live, ready].filter(row => row.certificateDays !== null && row.certificateDays !== undefined)
      const invalidTls = [admin, player, live, ready].some(row => row.code === 'CERTIFICATE_INVALID')
      event('certificate', 'certificate', invalidTls ? false : tls.length ?
        tls.every(row => row.certificateDays > config.thresholds.certificateDays) : null, 'CHECK_CERTIFICATE', 'warning')
      const token = config.credentialEnv ? secretReader(config.credentialEnv) : null
      let sample = null, summaryHealthy = null
      if (token && config.endpoints.summary) {
        const result = await probe(config.endpoints.summary, { ...options, token, kind: 'summary' })
        summaryHealthy = result.healthy
        event('monitor', 'credentials', result.code === 'CREDENTIALS_INVALID' ? false : result.healthy === true ? true : null,
          'CHECK_MONITOR_CREDENTIALS', 'warning')
        sample = result.metrics || null
      } else event('monitor', 'credentials', null, 'CHECK_MONITOR_CREDENTIALS', 'warning')
      const host = await hostSample()
      if (sample) {
        const thresholds = config.thresholds, http = sample.http
        const previous = state.previousHttp
        const reset = previous && http.requests < previous.requests
        const requests = previous && !reset ? http.requests - previous.requests : 0
        const errors = previous && !reset ? http.errors - previous.errors : 0
        event('api', 'error-rate', requests >= thresholds.minimumRequests ? errors / requests < thresholds.serverErrorRate : null)
        event('api', 'slow-response', http.sampleCount >= thresholds.minimumSamples ? http.p95Ms < thresholds.p95Ms : null,
          'CHECK_SERVICE', 'warning')
        event('storage', 'disk', Number.isFinite(sample.storage.freeBytes) ? sample.storage.freeBytes >= thresholds.diskFreeBytes : null,
          'CHECK_DISK')
        event('storage', 'wal', Number.isFinite(sample.storage.walBytes) ? sample.storage.walBytes < thresholds.walBytes : null,
          'CHECK_DISK', 'warning')
        event('api', 'resource', sample.process.rssBytes < thresholds.rssBytes, 'CHECK_SERVICE', 'warning')
        event('api', 'push-backlog', sample.push.pendingDue === 0 || sample.push.oldestDueWaitMs < thresholds.pushDueWaitMs,
          'CHECK_PUSH', 'warning')
        event('backup', 'backup', sample.backups.enabled ? (!sample.backups.lastFailureAt ||
          Date.parse(sample.backups.lastCompletedAt) >= Date.parse(sample.backups.lastFailureAt)) : null,
          'CHECK_BACKUP')
        if (sample.backups.enabled) {
          state.backupEnabledAt ??= now - Math.max(0, sample.backups.ageMs)
          const completedAt = Date.parse(sample.backups.lastCompletedAt)
          if (Number.isFinite(completedAt) && completedAt <= now + 300000)
            state.backupSuccessAt = Math.max(state.backupSuccessAt || 0, completedAt)
        }
        event('backup', 'backup-stale', sample.backups.enabled ?
          now - (state.backupSuccessAt ?? state.backupEnabledAt) < thresholds.backupAgeMs : null, 'CHECK_BACKUP')
        const replica = sample.backups.replication
        event('replication', 'replication', replica?.enabled ? Boolean(replica.lastSuccessAt &&
          !replica.lastErrorCode && now - Date.parse(replica.lastSuccessAt) < thresholds.replicationAgeMs) : null,
          'CHECK_REPLICATION')
        state.previousHttp = { requests: http.requests, errors: http.errors }
      } else {
        for (const [service, category, advice] of [['api', 'error-rate', 'CHECK_SERVICE'], ['api', 'slow-response', 'CHECK_SERVICE'],
          ['api', 'resource', 'CHECK_SERVICE'], ['storage', 'disk', 'CHECK_DISK'], ['storage', 'wal', 'CHECK_DISK'],
          ['api', 'push-backlog', 'CHECK_PUSH'], ['backup', 'backup', 'CHECK_BACKUP'],
          ['backup', 'backup-stale', 'CHECK_BACKUP'], ['replication', 'replication', 'CHECK_REPLICATION']])
          event(service, category, null, advice)
      }
      if (host) {
        if (host.managerHealthy !== undefined) event('supervisor', 'availability', host.managerHealthy)
        if (host.restartBudgetExhausted !== undefined) event('supervisor', 'restart-budget', !host.restartBudgetExhausted,
          'CHECK_RESTART_BUDGET')
      }
      const logsGood = sample?.logs.length ? sample.logs.every(row => row.bytes < config.thresholds.logBytes) : null
      const hostLogsGood = host?.logCapacityHealthy === false ? false : Number.isFinite(host?.logBytes)
        ? host.logBytes < config.thresholds.logBytes : null
      event('storage', 'log-capacity', logsGood === false || hostLogsGood === false ? false :
        host?.logCapacityHealthy === null ? null : logsGood === true || hostLogsGood === true ? true : null, 'CHECK_LOGS', 'warning')
      if (config.diagnostics.enabled && token && config.diagnostics.hoursUTC.includes(new Date(now).getUTCHours()) &&
          now - startedAt >= config.startupGraceMs &&
          now - state.diagnosticAt >= config.diagnostics.intervalMs) {
        state.diagnosticAt = now
        const result = await probe(config.endpoints.diagnostics, { ...options, token, kind: 'diagnostics' })
        if (result.diagnostics) {
          event('diagnostics', 'diagnostics', result.diagnostics.errorCount === 0, 'CHECK_DIAGNOSTICS', 'critical', true)
        } else event('diagnostics', 'diagnostics', null, 'CHECK_DIAGNOSTICS')
        event('diagnostics', 'availability', result.healthy, 'CHECK_DIAGNOSTICS')
      }
      await events.flush()
      const delivery = events.snapshot().delivery
      event('alerts', 'alert-delivery', delivery.state === 'disabled' ? null : delivery.state !== 'degraded', 'CHECK_ALERT_DELIVERY', 'warning')
      const sampleSafe = sample ? { rssBytes: sample.process.rssBytes, heapUsedBytes: sample.process.heapUsedBytes,
        p95Ms: sample.http.p95Ms, requests: sample.http.requests, errors: sample.http.errors,
        classifications: Object.fromEntries(['unauthorized401', 'forbidden403', 'conflict409', 'limited429', 'otherClient']
          .map(key => [key, Number(sample.http.classifications?.[key]) || 0])), freeBytes: sample.storage.freeBytes,
        walBytes: sample.storage.walBytes, pushDue: sample.push.pendingDue,
        pushWaitMs: sample.push.oldestDueWaitMs, backupsEnabled: sample.backups.enabled } : null
      state.lastRun = { observedAt, maintenance: false, samples: [admin, player, live, ready].filter(row => row.healthy !== null).length,
        failedProbes: [admin, player, live, ready].filter(row => row.healthy === false).length,
        unknownProbes: [admin, player, live, ready].filter(row => row.healthy === null).length, summaryAvailable: Boolean(sample),
        alertDelivery: delivery.state, minimumCertificateDays: tls.length ? Math.min(...tls.map(row => row.certificateDays)) : null }
      state.history.push({ ...state.lastRun, metrics: sampleSafe })
      state.history = state.history.slice(-100)
      event('monitor', 'availability', summaryHealthy === false ? false : true, 'CHECK_SERVICE')
      save()
      return state.lastRun
    } catch {
      event('monitor', 'availability', false, 'CHECK_SERVICE')
      state.lastRun = { observedAt, maintenance: false, errorCode: 'MONITOR_CYCLE_FAILED', samples: 0 }
      save()
      return state.lastRun
    } finally { running = false }
  }
  return { cycle, snapshot: () => JSON.parse(JSON.stringify(state)), start() {
    if (!timer && !closed) { timer = setInterval(() => void cycle().catch(() => {}), config.intervalMs); void cycle().catch(() => {}) }
  }, async close() { closed = true; clearInterval(timer); while (running) await new Promise(done => setTimeout(done, 10)) } }
}
