import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createStudioServer } from '../server/index.mjs'
import { ApiError, createStudioService } from '../server/studio.mjs'
import { testMutate } from './helpers/current-intent.mjs'
import { backupStudioDatabase, restoreStudioDatabase } from '../scripts/studio-backup.mjs'

const PASSWORD = 'isolated-lottery-integration-password-123'
const START = '2026-10-26T08:00:00.000Z'
const TIER = 'special-small'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const rejected = (callback, status = 400, code) =>
  assert.throws(
    callback,
    (error) =>
      error instanceof ApiError && error.status === status && (!code || error.code === code)
  )
const unavailable = (callback) => rejected(callback, 400, 'LOTTERY_CODE_UNAVAILABLE')
const stateOf = (service) =>
  JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
const updateState = (service, callback) => {
  const state = stateOf(service)
  callback(state)
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
}

test('共享奖图跨管理账号可读取，未发布上传及匿名头像访问保持隔离', async (t) => {
  const f = await fixture(t)
  f.savePool()
  const privateUpload = f.upload('admin', '未发布.png')
  const avatar = f.upload('admin', '私人头像.png')
  f.mutate('/profile', { name: '隔离管理', avatar })
  for (const role of ['admin', 'manager', 'owner', 'super_admin']) {
    const actor = f.createUser(`shared-${role}`, role)
    assert.equal(f.service.download(actor.id, f.images[0].id).data.length > 0, true)
    rejected(() => f.service.download(actor.id, privateUpload.id), 403)
  }
  rejected(() => f.service.lotteryAsset(avatar.id), 404)
})

test('HTTP转盘配置保存必须固定当前Actor，缺头/换账号/撤销会话均拒绝', async (t) => {
  const f = await fixture(t)
  const login = await f.http('/login', { username: 'admin', password: PASSWORD })
  assert.equal(login.response.status, 200)
  const cookie = login.response.headers.get('set-cookie').split(';')[0]
  const body = { tier: TIER, revision: 0, prizes: f.makePrizes() }
  const missing = await f.http('/lottery/pools', body, { headers: { Cookie: cookie } })
  assert.equal(missing.response.status, 409)
  assert.equal(missing.body.code, 'PRECONDITION_REQUIRED')
  const changed = await f.http('/lottery/pools', body, {
    headers: { Cookie: cookie, 'X-Studio-Actor': f.users.support.id }
  })
  assert.equal(changed.response.status, 409)
  assert.equal(changed.body.code, 'PRINCIPAL_CHANGED')
  const saved = await f.http('/lottery/pools', body, {
    headers: { Cookie: cookie, 'X-Studio-Actor': 'admin' }
  })
  assert.equal(saved.response.status, 200)
  assert.equal(saved.body.configured, true)
  f.service.logout(cookie.slice(cookie.indexOf('=') + 1))
  const revoked = await f.http(
    '/lottery/pools',
    { ...body, revision: 1 },
    { headers: { Cookie: cookie, 'X-Studio-Actor': 'admin' } }
  )
  assert.equal(revoked.response.status, 401)
})

async function fixture(t, { persistent = false } = {}) {
  let current = new Date(START)
  let failDraw = false
  let directory
  if (persistent) {
    const qaRoot = resolve('.qa')
    mkdirSync(qaRoot, { recursive: true })
    directory = mkdtempSync(join(qaRoot, 'lottery-integration-'))
  }
  const server = createStudioServer({
    dbPath: directory ? join(directory, 'isolated.sqlite') : ':memory:',
    seed: false,
    password: PASSWORD,
    clock: () => current,
    notificationIntervalMs: 86_400_000,
    backups: { intervalMinutes: 0 },
    uploadCleanup: { enabled: false },
    notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] },
    onTransaction({ state, beforeState }) {
      if (
        failDraw &&
        state.orders.some(
          (order) =>
            order.lotteryNote &&
            !beforeState.orders.find((before) => before.id === order.id)?.lotteryNote
        )
      )
        throw new Error('isolated lottery draw rollback')
    }
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  t.after(async () => {
    await new Promise((closed) => server.close(closed))
    if (directory) rmSync(directory, { recursive: true, force: true })
  })
  const service = server.service
  const base = `http://127.0.0.1:${server.address().port}/api/studio`
  const mutate = (path, body, actor = 'admin') => testMutate(service, actor, path, body)
  const level = mutate('/levels', { name: '转盘隔离等级', delaySeconds: 0 })
  const createUser = (name, role, permissionOverrides = {}) =>
    mutate('/users', {
      username: `lottery-${name}`,
      name: `转盘${name}`,
      role,
      password: PASSWORD,
      status: 'active',
      levelId: level.id,
      maxActiveOrders: 20,
      permissionOverrides
    })
  const users = {
    player1: createUser('player1', 'player'),
    player2: createUser('player2', 'player'),
    support: createUser('support', 'support'),
    finance: createUser('finance', 'finance')
  }
  const customer = mutate('/customers', {
    name: '转盘客户',
    contact: 'LOTTERY-PRIVATE-CONTACT',
    gameId: 'LOTTERY-PRIVATE-GAME',
    remark: 'LOTTERY-PRIVATE-CUSTOMER-REMARK'
  })
  const platform = mutate('/platforms', {
    name: '转盘测试来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  const templateBody = {
    name: '特惠小转盘测试',
    game: '三角洲行动',
    amount: 10000,
    reward: 7000,
    active: true
  }
  const template = mutate('/templates', { ...templateBody, playType: 'lottery', lotteryTier: TIER })
  const ordinary = mutate('/templates', { ...templateBody, name: '普通测试单', playType: 'normal' })
  const upload = (actor = 'admin', name = '奖图.png') =>
    service.upload(actor, { name, mime: 'image/png', data: PNG })
  const images = Array.from({ length: 6 }, (_, index) => upload('admin', `奖图${index + 1}.png`))
  const makePrizes = (winner = 0, suffix = '') =>
    images.map((image, index) => ({
      title: `测试目标${index + 1}${suffix}`,
      image,
      probability: index === winner ? '100' : '0'
    }))
  const savePool = (prizes = makePrizes(), actor = 'admin', tier = TIER) => {
    const revision = service.lotteryPools('admin').tiers.find((pool) => pool.tier === tier).revision
    return mutate('/lottery/pools', { tier, revision, prizes }, actor)
  }
  const order = (overrides = {}, actor = users.support.id) =>
    mutate(
      '/orders',
      {
        templateId: template.id,
        customerId: customer.id,
        platformId: platform.id,
        roomCode: 'LOTTERY-PRIVATE-ROOM',
        amount: 10000,
        reward: 7000,
        dispatchMode: 'pool',
        receivedAmount: 10000,
        paidAt: current.toISOString(),
        playerRemark: '保留原有打手备注',
        remark: 'LOTTERY-PRIVATE-INTERNAL-REMARK',
        ...overrides
      },
      actor
    )
  const claim = (record, actor = users.player1.id, requestId = randomUUID()) =>
    mutate(`/player/orders/${record.id}/claim`, { requestId }, actor)
  const code = (record, actor = users.support.id) => service.lotteryOrderCode(actor, record.id)
  const draw = (token) => service.drawLottery(TIER, token)
  const read = (token) => service.redeemLottery(TIER, token)
  const refund = (record, amount = 1, actor = users.finance.id) =>
    mutate('/refunds', { orderId: record.id, amount, reason: '隔离转盘退款测试' }, actor)
  const action = (record, body, actor = users.support.id) =>
    mutate(`/orders/${record.id}/action`, body, actor)
  const http = async (path, body, extra = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      ...extra,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extra.headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { response, body: await response.json() }
  }
  return {
    service,
    server,
    base,
    mutate,
    users,
    createUser,
    customer,
    platform,
    template,
    ordinary,
    upload,
    images,
    makePrizes,
    savePool,
    order,
    claim,
    code,
    draw,
    read,
    refund,
    action,
    http,
    setTime: (time) => {
      current = new Date(time)
    },
    rollbackDraw: (enabled) => {
      failDraw = enabled
    }
  }
}

test('真实接单才发码，普通和历史转盘不补码；同意图重试及换人接单保留一码和原到期时间', async (t) => {
  const f = await fixture(t)
  const record = f.order()
  assert.equal(f.code(record).status, 'not-issued')
  const requestId = randomUUID()
  const firstClaim = f.claim(record, f.users.player1.id, requestId)
  const original = f.code(record)
  assert.match(original.code, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(original.expiresAt, '2026-10-26T09:00:00.000Z')
  assert.deepEqual(f.claim(record, f.users.player1.id, requestId), firstClaim)
  assert.deepEqual(f.code(record), original)
  f.setTime('2026-10-26T08:30:00.000Z')
  f.action(record, { action: 'release', reason: '换打手' })
  f.claim(record, f.users.player2.id)
  assert.deepEqual(f.code(record), original)
  const normal = f.order({ templateId: f.ordinary.id })
  f.claim(normal)
  assert.equal(
    f.service.db.prepare('SELECT 1 FROM lottery_codes WHERE order_id=?').get(normal.id),
    undefined
  )
  const historical = f.order()
  updateState(f.service, (state) => {
    delete state.orders.find((row) => row.id === historical.id).lotteryEligible
  })
  f.claim(historical)
  assert.equal(f.code(historical).status, 'not-issued')
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM lottery_codes').get().n, 1)
  const logs = f.service.db.prepare('SELECT payload FROM audit_logs').all()
  assert.ok(!JSON.stringify(logs).includes(original.code), '兑换码不能写入审计')
  assert.ok(
    !JSON.stringify(stateOf(f.service)).includes(original.code),
    '兑换码不能保存到state JSON'
  )
})

test('最新奖池决定未抽结果，已中奖六格快照不变；中奖备注只写一次且两端都显示', async (t) => {
  const f = await fixture(t)
  f.savePool()
  const record = f.order()
  f.claim(record)
  const token = f.code(record).code
  f.savePool(f.makePrizes(1, '-最新'))
  const first = f.draw(token)
  assert.equal(first.result.prizeId, `${TIER}-2`)
  assert.equal(first.result.title, '测试目标2-最新')
  f.savePool(f.makePrizes(2, '-后来'))
  assert.deepEqual(f.read(token), first)
  assert.deepEqual(f.draw(token), first)
  const note = '【转盘中奖·特惠小转盘】测试目标2-最新'
  const stored = stateOf(f.service).orders.find((row) => row.id === record.id)
  assert.equal(stored.playerRemark, '保留原有打手备注')
  assert.equal(stored.lotteryNote, note)
  assert.equal(
    f.service.orderDetail(f.users.support.id, record.id).order.playerRemark,
    `保留原有打手备注\n${note}`
  )
  assert.equal(
    f.service.playerOrderDetail(f.users.player1.id, record.id).playerRemark,
    `保留原有打手备注\n${note}`
  )
  const beforeRevision = stored.revision
  for (let index = 0; index < 5; index++) assert.deepEqual(f.draw(token), first)
  assert.equal(
    stateOf(f.service).orders.find((row) => row.id === record.id).revision,
    beforeRevision
  )
  assert.equal(
    f.service.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity='lottery-draw'").get()
      .n,
    1
  )
  f.action(record, { action: 'remark', playerRemark: '新人工备注', lotteryNote: '伪造中奖' })
  const changed = f.service.playerOrderDetail(f.users.player1.id, record.id)
  assert.equal(changed.playerRemark, `新人工备注\n${note}`)
  f.action(record, { action: 'release', reason: '已开奖换人' })
  f.claim(record, f.users.player2.id)
  assert.equal(
    f.service.playerOrderDetail(f.users.player2.id, record.id).playerRemark,
    `新人工备注\n${note}`
  )
  assert.equal(f.code(record).code, token)
  assert.deepEqual(f.draw(token), first)
})

test('满一小时的read/draw及已中奖重试都拒绝，后台仍能查看原中奖记录', async (t) => {
  const f = await fixture(t)
  f.savePool()
  const drawn = f.order(),
    undrawn = f.order()
  f.claim(drawn)
  f.claim(undrawn)
  const drawnCode = f.code(drawn).code,
    undrawnCode = f.code(undrawn).code
  f.draw(drawnCode)
  f.setTime('2026-10-26T08:59:59.999Z')
  assert.equal(f.read(undrawnCode).remaining, 1)
  f.setTime('2026-10-26T09:00:00.000Z')
  for (const token of [drawnCode, undrawnCode]) {
    unavailable(() => f.read(token))
    unavailable(() => f.draw(token))
    for (const path of ['/lottery/redeem', '/lottery/draw']) {
      const reply = await f.http(path, { tier: TIER, code: token })
      assert.equal(reply.response.status, 400)
      assert.equal(reply.body.code, 'LOTTERY_CODE_UNAVAILABLE')
    }
  }
  assert.equal(f.code(drawn).status, 'expired')
  assert.equal(f.code(drawn).result.title, '测试目标1')
  assert.equal(f.code(undrawn).result, null)
  const managed = f.service.lotteryOrders('admin', { size: 50 }).records
  assert.equal(managed.find((row) => row.orderId === drawn.id).result.title, '测试目标1')
})

test('四档订单、兑换码和奖池互相独立，跨页面使用码均拒绝且不消费机会', async (t) => {
  const f = await fixture(t)
  const tiers = ['special-small', 'special-medium', 'value-large', 'ultimate-large']
  const tokens = []
  for (let index = 0; index < tiers.length; index++) {
    const tier = tiers[index]
    const template = f.mutate('/templates', {
      name: `独立档位${index + 1}`,
      game: '三角洲行动',
      amount: 10000,
      reward: 7000,
      active: true,
      playType: 'lottery',
      lotteryTier: tier
    })
    f.savePool(f.makePrizes(index, `-${tier}`), 'admin', tier)
    const record = f.order({ templateId: template.id })
    f.claim(record)
    const token = f.code(record).code
    tokens.push(token)
    for (const other of tiers.filter((value) => value !== tier)) {
      unavailable(() => f.service.redeemLottery(other, token))
      unavailable(() => f.service.drawLottery(other, token))
    }
    assert.equal(f.service.redeemLottery(tier, token).remaining, 1)
    const result = f.service.drawLottery(tier, token)
    assert.equal(result.result.prizeId, `${tier}-${index + 1}`)
    assert.equal(result.result.title, `测试目标${index + 1}-${tier}`)
  }
  assert.equal(new Set(tokens).size, 4)
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 4)
})

test('任何实际退款作废码：部分退款不取消，全额转盘退款取消，普通订单保留原状态', async (t) => {
  const f = await fixture(t)
  f.savePool()
  const partial = f.order(),
    full = f.order(),
    normal = f.order({ templateId: f.ordinary.id })
  for (const record of [partial, full, normal]) f.claim(record)
  const partialCode = f.code(partial).code,
    fullCode = f.code(full).code
  f.draw(partialCode)
  const partialRefund = f.refund(partial, 1)
  assert.equal(partialRefund.status, 'paid')
  assert.equal(f.service.orderDetail('admin', partial.id).order.status, 'active')
  assert.equal(f.code(partial).status, 'void')
  assert.equal(f.code(partial).result.title, '测试目标1')
  unavailable(() => f.read(partialCode))
  unavailable(() => f.draw(partialCode))
  f.refund(full, 10000)
  assert.equal(f.code(full).status, 'void')
  assert.equal(f.service.orderDetail('admin', full.id).order.status, 'canceled')
  unavailable(() => f.draw(fullCode))
  f.refund(normal, 10000)
  assert.equal(f.service.orderDetail('admin', normal.id).order.status, 'active')
})

test('未接单即退款/取消永久失效；取消不可恢复且不能重新接单发码', async (t) => {
  const f = await fixture(t)
  f.savePool()
  const record = f.order()
  f.claim(record)
  const token = f.code(record).code
  f.action(record, { action: 'cancel', reason: '取消转盘单' })
  assert.equal(f.code(record).status, 'void')
  rejected(() => f.action(
    record,
    { action: 'correct-status', status: 'pending', reason: '人工恢复订单状态' },
    'admin'
  ), 409, 'ORDER_CANCELED')
  rejected(() => f.claim(record, f.users.player2.id), 409)
  assert.equal(f.code(record).status, 'void')
  assert.equal(f.code(record).code, token)
  unavailable(() => f.draw(token))
  const beforeClaim = f.order()
  f.refund(beforeClaim, 1)
  assert.equal(f.code(beforeClaim).status, 'void')
  assert.equal(f.code(beforeClaim).code, null)
  f.claim(beforeClaim)
  assert.equal(f.code(beforeClaim).code, null)
  const canceled = f.order()
  f.action(canceled, { action: 'cancel', reason: '接单前取消' })
  rejected(() => f.action(
    canceled,
    { action: 'correct-status', status: 'pending', reason: '人工恢复订单状态' },
    'admin'
  ), 409, 'ORDER_CANCELED')
  rejected(() => f.claim(canceled), 409)
  assert.equal(f.code(canceled).code, null)
})

test('管理严格四角色；客服按原orders.view取码，打手永远不可取码；匿名及非管理投影无概率', async (t) => {
  const f = await fixture(t)
  f.savePool()
  for (const role of ['admin', 'manager', 'owner', 'super_admin']) {
    const actor = f.createUser(`allowed-${role}`, role)
    assert.equal(f.service.lotteryPools(actor.id).tiers.length, 4)
    const existing = f.service.lotteryPools(actor.id).tiers[0]
    assert.equal(
      f.mutate(
        '/lottery/pools',
        { tier: TIER, revision: existing.revision, prizes: existing.prizes },
        actor.id
      ).configured,
      true
    )
  }
  const record = f.order()
  f.claim(record)
  const token = f.code(record).code
  for (const role of ['finance', 'support']) {
    const actor = f.createUser(`forbidden-${role}`, role, {
      'templates.manage': true,
      'settings.manage': true,
      'logs.view': true
    })
    rejected(() => f.service.lotteryPools(actor.id), 403)
    rejected(() => f.savePool(f.makePrizes(), actor.id), 403)
    rejected(() => f.service.lotteryOrders(actor.id), 403)
    assert.ok(!JSON.stringify(f.service.bootstrap(actor.id)).includes('probability'))
    assert.ok(
      !JSON.stringify(f.service.logs(actor.id, { source: 'all', size: 100 })).includes(
        'probability'
      )
    )
  }
  assert.equal(f.code(record, f.users.support.id).code, token)
  rejected(() => f.code(record, f.users.player1.id), 403)
  const noView = f.createUser('no-view', 'support', { 'orders.view': false })
  rejected(() => f.code(record, noView.id), 403)
  const values = [
    f.service.publicLotteryPool(TIER),
    f.read(token),
    f.service.bootstrap(f.users.player1.id),
    f.service.playerOrderDetail(f.users.player1.id, record.id)
  ]
  for (const value of values) {
    const serialized = JSON.stringify(value)
    assert.ok(!serialized.includes('probability'))
    assert.ok(!serialized.includes(token))
  }
  for (const value of [f.service.publicLotteryPool(TIER), f.read(token)]) {
    const serialized = JSON.stringify(value)
    assert.ok(!serialized.includes('LOTTERY-PRIVATE'))
    assert.ok(!serialized.includes('/uploads/'))
  }
})

test('奖图必须为专用上传，拒绝借私人资料和业务凭证公开；公开奖图也不能再作私人或业务图片', async (t) => {
  const f = await fixture(t)
  f.savePool()
  const receipt = f.upload('admin', '私人凭证.png')
  f.order({ receipt }, 'admin')
  const withReceipt = f.makePrizes()
  withReceipt[0].image = receipt
  rejected(() => f.savePool(withReceipt), 403)
  const avatar = f.upload('admin', '私人头像.png')
  f.mutate('/profile', { name: '隔离管理员', avatar })
  const withAvatar = f.makePrizes()
  withAvatar[0].image = avatar
  rejected(() => f.savePool(withAvatar), 403)
  f.mutate('/profile', { name: '隔离管理员', avatar: null })
  rejected(() => f.savePool(withAvatar), 403)
  const privateQr = f.upload(f.users.player1.id, '私人微信收款码.png')
  f.mutate('/player/payment-methods', { method: 'wechat', qrCode: privateQr }, f.users.player1.id)
  const withQr = f.makePrizes()
  withQr[0].image = privateQr
  rejected(() => f.savePool(withQr), 403)
  rejected(() => f.order({ receipt: f.images[0] }, 'admin'), 403)
  rejected(() => f.mutate('/profile', { name: '隔离管理员', avatar: f.images[0] }), 403)
  for (const secret of [receipt, avatar, privateQr]) {
    rejected(() => f.service.lotteryAsset(secret.id), 404)
    const response = await fetch(`${f.base}/lottery/assets/${secret.id}`)
    assert.equal(response.status, 404)
  }
  const publicImage = await fetch(`${f.base}/lottery/assets/${f.images[0].id}`)
  assert.equal(publicImage.status, 200)
  assert.equal(publicImage.headers.get('content-type'), 'image/png')
  assert.ok((await publicImage.arrayBuffer()).byteLength > 0)
})

test('HTTP仅POST body传码，拒绝URL令牌、跨站来源和指定中奖字段；错误码统一且无身份泄漏', async (t) => {
  const f = await fixture(t)
  f.savePool()
  const record = f.order()
  f.claim(record)
  const token = f.code(record).code
  const valid = { tier: TIER, code: token }
  assert.equal((await f.http('/lottery/redeem', valid)).response.status, 200)
  assert.equal((await f.http(`/lottery/redeem?code=${token}`)).response.status, 405)
  assert.equal((await f.http(`/lottery/draw?code=${token}`, valid)).response.status, 400)
  assert.equal(
    (await f.http('/lottery/draw', { ...valid, prizeId: `${TIER}-6` })).response.status,
    400
  )
  assert.equal((await f.http('/lottery/draw', { ...valid, index: 5 })).response.status, 400)
  assert.equal(
    (await f.http('/lottery/draw', valid, { headers: { Origin: 'https://attacker.example' } }))
      .response.status,
    403
  )
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 0)
  const errors = []
  for (const body of [
    { tier: TIER, code: 'x'.repeat(43) },
    { tier: 'special-medium', code: token },
    { tier: 'unknown', code: token }
  ]) {
    const reply = await f.http('/lottery/redeem', body)
    assert.equal(reply.response.status, 400)
    assert.equal(reply.body.code, 'LOTTERY_CODE_UNAVAILABLE')
    errors.push(reply.body)
  }
  assert.deepEqual(errors[1], errors[0])
  assert.deepEqual(errors[2], errors[0])
  assert.ok(!JSON.stringify(errors).includes(record.id))
  assert.ok(!JSON.stringify(errors).includes(token))
  const drawn = await f.http('/lottery/draw', valid)
  assert.equal(drawn.response.status, 200)
  assert.equal(drawn.body.result.prizeId, `${TIER}-1`)
  assert.equal(drawn.response.headers.get('cache-control'), 'no-store')
})

test('HTTP猜码同一IP每分钟30次限流，返回429和Retry-After且到窗口后恢复', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 30; index++) {
    const reply = await f.http('/lottery/redeem', { tier: TIER, code: 'x'.repeat(43) })
    assert.equal(reply.response.status, 400)
  }
  const limited = await f.http('/lottery/redeem', { tier: TIER, code: 'x'.repeat(43) })
  assert.equal(limited.response.status, 429)
  assert.equal(limited.body.code, 'RATE_LIMITED')
  assert.equal(limited.response.headers.get('retry-after'), '60')
  f.setTime('2026-10-26T08:01:00.000Z')
  assert.equal(
    (await f.http('/lottery/redeem', { tier: TIER, code: 'x'.repeat(43) })).response.status,
    400
  )
})

test('匿名奖图GET与HEAD独立限流，未知ID不能绕过，且不占用兑换码验证额度', async (t) => {
  const f = await fixture(t)
  f.savePool()
  for (let index = 0; index < 240; index++) {
    const response = await fetch(`${f.base}/lottery/assets/missing-${index}`, {
      method: index % 2 ? 'HEAD' : 'GET'
    })
    assert.equal(response.status, 404)
    await response.arrayBuffer()
  }
  const limited = await fetch(`${f.base}/lottery/assets/${f.images[0].id}`)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  assert.equal((await limited.json()).code, 'RATE_LIMITED')
  assert.equal(
    (await f.http('/lottery/redeem', { tier: TIER, code: 'x'.repeat(43) })).response.status,
    400
  )
  f.setTime('2026-10-26T08:01:00.000Z')
  const recovered = await fetch(`${f.base}/lottery/assets/${f.images[0].id}`, { method: 'HEAD' })
  assert.equal(recovered.status, 200)
})

test('真实业务事务失败同时撤回开奖SQL、中奖备注和审计，重试后只登记一次', async (t) => {
  const f = await fixture(t)
  f.savePool()
  const record = f.order()
  f.claim(record)
  const token = f.code(record).code
  const before = stateOf(f.service)
  const logs = f.service.db.prepare('SELECT count(*) AS n FROM audit_logs').get().n
  f.rollbackDraw(true)
  assert.throws(() => f.draw(token), /isolated lottery draw rollback/)
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 0)
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, logs)
  assert.deepEqual(stateOf(f.service), before)
  assert.equal(f.read(token).remaining, 1)
  f.rollbackDraw(false)
  const result = f.draw(token)
  assert.deepEqual(f.draw(token), result)
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 1)
  assert.equal(
    f.service.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity='lottery-draw'").get()
      .n,
    1
  )
})

test('持久SQLite上并发双HTTP开奖及退款竞争只生成一个结果，退款提交后全部匿名访问失效', async (t) => {
  const f = await fixture(t, { persistent: true })
  f.savePool()
  const record = f.order()
  f.claim(record)
  const token = f.code(record).code
  const dbPath = f.service.db
    .prepare('PRAGMA database_list')
    .all()
    .find((row) => row.name === 'main').file
  const reopened = createStudioService({
    dbPath,
    seed: false,
    password: PASSWORD,
    clock: () => new Date(START)
  })
  try {
    assert.deepEqual(reopened.lotteryOrderCode('admin', record.id), f.code(record))
  } finally {
    reopened.close()
  }
  const pair = await Promise.all([
    f.http('/lottery/draw', { tier: TIER, code: token }),
    f.http('/lottery/draw', { tier: TIER, code: token })
  ])
  assert.ok(pair.every((reply) => reply.response.status === 200))
  assert.deepEqual(pair[0].body, pair[1].body)
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 1)
  assert.equal(
    f.service.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity='lottery-draw'").get()
      .n,
    1
  )
  const session = f.service.login(f.users.finance.username, PASSWORD)
  const cookie = `studio_session=${session.token}`
  for (const refundFirst of [false, true]) {
    const racing = f.order()
    f.claim(racing)
    const racingToken = f.code(racing).code
    const initialRevision = f.service.orderDetail('admin', racing.id).order.revision
    const refundRequest = (expectedRevision = initialRevision) =>
      f.http(
        '/refunds',
        {
          orderId: racing.id,
          expectedRevision,
          amount: 1,
          reason: '并发退款测试',
          requestId: randomUUID()
        },
        { headers: { Cookie: cookie, 'X-Studio-Actor': f.users.finance.id } }
      )
    const drawRequest = () => f.http('/lottery/draw', { tier: TIER, code: racingToken })
    const competing = await Promise.all(
      refundFirst ? [refundRequest(), drawRequest()] : [drawRequest(), refundRequest()]
    )
    let refundReply = competing[refundFirst ? 0 : 1]
    const drawReply = competing[refundFirst ? 1 : 0]
    if (refundReply.response.status === 409) {
      assert.equal(refundReply.body.code, 'ORDER_REVISION_CONFLICT')
      assert.equal(stateOf(f.service).refunds.some(row => row.orderId === racing.id), false)
      // The staff explicitly refreshes and confirms a new refund intent after
      // the competing draw changed the order. Never retry a stale write blindly.
      refundReply = await refundRequest(f.service.orderDetail('admin', racing.id).order.revision)
    }
    assert.equal(refundReply.response.status, 200, JSON.stringify(refundReply.body))
    assert.ok([200, 400].includes(drawReply.response.status), JSON.stringify(drawReply.body))
    assert.equal(f.code(racing).status, 'void')
    unavailable(() => f.read(racingToken))
    unavailable(() => f.draw(racingToken))
    const count = f.service.db
      .prepare(
        'SELECT count(*) AS n FROM lottery_draws WHERE code_id=(SELECT id FROM lottery_codes WHERE order_id=?)'
      )
      .get(racing.id).n
    assert.ok(count === 0 || count === 1)
    assert.equal(count, drawReply.response.status === 200 ? 1 : 0)
    assert.equal(f.service.orderDetail('admin', racing.id).order.status, 'active')
  }
})

test('完整SQLite备份离线恢复保留原兑换码、HMAC密钥、中奖快照和只抽一次约束', async (t) => {
  const f = await fixture(t, { persistent: true })
  f.savePool()
  const drawn = f.order(),
    pending = f.order()
  f.claim(drawn)
  f.claim(pending)
  const drawnCode = f.code(drawn),
    pendingCode = f.code(pending)
  const original = f.draw(drawnCode.code)
  f.savePool(f.makePrizes(1, '-备份前最新'))
  const sourcePath = f.service.db
    .prepare('PRAGMA database_list')
    .all()
    .find((row) => row.name === 'main').file
  const backupPath = join(dirname(sourcePath), 'complete-backup.sqlite')
  const restoredPath = join(dirname(sourcePath), 'offline-restored.sqlite')
  await backupStudioDatabase(sourcePath, backupPath, { clock: () => new Date(START) })
  const restore = await restoreStudioDatabase(backupPath, restoredPath, {
    clock: () => new Date(START)
  })
  assert.equal(restore.sourceVerification.hashVerification, 'verified')
  const recovered = createStudioService({
    dbPath: restoredPath,
    seed: false,
    password: PASSWORD,
    clock: () => new Date(START)
  })
  try {
    assert.deepEqual(recovered.lotteryOrderCode('admin', drawn.id), f.code(drawn))
    assert.deepEqual(recovered.lotteryOrderCode('admin', pending.id), pendingCode)
    assert.equal(
      recovered.db.prepare("SELECT count(*) AS n FROM lottery_meta WHERE key='code-hmac-v1'").get()
        .n,
      1
    )
    assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM lottery_draw_assets').get().n, 6)
    assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM lottery_codes').get().n, 2)
    assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 1)
    for (let attempt = 0; attempt < 3; attempt++)
      assert.deepEqual(recovered.drawLottery(TIER, drawnCode.code), original)
    assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 1)
    assert.equal(
      recovered.playerOrderDetail(f.users.player1.id, drawn.id).playerRemark,
      '保留原有打手备注\n【转盘中奖·特惠小转盘】测试目标1'
    )
    assert.ok(recovered.lotteryAsset(f.images[0].id).data.byteLength > 0)
    const newResult = recovered.drawLottery(TIER, pendingCode.code)
    assert.equal(newResult.result.title, '测试目标2-备份前最新')
    assert.deepEqual(recovered.drawLottery(TIER, pendingCode.code), newResult)
    assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 2)
    assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 1)
  } finally {
    recovered.close()
  }
})
