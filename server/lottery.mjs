import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto'

const TIERS = Object.freeze({
  'special-small': '特惠小转盘',
  'special-medium': '特惠中转盘',
  'value-large': '超值大转盘',
  'ultimate-large': '终极大转盘'
})
const MANAGERS = new Set(['admin', 'manager', 'owner', 'super_admin'])
const TOTAL = 1_000_000
const HOUR = 60 * 60 * 1000
const copy = (value) => JSON.parse(JSON.stringify(value))
const publicPrize = ({ id, title, image }) => ({
  id,
  title,
  image: image ? { ...copy(image), url: `/api/studio/lottery/assets/${image.id}` } : null
})
const hash = (token) => createHash('sha256').update(token).digest('hex')
const slots = (tier) =>
  Array.from({ length: 6 }, (_, index) => ({
    id: `${tier}-${index + 1}`,
    title: '',
    image: null,
    probability: '0'
  }))

// The service owns BEGIN IMMEDIATE and commits the state JSON, audit, order note,
// and the SQL draw together. Only the one-time asset-index migration owns a transaction.
export function createLotteryStore({ db, now = () => new Date().toISOString(), fail }) {
  const reject = (message, status = 400, code) => {
    try {
      if (fail) fail(message, status)
    } catch (error) {
      if (code) error.code = code
      throw error
    }
    const error = new Error(message)
    error.status = status
    if (code) error.code = code
    throw error
  }
  const unavailable = () => reject('兑换码不可用，请联系下单客服', 400, 'LOTTERY_CODE_UNAVAILABLE')
  const transactional = () => {
    if (!db.isTransaction) throw new Error('转盘写入必须在业务事务中执行')
  }
  const clock = () => {
    const value = new Date(now())
    if (!Number.isFinite(value.getTime())) throw new Error('转盘服务器时间无效')
    return value.toISOString()
  }
  const tierCheck = (tier) => {
    if (!Object.hasOwn(TIERS, tier)) reject('转盘类目无效')
    return tier
  }
  const probability = (value) => {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(value))
      reject('中奖概率须为最多四位小数的百分比文本')
    const [whole, decimal = ''] = value.split('.')
    const units = Number(whole) * 10000 + Number(decimal.padEnd(4, '0'))
    if (units > TOTAL) reject('中奖概率须在 0% 至 100% 之间')
    return {
      units,
      value: `${Number(whole)}${decimal.replace(/0+$/, '') ? `.${decimal.replace(/0+$/, '')}` : ''}`
    }
  }
  const pool = (state, tier) => {
    tierCheck(tier)
    return (
      state.lotteryPools?.find((row) => row.tier === tier) || {
        tier,
        title: TIERS[tier],
        revision: 0,
        configured: false,
        prizes: slots(tier)
      }
    )
  }
  const adminPool = (state, tier) => {
    const row = pool(state, tier)
    return copy({
      tier,
      title: TIERS[tier],
      revision: row.revision,
      configured: row.configured === true,
      prizes: row.prizes
    })
  }
  const publicPool = (state, tier) => {
    const row = pool(state, tier)
    return {
      tier,
      title: TIERS[tier],
      revision: row.revision,
      configured: row.configured === true,
      prizes: row.prizes.map(publicPrize)
    }
  }

  db.exec(`CREATE TABLE IF NOT EXISTS lottery_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lottery_codes (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL CHECK(tier IN ('special-small','special-medium','value-large','ultimate-large')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL CHECK(expires_at > created_at),
      invalidated_at TEXT,
      invalid_reason TEXT,
      CHECK((invalidated_at IS NULL) = (invalid_reason IS NULL))
    );
    CREATE TABLE IF NOT EXISTS lottery_draws (
      code_id TEXT PRIMARY KEY REFERENCES lottery_codes(id),
      prize_json TEXT NOT NULL,
      pool_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lottery_draw_assets (attachment_id TEXT PRIMARY KEY);
    CREATE TRIGGER IF NOT EXISTS lottery_draws_immutable_update
      BEFORE UPDATE ON lottery_draws BEGIN SELECT RAISE(ABORT,'lottery draws are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS lottery_draws_immutable_delete
      BEFORE DELETE ON lottery_draws BEGIN SELECT RAISE(ABORT,'lottery draws are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS lottery_codes_immutable_identity
      BEFORE UPDATE ON lottery_codes WHEN NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id
        OR NEW.token_hash IS NOT OLD.token_hash OR NEW.tier IS NOT OLD.tier
        OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
        OR (OLD.invalidated_at IS NOT NULL AND (NEW.invalidated_at IS NOT OLD.invalidated_at
          OR NEW.invalid_reason IS NOT OLD.invalid_reason))
      BEGIN SELECT RAISE(ABORT,'lottery code identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS lottery_codes_immutable_delete
      BEFORE DELETE ON lottery_codes BEGIN SELECT RAISE(ABORT,'lottery codes are immutable'); END;`)
  if (!db.prepare('SELECT 1 FROM lottery_meta WHERE key=?').get('assets-index-v1')) {
    const ownsTransaction = !db.isTransaction
    if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
    try {
      if (!db.prepare('SELECT 1 FROM lottery_meta WHERE key=?').get('assets-index-v1')) {
        db.exec(`INSERT OR IGNORE INTO lottery_draw_assets(attachment_id)
          SELECT json_extract(prize.value,'$.image.id')
          FROM lottery_draws AS draw, json_each(draw.pool_json,'$.prizes') AS prize
          WHERE json_type(prize.value,'$.image.id')='text';
          INSERT INTO lottery_meta(key,value) VALUES('assets-index-v1','1');`)
      }
      if (ownsTransaction) db.exec('COMMIT')
    } catch (error) {
      if (ownsTransaction) db.exec('ROLLBACK')
      throw error
    }
  }
  db.prepare('INSERT OR IGNORE INTO lottery_meta(key,value) VALUES(?,?)').run(
    'code-hmac-v1',
    randomBytes(32).toString('hex')
  )
  const secret = Buffer.from(
    db.prepare('SELECT value FROM lottery_meta WHERE key=?').get('code-hmac-v1').value,
    'hex'
  )
  if (secret.length !== 32) throw new Error('转盘兑换码密钥损坏，停止发码')
  const tokenFor = (row) =>
    createHmac('sha256', secret)
      .update(`lottery-code:v1:${row.id}:${row.order_id}`)
      .digest('base64url')
  const drawFor = (codeId) => db.prepare('SELECT * FROM lottery_draws WHERE code_id=?').get(codeId)
  const resultFor = (draw) => {
    if (!draw) return null
    const prize = JSON.parse(draw.prize_json)
    return { prizeId: prize.id, title: prize.title, image: prize.image, drawnAt: draw.created_at }
  }
  const usable = (state, tier, token, time) => {
    if (
      !Object.hasOwn(TIERS, tier) ||
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)
    )
      unavailable()
    const row = db.prepare('SELECT * FROM lottery_codes WHERE token_hash=?').get(hash(token))
    if (!row || row.tier !== tier || row.invalidated_at || row.expires_at <= time) unavailable()
    const order = state.orders?.find((entry) => entry.id === row.order_id)
    if (
      !order ||
      order.status === 'canceled' ||
      order.snapshot?.playType !== 'lottery' ||
      order.snapshot?.lotteryTier !== tier ||
      state.refunds?.some(
        (refund) => refund.orderId === order.id && refund.status === 'paid' && refund.amount > 0
      )
    )
      unavailable()
    return { row, order }
  }
  const view = (state, row, time, draw = drawFor(row.id)) => {
    const current = draw ? JSON.parse(draw.pool_json) : publicPool(state, row.tier)
    return {
      tier: row.tier,
      title: TIERS[row.tier],
      remaining: draw ? 0 : 1,
      expiresAt: row.expires_at,
      serverTime: time,
      result: resultFor(draw),
      prizes: current.prizes.map(publicPrize),
      configured: current.configured === true
    }
  }

  return {
    pools: (state) => ({ tiers: Object.keys(TIERS).map((tier) => adminPool(state, tier)) }),
    publicPool,
    savePool(state, user, body, normalizeImage, audit) {
      transactional()
      if (!user || user.status !== 'active' || !MANAGERS.has(user.role))
        reject('当前角色不能管理转盘', 403)
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['tier', 'revision', 'prizes'].includes(key))
      )
        reject('转盘配置字段无效')
      const tier = tierCheck(body.tier)
      const before = adminPool(state, tier)
      if (!Number.isSafeInteger(body.revision) || body.revision !== before.revision)
        reject('转盘配置已被修改，请刷新后再保存', 409)
      if (!Array.isArray(body.prizes) || body.prizes.length !== 6)
        reject('每种转盘必须固定配置六个奖项')
      let total = 0
      const prizes = body.prizes.map((entry, index) => {
        const prizeId = `${tier}-${index + 1}`
        if (
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          Object.keys(entry).some(
            (key) => !['id', 'title', 'image', 'probability'].includes(key)
          ) ||
          (entry.id !== undefined && entry.id !== prizeId)
        )
          reject('奖项字段或固定位置编号无效')
        if (
          typeof entry.title !== 'string' ||
          !entry.title.trim() ||
          entry.title.trim().length > 100 ||
          // eslint-disable-next-line no-control-regex -- Reject invisible ASCII controls in prize names.
          /[\u0000-\u001f\u007f<>]/.test(entry.title)
        )
          reject('奖项名称须为 1 至 100 字的纯文本')
        const normalized = probability(entry.probability)
        total += normalized.units
        const image = normalizeImage(entry.image, before.prizes[index].image)
        if (!image || typeof image !== 'object' || Array.isArray(image) || !image.id)
          reject('每个奖项必须设置图片')
        return {
          id: prizeId,
          title: entry.title.trim(),
          image: copy(image),
          probability: normalized.value
        }
      })
      if (total !== TOTAL) reject('六个奖项的中奖概率合计必须为 100%')
      const after = {
        tier,
        title: TIERS[tier],
        revision: before.revision + 1,
        configured: true,
        prizes
      }
      state.lotteryPools ||= []
      const index = state.lotteryPools.findIndex((row) => row.tier === tier)
      if (index < 0) state.lotteryPools.push(after)
      else state.lotteryPools[index] = after
      audit(copy(before), copy(after))
      return copy(after)
    },
    issue(order) {
      transactional()
      const existing = db.prepare('SELECT * FROM lottery_codes WHERE order_id=?').get(order.id)
      if (existing) return copy(existing)
      if (
        typeof order.id !== 'string' ||
        !order.id ||
        order.status !== 'active' ||
        order.snapshot?.playType !== 'lottery' ||
        !Object.hasOwn(TIERS, order.snapshot?.lotteryTier)
      )
        reject('只有实际接单的转盘订单可以生成兑换码', 409)
      const createdAt = clock()
      const row = {
        id: randomUUID(),
        order_id: order.id,
        tier: order.snapshot.lotteryTier,
        created_at: createdAt,
        expires_at: new Date(Date.parse(createdAt) + HOUR).toISOString()
      }
      db.prepare(
        'INSERT INTO lottery_codes(id,order_id,token_hash,tier,created_at,expires_at) VALUES(?,?,?,?,?,?)'
      ).run(row.id, row.order_id, hash(tokenFor(row)), row.tier, row.created_at, row.expires_at)
      return copy(db.prepare('SELECT * FROM lottery_codes WHERE id=?').get(row.id))
    },
    invalidate(orderId, reason) {
      transactional()
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 500)
        reject('兑换码作废原因无效')
      db.prepare(
        'UPDATE lottery_codes SET invalidated_at=?,invalid_reason=? WHERE order_id=? AND invalidated_at IS NULL'
      ).run(clock(), reason.trim(), orderId)
    },
    codeForOrder(orderId) {
      const row = db.prepare('SELECT * FROM lottery_codes WHERE order_id=?').get(orderId)
      if (!row) return null
      const time = clock()
      const draw = drawFor(row.id)
      return {
        code: tokenFor(row),
        tier: row.tier,
        status: row.invalidated_at
          ? 'void'
          : row.expires_at <= time
            ? 'expired'
            : draw
              ? 'drawn'
              : 'available',
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        result: resultFor(draw)
      }
    },
    readCode(state, tier, code) {
      const time = clock()
      const { row } = usable(state, tier, code, time)
      return view(state, row, time)
    },
    draw(state, tier, code) {
      transactional()
      const time = clock()
      const { row, order } = usable(state, tier, code, time)
      const previous = drawFor(row.id)
      if (previous) return { view: view(state, row, time, previous), isNew: false, order }
      const current = pool(state, tier)
      if (!current.configured)
        reject('该转盘尚未完成奖项配置，请联系下单客服', 409, 'LOTTERY_NOT_CONFIGURED')
      const weights = current.prizes.map((prize) => probability(prize.probability).units)
      if (current.prizes.length !== 6 || weights.reduce((sum, item) => sum + item, 0) !== TOTAL)
        reject('该转盘尚未完成奖项配置，请联系下单客服', 409, 'LOTTERY_NOT_CONFIGURED')
      const selection = randomInt(TOTAL)
      let boundary = 0
      const selected = current.prizes.find((_, index) => {
        boundary += weights[index]
        return selection < boundary
      })
      const prize = publicPrize(selected)
      const snapshot = publicPool(state, tier)
      db.prepare(
        'INSERT INTO lottery_draws(code_id,prize_json,pool_json,created_at) VALUES(?,?,?,?)'
      ).run(row.id, JSON.stringify(prize), JSON.stringify(snapshot), time)
      for (const item of snapshot.prizes)
        db.prepare('INSERT OR IGNORE INTO lottery_draw_assets(attachment_id) VALUES(?)').run(
          item.image.id
        )
      return { view: view(state, row, time), isNew: true, order }
    },
    isAsset(state, attachmentId) {
      if (typeof attachmentId !== 'string' || !attachmentId) return false
      if (
        Object.keys(TIERS).some((tier) =>
          pool(state, tier).prizes.some((prize) => prize.image?.id === attachmentId)
        )
      )
        return true
      return Boolean(
        db.prepare('SELECT 1 FROM lottery_draw_assets WHERE attachment_id=?').get(attachmentId)
      )
    },
    assetIds(state) {
      const ids = new Set()
      for (const tier of Object.keys(TIERS))
        for (const prize of pool(state, tier).prizes) if (prize.image?.id) ids.add(prize.image.id)
      for (const row of db.prepare('SELECT attachment_id FROM lottery_draw_assets').iterate())
        ids.add(row.attachment_id)
      return ids
    }
  }
}
