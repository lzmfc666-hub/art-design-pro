import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { buildFingerprint } from '../scripts/studio-release.mjs'
import { candidatePathAllowed, createStudioPackage } from '../scripts/studio-package.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
function archiveNames(bytes) {
  const tar = gunzipSync(bytes), names = []
  let offset = 0, paxPath
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) break
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 136).trim() || '0', 8), type = String.fromCharCode(header[156])
    if (type === 'x') {
      const attributes = tar.subarray(offset + 512, offset + 512 + size).toString('utf8')
      paxPath = attributes.match(/(?:^|\n)[0-9]+ path=([^\n]*)\n/)?.[1]
    } else if (type === '0' || type === '\0') {
      names.push(paxPath || [field(345, 500), field(0, 100)].filter(Boolean).join('/'))
      paxPath = undefined
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return names
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-package-isolated-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  write('src/app.mjs', 'export const isolated = true\n')
  write('package.json', '{"private":true,"type":"module"}\n')
  write('.env', '# Public frontend defaults\nVITE_BASE_URL=/\nVITE_LOCK_ENCRYPT_KEY=public-browser-constant\n')
  write('.env.production', 'VITE_API_URL=/\n')
  write('player-client/.env.example', 'STUDIO_API_TARGET=http://127.0.0.1:3007\nVITE_ADMIN_URL="http://127.0.0.1:3006/#/auth/login"\n')
  write('.qa/final-joint-ui.mjs', '// tracked source validation helper\n')
  write('dist/index.html', '<html>isolated admin</html>\n')
  write('dist/assets/app.js', 'console.log("isolated admin")\n')
  write('dist/assets/app.js.gz', gzipSync('console.log("isolated admin")\n'))
  write('player-client/dist/index.html', '<html>isolated player</html>\n')
  write('player-client/dist/assets/player.js', 'console.log("isolated player")\n')
  // Present but untracked runtime data must never be discovered by packing.
  write('.data/studio.sqlite', 'PRIVATE-DATABASE-CONTENT')
  write('.data/bootstrap-password.txt', 'PRIVATE-RUNTIME-PASSWORD')
  write('backups/production.sqlite', 'PRIVATE-BACKUP')
  write('.qa/session.json', '{"cookie":"PRIVATE-COOKIE"}')
  write('node_modules/fake/private.key', 'PRIVATE-KEY')
  write('ops-private/ops.json', '{"token":"PRIVATE-OPS-TOKEN"}')
  const tracked = ['src/app.mjs', 'package.json', '.env', '.env.production', 'player-client/.env.example', '.qa/final-joint-ui.mjs']
    .map(path => ({ path, mode: '100644' }))
  const sourceFiles = Object.fromEntries(['src/app.mjs', '.qa/final-joint-ui.mjs'].map(path => [path, hash(readFileSync(join(root, path)))]))
  const admin = buildFingerprint(join(root, 'dist')), player = buildFingerprint(join(root, 'player-client/dist'))
  const sourceDigest = hash(JSON.stringify(sourceFiles))
  const manifest = { format: 'studio-release-v1', id: hash([sourceDigest, admin.digest, player.digest].join(':')),
    generatedAt: '2026-10-18T00:00:00.000Z', sourceDigest, adminDigest: admin.digest, playerDigest: player.digest,
    sourceFiles, adminFiles: admin.files, playerFiles: player.files }
  write('.data/releases/current.json', JSON.stringify(manifest, null, 2))
  write('.studio-package-test-files.json', JSON.stringify(tracked))
  mkdirSync(join(root, 'output'))
  const output = name => join(root, 'output', name + '.tar.gz')
  return { root, write, tracked, manifest, output, pack: name => createStudioPackage({ output: output(name), isolatedTestRoot: root }),
    saveTracked: () => write('.studio-package-test-files.json', JSON.stringify(tracked)) }
}

test('安全候选包含Git源码、两端构建及精确发布清单，排除数据库/私钥/备份/运行凭据', t => {
  const f = fixture(t), result = f.pack('safe')
  assert.equal(result.id, f.manifest.id)
  assert.equal(result.sha256, hash(readFileSync(result.output)))
  assert.equal(result.size, readFileSync(result.output).length)
  assert.equal(result.fileCount, result.files.length)
  assert.equal(result.stagingVerified, true)
  const paths = result.files.map(row => row.path)
  assert.ok(paths.includes('src/app.mjs'))
  assert.ok(paths.includes('dist/index.html'))
  assert.ok(paths.includes('dist/assets/app.js.gz'))
  assert.ok(paths.includes('player-client/dist/index.html'))
  assert.ok(paths.includes('.qa/final-joint-ui.mjs'))
  assert.deepEqual(paths.filter(path => path.startsWith('.data/')), ['.data/releases/current.json'])
  assert.equal(paths.some(path => /sqlite|bootstrap-password|node_modules|backups|ops-private|session\.json/.test(path)), false)
  const archive = spawnSync('tar', ['-tzf', result.output], { encoding: 'utf8', windowsHide: true })
  assert.equal(archive.status, 0, archive.stderr)
  assert.deepEqual(archive.stdout.trim().split(/\r?\n/), paths)
  const released = spawnSync('tar', ['-xOf', result.output, '.data/releases/current.json'], { encoding: 'utf8', windowsHide: true })
  assert.equal(released.status, 0, released.stderr)
  assert.deepEqual(JSON.parse(released.stdout), f.manifest)
  assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, 'utf8')).files, result.files)
  assert.equal(readFileSync(result.checksumPath, 'utf8'), `${result.sha256}  safe.tar.gz\n`)
  assert.equal(readdirSync(join(f.root, '.qa')).some(name => name.startsWith('package-')), false)
})

test('相同输入跨秒重复归档字节可复现，输出及侧车清单均拒绝覆盖', async t => {
  const f = fixture(t), first = f.pack('first')
  // Windows bsdtar used to put the current second in the gzip header. Avoid
  // accidentally passing the regression merely by creating both in one second.
  await new Promise(resolve => setTimeout(resolve, 1200))
  const second = f.pack('second')
  assert.equal(readFileSync(first.output).readUInt32LE(4), 0)
  assert.equal(readFileSync(second.output).readUInt32LE(4), 0)
  assert.equal(first.sha256, second.sha256)
  assert.deepEqual(first.files, second.files)
  assert.throws(() => f.pack('first'), /拒绝覆盖/)
  f.write('output/blocked.tar.gz.sha256', 'existing checksum')
  assert.throws(() => f.pack('blocked'), /拒绝覆盖/)
  assert.equal(existsSync(f.output('blocked')), false)
  assert.equal(hash(readFileSync(first.output)), first.sha256)
})

test('路径过滤拒绝穿越、数据库、归档、隐藏私有目录和意外环境文件', () => {
  for (const path of ['../outside', '/absolute', 'C:/private', 'src/../private', 'src\\bad', 'bad\nname',
    '.data/studio.sqlite', '.DATA/studio.sqlite', '.qa/session.json', 'node_modules/pkg/index.js', 'src/.data/secret',
    'private/secret.json', 'keys/id', '.ssh/id_ed25519', 'server/credentials.json', 'backup/anything',
    'outputs/old.tar.gz', 'a.db-wal', 'dump.sql.gz', 'key.pem', '.env.production.local', 'src/.env'])
    assert.equal(candidatePathAllowed(path), false, path)
  assert.equal(candidatePathAllowed('.data/releases/current.json'), false)
  assert.equal(candidatePathAllowed('.data/releases/current.json', { generatedRelease: true }), true)
  assert.equal(candidatePathAllowed('.qa/final-joint-ui.mjs'), true)
  assert.equal(candidatePathAllowed('tests/login.test.mjs'), true)
  assert.equal(candidatePathAllowed('dist/assets/app.js.gz'), true)
  assert.equal(candidatePathAllowed('dist/database.gz'), false)
})

test('意外跟踪敏感文件会中止打包，不会默默带入或生成半成品', t => {
  const f = fixture(t)
  f.tracked.push({ path: '.data/studio.sqlite', mode: '100644' }); f.saveTracked()
  assert.throws(() => f.pack('blocked-data'), /不允许/)
  assert.equal(existsSync(f.output('blocked-data')), false)
})

test('允许的环境模板仍拒绝服务端秘密和外部运行代理配置', t => {
  const f = fixture(t)
  f.write('.env.production', 'VITE_API_URL=/\nSTUDIO_PASSWORD=not-a-real-secret\n')
  assert.throws(() => f.pack('private-env'), /非公开服务端配置/)
  assert.equal(existsSync(f.output('private-env')), false)
  f.write('.env.production', 'VITE_API_URL=/\n')
  f.write('player-client/.env.example', 'STUDIO_API_TARGET=https://example.com\n')
  assert.throws(() => f.pack('external-env'), /非公开服务端配置/)
})

test('源码或构建与发布清单不一致时不能生成候选', t => {
  const f = fixture(t)
  f.write('src/app.mjs', 'export const changed = true\n')
  assert.throws(() => f.pack('changed-source'), /源码与清单不一致/)
  f.write('src/app.mjs', 'export const isolated = true\n')
  f.write('dist/assets/app.js', 'changed build\n')
  assert.throws(() => f.pack('changed-build'), /构建与发布清单不一致/)
})

test('中文多层文档及跨目录构建完整解包，超长参数总量分批后跨秒SHA仍一致', async t => {
  const f = fixture(t)
  const names = ['docs/上线前运维操作手册-2026-10-15.md', 'docs/最终交付结果-生产修复-2026-10-18.md',
    'docs/上线前检查/服务端与打手端联调/中文多层记录.md']
  // Exceed one Windows command-line batch while keeping individual filenames
  // within the portable filesystem and USTAR boundaries used by GNU tar.
  for (let index = 0; index < 320; index++)
    names.push(`docs/上线前检查/服务端与打手端联调/记录-${String(index).padStart(4, '0')}-${'a'.repeat(48)}.md`)
  for (const name of names) { f.write(name, `中文文档内容：${name}\n`); f.tracked.push({ path: name, mode: '100644' }) }
  f.saveTracked()
  f.write('dist/assets/中文界面.js', 'console.log("中文后台界面")\n')
  f.write('dist/assets/中文界面.js.gz', gzipSync('console.log("中文后台界面")\n'))
  f.write('player-client/dist/assets/打手界面.js', 'console.log("中文打手界面")\n')
  const admin = buildFingerprint(join(f.root, 'dist')), player = buildFingerprint(join(f.root, 'player-client/dist'))
  const changed = { ...f.manifest, adminFiles: admin.files, adminDigest: admin.digest, playerFiles: player.files, playerDigest: player.digest }
  changed.id = hash([changed.sourceDigest, changed.adminDigest, changed.playerDigest].join(':'))
  f.write('.data/releases/current.json', JSON.stringify(changed))
  const result = f.pack('unicode-batches')
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(f.pack('unicode-batches-again').sha256, result.sha256)
  assert.deepEqual(archiveNames(readFileSync(result.output)), result.files.map(row => row.path))
  const extracted = join(f.root, 'extracted-unicode')
  mkdirSync(extracted)
  const unpack = spawnSync('tar', ['-xzf', result.output, '-C', extracted], { encoding: 'utf8', windowsHide: true })
  assert.equal(unpack.status, 0, unpack.stderr)
  for (const row of result.files)
    assert.equal(hash(readFileSync(join(extracted, row.path))), row.sha256, row.path)
  assert.ok(names.every(name => result.files.some(row => row.path === name)))
  assert.equal(result.files.some(row => row.path.includes('source.tar')), false)
  assert.equal(JSON.parse(readFileSync(join(extracted, '.data/releases/current.json'), 'utf8')).id, changed.id)
})

test('输入链接不能把私有目录或文件借源码名带入更新包', t => {
  const f = fixture(t)
  try { symlinkSync(join(f.root, '.data/bootstrap-password.txt'), join(f.root, 'src/linked.mjs'), 'file') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前系统未授予创建链接权限'); return } throw error }
  f.tracked.push({ path: 'src/linked.mjs', mode: '100644' }); f.saveTracked()
  assert.throws(() => f.pack('linked'), /链接/)
  assert.equal(existsSync(f.output('linked')), false)
})

test('伪装静态gzip侧车不能夹带与原文件不同的内容', t => {
  const f = fixture(t)
  f.write('dist/assets/app.js.gz', gzipSync('private-database-disguised-as-static'))
  // Update only the isolated build manifest to prove sidecar matching is a
  // separate packaging rule, rather than merely the earlier build digest check.
  const admin = buildFingerprint(join(f.root, 'dist'))
  const changed = { ...f.manifest, adminFiles: admin.files, adminDigest: admin.digest }
  changed.id = hash([changed.sourceDigest, changed.adminDigest, changed.playerDigest].join(':'))
  f.write('.data/releases/current.json', JSON.stringify(changed))
  assert.throws(() => f.pack('disguised-gzip'), /侧车与原文件不一致/)
  assert.equal(existsSync(f.output('disguised-gzip')), false)
})

test('测试根覆盖不能指向正常项目，也不能把已有Git目录当成隔离夹具', t => {
  const f = fixture(t)
  f.write('.git/config', 'not a real repository')
  assert.throws(() => f.pack('not-isolated'), /临时或QA隔离/)
  assert.throws(() => createStudioPackage({ output: f.output('wrong-root'), isolatedTestRoot: resolve('.') }), /临时或QA隔离/)
})
