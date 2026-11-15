import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStudioService } from '../server/studio.mjs'
import { merchantFixture, merchantPassword } from './helpers/merchant-fixture.mjs'

test('owner binding and deleted creator responsibility survive SQLite restart and case-insensitive login reuse', t => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-merchant-staff-persistence-'))
  const options = { dbPath: join(directory, 'isolated.sqlite'), seed: false, password: merchantPassword }
  let service = createStudioService(options)
  t.after(() => {
    service.close()
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Invalid isolated test path')
    rmSync(directory, { recursive: true, force: true })
  })
  const f = merchantFixture(null, service), owner = f.accounts[0], original = f.accounts[1]
  f.mutate(`/merchants/${f.merchants[0].id}/owner`, { userId: owner.id })
  const order = f.order({}, original.id)
  const token = service.login(original.username, merchantPassword).token
  f.mutate(`/merchant/staff/${original.id}/delete`, {}, owner.id)
  const replacement = f.mutate('/merchant/staff', { username: original.username.toUpperCase(), name: original.name, password: merchantPassword }, owner.id)
  service.close()
  service = createStudioService(options)
  assert.equal(service.bootstrap(owner.id).user.merchantRole, 'owner')
  assert.equal(service.merchants('admin')[0].ownerUserId, owner.id)
  assert.equal(service.session(token), null)
  assert.equal(service.login(original.username, merchantPassword).user.id, replacement.id)
  assert.notEqual(original.id, replacement.id)
  const bootstrap = service.bootstrap(owner.id)
  assert.match(bootstrap.users.find(user => user.id === original.id).name, /已删除/)
  assert.equal(service.orderDetail(replacement.id, order.id).order.creatorId, original.id)
})
