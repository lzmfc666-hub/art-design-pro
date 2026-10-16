import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createStudioServer } from '../../server/index.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.env.STUDIO_QA_ROOT || resolve(clientRoot, '.qa'), 'request-v2')
await mkdir(output, { recursive: true })
const dependency = createRequire(await realpath(resolve(clientRoot, 'node_modules/vite/package.json')))
const { build } = dependency('esbuild')
await build({ entryPoints: [resolve(clientRoot, 'tests/request-runtime-harness.ts')], outfile: resolve(output, 'request-runtime.mjs'), bundle: true, platform: 'node', format: 'esm', tsconfig: resolve(clientRoot, 'tsconfig.json') })
const api = await import(pathToFileURL(resolve(output, 'request-runtime.mjs')).href)
const calls = []
let respond = async (_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}') }
const server = createServer(async (request, response) => {
  calls.push(request.url)
  try { await respond(request, response) } catch { response.destroy() }
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const origin = `http://127.0.0.1:${server.address().port}`
const originalFetch = globalThis.fetch
globalThis.fetch = (url, options) => originalFetch(new URL(url, origin), options)
const sleep = (ms) => new Promise((ready) => setTimeout(ready, ms))
const evidence = []

await test('request runtime against isolated random-port HTTP transport', async (suite) => {
  const check = async (name, run) => suite.test(name, async () => {
    calls.length = 0
    api.invalidateSessionRequests()
    api.setPrincipalVerifier(() => true)
    api.setUnauthorizedHandler(() => {})
    api.setRequestActorProvider(() => undefined)
    await run()
    evidence.push({ name, passed: true })
  })
  try {
    await check('same account/path GET requests merge; a cancelled reader does not cancel another reader', async () => {
      respond = async (_request, response) => { await sleep(60); response.end('{"value":7}') }
      const controller = new AbortController()
      const first = api.studioRequest('player/profile', undefined, 'GET', controller.signal)
      const second = api.studioRequest('player/profile')
      const cancelled = assert.rejects(first, api.isAbortError)
      await sleep(10)
      controller.abort()
      await cancelled
      assert.deepEqual(await second, { value: 7 })
      assert.equal(calls.length, 1)
      const onlyReader = new AbortController()
      const abandoned = api.studioRequest('player/abandoned', undefined, 'GET', onlyReader.signal)
      const abandonedResult = assert.rejects(abandoned, api.isAbortError)
      onlyReader.abort()
      const replacement = api.studioRequest('player/abandoned')
      await abandonedResult
      assert.deepEqual(await replacement, { value: 7 }, 'a quick return must not reuse an already aborted shared request')
    })
    await check('distinct filters are distinct reads, and fulfilled reads are not persistent caches', async () => {
      respond = async (_request, response) => response.end('{"ok":true}')
      await Promise.all([api.studioRequest('player/orders?current=1'), api.studioRequest('player/orders?current=2')])
      await api.studioRequest('player/orders?current=1')
      assert.equal(calls.length, 3)
    })
    await check('GET timeout is bounded and is never automatically replayed', async () => {
      respond = async (_request, response) => { await sleep(150); response.end('{"ok":true}') }
      await assert.rejects(api.studioRequest('player/orders', undefined, 'GET', undefined, { timeoutMs: 30 }), (error) => error.code === 'TIMEOUT' && error.outcome === 'rejected')
      await sleep(30)
      assert.equal(calls.length, 1)
    })
    await check('POST response loss/timeout retains requestId and marks outcome unknown without retry', async () => {
      respond = async (_request, response) => { await sleep(150); response.end('{"ok":true}') }
      await assert.rejects(api.studioRequest('player/withdrawals', { requestId: 'original-operation', amount: 1 }, 'POST', undefined, { timeoutMs: 30 }),
        (error) => error.code === 'TIMEOUT' && error.outcome === 'unknown' && error.requestId === 'original-operation')
      await sleep(30)
      assert.equal(calls.length, 1)
    })
    await check('session invalidation aborts outstanding private read and rejects its late reply', async () => {
      respond = async (_request, response) => { await sleep(80); response.end('{"private":"old-account"}') }
      const read = api.studioRequest('player/wallet')
      const rejected = assert.rejects(read, (error) => error.code === 'SESSION_CHANGED')
      await sleep(10)
      api.invalidateSessionRequests()
      await rejected
    })
    await check('a late old-account 401 cannot log out the new account', async () => {
      let logouts = 0
      api.setUnauthorizedHandler(() => { logouts++ })
      const fetchSaved = globalThis.fetch
      globalThis.fetch = async () => { await sleep(30); return new Response('{"message":"expired"}', { status: 401 }) }
      try {
        const read = api.studioRequest('player/profile')
        const rejected = assert.rejects(read, (error) => error.code === 'SESSION_CHANGED')
        api.invalidateSessionRequests()
        await rejected
        assert.equal(logouts, 0)
      } finally { globalThis.fetch = fetchSaved }
    })
    await check('principal mismatch invokes current-session cleanup and returns 401', async () => {
      let logouts = 0
      api.setPrincipalVerifier((id) => id === 'current-player')
      api.setUnauthorizedHandler(() => { logouts++ })
      respond = async (_request, response) => { response.setHeader('X-Studio-User', 'other-player'); response.end('{"ok":true}') }
      await assert.rejects(api.studioRequest('player/wallet'), (error) => error.status === 401 && error.code === 'PRINCIPAL_CHANGED')
      assert.equal(logouts, 1)
    })
    await check('409 preserves explicit safe business reason/code; 429 parses Retry-After', async () => {
      respond = async (_request, response) => { response.statusCode = 409; response.end('{"message":"订单已变化，请重新确认","code":"ORDER_REVISION_CONFLICT"}') }
      await assert.rejects(api.studioRequest('player/orders/a/claim', { requestId: 'conflict' }, 'POST'),
        (error) => error.status === 409 && error.code === 'ORDER_REVISION_CONFLICT' && error.message === '订单已变化，请重新确认')
      respond = async (_request, response) => { response.statusCode = 429; response.setHeader('Retry-After', '3'); response.end('{"message":"internal throttle"}') }
      await assert.rejects(api.studioRequest('player/profile'), (error) => error.status === 429 && error.retryAfter === 3000 && error.message.includes('稍后重试'))
    })
    await check('503/internal errors are safe; malformed write response is unknown', async () => {
      respond = async (_request, response) => { response.statusCode = 503; response.end('{"message":"sqlite at C:\\\\server\\\\secret"}') }
      await assert.rejects(api.studioRequest('player/orders/a/submit', { requestId: 'service-busy' }, 'POST'),
        (error) => error.status === 503 && !error.message.includes('sqlite') && error.message.includes('已保留'))
      respond = async (_request, response) => { response.statusCode = 500; response.end('{"message":"server failed"}') }
      await assert.rejects(api.studioRequest('player/orders/a/claim', { requestId: 'server-unknown' }, 'POST'),
        (error) => error.status === 500 && error.outcome === 'unknown' && error.requestId === 'server-unknown')
      respond = async (_request, response) => response.end('<html>gateway failed</html>')
      await assert.rejects(api.studioRequest('player/withdrawals', { requestId: 'malformed-reply' }, 'POST'),
        (error) => error.code === 'INVALID_RESPONSE' && error.outcome === 'unknown' && error.requestId === 'malformed-reply')
      assert.equal(api.safeApiMessage(new Error('TypeError: broken at C:\\private\\server')), '加载失败，请重试')
    })
    await check('summary coordinator refreshes on changes, stays idle unchanged/hidden, and reconciles recovery once', async () => {
      const previousWindow = globalThis.window
      const previousDocument = globalThis.document
      const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      globalThis.window = new EventTarget()
      globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
      let changed = false, reads = 0, summaries = 0, stale = false
      const disposeSummary = api.setPlayerSummaryProvider(async () => { summaries++; return { version: summaries, changed } })
      api.setPlayerSessionVerifier(async () => {})
      const unregister = api.registerPlayerReader({ active: () => true, needsRefresh: () => stale, refresh: async () => { reads++; stale = false } })
      try {
        await api.reconcilePlayerReads()
        assert.equal(reads, 0, 'unchanged summary must not cause full resource read')
        changed = true
        await sleep(520)
        await api.reconcilePlayerReads()
        assert.equal(reads, 1)
        document.visibilityState = 'hidden'
        document.dispatchEvent(new Event('visibilitychange'))
        const beforeHidden = summaries
        await api.reconcilePlayerReads()
        assert.equal(summaries, beforeHidden)
        changed = false
        stale = true
        document.visibilityState = 'visible'
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
        await sleep(10)
        assert.equal(summaries, beforeHidden + 1, 'visible and focus must coalesce')
        assert.equal(reads, 2, 'stale interrupted data must recover even if summary is unchanged')
        await api.invalidatePlayerReads()
        assert.equal(reads, 3, 'a confirmed mutation forces current resources to read')
      } finally {
        unregister()
        disposeSummary()
        globalThis.window = previousWindow
        globalThis.document = previousDocument
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
        else delete globalThis.navigator
      }
    })
    await check('session cache is display-only and forced permission refresh advances epoch', async () => {
      api.setActivePinia(api.createPinia())
      const session = api.useSessionStore()
      const reasons = []
      const stopReasons = api.onSessionInvalidated((reason) => reasons.push(reason))
      let limit = 2
      let override = true
      respond = async (_request, response) => response.end(JSON.stringify({ user: {
        id: 'isolated-player', username: 'isolated-player', name: '验证账号', role: 'player', status: 'active',
        maxActiveOrders: limit, playerAccess: { login: true, claim: true, withdraw: true }, permissionOverrides: { 'orders.view': override }
      } }))
      const first = await session.checkSession(true)
      assert.equal(first.maxActiveOrders, 2)
      const epoch = session.epoch
      await session.checkSession()
      assert.equal(calls.length, 1, 'fresh display check should use short memory cache')
      limit = 1
      await session.checkSession(true)
      assert.equal(calls.length, 2)
      assert.equal(session.user.maxActiveOrders, 1)
      assert.equal(session.epoch, epoch + 1, 'permission/limit refresh must invalidate stale pages')
      await session.checkSession(true)
      assert.equal(session.epoch, epoch + 1, 'same permissions must not keep remounting the application')
      override = false
      await session.checkSession(true)
      assert.equal(session.epoch, epoch + 2, 'wire permissionOverrides change must invalidate pages')
      await session.checkSession(true)
      assert.equal(session.epoch, epoch + 2, 'same permissionOverrides must not invalidate twice')
      session.clearSession()
      stopReasons()
      assert.deepEqual(reasons, ['account', 'permissions', 'permissions', 'account'], 'account changes and same-account permission invalidation must stay distinguishable')
    })
    await check('cross-tab events contain no identity/write payload, ignore duplicates and use transient storage fallback', async () => {
      const previousWindow = globalThis.window
      const instances = []
      class IsolatedChannel {
        constructor(name) { this.name = name; this.messages = []; this.closed = false; instances.push(this) }
        postMessage(event) { this.messages.push(event) }
        close() { this.closed = true }
      }
      globalThis.window = Object.assign(new EventTarget(), { BroadcastChannel: IsolatedChannel })
      const phases = []
      let stop = api.onRemotePlayerSessionChanged((phase) => phases.push(phase))
      try {
        api.announcePlayerSession('login-start')
        const channel = instances[0], outgoing = channel.messages[0]
        assert.deepEqual(Object.keys(outgoing).sort(), ['id', 'phase', 'type', 'version'])
        channel.onmessage({ data: outgoing })
        assert.deepEqual(phases, [], 'own message is ignored even if a transport echoes it')
        const incoming = { type: 'player-session-event', version: 1, id: 'isolated-external-event', phase: 'login-complete' }
        channel.onmessage({ data: incoming }); channel.onmessage({ data: incoming })
        channel.onmessage({ data: { ...incoming, id: 'malformed', phase: 'arbitrary-action' } })
        assert.deepEqual(phases, ['login-complete'])
        stop()
        assert.equal(channel.closed, true)
        const saved = new Map(), writes = []
        globalThis.window = Object.assign(new EventTarget(), { localStorage: {
          setItem(key, value) { saved.set(key, value); writes.push({ key, value }) },
          removeItem(key) { saved.delete(key) }
        } })
        stop = api.onRemotePlayerSessionChanged((phase) => phases.push(phase))
        api.announcePlayerSession('logout')
        assert.equal(saved.size, 0, 'fallback does not retain event data after broadcasting')
        const payload = JSON.parse(writes[0].value)
        assert.deepEqual(Object.keys(payload).sort(), ['id', 'phase', 'type', 'version'])
        const storageEvent = Object.assign(new Event('storage'), { key: writes[0].key,
          newValue: JSON.stringify({ ...incoming, id: 'storage-event', phase: 'password-updated' }) })
        window.dispatchEvent(storageEvent); window.dispatchEvent(storageEvent)
        assert.deepEqual(phases, ['login-complete', 'password-updated'])
      } finally { stop(); globalThis.window = previousWindow }
    })
    await check('real isolated backend 403/404 clear previously loaded private order fields', async () => {
      const password = `read-boundary-${randomUUID()}`
      const backend = createStudioServer({ dbPath: ':memory:', seed: false, password, notificationIntervalMs: 86_400_000 })
      await new Promise((ready) => backend.listen(0, '127.0.0.1', ready))
      const backendOrigin = `http://127.0.0.1:${backend.address().port}`
      let adminCookie = '', playerCookie = '', adminActor = '', playerActor = ''
      const post = async (path, body, player = false) => {
        const response = await originalFetch(`${backendOrigin}/api/studio/${path}`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(player ? { 'X-Studio-Client': 'player' } : {}),
            ...((player ? playerActor : adminActor) && path !== 'login' ? { 'X-Studio-Actor': player ? playerActor : adminActor } : {}),
            ...((player ? playerCookie : adminCookie) ? { Cookie: player ? playerCookie : adminCookie } : {}) }, body: JSON.stringify(body) })
        if (response.headers.get('set-cookie')) {
          const cookie = response.headers.get('set-cookie').split(';')[0]
          if (player) playerCookie = cookie; else adminCookie = cookie
        }
        const result = await response.json()
        if (path === 'login' && result.user) { if (player) playerActor = result.user.id; else adminActor = result.user.id }
        assert.equal(response.status, 200, `${path}: ${result.message || response.status}`)
        return result
      }
      const previousWindow = globalThis.window, previousDocument = globalThis.document, savedFetch = globalThis.fetch
      const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      let app
      try {
        await post('login', { username: 'admin', password })
        const level = await post('levels', { name: '私有读取边界等级', delaySeconds: 0 })
        const players = []
        for (const suffix of ['A', 'B']) players.push(await post('users', { username: `read-boundary-${suffix}`, name: `隔离读取${suffix}`, role: 'player',
          status: 'active', levelId: level.id, maxActiveOrders: 2, permissionOverrides: {}, password }))
        const customer = await post('customers', { name: '隔离读取客户', gameId: 'PRIVATE-CUSTOMER-GAME-ID' })
        const template = await post('templates', { name: '私有读取订单', game: '三角洲行动', amount: 10000, reward: 1001, description: '真实接口验证', map: '长弓溪谷', active: true })
        const orderBody = { templateId: template.id, customerId: customer.id, platformId: 'xianyu', shopId: 'jindun',
          externalOrderNo: randomUUID(), roomCode: 'PRIVATE-ROOM-BOUNDARY', gameId: 'PRIVATE-GAME-BOUNDARY', amount: 10000, reward: 1001,
          receivedAmount: 10000, paidAt: new Date().toISOString(), dispatchMode: 'pool', playerRemark: '授权服务要求', remark: 'INTERNAL-NEVER-DISPLAY' }
        const ownOrder = await post('orders', { ...orderBody, requestId: randomUUID() })
        const forbiddenOrder = await post('orders', { ...orderBody, externalOrderNo: randomUUID(), requestId: randomUUID(), dispatchMode: 'direct', assignedTo: players[1].id })
        await post('login', { username: players[0].username, password }, true)
        await post(`player/orders/${ownOrder.id}/claim`, { requestId: randomUUID(), expectedRevision: ownOrder.revision, dispatchRound: ownOrder.dispatchRound }, true)
        const statuses = []
        globalThis.fetch = async (url, options) => {
          const response = await originalFetch(new URL(url, backendOrigin), { ...options, headers: { ...options?.headers, Cookie: playerCookie } })
          statuses.push(response.status)
          return response
        }
        globalThis.window = new EventTarget()
        globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
        const node = (type) => ({ type, children: [], parent: null })
        const renderer = api.createRenderer({ patchProp() {}, createElement: node, createText: node, createComment: node,
          setText() {}, setElementText() {}, parentNode: (value) => value.parent, nextSibling: () => null,
          insert(child, parent) { child.parent = parent; parent.children.push(child) },
          remove(child) { const at = child.parent?.children.indexOf(child); if (at >= 0) child.parent.children.splice(at, 1) } })
        let resource, target = ownOrder.id
        app = renderer.createApp({ setup() {
          resource = api.usePlayerResource((signal) => api.studioRequest(`player/orders/${target}`, undefined, 'GET', signal), null, false)
          return () => api.h('div')
        } })
        app.provide(api.routerKey, { currentRoute: { value: { fullPath: '/player/orders/test' } }, replace: async () => {} })
        app.mount(node('root'))
        await resource.refresh()
        assert.equal(resource.data.value.roomCode, 'PRIVATE-ROOM-BOUNDARY')
        assert.equal(resource.data.value.remark, undefined)
        target = forbiddenOrder.id
        await resource.refresh()
        assert.equal(statuses.at(-1), 403)
        assert.equal(resource.data.value, null, '403 cannot keep cached roomCode/gameId from a prior permitted read')
        assert.equal(resource.updatedAt.value, null)
        target = ownOrder.id
        await resource.refresh()
        assert.equal(resource.data.value.roomCode, 'PRIVATE-ROOM-BOUNDARY')
        target = 'nonexistent-private-order'
        await resource.refresh()
        assert.equal(statuses.at(-1), 404)
        assert.equal(resource.data.value, null)
        assert.equal(resource.updatedAt.value, null)
      } finally {
        app?.unmount()
        globalThis.fetch = savedFetch
        globalThis.window = previousWindow
        globalThis.document = previousDocument
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
        else delete globalThis.navigator
        backend.closeAllConnections?.()
        await new Promise((ready) => backend.close(ready))
      }
    })
    await check('consumed summary changes cancel held reads, survive the 350ms debounce and preserve retry backoff', async () => {
      const previousWindow = globalThis.window
      const previousDocument = globalThis.document
      const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      const originalNow = Date.now
      globalThis.window = new EventTarget()
      globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
      let changed = true, payloadRevision = 1, reads = 0, releaseOld, throttled = false, unavailable = false
      respond = async (_request, response) => {
        const capturedRevision = payloadRevision
        reads++
        if (reads === 1) await new Promise((ready) => { releaseOld = ready })
        if (unavailable) {
          response.statusCode = 503
          response.end('{"message":"service unavailable"}')
        } else if (throttled) {
          response.statusCode = 429
          response.setHeader('Retry-After', '30')
          response.end('{"message":"too many requests"}')
        } else response.end(JSON.stringify({ revision: capturedRevision }))
      }
      const disposeSummary = api.setPlayerSummaryProvider(async () => ({ version: payloadRevision, changed }))
      api.setPlayerSessionVerifier(async () => {})
      const node = (type) => ({ type, children: [], parent: null })
      const renderer = api.createRenderer({
        patchProp() {}, createElement: node, createText: node, createComment: node,
        setText() {}, setElementText() {}, parentNode: (value) => value.parent, nextSibling: () => null,
        insert(child, parent) { child.parent = parent; parent.children.push(child) },
        remove(child) { const at = child.parent?.children.indexOf(child); if (at >= 0) child.parent.children.splice(at, 1) }
      })
      let resource
      const app = renderer.createApp({ setup() {
        resource = api.usePlayerResource((signal) => api.studioRequest('player/held-read', undefined, 'GET', signal), { revision: 0 })
        return () => api.h('div')
      } })
      app.provide(api.routerKey, { currentRoute: { value: { fullPath: '/player/test' } }, replace: async () => {} })
      try {
        app.mount(node('root'))
        for (let attempt = 0; attempt < 40 && !releaseOld; attempt++) await sleep(5)
        assert.equal(reads, 1, 'first real HTTP read must be held at server')
        payloadRevision = 2
        await api.reconcilePlayerReads()
        assert.equal(reads, 2, 'a consumed change must start a fresh read instead of awaiting the older one')
        assert.equal(resource.data.value.revision, 2)
        releaseOld()
        await sleep(20)
        assert.equal(resource.data.value.revision, 2, 'released stale reply cannot overwrite the fresh version')
        await sleep(520)
        payloadRevision = 3
        await resource.refresh()
        payloadRevision = 4
        const fastChangeTime = originalNow()
        await api.reconcilePlayerReads()
        assert.ok(originalNow() - fastChangeTime < 350, 'change is reconciled within resource debounce window')
        assert.equal(resource.data.value.revision, 4, '350ms suppression must not lose an acknowledged change')
        unavailable = true
        await resource.refresh()
        assert.equal(resource.data.value.revision, 4, '503 keeps the last authorized data while showing it is stale')
        assert.notEqual(resource.updatedAt.value, null)
        assert.equal(resource.stale.value, true)
        unavailable = false
        await resource.refresh()
        throttled = true
        await resource.refresh()
        assert.equal(resource.error.value.includes('稍后重试'), true)
        const beforeThrottleRetry = reads
        throttled = false
        payloadRevision = 5
        document.visibilityState = 'hidden'
        document.dispatchEvent(new Event('visibilitychange'))
        document.visibilityState = 'visible'
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
        await sleep(20)
        assert.equal(reads, beforeThrottleRetry, 'visibility/focus recovery must preserve server Retry-After')
        await api.invalidatePlayerReads()
        assert.equal(reads, beforeThrottleRetry, 'mutation invalidation must respect Retry-After')
        assert.equal(resource.stale.value, true, 'change remains pending during backoff')
        changed = false
        Date.now = () => originalNow() + 31000
        await api.reconcilePlayerReads()
        assert.equal(reads, beforeThrottleRetry + 1, 'unchanged summary must retry a still-stale resource when allowed')
        assert.equal(resource.data.value.revision, 5)
        assert.equal(resource.stale.value, false)
      } finally {
        releaseOld?.()
        Date.now = originalNow
        app.unmount()
        disposeSummary()
        globalThis.window = previousWindow
        globalThis.document = previousDocument
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
        else delete globalThis.navigator
      }
    })
    await check('content expiration uses only its monotonic clock, and failure recovery respects backoff', async () => {
      const previousWindow = globalThis.window
      const previousDocument = globalThis.document
      const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      const originalNow = Date.now
      globalThis.window = new EventTarget()
      globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
      const disposeSummary = api.setPlayerSummaryProvider(async () => ({ version: 1, changed: false }))
      api.setPlayerSessionVerifier(async () => {})
      const node = (type) => ({ type, children: [], parent: null })
      const renderer = api.createRenderer({
        patchProp() {}, createElement: node, createText: node, createComment: node,
        setText() {}, setElementText() {}, parentNode: (value) => value.parent,
        nextSibling: () => null,
        insert(child, parent) { child.parent = parent; parent.children.push(child) },
        remove(child) { const at = child.parent?.children.indexOf(child); if (at >= 0) child.parent.children.splice(at, 1) }
      })
      let resource, reads = 0, failNext = false, throttleNext = false
      const end = originalNow() + 250
      const app = renderer.createApp({ setup() {
        resource = api.usePlayerContent((signal) => {
          reads++
          assert.equal(signal instanceof AbortSignal, true)
          if (failNext) { failNext = false; throw new Error('内容读取暂时失败') }
          if (throttleNext) { throttleNext = false; throw new api.StudioApiError('操作太频繁，请稍后重试', { status: 429, retryAfter: 30000 }) }
          return Promise.resolve({ serverTime: new Date(originalNow()).toISOString(), banners: [], announcements: [{
            id: 'timed-content', type: 'announcement', title: '时钟验证', text: '时钟验证', body: '', image: null,
            sortOrder: 0, startAt: null, endAt: new Date(end).toISOString(), publishedAt: new Date(originalNow()).toISOString()
          }] })
        })
        return () => api.h('div')
      } })
      try {
        app.mount(node('root'))
        await sleep(20)
        assert.equal(reads, 1)
        assert.equal(resource.announcements.value.length, 1)
        await sleep(550)
        assert.equal(resource.announcements.value.length, 0)
        assert.equal(reads, 1, 'expiry clock must not issue API reads')
        failNext = true
        await resource.refresh()
        assert.equal(reads, 2)
        assert.equal(resource.stale.value, true)
        await api.reconcilePlayerReads()
        assert.equal(reads, 2, 'summary does not bypass content failure backoff')
        Date.now = () => originalNow() + 16000
        await api.reconcilePlayerReads()
        assert.equal(reads, 3)
        assert.equal(resource.loadedRevision.value, 2, 'success refresh advances image-recovery revision')
        assert.equal(resource.error.value, '')
        Date.now = originalNow
        throttleNext = true
        await resource.refresh()
        assert.equal(reads, 4)
        window.dispatchEvent(new Event('focus'))
        await api.invalidatePlayerReads()
        assert.equal(reads, 4, 'content focus must not clear Retry-After before mutation invalidation')
        Date.now = () => originalNow() + 31000
        await api.reconcilePlayerReads()
        assert.equal(reads, 5)
        assert.equal(resource.loadedRevision.value, 3)
      } finally {
        Date.now = originalNow
        app.unmount()
        disposeSummary()
        globalThis.window = previousWindow
        globalThis.document = previousDocument
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
        else delete globalThis.navigator
      }
    })
  } finally {
    globalThis.fetch = originalFetch
    server.closeAllConnections()
    await new Promise((ready) => server.close(ready))
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), scope: 'transport/unit + isolated-backend read-boundary regression; not full business regression', isolatedRandomPort: true, formalDatabaseTouched: false, passed: evidence.length === 15, checks: evidence }, null, 2))
  }
})
