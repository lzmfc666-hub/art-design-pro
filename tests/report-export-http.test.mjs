import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'

const password = 'export-http-test-password-123'
async function fixture(t) {
  const server = createStudioServer({
    dbPath: ':memory:',
    seed: true,
    password,
    clock: () => new Date('2026-10-13T04:00:00Z')
  })
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
  for (let index = 0; index < 1005; index++)
    server.service.mutate('admin', '/profile', { name: `审计导出${index}` })
  const cookie = await login('admin')
  const page = await request('/logs?current=1&size=20', cookie)
  assert.equal(page.status, 200)
  const pageResult = await page.json()
  assert.equal(pageResult.records.length, 20)
  assert.equal(pageResult.total, 1006)
  const body = {
    month: '2026-10',
    period: { type: 'total' },
    modules: [{ id: 'logs', fields: ['id', 'action'] }]
  }
  const preview = await request('/exports/preview', cookie, body)
  assert.equal(preview.status, 200)
  const sheet = (await preview.json()).sheets[0]
  assert.equal(sheet.rows.length, 20)
  assert.equal(sheet.rowCount, 1006)
  const download = await request('/exports/download', cookie, body)
  assert.equal(download.status, 200)
  assert.equal((await download.json()).sheets[0].rows.length, 1006)
  const timestampSearch = await request('/exports/download', cookie, {
    ...body,
    filters: { keywordField: 'createdAt', keyword: '2026-10-13 12:00:00' }
  })
  assert.equal(timestampSearch.status, 200)
  assert.equal((await timestampSearch.json()).sheets[0].rowCount, 1006)
})

test('客服和客服主管真实登录后目录、预览、下载全部拒绝，个人授权覆盖无法绕过', async (t) => {
  const { server, login, request } = await fixture(t)
  for (const role of ['support', 'support_lead']) {
    const actor = server.service.mutate('admin', '/users', {
      username: `blocked-${role}`,
      name: role,
      role,
      status: 'active',
      maxActiveOrders: 1,
      permissionOverrides: { 'reports.export': true },
      password
    })
    const cookie = await login(actor.username)
    assert.equal((await request('/exports/catalog?month=2026-10', cookie)).status, 403)
    for (const path of ['/exports/preview', '/exports/download'])
      assert.equal(
        (
          await request(path, cookie, {
            month: '2026-10',
            modules: [{ id: 'profile', fields: ['username'] }]
          })
        ).status,
        403
      )
  }
})
