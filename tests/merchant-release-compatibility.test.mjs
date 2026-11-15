import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectStudioLifecycleCompatibility, LIFECYCLE_CAPABILITIES } from '../scripts/studio-lifecycle-compatibility.mjs'
import { RUNTIME_CAPABILITIES } from '../scripts/studio-release.mjs'

const credit = 'merchant-credit-v1', staff = 'merchant-staff-v1'
const hash = value => createHash('sha256').update(value).digest('hex')
const previousCapabilities = RUNTIME_CAPABILITIES.filter(value => ![credit, staff].includes(value))
const allCapabilities = [...previousCapabilities, credit, staff]
const blank = () => ({ schemaVersion: 2, orders: [], refunds: [] })
const order = extra => ({ id: 'PRIVATE-ORDER', status: 'pending', receivedAmount: 0, ...extra })

function manifest(directory, capabilities, name) {
  const files = ['source', 'admin', 'player'].map(key => ({ [`${key}.mjs`]: hash(key) }))
  const digests = files.map(value => hash(JSON.stringify(value)))
  const value = { format: 'studio-release-v1', id: hash(digests.join(':')),
    sourceFiles: files[0], adminFiles: files[1], playerFiles: files[2],
    sourceDigest: digests[0], adminDigest: digests[1], playerDigest: digests[2],
    runtimeCapabilities: capabilities }
  const path = join(directory, name)
  writeFileSync(path, JSON.stringify(value))
  return path
}

function fixture(t, state) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-merchant-compat-'))
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const databasePath = join(directory, 'private-source.sqlite')
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('CREATE TABLE studio_state(id INTEGER PRIMARY KEY,json TEXT); CREATE TABLE uploads(id TEXT PRIMARY KEY,data BLOB)')
    db.prepare('INSERT INTO studio_state VALUES(1,?)').run(JSON.stringify(state))
    db.prepare('INSERT INTO uploads VALUES(?,?)').run('PRIVATE-IMAGE', Buffer.from([0, 255, 3, 0, 5]))
  } finally { db.close() }
  return { directory, databasePath,
    previousManifest: manifest(directory, previousCapabilities, 'previous-63422.json'),
    creditManifest: manifest(directory, [...previousCapabilities, credit], 'credit-only.json'),
    currentManifest: manifest(directory, allCapabilities, 'current.json') }
}

function inspect(f, manifestPath = f.previousManifest) {
  const before = hash(readFileSync(f.databasePath))
  const report = inspectStudioLifecycleCompatibility({ databasePath: f.databasePath, manifestPath })
  assert.equal(hash(readFileSync(f.databasePath)), before, 'compatibility inspection must preserve every database byte')
  assert.equal(report.readOnly, true)
  assert.equal(report.queryOnly, true)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-|private-source|previous-63422\.json|password|username|deletedAt|ownerUserId/)
  return report
}

test('new releases declare both merchant runtime capabilities without removing production lifecycle protection', () => {
  for (const capability of [credit, staff]) {
    assert.ok(RUNTIME_CAPABILITIES.includes(capability))
    assert.ok(LIFECYCLE_CAPABILITIES.includes(capability))
  }
  for (const capability of ['lottery-onetime-v1', 'cancel-refund-v1', 'reward-disposition-v1', 'private-thumbnails-v1'])
    assert.ok(RUNTIME_CAPABILITIES.includes(capability))
})

test('ordinary databases with absent or empty merchant collections remain compatible with the previous production runtime', t => {
  for (const state of [blank(), { ...blank(), merchants: [], users: [], templates: [] },
    { ...blank(), merchants: [], users: [{ id: 'PRIVATE-USER', role: 'support' }],
      templates: [{ id: 'PRIVATE-TEMPLATE', merchantId: null, playType: 'normal' }], orders: [order({ merchantId: null })] }]) {
    const f = fixture(t, state), report = inspect(f)
    assert.equal(report.compatible, true)
    assert.deepEqual(report.requiredCapabilities, [])
  }
})

test('every persisted merchant credit marker rejects the previous runtime even without an existing owner or accepted order', t => {
  const examples = [
    { merchants: [{ id: 'PRIVATE-MERCHANT', ownerUserId: null }] },
    { users: [{ id: 'PRIVATE-USER', role: 'merchant', merchantId: 'PRIVATE-MERCHANT' }] },
    { orders: [order({ merchantId: 'PRIVATE-MERCHANT' })] },
    { orders: [order({ settlementMode: 'merchant-credit' })] },
    { templates: [{ id: 'PRIVATE-TEMPLATE', merchantId: 'PRIVATE-MERCHANT' }] }
  ]
  for (const example of examples) {
    const f = fixture(t, { ...blank(), ...example }), previous = inspect(f)
    assert.equal(previous.compatible, false)
    assert.deepEqual(previous.requiredCapabilities, [credit])
    assert.deepEqual(previous.missingCapabilities, [credit])
    assert.equal(inspect(f, f.creditManifest).compatible, true)
    assert.equal(inspect(f, f.currentManifest).compatible, true)
  }
})

test('owner bindings and deleted or reused merchant login identities additionally require staff-aware runtime behavior', t => {
  const examples = [
    { merchants: [{ id: 'PRIVATE-MERCHANT', ownerUserId: 'PRIVATE-OWNER' }] },
    { users: [{ id: 'PRIVATE-DELETED', username: 'PRIVATE-LOGIN', role: 'merchant', status: 'disabled', deletedAt: '2026-11-11T00:00:00Z' }] },
    { users: [
      { id: 'PRIVATE-DELETED', username: 'PRIVATE-LOGIN', role: 'merchant', status: 'disabled', deletedAt: '2026-11-11T00:00:00Z' },
      { id: 'PRIVATE-REPLACEMENT', username: 'private-login', role: 'merchant', status: 'active', deletedAt: null }
    ] }
  ]
  for (const example of examples) {
    const f = fixture(t, { ...blank(), ...example })
    const previous = inspect(f)
    assert.equal(previous.compatible, false)
    assert.deepEqual(previous.requiredCapabilities, [credit, staff])
    assert.deepEqual(previous.missingCapabilities, [credit, staff])
    const creditOnly = inspect(f, f.creditManifest)
    assert.equal(creditOnly.compatible, false)
    assert.deepEqual(creditOnly.missingCapabilities, [staff])
    assert.equal(inspect(f, f.currentManifest).compatible, true)
  }
})

test('malformed optional merchant and account collections fail closed rather than approving a downgrade', t => {
  for (const field of ['merchants', 'users', 'templates']) for (const value of [null, {}, 'PRIVATE-INVALID']) {
    const f = fixture(t, { ...blank(), [field]: value })
    const before = hash(readFileSync(f.databasePath))
    assert.throws(() => inspectStudioLifecycleCompatibility({ databasePath: f.databasePath, manifestPath: f.currentManifest }),
      error => error.code === 'DATABASE_INVALID')
    assert.equal(hash(readFileSync(f.databasePath)), before)
  }
  for (const field of ['merchants', 'users']) for (const value of [[null], [[]], ['PRIVATE-INVALID']]) {
    const f = fixture(t, { ...blank(), [field]: value })
    assert.throws(() => inspectStudioLifecycleCompatibility({ databasePath: f.databasePath, manifestPath: f.currentManifest }),
      error => error.code === 'DATABASE_INVALID')
  }
})

test('merchant and lottery requirements accumulate without exposing identities or replacing existing capability checks', t => {
  const f = fixture(t, { ...blank(), merchants: [{ id: 'PRIVATE-MERCHANT', ownerUserId: 'PRIVATE-OWNER' }],
    templates: [{ id: 'PRIVATE-TEMPLATE', merchantId: 'PRIVATE-MERCHANT', playType: 'lottery', lotteryTier: 'special-small' }] })
  const noLottery = manifest(f.directory, [credit, staff], 'merchant-without-lottery.json')
  const report = inspect(f, noLottery)
  assert.equal(report.compatible, false)
  assert.deepEqual(report.requiredCapabilities, ['lottery-onetime-v1', credit, staff])
  assert.deepEqual(report.missingCapabilities, ['lottery-onetime-v1'])
  assert.equal(inspect(f, f.currentManifest).compatible, true)
})

test('CLI refuses a staff-unaware rollback with public capability names and unchanged private database bytes', t => {
  const f = fixture(t, { ...blank(), users: [{ id: 'PRIVATE-DELETED', role: 'merchant', username: 'PRIVATE-LOGIN',
    password: 'PRIVATE-SECRET', deletedAt: '2026-11-11T00:00:00Z' }] })
  const before = hash(readFileSync(f.databasePath))
  const result = spawnSync(process.execPath, [resolve('scripts/studio-lifecycle-compatibility.mjs'),
    '--database', f.databasePath, '--manifest', f.creditManifest], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.compatible, false)
  assert.deepEqual(report.missingCapabilities, [staff])
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-|private-source|credit-only\.json|username|password|deletedAt/)
  assert.equal(hash(readFileSync(f.databasePath)), before)
})

test('an actual recorded release includes merchant capabilities and passes read-only checks on existing staff data', t => {
  const f = fixture(t, { ...blank(), merchants: [{ id: 'PRIVATE-MERCHANT', ownerUserId: 'PRIVATE-OWNER' }] })
  mkdirSync(join(f.directory, 'scripts'))
  for (const name of ['studio-release.mjs', 'studio-source-fingerprint.mjs'])
    copyFileSync(resolve('scripts', name), join(f.directory, 'scripts', name))
  writeFileSync(join(f.directory, 'package.json'), '{"type":"module","version":"isolated-merchant-release"}')
  for (const directory of ['dist', 'player-client/dist']) {
    mkdirSync(join(f.directory, directory), { recursive: true })
    writeFileSync(join(f.directory, directory, 'index.html'), '<!doctype html><title>Isolated build</title>')
  }
  const path = join(f.directory, 'recorded-release.json')
  const result = spawnSync(process.execPath, ['scripts/studio-release.mjs', '--record', path], {
    cwd: f.directory, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const recorded = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(recorded.runtimeCapabilities.includes(credit))
  assert.ok(recorded.runtimeCapabilities.includes(staff))
  assert.equal(inspect(f, path).compatible, true)
})
