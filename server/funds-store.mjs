import { ApiError } from './studio.mjs'

const stable = (value) =>
  JSON.stringify(value, function (_, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  })
export function createFundsStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS fund_accounts(account_type TEXT NOT NULL,account_id TEXT NOT NULL,balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),PRIMARY KEY(account_type,account_id));
    CREATE TABLE IF NOT EXISTS fund_transactions(id TEXT PRIMARY KEY,account_type TEXT NOT NULL,account_id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),delta INTEGER NOT NULL,balance_after INTEGER NOT NULL CHECK(balance_after>=0),reason TEXT NOT NULL,receipt_json TEXT,order_id TEXT,created_at TEXT NOT NULL,created_by TEXT NOT NULL,created_by_name TEXT NOT NULL,request_id TEXT NOT NULL,exit_type TEXT,source_id TEXT UNIQUE);
    CREATE INDEX IF NOT EXISTS fund_transactions_account ON fund_transactions(account_type,account_id,created_at DESC,id);
    CREATE INDEX IF NOT EXISTS fund_transactions_date ON fund_transactions(account_type,created_at,kind);
    CREATE TABLE IF NOT EXISTS financial_requests(request_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,operation TEXT NOT NULL,payload_json TEXT NOT NULL,result_json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS fund_transactions_immutable_update BEFORE UPDATE ON fund_transactions BEGIN SELECT RAISE(ABORT,'fund transactions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS fund_transactions_immutable_delete BEFORE DELETE ON fund_transactions BEGIN SELECT RAISE(ABORT,'fund transactions are immutable'); END;`)
  const project = (row) => ({
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    amount: row.amount,
    delta: row.delta,
    balanceAfter: row.balance_after,
    reason: row.reason,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    orderId: row.order_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    requestId: row.request_id,
    exitType: row.exit_type
  })
  const balance = (type, accountId) =>
    Number(
      db
        .prepare('SELECT balance FROM fund_accounts WHERE account_type=? AND account_id=?')
        .get(type, accountId)?.balance || 0
    )
  const request = (actorId, operation, requestId, body, callback, required = false) => {
    if (requestId == null && !required) return callback()
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128)
      throw new ApiError('请提供有效资金操作 requestId，重试须沿用原值')
    const payload = stable(body)
    const existing = db
      .prepare('SELECT * FROM financial_requests WHERE request_id=?')
      .get(requestId)
    if (existing) {
      if (
        existing.actor_id !== actorId ||
        existing.operation !== operation ||
        existing.payload_json !== payload
      )
        throw new ApiError('该 requestId 已用于不同操作或内容，请勿复用', 409)
      return JSON.parse(existing.result_json)
    }
    const result = callback()
    db.prepare('INSERT INTO financial_requests VALUES(?,?,?,?,?)').run(
      requestId,
      actorId,
      operation,
      payload,
      JSON.stringify(result)
    )
    return result
  }
  const append = ({
    type,
    accountId,
    kind,
    amount,
    direction,
    reason,
    receipt = null,
    orderId = null,
    actor,
    requestId,
    exitType = null,
    sourceId = null,
    now,
    id
  }) => {
    if (!db.isTransaction) throw new Error('资金写入必须在业务事务中执行')
    if (sourceId && db.prepare('SELECT id FROM fund_transactions WHERE source_id=?').get(sourceId))
      throw new ApiError('该业务资金已经登记，不能重复入账', 409)
    const next = balance(type, accountId) + direction * amount
    if (!Number.isSafeInteger(next) || next < 0)
      throw new ApiError(
        type === 'customer'
          ? '客户储值余额不足，本次操作未保存'
          : '打手押金余额不足，本次操作未保存',
        409
      )
    db.prepare(
      'INSERT INTO fund_accounts VALUES(?,?,?) ON CONFLICT(account_type,account_id) DO UPDATE SET balance=excluded.balance'
    ).run(type, accountId, next)
    db.prepare('INSERT INTO fund_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id,
      type,
      accountId,
      kind,
      amount,
      direction * amount,
      next,
      reason,
      receipt ? JSON.stringify(receipt) : null,
      orderId,
      now,
      actor.id,
      actor.name,
      requestId,
      exitType,
      sourceId
    )
    return project(db.prepare('SELECT * FROM fund_transactions WHERE id=?').get(id))
  }
  const query = ({ type, accountIds, start, end, match } = {}) => {
    const conditions = [],
      params = []
    if (type) {
      conditions.push('account_type=?')
      params.push(type)
    }
    if (accountIds) {
      conditions.push('account_id IN (SELECT value FROM json_each(?))')
      params.push(JSON.stringify(accountIds))
    }
    if (start) {
      conditions.push('created_at>=?')
      params.push(new Date(`${start}T00:00:00+08:00`).toISOString())
    }
    if (end) {
      conditions.push('created_at<?')
      params.push(new Date(Date.parse(`${end}T00:00:00+08:00`) + 86400000).toISOString())
    }
    if (match) {
      db.function('fund_record_matches', { deterministic: true, varargs: true }, (...values) =>
        match(
          project({
            id: values[0],
            account_id: values[1],
            kind: values[2],
            amount: values[3],
            delta: values[4],
            balance_after: values[5],
            reason: values[6],
            receipt_json: values[7],
            order_id: values[8],
            created_at: values[9],
            created_by: values[10],
            created_by_name: values[11],
            request_id: values[12],
            exit_type: values[13]
          })
        )
          ? 1
          : 0
      )
      conditions.push(
        'fund_record_matches(id,account_id,kind,amount,delta,balance_after,reason,receipt_json,order_id,created_at,created_by,created_by_name,request_id,exit_type)=1'
      )
    }
    return { where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params }
  }
  const rows = (options = {}) => {
    const { where, params } = query(options)
    return db
      .prepare(
        `SELECT * FROM fund_transactions${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`
      )
      .all(...params, options.limit ?? -1, options.offset ?? 0)
      .map(project)
  }
  const count = (options = {}) => {
    const { where, params } = query(options)
    return Number(
      db.prepare(`SELECT COUNT(*) AS n FROM fund_transactions${where}`).get(...params).n
    )
  }
  const income = (month) =>
    db
      .prepare(
        "SELECT date(created_at,'+8 hours') AS date,SUM(amount) AS amount FROM fund_transactions WHERE (account_type='customer' AND kind='deduction' OR account_type='deposit' AND kind='penalty') AND date(created_at,'+8 hours') LIKE ? GROUP BY date(created_at,'+8 hours')"
      )
      .all(`${month}-%`)
  return {
    balance,
    request,
    append,
    rows,
    count,
    income,
    firstDate: (options = {}) => {
      const { where, params } = query(options)
      return db
        .prepare(`SELECT MIN(created_at) AS value FROM fund_transactions${where}`)
        .get(...params).value
    },
    diagnosticRows: () =>
      db
        .prepare('SELECT * FROM fund_transactions ORDER BY rowid')
        .all()
        .map((row) => ({ ...project(row), type: row.account_type })),
    accounts: () =>
      db
        .prepare('SELECT account_type AS type,account_id AS accountId,balance FROM fund_accounts')
        .all()
  }
}
