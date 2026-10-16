import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { createStudioServer } from '../server/index.mjs'

const percentile = (samples, percent) =>
  [...samples].sort((a, b) => a - b)[
    Math.min(samples.length - 1, Math.ceil(samples.length * percent) - 1)
  ] || 0
const crc32 = (buffer) => {
  let crc = 0xffffffff
  for (const value of buffer) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
const pngChunk = (type, data) => {
  const header = Buffer.alloc(8),
    trailer = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  header.write(type, 4)
  trailer.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])))
  return Buffer.concat([header, data, trailer])
}
function largePng() {
  const width = 1440,
    height = 1440,
    rowSize = width * 4 + 1
  const raw = randomBytes(rowSize * height)
  for (let row = 0; row < height; row++) raw[row * rowSize] = 0
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** Isolated runtime-only load. Business/concurrency correctness has its own suite. */
export async function runRuntimePressure({ outputRoot = resolve('.qa/backend-runtime') } = {}) {
  mkdirSync(outputRoot, { recursive: true })
  const directory = mkdtempSync(join(outputRoot, 'run-')),
    dbPath = join(directory, 'isolated.sqlite')
  const password = 'runtime-pressure-isolated-only-123'
  const server = createStudioServer({
    dbPath,
    password,
    seed: false,
    notifications: { publicKey: '', privateKey: '', subject: '' },
    backups: { intervalMinutes: 0, failureWebhook: '' },
    runtime: { uploadRate: 60 }
  })
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  try {
    const login = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password })
    })
    if (login.status !== 200) throw new Error('隔离压测登录失败')
    const cookie = login.headers.getSetCookie()[0].split(';')[0]
    const png = largePng()
    const uploadBody = JSON.stringify({
      name: 'isolated-large-image.png',
      mime: 'image/png',
      data: png.toString('base64')
    })
    const batches = []
    const batch = async (name, count, concurrency, call) => {
      const latencies = [],
        errors = {},
        start = performance.now()
      let cursor = 0
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (cursor < count) {
            const index = cursor++,
              requestStart = performance.now()
            const response = await call(index),
              content = await response.json()
            latencies.push(performance.now() - requestStart)
            if (!response.ok) {
              const key = `${response.status}:${content.code || 'uncoded'}`
              errors[key] = (errors[key] || 0) + 1
            }
          }
        })
      )
      batches.push({
        name,
        requests: count,
        requestConcurrency: concurrency,
        p95Ms: percentile(latencies, 0.95),
        elapsedMs: performance.now() - start,
        errors
      })
    }
    for (const concurrency of [1, 10, 30])
      await batch('session-and-metrics', 90, concurrency, (index) =>
        fetch(base + (index % 10 === 0 ? '/runtime/metrics' : '/session'), {
          headers: { Cookie: cookie }
        })
      )
    await batch('large-real-png-upload', 4, 2, () =>
      fetch(base + '/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: uploadBody
      })
    )
    const metrics = await (
      await fetch(base + '/runtime/metrics', { headers: { Cookie: cookie } })
    ).json()
    const report = {
      generatedAt: new Date().toISOString(),
      isolated: true,
      database: 'run-specific disk SQLite; no production access',
      data: {
        orders: 0,
        screenshots: 4,
        screenshotBytes: png.length,
        screenshotDimensions: [1440, 1440]
      },
      batches,
      metrics,
      limitation:
        'Runtime endpoint and upload load only. Request concurrency is not an online-user count; no production deployment or phone-delivery proof.'
    }
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    return { directory, report }
  } finally {
    await new Promise((resolveClosed) => server.close(resolveClosed))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { directory, report } = await runRuntimePressure()
  console.log(
    JSON.stringify(
      {
        directory,
        data: report.data,
        batches: report.batches,
        exportQueueWaitMs: report.metrics.controls?.maxExportWaitMs,
        pushQueueWaitMs: report.metrics.push?.oldestDueWaitMs
      },
      null,
      2
    )
  )
}
