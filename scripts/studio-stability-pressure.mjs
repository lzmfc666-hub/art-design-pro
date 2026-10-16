import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomBytes, randomUUID, createECDH, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { deflateSync } from 'node:zlib'
import webpush from 'web-push'
import { createStudioServer } from '../server/index.mjs'
import { createStudioService } from '../server/studio.mjs'
import { createPlayerNotifications } from '../server/player-notifications.mjs'
import { backupStudioDatabase, restoreStudioDatabase } from './studio-backup.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'
import { runPlayerClientLoad } from './studio-pressure-client-load.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const qaRoot = process.env.STUDIO_FINAL_QA_ROOT
  ? resolve(process.env.STUDIO_FINAL_QA_ROOT, 'pressure')
  : join(root, '.qa', 'backend-stability-pressure')
const round = (value) => Math.round(value * 100) / 100
const counts = { orders: 1000, players: 100, customers: 50, poolOptedIn: 10, pushDevices: 3 }
const percentile = (values, percent) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * percent) - 1)] || 0

// A genuine, valid PNG just below the application's 8 MiB limit; no fake magic-only image.
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
function largePng(width = 1440) {
  const height = width,
    rowSize = width * 4 + 1,
    raw = randomBytes(rowSize * height)
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

async function worker() {
  let server,
    directory,
    dbPath,
    sampleTimer,
    peakRss = 0,
    seeded,
    simulatedClockOffset = -360_000
  let pushCalls = 0
  const sampleMemory = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  process.on('message', async (message) => {
    try {
      if (message.kind === 'stop') {
        clearInterval(sampleTimer)
        if (server) server.close(() => process.exit(0))
        else process.exit(0)
        return
      }
      if (message.kind === 'start') {
        if (server) throw new Error('worker already started')
        mkdirSync(qaRoot, { recursive: true })
        directory = mkdtempSync(join(qaRoot, 'isolated-'))
        dbPath = join(directory, 'studio.sqlite')
        // Explicit empty/mocked options prevent reading or using actual secret configurations.
        const clock = () => new Date(Date.now() + simulatedClockOffset)
        const password = `stability-fixture-${randomUUID()}`
        const notificationOptions = {
          ...webpush.generateVAPIDKeys(),
          subject: 'mailto:isolated-pressure@example.com',
          allowedPushHosts: [],
          clock,
          scanBatchSize: 100,
          sendBatchSize: 20,
          sendConcurrency: 2,
          pushSender: async () => {
            pushCalls++
            await new Promise((done) => setTimeout(done, 2))
          }
        }
        server = createStudioServer({
          dbPath,
          seed: false,
          password,
          clock,
          trustedProxies: [],
          notificationIntervalMs: 3_600_000,
          notifications: notificationOptions,
          backups: {
            intervalMinutes: 0,
            directory: join(directory, 'scheduled-backups'),
            failureWebhook: ''
          },
          runtime: {
            claimRate: 200,
            uploadRate: 100,
            uploadConcurrency: 8,
            uploadPerUser: 2,
            exportConcurrency: 1,
            exportQueueLimit: 4,
            exportWaitMs: 30_000,
            diskWarningBytes: 256 * 1024 ** 2,
            diskMinimumBytes: 64 * 1024 ** 2,
            walWarningBytes: 256 * 1024 ** 2
          }
        })
        sampleTimer = setInterval(sampleMemory, 100)
        sampleTimer.unref()
        const service = server.service
        const snapshot = () =>
          JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
        const mutate = (path, body, actor = 'admin') =>
          service.mutate(actor, path, { requestId: randomUUID(), ...body })
        const seedStart = performance.now()
        const level = mutate('/levels', { name: '独立稳定性压测等级', delaySeconds: 0 })
        const platform = mutate('/platforms', {
          name: '独立稳定性压测平台',
          rules: {
            requiresShop: false,
            requiresExternalOrderNo: false,
            requiresReceipt: false,
            allowPayOnArrival: true
          }
        })
        const template = mutate('/templates', {
          name: '隔离测试订单',
          game: '隔离测试',
          amount: 10000,
          reward: 7000,
          active: true
        })
        const support = mutate('/users', {
          username: 'isolated-support',
          name: '隔离客服',
          role: 'support',
          status: 'active',
          password,
          maxActiveOrders: 1,
          permissionOverrides: {}
        })
        mutate('/salary-plans', {
          userId: support.id,
          mode: 'fixed',
          base: 0,
          rate: null,
          platformRates: {},
          effectiveFrom: '2026-01-01',
          hourlyEnabled: false
        })
        const players = []
        for (let index = 0; index < counts.players; index++) {
          const user = mutate('/users', {
            username: `isolated-player-${index}`,
            name: `隔离打手${index}`,
            role: 'player',
            status: 'active',
            password,
            levelId: level.id,
            maxActiveOrders: 1,
            permissionOverrides: {}
          })
          players.push(user)
          if (index < counts.poolOptedIn)
            mutate(
              '/player/notification-settings',
              { pool: true, push: index < counts.pushDevices },
              user.id
            )
          if (index < counts.pushDevices) {
            const key = createECDH('prime256v1')
            key.generateKeys()
            mutate(
              '/player/push-subscriptions',
              {
                subscription: {
                  endpoint: `https://fcm.googleapis.com/fcm/send/isolated-${index}`,
                  keys: {
                    p256dh: key.getPublicKey().toString('base64url'),
                    auth: randomBytes(16).toString('base64url')
                  }
                }
              },
              user.id
            )
          }
          sampleMemory()
        }
        const customers = []
        for (let index = 0; index < counts.customers; index++)
          customers.push(
            mutate('/customers', {
              name: `隔离客户${index}`,
              platformId: platform.id,
              gameId: `TEST-${index}`,
              contact: '',
              remark: ''
            })
          )
        for (let index = 0; index < counts.orders; index++)
          mutate(
            '/orders',
            {
              templateId: template.id,
              customerId: customers[index % counts.customers].id,
              platformId: platform.id,
              roomCode: `R${index}`,
              gameId: `G${index}`,
              amount: 10000,
              reward: 7000,
              receivedAmount: 10000,
              paidAt: clock().toISOString(),
              externalOrderNo: `ISOLATED-${index}`,
              dispatchMode: index < 800 ? 'pool' : 'direct',
              assignedTo: index < 800 ? null : players[index % counts.players].id,
              remark: '内部压测备注不可公开',
              playerRemark: '打手可见压测说明'
            },
            support.id
          )
        // Nonempty capacity pages use real business writes, never synthetic wallet balances.
        const qr = service.upload(players[0].id, { name: 'isolated-payment.png', mime: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=' })
        mutate('/player/payment-methods', { method: 'wechat', qrCode: qr }, players[0].id)
        for (let index = 0; index < 25; index++) {
          mutate('/player-adjustments', { userId: players[0].id, kind: 'supplement', amount: 100, reason: '隔离容量流水' })
          const withdrawal = mutate('/player/withdrawals', { amount: 10, paymentMethod: 'wechat' }, players[0].id)
          mutate(`/player/withdrawals/${withdrawal.id}/cancel`, {}, players[0].id)
        }
        const state = snapshot()
        const cookies = {
          admin: `studio_session=${service.login('admin', password).token}`,
          support: `studio_session=${service.login(support.username, password).token}`,
          players: players.map(
            (user) =>
              `studio_player_session=${service.login(user.username, password, { requiredRole: 'player' }).token}`
          )
        }
        simulatedClockOffset = 0
        const realClockStartedAt = Date.now()
        await new Promise((done) => server.listen(0, '127.0.0.1', done))
        seeded = { snapshot, notificationOptions, cookies, realClockStartedAt }
        sampleMemory()
        process.send({
          kind: 'ready',
          id: message.id,
          base: `http://127.0.0.1:${server.address().port}/api/studio`,
          directory,
          cookies,
          actorIds: { admin: 'admin', support: support.id },
          playerIds: players.map((user) => user.id),
          customerId: customers[0].id,
          orderIdentities: state.orders.slice(0, 30).map((row) => ({
            id: row.id,
            revision: row.revision,
            dispatchRound: row.dispatchRound
          })),
          seedMs: round(performance.now() - seedStart),
          databaseBytes: statSync(dbPath).size
        })
        return
      }
      if (!server) throw new Error('worker not started')
      if (message.kind === 'scan') {
        const latencies = [],
          start = performance.now()
        let processed = 0,
          inserted = 0,
          batches = 0,
          remaining = Infinity
        while (remaining && batches < 3000) {
          const began = performance.now(),
            result = server.notifications.scanTimeouts({ limit: 100 })
          latencies.push(performance.now() - began)
          processed += result.processed
          inserted += result.inserted
          remaining = result.remaining
          batches++
          assert.ok(result.processed <= 100)
          await new Promise((done) => setImmediate(done))
        }
        assert.equal(remaining, 0)
        sampleMemory()
        process.send({
          kind: 'scan',
          id: message.id,
          batches,
          processed,
          inserted,
          elapsedMs: round(performance.now() - start),
          maxBatchMs: round(Math.max(...latencies)),
          p95BatchMs: round(percentile(latencies, 0.95)),
          queue: server.notifications.queueStats()
        })
        return
      }
      if (message.kind === 'push') {
        const secondDb = new DatabaseSync(dbPath)
        secondDb.exec('PRAGMA busy_timeout=5000')
        const second = createPlayerNotifications(secondDb, seeded.notificationOptions)
        const beforeCalls = pushCalls,
          start = performance.now()
        let batches = 0
        try {
          while (server.notifications.queueStats().pending && batches++ < 2000) {
            await Promise.all([server.notifications.flushPush(), second.flushPush()])
          }
          const sent = server.service.db
            .prepare("SELECT COUNT(*) AS count FROM player_push_outbox WHERE status='sent'")
            .get().count
          assert.equal(pushCalls, sent)
          assert.equal(server.notifications.queueStats().pending, 0)
          assert.equal(server.notifications.queueStats().processing, 0)
          const waitingGroups = { normalClock: [], advancedFixtureClock: [] }
          for (const row of server.service.db.prepare("SELECT created_at,sent_at FROM player_push_outbox WHERE status='sent'").all()) {
            const group = Date.parse(row.created_at) < seeded.realClockStartedAt ? 'advancedFixtureClock' : 'normalClock'
            waitingGroups[group].push(Math.max(0, Date.parse(row.sent_at) - Date.parse(row.created_at)))
          }
          const queueWaitByClock = Object.fromEntries(Object.entries(waitingGroups).map(([name, values]) => [name,
            { count: values.length, meanMs: round(values.reduce((sum,value)=>sum+value,0)/Math.max(1,values.length)),
              p50Ms: round(percentile(values,.5)), p95Ms: round(percentile(values,.95)), maxMs: round(Math.max(0,...values)),
              ...(name==='advancedFixtureClock'?{deliberateClockAdvanceMs:360000,productionLatency:false}:{}) }]))
          process.send({
            kind: 'push',
            id: message.id,
            elapsedMs: round(performance.now() - start),
            batches,
            senderCalls: pushCalls - beforeCalls,
            totalSenderCalls: pushCalls,
            sentRows: sent,
            queue: server.notifications.queueStats(),
            queueWaitByClock,
            simulationOnly: true,
            externalProviderCalls: 0
          })
        } finally {
          second.close()
          secondDb.close()
        }
        return
      }
      if (message.kind === 'backup') {
        const start = performance.now(),
          backupPath = join(directory, 'verified-backup.sqlite'),
          restoredPath = join(directory, 'verified-restored.sqlite')
        await backupStudioDatabase(dbPath, backupPath)
        const sourceCustomerId = seeded.snapshot().customers[0].id
        const sourceBalance = server.service.customerBalance('admin', sourceCustomerId).balance
        server.service.mutate('admin', '/customer-transactions', { requestId: randomUUID(), customerId: sourceCustomerId,
          kind: 'recharge', amount: 1, reason: '备份后恢复前源库新交易保留验证' })
        await restoreStudioDatabase(backupPath, restoredPath)
        const recovered = new DatabaseSync(restoredPath, { readOnly: true })
        const baseline = new DatabaseSync(backupPath, { readOnly: true })
        let restored
        try {
          assert.equal(Object.values(recovered.prepare('PRAGMA integrity_check').get())[0], 'ok')
          const original = JSON.parse(baseline.prepare('SELECT json FROM studio_state WHERE id=1').get().json),
            copied = JSON.parse(
              recovered.prepare('SELECT json FROM studio_state WHERE id=1').get().json
            )
          assert.deepEqual(copied, original)
          restored = {
            orders: copied.orders.length,
            players: copied.users.filter((row) => row.role === 'player').length,
            uploads: recovered.prepare('SELECT COUNT(*) AS count FROM uploads').get().count,
            notifications: recovered
              .prepare('SELECT COUNT(*) AS count FROM player_notifications')
              .get().count,
            pushOutbox: recovered.prepare('SELECT COUNT(*) AS count FROM player_push_outbox').get()
              .count
          }
          const tables = recovered.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
          const tableDigest = (database, name) => {
            const hash = createHash('sha256')
            let rows = 0
            for (const record of database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).iterate()) {
              const safe = Object.fromEntries(Object.entries(record).map(([key,value]) => [key, value instanceof Uint8Array
                ? { bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') } : value]))
              hash.update(JSON.stringify(safe)); rows++
            }
            return { rows, sha256: hash.digest('hex') }
          }
          restored.tables = {}
          for (const { name } of tables) {
            const expected = tableDigest(baseline, name), actual = tableDigest(recovered, name)
            assert.deepEqual(actual, expected, `full restored table content: ${name}`)
            restored.tables[name] = actual
          }
          restored.sessionPolicy = { copiedSessions: restored.tables.sessions.rows,
            rule: 'Full offline copy preserves session hashes/expiry; expiry and revocation rules remain. Revoke old sessions explicitly before an authorized production switch.' }
          restored.pushPolicy = { subscriptions: restored.tables.player_push_subscriptions.rows,
            externalSends: 0, rule: 'Offline copy never starts a sender; subscription/outbox/lease state is preserved. Do not run source and restored production senders together.' }
          assert.equal(server.service.customerBalance('admin', copied.customers[0].id).balance, sourceBalance + 1)
          assert.deepEqual(JSON.parse(recovered.prepare('SELECT json FROM studio_state WHERE id=1').get().json), copied)
          restored.sourceNewTransactionPreserved = true
        } finally {
          recovered.close()
          baseline.close()
        }
        // Exercise session policy on a second offline disposable copy, preserving verified-restored.
        const policyPath = join(directory, 'offline-policy-probe.sqlite')
        await restoreStudioDatabase(backupPath, policyPath)
        let policyClock = new Date()
        const policyService = createStudioService({ dbPath: policyPath, seed: false,
          password: 'offline-policy-isolated-unused-password', clock: () => policyClock })
        const policyNotifications = createPlayerNotifications(policyService.db, { clock: () => policyClock,
          publicKey: '', privateKey: '', subject: '', allowedPushHosts: [],
          pushSender: async () => { throw new Error('offline recovery must never send push') } })
        try {
          const oldToken = seeded.cookies.players[0].split('=')[1]
          assert.ok(policyService.session(oldToken, { readOnly: true }))
          policyClock = new Date(Date.now() + 13 * 60 * 60 * 1000)
          assert.equal(policyService.session(oldToken, { readOnly: true }), null)
          policyClock = new Date()
          policyService.logout(oldToken)
          assert.equal(policyService.session(oldToken, { readOnly: true }), null)
          policyService.db.prepare('DELETE FROM sessions').run()
          for (const { user_id } of policyService.db.prepare('SELECT DISTINCT user_id FROM player_push_subscriptions').all())
            policyNotifications.revoke(user_id)
          assert.equal(policyService.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
          assert.equal(policyService.db.prepare('SELECT COUNT(*) AS n FROM player_push_subscriptions').get().n, 0)
          assert.equal(policyService.db.prepare("SELECT COUNT(*) AS n FROM player_push_outbox WHERE status IN ('pending','processing')").get().n, 0)
          restored.sessionPolicy.offlineProbe = { unexpiredOldTokenAccepted: true, advancedClockExpired: true,
            logoutRevoked: true, explicitSessionResetOnProbe: true }
          restored.pushPolicy.offlineProbe = { explicitRevocationOnProbe: true, pendingOrProcessing: 0, externalSends: 0 }
          assert.equal(server.service.db.prepare('SELECT COUNT(*) AS n FROM player_push_subscriptions').get().n, counts.pushDevices)
        } finally { policyNotifications.close(); policyService.close() }
        process.send({
          kind: 'backup',
          id: message.id,
          elapsedMs: round(performance.now() - start),
          integrity: 'ok',
          restored,
          backupBytes: statSync(backupPath).size,
          restoredBytes: statSync(restoredPath).size
        })
        return
      }
      if (message.kind === 'metrics') {
        sampleMemory()
        process.send({
          kind: 'metrics',
          id: message.id,
          memory: process.memoryUsage(),
          sampledPeakRssBytes: peakRss,
          cpu: process.cpuUsage(),
          runtime: server.runtime.metrics(server.service.db),
          push: server.notifications.queueStats()
        })
      }
    } catch (error) {
      process.send({ kind: 'worker-error', id: message.id, error: error.message })
    }
  })
}

async function main() {
  const child = fork(fileURLToPath(import.meta.url), ['--isolated-worker'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += data.toString().slice(-2000)
  })
  const command = (kind) =>
    new Promise((done, reject) => {
      const id = randomUUID(),
        timeout = setTimeout(() => finish(new Error(`isolated worker timed out: ${kind}`)), 300_000)
      const onExit = () => finish(new Error(`isolated worker exited: ${stderr.slice(-1200)}`))
      const onMessage = (value) => {
        if (value.id !== id) return
        if (value.kind === 'worker-error') finish(new Error(value.error))
        else if (value.kind === kind || (kind === 'start' && value.kind === 'ready'))
          finish(null, value)
      }
      function finish(error, value) {
        clearTimeout(timeout)
        child.off('message', onMessage)
        child.off('exit', onExit)
        if (error) reject(error)
        else done(value)
      }
      child.on('message', onMessage)
      child.once('exit', onExit)
      child.send({ kind, id })
    })
  const report = {
    generatedAt: new Date().toISOString(),
    isolated: true,
    environment: {
      node: process.version,
      platform: process.platform,
      database: 'run-specific disk SQLite WAL',
      serverProcess: 'separate child process',
      host: 'random loopback port',
      push: 'mocked provider only'
    },
    data: counts,
    phases: [],
    checks: [],
    sourceBefore: sourceFingerprint(),
    limitations: [
      'Request concurrency is not an online-user count.',
      'This is local validation; no formal deployment or phone-delivery proof.',
      'The fixture advances its simulated business clock by 6 minutes to exercise assignment timeouts; maximum push queue age includes that deliberate advance.',
      'Sampled RSS may miss short memory peaks; raw fixture database is disposable and contains only fabricated records.'
    ]
  }
  let output = join(qaRoot, 'latest.json')
  let httpRequests = 0
  try {
    const context = await command('start')
    assert.ok(resolve(context.directory).startsWith(resolve(qaRoot) + sep))
    output = join(context.directory, 'report.json')
    report.data = {
      ...counts,
      fixtureClockAdvanceMs: 360_000,
      seedMs: context.seedMs,
      initialDatabaseBytes: context.databaseBytes
    }
    const { base, cookies, actorIds, customerId, orderIdentities } = context
    const request = async (path, role = 'admin', body) => {
      httpRequests++
      const started = performance.now(),
        playerIndex = typeof role === 'number' ? role : null
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: playerIndex == null ? cookies[role] : cookies.players[playerIndex],
          ...(playerIndex == null ? {} : { 'X-Studio-Client': 'player' }),
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'X-Studio-Actor':
                  playerIndex == null ? actorIds[role] : context.playerIds[playerIndex]
              })
        },
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
      })
      const text = await response.text()
      return {
        status: response.status,
        ms: performance.now() - started,
        bytes: Buffer.byteLength(text),
        data: JSON.parse(text)
      }
    }
    const phase = async (name, concurrency, total, action, allowed = [200]) => {
      let cursor = 0
      const latencies = [],
        statuses = {},
        failures = [],
        start = performance.now()
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (cursor < total) {
            const index = cursor++
            try {
              const result = await action(index)
              latencies.push(result.ms)
              statuses[result.status] = (statuses[result.status] || 0) + 1
              if (!allowed.includes(result.status))
                failures.push({
                  index,
                  status: result.status,
                  code: result.data.code || null,
                  message: result.data.message
                })
            } catch (error) {
              failures.push({ index, error: error.message })
            }
          }
        })
      )
      const result = {
        name,
        requestConcurrency: concurrency,
        requests: total,
        elapsedMs: round(performance.now() - start),
        p50Ms: round(percentile(latencies, 0.5)),
        p95Ms: round(percentile(latencies, 0.95)),
        maxMs: round(Math.max(...latencies)),
        throughputPerSecond: round(total / ((performance.now() - start) / 1000)),
        statuses,
        unexpectedErrors: failures.length,
        failures
      }
      report.phases.push(result)
      console.log(JSON.stringify(result))
      assert.equal(failures.length, 0, `${name}: unexpected errors`)
      return result
    }
    const mixed = (index) => {
      const playerIndex = index % counts.players
      const requests = [
        () => request(`/orders?current=${(index % 4) + 1}&size=20&status=pending`),
        () => request(`/player/orders?current=${(index % 4) + 1}&size=20&scope=all`, playerIndex),
        () => request('/player/changes?since=previous', playerIndex),
        () => request('/player/profile', playerIndex),
        () => request('/notifications/timeouts?current=1&size=20', 'support'),
        () => request('/exports/catalog'),
        () => request('/players?current=1&size=20'),
        () => request('/runtime/metrics')
        ,() => request('/player/orders?current=2&size=20&scope=all&keyword=隔离测试', playerIndex)
        ,() => request('/player/orders?current=1&size=20&scope=mine&sortBy=participatedAt', playerIndex)
        ,() => request('/player/wallet?includeRecords=false', playerIndex)
        ,() => request('/player/withdrawals?current=2&size=20&status=canceled', 0)
        ,() => request('/player/wallet/ledger?current=2&size=20', 0)
        ,() => request('/player/push-subscriptions/status', playerIndex)
      ]
      return requests[index % requests.length]()
    }
    const adminPage = await request('/orders?current=1&size=20')
    assert.equal(adminPage.status, 200)
    assert.equal(adminPage.data.total, counts.orders)
    assert.equal(adminPage.data.records.length, 20)
    const playerPage = await request('/player/orders?current=1&size=20&scope=pool', 99)
    assert.equal(playerPage.status, 200)
    assert.equal(playerPage.data.total, 800)
    for (const value of playerPage.data.records) {
      assert.equal(value.playerRemark, '打手可见压测说明')
      assert.equal(Object.hasOwn(value, 'amount'), false)
      assert.equal(Object.hasOwn(value, 'receipt'), false)
      assert.equal(JSON.stringify(value).includes('内部压测备注不可公开'), false)
    }
    assert.equal((await request('/orders?current=1&size=20', 0)).status, 403)
    assert.equal((await request('/exports/catalog', 'support')).status, 403)
    report.checks.push(
      'Server paging totals and explicit player remarks verified; customer amount/internal remark/export permissions isolated.'
    )
    for (const concurrency of [1, 10, 30, 50])
      await phase('mixed-paged-shared-reads', concurrency, 240, mixed)
    const withdrawalsPage = await request('/player/withdrawals?current=2&size=20&status=canceled', 0)
    assert.equal(withdrawalsPage.data.total, 25)
    assert.equal(withdrawalsPage.data.records.length, 5)
    const ledgerPage = await request('/player/wallet/ledger?current=2&size=20', 0)
    assert.equal(ledgerPage.data.total, 75)
    assert.equal(ledgerPage.data.records.length, 20)
    const summary = await request('/player/wallet?includeRecords=false', 0)
    assert.equal(summary.data.available, 2500)
    assert.deepEqual(summary.data.ledger, [])
    const withdrawalRace = await phase('withdrawal-balance-race', 10, 10, index => request('/player/withdrawals', 0,
      { requestId: `disk-withdraw-${index}`, amount: 2500, paymentMethod: 'wechat' }), [200,409])
    assert.equal(withdrawalRace.statuses[200], 1)
    assert.equal(withdrawalRace.statuses[409], 9)
    report.checks.push('Nonempty withdrawal/ledger pages retain exact totals; authoritative summary and concurrent withdrawals prevent double occupancy.')
    await phase('customer-credit-distinct', 25, 50, (index) =>
      request('/customer-transactions', 'admin', {
        customerId,
        kind: 'recharge',
        amount: 100,
        reason: '隔离测试充值',
        requestId: `distinct-${index}`
      })
    )
    const retryBody = {
      customerId,
      kind: 'recharge',
      amount: 100,
      reason: '隔离丢响应重试',
      requestId: 'lost-response-stable-id'
    }
    await phase('successful-response-loss-retries', 30, 60, () =>
      request('/customer-transactions', 'admin', retryBody)
    )
    assert.equal((await request(`/customers/${customerId}/balance`)).data.balance, 5100)
    report.checks.push('50 distinct credits and 60 identical retries persisted exactly 51 credits.')
    const first = orderIdentities[0]
    const claimRace = await phase(
      'same-order-claims',
      10,
      10,
      (index) =>
        request(`/player/orders/${first.id}/claim`, index, {
          requestId: `claim-race-${index}`,
          expectedRevision: first.revision,
          dispatchRound: first.dispatchRound
        }),
      [200, 409]
    )
    assert.equal(claimRace.statuses[200], 1)
    assert.equal(claimRace.statuses[409], 9)
    const capacityRace = await phase(
      'same-player-multiple-orders',
      10,
      10,
      (index) => {
        const order = orderIdentities[index + 1]
        return request(`/player/orders/${order.id}/claim`, 99, {
          requestId: `capacity-race-${index}`,
          expectedRevision: order.revision,
          dispatchRound: order.dispatchRound
        })
      },
      [200, 409]
    )
    assert.equal(capacityRace.statuses[200], 1)
    assert.equal(capacityRace.statuses[409], 9)
    report.checks.push(
      'Same order and same player across multiple orders: one winner each, no over-claim.'
    )
    const png = largePng(),
      body = JSON.stringify({
        name: 'isolated-real-large.png',
        mime: 'image/png',
        data: png.toString('base64')
      })
    assert.ok(png.length < 8 * 1024 ** 2 && png.length > 7.5 * 1024 ** 2)
    report.data.largeScreenshot = { bytes: png.length, dimensions: [1440, 1440] }
    await phase('large-real-png-uploads', 2, 4, () => request('/uploads', 'admin', body))
    const protectedUploads = await phase(
      'upload-concurrency-protection',
      6,
      6,
      () => request('/uploads', 'admin', body),
      [200, 429]
    )
    assert.ok(protectedUploads.statuses[429] > 0)
    const tooLarge = largePng(1450)
    assert.ok(tooLarge.length > 8 * 1024 ** 2)
    assert.equal(
      (
        await request(
          '/uploads',
          'admin',
          JSON.stringify({
            name: 'isolated-overlimit.png',
            mime: 'image/png',
            data: tooLarge.toString('base64')
          })
        )
      ).status,
      400
    )
    report.checks.push(
      'Valid ~8 MiB PNG uploads pass; oversized image and excess simultaneous uploads are rejected.'
    )
    const scanning = command('scan')
    await phase('mixed-reads-during-batched-notification-scan', 10, 240, mixed)
    report.notificationScan = await scanning
    console.log(JSON.stringify({ notificationScan: report.notificationScan }))
    report.pushDelivery = await command('push')
    report.checks.push(
      'Notification scan bounded to 100 recipients per transaction; two durable lease workers use only a simulated provider.'
    )
    for (let player = 0; player < 3; player++)
      assert.equal((await request('/player/notifications/read-all', player, {})).status, 200)
    report.realClientLoad = await runPlayerClientLoad({ apiBase: base.replace(/\/api\/studio$/, ''),
      cookies: cookies.players.slice(0, 3), playerIds: context.playerIds.slice(0, 3),
      output: join(context.directory, 'real-client-load') })
    assert.equal(report.realClientLoad.success, true)
    const selected = {
      period: { type: 'total' },
      modules: [{ id: 'orders', fields: ['orderNo', 'status', 'amount', 'playerRemark'] }]
    }
    const preview = await request('/exports/preview', 'admin', selected)
    assert.equal(preview.status, 200)
    await phase('selected-order-exports-with-queue', 4, 12, () =>
      request('/exports/download', 'admin', selected)
    )
    report.backupRecovery = await command('backup')
    report.checks.push(
      'Full SQLite online backup restored to another isolated disk path; business JSON, uploads, outbox, messages and idempotency counts match.'
    )
    const measured = await command('metrics')
    report.server = {
      endRssMiB: round(measured.memory.rss / 1024 ** 2),
      sampledPeakRssMiB: round(measured.sampledPeakRssBytes / 1024 ** 2),
      heapUsedMiB: round(measured.memory.heapUsed / 1024 ** 2),
      cpu: measured.cpu,
      runtime: measured.runtime,
      push: measured.push
    }
    const metrics = await request('/runtime/metrics')
    assert.equal(metrics.status, 200)
    report.queueWaiting = {
      exportMaxWaitMs: metrics.data.controls?.maxExportWaitMs || 0,
      pushMeanWaitMs: metrics.data.push.meanQueueWaitMs,
      pushMaxWaitMs: metrics.data.push.maxQueueWaitMs,
      pushOldestDueWaitMs: metrics.data.push.oldestDueWaitMs
    }
    report.unexpectedErrors = report.phases.reduce((sum, row) => sum + row.unexpectedErrors, 0)
    report.requestCounts = { phaseRequests: report.phases.reduce((sum,row) => sum + row.requests,0),
      directHttpRequests: httpRequests, realClientRequests: report.realClientLoad.requestCount,
      note: 'Direct count includes explicit checks and read-all preparation. Browser requests are separate actual app traffic.' }
    report.success = true
  } catch (error) {
    report.success = false
    report.error = error.message
    process.exitCode = 1
  } finally {
    report.sourceAfter = sourceFingerprint()
    report.sourceUnchanged = report.sourceBefore.digest === report.sourceAfter.digest
    if (!report.sourceUnchanged) { report.success = false; report.sourceChangeError = 'Source changed during pressure acceptance'; process.exitCode = 1 }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 })
    writeFileSync(join(qaRoot, 'latest.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    if (child.connected) {
      const exited = new Promise((done) => child.once('exit', done))
      child.send({ kind: 'stop' })
      await exited
    }
    console.log(
      JSON.stringify({
        success: report.success,
        output,
        unexpectedErrors: report.unexpectedErrors,
        queueWaiting: report.queueWaiting,
        error: report.error
      })
    )
  }
}

if (process.argv.includes('--isolated-worker')) await worker()
else await main()
