import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createECDH } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import webpush from 'web-push'
import { createStudioServer } from '../server/index.mjs'
import { ApiError } from '../server/studio.mjs'

const password = 'notification-test-only-123'
function fixture(t, extra = {}) {
  let time = new Date('2026-10-13T00:00:00Z')
  const keys = webpush.generateVAPIDKeys()
  const sent = []
  const { testPushSender, ...serverOptions } = extra
  const app = createStudioServer({
    dbPath: ':memory:',
    seed: false,
    password,
    clock: () => time,
    notifications: {
      clock: () => time,
      ...keys,
      subject: 'mailto:testing@example.com',
      pushSender:
        testPushSender ||
        (async (...args) => {
          sent.push(args)
        })
    },
    ...serverOptions
  })
  t.after(() => (app.service.db.isOpen ? new Promise((resolve) => app.close(resolve)) : undefined))
  const service = app.service
  // The fixture acts as an up-to-date client; explicit stale requests live in contract regressions.
  const mutate = (path, body, actor = 'admin') => {
    const orderId = path.match(/^\/(?:player\/)?orders\/([^/]+)\//)?.[1]
    const current =
      orderId &&
      JSON.parse(
        service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
      ).orders.find((row) => row.id === orderId)
    const safe = current
      ? {
          expectedRevision: current.revision,
          dispatchRound: current.dispatchRound,
          assignmentId: current.assignmentId,
          leaderId: current.leaderId,
          submissionId: current.submissionId,
          requestId: randomBytes(16).toString('hex'),
          ...body
        }
      : path === '/orders'
        ? { requestId: randomBytes(16).toString('hex'), ...body }
        : body
    return service.mutate(actor, path, safe)
  }
  const level = mutate('/levels', { name: '通知等级', delaySeconds: 0 })
  const users = {}
  for (const role of ['support', 'player', 'other'])
    users[role] = mutate('/users', {
      username: role,
      name: role,
      role: role === 'support' ? 'support' : 'player',
      status: 'active',
      password,
      maxActiveOrders: 1,
      levelId: level.id,
      permissionOverrides: {}
    })
  const customer = mutate('/customers', { name: '测试', gameId: '1' })
  const template = mutate('/templates', {
    name: '通知订单',
    game: '测试',
    amount: 2000,
    reward: 1001,
    active: true
  })
  const order = () =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId: 'xianyu',
        shopId: 'jindun',
        externalOrderNo: randomBytes(8).toString('hex'),
        roomCode: '1',
        amount: 2000,
        reward: 1001,
        receivedAmount: 2000,
        paidAt: time.toISOString(),
        dispatchMode: 'direct',
        assignedTo: users.player.id
      },
      users.support.id
    )
  const key = createECDH('prime256v1')
  key.generateKeys()
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-notification',
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url')
    }
  }
  return {
    app,
    service,
    mutate,
    users,
    order,
    sent,
    subscription,
    setTime(value) {
      time = new Date(value)
    }
  }
}

test('指定消息与订单事务一起提交，5分钟超时提醒只产生一次且接受后失效', (t) => {
  const f = fixture(t),
    order = f.order()
  assert.equal(
    f.app.notifications.list(f.users.player.id).records.filter((row) => row.type === 'assigned')
      .length,
    1
  )
  assert.equal(f.app.notifications.list(f.users.other.id).total, 0)
  f.setTime('2026-10-13T00:04:59Z')
  f.app.notifications.scanTimeouts()
  assert.equal(f.app.notifications.list(f.users.support.id, {}, false).total, 0)
  f.setTime('2026-10-13T00:05:00Z')
  f.app.notifications.scanTimeouts()
  f.app.notifications.scanTimeouts()
  assert.equal(f.app.notifications.list(f.users.support.id, {}, false).unread, 1)
  f.mutate(`/player/orders/${order.id}/claim`, {}, f.users.player.id)
  assert.equal(f.app.notifications.list(f.users.support.id, {}, false).unread, 0)
  assert.equal(
    f.service.bootstrap('admin').orders.find((row) => row.id === order.id).status,
    'active'
  )
})

test('重新指派后旧超时已读且新的指派重新计时；拒绝不取消客户单', (t) => {
  const f = fixture(t),
    order = f.order()
  f.setTime('2026-10-13T00:05:01Z')
  f.app.notifications.scanTimeouts()
  f.mutate(`/orders/${order.id}/action`, {
    action: 'dispatch',
    dispatchMode: 'direct',
    assignedTo: f.users.other.id
  })
  assert.equal(f.app.notifications.list(f.users.support.id, {}, false).unread, 0)
  f.app.notifications.scanTimeouts()
  assert.equal(f.app.notifications.list(f.users.support.id, {}, false).unread, 0)
  f.setTime('2026-10-13T00:10:01Z')
  f.app.notifications.scanTimeouts()
  assert.equal(f.app.notifications.list(f.users.support.id, {}, false).unread, 1)
  f.mutate(`/player/orders/${order.id}/reject`, { reason: '无法安排' }, f.users.other.id)
  const result = f.service.bootstrap('admin').orders.find((row) => row.id === order.id)
  assert.equal(result.status, 'pending')
  assert.equal(result.dispatchState, 'unassigned')
  assert.equal(f.app.notifications.list(f.users.support.id, {}, false).unread, 0)
})

test('消息读取和通知设置按本人隔离，推送地址禁止内网或任意服务器', (t) => {
  const f = fixture(t)
  f.order()
  const notice = f.app.notifications.list(f.users.player.id).records[0]
  assert.throws(
    () => f.mutate(`/player/notifications/${notice.id}/read`, {}, f.users.other.id),
    (error) => error instanceof ApiError && error.status === 404
  )
  f.mutate(`/player/notifications/${notice.id}/read`, {}, f.users.player.id)
  assert.equal(f.app.notifications.list(f.users.player.id).unread, 0)
  assert.deepEqual(f.app.notifications.settings(f.users.other.id), { pool: false, push: true })
  assert.throws(() =>
    f.mutate(
      '/player/push-subscriptions',
      { subscription: { ...f.subscription, endpoint: 'https://127.0.0.1/private' } },
      f.users.player.id
    )
  )
  assert.throws(() =>
    f.mutate('/player/notification-settings', { pool: 'true', push: true }, f.users.player.id)
  )
})

test('推送出站仅包含通用提醒，停用/换号绑定撤销且不会发给旧订阅', async (t) => {
  const f = fixture(t)
  f.mutate('/player/push-subscriptions', { subscription: f.subscription }, f.users.player.id)
  f.order()
  await f.app.notifications.flushPush()
  assert.equal(f.sent.length, 1)
  const payload = JSON.parse(f.sent[0][1])
  assert.equal(payload.url, '/#/player/messages')
  assert.equal(JSON.stringify(payload).includes(f.users.player.id), false)
  f.mutate('/player/push-subscriptions/test', {}, f.users.player.id)
  f.mutate('/player/push-subscriptions', { subscription: f.subscription }, f.users.other.id)
  await f.app.notifications.flushPush()
  assert.equal(f.sent.length, 1)
  f.mutate('/player/push-subscriptions/test', {}, f.users.other.id)
  f.mutate('/users', { ...f.users.other, status: 'disabled' })
  await f.app.notifications.flushPush()
  assert.equal(f.sent.length, 1)
})

test('通知在SQLite中持久化，服务重启后继续处理未接受指派', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'player-notifications-'))
  const dbPath = join(directory, 'studio.sqlite')
  let revivedApp
  t.after(async () => {
    if (revivedApp) await new Promise((resolve) => revivedApp.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  })
  const f = fixture(t, { dbPath })
  await new Promise((resolve) => f.app.listen(0, '127.0.0.1', resolve))
  f.order()
  await new Promise((resolve) => f.app.close(resolve))
  const app = (revivedApp = createStudioServer({
    dbPath,
    seed: false,
    clock: () => new Date('2026-10-13T00:06:00Z')
  }))
  app.notifications.scanTimeouts()
  assert.equal(
    app.notifications.list(f.users.player.id).records.filter((row) => row.type === 'assigned')
      .length,
    1
  )
  assert.equal(app.notifications.list(f.users.support.id, {}, false).unread, 1)
})

test('HTTP退出登录撤销通知绑定，匿名及非打手不能访问打手消息', async (t) => {
  const f = fixture(t)
  f.mutate('/player/push-subscriptions', { subscription: f.subscription }, f.users.player.id)
  await new Promise((resolve) => f.app.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${f.app.address().port}/api/studio`
  const login = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'player', password })
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(base + '/player/notifications')).status, 401)
  assert.equal(
    (await fetch(base + '/player/notifications', { headers: { Cookie: cookie } })).status,
    200
  )
  await fetch(base + '/logout', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.equal(
    f.service.db.prepare('SELECT COUNT(*) AS n FROM player_push_subscriptions').get().n,
    0
  )
})

test('永久失效的推送订阅清理所有未发队列，不留下超过单批20条的孤立待发消息', async (t) => {
  const f = fixture(t, {
    testPushSender: async () => {
      throw Object.assign(new Error('expired'), { statusCode: 410 })
    }
  })
  f.mutate('/player/push-subscriptions', { subscription: f.subscription }, f.users.player.id)
  for (let i = 0; i < 25; i++) f.mutate('/player/push-subscriptions/test', {}, f.users.player.id)
  await f.app.notifications.flushPush()
  assert.equal(
    f.service.db
      .prepare("SELECT COUNT(*) AS n FROM player_push_outbox WHERE status='pending'")
      .get().n,
    0
  )
  assert.equal(
    f.service.db.prepare('SELECT COUNT(*) AS n FROM player_push_subscriptions').get().n,
    0
  )
})
