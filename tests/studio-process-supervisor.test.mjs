import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { superviseServices } from '../scripts/studio-process-supervisor.mjs'

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
const alive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function until(predicate, message, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.fail(message)
}
function resources() {
  const watched = new Set(['ProcessWrap', 'PipeWrap', 'FSReqCallback', 'FSReqWrap', 'FSReqPromise'])
  return process.getActiveResourcesInfo().reduce((counts, name) => {
    if (watched.has(name)) counts[name] = (counts[name] || 0) + 1
    return counts
  }, {})
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-supervisor-test-'))
  const logDirectory = join(directory, 'logs'),
    script = join(directory, 'dummy.mjs')
  const baselineResources = resources(),
    events = [],
    unmanaged = []
  let supervisor
  writeFileSync(
    script,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [directory, name, mode] = process.argv.slice(2);
const attemptFile = directory + '/' + name + '.attempts';
const attempt = Number(existsSync(attemptFile) ? readFileSync(attemptFile, 'utf8') : 0) + 1;
writeFileSync(attemptFile, String(attempt));
const work = directory + '/' + name + '.work';
appendFileSync(work, 'START ' + process.pid + '\\n');
const output = 'STDOUT ' + name + ' attempt=' + attempt + '\\n';
const error = 'STDERR ' + name + ' attempt=' + attempt + '\\n';
process.stdout.write(output, () => process.stderr.write(error, () => {
  if (mode === 'fail') process.exit(7);
}));
setInterval(() => {
  appendFileSync(work, 'TICK ' + process.pid + '\\n');
  if (mode === 'zero-once' && attempt === 1 && existsSync(directory + '/exit-zero')) {
    process.stdout.write('EXIT zero\\n', () => process.stderr.write('EXIT stderr zero\\n', () => process.exit(0)));
  }
}, 10);
`
  )
  const service = (name, mode = 'stable') => ({
    name,
    command: process.execPath,
    args: [script, directory, name, mode],
    cwd: directory,
    env: {}
  })
  const start = (services, options = {}) => {
    supervisor = superviseServices({
      services,
      directory: logDirectory,
      retryDelayMs: 50,
      maxRestarts: 2,
      restartWindowMs: 10000,
      ...options,
      onEvent: (item) => {
        events.push({ ...item, observedAt: performance.now() })
        appendFileSync(join(logDirectory, 'events.jsonl'), JSON.stringify(item) + '\n')
      }
    })
    return supervisor
  }
  const state = (name) => supervisor.snapshot().find((row) => row.name === name)
  const ticks = (name) =>
    read(join(directory, name + '.work'))
      .split('\n')
      .filter((line) => line.startsWith('TICK ')).length
  const ready = async (name) => {
    await until(
      () => state(name)?.state === 'running' && ticks(name) >= 2,
      name + ' never became an active working child'
    )
    return state(name).pid
  }
  const outside = () => {
    const child = spawn(process.execPath, [script, directory, 'outside', 'stable'], {
      cwd: directory,
      env: {},
      stdio: 'ignore',
      windowsHide: true
    })
    const closed = new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', done)
    })
    unmanaged.push({ child, closed })
    return child
  }
  t.after(async () => {
    await supervisor?.stop()
    for (const { child, closed } of unmanaged) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await closed
    }
    // stop's process exit and subsequent pipe/file close must finish before Windows cleanup.
    await until(
      () =>
        Object.entries(resources()).every(
          ([name, count]) => count <= (baselineResources[name] || 0)
        ),
      'Owned stdio/process handles did not close'
    )
    const absolute = resolve(directory)
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep + 'studio-supervisor-test-'))
    rmSync(absolute, { recursive: true, force: true })
  })
  return { directory, logDirectory, service, start, state, ticks, ready, events, outside }
}

test('正常退出0仅重启退出服务，两个兄弟PID及持续工作保持，真实输出和退出均可查', async (t) => {
  const f = fixture(t),
    supervisor = f.start([
      f.service('restart-me', 'zero-once'),
      f.service('sibling-a'),
      f.service('sibling-b')
    ])
  const [initial, firstSibling, secondSibling] = await Promise.all([
    f.ready('restart-me'),
    f.ready('sibling-a'),
    f.ready('sibling-b')
  ])
  const firstWork = f.ticks('sibling-a'),
    secondWork = f.ticks('sibling-b')
  writeFileSync(join(f.directory, 'exit-zero'), 'exit only the first attempt')
  await until(
    () =>
      f.state('restart-me').state === 'running' &&
      f.state('restart-me').pid !== initial &&
      f.state('restart-me').restarts === 1 &&
      read(join(f.directory, 'restart-me.attempts')) === '2',
    'Exited service was not restarted'
  )
  await until(
    () => f.ticks('sibling-a') > firstWork && f.ticks('sibling-b') > secondWork,
    'Sibling work did not continue during the restart'
  )
  assert.equal(f.state('sibling-a').pid, firstSibling)
  assert.equal(f.state('sibling-b').pid, secondSibling)
  assert.equal(f.state('sibling-a').restarts, 0)
  assert.equal(f.state('sibling-b').restarts, 0)
  assert.equal(
    f.events.filter(
      (item) => item.service === 'restart-me' && item.type === 'exited' && item.code === 0
    ).length,
    1
  )
  await until(
    () =>
      read(join(f.logDirectory, 'restart-me.stdout.log')).includes('attempt=2') &&
      read(join(f.logDirectory, 'restart-me.stderr.log')).includes('attempt=2'),
    'Actual output was not logged'
  )
  assert.match(read(join(f.logDirectory, 'restart-me.stdout.log')), /STDOUT restart-me attempt=1/)
  assert.match(read(join(f.logDirectory, 'restart-me.stderr.log')), /STDERR restart-me attempt=1/)
  assert.match(read(join(f.logDirectory, 'events.jsonl')), /"type":"exited".*"code":0/)
  await supervisor.stop()
})

test('持续失败遵守实际退避并在上限停止循环，其他服务继续工作', async (t) => {
  const f = fixture(t),
    delay = 60
  f.start([f.service('fail-me', 'fail'), f.service('healthy')], {
    retryDelayMs: delay,
    maxRestarts: 2,
    restartWindowMs: 10000
  })
  const healthyPid = await f.ready('healthy')
  await until(
    () => f.state('fail-me').state === 'failed',
    'Restart budget did not terminate the failure loop'
  )
  const starts = f.events.filter((item) => item.service === 'fail-me' && item.type === 'started')
  const exits = f.events.filter((item) => item.service === 'fail-me' && item.type === 'exited')
  assert.equal(starts.length, 3)
  assert.equal(exits.length, 3)
  assert.ok(exits.every((item) => item.code === 7))
  for (let index = 1; index < starts.length; index++)
    assert.ok(
      starts[index].observedAt - exits[index - 1].observedAt >= delay - 2,
      'A restart was launched before the configured backoff'
    )
  const failedAt = performance.now(),
    workBefore = f.ticks('healthy')
  await until(
    () => performance.now() - failedAt >= delay * 3 && f.ticks('healthy') >= workBefore + 5,
    'Healthy sibling did not remain productive after failure limit'
  )
  assert.equal(
    f.events.filter((item) => item.service === 'fail-me' && item.type === 'started').length,
    3
  )
  assert.equal(f.state('fail-me').restarts, 2)
  assert.equal(f.state('healthy').pid, healthyPid)
  assert.equal(f.state('healthy').restarts, 0)
  assert.equal(
    JSON.parse(read(join(f.logDirectory, 'status.json'))).services.find(
      (row) => row.name === 'fail-me'
    ).state,
    'failed'
  )
})

test('spawn错误记录真实错误与失败状态，不停止已启动兄弟', async (t) => {
  const f = fixture(t)
  f.start(
    [
      f.service('healthy'),
      {
        name: 'missing',
        command: join(f.directory, 'does-not-exist.exe'),
        args: [],
        cwd: f.directory,
        env: {}
      }
    ],
    { maxRestarts: 0 }
  )
  const healthyPid = await f.ready('healthy')
  await until(
    () => f.state('missing').state === 'failed',
    'Spawn error did not reach a bounded failed state'
  )
  const error = f.events.find((item) => item.service === 'missing' && item.type === 'exited')
  assert.equal(error.error, 'ENOENT')
  assert.equal(error.pid, null)
  assert.match(read(join(f.logDirectory, 'events.jsonl')), /"service":"missing".*"error":"ENOENT"/)
  assert.equal(
    JSON.parse(read(join(f.logDirectory, 'status.json'))).services.find(
      (row) => row.name === 'missing'
    ).state,
    'failed'
  )
  const work = f.ticks('healthy')
  await until(() => f.ticks('healthy') >= work + 3, 'Spawn failure stopped sibling work')
  assert.equal(f.state('healthy').pid, healthyPid)
  assert.equal(f.state('healthy').restarts, 0)
})

test('明确stop取消待重试并等待自身子进程退出，不停止独立测试进程', async (t) => {
  const f = fixture(t),
    delay = 200
  const outside = f.outside()
  await until(() => f.ticks('outside') >= 2, 'Independent test child did not start')
  const supervisor = f.start([f.service('retry-pending', 'fail'), f.service('owned-running')], {
    retryDelayMs: delay,
    maxRestarts: 2
  })
  const ownedPid = await f.ready('owned-running')
  await until(
    () => f.state('retry-pending').state === 'waiting-restart',
    'No pending retry was observed'
  )
  await supervisor.stop()
  await until(() => !alive(ownedPid), 'stop resolved without terminating its active child')
  assert.ok(supervisor.snapshot().every((row) => row.state === 'stopped' && row.pid === null))
  const stoppedAt = performance.now(),
    outsideWork = f.ticks('outside')
  await until(
    () => performance.now() - stoppedAt >= delay * 2 && f.ticks('outside') >= outsideWork + 5,
    'Independent process stopped working after supervisor stop'
  )
  assert.equal(
    f.events.filter((item) => item.service === 'retry-pending' && item.type === 'started').length,
    1
  )
  assert.equal(f.state('retry-pending').restarts, 0)
  assert.ok(alive(outside.pid))
  await supervisor.stop()
})
