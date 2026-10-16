import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

// The parent passes its newly reserved backup copy, never the live business DB.
let db
try {
  db = new DatabaseSync(workerData.path)
  const deleted = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_deletions'").get()
    ? db.prepare('SELECT count(*) AS count FROM image_deletions').get().count : 0
  const freePagesBefore = db.prepare('PRAGMA freelist_count').get().freelist_count
  if (deleted && freePagesBefore) db.exec('VACUUM')
  parentPort.postMessage({ ok: true, deleted, compacted: Boolean(deleted && freePagesBefore), freePagesBefore })
} catch { parentPort.postMessage({ ok: false }) }
finally { db?.close() }
