import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localStatus } from '../scripts/studio-local.mjs'

test('真实默认启动入口遇到外部锁正常拒绝，不因guardian循环导入退出13或启动其他进程', { timeout: 8000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-local-bootstrap-'))
  const runtime = join(directory, 'runtime'), listener = createServer()
  await new Promise(done => listener.listen(0, '127.0.0.1', done))
  t.after(async () => {
    await new Promise(done => listener.close(done))
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/studio-local.mjs', import.meta.url)),
    '--directory', runtime, '--manager-port', String(listener.address().port)], {
    cwd: directory, windowsHide: true, env: Object.fromEntries(['SystemRoot', 'PATH', 'TEMP', 'TMP']
      .filter(key => process.env[key]).map(key => [key, process.env[key]])), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  assert.equal(code, 78)
  assert.match(output, /manager lock port is occupied/i)
  assert.doesNotMatch(output, /unsettled top-level await|circular/i)
  assert.equal(listener.listening, true)
  assert.equal(existsSync(runtime), false)
})

test('历史running文件不作为当前服务状态，未认证管理器只返回历史区与真实端口核对', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-local-bootstrap-'))
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true }) })
  const listener = createServer()
  await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port
  await new Promise(done => listener.close(done))
  writeFileSync(join(directory, 'status.json'), JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z',
    services: [{ name: 'api', port, state: 'running', pid: 123456 }] }))
  const status = await localStatus({ directory, managerPort: port })
  assert.equal(status.managerAlive, false)
  assert.deepEqual(status.services, [])
  assert.equal(status.statusSource, 'unverified')
  assert.equal(status.lastRecordedServices[0].state, 'running')
  assert.equal(status.ports[0].listening, false)
})
