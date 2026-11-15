import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createServer } from 'node:net'
import { preview } from 'vite'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const round = value => Math.round(value * 100) / 100
const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * ratio) - 1)] || 0
const fingerprint = directory => {
  const files = {}
  const visit = parent => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name)
      if (entry.isDirectory()) visit(path)
      else files[relative(directory, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  visit(directory)
  return { files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}

/** Three real merchant browser contexts reading the current production build. */
export async function runMerchantClientLoad({ apiBase, cookies, merchantIds, output }) {
  const api = new URL(apiBase)
  assert.equal(api.protocol, 'http:')
  assert.equal(api.hostname, '127.0.0.1')
  assert.ok(api.port && !['3006', '3007', '3008'].includes(api.port))
  assert.equal(api.pathname, '/')
  assert.equal(cookies.length, 3)
  assert.equal(merchantIds.length, 2)
  const directory = resolve(output), staticRoot = join(root, 'dist')
  assert.ok(existsSync(join(staticRoot, 'index.html')), 'current admin/merchant production build must exist')
  mkdirSync(join(directory, 'tmp'), { recursive: true })
  process.env.TEMP = process.env.TMP = join(directory, 'tmp')
  const sourceBefore = fingerprint(staticRoot)
  const require = createRequire(import.meta.url)
  let chromium
  try { ({ chromium } = require('playwright')) }
  catch { ({ chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')) }
  const report = { output: directory, productionBuild: true, readOnly: true, accountContexts: 3, simulatedResponses: 0,
    sourceBefore, requests: [], steps: [], failures: [], pageErrors: [], writeAttempts: [], screenshots: [],
    limitations: ['Three contexts measure actual request traffic, not an online-user capacity.', 'No formal server, HTTPS or mobile push arrival is measured.'] }
  let browser, frontend, active = 0, peak = 0
  const started = performance.now()
  try {
    const probe = createServer()
    await new Promise(ready => probe.listen(0, '127.0.0.1', ready))
    const port = probe.address().port
    await new Promise(ready => probe.close(ready))
    frontend = await preview({ root, configFile: false, preview: { host: '127.0.0.1', port, strictPort: true,
      proxy: { '/api/studio': { target: apiBase, changeOrigin: true } } } })
    const origin = `http://127.0.0.1:${frontend.httpServer.address().port}`
    browser = await chromium.launch({ headless: true, channel: 'msedge' })
    report.browserVersion = browser.version()
    await Promise.all(cookies.map(async (cookie, index) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
      const token = cookie.match(/(?:^|;\s*)studio_merchant_session=([^;]+)/)?.[1]
      assert.ok(token, 'dedicated merchant cookie required')
      await context.addCookies([{ name: 'studio_merchant_session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }])
      await context.route('**/api/studio/**', async route => {
        if (!['GET', 'HEAD'].includes(route.request().method())) {
          report.writeAttempts.push({ index, path: new URL(route.request().url()).pathname })
          await route.abort('blockedbyclient')
        } else await route.continue()
      })
      const page = await context.newPage(), records = new Map()
      page.setDefaultTimeout(30000)
      page.on('pageerror', error => report.pageErrors.push({ index, message: error.message }))
      page.on('request', request => {
        const url = new URL(request.url())
        if (!url.pathname.startsWith('/api/studio/')) return
        const row = { index, method: request.method(), path: url.pathname + url.search, started: performance.now() }
        records.set(request, row); report.requests.push(row)
        active++; peak = Math.max(peak, active)
      })
      page.on('response', response => {
        const row = records.get(response.request())
        if (!row) return
        row.status = response.status()
        if (row.status >= 400) report.failures.push({ index, path: row.path, status: row.status })
      })
      const finish = (request, failure) => {
        const row = records.get(request)
        if (!row || row.ms !== undefined) return
        active--; row.ms = round(performance.now() - row.started); delete row.started
        if (failure) row.failure = failure
        if (failure && !/ERR_ABORTED|aborted/i.test(failure)) report.failures.push({ index, path: row.path, failure })
      }
      page.on('requestfinished', request => finish(request))
      page.on('requestfailed', request => finish(request, request.failure()?.errorText || 'failed'))
      const capture = async name => {
        const path = join(directory, `merchant-${index}-${name}.png`)
        await page.screenshot({ path, fullPage: true }); report.screenshots.push(path)
      }
      const step = async (name, action, pathname, condition = () => true) => {
        const began = performance.now()
        const waiting = page.waitForResponse(response => {
          const url = new URL(response.url())
          return response.request().method() === 'GET' && url.pathname === `/api/studio/${pathname}` && condition(url.searchParams)
        })
        await action()
        const response = await waiting
        assert.equal(response.status(), 200, name)
        report.steps.push({ index, name, ms: round(performance.now() - began), path: new URL(response.url()).pathname + new URL(response.url()).search })
        const data = await response.json()
        if (pathname === 'orders') assert.ok(data.records.every(order => order.merchantId === merchantIds[index === 2 ? 1 : 0]))
        return data
      }
      try {
        const overview = await step('merchant-overview', () => page.goto(`${origin}/#/merchant/overview`), 'merchant/overview')
        assert.equal(overview.summary.orders, 30)
        await page.getByText('商家数据看板', { exact: true }).first().waitFor()
        await page.waitForLoadState('networkidle')
        assert.doesNotMatch(await page.locator('#app-main').innerText(), /打手到手|打手报酬|成本金额/)
        await capture('overview')
        const list = await step('merchant-orders', () => page.goto(`${origin}/#/merchant/orders`), 'orders')
        assert.equal(list.total, 30)
        await page.locator('#app-main .el-table__body tr').first().waitFor()
        await page.waitForLoadState('networkidle')
        const page2 = await step('merchant-next-page', () => page.locator('#app-main .el-pagination .btn-next').last().click(), 'orders', query => query.get('current') === '2')
        assert.equal(page2.records.length, 10)
        const title = page.getByPlaceholder('按订单项目搜索', { exact: true })
        if (!await title.isVisible()) await page.locator('.art-search-bar .filter-toggle').click()
        await title.fill('商家压力')
        const filtered = await step('merchant-title-search', () => page.locator('.art-search-bar .search-button').click(), 'orders', query => query.get('title') === '商家压力')
        assert.equal(filtered.total, 30)
        await capture('search')
        await page.goto(`${origin}/#/merchant/create`)
        await page.getByRole('button', { name: '发布商家订单', exact: true }).waitFor()
        await page.waitForLoadState('networkidle')
        assert.doesNotMatch(await page.locator('#app-main').innerText(), /打手到手|打手报酬/)
        report.steps.push({ index, name: 'merchant-create-template-read', path: '/#/merchant/create' })
      } catch (error) {
        report.failures.push({ index, message: error.message })
        await capture('failure')
      } finally { await context.close() }
    }))
  } catch (error) { report.failures.push({ message: error.message }) }
  finally {
    await browser?.close()
    if (frontend) await new Promise(ready => frontend.httpServer.close(ready))
    const completed = report.requests.filter(row => row.ms !== undefined && !row.failure && row.status === 200)
    const values = completed.map(row => row.ms), elapsedMs = performance.now() - started
    Object.assign(report, { elapsedMs: round(elapsedMs), requestCount: report.requests.length, peakConcurrentRequests: peak,
      p50Ms: round(percentile(values, 0.5)), p95Ms: round(percentile(values, 0.95)), maxMs: round(Math.max(0, ...values)),
      throughputPerSecond: round(completed.length / (elapsedMs / 1000)), sourceAfter: fingerprint(staticRoot) })
    report.builtAssetsUnchanged = report.sourceBefore.digest === report.sourceAfter.digest
    report.success = report.failures.length === 0 && report.pageErrors.length === 0 && report.writeAttempts.length === 0 && report.builtAssetsUnchanged
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  }
  return report
}
