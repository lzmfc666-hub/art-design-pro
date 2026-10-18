import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalFileMap, sourceFingerprint } from './studio-source-fingerprint.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const RUNTIME_CAPABILITIES = Object.freeze([
  'refund-execution-v1',
  'stored-orders-v1',
  'problem-orders-v1',
  'problem-staff-only-v1',
  'binary-uploads-v1',
  'private-thumbnails-v1',
  'cancel-refund-v1',
  'reward-disposition-v1',
  'refund-destination-v1'
])
const hash = (value) => createHash('sha256').update(value).digest('hex')
export function buildFingerprint(directory) {
  directory = resolve(directory)
  if (!existsSync(join(directory, 'index.html'))) return null
  const entries = []
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error('发布目录不接受符号链接')
      if (entry.isDirectory()) visit(target)
      else entries.push([relative(directory, target), hash(readFileSync(target))])
    }
  }
  visit(directory)
  const files = canonicalFileMap(entries)
  return { files, digest: hash(JSON.stringify(files)) }
}
export function currentReleaseFacts({
  adminDirectory = join(root, 'dist'),
  playerDirectory = join(root, 'player-client/dist')
} = {}) {
  const source = sourceFingerprint(),
    admin = buildFingerprint(adminDirectory),
    player = buildFingerprint(playerDirectory)
  if (!admin || !player) return { source, admin, player, id: null }
  return { source, admin, player, id: hash([source.digest, admin.digest, player.digest].join(':')) }
}
export function readReleaseManifest(
  path = join(root, '.data/releases/current.json'),
  { verify = true } = {}
) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    if (manifest.format !== 'studio-release-v1' || !/^[a-f0-9]{64}$/.test(manifest.id)) return null
    for (const key of ['source', 'admin', 'player'])
      if (
        !manifest[key + 'Files'] ||
        hash(JSON.stringify(manifest[key + 'Files'])) !== manifest[key + 'Digest']
      )
        return null
    if (
      hash([manifest.sourceDigest, manifest.adminDigest, manifest.playerDigest].join(':')) !==
      manifest.id
    )
      return null
    if (verify && currentReleaseFacts().id !== manifest.id) return null
    return manifest
  } catch {
    return null
  }
}
export function recordRelease(path = join(root, '.data/releases/current.json')) {
  const facts = currentReleaseFacts()
  if (!facts.id) throw new Error('两端生产构建均存在后才能记录发布对应关系')
  const manifest = {
    format: 'studio-release-v1',
    id: facts.id,
    generatedAt: new Date().toISOString(),
    runtimeCapabilities: [...RUNTIME_CAPABILITIES],
    sourceDigest: facts.source.digest,
    adminDigest: facts.admin.digest,
    playerDigest: facts.player.digest,
    sourceFiles: facts.source.files,
    adminFiles: facts.admin.files,
    playerFiles: facts.player.files,
    appVersion: JSON.parse(readFileSync(join(root, 'package.json'))).version
  }
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  return manifest
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[3] ? resolve(process.argv[3]) : undefined
  if (process.argv[2] === '--record')
    console.log(JSON.stringify({ recorded: true, id: recordRelease(path).id }))
  else {
    const value = readReleaseManifest(path)
    console.log(JSON.stringify({ verified: Boolean(value), id: value?.id || null }))
    if (!value) process.exitCode = 1
  }
}
