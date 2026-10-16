import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const invalid = () => new Error('LOCAL_MONITOR_BINDING_INVALID')

// A local opt-in file lets an already-running manager retain its environment.
// It grants only the existing read-only monitor authority, never a business login.
export function readLocalMonitorBinding({ root = process.cwd(), host, port, dbPath, required = false } = {}) {
  const directory = join(resolve(root), '.ops')
  const path = join(directory, 'local-monitor-binding.json')
  try {
    if (!existsSync(path)) {
      // A dangling symlink is still an invalid configured binding.
      try { lstatSync(path); throw invalid() } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (required) throw invalid()
      return null
    }
    // Production listeners must never inherit a local development identity.
    if (host !== '127.0.0.1') {
      if (required) throw invalid()
      return null
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') throw invalid()
    const rootPath = realpathSync(resolve(root))
    const directoryStat = lstatSync(directory)
    const fileStat = lstatSync(path)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 4096) throw invalid()
    if (realpathSync(directory) !== join(rootPath, '.ops')) throw invalid()
    let descriptor
    let text
    try {
      descriptor = openSync(path, 'r')
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > 4096 || opened.dev !== fileStat.dev || opened.ino !== fileStat.ino) throw invalid()
      text = readFileSync(descriptor, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > 4096) throw invalid()
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    const binding = JSON.parse(text)
    if (!binding || Array.isArray(binding) || binding.format !== 'studio-local-monitor-binding-v1' || binding.environment !== 'local' ||
        typeof binding.root !== 'string' || !isAbsolute(binding.root) || realpathSync(binding.root) !== rootPath ||
        typeof binding.databasePath !== 'string' || !isAbsolute(binding.databasePath) ||
        realpathSync(binding.databasePath) !== realpathSync(resolve(dbPath)) || !lstatSync(realpathSync(binding.databasePath)).isFile() ||
        binding.host !== '127.0.0.1' || binding.host !== host || binding.port !== port ||
        typeof binding.token !== 'string' || !/^[a-f0-9]{64}$/i.test(binding.token)) throw invalid()
    return { token: binding.token }
  } catch {
    throw invalid()
  }
}
