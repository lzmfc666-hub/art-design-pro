import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { runGuardian, guardianStatus } from '../scripts/studio-guardian.mjs'
import { readProcessOwner, requestProcessControl } from '../scripts/studio-service-control.mjs'
import { portProbe } from '../scripts/studio-local.mjs'

const root = resolve('.'),
  pause = (ms) => new Promise((done) => setTimeout(done, ms))
const windows = process.platform === 'win32'
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(40)
  }
  assert.fail(message)
}
async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen({ host: '127.0.0.1', port: 0 }, done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}
const cleanEnvironment = () =>
  Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  )

test('已有未知管理锁端口时拒绝新guardian，既不写归属也不停止已有监听者', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-guardian-test-'))
  const existing = createServer()
  await new Promise((done) => existing.listen({ host: '127.0.0.1', port: 0 }, done))
  const port = existing.address().port
  t.after(async () => {
    await new Promise((done) => existing.close(done))
    rmSync(directory, { recursive: true, force: true })
  })
  await assert.rejects(
    runGuardian({ directory, guardianPort: 0, managerPort: port }),
    /already occupied/
  )
  assert.equal(existsSync(join(directory, 'guardian.json')), false)
  assert.equal((await portProbe(port)).listening, true)
})
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-guardian-test-'))
  const runtime = join(directory, 'runtime'),
    config = join(directory, 'config.json'),
    dummy = join(directory, 'dummy.mjs'),
    manager = join(directory, 'manager.mjs')
  mkdirSync(runtime)
  writeFileSync(
    dummy,
    `
import { createServer } from 'node:http';import { appendFileSync,existsSync,readFileSync,writeFileSync } from 'node:fs';
const [directory,name,port]=process.argv.slice(2);const file=directory+'/'+name+'.attempts';const attempt=Number(existsSync(file)?readFileSync(file,'utf8'):0)+1;writeFileSync(file,String(attempt));
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({pid:process.pid,status:req.url.endsWith('/ready')?'ready':'ok',service:'studio-api',release:null,checks:{database:true}}));});server.listen(Number(port),'127.0.0.1');
setInterval(()=>{appendFileSync(directory+'/'+name+'.ticks','x');if(attempt===1&&existsSync(directory+'/'+name+'.hang'))while(true){}},10);
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`
  )
  writeFileSync(
    manager,
    `
import { runLocalManager } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/studio-local.mjs')).href)};
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
const directory=${JSON.stringify(runtime)},config=${JSON.stringify(config)};
const file=${JSON.stringify(join(directory, 'manager.attempts'))};const attempt=Number(existsSync(file)?readFileSync(file,'utf8'):0)+1;writeFileSync(file,String(attempt));
const manager=await runLocalManager({directory,managerPort:0,managerConfig:config,opsEvents:{observe(){}}});
const timer=setInterval(()=>{if(attempt===1&&existsSync(${JSON.stringify(join(directory, 'manager.crash'))}))process.exit(9);if(attempt===1&&existsSync(${JSON.stringify(join(directory, 'manager.hang'))}))while(true){}},20);
timer.unref();
const stop=async()=>{clearInterval(timer);await manager.stop();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop);
`
  )
  let guardian
  t.after(async () => {
    await guardian?.stop()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'studio-guardian-test-'))
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    runtime,
    config,
    dummy,
    manager,
    async setup() {
      const port = await freePort()
      writeFileSync(
        config,
        JSON.stringify({
          purpose: 'isolated-test',
          services: [
            {
              name: 'dummy',
              port,
              cwd: directory,
              env: {},
              args: [dummy, directory, 'dummy', String(port)]
            }
          ],
          supervisor: {
            initialGraceMs: 50,
            healthIntervalMs: 40,
            healthTimeoutMs: 100,
            stopGraceMs: 50,
            retryDelayMs: 30,
            cooldownMs: 30,
            maxRestarts: 2
          }
        })
      )
      return port
    },
    async start(options = {}) {
      guardian = await runGuardian({
        directory: runtime,
        guardianPort: 0,
        managerPort: 0,
        managerScript: manager,
        opsEvents: { observe() {} },
        options: {
          initialGraceMs: 2000,
          healthIntervalMs: 100,
          healthTimeoutMs: 200,
          stopGraceMs: 100,
          cooldownMs: 50,
          retryDelayMs: 50,
          maxRetryDelayMs: 100,
          ...options
        }
      })
      return guardian
    },
    status: () => guardianStatus({ directory: runtime })
  }
}

test(
  'Windows原生Job：manager异常退出时先原子回收仍活着的自有子进程再恢复，不接管未知PID',
  { skip: !windows },
  async (t) => {
    const f = fixture(t)
    await f.setup()
    const guardian = await f.start()
    await until(
      async () => (await f.status()).services[0]?.healthy === true,
      'owned manager/dummy never became ready'
    )
    const before = await f.status(),
      oldOwner = readProcessOwner(f.runtime, 'manager.json', root)
    writeFileSync(join(f.directory, 'dummy.hang'), 'hang actual contained child')
    writeFileSync(join(f.directory, 'manager.crash'), 'crash the manager while its child is alive')
    await until(async () => {
      const state = await f.status()
      return (
        state.managerAlive &&
        state.managerPid !== before.managerPid &&
        state.services[0]?.healthy === true
      )
    }, 'guardian did not recover the own manager family')
    const after = await f.status()
    assert.notEqual(after.services[0].pid, before.services[0].pid)
    assert.equal(await requestProcessControl(oldOwner, 'stop'), null)
    assert.equal(guardian.supervisor.snapshot()[0].restarts, 1)
    const log = readFileSync(join(f.runtime, 'guardian-manager/manager.stdout.log'), 'utf8')
    assert.match(log, /job-owned/)
    assert.match(log, /guardianStartIdentity/)
  }
)

test(
  'Windows原生Job：manager事件环持续hang，guardian正常停止超时后关闭自己Job host并恢复',
  { skip: !windows },
  async (t) => {
    const f = fixture(t)
    await f.setup()
    const guardian = await f.start({ initialGraceMs: 800 })
    await until(
      async () => (await f.status()).services[0]?.healthy === true,
      'owned manager was not ready'
    )
    const before = await f.status()
    writeFileSync(join(f.directory, 'manager.hang'), 'hang manager first attempt')
    await until(
      async () => {
        const state = await f.status()
        return (
          state.managerAlive &&
          state.managerPid !== before.managerPid &&
          state.services[0]?.healthy === true
        )
      },
      'hung manager was not recovered',
      15000
    )
    assert.equal(guardian.supervisor.snapshot()[0].restarts, 1)
    assert.match(readFileSync(join(f.runtime, 'guardian.events.jsonl'), 'utf8'), /forced-stop/)
  }
)

function runPowerShell(args, env = cleanEnvironment()) {
  return new Promise((done, reject) => {
    const child = spawn(
      join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(root, 'scripts/studio-service-windows.ps1'),
        ...args
      ],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}
test(
  'Windows临时TaskScheduler：安装启动触发、按需运行和宿主有限恢复guardian，最后卸载自有任务',
  { skip: !windows || process.env.STUDIO_QA_WINDOWS_TASKS !== '1', timeout: 180000 },
  async (t) => {
    const directory = resolve(
      process.env.STUDIO_QA_ROOT || '.qa/ops-autorecovery-20261015',
      `windows-task-${randomUUID()}`
    )
    mkdirSync(directory, { recursive: true })
    const runtime = join(directory, 'runtime'),
      fixtureManager = join(directory, 'manager.mjs'),
      fixtureGuardian = join(directory, 'guardian.mjs'),
      config = join(directory, 'config.json'),
      dummy = join(directory, 'dummy.mjs')
    mkdirSync(runtime)
    const port = await freePort(),
      taskName = `Studio-QA-${randomUUID()}`
    writeFileSync(
      dummy,
      `import{createServer}from'node:http';const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({pid:process.pid,status:req.url.endsWith('/ready')?'ready':'ok',service:'studio-api',release:null,checks:{database:true}}));});server.listen(${port},'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`
    )
    writeFileSync(
      config,
      JSON.stringify({
        purpose: 'isolated-test',
        services: [{ name: 'dummy', port, cwd: directory, env: {}, args: [dummy] }],
        supervisor: {
          initialGraceMs: 50,
          healthIntervalMs: 50,
          healthTimeoutMs: 200,
          stopGraceMs: 100,
          cooldownMs: 50
        }
      })
    )
    writeFileSync(
      fixtureManager,
      `import{runLocalManager}from${JSON.stringify(pathToFileURL(join(root, 'scripts/studio-local.mjs')).href)};const mgr=await runLocalManager({directory:${JSON.stringify(runtime)},managerPort:0,managerConfig:${JSON.stringify(config)},opsEvents:{observe(){}}});process.on('SIGTERM',async()=>{await mgr.stop();process.exit(0)});`
    )
    writeFileSync(
      fixtureGuardian,
      `import{runGuardian}from${JSON.stringify(pathToFileURL(join(root, 'scripts/studio-guardian.mjs')).href)};import{existsSync,readFileSync,writeFileSync}from'node:fs';const file=${JSON.stringify(join(directory, 'guardian.attempts'))};const attempt=Number(existsSync(file)?readFileSync(file,'utf8'):0)+1;writeFileSync(file,String(attempt));const guard=await runGuardian({directory:${JSON.stringify(runtime)},guardianPort:0,managerPort:0,managerScript:${JSON.stringify(fixtureManager)},opsEvents:{observe(){}},options:{initialGraceMs:2000,healthIntervalMs:200,healthTimeoutMs:500,cooldownMs:100,retryDelayMs:100,stopGraceMs:200}});const timer=setInterval(()=>{if(attempt===1&&existsSync(${JSON.stringify(join(directory, 'guardian.crash'))}))process.exit(9);if(attempt===2&&existsSync(${JSON.stringify(join(directory, 'guardian.hang'))}))while(true){}},50);timer.unref();process.on('SIGTERM',async()=>{clearInterval(timer);await guard.stop();process.exit(0)});`
    )
    const report = {
      taskName,
      output: directory,
      productionTaskInstalled: false,
      actualBootTested: false,
      recoveryBy:
        'owned native Job task host with bounded retry; not claiming Task Scheduler engine RestartOnFailure',
      actions: [],
      passed: false
    }
    let installed = false
    try {
      const install = await runPowerShell([
        '-Action',
        'Install',
        '-TaskName',
        taskName,
        '-RuntimeDirectory',
        runtime,
        '-NodePath',
        process.execPath,
        '-GuardianScript',
        fixtureGuardian,
        '-ManagerConfig',
        config,
        '-GuardianPort',
        '0',
        '-ManagerPort',
        '0',
        '-GuardianRestartDelayMs',
        '200',
        '-GuardianHealthGraceMs',
        '1000',
        '-GuardianHealthIntervalMs',
        '200',
        '-GuardianHealthTimeoutMs',
        '250'
      ])
      report.actions.push({ action: 'install', ...install })
      assert.equal(install.code, 0, install.stderr)
      installed = true
      const start = await runPowerShell([
        '-Action',
        'Start',
        '-TaskName',
        taskName,
        '-RuntimeDirectory',
        runtime
      ])
      report.actions.push({ action: 'start', ...start })
      assert.equal(start.code, 0, start.stderr)
      await until(
        async () => (await guardianStatus({ directory: runtime })).services[0]?.healthy === true,
        'scheduled dummy service did not become ready',
        20000
      )
      const before = await guardianStatus({ directory: runtime })
      report.before = before
      const duplicateStart = await runPowerShell([
        '-Action',
        'Start',
        '-TaskName',
        taskName,
        '-RuntimeDirectory',
        runtime
      ])
      report.actions.push({ action: 'start-again', ...duplicateStart })
      assert.equal(duplicateStart.code, 0)
      await pause(150)
      assert.equal((await guardianStatus({ directory: runtime })).guardianPid, before.guardianPid)
      const status = await runPowerShell([
        '-Action',
        'Status',
        '-TaskName',
        taskName,
        '-RuntimeDirectory',
        runtime
      ])
      report.actions.push({ action: 'status', ...status })
      assert.equal(status.code, 0, status.stderr)
      assert.equal(JSON.parse(status.stdout.trim()).startupTriggerRegistered, true)
      writeFileSync(join(directory, 'guardian.crash'), 'abnormal exit own first guardian')
      await until(
        async () => {
          const current = await guardianStatus({ directory: runtime })
          return (
            current.guardianAlive &&
            current.guardianPid !== before.guardianPid &&
            current.services[0]?.healthy === true
          )
        },
        'Owned task host did not restore the unexpectedly exited guardian',
        20000
      )
      report.after = await guardianStatus({ directory: runtime })
      assert.notEqual(report.after.managerPid, before.managerPid)
      assert.equal(Number(readFileSync(join(directory, 'guardian.attempts'), 'utf8')), 2)
      writeFileSync(join(directory, 'guardian.hang'), 'hang own second guardian event loop')
      await until(
        async () => {
          const current = await guardianStatus({ directory: runtime })
          return (
            current.guardianAlive &&
            current.guardianPid !== report.after.guardianPid &&
            current.services[0]?.healthy === true
          )
        },
        'Owned task host did not recover 3 consecutive guardian responsiveness failures',
        20000
      )
      report.afterHang = await guardianStatus({ directory: runtime })
      assert.equal(Number(readFileSync(join(directory, 'guardian.attempts'), 'utf8')), 3)
      report.hostHangRecovered = true
      const beforeHostExit = report.afterHang.guardianPid
      const taskHostExit = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-Command', `Stop-ScheduledTask -TaskName '${taskName}'`], {
          windowsHide: true, env: cleanEnvironment(), stdio: 'ignore' })
      assert.equal(await new Promise(done => taskHostExit.once('close', done)), 0)
      await until(async () => {
        const current = await guardianStatus({ directory: runtime })
        return current.guardianAlive && current.guardianPid !== beforeHostExit && current.services[0]?.healthy === true
      }, 'Periodic owned task trigger did not recover the exited outer host', 85000)
      report.afterTaskHostExit = await guardianStatus({ directory: runtime })
      report.taskHostRecoveryByPeriodicTriggerVerified = true
      const stop = await runPowerShell([
        '-Action',
        'Stop',
        '-TaskName',
        taskName,
        '-RuntimeDirectory',
        runtime
      ])
      report.actions.push({ action: 'stop', ...stop })
      assert.equal(stop.code, 0, stop.stderr)
      await until(
        async () => !(await portProbe(port)).listening,
        'owned scheduled service did not stop'
      )
      report.explicitStopVerified = true
      writeFileSync(join(runtime, 'guardian-recovery-blocked.json'), JSON.stringify({ adviceCode: 'CHECK_RESTART_BUDGET' }))
      const restart = await runPowerShell([
        '-Action',
        'Start',
        '-TaskName',
        taskName,
        '-RuntimeDirectory',
        runtime
      ])
      report.actions.push({ action: 'start-after-stop', ...restart })
      assert.equal(restart.code, 0, restart.stderr)
      await until(
        async () => (await guardianStatus({ directory: runtime })).services[0]?.healthy === true,
        'explicit task Start after Stop failed',
        20000
      )
      report.explicitRestart = await guardianStatus({ directory: runtime })
      assert.equal(existsSync(join(runtime, 'guardian-recovery-blocked.json')), false)
      report.passed = true
    } catch (error) {
      report.error = error.stack || String(error)
      throw error
    } finally {
      let cleanupError
      if (installed) {
        const uninstall = await runPowerShell([
          '-Action',
          'Uninstall',
          '-TaskName',
          taskName,
          '-RuntimeDirectory',
          runtime
        ])
        report.actions.push({ action: 'uninstall', ...uninstall })
        if (uninstall.code !== 0) cleanupError = new Error(uninstall.stderr)
        const child = spawn(
          join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoProfile',
            '-Command',
            `$found=Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; if($found){exit 1}else{exit 0}`
          ],
          { env: cleanEnvironment(), windowsHide: true, stdio: 'ignore' }
        )
        report.taskRemoved = await new Promise((done) =>
          child.once('close', (code) => done(code === 0))
        )
        if (!report.taskRemoved) cleanupError = new Error('owned temporary task was not removed')
        try {
          await until(
            async () => !(await guardianStatus({ directory: runtime })).guardianAlive,
            'owned scheduled guardian remained alive after uninstall'
          )
        } catch (error) {
          cleanupError = error
        }
        try {
          await until(
            async () => !(await portProbe(port)).listening,
            'owned scheduled dummy port remained open after uninstall'
          )
          report.servicePortClosed = true
        } catch (error) {
          cleanupError = error
        }
      }
      if (cleanupError) {
        report.cleanupError = cleanupError.message
        report.passed = false
      }
      writeFileSync(join(directory, 'results.json'), JSON.stringify(report, null, 2))
      if (cleanupError) throw cleanupError
    }
  }
)

test('Windows宿主预算耗尽持久阻断，后续周期触发不能重新循环启动', { skip: !windows, timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-guardian-budget-'))
  const guardian = join(directory, 'owned-exit.mjs'), attempts = join(directory, 'attempts')
  writeFileSync(guardian, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n'); process.exit(9)`)
  const argumentsList = ['-Action', 'RunGuardian', '-RuntimeDirectory', directory, '-NodePath', process.execPath,
    '-GuardianScript', guardian, '-GuardianRestartLimit', '0', '-GuardianRestartDelayMs', '50']
  const first = await runPowerShell(argumentsList)
  assert.equal(first.code, 78, first.stderr)
  assert.equal(existsSync(join(directory, 'guardian-recovery-blocked.json')), true)
  const firstAttempts = readFileSync(attempts, 'utf8')
  assert.ok(firstAttempts.length > 0)
  const second = await runPowerShell(argumentsList)
  assert.equal(second.code, 78, second.stderr)
  assert.equal(readFileSync(attempts, 'utf8'), firstAttempts)
})
