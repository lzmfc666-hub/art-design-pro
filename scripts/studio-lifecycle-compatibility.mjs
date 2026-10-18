import { DatabaseSync } from 'node:sqlite'
import { lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReleaseManifest } from './studio-release.mjs'

export const LIFECYCLE_CAPABILITIES = Object.freeze(['refund-execution-v1', 'stored-orders-v1', 'problem-orders-v1', 'problem-staff-only-v1'])
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const failure = (code, message) => Object.assign(new Error(message), { code })
const publicError = {
  INPUT_REQUIRED: '必须明确指定数据库和待使用版本的发布清单',
  INPUT_INVALID: '检查参数无效',
  DATABASE_INVALID: '数据库格式或业务状态无效，未作任何修改',
  MANIFEST_INVALID: '发布清单无效，无法确认该版本的数据兼容能力',
  PRIVATE_OUTPUT_INVALID: '私人清单必须写入已有的非公开、非源码目录，且不得覆盖已有文件',
  CHECK_FAILED: '兼容性检查未完成，未作任何业务修改'
}
function ordinaryFile(path, code, maxBytes = Infinity) {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > maxBytes) throw new Error('file')
  } catch { throw failure(code, publicError[code]) }
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0 }
function analyze(state, capabilities) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !integer(state.schemaVersion ?? 1) || ![1, 2].includes(state.schemaVersion ?? 1) ||
      !Array.isArray(state.orders) || !Array.isArray(state.refunds))
    throw failure('DATABASE_INVALID', publicError.DATABASE_INVALID)
  const supported = new Set(capabilities), required = new Set(), anomalies = [], financialReviews = [], refunded = new Map()
  for (const row of state.refunds) {
    if (!row || typeof row.orderId !== 'string' || !integer(row.amount)) throw failure('DATABASE_INVALID', publicError.DATABASE_INVALID)
    if (!['paid', 'pending'].includes(row.status)) continue
    const sum = refunded.get(row.orderId) || { paid: 0, pending: 0 }
    sum[row.status] += row.amount
    if (!integer(sum[row.status])) throw failure('DATABASE_INVALID', publicError.DATABASE_INVALID)
    refunded.set(row.orderId, sum)
  }
  const counts = { orders: state.orders.length, refunds: state.refunds.length, fullRefundedOrders: 0,
    fullRefundOpenFulfillment: 0, fullRefundAfterAssignment: 0, fullRefundCompletedOrders: 0,
    durablyClosedFullRefundOrders: 0, legacyFullRefundOpenFulfillment: 0, financialReviewOrders: 0,
    fullRefundPendingOrders: 0, activeStoredOrders: 0, storageHistoryOrders: 0,
    resumedCapacityExemptOrders: 0, openProblemOrders: 0, problemHistoryOrders: 0, anomalyOrders: 0 }
  const ids = new Set()
  for (const order of state.orders) {
    if (!order || typeof order.id !== 'string' || !order.id || ids.has(order.id) || !integer(order.receivedAmount ?? 0))
      throw failure('DATABASE_INVALID', publicError.DATABASE_INVALID)
    ids.add(order.id)
    const sums = refunded.get(order.id) || { paid: 0, pending: 0 }, received = order.receivedAmount || 0
    const full = Boolean(order.refundExecutionClosedAt) || (received > 0 && sums.paid >= received)
    const pending = !full && received > 0 && sums.pending > 0 && sums.paid + sums.pending >= received
    const codes = [], financeCodes = []
    if (full || pending) required.add('refund-execution-v1')
    if (full) {
      counts.fullRefundedOrders++
      if (order.refundExecutionClosedAt) counts.durablyClosedFullRefundOrders++
      if (['pending', 'active', 'review'].includes(order.status)) {
        // Retaining raw fulfillment is intentional. Only a legacy row without
        // durable closure needs an execution anomaly, while both need runtime protection.
        counts.fullRefundOpenFulfillment++
        if (!order.refundExecutionClosedAt) {
          counts.legacyFullRefundOpenFulfillment++
          codes.push(`LEGACY_FULL_REFUND_RAW_${order.status.toUpperCase()}`)
        }
      }
      if (order.leaderId || order.assignments?.length) {
        counts.fullRefundAfterAssignment++
        financeCodes.push('FULL_REFUND_ASSIGNMENT_REVIEW_REQUIRED')
      }
      if (order.status === 'completed') {
        counts.fullRefundCompletedOrders++
        financeCodes.push('FULL_REFUND_COMPLETED_REWARD_REVIEW_REQUIRED')
      }
    }
    if (pending) counts.fullRefundPendingOrders++
    const storageHistory = Boolean(order.storage || order.storageHistory?.length || order.capacityExemption)
    if (storageHistory) { required.add('stored-orders-v1'); counts.storageHistoryOrders++ }
    if (order.storage?.active === true) counts.activeStoredOrders++
    if (order.capacityExemption) counts.resumedCapacityExemptOrders++
    if (order.problem || order.problemHistory?.length) {
      required.add('problem-orders-v1'); required.add('problem-staff-only-v1'); counts.problemHistoryOrders++
    }
    if (order.problem?.status === 'open') counts.openProblemOrders++
    if (codes.length) anomalies.push({ orderId: order.id, codes })
    if (financeCodes.length) financialReviews.push({ orderId: order.id, codes: financeCodes })
  }
  counts.anomalyOrders = anomalies.length
  counts.financialReviewOrders = financialReviews.length
  const requiredCapabilities = LIFECYCLE_CAPABILITIES.filter(value => required.has(value))
  const missingCapabilities = requiredCapabilities.filter(value => !supported.has(value))
  return { report: { format: 'studio-lifecycle-compatibility-v1', compatible: missingCapabilities.length === 0,
    readOnly: true, queryOnly: true, schemaVersion: state.schemaVersion ?? 1, counts,
    requiredCapabilities, supportedCapabilities: LIFECYCLE_CAPABILITIES.filter(value => supported.has(value)), missingCapabilities,
    executionAnomaliesRequireReview: anomalies.length > 0, financialReviewRequired: financialReviews.length > 0,
    findingsRequireOperatorReview: anomalies.length > 0 || financialReviews.length > 0 }, anomalies, financialReviews }
}
function privateOutputPath(path) {
  const target = resolve(path), parent = dirname(target), normalized = target.replaceAll('\\', '/').toLowerCase()
  // Explicit private output may never land in either web tree or release output.
  if (/(?:^|\/)(?:public|dist|output|outputs|node_modules|\.git)(?:\/|$)/.test(normalized))
    throw failure('PRIVATE_OUTPUT_INVALID', publicError.PRIVATE_OUTPUT_INVALID)
  try {
    const parentInfo = lstatSync(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() ||
        realpathSync(parent).toLowerCase() !== parent.toLowerCase()) throw new Error('private directory')
    const distance = relative(root, target)
    if (!distance.startsWith('..') && !isAbsolute(distance) && !/^(?:\.qa|\.data|\.ops)[\\/]/.test(distance))
      throw new Error('source directory')
  } catch { throw failure('PRIVATE_OUTPUT_INVALID', publicError.PRIVATE_OUTPUT_INVALID) }
  return target
}

/** Opens an explicitly selected SQLite database read-only, never through the business initializer. */
export function inspectStudioLifecycleCompatibility({ databasePath, manifestPath, privateAnomaliesFile } = {}) {
  if (!databasePath || !manifestPath) throw failure('INPUT_REQUIRED', publicError.INPUT_REQUIRED)
  const database = resolve(databasePath), manifestFile = resolve(manifestPath)
  ordinaryFile(database, 'DATABASE_INVALID')
  ordinaryFile(manifestFile, 'MANIFEST_INVALID', 16 * 1024 * 1024)
  const manifest = readReleaseManifest(manifestFile, { verify: false })
  if (!manifest || (manifest.runtimeCapabilities !== undefined && (!Array.isArray(manifest.runtimeCapabilities) ||
      manifest.runtimeCapabilities.some(value => typeof value !== 'string' || value.length > 100))))
    throw failure('MANIFEST_INVALID', publicError.MANIFEST_INVALID)
  let db, result
  try {
    db = new DatabaseSync(database, { readOnly: true })
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN')
    if (db.prepare('PRAGMA query_only').get().query_only !== 1) throw new Error('query-only')
    const row = db.prepare('SELECT json FROM studio_state WHERE id=1').get()
    if (!row) throw new Error('state missing')
    result = analyze(JSON.parse(row.json), manifest.runtimeCapabilities || [])
    db.exec('ROLLBACK')
  } catch { throw failure('DATABASE_INVALID', publicError.DATABASE_INVALID) }
  finally { db?.close() }
  if (privateAnomaliesFile) {
    const target = privateOutputPath(privateAnomaliesFile)
    try {
      writeFileSync(target, JSON.stringify({ format: 'studio-lifecycle-private-review-v1', generatedAt: new Date().toISOString(),
        anomalies: result.anomalies, financialReviews: result.financialReviews }, null, 2), { flag: 'wx', mode: 0o600 })
    } catch { throw failure('PRIVATE_OUTPUT_INVALID', publicError.PRIVATE_OUTPUT_INVALID) }
  }
  return { ...result.report, releaseId: manifest.id, privateAnomaliesWritten: Boolean(privateAnomaliesFile) }
}

function argumentsOf(args) {
  const options = {}, fields = { '--database': 'databasePath', '--manifest': 'manifestPath', '--private-anomalies-file': 'privateAnomaliesFile' }
  for (let index = 0; index < args.length; index += 2) {
    const field = fields[args[index]], value = args[index + 1]
    if (!field || !value || value.startsWith('--') || Object.hasOwn(options, field))
      throw failure('INPUT_INVALID', publicError.INPUT_INVALID)
    options[field] = value
  }
  return options
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = inspectStudioLifecycleCompatibility(argumentsOf(process.argv.slice(2)))
    console.log(JSON.stringify(result))
    if (!result.compatible) process.exitCode = 1
  } catch (error) {
    const code = Object.hasOwn(publicError, error.code) ? error.code : 'CHECK_FAILED'
    console.log(JSON.stringify({ format: 'studio-lifecycle-compatibility-v1', compatible: false, readOnly: true, code, message: publicError[code] }))
    process.exitCode = 2
  }
}
