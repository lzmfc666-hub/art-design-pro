import { createServer, request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTrustedProxyResolver, sanitizedProxyHeaders } from '../server/runtime-protection.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'
}
const bootstrap = `(() => {
  const location = window.location;
  const hash = location.hash.replace(/^#/, '');
  const path = hash.split(/[?#]/, 1)[0];
  if (!/^\\/merchant\\/(login|overview|orders|create|staff|profile)$/.test(path) || /[\\\\\\u0000-\\u001f\\u007f]/.test(hash)) {
    const target = new URL(location.href);
    target.hash = '/merchant/login';
    location.replace(target.href);
  }
})();\n`

export const merchantCookies = value => String(value || '').split(';').map(part => part.trim())
  .filter(part => part.startsWith('studio_merchant_session=')).join('; ')

function cleanHopHeaders(input) {
  const headers = { ...input }
  const names = ['connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive',
    'upgrade', 'te', 'trailer', 'transfer-encoding',
    ...String(headers.connection || '').split(',').map(name => name.trim().toLowerCase())]
  for (const name of names) delete headers[name]
  return headers
}
function json(res, status, message) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ message }))
}
function send(req, res, type, body, cache = 'no-store') {
  const bytes = Buffer.from(body)
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': cache })
  res.end(req.method === 'HEAD' ? undefined : bytes)
}

/** Independent merchant website; it never opens a business database or alters the shared build. */
export function createMerchantClientServer({
  staticRoot = process.env.STUDIO_MERCHANT_STATIC_ROOT || resolve('../studio-app/dist'),
  apiTarget = process.env.STUDIO_API_TARGET || 'http://127.0.0.1:3007',
  trustedProxies = ''
} = {}) {
  const root = resolve(staticRoot), target = new URL(apiTarget)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash)
    throw new Error('后台接口地址必须为 HTTP/HTTPS 服务源地址')
  const resolveAddress = createTrustedProxyResolver(trustedProxies)
  return createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    let url
    try { url = new URL(req.url || '/', 'http://merchant.local') }
    catch { return json(res, 400, '请求地址无效') }
    if (url.pathname.startsWith('/api/studio/')) {
      const headers = cleanHopHeaders(sanitizedProxyHeaders(req, { resolveAddress }))
      delete headers.authorization
      // The socket destination is fixed above; preserve the browser's Host and
      // Origin so the existing API applies its normal same-origin write check.
      headers.host = req.headers.host || target.host
      if (req.headers.origin !== undefined) headers.origin = req.headers.origin
      headers.cookie = merchantCookies(req.headers.cookie)
      headers['x-studio-client'] = 'merchant'
      const request = target.protocol === 'https:' ? requestHttps : requestHttp
      const upstream = request({ protocol: target.protocol, hostname: target.hostname,
        port: target.port, method: req.method, path: url.pathname + url.search, headers, timeout: 30000 }, response => {
        const reply = cleanHopHeaders(response.headers)
        reply['cache-control'] = 'no-store'
        if (reply['set-cookie']) reply['set-cookie'] = reply['set-cookie']
          .filter(cookie => cookie.startsWith('studio_merchant_session='))
        if (res.destroyed) { response.destroy(); return }
        res.writeHead(response.statusCode || 502, reply)
        response.on('error', () => res.destroy())
        response.pipe(res)
      })
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
      upstream.on('error', () => json(res, 502, '后台接口暂时无法连接，请稍后重试'))
      req.on('aborted', () => upstream.destroy())
      req.on('error', () => upstream.destroy())
      res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
      req.pipe(upstream)
      return
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, '接口不存在')
    if (!['GET', 'HEAD'].includes(req.method || '')) return json(res, 405, '请通过后台接口提交业务操作')
    if (url.pathname === '/merchant-entry.js') return send(req, res, MIME['.js'], bootstrap)
    let pathname
    try { pathname = decodeURIComponent(url.pathname) }
    catch { return json(res, 400, '路径无效') }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.')))
      return json(res, 403, '路径无效')
    let file = resolve(root, '.' + pathname)
    if (file !== root && !file.startsWith(root + sep)) return json(res, 403, '路径无效')
    const extension = extname(pathname).toLowerCase()
    if (extension === '.html' && pathname !== '/index.html') return json(res, 404, '文件不存在')
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        if (extension) return json(res, 404, '文件不存在')
        file = resolve(root, 'index.html')
      }
      if (!existsSync(file)) return json(res, 503, '商家端构建尚不可读取，请检查静态目录')
      const actual = realpathSync(file), actualRoot = realpathSync(root)
      if (!actual.startsWith(actualRoot + sep)) return json(res, 403, '路径无效')
      if (file === resolve(root, 'index.html')) {
        let html = readFileSync(file, 'utf8')
        const entry = '<script src="/merchant-entry.js"></script>'
        html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, '$&' + entry) : entry + html
        return send(req, res, MIME['.html'], html)
      }
      const type = MIME[extname(file).toLowerCase()]
      if (!type) return json(res, 404, '文件不存在')
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(file).size,
        'Cache-Control': 'public, max-age=3600' })
      if (req.method === 'HEAD') res.end()
      else createReadStream(file).on('error', () => res.destroy()).pipe(res)
    } catch { json(res, 503, '商家端静态文件暂时不可读取') }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.STUDIO_MERCHANT_HOST || '127.0.0.1'
  const port = Number(process.env.STUDIO_MERCHANT_PORT || 3009)
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('商家入口必须绑定本机地址和有效端口')
  const server = createMerchantClientServer({ trustedProxies: process.env.STUDIO_MERCHANT_TRUSTED_PROXIES || '127.0.0.1,::1' })
  server.listen(port, host, () => console.log(`独立商家端已启动：http://${host}:${port}/#/merchant/login`))
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
