import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createECDH, createHash, randomBytes } from 'node:crypto'
import webpush from 'web-push'
import { createPlayerNotifications } from '../server/player-notifications.mjs'
import { createStudioServer } from '../server/index.mjs'

const timestamp = '2026-10-14T00:00:00.000Z'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const fingerprints = (subscription) => {
  const normalized = {
    endpoint: new URL(subscription.endpoint).href,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }
  }
  return {
    endpointHash: hash(normalized.endpoint),
    subscriptionHash: hash(JSON.stringify(normalized))
  }
}
const subscription = (suffix) => {
  const key = createECDH('prime256v1')
  key.generateKeys()
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/final-${suffix}`,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url')
    }
  }
}
const player = (id) => ({
  id,
  role: 'player',
  status: 'active',
  levelId: 'level',
  maxActiveOrders: 2,
  playerAccess: { login: true, claim: true, withdraw: true }
})
const directOrder = (id) => ({
  id,
  orderNo: id,
  revision: 1,
  dispatchRound: 1,
  status: 'pending',
  dispatchMode: 'direct',
  dispatchState: 'ready',
  assignedTo: 'player-a',
  assignedAt: timestamp,
  publishedAt: timestamp,
  leaderId: null,
  assignmentId: null,
  submissionId: null,
  assignments: [],
  submissions: [],
  returnRequests: []
})

function fixture(t, overrides = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE studio_state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)')
  db.prepare('INSERT INTO studio_state VALUES(1,?)').run(JSON.stringify({
    users: [player('player-a'), player('player-b')],
    orders: [],
    levels: [{ id: 'level', delaySeconds: 0 }],
    withdrawals: [],
    passwords: {}
  }))
  const notifications = createPlayerNotifications(db, {
    ...webpush.generateVAPIDKeys(),
    subject: 'mailto:final-notification-test@example.com',
    allowedPushHosts: [],
    clock: () => new Date(timestamp),
    pushSender: async () => {},
    ...overrides
  })
  t.after(() => {
    notifications.close()
    db.close()
  })
  const snapshot = () => JSON.parse(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const tx = (mutate) => {
    const before = snapshot(), after = structuredClone(before)
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = mutate(after)
      notifications.onTransaction({ state: after, beforeState: before, now: timestamp })
      db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(after))
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const mutate = (path, body, owner = 'player-a') => tx((state) => notifications.mutate({
    state, user: state.users.find((row) => row.id === owner), path, body, audit() {}
  }))
  const writes = () => db.prepare('SELECT total_changes() AS count').get().count
  return { db, notifications, snapshot, tx, mutate, writes }
}

test('设备指纹读取区分本人完整绑定与内容失配，其他账号/撤销均相同且无副作用', (t) => {
  const f = fixture(t), original = subscription('binding')
  f.mutate('/player/push-subscriptions', { subscription: original })
  f.mutate('/player/push-subscriptions/test', {})
  const before = f.writes(), originalFingerprint = fingerprints(original)
  const valid = { configured: true, status: 'valid', pushEnabled: true }
  const unbound = { configured: true, status: 'unbound', pushEnabled: true }
  assert.deepEqual(f.notifications.bindingStatus('player-a', originalFingerprint), valid)
  assert.deepEqual(f.notifications.bindingStatus('player-b', originalFingerprint), unbound)
  assert.deepEqual(f.notifications.bindingStatus('player-a'), unbound)
  const changed = { ...original, keys: subscription('rotated').keys }
  assert.deepEqual(f.notifications.bindingStatus('player-a', fingerprints(changed)), {
    configured: true, status: 'invalid', pushEnabled: true
  })
  for (const query of [
    { endpointHash: originalFingerprint.endpointHash },
    { ...originalFingerprint, subscriptionHash: 'bad' },
    { endpointHash: '', subscriptionHash: '' },
    { ...originalFingerprint, endpointHash: originalFingerprint.endpointHash.toUpperCase() }
  ]) assert.throws(() => f.notifications.bindingStatus('player-a', query), (error) => error.status === 400)
  assert.equal(f.writes(), before)
  assert.deepEqual(Object.keys(valid).sort(), ['configured', 'pushEnabled', 'status'])
  f.mutate('/player/notification-settings', { pool: false, push: false })
  assert.deepEqual(f.notifications.bindingStatus('player-a', originalFingerprint), { ...valid, pushEnabled: false })
  f.mutate('/player/push-subscriptions/remove', { endpoint: original.endpoint })
  assert.deepEqual(f.notifications.bindingStatus('player-a', originalFingerprint), { ...unbound, pushEnabled: false })
})

test('未配置服务的设备读取优先 unconfigured；永久失效订阅读取为 unbound', async (t) => {
  const disabled = fixture(t, { publicKey: '', privateKey: '', subject: '' })
  const before = disabled.writes()
  assert.deepEqual(disabled.notifications.bindingStatus('player-a', fingerprints(subscription('disabled'))), {
    configured: false, status: 'unconfigured', pushEnabled: true
  })
  assert.equal(disabled.writes(), before)
  const expired = fixture(t, { pushSender: async () => { throw Object.assign(new Error('test-expired'), { statusCode: 410 }) } })
  const binding = subscription('expired')
  expired.mutate('/player/push-subscriptions', { subscription: binding })
  expired.mutate('/player/push-subscriptions/test', {})
  await expired.notifications.flushPush()
  assert.equal(expired.notifications.bindingStatus('player-a', fingerprints(binding)).status, 'unbound')
})

test('消息目标随原事务固化轮次与材料，重派及新材料不重写旧目标', (t) => {
  const f = fixture(t)
  f.tx((state) => state.orders.push(directOrder('target-order')))
  const invitation = f.notifications.list('player-a').records[0]
  assert.deepEqual(invitation.target, { orderId: 'target-order', dispatchRound: 1, assignmentId: null, submissionId: null })
  f.tx((state) => {
    const order = state.orders[0]
    order.status = 'active'; order.leaderId = 'player-a'; order.assignmentId = 'assignment-1'; order.revision++
  })
  f.tx((state) => {
    const order = state.orders[0]
    order.status = 'review'; order.submissionId = 'submission-1'; order.revision++
  })
  const material = f.notifications.list('player-a').records.find((row) => row.target?.submissionId === 'submission-1')
  assert.ok(material)
  assert.deepEqual(material.target, { orderId: 'target-order', dispatchRound: 1, assignmentId: 'assignment-1', submissionId: 'submission-1' })
  f.tx((state) => {
    const order = state.orders[0]
    order.status = 'pending'; order.dispatchRound = 2; order.assignmentId = null; order.leaderId = null; order.revision++
  })
  const newInvitation = f.notifications.list('player-a').records.find((row) => row.type === 'assigned' && row.target?.dispatchRound === 2)
  assert.deepEqual(newInvitation.target, { orderId: 'target-order', dispatchRound: 2, assignmentId: null, submissionId: null })
  f.tx((state) => {
    const order = state.orders[0]
    order.status = 'active'; order.leaderId = 'player-a'; order.assignmentId = 'assignment-2'; order.revision++
  })
  f.tx((state) => {
    const order = state.orders[0]
    order.status = 'review'; order.submissionId = 'submission-2'; order.revision++
  })
  assert.deepEqual(f.notifications.detail('player-a', material.id).target, material.target)
  assert.deepEqual(f.notifications.detail('player-a', invitation.id).target, invitation.target)
  assert.ok(f.notifications.detail('player-a', invitation.id).invalidatedAt)
})

test('退单结果绑定被批准的原接单记录，历史缺失不补造当前轮次', (t) => {
  const f = fixture(t)
  f.tx((state) => state.orders.push({ ...directOrder('return-order'), status: 'active', leaderId: 'player-a', assignmentId: 'original-assignment', dispatchRound: 7,
    returnRequests: [{ id: 'return-original', status: 'pending', leaderId: 'player-a', assignmentId: 'original-assignment', dispatchRound: 7 }] }))
  f.tx((state) => {
    const order = state.orders[0]
    order.returnRequests[0].status = 'approved'
    order.assignmentId = null; order.leaderId = null; order.status = 'pending'; order.dispatchRound = 8; order.revision++
  })
  const returned = f.notifications.list('player-a').records.find((row) => row.type === 'return-result')
  assert.deepEqual(returned.target, { orderId: 'return-order', dispatchRound: 7, assignmentId: 'original-assignment', submissionId: null })
  f.tx((state) => {
    state.orders[0].returnRequests.push({ id: 'legacy-return', status: 'approved', leaderId: 'player-a' })
  })
  const legacy = f.notifications.list('player-a').records.find((row) => row.type === 'return-result' && row.id !== returned.id)
  assert.deepEqual(legacy.target, { orderId: 'return-order', dispatchRound: null, assignmentId: null, submissionId: null })
})

test('单条消息读取跨分页核验当前失效且不落库，旧字段与内部validity均不公开', (t) => {
  const f = fixture(t)
  f.tx((state) => state.orders.push(directOrder('detail-order')))
  const original = f.notifications.list('player-a').records[0]
  const insert = f.db.prepare('INSERT INTO player_notifications(id,user_id,event_key,type,title,body,order_id,href,created_at,validity_json,target_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  for (let i = 0; i < 35; i++) insert.run(`later-${i}`, 'player-a', `later-${i}`, 'test', 'later', '', null, '/#/player/messages', '2026-10-14T01:00:00.000Z', null, null)
  assert.equal(f.notifications.list('player-a', { size: 1 }).records.some((row) => row.id === original.id), false)
  const updated = f.snapshot()
  updated.orders[0].dispatchRound = 2
  f.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(updated))
  const before = f.writes(), checked = f.notifications.detail('player-a', original.id)
  assert.ok(checked.invalidatedAt)
  assert.equal(checked.target.dispatchRound, 1)
  assert.equal(f.db.prepare('SELECT invalidated_at FROM player_notifications WHERE id=?').get(original.id).invalidated_at, null)
  assert.equal(f.writes(), before)
  assert.throws(() => f.notifications.detail('player-b', original.id), (error) => error.status === 404)
  const hidden = { dispatchRound: 3, assignedTo: 'private-player', dispatchToken: 'PRIVATE_TOKEN', revision: 41 }
  insert.run('legacy-target', 'player-a', 'legacy-target', 'order-result', 'legacy', '', 'detail-order', '/#/player/messages', timestamp, JSON.stringify(hidden), null)
  const legacy = f.notifications.detail('player-a', 'legacy-target')
  assert.deepEqual(legacy.target, { orderId: 'detail-order', dispatchRound: 3, assignmentId: null, submissionId: null })
  assert.equal(JSON.stringify(legacy).includes('PRIVATE_TOKEN'), false)
  assert.equal(JSON.stringify(legacy).includes('private-player'), false)
  insert.run('unknown-target', 'player-a', 'unknown-target', 'order-result', 'unknown', '', 'detail-order', '/#/player/messages', timestamp, null, '{invalid')
  assert.deepEqual(f.notifications.detail('player-a', 'unknown-target').target, { orderId: 'detail-order', dispatchRound: null, assignmentId: null, submissionId: null })
  const malicious = { orderId: 'other-order', dispatchRound: 4, assignmentId: 'safe-id', submissionId: null, roomCode: 'PRIVATE_ROOM' }
  insert.run('whitelist-target', 'player-a', 'whitelist-target', 'order-result', 'safe', '', 'detail-order', '/#/player/messages', timestamp, null, JSON.stringify(malicious))
  assert.deepEqual(f.notifications.detail('player-a', 'whitelist-target').target, { orderId: 'detail-order', dispatchRound: 4, assignmentId: 'safe-id', submissionId: null })
  assert.equal(f.notifications.detail('player-a', 'later-0').target, null)
})

test('真实HTTP设备状态和单条消息路由保持认证、本人隔离及只读行为', async (t) => {
  const password = 'final-notification-http-only-123'
  const app = createStudioServer({ dbPath: ':memory:', seed: false, password, clock: () => new Date(timestamp), notifications: {
    ...webpush.generateVAPIDKeys(), subject: 'mailto:final-notification-http@example.com', allowedPushHosts: [], pushSender: async () => {}
  } })
  t.after(() => new Promise((resolve) => app.close(resolve)))
  const level = app.service.mutate('admin', '/levels', { name: 'final-notification-level', delaySeconds: 0 })
  const user = app.service.mutate('admin', '/users', { username: 'final-notification-player', name: 'notification', role: 'player', status: 'active', password, maxActiveOrders: 1, levelId: level.id })
  const other = app.service.mutate('admin', '/users', { username: 'final-notification-other', name: 'other', role: 'player', status: 'active', password, maxActiveOrders: 1, levelId: level.id })
  const binding = subscription('http')
  app.service.mutate(user.id, '/player/push-subscriptions', { subscription: binding })
  app.service.mutate(user.id, '/player/push-subscriptions/test', {})
  const notice = app.notifications.list(user.id).records[0]
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.address().port}/api/studio`
  const login = async (username) => {
    const response = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  const cookie = await login(user.username), otherCookie = await login(other.username)
  const statusPath = `/player/push-subscriptions/status?${new URLSearchParams(fingerprints(binding))}`
  assert.equal((await fetch(base + statusPath)).status, 401)
  assert.equal((await fetch(`${base}/player/notifications/${notice.id}`)).status, 401)
  const read = async (path, ownerCookie = cookie) => {
    const response = await fetch(base + path, { headers: { Cookie: ownerCookie } })
    return { status: response.status, data: await response.json() }
  }
  const before = app.service.db.prepare('SELECT total_changes() AS count').get().count
  assert.deepEqual(await read(statusPath), { status: 200, data: { configured: true, status: 'valid', pushEnabled: true } })
  assert.deepEqual(await read(statusPath, otherCookie), { status: 200, data: { configured: true, status: 'unbound', pushEnabled: true } })
  assert.equal((await read(`${statusPath}&subscriptionHash=malformed`)).status, 400)
  const message = await read(`/player/notifications/${notice.id}`)
  assert.equal(message.status, 200)
  assert.equal(message.data.readAt, null)
  assert.equal(message.data.target, null)
  assert.equal((await read(`/player/notifications/${notice.id}`, otherCookie)).status, 404)
  assert.equal(app.service.db.prepare('SELECT total_changes() AS count').get().count, before)
})
