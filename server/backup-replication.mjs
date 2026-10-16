import { copyFile, constants } from 'node:fs/promises'
import { existsSync, lstatSync, realpathSync, linkSync, unlinkSync, writeFileSync, openSync,
  closeSync, fsyncSync } from 'node:fs'
import { resolve, join, basename, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { backupFileDigest, verifyStudioBackup } from '../scripts/studio-backup.mjs'

export const BACKUP_FILE_NAME = /^studio-backup-\d{8}T\d{9}Z-([a-f0-9-]{36})\.sqlite$/
const failure = code => Object.assign(new Error(code), { code })
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const inside = (root, path) => {
  const child = relative(root, path)
  return Boolean(child) && !child.startsWith('..') && !isAbsolute(child)
}

/** Explicit existing mounted target only. The completion manifest is published last. */
export function createMountedBackupAdapter({ directory }) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw failure('BACKUP_REPLICATION_CONFIG_INVALID')
  const configured = resolve(directory), info = lstatSync(configured)
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('BACKUP_REPLICATION_PATH_INVALID')
  const root = realpathSync(configured)
  const owned = new Map()
  const remember = path => {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw failure('BACKUP_REPLICATION_PATH_INVALID')
    owned.set(path, { dev: info.dev, ino: info.ino })
  }
  const pathFor = name => {
    if (typeof name !== 'string' || name !== basename(name) || /[\\/\u0000-\u001f\u007f]/.test(name))
      throw failure('BACKUP_REPLICATION_PATH_INVALID')
    if (!same(realpathSync(configured), root) || lstatSync(configured).isSymbolicLink())
      throw failure('BACKUP_REPLICATION_PATH_INVALID')
    const path = join(root, name)
    if (!inside(root, path)) throw failure('BACKUP_REPLICATION_PATH_INVALID')
    return path
  }
  const remove = name => {
    const path = pathFor(name)
    const expected = owned.get(path)
    if (!expected || !existsSync(path)) { owned.delete(path); return }
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino)
      throw failure('BACKUP_REPLICATION_PATH_INVALID')
    unlinkSync(path)
    owned.delete(path)
  }
  return {
    async writeTemporary({ sourcePath, temporaryName, signal }) {
      if (signal.aborted) throw failure('BACKUP_REPLICATION_TIMEOUT')
      const temporary = pathFor(temporaryName)
      await copyFile(sourcePath, temporary, constants.COPYFILE_EXCL)
      remember(temporary)
      if (signal.aborted) throw failure('BACKUP_REPLICATION_TIMEOUT')
    },
    inspectTemporary: ({ temporaryName, signal }) => backupFileDigest(pathFor(temporaryName), { signal }),
    commit({ temporaryName, fileName, metadata, signal }) {
      if (signal.aborted) throw failure('BACKUP_REPLICATION_TIMEOUT')
      const temporary = pathFor(temporaryName), target = pathFor(fileName)
      const manifestTemporary = pathFor(`${temporaryName}.json`), manifest = pathFor(`${fileName}.json`)
      let targetOwned = false, manifestOwned = false
      try {
        const handle = openSync(manifestTemporary, 'wx', 0o600)
        remember(manifestTemporary)
        try { writeFileSync(handle, JSON.stringify(metadata, null, 2)); fsyncSync(handle) } finally { closeSync(handle) }
        // link is atomic and fails if a destination already exists; never overwrite another backup.
        linkSync(temporary, target); remember(target); targetOwned = true
        linkSync(manifestTemporary, manifest); remember(manifest); manifestOwned = true
        remove(temporaryName); remove(`${temporaryName}.json`)
        owned.delete(target); owned.delete(manifest)
      } catch (error) {
        if (manifestOwned) remove(`${fileName}.json`)
        if (targetOwned) remove(fileName)
        throw error
      }
    },
    removeTemporary({ temporaryName }) {
      remove(temporaryName); remove(`${temporaryName}.json`)
    }
  }
}

/** Adapter methods are trusted configuration and must honor AbortSignal; no adapter runs by default. */
export function createBackupReplicator({ enabled = false, kind = 'simulation', targetId = null,
  remoteIdentity = null, directory, adapter, timeoutMs = 10000 } = {}) {
  if (typeof enabled !== 'boolean') throw failure('BACKUP_REPLICATION_CONFIG_INVALID')
  if (!enabled) return { enabled: false, kind: null, targetId: null, run: async () => ({ skipped: true }) }
  if (!['simulation', 'remote'].includes(kind) || typeof targetId !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(targetId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000)
    throw failure('BACKUP_REPLICATION_CONFIG_INVALID')
  if (kind === 'remote') {
    if (!remoteIdentity || typeof remoteIdentity.host !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,253}$/.test(remoteIdentity.host) ||
        ['localhost', '127.0.0.1', hostname().toLowerCase()].includes(remoteIdentity.host.toLowerCase()))
      throw failure('BACKUP_REPLICATION_IDENTITY_REQUIRED')
    if (!adapter) {
      // A same-machine folder or another local disk is not evidence of another host.
      const unc = String(directory || '').match(/^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/)
      if (!unc || !same(unc[1], remoteIdentity.host) || remoteIdentity.share !== unc[2])
        throw failure('BACKUP_REPLICATION_IDENTITY_REQUIRED')
    }
  }
  const transport = adapter || createMountedBackupAdapter({ directory })
  for (const key of ['writeTemporary', 'inspectTemporary', 'commit', 'removeTemporary'])
    if (typeof transport[key] !== 'function') throw failure('BACKUP_REPLICATION_CONFIG_INVALID')
  return { enabled, kind, targetId,
    async run({ path, metadata }) {
      if (!BACKUP_FILE_NAME.test(basename(path))) throw failure('BACKUP_REPLICATION_PATH_INVALID')
      const verified = await verifyStudioBackup(path)
      if (verified.hashVerification !== 'verified' || metadata?.status !== 'complete' ||
          verified.sha256 !== metadata.sha256 || verified.bytes !== metadata.bytes)
        throw failure('BACKUP_REPLICATION_SOURCE_INVALID')
      const fileName = basename(path), temporaryName = `.${fileName}.${randomUUID()}.part`
      const controller = new AbortController()
      let timer
      const operation = (async () => {
        try {
          await transport.writeTemporary({ sourcePath: path, temporaryName, signal: controller.signal })
          if (controller.signal.aborted) throw failure('BACKUP_REPLICATION_TIMEOUT')
          const digest = await transport.inspectTemporary({ temporaryName, signal: controller.signal })
          if (digest.bytes !== verified.bytes || digest.sha256 !== verified.sha256)
            throw failure('BACKUP_REPLICATION_HASH_MISMATCH')
          if (controller.signal.aborted) throw failure('BACKUP_REPLICATION_TIMEOUT')
          await transport.commit({ temporaryName, fileName, metadata, signal: controller.signal })
          if (controller.signal.aborted) throw failure('BACKUP_REPLICATION_TIMEOUT')
          return { ok: true, kind, targetId, bytes: verified.bytes }
        } finally {
          // Cleanup follows any late temporary write; a timed-out job never initiates publication.
          await transport.removeTemporary({ temporaryName })
        }
      })()
      try {
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(failure('BACKUP_REPLICATION_TIMEOUT')) }, timeoutMs)
        })])
      } finally { clearTimeout(timer) }
    }
  }
}
