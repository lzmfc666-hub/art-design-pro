import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStudioService, ApiError } from '../server/studio.mjs'

const PASSWORD = 'isolated-lottery-template-password-123'
const TIERS = ['special-small', 'special-medium', 'value-large', 'ultimate-large']
const templateBody = (changes = {}) => ({
  name: '测试项目',
  game: '三角洲行动',
  description: '',
  amount: 1000,
  reward: 700,
  map: '',
  remark: '',
  active: true,
  ...changes
})
const rejected = (fn, status = 400) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status)

function fixture(t, dbPath = ':memory:', afterClose) {
  let service = createStudioService({ dbPath, password: PASSWORD, seed: false })
  t.after(() => {
    service.close()
    afterClose?.()
  })
  return {
    get service() {
      return service
    },
    mutate: (path, body, actor = 'admin') => service.mutate(actor, path, body),
    restart() {
      service.close()
      service = createStudioService({ dbPath, password: PASSWORD, seed: false })
    }
  }
}

function stateOf(service) {
  return JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
}

function updateState(service, update) {
  const state = stateOf(service)
  update(state)
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
}

function orderFactory(f) {
  const customer = f.mutate('/customers', { name: '隔离转盘客户' })
  const platform = f.mutate('/platforms', {
    name: '隔离转盘来源',
    rules: {
      requiresShop: false,
      requiresExternalOrderNo: false,
      requiresReceipt: false,
      allowPayOnArrival: true
    }
  })
  return (template, changes = {}) =>
    f.mutate('/orders', {
      requestId: randomUUID(),
      templateId: template.id,
      customerId: customer.id,
      platformId: platform.id,
      roomCode: 'ISOLATED-LOTTERY',
      amount: 1000,
      reward: 700,
      dispatchMode: 'pool',
      payOnArrival: true,
      receivedAmount: 0,
      ...changes
    })
}

test('模板显式玩法与四个转盘类目白名单：旧请求默认普通，不按名称猜测', (t) => {
  const f = fixture(t)
  const ordinary = f.mutate('/templates', templateBody({ name: '转盘单' }))
  assert.equal(ordinary.playType, 'normal')
  assert.equal(ordinary.lotteryTier, null)
  assert.equal(Object.hasOwn(ordinary, 'untrusted'), false)
  for (const lotteryTier of TIERS) {
    const template = f.mutate(
      '/templates',
      templateBody({
        name: '不含玩法名称',
        playType: 'lottery',
        lotteryTier,
        untrusted: 'ignored'
      })
    )
    assert.equal(template.playType, 'lottery')
    assert.equal(template.lotteryTier, lotteryTier)
    assert.equal(Object.hasOwn(template, 'untrusted'), false)
  }
  const normal = f.mutate(
    '/templates',
    templateBody({
      playType: 'normal',
      lotteryTier: 'special-small'
    })
  )
  assert.equal(normal.lotteryTier, null)
})

test('非法玩法、缺失或非法转盘类目返回400，模板与审计同事务回滚', (t) => {
  const f = fixture(t)
  const template = f.mutate(
    '/templates',
    templateBody({
      playType: 'lottery',
      lotteryTier: 'special-small'
    })
  )
  const original = stateOf(f.service)
  const originalLogs = f.service.logs('admin', { entity: 'template' })
  for (const fields of [
    { playType: '' },
    { playType: null },
    { playType: 'spin' },
    { playType: ['lottery'] },
    { playType: 'lottery' },
    { playType: 'lottery', lotteryTier: null },
    { playType: 'lottery', lotteryTier: '特惠小转盘' },
    { playType: 'lottery', lotteryTier: [] },
    { playType: 'normal', lotteryTier: 'unknown' }
  ]) {
    rejected(() => f.mutate('/templates', templateBody(fields)))
    assert.deepEqual(stateOf(f.service), original)
    assert.deepEqual(f.service.logs('admin', { entity: 'template' }), originalLogs)
  }
  rejected(() =>
    f.mutate(
      '/templates',
      templateBody({
        id: template.id,
        playType: 'lottery',
        lotteryTier: 'unknown'
      })
    )
  )
  assert.deepEqual(stateOf(f.service), original)
  assert.deepEqual(f.service.logs('admin', { entity: 'template' }), originalLogs)
})

test('旧客户端编辑省略玩法保留已有转盘与类目，旧普通模板保存才补默认值', (t) => {
  const f = fixture(t)
  const lottery = f.mutate(
    '/templates',
    templateBody({
      playType: 'lottery',
      lotteryTier: 'special-medium'
    })
  )
  const edited = f.mutate('/templates', templateBody({ id: lottery.id, name: '旧客户端改名' }))
  assert.equal(edited.playType, 'lottery')
  assert.equal(edited.lotteryTier, 'special-medium')
  const legacy = f.mutate('/templates', templateBody({ name: '旧转盘命名的普通项目' }))
  updateState(f.service, (state) => {
    const row = state.templates.find((row) => row.id === legacy.id)
    delete row.playType
    delete row.lotteryTier
  })
  assert.equal(
    Object.hasOwn(
      f.service.bootstrap('admin').templates.find((row) => row.id === legacy.id),
      'playType'
    ),
    false
  )
  const updated = f.mutate('/templates', templateBody({ id: legacy.id }))
  assert.equal(updated.playType, 'normal')
  assert.equal(updated.lotteryTier, null)
  updateState(f.service, (state) => {
    delete state.templates.find((row) => row.id === lottery.id).lotteryTier
  })
  rejected(() => f.mutate('/templates', templateBody({ id: lottery.id })))
  const corrected = f.mutate(
    '/templates',
    templateBody({
      id: lottery.id,
      lotteryTier: 'ultimate-large'
    })
  )
  assert.equal(corrected.playType, 'lottery')
  assert.equal(corrected.lotteryTier, 'ultimate-large')
})

test('模板保存在独立D盘SQLite重启保留，权限拒绝不写数据，审计包含玩法前后值', (t) => {
  const qaRoot = resolve('.qa')
  mkdirSync(qaRoot, { recursive: true })
  const directory = mkdtempSync(join(qaRoot, 'lottery-template-'))
  const f = fixture(t, join(directory, 'isolated.sqlite'), () =>
    rmSync(directory, { recursive: true, force: true })
  )
  const template = f.mutate('/templates', templateBody({ playType: 'normal', lotteryTier: null }))
  const changed = f.mutate(
    '/templates',
    templateBody({
      id: template.id,
      playType: 'lottery',
      lotteryTier: 'value-large'
    })
  )
  const support = f.mutate('/users', {
    username: 'isolated-lottery-support',
    name: '隔离客服',
    role: 'support',
    status: 'active',
    maxActiveOrders: 1,
    password: PASSWORD,
    permissionOverrides: {}
  })
  const original = stateOf(f.service)
  rejected(
    () =>
      f.mutate(
        '/templates',
        templateBody({
          id: template.id,
          playType: 'lottery',
          lotteryTier: 'ultimate-large'
        }),
        support.id
      ),
    403
  )
  assert.deepEqual(stateOf(f.service), original)
  f.restart()
  const persisted = f.service.bootstrap('admin').templates.find((row) => row.id === template.id)
  assert.deepEqual(persisted, changed)
  const log = f.service
    .logs('admin', { entity: 'template', entityId: template.id })
    .records.find((row) => row.before)
  assert.equal(log.before.playType, 'normal')
  assert.equal(log.before.lotteryTier, null)
  assert.equal(log.after.playType, 'lottery')
  assert.equal(log.after.lotteryTier, 'value-large')
  assert.equal(log.actorId, 'admin')
  assert.ok(log.createdAt)
})

test('转盘配置仅四种管理角色且需模板权限，财务客服权限覆盖不能绕过角色或改普通', (t) => {
  const f = fixture(t)
  const normal = f.mutate('/templates', templateBody())
  const lottery = f.mutate(
    '/templates',
    templateBody({
      playType: 'lottery',
      lotteryTier: 'special-small'
    })
  )
  for (const role of ['finance', 'support', 'admin', 'manager', 'owner', 'super_admin']) {
    const actor = f.mutate('/users', {
      username: `lottery-role-${role}`,
      name: `隔离${role}`,
      role,
      status: 'active',
      maxActiveOrders: 1,
      password: PASSWORD,
      permissionOverrides: { 'templates.manage': true }
    })
    if (['finance', 'support'].includes(role)) {
      for (const changes of [
        { playType: 'lottery', lotteryTier: 'value-large' },
        { id: normal.id, playType: 'lottery', lotteryTier: 'value-large' },
        { id: lottery.id, playType: 'lottery', lotteryTier: 'ultimate-large' },
        { id: lottery.id, playType: 'normal', lotteryTier: null },
        { id: lottery.id }
      ]) {
        const original = stateOf(f.service)
        const logs = f.service.logs('admin', { entity: 'template' })
        rejected(() => f.mutate('/templates', templateBody(changes), actor.id), 403)
        assert.deepEqual(stateOf(f.service), original)
        assert.deepEqual(f.service.logs('admin', { entity: 'template' }), logs)
      }
      rejected(() => f.mutate('/templates', templateBody({ playType: 'invalid' }), actor.id))
      const updated = f.mutate(
        '/templates',
        templateBody({
          id: normal.id,
          name: `${role}可修改普通项目`
        }),
        actor.id
      )
      assert.equal(updated.playType, 'normal')
      assert.equal(updated.lotteryTier, null)
    } else {
      const created = f.mutate(
        '/templates',
        templateBody({
          playType: 'lottery',
          lotteryTier: 'special-medium'
        }),
        actor.id
      )
      assert.equal(created.playType, 'lottery')
      assert.equal(created.lotteryTier, 'special-medium')
      const edited = f.mutate(
        '/templates',
        templateBody({
          id: created.id,
          playType: 'normal',
          lotteryTier: null
        }),
        actor.id
      )
      assert.equal(edited.playType, 'normal')
      if (role === 'super_admin') continue
      f.mutate('/users', { ...actor, permissionOverrides: { 'templates.manage': false } })
      rejected(
        () =>
          f.mutate(
            '/templates',
            templateBody({
              playType: 'lottery',
              lotteryTier: 'special-small'
            }),
            actor.id
          ),
        403
      )
    }
  }
})

test('新订单从服务端模板固定玩法快照，忽略客户端伪造；模板后改不影响旧订单', (t) => {
  const f = fixture(t)
  const order = orderFactory(f)
  const template = f.mutate(
    '/templates',
    templateBody({
      playType: 'lottery',
      lotteryTier: 'ultimate-large'
    })
  )
  const lotteryOrder = order(template, {
    playType: 'normal',
    lotteryTier: null,
    snapshot: { playType: 'normal', lotteryTier: 'special-small' }
  })
  assert.equal(lotteryOrder.snapshot.playType, 'lottery')
  assert.equal(lotteryOrder.snapshot.lotteryTier, 'ultimate-large')
  const originalSnapshot = structuredClone(lotteryOrder.snapshot)
  f.mutate('/templates', templateBody({ id: template.id, playType: 'normal', lotteryTier: null }))
  const stored = stateOf(f.service).orders.find((row) => row.id === lotteryOrder.id)
  assert.deepEqual(stored.snapshot, originalSnapshot)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.reward, 700)
  assert.equal(stored.receivedAmount, 0)
  assert.equal(Object.hasOwn(stored, 'playType'), false)
  assert.equal(Object.hasOwn(stored, 'lotteryCode'), false)
  const log = f.service.logs('admin', { entity: 'order', entityId: stored.id }).records[0]
  assert.equal(log.after.snapshot.playType, 'lottery')
  assert.equal(log.after.snapshot.lotteryTier, 'ultimate-large')
  const ordinary = order(template, { playType: 'lottery', lotteryTier: 'value-large' })
  assert.equal(ordinary.snapshot.playType, 'normal')
  assert.equal(ordinary.snapshot.lotteryTier, null)
  assert.equal(ordinary.status, 'pending')
  assert.equal(ordinary.reward, 700)
})

test('旧模板新下单默认普通，历史订单快照无迁移，缺类目的旧转盘模板不能猜类目建单', (t) => {
  const f = fixture(t)
  const order = orderFactory(f)
  const template = f.mutate('/templates', templateBody({ name: '转盘单' }))
  const historical = order(template)
  updateState(f.service, (state) => {
    const row = state.templates.find((row) => row.id === template.id)
    delete row.playType
    delete row.lotteryTier
    const snapshot = state.orders.find((row) => row.id === historical.id).snapshot
    delete snapshot.playType
    delete snapshot.lotteryTier
  })
  const originalHistory = structuredClone(stateOf(f.service).orders[0])
  const ordinary = order(template)
  assert.equal(ordinary.snapshot.playType, 'normal')
  assert.equal(ordinary.snapshot.lotteryTier, null)
  assert.deepEqual(stateOf(f.service).orders[0], originalHistory)
  assert.equal(Object.hasOwn(stateOf(f.service).templates[0], 'playType'), false)
  updateState(f.service, (state) => {
    state.templates[0].playType = 'lottery'
  })
  const original = stateOf(f.service)
  rejected(() => order(template))
  assert.deepEqual(stateOf(f.service), original)
})
