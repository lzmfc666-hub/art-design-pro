import { request } from 'node:http'
import { createServer, connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const portProbe = (port) =>
  new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    let ended = false
    const finish = (listening) => {
      if (ended) return
      ended = true
      socket.destroy()
      done({ port, listening })
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })

// Loaded only into children spawned by our manager. Public health HTTP cannot stop a process.
const token = process.env.STUDIO_PROCESS_CONTROL_TOKEN
if (process.connected && token) {
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    const bound = Math.max(
      1000,
      Math.min(30000, Number(process.env.STUDIO_PROCESS_STOP_BOUND_MS) || 10000)
    )
    setTimeout(() => process.exit(0), bound).unref()
    if (!process.emit('SIGTERM')) process.exit(0)
  }
  process.on('message', (message) => {
    if (message?.type === 'studio:shutdown' && message.token === token) shutdown()
  })
  process.once('disconnect', shutdown)
}

export function localJsonProbe({ port, path, timeoutMs = 1500, signal }) {
  return new Promise((done) => {
    let ended = false,
      bytes = 0,
      body = ''
    const finish = (value) => {
      if (ended) return
      ended = true
      signal?.removeEventListener('abort', abort)
      req.destroy()
      done(value)
    }
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (res) => {
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 4096)
          return finish({
            healthy: false,
            restartable: false,
            category: 'config',
            adviceCode: 'CHECK_CONFIG'
          })
        body += chunk
      })
      res.once('aborted', () =>
        finish({
          healthy: false,
          restartable: true,
          category: 'transport',
          adviceCode: 'LOCAL_HEALTH_INTERRUPTED'
        })
      )
      res.once('error', () =>
        finish({
          healthy: false,
          restartable: true,
          category: 'transport',
          adviceCode: 'LOCAL_HEALTH_INTERRUPTED'
        })
      )
      res.once('end', () => {
        try {
          const data = JSON.parse(body)
          const validStatus = path.endsWith('/ready')
            ? data.status === 'ready' && data.checks?.database === true
            : path.endsWith('/live')
              ? data.status === 'ok'
              : ['ok', 'ready'].includes(data.status)
          const healthy = res.statusCode === 200 && validStatus && data.service === 'studio-api'
          const category =
            data.category || (healthy ? 'process' : res.statusCode === 503 ? 'database' : 'config')
          finish({
            healthy,
            category,
            adviceCode: data.adviceCode || (healthy ? 'NONE' : 'CHECK_CONFIG'),
            restartable: false,
            release: /^[a-f0-9]{64}$/i.test(data.release || '') ? data.release : null
          })
        } catch {
          finish({
            healthy: false,
            restartable: false,
            category: 'config',
            adviceCode: 'CHECK_CONFIG'
          })
        }
      })
    })
    const abort = () =>
      finish({
        healthy: false,
        restartable: true,
        category: 'hang',
        adviceCode: 'LOCAL_HEALTH_TIMEOUT'
      })
    signal?.addEventListener('abort', abort, { once: true })
    req.once('error', () =>
      finish({
        healthy: false,
        restartable: true,
        category: 'transport',
        adviceCode: 'LOCAL_HEALTH_CONNECTION_FAILED'
      })
    )
    req.setTimeout(timeoutMs, abort)
    if (signal?.aborted) abort()
    else req.end()
  })
}

export function apiHealthCheck({
  port,
  livePath = '/api/studio/health/live',
  readyPath = '/api/studio/health/ready',
  timeoutMs = 1500,
  expectedRelease
} = {}) {
  return async ({ signal }) => {
    const live = await localJsonProbe({ port, path: livePath, timeoutMs, signal })
    if (!live.healthy) {
      if (!live.restartable) return live
      const second = await localJsonProbe({ port, path: readyPath, timeoutMs, signal })
      if (!second.restartable)
        return second.healthy
          ? { healthy: false, restartable: false, category: 'config', adviceCode: 'CHECK_CONFIG' }
          : second
      return { ...live, category: 'hang', adviceCode: 'BOTH_LOCAL_PROBES_UNRESPONSIVE' }
    }
    if (expectedRelease && live.release !== expectedRelease)
      return { healthy: false, restartable: false, category: 'config', adviceCode: 'CHECK_CONFIG' }
    const ready = await localJsonProbe({ port, path: readyPath, timeoutMs, signal })
    // A responsive live endpoint plus an unavailable readiness read is an infrastructure issue.
    if (!ready.healthy && ready.category === 'hang')
      return { ...ready, category: 'database', restartable: false, adviceCode: 'CHECK_DATABASE' }
    if (expectedRelease && ready.healthy && ready.release !== expectedRelease)
      return { healthy: false, restartable: false, category: 'config', adviceCode: 'CHECK_CONFIG' }
    return ready
  }
}

export function readProcessOwner(directory, fileName, expectedRoot) {
  try {
    const value = JSON.parse(readFileSync(join(directory, fileName), 'utf8'))
    return value.protocol === 2 &&
      value.root === resolve(expectedRoot) &&
      typeof value.nonce === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

export function requestProcessControl(owner, command = 'ping', timeoutMs = 1500) {
  return new Promise((done) => {
    if (!owner || !Number.isInteger(owner.port)) return done(null)
    const socket = connect({ host: '127.0.0.1', port: owner.port })
    let body = '',
      ended = false
    const finish = (value) => {
      if (ended) return
      ended = true
      socket.destroy()
      done(value)
    }
    socket.once('connect', () =>
      socket.write(JSON.stringify({ protocol: 2, nonce: owner.nonce, command }) + '\n')
    )
    socket.on('data', (chunk) => {
      body += chunk
      if (body.length > 4096) finish(null)
    })
    socket.once('end', () => {
      try {
        const value = JSON.parse(body)
        finish(value.ok && value.kind === owner.kind ? value : null)
      } catch {
        finish(null)
      }
    })
    socket.once('error', () => finish(null))
    socket.setTimeout(timeoutMs, () => finish(null))
  })
}

/** OS lock first, atomic private metadata second. Stale metadata never authorizes a PID kill. */
export async function acquireProcessLock({
  directory,
  fileName,
  root,
  port,
  kind,
  onCommand = () => ({})
}) {
  mkdirSync(directory, { recursive: true })
  const nonce = randomUUID(),
    startedAt = new Date().toISOString()
  const record = {
    protocol: 2,
    root: resolve(root),
    port,
    kind,
    nonce,
    pid: process.pid,
    startedAt
  }
  const server = createServer((socket) => {
    let body = '',
      accepted = false
    socket.on('error', () => {})
    socket.setTimeout(1500, () => socket.destroy())
    socket.on('data', async (chunk) => {
      body += chunk
      if (body.length > 4096) return socket.destroy()
      if (accepted || !body.includes('\n')) return
      accepted = true
      try {
        const request = JSON.parse(body.split('\n')[0])
        if (
          request.protocol !== 2 ||
          request.nonce !== nonce ||
          !['ping', 'status', 'stop'].includes(request.command)
        )
          return socket.end('{}')
        const value = await onCommand(request.command)
        socket.end(JSON.stringify({ ok: true, kind, pid: process.pid, startedAt, ...value }))
      } catch {
        socket.end('{}')
      }
    })
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, done)
  })
  record.port = server.address().port
  const target = join(directory, fileName)
  try {
    writeFileSync(target + '.tmp', JSON.stringify(record, null, 2), { mode: 0o600 })
    renameSync(target + '.tmp', target)
  } catch (error) {
    await new Promise((done) => server.close(done))
    throw error
  }
  let closed = false
  return {
    record,
    async close() {
      if (closed) return
      closed = true
      if (readProcessOwner(directory, fileName, root)?.nonce === nonce) {
        try {
          unlinkSync(target)
        } catch {}
      }
      await new Promise((done) => server.close(done))
    }
  }
}

export async function createSupervisorOpsObserver({
  opsEvents,
  opsDirectory,
  environment = 'local'
} = {}) {
  let owned = false
  if (!opsEvents && opsDirectory) {
    const { createOpsEvents } = await import('../server/ops-events.mjs')
    const { privateOpsDirectory } = await import('../server/ops-config.mjs')
    const dbPath = join(privateOpsDirectory(opsDirectory), 'events.sqlite')
    if (process.env.STUDIO_DB_PATH && dbPath === resolve(process.env.STUDIO_DB_PATH))
      throw new Error('Operational database must be independent')
    opsEvents = createOpsEvents({ dbPath, environment })
    owned = true
  }
  return {
    observe(item) {
      if (!opsEvents || item.intentional === true) return
      let service = ['api', 'admin', 'player'].includes(item.service)
        ? item.service
        : 'supervisor'
      let categories, adviceCode
      if (item.type === 'health-ok') {
        categories = ['availability', 'responsiveness', 'restart-budget']
        adviceCode = 'CHECK_SERVICE'
      } else if (item.type === 'restart-limit') {
        categories = ['restart-budget']
        adviceCode = 'CHECK_RESTART_BUDGET'
      } else if (
        item.type === 'log-error' ||
        item.type === 'status-write-error' ||
        item.category === 'storage'
      ) {
        categories = ['log-capacity']
        service = 'storage'
        adviceCode = 'CHECK_LOGS'
      } else if (
        ['health-failed', 'health-check-error', 'forced-stop'].includes(item.type) ||
        item.category === 'hang'
      ) {
        categories = ['responsiveness']
        adviceCode = 'CHECK_SERVICE'
      } else if (
        ['health-blocked', 'exited', 'process-error', 'restart-blocked'].includes(item.type)
      ) {
        categories = ['availability']
        adviceCode =
          item.category === 'database'
            ? 'CHECK_DATABASE'
            : item.category === 'certificate'
              ? 'CHECK_CERTIFICATE'
              : 'CHECK_SERVICE'
      } else return
      for (const category of categories) {
        try {
          opsEvents.observe({
            key: `${service}.${category}`,
            service,
            category,
            healthy: item.type === 'health-ok',
            severity:
              item.type === 'health-ok'
                ? 'warning'
                : ['restart-limit', 'restart-blocked'].includes(item.type)
                  ? 'critical'
                  : 'warning',
            adviceCode
          })
        } catch {}
      }
    },
    async close() {
      if (owned) await opsEvents.close()
    }
  }
}
