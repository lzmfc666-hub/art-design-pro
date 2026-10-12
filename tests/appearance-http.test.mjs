import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'

test('外观 HTTP 仅授权管理员写入，共享品牌图片须登录，版本冲突不覆盖', async (t) => {
  const password = 'appearance-http-test-password-123'
  const server = createStudioServer({ dbPath: ':memory:', password, seed: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const call = (path, cookie, body) =>
    fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
  const login = async (username) => {
    const response = await call('/login', null, { username, password })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  const staff = server.service.mutate('admin', '/users', {
    username: 'appearance-staff',
    name: '外观客服',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password
  })
  assert.equal((await call('/appearance')).status, 401)
  const admin = await login('admin'),
    employee = await login(staff.username)
  const original = await (await call('/appearance', admin)).json()
  const image = server.service.upload('admin', {
    name: 'brand.png',
    mime: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
  })
  const config = {
    ...original,
    studioName: 'HTTP 外观工作室',
    logo: image,
    page: { ...original.page, mode: 'color', color: '#ddeeff' }
  }
  assert.equal((await call('/appearance', employee, { config, revision: 0 })).status, 403)
  assert.equal((await call(image.url.replace('/api/studio', ''), employee)).status, 403)
  const result = await call('/appearance', admin, { config, revision: 0 })
  assert.equal(result.status, 200)
  const saved = await result.json()
  assert.equal(saved.revision, 1)
  assert.equal((await call('/appearance', admin, { config, revision: 0 })).status, 409)
  assert.equal((await (await call('/appearance', employee)).json()).studioName, 'HTTP 外观工作室')
  assert.equal((await call(image.url.replace('/api/studio', ''), employee)).status, 200)
  assert.equal((await call(image.url.replace('/api/studio', ''))).status, 401)
  assert.equal((await call('/appearance/reset', employee, { revision: 1 })).status, 403)
  const restored = await call('/appearance/reset', admin, { revision: 1 })
  assert.equal(restored.status, 200)
  assert.equal((await restored.json()).logo, null)
  assert.equal((await call(image.url.replace('/api/studio', ''), employee)).status, 403)
  assert.equal((await call(image.url.replace('/api/studio', ''), admin)).status, 200)
})
