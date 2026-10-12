import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudioService, ApiError } from '../server/studio.mjs'
import { defaultAppearance } from '../server/appearance.mjs'
import { buildExportSheets } from '../server/report-export.mjs'

const PASSWORD = 'appearance-test-password-123'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const rejected = (fn, status = 400) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status)

function fixture(t) {
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    clock: () => new Date('2026-10-13T02:00:00Z')
  })
  t.after(() => service.close())
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, body)
  const staff = (name, role = 'hr', overrides = {}) =>
    mutate('/users', {
      username: name,
      name,
      role,
      status: 'active',
      maxActiveOrders: 1,
      permissionOverrides: overrides,
      password: PASSWORD
    })
  const readOnly = staff('appearance-readonly', 'support', { 'logs.view': true })
  const manager = staff('appearance-manager', 'hr', { 'settings.manage': true, 'logs.view': true })
  const uploader = staff('appearance-other-owner')
  const upload = (actor = 'admin', name = '背景.png') =>
    service.upload(actor, { name, mime: 'image/png', data: PNG })
  const get = (actor = 'admin') => service.bootstrap(actor, '2026-10').appearance
  const save = (config, actor = 'admin', revision = get(actor).revision) =>
    mutate('/appearance', { config, revision }, actor)
  return { service, mutate, staff, readOnly, manager, uploader, upload, get, save }
}

test('外观默认值给所有登录账号，保存实际共享且只有配置授权可写', (t) => {
  const f = fixture(t)
  assert.deepEqual(f.get(), defaultAppearance())
  assert.deepEqual(f.get(f.readOnly.id), defaultAppearance())
  const logo = f.upload(f.manager.id, '工作室标志.png')
  const config = {
    ...f.get(),
    studioName: '  新品牌工作室  ',
    logo,
    page: { mode: 'color', color: '#AAbbCC', image: null, overlay: 60 },
    hero: { mode: 'image', color: '#eef4ff', image: logo, overlay: 40, showDecoration: false },
    icons: { dashboard: 'ri:gamepad-line' },
    revision: 999,
    updatedBy: 'forged-owner'
  }
  rejected(() => f.save(config, f.readOnly.id), 403)
  const result = f.save(config, f.manager.id)
  assert.equal(result.studioName, '新品牌工作室')
  assert.equal(result.page.color, '#aabbcc')
  assert.equal(result.logo.url, `/api/studio/uploads/${logo.id}`)
  assert.equal(result.revision, 1)
  assert.equal(result.updatedBy, f.manager.id)
  assert.equal(result.updatedAt, '2026-10-13T02:00:00.000Z')
  assert.equal(result.icons.dashboard, 'ri:gamepad-line')
  assert.equal(result.icons.orderList, undefined)
  assert.deepEqual(f.service.getAppearance(f.readOnly.id), result)
  assert.deepEqual(f.get(f.readOnly.id), result)
  assert.equal(f.service.download(f.readOnly.id, logo.id).mime, 'image/png')
  result.studioName = '客户端篡改'
  assert.equal(f.get().studioName, '新品牌工作室')
})

test('配置乐观版本保护不覆盖他人修改，恢复默认递增版本且解绑图片', (t) => {
  const f = fixture(t)
  const image = f.upload(f.manager.id)
  const current = f.save(
    { ...f.get(), logo: image, page: { ...f.get().page, mode: 'image', image } },
    f.manager.id
  )
  rejected(() => f.save({ ...current, studioName: '过期修改' }, 'admin', 0), 409)
  rejected(() => f.mutate('/appearance/reset', { revision: 0 }), 409)
  rejected(() => f.mutate('/appearance/reset', { revision: current.revision }, f.readOnly.id), 403)
  rejected(() => f.save(current, 'admin', '1'))
  const reset = f.mutate('/appearance/reset', { revision: current.revision })
  assert.equal(reset.revision, 2)
  assert.equal(reset.logo, null)
  assert.equal(reset.page.mode, 'default')
  assert.equal(reset.studioName, '电竞工作室')
  rejected(() => f.service.download(f.readOnly.id, image.id), 403)
  assert.ok(f.service.download(f.manager.id, image.id).data.length > 0)
  assert.equal(
    f.service.db.prepare('SELECT COUNT(*) AS count FROM uploads WHERE id=?').get(image.id).count,
    1
  )
})

test('不可借用其他人付款凭证作为外观，当前外观已关联图片可由其他配置管理员继续编辑', (t) => {
  const f = fixture(t)
  const privateImage = f.upload(f.uploader.id, '他人的财务凭证.png')
  const expense = f.mutate('/expenses', {
    category: '私有费用',
    amount: 100,
    date: '2026-10-13',
    purpose: '归属验证',
    receipt: f.upload()
  })
  // 超管可阅读业务凭证，也不能将其他人的图片借为共享品牌附件。
  rejected(() => f.save({ ...f.get(), logo: privateImage }), 403)
  rejected(
    () =>
      f.save(
        { ...f.get(), page: { ...f.get().page, mode: 'image', image: expense.receipt } },
        f.manager.id
      ),
    403
  )
  const brand = f.upload(f.manager.id, '已共享品牌.png')
  f.save({ ...f.get(), logo: brand }, f.manager.id)
  const changed = f.save({ ...f.get(), studioName: '另一位管理员编辑' })
  assert.equal(changed.logo.id, brand.id)
  assert.equal(f.service.download(f.readOnly.id, brand.id).name, '已共享品牌.png')
  // 非图片模式保存的图片仍可供配置管理员保留，但不作为所有员工可下载的活动背景。
  const inactive = f.upload(f.manager.id, '暂存背景.png')
  f.save({ ...f.get(), page: { ...f.get().page, mode: 'color', image: inactive } }, f.manager.id)
  rejected(() => f.service.download(f.readOnly.id, inactive.id), 403)
  const otherManager = f.staff('appearance-other-manager', 'hr', { 'settings.manage': true })
  assert.equal(f.service.download(otherManager.id, inactive.id).name, '暂存背景.png')
  f.save({ ...f.get(), page: { ...f.get().page, mode: 'image' } })
  assert.equal(f.service.download(f.readOnly.id, inactive.id).name, '暂存背景.png')
})

test('共享标志读取不授予业务附件复用权限，无订单查看的下单账号仍必须使用自己的付款凭证', (t) => {
  const f = fixture(t)
  const actor = f.staff('appearance-order-only', 'support', { 'orders.view': false })
  const logo = f.upload('admin', '共享工作室标志.png')
  f.save({ ...f.get(), logo })
  assert.equal(f.service.download(actor.id, logo.id).name, '共享工作室标志.png')
  const permissions = f.service.bootstrap(actor.id).permissions
  assert.ok(permissions.includes('orders.create'))
  assert.equal(permissions.includes('orders.view'), false)
  assert.equal(permissions.includes('settings.manage'), false)
  const customer = f.mutate('/customers', {
    name: '付款凭证测试客户',
    contact: '',
    gameId: 'GAME',
    remark: ''
  })
  const template = f.mutate('/templates', {
    name: '付款凭证测试项目',
    game: '测试',
    description: '',
    amount: 10000,
    reward: 7000,
    map: '不限',
    remark: '',
    active: true
  })
  const order = {
    templateId: template.id,
    customerId: customer.id,
    platformId: 'hall',
    shopId: null,
    externalOrderNo: '',
    channel: '测试',
    roomCode: 'ROOM',
    gameId: 'GAME',
    amount: 10000,
    reward: 7000,
    receivedAmount: 10000,
    paidAt: '2026-10-13T01:00:00Z',
    receipt: logo,
    dispatchMode: 'pool'
  }
  rejected(() => f.mutate('/orders', order, actor.id), 403)
  assert.equal(f.service.bootstrap('admin').orders.length, 0)
  const ownReceipt = f.upload(actor.id, '自己的付款凭证.png')
  const created = f.mutate('/orders', { ...order, receipt: ownReceipt }, actor.id)
  assert.equal(created.receipt.id, ownReceipt.id)
  assert.equal(created.receivedAmount, 10000)
})

test('外观只接受安全结构、颜色范围和图标白名单，不接受外链、数据串、SVG或伪造附件', (t) => {
  const f = fixture(t)
  const image = f.upload()
  const badConfigs = [
    { ...f.get(), studioName: '<img src=x onerror=alert(1)>' },
    { ...f.get(), studioName: '' },
    { ...f.get(), studioName: 'x'.repeat(41) },
    { ...f.get(), html: '<div>bad</div>' },
    { ...f.get(), page: { ...f.get().page, color: 'url(https://example.com)' } },
    { ...f.get(), page: { ...f.get().page, overlay: 91 } },
    { ...f.get(), page: { ...f.get().page, overlay: 0.5 } },
    { ...f.get(), hero: { ...f.get().hero, overlay: 71 } },
    { ...f.get(), hero: { ...f.get().hero, showDecoration: 'true' } },
    { ...f.get(), page: { ...f.get().page, mode: 'image' } },
    { ...f.get(), logo: 'data:image/svg+xml,content' },
    { ...f.get(), logo: { ...image, data: PNG } },
    { ...f.get(), logo: { ...image, url: 'https://example.com/logo.png' } },
    { ...f.get(), logo: { ...image, mime: 'image/svg+xml' } },
    { ...f.get(), logo: { ...image, size: 1 } },
    { ...f.get(), icons: { UnknownRoute: 'ri:home-line' } },
    { ...f.get(), icons: { dashboard: 'ri:not-real' } },
    { ...f.get(), icons: { dashboard: 'https://example.com/icon.svg' } },
    { ...f.get(), icons: { dashboard: '<svg>bad</svg>' } }
  ]
  for (const config of badConfigs) rejected(() => f.save(config))
  assert.equal(f.get().revision, 0)
  f.service.db
    .prepare('UPDATE uploads SET data=? WHERE id=?')
    .run(Buffer.from('<svg>bad</svg>'), image.id)
  rejected(() => f.save({ ...f.get(), logo: image }))
})

test('外观审计详情只对配置管理员开放，普通日志与导出不泄露配置前后值，旧数据库自动只读默认', (t) => {
  const f = fixture(t)
  f.save(
    { ...f.get(), studioName: '审计品牌', logo: f.upload(f.manager.id, 'brand-private-old.png') },
    f.manager.id
  )
  f.mutate('/appearance/reset', { revision: 1 })
  const managerData = f.service.bootstrap(f.manager.id, '2026-10', { exportMode: true })
  const changed = managerData.logs.find(
    (row) => row.entity === 'appearance' && row.action === '恢复默认界面外观'
  )
  assert.equal(changed.before.studioName, '审计品牌')
  assert.equal(changed.after.revision, 2)
  const plain = f.service.bootstrap(f.readOnly.id, '2026-10', { exportMode: true })
  assert.ok(plain.logs.some((row) => row.entity === 'appearance'))
  for (const log of plain.logs.filter((row) => row.entity === 'appearance')) {
    assert.equal(log.before, null)
    assert.equal(log.after, null)
    assert.ok(log.actorName && log.createdAt)
  }
  const exported = buildExportSheets(plain, {
    modules: [{ id: 'logs', fields: ['action', 'before', 'after'] }]
  }).sheets[0]
  assert.equal(JSON.stringify(exported).includes('brand-private-old.png'), false)
  const state = JSON.parse(f.service.db.prepare('SELECT json FROM studio_state').get().json)
  delete state.appearance
  f.service.db.prepare('UPDATE studio_state SET json=?').run(JSON.stringify(state))
  assert.deepEqual(f.get(), defaultAppearance())
  assert.equal(
    JSON.parse(f.service.db.prepare('SELECT json FROM studio_state').get().json).appearance,
    undefined
  )
})

test('图片大小与上传和前端保持一致，允许恰好8MB且拒绝超过上限', (t) => {
  const f = fixture(t)
  const max = 8 * 1024 * 1024
  const data = Buffer.alloc(max)
  Buffer.from(PNG, 'base64').copy(data)
  const image = f.service.upload('admin', {
    name: '8MB.png',
    mime: 'image/png',
    data: data.toString('base64')
  })
  const result = f.save({ ...f.get(), logo: image })
  assert.equal(result.logo.size, max)
  assert.equal(f.service.getAppearance(f.readOnly.id).logo.size, max)
  assert.equal(
    f.service.bootstrap('admin').logs.find((row) => row.entity === 'appearance').after.logo.size,
    max
  )
  rejected(() =>
    f.service.upload('admin', {
      name: 'too-large.png',
      mime: 'image/png',
      data: Buffer.concat([data, Buffer.alloc(1)]).toString('base64')
    })
  )
})
