import { Writable } from 'node:stream'
import { openSync, fstatSync, lstatSync, write, close, appendFileSync } from 'node:fs'

// Never truncate/delete existing logs. Once capacity is reached, consume further
// stdout without blocking the child and signal the independent ops event sink.
export function createCappedLogSink(path, { maxBytes = 8388608, onCapacity = () => {} } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) throw new Error('LOG_CAPACITY_INVALID')
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('LOG_PATH_INVALID') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  let fd = openSync(path, 'a', 0o600), bytes = fstatSync(fd).size, warned = false
  const alert = () => { if (!warned && bytes >= maxBytes * .9) { warned = true; try { onCapacity() } catch {} } }
  alert()
  return new Writable({ write(chunk, encoding, done) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    const allowed = data.subarray(0, Math.max(0, maxBytes - bytes))
    if (!allowed.length) { alert(); done(); return }
    const append = offset => write(fd, allowed, offset, allowed.length - offset, null, (error, count) => {
      if (error) return done(error)
      if (!count) return done(new Error('LOG_WRITE_FAILED'))
      bytes += count; alert()
      if (offset + count < allowed.length) append(offset + count); else done()
    })
    append(0)
  }, final(done) { const owned = fd; fd = null; close(owned, done) },
  destroy(error, done) { if (fd === null) return done(error); const owned = fd; fd = null; close(owned, () => done(error)) } })
}

export function appendCappedEvent(path, item, maxBytes = 8388608) {
  let size = 0
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('LOG_PATH_INVALID'); size = stat.size }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const line = JSON.stringify(item) + '\n'
  if (size + Buffer.byteLength(line) > maxBytes) return false
  appendFileSync(path, line, { mode: 0o600 }); return true
}
