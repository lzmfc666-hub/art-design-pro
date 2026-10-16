import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createStudioServer } from '../server/index.mjs'

// Raw transport intentionally avoids the legacy test client adapter: omission,
// actor mismatch, and authentication/body races must reach the actual HTTP guard.
// Every case creates its own disk database, random port, and test-only credentials.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

function rawCall(base, path, { body, cookie, actor, player = false } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolveReply, reject) => {
    const request = httpRequest(
      base + '/api/studio' + path,
      {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          ...(payload === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(actor === undefined ? {} : { 'X-Studio-Actor': actor }),
          ...(player ? { 'X-Studio-Client': 'player' } : {})
        }
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            resolveReply({
              status: response.statusCode,
              headers: response.headers,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8'))
            })
          } catch (error) {
            reject(error)
          }
        })
        response.on('error', reject)
      }
    )
    request.on('error', reject)
    request.setTimeout(10000, () => request.destroy(new Error('Isolated test request timed out')))
    request.end(payload)
  })
}

async function fixture(t) {
  const outputRoot = resolve('.qa/final-joint-ui/principal-tests')
  mkdirSync(outputRoot, { recursive: true })
  const output = mkdtempSync(join(outputRoot, 'case-'))
  let time = new Date('2026-10-14T05:00:00Z')
  const password = 'isolated-principal-' + randomUUID()
  const server = createStudioServer({
    dbPath: join(output, 'test.sqlite'),
    seed: false,
    password,
    clock: () => time,
    notificationIntervalMs: 86400000,
    backups: { intervalMinutes: 0, directory: join(output, 'backups'), failureWebhook: '' },
    uploadCleanup: { enabled: false },
    notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] }
  })
  const service = server.service
  const mutate = (path, body, user = 'admin') =>
    service.mutate(user, path, { requestId: randomUUID(), ...body })
  const level = mutate('/levels', { name: '认证竞争隔离等级', delaySeconds: 0 })
  const users = ['a', 'b'].map((suffix) =>
    mutate('/users', {
      username: 'isolated-principal-' + suffix,
      name: '认证验证' + suffix,
      role: 'player',
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 3,
      permissionOverrides: {},
      password
    })
  )
  const platform = mutate('/platforms', {
    name: '认证验证来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const customer = mutate('/customers', { name: '隔离认证客户', gameId: 'QA' })
  const template = mutate('/templates', {
    name: '隔离认证订单',
    game: 'QA',
    amount: 10000,
    reward: 7000,
    active: true
  })
  const order = () =>
    mutate('/orders', {
      templateId: template.id,
      customerId: customer.id,
      platformId: platform.id,
      roomCode: 'QA',
      dispatchMode: 'pool',
      amount: 10000,
      reward: 7000,
      receivedAmount: 10000,
      paidAt: time.toISOString()
    })
  const row = order()
  for (const user of users) {
    mutate('/player-adjustments', {
      userId: user.id,
      kind: 'supplement',
      amount: 10000,
      reason: '仅隔离测试可提现余额'
    })
    const qrCode = service.upload(user.id, { name: '隔离收款.png', mime: 'image/png', data: png })
    mutate('/player/payment-methods', { method: 'wechat', qrCode }, user.id)
  }
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  t.after(() => new Promise((close) => server.close(close)))
  const base = 'http://127.0.0.1:' + server.address().port
  const sessions = []
  for (const user of users) {
    const login = await rawCall(base, '/login', {
      body: { username: user.username, password },
      player: true
    })
    assert.equal(login.status, 200)
    sessions.push({
      cookie: login.headers['set-cookie'][0].split(';')[0],
      actor: user.id,
      player: true
    })
  }
  const current = () => service.orderDetail('admin', row.id).order
  const claimBody = () => ({
    requestId: randomUUID(),
    expectedRevision: current().revision,
    dispatchRound: current().dispatchRound
  })
  const moneyBody = () => ({ requestId: randomUUID(), amount: 5000, paymentMethod: 'wechat' })
  const criticalCounts = () => ({
    requests: Number(service.db.prepare('SELECT COUNT(*) AS n FROM business_requests').get().n),
    logs: Number(service.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n),
    notifications: Number(
      service.db.prepare('SELECT COUNT(*) AS n FROM player_notifications').get().n
    ),
    withdrawals: service.bootstrap('admin').withdrawals.length,
    assignments: current().assignments.length,
    revision: current().revision
  })
  return {
    server,
    service,
    base,
    users,
    row,
    sessions,
    current,
    claimBody,
    moneyBody,
    criticalCounts,
    mutate,
    advance: (milliseconds) => {
      time = new Date(time.valueOf() + milliseconds)
    }
  }
}

function delayedBody(f, path, body, session) {
  const payload = JSON.stringify(body)
  let signalAuthenticated
  const authenticated = new Promise((ready) => {
    signalAuthenticated = ready
  })
  const token = session.cookie.slice(session.cookie.indexOf('=') + 1)
  const originalSession = f.service.session
  f.service.session = function (candidate, ...args) {
    const result = originalSession.call(this, candidate, ...args)
    if (candidate === token && result?.id === session.actor) signalAuthenticated()
    return result
  }
  let request
  const response = new Promise((resolveReply, reject) => {
    request = httpRequest(
      f.base + '/api/studio' + path,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Cookie: session.cookie,
          'X-Studio-Actor': session.actor,
          'X-Studio-Client': 'player'
        }
      },
      (reply) => {
        const chunks = []
        reply.on('data', (chunk) => chunks.push(chunk))
        reply.on('end', () => {
          try {
            resolveReply({
              status: reply.statusCode,
              value: JSON.parse(Buffer.concat(chunks).toString())
            })
          } catch (error) {
            reject(error)
          }
        })
        reply.on('error', reject)
      }
    )
    request.on('error', reject)
    request.setTimeout(10000, () => request.destroy(new Error('Isolated delayed body timed out')))
    // Flush headers plus a valid beginning, keeping the JSON body intentionally incomplete.
    request.write(payload.slice(0, 1))
  })
  return {
    authenticated: Promise.race([
      authenticated,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Authentication was not observed before isolated test timeout')),
          5000
        )
        timer.unref()
        authenticated.finally(() => clearTimeout(timer))
      })
    ]),
    response,
    finish: () => request.end(payload.slice(1)),
    cancel: () => {
      response.catch(() => {})
      request.destroy()
    },
    restore: () => {
      f.service.session = originalSession
    }
  }
}

test('HTTP本人约束：缺少操作者与B会话携带A操作者均不能抢单或提现，也不提交日志消息幂等记录', async (t) => {
  const f = await fixture(t)
  const before = f.criticalCounts()
  for (const path of ['/player/orders/' + f.row.id + '/claim', '/player/withdrawals']) {
    const body = path.endsWith('/claim') ? f.claimBody() : f.moneyBody()
    const missing = await rawCall(f.base, path, { ...f.sessions[0], actor: undefined, body })
    assert.equal(missing.status, 409)
    assert.equal(missing.value.code, 'PRECONDITION_REQUIRED')
    const changed = await rawCall(f.base, path, {
      ...f.sessions[1],
      actor: f.users[0].id,
      body
    })
    assert.equal(changed.status, 409)
    assert.equal(changed.value.code, 'PRINCIPAL_CHANGED')
    assert.deepEqual(f.criticalCounts(), before)
    assert.equal(f.service.playerWallet(f.users[0].id).available, 10000)
    assert.equal(f.service.playerWallet(f.users[1].id).available, 10000)
  }
})

test('HTTP有效会话同意图重试返回原结果，退出后的原编号重试不能访问结果或再次抢单', async (t) => {
  const f = await fixture(t),
    body = f.claimBody(),
    path = '/player/orders/' + f.row.id + '/claim'
  const first = await rawCall(f.base, path, { ...f.sessions[0], body })
  assert.equal(first.status, 200)
  const after = f.criticalCounts()
  const retry = await rawCall(f.base, path, { ...f.sessions[0], body })
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.value, first.value)
  assert.deepEqual(f.criticalCounts(), after)
  assert.equal(f.current().assignments.length, 1)
  assert.equal((await rawCall(f.base, '/logout', { ...f.sessions[0], body: {} })).status, 200)
  const departed = f.criticalCounts()
  const denied = await rawCall(f.base, path, { ...f.sessions[0], body })
  assert.equal(denied.status, 401)
  assert.equal(denied.value.id, undefined)
  assert.deepEqual(f.criticalCounts(), departed)
})

test(
  'HTTP认证后请求体尚未收完时退出：事务重新验证token，旧抢单请求401且不落业务',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      path = '/player/orders/' + f.row.id + '/claim'
    const pending = delayedBody(f, path, f.claimBody(), f.sessions[0])
    try {
      await pending.authenticated
      const logout = await rawCall(f.base, '/logout', { ...f.sessions[0], body: {} })
      assert.equal(logout.status, 200)
      const before = f.criticalCounts()
      pending.finish()
      const denied = await pending.response
      assert.equal(denied.status, 401)
      assert.deepEqual(f.criticalCounts(), before)
      assert.equal(f.current().status, 'pending')
      assert.equal(f.current().leaderId, null)
    } finally {
      pending.cancel()
      pending.restore()
    }
  }
)

test(
  'HTTP认证后提现请求体延迟期间会话过期：事务重新验证到期时间，不占资金',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t)
    const pending = delayedBody(f, '/player/withdrawals', f.moneyBody(), f.sessions[0])
    try {
      await pending.authenticated
      f.advance(13 * 60 * 60 * 1000)
      const before = f.criticalCounts()
      pending.finish()
      const denied = await pending.response
      assert.equal(denied.status, 401)
      assert.deepEqual(f.criticalCounts(), before)
      assert.equal(f.service.playerWallet(f.users[0].id).available, 10000)
      assert.equal(f.service.playerWallet(f.users[0].id).occupied, 0)
    } finally {
      pending.cancel()
      pending.restore()
    }
  }
)

test(
  'HTTP认证后请求体延迟期间关闭提现：事务检查最新资格，403且无提现资金消息幂等副作用',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t)
    const pending = delayedBody(f, '/player/withdrawals', f.moneyBody(), f.sessions[0])
    try {
      await pending.authenticated
      f.mutate('/users', {
        ...f.users[0],
        playerAccess: { login: true, claim: true, withdraw: false }
      })
      const before = f.criticalCounts()
      pending.finish()
      const denied = await pending.response
      assert.equal(denied.status, 403)
      assert.deepEqual(f.criticalCounts(), before)
      assert.equal(f.service.playerWallet(f.users[0].id).available, 10000)
    } finally {
      pending.cancel()
      pending.restore()
    }
  }
)

test('HTTP原请求结果只确认本人匹配操作族的成功，不泄露快照；未记录不证明失败或解锁新编号', async (t) => {
  const f = await fixture(t),
    body = f.claimBody(),
    claimPath = '/player/orders/' + f.row.id + '/claim',
    lookup = '/player/operation-results/' + body.requestId + '?family=claim'
  const committed = await rawCall(f.base, claimPath, { ...f.sessions[0], body })
  assert.equal(committed.status, 200)
  const before = f.criticalCounts()
  const own = await rawCall(f.base, lookup, f.sessions[0])
  assert.equal(own.status, 200)
  assert.equal(own.value.status, 'succeeded')
  assert.equal(own.value.operationConfirmed, true)
  assert.equal(own.value.result, 'confirmation-only')
  assert.equal(own.value.canCreateNew, false)
  assert.equal(own.value.canRetryWithOriginal, false)
  assert.equal(own.value.lateCommitPossible, false)
  for (const key of [
    'order',
    'target',
    'amount',
    'reward',
    'screenshots',
    'receipt',
    'paymentSnapshot',
    'body',
    'payload'
  ])
    assert.equal(own.value[key], undefined)
  assert.equal(JSON.stringify(own.value).includes(f.row.id), false)

  const requests = [
    await rawCall(f.base, lookup, f.sessions[1]),
    await rawCall(
      f.base,
      '/player/operation-results/' + body.requestId + '?family=withdraw',
      f.sessions[0]
    ),
    await rawCall(
      f.base,
      '/player/operation-results/' + randomUUID() + '?family=claim',
      f.sessions[0]
    )
  ]
  for (const result of requests) {
    assert.equal(result.status, 200)
    assert.equal(result.value.status, 'not-recorded')
    assert.equal(result.value.operationConfirmed, false)
    assert.equal(result.value.result, 'confirmation-only')
    assert.equal(result.value.canCreateNew, false)
    assert.equal(result.value.lateCommitPossible, true)
    assert.equal(result.value.createdAt, null)
  }
  assert.deepEqual(
    f.criticalCounts(),
    before,
    'Result reads must not create audit, notification or request rows'
  )
  const badFamily = await rawCall(
    f.base,
    '/player/operation-results/' + body.requestId + '?family=__proto__',
    f.sessions[0]
  )
  assert.equal(badFamily.status, 400)
  assert.equal(badFamily.value.code, 'INVALID_OPERATION_FAMILY')
})

test('HTTP本人原请求成功确认在订单转交后不恢复旧私有详情；账号停用后读取和重试均拒绝', async (t) => {
  const f = await fixture(t),
    body = f.claimBody(),
    claimPath = '/player/orders/' + f.row.id + '/claim',
    lookup = '/player/operation-results/' + body.requestId + '?family=claim'
  assert.equal((await rawCall(f.base, claimPath, { ...f.sessions[0], body })).status, 200)
  const accepted = f.current()
  f.mutate('/orders/' + f.row.id + '/action', {
    action: 'release',
    expectedRevision: accepted.revision,
    assignmentId: accepted.assignmentId,
    leaderId: accepted.leaderId,
    reason: '隔离验证转交负责人'
  })
  const released = f.current()
  f.mutate('/orders/' + f.row.id + '/action', {
    action: 'dispatch',
    expectedRevision: released.revision,
    dispatchMode: 'direct',
    assignedTo: f.users[1].id
  })
  const target = f.current()
  f.mutate(
    '/player/orders/' + f.row.id + '/claim',
    {
      expectedRevision: target.revision,
      dispatchRound: target.dispatchRound
    },
    f.users[1].id
  )
  const history = await rawCall(f.base, '/player/orders/' + f.row.id, f.sessions[0])
  assert.equal(history.status, 200)
  assert.equal(history.value.historyOnly, true)
  for (const key of ['roomCode', 'gameId', 'receipt', 'remark', 'customerId'])
    assert.equal(Object.hasOwn(history.value, key), false)
  assert.deepEqual(history.value.submissions, [])
  assert.equal(history.value.canClaim, false)
  assert.equal(history.value.canSubmit, false)
  const before = f.criticalCounts()
  const confirmation = await rawCall(f.base, lookup, f.sessions[0])
  assert.equal(confirmation.status, 200)
  assert.equal(confirmation.value.status, 'succeeded')
  assert.equal(confirmation.value.result, 'confirmation-only')
  assert.equal(confirmation.value.canRetryWithOriginal, false)
  assert.equal(confirmation.value.order, undefined)
  assert.equal((await rawCall(f.base, claimPath, { ...f.sessions[0], body })).status, 403)
  assert.deepEqual(f.criticalCounts(), before)
  assert.equal(f.current().leaderId, f.users[1].id)

  f.mutate('/users', { ...f.users[0], status: 'disabled' })
  const disabled = f.criticalCounts()
  assert.ok([401, 403].includes((await rawCall(f.base, lookup, f.sessions[0])).status))
  assert.ok(
    [401, 403].includes((await rawCall(f.base, claimPath, { ...f.sessions[0], body })).status)
  )
  assert.deepEqual(f.criticalCounts(), disabled)
})

test('HTTP提现成功响应未使用后原内容重试只占一次资金；只读核对不给旧资金明细', async (t) => {
  const f = await fixture(t),
    body = f.moneyBody()
  const first = await rawCall(f.base, '/player/withdrawals', { ...f.sessions[0], body })
  assert.equal(first.status, 200)
  const after = f.criticalCounts()
  assert.equal(after.withdrawals, 1)
  const retry = await rawCall(f.base, '/player/withdrawals', { ...f.sessions[0], body })
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.value, first.value)
  assert.deepEqual(f.criticalCounts(), after)
  assert.equal(f.service.playerWallet(f.users[0].id).available, 5000)
  assert.equal(f.service.playerWallet(f.users[0].id).occupied, 5000)
  const own = await rawCall(
    f.base,
    '/player/operation-results/' + body.requestId + '?family=withdraw',
    f.sessions[0]
  )
  assert.equal(own.status, 200)
  assert.equal(own.value.operationConfirmed, true)
  assert.equal(own.value.amount, undefined)
  assert.equal(own.value.paymentSnapshot, undefined)
  assert.equal(own.value.receipt, undefined)
  assert.deepEqual(f.criticalCounts(), after)
})

test('HTTP原请求核对无效编号编码和错误族返回明确400，不转成服务器500', async (t) => {
  const f = await fixture(t),
    before = f.criticalCounts()
  const malformed = await rawCall(
    f.base,
    '/player/operation-results/%ZZ?family=claim',
    f.sessions[0]
  )
  assert.equal(malformed.status, 400)
  assert.equal(malformed.value.code, 'INVALID_REQUEST_ID')
  const badFamily = await rawCall(
    f.base,
    '/player/operation-results/' + randomUUID() + '?family=__proto__',
    f.sessions[0]
  )
  assert.equal(badFamily.status, 400)
  assert.equal(badFamily.value.code, 'INVALID_OPERATION_FAMILY')
  const tooLong = await rawCall(
    f.base,
    '/player/operation-results/' + 'x'.repeat(129) + '?family=claim',
    f.sessions[0]
  )
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.value.code, 'INVALID_REQUEST_ID')
  assert.deepEqual(f.criticalCounts(), before)
})
