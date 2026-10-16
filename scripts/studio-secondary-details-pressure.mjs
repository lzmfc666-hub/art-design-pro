import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createStudioServer } from '../server/index.mjs'
import { testMutate } from '../tests/helpers/current-intent.mjs'
import { sourceFingerprint } from './studio-source-fingerprint.mjs'

// Short, local read comparison only. No production settings, data or servers are used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = process.env.STUDIO_FINAL_QA_ROOT
  ? resolve(process.env.STUDIO_FINAL_QA_ROOT, 'statistics-pressure')
  : join(root, '.qa', 'secondary-details-20261014', 'pressure')
const shortRange = { start: '2026-10-08', end: '2026-10-14' }
const longRange = { start: '2025-10-14', end: '2026-10-14' }
const counts = { orders: 1000, players: 100, customers: 50, completed: 100, canceled: 20 }
const views = {
  received: ['days', 'paid-orders', 'by-game', 'by-project', 'by-platform'],
  orders: ['paid-orders', 'created-orders', 'completed-orders', 'canceled-orders', 'by-status'],
  customers: ['paying-customers', 'repeat-customers', 'by-game'],
  profit: ['days', 'cost-orders'], people: ['new-staff', 'new-players', 'current-people', 'unknown-date'],
  wallet: ['balances', 'paid-withdrawals', 'in-flight-withdrawals'],
  accepted: ['assignments', 'accepted-orders', 'by-player'],
  expenses: ['expense-records', 'reward-adjustments'], personal: ['completed-orders', 'by-game']
}
const combinations = Object.entries(views).flatMap(([metric, rows]) => rows.map((view) => ({ metric, view })))
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const round = (value) => Math.round(value * 100) / 100
const percentile = (rows, q) => [...rows].sort((a, b) => a - b)[Math.max(0, Math.ceil(rows.length * q) - 1)] || 0
const digest = (value) => createHash('sha256').update(value).digest('hex')
const summarize = (rows, elapsedMs) => ({
  requests: rows.length, p50Ms: round(percentile(rows.map((row) => row.ms), .5)),
  p95Ms: round(percentile(rows.map((row) => row.ms), .95)), maxMs: round(Math.max(0, ...rows.map((row) => row.ms))),
  throughputRequestsPerSecond: elapsedMs ? round(rows.length * 1000 / elapsedMs) : 0,
  statusCounts: Object.fromEntries([...new Set(rows.map((row) => row.status))].sort().map((status) =>
    [status, rows.filter((row) => row.status === status).length]))
})

async function worker() {
  let server, timer, directory, pushCalls = 0, clock = new Date('2025-10-14T04:00:00Z')
  const memory = []
  const sample = () => {
    const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage()
    memory.push({ at: new Date().toISOString(), rss, heapUsed, external, arrayBuffers })
  }
  const invariant = () => {
    const db = server.service.db
    const json = db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
    const state = JSON.parse(json)
    const tables = ['fund_transactions', 'financial_requests', 'business_requests', 'audit_logs',
      'audit_logs_archive', 'uploads', 'player_notifications', 'player_push_outbox']
    const tableCounts = Object.fromEntries(tables.map((table) => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      return [table, exists ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null]
    }))
    return {
      stateHash: digest(json), dataVersion: state.dataVersion, tableCounts,
      entityCounts: Object.fromEntries(['orders', 'users', 'customers', 'refunds', 'withdrawals',
        'expenses', 'rewardCredits', 'playerAdjustments'].map((key) => [key, state[key]?.length || 0])),
      sqliteChanges: db.prepare('SELECT total_changes() AS n').get().n,
      fundsHash: digest(JSON.stringify(db.prepare('SELECT * FROM fund_transactions ORDER BY id').all()))
    }
  }
  process.on('message', async (message) => {
    const { id, kind } = message
    try {
      if (kind === 'snapshot') {
        sample()
        process.send({ id, kind: 'snapshot', invariant: invariant(), memory,
          pushCalls, fileBytes: statSync(join(directory, 'studio.sqlite')).size,
          walBytes: existsSync(join(directory, 'studio.sqlite-wal')) ? statSync(join(directory, 'studio.sqlite-wal')).size : 0 })
        return
      }
      if (kind === 'stop') {
        clearInterval(timer)
        if (server) await new Promise((done) => server.close(done))
        process.send({ id, kind: 'stopped' })
        process.exit(0)
      }
      if (kind !== 'start' || server) throw new Error('Unexpected isolated worker command')
      mkdirSync(outputRoot, { recursive: true })
      directory = mkdtempSync(join(outputRoot, 'isolated-'))
      const password = `isolated-read-${randomUUID()}`
      server = createStudioServer({
        dbPath: join(directory, 'studio.sqlite'), seed: false, password, clock: () => clock,
        monitor: message.monitor || {}, releaseId: message.releaseId ?? null,
        maintenanceFromEnv: false, trustedProxies: [], notificationIntervalMs: 3_600_000,
        notifications: { clock: () => clock, publicKey: '', privateKey: '', subject: '',
          allowedPushHosts: [], pushSender: async () => { pushCalls++ } },
        backups: { intervalMinutes: 0, directory: join(directory, 'unused-backups'), failureWebhook: '' },
        uploadCleanup: { enabled: false }, runtime: { claimRate: 200 }
      })
      timer = setInterval(sample, 100)
      timer.unref()
      const service = server.service
      const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
      const seededAt = performance.now()
      const level = mutate('/levels', { name: '隔离读取等级', delaySeconds: 0 })
      mutate('/platforms', { id: 'hall', name: '游戏大厅', rules: {
        requiresShop: false, requiresExternalOrderNo: false, requiresReceipt: false, allowPayOnArrival: true
      } })
      const support = mutate('/users', { username: 'isolated-read-support', name: '隔离客服', role: 'support',
        status: 'active', password, maxActiveOrders: 5, permissionOverrides: {} })
      mutate('/salary-plans', { userId: support.id, mode: 'fixed', base: 0, rate: null,
        platformRates: {}, effectiveFrom: '2025-01-01', hourlyEnabled: false })
      const players = []
      for (let i = 0; i < counts.players; i++) {
        players.push(mutate('/users', { username: `isolated-read-player-${i}`, name: `隔离打手[${String(i).padStart(3, '0')}]`,
          role: 'player', status: 'active', password, levelId: level.id, maxActiveOrders: 5, permissionOverrides: {} }))
        if (i % 20 === 0) process.send({ kind: 'progress', text: `隔离造数：打手 ${i + 1}/${counts.players}` })
      }
      const customers = Array.from({ length: counts.customers }, (_, i) => mutate('/customers', {
        name: `隔离客户[${String(i).padStart(3, '0')}]`, contact: `PRIVATE-CONTACT-${i}`,
        gameId: `PRIVATE-CUSTOMER-${i}`, remark: 'PRIVATE-CUSTOMER-REMARK'
      }))
      const templates = Array.from({ length: 6 }, (_, i) => mutate('/templates', {
        name: `隔离项目[${i}]`, game: `隔离游戏[${i % 3}]`, amount: 10000, reward: 7000,
        description: 'PRIVATE-TEMPLATE-DESCRIPTION', active: true
      }))
      const orders = []
      for (let i = 0; i < counts.orders; i++) {
        const date = i < 250
          ? new Date(Date.parse('2025-10-15T04:00:00Z') + (i % 250) * 86400000)
          : new Date(Date.parse('2026-10-08T04:00:00Z') + Math.floor((i - 250) * 7 / 750) * 86400000)
        clock = date
        orders.push(mutate('/orders', { templateId: templates[i % templates.length].id,
          customerId: customers[i % customers.length].id, platformId: 'hall',
          roomCode: `PRIVATE-ROOM-${i}`, gameId: `PRIVATE-GAME-${i}`, amount: 10000, reward: 7000,
          receivedAmount: 10000, paidAt: date.toISOString(), dispatchMode: i < 800 ? 'pool' : 'direct',
          assignedTo: i < 800 ? null : players[i % players.length].id,
          remark: 'PRIVATE-INTERNAL-REMARK', playerRemark: '隔离打手可见说明' }, support.id))
        if (i % 100 === 0) { sample(); process.send({ kind: 'progress', text: `隔离造数：订单 ${i + 1}/${counts.orders}` }) }
      }
      clock = new Date('2026-10-14T04:00:00Z')
      for (let i = 0; i < counts.completed; i++) {
        const player = players[i], order = orders[i]
        mutate(`/player/orders/${order.id}/claim`, {}, player.id)
        const image = service.upload(player.id, { name: 'isolated-material.png', mime: 'image/png', data: PNG })
        mutate(`/player/orders/${order.id}/submit`, { screenshots: [image] }, player.id)
        mutate(`/orders/${order.id}/action`, { action: 'review-pass' })
      }
      for (let i = counts.completed; i < counts.completed + counts.canceled; i++)
        mutate(`/orders/${orders[i].id}/action`, { action: 'cancel', reason: '隔离取消' })
      for (let i = 0; i < 7; i++) mutate('/expenses', { category: `隔离费用[${i}]`,
        amount: 1000 + i, date: `2026-10-${String(8 + i).padStart(2, '0')}`, purpose: 'PRIVATE-EXPENSE-REASON',
        receipt: service.upload('admin', { name: 'isolated-expense.png', mime: 'image/png', data: PNG }) })
      for (let i = 0; i < 20; i++) {
        mutate('/player-adjustments', { userId: players[i].id, kind: 'supplement', amount: 100, reason: 'PRIVATE-ADJUSTMENT-REASON' })
        mutate('/player-adjustments', { userId: players[i].id, kind: 'deduction', amount: 40, reason: 'PRIVATE-ADJUSTMENT-REASON' })
      }
      for (let i = 0; i < 50; i++) {
        const player = players[i]
        const qrCode = service.upload(player.id, { name: 'isolated-private-qr.png', mime: 'image/png', data: PNG })
        mutate('/player/payment-methods', { method: 'wechat', qrCode }, player.id)
        const row = mutate('/player/withdrawals', { amount: 1000, paymentMethod: 'wechat' }, player.id)
        if (i < 20) mutate(`/withdrawals/${row.id}/action`, { action: 'approve' })
        if (i < 10) {
          const receipt = service.upload('admin', { name: 'isolated-paid.png', mime: 'image/png', data: PNG })
          mutate(`/withdrawals/${row.id}/action`, { action: 'pay', receipt })
        }
        if (i >= 30 && i < 40) mutate(`/player/withdrawals/${row.id}/cancel`, {}, player.id)
        if (i >= 40) mutate(`/withdrawals/${row.id}/action`, { action: 'reject', reason: '隔离驳回' })
      }
      const cookies = {
        admin: `studio_session=${service.login('admin', password).token}`,
        support: `studio_session=${service.login(support.username, password).token}`,
        players: players.map((row) => `studio_player_session=${service.login(row.username, password, { requiredRole: 'player' }).token}`)
      }
      await new Promise((done) => server.listen(0, '127.0.0.1', done))
      await server.notifications.flushPush()
      const state = JSON.parse(service.db.prepare('SELECT json FROM studio_state').get().json)
      const model = {
        orders: state.orders.map((row) => ({ id: row.id, orderNo: row.orderNo, title: row.title,
          customerId: row.customerId, paidAt: row.paidAt, createdAt: row.createdAt, canceledAt: row.canceledAt,
          completedAt: row.completedAt, status: row.status, assignedTo: row.assignedTo, leaderId: row.leaderId,
          dispatchMode: row.dispatchMode, game: row.snapshot.game, project: row.snapshot.name })),
        customerNames: customers.map((row) => row.name),
        users: state.users.map((row) => ({ id: row.id, name: row.name, role: row.role, createdAt: row.createdAt })),
        playerIds: players.map((row) => row.id), playerNames: players.map((row) => row.name)
      }
      sample()
      process.send({ id, kind: 'ready', directory, base: `http://127.0.0.1:${server.address().port}/api/studio`,
        cookies, model, seedDurationMs: round(performance.now() - seededAt), invariant: invariant() })
    } catch (error) {
      process.send({ id, kind: 'error', message: error.message, stack: error.stack })
    }
  })
}

async function parent() {
  const fingerprintBefore = sourceFingerprint()
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
    cwd: root, windowsHide: true, env: { ...process.env, STUDIO_NOTIFICATION_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  const pending = new Map()
  child.on('message', (message) => {
    if (message.kind === 'progress') { console.log(message.text); return }
    const task = pending.get(message.id)
    if (!task) return
    clearTimeout(task.timer)
    pending.delete(message.id)
    if (message.kind === 'error') task.reject(new Error(message.stack || message.message))
    else task.resolve(message)
  })
  child.on('exit', (code) => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(`Isolated worker exited: ${code}`)) }
    pending.clear()
  })
  const rpc = (kind) => new Promise((resolveTask, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker ${kind} timed out`)) }, 180_000)
    pending.set(id, { resolve: resolveTask, reject, timer })
    child.send({ id, kind })
  })
  let ready, finalSnapshot, failure = null
  const requests = [], phases = [], validation = []
  let phase = 'setup'
  try {
    ready = await rpc('start')
    writeFileSync(join(ready.directory, 'source-before.json'), JSON.stringify(fingerprintBefore, null, 2))
    const call = async (path, cookie, kind, expectedStatus = 200) => {
      const started = performance.now()
      const record = { phase, kind, path, status: 0, expectedStatus, ms: 0 }
      requests.push(record)
      try {
        const response = await fetch(ready.base + path, { headers: { Cookie: cookie || '',
          ...(String(cookie).includes('studio_player_session=') ? { 'X-Studio-Client': 'player' } : {}) },
          signal: AbortSignal.timeout(90_000) })
        record.status = response.status
        const body = await response.json()
        assert.equal(record.status, expectedStatus, `${path}: ${JSON.stringify(body).slice(0, 300)}`)
        return body
      } catch (error) {
        record.error = error.message
        throw error
      } finally {
        record.ms = performance.now() - started
      }
    }
    const day = (value) => value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10) : null
    const included = (value, range) => day(value) && day(value) >= range.start && day(value) <= range.end
    const expected = (metric, view, range) => {
      const rows = ready.model.orders, paid = rows.filter((row) => included(row.paidAt, range))
      const completed = rows.filter((row) => row.status === 'completed' && included(row.completedAt, range))
      const cases = {
        'received/days': (Date.parse(range.end) - Date.parse(range.start)) / 86400000 + 1,
        'received/paid-orders': paid.length, 'received/by-game': new Set(paid.map((row) => row.game)).size,
        'received/by-project': new Set(paid.map((row) => row.project)).size, 'received/by-platform': 1,
        'orders/paid-orders': paid.length, 'orders/created-orders': rows.filter((row) => included(row.createdAt, range)).length,
        'orders/completed-orders': completed.length, 'orders/canceled-orders': rows.filter((row) => included(row.canceledAt, range)).length,
        'orders/by-status': new Set(paid.map((row) => row.status)).size,
        'customers/paying-customers': new Set(paid.map((row) => row.customerId)).size,
        'customers/repeat-customers': new Set(paid.map((row) => row.customerId)).size,
        'customers/by-game': new Set(paid.map((row) => row.game)).size,
        'profit/days': (Date.parse(range.end) - Date.parse(range.start)) / 86400000 + 1,
        'profit/cost-orders': paid.length, 'people/new-staff': ready.model.users.filter((row) => row.role !== 'player' && included(row.createdAt, range)).length,
        'people/new-players': ready.model.users.filter((row) => row.role === 'player' && included(row.createdAt, range)).length,
        'people/current-people': ready.model.users.length, 'people/unknown-date': ready.model.users.filter((row) => !row.createdAt).length,
        'wallet/balances': 100, 'wallet/paid-withdrawals': 10, 'wallet/in-flight-withdrawals': 20,
        'accepted/assignments': 100, 'accepted/accepted-orders': 100, 'accepted/by-player': 100,
        'expenses/expense-records': 7, 'expenses/reward-adjustments': 40,
        'personal/completed-orders': completed.length, 'personal/by-game': new Set(completed.map((row) => row.game)).size
      }
      return cases[`${metric}/${view}`]
    }
    const detailPath = (metric, view, range = shortRange, extra = {}) => '/overview/details?' +
      new URLSearchParams({ metric, view, ...range, current: '1', size: '7', ...extra })
    const checkDetail = (body, metric, view, range, expectedTotal = expected(metric, view, range)) => {
      assert.equal(body.total, expectedTotal, `${metric}/${view} full total`)
      assert.equal(body.records.length, Math.min(Math.max(0, expectedTotal - (body.current - 1) * body.size), body.size))
      assert.deepEqual(body.summary, body.overview.metrics)
      assert.deepEqual(body.range.start, range.start)
      assert.deepEqual(body.range.end, range.end)
      assert.equal(body.groups.length, body.groupsInfo.returned)
      assert.equal(body.groupsInfo.truncated, body.groupsInfo.total > 100)
      const paidCount = ready.model.orders.filter((row) => included(row.paidAt, range)).length
      assert.equal(body.summary.received, paidCount * 10000)
      assert.equal(body.summary.orderCount, paidCount)
      assert.equal(body.summary.playerAvailable, 671200)
      assert.equal(body.summary.playerOccupied, 20000)
      assert.equal(body.summary.playerPaid, 10000)
      assert.equal(body.summary.expenses, 8221)
      assert.equal(body.summary.personalCompletedOrders, 0)
      assert.equal(body.capabilities.terminal.supported, false)
      assert.ok(!JSON.stringify(body.records).includes('PRIVATE-'))
      assert.ok(body.records.every((row) => Object.values(row).every((value) => value === null || typeof value !== 'object')))
    }
    // Admin did not create the support's orders. Personal detail must stay empty for admin.
    const personalExpected = (metric, view, range) => metric === 'personal' ? 0 : expected(metric, view, range)
    phase = 'validation-366-days'
    for (const { metric, view } of combinations) {
      const started = performance.now()
      const body = await call(detailPath(metric, view, longRange), ready.cookies.admin, 'admin-detail')
      if (metric === 'personal') {
        assert.equal(body.total, 0)
        assert.equal(body.summary.personalCompletedOrders, 0)
        assert.deepEqual(body.summary, body.overview.metrics)
      } else checkDetail(body, metric, view, longRange)
      validation.push({ rangeDays: 366, metric, view, total: body.total, ms: round(performance.now() - started) })
    }
    phase = 'validation-short-range'
    for (const { metric, view } of combinations) {
      const body = await call(detailPath(metric, view), ready.cookies.admin, 'admin-detail')
      if (metric === 'personal') {
        assert.equal(body.total, 0)
        assert.equal(body.summary.personalCompletedOrders, 0)
      } else checkDetail(body, metric, view, shortRange)
      validation.push({ rangeDays: 7, metric, view, total: body.total })
    }
    for (const range of [longRange, shortRange]) {
      for (const view of ['completed-orders', 'by-game']) {
        const own = await call(detailPath('personal', view, range), ready.cookies.support, 'admin-own-detail')
        assert.equal(own.total, view === 'completed-orders' ? 100 : 3)
        assert.equal(own.records.length, view === 'completed-orders' ? 7 : 3)
        assert.equal(own.summary.personalCompletedOrders, 100)
        assert.equal(own.summary.personalNet, 1000000)
        assert.equal(own.groups.reduce((sum, row) => sum + row.amount, 0), own.summary.personalNet)
        assert.equal(own.groupsInfo.amountLabel, '本人有效业绩')
        assert.equal(own.groupsInfo.countLabel, '本人完成订单数')
        assert.deepEqual(own.summary, own.overview.metrics)
        validation.push({ rangeDays: range === longRange ? 366 : 7, metric: 'personal', view,
          actor: 'support-own', total: own.total })
      }
    }
    const exactOrder = ready.model.orders.at(-1).orderNo
    checkDetail(await call(detailPath('received', 'paid-orders', shortRange, { keyword: exactOrder }),
      ready.cookies.admin, 'admin-detail'), 'received', 'paid-orders', shortRange, 1)
    checkDetail(await call(detailPath('received', 'paid-orders', shortRange, { keyword: 'PRIVATE-INTERNAL-REMARK' }),
      ready.cookies.admin, 'admin-detail'), 'received', 'paid-orders', shortRange, 0)
    checkDetail(await call(detailPath('orders', 'paid-orders', shortRange, { current: '80', size: '10' }),
      ready.cookies.admin, 'admin-detail'), 'orders', 'paid-orders', shortRange)
    await call(detailPath('received', 'paid-orders'), ready.cookies.support, 'expected-denial', 403)
    await call(detailPath('received', 'paid-orders'), ready.cookies.players[0], 'expected-denial', 403)
    await call(detailPath('received', 'paid-orders'), '', 'expected-denial', 401)
    const unsupported = await call(detailPath('received', 'by-terminal'), ready.cookies.admin, 'expected-unsupported', 400)
    assert.equal(unsupported.code, 'OVERVIEW_VIEW_UNSUPPORTED')
    const playerPaths = ['/player/profile', '/player/changes', '/player/orders?current=1&size=20&scope=all',
      '/player/orders?current=1&size=20&scope=mine&keyword=', '/player/wallet?includeRecords=false']
    const playerTask = (index) => ({ kind: 'player-read', index: index % 100, path: playerPaths[index % playerPaths.length] })
    const checkPlayer = (body, task) => {
      if (task.path.includes('/orders?')) {
        const playerId = ready.model.playerIds[task.index]
        const authorized = ready.model.orders.filter((row) => task.path.includes('scope=mine')
          ? row.leaderId === playerId
          : row.leaderId === playerId || (row.status === 'pending' &&
            (row.dispatchMode === 'pool' || row.assignedTo === playerId)))
        assert.equal(body.total, authorized.length)
        assert.equal(body.records.length, Math.min(20, body.total))
      }
      if (task.path.includes('/wallet?')) {
        const index = task.index
        const adjusted = index < 20 ? 60 : 0
        const occupied = index >= 10 && index < 30 ? 1000 : 0
        const paid = index < 10 ? 1000 : 0
        assert.equal(body.earned, 7000 + adjusted)
        assert.equal(body.occupied, occupied)
        assert.equal(body.available, 7000 + adjusted - occupied - paid)
        assert.deepEqual(body.ledger, [])
        assert.deepEqual(body.withdrawals, [])
      }
      assert.ok(!JSON.stringify(body).includes('PRIVATE-CONTACT-'))
      assert.ok(!JSON.stringify(body).includes('PRIVATE-INTERNAL-REMARK'))
    }
    const runTask = async (task) => {
      if (task.kind === 'player-read') {
        checkPlayer(await call(task.path, ready.cookies.players[task.index], task.kind), task)
      } else {
        const body = await call(detailPath(task.metric, task.view, shortRange, { current: String(task.page) }),
          ready.cookies.admin, task.kind)
        assert.equal(body.total, personalExpected(task.metric, task.view, shortRange))
        assert.equal(body.records.length, Math.min(Math.max(0, body.total - (body.current - 1) * body.size), body.size))
        assert.deepEqual(body.summary, body.overview.metrics)
      }
    }
    phase = 'warmup'
    for (let index = 0; index < 100; index++) await runTask(playerTask(index))
    const concurrency = 8, playerRequestsPerPhase = 400, adminRequestsPerMixedPhase = 160
    const mixedTasks = () => {
      const tasks = [], playerTasks = Array.from({ length: playerRequestsPerPhase }, (_, i) => playerTask(i))
      const adminTasks = Array.from({ length: adminRequestsPerMixedPhase }, (_, i) => ({
        ...combinations[i % combinations.length], kind: 'admin-detail', page: i % 3 + 1
      }))
      while (playerTasks.length || adminTasks.length) {
        tasks.push(...playerTasks.splice(0, 5), ...adminTasks.splice(0, 2))
      }
      return tasks
    }
    for (const name of ['baseline-before', 'mixed-first', 'mixed-second', 'baseline-after']) {
      phase = name
      const before = requests.length, started = performance.now()
      const tasks = name.startsWith('baseline') ? Array.from({ length: playerRequestsPerPhase }, (_, i) => playerTask(i)) : mixedTasks()
      let cursor = 0
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (cursor < tasks.length) { const task = tasks[cursor++]; await runTask(task) }
      }))
      const elapsed = performance.now() - started, rows = requests.slice(before)
      const sampled = await rpc('snapshot')
      phases.push({ name, concurrency, durationMs: round(elapsed), all: summarize(rows, elapsed),
        players: summarize(rows.filter((row) => row.kind === 'player-read'), elapsed),
        adminDetails: summarize(rows.filter((row) => row.kind === 'admin-detail'), elapsed),
        workerMemoryLatest: sampled.memory.at(-1) })
      assert.deepEqual(sampled.invariant, ready.invariant, `${name} changed business/funds state`)
      console.log(`${name}: ${rows.length} HTTP，P95 ${round(percentile(rows.map((row) => row.ms), .95))}ms`)
    }
    finalSnapshot = await rpc('snapshot')
    assert.deepEqual(finalSnapshot.invariant, ready.invariant)
    assert.equal(finalSnapshot.pushCalls, 0)
  } catch (error) {
    failure = { message: error.message, stack: error.stack }
    console.error(error.stack)
  } finally {
    if (ready && !finalSnapshot) { try { finalSnapshot = await rpc('snapshot') } catch {} }
    const fingerprintAfter = sourceFingerprint()
    const stable = fingerprintAfter.digest === fingerprintBefore.digest
    if (!stable && !failure) failure = { message: 'Source changed during read evidence; rerun after freezing.' }
    if (ready) {
      writeFileSync(join(ready.directory, 'source-after.json'), JSON.stringify(fingerprintAfter, null, 2))
      const unexpected = requests.filter((row) => row.status !== row.expectedStatus || row.error)
      const report = {
        success: !failure, kind: 'local-isolated-read-comparison', generatedAt: new Date().toISOString(),
        directory: ready.directory, data: counts, database: 'real disk SQLite, new isolated file',
        httpRequests: requests.length, expectedConflict409: requests.filter((row) => row.status === 409 && row.expectedStatus === 409).length,
        expectedDenials: requests.filter((row) => [401, 403].includes(row.status) && row.status === row.expectedStatus).length,
        unexpectedErrors: unexpected.length, unexpected: unexpected.slice(0, 20), failure,
        seedDurationMs: ready.seedDurationMs, validation, phases,
        invariantBefore: ready.invariant, invariantAfter: finalSnapshot?.invariant,
        readonlyUnchanged: finalSnapshot ? JSON.stringify(finalSnapshot.invariant) === JSON.stringify(ready.invariant) : false,
        source: { before: fingerprintBefore.digest, after: fingerprintAfter.digest, stable, files: Object.keys(fingerprintBefore.files).length },
        memory: { workerSamples: finalSnapshot?.memory || [],
          peakRss: Math.max(0, ...(finalSnapshot?.memory || []).map((row) => row.rss)),
          peakHeapUsed: Math.max(0, ...(finalSnapshot?.memory || []).map((row) => row.heapUsed)), intervalMs: 100 },
        fakePushCalls: finalSnapshot?.pushCalls, databaseFileBytes: finalSnapshot?.fileBytes,
        databaseWalBytes: finalSnapshot?.walBytes,
        notes: [
          '本机短混合读取证据，不是正式服务器容量，8个HTTP请求槽不能换算在线人数。',
          'ABBA顺序：打手基线→混合→混合→打手基线；同数据同进程，前置29视图/366天校验及warmup已预热磁盘和运行时。',
          '混合每轮保留400个打手请求并加入160个后台详情，共用8个并发槽；调度比例和缓存不同，不能归因为单一功能成本。',
          '请求耗时包含HTTP响应接收及JSON解析；phase吞吐含校验开销。后台CPU和内存由独立子进程采样，100ms采样会遗漏短峰值。',
          '所用业务时钟固定于2026-10-14以避免会话续期/提醒产生业务变动；耗时与吞吐使用真实单调时钟，不是模拟等待。',
          '未配置真实推送且发送器为本地stub，维护配置环境关闭；不证明手机到达、HTTPS、移动网络或正式部署。',
          '本脚本只覆盖读取；本轮资金写幂等、8MiB图片、备份恢复及队列压力由现有 studio-stability-pressure.mjs 在同一本轮最终源码版本另行顺序复跑，最终交付引用各自实际报告。'
        ]
      }
      writeFileSync(join(ready.directory, 'report.json'), JSON.stringify(report, null, 2))
      writeFileSync(join(ready.directory, 'requests.json'), JSON.stringify(requests, null, 2))
      console.log(`只读混合报告：${join(ready.directory, 'report.json')}；success=${report.success}`)
    }
    try { await rpc('stop') } catch { child.kill() }
    if (failure) process.exitCode = 1
  }
}

if (process.argv.includes('--worker')) await worker()
else await parent()
