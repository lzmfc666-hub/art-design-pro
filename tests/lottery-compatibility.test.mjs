import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectStudioLifecycleCompatibility } from '../scripts/studio-lifecycle-compatibility.mjs'
import { RUNTIME_CAPABILITIES } from '../scripts/studio-release.mjs'
import { createLotteryStore } from '../server/lottery.mjs'

const capability = 'lottery-onetime-v1'
const hash = value => createHash('sha256').update(value).digest('hex')
const blankState = () => ({ schemaVersion: 2, templates: [], orders: [], refunds: [] })
const order = extra => ({ id: 'PRIVATE-ORDER', status: 'active', receivedAmount: 1000, ...extra })
const fields = ['lotteryTemplates', 'lotteryPools', 'lotteryOrders', 'lotteryCodes', 'lotteryDraws', 'lotteryDrawAssets']

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
function fixture(t, { state = blankState(), tables = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-lottery-compat-'))
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const databasePath = join(directory, 'isolated.sqlite')
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('CREATE TABLE studio_state(id INTEGER PRIMARY KEY,json TEXT)')
    db.prepare('INSERT INTO studio_state VALUES(1,?)').run(JSON.stringify(state))
    if (tables) createLotteryStore({ db })
  } finally { db.close() }
  return { directory, databasePath,
    oldManifest: manifest(directory, RUNTIME_CAPABILITIES.filter(value => value !== capability), 'rc8.json'),
    newManifest: manifest(directory, RUNTIME_CAPABILITIES, 'unified.json') }
}
function writeFixture(f, callback) {
  const db = new DatabaseSync(f.databasePath)
  try { callback(db) } finally { db.close() }
}
function inspect(f, manifestPath = f.oldManifest) {
  const before = hash(readFileSync(f.databasePath))
  const result = inspectStudioLifecycleCompatibility({ databasePath: f.databasePath, manifestPath })
  assert.equal(hash(readFileSync(f.databasePath)), before, 'the selected database bytes must remain unchanged')
  assert.equal(result.readOnly, true)
  assert.equal(result.queryOnly, true)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|code-hmac|token_hash|prize_json|pool_json|isolated\.sqlite/)
  return result
}
function sqlCode(db) {
  db.prepare(`INSERT INTO lottery_codes(id,order_id,token_hash,tier,created_at,expires_at)
    VALUES(?,?,?,?,?,?)`).run('PRIVATE-CODE', 'PRIVATE-ORDER', 'PRIVATE-TOKEN-HASH', 'special-small',
      '2026-10-20T00:00:00Z', '2026-10-20T01:00:00Z')
}

test('新版兼容检查读取无转盘表的旧库，不初始化表或密钥且允许RC8候选', t => {
  const f = fixture(t)
  const report = inspect(f)
  assert.equal(report.compatible, true)
  assert.deepEqual(report.requiredCapabilities, [])
  assert.deepEqual(fields.map(field => report.counts[field]), [0, 0, 0, 0, 0, 0])
  const db = new DatabaseSync(f.databasePath, { readOnly: true })
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'lottery_%'").get().count, 0) }
  finally { db.close() }
})

test('仅初始化转盘空表和密钥、普通模板或普通订单默认字段不阻止RC8回退', t => {
  const f = fixture(t, { tables: true, state: { ...blankState(),
    templates: [{ id: 'PRIVATE-TEMPLATE', playType: 'normal', lotteryTier: null }],
    lotteryPools: [], orders: [order({ snapshot: { playType: 'normal', lotteryTier: null } })] } })
  const report = inspect(f)
  assert.equal(report.compatible, true)
  assert.deepEqual(report.requiredCapabilities, [])
  assert.deepEqual(fields.map(field => report.counts[field]), [0, 0, 0, 0, 0, 0])
})

test('模板、奖池和订单的每种转盘业务标记分别阻止旧RC8，仅支持一次开奖能力的候选可通过', t => {
  const f = fixture(t)
  const cases = [
    { state: { templates: [{ id: 'PRIVATE-TEMPLATE', playType: 'lottery', lotteryTier: 'special-small' }] }, field: 'lotteryTemplates' },
    { state: { templates: [{ id: 'PRIVATE-TEMPLATE', lotteryTier: 'special-medium' }] }, field: 'lotteryTemplates' },
    { state: { lotteryPools: [{ tier: 'special-small', configured: true, prizes: [{ title: 'PRIVATE-PRIZE' }] }] }, field: 'lotteryPools' },
    { state: { orders: [order({ snapshot: { playType: 'lottery', lotteryTier: 'special-small' } })] }, field: 'lotteryOrders' },
    { state: { orders: [order({ snapshot: { lotteryTier: 'ultimate-large' } })] }, field: 'lotteryOrders' },
    { state: { orders: [order({ lotteryEligible: true })] }, field: 'lotteryOrders' },
    { state: { orders: [order({ lotteryVoidedAt: '2026-10-26T00:00:00Z' })] }, field: 'lotteryOrders' },
    { state: { orders: [order({ lotteryNote: 'PRIVATE-WINNING-NOTE' })] }, field: 'lotteryOrders' }
  ]
  for (const example of cases) {
    writeFixture(f, db => db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify({ ...blankState(), ...example.state })))
    const rejected = inspect(f)
    assert.equal(rejected.compatible, false)
    assert.deepEqual(rejected.missingCapabilities, [capability])
    assert.equal(rejected.counts[example.field], 1)
    assert.equal(inspect(f, f.newManifest).compatible, true)
  }
})

test('SQL码、开奖历史和奖图索引逐表检测，即使状态JSON无标记或码已过期也不能回退RC8', t => {
  const examples = [
    { field: 'lotteryCodes', write: sqlCode },
    // Isolate each table's detection from code/state markers. The read-only
    // checker must not ignore retained SQL history even in an inconsistent copy.
    { field: 'lotteryDraws', write: db => {
      db.exec('PRAGMA foreign_keys=OFF')
      db.prepare('INSERT INTO lottery_draws VALUES(?,?,?,?)')
        .run('PRIVATE-CODE', '{"title":"PRIVATE-PRIZE"}', '{"prizes":[]}', '2026-10-20T00:30:00Z')
    } },
    { field: 'lotteryDrawAssets', write: db => db.prepare('INSERT INTO lottery_draw_assets VALUES(?)').run('PRIVATE-IMAGE') }
  ]
  for (const example of examples) {
    const f = fixture(t, { tables: true })
    writeFixture(f, example.write)
    const rejected = inspect(f)
    assert.equal(rejected.compatible, false)
    assert.deepEqual(rejected.missingCapabilities, [capability])
    assert.deepEqual(fields.filter(field => rejected.counts[field] > 0), [example.field])
    assert.equal(rejected.counts[example.field], 1)
    assert.equal(inspect(f, f.newManifest).compatible, true)
  }
})

test('WAL并发提交时状态JSON和转盘SQL行取自同一只读事务快照', t => {
  const f = fixture(t, { tables: true })
  const writer = new DatabaseSync(f.databasePath)
  writer.exec('PRAGMA journal_mode=WAL')
  const original = DatabaseSync.prototype.prepare
  let changed = false
  try {
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
      if (!changed && sql === 'SELECT type FROM sqlite_schema WHERE name=?') {
        changed = true
        writer.exec('BEGIN IMMEDIATE')
        writer.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify({ ...blankState(),
          lotteryPools: [{ tier: 'special-small', configured: true, prizes: [] }] }))
        sqlCode(writer)
        writer.exec('COMMIT')
      }
      return original.call(this, sql, ...args)
    })
    const first = inspectStudioLifecycleCompatibility({ databasePath: f.databasePath, manifestPath: f.oldManifest })
    t.mock.restoreAll()
    assert.equal(changed, true)
    assert.equal(first.compatible, true)
    assert.equal(first.counts.lotteryPools, 0)
    assert.equal(first.counts.lotteryCodes, 0)
    const second = inspect(f)
    assert.equal(second.compatible, false)
    assert.equal(second.counts.lotteryPools, 1)
    assert.equal(second.counts.lotteryCodes, 1)
  } finally { t.mock.restoreAll(); writer.close() }
})

test('新版CLI检查旧RC8清单明确退出1，输出只含统计和缺失能力', t => {
  const f = fixture(t, { tables: true })
  writeFixture(f, sqlCode)
  const before = hash(readFileSync(f.databasePath))
  const result = spawnSync(process.execPath, [resolve('scripts/studio-lifecycle-compatibility.mjs'),
    '--database', f.databasePath, '--manifest', f.oldManifest], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.compatible, false)
  assert.deepEqual(report.missingCapabilities, [capability])
  assert.equal(report.counts.lotteryCodes, 1)
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-|code-hmac|token_hash|isolated\.sqlite|rc8\.json/)
  assert.equal(hash(readFileSync(f.databasePath)), before)
})

test('真正执行隔离发布记录后，清单包含lottery-onetime-v1并可通过新业务兼容检查', t => {
  const f = fixture(t, { tables: true })
  writeFixture(f, sqlCode)
  mkdirSync(join(f.directory, 'scripts'))
  for (const name of ['studio-release.mjs', 'studio-source-fingerprint.mjs'])
    copyFileSync(resolve('scripts', name), join(f.directory, 'scripts', name))
  writeFileSync(join(f.directory, 'package.json'), '{"type":"module","version":"isolated-lottery-release"}')
  for (const name of ['dist', 'player-client/dist']) {
    mkdirSync(join(f.directory, name), { recursive: true })
    writeFileSync(join(f.directory, name, 'index.html'), '<!doctype html><title>Isolated build</title>')
  }
  const path = join(f.directory, 'recorded-release.json')
  const result = spawnSync(process.execPath, ['scripts/studio-release.mjs', '--record', path], {
    cwd: f.directory, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(path), true)
  const recorded = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(recorded.runtimeCapabilities.includes(capability))
  assert.equal(inspect(f, path).compatible, true)
})
