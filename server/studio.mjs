import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { buildOverviewReport, normalizeOverviewRange, overviewMonths } from './overview-report.mjs'
import {
  defaultAppearance,
  normalizeAppearance,
  validateAppearanceRevision,
  appearanceAttachments,
  projectAppearanceAudit,
  projectPublicAppearance,
  publicAppearanceAttachments
} from './appearance.mjs'
import { createAuditStore, isAuditCapacityError } from './audit-store.mjs'
import { platformRules, normalizePlatformRules } from './platform-rules.mjs'
import { buildPeriodExportSnapshot } from './export-period.mjs'

export const ALL_PERMISSIONS = [
  'orders.view',
  'orders.create',
  'orders.edit',
  'finance.review',
  'finance.refunds',
  'finance.withdrawals',
  'finance.expenses',
  'salary.view',
  'salary.all',
  'salary.manage',
  'profit.view',
  'users.manage',
  'templates.manage',
  'settings.manage',
  'attendance.manage',
  'logs.view',
  'reports.export'
]
const ROLES = [
  'owner',
  'manager',
  'finance',
  'hr',
  'operations',
  'support_lead',
  'support',
  'admin',
  'super_admin',
  'player'
]
const DEFAULT_PERMISSIONS = {
  super_admin: ALL_PERMISSIONS,
  owner: ALL_PERMISSIONS,
  manager: [
    'orders.view',
    'orders.create',
    'orders.edit',
    'salary.view',
    'salary.all',
    'profit.view',
    'logs.view'
  ],
  finance: [
    'orders.view',
    'orders.edit',
    'finance.review',
    'finance.refunds',
    'finance.withdrawals',
    'finance.expenses',
    'salary.view',
    'salary.all',
    'salary.manage',
    'profit.view',
    'logs.view'
  ],
  hr: ['attendance.manage', 'salary.view'],
  operations: ['orders.view', 'orders.create', 'salary.view'],
  support_lead: ['orders.view', 'orders.create', 'orders.edit'],
  support: ['orders.view', 'orders.create', 'orders.edit'],
  admin: ['orders.view', 'users.manage', 'templates.manage', 'settings.manage', 'logs.view'],
  player: []
}
const COMPLETE_AUDIT_PERMISSIONS = [
  'settings.manage',
  'logs.view',
  'reports.export',
  'orders.view',
  'users.manage',
  'salary.all',
  'profit.view',
  'finance.review',
  'finance.refunds',
  'finance.withdrawals',
  'finance.expenses'
]
for (const [role, permissions] of Object.entries(DEFAULT_PERMISSIONS))
  if (!['support', 'support_lead'].includes(role) && !permissions.includes('reports.export'))
    permissions.push('reports.export')
export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
const fail = (message, status = 400) => {
  throw new ApiError(message, status)
}
const id = () => randomUUID()
const clone = (value) => JSON.parse(JSON.stringify(value))
const text = (value, label, { required = false, max = 2000 } = {}) => {
  if (value == null) {
    if (required) fail(`${label}不能为空`)
    return ''
  }
  if (typeof value !== 'string') fail(`${label}必须为文本`)
  const result = value.trim()
  if (required && !result) fail(`${label}不能为空`)
  if (result.length > max) fail(`${label}不能超过${max}字`)
  return result
}
const cents = (value, label, { positive = false, nullable = false } = {}) => {
  if (nullable && value == null) return null
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > 100_000_000_000)
    fail(`${label}必须是有效的整数分`)
  return value
}
const rate = (value, label) => {
  if (value == null) return null
  if (!Number.isInteger(value) || value < 0 || value > 10000) fail(`${label}应为0到10000的万分比`)
  return value
}
const choice = (value, allowed, label) => (allowed.includes(value) ? value : fail(`${label}无效`))
const requiredReason = (body) => text(body.reason, '原因', { required: true })
const shanghaiParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})
export function shanghaiDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) fail('日期无效')
  const parts = Object.fromEntries(shanghaiParts.formatToParts(d).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
const validDate = (value, label = '日期') => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    fail(`${label}无效`)
  return value
}
const validMonth = (value) =>
  typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
    ? value
    : fail('月份格式应为YYYY-MM')
const normalizedTime = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}不能为空`)
  let input = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    validDate(input, label)
    input += 'T00:00:00+08:00'
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(input))
    input = input.replace(' ', 'T') + '+08:00'
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) fail(`${label}无效`)
  return d.toISOString()
}
export function permissionsFor(user) {
  if (user.role === 'super_admin') return [...ALL_PERMISSIONS]
  const permissions = new Set(DEFAULT_PERMISSIONS[user.role] || [])
  for (const [key, enabled] of Object.entries(user.permissionOverrides || {})) {
    if (!ALL_PERMISSIONS.includes(key)) continue
    if (enabled) permissions.add(key)
    else permissions.delete(key)
  }
  if (['support', 'support_lead'].includes(user.role)) permissions.delete('reports.export')
  return [...permissions]
}
const can = (user, permission) => permissionsFor(user).includes(permission)
const requirePermission = (user, permission) => {
  if (!can(user, permission)) fail('没有执行此操作的权限', 403)
}
const requirePlayer = (user) => {
  if (user.role !== 'player') fail('此接口仅供打手账号使用', 403)
}
const find = (state, table, entityId, label = '记录') =>
  state[table].find((row) => row.id === entityId) || fail(`${label}不存在`, 404)
const paidRefunds = (state, orderId) =>
  state.refunds
    .filter((r) => r.orderId === orderId && r.status === 'paid')
    .reduce((total, r) => total + r.amount, 0)
const netOrder = (state, order) =>
  Math.max(0, Math.min(order.amount, order.receivedAmount) - paidRefunds(state, order.id))
const paidOrder = (order) => order.receivedAmount > 0 && Boolean(order.paidAt)
const commission = (amount, configuredRate) =>
  configuredRate == null ? null : Math.round((amount * configuredRate) / 10000)
const activeCount = (state, userId) =>
  state.orders.filter((o) => o.status === 'active' && o.leaderId === userId).length
const publicStaff = (state, user) => ({ ...user, activeOrders: activeCount(state, user.id) })
const hashPassword = (password) => {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128)
    fail('密码长度应为8至128位')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}
const verifyPassword = (password, stored) => {
  if (!stored || typeof password !== 'string' || password.length > 128) return false
  const [salt, hash] = stored.split(':')
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, salt, 64)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
const sessionHash = (token) => createHash('sha256').update(token).digest('hex')

function emptyState() {
  return {
    users: [],
    customers: [],
    platforms: [],
    shops: [],
    levels: [],
    templates: [],
    orders: [],
    refunds: [],
    withdrawals: [],
    expenses: [],
    attendance: [],
    salaryPlans: [],
    payrolls: [],
    logs: [],
    passwords: {},
    rewardCredits: [],
    commissionPaid: {},
    commissionAdjustments: [],
    rewardReviews: [],
    playerAdjustments: [],
    statusCorrectionReversals: {},
    appearance: defaultAppearance(),
    demo: false,
    schemaVersion: 2
  }
}

function seedState(now, password, demo) {
  const state = emptyState()
  state.demo = demo
  state.users.push({
    id: 'admin',
    username: 'admin',
    name: '工作室超级管理员',
    role: 'super_admin',
    createdAt: now,
    status: 'active',
    maxActiveOrders: 1,
    permissionOverrides: {}
  })
  state.passwords.admin = hashPassword(password)
  state.platforms = [
    { id: 'hall', name: '游戏大厅', operatorCommission: false },
    { id: 'xiaohongshu', name: '小红书', operatorCommission: true },
    { id: 'xianyu', name: '闲鱼', operatorCommission: true }
  ]
  state.shops = [{ id: 'jindun', platformId: 'xianyu', name: '金盾电竞' }]
  if (!demo) return state
  state.levels = [
    { id: 'priority', name: '优先等级（示例）', delaySeconds: 0 },
    { id: 'standard', name: '普通等级（示例）', delaySeconds: 30 }
  ]
  for (const [uid, name, role] of [
    ['support-demo', '示例客服', 'support'],
    ['operations-demo', '示例运营', 'operations'],
    ['finance-demo', '示例财务', 'finance'],
    ['hr-demo', '示例人事', 'hr'],
    ['player-demo-1', '示例打手 · 阿远', 'player'],
    ['player-demo-2', '示例打手 · 小北', 'player']
  ]) {
    state.users.push({
      id: uid,
      username: uid,
      name,
      role,
      createdAt: now,
      status: 'active',
      ...(role === 'player' ? { levelId: 'priority' } : {}),
      maxActiveOrders: 1,
      permissionOverrides: {}
    })
    if (role !== 'player')
      state.salaryPlans.push({
        id: `salary-${uid}`,
        userId: uid,
        mode: 'base_commission',
        base: null,
        rate: null,
        platformRates: {},
        effectiveFrom: shanghaiDate(now).slice(0, 7) + '-01',
        hourlyEnabled: false
      })
  }
  state.customers = [
    {
      id: 'customer-demo',
      name: '示例客户',
      contact: '演示数据 · 请替换为真实客户',
      gameId: 'DELTA-DEMO',
      createdAt: now,
      remark: '仅用于熟悉页面，非真实业务'
    }
  ]
  state.templates = [
    {
      id: 'template-70',
      name: '70 788w',
      game: '三角洲行动',
      description: '目标 788w · 示例模板',
      amount: 8800,
      reward: 7000,
      map: '不限',
      remark: '结单提醒客户确认收货',
      active: true
    },
    {
      id: 'template-50',
      name: '50 588w',
      game: '三角洲行动',
      description: '客户价格待配置',
      amount: null,
      reward: 5000,
      map: '不限',
      remark: '',
      active: true
    },
    {
      id: 'template-entertainment',
      name: '娱乐单',
      game: '三角洲行动',
      description: '客户价格和打手报酬待配置',
      amount: null,
      reward: null,
      map: '不限',
      remark: '',
      active: true
    }
  ]
  const template = state.templates[0]
  state.orders = [
    {
      id: 'order-demo',
      orderNo: 'DEMO-001',
      templateId: template.id,
      title: template.name,
      customerId: 'customer-demo',
      platformId: 'xianyu',
      shopId: 'jindun',
      externalOrderNo: 'DEMO-20261012001',
      channel: '闲鱼',
      roomCode: '示例房间码',
      gameId: 'DELTA-DEMO',
      map: '不限',
      amount: 8800,
      reward: 7000,
      receivedAmount: 8800,
      paidAt: now,
      receivedAt: now,
      receipt: null,
      status: 'pending',
      dispatchMode: 'pool',
      assignedTo: null,
      leaderId: null,
      teammateId: null,
      creatorId: 'support-demo',
      createdAt: now,
      publishedAt: now,
      completedAt: null,
      remark: '示例订单 · 仅用于体验流程，正式使用前请清理演示数据',
      snapshot: clone(template),
      assignments: [],
      submissions: []
    }
  ]
  return state
}

export function createStudioService({
  dbPath = resolve('.data/studio.sqlite'),
  password = process.env.STUDIO_ADMIN_PASSWORD,
  seed = true,
  clock = () => new Date(),
  auditRetentionDays = Number(process.env.STUDIO_AUDIT_RETENTION_DAYS || 90),
  auditHotMaxRows = Number(process.env.STUDIO_AUDIT_HOT_MAX_ROWS || 10000),
  auditArchiveMaxBytes = Number(process.env.STUDIO_AUDIT_ARCHIVE_MAX_BYTES || 500 * 1024 * 1024)
} = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS studio_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);'
  )
  const now = () => new Date(clock()).toISOString()
  const auditStore = createAuditStore(db, {
    retentionDays: auditRetentionDays,
    hotMaxRows: auditHotMaxRows,
    archiveMaxBytes: auditArchiveMaxBytes,
    clock
  })
  db.exec(
    'CREATE TABLE IF NOT EXISTS audit_archive_backups(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,before_date TEXT NOT NULL,scope_json TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS audit_backup_expiry ON audit_archive_backups(expires_at)'
  )
  const canBackupAudit = (user) =>
    COMPLETE_AUDIT_PERMISSIONS.every((permission) => can(user, permission))
  const requireBackupAudit = (user) => {
    if (!canBackupAudit(user))
      fail('完整日志备份与清理需要全部业务审计查看及配置权限，当前账号不能执行', 403)
  }
  const checkBackupReceipt = (user, token, beforeDate, { ready = true } = {}) => {
    requireBackupAudit(user)
    if (typeof token !== 'string' || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token))
      fail('请先完成对应截止日期的完整归档备份', 409)
    const receipt = db
      .prepare('SELECT * FROM audit_archive_backups WHERE token_hash=? AND user_id=?')
      .get(sessionHash(token), user.id)
    if (
      !receipt ||
      receipt.expires_at <= Date.parse(now()) ||
      receipt.before_date !== beforeDate ||
      (ready && !receipt.ready)
    )
      fail('备份凭据无效、未完成或已过期，请重新下载完整归档备份', 409)
    if (receipt.scope_json !== JSON.stringify(auditStore.backupScope(beforeDate)))
      fail('归档记录在备份后已变化，请重新下载完整备份再清理', 409)
    return receipt
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS customer_order_references(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,platform_id TEXT NOT NULL,shop_id TEXT NOT NULL,external_order_no TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS customer_refs_unique ON customer_order_references(customer_id,platform_id,shop_id,external_order_no); CREATE INDEX IF NOT EXISTS customer_refs_customer ON customer_order_references(customer_id,id)'
  )
  // 与导出字段的 JavaScript 搜索保持同一 Unicode 大小写规则，避免 SQLite lower 仅处理 ASCII。
  db.function('customer_ref_contains', { deterministic: true }, (value, keyword) =>
    String(value ?? '')
      .toLowerCase()
      .includes(String(keyword))
      ? 1
      : 0
  )
  if (!db.prepare('SELECT 1 FROM studio_state WHERE id=1').get()) {
    let initialPassword = password
    if (!initialPassword) {
      initialPassword = randomBytes(18).toString('base64url')
      if (dbPath === ':memory:') fail('内存数据库必须明确提供初始密码')
      const passwordPath = resolve(dirname(dbPath), 'bootstrap-password.txt')
      writeFileSync(
        passwordPath,
        `首次登录账号：admin\n初始密码：${initialPassword}\n请首次登录后在用户管理重置密码；本文件仅保存在本机，请勿上传。\n`,
        { mode: 0o600 }
      )
      try {
        chmodSync(passwordPath, 0o600)
      } catch {
        // Windows may not support POSIX modes; the file remains in the local data directory.
      }
    }
    db.prepare('INSERT INTO studio_state(id,json) VALUES(1,?)').run(
      JSON.stringify(seedState(now(), initialPassword, seed))
    )
  }
  const read = () => {
    const state = JSON.parse(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
    state.playerAdjustments ||= []
    state.statusCorrectionReversals ||= {}
    if (state.logs?.length) {
      const ownsTransaction = !db.isTransaction
      if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
      try {
        auditStore.importLegacy(state.logs)
        state.logs = []
        db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
        if (ownsTransaction) db.exec('COMMIT')
      } catch (error) {
        if (ownsTransaction) db.exec('ROLLBACK')
        throw error
      }
    }
    state.logs = []
    return state
  }
  const save = (state) =>
    db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  // 旧版首次创建的 admin 本来就拥有全部权限，迁移成独立的超管角色。
  const existingState = read()
  if ((existingState.schemaVersion || 1) < 2) {
    const initialAdmin = existingState.users.find((u) => u.id === 'admin' && u.role === 'admin')
    if (initialAdmin) initialAdmin.role = 'super_admin'
    existingState.schemaVersion = 2
    save(existingState)
  }
  const audit = (state, user, action, entity, entityId, before, after) => {
    auditStore.append({
      id: id(),
      actorId: user.id,
      actorName: user.name,
      action,
      entity,
      entityId,
      before: before == null ? null : clone(before),
      after: after == null ? null : clone(after),
      createdAt: now()
    })
  }
  const transact = (userId, callback) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const state = read()
      const user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      const result = callback(state, user)
      save(state)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const metadata = (record) => ({
    id: record.id,
    name: record.name,
    mime: record.mime,
    size: record.size,
    url: `/api/studio/uploads/${record.id}`
  })
  const publicReference = (row) => ({
    id: row.id,
    customerId: row.customer_id,
    platformId: row.platform_id,
    shopId: row.shop_id || null,
    externalOrderNo: row.external_order_no
  })
  const publicCustomer = (customer) => ({
    ...customer,
    platformId: customer.platformId || null,
    orderReferences: db
      .prepare(
        'SELECT * FROM customer_order_references WHERE customer_id=? ORDER BY rowid DESC LIMIT 20'
      )
      .all(customer.id)
      .map(publicReference),
    orderReferenceCount: Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM customer_order_references WHERE customer_id=?')
        .get(customer.id).n
    )
  })
  const requireCustomerAccess = (user, editing = false) => {
    if (
      (user.role === 'player' && !can(user, 'orders.view')) ||
      (!can(user, 'orders.create') &&
        !can(user, 'users.manage') &&
        (editing || !can(user, 'orders.view')))
    )
      fail('没有查看或维护客户资料的权限', 403)
  }
  function createPlayerAdjustment(state, user, body, source = 'manual') {
    const target = find(state, 'users', body.userId, '打手')
    if (target.role !== 'player') fail('扣补款对象必须是打手')
    const kind = choice(body.kind, ['deduction', 'supplement'], '扣补类型')
    const amount = cents(body.amount, '扣补款金额', { positive: true })
    const appliedAmount =
      kind === 'supplement' ? amount : Math.min(amount, wallet(state, target.id).available)
    const row = {
      id: id(),
      userId: target.id,
      orderId: body.orderId ? find(state, 'orders', body.orderId, '订单').id : null,
      kind,
      amount,
      appliedAmount,
      manualAmount: amount - appliedAmount,
      status: amount > appliedAmount ? 'manual' : 'applied',
      reason: requiredReason(body),
      createdAt: now(),
      createdBy: user.id,
      source
    }
    state.playerAdjustments.push(row)
    audit(
      state,
      user,
      kind === 'deduction' ? '登记打手扣款' : '登记打手补款',
      'player-adjustment',
      row.id,
      null,
      row
    )
    return row
  }
  const linkedAttachment = (state, user, attachmentId) => {
    const has = (item) => item?.id === attachmentId
    if (
      state.orders.some(
        (order) =>
          visibleOrder(state, user, order) &&
          ((can(user, 'orders.view') && has(order.receipt)) ||
            order.submissions.some((s) => s.screenshots.some(has)))
      )
    )
      return true
    if (can(user, 'finance.expenses') || can(user, 'profit.view'))
      if (state.expenses.some((e) => has(e.receipt))) return true
    if (
      state.withdrawals.some(
        (w) => (can(user, 'finance.withdrawals') || w.userId === user.id) && has(w.receipt)
      )
    )
      return true
    return false
  }
  const attachment = (state, user, value, required = false) => {
    if (!value) {
      if (required) fail('请先上传凭证')
      return null
    }
    const attachmentId = typeof value === 'string' ? value : value.id
    const record = db
      .prepare('SELECT id,owner_id,name,mime,size FROM uploads WHERE id=?')
      .get(attachmentId)
    if (!record) fail('附件不存在，请重新上传')
    if (record.owner_id !== user.id && !linkedAttachment(state, user, attachmentId))
      fail('无权使用此附件', 403)
    return metadata(record)
  }
  function visibleOrder(state, user, order) {
    if (can(user, 'orders.view')) return true
    if (user.role !== 'player') return false
    if (order.leaderId === user.id || order.teammateId === user.id) return true
    if (order.status !== 'pending') return false
    if (order.dispatchMode === 'direct') return order.assignedTo === user.id
    const level = state.levels.find((l) => l.id === user.levelId)
    return Boolean(
      level && Date.parse(now()) >= Date.parse(order.publishedAt) + level.delaySeconds * 1000
    )
  }
  function playerOrder(order) {
    const clean = clone(order)
    clean.amount = 0
    clean.receivedAmount = 0
    clean.paidAt = null
    clean.receivedAt = null
    clean.receipt = null
    clean.externalOrderNo = ''
    clean.customerId = ''
    clean.snapshot.amount = null
    delete clean.commissionSnapshot
    return clean
  }
  function safeOrder(state, user, order) {
    if (user.role === 'player' && !can(user, 'orders.view')) return playerOrder(order)
    const clean = clone(order)
    if (!can(user, 'salary.all') && !can(user, 'profit.view')) delete clean.commissionSnapshot
    return clean
  }
  // 审计记录保存当时的值；读取时与对应业务数据使用相同权限，不从现有记录覆盖历史。
  function safeAuditLog(state, user, log) {
    const pick = (value, keys) =>
      Object.fromEntries(
        keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])
      )
    const safeAttachment = (value) =>
      value && typeof value === 'object' ? pick(value, ['id', 'name', 'mime', 'size', 'url']) : null
    const canViewSalaryLog = can(user, 'salary.all') && can(user, 'profit.view')
    if (['salary-plan', 'payroll'].includes(log.entity) && !canViewSalaryLog) return null
    const visibleOrderId = (orderId) => {
      const order = state.orders.find((row) => row.id === orderId)
      return Boolean(order && visibleOrder(state, user, order))
    }
    const salaryLine = (value) =>
      pick(value, [
        'userId',
        'name',
        'role',
        'base',
        'commission',
        'deduction',
        'total',
        'incomplete'
      ])
    const project = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      switch (log.entity) {
        case 'user': {
          const managing = can(user, 'users.manage')
          const result = pick(value, ['id', 'name', 'role', 'status'])
          if (managing || log.entityId === user.id) Object.assign(result, pick(value, ['username']))
          if (managing) {
            Object.assign(result, pick(value, ['levelId', 'maxActiveOrders', 'activeOrders']))
            if (value.permissionOverrides && typeof value.permissionOverrides === 'object')
              result.permissionOverrides = Object.fromEntries(
                Object.entries(value.permissionOverrides).filter(
                  ([key, enabled]) => ALL_PERMISSIONS.includes(key) && typeof enabled === 'boolean'
                )
              )
          }
          return result
        }
        case 'order': {
          if (!visibleOrderId(log.entityId)) return null
          const clean = safeOrder(state, user, value)
          const result = pick(clean, [
            'id',
            'orderNo',
            'templateId',
            'title',
            'customerId',
            'platformId',
            'shopId',
            'externalOrderNo',
            'channel',
            'roomCode',
            'gameId',
            'map',
            'amount',
            'reward',
            'receivedAmount',
            'paidAt',
            'receivedAt',
            'status',
            'dispatchMode',
            'assignedTo',
            'leaderId',
            'teammateId',
            'creatorId',
            'createdAt',
            'publishedAt',
            'completedAt',
            'remark',
            'canceledAt',
            'cancelReason',
            'canceledFrom',
            'compensationPending',
            'compensationSettled'
          ])
          if (Object.hasOwn(clean, 'receipt')) result.receipt = safeAttachment(clean.receipt)
          if (clean.snapshot && typeof clean.snapshot === 'object')
            result.snapshot = pick(clean.snapshot, [
              'id',
              'name',
              'game',
              'description',
              'amount',
              'reward',
              'map',
              'remark',
              'active'
            ])
          if (Array.isArray(clean.assignments))
            result.assignments = clean.assignments.map((row) =>
              pick(row, ['leaderId', 'acceptedAt', 'releasedAt', 'reason', 'correctedBy'])
            )
          if (Array.isArray(clean.submissions))
            result.submissions = clean.submissions.map((row) => ({
              ...pick(row, [
                'id',
                'submittedAt',
                'leaderId',
                'teammateId',
                'review',
                'reason',
                'reviewedAt',
                'reviewerId',
                'recheckBy',
                'recheckedAt',
                'recheckReason',
                'previousSubmissionId'
              ]),
              screenshots: (row.screenshots || []).map(safeAttachment)
            }))
          if (clean.commissionSnapshot && typeof clean.commissionSnapshot === 'object')
            result.commissionSnapshot = pick(clean.commissionSnapshot, [
              'supportRate',
              'operationsRate',
              'operationsId'
            ])
          return result
        }
        case 'refund':
          return visibleOrderId(value.orderId) &&
            (can(user, 'orders.view') || can(user, 'finance.refunds'))
            ? pick(value, [
                'id',
                'orderId',
                'amount',
                'reason',
                'status',
                'requestedBy',
                'createdAt',
                'processedAt',
                'processedBy',
                'manualRewardReview',
                'manualResolution'
              ])
            : null
        case 'withdrawal': {
          if (!can(user, 'finance.withdrawals') && value.userId !== user.id) return null
          const result = pick(value, [
            'id',
            'userId',
            'amount',
            'status',
            'createdAt',
            'processedAt',
            'paidAt',
            'reason'
          ])
          if (Object.hasOwn(value, 'receipt')) result.receipt = safeAttachment(value.receipt)
          return result
        }
        case 'expense': {
          if (!can(user, 'finance.expenses') && !can(user, 'profit.view')) return null
          return {
            ...pick(value, [
              'id',
              'category',
              'amount',
              'date',
              'purpose',
              'createdBy',
              'deletedAt'
            ]),
            receipt: safeAttachment(value.receipt)
          }
        }
        case 'attendance':
          return can(user, 'attendance.manage') ||
            can(user, 'salary.all') ||
            value.userId === user.id
            ? pick(value, [
                'id',
                'userId',
                'date',
                'start',
                'end',
                'status',
                'actualHours',
                'hoursRegistered',
                'remark'
              ])
            : null
        case 'customer':
          return (user.role !== 'player' || can(user, 'orders.view')) &&
            (can(user, 'orders.view') || can(user, 'orders.create') || can(user, 'users.manage'))
            ? pick(value, ['id', 'name', 'platformId', 'contact', 'gameId', 'remark', 'createdAt'])
            : null
        case 'template':
          return can(user, 'orders.view') ||
            can(user, 'orders.create') ||
            can(user, 'templates.manage')
            ? pick(value, [
                'id',
                'name',
                'game',
                'description',
                'amount',
                'reward',
                'map',
                'remark',
                'active'
              ])
            : null
        case 'platform': {
          const result = pick(value, ['id', 'name', 'operatorCommission'])
          if (value.rules && typeof value.rules === 'object' && !Array.isArray(value.rules))
            result.rules = pick(value.rules, [
              'requiresShop',
              'requiresExternalOrderNo',
              'requiresReceipt',
              'allowPayOnArrival'
            ])
          return result
        }
        case 'shop':
          return pick(value, ['id', 'name', 'platformId'])
        case 'level':
          return pick(value, ['id', 'name', 'delaySeconds'])
        case 'salary-plan': {
          const result = pick(value, [
            'id',
            'userId',
            'mode',
            'base',
            'rate',
            'effectiveFrom',
            'hourlyEnabled'
          ])
          if (value.platformRates && typeof value.platformRates === 'object')
            result.platformRates = Object.fromEntries(
              Object.entries(value.platformRates).filter(
                ([key, rate]) =>
                  state.platforms.some((platform) => platform.id === key) &&
                  (rate === null || Number.isInteger(rate))
              )
            )
          return result
        }
        case 'payroll':
          return {
            ...pick(value, ['id', 'month', 'status', 'paidAt', 'paidBy']),
            lines: (value.lines || []).map(salaryLine)
          }
        case 'upload':
          return log.actorId === user.id || linkedAttachment(state, user, log.entityId)
            ? safeAttachment(value)
            : null
        case 'session':
          return can(user, 'users.manage') || log.entityId === user.id
            ? pick(value, ['userId'])
            : null
        case 'account-security':
          return can(user, 'users.manage') || log.entityId === user.id
            ? pick(value, ['sessionsRevoked'])
            : null
        case 'appearance':
          return can(user, 'settings.manage') ? projectAppearanceAudit(value) : null
        case 'player-adjustment':
          return can(user, 'finance.withdrawals') || value.userId === user.id
            ? pick(value, [
                'id',
                'userId',
                'orderId',
                'kind',
                'amount',
                'appliedAmount',
                'manualAmount',
                'status',
                'reason',
                'createdAt',
                'createdBy',
                'resolution',
                'resolvedAt',
                'resolvedBy',
                'resolutionReason',
                'source'
              ])
            : null
        case 'reward-review':
          return can(user, 'finance.withdrawals')
            ? pick(value, [
                'id',
                'orderId',
                'expectedReward',
                'reason',
                'createdAt',
                'actorId',
                'resolvedAt',
                'resolvedBy',
                'resolution'
              ])
            : null
        case 'customer-reference':
          return can(user, 'orders.view') || can(user, 'orders.create') || can(user, 'users.manage')
            ? pick(value, ['id', 'customerId', 'platformId', 'shopId', 'externalOrderNo'])
            : null
        case 'audit-maintenance':
          return can(user, 'settings.manage') && can(user, 'logs.view')
            ? pick(value, ['action', 'beforeDate', 'reason', 'affectedRows'])
            : null
        default:
          return null
      }
    }
    return {
      ...pick(log, ['id', 'actorId', 'actorName', 'action', 'entity', 'entityId', 'createdAt']),
      before: project(log.before),
      after: project(log.after)
    }
  }
  function salaryPlan(state, userId, date) {
    return state.salaryPlans
      .filter((plan) => plan.userId === userId && plan.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id.localeCompare(a.id))[0]
  }
  function snapshotCommission(state, order) {
    if (order.status !== 'completed' || !paidOrder(order)) return
    const date = shanghaiDate(order.completedAt)
    const creator = state.users.find((u) => u.id === order.creatorId)
    const platform = state.platforms.find((p) => p.id === order.platformId)
    const previous = order.commissionSnapshot
    const supportApplicable = ['support', 'support_lead'].includes(creator?.role)
    const supportPlan = supportApplicable ? salaryPlan(state, order.creatorId, date) : null
    const isHall = platform?.id === 'hall' || platform?.name === '游戏大厅'
    let operationsId = isHall ? null : (previous?.operationsId ?? null)
    const operationsApplicable =
      !isHall && (previous ? previous.operationsRate !== 0 || operationsId !== null : true)
    if (
      operationsApplicable &&
      operationsId == null &&
      (!previous || previous.operationsRate == null)
    ) {
      const operationsUsers = state.users.filter(
        (u) => u.role === 'operations' && u.status === 'active'
      )
      if (operationsUsers.length === 1) operationsId = operationsUsers[0].id
    }
    const operationsPlan = operationsId ? salaryPlan(state, operationsId, date) : null
    order.commissionSnapshot = {
      supportRate:
        previous?.supportRate ??
        (supportApplicable ? (supportPlan?.mode === 'fixed' ? 0 : (supportPlan?.rate ?? null)) : 0),
      operationsRate: isHall
        ? 0
        : (previous?.operationsRate ??
          (operationsApplicable
            ? operationsId
              ? operationsPlan?.mode === 'fixed'
                ? 0
                : (operationsPlan?.platformRates[order.platformId] ?? null)
              : null
            : 0)),
      operationsId
    }
  }
  const orderCommissions = (state, order) => {
    if (order.status !== 'completed' || !paidOrder(order))
      return { support: 0, operations: 0, incomplete: false }
    const snapshot = order.commissionSnapshot
    const support = commission(netOrder(state, order), snapshot?.supportRate ?? null)
    const operations = commission(netOrder(state, order), snapshot?.operationsRate ?? null)
    return { support, operations, incomplete: support == null || operations == null }
  }
  function wallet(state, userId) {
    const earned =
      state.rewardCredits
        .filter((row) => row.userId === userId)
        .reduce((total, row) => total + row.amount, 0) +
      state.playerAdjustments
        .filter((row) => row.userId === userId)
        .reduce(
          (total, row) =>
            total + (row.kind === 'supplement' ? row.appliedAmount : -row.appliedAmount),
          0
        )
    const occupied = state.withdrawals
      .filter((w) => w.userId === userId && ['pending', 'approved'].includes(w.status))
      .reduce((total, w) => total + w.amount, 0)
    const paid = state.withdrawals
      .filter((w) => w.userId === userId && w.status === 'paid')
      .reduce((total, w) => total + w.amount, 0)
    return { userId, earned, occupied, paid, available: Math.max(0, earned - occupied - paid) }
  }
  function settleReward(state, order, user) {
    restoreStatusReward(state, order, user)
    const allocations = new Map()
    if (order.leaderId && order.reward > 0) {
      if (order.teammateId) {
        if (order.reward % 2) fail('双人平分的整单报酬必须为偶数分；分币尾差规则尚未配置')
        allocations.set(order.leaderId, order.reward / 2)
        allocations.set(order.teammateId, order.reward / 2)
      } else allocations.set(order.leaderId, order.reward)
    }
    const existing = state.rewardCredits.filter((row) => row.orderId === order.id)
    let manual = false
    for (const row of existing) {
      const next = allocations.get(row.userId) ?? 0
      if (next < row.amount && wallet(state, row.userId).paid > 0) {
        manual = true
        continue
      }
      if (
        next < row.amount &&
        wallet(state, row.userId).earned - row.amount + next < wallet(state, row.userId).occupied
      )
        fail('报酬调整后不足覆盖在途提现，请先驳回相关提现申请', 409)
      row.amount = next
    }
    for (const [userId, amount] of allocations) {
      const row = existing.find((r) => r.userId === userId)
      if (row) {
        if (amount > row.amount) row.amount = amount
      } else
        state.rewardCredits.push({ id: id(), orderId: order.id, userId, amount, createdAt: now() })
    }
    if (manual) {
      state.rewardReviews.push({
        id: id(),
        orderId: order.id,
        expectedReward: order.reward,
        reason: '报酬调整涉及已发放提现，由财务人工处理；系统未自动扣减打手余额',
        createdAt: now(),
        actorId: user.id
      })
      for (const refund of state.refunds.filter(
        (r) => r.orderId === order.id && r.status === 'paid'
      )) {
        refund.manualRewardReview = true
        delete refund.manualResolution
      }
    }
    return manual
  }
  function restoreStatusReward(state, order, user) {
    const reversal = state.statusCorrectionReversals[order.id]
    if (!reversal?.active) return
    if (
      order.reward !== reversal.reward ||
      order.leaderId !== reversal.leaderId ||
      order.teammateId !== reversal.teammateId
    )
      fail(
        '该订单已有结算冲正，恢复时须沿用原负责人和原报酬；不同金额或人员请先由财务处理扣补款差额',
        409
      )
    for (const adjustmentId of reversal.adjustmentIds) {
      const row = state.playerAdjustments.find((item) => item.id === adjustmentId)
      if (!row) continue
      const recovered = row.resolution === 'recovered' ? row.manualAmount : 0
      const restore = row.appliedAmount + recovered
      if (restore > 0)
        createPlayerAdjustment(
          state,
          user,
          {
            userId: row.userId,
            kind: 'supplement',
            amount: restore,
            reason: '恢复原订单结算：' + order.orderNo,
            orderId: order.id
          },
          'status-correction'
        )
      if (row.status === 'manual') {
        const before = clone(row)
        Object.assign(row, {
          status: 'resolved',
          resolution: 'waived',
          resolvedAt: now(),
          resolvedBy: user.id,
          resolutionReason: '订单重新结算，取消此次状态冲正待追回金额'
        })
        audit(state, user, '订单恢复结算取消待追回', 'player-adjustment', row.id, before, row)
      }
    }
    reversal.active = false
  }
  function reverseStatusReward(state, order, user, reason) {
    if (state.statusCorrectionReversals[order.id]?.active) return
    const adjustmentIds = []
    for (const credit of state.rewardCredits.filter(
      (row) => row.orderId === order.id && row.amount > 0
    ))
      adjustmentIds.push(
        createPlayerAdjustment(
          state,
          user,
          {
            userId: credit.userId,
            kind: 'deduction',
            amount: credit.amount,
            reason,
            orderId: order.id
          },
          'status-correction'
        ).id
      )
    state.statusCorrectionReversals[order.id] = {
      active: true,
      adjustmentIds,
      completedAt: order.completedAt,
      reward: order.reward,
      leaderId: order.leaderId,
      teammateId: order.teammateId
    }
  }
  function recordCommissionAdjustment(state, order, sourceId, reason) {
    const record = state.commissionPaid[order.id]
    if (!record) return
    const expected = orderCommissions(state, order)
    for (const [kind, userId, amount] of [
      ['support', record.supportUserId, expected.support],
      ['operations', record.operationsUserId, expected.operations]
    ]) {
      if (!userId || amount == null) continue
      const originalPaid = record[`${kind}Amount`] || 0
      const prior = state.commissionAdjustments
        .filter((a) => a.orderId === order.id && a.kind === kind)
        .reduce((sum, a) => sum + a.amount, 0)
      const delta = originalPaid - amount - prior
      if (delta)
        state.commissionAdjustments.push({
          id: id(),
          orderId: order.id,
          sourceId,
          kind,
          userId,
          amount: delta,
          month: shanghaiDate(now()).slice(0, 7),
          createdAt: now(),
          reason,
          payrollId: null
        })
    }
  }
  function payrollLines(state, month, supplementary = false) {
    const date = `${month}-31`
    const employees = state.users.filter(
      (u) =>
        u.role !== 'player' &&
        (!['super_admin', 'admin', 'owner'].includes(u.role) ||
          state.salaryPlans.some((p) => p.userId === u.id))
    )
    return employees
      .map((user) => {
        const plan = salaryPlan(state, user.id, date)
        let base = supplementary ? 0 : !plan ? null : plan.mode === 'commission' ? 0 : plan.base
        let totalCommission = 0
        let incomplete = !supplementary && (!plan || base == null)
        {
          if (
            !supplementary &&
            plan?.mode !== 'fixed' &&
            ['support', 'support_lead'].includes(user.role) &&
            plan?.rate == null
          )
            incomplete = true
          if (
            !supplementary &&
            plan?.mode !== 'fixed' &&
            user.role === 'operations' &&
            state.platforms.some(
              (p) => p.id !== 'hall' && p.name !== '游戏大厅' && plan?.platformRates[p.id] == null
            )
          )
            incomplete = true
          for (const order of state.orders.filter(
            (o) =>
              o.status === 'completed' &&
              paidOrder(o) &&
              shanghaiDate(o.completedAt).startsWith(month) &&
              (!supplementary || !state.commissionPaid[o.id])
          )) {
            const amounts = orderCommissions(state, order)
            if (order.creatorId === user.id && order.commissionSnapshot?.supportRate !== 0) {
              if (amounts.support == null) incomplete = true
              else totalCommission += amounts.support
            }
            if (order.commissionSnapshot?.operationsId === user.id) {
              if (amounts.operations == null) incomplete = true
              else totalCommission += amounts.operations
            }
          }
        }
        const deduction = state.commissionAdjustments
          .filter((a) => a.userId === user.id && a.month === month && !a.payrollId)
          .reduce((sum, a) => sum + a.amount, 0)
        return {
          userId: user.id,
          name: user.name,
          role: user.role,
          base,
          commission: incomplete ? null : totalCommission,
          deduction,
          total: incomplete ? null : base + totalCommission - deduction,
          incomplete
        }
      })
      .filter(
        (line) => !supplementary || line.deduction !== 0 || line.commission !== 0 || line.incomplete
      )
  }
  function reports(state, month) {
    const year = Number(month.slice(0, 4)),
      monthIndex = Number(month.slice(5))
    const dayCount = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate()
    const days = Array.from({ length: dayCount }, (_, i) => ({
      date: `${month}-${String(i + 1).padStart(2, '0')}`,
      received: 0,
      refunds: 0,
      net: 0,
      reward: 0,
      supportCommission: 0,
      operationsCommission: 0,
      expenses: 0,
      profit: 0,
      incomplete: false,
      estimatedReward: 0
    }))
    for (const order of state.orders.filter(
      (o) => paidOrder(o) && shanghaiDate(o.paidAt).startsWith(month)
    )) {
      const day = days[Number(shanghaiDate(order.paidAt).slice(8)) - 1]
      day.received += order.receivedAmount
      day.refunds += paidRefunds(state, order.id)
      day.reward += order.reward
      if (order.status !== 'completed' && !order.compensationSettled)
        day.estimatedReward += order.reward
      const amounts = orderCommissions(state, order)
      day.supportCommission += amounts.support || 0
      day.operationsCommission += amounts.operations || 0
      day.incomplete ||= amounts.incomplete || Boolean(order.compensationPending)
    }
    for (const expense of state.expenses.filter((e) => !e.deletedAt && e.date.startsWith(month)))
      days[Number(expense.date.slice(8)) - 1].expenses += expense.amount
    for (const adjustment of state.playerAdjustments.filter(
      (row) => row.source !== 'status-correction'
    )) {
      const order = adjustment.orderId
        ? state.orders.find((row) => row.id === adjustment.orderId)
        : null
      const date = order?.paidAt ? shanghaiDate(order.paidAt) : shanghaiDate(adjustment.createdAt)
      if (!date.startsWith(month)) continue
      const recovered = adjustment.resolution === 'recovered' ? adjustment.manualAmount : 0
      days[Number(date.slice(8)) - 1].expenses +=
        adjustment.kind === 'supplement'
          ? adjustment.appliedAmount
          : -adjustment.appliedAmount - recovered
    }
    for (const adjustment of state.playerAdjustments.filter(
      (row) => row.source === 'status-correction' && row.status === 'manual'
    )) {
      const order = state.orders.find((row) => row.id === adjustment.orderId)
      if (order?.paidAt && shanghaiDate(order.paidAt).startsWith(month))
        days[Number(shanghaiDate(order.paidAt).slice(8)) - 1].incomplete = true
    }
    for (const day of days) {
      day.net = day.received - day.refunds
      day.profit = day.incomplete
        ? null
        : day.net - day.reward - day.supportCommission - day.operationsCommission - day.expenses
    }
    const monthlyOrders = state.orders.filter(
      (o) => paidOrder(o) && shanghaiDate(o.paidAt).startsWith(month)
    )
    const summarizeChannel = (platformId, shopId, name) => {
      const rows = monthlyOrders.filter(
        (o) => o.platformId === platformId && (shopId === undefined || o.shopId === shopId)
      )
      const received = rows.reduce((sum, o) => sum + o.receivedAmount, 0),
        refunds = rows.reduce((sum, o) => sum + paidRefunds(state, o.id), 0)
      return {
        platformId,
        ...(shopId === undefined ? {} : { shopId }),
        name,
        orders: rows.length,
        received,
        refunds,
        net: received - refunds
      }
    }
    const channels = [
      ...state.platforms.map((p) => summarizeChannel(p.id, undefined, p.name)),
      ...state.shops.map((s) => summarizeChannel(s.platformId, s.id, s.name))
    ]
    const performance = state.users
      .filter((u) => u.role !== 'player')
      .map((user) => {
        const rows = state.orders
          .filter(
            (o) =>
              o.status === 'completed' &&
              paidOrder(o) &&
              shanghaiDate(o.completedAt).startsWith(month)
          )
          .filter((o) =>
            user.role === 'operations'
              ? o.commissionSnapshot?.operationsId === user.id
              : o.creatorId === user.id
          )
        return {
          userId: user.id,
          name: user.name,
          orders: rows.length,
          completed: rows.filter((o) => o.status === 'completed').length,
          net: rows.reduce((sum, o) => sum + netOrder(state, o), 0)
        }
      })
    const previousPayrolls = state.payrolls.filter((p) => p.month === month)
    const pendingPayroll = payrollLines(state, month, previousPayrolls.length > 0)
    const payroll = previousPayrolls.length
      ? previousPayrolls.flatMap((p) => p.lines).concat(pendingPayroll)
      : pendingPayroll
    const bases = payrollLines(state, month)
    const monthlyBase = previousPayrolls.length
      ? previousPayrolls.flatMap((p) => p.lines).reduce((sum, l) => sum + (l.base || 0), 0)
      : bases.some((l) => l.base == null)
        ? null
        : bases.reduce((sum, l) => sum + l.base, 0)
    const monthlyProfit =
      monthlyBase == null || days.some((d) => d.profit == null)
        ? null
        : days.reduce((sum, d) => sum + d.profit, 0) - monthlyBase
    return { days, channels, performance, payroll, month, monthlyBase, monthlyProfit }
  }

  function bootstrap(userId, month, { exportMode = false } = {}) {
    const state = read(),
      user = find(state, 'users', userId, '账号')
    if (user.status !== 'active') fail('账号已停用', 403)
    month = validMonth(month || shanghaiDate(now()).slice(0, 7))
    const result = reports(state, month)
    const viewSalary = can(user, 'salary.view') || can(user, 'salary.all'),
      allSalary = can(user, 'salary.all'),
      viewProfit = can(user, 'profit.view')
    const salaryVisible = (row) => viewSalary && (allSalary || row.userId === user.id)
    const orderRows = state.orders.filter((o) => visibleOrder(state, user, o))
    const orderIds = new Set(orderRows.map((o) => o.id))
    if (!viewProfit) {
      result.days = []
      result.channels = []
      result.monthlyProfit = null
      result.monthlyBase = null
    }
    if (!allSalary && !viewProfit)
      result.performance = result.performance.filter((p) => p.userId === user.id)
    result.payroll = result.payroll.filter(salaryVisible)
    const visibleUsers = state.users
      .map((row) => publicStaff(state, row))
      .map((row) =>
        can(user, 'users.manage') || row.id === user.id
          ? row
          : {
              ...row,
              username: '',
              permissionOverrides: {},
              ...(can(user, 'attendance.manage') || allSalary ? {} : { createdAt: undefined })
            }
      )
    const rows = {
      user: publicStaff(state, user),
      permissions: permissionsFor(user),
      roleDefaults: DEFAULT_PERMISSIONS,
      appearance: state.appearance || defaultAppearance(),
      users: visibleUsers,
      customers:
        user.role === 'player' && !can(user, 'orders.view')
          ? []
          : can(user, 'orders.view') || can(user, 'orders.create') || can(user, 'users.manage')
            ? state.customers.map(publicCustomer)
            : [],
      platforms: state.platforms.map((platform) => ({
        ...platform,
        rules: platformRules(platform)
      })),
      shops: state.shops,
      levels: state.levels,
      templates:
        can(user, 'orders.view') || can(user, 'orders.create') || can(user, 'templates.manage')
          ? state.templates
          : [],
      orders: orderRows.map((order) => safeOrder(state, user, order)),
      refunds: state.refunds.filter(
        (r) => orderIds.has(r.orderId) && (can(user, 'orders.view') || can(user, 'finance.refunds'))
      ),
      withdrawals: state.withdrawals.filter(
        (w) => can(user, 'finance.withdrawals') || w.userId === user.id
      ),
      expenses: can(user, 'finance.expenses') || viewProfit ? state.expenses : [],
      attendance: state.attendance.filter(
        (row) => can(user, 'attendance.manage') || allSalary || row.userId === user.id
      ),
      salaryPlans: state.salaryPlans.filter(salaryVisible),
      payrolls: viewSalary
        ? state.payrolls
            .map((p) => ({ ...p, lines: p.lines.filter(salaryVisible) }))
            .filter((p) => p.lines.length)
        : [],
      logs: auditStore
        .rows({
          source: exportMode ? 'all' : 'hot',
          limit: exportMode ? 100001 : 1000,
          omitEntities: allSalary && viewProfit ? [] : ['salary-plan', 'payroll']
        })
        .filter(
          (log) => can(user, 'logs.view') || (log.entity === 'order' && orderIds.has(log.entityId))
        )
        .map((log) => safeAuditLog(state, user, log))
        .filter(Boolean),
      playerAdjustments: state.playerAdjustments.filter(
        (row) => can(user, 'finance.withdrawals') || row.userId === user.id
      ),
      rewardReviews: can(user, 'finance.withdrawals') ? state.rewardReviews : [],
      reports: result,
      wallets: state.users
        .filter(
          (u) => u.role === 'player' && (can(user, 'finance.withdrawals') || u.id === user.id)
        )
        .map((u) => wallet(state, u.id)),
      demo: state.demo
    }
    return clone(rows)
  }

  function paymentData(state, user, body, platform) {
    const receivedAmount = cents(body.receivedAmount, '实收金额', { positive: true })
    const paidAt = normalizedTime(body.paidAt, '客户付款时间')
    if (Date.parse(paidAt) > Date.parse(now()) + 60_000) fail('客户付款时间不能晚于当前时间')
    const receipt = attachment(state, user, body.receipt, platformRules(platform).requiresReceipt)
    return { receivedAmount, paidAt, receivedAt: now(), receipt }
  }
  function validateTarget(state, assignedTo) {
    const target = find(state, 'users', assignedTo, '打手')
    if (target.role !== 'player' || target.status !== 'active') fail('指定账号必须是启用中的打手')
    return target.id
  }
  function validateTeammate(state, leaderId, teammateId) {
    if (!teammateId) return null
    if (teammateId === leaderId) fail('队友不能与负责人相同')
    return validateTarget(state, teammateId)
  }
  function createOrder(state, user, body) {
    requirePermission(user, 'orders.create')
    const template = find(
      state,
      'templates',
      text(body.templateId, '订单模板', { required: true }),
      '订单模板'
    )
    if (!template.active) fail('该订单模板已停用')
    const customerId = find(
      state,
      'customers',
      text(body.customerId, '客户', { required: true }),
      '客户'
    ).id
    const platform = find(
      state,
      'platforms',
      text(body.platformId, '来源平台', { required: true }),
      '来源平台'
    )
    const rules = platformRules(platform)
    const shopId =
      body.shopId || rules.requiresShop
        ? find(
            state,
            'shops',
            text(body.shopId, '来源店铺', { required: rules.requiresShop }),
            '店铺'
          ).id
        : null
    if (shopId && find(state, 'shops', shopId).platformId !== platform.id)
      fail('店铺与来源平台不一致')
    const externalOrderNo = text(body.externalOrderNo, '平台订单号', {
      required: rules.requiresExternalOrderNo,
      max: 128
    })
    if (
      externalOrderNo &&
      state.orders.some(
        (o) => o.platformId === platform.id && o.externalOrderNo === externalOrderNo
      )
    )
      fail('该平台订单号已存在', 409)
    const roomCode = text(body.roomCode, '房间码', { max: 128 }),
      gameId = text(body.gameId, '客户游戏ID', { max: 128 })
    if (!roomCode && !gameId) fail('房间码与客户游戏ID至少填写一项')
    const amount = cents(body.amount ?? template.amount, '客户金额', { positive: true }),
      reward = cents(body.reward ?? template.reward, '整单打手报酬')
    const dispatchMode = choice(body.dispatchMode, ['pool', 'direct'], '派单方式')
    const assignedTo = dispatchMode === 'direct' ? validateTarget(state, body.assignedTo) : null
    if (body.payOnArrival && !rules.allowPayOnArrival)
      fail('当前平台不允许落地付，请先确认客户付款')
    let payment = { receivedAmount: 0, paidAt: null, receivedAt: null, receipt: null }
    if (!body.payOnArrival || Number(body.receivedAmount) > 0)
      payment = paymentData(state, user, body, platform)
    if (payment.receivedAmount && payment.receivedAmount !== amount)
      fail('普通订单派单前须确认全额收款；金额应与实收一致')
    const order = {
      id: id(),
      orderNo: `ES${shanghaiDate(now()).replaceAll('-', '')}${String(state.orders.length + 1).padStart(5, '0')}`,
      templateId: template.id,
      title: template.name,
      customerId,
      platformId: platform.id,
      shopId,
      externalOrderNo,
      channel: '',
      roomCode,
      gameId,
      map: text(body.map ?? template.map, '地图', { max: 128 }),
      amount,
      reward,
      ...payment,
      status: 'pending',
      dispatchMode,
      assignedTo,
      leaderId: null,
      teammateId: null,
      creatorId: user.id,
      createdAt: now(),
      publishedAt: now(),
      completedAt: null,
      remark: text(body.remark ?? template.remark, '打手可见备注'),
      snapshot: clone(template),
      assignments: [],
      submissions: []
    }
    state.orders.push(order)
    audit(state, user, '创建订单', 'order', order.id, null, order)
    return safeOrder(state, user, order)
  }
  function orderAction(state, user, orderId, body) {
    const order = find(state, 'orders', orderId, '订单'),
      before = clone(order)
    const action = body.action
    if (action === 'correct-status') {
      if (!['finance', 'manager', 'owner', 'super_admin'].includes(user.role))
        fail('仅财务、店长、老板或超级管理员可以更正订单状态', 403)
      requirePermission(user, 'orders.edit')
      const reason = requiredReason(body)
      const next = choice(
        body.status,
        ['pending', 'active', 'review', 'completed', 'canceled'],
        '目标状态'
      )
      if (next === order.status) fail('订单已经是该状态，无需重复更正', 409)
      const leaderId = body.leaderId || order.leaderId || order.assignments.at(-1)?.leaderId
      if (['active', 'review', 'completed'].includes(next) && !leaderId)
        fail('请先选择实际负责打手，不能无负责人更正为执行或完成状态')
      if (leaderId && ['active', 'review', 'completed'].includes(next))
        validateTarget(state, leaderId)
      const priorSettlement = state.statusCorrectionReversals[order.id]
      const resolvedTeammate = Object.hasOwn(body, 'teammateId')
        ? body.teammateId
        : (order.teammateId ?? priorSettlement?.teammateId)
      if (
        ['active', 'review', 'completed'].includes(next) &&
        state.rewardCredits.some((row) => row.orderId === order.id && row.amount > 0) &&
        (leaderId !== (priorSettlement?.leaderId || order.leaderId) ||
          (resolvedTeammate ?? null) !==
            (priorSettlement ? priorSettlement.teammateId : order.teammateId))
      )
        fail('已结算订单不能直接更换结算打手，请先由财务处理原打手与新打手的扣补款差额', 409)
      if (
        next === 'active' &&
        order.status !== 'active' &&
        activeCount(state, leaderId) >= find(state, 'users', leaderId).maxActiveOrders
      )
        fail('负责人已经达到同时接单上限', 409)
      if (next === 'completed' && (!paidOrder(order) || order.receivedAmount !== order.amount))
        fail('完成前必须确认客户足额收款')
      if (next === 'review' && !order.submissions.at(-1)?.screenshots?.length)
        fail('尚无完成材料，不能直接更正为待验收')
      if (order.status === 'completed' || order.compensationSettled)
        reverseStatusReward(state, order, user, reason)
      if (['active', 'review', 'completed'].includes(next)) {
        if (order.leaderId !== leaderId || !order.assignments.some((row) => !row.releasedAt)) {
          const old = order.assignments.findLast((row) => !row.releasedAt)
          if (old) Object.assign(old, { releasedAt: now(), reason })
          order.assignments.push({ leaderId, acceptedAt: now(), correctedBy: user.id })
        }
        order.leaderId = leaderId
        order.teammateId = validateTeammate(state, leaderId, resolvedTeammate)
        if (order.teammateId && order.reward % 2) fail('双人平分报酬必须为偶数分')
      }
      if (next === 'review' && order.submissions.at(-1)?.review) {
        const previous = order.submissions.at(-1)
        order.submissions.push({
          id: id(),
          submittedAt: previous.submittedAt,
          leaderId: order.leaderId,
          teammateId: order.teammateId,
          screenshots: clone(previous.screenshots),
          previousSubmissionId: previous.id,
          recheckBy: user.id,
          recheckedAt: now(),
          recheckReason: reason
        })
      }
      order.status = next
      if (next === 'pending') {
        const active = order.assignments.findLast((row) => !row.releasedAt)
        if (active) Object.assign(active, { releasedAt: now(), reason })
        order.leaderId = null
        order.teammateId = null
        order.assignedTo = null
        order.dispatchMode = 'pool'
        order.publishedAt = now()
      }
      if (next === 'completed') {
        order.completedAt ||= state.statusCorrectionReversals[order.id]?.completedAt || now()
        snapshotCommission(state, order)
        settleReward(state, order, user)
        order.compensationPending = false
        order.compensationSettled = false
      } else if (next === 'canceled') {
        order.canceledAt = now()
        order.cancelReason = reason
        order.canceledFrom = before.status
        order.compensationPending = order.assignments.length > 0
        order.compensationSettled = !order.compensationPending
        if (!order.compensationPending) order.reward = 0
      }
      recordCommissionAdjustment(state, order, order.id, reason)
    } else if (action === 'review-pass' || action === 'review-return') {
      requirePermission(user, 'finance.review')
      if (order.status !== 'review') fail('只有待验收订单可以审核', 409)
      const submission = order.submissions.at(-1)
      if (!submission || submission.review) fail('提交材料已审核，不能重复处理', 409)
      if (action === 'review-pass') {
        if (!paidOrder(order) || order.receivedAmount !== order.amount) fail('验收前请确认足额收款')
        if (!submission.screenshots.length) fail('完成截图不能为空')
        order.status = 'completed'
        order.completedAt ||= state.statusCorrectionReversals[order.id]?.completedAt || now()
        submission.review = 'passed'
        snapshotCommission(state, order)
        settleReward(state, order, user)
      } else {
        order.status = 'active'
        submission.review = 'returned'
        submission.reason = requiredReason(body)
      }
      submission.reviewedAt = now()
      submission.reviewerId = user.id
    } else if (action === 'adjust') {
      requirePermission(user, 'finance.review')
      const reason = requiredReason(body)
      if (!['completed', 'canceled'].includes(order.status))
        fail('金额更正仅用于已完成或已取消订单；执行中请先取消并重新下单', 409)
      const amount = cents(body.amount, '客户金额', { positive: true }),
        reward = cents(body.reward, '整单打手报酬')
      if (
        amount <
        state.refunds
          .filter((r) => r.orderId === order.id && r.status !== 'rejected')
          .reduce((sum, r) => sum + r.amount, 0)
      )
        fail('更正金额不能小于累计及在途退款')
      if (order.teammateId && reward % 2) fail('双人平分报酬必须为偶数分')
      order.amount = amount
      order.reward = reward
      if (paidOrder(order)) order.receivedAmount = amount
      if (order.status === 'completed' || order.compensationSettled)
        settleReward(state, order, user)
      recordCommissionAdjustment(state, order, order.id, reason)
    } else if (action === 'cancel-settle') {
      requirePermission(user, 'finance.review')
      requiredReason(body)
      if (order.status !== 'canceled' || !order.compensationPending || order.compensationSettled)
        fail('该订单不需要重复补偿结算', 409)
      order.reward = cents(body.reward, '最终整单报酬')
      if (order.reward > 0 && !order.leaderId)
        order.leaderId = order.assignments.at(-1)?.leaderId ?? null
      if (order.reward > 0 && !order.leaderId) fail('没有历史负责人，不能结算打手报酬')
      order.teammateId = validateTeammate(state, order.leaderId, body.teammateId)
      settleReward(state, order, user)
      order.compensationPending = false
      order.compensationSettled = true
    } else {
      if (action === 'cancel' && order.status === 'completed')
        requirePermission(user, 'finance.review')
      else requirePermission(user, 'orders.edit')
      if (action === 'remark') order.remark = text(body.remark, '打手可见备注')
      else if (action === 'edit') {
        if (['completed', 'canceled'].includes(order.status))
          fail('已完成或已取消订单请使用财务金额更正；备注可单独修改', 409)
        for (const [key, label] of [
          ['roomCode', '房间码'],
          ['gameId', '客户游戏ID'],
          ['map', '地图'],
          ['channel', '成交渠道'],
          ['remark', '打手可见备注']
        ])
          if (body[key] !== undefined)
            order[key] = text(body[key], label, { max: key === 'remark' ? 2000 : 128 })
        if (!order.roomCode && !order.gameId) fail('房间码与客户游戏ID至少填写一项')
        if (body.amount !== undefined || body.reward !== undefined) {
          requiredReason(body)
          if (body.amount !== undefined) {
            order.amount = cents(body.amount, '客户金额', { positive: true })
            if (
              order.amount <
              state.refunds
                .filter((r) => r.orderId === order.id && r.status !== 'rejected')
                .reduce((sum, r) => sum + r.amount, 0)
            )
              fail('更正金额不能小于累计及在途退款')
            if (paidOrder(order)) order.receivedAmount = order.amount
          }
          if (body.reward !== undefined) order.reward = cents(body.reward, '整单打手报酬')
          if (order.teammateId && order.reward % 2) fail('双人平分报酬必须为偶数分')
        }
      } else if (action === 'confirm-payment') {
        if (order.status === 'canceled') fail('已取消订单不能确认收款', 409)
        if (paidOrder(order)) fail('该订单已确认收款，不能重复入账', 409)
        const payment = paymentData(state, user, body, find(state, 'platforms', order.platformId))
        if (payment.receivedAmount !== order.amount) fail('实收金额须与订单金额一致')
        Object.assign(order, payment)
      } else if (action === 'dispatch') {
        if (order.status !== 'pending') fail('只有待接单订单可以派单', 409)
        order.dispatchMode = choice(body.dispatchMode, ['pool', 'direct'], '派单方式')
        order.assignedTo =
          order.dispatchMode === 'direct' ? validateTarget(state, body.assignedTo) : null
        order.publishedAt = now()
      } else if (action === 'release') {
        if (order.status !== 'active') fail('只有接单中订单可以解除接单', 409)
        const reason = requiredReason(body),
          assignment = order.assignments.findLast((a) => !a.releasedAt)
        if (assignment) {
          assignment.releasedAt = now()
          assignment.reason = reason
        }
        order.status = 'pending'
        order.leaderId = null
        order.teammateId = null
        order.assignedTo = null
        order.dispatchMode = 'pool'
        order.publishedAt = now()
      } else if (action === 'cancel') {
        const reason = requiredReason(body)
        if (order.status === 'canceled') fail('订单已经取消', 409)
        if (order.status === 'completed') requirePermission(user, 'finance.review')
        order.canceledFrom = order.status
        order.status = 'canceled'
        order.canceledAt = now()
        order.cancelReason = reason
        order.compensationPending = order.assignments.length > 0
        order.compensationSettled = !order.compensationPending
        if (!order.compensationPending) order.reward = 0
        recordCommissionAdjustment(state, order, order.id, reason)
      } else fail('未知订单操作')
    }
    audit(
      state,
      user,
      `订单：${action}${body.reason ? ` · ${text(body.reason, '原因')}` : ''}`,
      'order',
      order.id,
      before,
      order
    )
    return safeOrder(state, user, order)
  }

  function markRefund(state, user, refund) {
    const order = find(state, 'orders', refund.orderId)
    if (paidRefunds(state, order.id) + refund.amount > order.receivedAmount)
      fail('退款总额不能超过实收金额', 409)
    refund.status = 'paid'
    refund.processedAt = now()
    refund.processedBy = user.id
    const rewardUsers = state.rewardCredits
      .filter((c) => c.orderId === order.id)
      .map((c) => c.userId)
    refund.manualRewardReview = rewardUsers.some((uid) => wallet(state, uid).paid > 0)
    recordCommissionAdjustment(state, order, refund.id, refund.reason)
  }
  function refundCreate(state, user, body) {
    if (!can(user, 'finance.refunds')) requirePermission(user, 'orders.edit')
    const order = find(state, 'orders', body.orderId, '订单'),
      platform = find(state, 'platforms', order.platformId)
    if (platform.id === 'hall' || platform.name === '游戏大厅') fail('游戏大厅订单不提供退款流程')
    if (!paidOrder(order)) fail('未收款订单不能退款')
    const amount = cents(body.amount, '退款金额', { positive: true }),
      reason = requiredReason(body)
    const reserved = state.refunds
      .filter((r) => r.orderId === order.id && r.status !== 'rejected')
      .reduce((sum, r) => sum + r.amount, 0)
    if (reserved + amount > order.receivedAmount) fail('累计退款和在途申请不能超过实收金额', 409)
    const refund = {
      id: id(),
      orderId: order.id,
      amount,
      reason,
      status: 'pending',
      requestedBy: user.id,
      createdAt: now()
    }
    state.refunds.push(refund)
    if (can(user, 'finance.refunds')) markRefund(state, user, refund)
    audit(
      state,
      user,
      refund.status === 'paid' ? '财务直接退款' : '申请退款',
      'refund',
      refund.id,
      null,
      refund
    )
    return clone(refund)
  }
  function refundAction(state, user, refundId, body) {
    requirePermission(user, 'finance.refunds')
    const refund = find(state, 'refunds', refundId, '退款记录'),
      before = clone(refund)
    if (body.action === 'resolve') {
      if (refund.status !== 'paid' || !refund.manualRewardReview || refund.manualResolution)
        fail('没有待处理的已提现退款差额', 409)
      refund.manualResolution = requiredReason(body)
      state.rewardReviews
        .filter((r) => r.orderId === refund.orderId && !r.resolvedAt)
        .forEach((r) => {
          r.resolvedAt = now()
          r.resolvedBy = user.id
          r.resolution = refund.manualResolution
        })
    } else {
      if (refund.status !== 'pending') fail('退款已处理，不能重复审核', 409)
      if (body.action === 'approve') markRefund(state, user, refund)
      else if (body.action === 'reject') {
        refund.reason += `；驳回：${requiredReason(body)}`
        refund.status = 'rejected'
        refund.processedAt = now()
        refund.processedBy = user.id
      } else fail('未知退款操作')
    }
    audit(state, user, `退款：${body.action}`, 'refund', refund.id, before, refund)
    return clone(refund)
  }

  function mutate(userId, path, body = {}) {
    if (body == null || typeof body !== 'object' || Array.isArray(body))
      fail('请求内容必须为JSON对象')
    return transact(userId, (state, user) => {
      if (path === '/logs/maintenance') {
        requirePermission(user, 'settings.manage')
        requirePermission(user, 'logs.view')
        let affectedRows
        if (body.action === 'archive') affectedRows = auditStore.archive()
        else if (body.action === 'purge-archive') {
          requireBackupAudit(user)
          if (body.backupConfirmed !== true) fail('请先导出并确认已经保存日志备份')
          requiredReason(body)
          checkBackupReceipt(user, body.backupToken, validDate(body.beforeDate, '归档清理截止日期'))
          affectedRows = auditStore.purge(validDate(body.beforeDate, '归档清理截止日期'))
          db.prepare('DELETE FROM audit_archive_backups WHERE token_hash=?').run(
            sessionHash(body.backupToken)
          )
        } else fail('日志维护操作无效')
        audit(
          state,
          user,
          body.action === 'archive' ? '主动归档日志' : '清理已备份归档日志',
          'audit-maintenance',
          id(),
          null,
          {
            action: body.action,
            beforeDate: body.beforeDate || null,
            reason: body.reason || '按热日志保留规则归档',
            affectedRows
          }
        )
        return { affectedRows, storage: auditStore.storage() }
      }
      const rewardReviewMatch = path.match(/^\/reward-reviews\/([^/]+)\/action$/)
      if (rewardReviewMatch) {
        requirePermission(user, 'finance.withdrawals')
        const row = find(state, 'rewardReviews', rewardReviewMatch[1], '历史人工差额'),
          before = clone(row)
        if (body.action !== 'resolve' || row.resolvedAt) fail('该人工差额已处理或操作无效', 409)
        Object.assign(row, {
          resolvedAt: now(),
          resolvedBy: user.id,
          resolution: requiredReason(body)
        })
        audit(state, user, '登记历史报酬差额人工处理', 'reward-review', row.id, before, row)
        return clone(row)
      }
      if (path === '/player-adjustments') {
        requirePermission(user, 'finance.withdrawals')
        return clone(createPlayerAdjustment(state, user, body))
      }
      const adjustmentMatch = path.match(/^\/player-adjustments\/([^/]+)\/action$/)
      if (adjustmentMatch) {
        requirePermission(user, 'finance.withdrawals')
        const row = find(state, 'playerAdjustments', adjustmentMatch[1], '扣补款记录'),
          before = clone(row)
        if (body.action !== 'resolve' || row.status !== 'manual')
          fail('该记录没有待追回差额或已处理', 409)
        Object.assign(row, {
          resolution: choice(body.resolution, ['recovered', 'waived'], '处理结果'),
          resolutionReason: requiredReason(body),
          status: 'resolved',
          resolvedAt: now(),
          resolvedBy: user.id
        })
        audit(state, user, '登记扣款人工处理结果', 'player-adjustment', row.id, before, row)
        return clone(row)
      }
      if (path === '/customer-order-references') {
        requireCustomerAccess(user, true)
        const customer = find(state, 'customers', body.customerId, '客户')
        if (body.action === 'remove') {
          const row = db
            .prepare('SELECT * FROM customer_order_references WHERE id=? AND customer_id=?')
            .get(body.id, customer.id)
          if (!row) fail('客户平台订单号记录不存在', 404)
          db.prepare('DELETE FROM customer_order_references WHERE id=?').run(row.id)
          audit(
            state,
            user,
            '移除客户平台订单号',
            'customer-reference',
            row.id,
            publicReference(row),
            null
          )
          return { ok: true }
        }
        const platform = find(state, 'platforms', body.platformId, '来源平台'),
          rules = platformRules(platform)
        if (!rules.requiresExternalOrderNo) fail('该来源不要求平台订单号，无需添加关联编号')
        const shopId =
          body.shopId || rules.requiresShop
            ? find(state, 'shops', body.shopId, '来源店铺').id
            : null
        if (shopId && find(state, 'shops', shopId).platformId !== platform.id)
          fail('店铺与来源平台不一致')
        const externalOrderNo = text(body.externalOrderNo, '平台订单号', {
          required: true,
          max: 128
        })
        if (
          db
            .prepare(
              'SELECT id FROM customer_order_references WHERE customer_id=? AND platform_id=? AND shop_id=? AND external_order_no=?'
            )
            .get(customer.id, platform.id, shopId || '', externalOrderNo)
        )
          fail('该客户已有相同来源、店铺和平台订单号', 409)
        const row = {
          id: id(),
          customerId: customer.id,
          platformId: platform.id,
          shopId,
          externalOrderNo
        }
        db.prepare('INSERT INTO customer_order_references VALUES(?,?,?,?,?)').run(
          row.id,
          customer.id,
          platform.id,
          shopId || '',
          externalOrderNo
        )
        audit(state, user, '新增客户平台订单号', 'customer-reference', row.id, null, row)
        return row
      }
      if (path === '/appearance' || path === '/appearance/reset') {
        requirePermission(user, 'settings.manage')
        const before = state.appearance || defaultAppearance()
        validateAppearanceRevision(body.revision, before.revision)
        const resolveImage = (value) => {
          const record = db
            .prepare('SELECT id,owner_id,name,mime,size,data FROM uploads WHERE id=?')
            .get(value.id)
          if (!record) fail('图片附件不存在，请重新上传')
          if (
            record.owner_id !== user.id &&
            !appearanceAttachments(before).some((image) => image.id === record.id)
          )
            fail('外观图片必须由当前账号上传，不能借用其他人的业务凭证', 403)
          const image = metadata(record)
          if (
            (value.url != null && value.url !== image.url) ||
            (value.mime != null && value.mime !== image.mime) ||
            (value.size != null && value.size !== image.size) ||
            (value.name != null && value.name !== image.name)
          )
            fail('图片附件信息无效，请使用原上传记录')
          const data = Buffer.from(record.data)
          const signature =
            record.mime === 'image/png'
              ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
              : record.mime === 'image/jpeg'
                ? data.length > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255
                : record.mime === 'image/webp' &&
                  data.length >= 12 &&
                  data.toString('ascii', 0, 4) === 'RIFF' &&
                  data.toString('ascii', 8, 12) === 'WEBP'
          if (
            !signature ||
            record.size <= 0 ||
            record.size > 8 * 1024 * 1024 ||
            record.size !== data.length
          )
            fail('外观图片仅支持不超过 8MB 的真实 PNG、JPG 或 WebP 图片')
          return image
        }
        const config =
          path === '/appearance/reset'
            ? defaultAppearance()
            : normalizeAppearance(body.config, resolveImage)
        const result = {
          ...config,
          revision: before.revision + 1,
          updatedAt: now(),
          updatedBy: user.id
        }
        state.appearance = result
        audit(
          state,
          user,
          path === '/appearance/reset' ? '恢复默认界面外观' : '更新界面外观',
          'appearance',
          'appearance',
          before,
          result
        )
        return clone(result)
      }
      if (path === '/profile') {
        const before = clone(user)
        user.name = text(body.name, '姓名', { required: true, max: 100 })
        audit(state, user, '更新个人资料', 'user', user.id, before, user)
        return publicStaff(state, user)
      }
      if (path === '/profile/password') {
        if (!verifyPassword(body.currentPassword, state.passwords[user.id]))
          fail('当前密码不正确', 400)
        if (body.newPassword === body.currentPassword) fail('新密码不能与当前密码相同')
        state.passwords[user.id] = hashPassword(body.newPassword)
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
        audit(state, user, '修改本人密码', 'account-security', user.id, null, {
          sessionsRevoked: true
        })
        return { ok: true }
      }
      if (path === '/orders') return createOrder(state, user, body)
      const orderMatch = path.match(/^\/orders\/([^/]+)\/action$/)
      if (orderMatch) return orderAction(state, user, orderMatch[1], body)
      if (path === '/refunds') return refundCreate(state, user, body)
      const refundMatch = path.match(/^\/refunds\/([^/]+)\/action$/)
      if (refundMatch) return refundAction(state, user, refundMatch[1], body)
      const withdrawalMatch = path.match(/^\/withdrawals\/([^/]+)\/action$/)
      if (withdrawalMatch) {
        requirePermission(user, 'finance.withdrawals')
        const row = find(state, 'withdrawals', withdrawalMatch[1], '提现记录'),
          before = clone(row)
        if (body.action === 'approve') {
          if (row.status !== 'pending') fail('只有待审核提现可以通过', 409)
          row.status = 'approved'
          row.processedAt = now()
        } else if (body.action === 'reject') {
          if (!['pending', 'approved'].includes(row.status)) fail('提现已结束，不能驳回', 409)
          row.reason = requiredReason(body)
          row.status = 'rejected'
          row.processedAt = now()
        } else if (body.action === 'pay') {
          if (row.status !== 'approved') fail('只有待发放提现可以登记付款，不能重复发放', 409)
          row.receipt = attachment(state, user, body.receipt, true)
          row.status = 'paid'
          row.paidAt = now()
          row.processedAt = now()
        } else fail('未知提现操作')
        audit(state, user, `提现：${body.action}`, 'withdrawal', row.id, before, row)
        return clone(row)
      }
      if (path === '/expenses') {
        requirePermission(user, 'finance.expenses')
        const row = {
          id: id(),
          category: text(body.category, '费用类别', { required: true, max: 100 }),
          amount: cents(body.amount, '费用金额', { positive: true }),
          date: validDate(body.date),
          purpose: text(body.purpose, '用途', { required: true }),
          receipt: attachment(state, user, body.receipt, true),
          createdBy: user.id,
          deletedAt: null
        }
        state.expenses.push(row)
        audit(state, user, '录入费用', 'expense', row.id, null, row)
        return clone(row)
      }
      const expenseMatch = path.match(/^\/expenses\/([^/]+)\/action$/)
      if (expenseMatch) {
        requirePermission(user, 'finance.expenses')
        const row = find(state, 'expenses', expenseMatch[1], '费用记录'),
          before = clone(row)
        if (body.action === 'delete') {
          if (row.deletedAt) fail('费用已删除', 409)
          row.deletedAt = now()
        } else if (body.action === 'restore') {
          if (!row.deletedAt) fail('费用未删除', 409)
          row.deletedAt = null
        } else fail('未知费用操作')
        audit(state, user, `费用：${body.action}`, 'expense', row.id, before, row)
        return clone(row)
      }
      if (path === '/users') {
        requirePermission(user, 'users.manage')
        const existing = body.id ? find(state, 'users', body.id, '账号') : null,
          before = existing ? clone(existing) : null
        if (body.password && !['super_admin', 'admin'].includes(user.role))
          fail('仅管理员可以创建或重置密码', 403)
        if (
          (existing?.role === 'super_admin' || body.role === 'super_admin') &&
          user.role !== 'super_admin'
        )
          fail('仅超级管理员可以维护超级管理员账号', 403)
        const username = text(body.username, '登录名', { required: true, max: 64 })
        if (!/^[a-zA-Z0-9_.@-]+$/.test(username)) fail('登录名仅支持字母、数字和_.@-')
        if (
          state.users.some(
            (u) => u.username.toLowerCase() === username.toLowerCase() && u.id !== existing?.id
          )
        )
          fail('登录名已存在', 409)
        const role = choice(body.role, ROLES, '角色'),
          status = choice(body.status || 'active', ['active', 'disabled'], '状态')
        if (
          !Number.isInteger(body.maxActiveOrders) ||
          body.maxActiveOrders < 1 ||
          body.maxActiveOrders > 100
        )
          fail('同时接单上限应为1至100')
        const overrides = body.permissionOverrides || {}
        if (
          typeof overrides !== 'object' ||
          Array.isArray(overrides) ||
          Object.entries(overrides).some(
            ([key, enabled]) => !ALL_PERMISSIONS.includes(key) || typeof enabled !== 'boolean'
          )
        )
          fail('个人权限配置无效')
        const levelId =
          role === 'player' && body.levelId
            ? find(state, 'levels', body.levelId, '等级').id
            : undefined
        if (role === 'player' && !levelId) fail('打手账号必须设置等级')
        const row = {
          id: existing?.id || id(),
          username,
          name: text(body.name, '姓名', { required: true, max: 100 }),
          role,
          status,
          ...(levelId ? { levelId } : {}),
          ...(existing
            ? existing.createdAt
              ? { createdAt: existing.createdAt }
              : {}
            : { createdAt: now() }),
          maxActiveOrders: body.maxActiveOrders,
          permissionOverrides: role === 'super_admin' ? {} : overrides
        }
        if (row.id === user.id && (status !== 'active' || role !== user.role))
          fail('不能停用自己或更改自身角色')
        if (!existing && !body.password) fail('创建账号时请设置初始密码')
        if (body.password) state.passwords[row.id] = hashPassword(body.password)
        if (existing) state.users[state.users.indexOf(existing)] = row
        else state.users.push(row)
        if (!state.users.some((u) => u.role === 'super_admin' && u.status === 'active'))
          fail('至少保留一个启用中的超级管理员')
        for (const order of state.orders) snapshotCommission(state, order)
        if (body.password || status === 'disabled' || existing?.role !== row.role)
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id)
        audit(
          state,
          user,
          `账号${existing ? '修改' : '创建'}${body.password ? ' / 设置密码' : ''}`,
          'user',
          row.id,
          before,
          row
        )
        return publicStaff(state, row)
      }
      if (path === '/customers') {
        if (!can(user, 'orders.create') && !can(user, 'users.manage'))
          fail('没有维护客户的权限', 403)
        const existing = body.id ? find(state, 'customers', body.id, '客户') : null
        const row = {
          id: existing?.id || id(),
          name: text(body.name, '客户名称', { required: true, max: 100 }),
          platformId: body.platformId
            ? find(state, 'platforms', body.platformId, '来源平台').id
            : null,
          contact: text(body.contact, '联系方式', { max: 200 }),
          gameId: text(body.gameId, '游戏ID', { max: 128 }),
          remark: text(body.remark, '备注'),
          ...(existing
            ? existing.createdAt
              ? { createdAt: existing.createdAt }
              : {}
            : { createdAt: now() })
        }
        audit(state, user, existing ? '修改客户' : '新增客户', 'customer', row.id, existing, row)
        if (existing) state.customers[state.customers.indexOf(existing)] = row
        else state.customers.push(row)
        return clone(publicCustomer(row))
      }
      if (path === '/templates') {
        requirePermission(user, 'templates.manage')
        const existing = body.id ? find(state, 'templates', body.id, '订单模板') : null
        const row = {
          id: existing?.id || id(),
          name: text(body.name, '模板名称', { required: true, max: 100 }),
          game: text(body.game, '游戏', { required: true, max: 100 }),
          description: text(body.description, '规格说明'),
          amount: cents(body.amount, '客户价格', { nullable: true }),
          reward: cents(body.reward, '打手报酬', { nullable: true }),
          map: text(body.map, '默认地图', { max: 100 }),
          remark: text(body.remark, '默认备注'),
          active: body.active !== false
        }
        audit(state, user, existing ? '修改模板' : '新增模板', 'template', row.id, existing, row)
        if (existing) state.templates[state.templates.indexOf(existing)] = row
        else state.templates.push(row)
        return clone(row)
      }
      if (['/platforms', '/shops', '/levels'].includes(path)) {
        requirePermission(user, 'settings.manage')
        const table = path.slice(1),
          existing = body.id ? find(state, table, body.id) : null
        const row = {
          id: existing?.id || id(),
          name: text(body.name, '名称', { required: true, max: 100 })
        }
        if (
          state[table].some(
            (r) =>
              r.name === row.name &&
              r.id !== row.id &&
              (table !== 'shops' || r.platformId === body.platformId)
          )
        )
          fail('名称已存在', 409)
        if (table === 'platforms') {
          if ((row.id === 'hall' || row.name === '游戏大厅') && body.operatorCommission)
            fail('游戏大厅不参与运营提成')
          row.rules = normalizePlatformRules(body.rules, existing || row)
        }
        if (table === 'shops') {
          row.platformId = find(state, 'platforms', body.platformId, '平台').id
          if (
            existing &&
            existing.platformId !== row.platformId &&
            state.orders.some((o) => o.shopId === row.id)
          )
            fail('已使用的店铺不能更换所属平台')
        }
        if (table === 'levels') {
          if (
            !Number.isInteger(body.delaySeconds) ||
            body.delaySeconds < 0 ||
            body.delaySeconds > 86400
          )
            fail('开放延迟应为0至86400秒')
          row.delaySeconds = body.delaySeconds
        }
        audit(
          state,
          user,
          `${existing ? '修改' : '新增'}${table}`,
          table.slice(0, -1),
          row.id,
          existing,
          row
        )
        if (existing) state[table][state[table].indexOf(existing)] = row
        else state[table].push(row)
        return clone(row)
      }
      if (path === '/attendance') {
        requirePermission(user, 'attendance.manage')
        const existing = body.id ? find(state, 'attendance', body.id, '考勤记录') : null
        const userId = find(state, 'users', body.userId, '员工').id,
          date = validDate(body.date)
        const toClock = (value, label) => {
          const clockValue =
            typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)
              ? value
              : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
                ? new Intl.DateTimeFormat('en-GB', {
                    timeZone: 'Asia/Shanghai',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                  }).format(new Date(normalizedTime(value, label)))
                : fail(`${label}格式应为HH:mm`)
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clockValue)) fail(`${label}无效`)
          return clockValue
        }
        const status = choice(
          body.status,
          ['scheduled', 'present', 'normal', 'rest', 'leave', 'absent'],
          '考勤状态'
        )
        const noShift = ['normal', 'rest'].includes(status) && !body.start && !body.end
        if (Boolean(body.start) !== Boolean(body.end)) fail('班次开始和结束时间需要成对填写')
        const start = noShift ? '' : toClock(body.start, '上班时间'),
          end = noShift ? '' : toClock(body.end, '下班时间')
        const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
        let shiftMinutes = minutes(end) - minutes(start)
        if (shiftMinutes === 0 && !noShift) fail('班次开始和结束时间不能相同')
        if (shiftMinutes < 0) shiftMinutes += 1440
        if (status === 'present' && date > shanghaiDate(now()))
          fail('未来排班不能提前登记到岗，请选择待登记状态')
        const maxHours = noShift ? 24 : shiftMinutes / 60
        const actualHours =
          body.actualHours == null
            ? status === 'present'
              ? existing?.status === 'present'
                ? existing.actualHours
                : Math.round(maxHours * 100) / 100
              : 0
            : body.actualHours
        if (
          typeof actualHours !== 'number' ||
          !Number.isFinite(actualHours) ||
          actualHours < 0 ||
          actualHours > maxHours + 0.01
        )
          fail('实际工时应在班次时长范围内')
        if (!['present', 'normal'].includes(status) && actualHours !== 0)
          fail('待登记、请假或缺勤记录的实际工时必须为0')
        if (date > shanghaiDate(now()) && actualHours !== 0) fail('未来排班不能提前登记实际工时')
        if (
          state.attendance.some(
            (a) => a.userId === userId && a.date === date && a.id !== existing?.id
          )
        )
          fail('该员工当天已有考勤记录，请编辑原记录', 409)
        const row = {
          id: existing?.id || id(),
          userId,
          date,
          start,
          end,
          status,
          actualHours: Math.round(actualHours * 100) / 100,
          hoursRegistered:
            date <= shanghaiDate(now()) &&
            ['present', 'normal'].includes(status) &&
            body.actualHours != null,
          remark: text(body.remark, '考勤备注')
        }
        audit(state, user, existing ? '修改考勤' : '登记考勤', 'attendance', row.id, existing, row)
        if (existing) state.attendance[state.attendance.indexOf(existing)] = row
        else state.attendance.push(row)
        return clone(row)
      }
      if (path === '/salary-plans') {
        requirePermission(user, 'salary.manage')
        const userId = find(state, 'users', body.userId, '员工').id
        if (find(state, 'users', userId).role === 'player')
          fail('打手通过报酬钱包结算，不使用员工工资方案')
        if (body.hourlyEnabled) fail('按工时计薪规则尚未配置，当前不能启用')
        const mode = choice(body.mode, ['base_commission', 'commission', 'fixed'], '工资模式'),
          effectiveFrom = validDate(body.effectiveFrom, '生效日期')
        if (body.id) find(state, 'salaryPlans', body.id, '工资方案')
        if (body.id && find(state, 'salaryPlans', body.id).userId !== userId)
          fail('不能更换工资方案所属员工')
        const platformRates = {}
        if (
          body.platformRates != null &&
          (typeof body.platformRates !== 'object' || Array.isArray(body.platformRates))
        )
          fail('平台比例无效')
        for (const [platformId, configuredRate] of Object.entries(body.platformRates || {})) {
          find(state, 'platforms', platformId, '平台')
          platformRates[platformId] = rate(configuredRate, '平台提成比例')
        }
        const existing = state.salaryPlans.find(
          (p) => p.userId === userId && p.effectiveFrom === effectiveFrom
        )
        if (
          existing &&
          state.payrolls.some(
            (p) => p.month >= effectiveFrom.slice(0, 7) && p.lines.some((l) => l.userId === userId)
          )
        )
          fail('该生效期已有工资发放记录，请新建未来生效的方案以保留历史', 409)
        const row = {
          id: existing?.id || id(),
          userId,
          mode,
          base: cents(body.base, '底薪', { nullable: true }),
          rate: rate(body.rate, '提成比例'),
          platformRates,
          effectiveFrom,
          hourlyEnabled: false
        }
        audit(
          state,
          user,
          existing ? '修改工资方案' : '新增工资方案版本',
          'salary-plan',
          row.id,
          existing,
          row
        )
        if (existing) state.salaryPlans[state.salaryPlans.indexOf(existing)] = row
        else state.salaryPlans.push(row)
        for (const order of state.orders) snapshotCommission(state, order)
        return clone(row)
      }
      if (path === '/payrolls') {
        requirePermission(user, 'salary.manage')
        requirePermission(user, 'salary.all')
        const month = validMonth(body.month),
          supplementary = state.payrolls.some((p) => p.month === month)
        const lines = payrollLines(state, month, supplementary)
        if (!lines.length)
          fail(
            supplementary ? '该月工资已发放，没有新的差额需要结算' : '没有需要发放工资的员工',
            409
          )
        if (lines.some((line) => line.incomplete || line.total == null))
          fail('工资配置不完整，请先补齐底薪及提成比例', 409)
        const row = { id: id(), month, status: 'paid', lines, paidAt: now(), paidBy: user.id }
        if (
          state.orders.some(
            (o) =>
              o.status === 'completed' &&
              paidOrder(o) &&
              shanghaiDate(o.completedAt).startsWith(month) &&
              orderCommissions(state, o).incomplete
          )
        )
          fail('已完成订单仍有待配置的历史计提比例，请补齐后结算', 409)
        for (const order of state.orders.filter(
          (o) =>
            o.status === 'completed' &&
            paidOrder(o) &&
            shanghaiDate(o.completedAt).startsWith(month) &&
            !state.commissionPaid[o.id]
        )) {
          const amounts = orderCommissions(state, order)
          state.commissionPaid[order.id] = {
            payrollId: row.id,
            supportUserId: order.creatorId,
            supportAmount: amounts.support || 0,
            operationsUserId: order.commissionSnapshot?.operationsId ?? null,
            operationsAmount: amounts.operations || 0
          }
        }
        state.commissionAdjustments
          .filter((a) => a.month === month && !a.payrollId)
          .forEach((a) => {
            a.payrollId = row.id
          })
        state.payrolls.push(row)
        audit(
          state,
          user,
          supplementary ? '登记退款提成差额结算' : '登记工资发放',
          'payroll',
          row.id,
          null,
          row
        )
        return clone(row)
      }
      const claimMatch = path.match(/^\/player\/orders\/([^/]+)\/claim$/)
      if (claimMatch) {
        requirePlayer(user)
        const order = find(state, 'orders', claimMatch[1], '订单'),
          before = clone(order)
        if (!visibleOrder(state, user, order)) fail('订单尚未向你的等级开放或未指派给你', 403)
        if (order.status !== 'pending' || order.leaderId) fail('订单已被接取或已经结束', 409)
        if (activeCount(state, user.id) >= user.maxActiveOrders) fail('已达到同时接单上限', 409)
        order.status = 'active'
        order.leaderId = user.id
        order.assignments.push({ leaderId: user.id, acceptedAt: now() })
        audit(state, user, '打手接单', 'order', order.id, before, order)
        return playerOrder(order)
      }
      const submitMatch = path.match(/^\/player\/orders\/([^/]+)\/submit$/)
      if (submitMatch) {
        requirePlayer(user)
        const order = find(state, 'orders', submitMatch[1], '订单'),
          before = clone(order)
        if (order.leaderId !== user.id) fail('只有当前有效负责人可以上报完成', 403)
        if (order.status !== 'active') fail('只有接单中订单可以上报', 409)
        if (
          !Array.isArray(body.screenshots) ||
          !body.screenshots.length ||
          body.screenshots.length > 10
        )
          fail('请上传1至10张完成截图')
        const screenshots = body.screenshots.map((a) => attachment(state, user, a, true))
        order.teammateId = validateTeammate(state, user.id, body.teammateId)
        if (order.teammateId && order.reward % 2)
          fail('双人平分报酬必须为偶数分，请联系财务确认分币尾差')
        order.submissions.push({
          id: id(),
          submittedAt: now(),
          leaderId: user.id,
          teammateId: order.teammateId,
          screenshots
        })
        order.status = 'review'
        audit(state, user, '打手上报完成', 'order', order.id, before, order)
        return playerOrder(order)
      }
      if (path === '/player/withdrawals') {
        requirePlayer(user)
        const amount = cents(body.amount, '提现金额', { positive: true })
        if (amount > wallet(state, user.id).available)
          fail('可提现余额不足，申请中的金额已占用', 409)
        const row = { id: id(), userId: user.id, amount, status: 'pending', createdAt: now() }
        state.withdrawals.push(row)
        audit(state, user, '申请提现', 'withdrawal', row.id, null, row)
        return clone(row)
      }
      fail('接口不存在', 404)
    })
  }
  return {
    db,
    close: () => db.close(),
    bootstrap,
    getAppearance(userId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      return clone(state.appearance || defaultAppearance())
    },
    publicAppearance() {
      return projectPublicAppearance(read().appearance || defaultAppearance())
    },
    publicAsset(attachmentId) {
      const appearance = read().appearance || defaultAppearance()
      if (!publicAppearanceAttachments(appearance).some((row) => row.id === attachmentId))
        fail('公开图片不存在', 404)
      const row = db.prepare('SELECT * FROM uploads WHERE id=?').get(attachmentId)
      if (!row) fail('公开图片不存在', 404)
      return { ...metadata(row), data: Buffer.from(row.data) }
    },
    customerReferences(userId, customerId, input = {}) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      requireCustomerAccess(user)
      find(state, 'customers', customerId, '客户')
      const current = Number(input.current || 1),
        size = Number(input.size || 20)
      if (
        !Number.isSafeInteger((current - 1) * size) ||
        !Number.isSafeInteger(current) ||
        current < 1 ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 100
      )
        fail('客户编号分页参数无效')
      const records = db
        .prepare(
          'SELECT * FROM customer_order_references WHERE customer_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?'
        )
        .all(customerId, size, (current - 1) * size)
        .map(publicReference)
      return {
        records,
        total: Number(
          db
            .prepare('SELECT COUNT(*) AS n FROM customer_order_references WHERE customer_id=?')
            .get(customerId).n
        ),
        current,
        size
      }
    },
    logs(userId, input = {}) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      requirePermission(user, 'logs.view')
      const current = Number(input.current || 1),
        size = Number(input.size || 50)
      if (
        !Number.isSafeInteger((current - 1) * size) ||
        !Number.isSafeInteger(current) ||
        current < 1 ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 200
      )
        fail('日志分页参数无效')
      const options = {
        source: input.source || (input.archived === 'true' ? 'archive' : 'hot'),
        actorId: input.actorId,
        entity: input.entity,
        entityId: input.entityId,
        action: input.action,
        keyword: text(input.keyword || input.search, '日志搜索', { max: 200 }),
        start:
          input.start || input.dateStart ? validDate(input.start || input.dateStart) : undefined,
        end: input.end || input.dateEnd ? validDate(input.end || input.dateEnd) : undefined,
        omitEntities:
          can(user, 'salary.all') && can(user, 'profit.view') ? [] : ['salary-plan', 'payroll']
      }
      return {
        records: auditStore
          .rows({ ...options, limit: size, offset: (current - 1) * size })
          .map((row) => safeAuditLog(state, user, row))
          .filter(Boolean),
        total: auditStore.total(options),
        current,
        size
      }
    },
    logDetail(userId, logId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      requirePermission(user, 'logs.view')
      const row = auditStore.get(logId),
        result = row ? safeAuditLog(state, user, row) : null
      if (!result) fail('日志不存在或当前账号无权查看', 404)
      return result
    },
    logStorage(userId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      requirePermission(user, 'settings.manage')
      requirePermission(user, 'logs.view')
      return { ...auditStore.storage(), canBackup: canBackupAudit(user) }
    },
    prepareArchiveBackup(userId, beforeDate) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      requireBackupAudit(user)
      beforeDate = validDate(beforeDate, '备份截止日期')
      const scope = auditStore.backupScope(beforeDate)
      if (!scope.count) fail('该截止日期之前没有可备份的归档记录', 409)
      const token = randomBytes(32).toString('base64url')
      db.prepare('DELETE FROM audit_archive_backups WHERE expires_at<=?').run(Date.parse(now()))
      db.prepare(
        'INSERT INTO audit_archive_backups(token_hash,user_id,before_date,scope_json,ready,expires_at) VALUES(?,?,?,?,0,?)'
      ).run(
        sessionHash(token),
        user.id,
        beforeDate,
        JSON.stringify(scope),
        Date.parse(now()) + 30 * 60000
      )
      return {
        backupToken: token,
        rowCount: scope.count,
        beforeDate,
        generatedAt: now(),
        records: auditStore.backupIterator(beforeDate)
      }
    },
    completeArchiveBackup(userId, token, beforeDate) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      checkBackupReceipt(user, token, beforeDate, { ready: false })
      db.prepare('UPDATE audit_archive_backups SET ready=1 WHERE token_hash=?').run(
        sessionHash(token)
      )
    },
    cancelArchiveBackup(token) {
      db.prepare('DELETE FROM audit_archive_backups WHERE token_hash=? AND ready=0').run(
        sessionHash(token)
      )
    },
    exportSnapshot(userId, request = {}) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      requirePermission(user, 'reports.export')
      const base = bootstrap(userId, request.month)
      const logBounds = auditStore.bounds()
      state.logs = [logBounds.start, logBounds.end]
        .filter(Boolean)
        .map((createdAt) => ({ createdAt }))
      const result = buildPeriodExportSnapshot({
        base,
        state,
        request,
        now: now(),
        monthReport: (month) => reports(state, month)
      })
      const filters = request.filters || {},
        dateRange = filters.dateRange
      const referenceRequested = request.modules?.some(
        (row) => row.id === 'customerOrderReferences'
      )
      const referenceConditions = ['customer_id IN (SELECT value FROM json_each(?))'],
        referenceParams = [JSON.stringify(result.customers.map((row) => row.id))]
      if (filters.platformId != null) {
        if (typeof filters.platformId !== 'string' || filters.platformId.length > 200)
          fail('导出来源筛选格式无效')
        if (filters.platformId) {
          referenceConditions.push('platform_id=?')
          referenceParams.push(filters.platformId)
        }
      }
      const referenceKeyword = text(filters.keyword, '关联编号搜索', { max: 200 }).toLowerCase()
      if (referenceKeyword) {
        if (filters.keywordField === 'externalOrderNo') {
          referenceConditions.push('customer_ref_contains(external_order_no,?)=1')
          referenceParams.push(referenceKeyword)
        } else {
          const source = new Map([
            ['customerName', { column: 'customer_id', rows: result.customers }],
            ['platformName', { column: 'platform_id', rows: result.platforms }],
            ['shopName', { column: 'shop_id', rows: result.shops }]
          ]).get(filters.keywordField)
          if (source) {
            referenceConditions.push(`${source.column} IN (SELECT value FROM json_each(?))`)
            referenceParams.push(
              JSON.stringify(
                source.rows
                  .filter((row) => row.name.toLowerCase().includes(referenceKeyword))
                  .map((row) => row.id)
              )
            )
          } else referenceConditions.push('0')
        }
      }
      const referenceWhere = ' WHERE ' + referenceConditions.join(' AND ')
      result.customerOrderReferenceCount = Number(
        db
          .prepare('SELECT COUNT(*) AS n FROM customer_order_references' + referenceWhere)
          .get(...referenceParams).n
      )
      if (referenceRequested && result.customerOrderReferenceCount > 100000)
        fail('客户关联编号匹配超过 100000 条，请缩小来源或关键词范围后重试')
      if (referenceRequested && result.customers.length) {
        const records = db
          .prepare(
            'SELECT * FROM customer_order_references' +
              referenceWhere +
              ' ORDER BY rowid DESC LIMIT 100001'
          )
          .all(...referenceParams)
          .map(publicReference)
        for (const customer of result.customers)
          customer.orderReferences = records.filter((row) => row.customerId === customer.id)
      }
      const logRequested = request.modules?.some((row) => row.id === 'logs')
      const logKeywordFields = ['id', 'action', 'actorName', 'entity', 'entityId', 'createdAt']
      if (logRequested && filters.keyword && ['before', 'after'].includes(filters.keywordField))
        fail('日志关键词不检索权限过滤的修改前后内容，请选择操作人、操作动作或记录号')
      const unmatchedLogField = Boolean(
        filters.keyword && filters.keywordField && !logKeywordFields.includes(filters.keywordField)
      )
      const start = dateRange ? validDate(dateRange[0]) : result.exportPeriod.start
      const end = dateRange ? validDate(dateRange[1]) : result.exportPeriod.end
      const options = {
        source: filters.archived || 'all',
        start: start > result.exportPeriod.start ? start : result.exportPeriod.start,
        end: end < result.exportPeriod.end ? end : result.exportPeriod.end,
        actorId: filters.personId,
        keyword:
          filters.keyword && !unmatchedLogField
            ? text(filters.keyword, '日志搜索', { max: 200 })
            : undefined,
        keywordField: unmatchedLogField ? undefined : filters.keywordField,
        omitEntities:
          can(user, 'salary.all') && can(user, 'profit.view') ? [] : ['salary-plan', 'payroll']
      }
      result.auditLogCount =
        can(user, 'logs.view') && !unmatchedLogField ? auditStore.total(options) : 0
      if (logRequested && can(user, 'logs.view') && !unmatchedLogField)
        result.logs = auditStore
          .rows({ ...options, limit: 100001 })
          .map((row) => safeAuditLog(state, user, row))
          .filter(Boolean)
      else if (logRequested) result.logs = []
      return result
    },
    overview(userId, input = {}) {
      const dates = normalizeOverviewRange(input, shanghaiDate(now()))
      const snapshots = overviewMonths(dates).map((month) => bootstrap(userId, month))
      // 普通运营的订单快照不暴露提成归属；这里只投影本人完成业绩，不输出其他人的计提信息。
      const snapshot = snapshots[0]
      if (snapshot.permissions.includes('orders.view')) {
        const state = read()
        const personalPerformance = state.orders
          .filter(
            (order) =>
              order.status === 'completed' &&
              paidOrder(order) &&
              (snapshot.user.role === 'operations'
                ? order.commissionSnapshot?.operationsId === snapshot.user.id
                : order.creatorId === snapshot.user.id)
          )
          .map((order) => ({ date: shanghaiDate(order.completedAt), net: netOrder(state, order) }))
        for (const value of snapshots) value.personalPerformance = personalPerformance
      }
      return buildOverviewReport(snapshots, dates, now())
    },
    mutate,
    login(username, passwordValue) {
      const state = read(),
        loginName = text(username, '登录名', { required: true, max: 64 })
      const user = state.users.find((u) => u.username.toLowerCase() === loginName.toLowerCase())
      if (
        !user ||
        user.status !== 'active' ||
        !verifyPassword(passwordValue, state.passwords[user.id])
      )
        fail('账号或密码错误，或账号已停用', 401)
      const token = randomBytes(32).toString('base64url'),
        expiresAt = Date.parse(now()) + 12 * 3600000
      const registerSession = () => {
        db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.parse(now()))
        db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(
          sessionHash(token),
          user.id,
          expiresAt
        )
      }
      let maintenanceNotice
      try {
        transact(user.id, (s, actor) => {
          registerSession()
          audit(s, actor, '登录', 'session', actor.id, null, { userId: actor.id })
        })
      } catch (error) {
        if (!isAuditCapacityError(error) || !canBackupAudit(user)) throw error
        // The failed session transaction has rolled back. Only fully authorized
        // backup operators can recover access, with a separate bounded login audit.
        transact(user.id, (s, actor) => {
          requireBackupAudit(actor)
          registerSession()
          auditStore.appendEmergencyLogin({
            id: id(),
            actorId: actor.id,
            actorName: actor.name,
            createdAt: now()
          })
        })
        maintenanceNotice =
          '日志归档容量已满，请进入操作日志下载完整备份并清理已备份归档；业务修改暂不可保存'
      }
      return {
        token,
        user: publicStaff(state, user),
        ...(maintenanceNotice ? { maintenanceNotice } : {})
      }
    },
    session(token) {
      if (!token || typeof token !== 'string' || token.length > 128) return null
      const row = db
        .prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?')
        .get(sessionHash(token))
      if (!row || row.expires_at <= Date.parse(now())) return null
      const state = read(),
        user = state.users.find((u) => u.id === row.user_id && u.status === 'active')
      return user ? publicStaff(state, user) : null
    },
    logout(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionHash(token))
      return { ok: true }
    },
    playerOrders(userId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      requirePlayer(user)
      return state.orders.filter((o) => visibleOrder(state, user, o)).map(playerOrder)
    },
    playerWallet(userId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      requirePlayer(user)
      return {
        ...wallet(state, user.id),
        withdrawals: state.withdrawals.filter((w) => w.userId === user.id)
      }
    },
    upload(userId, body) {
      return transact(userId, (state, user) => {
        const name = text(body.name, '文件名', { required: true, max: 200 }),
          mime = choice(body.mime, ['image/png', 'image/jpeg', 'image/webp'], '附件格式')
        if (
          typeof body.data !== 'string' ||
          body.data.length > 12_000_000 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)
        )
          fail('附件内容不是有效base64')
        const data = Buffer.from(body.data, 'base64')
        if (!data.length || data.length > 8 * 1024 * 1024) fail('附件大小须为1字节至8MB')
        const signature =
          mime === 'image/png'
            ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
            : mime === 'image/jpeg'
              ? data.length > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255
              : data.length >= 12 &&
                data.toString('ascii', 0, 4) === 'RIFF' &&
                data.toString('ascii', 8, 12) === 'WEBP'
        if (!signature) fail('文件内容与图片类型不一致，仅支持PNG、JPEG或WebP')
        const attachmentId = id()
        db.prepare(
          'INSERT INTO uploads(id,owner_id,name,mime,size,data,created_at) VALUES(?,?,?,?,?,?,?)'
        ).run(attachmentId, user.id, name, mime, data.length, data, now())
        const result = metadata({ id: attachmentId, name, mime, size: data.length })
        audit(state, user, '上传附件', 'upload', attachmentId, null, result)
        return result
      })
    },
    download(userId, attachmentId) {
      const state = read(),
        user = find(state, 'users', userId, '账号'),
        row = db.prepare('SELECT * FROM uploads WHERE id=?').get(attachmentId)
      if (!row) fail('附件不存在', 404)
      // 共享品牌图只允许读取；不能借此取得将他人图片用作业务付款凭证的权限。
      const appearanceReadable =
        user.status === 'active' &&
        appearanceAttachments(state.appearance, { activeOnly: !can(user, 'settings.manage') }).some(
          (image) => image.id === attachmentId
        )
      if (
        row.owner_id !== user.id &&
        !linkedAttachment(state, user, attachmentId) &&
        !appearanceReadable
      )
        fail('无权查看此附件', 403)
      return { ...metadata(row), data: Buffer.from(row.data) }
    }
  }
}
