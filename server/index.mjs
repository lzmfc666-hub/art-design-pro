import { createServer } from 'node:http'
import { existsSync, statSync, createReadStream } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudioService, ApiError } from './studio.mjs'
import { getExportCatalog, buildExportSheets } from './report-export.mjs'

const PREFIX = '/api/studio'
const COOKIE_NAME = 'studio_session'
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
const cookieToken = (req) => {
  const cookie = req.headers.cookie || ''
  const match = cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${COOKIE_NAME}=`))
  return match ? match.slice(COOKIE_NAME.length + 1) : null
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
  const service = createStudioService(options)
  const staticRoot = resolve(options.staticRoot || 'dist')
  const loginAttempts = new Map()
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
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
          'Cache-Control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=3600'
        })
        if (req.method === 'HEAD') res.end()
        else createReadStream(target).pipe(res)
        return
      }
      const path = url.pathname.slice(PREFIX.length)
      const token = cookieToken(req)
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
      if (req.method === 'GET' && path === '/session')
        return json(res, 200, { user: service.session(token) })
      if (req.method === 'POST') checkOrigin(req)
      if (req.method === 'POST' && path === '/login') {
        const key = req.socket.remoteAddress || 'local',
          timestamp = Date.now()
        let attempts = loginAttempts.get(key)
        if (!attempts || timestamp > attempts.resetAt) {
          attempts = { count: 0, resetAt: timestamp + 15 * 60000 }
          loginAttempts.set(key, attempts)
        }
        if (attempts.count >= 15) throw new ApiError('登录尝试过多，请15分钟后重试', 429)
        const body = await parseBody(req)
        try {
          const result = service.login(body.username, body.password)
          loginAttempts.delete(key)
          const secure = process.env.STUDIO_SECURE_COOKIE === 'true' ? '; Secure' : ''
          res.setHeader(
            'Set-Cookie',
            `${COOKIE_NAME}=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`
          )
          return json(res, 200, {
            user: result.user,
            ...(result.maintenanceNotice ? { maintenanceNotice: result.maintenanceNotice } : {})
          })
        } catch (error) {
          attempts.count++
          throw error
        }
      }
      if (req.method === 'POST' && path === '/logout') {
        service.logout(token)
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
        return json(res, 200, { ok: true })
      }
      const user = service.session(token)
      if (!user) throw new ApiError('请先登录', 401)
      if (req.method === 'GET') {
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
          return json(res, 200, service.bootstrap(user.id, url.searchParams.get('month')))
        if (path === '/overview')
          return json(
            res,
            200,
            service.overview(user.id, {
              start: url.searchParams.get('start'),
              end: url.searchParams.get('end')
            })
          )
        if (path === '/exports/catalog')
          return json(
            res,
            200,
            getExportCatalog(
              service.exportSnapshot(user.id, {
                month: url.searchParams.get('month') || undefined,
                period: {
                  type: url.searchParams.get('periodType') || 'monthly',
                  date: url.searchParams.get('periodDate') || undefined
                },
                filters: { archived: url.searchParams.get('archived') || 'all' }
              })
            )
          )
        if (path === '/player/orders') return json(res, 200, service.playerOrders(user.id))
        if (path === '/player/wallet') return json(res, 200, service.playerWallet(user.id))
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
        const body = await parseBody(req)
        if (path === '/exports/preview' || path === '/exports/download') {
          const snapshot = service.exportSnapshot(user.id, body)
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
          path === '/uploads' ? service.upload(user.id, body) : service.mutate(user.id, path, body)
        )
      }
      throw new ApiError('接口不存在', 404)
    } catch (error) {
      if (error instanceof ApiError) return json(res, error.status, { message: error.message })
      console.error('[studio] 请求处理失败：', error?.message || 'unknown')
      if (!res.headersSent) json(res, 500, { message: '服务器处理失败，请稍后重试' })
      else res.end()
    }
  })
  server.service = service
  server.on('close', () => service.close())
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.STUDIO_HOST || '127.0.0.1'
  const port = Number(process.env.STUDIO_PORT || 3007)
  const server = createStudioServer({
    dbPath: process.env.STUDIO_DB_PATH || resolve('.data/studio.sqlite'),
    seed: process.env.STUDIO_DEMO !== 'false'
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
