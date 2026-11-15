import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createLotteryStore } from '../server/lottery.mjs'

const TIER = 'special-small'
const START = '2026-10-26T08:00:00.000Z'
const admin = { id: 'admin', role: 'admin', status: 'active' }
const order = (id = 'order-1', tier = TIER) => ({
  id,
  status: 'active',
  snapshot: { playType: 'lottery', lotteryTier: tier },
  internalRemark: '原打手备注'
})
const image = (id) => ({
  id,
  name: `${id}.png`,
  mime: 'image/png',
  size: 123,
  url: `/api/studio/uploads/${id}`
})
const prizes = (weights = ['100', '0', '0', '0', '0', '0'], suffix = '') =>
  weights.map((probability, index) => ({
    title: `奖项${index + 1}${suffix}`,
    image: image(`image-${index + 1}${suffix}`),
    probability
  }))
const rejected = (callback, status = 400, code) =>
  assert.throws(callback, (error) => error.status === status && (!code || error.code === code))
const unavailable = (callback) => rejected(callback, 400, 'LOTTERY_CODE_UNAVAILABLE')
const tx = (db, callback) => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = callback()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
function fixture(t, dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath)
  let time = START
  const store = createLotteryStore({ db, now: () => time })
  const state = { orders: [order()], refunds: [] }
  const audits = []
  t.after(() => db.close())
  return {
    db,
    store,
    state,
    audits,
    setTime: (value) => {
      time = value
    },
    save(items = prizes(), tier = TIER, actor = admin, revision) {
      return tx(db, () =>
        store.savePool(
          state,
          actor,
          {
            tier,
            revision:
              revision ?? store.pools(state).tiers.find((row) => row.tier === tier)?.revision ?? 0,
            prizes: items
          },
          (value) => value,
          (before, after) => audits.push({ before, after })
        )
      )
    },
    issue(value = state.orders[0]) {
      return tx(db, () => store.issue(value))
    },
    draw(token, tier = TIER) {
      return tx(db, () => store.draw(state, tier, token))
    },
    code(id = state.orders[0].id) {
      return store.codeForOrder(id)
    }
  }
}

if (!isMainThread && workerData?.lotteryConcurrency) {
  const db = new DatabaseSync(workerData.dbPath)
  db.exec('PRAGMA busy_timeout=10000')
  const store = createLotteryStore({ db, now: () => START })
  parentPort.on('message', () => {
    try {
      const result = tx(db, () => store.draw(workerData.state, TIER, workerData.token))
      parentPort.postMessage({ isNew: result.isNew, result: result.view.result })
    } catch (error) {
      parentPort.postMessage({ error: error.message })
    } finally {
      db.close()
      parentPort.close()
    }
  })
  parentPort.postMessage({ ready: true })
} else {
  test('四档固定六项，概率以整数百万分之一保存语义，四位小数不受浮点误差影响', (t) => {
    const f = fixture(t)
    const initial = f.store.pools(f.state)
    assert.deepEqual(
      initial.tiers.map((row) => row.tier),
      [TIER, 'special-medium', 'value-large', 'ultimate-large']
    )
    assert.ok(
      initial.tiers.every((row) => !row.configured && row.revision === 0 && row.prizes.length === 6)
    )
    const saved = f.save(prizes(['99.9995', '0.0001', '0.0001', '0.0001', '0.0001', '0.0001']))
    assert.equal(saved.revision, 1)
    assert.equal(saved.configured, true)
    assert.equal(saved.prizes[1].probability, '0.0001')
    assert.equal(saved.prizes[0].id, 'special-small-1')
    assert.equal(f.audits.length, 1)
    assert.equal(f.audits[0].before.configured, false)
    assert.equal(f.audits[0].after.prizes.length, 6)
    assert.equal(f.save(prizes(['100.0000', '0', '0', '0', '0', '0'])).prizes[0].probability, '100')
    for (const tier of initial.tiers.slice(1).map((row) => row.tier))
      assert.equal(f.save(prizes(), tier).tier, tier)
  })

  test('拒绝非法概率、总和、档位、个数、图片、名称及可疑字段', (t) => {
    const f = fixture(t)
    for (const invalid of [
      '0.00001',
      '100.0001',
      '-1',
      '1e2',
      ' 100',
      '100%',
      '01',
      '',
      '.5',
      '0x10',
      'NaN',
      100,
      null
    ]) {
      const value = prizes()
      value[0].probability = invalid
      rejected(() => f.save(value))
    }
    rejected(() => f.save(prizes(['99.9999', '0', '0', '0', '0', '0'])))
    rejected(() => f.save(prizes(['100', '0.0001', '0', '0', '0', '0'])))
    rejected(() => f.save(prizes().slice(0, 5)))
    rejected(() => f.save([...prizes(), prizes()[0]]))
    rejected(() => f.save(prizes(), 'unknown'))
    for (const change of [
      { id: 'forged-slot' },
      { image: null },
      { title: '' },
      { title: '<img src=x>' },
      { title: 'a'.repeat(101) },
      { title: 'x\u0000' },
      { stock: 100 },
      { winner: true }
    ]) {
      const value = prizes()
      Object.assign(value[0], change)
      rejected(() => f.save(value))
    }
    assert.equal(f.audits.length, 0)
    assert.equal(f.store.pools(f.state).tiers[0].configured, false)
  })

  test('严格四角色管理权限，版本冲突且非事务写入均被拒绝', (t) => {
    const f = fixture(t)
    for (const role of ['finance', 'support', 'support_lead', 'player', 'operations', 'hr'])
      rejected(
        () =>
          f.save(prizes(), TIER, {
            ...admin,
            role,
            permissions: ['settings.manage', 'templates.manage']
          }),
        403
      )
    rejected(() => f.save(prizes(), TIER, { ...admin, status: 'disabled' }), 403)
    for (const role of ['admin', 'manager', 'owner', 'super_admin'])
      assert.equal(f.save(prizes(), TIER, { ...admin, role }).configured, true)
    rejected(() => f.save(prizes(), TIER, admin, 0), 409)
    assert.throws(() => f.store.issue(f.state.orders[0]), /业务事务/)
    assert.throws(() => f.store.invalidate('order-1', 'cancel'), /业务事务/)
    assert.throws(() => f.store.draw(f.state, TIER, 'fake'), /业务事务/)
    assert.throws(
      () =>
        f.store.savePool(
          f.state,
          admin,
          {},
          () => null,
          () => {}
        ),
      /业务事务/
    )
  })

  test('一单一码、256位不可预测令牌、SQL只存哈希、重开数据库保留原码和时间', (t) => {
    const f = fixture(t)
    f.issue()
    const original = f.code()
    assert.match(original.code, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(original.status, 'available')
    assert.equal(original.createdAt, START)
    assert.equal(original.expiresAt, '2026-10-26T09:00:00.000Z')
    f.setTime('2026-10-26T08:30:00.000Z')
    f.issue()
    assert.deepEqual(f.code(), original)
    const secondStore = createLotteryStore({ db: f.db, now: () => START })
    assert.deepEqual(secondStore.codeForOrder('order-1'), original)
    const record = f.db.prepare('SELECT * FROM lottery_codes').get()
    assert.ok(!JSON.stringify(record).includes(original.code))
    assert.equal(record.token_hash.length, 64)
    assert.ok(!JSON.stringify(f.state).includes(original.code))
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lottery_codes').get().n, 1)
    f.state.orders.push(order('order-2'))
    f.issue(f.state.orders[1])
    assert.notEqual(f.code('order-2').code, original.code)
    for (const invalid of [order('pending'), order('normal'), order('bad-tier')]) {
      if (invalid.id === 'pending') invalid.status = 'pending'
      if (invalid.id === 'normal') invalid.snapshot.playType = 'normal'
      if (invalid.id === 'bad-tier') invalid.snapshot.lotteryTier = 'unknown'
      rejected(() => f.issue(invalid), 409)
    }
  })

  test('公开投影不含概率、订单、联系资料或内部URL，图片只认可当前及历史奖图', (t) => {
    const f = fixture(t)
    f.state.orders[0].customerPhone = '13900000000'
    f.save()
    f.issue()
    const token = f.code().code
    for (const value of [
      f.store.publicPool(f.state, TIER),
      f.store.readCode(f.state, TIER, token)
    ]) {
      assert.ok(!JSON.stringify(value).includes('probability'))
      assert.ok(!JSON.stringify(value).includes('13900000000'))
      assert.ok(!JSON.stringify(value).includes('order-1'))
      assert.ok(
        value.prizes.every(
          (prize) => prize.image.url === `/api/studio/lottery/assets/${prize.image.id}`
        )
      )
    }
    assert.equal(f.store.pools(f.state).tiers[0].prizes[0].image.url, '/api/studio/uploads/image-1')
    assert.equal(f.store.isAsset(f.state, 'image-1'), true)
    assert.equal(f.store.isAsset(f.state, 'unrelated-private-receipt'), false)
    f.draw(token)
    f.save(prizes(undefined, '-new'))
    assert.equal(f.store.isAsset(f.state, 'image-1'), true)
    assert.equal(f.store.isAsset(f.state, 'image-1-new'), true)
    assert.ok(f.store.assetIds(f.state).has('image-1'))
    assert.equal(f.store.assetIds(f.state).has('unrelated-private-receipt'), false)
  })

  test('未抽奖使用最新池；一次开奖重试和改池后仍保留首次结果及完整六格快照', (t) => {
    const f = fixture(t)
    f.save()
    f.issue()
    const token = f.code().code
    f.save(prizes(['0', '100', '0', '0', '0', '0'], '-latest'))
    const latestView = f.store.readCode(f.state, TIER, token)
    assert.equal(latestView.prizes[0].title, '奖项1-latest')
    const first = f.draw(token)
    assert.equal(first.isNew, true)
    assert.equal(first.order, f.state.orders[0])
    assert.equal(first.view.result.prizeId, 'special-small-2')
    assert.equal(first.view.result.title, '奖项2-latest')
    assert.equal(first.view.remaining, 0)
    assert.equal(first.order.internalRemark, '原打手备注')
    f.save(prizes(['0', '0', '100', '0', '0', '0'], '-future'))
    const second = f.draw(token)
    assert.equal(second.isNew, false)
    assert.deepEqual(second.view, first.view)
    assert.deepEqual(f.store.readCode(f.state, TIER, token), first.view)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 1)
    const snapshot = f.db.prepare('SELECT pool_json FROM lottery_draws').get().pool_json
    assert.ok(!snapshot.includes('probability'))
    assert.ok(snapshot.includes('奖项1-latest'))
    assert.ok(!snapshot.includes('-future'))
  })

  test('旧开奖记录只迁移一次历史奖图索引，换池和重启后仍可查询且按主键检索', (t) => {
    const f = fixture(t)
    f.save()
    f.issue()
    f.draw(f.code().code)
    f.save(prizes(undefined, '-new'))
    f.db.exec(
      "DELETE FROM lottery_draw_assets; DELETE FROM lottery_meta WHERE key='assets-index-v1'"
    )
    const reopened = createLotteryStore({ db: f.db, now: () => START })
    assert.equal(reopened.isAsset(f.state, 'image-1'), true)
    assert.equal(reopened.isAsset(f.state, 'image-6'), true)
    assert.equal(reopened.isAsset(f.state, 'missing-image'), false)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lottery_draw_assets').get().n, 6)
    const plan = f.db
      .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM lottery_draw_assets WHERE attachment_id=?')
      .all('missing-image')
    assert.ok(plan.some((row) => /SEARCH.*INDEX/.test(row.detail)))
    assert.ok(plan.every((row) => !/SCAN/.test(row.detail)))
    assert.equal(createLotteryStore({ db: f.db }).assetIds(f.state).size, 12)
  })

  test('尚未配置不消费机会，设置池后可以开奖；外层事务失败全部回滚', (t) => {
    const f = fixture(t)
    f.issue()
    const token = f.code().code
    rejected(() => f.draw(token), 409, 'LOTTERY_NOT_CONFIGURED')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 0)
    f.save()
    assert.throws(
      () =>
        tx(f.db, () => {
          assert.equal(f.store.draw(f.state, TIER, token).isNew, true)
          throw new Error('模拟中奖备注或审计失败')
        }),
      /模拟中奖备注/
    )
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lottery_draw_assets').get().n, 0)
    assert.equal(f.draw(token).isNew, true)
  })

  test('到期边界先于历史结果；错误、跨档、取消、实际退款均返回统一匿名错误', (t) => {
    const f = fixture(t)
    f.save()
    f.issue()
    const token = f.code().code
    for (const badCode of ['', 'x'.repeat(43), `${token}x`, null, { token }]) {
      unavailable(() => f.store.readCode(f.state, TIER, badCode))
      unavailable(() => f.draw(badCode))
    }
    unavailable(() => f.store.readCode(f.state, 'special-medium', token))
    unavailable(() => f.draw(token, 'special-medium'))
    f.setTime('2026-10-26T08:59:59.999Z')
    f.draw(token)
    f.setTime('2026-10-26T09:00:00.000Z')
    unavailable(() => f.store.readCode(f.state, TIER, token))
    unavailable(() => f.draw(token))
    assert.equal(f.code().status, 'expired')
    assert.equal(f.code().result.title, '奖项1')
    f.setTime(START)
    f.state.orders[0].status = 'canceled'
    unavailable(() => f.store.readCode(f.state, TIER, token))
    unavailable(() => f.draw(token))
    f.state.orders[0].status = 'active'
    f.state.refunds.push({ orderId: 'order-1', status: 'pending', amount: 1 })
    assert.equal(f.store.readCode(f.state, TIER, token).remaining, 0)
    f.state.refunds[0].status = 'paid'
    unavailable(() => f.store.readCode(f.state, TIER, token))
    unavailable(() => f.draw(token))
  })

  test('作废永久生效且不抹除后台中奖记录，换人不重发/延时/重抽', (t) => {
    const f = fixture(t)
    f.save()
    f.issue()
    const original = f.code()
    f.draw(original.code)
    f.state.orders[0].leaderId = 'replacement-worker'
    f.setTime('2026-10-26T08:30:00.000Z')
    f.issue()
    assert.equal(f.code().code, original.code)
    assert.equal(f.code().expiresAt, original.expiresAt)
    assert.equal(f.draw(original.code).isNew, false)
    tx(f.db, () => f.store.invalidate('order-1', '退款'))
    const invalid = f.code()
    assert.equal(invalid.status, 'void')
    assert.equal(invalid.result.title, '奖项1')
    unavailable(() => f.store.readCode(f.state, TIER, original.code))
    unavailable(() => f.draw(original.code))
    f.issue()
    assert.equal(f.code().status, 'void')
    const before = f.db.prepare('SELECT * FROM lottery_codes').get()
    tx(f.db, () => f.store.invalidate('order-1', '再次作废'))
    assert.deepEqual(f.db.prepare('SELECT * FROM lottery_codes').get(), before)
  })

  test('数据库唯一约束和不可变触发器拒绝重复码/重复结果/延时/撤销作废', (t) => {
    const f = fixture(t)
    f.save()
    f.issue()
    f.draw(f.code().code)
    const row = f.db.prepare('SELECT * FROM lottery_codes').get()
    assert.throws(
      () =>
        f.db
          .prepare(
            'INSERT INTO lottery_codes(id,order_id,token_hash,tier,created_at,expires_at) VALUES(?,?,?,?,?,?)'
          )
          .run('duplicate', row.order_id, 'other-hash', row.tier, row.created_at, row.expires_at),
      /UNIQUE/
    )
    assert.throws(
      () =>
        f.db
          .prepare(
            'INSERT INTO lottery_codes(id,order_id,token_hash,tier,created_at,expires_at) VALUES(?,?,?,?,?,?)'
          )
          .run(
            'duplicate',
            'other-order',
            row.token_hash,
            row.tier,
            row.created_at,
            row.expires_at
          ),
      /UNIQUE/
    )
    assert.throws(
      () =>
        f.db.prepare('INSERT INTO lottery_draws VALUES(?,?,?,?)').run(row.id, '{}', '{}', START),
      /UNIQUE/
    )
    assert.throws(
      () => f.db.prepare('UPDATE lottery_codes SET expires_at=?').run('2026-10-27T09:00:00.000Z'),
      /immutable/
    )
    assert.throws(() => f.db.exec('DELETE FROM lottery_codes'), /immutable/)
    assert.throws(() => f.db.exec("UPDATE lottery_draws SET prize_json='{}'"), /immutable/)
    assert.throws(() => f.db.exec('DELETE FROM lottery_draws'), /immutable/)
    tx(f.db, () => f.store.invalidate('order-1', '退款'))
    assert.throws(
      () => f.db.exec('UPDATE lottery_codes SET invalidated_at=NULL,invalid_reason=NULL'),
      /immutable/
    )
  })

  test('独立连接并发 BEGIN IMMEDIATE 时仅一个新结果，其余请求返回同一结果', async (t) => {
    const qaRoot = resolve('.qa')
    mkdirSync(qaRoot, { recursive: true })
    const directory = mkdtempSync(join(qaRoot, 'lottery-store-'))
    const dbPath = join(directory, 'concurrent.sqlite')
    const f = fixture(t, dbPath)
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    f.db.exec('PRAGMA journal_mode=WAL')
    f.save()
    f.issue()
    const token = f.code().code
    const workers = Array.from(
      { length: 6 },
      () =>
        new Worker(new URL(import.meta.url), {
          workerData: { lotteryConcurrency: true, dbPath, state: f.state, token }
        })
    )
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.terminate()))
    })
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolveReady, rejectReady) => {
            worker.once('message', (message) =>
              message.ready ? resolveReady() : rejectReady(new Error(JSON.stringify(message)))
            )
            worker.once('error', rejectReady)
          })
      )
    )
    const pending = workers.map(
      (worker) =>
        new Promise((resolveResult, rejectResult) => {
          worker.once('message', resolveResult)
          worker.once('error', rejectResult)
        })
    )
    for (const worker of workers) worker.postMessage('draw')
    const results = await Promise.all(pending)
    assert.ok(
      results.every((result) => !result.error),
      JSON.stringify(results)
    )
    assert.equal(results.filter((result) => result.isNew).length, 1)
    for (const result of results) assert.deepEqual(result.result, results[0].result)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lottery_draws').get().n, 1)
  })
}
