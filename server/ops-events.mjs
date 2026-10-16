import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const OPS_SERVICES = Object.freeze([
  'api',
  'admin',
  'player',
  'backup',
  'storage',
  'alerts',
  'supervisor',
  'monitor',
  'certificate',
  'diagnostics',
  'replication'
])
export const OPS_CATEGORIES = Object.freeze([
  'availability',
  'resource',
  'responsiveness',
  'restart-budget',
  'disk',
  'wal',
  'log-capacity',
  'error-rate',
  'slow-response',
  'push-backlog',
  'backup',
  'backup-stale',
  'replication',
  'certificate',
  'diagnostics',
  'credentials',
  'alert-delivery',
  'startup',
  'maintenance'
])
export const OPS_ADVICE_CODES = Object.freeze([
  'CHECK_SERVICE',
  'CHECK_BACKUP',
  'CHECK_DISK',
  'CHECK_ALERT_CONFIG',
  'CHECK_ALERT_DELIVERY',
  'CHECK_LOGS',
  'CHECK_DATABASE',
  'CHECK_RESTART_BUDGET',
  'CHECK_PUSH',
  'CHECK_CERTIFICATE',
  'CHECK_DIAGNOSTICS',
  'CHECK_MONITOR_CREDENTIALS',
  'CHECK_REPLICATION'
])
const environments = ['local', 'test', 'staging', 'production']
const failureCodes = new Set([
  'DELIVERY_REJECTED',
  'DELIVERY_FAILED',
  'DELIVERY_TIMEOUT',
  'DELIVERY_ABORTED',
  'DELIVERY_CONFIG_INVALID',
  'DELIVERY_DISABLED',
  'LEASE_EXPIRED'
])
const inputFields = new Set(['key', 'service', 'category', 'healthy', 'severity', 'adviceCode'])
const eventFields = new Set([
  'id',
  'incidentId',
  'type',
  'occurredAt',
  'environment',
  'key',
  'service',
  'category',
  'severity',
  'adviceCode'
])
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export function isSafeOpsEvent(event) {
  return Boolean(
    event &&
      typeof event === 'object' &&
      !Array.isArray(event) &&
      Object.keys(event).length === eventFields.size &&
      Object.keys(event).every((key) => eventFields.has(key)) &&
      typeof event.id === 'string' &&
      typeof event.incidentId === 'string' &&
      uuidPattern.test(event.id) &&
      uuidPattern.test(event.incidentId) &&
      ['studio.ops.failure', 'studio.ops.recovery'].includes(event.type) &&
      typeof event.occurredAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.occurredAt) &&
      Number.isFinite(Date.parse(event.occurredAt)) &&
      environments.includes(event.environment) &&
      OPS_SERVICES.includes(event.service) &&
      OPS_CATEGORIES.includes(event.category) &&
      event.key === `${event.service}.${event.category}` &&
      ['warning', 'critical', 'info'].includes(event.severity) &&
      OPS_ADVICE_CODES.includes(event.adviceCode)
  )
}

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max
}

/** Independent operational state. Never pass a business database or a business transaction. */
export function createOpsEvents({
  dbPath,
  environment = 'local',
  clock = Date.now,
  retentionDays = 30,
  maxEvents = 5000,
  maxDeliveries = 5000,
  maxIncidents = 1000,
  sender,
  timeoutMs = 10000,
  leaseMs = 30000,
  maxAttempts = 3,
  baseRetryMs = 30000,
  maxRetryMs = 300000,
  batchSize = 10
} = {}) {
  if (
    !dbPath ||
    dbPath === ':memory:' ||
    !environments.includes(environment) ||
    typeof clock !== 'function' ||
    (sender !== undefined && typeof sender !== 'function') ||
    !integer(retentionDays, 1, 365) ||
    !integer(maxEvents, 2, 100000) ||
    !integer(maxDeliveries, 2, 100000) ||
    !integer(maxIncidents, 1, 50000) ||
    !integer(timeoutMs, 10, 60000) ||
    !integer(leaseMs, timeoutMs + 100, 300000) ||
    !integer(maxAttempts, 1, 10) ||
    !integer(baseRetryMs, 1, 3600000) ||
    !integer(maxRetryMs, baseRetryMs, 86400000) ||
    !integer(batchSize, 1, 100)
  )
    throw new Error('OPS_CONFIG_INVALID')
  const path = resolve(dbPath)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  let closed = false,
    running,
    closing
  const controllers = new Set()
  const now = () => {
    const value = Number(new Date(clock()))
    if (!Number.isFinite(value)) throw new Error('OPS_CLOCK_INVALID')
    return value
  }
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
    if (
      tables.some(
        ({ name }) => !['ops_meta', 'ops_incidents', 'ops_events', 'ops_deliveries'].includes(name)
      )
    )
      throw new Error('OPS_DATABASE_NOT_ISOLATED')
    db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;'
    )
    db.exec(`
      CREATE TABLE IF NOT EXISTS ops_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ops_incidents (
        id TEXT PRIMARY KEY, environment TEXT NOT NULL, key TEXT NOT NULL,
        service TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL,
        advice_code TEXT NOT NULL, opened_at INTEGER NOT NULL, resolved_at INTEGER,
        active INTEGER NOT NULL CHECK(active IN (0,1))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ops_active_key ON ops_incidents(environment,key) WHERE active=1;
      CREATE TABLE IF NOT EXISTS ops_events (
        id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES ops_incidents(id) ON DELETE CASCADE,
        transition TEXT NOT NULL CHECK(transition IN ('failure','recovery')), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops_deliveries (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES ops_events(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','accepted','failed','disabled','suppressed')),
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        lease_token TEXT, lease_until INTEGER, claimed_at INTEGER, accepted_at INTEGER,
        last_error_code TEXT, completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS ops_delivery_due ON ops_deliveries(status,next_at);
      CREATE INDEX IF NOT EXISTS ops_resolved_age ON ops_incidents(active,resolved_at);
    `)
    transaction(() => {
      const existing = db.prepare("SELECT value FROM ops_meta WHERE key='environment'").get()
      if (existing && existing.value !== environment) throw new Error('OPS_ENVIRONMENT_MISMATCH')
      db.prepare("INSERT OR IGNORE INTO ops_meta(key,value) VALUES('environment',?)").run(
        environment
      )
    })
  } catch (error) {
    db.close()
    throw error
  }
  const assertOpen = () => {
    if (closed) throw new Error('OPS_CLOSED')
  }
  const meta = (key) => db.prepare('SELECT value FROM ops_meta WHERE key=?').get(key)?.value
  const putMeta = (key, value) =>
    db
      .prepare(
        'INSERT INTO ops_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, String(value))
  const countFailure = (timestamp, code) => {
    putMeta('failedAttempts', Number(meta('failedAttempts') || 0) + 1)
    putMeta('consecutiveFailures', Number(meta('consecutiveFailures') || 0) + 1)
    putMeta('lastFailureAt', timestamp)
    putMeta('lastErrorCode', code)
  }
  const counts = () => ({
    incidents: Number(db.prepare('SELECT COUNT(*) AS n FROM ops_incidents').get().n),
    active: Number(db.prepare('SELECT COUNT(*) AS n FROM ops_incidents WHERE active=1').get().n),
    events: Number(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n),
    deliveries: Number(db.prepare('SELECT COUNT(*) AS n FROM ops_deliveries').get().n)
  })
  const removable = () =>
    db
      .prepare(
        `SELECT i.id FROM ops_incidents i WHERE active=0 AND NOT EXISTS (
    SELECT 1 FROM ops_events e JOIN ops_deliveries d ON d.event_id=e.id
    WHERE e.incident_id=i.id AND d.status IN ('pending','processing')
  ) ORDER BY resolved_at,id`
      )
      .all()
  const pruneInside = (
    timestamp,
    needed = { events: 0, deliveries: 0, incidents: 0, active: 0 }
  ) => {
    let pruned = 0
    const cutoff = timestamp - retentionDays * 86400000
    const candidates = removable()
    const fits = () => {
      const n = counts()
      // Reserve one recovery event/delivery for each active incident, even at capacity.
      return (
        n.events + needed.events + n.active + needed.active <= maxEvents &&
        n.deliveries + needed.deliveries + n.active + needed.active <= maxDeliveries &&
        n.incidents + needed.incidents <= maxIncidents
      )
    }
    for (const row of candidates) {
      const age = db
        .prepare('SELECT resolved_at FROM ops_incidents WHERE id=?')
        .get(row.id).resolved_at
      if (age >= cutoff && fits()) continue
      db.prepare('DELETE FROM ops_incidents WHERE id=? AND active=0').run(row.id)
      pruned++
    }
    if (pruned) putMeta('prunedIncidents', Number(meta('prunedIncidents') || 0) + pruned)
    return { pruned, fits: fits() }
  }
  const projection = (row) => ({
    id: row.id,
    incidentId: row.incident_id,
    type: `studio.ops.${row.transition}`,
    occurredAt: new Date(row.created_at).toISOString(),
    environment: row.environment,
    key: row.key,
    service: row.service,
    category: row.category,
    severity: row.transition === 'recovery' ? 'info' : row.severity,
    adviceCode: row.advice_code
  })
  const eventRow = (id) =>
    db
      .prepare(
        `SELECT e.*,i.environment,i.key,i.service,i.category,i.severity,i.advice_code
    FROM ops_events e JOIN ops_incidents i ON i.id=e.incident_id WHERE e.id=?`
      )
      .get(id)
  function observe(input) {
    assertOpen()
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !inputFields.has(key)) ||
      !OPS_SERVICES.includes(input.service) ||
      !OPS_CATEGORIES.includes(input.category) ||
      input.key !== `${input.service}.${input.category}` ||
      typeof input.healthy !== 'boolean' ||
      !['warning', 'critical'].includes(input.severity) ||
      !OPS_ADVICE_CODES.includes(input.adviceCode)
    )
      throw new Error('OPS_EVENT_INVALID')
    const timestamp = now()
    return transaction(() => {
      const active = db
        .prepare('SELECT * FROM ops_incidents WHERE environment=? AND key=? AND active=1')
        .get(environment, input.key)
      if ((!input.healthy && active) || (input.healthy && !active))
        return { changed: false, incidentId: active?.id ?? null }
      const room = pruneInside(timestamp, {
        events: 1,
        deliveries: 1,
        incidents: active ? 0 : 1,
        active: active ? -1 : 1
      })
      if (!room.fits) {
        putMeta('capacityRejected', Number(meta('capacityRejected') || 0) + 1)
        return { changed: false, code: 'OPS_CAPACITY_REACHED' }
      }
      const incidentId = active?.id || randomUUID()
      if (active)
        db.prepare('UPDATE ops_incidents SET active=0,resolved_at=? WHERE id=? AND active=1').run(
          timestamp,
          incidentId
        )
      else
        db.prepare(
          `INSERT INTO ops_incidents(id,environment,key,service,category,severity,advice_code,opened_at,active)
        VALUES(?,?,?,?,?,?,?,?,1)`
        ).run(
          incidentId,
          environment,
          input.key,
          input.service,
          input.category,
          input.severity,
          input.adviceCode,
          timestamp
        )
      const eventId = randomUUID(),
        deliveryId = randomUUID()
      const deliveryStatus =
        input.category === 'alert-delivery' ? 'suppressed' : sender ? 'pending' : 'disabled'
      db.prepare(
        'INSERT INTO ops_events(id,incident_id,transition,created_at) VALUES(?,?,?,?)'
      ).run(eventId, incidentId, active ? 'recovery' : 'failure', timestamp)
      db.prepare(
        'INSERT INTO ops_deliveries(id,event_id,status,next_at,completed_at) VALUES(?,?,?,?,?)'
      ).run(
        deliveryId,
        eventId,
        deliveryStatus,
        timestamp,
        ['suppressed', 'disabled'].includes(deliveryStatus) ? timestamp : null
      )
      return { changed: true, incidentId, eventId, deliveryId, deliveryStatus }
    })
  }
  function claim() {
    const timestamp = now()
    return transaction(() => {
      const expired = db
        .prepare("SELECT * FROM ops_deliveries WHERE status='processing' AND lease_until<=?")
        .all(timestamp)
      for (const row of expired) {
        const terminal = row.attempts >= maxAttempts
        db.prepare(
          `UPDATE ops_deliveries SET status=?,next_at=?,lease_token=NULL,lease_until=NULL,
          last_error_code='LEASE_EXPIRED',completed_at=? WHERE id=? AND status='processing' AND lease_token=?`
        ).run(
          terminal ? 'failed' : 'pending',
          timestamp + Math.min(maxRetryMs, baseRetryMs * 2 ** Math.max(0, row.attempts - 1)),
          terminal ? timestamp : null,
          row.id,
          row.lease_token
        )
        countFailure(timestamp, 'LEASE_EXPIRED')
      }
      const row = db
        .prepare(
          `SELECT d.* FROM ops_deliveries d JOIN ops_events e ON e.id=d.event_id
        JOIN ops_incidents incident ON incident.id=e.incident_id
        WHERE d.status='pending' AND d.next_at<=? AND NOT EXISTS (
          SELECT 1 FROM ops_events earlier JOIN ops_deliveries predecessor ON predecessor.event_id=earlier.id
          JOIN ops_incidents prior_incident ON prior_incident.id=earlier.incident_id
          WHERE prior_incident.environment=incident.environment AND prior_incident.key=incident.key AND earlier.rowid<e.rowid
            AND predecessor.status IN ('pending','processing')
        ) ORDER BY d.next_at,d.rowid LIMIT 1`
        )
        .get(timestamp)
      if (!row) return null
      const token = randomUUID()
      db.prepare(
        "UPDATE ops_deliveries SET status='processing',attempts=attempts+1,lease_token=?,lease_until=?,claimed_at=? WHERE id=? AND status='pending'"
      ).run(token, timestamp + leaseMs, timestamp, row.id)
      return {
        ...row,
        attempts: row.attempts + 1,
        token,
        event: projection(eventRow(row.event_id))
      }
    })
  }
  async function send(row) {
    const controller = new AbortController()
    controllers.add(controller)
    let timer
    const interrupted = new Promise((done) => {
      controller.signal.addEventListener(
        'abort',
        () => done({ ok: false, code: closed ? 'DELIVERY_ABORTED' : 'DELIVERY_TIMEOUT' }),
        { once: true }
      )
      timer = setTimeout(() => controller.abort(), timeoutMs)
    })
    try {
      const result = await Promise.race([
        Promise.resolve()
          .then(() =>
            controller.signal.aborted
              ? { ok: false, code: 'DELIVERY_ABORTED' }
              : sender(row.event, { signal: controller.signal, deliveryId: row.id })
          )
          .catch(() => ({ ok: false, code: 'DELIVERY_FAILED' })),
        interrupted
      ])
      return result?.ok === true
        ? { ok: true }
        : {
            ok: false,
            code: failureCodes.has(result?.code) ? result.code : 'DELIVERY_REJECTED'
          }
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  }
  async function runFlush() {
    const result = { claimed: 0, accepted: 0, failed: 0, stale: 0, disabled: !sender }
    if (!sender || closed) return result
    for (let index = 0; index < batchSize && !closed; index++) {
      const row = claim()
      if (!row) break
      result.claimed++
      const sent = await send(row),
        timestamp = now()
      transaction(() => {
        const owned = db
          .prepare(
            "SELECT id FROM ops_deliveries WHERE id=? AND status='processing' AND lease_token=?"
          )
          .get(row.id, row.token)
        if (!owned) {
          result.stale++
          return
        }
        if (sent.ok) {
          db.prepare(
            "UPDATE ops_deliveries SET status='accepted',accepted_at=?,completed_at=?,lease_token=NULL,lease_until=NULL,last_error_code=NULL WHERE id=? AND lease_token=?"
          ).run(timestamp, timestamp, row.id, row.token)
          putMeta('consecutiveFailures', 0)
          putMeta('lastAcceptedAt', timestamp)
          result.accepted++
        } else {
          const terminal = row.attempts >= maxAttempts
          db.prepare(
            'UPDATE ops_deliveries SET status=?,next_at=?,last_error_code=?,completed_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?'
          ).run(
            terminal ? 'failed' : 'pending',
            timestamp + Math.min(maxRetryMs, baseRetryMs * 2 ** (row.attempts - 1)),
            sent.code,
            terminal ? timestamp : null,
            row.id,
            row.token
          )
          countFailure(timestamp, sent.code)
          result.failed++
        }
      })
    }
    return result
  }
  const isoMeta = (key) => (meta(key) ? new Date(Number(meta(key))).toISOString() : null)
  return {
    observe,
    flush() {
      assertOpen()
      if (!running)
        running = runFlush().finally(() => {
          running = null
        })
      return running
    },
    prune() {
      assertOpen()
      return transaction(() => pruneInside(now()))
    },
    events({ limit = 100 } = {}) {
      assertOpen()
      if (!integer(limit, 1, 1000)) throw new Error('OPS_QUERY_INVALID')
      return db
        .prepare(
          `SELECT e.*,i.environment,i.key,i.service,i.category,i.severity,i.advice_code
        FROM ops_events e JOIN ops_incidents i ON i.id=e.incident_id ORDER BY e.created_at DESC,e.rowid DESC LIMIT ?`
        )
        .all(limit)
        .map(projection)
    },
    snapshot() {
      assertOpen()
      const states = Object.fromEntries(
        ['pending', 'processing', 'accepted', 'failed', 'disabled', 'suppressed'].map((status) => [
          status,
          0
        ])
      )
      for (const row of db
        .prepare('SELECT status,COUNT(*) AS n FROM ops_deliveries GROUP BY status')
        .all())
        states[row.status] = Number(row.n)
      const consecutiveFailures = Number(meta('consecutiveFailures') || 0)
      return {
        environment,
        counts: counts(),
        limits: { retentionDays, maxEvents, maxDeliveries, maxIncidents },
        activeIncidents: db
          .prepare('SELECT * FROM ops_incidents WHERE active=1 ORDER BY opened_at,id')
          .all()
          .map((row) => ({
            id: row.id,
            key: row.key,
            service: row.service,
            category: row.category,
            severity: row.severity,
            adviceCode: row.advice_code,
            openedAt: new Date(row.opened_at).toISOString()
          })),
        delivery: {
          configured: Boolean(sender),
          state: !sender ? 'disabled' : consecutiveFailures ? 'degraded' : 'ready',
          ...states,
          failedAttempts: Number(meta('failedAttempts') || 0),
          consecutiveFailures,
          lastFailureAt: isoMeta('lastFailureAt'),
          lastErrorCode: meta('lastErrorCode') ?? null,
          lastAcceptedAt: isoMeta('lastAcceptedAt')
        },
        capacityRejected: Number(meta('capacityRejected') || 0),
        prunedIncidents: Number(meta('prunedIncidents') || 0)
      }
    },
    close() {
      if (!closing) {
        closed = true
        for (const controller of controllers) controller.abort()
        closing = (async () => {
          try {
            await running
          } finally {
            db.close()
          }
        })()
      }
      return closing
    }
  }
}
