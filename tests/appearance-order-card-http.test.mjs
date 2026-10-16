import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ApiError } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'
import { defaultAppearance, normalizeAppearance, projectAppearanceAudit, projectPublicAppearance } from '../server/appearance.mjs'
import { testMutate } from './helpers/current-intent.mjs'

const PASSWORD = 'isolated-order-card-v33-test-password'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const fails = (callback, status = 403) => assert.throws(callback, (error) => error instanceof ApiError && error.status === status)

async function fixture(t) {
  let time = new Date('2026-10-14T04:00:00Z')
  const server = createStudioServer({ dbPath: ':memory:', seed: false, password: PASSWORD, clock: () => time, notificationIntervalMs: 3_600_000 })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  t.after(() => new Promise((ready) => server.close(ready)))
  const service = server.service
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '卡图隔离等级', delaySeconds: 0 })
  const staff = (username, role, overrides = {}) => mutate('/users', {
    username, name: username, role, password: PASSWORD, status: 'active', levelId: level.id,
    maxActiveOrders: 3, permissionOverrides: overrides
  })
  const manager = staff('card-manager', 'hr', { 'settings.manage': true, 'logs.view': true })
  const otherManager = staff('card-manager-other', 'hr', { 'settings.manage': true })
  const reader = staff('card-reader', 'support')
  const player = staff('card-player', 'player', { 'settings.manage': true })
  const upload = (actor = manager.id, name = '卡图.png') => service.upload(actor, { name, mime: 'image/png', data: PNG })
  const get = () => service.getAppearance('admin')
  const save = (image, actor = manager.id, extra = {}) => mutate('/appearance', {
    config: { ...get(), ...extra, playerOrderCardImage: image }, revision: get().revision
  }, actor)
  const state = () => JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const setState = (value) => service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(value))
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const cookies = new Map()
  async function call(path, actor, body) {
    const isPlayer = actor === player.id
    const headers = { ...(isPlayer ? { 'X-Studio-Client': 'player' } : {}) }
    if (actor && !cookies.has(actor)) {
      const username = actor === 'admin' ? 'admin' : state().users.find((row) => row.id === actor).username
      const response = await fetch(base + '/login', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) })
      assert.equal(response.status, 200)
      cookies.set(actor, response.headers.get('set-cookie').split(';')[0])
    }
    if (actor) headers.Cookie = cookies.get(actor)
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  const injectAudit = (table, value) => {
    const id = randomUUID(), payload = JSON.stringify({ id, actorId: 'admin', actorName: '隔离管理员', entity: 'order', entityId: randomUUID(), createdAt: time.toISOString(), ...value })
    service.db.prepare(`INSERT INTO ${table}(id,actor_id,action,entity,entity_id,created_at,payload,byte_length) VALUES(?,?,?,?,?,?,?,?)`).run(id, 'admin', '隔离历史附件', 'order', id, time.toISOString(), payload, Buffer.byteLength(payload))
  }
  return { service, server, mutate, manager, otherManager, reader, player, upload, get, save, state, setState, call, injectAudit, setTime(value) { time = new Date(value) } }
}

test('v3.3旧配置只读补null、打手最小投影和匿名边界，读取不写状态或审计', async (t) => {
  const f = await fixture(t)
  const legacy = defaultAppearance()
  delete legacy.playerOrderCardImage
  const state = f.state(); state.appearance = legacy; f.setState(state)
  const before = f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  const writes = f.service.db.prepare('SELECT total_changes() AS n').get().n
  assert.equal(f.get().playerOrderCardImage, null)
  assert.deepEqual(f.service.playerAppearance(f.player.id), { revision: 0, orderCardImage: null })
  assert.equal(f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json, before)
  assert.equal(f.service.db.prepare('SELECT total_changes() AS n').get().n, writes)
  assert.equal(normalizeAppearance(legacy, (image) => image).playerOrderCardImage, null)
  assert.equal(projectAppearanceAudit(legacy).playerOrderCardImage, null)
  assert.equal(Object.hasOwn(projectPublicAppearance(defaultAppearance()), 'playerOrderCardImage'), false)
  assert.equal((await f.call('/player/appearance')).status, 401)
  assert.equal((await f.call('/player/appearance', 'admin')).status, 403)
  const response = await f.call('/player/appearance', f.player.id)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { revision: 0, orderCardImage: null })
})

test('真实HTTP上传保存后打手可读，摘要版本随卡图变化，合法配置图可由另一管理员复用', async (t) => {
  const f = await fixture(t)
  const prior = f.service.playerChanges(f.player.id)
  const uploaded = await f.call('/uploads', f.manager.id, { name: '真实卡图.png', mime: 'image/png', data: PNG })
  assert.equal(uploaded.status, 200)
  const image = await uploaded.json()
  assert.equal((await f.call(`/public-assets/${image.id}`)).status, 404)
  const saved = await f.call('/appearance', f.manager.id, { config: { ...f.get(), playerOrderCardImage: image }, revision: 0 })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).revision, 1)
  const current = await (await f.call('/player/appearance', f.player.id)).json()
  assert.deepEqual(current, { revision: 1, orderCardImage: image })
  const downloaded = await f.call(image.url.replace('/api/studio', ''), f.player.id)
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), Buffer.from(PNG, 'base64'))
  const changes = f.service.playerChanges(f.player.id, prior.version)
  assert.equal(changes.changed, true)
  assert.equal(changes.appearanceRevision, 1)
  assert.notEqual(changes.version, prior.version)
  assert.equal((await (await f.call('/player/changes', f.player.id)).json()).appearanceRevision, 1)
  assert.equal(f.save(image, f.otherManager.id, { studioName: '另一个合法管理员' }).revision, 2)
  assert.equal(Object.hasOwn(await (await f.call('/appearance/public')).json(), 'playerOrderCardImage'), false)
  assert.equal((await f.call(`/public-assets/${image.id}`)).status, 404)
  assert.equal((await f.call(image.url.replace('/api/studio', ''))).status, 401)
})

test('换图、移除和恢复默认撤旧共享，owner及其他当前合法槽独立保留原读取权', async (t) => {
  const f = await fixture(t)
  const first = f.upload(), second = f.upload()
  f.save(first)
  f.save(second)
  fails(() => f.service.download(f.player.id, first.id))
  assert.ok(f.service.download(f.manager.id, first.id).data.length)
  f.save(null)
  assert.equal(f.service.playerAppearance(f.player.id).orderCardImage, null)
  fails(() => f.service.download(f.player.id, second.id))
  f.save(first, f.manager.id, { logo: first })
  f.save(null)
  assert.ok(f.service.download(f.player.id, first.id).data.length)
  assert.ok(f.service.publicAsset(first.id).data.length)
  f.save(second)
  const reset = f.mutate('/appearance/reset', { revision: f.get().revision })
  assert.equal(reset.playerOrderCardImage, null)
  assert.equal(reset.logo, null)
  fails(() => f.service.download(f.player.id, second.id))
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE id IN (?,?)').get(first.id, second.id).n, 2)
})

test('编辑权限按新卡图实际变化限制，旧revision回滚且打手停用/撤登录读取拒绝', async (t) => {
  const f = await fixture(t)
  const image = f.upload(), another = f.upload(f.player.id)
  fails(() => f.save(image, f.reader.id))
  fails(() => f.save(another, f.player.id))
  f.save(image)
  const current = f.get()
  const untouched = f.mutate('/appearance', { config: { ...current, studioName: '有原覆盖权但未改卡图' }, revision: current.revision }, f.player.id)
  assert.equal(untouched.playerOrderCardImage.id, image.id)
  const olderBody = { ...f.get(), studioName: '旧客户端未提交卡图字段' }; delete olderBody.playerOrderCardImage
  assert.equal(f.mutate('/appearance', { config: olderBody, revision: f.get().revision }, f.player.id).playerOrderCardImage.id, image.id)
  fails(() => f.save(null, f.player.id))
  fails(() => f.save(another, f.player.id))
  fails(() => f.mutate('/appearance/reset', { revision: f.get().revision }, f.player.id))
  const before = f.get(), auditRows = f.service.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n
  fails(() => f.mutate('/appearance', { config: { ...before, playerOrderCardImage: null }, revision: 0 }), 409)
  assert.deepEqual(f.get(), before)
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, auditRows)
  await f.call('/player/appearance', f.player.id)
  f.mutate('/users', { ...f.player, playerAccess: { login: false, claim: true, withdraw: true } })
  fails(() => f.service.playerAppearance(f.player.id))
  fails(() => f.service.download(f.player.id, image.id))
  assert.equal((await f.call('/player/appearance', f.player.id)).status, 401)
  assert.equal((await f.call(image.url.replace('/api/studio', ''), f.player.id)).status, 401)
  f.mutate('/users', { ...f.player, status: 'disabled', playerAccess: { login: true, claim: true, withdraw: true } })
  fails(() => f.service.playerAppearance(f.player.id))
  fails(() => f.service.download(f.player.id, image.id))
})

test('现有凭证/材料字段、私人标记及资金实体拒共享，拥有私人图片不授予配置权', async (t) => {
  const f = await fixture(t)
  const image = f.upload('admin', '配置人自己的私人凭证.png')
  f.mutate('/expenses', { category: '隔离费用', amount: 10, date: '2026-10-14', purpose: '真实私人用途', receipt: image })
  fails(() => f.save(image, 'admin'))
  for (const buildReference of [(value) => ({ receipt: value }), (value) => ({ paymentSnapshot: { qrCode: value } }), (value) => ({ submissions: [{ screenshots: [value] }] })]) {
    const privateImage = f.upload('admin')
    const clean = f.state(); clean.expenses = []; clean.refunds = [buildReference(privateImage)]; f.setState(clean)
    fails(() => f.save(privateImage, 'admin'))
  }
  const qr = f.upload('admin')
  f.service.db.prepare('INSERT INTO player_private_uploads VALUES(?,?)').run(qr.id, 'admin')
  fails(() => f.save(qr, 'admin'))
  const customer = f.mutate('/customers', { name: '隔离资金客户', contact: '', gameId: '', remark: '' })
  const fundImage = f.upload('admin')
  f.mutate('/customer-transactions', { customerId: customer.id, kind: 'recharge', amount: 10, reason: '真实资金凭证', receipt: fundImage })
  fails(() => f.save(fundImage, 'admin'))
})

test('只留冷热敏感审计或成功结果的旧附件仍拒绝，不因文件名/说明文本误判', async (t) => {
  const f = await fixture(t)
  for (const table of ['audit_logs', 'audit_logs_archive']) {
    const image = f.upload('admin')
    f.injectAudit(table, { before: { submissions: [{ screenshots: [image] }] }, after: null })
    fails(() => f.save(image, 'admin'))
  }
  for (const table of ['business_requests', 'financial_requests']) {
    const image = f.upload('admin'), result = JSON.stringify({ paymentSnapshot: { qrCode: image } })
    if (table === 'business_requests') f.service.db.prepare('INSERT INTO business_requests VALUES(?,?,?,?,?,?)').run(randomUUID(), 'admin', '/orders', 'fixture-hash', result, '2026-10-14T04:00:00Z')
    else f.service.db.prepare('INSERT INTO financial_requests VALUES(?,?,?,?,?)').run(randomUUID(), 'admin', '/orders', '{}', result)
    fails(() => f.save(image, 'admin'))
  }
  const ordinary = f.upload('admin', 'receipt-qrCode-screenshots.png')
  f.injectAudit('audit_logs', { before: null, after: { reason: ordinary.id, title: `截图ID ${ordinary.id}`, image: ordinary } })
  assert.equal(f.save(ordinary, 'admin').playerOrderCardImage.id, ordinary.id)
})

test('当前卡图不能转业务/私人用途，提现未使用的额外receipt不能投毒后续合法保存', async (t) => {
  const f = await fixture(t)
  const image = f.upload('admin')
  f.save(image, 'admin')
  fails(() => f.mutate('/expenses', { category: '隔离', amount: 1, date: '2026-10-14', purpose: '不能转凭证', receipt: image }))
  fails(() => f.mutate('/profile', { name: '隔离管理员', avatar: image }))
  const qr = f.upload(f.player.id)
  f.mutate('/player/payment-methods', { method: 'wechat', qrCode: qr }, f.player.id)
  f.mutate('/player-adjustments', { userId: f.player.id, kind: 'supplement', amount: 1000, reason: '隔离补款' })
  const withdrawal = f.mutate('/player/withdrawals', { amount: 100, paymentMethod: 'wechat', receipt: { id: image.id } }, f.player.id)
  assert.equal(withdrawal.status, 'pending')
  assert.equal(withdrawal.receipt, undefined)
  assert.equal(f.save(image, 'admin', { studioName: '未使用参数不能投毒' }).playerOrderCardImage.id, image.id)
  fails(() => f.mutate('/player/payment-methods', { method: 'alipay', qrCode: image }, f.player.id))
})

test('新槽元数据及容量遵循真实上传限制，品牌/登录/审计投影保留且8MiB可保存', async (t) => {
  const f = await fixture(t)
  const card = f.upload(), brand = f.upload()
  const saved = f.save(card, f.manager.id, { logo: brand, login: { ...f.get().login, illustration: { mode: 'image', image: brand } } })
  assert.equal(f.service.publicAsset(brand.id).id, brand.id)
  assert.equal(projectAppearanceAudit(saved).playerOrderCardImage.id, card.id)
  const before = f.get()
  for (const forged of [{ ...card, url: 'https://example.invalid/private.png' }, { ...card, mime: 'image/svg+xml' }, { ...card, size: card.size + 1 }, { id: card.id, source: 'external' }]) fails(() => f.save(forged), 400)
  assert.deepEqual(f.get(), before)
  const unreferencedOther = f.upload(f.reader.id)
  fails(() => f.save(unreferencedOther))
  const data = Buffer.alloc(8 * 1024 * 1024); Buffer.from(PNG, 'base64').copy(data)
  const large = f.service.upload(f.manager.id, { name: '8MiB.png', mime: 'image/png', data: data.toString('base64') })
  assert.equal(f.save(large).playerOrderCardImage.size, 8 * 1024 * 1024)
  fails(() => f.service.upload(f.manager.id, { name: 'over.png', mime: 'image/png', data: Buffer.concat([data, Buffer.alloc(1)]).toString('base64') }), 400)
  fails(() => f.service.upload(f.manager.id, { name: 'wrong.png', mime: 'image/jpeg', data: PNG }), 400)
})

test('当前卡图与历史外观审计沿用GC引用保护，保留二进制不恢复旧共享', async (t) => {
  const f = await fixture(t)
  const old = f.upload(), current = f.upload(), unused = f.upload()
  f.save(old)
  f.save(current)
  f.setTime('2026-10-24T04:00:00Z')
  const collected = f.service.collectAbandonedUploads()
  assert.ok(collected.deleted >= 1)
  assert.equal(f.service.db.prepare('SELECT 1 FROM uploads WHERE id=?').get(unused.id), undefined)
  assert.ok(f.service.db.prepare('SELECT 1 FROM uploads WHERE id=?').get(old.id))
  assert.ok(f.service.download(f.player.id, current.id).data.length)
  fails(() => f.service.download(f.player.id, old.id))
})
