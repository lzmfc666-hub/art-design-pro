import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { acquireProcessLock, readProcessOwner, requestProcessControl } from './studio-service-control.mjs'
import { loadOpsConfig } from '../server/ops-config.mjs'
import { createOpsEvents } from '../server/ops-events.mjs'
import { createOpsWebhookSender } from '../server/ops-delivery.mjs'
import { createOpsMonitor } from '../server/ops-monitor.mjs'
import { readLocalMonitorBinding } from '../server/local-monitor-binding.mjs'

const script = fileURLToPath(import.meta.url)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export function createConfiguredMonitor(config, { allowRealDelivery = false } = {}) {
  let localBinding
  if (config.localBinding === true) {
    if (config.environment !== 'local' || config.mode !== 'internal' ||
        config.credentialEnv !== 'STUDIO_MONITOR_TOKEN' || !config.endpoints.summary)
      throw new Error('LOCAL_MONITOR_BINDING_INVALID')
    const endpoint = new URL(config.endpoints.summary)
    if (endpoint.protocol !== 'http:' || endpoint.pathname !== '/api/studio/ops/summary' ||
        ['live', 'ready'].some(key => !config.endpoints[key] ||
          new URL(config.endpoints[key]).origin !== endpoint.origin))
      throw new Error('LOCAL_MONITOR_BINDING_INVALID')
    localBinding = readLocalMonitorBinding({ root: config.root, host: endpoint.hostname,
      port: Number(endpoint.port || 80), dbPath: resolve(config.root, config.storage.dbPath), required: true })
    if (process.env.STUDIO_MONITOR_TOKEN && process.env.STUDIO_MONITOR_TOKEN !== localBinding.token)
      throw new Error('LOCAL_MONITOR_BINDING_INVALID')
  }
  const sender = allowRealDelivery && config.alerts.authorized
    ? createOpsWebhookSender({ resolveTarget: () => process.env[config.alerts.targetEnv] }) : undefined
  const events = createOpsEvents({ dbPath: join(config.storage.opsDir, 'events.sqlite'),
    environment: config.environment, sender })
  const hostSample = () => {
    if (config.mode !== 'internal') return null
    const directory = resolve(config.root, config.supervisor?.stateDirectory || '.qa/local-service')
    let status
    try { status = JSON.parse(readFileSync(join(directory, 'status.json'))) } catch { return { managerHealthy: null, logCapacityHealthy: null } }
    let logBytes = 0, largestLogBytes = 0, files = 0
    const visit = (parent, depth = 0) => {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const path = join(parent, entry.name)
        if (entry.isDirectory() && depth < 2) visit(path, depth + 1)
        else if (entry.isFile() && /\.(log|jsonl)$/.test(entry.name) && ++files <= 512) {
          const bytes = statSync(path).size; logBytes += bytes; largestLogBytes = Math.max(largestLogBytes, bytes)
        }
      }
    }
    visit(directory)
    return { managerHealthy: Date.now() - Date.parse(status.updatedAt) < 15000,
      restartBudgetExhausted: existsSync(join(directory, 'guardian-recovery-blocked.json')) ||
        status.services.some(row => row.state === 'failed' || row.state === 'restart-limit'),
      restartCount: status.services.reduce((sum, row) => sum + (row.restarts || 0), 0), logBytes,
      logCapacityHealthy: files > 512 ? null : largestLogBytes < 8388608 * .9 }
  }
  const monitor = createOpsMonitor({ config, events, hostSample,
    secretReader: name => localBinding && name === config.credentialEnv ? localBinding.token : process.env[name],
    statePath: join(config.storage.opsDir, 'monitor-state.json') })
  return { monitor, events, async close() { await monitor.close(); await events.close() } }
}
if (process.argv[1] && resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2), position = args.indexOf('--config')
  if (position < 0 || !args[position + 1]) throw new Error('用法：node scripts/studio-monitor.mjs --config 配置文件 [--once|--status] [--enable-authorized-delivery]')
  const remaining = args.filter((_, index) => index !== position && index !== position + 1)
  if (remaining.some(value => !['--once', '--status', '--stop', '--enable-authorized-delivery'].includes(value)) ||
      remaining.filter(value => ['--once', '--status', '--stop'].includes(value)).length > 1) throw new Error('OPS_ARGUMENTS_INVALID')
  const config = loadOpsConfig(resolve(args[position + 1]))
  if (args.includes('--status') || args.includes('--stop')) {
    const owner = readProcessOwner(config.storage.opsDir, 'monitor-owner.json', config.root)
    const reply = owner?.kind === 'studio-monitor' ? await requestProcessControl(owner, args.includes('--stop') ? 'stop' : 'status') : null
    let state
    try { state = JSON.parse(readFileSync(join(config.storage.opsDir, 'monitor-state.json'))) } catch {}
    const last = reply?.lastRun || state?.lastRun
    const safeLast = last && Number.isFinite(Date.parse(last.observedAt)) ? {
      observedAt: new Date(last.observedAt).toISOString(), maintenance: last.maintenance === true,
      summaryAvailable: last.summaryAvailable === true } : null
    console.log(JSON.stringify({ configured: true, mode: config.mode, environment: config.environment,
      enabled: Boolean(reply), stopRequested: args.includes('--stop') && Boolean(reply?.stopping),
      sampled: Boolean(safeLast), lastRun: safeLast, independentExternalHostVerified: false,
      note: 'A local authenticated process check does not prove an independent external host or production activation.' }, null, 2))
  } else {
    if (['admin', 'player', 'live', 'ready'].some(key => !config.endpoints[key]) ||
      (config.environment === 'production' && (!config.expectedRelease || !config.pageFingerprints.admin || !config.pageFingerprints.player)))
      throw new Error('OPS_MONITOR_TARGETS_INCOMPLETE')
    const once = args.includes('--once')
    let instance, stopPromise
    const close = () => stopPromise ||= (async () => { await instance?.close(); await lock.close() })()
    const lock = await acquireProcessLock({ directory: config.storage.opsDir, fileName: 'monitor-owner.json',
      root: config.root, port: config.monitorLockPort, kind: 'studio-monitor', onCommand(command) {
        if (command === 'stop') { setTimeout(() => void close(), 25); return { stopping: true } }
        return { mode: config.mode, environment: config.environment, lastRun: instance?.monitor.snapshot().lastRun || null }
      } })
    try { instance = createConfiguredMonitor(config, { allowRealDelivery: args.includes('--enable-authorized-delivery') }) }
    catch (error) { await lock.close(); throw error }
    if (once) {
      try { const result = await instance.monitor.cycle(); console.log(JSON.stringify(result)); if (result.errorCode) process.exitCode = 1 }
      finally { await close() }
    } else {
      instance.monitor.start()
      console.log(JSON.stringify({ enabled: true, scope: config.mode, environment: config.environment,
        intervalMs: config.intervalMs, realDeliveryEnabled: args.includes('--enable-authorized-delivery') && config.alerts.authorized,
        externalHostVerified: false }))
      process.once('SIGINT', close); process.once('SIGTERM', close)
    }
  }
}
