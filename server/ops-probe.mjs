import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'

/** No cookies, no redirects, no private response content is returned on errors. */
export function probeHttp(target, { timeoutMs = 5000, kind = 'ready', token, expectedRelease, expectedPageSha256, ca } = {}) {
  if (!target) return Promise.resolve({ healthy: null, code: 'NOT_CONFIGURED' })
  let url
  try { url = new URL(target) } catch { return Promise.resolve({ healthy: null, code: 'INVALID_TARGET' }) }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol))
    return Promise.resolve({ healthy: null, code: 'INVALID_TARGET' })
  if (token && (typeof token !== 'string' || !/^[^\s]{32,256}$/.test(token)))
    return Promise.resolve({ healthy: false, code: 'CREDENTIALS_INVALID' })
  const started = performance.now()
  return new Promise(resolve => {
    let settled = false, certificateDays = null
    const finish = value => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({ ...value, durationMs: Math.round((performance.now() - started) * 100) / 100, certificateDays })
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', agent: false, ca, headers: token ? { Authorization: `Bearer ${token}` } : {}
    }, res => {
      let body = '', bytes = 0
      const chunks = []
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 1048576) { request.destroy(); finish({ healthy: false, code: 'BODY_LIMIT' }); return }
        chunks.push(chunk)
      })
      res.once('aborted', () => finish({ healthy: false, code: 'RESPONSE_ABORTED' }))
      res.once('error', () => finish({ healthy: false, code: 'RESPONSE_ABORTED' }))
      res.once('end', () => {
        body = Buffer.concat(chunks).toString('utf8')
        if ([401, 403].includes(res.statusCode)) return finish({ healthy: false, code: 'CREDENTIALS_INVALID' })
        if (res.statusCode === 429) return finish({ healthy: false, code: 'PROBE_RATE_LIMITED' })
        if (res.statusCode >= 300 && res.statusCode < 400) return finish({ healthy: false, code: 'REDIRECT' })
        if (kind === 'page') return finish({ healthy: res.statusCode === 200 &&
          String(res.headers['content-type']).includes('text/html') && /id=["']app["']/.test(body) &&
          (!expectedPageSha256 || createHash('sha256').update(body).digest('hex') === expectedPageSha256), code: 'PAGE_CONTENT' })
        let data
        try { data = JSON.parse(body) } catch { return finish({ healthy: false, code: 'JSON_CONTENT' }) }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return finish({ healthy: false, code: 'JSON_CONTENT' })
        if (!String(res.headers['content-type']).includes('application/json')) return finish({ healthy: false, code: 'JSON_CONTENT' })
        if (kind === 'live' || kind === 'ready') {
          const valid = data.service === 'studio-api' &&
            (kind === 'live' ? data.status === 'ok' : data.status === 'ready' && data.checks?.database === true)
          const version = !expectedRelease || data.release === expectedRelease
          return finish({ healthy: res.statusCode === 200 && valid && version,
            code: !version ? 'RELEASE_MISMATCH' : data.category === 'database' ? 'DATABASE_NOT_READY' : 'API_CONTENT',
            release: /^[a-f0-9]{64}$/.test(data.release || '') ? data.release : null })
        }
        if (kind === 'summary') {
          const count = value => Number.isFinite(value) && value >= 0
          const valid = data.source === 'actual-runtime' && data.status === 'ready' &&
            [data.http?.requests, data.http?.errors, data.http?.sampleCount, data.http?.p95Ms,
              data.process?.rssBytes, data.process?.heapUsedBytes, data.push?.pendingDue, data.push?.oldestDueWaitMs]
              .every(count) && data.http.errors <= data.http.requests &&
            data.storage && [data.storage.freeBytes, data.storage.walBytes].every(value => value === null || count(value)) &&
            Array.isArray(data.logs) && data.logs.length <= 50 && data.logs.every(row => row && typeof row === 'object' &&
              !Array.isArray(row) && count(row.bytes)) &&
            typeof data.backups?.enabled === 'boolean' && count(data.backups.ageMs) &&
            (!expectedRelease || data.release === expectedRelease)
          return finish({ healthy: res.statusCode === 200 && valid, code: data.category === 'database' ? 'DATABASE_NOT_READY' : 'SUMMARY_CONTENT',
            ...(valid && res.statusCode === 200 ? { metrics: data } : {}) })
        }
        const valid = Number.isInteger(data.errorCount) && data.errorCount >= 0 && Number.isInteger(data.warningCount) &&
          data.warningCount >= 0 && Number.isFinite(Date.parse(data.generatedAt))
        finish({ healthy: res.statusCode === 200 && valid, code: 'DIAGNOSTICS_CONTENT',
          ...(valid && res.statusCode === 200 ? { diagnostics: data } : {}) })
      })
    })
    const timer = setTimeout(() => { request.destroy(); finish({ healthy: false, code: 'TIMEOUT' }) }, timeoutMs)
    request.once('error', error => finish({ healthy: false, code:
      ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID'].includes(error.code)
        ? 'CERTIFICATE_INVALID' : 'NETWORK_UNAVAILABLE' }))
    if (url.protocol === 'https:') request.on('socket', socket => socket.once('secureConnect', () => {
      const end = Date.parse(socket.getPeerCertificate()?.valid_to)
      certificateDays = Number.isFinite(end) ? Math.floor((end - Date.now()) / 86400000) : null
    }))
    request.end()
  })
}
