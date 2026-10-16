import { testMutate, installTestClientFetch } from './helpers/current-intent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { createStudioServer } from '../server/index.mjs'

const PASSWORD = 'isolated-player-content-password'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const fails = (callback, status) =>
  assert.throws(callback, (error) => error instanceof ApiError && error.status === status)
function fixture(t, options = {}) {
  let time = new Date('2026-10-14T04:00:00Z')
  const service = createStudioService({
    dbPath: ':memory:',
    seed: false,
    password: PASSWORD,
    clock: () => time,
    ...options
  })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '等级', delaySeconds: 0 })
  const createUser = (name, role, extra = {}) =>
    mutate('/users', {
      username: name,
      name,
      role,
      status: 'active',
      maxActiveOrders: 1,
      permissionOverrides: {},
      password: PASSWORD,
      ...(role === 'player' ? { levelId: level.id } : {}),
      ...extra
    })
  const player = createUser('worker', 'player', {
    permissionOverrides: { 'settings.manage': true, 'logs.view': true }
  })
  const admin = createUser('second-admin', 'admin')
  const finance = createUser('finance', 'finance')
  const upload = (actor = 'admin') =>
    service.upload(actor, { name: 'board.png', mime: 'image/png', data: PNG })
  const draft = (extra = {}, actor = 'admin') =>
    mutate(
      '/player-content',
      {
        type: 'announcement',
        title: '工作室通知',
        text: '按要求上报完成',
        body: '详情正文\n第二行',
        imageId: null,
        sortOrder: 0,
        startAt: null,
        endAt: null,
        ...extra
      },
      actor
    )
  const action = (row, kind, actor = 'admin') =>
    mutate(`/player-content/${row.id}/${kind}`, { revision: row.revision }, actor)
  return {
    service,
    mutate,
    draft,
    action,
    upload,
    player,
    admin,
    finance,
    setTime: (value) => {
      time = new Date(value)
    }
  }
}

test('草稿不进入打手端，修改已发布快照前标题、详情、排序和图片均保留旧版本', (t) => {
  const f = fixture(t)
  const first = f.draft({ title: '第一条', sortOrder: 1 }),
    second = f.draft({ title: '第二条', sortOrder: 2 })
  assert.equal(first.status, 'draft')
  assert.equal(first.hasUnpublishedChanges, true)
  assert.deepEqual(f.service.playerContent(f.player.id).announcements, [])
  fails(() => f.service.playerContent(f.player.id, first.id), 404)
  const published = f.action(first, 'publish')
  f.action(second, 'publish')
  assert.equal(published.status, 'active')
  assert.equal(published.hasUnpublishedChanges, false)
  const changed = f.draft({
    id: published.id,
    revision: published.revision,
    title: '修改未发布',
    body: '新详情',
    sortOrder: 9
  })
  const current = f.service.playerContent(f.player.id)
  assert.deepEqual(
    current.announcements.map((row) => row.title),
    ['第一条', '第二条']
  )
  assert.equal(current.announcements[0].body, '详情正文\n第二行')
  assert.equal(changed.published.title, '第一条')
  assert.equal(changed.hasUnpublishedChanges, true)
  const next = f.action(changed, 'publish')
  assert.equal(next.hasUnpublishedChanges, false)
  assert.deepEqual(
    f.service.playerContent(f.player.id).announcements.map((row) => row.title),
    ['第二条', '修改未发布']
  )
  assert.deepEqual(Object.keys(f.service.playerContent(f.player.id, first.id)).sort(), [
    'body',
    'endAt',
    'id',
    'image',
    'publishedAt',
    'sortOrder',
    'startAt',
    'text',
    'title',
    'type'
  ])
})

test('开始时间含边界自动生效，结束时间含边界自动消失，时区转换与状态可刷新', (t) => {
  const f = fixture(t)
  const image = f.upload()
  const draft = f.draft({
    type: 'banner',
    imageId: image.id,
    startAt: '2026-10-14T12:01:00+08:00',
    endAt: '2026-10-14T12:02:00+08:00'
  })
  const published = f.action(draft, 'publish')
  assert.equal(published.status, 'scheduled')
  assert.equal(published.startAt, '2026-10-14T04:01:00.000Z')
  assert.equal(f.service.playerContent(f.player.id).banners.length, 0)
  fails(() => f.service.playerContentAsset(f.player.id, image.id), 404)
  assert.equal(
    f.service.playerContentAsset('admin', image.id, 'admin').size,
    Buffer.from(PNG, 'base64').length
  )
  f.setTime('2026-10-14T04:01:00.000Z')
  assert.equal(f.service.adminPlayerContent('admin').items[0].status, 'active')
  assert.equal(f.service.playerContent(f.player.id).banners.length, 1)
  assert.equal(f.service.playerContentAsset(f.player.id, image.id).mime, 'image/png')
  f.setTime('2026-10-14T04:02:00.000Z')
  assert.equal(f.service.adminPlayerContent('admin').items[0].status, 'expired')
  assert.equal(f.service.playerContent(f.player.id).banners.length, 0)
  fails(() => f.service.playerContent(f.player.id, draft.id), 404)
  fails(() => f.service.playerContentAsset(f.player.id, image.id), 404)
  fails(() => f.action(published, 'publish'), 409)
})

test('轮播草稿替换图片不会替换线上图片，新图片仅在再次发布后给打手读取', (t) => {
  const f = fixture(t),
    original = f.upload(),
    replacement = f.upload()
  const published = f.action(f.draft({ type: 'banner', imageId: original.id }), 'publish')
  const changed = f.draft({
    id: published.id,
    revision: published.revision,
    type: 'banner',
    imageId: replacement.id
  })
  assert.equal(changed.image.id, replacement.id)
  assert.equal(changed.published.image.id, original.id)
  assert.equal(f.service.playerContent(f.player.id).banners[0].image.id, original.id)
  assert.equal(f.service.playerContentAsset(f.player.id, original.id).id, original.id)
  fails(() => f.service.playerContentAsset(f.player.id, replacement.id), 404)
  f.action(changed, 'publish')
  assert.equal(f.service.playerContent(f.player.id).banners[0].image.id, replacement.id)
  fails(() => f.service.playerContentAsset(f.player.id, original.id), 404)
})

test('内容列表和详情读取每张图片最多 12 字节，实际图片接口仍返回完整文件', (t) => {
  const f = fixture(t),
    images = [f.upload(), f.upload()],
    published = images.map((image, index) =>
      f.action(f.draft({ type: 'banner', title: `轮播 ${index}`, imageId: image.id }), 'publish')
    )
  const db = f.service.db,
    prepare = db.prepare.bind(db),
    imageReads = []
  t.mock.method(db, 'prepare', (sql) => {
    const statement = prepare(sql)
    if (/^SELECT\b.*\bFROM uploads\b/i.test(sql)) {
      const get = statement.get.bind(statement)
      t.mock.method(statement, 'get', (...parameters) => {
        const row = get(...parameters)
        if (row)
          imageReads.push(
            Object.values(row)
              .filter((value) => value instanceof Uint8Array)
              .reduce((total, value) => total + value.byteLength, 0)
          )
        return row
      })
    }
    return statement
  })
  assert.equal(f.service.playerContent(f.player.id).banners.length, 2)
  assert.equal(f.service.playerContent(f.player.id, published[0].id).id, published[0].id)
  assert.ok(imageReads.length > 0)
  assert.ok(
    imageReads.every((size) => size <= 12),
    `元数据读取了完整图片：${imageReads}`
  )
  imageReads.length = 0
  const asset = f.service.playerContentAsset(f.player.id, images[0].id)
  assert.deepEqual(asset.data, Buffer.from(PNG, 'base64'))
  assert.deepEqual(imageReads, [asset.data.length])
})

test('图片元数据读取仍拒绝损坏签名、长度不符和新增私人引用', (t) => {
  const f = fixture(t),
    valid = f.upload(),
    invalid = [f.upload(), f.upload(), f.upload()]
  const contents = [valid, ...invalid].map((image) =>
    f.action(f.draft({ type: 'banner', imageId: image.id }), 'publish')
  )
  const broken = Buffer.from(PNG, 'base64')
  broken[0] = 0
  f.service.db.prepare('UPDATE uploads SET data=? WHERE id=?').run(broken, invalid[0].id)
  f.service.db.prepare('UPDATE uploads SET size=size+1 WHERE id=?').run(invalid[1].id)
  f.service.db
    .prepare('INSERT INTO player_private_uploads VALUES(?,?)')
    .run(invalid[2].id, f.player.id)
  assert.deepEqual(
    f.service.playerContent(f.player.id).banners.map((row) => row.id),
    [contents[0].id]
  )
  for (const content of contents.slice(1))
    fails(() => f.service.playerContent(f.player.id, content.id), 404)
  for (const image of invalid.slice(0, 2))
    fails(() => f.service.playerContentAsset(f.player.id, image.id), 400)
  fails(() => f.service.playerContentAsset(f.player.id, invalid[2].id), 403)
})

test('下架立即失效，保留草稿和发布快照；发布中的内容不能直接删除', (t) => {
  const f = fixture(t),
    image = f.upload()
  const published = f.action(f.draft({ type: 'banner', imageId: image.id }), 'publish')
  fails(() => f.action(published, 'delete'), 409)
  const offline = f.action(published, 'offline')
  assert.equal(offline.status, 'offline')
  assert.equal(offline.imageId, image.id)
  assert.equal(offline.published.image.id, image.id)
  assert.equal(f.service.playerContent(f.player.id).banners.length, 0)
  fails(() => f.service.playerContentAsset(f.player.id, image.id), 404)
  f.action(offline, 'delete')
  assert.equal(f.service.adminPlayerContent('admin').items.length, 0)
  fails(() => f.service.playerContentAsset('admin', image.id, 'admin'), 404)
  const untouched = f.draft()
  assert.deepEqual(f.action(untouched, 'delete'), { ok: true })
})

test('多人编辑、发布、下架、删除均需版本；旧版本冲突不改内容或审计', (t) => {
  const f = fixture(t),
    draft = f.draft()
  const changed = f.draft(
    { id: draft.id, revision: draft.revision, text: '第二管理员修改' },
    f.admin.id
  )
  const beforeLogs = f.service.logs('admin', { entity: 'player-content' }).total
  fails(() => f.draft({ id: draft.id, revision: draft.revision, text: '覆盖' }), 409)
  for (const action of ['publish', 'offline', 'delete']) fails(() => f.action(draft, action), 409)
  fails(() => f.mutate(`/player-content/${draft.id}/publish`, {}), 409)
  assert.equal(f.service.logs('admin', { entity: 'player-content' }).total, beforeLogs)
  assert.equal(f.service.adminPlayerContent('admin').items[0].text, '第二管理员修改')
  assert.equal(f.action(changed, 'publish', f.admin.id).updatedBy, f.admin.id)
})

test('管理与展示权限从角色及设置权限双重验证，审计仅配置管理员可读', (t) => {
  const f = fixture(t),
    draft = f.draft()
  for (const actor of [f.player.id, f.finance.id]) {
    fails(() => f.service.adminPlayerContent(actor), 403)
    fails(() => f.draft({}, actor), 403)
    fails(() => f.action(draft, 'publish', actor), 403)
  }
  fails(() => f.service.playerContent('admin'), 403)
  const logs = f.service.logs('admin', { entity: 'player-content' }).records
  assert.equal(logs.length, 1)
  assert.equal(logs[0].before, null)
  assert.equal(logs[0].after.title, draft.title)
  assert.deepEqual(f.service.logs(f.finance.id, { entity: 'player-content' }).records, [])
  assert.equal(f.service.logs(f.finance.id, { entity: 'player-content' }).total, 0)
  fails(() => f.service.logDetail(f.finance.id, logs[0].id), 404)
  const offlineUser = f.mutate('/users', { ...f.player, status: 'disabled' })
  fails(() => f.service.playerContent(offlineUser.id), 403)
})

test('图片按上传文件验证，禁止任意 URL、伪造元数据及他人的其他内容图片', (t) => {
  const f = fixture(t),
    own = f.upload(),
    other = f.upload(f.admin.id)
  const draft = f.draft({ type: 'banner', imageId: own.id })
  const published = f.action(draft, 'publish')
  assert.equal(published.published.image.url, `/api/studio/player-content/assets/${own.id}`)
  assert.equal(
    f.service.playerContent(f.player.id).banners[0].image.url,
    `/api/studio/player/content-assets/${own.id}`
  )
  assert.equal(
    f.draft(
      { id: published.id, revision: published.revision, type: 'banner', imageId: own.id },
      f.admin.id
    ).imageId,
    own.id
  )
  fails(() => f.draft({ type: 'banner', imageId: own.id }, f.admin.id), 403)
  fails(() => f.draft({ type: 'banner', imageId: other.id }), 403)
  fails(() => f.draft({ type: 'banner', imageId: 'https://evil.example/image.png' }), 400)
  fails(() => f.draft({ image: { id: own.id, url: 'https://evil.example/' } }), 400)
  fails(() => f.draft({ imageId: { id: own.id } }), 400)
  fails(() => f.service.playerContentAsset(f.finance.id, own.id, 'admin'), 403)
  const orphan = f.upload()
  fails(() => f.service.playerContentAsset('admin', orphan.id, 'admin'), 404)
  f.service.db.prepare('UPDATE uploads SET data=? WHERE id=?').run(Buffer.from('broken'), orphan.id)
  fails(() => f.draft({ type: 'banner', imageId: orphan.id }), 400)
})

test('私人收款码、业务凭证和资金凭证不能借用，发布后图片也不能转为私人业务凭证', (t) => {
  const f = fixture(t)
  const privateImage = f.upload(f.player.id)
  f.mutate('/player/payment-methods', { method: 'wechat', qrCode: privateImage }, f.player.id)
  fails(() => f.draft({ type: 'banner', imageId: privateImage.id }), 403)
  const receipt = f.upload()
  const customer = f.mutate('/customers', { name: '测试客户', contact: '', gameId: '', remark: '' })
  const template = f.mutate('/templates', {
    name: '测试模板',
    game: '测试游戏',
    description: '',
    map: '不限',
    amount: 200,
    reward: 100,
    active: true
  })
  f.mutate('/orders', {
    customerId: customer.id,
    templateId: template.id,
    platformId: 'xianyu',
    shopId: 'jindun',
    externalOrderNo: 'CONTENT-TEST',
    roomCode: 'TEST-ROOM',
    gameId: '',
    map: '不限',
    amount: 200,
    reward: 100,
    receivedAmount: 200,
    paidAt: '2026-10-14T04:00:00.000Z',
    receipt,
    dispatchMode: 'pool'
  })
  fails(() => f.draft({ type: 'banner', imageId: receipt.id }), 403)
  const fundsReceipt = f.upload()
  f.mutate('/player-deposit-transactions', {
    userId: f.player.id,
    accountId: f.player.id,
    kind: 'deposit',
    amount: 100,
    reason: '测试押金',
    requestId: 'test-content-funds-receipt',
    receipt: fundsReceipt
  })
  fails(() => f.draft({ type: 'banner', imageId: fundsReceipt.id }), 403)
  const clean = f.upload(),
    board = f.draft({ type: 'banner', imageId: clean.id })
  f.action(board, 'publish')
  fails(
    () => f.mutate('/player/payment-methods', { method: 'alipay', qrCode: clean }, f.player.id),
    403
  )
  fails(() => f.mutate('/profile', { name: '管理员', avatar: clean }), 403)
})

test('输入长度、非法时间、范围、HTML、无效字段及发布缺项全部被服务端拒绝', (t) => {
  const f = fixture(t)
  const invalid = [
    { title: '' },
    { title: '长'.repeat(81) },
    { text: '长'.repeat(301) },
    { body: '长'.repeat(20001) },
    { title: '<script>alert(1)</script>' },
    { body: '<img src=x onerror=alert(1)>' },
    { text: null },
    { type: 'link' },
    { sortOrder: -1 },
    { sortOrder: 10000 },
    { sortOrder: 0.5 },
    { startAt: '2026-02-30T12:00:00Z' },
    { startAt: '2026-10-14T24:00:00Z' },
    { startAt: '2026-10-14T04:00:00' },
    { startAt: '2026-10-14T04:00:00Z', endAt: '2026-10-14T04:00:00Z' },
    { endAt: '' },
    { enabled: true },
    { status: 'active' },
    { published: {} },
    { id: '' }
  ]
  for (const body of invalid) fails(() => f.draft(body), 400)
  const emptyBanner = f.draft({ type: 'banner' }),
    emptyNotice = f.draft({ text: '' })
  fails(() => f.action(emptyBanner, 'publish'), 400)
  fails(() => f.action(emptyNotice, 'publish'), 400)
  fails(() => f.action(f.draft({ endAt: '2026-10-14T03:59:59Z' }), 'publish'), 409)
  assert.equal(f.service.playerContent(f.player.id).announcements.length, 0)
})

test('内容数量封顶，删除旧草稿后可继续创建', (t) => {
  const f = fixture(t)
  const drafts = Array.from({ length: 100 }, (_, index) => f.draft({ title: `通知 ${index}` }))
  fails(() => f.draft(), 409)
  f.action(drafts[0], 'delete')
  f.draft()
  assert.equal(f.service.adminPlayerContent('admin').items.length, 100)
})

test('事务后置处理失败时，内容草稿、发布快照及审计同时回滚', (t) => {
  let rejectTransaction = false
  const f = fixture(t, {
    onTransaction: () => {
      if (rejectTransaction) throw new Error('isolated rollback')
    }
  })
  const draft = f.draft(),
    logCount = f.service.logs('admin', { entity: 'player-content' }).total
  rejectTransaction = true
  assert.throws(() => f.action(draft, 'publish'), /isolated rollback/)
  assert.throws(
    () => f.draft({ id: draft.id, revision: draft.revision, title: '不能留下的修改' }),
    /isolated rollback/
  )
  const current = f.service.adminPlayerContent('admin').items[0]
  assert.equal(current.revision, draft.revision)
  assert.equal(current.status, 'draft')
  assert.equal(current.published, null)
  assert.equal(current.title, draft.title)
  assert.equal(f.service.logs('admin', { entity: 'player-content' }).total, logCount)
})

test('重启保留已发布快照及未发布修改，审计包含每次变更前后', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-player-content-'))
  const dbPath = join(directory, 'test.sqlite')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let service = createStudioService({ dbPath, password: PASSWORD, seed: false })
  const body = {
    type: 'announcement',
    title: '持久通知',
    text: '已发布文字',
    body: '',
    imageId: null,
    sortOrder: 0,
    startAt: null,
    endAt: null
  }
  const draft = testMutate(service, 'admin', '/player-content', body)
  const active = testMutate(service, 'admin', `/player-content/${draft.id}/publish`, {
    revision: draft.revision
  })
  testMutate(service, 'admin', '/player-content', {
    ...body,
    id: active.id,
    revision: active.revision,
    text: '尚未发布文字'
  })
  service.close()
  service = createStudioService({ dbPath, seed: false })
  try {
    const row = service.adminPlayerContent('admin').items[0]
    assert.equal(row.text, '尚未发布文字')
    assert.equal(row.published.text, '已发布文字')
    assert.equal(row.hasUnpublishedChanges, true)
    const logs = service.logs('admin', { entity: 'player-content' }).records
    assert.equal(logs.length, 3)
    assert.ok(
      logs.some((row) => row.before?.text === '已发布文字' && row.after?.text === '尚未发布文字')
    )
  } finally {
    service.close()
  }
})

test('HTTP 按管理和打手 cookie 隔离内容、图片与权限，未登录不给公开内容', async (t) => {
  const instance = createStudioServer({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: true,
    clock: () => new Date('2026-10-14T04:00:00Z')
  })
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => instance.close(resolve))
  })
  const base = `http://127.0.0.1:${instance.address().port}/api/studio`
  const request = (path, cookie = '', player = false, body) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(player ? { 'X-Studio-Client': 'player' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const adminLogin = await request('/login', '', false, { username: 'admin', password: PASSWORD })
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0]
  testMutate(instance.service, 'admin', '/users', {
    ...instance.service.bootstrap('admin').users.find((row) => row.id === 'player-demo-1'),
    password: PASSWORD
  })
  const playerLogin = await request('/login', '', true, {
    username: 'player-demo-1',
    password: PASSWORD
  })
  const playerCookie = playerLogin.headers.get('set-cookie').split(';')[0]
  const image = instance.service.upload('admin', { name: 'http.png', mime: 'image/png', data: PNG })
  const saved = await request('/player-content', adminCookie, false, {
    type: 'banner',
    title: '板报',
    text: '',
    body: '详情',
    imageId: image.id,
    sortOrder: 0,
    startAt: null,
    endAt: null
  })
  assert.equal(saved.status, 200)
  const draft = await saved.json()
  assert.equal((await request('/player/content', '', true)).status, 401)
  assert.equal((await request('/player-content', playerCookie, true)).status, 403)
  assert.equal(
    (await request(`/player/content-assets/${image.id}`, playerCookie, true)).status,
    404
  )
  assert.equal((await request(`/player-content/assets/${image.id}`, adminCookie)).status, 200)
  assert.equal(
    (
      await request(`/player-content/${draft.id}/publish`, adminCookie, false, {
        revision: draft.revision
      })
    ).status,
    200
  )
  const content = await request('/player/content', playerCookie, true)
  assert.equal(content.status, 200)
  const payload = await content.json()
  assert.equal(payload.banners[0].title, '板报')
  assert.equal(JSON.stringify(payload).includes('updatedBy'), false)
  const asset = await request(`/player/content-assets/${image.id}`, playerCookie, true)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-type'), 'image/png')
  assert.match(asset.headers.get('cache-control'), /no-store/)
  assert.equal((await request('/player/content', adminCookie, true)).status, 401)
})

installTestClientFetch()
