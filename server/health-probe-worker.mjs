import { parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

export function probeDatabase(db) {
  const row = db.prepare("SELECT id,json_valid(json) AS valid,json_extract(json,'$.schemaVersion') AS version FROM studio_state WHERE id=1").get()
  if (!row || row.valid !== 1 || ![1, 2].includes(row.version)) return false
  // Verify a bounded read of necessary tables, never enumerate orders or private values.
  for (const table of ['sessions', 'uploads', 'fund_accounts', 'fund_transactions', 'audit_logs',
    'business_requests', 'financial_requests', 'player_notifications', 'player_push_outbox'])
    db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
  return true
}

parentPort?.on('message', ({ id, path, busyMs }) => {
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${busyMs}`)
    db.exec('BEGIN')
    const ready = probeDatabase(db)
    db.exec('ROLLBACK')
    parentPort.postMessage({ id, ready })
  } catch { parentPort.postMessage({ id, ready: false }) }
  finally { db?.close() }
})
