import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { buildOverviewReport, normalizeOverviewRange, overviewMonths } from './overview-report.mjs'
import { buildOverviewDetails, overviewDetailQuery } from './overview-details.mjs'
import {
  defaultAppearance,
  normalizeAppearance,
  validateAppearanceRevision,
  appearanceAttachments,
  projectAppearanceAudit,
  projectPublicAppearance,
  publicAppearanceAttachments,
  canonicalAppearanceIcons
} from './appearance.mjs'
import { createAuditStore, isAuditCapacityError } from './audit-store.mjs'
import { platformRules, normalizePlatformRules } from './platform-rules.mjs'
import { buildPeriodExportSnapshot, exportPeriod } from './export-period.mjs'
import { buildDiagnosticsReport } from './diagnostics.mjs'
import { createFundsStore } from './funds-store.mjs'
import { readPlayerOperationResult } from './operation-results.mjs'
import { createImageArchive, archivedImageRecord, readArchivedImage, deletedImageRecord } from './image-archive.mjs'
import {
  normalizeOrderIdentity,
  advanceOrderIdentity,
  checkOrderPreconditions,
  createBusinessRequests,
  claimEligibility,
  submitEligibility,
  paymentConfirmed,
  activeOrderCount,
  conflict
} from './order-contract.mjs'
import {
  mutatePlayerContent,
  adminPlayerContent,
  playerContent,
  playerContentAsset,
  isPlayerContentAttachment
} from './player-content.mjs'

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
  if (user.status !== 'active') fail('账号已停用', 403)
  if (!playerAccess(user).login) fail('当前打手账号已关闭登录', 403)
}
export const playerAccess = (user) => ({
  login: true,
  claim: true,
  withdraw: true,
  ...(user.playerAccess || {})
})
const normalizePlayerAccess = (value, previous) => {
  if (value == null) return playerAccess(previous || {})
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['login', 'claim', 'withdraw'].includes(key)) ||
    ['login', 'claim', 'withdraw'].some((key) => typeof value[key] !== 'boolean')
  )
    fail('打手访问设置必须包含登录、接单、提现三个有效开关')
  return { login: value.login, claim: value.claim, withdraw: value.withdraw }
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
const activeCount = (state, userId) => activeOrderCount(state, userId)
const publicStaff = (state, user, counts) => ({
  ...user,
  ...(user.role === 'player' ? { playerAccess: playerAccess(user) } : {}),
  activeOrders: counts ? counts.active.get(user.id) || 0 : activeCount(state, user.id),
  pendingAssignments: counts
    ? counts.pending.get(user.id) || 0
    : state.orders.filter(
        (o) =>
          o.status === 'pending' && o.dispatchState !== 'unassigned' && o.assignedTo === user.id
      ).length
})
function staffOrderCounts(state) {
  const active = new Map(),
    pending = new Map()
  for (const order of state.orders) {
    if (order.status === 'active' && order.leaderId)
      active.set(order.leaderId, (active.get(order.leaderId) || 0) + 1)
    if (order.status === 'pending' && order.assignedTo && order.dispatchState !== 'unassigned')
      pending.set(order.assignedTo, (pending.get(order.assignedTo) || 0) + 1)
  }
  return { active, pending }
}
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
    workSchedules: [],
    salaryPlans: [],
    payrolls: [],
    logs: [],
    passwords: {},
    rewardCredits: [],
    playerRewardLedger: [],
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
  password,
  seed = true,
  clock = () => new Date(),
  onTransaction,
  playerExtraMutate,
  imageArchive = {},
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
  const archivedImages = createImageArchive({ db, dbPath, ...imageArchive, clock })
  const auditStore = createAuditStore(db, {
    retentionDays: auditRetentionDays,
    hotMaxRows: auditHotMaxRows,
    archiveMaxBytes: auditArchiveMaxBytes,
    clock
  })
  const funds = createFundsStore(db)
  const businessRequest = createBusinessRequests(db)
  db.exec(
    'CREATE TABLE IF NOT EXISTS player_private_uploads(attachment_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL)'
  )
  const appearanceFor = (state) => {
    const config = state.appearance || defaultAppearance()
    return {
      ...config,
      playerOrderCardImage: config.playerOrderCardImage ?? null,
      icons: canonicalAppearanceIcons(config.icons)
    }
  }
  const fundDateFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
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
  const readScope = new AsyncLocalStorage()
  const derivedResults = new Map()
  const readOnlyState = () => {
    // A transaction always re-reads authority; only read-only parsed snapshots are reused.
    const cacheKey = `${db.prepare('PRAGMA data_version').get().data_version}:${db.prepare('SELECT total_changes() AS n').get().n}`
    const memo = readScope.getStore()
    if (!db.isTransaction && memo?.key === cacheKey) return memo.state
    const state = JSON.parse(db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
    if (!db.isTransaction && memo) Object.assign(memo, { key: cacheKey, state })
    return state
  }
  const read = () => {
    const state = readOnlyState()
    state.playerAdjustments ||= []
    state.statusCorrectionReversals ||= {}
    state.workSchedules ||= []
    state.playerPaymentMethods ||= {}
    state.dataVersion ||= 1
    for (const order of state.orders) normalizeOrderIdentity(order)
    // 旧账只登记当前余额快照；不能把已经更正的报酬伪装成原始入账流水。
    state.playerRewardLedger ||= state.rewardCredits.map((row) => ({
      id: `legacy:${row.id}`,
      orderId: row.orderId,
      userId: row.userId,
      kind: 'legacy-reward-snapshot',
      amount: row.amount,
      delta: row.amount,
      createdAt: row.createdAt,
      snapshotAt: now(),
      reason: '历史报酬余额快照（按当前更正结果展示，原始变更请财务核对）'
    }))
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
  const save = (state) => {
    state.dataVersion = (state.dataVersion || 1) + 1
    derivedResults.clear()
    return db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  }
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
  const transact = (userId, callback, authentication = {}) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const state = read()
      const user = find(state, 'users', userId, '账号')
      if (authentication.sessionToken !== undefined) {
        const session = db
          .prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?')
          .get(sessionHash(authentication.sessionToken))
        if (!session || session.user_id !== userId || session.expires_at <= Date.parse(now()))
          throw Object.assign(new ApiError('会话已撤销或过期，请重新登录', 401), {
            code: 'SESSION_EXPIRED'
          })
      }
      if (
        authentication.requireActor &&
        (typeof authentication.expectedActorId !== 'string' ||
          !authentication.expectedActorId.trim())
      )
        conflict('PRECONDITION_REQUIRED', '缺少本次操作所属账号，请刷新并重新确认')
      if (authentication.expectedActorId !== undefined && authentication.expectedActorId !== userId)
        conflict('PRINCIPAL_CHANGED', '本次操作所属账号与当前会话不一致，业务未执行，请重新确认')
      if (user.status !== 'active' || (user.role === 'player' && !playerAccess(user).login))
        fail('账号已停用或关闭登录', 403)
      const beforeState = onTransaction ? clone(state) : null
      const transaction = { changed: true }
      const result = callback(state, user, transaction)
      if (transaction.changed) {
        if (onTransaction) onTransaction({ db, state, beforeState, user, now: now() })
        save(state)
      }
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
  const retainedAttachment = (image) => {
    const deleted = image && deletedImageRecord(db, image.id)
    return deleted ? { ...image, retentionStatus: 'deleted', deletedAt: deleted.deleted_at } : image
  }
  const imageRetentionVersion = () => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_deletions'").get()
    ? db.prepare('SELECT max(rowid) AS version FROM image_deletions').get().version || 0 : 0
  const publicReference = (row) => ({
    id: row.id,
    customerId: row.customer_id,
    platformId: row.platform_id,
    shopId: row.shop_id || null,
    externalOrderNo: row.external_order_no
  })
  const publicCustomer = (customer, balances) => ({
    ...customer,
    balance: balances ? balances.get(customer.id) || 0 : funds.balance('customer', customer.id),
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
  const moneyRequest = (user, path, body, callback, required = false) => {
    const keys = [
      'customerId',
      'userId',
      'kind',
      'amount',
      'reason',
      'receipt',
      'orderId',
      'exitType',
      'templateId',
      'platformId',
      'shopId',
      'externalOrderNo',
      'roomCode',
      'gameId',
      'map',
      'reward',
      'remark',
      'dispatchMode',
      'assignedTo',
      'receivedAmount',
      'paidAt',
      'payOnArrival',
      'paymentMethod',
      'action',
      'status',
      'leaderId',
      'resolution',
      'teammateId'
    ]
    const payload = Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(body, key))
        .map((key) => [
          key,
          key === 'receipt' && body[key] && typeof body[key] === 'object' ? body[key].id : body[key]
        ])
    )
    return funds.request(user.id, path, body.requestId, payload, callback, required)
  }
  const customerAccountVisible = (user) =>
    can(user, 'orders.view') ||
    can(user, 'orders.create') ||
    can(user, 'users.manage') ||
    can(user, 'finance.refunds')
  const requireCustomerAccount = (user) => {
    if (user.role === 'player' || !customerAccountVisible(user))
      fail('没有查看客户储值余额的权限', 403)
  }
  const depositVisible = (user, userId) =>
    user.id === userId || (user.role !== 'player' && can(user, 'finance.withdrawals'))
  const activeState = (userId) => {
    const state = read(),
      user = find(state, 'users', userId, '账号')
    if (user.status !== 'active' || (user.role === 'player' && !playerAccess(user).login))
      fail('账号已停用或关闭登录', 403)
    return { state, user }
  }
  const accountPage = (input = {}) => {
    const current = Number(input.current ?? 1),
      size = Number(input.size ?? 20)
    if (
      !Number.isSafeInteger(current) ||
      current < 1 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 100 ||
      !Number.isSafeInteger((current - 1) * size)
    )
      fail('分页参数无效')
    return { current, size }
  }
  const postFund = (state, user, body, type) => {
    requirePermission(user, type === 'customer' ? 'finance.refunds' : 'finance.withdrawals')
    const accountId =
      type === 'customer'
        ? find(state, 'customers', body.customerId, '客户').id
        : find(state, 'users', body.userId, '打手').id
    if (type === 'deposit' && find(state, 'users', accountId).role !== 'player')
      fail('押金对象必须是打手账号')
    const kind = choice(
      body.kind === 'refund' && type === 'deposit' ? 'return' : body.kind,
      type === 'customer' ? ['recharge', 'deduction', 'return'] : ['deposit', 'penalty', 'return'],
      '资金操作'
    )
    const exitType =
      type === 'deposit' && kind !== 'deposit'
        ? choice(body.exitType, ['leave', 'absconded'], '退店或跑路场景')
        : null
    const normalized = { ...body, kind, exitType }
    return moneyRequest(
      user,
      type === 'customer' ? '/customer-transactions' : '/player-deposit-transactions',
      normalized,
      () => {
        const amount = cents(body.amount, '资金金额', { positive: true }),
          reason = requiredReason(body)
        const row = funds.append({
          type,
          accountId,
          kind,
          amount,
          direction: ['recharge', 'deposit'].includes(kind) ? 1 : -1,
          reason,
          receipt: attachment(state, user, body.receipt),
          actor: user,
          requestId: body.requestId,
          exitType,
          now: now(),
          id: id()
        })
        audit(
          state,
          user,
          type === 'customer' ? '客户储值资金登记' : '打手押金资金登记',
          type === 'customer' ? 'customer-transaction' : 'player-deposit-transaction',
          row.id,
          null,
          row
        )
        return row
      },
      true
    )
  }
  const balancePayment = (state, user, order, body) => {
    const row = funds.append({
      type: 'customer',
      accountId: order.customerId,
      kind: 'order-payment',
      amount: order.amount,
      direction: -1,
      reason: `订单储值支付：${order.orderNo}`,
      orderId: order.id,
      actor: user,
      requestId: body.requestId,
      sourceId: `order-payment:${order.id}`,
      now: now(),
      id: id()
    })
    order.paymentMethod = 'balance'
    order.balanceTransactionId = row.id
    order.balanceCustomerId = order.customerId
    Object.assign(order, {
      receivedAmount: order.amount,
      paidAt: row.createdAt,
      receivedAt: row.createdAt,
      receipt: null
    })
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
      state.users.some((row) => has(row.avatar)) &&
      (user.role === 'player' || can(user, 'users.manage') || can(user, 'orders.view'))
    )
      return true
    if (
      state.orders.some(
        (order) =>
          visibleOrder(state, user, order) &&
          ((user.role !== 'player' && can(user, 'orders.view') && has(order.receipt)) ||
            order.submissions.some(
              (s) =>
                (user.role !== 'player' ||
                  ([order.leaderId, order.teammateId].includes(user.id) &&
                    [s.leaderId, s.teammateId].includes(user.id))) &&
                s.screenshots.some(has)
            ))
      )
    )
      return true
    if (user.role !== 'player' && (can(user, 'finance.expenses') || can(user, 'profit.view')))
      if (state.expenses.some((e) => has(e.receipt))) return true
    if (
      state.withdrawals.some(
        (w) =>
          ((user.role !== 'player' && can(user, 'finance.withdrawals')) || w.userId === user.id) &&
          (has(w.receipt) || has(w.paymentSnapshot?.qrCode))
      )
    )
      return true
    if (
      Object.entries(state.playerPaymentMethods || {}).some(
        ([ownerId, methods]) =>
          (ownerId === user.id || (user.role !== 'player' && can(user, 'finance.withdrawals'))) &&
          Object.values(methods).some((method) => has(method.qrCode))
      )
    )
      return true
    const fundingReceipt = db
      .prepare(
        "SELECT account_type,account_id FROM fund_transactions WHERE json_extract(receipt_json,'$.id')=?"
      )
      .all(attachmentId)
    if (
      fundingReceipt.some((row) =>
        row.account_type === 'customer'
          ? user.role !== 'player' && can(user, 'finance.refunds')
          : depositVisible(user, row.account_id)
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
    if (state.appearance?.playerOrderCardImage?.id === attachmentId)
      fail('当前打手订单卡片图片不能转作业务凭证或私人资料，请单独上传', 403)
    if (isPlayerContentAttachment(state, attachmentId))
      fail('板报图片不能用作业务凭证或私人资料，请单独上传', 403)
    const record = db
      .prepare('SELECT id,owner_id,name,mime,size FROM uploads WHERE id=?')
      .get(attachmentId)
    if (!record) fail('附件不存在，请重新上传')
    if (record.owner_id !== user.id && !linkedAttachment(state, user, attachmentId))
      fail('无权使用此附件', 403)
    if (deletedImageRecord(db, attachmentId)) fail('订单图片已按30天保留规则删除，请重新上传', 410)
    return metadata(record)
  }
  // Only structured attachment fields indicate private use. File names, reasons,
  // and arbitrary free text containing an upload ID never classify an image.
  function privateAttachmentReference(value, attachmentId) {
    if (!value || typeof value !== 'object') return false
    const isAttachment = (item) =>
      item === attachmentId ||
      (item && typeof item === 'object' && item.id === attachmentId)
    for (const [key, child] of Object.entries(value)) {
      if (
        (['receipt', 'qrCode'].includes(key) && isAttachment(child)) ||
        (key === 'screenshots' && Array.isArray(child) && child.some(isAttachment))
      )
        return true
      if (privateAttachmentReference(child, attachmentId)) return true
    }
    return false
  }
  function requireNonPrivateCardImage(state, attachmentId) {
    if (
      db.prepare('SELECT 1 FROM player_private_uploads WHERE attachment_id=?').get(attachmentId) ||
      privateAttachmentReference(state, attachmentId) ||
      db
        .prepare("SELECT 1 FROM fund_transactions WHERE json_extract(receipt_json,'$.id')=? LIMIT 1")
        .get(attachmentId)
    )
      fail('私人收款码、业务凭证和订单材料不能用作共享订单卡片图片', 403)
    for (const [table, columns] of [
      ['audit_logs', ['payload']],
      ['audit_logs_archive', ['payload']],
      ['business_requests', ['result_json']],
      // A shared moneyRequest payload can contain unused optional fields. Only
      // its authoritative result proves private use, preventing marker poisoning.
      ['financial_requests', ['result_json']]
    ]) {
      for (const record of db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).iterate()) {
        for (const column of columns) {
          if (!record[column]?.includes(attachmentId)) continue
          let value
          try { value = JSON.parse(record[column]) } catch { continue }
          if (privateAttachmentReference(value, attachmentId))
            fail('存在私人凭证或材料历史引用的图片不能用作共享订单卡片图片', 403)
        }
      }
    }
  }
  function hasPlayerParticipation(order, userId) {
    return (
      [order.leaderId, order.teammateId].includes(userId) ||
      (order.assignments || []).some((row) => row.leaderId === userId) ||
      (order.submissions || []).some((row) => [row.leaderId, row.teammateId].includes(userId)) ||
      (order.returnRequests || []).some((row) => row.leaderId === userId) ||
      (order.rejections || []).some((row) => row.playerId === userId)
    )
  }
  function lastPlayerParticipation(order, userId) {
    const timestamps = []
    for (const row of order.assignments || [])
      if (row.leaderId === userId) timestamps.push(row.acceptedAt, row.releasedAt)
    for (const row of order.submissions || [])
      if ([row.leaderId, row.teammateId].includes(userId)) timestamps.push(row.submittedAt)
    for (const row of order.returnRequests || [])
      if (row.leaderId === userId) timestamps.push(row.requestedAt, row.processedAt)
    for (const row of order.rejections || [])
      if (row.playerId === userId) timestamps.push(row.rejectedAt)
    return timestamps.filter((value) => typeof value === 'string' && value).sort().at(-1) || null
  }
  function currentPlayerOrderAccess(state, user, order) {
    if (order.leaderId === user.id || order.teammateId === user.id) return true
    if (order.status !== 'pending') return false
    if (order.dispatchState === 'unassigned') return false
    if (order.dispatchMode === 'direct') return order.assignedTo === user.id
    const level = state.levels.find((l) => l.id === user.levelId)
    return Boolean(
      level && Date.parse(now()) >= Date.parse(order.publishedAt) + level.delaySeconds * 1000
    )
  }
  function visibleOrder(state, user, order) {
    if (user.role !== 'player') return can(user, 'orders.view')
    return currentPlayerOrderAccess(state, user, order) || hasPlayerParticipation(order, user.id)
  }
  function playerOrder(state, user, order) {
    const participant = order.leaderId === user.id || order.teammateId === user.id
    const historical = hasPlayerParticipation(order, user.id)
    const historyOnly = historical && !currentPlayerOrderAccess(state, user, order)
    const eligibility = claimEligibility(state, user, order, now())
    const level = state.levels.find((row) => row.id === user.levelId)
    const availableAt =
      order.dispatchMode === 'pool' && level
        ? new Date(Date.parse(order.publishedAt) + level.delaySeconds * 1000).toISOString()
        : order.publishedAt
    const clean = {
      id: order.id,
      participation: participant ? 'current' : historical ? 'historical' : 'available',
      lastParticipationAt: lastPlayerParticipation(order, user.id),
      historyOnly,
      revision: order.revision,
      dispatchRound: order.dispatchRound,
      assignmentId: order.assignmentId,
      submissionId: order.submissionId,
      playerRemark: order.playerRemark || '',
      paymentConfirmed: paymentConfirmed(order),
      canClaim: !historyOnly && eligibility.canClaim,
      claimBlockedReason: eligibility.reasonCode
        ? { code: eligibility.reasonCode, message: eligibility.reason }
        : null,
      ...submitEligibility(user, order),
      orderNo: order.orderNo,
      title: order.title,
      status: order.status,
      reward: order.reward,
      map: order.map,
      requirements: order.snapshot?.description || '',
      snapshot: Object.fromEntries(
        ['name', 'game', 'description', 'map']
          .filter((key) => Object.hasOwn(order.snapshot || {}, key))
          .map((key) => [key, order.snapshot[key]])
      ),
      dispatchMode: order.dispatchMode,
      dispatchState: order.dispatchState || 'ready',
      assignedTo: order.assignedTo,
      leaderId: order.leaderId,
      teammateId: order.teammateId,
      createdAt: order.createdAt,
      publishedAt: order.publishedAt,
      completedAt: order.completedAt,
      availableAt,
      claimEligible:
        !historyOnly &&
        order.status === 'pending' &&
        order.dispatchState !== 'unassigned' &&
        !order.leaderId &&
        playerAccess(user).claim &&
        (order.dispatchMode === 'direct'
          ? order.assignedTo === user.id
          : Boolean(level && Date.parse(now()) >= Date.parse(availableAt))) &&
        activeCount(state, user.id) < user.maxActiveOrders,
      submissions: participant
        ? (order.submissions || [])
            .filter((row) => row.leaderId === user.id || row.teammateId === user.id)
            .map((row) => ({
              id: row.id,
              assignmentId: row.assignmentId,
              dispatchRound: row.dispatchRound,
              submittedAt: row.submittedAt,
              leaderId: row.leaderId,
              teammateId: row.teammateId,
              screenshots: (row.screenshots || []).map(retainedAttachment),
              source: row.source,
              review: row.review,
              reviewedAt: row.reviewedAt,
              reason: row.reason,
              ...(row.source === 'status-correction'
                ? { correctionReason: '后台已登记订单状态' }
                : {})
            }))
        : [],
      returnRequests: (order.returnRequests || [])
        .filter((row) => row.leaderId === user.id)
        .map(
          ({
            id,
            assignmentId,
            dispatchRound,
            leaderId,
            reason,
            status,
            requestedAt,
            processedAt,
            processReason
          }) => ({
            id,
            assignmentId,
            dispatchRound,
            leaderId,
            reason,
            status,
            requestedAt,
            processedAt,
            processReason
          })
        ),
      rejections: (order.rejections || [])
        .filter((row) => row.playerId === user.id)
        .map(({ id, playerId, reason, rejectedAt }) => ({ id, playerId, reason, rejectedAt }))
    }
    if (participant) Object.assign(clean, { roomCode: order.roomCode, gameId: order.gameId })
    return clone(clean)
  }
  function safeOrder(state, user, order) {
    if (user.role === 'player') return playerOrder(state, user, order)
    const clean = clone(order)
    for (const submission of clean.submissions || [])
      submission.screenshots = (submission.screenshots || []).map(retainedAttachment)
    if (!can(user, 'salary.all') && !can(user, 'profit.view')) delete clean.commissionSnapshot
    return clean
  }
  // 审计记录保存当时的值；读取时与对应业务数据使用相同权限，不从现有记录覆盖历史。
  function safeAuditLog(state, user, log) {
    if (user.role === 'player') return null
    if (log.entity === 'player-content' && !can(user, 'settings.manage')) return null
    const pick = (value, keys) =>
      Object.fromEntries(
        keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])
      )
    const safeAttachment = (value) =>
      value && typeof value === 'object' ? retainedAttachment(pick(value, ['id', 'name', 'mime', 'size', 'url'])) : null
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
            if (value.playerAccess)
              result.playerAccess = pick(value.playerAccess, ['login', 'claim', 'withdraw'])
          }
          return result
        }
        case 'order': {
          if (!visibleOrderId(log.entityId)) return null
          const clean = safeOrder(state, user, value)
          const result = pick(clean, [
            'id',
            'revision',
            'dispatchRound',
            'assignmentId',
            'submissionId',
            'playerRemark',
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
            'paymentMethod',
            'balanceTransactionId',
            'balanceCustomerId',
            'status',
            'dispatchMode',
            'dispatchState',
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
            'rewardBeforeCancellation',
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
          if (Array.isArray(clean.returnRequests))
            result.returnRequests = clean.returnRequests.map((row) =>
              pick(row, [
                'id',
                'leaderId',
                'reason',
                'status',
                'requestedAt',
                'processedAt',
                'processedBy',
                'processReason'
              ])
            )
          if (Array.isArray(clean.rejections))
            result.rejections = clean.rejections.map((row) =>
              pick(row, ['id', 'playerId', 'reason', 'rejectedAt'])
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
                'previousSubmissionId',
                'source',
                'correctedBy',
                'correctionReason'
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
            'reason',
            'paymentMethod',
            'weekStart',
            'requestId',
            'canceledAt',
            'processedBy'
          ])
          if (value.paymentSnapshot && typeof value.paymentSnapshot === 'object')
            result.paymentSnapshot = {
              ...pick(value.paymentSnapshot, ['method', 'updatedAt']),
              qrCode: safeAttachment(value.paymentSnapshot.qrCode)
            }
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
        case 'work-schedule':
          return can(user, 'attendance.manage') ||
            can(user, 'salary.all') ||
            value.userId === user.id
            ? pick(value, [
                'id',
                'userId',
                'effectiveFrom',
                'enabled',
                'start',
                'end',
                'remark',
                'updatedAt',
                'updatedBy'
              ])
            : null
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
        case 'player-content':
          return can(user, 'settings.manage') ? clone(value) : null
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
        case 'customer-transaction':
        case 'player-deposit-transaction': {
          if (
            log.entity === 'customer-transaction'
              ? !can(user, 'finance.refunds')
              : !depositVisible(user, value.accountId)
          )
            return null
          return {
            ...pick(value, [
              'id',
              'accountId',
              'kind',
              'amount',
              'delta',
              'balanceAfter',
              'reason',
              'orderId',
              'createdAt',
              'createdBy',
              'createdByName',
              'requestId',
              'exitType'
            ]),
            receipt: safeAttachment(value.receipt)
          }
        }
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
            ? pick(value, ['action', 'beforeDate', 'reason', 'affectedRows', 'candidateRows'])
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
  function walletBatch(state) {
    const map = new Map(
      state.users
        .filter((row) => row.role === 'player')
        .map((row) => [row.id, { userId: row.id, earned: 0, occupied: 0, paid: 0, available: 0 }])
    )
    for (const row of state.rewardCredits)
      if (map.has(row.userId)) map.get(row.userId).earned += row.amount
    for (const row of state.playerAdjustments)
      if (map.has(row.userId))
        map.get(row.userId).earned +=
          row.kind === 'supplement' ? row.appliedAmount : -row.appliedAmount
    for (const row of state.withdrawals)
      if (map.has(row.userId)) {
        if (['pending', 'approved'].includes(row.status)) map.get(row.userId).occupied += row.amount
        else if (row.status === 'paid') map.get(row.userId).paid += row.amount
      }
    for (const row of map.values())
      row.available = Math.max(0, row.earned - row.occupied - row.paid)
    return map
  }
  const emptyReports = (month) => ({
    month,
    days: [],
    channels: [],
    performance: [],
    payroll: [],
    monthlyBase: null,
    monthlyProfit: null
  })
  function naturalWeek(value) {
    const date = shanghaiDate(value)
    const midnight = new Date(`${date}T00:00:00+08:00`)
    const day = new Date(`${date}T00:00:00Z`).getUTCDay()
    return shanghaiDate(new Date(midnight.getTime() - ((day + 6) % 7) * 86400000))
  }
  function paymentMethods(state, userId) {
    return clone(Object.values(state.playerPaymentMethods?.[userId] || {}))
  }
  function playerWalletSummary(state, user) {
    const weekStart = naturalWeek(now())
    const weeklyUsed = state.withdrawals.filter(
      (row) =>
        row.userId === user.id &&
        ['pending', 'approved', 'paid'].includes(row.status) &&
        (row.weekStart || naturalWeek(row.createdAt)) === weekStart
    ).length
    return clone({
      ...wallet(state, user.id),
      withdrawals: [],
      ledger: [],
      weeklyLimit: 7,
      weeklyUsed,
      weeklyRemaining: Math.max(0, 7 - weeklyUsed),
      weekStart,
      paymentMethods: paymentMethods(state, user.id)
    })
  }
  function playerLedgerRows(state, user) {
    const withdrawals = state.withdrawals.filter((row) => row.userId === user.id)
    const orderNumbers = new Map(state.orders.map((order) => [order.id, order.orderNo]))
    const ledger = state.playerRewardLedger
      .filter((row) => row.userId === user.id)
      .map((row) => ({
        id: `reward:${row.id}`,
        kind: row.kind,
        amount: row.amount,
        delta: row.delta,
        createdAt: row.createdAt,
        snapshotAt: row.snapshotAt,
        orderId: row.orderId,
        orderNo: orderNumbers.get(row.orderId),
        reason: row.reason
      }))
    for (const row of state.playerAdjustments.filter((row) => row.userId === user.id))
      ledger.push({
        id: `adjustment:${row.id}`,
        kind: row.kind,
        amount: row.appliedAmount,
        delta: row.kind === 'supplement' ? row.appliedAmount : -row.appliedAmount,
        createdAt: row.createdAt,
        orderId: row.orderId,
        reason: row.reason,
        manualAmount: row.manualAmount,
        status: row.status
      })
    for (const row of withdrawals) {
      ledger.push({
        id: `withdrawal:${row.id}`,
        withdrawalId: row.id,
        kind: 'withdrawal-request',
        amount: row.amount,
        delta: -row.amount,
        createdAt: row.createdAt,
        reason: '提现申请占用可用报酬',
        status: row.status
      })
      if (['rejected', 'canceled'].includes(row.status))
        ledger.push({
          id: `withdrawal-release:${row.id}`,
          withdrawalId: row.id,
          kind: row.status === 'canceled' ? 'withdrawal-canceled' : 'withdrawal-rejected',
          amount: row.amount,
          delta: row.amount,
          createdAt: row.canceledAt || row.processedAt,
          reason: row.reason || '撤回提现，释放占用报酬'
        })
      if (row.status === 'paid')
        ledger.push({
          id: `withdrawal-paid:${row.id}`,
          withdrawalId: row.id,
          kind: 'withdrawal-paid',
          amount: row.amount,
          delta: 0,
          createdAt: row.paidAt,
          reason: '财务已登记发放'
        })
    }
    ledger.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return ledger.reverse()
  }
  function playerWalletData(state, user, input = {}) {
    const summary = playerWalletSummary(state, user)
    if (input.includeRecords === false) return summary
    return clone({
      ...summary,
      withdrawals: state.withdrawals.filter((row) => row.userId === user.id),
      ledger: playerLedgerRows(state, user)
    })
  }
  function financialPage(rows, input) {
    const { current, size } = accountPage(input)
    const start = input.start ? validDate(input.start) : ''
    const end = input.end ? validDate(input.end) : ''
    if (start && end && start > end) fail('开始日期不能晚于结束日期')
    const filtered = rows
      .filter((row) => {
        if (!start && !end) return true
        const date = row.createdAt ? shanghaiDate(row.createdAt) : ''
        return date && (!start || date >= start) && (!end || date <= end)
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    return clone({
      records: filtered.slice((current - 1) * size, current * size),
      total: filtered.length,
      current,
      size
    })
  }
  function obsoleteReturns(order, actorId) {
    for (const row of order.returnRequests || [])
      if (row.status === 'pending')
        Object.assign(row, {
          status: 'obsolete',
          processedAt: now(),
          processedBy: actorId,
          processReason: '订单状态或负责人已变更，本次退单申请失效'
        })
  }
  function settleReward(state, order, user) {
    restoreStatusReward(state, order, user)
    const allocations = new Map()
    if (order.leaderId && order.reward > 0) {
      if (order.teammateId) {
        allocations.set(order.leaderId, Math.ceil(order.reward / 2))
        allocations.set(order.teammateId, Math.floor(order.reward / 2))
      } else allocations.set(order.leaderId, order.reward)
    }
    const existing = state.rewardCredits.filter((row) => row.orderId === order.id)
    const priorAmounts = new Map(existing.map((row) => [row.id, row.amount]))
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
    for (const row of state.rewardCredits.filter((row) => row.orderId === order.id)) {
      const delta = row.amount - (priorAmounts.get(row.id) || 0)
      if (!delta) continue
      const correction = priorAmounts.has(row.id)
      state.playerRewardLedger.push({
        id: id(),
        orderId: order.id,
        userId: row.userId,
        kind: correction ? 'reward-correction' : 'reward',
        amount: Math.abs(delta),
        delta,
        createdAt: now(),
        reason: correction ? '订单报酬财务更正' : '订单报酬结算'
      })
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
      otherIncome: 0,
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
    for (const row of funds.income(month))
      days[Number(row.date.slice(8)) - 1].otherIncome += row.amount
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
        : day.net +
          day.otherIncome -
          day.reward -
          day.supportCommission -
          day.operationsCommission -
          day.expenses
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

  function bootstrap(
    userId,
    month,
    { exportMode = false, includeOrders = true, includeReports = true, modules, stateSnapshot,
      reportOnly = false } = {}
  ) {
    const state = stateSnapshot || read(),
      user = find(state, 'users', userId, '账号')
    if (user.status !== 'active') fail('账号已停用', 403)
    month = validMonth(month || shanghaiDate(now()).slice(0, 7))
    if (user.role === 'player') {
      requirePlayer(user)
      return clone({
        user: publicStaff(state, user),
        permissions: permissionsFor(user),
        roleDefaults: DEFAULT_PERMISSIONS,
        appearance: appearanceFor(state),
        users: state.users
          .filter((row) => row.id === user.id || (row.role === 'player' && row.status === 'active'))
          .map((row) =>
            row.id === user.id
              ? publicStaff(state, row)
              : {
                  id: row.id,
                  name: row.name,
                  role: row.role,
                  status: row.status,
                  avatar: row.avatar
                }
          ),
        customers: [],
        platforms: [],
        shops: [],
        levels: state.levels,
        templates: [],
        orders: state.orders
          .filter((order) => visibleOrder(state, user, order))
          .map((order) => playerOrder(state, user, order)),
        refunds: [],
        withdrawals: state.withdrawals.filter((row) => row.userId === user.id),
        expenses: [],
        attendance: [],
        workSchedules: [],
        salaryPlans: [],
        payrolls: [],
        logs: [],
        playerAdjustments: state.playerAdjustments.filter((row) => row.userId === user.id),
        rewardReviews: [],
        customerBalances: [],
        playerDeposits: [{ userId: user.id, balance: funds.balance('deposit', user.id) }],
        wallets: [wallet(state, user.id)],
        reports: {
          month,
          days: [],
          channels: [],
          performance: [],
          payroll: [],
          monthlyBase: null,
          monthlyProfit: null
        },
        demo: state.demo
      })
    }
    const reportModules = [
      'overview',
      'days',
      'channels',
      'performance',
      'payroll',
      'payrollHistory'
    ]
    const needsReports =
      includeReports &&
      (can(user, 'profit.view') || can(user, 'salary.view') || can(user, 'salary.all')) &&
      (!modules || modules.some((key) => reportModules.includes(key)))
    const result = needsReports ? reports(state, month) : emptyReports(month)
    if (includeReports && !needsReports && can(user, 'orders.view')) {
      const own = state.orders.filter(
        (o) =>
          o.status === 'completed' &&
          paidOrder(o) &&
          shanghaiDate(o.completedAt).startsWith(month) &&
          (user.role === 'operations'
            ? o.commissionSnapshot?.operationsId === user.id
            : o.creatorId === user.id)
      )
      result.performance = [
        {
          userId: user.id,
          name: user.name,
          orders: own.length,
          completed: own.length,
          net: own.reduce((sum, o) => sum + netOrder(state, o), 0)
        }
      ]
    }
    const viewSalary = can(user, 'salary.view') || can(user, 'salary.all'),
      allSalary = can(user, 'salary.all'),
      viewProfit = can(user, 'profit.view')
    const salaryVisible = (row) => viewSalary && (allSalary || row.userId === user.id)
    if (!viewProfit) {
      result.days = []
      result.channels = []
      result.monthlyProfit = null
      result.monthlyBase = null
    }
    if (!allSalary && !viewProfit)
      result.performance = result.performance.filter((p) => p.userId === user.id)
    result.payroll = result.payroll.filter(salaryVisible)
    // Internal overview reads need monthly reports, not another full business projection.
    if (reportOnly) return { reports: clone(result) }
    const orderRows = state.orders.filter((o) => visibleOrder(state, user, o))
    const orderIds = new Set(orderRows.map((o) => o.id))
    const counts = staffOrderCounts(state)
    const balances = funds.accounts()
    const customerBalances = new Map(
      balances.filter((row) => row.type === 'customer').map((row) => [row.accountId, row.balance])
    )
    const depositBalances = new Map(
      balances.filter((row) => row.type === 'deposit').map((row) => [row.accountId, row.balance])
    )
    const wallets = walletBatch(state)
    const visibleUsers = state.users
      .map((row) => publicStaff(state, row, counts))
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
      user: publicStaff(state, user, counts),
      dataVersion: state.dataVersion || 1,
      orderCounts: orderCounts(orderRows),
      skipReportComputation: !needsReports,
      permissions: permissionsFor(user),
      roleDefaults: DEFAULT_PERMISSIONS,
      appearance: appearanceFor(state),
      users: visibleUsers,
      customers:
        user.role === 'player' && !can(user, 'orders.view')
          ? []
          : can(user, 'orders.view') || can(user, 'orders.create') || can(user, 'users.manage')
            ? state.customers.map((row) => publicCustomer(row, customerBalances))
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
      orders: includeOrders ? orderRows.map((order) => safeOrder(state, user, order)) : [],
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
      workSchedules: state.workSchedules.filter(
        (row) => can(user, 'attendance.manage') || allSalary || row.userId === user.id
      ),
      salaryPlans: state.salaryPlans.filter(salaryVisible),
      payrolls: viewSalary
        ? state.payrolls
            .map((p) => ({ ...p, lines: p.lines.filter(salaryVisible) }))
            .filter((p) => p.lines.length)
        : [],
      logs:
        modules && !modules.includes('logs')
          ? []
          : auditStore
              .rows({
                source: exportMode ? 'all' : 'hot',
                limit: exportMode ? 100001 : 1000,
                omitEntities: [
                  ...(allSalary && viewProfit ? [] : ['salary-plan', 'payroll']),
                  ...(can(user, 'settings.manage') ? [] : ['player-content'])
                ]
              })
              .filter(
                (log) =>
                  can(user, 'logs.view') || (log.entity === 'order' && orderIds.has(log.entityId))
              )
              .map((log) => safeAuditLog(state, user, log))
              .filter(Boolean),
      playerAdjustments: state.playerAdjustments.filter(
        (row) => can(user, 'finance.withdrawals') || row.userId === user.id
      ),
      rewardReviews: can(user, 'finance.withdrawals') ? state.rewardReviews : [],
      customerBalances: customerAccountVisible(user)
        ? state.customers.map((row) => ({
            customerId: row.id,
            balance: customerBalances.get(row.id) || 0
          }))
        : [],
      playerDeposits: state.users
        .filter((row) => row.role === 'player' && depositVisible(user, row.id))
        .map((row) => ({ userId: row.id, balance: depositBalances.get(row.id) || 0 })),
      reports: result,
      wallets: state.users
        .filter(
          (u) => u.role === 'player' && (can(user, 'finance.withdrawals') || u.id === user.id)
        )
        .map((u) => wallets.get(u.id)),
      demo: state.demo
    }
    return clone(rows)
  }

  function overviewRead(state, user, dates) {
    const snapshots = overviewMonths(dates).map((month, index) =>
      index === 0
        ? bootstrap(user.id, month, { stateSnapshot: state, modules: ['overview'] })
        : { ...bootstrap(user.id, month, {
            stateSnapshot: state, modules: ['overview'], reportOnly: true
          }), orders: [], refunds: [] })
    const personalOrders = can(user, 'orders.view')
      ? state.orders.filter((order) => order.status === 'completed' && paidOrder(order) &&
          (user.role === 'operations'
            ? order.commissionSnapshot?.operationsId === user.id
            : order.creatorId === user.id))
      : []
    if (can(user, 'orders.view')) {
      // Only the current actor's attribution is projected, including ordinary operations roles.
      const personalPerformance = personalOrders.map((order) => ({
        date: shanghaiDate(order.completedAt), net: netOrder(state, order)
      }))
      for (const snapshot of snapshots) snapshot.personalPerformance = personalPerformance
    }
    return { snapshots, personalOrders, overview: buildOverviewReport(snapshots, dates, now()) }
  }

  function diagnosticsReport(state) {
    return buildDiagnosticsReport({ state,
      customerReferences: db.prepare('SELECT * FROM customer_order_references').all().map(publicReference),
      uploadIds: db.prepare('SELECT id FROM uploads').all().map(row => row.id),
      fundAccounts: funds.accounts(), fundTransactions: funds.diagnosticRows(), now: now() })
  }

  const playerListRecord = (state, user, row) => ({
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    status: row.status,
    levelId: row.levelId,
    maxActiveOrders: row.maxActiveOrders,
    activeOrders: activeCount(state, row.id),
    playerAccess: playerAccess(row),
    ...(can(user, 'finance.withdrawals')
      ? { wallet: wallet(state, row.id), depositBalance: funds.balance('deposit', row.id) }
      : {})
  })
  const participatedPlayerOrder = (row, targetId) => row.leaderId === targetId ||
    row.teammateId === targetId || row.assignedTo === targetId ||
    row.assignments.some((entry) => entry.leaderId === targetId) ||
    row.submissions.some((entry) => entry.leaderId === targetId || entry.teammateId === targetId)

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
  function validateDispatchTarget(state, targetId) {
    const target = find(state, 'users', validateTarget(state, targetId))
    const access = playerAccess(target)
    if (!access.login || !access.claim) fail('该打手未开放登录或接单，不能新指派')
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
    const assignedTo =
      dispatchMode === 'direct' ? validateDispatchTarget(state, body.assignedTo) : null
    const paymentMethod = choice(body.paymentMethod || 'cash', ['cash', 'balance'], '付款方式')
    if (paymentMethod === 'balance' && body.payOnArrival) fail('储值支付不支持落地付')
    if (body.payOnArrival && !rules.allowPayOnArrival)
      fail('当前平台不允许落地付，请先确认客户付款')
    let payment = { receivedAmount: 0, paidAt: null, receivedAt: null, receipt: null }
    if (paymentMethod === 'balance')
      payment = { receivedAmount: amount, paidAt: now(), receivedAt: now(), receipt: null }
    else if (!body.payOnArrival || Number(body.receivedAmount) > 0)
      payment = paymentData(state, user, body, platform)
    if (payment.receivedAmount && payment.receivedAmount !== amount)
      fail('普通订单派单前须确认全额收款；金额应与实收一致')
    const order = {
      id: id(),
      revision: 1,
      dispatchRound: 1,
      assignmentId: null,
      submissionId: null,
      playerRemark: text(body.playerRemark, '打手备注'),
      payOnArrival: Boolean(body.payOnArrival),
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
      paymentMethod,
      status: 'pending',
      dispatchMode,
      dispatchState: 'ready',
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
    if (paymentMethod === 'balance') balancePayment(state, user, order, body)
    state.orders.push(order)
    audit(state, user, '创建订单', 'order', order.id, null, order)
    return safeOrder(state, user, order)
  }
  function orderAction(state, user, orderId, body) {
    const order = find(state, 'orders', orderId, '订单'),
      before = clone(order)
    const action = body.action
    if (['return-approve', 'return-reject'].includes(action)) {
      requirePermission(user, 'orders.edit')
      if (user.role === 'player') fail('打手不能处理退单申请', 403)
      const request = (order.returnRequests || []).find((row) => row.id === body.returnRequestId)
      if (!request) fail('退单申请不存在，请刷新订单', 404)
      if (
        request.status !== 'pending' ||
        order.status !== 'active' ||
        order.leaderId !== request.leaderId
      )
        fail('退单申请已处理或订单状态已变化，请刷新订单', 409)
      const reason = requiredReason(body)
      Object.assign(request, {
        status: action === 'return-approve' ? 'approved' : 'rejected',
        processedAt: now(),
        processedBy: user.id,
        processReason: reason
      })
      if (action === 'return-approve') {
        const assignment = order.assignments.findLast((row) => !row.releasedAt)
        if (assignment)
          Object.assign(assignment, {
            releasedAt: now(),
            reason: request.reason,
            returnRequestId: request.id
          })
        Object.assign(order, {
          status: 'pending',
          dispatchState: 'unassigned',
          assignedTo: null,
          leaderId: null,
          teammateId: null
        })
      }
      advanceOrderIdentity(order, before, action)
      audit(state, user, `订单：${action}`, 'order', order.id, before, order)
      return safeOrder(state, user, order)
    }
    if (order.paymentMethod === 'balance') {
      if (
        (Object.hasOwn(body, 'amount') && body.amount !== order.amount) ||
        (Object.hasOwn(body, 'receivedAmount') && body.receivedAmount !== order.receivedAmount) ||
        (Object.hasOwn(body, 'paymentMethod') && body.paymentMethod !== 'balance')
      )
        fail('储值支付订单不能直接更改客户金额、实收或付款方式，请通过独立退款/更正流程处理', 409)
      if (action === 'edit' && body.customerId && body.customerId !== order.balanceCustomerId)
        fail('储值支付订单不能更换付款客户', 409)
    }
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
        if (find(state, 'users', leaderId, '打手').role !== 'player')
          fail('实际负责人必须是打手账号')
      const hasSettledReward = state.rewardCredits.some(
        (row) => row.orderId === order.id && row.amount > 0
      )
      const priorSettlement = state.statusCorrectionReversals[order.id]
      const resolvedTeammate = Object.hasOwn(body, 'teammateId')
        ? body.teammateId
        : (order.teammateId ?? priorSettlement?.teammateId)
      if (
        ['active', 'review', 'completed'].includes(next) &&
        hasSettledReward &&
        (leaderId !== (priorSettlement?.leaderId || order.leaderId) ||
          (resolvedTeammate ?? null) !==
            (priorSettlement ? priorSettlement.teammateId : order.teammateId))
      )
        fail('已结算订单不能直接更换结算打手，请先由财务处理原打手与新打手的扣补款差额', 409)
      if (next === 'completed' && (!paidOrder(order) || order.receivedAmount !== order.amount))
        fail('完成前必须确认客户足额收款')
      if (
        (['completed', 'canceled'].includes(order.status) || order.compensationSettled) &&
        hasSettledReward
      )
        reverseStatusReward(state, order, user, reason)
      if (
        order.status === 'canceled' &&
        !hasSettledReward &&
        order.reward === 0 &&
        Number.isSafeInteger(order.rewardBeforeCancellation)
      )
        order.reward = order.rewardBeforeCancellation
      if (['active', 'review', 'completed'].includes(next)) {
        if (order.leaderId !== leaderId || !order.assignments.some((row) => !row.releasedAt)) {
          const old = order.assignments.findLast((row) => !row.releasedAt)
          if (old) Object.assign(old, { releasedAt: now(), reason })
          order.assignments.push({ leaderId, acceptedAt: now(), correctedBy: user.id })
        }
        order.leaderId = leaderId
        if (resolvedTeammate === leaderId) fail('队友不能与负责人相同')
        if (resolvedTeammate && find(state, 'users', resolvedTeammate, '队友').role !== 'player')
          fail('队友必须是打手账号')
        order.teammateId = resolvedTeammate || null
      }
      if (next === 'review') {
        const previous = order.submissions.at(-1)
        const sameParticipants =
          previous?.leaderId === order.leaderId &&
          (previous?.teammateId ?? null) === order.teammateId
        if (!previous || previous.review || !sameParticipants || !previous.screenshots.length) {
          const retainedMaterials = (previous?.screenshots || []).filter(image => !deletedImageRecord(db, image.id))
          const reuseMaterials = sameParticipants && retainedMaterials.length > 0
          order.submissions.push({
            id: id(),
            submittedAt: reuseMaterials ? previous.submittedAt : now(),
            leaderId: order.leaderId,
            teammateId: order.teammateId,
            screenshots: reuseMaterials ? clone(retainedMaterials) : [],
            source: 'status-correction',
            correctedBy: user.id,
            correctionReason: reason,
            ...(reuseMaterials
              ? {
                  previousSubmissionId: previous.id,
                  recheckBy: user.id,
                  recheckedAt: now(),
                  recheckReason: reason
                }
              : {})
          })
        }
      }
      order.status = next
      order.dispatchState = 'ready'
      if (next !== 'canceled') {
        order.compensationPending = false
        if (!hasSettledReward || next === 'completed') order.compensationSettled = false
      }
      if (next === 'pending') {
        const active = order.assignments.findLast((row) => !row.releasedAt)
        if (active) Object.assign(active, { releasedAt: now(), reason })
        order.leaderId = null
        order.teammateId = null
        order.assignedTo = null
        order.dispatchMode = 'pool'
        order.dispatchState = 'ready'
        order.publishedAt = now()
      }
      if (next === 'completed') {
        order.completedAt ||= state.statusCorrectionReversals[order.id]?.completedAt || now()
        snapshotCommission(state, order)
        settleReward(state, order, user)
        let submission = order.submissions.at(-1)
        if (
          !submission ||
          submission.review ||
          submission.leaderId !== order.leaderId ||
          (submission.teammateId ?? null) !== order.teammateId
        ) {
          submission = {
            id: id(),
            submittedAt: now(),
            leaderId: order.leaderId,
            teammateId: order.teammateId,
            screenshots: [],
            source: 'status-correction',
            correctedBy: user.id,
            correctionReason: reason
          }
          order.submissions.push(submission)
        }
        Object.assign(submission, { review: 'passed', reviewedAt: now(), reviewerId: user.id })
      } else if (next === 'canceled') {
        order.rewardBeforeCancellation = order.reward
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
        if (
          !submission.screenshots.length &&
          !(
            submission.source === 'status-correction' &&
            submission.correctedBy &&
            submission.correctionReason
          )
        )
          fail('完成截图或后台状态更正记录不能为空')
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
      validateCashCorrection(order, body, amount)
      if (
        amount <
        state.refunds
          .filter((r) => r.orderId === order.id && r.status !== 'rejected')
          .reduce((sum, r) => sum + r.amount, 0)
      )
        fail('更正金额不能小于累计及在途退款')
      order.amount = amount
      order.reward = reward
      if (order.status === 'canceled') order.rewardBeforeCancellation = reward
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
      order.rewardBeforeCancellation = order.reward
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
      if (action === 'remark') {
        if (Object.hasOwn(body, 'remark')) order.remark = text(body.remark, '内部备注')
        if (Object.hasOwn(body, 'playerRemark'))
          order.playerRemark = text(body.playerRemark, '打手备注')
      } else if (action === 'edit') {
        if (['completed', 'canceled'].includes(order.status))
          fail('已完成或已取消订单请使用财务金额更正；备注可单独修改', 409)
        for (const [key, label] of [
          ['roomCode', '房间码'],
          ['gameId', '客户游戏ID'],
          ['map', '地图'],
          ['channel', '成交渠道'],
          ['remark', '内部备注'],
          ['playerRemark', '打手备注']
        ])
          if (body[key] !== undefined)
            order[key] = text(body[key], label, { max: key === 'remark' ? 2000 : 128 })
        if (!order.roomCode && !order.gameId) fail('房间码与客户游戏ID至少填写一项')
        if (body.amount !== undefined || body.reward !== undefined) {
          requiredReason(body)
          if (body.amount !== undefined) {
            validateCashCorrection(order, body, body.amount)
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
        }
      } else if (action === 'confirm-payment') {
        if (order.status === 'canceled') fail('已取消订单不能确认收款', 409)
        if (paidOrder(order)) fail('该订单已确认收款，不能重复入账', 409)
        const requestedMethod = choice(
          body.paymentMethod || 'cash',
          ['cash', 'balance'],
          '付款方式'
        )
        if (requestedMethod === 'balance') balancePayment(state, user, order, body)
        else {
          const payment = paymentData(state, user, body, find(state, 'platforms', order.platformId))
          if (payment.receivedAmount !== order.amount) fail('实收金额须与订单金额一致')
          Object.assign(order, payment)
          order.paymentMethod = 'cash'
        }
      } else if (action === 'dispatch') {
        if (order.status !== 'pending') fail('只有待接单订单可以派单', 409)
        order.dispatchMode = choice(body.dispatchMode, ['pool', 'direct'], '派单方式')
        order.assignedTo =
          order.dispatchMode === 'direct' ? validateDispatchTarget(state, body.assignedTo) : null
        order.dispatchState = 'ready'
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
        order.dispatchState = 'ready'
        order.publishedAt = now()
      } else if (action === 'cancel') {
        const reason = requiredReason(body)
        if (order.status === 'canceled') fail('订单已经取消', 409)
        if (order.status === 'completed') requirePermission(user, 'finance.review')
        order.canceledFrom = order.status
        order.rewardBeforeCancellation = order.reward
        order.status = 'canceled'
        order.dispatchState = 'ready'
        order.canceledAt = now()
        order.cancelReason = reason
        order.compensationPending = order.assignments.length > 0
        order.compensationSettled = !order.compensationPending
        if (!order.compensationPending) order.reward = 0
        recordCommissionAdjustment(state, order, order.id, reason)
      } else fail('未知订单操作')
    }
    if (
      order.status !== 'active' ||
      before.leaderId !== order.leaderId ||
      action === 'correct-status'
    )
      obsoleteReturns(order, user.id)
    advanceOrderIdentity(order, before, action)
    audit(
      state,
      user,
      `订单：${action}${body.reason ? ` · ${text(body.reason, '原因')}` : ''}${body.amount !== undefined && before.amount !== order.amount && order.paymentMethod !== 'balance' ? ` · ${body.amountChangeKind === 'historical-correction' ? '历史录错更正' : '未收款改价'}（${body.affectsHistoricalReceived ? '同步原实收及原付款日统计' : '不改变历史实收'}）` : ''}`,
      'order',
      order.id,
      before,
      order
    )
    return safeOrder(state, user, order)
  }

  function markRefund(state, user, refund, requestId = refund.requestId) {
    const order = find(state, 'orders', refund.orderId)
    if (paidRefunds(state, order.id) + refund.amount > order.receivedAmount)
      fail('退款总额不能超过实收金额', 409)
    refund.status = 'paid'
    if (order.paymentMethod === 'balance') {
      const customerId = order.balanceCustomerId || order.customerId
      find(state, 'customers', customerId, '原储值付款客户')
      const row = funds.append({
        type: 'customer',
        accountId: customerId,
        kind: 'order-refund',
        amount: refund.amount,
        direction: 1,
        reason: refund.reason,
        orderId: order.id,
        actor: user,
        requestId,
        sourceId: `order-refund:${refund.id}`,
        now: now(),
        id: id()
      })
      refund.refundMethod = 'balance'
      refund.balanceTransactionId = row.id
    } else refund.refundMethod = 'cash'
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
      createdAt: now(),
      ...(body.requestId ? { requestId: body.requestId } : {})
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
      if (body.action === 'approve') markRefund(state, user, refund, body.requestId)
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

  function orderCounts(rows) {
    const counts = {
      all: rows.length,
      pending: 0,
      active: 0,
      review: 0,
      completed: 0,
      canceled: 0,
      unassigned: 0,
      'return-pending': 0,
      unpaid: 0,
      compensation: 0
    }
    for (const row of rows) {
      counts[row.status]++
      if (row.status === 'pending' && row.dispatchState === 'unassigned') counts.unassigned++
      if ((row.returnRequests || []).some((r) => r.status === 'pending')) counts['return-pending']++
      if (row.status !== 'canceled' && !paymentConfirmed(row)) counts.unpaid++
      if (row.compensationPending && !row.compensationSettled) counts.compensation++
    }
    return counts
  }
  function orderPage(state, user, input) {
    const { current, size } = accountPage(input)
    const keyword = text(input.keyword, '订单搜索', { max: 100 }).toLowerCase()
    const sortBy = choice(input.sortBy || 'createdAt', ['createdAt', 'participatedAt'], '排序字段')
    const sortOrder = choice(input.sortOrder || 'desc', ['asc', 'desc'], '排序方向')
    const start = input.start ? validDate(input.start) : ''
    const end = input.end ? validDate(input.end) : ''
    if (start && end && start > end) fail('开始日期不能晚于结束日期')
    const dateKey = choice(input.dateKey || 'createdAt', ['createdAt', 'paidAt', 'completedAt'], '订单日期口径')
    if (user.role === 'player' && dateKey === 'paidAt')
      fail('打手订单不支持客户付款日期筛选', 403)
    if (input.scope && !['all', 'mine', 'direct', 'pool'].includes(input.scope))
      fail('订单范围无效')
    if (
      user.role === 'player' &&
      ['platformId', 'shopId', 'customerName', 'contact', 'creatorId'].some((key) => input[key])
    )
      fail('打手订单不支持内部客户筛选', 403)
    const customers = new Map(state.customers.map((r) => [r.id, r]))
    const rows = state.orders
      .filter((order) => {
        if (!visibleOrder(state, user, order)) return false
        if (input.scope === 'mine' && !hasPlayerParticipation(order, user.id))
          return false
        if (['direct', 'pool'].includes(input.scope) && order.dispatchMode !== input.scope)
          return false
        if (
          keyword &&
          ![order.title, order.orderNo].some((value) =>
            String(value || '').toLowerCase().includes(keyword)
          )
        )
          return false
        const fields = {
          orderNo: order.orderNo,
          externalOrderNo: order.externalOrderNo,
          title: order.title,
          customerName: customers.get(order.customerId)?.name,
          contact: customers.get(order.customerId)?.contact,
          gameId: order.gameId,
          roomCode: order.roomCode
        }
        if (
          user.role !== 'player' &&
          Object.entries(fields).some(
            ([key, value]) =>
              input[key] &&
              !String(value || '')
                .toLowerCase()
                .includes(String(input[key]).toLowerCase())
          )
        )
          return false
        if (
          ['platformId', 'shopId', 'leaderId', 'creatorId'].some(
            (key) => input[key] && order[key] !== input[key]
          )
        )
          return false
        if ((input.payment || input.paymentStatus) === 'paid' && !paymentConfirmed(order))
          return false
        if ((input.payment || input.paymentStatus) === 'unpaid' && paymentConfirmed(order))
          return false
        if (start || end) {
          const value = order[dateKey] ? shanghaiDate(order[dateKey]) : ''
          if (
            !value ||
            (start && value < start) ||
            (end && value > end)
          )
            return false
        }
        return true
      })
      .sort((a, b) => {
        const value = (row) =>
          sortBy === 'participatedAt' ? lastPlayerParticipation(row, user.id) || '' : row.createdAt
        const direction = sortOrder === 'asc' ? 1 : -1
        return (value(a).localeCompare(value(b)) || a.id.localeCompare(b.id)) * direction
      })
    const counts = orderCounts(rows)
    const filtered = rows.filter(
      (row) =>
        !input.status ||
        input.status === 'all' ||
        (input.status === 'unassigned'
          ? row.status === 'pending' && row.dispatchState === 'unassigned'
          : input.status === 'return-pending'
            ? row.returnRequests?.some((r) => r.status === 'pending')
            : row.status === input.status)
    )
    return {
      records: filtered
        .slice((current - 1) * size, current * size)
        .map((row) => safeOrder(state, user, row)),
      total: filtered.length,
      current,
      size,
      counts
    }
  }
  function validateCashCorrection(order, body, amount) {
    if (order.paymentMethod === 'balance' || amount === order.amount) return
    if (
      !['historical-correction', 'price-change'].includes(body.amountChangeKind) ||
      typeof body.affectsHistoricalReceived !== 'boolean'
    )
      conflict('PRECONDITION_REQUIRED', '金额更正须明确是否影响历史实收及统计，并填写原因')
    requiredReason(body)
    if (
      paidOrder(order) &&
      (body.amountChangeKind !== 'historical-correction' || !body.affectsHistoricalReceived)
    )
      conflict(
        'PAYMENT_ADJUSTMENT_REQUIRED',
        '已收款订单不能用普通改价代替追加收费或退款；历史录错更正须明确确认同步原实收'
      )
    if (!paidOrder(order) && body.affectsHistoricalReceived)
      conflict('PAYMENT_ADJUSTMENT_REQUIRED', '未收款订单改价不能生成历史实收')
  }
  const isCriticalWrite = (path) =>
    /^\/(?:orders(?:\/[^/]+\/action)?|refunds(?:\/[^/]+\/action)?|withdrawals\/[^/]+\/action|expenses(?:\/[^/]+\/action)?|payrolls|player-adjustments(?:\/[^/]+\/action)?|reward-reviews\/[^/]+\/action|customer-transactions|player-deposit-transactions|player\/orders\/[^/]+\/(?:claim|reject|submit|return-request)|player\/withdrawals(?:\/[^/]+\/cancel)?)$/.test(
      path
    )
  function authorizeCriticalWrite(state, user, path, body) {
    if (path.startsWith('/player/')) {
      requirePlayer(user)
      if (path.endsWith('/claim') && !playerAccess(user).claim)
        fail('当前打手账号已关闭新接单', 403)
      if (path === '/player/withdrawals' && !playerAccess(user).withdraw)
        fail('当前打手账号已关闭新提现申请', 403)
      const orderTarget = path.match(/^\/player\/orders\/([^/]+)\//)
      const priorOrderWrite =
        orderTarget && typeof body.requestId === 'string'
          ? db
              .prepare('SELECT actor_id,operation FROM business_requests WHERE request_id=?')
              .get(body.requestId)
          : null
      if (orderTarget) {
        const order = find(state, 'orders', orderTarget[1], '订单')
        const ownSuccess = priorOrderWrite?.actor_id === user.id && priorOrderWrite.operation === path
        if (
          (!currentPlayerOrderAccess(state, user, order) &&
            (!path.endsWith('/claim') || ownSuccess)) ||
          (ownSuccess &&
            !path.endsWith('/reject') &&
            ![order.leaderId, order.teammateId].includes(user.id))
        )
          fail('订单不再属于当前操作或私人详情范围，请只读核对原操作结果', 403)
      }
      const withdrawal = path.match(/^\/player\/withdrawals\/([^/]+)\/cancel$/)
      if (withdrawal && find(state, 'withdrawals', withdrawal[1]).userId !== user.id)
        fail('只能撤回本人的提现', 403)
      return
    }
    if (user.role === 'player') fail('此后台操作不向打手开放', 403)
    if (path === '/orders') return requirePermission(user, 'orders.create')
    const order = path.match(/^\/orders\/([^/]+)\/action$/)
    if (order) {
      const target = find(state, 'orders', order[1])
      if (
        body.action === 'correct-status' &&
        !['finance', 'manager', 'owner', 'super_admin'].includes(user.role)
      )
        fail('仅财务、店长、老板或超级管理员可以更正订单状态', 403)
      return requirePermission(
        user,
        ['review-pass', 'review-return', 'adjust', 'cancel-settle'].includes(body.action) ||
          (body.action === 'cancel' &&
            (target.status === 'completed' || target.canceledFrom === 'completed'))
          ? 'finance.review'
          : 'orders.edit'
      )
    }
    if (path === '/refunds')
      return requirePermission(
        user,
        can(user, 'finance.refunds') ? 'finance.refunds' : 'orders.edit'
      )
    if (path.startsWith('/refunds/')) return requirePermission(user, 'finance.refunds')
    if (path.startsWith('/expenses')) return requirePermission(user, 'finance.expenses')
    if (path === '/payrolls') {
      requirePermission(user, 'salary.manage')
      return requirePermission(user, 'salary.all')
    }
    if (path === '/customer-transactions') return requirePermission(user, 'finance.refunds')
    requirePermission(user, 'finance.withdrawals')
  }
  function mutate(userId, path, body = {}, authentication = {}) {
    if (body == null || typeof body !== 'object' || Array.isArray(body))
      fail('请求内容必须为JSON对象')
    return transact(
      userId,
      (state, user, transaction) => {
        const execute = () => {
          const contentResult = mutatePlayerContent({
            db,
            state,
            user,
            path,
            body,
            now: now(),
            audit: (action, entity, entityId, before, after) =>
              audit(state, user, action, entity, entityId, before, after)
          })
          if (contentResult !== undefined) return contentResult
          if (path.startsWith('/player/')) {
            requirePlayer(user)
            if (playerExtraMutate) {
              const extra = playerExtraMutate({
                db,
                state,
                user,
                path,
                body,
                now: now(),
                audit: (action, entity, entityId, before, after) =>
                  audit(state, user, action, entity, entityId, before, after)
              })
              if (extra !== undefined) return extra
            }
          }
          if (path === '/logs/maintenance') {
            requirePermission(user, 'settings.manage')
            requirePermission(user, 'logs.view')
            const archiveRowsBefore =
              body.action === 'archive' ? auditStore.storage().archiveRows : null
            let affectedRows
            if (body.action === 'archive') {
              affectedRows = auditStore.archive()
              if (affectedRows === 0) return { affectedRows: 0, storage: auditStore.storage() }
            } else if (body.action === 'purge-archive') {
              requireBackupAudit(user)
              if (body.backupConfirmed !== true) fail('请先导出并确认已经保存日志备份')
              requiredReason(body)
              checkBackupReceipt(
                user,
                body.backupToken,
                validDate(body.beforeDate, '归档清理截止日期')
              )
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
                ...(body.action === 'archive' ? { candidateRows: affectedRows } : { affectedRows })
              }
            )
            const storage = auditStore.storage()
            if (body.action === 'archive') {
              const candidateRows = affectedRows
              affectedRows = storage.archiveRows - archiveRowsBefore
              return {
                affectedRows,
                candidateRows,
                automaticArchiveRows: affectedRows - candidateRows,
                storage
              }
            }
            return { affectedRows, storage }
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
            return moneyRequest(user, path, body, () =>
              clone(createPlayerAdjustment(state, user, body))
            )
          }
          if (path === '/customer-transactions') return postFund(state, user, body, 'customer')
          if (path === '/player-deposit-transactions') return postFund(state, user, body, 'deposit')
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
            const resolveImage = (value, purpose) => {
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
              if (purpose === 'player-order-card') requireNonPrivateCardImage(state, record.id)
              return image
            }
            const config =
              path === '/appearance/reset'
                ? defaultAppearance()
                : normalizeAppearance(
                    body.config && typeof body.config === 'object' && !Array.isArray(body.config)
                      ? {
                          ...body.config,
                          playerOrderCardImage: Object.hasOwn(body.config, 'playerOrderCardImage')
                            ? body.config.playerOrderCardImage
                            : before.playerOrderCardImage ?? null
                        }
                      : body.config,
                    resolveImage
                  )
            const previousCard = before.playerOrderCardImage ?? null
            const nextCard = config.playerOrderCardImage
            if (
              user.role === 'player' &&
              (Boolean(previousCard) !== Boolean(nextCard) ||
                ['id', 'name', 'mime', 'size', 'url'].some(
                  (key) => previousCard?.[key] !== nextCard?.[key]
                ))
            )
              fail('打手账号不能编辑全局订单卡片图片', 403)
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
            if (Object.hasOwn(body, 'avatar')) {
              const avatar = attachment(state, user, body.avatar)
              if (
                avatar &&
                db
                  .prepare('SELECT 1 FROM player_private_uploads WHERE attachment_id=?')
                  .get(avatar.id)
              )
                fail('收款码不能用作公开头像')
              user.avatar = avatar
            }
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
          if (path === '/orders') {
            requirePermission(user, 'orders.create')
            return safeOrder(
              state,
              user,
              moneyRequest(
                user,
                path,
                body,
                () => createOrder(state, user, body),
                body.paymentMethod === 'balance'
              )
            )
          }
          const orderMatch = path.match(/^\/orders\/([^/]+)\/action$/)
          if (orderMatch) {
            const target = find(state, 'orders', orderMatch[1])
            checkOrderPreconditions(target, body, body.action)
            if (
              body.action === 'correct-status' &&
              !['finance', 'manager', 'owner', 'super_admin'].includes(user.role)
            )
              fail('仅财务、店长、老板或超级管理员可以更正订单状态', 403)
            if (
              body.action === 'cancel' &&
              (target.status === 'completed' || target.canceledFrom === 'completed')
            )
              requirePermission(user, 'finance.review')
            else if (body.action === 'confirm-payment') requirePermission(user, 'orders.edit')
            else if (
              ['adjust', 'cancel-settle', 'review-pass', 'review-return'].includes(body.action)
            )
              requirePermission(user, 'finance.review')
            else requirePermission(user, 'orders.edit')
            return safeOrder(
              state,
              user,
              moneyRequest(
                user,
                path,
                body,
                () => orderAction(state, user, orderMatch[1], body),
                body.action === 'confirm-payment' && body.paymentMethod === 'balance'
              )
            )
          }
          if (path === '/refunds') {
            if (!can(user, 'finance.refunds')) requirePermission(user, 'orders.edit')
            const order = find(state, 'orders', body.orderId, '退款订单')
            return moneyRequest(
              user,
              path,
              body,
              () => refundCreate(state, user, body),
              order.paymentMethod === 'balance'
            )
          }
          const refundMatch = path.match(/^\/refunds\/([^/]+)\/action$/)
          if (refundMatch) {
            requirePermission(user, 'finance.refunds')
            const refund = find(state, 'refunds', refundMatch[1]),
              order = find(state, 'orders', refund.orderId)
            return moneyRequest(
              user,
              path,
              body,
              () => refundAction(state, user, refundMatch[1], body),
              order.paymentMethod === 'balance' && body.action === 'approve'
            )
          }
          const withdrawalMatch = path.match(/^\/withdrawals\/([^/]+)\/action$/)
          if (withdrawalMatch) {
            requirePermission(user, 'finance.withdrawals')
            return moneyRequest(user, path, body, () => {
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
              row.processedBy = user.id
              audit(state, user, `提现：${body.action}`, 'withdrawal', row.id, before, row)
              return clone(row)
            })
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
            if (existing?.role === 'player' && role !== 'player') {
              const currentWallet = wallet(state, existing.id)
              const unfinished = state.orders.some(
                (order) =>
                  (['active', 'review'].includes(order.status) &&
                    (order.leaderId === existing.id || order.teammateId === existing.id)) ||
                  (order.status === 'pending' && order.assignedTo === existing.id) ||
                  (order.compensationPending &&
                    (order.leaderId === existing.id ||
                      order.assignments.some((row) => row.leaderId === existing.id)))
              )
              if (
                funds.balance('deposit', existing.id) > 0 ||
                currentWallet.available > 0 ||
                currentWallet.occupied > 0 ||
                unfinished ||
                state.playerAdjustments.some(
                  (row) => row.userId === existing.id && row.status === 'manual'
                )
              )
                fail(
                  '该打手仍有押金、未提现报酬、在途提现、待追回或未完订单，请先核对结清后再更换角色',
                  409
                )
            }
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
              permissionOverrides: role === 'super_admin' ? {} : overrides,
              ...(role === 'player'
                ? { playerAccess: normalizePlayerAccess(body.playerAccess, existing) }
                : {})
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
            if (
              body.password ||
              status === 'disabled' ||
              existing?.role !== row.role ||
              (role === 'player' && !row.playerAccess.login)
            )
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
            if (
              Object.hasOwn(body, 'balance') &&
              body.balance !== funds.balance('customer', existing?.id || '')
            )
              fail('客户储值余额只能通过财务资金流水修改，不能直接编辑余额')
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
            audit(
              state,
              user,
              existing ? '修改客户' : '新增客户',
              'customer',
              row.id,
              existing,
              row
            )
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
            audit(
              state,
              user,
              existing ? '修改模板' : '新增模板',
              'template',
              row.id,
              existing,
              row
            )
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
          if (path === '/work-schedules') {
            requirePermission(user, 'attendance.manage')
            const employee = find(state, 'users', body.userId, '人员')
            if (employee.status !== 'active') fail('停用人员不能设置新班次')
            const effectiveFrom = validDate(body.effectiveFrom, '生效日期')
            if (effectiveFrom < shanghaiDate(now()))
              fail('固定班次只能从今天或之后生效，历史排班不能改写')
            if (typeof body.enabled !== 'boolean') fail('固定班次启用状态无效')
            const clockValue = (value, label) => {
              if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
                fail(`${label}格式应为有效的HH:mm`)
              return value
            }
            const start = body.enabled ? clockValue(body.start, '上班时间') : ''
            const end = body.enabled ? clockValue(body.end, '下班时间') : ''
            if (body.enabled && start === end)
              fail('上班和下班时间不能相同；跨夜班次请填写次日下班时间')
            const existing = state.workSchedules.find(
              (row) => row.userId === employee.id && row.effectiveFrom === effectiveFrom
            )
            const row = {
              id: existing?.id || id(),
              userId: employee.id,
              effectiveFrom,
              enabled: body.enabled,
              start,
              end,
              remark: text(body.remark, '班次备注', { max: 1000 }),
              updatedAt: now(),
              updatedBy: user.id
            }
            audit(
              state,
              user,
              body.enabled ? '设置个人固定班次' : '取消个人固定班次',
              'work-schedule',
              row.id,
              existing,
              row
            )
            if (existing) state.workSchedules[state.workSchedules.indexOf(existing)] = row
            else state.workSchedules.push(row)
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
            if (date > shanghaiDate(now()) && actualHours !== 0)
              fail('未来排班不能提前登记实际工时')
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
            audit(
              state,
              user,
              existing ? '修改考勤' : '登记考勤',
              'attendance',
              row.id,
              existing,
              row
            )
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
                (p) =>
                  p.month >= effectiveFrom.slice(0, 7) && p.lines.some((l) => l.userId === userId)
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
            if (!playerAccess(user).claim) fail('当前打手账号已关闭新接单', 403)
            const order = find(state, 'orders', claimMatch[1], '订单'),
              before = clone(order)
            checkOrderPreconditions(order, body, 'claim')
            const eligibility = claimEligibility(state, user, order, now())
            if (!eligibility.canClaim)
              throw Object.assign(
                new ApiError(
                  eligibility.reason,
                  ['CLAIM_DISABLED', 'LEVEL_NOT_OPEN', 'NOT_ASSIGNED'].includes(
                    eligibility.reasonCode
                  )
                    ? 403
                    : 409
                ),
                { code: eligibility.reasonCode }
              )
            if (order.status !== 'pending' || order.leaderId) fail('订单已被接取或已经结束', 409)
            if (order.dispatchState === 'unassigned') fail('订单正在等待客服重新分配', 409)
            const level = state.levels.find((row) => row.id === user.levelId)
            if (
              order.dispatchMode === 'direct'
                ? order.assignedTo !== user.id
                : !level ||
                  Date.parse(now()) < Date.parse(order.publishedAt) + level.delaySeconds * 1000
            )
              fail('订单尚未向你的等级开放或未指派给你', 403)
            if (activeCount(state, user.id) >= user.maxActiveOrders) fail('已达到同时接单上限', 409)
            order.status = 'active'
            order.leaderId = user.id
            order.assignments.push({ leaderId: user.id, acceptedAt: now() })
            advanceOrderIdentity(order, before, 'claim')
            audit(state, user, '打手接单', 'order', order.id, before, order)
            return playerOrder(state, user, order)
          }
          const rejectMatch = path.match(/^\/player\/orders\/([^/]+)\/reject$/)
          if (rejectMatch) {
            requirePlayer(user)
            const order = find(state, 'orders', rejectMatch[1], '订单'),
              before = clone(order)
            checkOrderPreconditions(order, body, 'reject')
            if (
              order.status !== 'pending' ||
              order.dispatchState === 'unassigned' ||
              order.dispatchMode !== 'direct' ||
              order.leaderId
            )
              fail('只有尚未接受的指定订单可以拒绝，请刷新订单', 409)
            if (order.assignedTo !== user.id) fail('只能拒绝指定给你的订单', 403)
            const reason = requiredReason(body)
            order.rejections ||= []
            order.rejections.push({ id: id(), playerId: user.id, reason, rejectedAt: now() })
            Object.assign(order, { dispatchState: 'unassigned', assignedTo: null })
            advanceOrderIdentity(order, before, 'reject')
            audit(state, user, '拒绝指定订单', 'order', order.id, before, order)
            return playerOrder(state, user, order)
          }
          const returnMatch = path.match(/^\/player\/orders\/([^/]+)\/return-request$/)
          if (returnMatch) {
            requirePlayer(user)
            const order = find(state, 'orders', returnMatch[1], '订单'),
              before = clone(order)
            checkOrderPreconditions(order, body, 'return-request')
            if (order.leaderId !== user.id) fail('只有当前负责人可以申请退单', 403)
            if (order.status !== 'active') fail('只有接单中订单可以申请退单，请刷新订单', 409)
            order.returnRequests ||= []
            if (order.returnRequests.some((row) => row.status === 'pending'))
              fail('已有退单申请等待客服处理', 409)
            order.returnRequests.push({
              id: id(),
              leaderId: user.id,
              reason: requiredReason(body),
              status: 'pending',
              requestedAt: now()
            })
            advanceOrderIdentity(order, before, 'return-request')
            audit(state, user, '申请退单', 'order', order.id, before, order)
            return playerOrder(state, user, order)
          }
          const submitMatch = path.match(/^\/player\/orders\/([^/]+)\/submit$/)
          if (submitMatch) {
            requirePlayer(user)
            const order = find(state, 'orders', submitMatch[1], '订单'),
              before = clone(order)
            checkOrderPreconditions(order, body, 'submit')
            if (!paymentConfirmed(order))
              throw Object.assign(new ApiError('足额收款后才允许正常上报', 409), {
                code: 'PAYMENT_NOT_CONFIRMED'
              })
            if (order.leaderId !== user.id) fail('只有当前有效负责人可以上报完成', 403)
            if (order.status !== 'active') fail('只有接单中订单可以上报', 409)
            if (
              !Array.isArray(body.screenshots) ||
              !body.screenshots.length ||
              body.screenshots.length > 10
            )
              fail('请上传1至10张完成截图')
            const screenshots = body.screenshots.map((a) => attachment(state, user, a, true))
            if (
              screenshots.some((row) =>
                db.prepare('SELECT 1 FROM player_private_uploads WHERE attachment_id=?').get(row.id)
              )
            )
              fail('收款码不能用作完成截图')
            order.teammateId = validateTeammate(state, user.id, body.teammateId)
            order.submissions.push({
              id: id(),
              submittedAt: now(),
              leaderId: user.id,
              teammateId: order.teammateId,
              screenshots
            })
            order.status = 'review'
            obsoleteReturns(order, user.id)
            advanceOrderIdentity(order, before, 'submit')
            audit(state, user, '打手上报完成', 'order', order.id, before, order)
            return playerOrder(state, user, order)
          }
          if (path === '/player/withdrawals') {
            requirePlayer(user)
            if (!playerAccess(user).withdraw) fail('当前打手账号已关闭新提现申请', 403)
            return moneyRequest(
              user,
              path,
              body,
              () => {
                const amount = cents(body.amount, '提现金额', { positive: true })
                if (amount > wallet(state, user.id).available)
                  fail('可提现余额不足，申请中的金额已占用', 409)
                if (playerWalletSummary(state, user).weeklyUsed >= 7)
                  fail('本自然周已达到7次提现申请，请下周再申请', 409)
                const method = choice(body.paymentMethod, ['wechat', 'alipay'], '收款方式')
                const paymentSnapshot = state.playerPaymentMethods?.[user.id]?.[method]
                if (!paymentSnapshot) fail('请先保存该方式的收款码')
                const row = {
                  id: id(),
                  userId: user.id,
                  amount,
                  status: 'pending',
                  createdAt: now(),
                  paymentMethod: method,
                  paymentSnapshot: clone(paymentSnapshot),
                  weekStart: naturalWeek(now()),
                  requestId: body.requestId
                }
                state.withdrawals.push(row)
                audit(state, user, '申请提现', 'withdrawal', row.id, null, row)
                return clone(row)
              },
              true
            )
          }
          const cancelWithdrawal = path.match(/^\/player\/withdrawals\/([^/]+)\/cancel$/)
          if (cancelWithdrawal) {
            requirePlayer(user)
            const row = find(state, 'withdrawals', cancelWithdrawal[1], '提现记录')
            if (row.userId !== user.id) fail('只能撤回本人的提现', 403)
            return moneyRequest(
              user,
              path,
              body,
              () => {
                if (row.status !== 'pending') fail('只有待审核提现可以撤回，请刷新记录', 409)
                const before = clone(row)
                Object.assign(row, {
                  status: 'canceled',
                  canceledAt: now(),
                  processedAt: now(),
                  processedBy: user.id,
                  reason: '打手自行撤回'
                })
                audit(state, user, '撤回提现', 'withdrawal', row.id, before, row)
                return clone(row)
              },
              true
            )
          }
          if (path === '/player/payment-methods') {
            requirePlayer(user)
            const method = choice(body.method, ['wechat', 'alipay'], '收款方式')
            const qrCode = attachment(state, user, body.qrCode, true)
            const owner = db.prepare('SELECT owner_id FROM uploads WHERE id=?').get(qrCode.id)
            if (owner.owner_id !== user.id) fail('只能保存本人上传的收款码', 403)
            if (
              state.users.some((row) => row.avatar?.id === qrCode.id) ||
              appearanceAttachments(state.appearance).some((row) => row.id === qrCode.id) ||
              state.orders.some(
                (order) =>
                  order.receipt?.id === qrCode.id ||
                  order.submissions.some((row) =>
                    row.screenshots.some((shot) => shot.id === qrCode.id)
                  )
              )
            )
              fail('已用于公开图片或订单材料的附件不能用作私人收款码，请重新上传')
            state.playerPaymentMethods ||= {}
            state.playerPaymentMethods[user.id] ||= {}
            const before = state.playerPaymentMethods[user.id][method] || null
            const row = { method, qrCode, updatedAt: now() }
            state.playerPaymentMethods[user.id][method] = row
            db.prepare(
              'INSERT INTO player_private_uploads VALUES(?,?) ON CONFLICT(attachment_id) DO NOTHING'
            ).run(qrCode.id, user.id)
            audit(state, user, '维护本人收款码', 'player-payment-method', user.id, before, row)
            return clone(row)
          }
          fail('接口不存在', 404)
        }
        if (isCriticalWrite(path)) {
          authorizeCriticalWrite(state, user, path, body)
          let executed = false
          const result = businessRequest(
            user,
            path,
            body,
            () => {
              executed = true
              return execute()
            },
            now()
          )
          if (!executed) transaction.changed = false
          if (
            user.role !== 'player' &&
            (path === '/orders' || /^\/orders\/[^/]+\/action$/.test(path))
          )
            return safeOrder(state, user, result)
          return result
        }
        return execute()
      },
      authentication
    )
  }
  return {
    db,
    withReadScope: (callback) => readScope.run({}, callback),
    requiresWriteIdentity: isCriticalWrite,
    playerOperationResult(userId, requestId, family) {
      const { user } = activeState(userId)
      return readPlayerOperationResult(db, user, requestId, family, now())
    },
    collectAbandonedUploads({ before, limit = 50 } = {}) {
      const cutoff = before || new Date(Date.parse(now()) - 7 * 86400000).toISOString()
      if (
        !Number.isFinite(Date.parse(cutoff)) ||
        Date.parse(cutoff) > Date.parse(now()) - 7 * 86400000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        fail('废弃上传回收只允许至少7天前、每批最多50条')
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(
          'CREATE TABLE IF NOT EXISTS upload_cleanup_cursor(id INTEGER PRIMARY KEY CHECK(id=1),created_at TEXT NOT NULL,upload_id TEXT NOT NULL)'
        )
        const cursor = db
          .prepare('SELECT created_at,upload_id FROM upload_cleanup_cursor WHERE id=1')
          .get() || { created_at: '', upload_id: '' }
        const state = read()
        const referenced = new Set()
        const visit = (value) => {
          if (typeof value === 'string') {
            referenced.add(value)
            return
          }
          if (value && typeof value === 'object')
            for (const child of Object.values(value)) visit(child)
        }
        visit(state)
        const candidates = db
          .prepare(
            'SELECT id,size,created_at FROM uploads WHERE created_at<? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?'
          )
          .all(cutoff, cursor.created_at, cursor.created_at, cursor.upload_id, limit)
        let deleted = 0,
          bytes = 0
        for (const row of candidates) {
          if (
            referenced.has(row.id) ||
            [...referenced].some((value) => value.includes(row.id)) ||
            deletedImageRecord(db, row.id) ||
            archivedImageRecord(db, row.id) ||
            db.prepare('SELECT 1 FROM player_private_uploads WHERE attachment_id=?').get(row.id)
          )
            continue
          const historical = ['audit_logs', 'audit_logs_archive'].some((table) =>
            db
              .prepare(
                `SELECT 1 FROM ${table},json_tree(payload) WHERE entity<>'upload' AND json_tree.type='text' AND json_tree.value=? LIMIT 1`
              )
              .get(row.id)
          )
          if (
            historical ||
            db
              .prepare(
                "SELECT 1 FROM fund_transactions WHERE json_extract(receipt_json,'$.id')=? LIMIT 1"
              )
              .get(row.id) ||
            ['business_requests', 'financial_requests'].some((table) =>
              db
                .prepare(
                  `SELECT 1 FROM ${table},json_tree(result_json) WHERE json_tree.type='text' AND json_tree.value=? LIMIT 1`
                )
                .get(row.id)
            )
          )
            continue
          db.prepare('DELETE FROM uploads WHERE id=?').run(row.id)
          deleted++
          bytes += row.size
        }
        const last = candidates.at(-1)
        db.prepare(
          'INSERT INTO upload_cleanup_cursor VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,upload_id=excluded.upload_id'
        ).run(last?.created_at || '', last?.id || '')
        db.exec('COMMIT')
        return {
          scanned: candidates.length,
          deleted,
          bytes,
          protected: candidates.length - deleted
        }
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    archiveCompletedOrderImages: (options) => archivedImages.run(options),
    deleteCompletedOrderImages: (options) => archivedImages.remove(options),
    ordersPage(userId, input = {}) {
      const { state, user } = activeState(userId)
      if (user.role === 'player') fail('打手请使用本人订单接口', 403)
      requirePermission(user, 'orders.view')
      return orderPage(state, user, input)
    },
    dispatchTargets(userId) {
      const { state, user } = activeState(userId)
      if (user.role === 'player' || (!can(user, 'orders.create') && !can(user, 'orders.edit')))
        fail('没有派单权限', 403)
      const counts = staffOrderCounts(state)
      return {
        records: state.users
          .filter((row) => row.role === 'player')
          .map((row) => ({
            id: row.id,
            name: row.name,
            status: row.status,
            levelId: row.levelId,
            maxActiveOrders: row.maxActiveOrders,
            activeOrders: counts.active.get(row.id) || 0,
            pendingAssignments: counts.pending.get(row.id) || 0,
            playerAccess: playerAccess(row)
          }))
      }
    },
    orderDetail(userId, orderId) {
      const { state, user } = activeState(userId)
      const order = find(state, 'orders', orderId, '订单')
      if (user.role === 'player' || !visibleOrder(state, user, order))
        fail('没有查看订单的权限', 403)
      const refunds = state.refunds.filter((row) => row.orderId === orderId)
      const orderLogs = auditStore.rows({
        source: 'all',
        entity: 'order',
        entityId: orderId,
        limit: 200
      })
      const refundLogs = refunds.length
        ? db
            .prepare(
              "SELECT payload,created_at,id FROM audit_logs WHERE entity='refund' AND entity_id IN (SELECT value FROM json_each(?)) UNION ALL SELECT payload,created_at,id FROM audit_logs_archive WHERE entity='refund' AND entity_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC,id DESC LIMIT 200"
            )
            .all(
              JSON.stringify(refunds.map((row) => row.id)),
              JSON.stringify(refunds.map((row) => row.id))
            )
            .map((row) => JSON.parse(row.payload))
        : []
      return {
        order: safeOrder(state, user, order),
        refunds,
        logs: [...orderLogs, ...refundLogs]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .slice(0, 200)
          .map((row) => safeAuditLog(state, user, row))
          .filter(Boolean)
      }
    },
    playerOrdersPage(userId, input = {}) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      return orderPage(state, user, input)
    },
    playerChanges(userId, since) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      const version = `${state.dataVersion || 1}:${createHash('sha256')
        .update(
          JSON.stringify([
            user.id,
            user.role,
            user.status,
            permissionsFor(user),
            playerAccess(user),
            user.levelId,
            user.maxActiveOrders,
            imageRetentionVersion()
          ])
        )
        .digest('hex')
        .slice(0, 16)}`
      return {
        version,
        changed: String(since || '') !== version,
        serverTime: now(),
        appearanceRevision: appearanceFor(state).revision,
        unreadCount: 0,
        activeOrders: activeCount(state, user.id),
        maxActiveOrders: user.maxActiveOrders,
        pendingAssignments: state.orders.filter(
          (o) =>
            o.status === 'pending' && o.assignedTo === user.id && o.dispatchState !== 'unassigned'
        ).length
      }
    },
    staffChanges(userId, since) {
      const { state, user } = activeState(userId)
      if (user.role === 'player') fail('该摘要仅供后台使用', 403)
      const version = `${state.dataVersion || 1}:${createHash('sha256')
        .update(JSON.stringify([user.id, permissionsFor(user), imageRetentionVersion()]))
        .digest('hex')
        .slice(0, 16)}`
      const orders = state.orders.filter((row) => visibleOrder(state, user, row))
      return {
        version,
        changed: String(since || '') !== version,
        serverTime: now(),
        orderCounts: orderCounts(orders)
      }
    },
    exportCatalogSnapshot(userId, input = {}) {
      const { state, user } = activeState(userId)
      if (['support', 'support_lead'].includes(user.role)) fail('客服端禁止导出数据', 403)
      requirePermission(user, 'reports.export')
      const snapshot = Object.fromEntries(
        [
          'users',
          'customers',
          'platforms',
          'shops',
          'levels',
          'templates',
          'orders',
          'refunds',
          'withdrawals',
          'expenses',
          'attendance',
          'workSchedules',
          'salaryPlans',
          'payrolls',
          'logs',
          'wallets',
          'playerAdjustments',
          'rewardReviews',
          'customerBalances',
          'playerDeposits'
        ].map((key) => [key, []])
      )
      return {
        ...snapshot,
        catalogOnly: true,
        exportPeriod: exportPeriod(
          input,
          { orders: state.orders.filter((row) => visibleOrder(state, user, row)) },
          new Date(now())
        ),
        user: publicStaff(state, user),
        permissions: permissionsFor(user),
        roleDefaults: DEFAULT_PERMISSIONS,
        appearance: appearanceFor(state),
        reports: {
          month: validMonth(input.month || shanghaiDate(now()).slice(0, 7)),
          days: [],
          channels: [],
          performance: [],
          payroll: [],
          monthlyBase: null,
          monthlyProfit: null
        },
        demo: state.demo
      }
    },
    close: () => { if (db.isOpen) db.close() },
    bootstrap,
    getAppearance(userId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      return clone(appearanceFor(state))
    },
    playerAppearance(userId) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      const appearance = appearanceFor(state)
      return clone({ revision: appearance.revision, orderCardImage: appearance.playerOrderCardImage })
    },
    publicAppearance() {
      return projectPublicAppearance(read().appearance || defaultAppearance())
    },
    publicAsset(attachmentId) {
      if (
        db.prepare('SELECT 1 FROM player_private_uploads WHERE attachment_id=?').get(attachmentId)
      )
        fail('公开图片不存在', 404)
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
        omitEntities: [
          ...(can(user, 'salary.all') && can(user, 'profit.view')
            ? []
            : ['salary-plan', 'payroll']),
          ...(can(user, 'settings.manage') ? [] : ['player-content'])
        ]
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
      const selectedModules = request.modules?.map((row) => row.id)
      const requiresOrders =
        !selectedModules ||
        selectedModules.some(
          (key) =>
            key.startsWith('order') ||
            [
              'refunds',
              'overview',
              'days',
              'channels',
              'performance',
              'payroll',
              'payrollHistory'
            ].includes(key)
        )
      const base = bootstrap(userId, request.month, {
        includeOrders: requiresOrders,
        modules: selectedModules
      })
      const logBounds = auditStore.bounds()
      state.logs = [logBounds.start, logBounds.end]
        .filter(Boolean)
        .map((createdAt) => ({ createdAt }))
      if (user.role === 'player') state.logs = []
      state.exportOnlyDates = [
        user.role !== 'player' && can(user, 'finance.refunds')
          ? funds.firstDate({ type: 'customer' })
          : null,
        funds.firstDate({
          type: 'deposit',
          accountIds:
            user.role !== 'player' && can(user, 'finance.withdrawals') ? undefined : [user.id]
        })
      ].filter(Boolean)
      const result = buildPeriodExportSnapshot({
        base,
        state: user.role === 'player' ? { ...base, exportOnlyDates: state.exportOnlyDates } : state,
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
        omitEntities: [
          ...(can(user, 'salary.all') && can(user, 'profit.view')
            ? []
            : ['salary-plan', 'payroll']),
          ...(can(user, 'settings.manage') ? [] : ['player-content'])
        ]
      }
      result.auditLogCount =
        user.role !== 'player' && can(user, 'logs.view') && !unmatchedLogField
          ? auditStore.total(options)
          : 0
      if (logRequested && user.role !== 'player' && can(user, 'logs.view') && !unmatchedLogField)
        result.logs = auditStore
          .rows({ ...options, limit: 100001 })
          .map((row) => safeAuditLog(state, user, row))
          .filter(Boolean)
      else if (logRequested) result.logs = []
      result.fundCounts = {}
      const keyword = text(filters.keyword, '资金流水搜索', { max: 200 }).toLowerCase()
      const startDate = start > result.exportPeriod.start ? start : result.exportPeriod.start
      const endDate = end < result.exportPeriod.end ? end : result.exportPeriod.end
      const customerNames = new Map(state.customers.map((row) => [row.id, row.name]))
      const staffNames = new Map(state.users.map((row) => [row.id, row.name]))
      const orderNumbers = new Map(state.orders.map((row) => [row.id, row.orderNo]))
      const kindNames = {
        recharge: '充值',
        deduction: '非订单扣款',
        'order-payment': '订单余额付款',
        'order-refund': '订单余额退款',
        deposit: '缴纳押金',
        penalty: '离店押金没收'
      }
      for (const [moduleId, type, outputKey, authorized] of [
        [
          'customerTransactions',
          'customer',
          'customerTransactions',
          user.role !== 'player' && can(user, 'finance.refunds')
        ],
        [
          'playerDepositTransactions',
          'deposit',
          'playerDepositTransactions',
          can(user, 'finance.withdrawals') || user.role === 'player'
        ]
      ]) {
        if (!authorized) {
          result.fundCounts[moduleId] = 0
          continue
        }
        const options = {
          type,
          start: startDate,
          end: endDate,
          accountIds:
            type === 'deposit' && (user.role === 'player' || !can(user, 'finance.withdrawals'))
              ? [user.id]
              : undefined,
          match: (row) => {
            if (type === 'customer' && filters.customerId && row.accountId !== filters.customerId)
              return false
            if (
              filters.personId &&
              (type === 'customer'
                ? row.createdBy !== filters.personId
                : row.accountId !== filters.personId && row.createdBy !== filters.personId)
            )
              return false
            if (!keyword) return true
            const values = {
              id: row.id,
              accountId: row.accountId,
              customerId: row.accountId,
              userId: row.accountId,
              customerName: customerNames.get(row.accountId) || '',
              name: staffNames.get(row.accountId) || '',
              kind:
                row.kind === 'return'
                  ? type === 'customer'
                    ? '余额退还'
                    : '押金退还'
                  : kindNames[row.kind] || row.kind,
              exitType:
                row.exitType === 'leave' ? '离店' : row.exitType === 'absconded' ? '跑路' : '',
              reason: row.reason,
              orderNo: orderNumbers.get(row.orderId) || '',
              createdByName: row.createdByName,
              createdAt:
                !filters.keywordField || filters.keywordField === 'createdAt'
                  ? fundDateFormatter.format(new Date(row.createdAt))
                  : '',
              receiptName: row.receipt?.name || '',
              receiptUrl: row.receipt?.url || '',
              amount: row.amount / 100,
              delta: row.delta / 100,
              balanceAfter: row.balanceAfter / 100
            }
            const search = filters.keywordField
              ? Object.hasOwn(values, filters.keywordField)
                ? [values[filters.keywordField]]
                : []
              : Object.values(values)
            return search.some((value) => String(value).toLowerCase().includes(keyword))
          }
        }
        if (!keyword && !filters.customerId && !filters.personId) delete options.match
        const count = funds.count(options)
        result.fundCounts[moduleId] = count
        if (request.modules?.some((row) => row.id === moduleId)) {
          if (count > 100000) fail('资金流水匹配超过100000条，请缩小日期或关键词范围')
          result[outputKey] = funds.rows({ ...options, limit: 100001 })
        }
      }
      return result
    },
    overview(userId, input = {}) {
      const dates = normalizeOverviewRange(input, shanghaiDate(now()))
      const authority = activeState(userId)
      const cacheKey = JSON.stringify([
        userId,
        authority.user.role,
        permissionsFor(authority.user),
        authority.state.dataVersion,
        db.prepare('PRAGMA data_version').get().data_version,
        db.prepare('SELECT total_changes() AS n').get().n,
        dates,
        shanghaiDate(now())
      ])
      if (derivedResults.has(cacheKey)) return clone(derivedResults.get(cacheKey))
      const { overview: report } = overviewRead(authority.state, authority.user, dates)
      if (derivedResults.size >= 32) derivedResults.delete(derivedResults.keys().next().value)
      derivedResults.set(cacheKey, clone(report))
      return report
    },
    overviewDetails(userId, input = {}) {
      // One read transaction keeps state, funds and derived reports on the same snapshot.
      const ownsTransaction = !db.isTransaction
      if (ownsTransaction) db.exec('BEGIN')
      try {
        const { state, user } = activeState(userId)
        const query = overviewDetailQuery(user, permissionsFor(user), input)
        const dates = normalizeOverviewRange(input, shanghaiDate(now()))
        const { snapshots, personalOrders, overview } = overviewRead(state, user, dates)
        const orderFacts = new Map()
        if (can(user, 'orders.view'))
          for (const order of state.orders.filter((row) => visibleOrder(state, user, row))) {
            const amounts = orderCommissions(state, order)
            orderFacts.set(order.id, {
              net: netOrder(state, order),
              estimatedReward: order.status !== 'completed' && !order.compensationSettled ? order.reward : 0,
              supportCommission: amounts.support, operationsCommission: amounts.operations,
              incomplete: amounts.incomplete || Boolean(order.compensationPending)
            })
          }
        const orders = new Map(state.orders.map((row) => [row.id, row]))
        const adjustmentDates = new Map(state.playerAdjustments.map((row) => [
          row.id, orders.get(row.orderId)?.paidAt
            ? shanghaiDate(orders.get(row.orderId).paidAt) : shanghaiDate(row.createdAt)
        ]))
        const result = buildOverviewDetails(snapshots, overview, query, {
          orderFacts, adjustmentDates, personalOrderIds: new Set(personalOrders.map((row) => row.id))
        })
        if (ownsTransaction) db.exec('COMMIT')
        return result
      } catch (error) {
        if (ownsTransaction) db.exec('ROLLBACK')
        throw error
      }
    },
    mutate,
    customerBalance(userId, customerId) {
      const { state, user } = activeState(userId)
      requireCustomerAccount(user)
      find(state, 'customers', customerId, '客户')
      return { customerId, balance: funds.balance('customer', customerId) }
    },
    customerTransactions(userId, customerId, input = {}) {
      const { state, user } = activeState(userId)
      requirePermission(user, 'finance.refunds')
      find(state, 'customers', customerId, '客户')
      const { current, size } = accountPage(input),
        options = { type: 'customer', accountIds: [customerId] }
      return {
        customerId,
        balance: funds.balance('customer', customerId),
        records: funds.rows({ ...options, limit: size, offset: (current - 1) * size }),
        total: funds.count(options),
        current,
        size
      }
    },
    customerTransactionDetail(userId, customerId, transactionId) {
      const { state, user } = activeState(userId)
      requirePermission(user, 'finance.refunds')
      find(state, 'customers', customerId, '客户')
      const row = funds.rows({ type: 'customer', accountIds: [customerId],
        match: (record) => record.id === transactionId, limit: 1 })[0]
      if (!row) fail('该客户资金流水不存在', 404)
      return row
    },
    playerDeposit(userId, targetId, input = {}) {
      const { state, user } = activeState(userId)
      if (!depositVisible(user, targetId)) fail('没有查看该打手押金的权限', 403)
      find(state, 'users', targetId, '打手')
      const { current, size } = accountPage(input),
        options = { type: 'deposit', accountIds: [targetId] }
      return {
        userId: targetId,
        balance: funds.balance('deposit', targetId),
        records: funds.rows({ ...options, limit: size, offset: (current - 1) * size }),
        total: funds.count(options),
        current,
        size
      }
    },
    playerDepositTransactionDetail(userId, targetId, transactionId) {
      const { state, user } = activeState(userId)
      if (!depositVisible(user, targetId)) fail('没有查看该打手押金的权限', 403)
      find(state, 'users', targetId, '打手')
      const row = funds.rows({ type: 'deposit', accountIds: [targetId],
        match: (record) => record.id === transactionId, limit: 1 })[0]
      if (!row) fail('该打手押金流水不存在', 404)
      return row
    },
    playerDetail(userId, targetId) {
      const { state, user } = activeState(userId)
      if (!can(user, 'users.manage') && !can(user, 'finance.withdrawals'))
        fail('没有查看打手档案的权限', 403)
      const row = state.users.find((entry) => entry.id === targetId && entry.role === 'player')
      if (!row) fail('打手档案不存在', 404)
      return playerListRecord(state, user, row)
    },
    players(userId, input = {}) {
      const { state, user } = activeState(userId)
      if (!can(user, 'users.manage') && !can(user, 'finance.withdrawals'))
        fail('没有查看打手档案的权限', 403)
      const { current, size } = accountPage(input)
      const contains = (value, query) =>
        String(value || '')
          .toLowerCase()
          .includes(text(query, '搜索条件', { max: 128 }).toLowerCase())
      for (const key of ['login', 'claim', 'withdraw'])
        if (input[key] !== undefined && !['', 'true', 'false'].includes(String(input[key])))
          fail('打手开关筛选无效')
      const rows = state.users.filter(
        (row) =>
          row.role === 'player' &&
          (!input.name || contains(row.name, input.name)) &&
          (!input.username || contains(row.username, input.username)) &&
          (!input.levelId || row.levelId === input.levelId) &&
          (!input.status || row.status === input.status) &&
          ['login', 'claim', 'withdraw'].every(
            (key) =>
              input[key] === undefined ||
              input[key] === '' ||
              playerAccess(row)[key] === (String(input[key]) === 'true')
          )
      )
      const records = rows.slice((current - 1) * size, current * size)
        .map((row) => playerListRecord(state, user, row))
      return { records, total: rows.length, current, size }
    },
    playerHistoryDetail(userId, targetId, orderId) {
      const { state, user } = activeState(userId)
      if (!can(user, 'orders.view') && !can(user, 'finance.withdrawals'))
        fail('没有查看打手接单记录的权限', 403)
      find(state, 'users', targetId, '打手')
      const row = state.orders.find((entry) => entry.id === orderId && participatedPlayerOrder(entry, targetId))
      if (!row) fail('该打手参与订单不存在', 404)
      return can(user, 'orders.view') ? safeOrder(state, user, row) : playerOrder(state, user, row)
    },
    playerHistory(userId, targetId, input = {}) {
      const { state, user } = activeState(userId)
      if (!can(user, 'orders.view') && !can(user, 'finance.withdrawals'))
        fail('没有查看打手接单记录的权限', 403)
      find(state, 'users', targetId, '打手')
      const { current, size } = accountPage(input),
        sortBy = choice(
          input.sortBy || 'acceptedAt',
          ['createdAt', 'completedAt', 'acceptedAt'],
          '排序字段'
        ),
        sortOrder = choice(input.sortOrder || 'desc', ['asc', 'desc'], '排序方向')
      const accepted = (row) =>
        row.assignments.filter((entry) => entry.leaderId === targetId).at(-1)?.acceptedAt ||
        row.submissions.find((entry) => entry.teammateId === targetId)?.submittedAt ||
        ''
      const value = (row) => (sortBy === 'acceptedAt' ? accepted(row) : row[sortBy] || '')
      const rows = state.orders
        .filter((row) => participatedPlayerOrder(row, targetId))
        .sort(
          (a, b) =>
            value(a).localeCompare(value(b)) * (sortOrder === 'asc' ? 1 : -1) ||
            a.id.localeCompare(b.id)
        )
      return {
        records: rows
          .slice((current - 1) * size, current * size)
          .map((row) =>
            can(user, 'orders.view') ? safeOrder(state, user, row) : playerOrder(state, user, row)
          ),
        total: rows.length,
        current,
        size
      }
    },
    operationsDiagnostics() {
      const ownTransaction = !db.isTransaction
      if (ownTransaction) db.exec('BEGIN')
      try {
        const report = diagnosticsReport(readOnlyState())
        if (ownTransaction) db.exec('COMMIT')
        return { generatedAt: now(), ...report.summary }
      } catch (error) { if (ownTransaction) db.exec('ROLLBACK'); throw error }
    },
    diagnostics(userId) {
      const state = readOnlyState(),
        user = find(state, 'users', userId, '账号')
      if (user.status !== 'active') fail('账号已停用', 403)
      requireBackupAudit(user)
      return diagnosticsReport(state)
    },
    login(username, passwordValue, { requiredRole } = {}) {
      const state = read(),
        loginName = text(username, '登录名', { required: true, max: 64 })
      const user = state.users.find((u) => u.username.toLowerCase() === loginName.toLowerCase())
      if (
        !user ||
        user.status !== 'active' ||
        (user.role === 'player' && !playerAccess(user).login) ||
        !verifyPassword(passwordValue, state.passwords[user.id])
      )
        fail('账号或密码错误，或账号已停用', 401)
      if (requiredRole && user.role !== requiredRole) fail('此客户端不允许该账号角色登录', 403)
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
    session(token, { readOnly = false } = {}) {
      if (!token || typeof token !== 'string' || token.length > 128) return null
      const row = db
        .prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?')
        .get(sessionHash(token))
      if (!row || row.expires_at <= Date.parse(now())) return null
      const state = readOnly ? readOnlyState() : read(),
        user = state.users.find(
          (u) =>
            u.id === row.user_id &&
            u.status === 'active' &&
            (u.role !== 'player' || playerAccess(u).login)
        )
      return user ? publicStaff(state, user) : null
    },
    logout(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionHash(token))
      return { ok: true }
    },
    playerContent(userId, contentId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      return playerContent({ db, state, user, now: now() }, contentId)
    },
    adminPlayerContent(userId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      return adminPlayerContent({ db, state, user, now: now() })
    },
    playerContentAsset(userId, attachmentId, audience = 'player') {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      return playerContentAsset({ db, state, user, now: now() }, attachmentId, audience)
    },
    playerOrders(userId) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      requirePlayer(user)
      return state.orders
        .filter((o) => visibleOrder(state, user, o))
        .map((order) => playerOrder(state, user, order))
    },
    playerWallet(userId, input = {}) {
      const state = read(),
        user = find(state, 'users', userId, '账号')
      requirePlayer(user)
      return playerWalletData(state, user, input)
    },
    playerWithdrawalsPage(userId, input = {}) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      const status = choice(
        input.status || 'all',
        ['all', 'pending', 'approved', 'paid', 'rejected', 'canceled'],
        '提现状态'
      )
      return financialPage(
        state.withdrawals.filter(
          (row) => row.userId === user.id && (status === 'all' || row.status === status)
        ),
        input
      )
    },
    playerLedgerPage(userId, input = {}) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      const kind = choice(
        input.kind || 'all',
        [
          'all',
          'reward',
          'reward-correction',
          'legacy-reward-snapshot',
          'supplement',
          'deduction',
          'withdrawal-request',
          'withdrawal-canceled',
          'withdrawal-rejected',
          'withdrawal-paid'
        ],
        '账本类型'
      )
      return financialPage(
        playerLedgerRows(state, user).filter((row) => kind === 'all' || row.kind === kind),
        input
      )
    },
    playerOrderDetail(userId, orderId) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      const order = find(state, 'orders', orderId, '订单')
      if (!visibleOrder(state, user, order)) fail('没有查看该订单的权限', 403)
      return playerOrder(state, user, order)
    },
    playerProfile(userId) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      return clone({
        user: publicStaff(state, user),
        level: state.levels.find((row) => row.id === user.levelId) || null,
        activeOrders: activeCount(state, user.id),
        maxActiveOrders: user.maxActiveOrders,
        paymentMethods: paymentMethods(state, user.id)
      })
    },
    playerPaymentMethods(userId) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      return paymentMethods(state, user.id)
    },
    playerTeammates(userId) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      return clone(
        state.users
          .filter((row) => row.role === 'player' && row.status === 'active' && row.id !== user.id)
          .map((row) => ({ id: row.id, name: row.name, avatar: row.avatar }))
      )
    },
    playerLeaderboard(userId, input = {}) {
      const { state, user } = activeState(userId)
      requirePlayer(user)
      const month = validMonth(input.month || shanghaiDate(now()).slice(0, 7))
      const type = choice(input.type || 'orders', ['orders', 'withdrawals'], '排行类型')
      const { current, size } = accountPage(input)
      const scores = new Map()
      if (type === 'orders') {
        for (const order of state.orders) {
          if (
            order.status !== 'completed' ||
            !order.leaderId ||
            !order.completedAt ||
            !paidOrder(order) ||
            netOrder(state, order) <= 0 ||
            !shanghaiDate(order.completedAt).startsWith(month) ||
            state.statusCorrectionReversals[order.id]?.active
          )
            continue
          const credits = state.rewardCredits.filter((row) => row.orderId === order.id)
          if (order.reward > 0 && credits.reduce((sum, row) => sum + row.amount, 0) < order.reward)
            continue
          scores.set(order.leaderId, (scores.get(order.leaderId) || 0) + 1)
        }
      } else {
        for (const row of state.withdrawals)
          if (row.status === 'paid' && row.paidAt && shanghaiDate(row.paidAt).startsWith(month))
            scores.set(row.userId, (scores.get(row.userId) || 0) + row.amount)
      }
      const records = state.users
        .filter((row) => row.role === 'player' && scores.get(row.id) > 0)
        .map((row) => ({
          userId: row.id,
          name: row.name,
          avatar: row.avatar,
          ...(type === 'orders'
            ? { orderCount: scores.get(row.id) }
            : { amount: scores.get(row.id) })
        }))
        .sort(
          (a, b) =>
            scores.get(b.userId) - scores.get(a.userId) ||
            a.name.localeCompare(b.name, 'zh-CN') ||
            a.userId.localeCompare(b.userId)
        )
      let previousScore = null,
        rank = 0
      records.forEach((row, index) => {
        const score = scores.get(row.userId)
        if (score !== previousScore) rank = index + 1
        row.rank = rank
        previousScore = score
      })
      return clone({
        month,
        type,
        records: records.slice((current - 1) * size, current * size),
        total: records.length,
        current,
        size,
        myRank: records.find((row) => row.userId === user.id) || null,
        rankingRule: '同成绩并列名次，下一名次按实际人数顺延；无成绩不列入排名'
      })
    },
    upload(userId, body, authentication = {}) {
      return transact(
        userId,
        (state, user) => {
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
        },
        authentication
      )
    },
    download(userId, attachmentId) {
      const state = read(),
        user = find(state, 'users', userId, '账号'),
        row = db.prepare('SELECT * FROM uploads WHERE id=?').get(attachmentId)
      if (!row) fail('附件不存在', 404)
      if (user.status !== 'active' || (user.role === 'player' && !playerAccess(user).login))
        fail('账号已停用或关闭登录', 403)
      const privateImage = db
        .prepare('SELECT * FROM player_private_uploads WHERE attachment_id=?')
        .get(attachmentId)
      if (
        privateImage &&
        privateImage.owner_id !== user.id &&
        (user.role === 'player' || !can(user, 'finance.withdrawals'))
      )
        fail('无权查看私人收款码', 403)
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
      if (deletedImageRecord(db, attachmentId)) fail('订单完成满30天，图片已删除', 410)
      const archived = archivedImageRecord(db, attachmentId)
      if (archived) {
        if (archived.size !== row.size || row.data.length !== 0) fail('归档图片元数据不一致，请联系管理员核对', 503)
        try { return { ...metadata(row), data: readArchivedImage(archived) } }
        catch { fail('归档图片暂时不可读取，请联系管理员核对存储及备份', 503) }
      }
      if (row.data.length !== row.size) fail('图片内容不完整，请联系管理员核对存储及备份', 503)
      return { ...metadata(row), data: Buffer.from(row.data) }
    }
  }
}
