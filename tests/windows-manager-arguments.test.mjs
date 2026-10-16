import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runGuardian, guardianStatus } from '../scripts/studio-guardian.mjs'
import { readProcessOwner, requestProcessControl } from '../scripts/studio-service-control.mjs'

const root = resolve('.'), windows = process.platform === 'win32'
const pause = ms => new Promise(done => setTimeout(done, ms))
async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen({ host: '127.0.0.1', port: 0 }, done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}
function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'studio windows arguments '))
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'studio windows arguments '))
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}
async function until(check, failure, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(40)
  }
  assert.fail(failure)
}

test('Windows RunJob将Base64参数逐项传给真实studio-local CLI，空格路径和isolated-test配置完整生效',
  { skip: !windows, timeout: 25000 }, async t => {
    const directory = temporaryDirectory(t), runtime = join(directory, 'private runtime')
    const config = join(directory, 'isolated config.json'), dummy = join(directory, 'fake service.mjs')
    const marker = randomUUID(), port = await freePort()
    mkdirSync(runtime)
    writeFileSync(dummy, `
import { createServer } from 'node:http';
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'studio-api',status:req.url.endsWith('/ready')?'ready':'ok',checks:{database:true},release:null,fixture:${JSON.stringify(marker)}}))});
server.listen(${port},'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`)
    writeFileSync(config, JSON.stringify({
      purpose: 'isolated-test',
      services: [{ name: 'isolated-api', port, cwd: directory, env: {}, args: [dummy] }],
      supervisor: { initialGraceMs: 50, healthIntervalMs: 100, healthTimeoutMs: 500,
        failureThreshold: 3, stopGraceMs: 1000, maxRestarts: 0 }
    }))
    const guardian = await runGuardian({
      directory: runtime, guardianPort: 0, managerPort: 0,
      managerConfig: config, opsDirectory: join(directory, 'private ops'), opsEnvironment: 'test',
      options: { initialGraceMs: 2000, healthIntervalMs: 100, healthTimeoutMs: 500,
        failureThreshold: 5, stopGraceMs: 2000, maxRestarts: 0 }
    })
    t.after(() => guardian.stop())
    await until(async () => {
      const status = await guardianStatus({ directory: runtime })
      const snapshot = guardian.supervisor.snapshot()[0]
      if (snapshot?.state === 'waiting-restart' || snapshot?.state === 'restart-limit')
        assert.fail('real studio-local CLI exited before authenticating the isolated manager')
      return status.managerAlive && status.services[0]?.healthy === true
    }, 'real studio-local CLI did not start the isolated configuration')
    const before = await guardianStatus({ directory: runtime })
    const owner = readProcessOwner(runtime, 'manager.json', root)
    assert.equal(owner.kind, 'studio-local-manager')
    assert.equal(before.services.length, 1)
    assert.equal(before.services[0].name, 'isolated-api')
    assert.equal(before.services[0].port, port)
    assert.equal((await requestProcessControl(owner, 'status')).pid, before.managerPid)
    const response = await fetch(`http://127.0.0.1:${port}/api/studio/health/ready`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).fixture, marker)
    const hostLog = readFileSync(join(runtime, 'guardian-manager/manager.stdout.log'), 'utf8')
    assert.match(hostLog, /job-owned/)
    assert.equal(existsSync(join(directory, 'private ops/events.sqlite')), true)
    const childPid = before.services[0].pid
    await guardian.stop()
    await until(() => {
      try { process.kill(childPid, 0); return false } catch (error) { return error.code === 'ESRCH' }
    }, 'owned isolated service remained alive after guardian stop')
    assert.equal(await requestProcessControl(owner, 'ping'), null)
  })

test('Windows RunJob严格拒绝畸形、非字符串及超限Base64参数，错误不回显原文',
  { skip: !windows, timeout: 25000 }, async t => {
    const directory = temporaryDirectory(t), marker = 'PRIVATE_ARGUMENT_MARKER_MUST_NOT_BE_LOGGED'
    const encode = value => Buffer.from(value).toString('base64')
    const cases = [
      ['base64', '%not-base64-' + marker],
      ['json', encode('["' + marker + '",')],
      ['scalar', encode(JSON.stringify(marker))],
      ['object', encode(JSON.stringify({ value: marker }))],
      ['number-entry', encode(JSON.stringify([marker, 12]))],
      ['null-entry', encode(JSON.stringify([marker, null]))],
      ['nested-entry', encode(JSON.stringify([[marker]]))],
      ['empty-array', encode('[]')],
      ['utf8', Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')],
      ['argument-length', encode(JSON.stringify([marker + 'x'.repeat(4097)]))],
      ['argument-count', encode(JSON.stringify(Array(129).fill(marker)))],
      ['encoded-length', 'A'.repeat(22000)]
    ]
    for (const [name, encoded] of cases) {
      const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
        .filter(key => process.env[key]).map(key => [key, process.env[key]]))
      env.STUDIO_GUARDIAN_OWNER_TOKEN = 'isolated-test-placeholder-only'
      const result = await new Promise((done, reject) => {
        const child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/studio-service-windows.ps1'),
          '-Action', 'RunJob', '-NodePath', process.execPath, '-RuntimeDirectory', join(directory, name),
          '-ParentPid', String(process.pid), '-GuardianPort', '1', '-ManagerArgumentsBase64', encoded
        ], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        child.stdout.on('data', value => { stdout += value })
        child.stderr.on('data', value => { stderr += value })
        child.once('error', reject)
        child.once('close', code => done({ code, stdout, stderr }))
      })
      assert.equal(result.code, 78, `${name}: invalid arguments did not stop safely`)
      assert.equal(result.stderr.trim(), 'MANAGER_ARGUMENTS_INVALID', `${name}: unexpected unsafe error`)
      assert.equal(result.stdout, '', `${name}: invalid arguments wrote output`)
      assert.equal((result.stdout + result.stderr).includes(marker), false)
      assert.equal(existsSync(join(directory, name, 'manager.json')), false)
    }
  })
