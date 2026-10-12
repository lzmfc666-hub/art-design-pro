import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'

const password = 'export-http-test-password-123'
async function fixture(t) {
  const server = createStudioServer({ dbPath: ':memory:', seed: true, password })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const login = async (username) => {
    const response = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  const request = (path, cookie, body) =>
    fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
  return { server, login, request }
}

test('导出 HTTP 使用真实会话，非法模块字段或账期被拒绝', async (t) => {
  const { login, request } = await fixture(t)
  assert.equal((await request('/exports/catalog?month=2026-10')).status, 401)
  assert.equal(
    (
      await request('/exports/download', null, {
        month: '2026-10',
        modules: [{ id: 'orders', fields: ['orderNo'] }]
      })
    ).status,
    401
  )
  const cookie = await login('admin')
  const catalog = await request('/exports/catalog?month=2026-10', cookie)
  assert.equal(catalog.status, 200)
  assert.ok((await catalog.json()).modules.some((item) => item.id === 'orders'))
  assert.equal((await request('/exports/catalog?month=2026-99', cookie)).status, 400)
  assert.equal(
    (
      await request('/exports/download', cookie, {
        month: '2026-10',
        modules: [{ id: 'orders', fields: ['passwordHash'] }]
      })
    ).status,
    400
  )
})

test('下载时重新读取权限，旧目录不能导出已撤销的工资权限', async (t) => {
  const { server, login, request } = await fixture(t)
  const user = server.service.mutate('admin', '/users', {
    username: 'export-finance',
    name: '导出财务',
    role: 'finance',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password
  })
  const cookie = await login(user.username)
  let catalog = await request('/exports/catalog?month=2026-10', cookie)
  const salary = (await catalog.json()).modules.find((item) => item.id === 'payroll')
  assert.ok(salary)
  const modules = [{ id: salary.id, fields: salary.fields.slice(0, 2).map((field) => field.key) }]
  assert.equal(
    (await request('/exports/download', cookie, { month: '2026-10', modules })).status,
    200
  )
  server.service.mutate('admin', '/users', {
    ...user,
    permissionOverrides: { 'salary.view': false, 'salary.all': false, 'salary.manage': false }
  })
  assert.equal(
    (await request('/exports/download', cookie, { month: '2026-10', modules })).status,
    403
  )
  catalog = await request('/exports/catalog?month=2026-10', cookie)
  assert.ok(!(await catalog.json()).modules.some((item) => item.id === 'payroll'))
})

test('导出全量可见审计记录，页面列表上限不截断报表', async (t) => {
  const { server, login, request } = await fixture(t)
  const row = server.service.db.prepare('SELECT json FROM studio_state').get()
  const state = JSON.parse(row.json)
  state.logs = Array.from({ length: 1005 }, (_, index) => ({
    id: `export-log-${index}`,
    actorId: 'admin',
    actorName: '测试超管',
    action: '修改本人称呼',
    entity: 'profile',
    entityId: 'admin',
    before: { name: '旧名' },
    after: { name: `新名${index}` },
    createdAt: '2026-10-01T16:01:00.000Z'
  }))
  server.service.db.prepare('UPDATE studio_state SET json=?').run(JSON.stringify(state))
  const cookie = await login('admin')
  assert.equal(server.service.bootstrap('admin', '2026-10').logs.length, 1000)
  const body = { month: '2026-10', modules: [{ id: 'logs', fields: ['id', 'action'] }] }
  const preview = await request('/exports/preview', cookie, body)
  assert.equal(preview.status, 200)
  const sheet = (await preview.json()).sheets[0]
  assert.equal(sheet.rows.length, 20)
  assert.equal(sheet.rowCount, 1006)
  const download = await request('/exports/download', cookie, body)
  assert.equal(download.status, 200)
  assert.equal((await download.json()).sheets[0].rows.length, 1006)
})
