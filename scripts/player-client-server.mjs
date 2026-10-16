import { createServer, request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTrustedProxyResolver, sanitizedProxyHeaders } from '../server/runtime-protection.mjs'

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
  '.woff2': 'font/woff2'
}
const json = (res, status, message) => {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify({ message }))
}
export const playerCookies = (value) =>
  String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('studio_player_session='))
    .join('; ')

/** Standalone player assets plus a fixed upstream API; there is no second business server/database. */
export function createPlayerClientServer({
  staticRoot = resolve('player-client/dist'),
  apiTarget = process.env.STUDIO_API_TARGET || 'http://127.0.0.1:3007',
  trustedProxies = process.env.STUDIO_PLAYER_TRUSTED_PROXIES || ''
} = {}) {
  const root = resolve(staticRoot),
    target = new URL(apiTarget)
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== '/'
  )
    throw new Error('后台接口地址必须为 HTTP/HTTPS 服务源地址')
  const resolveAddress = createTrustedProxyResolver(trustedProxies)
  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    let url
    try {
      url = new URL(req.url || '/', 'http://player.local')
    } catch {
      return json(res, 400, '请求地址无效')
    }
    if (url.pathname.startsWith('/api/studio/')) {
      const headers = {
        ...sanitizedProxyHeaders(req, { resolveAddress }),
        host: target.host,
        cookie: playerCookies(req.headers.cookie),
        'x-studio-client': 'player'
      }
      for (const name of [
        'connection',
        'proxy-authorization',
        'proxy-authenticate',
        'authorization',
        'keep-alive',
        'upgrade',
        'te',
        'trailer'
      ])
        delete headers[name]
      const request = target.protocol === 'https:' ? requestHttps : requestHttp
      const upstream = request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          method: req.method,
          path: url.pathname + url.search,
          headers,
          timeout: 30000
        },
        (response) => {
          const responseHeaders = { ...response.headers, 'cache-control': 'no-store' }
          delete responseHeaders.connection
          if (responseHeaders['set-cookie'])
            responseHeaders['set-cookie'] = responseHeaders['set-cookie'].filter((cookie) =>
              cookie.startsWith('studio_player_session=')
            )
          res.writeHead(response.statusCode || 502, responseHeaders)
          response.on('error', () => res.destroy())
          response.pipe(res)
        }
      )
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
      upstream.on('error', () => json(res, 502, '后台接口暂时无法连接，请稍后重试'))
      req.on('aborted', () => upstream.destroy())
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy()
      })
      req.pipe(upstream)
      return
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, '接口不存在')
    if (!['GET', 'HEAD'].includes(req.method || ''))
      return json(res, 405, '请通过后台接口提交业务操作')
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return json(res, 400, '路径无效')
    }
    let file = resolve(root, '.' + pathname)
    if (file !== root && !file.startsWith(root + sep)) return json(res, 403, '路径无效')
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(pathname)) return json(res, 404, '文件不存在')
      file = resolve(root, 'index.html')
    }
    if (!existsSync(file)) return json(res, 503, '打手端尚未构建，请先运行 pnpm build:player')
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Cache-Control':
        extname(file) === '.html' || pathname === '/player-sw.js'
          ? 'no-cache'
          : 'public, max-age=3600'
    })
    if (req.method === 'HEAD') res.end()
    else
      createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res)
  })
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.STUDIO_PLAYER_HOST || '127.0.0.1'
  const port = Number(process.env.STUDIO_PLAYER_PORT || 3008)
  const server = createPlayerClientServer()
  server.listen(port, host, () =>
    console.log(`独立打手端已启动：http://${host}:${port}/#/player/login`)
  )
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
