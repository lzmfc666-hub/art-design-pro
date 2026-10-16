import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runGuardian, guardianStatus } from '../scripts/studio-guardian.mjs'
import { readProcessOwner, requestProcessControl } from '../scripts/studio-service-control.mjs'
import { createOpsEvents } from '../server/ops-events.mjs'

const root = resolve('.'), pause = ms => new Promise(done => setTimeout(done, ms))

async function until(check, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(40)
  }
  assert.fail(message)
}

function temporaryFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-guardian-ops-config-'))
  let guardian, reader
  t.after(async () => {
    await guardian?.stop()
    await reader?.close()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'studio-guardian-ops-config-'))
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    ownGuardian(value) { guardian = value; return value },
    ownReader(value) { reader = value; return value }
  }
}

test('guardian显式私有运维目录和环境真实传递到隔离manager，事件可读且stop仅关闭自有进程', { timeout: 25000 }, async t => {
  const f = temporaryFixture(t), runtime = join(f.directory, 'runtime')
  const opsDirectory = join(f.directory, 'private-ops'), dummy = join(f.directory, 'manager.mjs')
  const failPings = join(f.directory, 'fail-pings')
  mkdirSync(runtime)
  writeFileSync(dummy, `
import { existsSync } from 'node:fs';
import { acquireProcessLock } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/studio-service-control.mjs')).href)};
let stopping=false, lock;
const stop=async()=>{if(stopping)return;stopping=true;await lock.close();process.exit(0)};
lock=await acquireProcessLock({directory:${JSON.stringify(runtime)},fileName:'manager.json',root:${JSON.stringify(root)},port:0,kind:'studio-manager',onCommand(command){
  if(command==='stop'){setTimeout(()=>void stop(),25);return {stopping:true}}
  return {ok:!existsSync(${JSON.stringify(failPings)}),services:[]};
}});
console.log(JSON.stringify({STUDIO_OPS_DIRECTORY:process.env.STUDIO_OPS_DIRECTORY,STUDIO_OPS_ENVIRONMENT:process.env.STUDIO_OPS_ENVIRONMENT}));
process.on('SIGINT',stop);process.on('SIGTERM',stop);
`)
  const guardian = f.ownGuardian(await runGuardian({
    directory: runtime, guardianPort: 0, managerPort: 0, managerScript: dummy,
    opsDirectory, opsEnvironment: 'test',
    options: {
      initialGraceMs: 1500, healthIntervalMs: 100, healthTimeoutMs: 500,
      failureThreshold: 100, stopGraceMs: 1500, maxRestarts: 0
    }
  }))
  await until(async () => (await guardianStatus({ directory: runtime })).managerAlive,
    'isolated manager never authenticated')
  const owner = readProcessOwner(runtime, 'manager.json', root)
  assert.equal(owner.kind, 'studio-manager')
  assert.notEqual(owner.pid, process.pid)
  assert.notEqual(owner.port, 3009)
  assert.equal((await requestProcessControl(owner, 'ping')).pid, owner.pid)
  const stdoutPath = process.platform === 'win32'
    ? join(runtime, 'manager.stdout.log')
    : join(runtime, 'guardian-manager/manager.stdout.log')
  await until(() => existsSync(stdoutPath) && readFileSync(stdoutPath, 'utf8').includes('STUDIO_OPS_DIRECTORY'),
    'manager did not report its two non-secret operations settings')
  const safeSettings = readFileSync(stdoutPath, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line)).find(row => Object.hasOwn(row, 'STUDIO_OPS_DIRECTORY'))
  assert.deepEqual(safeSettings, {
    STUDIO_OPS_DIRECTORY: opsDirectory, STUDIO_OPS_ENVIRONMENT: 'test'
  })
  assert.equal(existsSync(join(opsDirectory, 'events.sqlite')), true)
  assert.equal(existsSync(join(runtime, 'events.sqlite')), false)
  const reader = f.ownReader(createOpsEvents({ dbPath: join(opsDirectory, 'events.sqlite'), environment: 'test' }))
  assert.equal(reader.snapshot().delivery.state, 'disabled')

  // Reject only the dummy manager's authenticated health reply; keep its stop endpoint usable.
  writeFileSync(failPings, 'isolated fixture: reject health replies')
  await until(() => reader.events({ limit: 20 }).some(row =>
    row.key === 'supervisor.responsiveness' && row.type === 'studio.ops.failure' && row.environment === 'test'),
    'guardian did not persist its real isolated health failure in the configured operations database')
  assert.equal(guardian.supervisor.snapshot()[0].restarts, 0)
  await guardian.stop()
  await until(() => {
    try { process.kill(owner.pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
  }, 'stop left the owned isolated manager alive')
  assert.equal(await requestProcessControl(owner, 'ping'), null)
  assert.equal((await guardianStatus({ directory: runtime })).guardianAlive, false)
  assert.equal((await guardianStatus({ directory: runtime })).managerAlive, false)
})

test('guardian拒绝未知运维环境，不启动子进程或创建事件库', async t => {
  const f = temporaryFixture(t), runtime = join(f.directory, 'runtime'), opsDirectory = join(f.directory, 'ops')
  await assert.rejects(runGuardian({
    directory: runtime, guardianPort: 0, managerPort: 0,
    opsDirectory, opsEnvironment: 'invalid-environment'
  }), /Invalid operations environment/)
  assert.equal(existsSync(join(runtime, 'guardian.json')), false)
  assert.equal(existsSync(join(opsDirectory, 'events.sqlite')), false)
})

test('guardian拒绝网站公开目录作为运维存储，未创建归属或公开事件库', async t => {
  const f = temporaryFixture(t), runtime = join(f.directory, 'runtime')
  for (const publicPath of ['public', 'dist', 'player-client/public', 'player-client/dist']) {
    const opsDirectory = resolve(root, publicPath, 'guardian-ops-must-never-be-created')
    assert.equal(existsSync(opsDirectory), false)
    await assert.rejects(runGuardian({
      directory: runtime, guardianPort: 0, managerPort: 0,
      opsDirectory, opsEnvironment: 'test'
    }), /OPS_CONFIG_INVALID/)
    assert.equal(existsSync(join(runtime, 'guardian.json')), false)
    assert.equal(existsSync(opsDirectory), false)
  }
})
