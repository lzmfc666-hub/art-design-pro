import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, chmodSync, writeFileSync,
  openSync, closeSync, readSync, writeSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { buildFingerprint, readReleaseManifest } from './studio-release.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const releasePath = '.data/releases/current.json'
const sha = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const inside = (root, target) => !relative(root, target).startsWith('..' + sep) &&
  relative(root, target) !== '..' && !relative(root, target).includes(':') && target !== root
const present = path => { try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const publicEnv = new Set(['.env', '.env.development', '.env.production', 'player-client/.env.example'])
const blockedDirectories = new Set(['.git', '.data', '.qa', 'node_modules', '.ops', 'ops-private', 'backups', 'backup',
  '.ssh', 'keys', 'secrets', 'private', 'playwright-report', 'test-results'])
const sensitiveExtension = /\.(?:sqlite(?:3)?(?:-wal|-shm)?|db(?:-wal|-shm)?|bak|pem|key|pfx|p12|zip|tar(?:\.(?:gz|bz2|xz))?|tgz|7z|rar|gz|bz2|xz|log)$/i
const staticGzip = path => /^(?:dist|player-client\/dist)\/.+\.(?:js|mjs|json|css|html)\.gz$/.test(path)

export function candidatePathAllowed(path, { generatedRelease = false } = {}) {
  if (typeof path !== 'string' || !path || /[\\\0\r\n]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return false
  if (path === releasePath) return generatedRelease
  if (parts[0].toLowerCase() === '.data') return false
  if (parts[0].toLowerCase() === '.qa') return path === '.qa/final-joint-ui.mjs'
  if (parts.some(part => blockedDirectories.has(part.toLowerCase()))) return false
  if (parts.some(part => part.toLowerCase().startsWith('.env')) && !publicEnv.has(path)) return false
  if ((sensitiveExtension.test(path) && !staticGzip(path)) || /(?:^|\/)(?:bootstrap-password\.txt|credentials(?:\.json)?|secrets(?:\.json)?|id_rsa|id_ed25519|\.npmrc)$/i.test(path)) return false
  return true
}

function regularDirectory(path) {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || !same(resolve(path), realpathSync(path)))
    throw new Error('打包目录必须为真实目录，不能使用符号链接')
}
function fileAt(root, path) {
  const target = resolve(root, path)
  if (!inside(root, target)) throw new Error('打包路径越界')
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    const info = lstatSync(current)
    if (info.isSymbolicLink() || !same(resolve(current), realpathSync(current))) throw new Error(`不接受链接文件：${path}`)
  }
  const info = lstatSync(target)
  if (!info.isFile()) throw new Error(`只接受常规文件：${path}`)
  return { target, info }
}
function readStable(root, path) {
  const { target, info } = fileAt(root, path), bytes = readFileSync(target), after = lstatSync(target)
  if (!after.isFile() || after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino ||
      info.size !== after.size || info.mtimeMs !== after.mtimeMs || bytes.length !== info.size)
    throw new Error(`文件在打包时发生变化：${path}`)
  return bytes
}
function checkEnv(path, bytes) {
  if (!publicEnv.has(path)) return
  for (const raw of bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (!match) throw new Error(`环境模板格式无效：${path}`)
    if (match[1].startsWith('VITE_')) continue
    if (path === 'player-client/.env.example' && match[1] === 'STUDIO_API_TARGET' &&
        /^['"]?http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}\/?['"]?$/.test(match[2])) continue
    throw new Error(`环境文件包含非公开服务端配置：${path}`)
  }
}
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0 || result.error) throw new Error('无法读取已提交Git版本')
  return result.stdout
}
function tracked(root, isolated) {
  if (isolated) {
    const list = JSON.parse(readFileSync(join(root, '.studio-package-test-files.json'), 'utf8'))
    if (!Array.isArray(list) || list.some(row => typeof row?.path !== 'string' || !['100644', '100755'].includes(row.mode)))
      throw new Error('隔离测试文件清单无效')
    return list
  }
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']))
    throw new Error('请先提交并冻结当前源码，再生成更新包')
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean)
  const modes = new Map(git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(row => {
    const at = row.indexOf('\t'), header = row.slice(0, at).split(' ')
    if (header[2] !== '0') throw new Error('Git存在未解决合并记录')
    return [row.slice(at + 1), header[0]]
  }))
  return paths.map(path => ({ path, mode: modes.get(path) }))
}
function isolatedManifest(root) {
  const value = JSON.parse(readStable(root, releasePath).toString('utf8'))
  if (value.format !== 'studio-release-v1') throw new Error('隔离发布清单无效')
  for (const key of ['source', 'admin', 'player']) {
    if (!value[key + 'Files'] || sha(JSON.stringify(value[key + 'Files'])) !== value[key + 'Digest'])
      throw new Error('隔离发布摘要不一致')
  }
  if (sha([value.sourceDigest, value.adminDigest, value.playerDigest].join(':')) !== value.id)
    throw new Error('隔离发布标识不一致')
  for (const [path, digest] of Object.entries(value.sourceFiles))
    if (sha(readStable(root, path)) !== digest) throw new Error('隔离源码与清单不一致')
  if (buildFingerprint(join(root, 'dist'))?.digest !== value.adminDigest ||
      buildFingerprint(join(root, 'player-client/dist'))?.digest !== value.playerDigest)
    throw new Error('隔离构建与发布清单不一致')
  return value
}
function walkBuild(root, directory, files) {
  const target = resolve(root, directory)
  regularDirectory(target)
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (!candidatePathAllowed(path)) throw new Error(`构建含不允许文件：${path}`)
    if (entry.isDirectory()) walkBuild(root, path, files)
    else { fileAt(root, path); files.set(path, { path, mode: '100644' }) }
  }
}
function tarArchive(stage, fileList, output) {
  const version = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
  if (version.status !== 0 || version.error) throw new Error('需要系统tar命令生成更新包')
  const gnu = /GNU tar/.test(version.stdout)
  const options = gnu
    ? ['--format=ustar', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0']
    : ['--format=ustar', '--uid', '0', '--gid', '0', '--uname', '', '--gname', '']
  const result = spawnSync('tar', ['-czf', output, ...options, '-C', stage, '--null', '-T', fileList],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
  if (result.status !== 0 || result.error) throw new Error(`更新包归档失败：${String(result.stderr || result.error?.message || '').slice(0, 500)}`)
  // bsdtar writes wall-clock seconds into the gzip wrapper even when every
  // tar entry has epoch mtime. Gzip CRC covers decompressed data, not this
  // header (FHCRC is deliberately rejected), so normalizing MTIME preserves
  // the tar payload and its checksum and makes cross-second builds identical.
  const descriptor = openSync(output, 'r+')
  try {
    const header = Buffer.alloc(10)
    if (readSync(descriptor, header, 0, 10, 0) !== 10 || header[0] !== 0x1f ||
        header[1] !== 0x8b || header[2] !== 8 || header[3] !== 0)
      throw new Error('系统tar生成了不支持的gzip头，无法保证可复现归档')
    if (writeSync(descriptor, Buffer.alloc(4), 0, 4, 4) !== 4)
      throw new Error('gzip时间字段写入不完整，拒绝发布归档')
  } finally { closeSync(descriptor) }
}

/** CLI always packages this repository. Test overrides are accepted only for an
 * explicit temporary/QA root without .git; no Git creation or mutation is needed.
 */
export function createStudioPackage({ output, isolatedTestRoot } = {}) {
  if (typeof output !== 'string' || !output.trim() || !output.endsWith('.tar.gz'))
    throw new Error('必须通过--output明确提供新的.tar.gz输出文件')
  let root = repositoryRoot
  if (isolatedTestRoot !== undefined) {
    if (typeof isolatedTestRoot !== 'string' || !isolatedTestRoot.trim()) throw new Error('隔离测试目录无效')
    root = resolve(isolatedTestRoot)
    regularDirectory(root)
    const allowed = [realpathSync(tmpdir()), join(repositoryRoot, '.qa')]
    if (!allowed.some(parent => inside(parent, root)) || present(join(root, '.git')))
      throw new Error('测试覆盖只能使用明确的临时或QA隔离目录')
  }
  regularDirectory(root)
  const destination = resolve(output), sidecar = destination + '.manifest.json', checksum = destination + '.sha256'
  regularDirectory(dirname(destination))
  if ([destination, sidecar, checksum].some(present)) throw new Error('输出文件或校验清单已存在，拒绝覆盖')
  const verify = () => isolatedTestRoot !== undefined ? isolatedManifest(root) : readReleaseManifest()
  const manifest = verify()
  if (!manifest) throw new Error('当前两端构建与发布清单尚未通过校验')
  const files = new Map()
  for (const row of tracked(root, isolatedTestRoot !== undefined)) {
    if (!candidatePathAllowed(row.path)) throw new Error(`已跟踪文件不允许进入更新包：${row.path}`)
    if (!['100644', '100755'].includes(row.mode)) throw new Error(`不接受链接或子模块：${row.path}`)
    files.set(row.path, row)
  }
  walkBuild(root, 'dist', files)
  walkBuild(root, 'player-client/dist', files)
  files.set(releasePath, { path: releasePath, mode: '100644' })
  for (const path of Object.keys(manifest.sourceFiles))
    if (!files.has(path)) throw new Error(`发布必需源码尚未纳入Git：${path}`)
  const qa = join(root, '.qa')
  if (!present(qa)) mkdirSync(qa, { mode: 0o700 })
  regularDirectory(qa)
  const scratch = mkdtempSync(join(qa, 'package-')), content = join(scratch, 'content'), created = []
  mkdirSync(content, { mode: 0o700 })
  try {
    const inventory = []
    for (const row of [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      if (!candidatePathAllowed(row.path, { generatedRelease: true })) throw new Error('打包路径校验失败')
      const data = readStable(root, row.path)
      checkEnv(row.path, data)
      if (staticGzip(row.path) && !gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 }).equals(readStable(root, row.path.slice(0, -3))))
        throw new Error(`静态压缩侧车与原文件不一致：${row.path}`)
      const target = resolve(content, row.path)
      if (!inside(content, target)) throw new Error('暂存路径越界')
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, data, { flag: 'wx', mode: row.mode === '100755' ? 0o755 : 0o644 })
      chmodSync(target, row.mode === '100755' ? 0o755 : 0o644)
      utimesSync(target, 0, 0)
      inventory.push({ path: row.path, mode: row.mode, size: data.length, sha256: sha(data) })
    }
    if (isolatedManifest(content).id !== manifest.id) throw new Error('暂存发布版本校验失败')
    if (isolatedTestRoot === undefined) {
      const checked = spawnSync(process.execPath, [join(content, 'scripts/studio-release.mjs')],
        { cwd: content, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
      let value
      try { value = JSON.parse(checked.stdout) } catch { /* reported below */ }
      if (checked.status !== 0 || checked.error || value?.verified !== true || value.id !== manifest.id)
        throw new Error('暂存源码与两端构建身份校验失败')
    }
    const fileList = join(scratch, 'files.txt'), archive = join(scratch, 'candidate.tar.gz')
    writeFileSync(fileList, inventory.map(row => row.path + '\0').join(''), { mode: 0o600 })
    tarArchive(content, fileList, archive)
    const after = verify()
    if (!after || after.id !== manifest.id) throw new Error('归档期间发布版本发生变化')
    if (isolatedTestRoot === undefined) tracked(root, false)
    for (const row of inventory)
      if (sha(readStable(root, row.path)) !== row.sha256) throw new Error(`归档期间文件发生变化：${row.path}`)
    const packageBytes = readFileSync(archive), digest = sha(packageBytes)
    const metadata = { format: 'studio-candidate-package-v1', id: manifest.id,
      sourceDigest: manifest.sourceDigest, adminDigest: manifest.adminDigest, playerDigest: manifest.playerDigest,
      commit: isolatedTestRoot === undefined ? git(root, ['rev-parse', '--verify', 'HEAD']).trim() : null,
      archive: basename(destination), sha256: digest, size: packageBytes.length,
      stagingVerified: true, fileCount: inventory.length, uncompressedBytes: inventory.reduce((sum, row) => sum + row.size, 0), files: inventory }
    copyFileSync(archive, destination, constants.COPYFILE_EXCL)
    created.push({ path: destination, info: statSync(destination) })
    for (const [path, text] of [[sidecar, JSON.stringify(metadata, null, 2) + '\n'], [checksum, `${digest}  ${basename(destination)}\n`]]) {
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 })
      created.push({ path, info: statSync(path) })
    }
    return { ...metadata, output: destination, manifestPath: sidecar, checksumPath: checksum }
  } catch (error) {
    for (const row of created) {
      if (!present(row.path)) continue
      const current = lstatSync(row.path)
      if (current.isFile() && current.dev === row.info.dev && current.ino === row.info.ino) unlinkSync(row.path)
    }
    throw error
  } finally {
    // Only remove the fresh verified scratch directory, never the QA root.
    if (present(scratch) && inside(qa, scratch) && same(realpathSync(scratch), scratch) && !lstatSync(scratch).isSymbolicLink())
      rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--output') throw new Error('用法：node scripts/studio-package.mjs --output <新的.tar.gz路径>')
    const summary = createStudioPackage({ output: process.argv[3] })
    delete summary.files
    console.log(JSON.stringify(summary, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
