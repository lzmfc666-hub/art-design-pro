import { parentPort, workerData } from 'node:worker_threads'
import { lstatSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { backupStudioDatabase, verifyStudioBackup } from '../scripts/studio-backup.mjs'

// Large SQLite integrity scans and snapshot work do not occupy the API event loop.
try {
  if (workerData.operation === 'verify') {
    parentPort.postMessage({ ok: true, value: await verifyStudioBackup(workerData.path) })
  } else {
    const { source, target, options, protection } = workerData
    const started = Date.now(), clock = () => options.clockTime + Date.now() - started
    const checkCapacity = () => {
      for (const path of [dirname(source), dirname(target)]) {
        let available
        try {
          const disk = statfsSync(path); available = Number(disk.bavail) * Number(disk.bsize)
          if (!Number.isSafeInteger(available) || available < 0) throw new Error('Unavailable')
        } catch { throw Object.assign(new Error('BACKUP_DISK_PROBE_FAILED'), { code: 'BACKUP_DISK_PROBE_FAILED' }) }
        if (available < protection.minFreeBytes) throw Object.assign(new Error('BACKUP_DISK_LOW'), { code: 'BACKUP_DISK_LOW' })
      }
      let bytes = 0
      for (const path of [target, target + '.json']) {
        try { bytes += lstatSync(path).size } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      }
      if (protection.maxTotalBytes && bytes > protection.maxTotalBytes)
        throw Object.assign(new Error('BACKUP_CAPACITY_EXCEEDED'), { code: 'BACKUP_CAPACITY_EXCEEDED' })
    }
    const value = await backupStudioDatabase(source, target, { applicationRelease: options.applicationRelease,
      ownership: options.ownership, clock, checkCapacity,
      onReserved: value => parentPort.postMessage({ reserved: value }) })
    parentPort.postMessage({ ok: true, value })
  }
} catch (cause) { parentPort.postMessage({ ok: false, code: cause.code || 'BACKUP_FAILED' }) }
