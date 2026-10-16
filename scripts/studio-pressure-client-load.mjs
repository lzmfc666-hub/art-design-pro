import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createPlayerClientServer } from './player-client-server.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const round = (value) => Math.round(value * 100) / 100
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] || 0
const assetFingerprint = (directory) => {
  const entries = {}
  const visit = (parent) => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name)
      if (entry.isDirectory()) visit(path)
      else entries[relative(directory, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  visit(directory)
  return { algorithm: 'SHA256', files: entries, digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}

/** Read-only browser traffic from the actual production player build and fixed player proxy. */
export async function runPlayerClientLoad({ apiBase, cookies, playerIds, output }) {
  const target = new URL(apiBase)
  assert.equal(target.protocol, 'http:')
  assert.equal(target.hostname, '127.0.0.1')
  assert.equal(target.pathname, '/')
  assert.ok(!['3006', '3007', '3008'].includes(target.port), 'refuse existing local development services')
  assert.ok(target.port && !target.username && !target.password && !target.search && !target.hash)
  assert.ok(Array.isArray(cookies) && cookies.length >= 3)
  assert.ok(Array.isArray(playerIds) && playerIds.length >= 3)
  const staticRoot = join(root, 'player-client', 'dist'), directory = resolve(output)
  assert.ok(existsSync(join(staticRoot, 'index.html')), 'current player production build must exist')
  mkdirSync(directory, { recursive: true })
  const sourceBefore = assetFingerprint(staticRoot)
  const require = createRequire(import.meta.url)
  let chromium
  try { ({ chromium } = require('playwright')) }
  catch { ({ chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')) }
  const server = createPlayerClientServer({ staticRoot, apiTarget: apiBase, trustedProxies: [] })
  let browser, activeRequests = 0, peakConcurrentRequests = 0
  const started = performance.now(), requests = [], pageErrors = [], failures = [], writeAttempts = [], steps = [], screenshots = []
  const pendingRecords = new Set()
  const report = {
    generatedAt: new Date().toISOString(),
    browser: 'actual headless Microsoft Edge',
    accountContexts: 3,
    source: 'player-client/dist via createPlayerClientServer on a random loopback port',
    readOnly: true,
    simulatedResponses: 0,
    businessWrites: 0,
    externalPushRequests: 0,
    sourceBefore,
    requests,
    steps,
    pageErrors,
    failures,
    writeAttempts,
    screenshots,
    limitations: [
      'Three isolated browser contexts are a measured request workload, not an online-user capacity claim.',
      'No notification permission, binding, push test, claim, submission or withdrawal is performed.',
      'The fixture must pre-mark the selected existing messages read; only already-read messages are clicked.',
      'No real Android/iPhone, HTTPS, lock screen or mobile-network arrival is measured.'
    ]
  }
  const finishRequest = async (request, record, failure) => {
    if (record.finished) return
    record.finished = true
    activeRequests--
    record.ms = round(performance.now() - record.started)
    delete record.started
    const response = await request.response()
    record.status = response?.status() || null
    if (failure) record.failure = failure
    if (failure && !/ERR_ABORTED|aborted/i.test(failure)) failures.push({ actor: record.actor, path: record.path, failure })
    if (record.status >= 500 || record.status === 401) failures.push({ actor: record.actor, path: record.path, status: record.status })
    // A current order GET may deny a historic message target; that is a successful
    // permission boundary, not permission restored by the message.
    if (record.status >= 400 && record.status < 500 && record.status !== 401) {
      if (record.status === 403 && /^\/api\/studio\/player\/orders\/[^/?]+$/.test(record.path)) record.expectedPermissionDenial = true
      else failures.push({ actor: record.actor, path: record.path, status: record.status })
    }
    delete record.finished
  }
  try {
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    const origin = `http://127.0.0.1:${server.address().port}`
    report.proxyPort = server.address().port
    browser = await chromium.launch({ headless: true, channel: 'msedge' })
    report.browserVersion = browser.version()
    await Promise.all(playerIds.slice(0, 3).map(async (actor, index) => {
      const actorDirectory = join(directory, `player-${index}`)
      mkdirSync(actorDirectory, { recursive: true })
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
      const token = String(cookies[index]).match(/(?:^|;\s*)studio_player_session=([^;]+)/)?.[1]
      assert.ok(token, 'fixture must supply a dedicated player session cookie')
      await context.addCookies([{ name: 'studio_player_session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }])
      await context.route('**/api/studio/**', async (route) => {
        const request = route.request()
        if (!['GET', 'HEAD'].includes(request.method())) {
          writeAttempts.push({ actor, method: request.method(), path: new URL(request.url()).pathname })
          // Prevent accidental mutations; no success/error body is fabricated.
          await route.abort('blockedbyclient')
        } else await route.continue()
      })
      const page = await context.newPage(), records = new Map()
      page.setDefaultTimeout(30_000)
      page.on('pageerror', (error) => pageErrors.push({ actor, error: error.message }))
      page.on('request', (request) => {
        const url = new URL(request.url())
        if (!url.pathname.startsWith('/api/studio/')) return
        const record = { actor, method: request.method(), path: url.pathname + url.search, started: performance.now() }
        records.set(request, record)
        requests.push(record)
        activeRequests++
        peakConcurrentRequests = Math.max(peakConcurrentRequests, activeRequests)
      })
      const settle = (request, failure) => {
        const record = records.get(request)
        if (!record || record.finished || record.ms !== undefined) return
        const pending = finishRequest(request, record, failure).finally(() => pendingRecords.delete(pending))
        pendingRecords.add(pending)
      }
      page.on('requestfinished', (request) => settle(request))
      page.on('requestfailed', (request) => settle(request, request.failure()?.errorText || 'request failed'))
      const waitGet = (path, condition = () => true) => page.waitForResponse((response) => {
        const url = new URL(response.url())
        return response.request().method() === 'GET' && url.pathname === `/api/studio/${path}` && condition(url.searchParams)
      })
      const recordStep = async (label, action, path, condition) => {
        const began = performance.now(), waiting = waitGet(path, condition)
        await action()
        const response = await waiting
        assert.equal(response.status(), 200, `${label} must read real successful response`)
        const data = await response.json()
        await page.locator('.p-page').waitFor()
        if (['player/orders', 'player/withdrawals', 'player/wallet/ledger'].includes(path)) {
          await page.waitForFunction(({ total, current }) => {
            const text = document.querySelector('.p-pagination')?.textContent || ''
            return text.includes(`共 ${total} 条`) && text.includes(`第 ${current} /`)
          }, { total: data.total, current: data.current })
        }
        steps.push({ actor, label, ms: round(performance.now() - began), path: new URL(response.url()).pathname + new URL(response.url()).search,
          ...(typeof data.total === 'number' ? { total: data.total, current: data.current, size: data.size } : {}) })
        return data
      }
      const navigate = (route, path, condition) => recordStep(route, () => page.goto(`${origin}/#/player/${route}`, { waitUntil: 'domcontentloaded' }), path, condition)
      const capture = async (label) => {
        const path = join(actorDirectory, `${label}.png`)
        await page.screenshot({ path, fullPage: true })
        screenshots.push(path)
      }
      const nextPage = async (path, condition) => {
        const button = page.getByRole('button', { name: '下一页', exact: true })
        if (await button.count()) await recordStep(`${path}-next-page`, () => button.click(), path, (query) => query.get('current') === '2' && (!condition || condition(query)))
      }
      try {
        await navigate('lobby', 'player/orders', (query) => query.get('status') === 'pending')
        await recordStep('lobby-pool-filter', () => page.getByRole('button', { name: '公共订单', exact: true }).click(), 'player/orders', (query) => query.get('scope') === 'pool')
        await nextPage('player/orders', (query) => query.get('scope') === 'pool')
        await capture('lobby-page-2')

        await navigate('tasks', 'player/orders', (query) => query.get('scope') === 'mine')
        await recordStep('tasks-all-authorized', () => page.getByRole('button', { name: '全部授权任务', exact: true }).click(), 'player/orders', (query) => query.get('scope') === 'all')
        const allStatuses = page.locator('.p-tasks-page').getByRole('button', { name: '全部', exact: true })
        if (await allStatuses.getAttribute('aria-pressed') !== 'true') {
          await recordStep('tasks-all-statuses', () => allStatuses.click(), 'player/orders', (query) => query.get('scope') === 'all' && !query.has('status'))
        }
        await recordStep('tasks-global-keyword', () => page.getByRole('searchbox', { name: '搜索全部授权任务', exact: true }).fill('隔离测试'), 'player/orders', (query) => query.get('keyword') === '隔离测试')
        await nextPage('player/orders', (query) => query.get('keyword') === '隔离测试')
        await capture('global-keyword-page-2')

        const wallet = await navigate('wallet', 'player/wallet', (query) => query.get('includeRecords') === 'false')
        assert.deepEqual(wallet.ledger, [])
        assert.deepEqual(wallet.withdrawals, [])
        await capture('wallet-authoritative-summary')

        await navigate('withdrawals', 'player/withdrawals')
        await nextPage('player/withdrawals')
        await recordStep('withdrawals-status-filter', () => page.getByLabel('提现状态', { exact: true }).selectOption('canceled'), 'player/withdrawals', (query) => query.get('status') === 'canceled')
        await nextPage('player/withdrawals', (query) => query.get('status') === 'canceled')
        await capture('withdrawals-filtered-page')

        await navigate('ledger', 'player/wallet/ledger')
        await nextPage('player/wallet/ledger')
        await recordStep('ledger-kind-filter', () => page.getByLabel('流水类型', { exact: true }).selectOption('supplement'), 'player/wallet/ledger', (query) => query.get('kind') === 'supplement')
        await nextPage('player/wallet/ledger', (query) => query.get('kind') === 'supplement')
        await capture('ledger-filtered-page')

        const notices = await navigate('messages', 'player/notifications')
        const notice = notices.records.find((row) => row.readAt && !row.invalidatedAt && (row.target?.orderId || row.orderId)) ||
          notices.records.find((row) => row.readAt && (row.target?.orderId || row.orderId))
        assert.ok(notice, 'fixture must supply one already-read order notification for target load')
        await recordStep('message-exact-target-read', () => page.locator(`[data-notification-id="${notice.id}"]`).click(), `player/notifications/${notice.id}`)
        await page.locator('.p-message-current').waitFor()
        await capture('message-current-target')

        const binding = await navigate('notifications', 'player/push-subscriptions/status')
        assert.ok(['valid', 'unbound', 'invalid', 'unconfigured'].includes(binding.status))
        await page.getByText('本机账号绑定', { exact: true }).waitFor()
        await capture('device-read-only-status')
      } catch (error) {
        failures.push({ actor, scenario: 'actual-player-build-read-flow', error: error.message })
        try { await capture('failure') } catch {}
      } finally {
        await context.close()
      }
    }))
  } catch (error) {
    failures.push({ scenario: 'browser-load-setup', error: error.message })
  } finally {
    if (browser) await browser.close()
    await Promise.all([...pendingRecords])
    await new Promise((done) => server.close(done))
    const measured = requests.filter((row) => row.method === 'GET' && row.ms !== undefined && !row.failure)
    const values = measured.map((row) => row.ms), elapsedMs = performance.now() - started
    report.elapsedMs = round(elapsedMs)
    report.requestCount = requests.length
    report.getRequests = measured.length
    report.peakConcurrentRequests = peakConcurrentRequests
    report.p50Ms = round(percentile(values, 0.5))
    report.p95Ms = round(percentile(values, 0.95))
    report.maxMs = round(Math.max(0, ...values))
    report.throughputPerSecond = round(measured.length / (elapsedMs / 1000))
    report.statuses = measured.reduce((result, row) => { result[row.status] = (result[row.status] || 0) + 1; return result }, {})
    report.canceledReads = requests.filter((row) => row.failure && /ERR_ABORTED|aborted/i.test(row.failure)).length
    report.coverage = {
      summary: measured.some((row) => row.path === '/api/studio/player/wallet?includeRecords=false'),
      withdrawals: measured.some((row) => row.path.startsWith('/api/studio/player/withdrawals?')),
      ledger: measured.some((row) => row.path.startsWith('/api/studio/player/wallet/ledger?')),
      keyword: measured.some((row) => new URL(row.path, 'http://client.local').searchParams.has('keyword')),
      deviceBinding: measured.some((row) => row.path.startsWith('/api/studio/player/push-subscriptions/status')),
      exactNotificationTarget: measured.some((row) => /^\/api\/studio\/player\/notifications\/[^/?]+$/.test(row.path))
    }
    report.sourceAfter = assetFingerprint(staticRoot)
    report.builtAssetsUnchanged = sourceBefore.digest === report.sourceAfter.digest
    report.unexpectedErrors = failures.length + pageErrors.length + writeAttempts.length
    report.success = report.unexpectedErrors === 0 && report.builtAssetsUnchanged && Object.values(report.coverage).every(Boolean)
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  }
  return report
}
