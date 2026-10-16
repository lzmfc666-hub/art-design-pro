import { createHash, timingSafeEqual } from 'node:crypto'

export function createMonitorAuthority(token) {
  if (token && (typeof token !== 'string' || !/^[^\s]{32,256}$/.test(token)))
    throw new Error('监控凭据须为32至256字符的独立随机秘密')
  const expected = token ? createHash('sha256').update(token).digest() : null
  return { configured: Boolean(expected), accepts(header) {
    if (!expected || typeof header !== 'string' || !/^Bearer [^\s]{32,256}$/.test(header)) return false
    return timingSafeEqual(expected, createHash('sha256').update(header.slice(7)).digest())
  } }
}
export function safeRuntimeSummary({ runtime, backups, release, ready, probe }) {
  return {
    status: ready ? 'ready' : 'not-ready', release,
    generatedAt: runtime.generatedAt, source: 'actual-runtime',
    process: { uptimeSeconds: runtime.process.uptimeSeconds, rssBytes: runtime.process.memory.rss,
      heapUsedBytes: runtime.process.memory.heapUsed },
    http: { ...runtime.http }, storage: { ...runtime.storage },
    logs: runtime.logs.map(row => ({ table: row.table_name, bytes: row.bytes, rows: row.rows })),
    push: { pendingDue: runtime.push.due, oldestDueWaitMs: runtime.push.oldestDueWaitMs },
    backups, probe
  }
}
