import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { appendCappedEvent } from './studio-log-sink.mjs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { superviseServices } from './studio-process-supervisor.mjs'
import { privateOpsDirectory } from '../server/ops-config.mjs'
import {
  acquireProcessLock,
  readProcessOwner,
  requestProcessControl,
  portProbe,
  createSupervisorOpsObserver
} from './studio-service-control.mjs'

const script = fileURLToPath(import.meta.url),
  root = resolve(dirname(script), '..')
const valueOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

export async function guardianStatus({ directory = join(root, '.qa/local-service') } = {}) {
  const guardian = readProcessOwner(directory, 'guardian.json', root)
  const reply = await requestProcessControl(guardian, 'status')
  const manager = readProcessOwner(directory, 'manager.json', root)
  const managerReply = await requestProcessControl(manager, 'status')
  return {
    guardianAlive: Boolean(reply),
    guardianPid: reply?.pid ?? null,
    managerAlive: Boolean(managerReply),
    managerPid: managerReply?.pid ?? null,
    services: managerReply?.services || [],
    managerState: reply?.services || [],
    logs: directory
  }
}

export async function runGuardian({
  directory = join(root, '.qa/local-service'),
  guardianPort = 3010,
  managerPort = 3009,
  managerConfig,
  mode = 'built-local',
  managerScript = join(root, 'scripts/studio-local.mjs'),
  managerArguments,
  opsDirectory,
  opsEnvironment = 'local',
  options = {},
  opsEvents,
  onEvent = () => {}
} = {}) {
  if (managerPort > 0 && (await portProbe(managerPort)).listening)
    throw new Error(
      'Manager lock port is already occupied; no second guardian or manager is started'
    )
  mkdirSync(directory, { recursive: true })
  let supervisor,
    lock,
    stopped = false,
    stopPromise
  if (!['local', 'test', 'staging', 'production'].includes(opsEnvironment))
    throw new Error('Invalid operations environment')
  const configuredOpsDirectory = opsDirectory ? privateOpsDirectory(opsDirectory, root) : process.env.STUDIO_OPS_DIRECTORY
  const observer = await createSupervisorOpsObserver({
    opsEvents,
    opsDirectory: configuredOpsDirectory,
    environment: opsDirectory ? opsEnvironment : ['local', 'test', 'staging', 'production'].includes(
      process.env.STUDIO_OPS_ENVIRONMENT
    )
      ? process.env.STUDIO_OPS_ENVIRONMENT
      : 'local'
  })
  const stop = () => {
    if (stopPromise) return stopPromise
    stopped = true
    stopPromise = (async () => {
      await supervisor?.stop()
      await lock?.close()
      await observer.close()
    })()
    return stopPromise
  }
  try {
    lock = await acquireProcessLock({
      directory,
      fileName: 'guardian.json',
      root,
      port: guardianPort,
      kind: 'studio-guardian',
      onCommand: (command) => {
        if (command === 'stop') {
          setTimeout(() => {
            void stop()
          }, 25)
          return { stopping: true }
        }
        return { stopping: stopped, services: supervisor?.snapshot() || [] }
      }
    })
    const args = managerArguments || [
      '--run',
      '--directory',
      directory,
      '--manager-port',
      String(managerPort),
      '--mode',
      mode,
      ...(managerConfig ? ['--manager-config', resolve(managerConfig)] : [])
    ]
    const service = {
      name: 'manager',
      port: managerPort,
      cwd: root,
      controlled: false,
      noRestartExitCodes: [73, 74, 78],
      env: { ...process.env, STUDIO_GUARDIAN_OWNER_TOKEN: lock.record.nonce,
        ...(configuredOpsDirectory ? { STUDIO_OPS_DIRECTORY: configuredOpsDirectory,
          STUDIO_OPS_ENVIRONMENT: opsDirectory ? opsEnvironment : process.env.STUDIO_OPS_ENVIRONMENT || 'local' } : {}) },
      async gracefulStop() {
        const owner = readProcessOwner(directory, 'manager.json', root)
        if (owner) await requestProcessControl(owner, 'stop')
      },
      async healthCheck() {
        const owner = readProcessOwner(directory, 'manager.json', root)
        const reply = await requestProcessControl(owner, 'ping', options.healthTimeoutMs || 1500)
        return {
          healthy: Boolean(reply),
          restartable: true,
          category: 'hang',
          adviceCode: reply ? 'NONE' : 'LOCAL_MANAGER_UNRESPONSIVE'
        }
      }
    }
    if (process.platform === 'win32') {
      service.command = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
        : 'powershell.exe'
      service.args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(root, 'scripts/studio-service-windows.ps1'),
        '-Action',
        'RunJob',
        '-NodePath',
        process.execPath,
        '-RuntimeDirectory',
        directory,
        '-ManagerScript',
        managerScript,
        '-ManagerArgumentsBase64',
        Buffer.from(JSON.stringify(args)).toString('base64'),
        '-ParentPid',
        String(process.pid),
        '-GuardianPort',
        String(lock.record.port),
        '-ManagerPort',
        String(managerPort)
      ]
    } else {
      // IPC parent-disconnect shutdown is safe; no PID-based orphan adoption is attempted.
      service.command = process.execPath
      service.args = [managerScript, ...args]
      service.controlled = true
    }
    supervisor = superviseServices({
      services: [service],
      directory: join(directory, 'guardian-manager'),
      initialGraceMs: 30000,
      healthIntervalMs: 5000,
      failureThreshold: 3,
      retryDelayMs: 1500,
      maxRetryDelayMs: 30000,
      cooldownMs: 5000,
      restartWindowMs: 120000,
      maxRestarts: 5,
      ...options,
      managerNonce: lock.record.nonce,
      onEvent: (item) => {
        observer.observe({ ...item, service: 'supervisor' })
        try {
          if (!appendCappedEvent(join(directory, 'guardian.events.jsonl'), item))
            observer.observe({ type: 'log-error', category: 'storage', service: 'supervisor' })
        } catch {}
        onEvent(item)
      }
    })
    return { supervisor, lock, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

export async function backgroundGuardian({
  directory = join(root, '.qa/local-service'),
  guardianPort = 3010,
  managerPort = 3009,
  managerConfig
} = {}) {
  const current = await guardianStatus({ directory })
  if (current.guardianAlive) {
    if (
      !current.managerAlive ||
      !current.services.length ||
      current.services.some((service) => service.healthy !== true)
    )
      throw new Error(
        'Guardian exists but services are not ready; inspect logs without starting another manager'
      )
    console.log(JSON.stringify({ ...current, ready: true }))
    return current
  }
  // A foreign manager/port is never killed. The manager will refuse occupied service ports too.
  const existingManager = readProcessOwner(directory, 'manager.json', root)
  if (await requestProcessControl(existingManager))
    throw new Error('An independent manager exists; no second guardian is started')
  if (managerPort > 0 && (await portProbe(managerPort)).listening)
    throw new Error(
      'Existing manager lock port is occupied; no existing service is adopted or stopped'
    )
  mkdirSync(directory, { recursive: true })
  const out = openSync(join(directory, 'guardian.stdout.log'), 'a', 0o600),
    err = openSync(join(directory, 'guardian.stderr.log'), 'a', 0o600)
  try {
    const child = spawn(
      process.execPath,
      [
        script,
        '--run',
        '--directory',
        directory,
        '--guardian-port',
        String(guardianPort),
        '--manager-port',
        String(managerPort),
        ...(managerConfig ? ['--manager-config', resolve(managerConfig)] : [])
      ],
      { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, err] }
    )
    await new Promise((done, reject) => {
      child.once('spawn', done)
      child.once('error', reject)
    })
    child.unref()
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Guardian exited; startup was not claimed successful')
      const active = await guardianStatus({ directory })
      if (
        active.guardianAlive &&
        active.managerAlive &&
        active.services.length &&
        active.services.every((service) => service.healthy === true)
      ) {
        console.log(JSON.stringify({ ...active, ready: true }))
        return active
      }
      if (active.managerState.some((service) => service.state === 'failed'))
        throw new Error('Manager startup is blocked; inspect guardian logs')
      await wait(250)
    }
    throw new Error('Guardian readiness timed out; no success or version verification is claimed')
  } finally {
    closeSync(out)
    closeSync(err)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const directory = resolve(valueOf('--directory', join(root, '.qa/local-service')))
  try {
    if (process.argv.includes('--run')) {
      const guardian = await runGuardian({
        directory,
        guardianPort: Number(valueOf('--guardian-port', 3010)),
        managerPort: Number(valueOf('--manager-port', 3009)),
        managerConfig: valueOf('--manager-config'),
        opsDirectory: valueOf('--ops-directory'),
        opsEnvironment: valueOf('--ops-environment', 'local'),
        mode: valueOf('--mode', 'built-local')
      })
      const stop = async () => {
        await guardian.stop()
        process.exit(0)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    } else if (process.argv.includes('--stop')) {
      if (
        !(await requestProcessControl(readProcessOwner(directory, 'guardian.json', root), 'stop'))
      )
        throw new Error('No authenticated guardian exists; no PID or unknown port was stopped')
    } else if (process.argv.includes('--status'))
      console.log(JSON.stringify(await guardianStatus({ directory }), null, 2))
    else
      await backgroundGuardian({
        directory,
        guardianPort: Number(valueOf('--guardian-port', 3010)),
        managerPort: Number(valueOf('--manager-port', 3009)),
        managerConfig: valueOf('--manager-config')
      })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 78
  }
}
