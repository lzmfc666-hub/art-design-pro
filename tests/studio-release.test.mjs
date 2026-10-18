import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalFileMap } from '../scripts/studio-source-fingerprint.mjs'
import { buildFingerprint } from '../scripts/studio-release.mjs'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const digestMap = (value) => hash(JSON.stringify(value))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-release-isolated-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, bytes) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    return target
  }
  mkdirSync(join(root, 'scripts'))
  for (const name of ['studio-release.mjs', 'studio-source-fingerprint.mjs'])
    copyFileSync(join(repository, 'scripts', name), join(root, 'scripts', name))
  write('package.json', '{"type":"module","version":"isolated-test"}\n')
  write('src/router/routesAlias.ts', 'export const aliases = true\n')
  write('src/router/routes/asyncRoutes.ts', 'export const asyncRoutes = []\n')
  write('src/router/routes/staticRoutes.ts', 'export const staticRoutes = []\n')
  for (const directory of ['dist', 'player-client/dist']) {
    write(`${directory}/index.html`, `<html>${directory}</html>\n`)
    write(`${directory}/assets/a.js`, 'console.log("lowercase")\n')
    write(`${directory}/assets/Z.js`, 'console.log("uppercase")\n')
    write(`${directory}/assets/_shared.js`, 'export const shared = true\n')
  }
  const run = (args, options = {}) => {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      ...options
    })
    assert.ifError(result.error)
    return result
  }
  const json = (args) => {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const record = () => {
    const result = json(['scripts/studio-release.mjs', '--record'])
    assert.equal(result.recorded, true)
    return JSON.parse(readFileSync(join(root, '.data/releases/current.json'), 'utf8'))
  }
  return { root, write, run, json, record }
}

test('native Windows and POSIX counterexample paths produce the same canonical file map', () => {
  const paths = [
    'src/router/routesAlias.ts',
    'src/router/routes/asyncRoutes.ts',
    'src/router/routes/staticRoutes.ts'
  ]
  const windowsRoot = 'C:\\isolated-release'
  const posixRoot = '/isolated-release'
  const windowsAbsolute = paths.map((path) => win32.join(windowsRoot, ...path.split('/'))).sort()
  const posixAbsolute = paths.map((path) => posix.join(posixRoot, path)).sort()
  const windows = windowsAbsolute.map((path) => win32.relative(windowsRoot, path))
  const unix = posixAbsolute.map((path) => posix.relative(posixRoot, path))
  // This fixture must actually exercise the old absolute-path ordering bug.
  assert.notDeepEqual(
    windows.map((path) => path.replaceAll('\\', '/')),
    unix
  )
  const entries = (paths) => paths.map((path) => [path, hash(path.replaceAll('\\', '/'))])
  const expected = {
    'src/router/routes/asyncRoutes.ts': hash('src/router/routes/asyncRoutes.ts'),
    'src/router/routes/staticRoutes.ts': hash('src/router/routes/staticRoutes.ts'),
    'src/router/routesAlias.ts': hash('src/router/routesAlias.ts')
  }
  assert.deepEqual(canonicalFileMap(entries(windows)), expected)
  assert.deepEqual(canonicalFileMap(entries(unix.reverse())), expected)
  assert.equal(digestMap(canonicalFileMap(entries(windows))), digestMap(expected))
  assert.equal(digestMap(canonicalFileMap(entries(unix))), digestMap(expected))
})

test('normalizing duplicate separators cannot silently drop a file', () => {
  assert.throws(
    () =>
      canonicalFileMap([
        ['assets\\a.js', hash('first')],
        ['assets/a.js', hash('second')]
      ]),
    /发布文件路径重复/
  )
})

test('the actual source CLI includes every source byte in normalized relative order', (t) => {
  const f = fixture(t)
  const result = f.json(['scripts/studio-source-fingerprint.mjs'])
  const expectedPaths = [
    'package.json',
    'scripts/studio-release.mjs',
    'scripts/studio-source-fingerprint.mjs',
    'src/router/routes/asyncRoutes.ts',
    'src/router/routes/staticRoutes.ts',
    'src/router/routesAlias.ts'
  ]
  assert.deepEqual(Object.keys(result.files), expectedPaths)
  for (const [path, digest] of Object.entries(result.files))
    assert.equal(digest, hash(readFileSync(join(f.root, path))), path)
  assert.equal(result.digest, digestMap(result.files))
  f.write('node_modules/ignored.mjs', 'private dependency\n')
  f.write('.data/studio.sqlite', 'private runtime database\n')
  f.write('src/types/import/components.d.ts', 'regenerated declaration\n')
  assert.deepEqual(f.json(['scripts/studio-source-fingerprint.mjs']), result)
})

test('build fingerprints use fixed UTF-16 order for case, punctuation, nested and Chinese paths', (t) => {
  const f = fixture(t),
    directory = join(f.root, 'canonical-build')
  const expectedPaths = [
    'assets/A.js',
    'assets/Z.js',
    'assets/_shared.js',
    'assets/a-legacy.js',
    'assets/a/nested.js',
    'assets/aAlias.js',
    'assets/图片.png',
    'index.html'
  ]
  for (const path of [...expectedPaths].reverse())
    f.write(`canonical-build/${path}`, Buffer.from(`original bytes ${path}`))
  const result = buildFingerprint(directory)
  assert.deepEqual(Object.keys(result.files), expectedPaths)
  for (const [path, digest] of Object.entries(result.files))
    assert.equal(digest, hash(readFileSync(join(directory, path))), path)
  assert.equal(result.digest, digestMap(result.files))
})

test('a directory without its build entry point remains an invalid build', (t) => {
  const f = fixture(t)
  assert.equal(buildFingerprint(join(f.root, 'missing-build')), null)
})

test('isolated recording and read-only verification need no dependencies or locale comparison', (t) => {
  const f = fixture(t),
    manifest = f.record()
  assert.equal(existsSync(join(f.root, 'node_modules')), false)
  assert.deepEqual(f.json(['scripts/studio-release.mjs']), { verified: true, id: manifest.id })
  const result = f.json([
    '--input-type=module',
    '-e',
    `
    String.prototype.localeCompare = () => { throw new Error('host locale must not be used') }
    const { currentReleaseFacts, readReleaseManifest } = await import('./scripts/studio-release.mjs')
    const facts = currentReleaseFacts()
    const manifest = readReleaseManifest()
    console.log(JSON.stringify({ facts, verified: Boolean(manifest), id: manifest?.id }))
  `
  ])
  assert.equal(result.verified, true)
  assert.equal(result.id, manifest.id)
  for (const part of ['source', 'admin', 'player']) {
    assert.deepEqual(result.facts[part].files, manifest[part + 'Files'])
    assert.equal(result.facts[part].digest, manifest[part + 'Digest'])
  }
  const before = hash(readFileSync(join(f.root, '.data/releases/current.json')))
  assert.deepEqual(f.json(['scripts/studio-release.mjs']), { verified: true, id: manifest.id })
  assert.equal(hash(readFileSync(join(f.root, '.data/releases/current.json'))), before)
})

test('legacy ordered manifests retain self-validation without relaxing actual release verification', (t) => {
  const f = fixture(t),
    manifest = f.record()
  for (const part of ['source', 'admin', 'player']) {
    manifest[part + 'Files'] = Object.fromEntries(
      Object.entries(manifest[part + 'Files']).reverse()
    )
    manifest[part + 'Digest'] = digestMap(manifest[part + 'Files'])
  }
  manifest.id = hash([manifest.sourceDigest, manifest.adminDigest, manifest.playerDigest].join(':'))
  f.write('.data/releases/current.json', JSON.stringify(manifest))
  const before = hash(readFileSync(join(f.root, '.data/releases/current.json')))
  const result = f.json([
    '--input-type=module',
    '-e',
    `
    import { readReleaseManifest } from './scripts/studio-release.mjs'
    console.log(JSON.stringify({
      metadata: readReleaseManifest(undefined, { verify: false }),
      actual: readReleaseManifest()
    }))
  `
  ])
  assert.deepEqual(result.metadata, manifest)
  assert.equal(result.actual, null)
  assert.equal(hash(readFileSync(join(f.root, '.data/releases/current.json'))), before)
})

test('manifest content tampering is rejected even when filesystem verification is disabled', (t) => {
  const f = fixture(t),
    manifest = f.record()
  manifest.sourceFiles['src/router/routesAlias.ts'] = hash('tampered metadata')
  f.write('.data/releases/current.json', JSON.stringify(manifest))
  const result = f.json([
    '--input-type=module',
    '-e',
    `
    import { readReleaseManifest } from './scripts/studio-release.mjs'
    console.log(JSON.stringify({
      metadata: readReleaseManifest(undefined, { verify: false }),
      actual: readReleaseManifest()
    }))
  `
  ])
  assert.equal(result.metadata, null)
  assert.equal(result.actual, null)
})

for (const [part, path] of [
  ['source', 'src/router/routesAlias.ts'],
  ['admin', 'dist/assets/a.js'],
  ['player', 'player-client/dist/assets/a.js']
]) {
  for (const operation of ['changed', 'missing', 'extra']) {
    test(`${part} ${operation} files cannot pass release verification`, (t) => {
      const f = fixture(t),
        manifest = f.record()
      if (operation === 'changed') f.write(path, 'unexpected different bytes\n')
      else if (operation === 'missing') rmSync(join(f.root, path))
      else {
        const extra =
          part === 'source'
            ? 'src/unexpected.ts'
            : `${part === 'admin' ? 'dist' : 'player-client/dist'}/assets/unexpected.js`
        f.write(extra, 'unexpected extra file\n')
      }
      const result = f.run(['scripts/studio-release.mjs'])
      assert.equal(result.status, 1, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { verified: false, id: null })
      // Verification must not rewrite the manifest to bless the changed tree.
      assert.deepEqual(
        JSON.parse(readFileSync(join(f.root, '.data/releases/current.json'), 'utf8')),
        manifest
      )
    })
  }
}
