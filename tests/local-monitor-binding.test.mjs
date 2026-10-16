import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readLocalMonitorBinding } from '../server/local-monitor-binding.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-local-monitor-binding-'))
  assert.ok(root.startsWith(join(tmpdir(), 'studio-local-monitor-binding-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.ops'))
  const dbPath = join(root, 'existing.sqlite')
  writeFileSync(dbPath, 'existing database bytes must remain untouched')
  const options = { root, host: '127.0.0.1', port: 3007, dbPath }
  const binding = { format: 'studio-local-monitor-binding-v1', environment: 'local', root,
    databasePath: dbPath, host: options.host, port: options.port, token: 'a'.repeat(64) }
  const path = join(root, '.ops/local-monitor-binding.json')
  return { root, path, dbPath, options, binding,
    write(value = binding) { writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) } }
}

test('local monitor binding is explicit, optional and never creates a database', t => {
  const f = fixture(t)
  assert.equal(readLocalMonitorBinding(f.options), null)
  assert.throws(() => readLocalMonitorBinding({ ...f.options, required: true }), { message: 'LOCAL_MONITOR_BINDING_INVALID' })
  f.write()
  assert.deepEqual(readLocalMonitorBinding(f.options), { token: f.binding.token })
  assert.throws(() => readLocalMonitorBinding({ ...f.options, dbPath: join(f.root, 'missing.sqlite') }), { message: 'LOCAL_MONITOR_BINDING_INVALID' })
})

test('local monitor binding is bound to the exact project, existing database and loopback port', t => {
  const f = fixture(t)
  const otherRoot = join(f.root, 'other')
  mkdirSync(otherRoot)
  const otherDb = join(f.root, 'other.sqlite')
  writeFileSync(otherDb, 'other data')
  for (const patch of [{ root: otherRoot }, { root: '.' }, { databasePath: otherDb },
    { databasePath: 'existing.sqlite' }, { environment: 'production' }, { format: 'other' },
    { host: 'localhost' }, { port: 3008 }, { port: '3007' }, { token: 'b'.repeat(63) },
    { token: 'g'.repeat(64) }, { token: 'secret\n' + 'a'.repeat(64) }]) {
    f.write({ ...f.binding, ...patch })
    assert.throws(() => readLocalMonitorBinding(f.options), { message: 'LOCAL_MONITOR_BINDING_INVALID' })
  }
  f.write()
  assert.throws(() => readLocalMonitorBinding({ ...f.options, port: 3008 }), { message: 'LOCAL_MONITOR_BINDING_INVALID' })
  assert.throws(() => readLocalMonitorBinding({ ...f.options, dbPath: ':memory:' }), { message: 'LOCAL_MONITOR_BINDING_INVALID' })
  assert.deepEqual(readLocalMonitorBinding(f.options), { token: f.binding.token })
})

test('local binding never activates on a non-loopback listener, required monitor rejects it', t => {
  const f = fixture(t)
  f.write('malformed secret that must never be echoed')
  for (const host of ['0.0.0.0', '::', 'localhost', '::1']) {
    assert.equal(readLocalMonitorBinding({ ...f.options, host }), null)
    assert.throws(() => readLocalMonitorBinding({ ...f.options, host, required: true }), { message: 'LOCAL_MONITOR_BINDING_INVALID' })
  }
})

test('invalid and oversized binding errors never echo contents or filesystem details', t => {
  const f = fixture(t)
  for (const value of ['{"token":"PRIVATE_BINDING_SECRET"', ' '.repeat(4097), 'null', '[]']) {
    f.write(value)
    let thrown
    try { readLocalMonitorBinding(f.options) } catch (error) { thrown = error }
    assert.equal(thrown?.message, 'LOCAL_MONITOR_BINDING_INVALID')
    assert.ok(!String(thrown?.stack).includes('PRIVATE_BINDING_SECRET'))
  }
})

test('binding rejects file and directory symlinks', t => {
  const f = fixture(t)
  const target = join(f.root, 'binding-target.json')
  writeFileSync(target, JSON.stringify(f.binding))
  let fileSymlinkCreated = false
  try { symlinkSync(target, f.path, 'file'); fileSymlinkCreated = true } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      // Directory junctions do not require Windows developer mode.
    } else throw error
  }
  try { if (fileSymlinkCreated) assert.throws(() => readLocalMonitorBinding(f.options), { message: 'LOCAL_MONITOR_BINDING_INVALID' }) }
  finally { rmSync(f.path, { force: true }) }
  rmSync(join(f.root, '.ops'), { recursive: true })
  const privateTarget = join(f.root, 'other-private')
  mkdirSync(privateTarget)
  writeFileSync(join(privateTarget, 'local-monitor-binding.json'), JSON.stringify(f.binding))
  symlinkSync(privateTarget, join(f.root, '.ops'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readLocalMonitorBinding(f.options), { message: 'LOCAL_MONITOR_BINDING_INVALID' })
})
