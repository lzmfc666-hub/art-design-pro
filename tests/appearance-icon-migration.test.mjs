import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioServer } from '../server/index.mjs'
import {
  defaultAppearance,
  normalizeAppearance,
  projectAppearanceAudit,
  projectPublicAppearance
} from '../server/appearance.mjs'

test('旧路径和新路径图标迁移到稳定槽位，显式槽位优先，未知路径仍拒绝', () => {
  const current = defaultAppearance()
  const config = {
    ...current,
    icons: {
      '/system/user': 'ri:gamepad-line',
      '/orders/customers': 'ri:star-line',
      '/personnel': 'ri:group-line'
    }
  }
  const expected = {
    users: 'ri:gamepad-line',
    customers: 'ri:star-line',
    personnel: 'ri:group-line'
  }
  assert.deepEqual(normalizeAppearance(config, () => null).icons, expected)
  assert.deepEqual(projectAppearanceAudit(config).icons, expected)
  assert.equal(Object.hasOwn(projectPublicAppearance(config), 'icons'), false)
  assert.deepEqual(
    normalizeAppearance(
      {
        ...current,
        icons: {
          '/system/user': 'ri:gamepad-line',
          '/personnel/employees': 'ri:team-line',
          users: 'ri:star-line'
        }
      },
      () => null
    ).icons,
    { users: 'ri:star-line' }
  )
  assert.throws(
    () =>
      normalizeAppearance({ ...current, icons: { '/unknown-route': 'ri:star-line' } }, () => null),
    (error) => error.status === 400
  )
  assert.throws(
    () =>
      normalizeAppearance(
        { ...current, icons: { users: 'ri:star-line', '/system/user': 'javascript:alert(1)' } },
        () => null
      ),
    (error) => error.status === 400
  )
})

test('真实HTTP保存既有旧路径图标不400，版本校验保留，自定义图标不丢失', async (t) => {
  const password = 'appearance-migration-isolated-test-123'
  const server = createStudioServer({ dbPath: ':memory:', password, seed: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const service = server.service
  const original = service.getAppearance('admin')
  const old = {
    ...original,
    icons: {
      '/system/user': 'ri:gamepad-line',
      '/orders/customers': 'ri:star-line',
      '/personnel': 'ri:group-line'
    }
  }
  const state = JSON.parse(
    service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  )
  state.appearance = old
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password })
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const loaded = await fetch(`${base}/appearance`, { headers: { cookie } }).then((response) =>
    response.json()
  )
  assert.equal(loaded.revision, original.revision)
  assert.deepEqual(loaded.icons, {
    users: 'ri:gamepad-line',
    customers: 'ri:star-line',
    personnel: 'ri:group-line'
  })
  const save = await fetch(`${base}/appearance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      config: { ...loaded, studioName: '迁移后继续编辑' },
      revision: loaded.revision
    })
  })
  assert.equal(save.status, 200)
  const saved = await save.json()
  assert.equal(saved.revision, original.revision + 1)
  assert.deepEqual(saved.icons, {
    users: 'ri:gamepad-line',
    customers: 'ri:star-line',
    personnel: 'ri:group-line'
  })
  const conflict = await fetch(`${base}/appearance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ config: loaded, revision: loaded.revision })
  })
  assert.equal(conflict.status, 409)
  assert.deepEqual(service.getAppearance('admin').icons, saved.icons)
})
