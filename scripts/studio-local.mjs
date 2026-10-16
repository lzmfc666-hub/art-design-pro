import { request } from 'node:http'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { superviseServices } from './studio-process-supervisor.mjs'
import { appendCappedEvent } from './studio-log-sink.mjs'
import { loadOpsConfig, normalizeOpsConfig, privateOpsDirectory } from '../server/ops-config.mjs'
import { readLocalMonitorBinding } from '../server/local-monitor-binding.mjs'
import {
  acquireProcessLock,
  readProcessOwner,
  requestProcessControl,
  portProbe,
  apiHealthCheck,
  createSupervisorOpsObserver
} from './studio-service-control.mjs'

const script = fileURLToPath(import.meta.url)
export const root = resolve(dirname(script), '..')
const valueOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
export { portProbe }
const numberOption = (name, fallback, min = 1) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < min) throw new Error(`Invalid timing option ${name}`)
  return value
}
export const supervisorOptions = () => ({
  initialGraceMs: numberOption('STUDIO_HEALTH_GRACE_MS', 30000, 0),
  healthIntervalMs: numberOption('STUDIO_HEALTH_INTERVAL_MS', 5000),
  healthTimeoutMs: numberOption('STUDIO_HEALTH_TIMEOUT_MS', 2000),
  failureThreshold: numberOption('STUDIO_HEALTH_FAILURE_THRESHOLD', 3),
  stopGraceMs: numberOption('STUDIO_STOP_GRACE_MS', 5000, 0),
  retryDelayMs: numberOption('STUDIO_RESTART_DELAY_MS', 1500),
  maxRetryDelayMs: numberOption('STUDIO_RESTART_MAX_DELAY_MS', 30000),
  cooldownMs: numberOption('STUDIO_RESTART_COOLDOWN_MS', 5000, 0),
  maxRestarts: numberOption('STUDIO_RESTART_LIMIT', 5, 0),
  restartWindowMs: numberOption('STUDIO_RESTART_WINDOW_MS', 60000)
})
export function htmlHealthCheck(port) {
  return ({ signal }) =>
    new Promise((done) => {
      let ended = false
      const finish = (value) => {
        if (ended) return
        ended = true
        signal?.removeEventListener('abort', abort)
        req.destroy()
        done(value)
      }
      const req = request(
        { host: '127.0.0.1', port, path: '/', method: 'GET', agent: false },
        (res) => {
          res.resume()
          const healthy =
            res.statusCode === 200 && String(res.headers['content-type']).includes('text/html')
          res.once('end', () =>
            finish({
              healthy,
              category: healthy ? 'process' : 'config',
              restartable: false,
              adviceCode: healthy ? 'NONE' : 'CHECK_CONFIG'
            })
          )
          res.once('error', () =>
            finish({
              healthy: false,
              category: 'transport',
              restartable: true,
              adviceCode: 'LOCAL_HEALTH_INTERRUPTED'
            })
          )
        }
      )
      const abort = () =>
        finish({
          healthy: false,
          category: 'hang',
          restartable: true,
          adviceCode: 'LOCAL_HEALTH_TIMEOUT'
        })
      signal?.addEventListener('abort', abort, { once: true })
      req.setTimeout(1500, abort)
      req.once('error', () =>
        finish({
          healthy: false,
          category: 'transport',
          restartable: true,
          adviceCode: 'LOCAL_HEALTH_CONNECTION_FAILED'
        })
      )
      if (signal?.aborted) abort()
      else req.end()
    })
}
export function localMonitorService({
  directory = join(root, '.qa/local-service'),
  projectRoot = root,
  database = join(projectRoot, '.data/studio.sqlite'),
  apiPort = 3007,
  adminPort = 3006,
  playerPort = 3008,
  env = process.env,
  clock = Date.now
} = {}) {
  const configPath = join(projectRoot, '.ops/local-monitor.json')
  if (!existsSync(configPath)) return null
  const invalid = () => new Error('LOCAL_MONITOR_SUPERVISION_CONFIG_INVALID')
  let config
  let backupEnvironment
  try {
    const file = lstatSync(configPath)
    if (!file.isFile() || file.isSymbolicLink()) throw invalid()
    config = normalizeOpsConfig(loadOpsConfig(configPath), { root: projectRoot })
    const apiOrigin = `http://127.0.0.1:${apiPort}`
    const endpoints = {
      admin: `http://127.0.0.1:${adminPort}/`,
      player: `http://127.0.0.1:${playerPort}/`,
      live: `${apiOrigin}/api/studio/health/live`,
      ready: `${apiOrigin}/api/studio/health/ready`,
      summary: `${apiOrigin}/api/studio/ops/summary`
    }
    if (config.environment !== 'local' || config.mode !== 'internal' ||
      config.localBinding !== true || config.credentialEnv !== 'STUDIO_MONITOR_TOKEN' ||
      config.alerts.authorized ||
      Object.entries(endpoints).some(([key, value]) => config.endpoints[key] !== value) ||
      (config.endpoints.diagnostics && config.endpoints.diagnostics !== `${apiOrigin}/api/studio/ops/diagnostics-summary`) ||
      realpathSync(resolve(config.root, config.storage.dbPath)) !== realpathSync(database) ||
      resolve(config.root, config.supervisor?.stateDirectory || '.qa/local-service') !== resolve(directory) ||
      (env.STUDIO_OPS_DIRECTORY && resolve(env.STUDIO_OPS_DIRECTORY) !== config.storage.opsDir) ||
      [apiPort, adminPort, playerPort].includes(config.monitorLockPort)) throw invalid()
    const binding = readLocalMonitorBinding({ root: projectRoot, host: '127.0.0.1', port: apiPort,
      dbPath: database, required: true })
    if (env.STUDIO_MONITOR_TOKEN && env.STUDIO_MONITOR_TOKEN !== binding.token) throw invalid()
    backupEnvironment = { STUDIO_BACKUP_INTERVAL_MINUTES: '0',
      STUDIO_BACKUP_FAILURE_WEBHOOK: '', STUDIO_BACKUP_REPLICATION_CONFIG: '' }
    if (config.backups?.enabled === true) {
      const { intervalMinutes, retentionCount, directory: backupDirectory } = config.backups
      if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 35791 ||
        !Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 90 ||
        typeof backupDirectory !== 'string' || !backupDirectory ||
        config.backups.replication?.enabled === true) throw invalid()
      backupEnvironment = { ...backupEnvironment,
        STUDIO_BACKUP_INTERVAL_MINUTES: String(intervalMinutes),
        STUDIO_BACKUP_RETENTION_COUNT: String(retentionCount),
        STUDIO_BACKUP_DIR: privateOpsDirectory(backupDirectory, projectRoot) }
    }
  } catch { throw invalid() }
  const ownedMonitor = child => {
    const owner = readProcessOwner(config.storage.opsDir, 'monitor-owner.json', projectRoot)
    return owner?.kind === 'studio-monitor' && owner.pid === child?.pid &&
      owner.port === config.monitorLockPort ? owner : null
  }
  const firstCheckAt = new WeakMap()
  return {
    opsDirectory: config.storage.opsDir,
    backupEnvironment,
    service: {
      name: 'monitor', port: config.monitorLockPort, cwd: resolve(projectRoot), env,
      // Its authenticated control socket supplies graceful shutdown. Avoid keeping
      // an extra IPC channel alive after that socket and its timers have closed.
      controlled: false,
      args: [join(root, 'scripts/studio-monitor.mjs'), '--config', configPath],
      async healthCheck({ child }) {
        const now = clock()
        if (!firstCheckAt.has(child)) firstCheckAt.set(child, now)
        const owner = ownedMonitor(child)
        const reply = owner && await requestProcessControl(owner, 'status')
        const observedAt = Date.parse(reply?.lastRun?.observedAt)
        const samplingWindow = config.intervalMs * 3 + config.timeoutMs * 6
        const fresh = reply?.lastRun ? (Number.isFinite(observedAt) &&
          now - observedAt < Math.max(15000, samplingWindow)) :
          now - firstCheckAt.get(child) < Math.max(config.startupGraceMs, samplingWindow)
        const healthy = Boolean(reply && reply.pid === child.pid && reply.kind === 'studio-monitor' && fresh)
        return { healthy, restartable: true, category: 'hang',
          adviceCode: healthy ? 'NONE' : 'LOCAL_MONITOR_UNRESPONSIVE' }
      },
      async gracefulStop({ child }) {
        const owner = ownedMonitor(child)
        if (owner) await requestProcessControl(owner, 'stop')
      }
    }
  }
}

export function servicesConfiguration({ directory, mode = 'built-local', managerConfig } = {}) {
  if (managerConfig) {
    const config = JSON.parse(readFileSync(resolve(managerConfig), 'utf8'))
    if (
      config.purpose !== 'isolated-test' ||
      !Array.isArray(config.services) ||
      config.services.length < 1 ||
      config.services.length > 10
    )
      throw new Error(
        'Custom service configuration is restricted to explicit isolated-test fixtures'
      )
    return {
      services: config.services.map((service) => ({
        ...service,
        env: { ...(service.env || {}) },
        command: process.execPath,
        healthCheck:
          service.health === 'html'
            ? htmlHealthCheck(service.port)
            : apiHealthCheck({ port: service.port })
      })),
      configuration: config,
      testFixture: true
    }
  }
  const database = resolve(process.env.STUDIO_DB_PATH || join(root, '.data', 'studio.sqlite'))
  const required = [
    database,
    ...(mode === 'built-local'
      ? [join(root, 'dist/index.html'), join(root, 'player-client/dist/index.html')]
      : [])
  ]
  if (required.some((path) => !existsSync(path)))
    throw new Error(
      'Existing business database or build missing; no empty database or data replacement is created'
    )
  const env = {
    ...process.env,
    STUDIO_HOST: '127.0.0.1',
    STUDIO_PORT: '3007',
    STUDIO_DB_PATH: database,
    STUDIO_PLAYER_HOST: '127.0.0.1',
    STUDIO_PLAYER_PORT: '3008',
    STUDIO_API_TARGET: 'http://127.0.0.1:3007',
    VITE_API_PROXY_URL: 'http://127.0.0.1:3007',
    STUDIO_QA_DECLARATIONS_DIR: join(directory, 'generated-types')
  }
  const development = mode === 'development'
  const monitoring = localMonitorService({ directory, database, env })
  return {
    testFixture: false,
    opsDirectory: monitoring?.opsDirectory,
    services: [
      {
        name: 'api',
        port: 3007,
        cwd: root,
        env: monitoring ? { ...env, ...monitoring.backupEnvironment } : env,
        args: development ? ['--watch', 'server/index.mjs'] : ['server/index.mjs'],
        healthCheck: apiHealthCheck({ port: 3007 })
      },
      {
        name: 'admin',
        port: 3006,
        cwd: root,
        env,
        args: [
          'node_modules/vite/bin/vite.js',
          ...(development ? [] : ['preview', '--mode', 'development']),
          '--host',
          '127.0.0.1',
          '--port',
          '3006',
          '--strictPort'
        ],
        healthCheck: htmlHealthCheck(3006)
      },
      {
        name: 'player',
        port: 3008,
        cwd: development ? join(root, 'player-client') : root,
        env,
        args: development
          ? [
              join(root, 'node_modules/vite/bin/vite.js'),
              '--host',
              '127.0.0.1',
              '--port',
              '3008',
              '--strictPort'
            ]
          : ['scripts/player-client-server.mjs'],
        healthCheck: htmlHealthCheck(3008)
      },
      ...(monitoring ? [monitoring.service] : [])
    ]
  }
}
export async function localStatus({
  directory = join(root, '.qa/local-service'),
  managerPort = 3009
} = {}) {
  const owner = readProcessOwner(directory, 'manager.json', root)
  const reply = await requestProcessControl(owner, 'status')
  let stored
  try {
    stored = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8'))
  } catch {}
  const ports = stored?.services?.map((service) => service.port).filter(Number.isInteger) || [
    3006, 3007, 3008
  ]
  return {
    managerAlive: Boolean(reply),
    managerPid: reply?.pid ?? null,
    managerPort: owner?.port || managerPort,
    services: reply?.services || [],
    statusSource: reply ? 'live-authenticated' : 'unverified',
    lastRecordedServices: reply ? [] : stored?.services || [],
    lastRecordedAt: stored?.updatedAt || null,
    ports: await Promise.all(ports.map(portProbe)),
    versionVerified: false,
    logs: directory
  }
}
export async function runLocalManager({
  directory = join(root, '.qa/local-service'),
  managerPort = 3009,
  managerConfig,
  mode = 'built-local',
  opsEvents,
  onEvent
} = {}) {
  let supervisor,
    lock,
    closing = false,
    closedPromise
  const observer = await createSupervisorOpsObserver({
    opsEvents,
    opsDirectory: process.env.STUDIO_OPS_DIRECTORY,
    environment: ['local', 'test', 'staging', 'production'].includes(
      process.env.STUDIO_OPS_ENVIRONMENT
    )
      ? process.env.STUDIO_OPS_ENVIRONMENT
      : 'local'
  })
  const shutdown = () => {
    if (closedPromise) return closedPromise
    closing = true
    closedPromise = (async () => {
      await supervisor?.stop()
      await lock?.close()
      await observer.close()
    })()
    return closedPromise
  }
  try {
    lock = await acquireProcessLock({
      directory,
      fileName: 'manager.json',
      root,
      port: managerPort,
      kind: 'studio-local-manager',
      onCommand: (command) => {
        if (command === 'stop') {
          setTimeout(() => {
            void shutdown()
          }, 25)
          return { stopping: true }
        }
        return { services: supervisor?.snapshot() || [], stopping: closing }
      }
    })
    const setup = servicesConfiguration({ directory, mode, managerConfig })
    const occupied = (
      await Promise.all(setup.services.map((service) => portProbe(service.port)))
    ).filter((port) => port.listening)
    if (occupied.length) {
      const error = new Error('Service port is occupied; no existing process is adopted or stopped')
      error.exitCode = 73
      throw error
    }
    supervisor = superviseServices({
      directory,
      managerNonce: lock.record.nonce,
      services: setup.services,
      ...supervisorOptions(),
      ...(setup.configuration?.supervisor || {}),
      onEvent: (item) => {
        observer.observe(item)
        if (onEvent) onEvent(item)
        else if (!appendCappedEvent(join(directory, 'manager.events.jsonl'), item))
          observer.observe({ type: 'log-error', category: 'storage', service: 'supervisor' })
      }
    })
    return { supervisor, lock, stop: shutdown }
  } catch (error) {
    await shutdown()
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const directory = resolve(valueOf('--directory', join(root, '.qa/local-service')))
  const managerPort = Number(valueOf('--manager-port', 3009)),
    managerConfig = valueOf('--manager-config')
  try {
    if (process.argv.includes('--run')) {
      const manager = await runLocalManager({
        directory,
        managerPort,
        managerConfig,
        mode: valueOf('--mode', 'built-local')
      })
      const shutdown = async () => {
        await manager.stop()
        process.exit(0)
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    } else if (process.argv.includes('--status'))
      console.log(JSON.stringify(await localStatus({ directory, managerPort }), null, 2))
    else if (process.argv.includes('--stop')) {
      const owner = readProcessOwner(directory, 'manager.json', root)
      if (!(await requestProcessControl(owner, 'stop')))
        throw new Error('No authenticated owned manager exists; no PID was stopped')
    } else {
      const { backgroundGuardian } = await import('./studio-guardian.mjs')
      await backgroundGuardian({ directory, managerPort, managerConfig })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = error.exitCode || 78
  }
}
