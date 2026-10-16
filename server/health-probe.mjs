import { Worker } from 'node:worker_threads'
import { probeDatabase } from './health-probe-worker.mjs'

export function createReadinessProbe({ dbPath, db, timeoutMs = 1500, busyMs = 150,
  cacheMs = 1000, workerFactory = () => new Worker(new URL('./health-probe-worker.mjs', import.meta.url)) } = {}) {
  for (const [value, minimum, maximum] of [[timeoutMs, 50, 10000], [busyMs, 0, 1000], [cacheMs, 0, 5000]])
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('健康探针配置无效')
  let worker, inflight, cached, cachedAt = 0, sequence = 0, closed = false
  const stats = { runs: 0, timeouts: 0, workerErrors: 0 }
  const invalidate = () => { const old = worker; worker = null; void old?.terminate() }
  async function check() {
    if (closed) return false
    const connection = typeof db === 'function' ? db() : db
    // A healthy file must not hide an unavailable API connection.
    if (db !== undefined) {
      try { connection.prepare('SELECT 1').get() } catch { return false }
    }
    if (cached !== undefined && Date.now() - cachedAt < cacheMs) return cached
    if (inflight) return inflight
    stats.runs++
    if (dbPath === ':memory:') {
      try { return probeDatabase(connection) } catch { return false }
    }
    inflight = new Promise(resolve => {
      const id = ++sequence
      try { worker ||= workerFactory(); worker.unref?.() }
      catch { stats.workerErrors++; resolve(false); return }
      const current = worker
      let settled = false
      const finish = (value, restart = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        current.off('message', message); current.off('error', error); current.off('exit', exit)
        if (restart) invalidate()
        cached = value; cachedAt = Date.now()
        resolve(value)
      }
      const message = result => { if (result.id === id) finish(result.ready === true) }
      const error = () => { stats.workerErrors++; finish(false, true) }
      const exit = () => { stats.workerErrors++; finish(false, true) }
      const timer = setTimeout(() => { stats.timeouts++; finish(false, true) }, timeoutMs)
      current.on('message', message); current.once('error', error); current.once('exit', exit)
      try { current.postMessage({ id, path: dbPath, busyMs }) } catch { error() }
    }).finally(() => { inflight = null })
    return inflight
  }
  return { check, metrics: () => ({ ...stats, busy: Boolean(inflight) }), close() { closed = true; invalidate() } }
}
