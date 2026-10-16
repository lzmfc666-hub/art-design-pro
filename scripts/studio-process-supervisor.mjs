import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { createCappedLogSink } from './studio-log-sink.mjs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const preload = new URL('./studio-service-control.mjs', import.meta.url).href
const restartBlockedCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS'])
const categories = new Set([
  'process',
  'hang',
  'transport',
  'database',
  'storage',
  'configuration',
  'config',
  'certificate',
  'external_network',
  'ownership'
])

/** Only ChildProcess handles created here can be stopped. Ports/PIDs never grant ownership. */
export function superviseServices({
  services,
  directory,
  retryDelayMs = 1500,
  maxRestarts = 5,
  restartWindowMs = 60000,
  backoffFactor = 2,
  maxRetryDelayMs = 30000,
  cooldownMs = 0,
  healthCheck,
  healthIntervalMs = 5000,
  healthTimeoutMs = 2000,
  initialGraceMs = 30000,
  failureThreshold = 3,
  stopGraceMs = 5000,
  heartbeatMs = 5000,
  managerNonce = randomUUID(),
  onEvent = () => {}
}) {
  for (const value of [
    retryDelayMs,
    restartWindowMs,
    maxRetryDelayMs,
    healthIntervalMs,
    healthTimeoutMs,
    heartbeatMs
  ])
    if (!Number.isFinite(value) || value <= 0) throw new Error('Supervisor timing must be positive')
  if (
    !Number.isInteger(maxRestarts) ||
    maxRestarts < 0 ||
    !Number.isInteger(failureThreshold) ||
    failureThreshold < 1
  )
    throw new Error('Supervisor limits must be non-negative integers')
  if (
    services.some((service) => !/^[a-zA-Z0-9_-]+$/.test(service.name)) ||
    new Set(services.map((service) => service.name)).size !== services.length
  )
    throw new Error('Service names must be unique safe identifiers')
  mkdirSync(directory, { recursive: true })
  let stopping = false,
    stopPromise
  const entries = services.map((service) => ({
    service,
    child: null,
    timer: null,
    failures: [],
    closed: Promise.resolve(),
    stopPromise: null,
    probing: false,
    restartBlocked: false,
    status: {
      name: service.name,
      port: service.port,
      state: 'starting',
      pid: null,
      restarts: 0,
      healthy: null,
      healthFailures: 0
    }
  }))
  const notify = (item) => {
    try {
      onEvent(item)
    } catch {}
  }
  const save = () => {
    const target = join(directory, 'status.json')
    try {
      writeFileSync(
        target + '.tmp',
        JSON.stringify(
          {
            managerPid: process.pid,
            managerNonce,
            updatedAt: new Date().toISOString(),
            stopping,
            services: entries.map((entry) => entry.status)
          },
          null,
          2
        ),
        { mode: 0o600 }
      )
      renameSync(target + '.tmp', target)
    } catch (error) {
      notify({
        at: new Date().toISOString(),
        type: 'status-write-error',
        category: 'storage',
        healthy: false,
        severity: 'error',
        adviceCode: 'CHECK_DISK',
        code: error.code
      })
    }
  }
  const event = (entry, type, extra = {}) => {
    notify({
      at: new Date().toISOString(),
      service: entry.service.name,
      type,
      category: 'process',
      healthy: entry.status.healthy,
      severity: 'info',
      adviceCode: 'NONE',
      ...extra
    })
    save()
  }
  async function stopEntry(entry, reason) {
    if (entry.stopPromise) return entry.stopPromise
    const child = entry.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return entry.closed
    entry.stopPromise = (async () => {
      entry.status.state = stopping ? 'stopping' : 'recovering'
      event(entry, 'graceful-stop', {
        category: reason,
        healthy: false,
        severity: 'warning',
        adviceCode: 'WAIT_GRACEFUL_EXIT'
      })
      if (entry.service.gracefulStop) {
        let callbackTimer
        try {
          await Promise.race([
            Promise.resolve().then(() => entry.service.gracefulStop({ child })),
            new Promise((done) => {
              callbackTimer = setTimeout(done, stopGraceMs)
            })
          ])
        } catch {
        } finally {
          clearTimeout(callbackTimer)
        }
      } else if (child.connected && entry.controlToken) {
        try {
          child.send({ type: 'studio:shutdown', token: entry.controlToken }, () => {})
        } catch {}
      } else child.kill('SIGTERM')
      let graceTimer
      await Promise.race([
        entry.closed,
        new Promise((done) => {
          graceTimer = setTimeout(done, stopGraceMs)
        })
      ])
      clearTimeout(graceTimer)
      if (entry.child === child && child.exitCode === null && child.signalCode === null) {
        event(entry, 'forced-stop', {
          category: reason,
          healthy: false,
          severity: 'warning',
          adviceCode: 'OWNED_CHILD_HUNG'
        })
        child.kill('SIGKILL')
      }
      await entry.closed
    })().finally(() => {
      entry.stopPromise = null
    })
    return entry.stopPromise
  }
  function scheduleRestart(entry, spawnError) {
    if (stopping) return
    if (
      entry.restartBlocked ||
      restartBlockedCodes.has(spawnError?.code) ||
      entry.service.noRestartExitCodes?.includes(entry.status.exitCode)
    ) {
      entry.status.state = 'failed'
      event(entry, 'restart-blocked', {
        category: restartBlockedCodes.has(spawnError?.code)
          ? 'configuration'
          : entry.status.category,
        healthy: false,
        severity: 'error',
        adviceCode: entry.status.adviceCode || 'CHECK_LOCAL_CONFIGURATION'
      })
      return
    }
    const now = Date.now()
    entry.failures = entry.failures.filter((at) => now - at < restartWindowMs)
    entry.failures.push(now)
    if (entry.failures.length > maxRestarts) {
      entry.status.state = 'failed'
      event(entry, 'restart-limit', {
        healthy: false,
        severity: 'error',
        adviceCode: 'RESTART_BUDGET_EXHAUSTED',
        failures: entry.failures.length,
        restartWindowMs
      })
      return
    }
    const waitMs = Math.max(
      cooldownMs,
      Math.min(
        maxRetryDelayMs,
        retryDelayMs * Math.max(1, backoffFactor) ** (entry.failures.length - 1)
      )
    )
    entry.status.state = 'waiting-restart'
    entry.status.retryAt = new Date(now + waitMs).toISOString()
    event(entry, 'restart-scheduled', { waitMs, severity: 'warning', adviceCode: 'WAIT_BACKOFF' })
    entry.timer = setTimeout(() => {
      entry.status.restarts++
      start(entry)
    }, waitMs)
  }
  function start(entry) {
    if (stopping) return
    entry.status.state = 'starting'
    entry.status.healthy = null
    entry.status.healthFailures = 0
    entry.started = Date.now()
    entry.probing = false
    entry.probeToken = null
    entry.restartBlocked = false
    delete entry.status.retryAt
    const sink = channel => createCappedLogSink(join(directory, `${entry.service.name}.${channel}.log`), {
      maxBytes: entry.service.logMaxBytes ?? 8388608, onCapacity() {
        event(entry, 'log-capacity', { category: 'storage', healthy: false, adviceCode: 'CHECK_LOGS' })
      } })
    const out = sink('stdout'), err = sink('stderr')
    const command = entry.service.command || process.execPath
    const controlled = entry.service.controlled !== false && command === process.execPath
    entry.controlToken = controlled ? randomUUID() : null
    const env = {
      ...(entry.service.env || process.env),
      ...(controlled
        ? {
            STUDIO_PROCESS_CONTROL_TOKEN: entry.controlToken,
            STUDIO_PROCESS_PARENT_NONCE: managerNonce
          }
        : {})
    }
    const child = spawn(
      command,
      controlled ? ['--import', preload, ...entry.service.args] : entry.service.args,
      {
        cwd: entry.service.cwd,
        env,
        stdio: controlled ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    entry.child = child
    let resolveClosed
    entry.closed = new Promise((done) => {
      resolveClosed = done
    })
    for (const [stream, source, channel] of [
      [out, child.stdout, 'stdout'],
      [err, child.stderr, 'stderr']
    ])
      stream.on('error', (error) => {
        source?.unpipe(stream)
        source?.resume()
        if (restartBlockedCodes.has(error.code)) entry.restartBlocked = true
        event(entry, 'log-error', {
          channel,
          code: error.code,
          category: 'storage',
          healthy: false,
          severity: 'error',
          adviceCode: 'CHECK_DISK'
        })
      })
    child.stdout?.pipe(out, { end: false })
    child.stderr?.pipe(err, { end: false })
    child.once('spawn', () => {
      entry.status.pid = child.pid
      entry.status.startedAt = new Date().toISOString()
      entry.status.state = 'running'
      entry.status.generation = randomUUID()
      event(entry, 'started', { pid: child.pid })
    })
    let spawnError
    child.once('error', (error) => {
      spawnError = error
      event(entry, 'process-error', {
        code: error.code || 'PROCESS_ERROR',
        severity: 'error',
        adviceCode: 'CHECK_LOCAL_CONFIGURATION'
      })
    })
    child.once('close', async (code, signal) => {
      await Promise.all(
        [out, err].map((stream) =>
          stream.destroyed ? Promise.resolve() : new Promise((done) => stream.end(done))
        )
      )
      entry.status.pid = null
      entry.status.exitCode = code
      entry.status.signal = signal
      entry.status.exitedAt = new Date().toISOString()
      entry.status.state = stopping ? 'stopped' : 'waiting-restart'
      event(entry, 'exited', {
        pid: child.pid ?? null,
        code,
        signal,
        healthy: false,
        intentional: stopping,
        ...(spawnError ? { error: spawnError.code || 'SPAWN_ERROR' } : {})
      })
      resolveClosed()
      scheduleRestart(entry, spawnError)
    })
  }
  async function check(entry) {
    const checker = entry.service.healthCheck || healthCheck
    const child = entry.child
    if (
      !checker ||
      stopping ||
      entry.probing ||
      entry.stopPromise ||
      entry.status.state !== 'running' ||
      !child?.pid ||
      Date.now() - entry.started < (entry.service.initialGraceMs ?? initialGraceMs)
    )
      return
    entry.probing = true
    const probeToken = Symbol('health-generation')
    entry.probeToken = probeToken
    const controller = new AbortController()
    let timer
    try {
      const timeout = new Promise((done) => {
        timer = setTimeout(() => {
          controller.abort()
          done({
            healthy: false,
            restartable: true,
            category: 'hang',
            adviceCode: 'LOCAL_HEALTH_TIMEOUT'
          })
        }, healthTimeoutMs)
      })
      let value = await Promise.race([
        Promise.resolve().then(() =>
          checker({ service: entry.service, child, signal: controller.signal })
        ),
        timeout
      ])
      if (stopping || entry.child !== child || child.exitCode !== null || child.signalCode !== null)
        return
      if (typeof value === 'boolean') value = { healthy: value }
      const healthy = value?.healthy === true
      const category = categories.has(value?.category) ? value.category : 'transport'
      const adviceCode = /^[A-Z0-9_]{1,64}$/.test(value?.adviceCode || '')
        ? value.adviceCode
        : healthy
          ? 'NONE'
          : 'CHECK_LOCAL_HEALTH'
      entry.status.healthy = healthy
      entry.status.checkedAt = new Date().toISOString()
      entry.status.category = category
      entry.status.adviceCode = adviceCode
      if (healthy) {
        entry.status.healthFailures = 0
        entry.restartBlocked = false
      } else if (
        value?.restartable === false ||
        [
          'database',
          'storage',
          'configuration',
          'config',
          'certificate',
          'external_network'
        ].includes(category)
      ) {
        entry.status.healthFailures = 0
        entry.restartBlocked = true
      } else entry.status.healthFailures++
      event(
        entry,
        healthy ? 'health-ok' : entry.restartBlocked ? 'health-blocked' : 'health-failed',
        {
          category,
          healthy,
          adviceCode,
          severity: healthy ? 'info' : entry.restartBlocked ? 'error' : 'warning',
          consecutiveFailures: entry.status.healthFailures
        }
      )
      if (!healthy && !entry.restartBlocked && entry.status.healthFailures >= failureThreshold)
        await stopEntry(entry, 'hang')
    } catch {
      if (!stopping && entry.child === child) {
        entry.status.healthy = false
        entry.status.healthFailures = 0
        entry.restartBlocked = true
        entry.status.category = 'config'
        entry.status.adviceCode = 'CHECK_CONFIG'
        event(entry, 'health-check-error', {
          category: 'config',
          healthy: false,
          severity: 'error',
          adviceCode: 'CHECK_CONFIG'
        })
      }
    } finally {
      clearTimeout(timer)
      if (entry.probeToken === probeToken) entry.probing = false
    }
  }
  entries.forEach(start)
  const heartbeat = setInterval(save, heartbeatMs)
  const healthTimer = setInterval(() => {
    for (const entry of entries) void check(entry)
  }, healthIntervalMs)
  save()
  return {
    snapshot: () => entries.map((entry) => ({ ...entry.status })),
    async checkNow() {
      await Promise.all(entries.map(check))
    },
    stop() {
      if (stopPromise) return stopPromise
      stopping = true
      clearInterval(heartbeat)
      clearInterval(healthTimer)
      for (const entry of entries) clearTimeout(entry.timer)
      stopPromise = Promise.all(entries.map((entry) => stopEntry(entry, 'process'))).then(() => {
        for (const entry of entries) entry.status.state = 'stopped'
        save()
      })
      return stopPromise
    }
  }
}
