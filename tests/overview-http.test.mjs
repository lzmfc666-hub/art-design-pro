import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'

test('区间主页 HTTP 验证真实会话、日期和当前权限，读取不改业务记录', async (t) => {
  const password = 'overview-http-test-password-123'
  const server = createStudioServer({ dbPath: ':memory:', password, seed: true })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const path = '/overview?start=2026-09-29&end=2026-10-03'
  assert.equal((await fetch(base + path)).status, 401)
  const actor = server.service.mutate('admin', '/users', {
    username: 'overview-support',
    name: '主页客服',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password
  })
  const login = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: actor.username, password })
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const before = server.service.db.prepare('SELECT json FROM studio_state').get().json
  let response = await fetch(base + path, { headers: { Cookie: cookie } })
  assert.equal(response.status, 200)
  let result = await response.json()
  assert.equal(result.range.days, 5)
  assert.equal(result.metrics.received, null)
  assert.equal(result.metrics.periodOperatingProfit, null)
  assert.ok(result.series.every((row) => row.net === null && row.profit === null))
  assert.equal(server.service.db.prepare('SELECT json FROM studio_state').get().json, before)
  assert.equal(
    (
      await fetch(base + '/overview?start=2026-02-30&end=2026-10-01', {
        headers: { Cookie: cookie }
      })
    ).status,
    400
  )
  server.service.mutate('admin', '/users', {
    ...actor,
    permissionOverrides: { 'profit.view': true }
  })
  response = await fetch(base + path, { headers: { Cookie: cookie } })
  result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(typeof result.metrics.received, 'number')
  server.service.mutate('admin', '/users', {
    ...actor,
    permissionOverrides: { 'profit.view': false }
  })
  result = await (await fetch(base + path, { headers: { Cookie: cookie } })).json()
  assert.equal(result.metrics.received, null)
  assert.equal(result.metrics.fullMonthsProfit, null)
})
