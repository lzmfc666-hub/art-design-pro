import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createStudioServer } from '../server/index.mjs'
import { testMutate, installTestClientFetch } from '../tests/helpers/current-intent.mjs'

installTestClientFetch()

// Only a disposable, local SQLite database is accepted. Never target a running studio.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const count = 1000
const round = (n) => Math.round(n * 100) / 100

async function worker() {
  let server
  process.on('message', async (message) => {
    if (message.kind === 'stop') {
      return server.close(() => process.exit(0))
    }
    if (message.kind === 'metrics') {
      return process.send({
        kind: 'metrics',
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      })
    }
    if (message.kind !== 'start' || server) return
    const qaRoot = join(root, '.qa', 'pressure')
    mkdirSync(qaRoot, { recursive: true })
    const dbPath = join(mkdtempSync(join(qaRoot, 'isolated-')), 'studio.sqlite')
    const password = `pressure-${randomUUID()}`
    server = createStudioServer({ dbPath, seed: false, password })
    const service = server.service
    const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
    const level = mutate('/levels', { name: '压测等级', delaySeconds: 0 })
    const platform = mutate('/platforms', {
      name: '压测平台',
      rules: {
        requiresShop: false,
        requiresExternalOrderNo: false,
        requiresReceipt: false,
        allowPayOnArrival: true
      }
    })
    const template = mutate('/templates', {
      name: '压测订单',
      game: '测试游戏',
      amount: 10000,
      reward: 7000,
      active: true
    })
    const player = mutate('/users', {
      username: 'pressure-player',
      name: '压测打手',
      role: 'player',
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 100,
      permissionOverrides: {},
      password
    })
    const finance = mutate('/users', {
      username: 'pressure-finance',
      name: '压测财务',
      role: 'finance',
      status: 'active',
      maxActiveOrders: 1,
      permissionOverrides: {},
      password
    })
    const support = mutate('/users', {
      username: 'pressure-support',
      name: '压测客服',
      role: 'support',
      status: 'active',
      maxActiveOrders: 1,
      permissionOverrides: {},
      password
    })
    const operations = mutate('/users', {
      username: 'pressure-operations',
      name: '压测运营',
      role: 'operations',
      status: 'active',
      maxActiveOrders: 1,
      permissionOverrides: {},
      password
    })
    for (const person of [finance, support, operations])
      mutate('/salary-plans', {
        userId: person.id,
        mode: 'fixed',
        base: 0,
        rate: null,
        platformRates: {},
        effectiveFrom: '2026-01-01',
        hourlyEnabled: false
      })
    const customers = Array.from({ length: 50 }, (_, i) =>
      mutate('/customers', {
        name: `压测客户${i + 1}`,
        platformId: platform.id,
        contact: '',
        gameId: `P${i + 1}`,
        remark: ''
      })
    )
    const seedStart = performance.now()
    let firstOrder
    for (let i = 0; i < count; i++) {
      const order = mutate(
        '/orders',
        {
          templateId: template.id,
          customerId: customers[i % customers.length].id,
          platformId: platform.id,
          externalOrderNo: `PRESSURE-${i}`,
          gameId: `P${i}`,
          amount: 10000,
          reward: 7000,
          receivedAmount: 10000,
          paidAt: new Date().toISOString(),
          dispatchMode: 'pool'
        },
        support.id
      )
      firstOrder ||= order
    }
    const cookies = Object.fromEntries(
      [
        ['admin', 'admin'],
        ['player', player.username],
        ['finance', finance.username],
        ['support', support.username]
      ].map(([key, username]) => [key, `studio_session=${service.login(username, password).token}`])
    )
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
    const qrCode = service.upload(player.id, {
      name: 'isolated-qr.png',
      mime: 'image/png',
      data: png
    })
    mutate('/player/payment-methods', { method: 'wechat', qrCode }, player.id)
    await new Promise((res) => server.listen(0, '127.0.0.1', res))
    process.send({
      kind: 'ready',
      base: `http://127.0.0.1:${server.address().port}/api/studio`,
      cookies,
      customerId: customers[0].id,
      playerId: player.id,
      orderId: firstOrder.id,
      seedMs: round(performance.now() - seedStart),
      databaseBytes: statSync(dbPath).size
    })
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
    stderr += data.toString()
  })
  const message = (kind) =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => done(new Error(`Timed out waiting for ${kind}`)), 120000)
      const onExit = () => done(new Error(`Pressure worker exited: ${stderr.slice(-1000)}`))
      const onMessage = (value) => {
        if (value.kind === kind) done(null, value)
      }
      function done(error, value) {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        if (error) rej(error)
        else res(value)
      }
      child.on('message', onMessage)
      child.once('exit', onExit)
    })
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      database: 'isolated SQLite on disk',
      serverProcess: 'separate child process',
      host: 'loopback only'
    },
    data: { orders: count, customers: 50 },
    phases: [],
    checks: []
  }
  const output = join(root, '.qa', 'pressure', 'latest.json')
  try {
    const ready = message('ready')
    child.send({ kind: 'start' })
    const context = await ready
    report.data.seedMs = context.seedMs
    report.data.initialDatabaseBytes = context.databaseBytes
    const { base, cookies, customerId, playerId, orderId } = context
    const request = async (path, role = 'admin', body) => {
      const start = performance.now()
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookies[role],
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      })
      const text = await response.text()
      return {
        status: response.status,
        ms: performance.now() - start,
        bytes: Buffer.byteLength(text),
        data: JSON.parse(text)
      }
    }
    async function phase(name, concurrency, total, action, allowed = [200]) {
      let index = 0
      const samples = [],
        statuses = {},
        failures = []
      const start = performance.now()
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (index < total) {
            const i = index++
            try {
              const row = await action(i)
              samples.push(row.ms)
              statuses[row.status] = (statuses[row.status] || 0) + 1
              if (!allowed.includes(row.status))
                failures.push({ index: i, status: row.status, message: row.data.message })
            } catch (error) {
              failures.push({ index: i, error: error.message })
            }
          }
        })
      )
      samples.sort((a, b) => a - b)
      const elapsedMs = performance.now() - start
      const row = {
        name,
        concurrency,
        requests: total,
        elapsedMs: round(elapsedMs),
        rps: round((total * 1000) / elapsedMs),
        p50Ms: round(samples[Math.ceil(samples.length * 0.5) - 1] || 0),
        p95Ms: round(samples[Math.ceil(samples.length * 0.95) - 1] || 0),
        maxMs: round(samples.at(-1) || 0),
        statuses,
        failures
      }
      report.phases.push(row)
      console.log(JSON.stringify(row))
      assert.equal(failures.length, 0, name)
      return row
    }
    const paths = [
      '/bootstrap',
      '/overview',
      '/players?current=1&size=20',
      '/logs?current=1&size=20',
      '/logs/storage'
    ]
    for (const concurrency of [1, 10, 25, 50]) {
      await phase('mixed-reads', concurrency, 200, (i) => request(paths[i % paths.length]))
    }
    const initialBalance = (await request(`/customers/${customerId}/balance`, 'finance')).data
      .balance
    await phase('recharge-unique-writes', 25, 100, (i) =>
      request('/customer-transactions', 'finance', {
        customerId,
        kind: 'recharge',
        amount: 100,
        reason: '隔离并发充值测试',
        requestId: `pressure-unique-${i}`
      })
    )
    await phase('same-recharge-retry', 50, 100, () =>
      request('/customer-transactions', 'finance', {
        customerId,
        kind: 'recharge',
        amount: 100,
        reason: '隔离重复请求测试',
        requestId: 'pressure-same'
      })
    )
    assert.equal(
      (await request(`/customers/${customerId}/balance`, 'finance')).data.balance,
      initialBalance + 10100
    )
    report.checks.push('100 distinct credits persisted; 100 retries credited only once')
    const race = await phase(
      'same-order-claim-race',
      25,
      25,
      () => request(`/player/orders/${orderId}/claim`, 'player', {}),
      [200, 409]
    )
    assert.equal(race.statuses[200], 1)
    assert.equal(race.statuses[409], 24)
    report.checks.push('25 concurrent claims: exactly one winner')
    const completed = await request(`/orders/${orderId}/action`, 'finance', {
      action: 'correct-status',
      status: 'completed',
      leaderId: playerId,
      reason: '隔离压测后台结单',
      requestId: 'pressure-complete'
    })
    assert.equal(completed.status, 200, completed.data.message)
    const wallet = (await request('/player/wallet', 'player')).data
    assert.equal(wallet.available, 7000)
    const withdrawals = await phase(
      'same-wallet-withdrawal-race',
      25,
      25,
      () =>
        request('/player/withdrawals', 'player', {
          amount: 7000,
          paymentMethod: 'wechat',
          requestId: randomUUID()
        }),
      [200, 409]
    )
    assert.equal(withdrawals.statuses[200], 1)
    assert.equal(withdrawals.statuses[409], 24)
    report.checks.push('25 concurrent full-balance withdrawals: exactly one accepted, no overdraft')
    assert.equal((await request('/exports/catalog', 'support')).status, 403)
    report.checks.push('Customer support export prohibition remains enforced')
    await phase('full-order-export', 5, 10, () =>
      request('/exports/download', 'admin', {
        period: { type: 'total' },
        modules: [{ id: 'orders', fields: ['orderNo', 'status', 'amount'] }]
      })
    )
    const diagnostics = await request('/diagnostics')
    assert.equal(diagnostics.status, 200)
    assert.equal(diagnostics.data.summary.errorCount, 0)
    report.checks.push('Final read-only diagnostics: zero data consistency errors')
    report.diagnostics = diagnostics.data.summary
    const metrics = message('metrics')
    child.send({ kind: 'metrics' })
    const measured = await metrics
    report.server = {
      rssMiB: round(measured.memory.rss / 1024 ** 2),
      heapUsedMiB: round(measured.memory.heapUsed / 1024 ** 2),
      cpu: measured.cpu
    }
    report.success = true
  } catch (error) {
    report.success = false
    report.error = error.message
    process.exitCode = 1
  } finally {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(report, null, 2))
    if (child.connected) {
      const exited = new Promise((res) => child.once('exit', res))
      child.send({ kind: 'stop' })
      await exited
    }
    console.log(
      JSON.stringify({
        success: report.success,
        output,
        checks: report.checks,
        error: report.error
      })
    )
  }
}

if (process.argv.includes('--isolated-worker')) await worker()
else await main()
