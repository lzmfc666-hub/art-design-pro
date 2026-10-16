import { createServer } from 'node:http'
import { existsSync, statSync, createReadStream, readFileSync } from 'node:fs'
import { resolve, dirname, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudioService, ApiError, permissionsFor } from './studio.mjs'
import { getExportCatalog, buildExportSheets } from './report-export.mjs'
import { createPlayerNotifications } from './player-notifications.mjs'
import { createLoginRateLimit } from './login-rate-limit.mjs'
import { createRuntimeProtection, createTrustedProxyResolver } from './runtime-protection.mjs'
import { createBackupScheduler } from './backup-scheduler.mjs'
import { createUploadCleanup } from './upload-cleanup.mjs'
import { createReadinessProbe } from './health-probe.mjs'
import { createMonitorAuthority, safeRuntimeSummary } from './ops-summary.mjs'
import { readReleaseManifest } from '../scripts/studio-release.mjs'
import { createOpsEvents } from './ops-events.mjs'
import { privateOpsDirectory } from './ops-config.mjs'
import { readLocalMonitorBinding } from './local-monitor-binding.mjs'

const PREFIX = '/api/studio'
const COOKIE_NAME = 'studio_session'
const PLAYER_COOKIE_NAME = 'studio_player_session'
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json'
}
const json = (res, status, value) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(value))
}
const cookieToken = (req, cookieName) => {
  const cookie = req.headers.cookie || ''
  const match = cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${cookieName}=`))
  return match ? match.slice(cookieName.length + 1) : null
}
async function parseBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))
    throw new ApiError('请使用application/json请求内容', 415)
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 12 * 1024 * 1024) throw new ApiError('请求内容过大', 413)
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new ApiError('请求内容必须为有效JSON对象')
  }
}
const loopback = (hostname) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)
function checkOrigin(req) {
  if (!req.headers.origin) return
  let origin, requestHost
  try {
    origin = new URL(req.headers.origin)
    requestHost = new URL(`http://${req.headers.host || 'localhost'}`)
  } catch {
    throw new ApiError('请求来源无效', 403)
  }
  const configured = (process.env.STUDIO_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (
    origin.host === requestHost.host ||
    (loopback(origin.hostname) && loopback(requestHost.hostname)) ||
    configured.includes(origin.origin)
  )
    return
  throw new ApiError('请求来源不受信任', 403)
}

export function createStudioServer(options = {}) {
  let notifications
  if (
    Object.hasOwn(options, 'dbPath') &&
    (typeof options.dbPath !== 'string' || !options.dbPath.trim())
  )
    throw new Error('显式 dbPath 必须是非空路径，测试不能回退到默认业务库')
  // Explicit databases are library/test instances. Production environment jobs
  // must be deliberately enabled by the CLI or by an explicit caller option.
  const maintenanceFromEnv = options.maintenanceFromEnv ?? !Object.hasOwn(options, 'dbPath')
  if (typeof maintenanceFromEnv !== 'boolean') throw new Error('maintenanceFromEnv 必须为布尔值')
  const databasePath = options.dbPath || resolve('.data/studio.sqlite')
  const releaseId = options.releaseId ?? null
  if (releaseId !== null && !/^[a-f0-9]{64}$/.test(releaseId)) throw new Error('发布标识格式无效')
  const monitorAuthority = createMonitorAuthority(options.monitor?.token ??
    (maintenanceFromEnv ? process.env.STUDIO_MONITOR_TOKEN : null))
  const diagnosticHours = options.monitor?.diagnosticHoursUTC || []
  if (!Array.isArray(diagnosticHours) || diagnosticHours.some(hour => !Number.isInteger(hour) || hour < 0 || hour > 23))
    throw new Error('低峰诊断时间窗无效')
  const diagnosticIntervalMs = options.monitor?.diagnosticIntervalMs ?? 3600000
  if (!Number.isSafeInteger(diagnosticIntervalMs) || diagnosticIntervalMs < 60000)
    throw new Error('诊断最小间隔无效')
  const readiness = createReadinessProbe({ dbPath: databasePath, db: () => service.db,
    timeoutMs: options.health?.timeoutMs, busyMs: options.health?.busyMs, cacheMs: options.health?.cacheMs })
  const backupOptions = maintenanceFromEnv
    ? options.backups
    : {
        ...options.backups,
        intervalMinutes: options.backups?.intervalMinutes ?? 0,
        directory:
          options.backups?.directory ??
          (databasePath === ':memory:' ? '' : resolve(dirname(databasePath), 'backups')),
        retentionCount: options.backups?.retentionCount ?? 7,
        maxTotalBytes: options.backups?.maxTotalBytes ?? 0,
        minFreeBytes: options.backups?.minFreeBytes ?? 0,
        failureWebhook: options.backups?.failureWebhook ?? ''
      }
  const cleanupOptions = maintenanceFromEnv
    ? options.uploadCleanup
    : {
        ...options.uploadCleanup,
        enabled: options.uploadCleanup?.enabled ?? false,
        intervalMinutes: options.uploadCleanup?.intervalMinutes ?? 60,
        retentionDays: options.uploadCleanup?.retentionDays ?? 7,
        limit: options.uploadCleanup?.limit ?? 50
      }
  const imageArchiveOptions = {
    enabled: maintenanceFromEnv && process.env.STUDIO_IMAGE_ARCHIVE_ENABLED === 'true',
    deletionEnabled: maintenanceFromEnv && process.env.STUDIO_IMAGE_DELETE_ENABLED === 'true',
    directory: maintenanceFromEnv ? process.env.STUDIO_IMAGE_ARCHIVE_DIR : undefined,
    holdsFile: maintenanceFromEnv ? process.env.STUDIO_IMAGE_ARCHIVE_HOLDS_FILE : undefined,
    retentionDays: maintenanceFromEnv ? Number(process.env.STUDIO_IMAGE_DELETE_RETENTION_DAYS || process.env.STUDIO_IMAGE_ARCHIVE_RETENTION_DAYS || 30) : 30,
    ...options.imageArchive
  }
  if (imageArchiveOptions.enabled && imageArchiveOptions.deletionEnabled)
    throw new Error('完成单图片归档与到期删除不能同时开启')
  const notificationOptions = maintenanceFromEnv
    ? options.notifications || { clock: options.clock }
    : {
        ...options.notifications,
        clock: options.notifications?.clock ?? options.clock,
        publicKey: options.notifications?.publicKey ?? '',
        privateKey: options.notifications?.privateKey ?? '',
        subject: options.notifications?.subject ?? '',
        allowedPushHosts: options.notifications?.allowedPushHosts ?? []
      }
  // Validate runtime infrastructure before opening or initializing a business database.
  const resolveAddress = createTrustedProxyResolver(
    options.trustedProxies ?? process.env.STUDIO_TRUSTED_PROXIES ?? ''
  )
  const runtime = createRuntimeProtection({
    ...options.runtime,
    clock: options.clock,
    dbPath: databasePath
  })
  const ownsOpsEvents = !options.opsEvents && maintenanceFromEnv && Boolean(process.env.STUDIO_OPS_DIRECTORY)
  const opsEvents = options.opsEvents || (ownsOpsEvents ? createOpsEvents({
    dbPath: resolve(privateOpsDirectory(process.env.STUDIO_OPS_DIRECTORY), 'events.sqlite'),
    environment: process.env.STUDIO_OPS_ENVIRONMENT || 'local'
  }) : null)
  let replication = backupOptions?.replication
  if (replication === undefined && maintenanceFromEnv && process.env.STUDIO_BACKUP_REPLICATION_CONFIG) {
    try {
      const path = privateOpsDirectory(process.env.STUDIO_BACKUP_REPLICATION_CONFIG)
      if (statSync(path).size > 32768) throw new Error('LIMIT')
      replication = JSON.parse(readFileSync(path, 'utf8'))
    } catch { throw new Error('BACKUP_REPLICATION_CONFIG_INVALID') }
  }
  const backups = createBackupScheduler({
    dbPath: databasePath,
    ...backupOptions,
    clock: options.clock, applicationRelease: backupOptions?.applicationRelease ?? releaseId,
    replication: replication || {},
    onEvent(event) {
      opsEvents?.observe({ key: event.key, service: event.service, category: event.category,
        healthy: event.healthy, severity: 'critical', adviceCode: event.adviceCode })
      return backupOptions?.onEvent?.(event)
    }
  })
  const uploadCleanup = createUploadCleanup({
    ...cleanupOptions,
    clock: options.clock,
    completedRetentionDays: imageArchiveOptions.retentionDays,
    archive: imageArchiveOptions.enabled ? input => service.archiveCompletedOrderImages(input) : undefined,
    removeCompleted: imageArchiveOptions.deletionEnabled ? input => service.deleteCompletedOrderImages(input) : undefined,
    collect: (input) => service.collectAbandonedUploads(input)
  })
  const service = createStudioService({
    ...options,
    imageArchive: { directory: imageArchiveOptions.directory, holdsFile: imageArchiveOptions.holdsFile },
    password: maintenanceFromEnv ? options.password : (options.password ?? null),
    onTransaction(context) {
      notifications?.onTransaction(context)
      options.onTransaction?.(context)
    },
    playerExtraMutate(context) {
      return notifications?.mutate(context) ?? options.playerExtraMutate?.(context)
    }
  })
  notifications = createPlayerNotifications(service.db, notificationOptions)
  let diagnosticCached, diagnosticAt = 0
  const staticRoot = resolve(options.staticRoot || 'dist')
  const loginAttempts = createLoginRateLimit({ clock: options.clock })
  const server = createServer((req, res) =>
    service.withReadScope(async () => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'same-origin')
      runtime.begin(req, res)
      const requestAddress = resolveAddress(req)
      let releaseUpload, releaseExport
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
        if (!url.pathname.startsWith(`${PREFIX}/`)) {
          if (req.method !== 'GET' && req.method !== 'HEAD')
            return json(res, 404, { message: '接口不存在' })
          let pathname
          try {
            pathname = decodeURIComponent(url.pathname)
          } catch {
            throw new ApiError('路径无效')
          }
          let target = resolve(staticRoot, '.' + pathname)
          if (target !== staticRoot && !target.startsWith(staticRoot + sep))
            throw new ApiError('路径无效', 403)
          if (!existsSync(target) || !statSync(target).isFile()) {
            if (extname(pathname)) return json(res, 404, { message: '文件不存在' })
            target = resolve(staticRoot, 'index.html')
          }
          if (!existsSync(target))
            return json(res, 404, {
              message: '前端尚未构建；开发请使用Vite页面，生产预览请先构建前端'
            })
          res.writeHead(200, {
            'Content-Type': MIME[extname(target)] || 'application/octet-stream',
            'Cache-Control':
              extname(target) === '.html' || pathname === '/player-sw.js'
                ? 'no-cache'
                : 'public, max-age=3600'
          })
          if (req.method === 'HEAD') res.end()
          else createReadStream(target).pipe(res)
          return
        }
        const path = url.pathname.slice(PREFIX.length)
        if (req.method === 'GET' && path === '/health/live')
          return json(res, 200, { status: 'ok', service: 'studio-api', release: releaseId })
        if (req.method === 'GET' && path === '/health/ready') {
          const ready = await readiness.check()
          return json(res, ready ? 200 : 503, ready
            ? { status: 'ready', service: 'studio-api', release: releaseId, checks: { database: true } }
            : { status: 'not-ready', service: 'studio-api', release: releaseId,
                category: 'database', adviceCode: 'CHECK_DATABASE' })
        }
        if (path === '/ops/summary' || path === '/ops/diagnostics-summary') {
          if (req.method !== 'GET') return json(res, 405, { code: 'OPS_READ_ONLY' })
          if (!monitorAuthority.accepts(req.headers.authorization))
            return json(res, 401, { code: 'MONITOR_UNAUTHORIZED' })
          if (path === '/ops/diagnostics-summary') {
            if (!diagnosticHours.includes(new Date().getUTCHours()))
              return json(res, 409, { code: 'OPS_DIAGNOSTICS_OUTSIDE_WINDOW' })
            if (diagnosticCached && Date.now() - diagnosticAt < diagnosticIntervalMs)
              return json(res, 200, { ...diagnosticCached, cached: true })
            const summary = service.operationsDiagnostics()
            diagnosticCached = summary; diagnosticAt = Date.now()
            return json(res, 200, { ...summary, cached: false })
          }
          const ready = await readiness.check()
          if (!ready) return json(res, 503, { status: 'not-ready', category: 'database', adviceCode: 'CHECK_DATABASE' })
          return json(res, 200, safeRuntimeSummary({ runtime: runtime.metrics(service.db),
            backups: backups.metrics(), release: releaseId, ready, probe: readiness.metrics() }))
        }
        // The independent player proxy selects its own cookie. The channel can
        // only narrow access; it never grants a role or trusts the admin cookie.
        const playerClient = req.headers['x-studio-client'] === 'player'
        const cookieName = playerClient ? PLAYER_COOKIE_NAME : COOKIE_NAME
        const token = cookieToken(req, cookieName)
        const secure = process.env.STUDIO_SECURE_COOKIE === 'true' ? '; Secure' : ''
        if (req.method === 'GET' && path === '/appearance/public')
          return json(res, 200, service.publicAppearance())
        const publicAssetMatch = path.match(/^\/public-assets\/([^/]+)$/)
        if (req.method === 'GET' && publicAssetMatch) {
          const attachment = service.publicAsset(publicAssetMatch[1])
          res.writeHead(200, {
            'Content-Type': attachment.mime,
            'Content-Length': attachment.size,
            'Cache-Control': 'no-store'
          })
          return res.end(attachment.data)
        }
        if (req.method === 'GET' && path === '/session') {
          const user = service.session(token)
          return json(res, 200, { user: playerClient && user?.role !== 'player' ? null : user })
        }
        if (req.method === 'POST') checkOrigin(req)
        if (req.method === 'POST' && path === '/login') {
          const body = await parseBody(req)
          const attempt = {
            channel: playerClient ? 'player' : 'admin',
            address: requestAddress,
            username: body.username
          }
          const retryAfter = loginAttempts.check(attempt)
          if (retryAfter) {
            res.setHeader('Retry-After', String(retryAfter))
            const wait = retryAfter >= 60 ? `${Math.ceil(retryAfter / 60)}分钟` : `${retryAfter}秒`
            throw new ApiError(`当前登录入口尝试过多，请${wait}后重试`, 429)
          }
          try {
            const result = service.login(body.username, body.password, {
              requiredRole: playerClient ? 'player' : undefined
            })
            loginAttempts.success(attempt)
            res.setHeader(
              'Set-Cookie',
              `${cookieName}=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`
            )
            return json(res, 200, {
              user: result.user,
              ...(result.maintenanceNotice ? { maintenanceNotice: result.maintenanceNotice } : {})
            })
          } catch (error) {
            if (error instanceof ApiError && [401, 403].includes(error.status))
              loginAttempts.failure(attempt)
            throw error
          }
        }
        if (req.method === 'POST' && path === '/logout') {
          const departingUser = service.session(token)
          if (playerClient && departingUser && departingUser.role !== 'player')
            throw new ApiError('打手端仅允许打手账号访问', 403)
          if (departingUser?.role === 'player') notifications.revoke(departingUser.id)
          service.logout(token)
          res.setHeader(
            'Set-Cookie',
            `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
          )
          return json(res, 200, { ok: true })
        }
        const user = service.session(token, {
          readOnly: req.method === 'GET' && path === '/diagnostics'
        })
        if (!user) throw new ApiError('请先登录', 401)
        if (playerClient && user.role !== 'player')
          throw new ApiError('打手端仅允许打手账号访问', 403)
        res.setHeader('X-Studio-User', user.id)
        if (user.role === 'player') {
          const playerPath =
            path.startsWith('/player/') ||
            /^\/uploads\/[^/]+$/.test(path) ||
            /^\/players\/[^/]+\/(?:deposit|deposits|deposit-transactions)$/.test(path) ||
            [
              '/bootstrap',
              '/appearance',
              '/uploads',
              '/profile',
              '/profile/password',
              '/exports/catalog',
              '/exports/preview',
              '/exports/download'
            ].includes(path)
          if (!playerPath) throw new ApiError('此接口不向打手账号开放', 403)
        }
        if (req.method === 'GET') {
          if (path === '/runtime/metrics') {
            const permissions = permissionsFor(user)
            if (
              !['owner', 'super_admin'].includes(user.role) ||
              !['logs.view', 'settings.manage'].every((permission) =>
                permissions.includes(permission)
              )
            )
              throw new ApiError('没有查看运行指标的权限', 403)
            return json(res, 200, {
              ...runtime.metrics(service.db),
              ...(notifications.queueStats ? { push: notifications.queueStats() } : {}),
              backups: backups.metrics(),
              uploadCleanup: uploadCleanup.metrics()
            })
          }
          if (path === '/changes') {
            const summary = service.staffChanges(user.id)
            const notices = notifications.summary(user.id)
            const version = `${summary.version}:${notices.version}`
            return json(res, 200, {
              ...summary,
              version,
              changed: String(url.searchParams.get('since') || '') !== version,
              unreadCount: notices.unreadCount
            })
          }
          if (path === '/orders/dispatch-targets')
            return json(res, 200, service.dispatchTargets(user.id))
          const operationResultMatch = path.match(/^\/player\/operation-results\/([^/]+)$/)
          if (operationResultMatch) {
            let requestId
            try {
              requestId = decodeURIComponent(operationResultMatch[1])
            } catch {
              throw Object.assign(new ApiError('原请求编号编码无效', 400), {
                code: 'INVALID_REQUEST_ID'
              })
            }
            return json(
              res,
              200,
              service.playerOperationResult(user.id, requestId, url.searchParams.get('family'))
            )
          }
          if (path === '/orders')
            return json(res, 200, service.ordersPage(user.id, Object.fromEntries(url.searchParams)))
          const adminOrderMatch = path.match(/^\/orders\/([^/]+)$/)
          if (adminOrderMatch)
            return json(res, 200, service.orderDetail(user.id, adminOrderMatch[1]))
          if (path === '/player-content') return json(res, 200, service.adminPlayerContent(user.id))
          if (path === '/player/content') return json(res, 200, service.playerContent(user.id))
          const contentMatch = path.match(/^\/player\/content\/([^/]+)$/)
          if (contentMatch) return json(res, 200, service.playerContent(user.id, contentMatch[1]))
          const contentAssetMatch = path.match(
            /^\/(player\/content-assets|player-content\/assets)\/([^/]+)$/
          )
          if (contentAssetMatch) {
            const attachment = service.playerContentAsset(
              user.id,
              contentAssetMatch[2],
              contentAssetMatch[1] === 'player/content-assets' ? 'player' : 'admin'
            )
            res.writeHead(200, {
              'Content-Type': attachment.mime,
              'Content-Length': attachment.size,
              'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
              'Cache-Control': 'private, no-store'
            })
            return res.end(attachment.data)
          }
          if (path === '/players')
            return json(res, 200, service.players(user.id, Object.fromEntries(url.searchParams)))
          const playerDetailMatch = path.match(/^\/players\/([^/]+)$/)
          if (playerDetailMatch)
            return json(res, 200, service.playerDetail(user.id, playerDetailMatch[1]))
          const playerHistoryDetailMatch = path.match(/^\/players\/([^/]+)\/orders\/([^/]+)$/)
          if (playerHistoryDetailMatch)
            return json(res, 200, service.playerHistoryDetail(user.id,
              playerHistoryDetailMatch[1], playerHistoryDetailMatch[2]))
          const playerHistoryMatch = path.match(/^\/players\/([^/]+)\/orders$/)
          if (playerHistoryMatch)
            return json(
              res,
              200,
              service.playerHistory(
                user.id,
                playerHistoryMatch[1],
                Object.fromEntries(url.searchParams)
              )
            )
          const playerDepositMatch = path.match(
            /^\/players\/([^/]+)\/(?:deposit|deposits|deposit-transactions)$/
          )
          if (playerDepositMatch)
            return json(
              res,
              200,
              service.playerDeposit(
                user.id,
                playerDepositMatch[1],
                Object.fromEntries(url.searchParams)
              )
            )
          const playerDepositDetailMatch = path.match(/^\/players\/([^/]+)\/deposits\/([^/]+)$/)
          if (playerDepositDetailMatch)
            return json(res, 200, service.playerDepositTransactionDetail(user.id,
              playerDepositDetailMatch[1], playerDepositDetailMatch[2]))
          const customerBalanceMatch = path.match(/^\/customers\/([^/]+)\/balance$/)
          if (customerBalanceMatch)
            return json(res, 200, service.customerBalance(user.id, customerBalanceMatch[1]))
          const customerTransactionsMatch = path.match(/^\/customers\/([^/]+)\/transactions$/)
          if (customerTransactionsMatch)
            return json(
              res,
              200,
              service.customerTransactions(
                user.id,
                customerTransactionsMatch[1],
                Object.fromEntries(url.searchParams)
              )
            )
          const customerTransactionDetailMatch = path.match(/^\/customers\/([^/]+)\/transactions\/([^/]+)$/)
          if (customerTransactionDetailMatch)
            return json(res, 200, service.customerTransactionDetail(user.id,
              customerTransactionDetailMatch[1], customerTransactionDetailMatch[2]))
          if (path === '/diagnostics') return json(res, 200, service.diagnostics(user.id))
          if (path === '/logs/archive-backup') {
            const backup = service.prepareArchiveBackup(user.id, url.searchParams.get('beforeDate'))
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': `attachment; filename="studio-audit-archive-before-${backup.beforeDate}.json"`,
              'Cache-Control': 'private, no-store',
              'X-Studio-Backup-Token': backup.backupToken,
              'X-Studio-Backup-Count': String(backup.rowCount)
            })
            const write = async (chunk) => {
              if (res.destroyed) throw new Error('备份下载连接已关闭')
              if (!res.write(chunk))
                await new Promise((resolve, reject) => {
                  const cleanup = () => {
                    res.off('drain', drained)
                    res.off('close', closed)
                    res.off('error', failed)
                  }
                  const drained = () => {
                    cleanup()
                    resolve()
                  }
                  const closed = () => {
                    cleanup()
                    reject(new Error('备份下载连接已关闭'))
                  }
                  const failed = (error) => {
                    cleanup()
                    reject(error)
                  }
                  res.once('drain', drained)
                  res.once('close', closed)
                  res.once('error', failed)
                })
            }
            try {
              await write(
                JSON.stringify({
                  format: 'studio-audit-archive-v1',
                  beforeDate: backup.beforeDate,
                  generatedAt: backup.generatedAt
                }).slice(0, -1) + ',"records":[\n'
              )
              let first = true
              for (const row of backup.records) {
                await write((first ? '' : ',\n') + row.payload)
                first = false
              }
              await write('\n]}')
              // 下载响应已完整交给HTTP发送队列；清理仍须用户确认已保存文件。
              res.once('finish', () => {
                try {
                  service.completeArchiveBackup(user.id, backup.backupToken, backup.beforeDate)
                } catch {
                  service.cancelArchiveBackup(backup.backupToken)
                }
              })
              res.once('close', () => {
                if (!res.writableFinished) service.cancelArchiveBackup(backup.backupToken)
              })
              return res.end()
            } catch (error) {
              service.cancelArchiveBackup(backup.backupToken)
              throw error
            }
          }
          if (path === '/logs/storage') return json(res, 200, service.logStorage(user.id))
          if (path === '/logs')
            return json(res, 200, service.logs(user.id, Object.fromEntries(url.searchParams)))
          const logMatch = path.match(/^\/logs\/([^/]+)$/)
          if (logMatch) return json(res, 200, service.logDetail(user.id, logMatch[1]))
          const referenceMatch = path.match(/^\/customers\/([^/]+)\/order-references$/)
          if (referenceMatch)
            return json(
              res,
              200,
              service.customerReferences(
                user.id,
                referenceMatch[1],
                Object.fromEntries(url.searchParams)
              )
            )
          if (path === '/appearance') return json(res, 200, service.getAppearance(user.id))
          if (path === '/bootstrap')
            return json(
              res,
              200,
              service.bootstrap(user.id, url.searchParams.get('month'), {
                includeOrders: url.searchParams.get('includeOrders') !== 'false',
                includeReports: url.searchParams.get('includeReports') !== 'false'
              })
            )
          if (path === '/overview')
            return json(
              res,
              200,
              service.overview(user.id, {
                start: url.searchParams.get('start'),
                end: url.searchParams.get('end')
              })
            )
          if (path === '/overview/details')
            return json(res, 200, service.overviewDetails(user.id, Object.fromEntries(url.searchParams)))
          if (path === '/exports/catalog')
            return json(
              res,
              200,
              getExportCatalog(
                service.exportCatalogSnapshot(user.id, {
                  month: url.searchParams.get('month') || undefined,
                  period: {
                    type: url.searchParams.get('periodType') || 'monthly',
                    date: url.searchParams.get('periodDate') || undefined
                  },
                  filters: { archived: url.searchParams.get('archived') || 'all' }
                })
              )
            )
          if (path === '/player/orders')
            return json(
              res,
              200,
              url.searchParams.size
                ? service.playerOrdersPage(user.id, Object.fromEntries(url.searchParams))
                : service.playerOrders(user.id)
            )
          if (path === '/player/appearance')
            return json(res, 200, service.playerAppearance(user.id))
          if (path === '/player/changes') {
            const summary = service.playerChanges(user.id)
            const notices = notifications.summary(user.id)
            const version = `${summary.version}:${notices.version}`
            return json(res, 200, {
              ...summary,
              version,
              changed: String(url.searchParams.get('since') || '') !== version,
              unreadCount: notices.unreadCount
            })
          }
          if (path === '/player/wallet')
            return json(res, 200, service.playerWallet(user.id, {
              includeRecords: url.searchParams.get('includeRecords') !== 'false'
            }))
          if (path === '/player/withdrawals')
            return json(res, 200, service.playerWithdrawalsPage(user.id, Object.fromEntries(url.searchParams)))
          if (path === '/player/wallet/ledger')
            return json(res, 200, service.playerLedgerPage(user.id, Object.fromEntries(url.searchParams)))
          const playerOrderMatch = path.match(/^\/player\/orders\/([^/]+)$/)
          if (playerOrderMatch)
            return json(res, 200, service.playerOrderDetail(user.id, playerOrderMatch[1]))
          if (path === '/player/profile') return json(res, 200, service.playerProfile(user.id))
          if (path === '/player/teammates') return json(res, 200, service.playerTeammates(user.id))
          if (path === '/player/payment-methods')
            return json(res, 200, service.playerPaymentMethods(user.id))
          if (path === '/player/leaderboard')
            return json(
              res,
              200,
              service.playerLeaderboard(user.id, Object.fromEntries(url.searchParams))
            )
          if (path === '/player/notifications')
            return json(res, 200, notifications.list(user.id, Object.fromEntries(url.searchParams)))
          const playerNoticeMatch = path.match(/^\/player\/notifications\/([^/]+)$/)
          if (playerNoticeMatch)
            return json(res, 200, notifications.detail(user.id, playerNoticeMatch[1]))
          if (path === '/player/push-subscriptions/status')
            return json(res, 200, notifications.bindingStatus(user.id, Object.fromEntries(url.searchParams)))
          if (path === '/player/notification-settings')
            return json(res, 200, notifications.settings(user.id))
          if (path === '/player/push-config') return json(res, 200, notifications.config(user.id))
          if (path === '/notifications')
            return json(
              res,
              200,
              notifications.list(user.id, Object.fromEntries(url.searchParams), false)
            )
          if (path === '/notifications/timeouts')
            return json(
              res,
              200,
              notifications.listStaffTimeouts(user.id, Object.fromEntries(url.searchParams))
            )
          if (path === '/notifications/delivery-status')
            return json(res, 200, notifications.deliveryStatus(user.id))
          const uploadMatch = path.match(/^\/uploads\/([^/]+)$/)
          if (uploadMatch) {
            const attachment = service.download(user.id, uploadMatch[1])
            res.writeHead(200, {
              'Content-Type': attachment.mime,
              'Content-Length': attachment.size,
              'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
              'Cache-Control': 'private, no-store'
            })
            return res.end(attachment.data)
          }
        }
        if (req.method === 'POST') {
          if (
            ['/exports/preview', '/exports/download'].includes(path) &&
            !permissionsFor(user).includes('reports.export')
          )
            throw new ApiError('没有导出数据的权限', 403)
          if (/^\/player\/orders\/[^/]+\/(claim|accept)$/.test(path))
            runtime.claim(user.id, requestAddress)
          if (path === '/uploads') releaseUpload = runtime.acquireUpload(user.id, requestAddress)
          if (path === '/exports/download') releaseExport = await runtime.acquireExport()
          if (req.destroyed) throw new ApiError('请求已取消', 400)
          const body = await parseBody(req)
          const noticeReadMatch = path.match(/^\/notifications\/([^/]+)\/read$/)
          if (noticeReadMatch)
            return json(res, 200, notifications.readStaff(user.id, noticeReadMatch[1]))
          if (path === '/exports/preview' || path === '/exports/download') {
            const snapshot = service.exportSnapshot(user.id, body)
            if (releaseExport) {
              const finishExport = releaseExport
              res.once('finish', finishExport)
              res.once('close', finishExport)
              releaseExport = undefined
            }
            return json(
              res,
              200,
              buildExportSheets(
                snapshot,
                body,
                path === '/exports/preview' ? { previewLimit: 20 } : {}
              )
            )
          }
          return json(
            res,
            200,
            path === '/uploads'
              ? service.upload(user.id, body, {
                  sessionToken: token,
                  expectedActorId: req.headers['x-studio-actor']
                })
              : service.mutate(user.id, path, body, {
                  sessionToken: token,
                  expectedActorId: req.headers['x-studio-actor'],
                  requireActor: service.requiresWriteIdentity(path)
                })
          )
        }
        throw new ApiError('接口不存在', 404)
      } catch (error) {
        if (
          error instanceof ApiError ||
          error?.runtimeProtection ||
          (error?.publicBusinessError === true &&
            error.status === 409 &&
            typeof error.code === 'string')
        ) {
          if (error.details?.retryAfter)
            res.setHeader('Retry-After', String(error.details.retryAfter))
          return json(res, error.status, {
            message: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...(error.details ? { details: error.details } : {})
          })
        }
        console.error('[studio] 请求处理失败：', error?.message || 'unknown')
        if (!res.headersSent) json(res, 500, { message: '服务器处理失败，请稍后重试' })
        else res.end()
      } finally {
        releaseUpload?.()
        releaseExport?.()
      }
    })
  )
  server.service = service
  server.notifications = notifications
  server.runtime = runtime
  server.backups = backups
  server.uploadCleanup = uploadCleanup
  server.readiness = readiness
  const tick = () => {
    try {
      notifications.scanTimeouts()
    } catch (error) {
      console.error('[studio] 通知任务失败：', error?.message || 'unknown')
    }
    void notifications.flushPush().catch(() => {})
  }
  const notificationTimer = setInterval(tick, options.notificationIntervalMs || 30000)
  notificationTimer.unref()
  server.on('listening', tick)
  server.on('listening', () => backups.start())
  server.on('listening', () => uploadCleanup.start())
  server.on('close', () => {
    clearInterval(notificationTimer)
    runtime.close()
    backups.close()
    uploadCleanup.close()
    notifications.close()
    readiness.close()
    service.close()
    if (ownsOpsEvents) void opsEvents.close().catch(() => {})
  })
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.STUDIO_HOST || '127.0.0.1'
  const port = Number(process.env.STUDIO_PORT || 3007)
  const databasePath = process.env.STUDIO_DB_PATH || resolve('.data/studio.sqlite')
  const localMonitor = readLocalMonitorBinding({ host, port, dbPath: databasePath })
  if (localMonitor && process.env.STUDIO_MONITOR_TOKEN &&
      process.env.STUDIO_MONITOR_TOKEN !== localMonitor.token)
    throw new Error('LOCAL_MONITOR_BINDING_INVALID')
  const server = createStudioServer({
    dbPath: databasePath,
    maintenanceFromEnv: true,
    password: process.env.STUDIO_ADMIN_PASSWORD,
    seed: localMonitor ? false : process.env.STUDIO_DEMO !== 'false',
    monitor: { token: localMonitor?.token, diagnosticHoursUTC: process.env.STUDIO_DIAGNOSTIC_HOURS_UTC
      ? process.env.STUDIO_DIAGNOSTIC_HOURS_UTC.split(',').map(Number) : [] },
    releaseId: readReleaseManifest()?.id ?? null
  })
  server.listen(port, host, () => {
    console.log(`工作室 API 已启动：http://${host}:${port}/api/studio`)
    console.log(
      '首次登录账号为 admin；初始密码使用 STUDIO_ADMIN_PASSWORD，未配置则读取 .data/bootstrap-password.txt。'
    )
  })
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
