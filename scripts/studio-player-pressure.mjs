import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createStudioServer } from '../server/index.mjs'
import { testMutate, installTestClientFetch } from '../tests/helpers/current-intent.mjs'

installTestClientFetch()

// Disposable in-memory data only. Requests never target the user's running server or database.
const password = `isolated-${randomUUID()}`
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
let time = new Date('2026-10-13T04:00:00Z')
const app = createStudioServer({
  dbPath: ':memory:',
  seed: false,
  password,
  clock: () => time,
  notifications: { clock: () => time },
  notificationIntervalMs: 60000,
  runtime: { claimRate: 100 }
})
const service = app.service
const mutate = (path, body) => testMutate(service, 'admin', path, body)
const samples = []
const phases = []
const start = performance.now()
const round = (number) => Math.round(number * 100) / 100
const summarize = (rows) => {
  const times = rows.map((row) => row.ms).sort((a, b) => a - b)
  return {
    requests: rows.length,
    statusCounts: Object.fromEntries(
      [...new Set(rows.map((row) => row.status))].map((status) => [
        status,
        rows.filter((row) => row.status === status).length
      ])
    ),
    p50Ms: round(times[Math.floor((times.length - 1) * 0.5)] || 0),
    p95Ms: round(times[Math.floor((times.length - 1) * 0.95)] || 0),
    maxMs: round(times.at(-1) || 0)
  }
}
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${app.address().port}/api/studio`
const call = async (path, body, cookie = '') => {
  const began = performance.now()
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const data = await response.json()
  const row = { status: response.status, ms: performance.now() - began }
  samples.push(row)
  return { ...row, data, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
const ok = async (...args) => {
  const result = await call(...args)
  assert.equal(result.status, 200, JSON.stringify(result.data))
  return result
}
const login = async (username) => (await ok('/login', { username, password })).cookie
const phase = async (name, run) => {
  const offset = samples.length,
    began = performance.now()
  const extra = await run()
  phases.push({
    name,
    durationMs: round(performance.now() - began),
    ...summarize(samples.slice(offset)),
    ...extra
  })
}
let admin, players, cookies, makeOrder
try {
  const seededAt = performance.now()
  const level = mutate('/levels', { name: '压测等级', delaySeconds: 0 })
  players = Array.from({ length: 100 }, (_, index) =>
    mutate('/users', {
      username: `pressure-player-${index}`,
      name: `压测打手${index + 1}`,
      role: 'player',
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 1,
      permissionOverrides: {},
      password
    })
  )
  const platform = mutate('/platforms', {
    name: '隔离测试平台',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const customer = mutate('/customers', {
    name: '隔离客户',
    contact: 'PRIVATE-CONTACT',
    remark: 'PRIVATE-REMARK'
  })
  const template = mutate('/templates', {
    name: '隔离订单',
    game: '测试游戏',
    description: '服务目标',
    amount: 2000,
    reward: 1001,
    map: '不限',
    remark: 'PRIVATE-TEMPLATE-NOTE',
    active: true
  })
  makeOrder = () =>
    mutate('/orders', {
      customerId: customer.id,
      templateId: template.id,
      platformId: platform.id,
      roomCode: 'PRIVATE-ROOM',
      gameId: 'PRIVATE-GAME',
      amount: 2000,
      reward: 1001,
      receivedAmount: 2000,
      paidAt: time.toISOString(),
      dispatchMode: 'pool'
    })
  const orders = Array.from({ length: 120 }, makeOrder)
  for (const index of [80, 81, 82, 83, 90, 91, 92])
    mutate('/player-adjustments', {
      userId: players[index].id,
      kind: 'supplement',
      amount: 10000,
      reason: '隔离压测补款',
      requestId: randomUUID()
    })
  phases.push({
    name: 'seed',
    accounts: 100,
    orders: 120,
    durationMs: round(performance.now() - seededAt)
  })
  admin = await login('admin')
  await phase('100-account-login', async () => {
    cookies = []
    for (let offset = 0; offset < 100; offset += 10) {
      const batch = await Promise.all(
        players.slice(offset, offset + 10).map((row) => login(row.username))
      )
      cookies.push(...batch)
    }
    return { concurrency: 10 }
  })
  const savedQrs = new Map()
  await phase('valid-png-upload-and-private-qr', async () => {
    await Promise.all(
      [80, 81, 82, 83, 90, 91, 92].map(async (index) => {
        const upload = await ok(
          '/uploads',
          { name: 'private-qr.png', mime: 'image/png', data: png },
          cookies[index]
        )
        savedQrs.set(index, upload.data)
        await ok(
          '/player/payment-methods',
          { method: 'wechat', qrCode: upload.data },
          cookies[index]
        )
      })
    )
    return { concurrency: 7, validUploads: 7 }
  })
  for (const concurrency of [10, 50])
    await phase(`read-load-${concurrency}`, async () => {
      const paths = [
        '/player/orders',
        '/player/wallet',
        '/player/leaderboard?type=orders&month=2026-10',
        '/player/leaderboard?type=withdrawals&month=2026-10',
        '/player/profile'
      ]
      for (let cycle = 0; cycle < 10; cycle++)
        await Promise.all(
          Array.from({ length: concurrency }, (_, index) =>
            ok(paths[(cycle + index) % paths.length], undefined, cookies[index])
          )
        )
      return { concurrency }
    })
  await phase('same-order-50-claimers', async () => {
    const outcomes = await Promise.all(
      cookies.slice(0, 50).map((cookie) => call(`/player/orders/${orders[0].id}/claim`, {}, cookie))
    )
    assert.equal(outcomes.filter((row) => row.status === 200).length, 1)
    assert.equal(outcomes.filter((row) => row.status === 409).length, 49)
    const snapshot = service.bootstrap('admin')
    assert.equal(
      snapshot.orders.filter((row) => row.id === orders[0].id && row.status === 'active').length,
      1
    )
    return { concurrency: 50, successfulClaims: 1, conflicts: 49 }
  })
  await phase('same-user-50-orders-cap', async () => {
    const outcomes = await Promise.all(
      orders.slice(1, 51).map((row) => call(`/player/orders/${row.id}/claim`, {}, cookies[99]))
    )
    assert.equal(outcomes.filter((row) => row.status === 200).length, 1)
    assert.equal(outcomes.filter((row) => row.status === 409).length, 49)
    assert.equal(service.playerProfile(players[99].id).activeOrders, 1)
    return { concurrency: 50, successfulClaims: 1, conflicts: 49 }
  })
  await phase('weekly-limit-50-parallel-withdrawals', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        call(
          '/player/withdrawals',
          {
            amount: 1,
            paymentMethod: 'wechat',
            requestId: randomUUID()
          },
          cookies[90]
        )
      )
    )
    assert.equal(outcomes.filter((row) => row.status === 200).length, 7)
    assert.equal(outcomes.filter((row) => row.status === 409).length, 43)
    const wallet = service.playerWallet(players[90].id)
    assert.equal(wallet.weeklyUsed, 7)
    assert.equal(wallet.occupied, 7)
    return { concurrency: 50, created: 7, rejectedByLimit: 43 }
  })
  await phase('50-identical-withdrawal-retries', async () => {
    const requestId = randomUUID(),
      body = { amount: 1, paymentMethod: 'wechat', requestId }
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => ok('/player/withdrawals', body, cookies[91]))
    )
    assert.equal(new Set(outcomes.map((row) => row.data.id)).size, 1)
    const wallet = service.playerWallet(players[91].id)
    assert.equal(wallet.weeklyUsed, 1)
    assert.equal(wallet.occupied, 1)
    return { concurrency: 50, retries: 50, created: 1 }
  })
  await phase('withdrawal-cancel-vs-finance-approve', async () => {
    const withdrawal = (
      await ok(
        '/player/withdrawals',
        { amount: 1, paymentMethod: 'wechat', requestId: randomUUID() },
        cookies[92]
      )
    ).data
    const outcomes = await Promise.all([
      call(`/player/withdrawals/${withdrawal.id}/cancel`, { requestId: randomUUID() }, cookies[92]),
      call(
        `/withdrawals/${withdrawal.id}/action`,
        { action: 'approve', requestId: randomUUID() },
        admin
      )
    ])
    assert.equal(outcomes.filter((row) => row.status === 200).length, 1)
    assert.equal(outcomes.filter((row) => row.status === 409).length, 1)
    return { concurrency: 2, effectiveResults: 1 }
  })
  await phase('A17-finance-correction-vs-late-player-actions', async () => {
    const order = makeOrder()
    await ok(`/player/orders/${order.id}/claim`, {}, cookies[80])
    const material = (
      await ok('/uploads', { name: 'completion.png', mime: 'image/png', data: png }, cookies[80])
    ).data
    await ok(
      `/orders/${order.id}/action`,
      { action: 'correct-status', status: 'completed', reason: '财务真实登记完成' },
      admin
    )
    const late = await Promise.all([
      call(`/player/orders/${order.id}/submit`, { screenshots: [material] }, cookies[80]),
      call(`/player/orders/${order.id}/return-request`, { reason: '已失效申请' }, cookies[80])
    ])
    assert.ok(late.every((row) => row.status === 409))
    const next = makeOrder()
    await ok(`/player/orders/${next.id}/claim`, {}, cookies[80])
    const request = (
      await ok(`/player/orders/${next.id}/return-request`, { reason: '先前退单' }, cookies[80])
    ).data.returnRequests.at(-1)
    await ok(
      `/orders/${next.id}/action`,
      { action: 'correct-status', status: 'review', reason: '财务登记待验收' },
      admin
    )
    const approval = await call(
      `/orders/${next.id}/action`,
      { action: 'return-approve', returnRequestId: request.id, reason: '晚到审批' },
      admin
    )
    assert.equal(approval.status, 409)
    assert.equal(service.playerOrderDetail(players[80].id, next.id).status, 'review')
    assert.equal(
      service.playerOrderDetail(players[80].id, next.id).returnRequests.at(-1).status,
      'obsolete'
    )
    const parallel = makeOrder()
    await ok(`/player/orders/${parallel.id}/claim`, {}, cookies[81])
    const competing = await Promise.all([
      call(`/player/orders/${parallel.id}/return-request`, { reason: '同时发起' }, cookies[81]),
      call(
        `/orders/${parallel.id}/action`,
        { action: 'correct-status', status: 'completed', reason: '财务确认完成' },
        admin
      )
    ])
    assert.equal(competing[1].status, 200)
    assert.ok([200, 409].includes(competing[0].status))
    const final = service.playerOrderDetail(players[81].id, parallel.id)
    assert.equal(final.status, 'completed')
    assert.ok(final.returnRequests.every((row) => row.status !== 'pending'))
    assert.equal(service.playerWallet(players[81].id).earned, 11001)
    return { staleActionsRejected: 3, parallelCorrectionPreserved: true }
  })
  await phase('override-permissions-private-data-security', async () => {
    const player = players[82]
    mutate('/users', {
      ...player,
      permissionOverrides: {
        'finance.withdrawals': true,
        'finance.refunds': true,
        'users.manage': true,
        'orders.view': true,
        'profit.view': true,
        'salary.all': true,
        'logs.view': true
      }
    })
    const own = mutate('/player-deposit-transactions', {
      userId: player.id,
      kind: 'deposit',
      amount: 10,
      reason: '本人押金',
      requestId: randomUUID()
    })
    mutate('/player-deposit-transactions', {
      userId: players[83].id,
      kind: 'deposit',
      amount: 999,
      reason: 'PRIVATE-OTHER-DEPOSIT',
      requestId: randomUUID()
    })
    const protectedResponses = await Promise.all([
      call(`/uploads/${savedQrs.get(83).id}`, undefined, cookies[82]),
      call(`/players/${players[83].id}/deposit`, undefined, cookies[82]),
      call('/players', undefined, cookies[82]),
      call('/logs', undefined, cookies[82]),
      call(
        `/orders/${orders[0].id}/action`,
        { action: 'correct-status', status: 'completed', reason: '非法' },
        cookies[82]
      )
    ])
    assert.ok(protectedResponses.every((row) => row.status === 403))
    const snapshot = (await ok('/bootstrap', undefined, cookies[82])).data
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE-CONTACT'), false)
    assert.deepEqual(snapshot.customers, [])
    const exported = await ok(
      '/exports/preview',
      {
        period: { type: 'total' },
        modules: [{ id: 'playerDepositTransactions', fields: ['accountId', 'amount', 'reason'] }]
      },
      cookies[82]
    )
    assert.equal(exported.data.sheets[0].rowCount, 1)
    assert.equal(JSON.stringify(exported.data).includes('PRIVATE-OTHER-DEPOSIT'), false)
    assert.equal(
      service.exportSnapshot(player.id, { modules: [{ id: 'playerDepositTransactions' }] })
        .playerDepositTransactions[0].id,
      own.id
    )
    return { overridesCannotReadOtherQr: true, forbiddenEndpoints: 5, ownExportRows: 1 }
  })
  await phase('A08-Shanghai-natural-week-and-crossweek-cancel', async () => {
    time = new Date('2026-10-18T15:59:59Z')
    const sundayCookie = await login(players[83].username)
    const sunday = []
    for (let index = 0; index < 7; index++)
      sunday.push(
        (
          await ok(
            '/player/withdrawals',
            {
              amount: 1,
              paymentMethod: 'wechat',
              requestId: randomUUID()
            },
            sundayCookie
          )
        ).data
      )
    assert.equal(service.playerWallet(players[83].id).weekStart, '2026-10-12')
    time = new Date('2026-10-18T16:00:00Z')
    assert.equal(service.playerWallet(players[83].id).weeklyRemaining, 7)
    for (let index = 0; index < 7; index++)
      await ok(
        '/player/withdrawals',
        {
          amount: 1,
          paymentMethod: 'wechat',
          requestId: randomUUID()
        },
        sundayCookie
      )
    await ok(
      `/player/withdrawals/${sunday[0].id}/cancel`,
      { requestId: randomUUID() },
      sundayCookie
    )
    assert.equal(service.playerWallet(players[83].id).weeklyRemaining, 0)
    const eighth = await call(
      '/player/withdrawals',
      { amount: 1, paymentMethod: 'wechat', requestId: randomUUID() },
      sundayCookie
    )
    assert.equal(eighth.status, 409)
    return { sundayApplications: 7, mondayApplications: 7, crossWeekRemaining: 0 }
  })
  const report = {
    generatedAt: new Date().toISOString(),
    environment: 'isolated in-memory SQLite + local real HTTP',
    accounts: 100,
    initialOrders: 120,
    ...summarize(samples),
    elapsedMs: round(performance.now() - start),
    phases,
    memoryMiB: round(process.memoryUsage().rss / 1024 / 1024),
    limitations:
      'Local request concurrency, not 50 real phones or production capacity. Static clock used for deterministic financial weeks.'
  }
  mkdirSync(new URL('../.qa/', import.meta.url), { recursive: true })
  writeFileSync(
    new URL('../.qa/player-pressure-results.json', import.meta.url),
    JSON.stringify(report, null, 2)
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  await new Promise((resolve) => app.close(resolve))
}
