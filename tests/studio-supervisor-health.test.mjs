import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { superviseServices } from '../scripts/studio-process-supervisor.mjs'
import {
  apiHealthCheck,
  acquireProcessLock,
  readProcessOwner,
  requestProcessControl,
  createSupervisorOpsObserver
} from '../scripts/studio-service-control.mjs'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(10)
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
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-health-test-')),
    events = []
  const script = join(directory, 'dummy.mjs')
  writeFileSync(
    script,
    `
import { createServer } from 'node:http';
import { appendFileSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
const [directory,name,port]=process.argv.slice(2);
const file=directory+'/'+name+'.attempts';const attempt=Number(existsSync(file)?readFileSync(file,'utf8'):0)+1;writeFileSync(file,String(attempt));
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:req.url.endsWith('/ready')?'ready':'ok',service:'studio-api',release:null,checks:{database:true}}));});
server.listen(Number(port),'127.0.0.1');
setInterval(()=>{appendFileSync(directory+'/'+name+'.ticks','x');if(attempt===1&&existsSync(directory+'/'+name+'.exit'))process.exit(0);if(attempt===1&&existsSync(directory+'/'+name+'.hang'))while(true){}},10);
process.on('SIGTERM',()=>{writeFileSync(directory+'/'+name+'.grace',String(process.pid));server.close(()=>process.exit(0));});
`
  )
  let supervisor
  t.after(async () => {
    await supervisor?.stop()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'studio-health-test-'))
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    events,
    service(name, port, healthCheck) {
      return {
        name,
        port,
        healthCheck,
        args: [script, directory, name, String(port)],
        cwd: directory,
        env: {}
      }
    },
    start(services, options = {}) {
      supervisor = superviseServices({
        services,
        directory: join(directory, 'logs'),
        retryDelayMs: 20,
        cooldownMs: 20,
        maxRetryDelayMs: 100,
        maxRestarts: 2,
        restartWindowMs: 5000,
        initialGraceMs: 0,
        healthIntervalMs: 100000,
        stopGraceMs: 100,
        healthTimeoutMs: 100,
        onEvent: (item) => events.push(item),
        ...options
      })
      return supervisor
    },
    state(name) {
      return supervisor.snapshot().find((item) => item.name === name)
    }
  }
}

test('启动宽限和连续3次失败，成功一次会重置计数，优先正常退出且兄弟不重启', async (t) => {
  const f = fixture(t),
    port = await freePort(),
    siblingPort = await freePort()
  let healthy = false,
    checks = 0
  const supervisor = f.start(
    [
      f.service('target', port, () => {
        checks++
        return { healthy, restartable: true, category: 'hang' }
      }),
      f.service('sibling', siblingPort)
    ],
    { initialGraceMs: 200 }
  )
  await until(() => f.state('target').pid, 'dummy was not spawned')
  const first = f.state('target').pid,
    sibling = f.state('sibling').pid
  await supervisor.checkNow()
  assert.equal(checks, 0)
  await until(() => existsSync(join(f.directory, 'target.ticks')), 'dummy never ran')
  await pause(210)
  await supervisor.checkNow()
  await supervisor.checkNow()
  assert.equal(f.state('target').healthFailures, 2)
  healthy = true
  await supervisor.checkNow()
  assert.equal(f.state('target').healthFailures, 0)
  healthy = false
  await supervisor.checkNow()
  await supervisor.checkNow()
  assert.equal(f.state('target').pid, first)
  await supervisor.checkNow()
  await until(
    () => f.state('target').pid && f.state('target').pid !== first,
    'third failure did not recover owned child'
  )
  assert.equal(f.state('sibling').pid, sibling)
  assert.equal(f.state('sibling').restarts, 0)
  assert.ok(existsSync(join(f.directory, 'target.grace')))
  assert.equal(f.events.filter((item) => item.type === 'forced-stop').length, 0)
})

test('数据库/磁盘/配置/证书/外网失败仅阻断恢复，不因restartable误标盲重启', async (t) => {
  const f = fixture(t),
    categories = ['database', 'storage', 'config', 'certificate', 'external_network']
  const services = []
  for (const category of categories)
    services.push(
      f.service(category, await freePort(), () => ({
        healthy: false,
        restartable: true,
        category,
        adviceCode: 'CHECK_DATABASE'
      }))
    )
  const supervisor = f.start(services)
  await until(
    () => supervisor.snapshot().every((item) => item.pid),
    'not all test children started'
  )
  const pids = supervisor.snapshot().map((item) => item.pid)
  for (let index = 0; index < 5; index++) await supervisor.checkNow()
  assert.deepEqual(
    supervisor.snapshot().map((item) => item.pid),
    pids
  )
  assert.ok(
    supervisor
      .snapshot()
      .every((item) => item.restarts === 0 && item.healthFailures === 0 && item.healthy === false)
  )
  assert.equal(f.events.filter((item) => item.type === 'health-blocked').length, 25)
})

test('真实HTTP事件环hang达到3次后强退自有子进程，第二次启动可服务，兄弟继续', async (t) => {
  const f = fixture(t),
    port = await freePort(),
    siblingPort = await freePort()
  f.start(
    [
      f.service('target', port, apiHealthCheck({ port, timeoutMs: 25 })),
      f.service('sibling', siblingPort)
    ],
    { healthIntervalMs: 40, healthTimeoutMs: 100, initialGraceMs: 80, stopGraceMs: 30 }
  )
  await until(() => f.state('target').healthy === true, 'API probe never became healthy')
  const first = f.state('target').pid,
    sibling = f.state('sibling').pid
  writeFileSync(join(f.directory, 'target.hang'), 'hang first owned attempt')
  await until(
    () => f.state('target').pid !== first && f.state('target').healthy === true,
    'real hung event loop was not recovered'
  )
  assert.equal(f.state('sibling').pid, sibling)
  assert.equal(f.events.filter((item) => item.type === 'forced-stop').length, 1)
  assert.ok(f.events.filter((item) => item.type === 'health-failed').length >= 3)
})

test('OS锁和nonce拒绝第二管理者、错误令牌及旧记录，不将端口或PID当操作权', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-health-test-'))
  let called = 0
  const lock = await acquireProcessLock({
    directory,
    fileName: 'manager.json',
    root: directory,
    port: 0,
    kind: 'studio-local-manager',
    onCommand: () => {
      called++
      return {}
    }
  })
  t.after(async () => {
    await lock.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await assert.rejects(
    acquireProcessLock({
      directory,
      fileName: 'other.json',
      root: directory,
      port: lock.record.port,
      kind: 'studio-local-manager'
    }),
    { code: 'EADDRINUSE' }
  )
  assert.equal(await requestProcessControl({ ...lock.record, nonce: 'wrong' }, 'stop'), null)
  assert.equal(called, 0)
  assert.ok(
    await requestProcessControl(readProcessOwner(directory, 'manager.json', directory), 'ping')
  )
  assert.equal(called, 1)
})

test('运维observer只传6个白名单字段，PID、异常文本和控制令牌均不进入告警', async () => {
  const seen = []
  const observer = await createSupervisorOpsObserver({
    opsEvents: {
      observe(value) {
        seen.push(value)
      }
    }
  })
  observer.observe({
    type: 'health-blocked',
    service: 'api',
    category: 'database',
    healthy: false,
    pid: 111,
    token: 'secret-token',
    message: 'secret-body',
    code: 'DB_UNAVAILABLE'
  })
  observer.observe({ type: 'health-ok', service: 'api', category: 'process', healthy: true })
  assert.equal(seen.length, 4)
  assert.ok(
    seen.every(
      (item) =>
        Object.keys(item).sort().join(',') === 'adviceCode,category,healthy,key,service,severity'
    )
  )
  assert.equal(JSON.stringify(seen).includes('secret'), false)
  assert.equal(seen[0].adviceCode, 'CHECK_DATABASE')
})

test('注入的health callback抛异常属于未知检查配置错误，不将数据库等异常当hang重启', async (t) => {
  const f = fixture(t),
    port = await freePort()
  const supervisor = f.start([
    f.service('target', port, () => {
      throw new Error('private database exception')
    })
  ])
  await until(
    () => f.state('target').pid && existsSync(join(f.directory, 'target.ticks')),
    'dummy never became ready'
  )
  const pid = f.state('target').pid
  for (let index = 0; index < 4; index++) await supervisor.checkNow()
  assert.equal(f.state('target').pid, pid)
  assert.equal(f.state('target').restarts, 0)
  assert.equal(f.state('target').healthFailures, 0)
  assert.equal(f.state('target').category, 'config')
  assert.equal(JSON.stringify(f.events).includes('private database exception'), false)
})

test('旧进程迟到健康回调不能解除新进程在途probe门禁或修改新状态', async (t) => {
  const f = fixture(t),
    port = await freePort(),
    releases = []
  const supervisor = f.start(
    [f.service('target', port, () => new Promise((done) => releases.push(done)))],
    { healthTimeoutMs: 2000 }
  )
  await until(
    () => f.state('target').pid && existsSync(join(f.directory, 'target.ticks')),
    'first child never ran'
  )
  const firstPid = f.state('target').pid,
    firstCheck = supervisor.checkNow()
  await until(() => releases.length === 1, 'first health callback not entered')
  writeFileSync(join(f.directory, 'target.exit'), 'normal owned first exit')
  await until(
    () => f.state('target').pid && f.state('target').pid !== firstPid,
    'second owned generation never ran'
  )
  const secondCheck = supervisor.checkNow()
  await until(() => releases.length === 2, 'second health callback not entered')
  releases[0]({ healthy: false, restartable: true, category: 'hang' })
  await firstCheck
  await supervisor.checkNow()
  assert.equal(releases.length, 2)
  releases[1]({ healthy: true })
  await secondCheck
  assert.equal(f.state('target').healthy, true)
  assert.equal(f.state('target').healthFailures, 0)
})
