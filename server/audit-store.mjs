import { ApiError } from './studio.mjs'

const EMERGENCY_LOGIN_MAX_ROWS = 1000
const EMERGENCY_LOGIN_RETENTION_DAYS = 30
const capacityError = (message) =>
  Object.assign(new ApiError(message, 503), { code: 'AUDIT_CAPACITY' })
export const isAuditCapacityError = (error) =>
  error instanceof ApiError && error.status === 503 && error.code === 'AUDIT_CAPACITY'

export function createAuditStore(
  db,
  {
    retentionDays = 90,
    hotMaxRows = 10000,
    archiveMaxBytes = 500 * 1024 * 1024,
    clock = () => new Date()
  } = {}
) {
  for (const value of [retentionDays, hotMaxRows, archiveMaxBytes])
    if (!Number.isSafeInteger(value) || value < 1) throw new ApiError('日志存储配置无效')
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    for (const table of ['audit_logs', 'audit_logs_archive']) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY,actor_id TEXT,action TEXT,entity TEXT,entity_id TEXT,created_at TEXT,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_date ON ${table}(created_at DESC,id); CREATE INDEX IF NOT EXISTS ${table}_actor ON ${table}(actor_id,created_at DESC); CREATE INDEX IF NOT EXISTS ${table}_entity ON ${table}(entity,entity_id,created_at DESC)`
      )
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === 'byte_length')
      )
        db.exec(
          `ALTER TABLE ${table} ADD COLUMN byte_length INTEGER NOT NULL DEFAULT 0; UPDATE ${table} SET byte_length=length(CAST(payload AS BLOB))`
        )
    }
    db.exec(
      'CREATE TABLE IF NOT EXISTS audit_storage_totals(table_name TEXT PRIMARY KEY,bytes INTEGER NOT NULL,rows INTEGER NOT NULL)'
    )
    if (
      !db
        .prepare('PRAGMA table_info(audit_storage_totals)')
        .all()
        .some((row) => row.name === 'revision')
    )
      db.exec('ALTER TABLE audit_storage_totals ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
    for (const table of ['audit_logs', 'audit_logs_archive']) {
      if (!db.prepare('SELECT 1 FROM audit_storage_totals WHERE table_name=?').get(table)) {
        db.exec(`UPDATE ${table} SET byte_length=length(CAST(payload AS BLOB))`)
        db.prepare(
          `INSERT INTO audit_storage_totals(table_name,bytes,rows) SELECT ?,COALESCE(SUM(byte_length),0),COUNT(*) FROM ${table}`
        ).run(table)
      }
      db.exec(`DROP TRIGGER IF EXISTS ${table}_storage_insert; DROP TRIGGER IF EXISTS ${table}_storage_delete; DROP TRIGGER IF EXISTS ${table}_storage_bytes;
      CREATE TRIGGER ${table}_storage_insert AFTER INSERT ON ${table} BEGIN UPDATE audit_storage_totals SET bytes=bytes+NEW.byte_length,rows=rows+1,revision=revision+1 WHERE table_name='${table}'; END;
      CREATE TRIGGER ${table}_storage_delete AFTER DELETE ON ${table} BEGIN UPDATE audit_storage_totals SET bytes=bytes-OLD.byte_length,rows=rows-1,revision=revision+1 WHERE table_name='${table}'; END;
      CREATE TRIGGER ${table}_storage_bytes AFTER UPDATE OF byte_length ON ${table} BEGIN UPDATE audit_storage_totals SET bytes=bytes+NEW.byte_length-OLD.byte_length,revision=revision+1 WHERE table_name='${table}'; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_storage_payload AFTER UPDATE OF payload ON ${table} BEGIN UPDATE ${table} SET byte_length=length(CAST(NEW.payload AS BLOB)) WHERE id=NEW.id; END;`)
    }
    db.exec(
      'CREATE TABLE IF NOT EXISTS audit_emergency_logins(id TEXT PRIMARY KEY,actor_id TEXT,action TEXT,entity TEXT,entity_id TEXT,created_at TEXT,payload TEXT NOT NULL,byte_length INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS audit_emergency_login_date ON audit_emergency_logins(created_at DESC,id DESC); CREATE TABLE IF NOT EXISTS audit_runtime_state(id INTEGER PRIMARY KEY CHECK(id=1),maintenance_mode INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO audit_runtime_state(id,maintenance_mode) VALUES(1,0)'
    )
    pruneEmergencyLogins()
    if (ownsTransaction) db.exec('COMMIT')
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK')
    throw error
  }
  const bytes = (table) =>
    Number(db.prepare('SELECT bytes FROM audit_storage_totals WHERE table_name=?').get(table).bytes)
  const count = (table) =>
    Number(db.prepare('SELECT rows FROM audit_storage_totals WHERE table_name=?').get(table).rows)
  const insert = db.prepare(
    'INSERT OR IGNORE INTO audit_logs(id,actor_id,action,entity,entity_id,created_at,payload,byte_length) VALUES(?,?,?,?,?,?,?,?)'
  )
  const archivedId = db.prepare('SELECT 1 FROM audit_logs_archive WHERE id=?')
  const put = (log) => {
    if (archivedId.get(log.id)) return { changes: 0 }
    const payload = JSON.stringify(log)
    return insert.run(
      log.id,
      log.actorId || '',
      log.action || '',
      log.entity || '',
      log.entityId || '',
      log.createdAt || '',
      payload,
      Buffer.byteLength(payload)
    )
  }
  function emergencyCutoff() {
    return new Date(
      new Date(clock()).getTime() - EMERGENCY_LOGIN_RETENTION_DAYS * 86400000
    ).toISOString()
  }
  function pruneEmergencyLogins() {
    db.prepare('DELETE FROM audit_emergency_logins WHERE created_at<?').run(emergencyCutoff())
    db.prepare(
      'DELETE FROM audit_emergency_logins WHERE id IN (SELECT id FROM audit_emergency_logins ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?)'
    ).run(EMERGENCY_LOGIN_MAX_ROWS)
  }
  function appendEmergencyLogin({ id, actorId, actorName, createdAt }) {
    // Only capacity-recovery login metadata enters this bounded security log.
    const log = {
      id,
      actorId,
      actorName,
      action: '登录（日志容量维护）',
      entity: 'session',
      entityId: actorId,
      createdAt,
      before: null,
      after: { userId: actorId }
    }
    const payload = JSON.stringify(log)
    db.prepare('INSERT INTO audit_emergency_logins VALUES(?,?,?,?,?,?,?,?)').run(
      id,
      actorId,
      log.action,
      log.entity,
      actorId,
      createdAt,
      payload,
      Buffer.byteLength(payload)
    )
    pruneEmergencyLogins()
    db.prepare('UPDATE audit_runtime_state SET maintenance_mode=1 WHERE id=1').run()
  }
  function storage() {
    const archiveBytes = bytes('audit_logs_archive')
    const maintenanceMode =
      archiveBytes >= archiveMaxBytes ||
      Boolean(
        db.prepare('SELECT maintenance_mode FROM audit_runtime_state WHERE id=1').get()
          .maintenance_mode
      )
    return {
      hotRows: count('audit_logs'),
      archiveRows: count('audit_logs_archive'),
      archiveBytes,
      archiveMaxBytes,
      retentionDays,
      hotMaxRows,
      emergencyLoginRows: Number(
        db
          .prepare('SELECT COUNT(*) AS n FROM audit_emergency_logins WHERE created_at>=?')
          .get(emergencyCutoff()).n
      ),
      emergencyLoginMaxRows: EMERGENCY_LOGIN_MAX_ROWS,
      emergencyLoginRetentionDays: EMERGENCY_LOGIN_RETENTION_DAYS,
      maintenanceMode,
      warning: maintenanceMode || archiveBytes >= archiveMaxBytes * 0.9
    }
  }
  function archive() {
    const cutoff = new Date(new Date(clock()).getTime() - retentionDays * 86400000).toISOString()
    const selected = db
      .prepare(
        'SELECT id,byte_length FROM audit_logs WHERE created_at < ? OR id IN (SELECT id FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?)'
      )
      .all(cutoff, hotMaxRows)
    const total = selected.reduce((sum, row) => sum + row.byte_length, 0)
    if (bytes('audit_logs_archive') + total > archiveMaxBytes)
      throw capacityError(
        '日志归档容量已满，请管理员先导出备份并清理已备份的归档记录；本次修改未保存'
      )
    const move = db.prepare(
      'INSERT OR IGNORE INTO audit_logs_archive SELECT * FROM audit_logs WHERE id=?'
    )
    const remove = db.prepare('DELETE FROM audit_logs WHERE id=?')
    for (const row of selected) {
      move.run(row.id)
      remove.run(row.id)
    }
    return selected.length
  }
  function append(log) {
    if (bytes('audit_logs_archive') >= archiveMaxBytes)
      throw capacityError('日志归档容量已满，请先导出备份并清理归档；本次修改未保存')
    put(log)
    archive()
    db.prepare('UPDATE audit_runtime_state SET maintenance_mode=0 WHERE id=1').run()
  }
  function query({
    source = 'all',
    actorId,
    entity,
    entityId,
    action,
    start,
    end,
    keyword,
    keywordField,
    omitEntities = []
  } = {}) {
    if (!['all', 'hot', 'archive'].includes(source)) throw new ApiError('日志来源无效')
    const conditions = [],
      params = []
    for (const [column, value] of [
      ['actor_id', actorId],
      ['entity', entity],
      ['entity_id', entityId]
    ])
      if (value) {
        conditions.push(`${column}=?`)
        params.push(value)
      }
    if (start) {
      conditions.push('created_at>=?')
      params.push(new Date(`${start}T00:00:00+08:00`).toISOString())
    }
    if (action) {
      conditions.push('instr(action,?)>0')
      params.push(action)
    }
    if (end) {
      conditions.push('created_at<?')
      params.push(new Date(Date.parse(`${end}T00:00:00+08:00`) + 86400000).toISOString())
    }
    if (keyword) {
      const columns = {
        id: 'id',
        action: 'action',
        actorName: "json_extract(payload,'$.actorName')",
        entity: 'entity',
        entityId: 'entity_id',
        createdAt: "datetime(created_at,'+8 hours')"
      }
      if (keywordField) {
        if (!Object.hasOwn(columns, keywordField))
          throw new ApiError('日志关键词只能检索公开的操作人、操作动作、类型、记录号或时间字段')
        conditions.push(`instr(lower(${columns[keywordField]}),lower(?))>0`)
        params.push(keyword)
      } else {
        const searchable = Object.values(columns)
        conditions.push(
          '(' + searchable.map((column) => `instr(lower(${column}),lower(?))>0`).join(' OR ') + ')'
        )
        params.push(...searchable.map(() => keyword))
      }
    }
    if (omitEntities.length) {
      conditions.push(`entity NOT IN (${omitEntities.map(() => '?').join(',')})`)
      params.push(...omitEntities)
    }
    const emergency =
      "SELECT * FROM audit_emergency_logins WHERE created_at>='" + emergencyCutoff() + "'"
    const from =
      source === 'hot'
        ? `(SELECT * FROM audit_logs UNION ALL ${emergency})`
        : source === 'archive'
          ? 'audit_logs_archive'
          : `(SELECT * FROM audit_logs UNION ALL SELECT * FROM audit_logs_archive UNION ALL ${emergency})`
    return { from, where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params }
  }
  function rows(options = {}) {
    const { from, where, params } = query(options)
    return db
      .prepare(
        `SELECT payload FROM ${from}${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, options.limit ?? 100001, options.offset ?? 0)
      .map((row) => JSON.parse(row.payload))
  }
  function total(options = {}) {
    const { from, where, params } = query(options)
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${from}${where}`).get(...params).n)
  }
  function get(id) {
    const row = db
      .prepare(
        'SELECT payload FROM audit_logs WHERE id=? UNION ALL SELECT payload FROM audit_logs_archive WHERE id=? UNION ALL SELECT payload FROM audit_emergency_logins WHERE id=? AND created_at>=? LIMIT 1'
      )
      .get(id, id, id, emergencyCutoff())
    return row ? JSON.parse(row.payload) : null
  }
  function bounds() {
    return db
      .prepare(
        "SELECT MIN(created_at) AS start,MAX(created_at) AS end FROM (SELECT created_at FROM audit_logs UNION ALL SELECT created_at FROM audit_logs_archive UNION ALL SELECT created_at FROM audit_emergency_logins WHERE created_at>=?) WHERE created_at<>''"
      )
      .get(emergencyCutoff())
  }
  function purge(beforeDate) {
    const cutoff = new Date(`${beforeDate}T00:00:00+08:00`).toISOString()
    return Number(
      db.prepare('DELETE FROM audit_logs_archive WHERE created_at<?').run(cutoff).changes
    )
  }
  function backupScope(beforeDate) {
    const cutoff = new Date(`${beforeDate}T00:00:00+08:00`).toISOString()
    const result = db
      .prepare(
        'SELECT COUNT(*) AS count,MAX(created_at) AS maxCreatedAt,COALESCE(SUM(byte_length),0) AS bytes FROM audit_logs_archive WHERE created_at<?'
      )
      .get(cutoff)
    const revision = db
      .prepare("SELECT revision FROM audit_storage_totals WHERE table_name='audit_logs_archive'")
      .get().revision
    return { ...result, revision }
  }
  function backupIterator(beforeDate) {
    const cutoff = new Date(`${beforeDate}T00:00:00+08:00`).toISOString()
    return db
      .prepare('SELECT payload FROM audit_logs_archive WHERE created_at<? ORDER BY created_at,id')
      .iterate(cutoff)
  }
  return {
    append,
    appendEmergencyLogin,
    archive,
    storage,
    rows,
    total,
    get,
    bounds,
    purge,
    backupScope,
    backupIterator,
    importLegacy: (logs) => logs.forEach(put)
  }
}
