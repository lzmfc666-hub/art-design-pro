import test from 'node:test'
import assert from 'node:assert/strict'
import * as entry from '../src/utils/auth/admin-entry.ts'
import { OutgoingMessage } from 'node:http'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { loadConfigFromFile } from 'vite'

test('merchant sessions cannot hydrate the internal administrator entry', () => {
  assert.equal(entry.adminSessionUser({ id: 'merchant-a', role: 'merchant' }), null)
  assert.equal(entry.adminLoginRedirect('/merchant/orders?id=private'), '/dashboard/console')
  const support = { id: 'original-support', role: 'support' }
  assert.equal(entry.adminSessionUser(support), support)
  assert.equal(entry.adminLoginRedirect('/orders/create'), '/orders/create')
  assert.equal(entry.studioClientForPath('/orders/create'), 'admin')
})

test('merchant entry selects its own channel and only restores merchant business paths', () => {
  assert.equal(typeof entry.studioClientForPath, 'function')
  assert.equal(entry.studioClientForPath('/merchant/orders?status=active'), 'merchant')
  assert.equal(entry.studioClientForPath('/merchant/login'), 'merchant')
  assert.equal(entry.studioClientForPath('/system/user-center'), 'admin')
  assert.equal(entry.studioClientForPath('/merchant-other'), 'admin')
  assert.equal(entry.studioClientForPath('/merchants/manage?section=accounts'), 'admin')
  assert.equal(entry.adminLoginRedirect('/merchants/manage?section=orders'), '/merchants/manage?section=orders')
  assert.equal(entry.merchantLoginRedirect('/merchant/orders?id=a'), '/merchant/orders?id=a')
  for (const unsafe of ['/orders/list', '//outside.invalid', '/merchant/login', '/merchant/../system/business', '/merchant/orders\\evil', undefined]) {
    assert.equal(entry.merchantLoginRedirect(unsafe), '/merchant/overview')
  }
})

test('merchant create payload contains only task intent and current template version', () => {
  assert.equal(typeof entry.merchantOrderPayload, 'function')
  const body = entry.merchantOrderPayload({
    templateId: 'template-a', roomCode: '1234', gameId: '', map: '不限',
    dispatchMode: 'pool', assignedTo: '', playerRemark: '',
    amount: 1, reward: 999, customerId: 'other', platformId: 'forged',
    paymentMethod: 'cash', receivedAmount: 8000, paidAt: 'fake', merchantId: 'other'
  }, { id: 'template-a', revision: 4 })
  assert.deepEqual(body, {
    templateId: 'template-a', expectedTemplateRevision: 4, roomCode: '1234',
    gameId: '', map: '不限', dispatchMode: 'pool', assignedTo: null,
    playerRemark: '报响箭电竞'
  })
  assert.throws(() => entry.merchantOrderPayload({ templateId: 'template-a' }, { id: 'template-a' }), /刷新/)
})

test('development proxy retains merchant session channel and strips the old player channel', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, `${root}/vite.config.ts`, root, 'silent')
  const proxy = new EventEmitter()
  config.config.server.proxy['/api'].configure(proxy)
  for (const channel of ['merchant', 'player', 'other']) {
    const outgoing = new OutgoingMessage()
    outgoing.setHeader('x-studio-client', channel)
    outgoing.setHeader('x-forwarded-for', 'forged.invalid')
    proxy.emit('proxyReq', outgoing, { headers: { 'x-studio-client': channel }, socket: { remoteAddress: '127.0.0.1' } })
    assert.equal(outgoing.getHeader('x-studio-client'), channel === 'merchant' ? 'merchant' : undefined)
    assert.equal(outgoing.getHeader('x-forwarded-for'), '127.0.0.1')
  }
})

// Owner-only landing is still validated by the current session's route guard.
test('merchant login can restore staff management while keeping external paths excluded', () => {
  assert.equal(entry.merchantLoginRedirect('/merchant/staff'), '/merchant/staff')
})
