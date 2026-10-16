import { testMutate, installTestClientFetch } from './helpers/current-intent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLoginRateLimit } from '../server/login-rate-limit.mjs'
import { createStudioServer } from '../server/index.mjs'
import { ApiError } from '../server/studio.mjs'

const input = { channel: 'admin', address: '127.0.0.1', username: 'admin' }

test('登录限流：账号、客户端和地址隔离，大小写与空格不能绕过锁定', () => {
  let now = 1000000
  const limiter = createLoginRateLimit({ clock: () => now })
  for (let count = 0; count < 15; count++) {
    assert.equal(limiter.check(input), 0)
    limiter.failure(input)
  }
  assert.equal(limiter.check({ ...input, username: ' ADMIN ' }), 900)
  assert.equal(limiter.check({ ...input, channel: 'player' }), 0)
  assert.equal(limiter.check({ ...input, username: 'someone-else' }), 0)
  assert.equal(limiter.check({ ...input, address: '127.0.0.2' }), 0)
  now += 61000
  assert.equal(limiter.check(input), 839)
  now += 839000
  assert.equal(limiter.check(input), 0)
})

test('登录限流：成功仅重置自身账号，轮换账号仍受客户端地址总量保护', () => {
  const limiter = createLoginRateLimit({ clock: () => 1000000 })
  for (let count = 0; count < 14; count++) limiter.failure(input)
  limiter.success({ ...input, username: ' ADMIN ' })
  for (let count = 0; count < 14; count++) limiter.failure(input)
  assert.equal(limiter.check(input), 0)
  limiter.failure(input)
  assert.equal(limiter.check(input), 900)
  for (let count = 29; count < 150; count++) {
    const other = { ...input, username: `other-${count}` }
    assert.equal(limiter.check(other), 0)
    limiter.failure(other)
  }
  assert.equal(limiter.check({ ...input, username: 'never-tried' }), 900)
  limiter.success(input)
  assert.equal(limiter.check(input), 900)
  assert.equal(limiter.check({ ...input, channel: 'player' }), 0)
})

test('登录限流：桶数量有上限，满额不淘汰有效锁定，过期后释放', () => {
  let now = 1000000
  const limiter = createLoginRateLimit({ clock: () => now, maxBuckets: 4 })
  for (const username of ['a', 'b', 'c']) {
    const attempt = { ...input, username }
    assert.equal(limiter.check(attempt), 0)
    limiter.failure(attempt)
  }
  assert.equal(limiter.check({ ...input, username: 'd' }), 900)
  assert.equal(limiter.check({ ...input, username: 'a' }), 0)
  assert.equal(limiter.check({ ...input, channel: 'player', username: 'd' }), 0)
  now += 900000
  assert.equal(limiter.check({ ...input, username: 'd' }), 0)
  limiter.failure({ ...input, username: 'd' })
  assert.equal(limiter.check({ ...input, username: 'e' }), 0)
})

async function fixture(t) {
  let now = Date.parse('2026-10-13T04:00:00Z')
  const password = 'rate-limit-isolated-test-123'
  const server = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password,
    clock: () => new Date(now)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  async function login({ username = 'admin', player = false, secret = password } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/studio/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(player ? { 'X-Studio-Client': 'player' } : {})
      },
      body: JSON.stringify({ username, password: secret })
    })
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      data: await response.json()
    }
  }
  return { server, login, password, advance: (milliseconds) => (now += milliseconds) }
}

test('真实HTTP：误在打手端登录后台账号不会锁后台，其他账号仍可登录且等待时间准确', async (t) => {
  const f = await fixture(t)
  testMutate(f.server.service, 'admin', '/users', {
    username: 'another-staff',
    name: '测试客服',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: f.password
  })
  for (let count = 0; count < 15; count++)
    assert.equal((await f.login({ player: true })).status, 403)
  const playerBlocked = await f.login({ player: true })
  assert.equal(playerBlocked.status, 429)
  assert.equal(playerBlocked.retryAfter, '900')
  assert.equal((await f.login()).status, 200)
  for (let count = 0; count < 15; count++)
    assert.equal((await f.login({ secret: 'wrong-password' })).status, 401)
  assert.equal((await f.login()).status, 429)
  assert.equal((await f.login({ username: 'another-staff' })).status, 200)
  f.advance(61000)
  const remaining = await f.login()
  assert.equal(remaining.status, 429)
  assert.equal(remaining.retryAfter, '839')
  assert.match(remaining.data.message, /14分钟/)
  f.advance(839000)
  assert.equal((await f.login()).status, 200)
})

test('真实HTTP：服务器处理失败和参数错误不算密码错误', async (t) => {
  const f = await fixture(t)
  const original = f.server.service.login
  f.server.service.login = () => {
    throw new ApiError('测试暂时不可用', 503)
  }
  for (let count = 0; count < 20; count++) assert.equal((await f.login()).status, 503)
  f.server.service.login = original
  for (let count = 0; count < 20; count++)
    assert.equal((await f.login({ username: '' })).status, 400)
  assert.equal((await f.login()).status, 200)
})

installTestClientFetch()
