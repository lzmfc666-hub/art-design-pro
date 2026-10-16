import { testMutate, installTestClientFetch } from './helpers/current-intent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'

test('登录左图只公开当前生效图片，上传、权限、版本与恢复默认互通', async (t) => {
  const password = 'illustration-http-isolated-test-123'
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
  const employee = testMutate(server.service, 'admin', '/users', {
    username: 'illustration-support',
    name: '插图测试客服',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {},
    password
  })
  const adminCookie = await login('admin')
  const employeeCookie = await login(employee.username)
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
  const upload = (actor, name) =>
    server.service.upload(actor, { name, mime: 'image/png', data: png })
  const left = upload('admin', '登录左图.png')
  const bg = upload('admin', '登录背景.png')
  const privateImage = upload(employee.id, '内部凭证.png')
  const original = await (await call('/appearance', adminCookie)).json()
  const config = {
    ...original,
    login: {
      ...original.login,
      illustration: { mode: 'image', image: left },
      background: { ...original.login.background, mode: 'image', image: bg }
    }
  }
  assert.equal((await call(`/public-assets/${left.id}`)).status, 404)
  assert.equal((await call('/appearance', employeeCookie, { config, revision: 0 })).status, 403)
  const forged = structuredClone(config)
  forged.login.illustration.image = privateImage
  assert.equal(
    (await call('/appearance', adminCookie, { config: forged, revision: 0 })).status,
    403
  )
  const savedResponse = await call('/appearance', adminCookie, { config, revision: 0 })
  assert.equal(savedResponse.status, 200)
  const saved = await savedResponse.json()
  assert.equal(saved.revision, 1)
  const publicConfig = await (await call('/appearance/public')).json()
  assert.deepEqual(Object.keys(publicConfig).sort(), ['glass', 'login', 'logo', 'studioName'])
  assert.equal(publicConfig.login.illustration.image.url, `/api/studio/public-assets/${left.id}`)
  assert.equal(publicConfig.login.background.image.url, `/api/studio/public-assets/${bg.id}`)
  assert.equal((await call(`/public-assets/${left.id}`)).status, 200)
  assert.equal((await call(`/public-assets/${bg.id}`)).status, 200)
  assert.equal((await call(`/public-assets/${privateImage.id}`)).status, 404)
  assert.equal((await call('/appearance', adminCookie, { config, revision: 0 })).status, 409)
  saved.login.illustration.mode = 'default'
  assert.equal((await call('/appearance', adminCookie, { config: saved, revision: 1 })).status, 200)
  assert.equal((await call(`/public-assets/${left.id}`)).status, 404)
  assert.equal((await call(`/public-assets/${bg.id}`)).status, 200)
  assert.equal((await (await call('/appearance/public')).json()).login.illustration.image, null)
  assert.equal((await call(left.url.replace('/api/studio', ''), employeeCookie)).status, 403)
  assert.equal((await call(left.url.replace('/api/studio', ''), adminCookie)).status, 200)
  const reset = await call('/appearance/reset', adminCookie, { revision: 2 })
  assert.equal(reset.status, 200)
  assert.deepEqual((await reset.json()).login.illustration, { mode: 'default', image: null })
  assert.equal((await call(`/public-assets/${bg.id}`)).status, 404)
})

installTestClientFetch()
