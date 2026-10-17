import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Explicit client unit faults, not real API/UI acceptance: the current source is
// bundled without rewriting it, and controlled transport/late replies are injected.
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.env.STUDIO_QA_ROOT || resolve(clientRoot, '.qa/order-card-image-v33'), 'runtime', `run-${randomUUID()}`)
await mkdir(output, { recursive: true })
const dependency = createRequire(await realpath(resolve(clientRoot, 'node_modules/vite/package.json')))
const { build } = dependency('esbuild')
const bundle = resolve(output, 'runtime.mjs')
await build({ stdin: { contents: `
  export { createPinia, setActivePinia, disposePinia } from 'pinia'
  export { useAppearanceStore } from './src/stores/appearance'
  export { useSessionStore } from './src/stores/session'
  export { playerApi } from './src/api/player'
  export { invalidateSessionRequests } from './src/api/sessionBoundary'
  export { setUnauthorizedHandler } from './src/api/studio'
  export * from './src/api/readScheduler'
`, resolveDir: clientRoot, sourcefile: 'order-card-image-runtime-entry.ts', loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm',
  tsconfig: resolve(clientRoot, 'tsconfig.json'),
  banner: { js: "import { createRequire as qaCreateRequire } from 'node:module'; const require = qaCreateRequire(import.meta.url);" } })
const api = await import(pathToFileURL(bundle).href)
const fetchOriginal = globalThis.fetch, dateOriginal = Date.now
const windowOriginal = globalThis.window, documentOriginal = globalThis.document
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
let now = dateOriginal()
Date.now = () => now
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
const report = { passed: false, cases: [], failures: [], output,
  verification: 'Current client source with explicit unit-level delayed/failed transport fixtures; no real backend, database, browser or phone.' }
const image = (id = 'card-a') => ({ id, name: `${id}.png`, mime: 'image/png', size: 1234, url: `/api/studio/uploads/${encodeURIComponent(id)}` })
const appearance = (revision = 1, id = 'card-a') => ({ revision, orderCardImage: id === null ? null : image(id) })
const actor = (id = 'actor-a', changes = {}) => ({ id, username: id, name: id, role: 'player', status: 'active', playerAccess: { login: true }, ...changes })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve() }
async function check(name, run) {
  const pinia = api.createPinia()
  api.setActivePinia(pinia)
  const session = api.useSessionStore(pinia), store = api.useAppearanceStore(pinia)
  const savedAppearance = api.playerApi.appearance
  session.acceptUser(actor())
  try { await run({ session, store }); report.cases.push({ name, passed: true }) }
  finally { api.playerApi.appearance = savedAppearance; api.disposePinia(pinia); globalThis.fetch = fetchOriginal }
}
try {
  await check('same actor concurrent first reads share one appearance invocation', async ({ store }) => {
    const hold = deferred(); let count = 0
    api.playerApi.appearance = () => { count++; return hold.promise }
    const first = store.loadPlayer(true), second = store.loadPlayer(), third = store.loadPlayer(true)
    assert.equal(count, 1)
    hold.resolve(appearance())
    await Promise.all([first, second, third])
    assert.equal(store.orderCardImage.id, 'card-a'); assert.equal(store.playerSaved.revision, 1)
  })
  await check('ordinary changes with same appearance revision do not read; mismatch clears old art and rereads', async ({ store }) => {
    let count = 0, current = appearance()
    api.playerApi.appearance = async () => { count++; return current }
    await store.loadPlayer()
    store.notePlayerRevision(1); await store.loadPlayer()
    store.notePlayerRevision(1); await store.loadPlayer()
    assert.equal(count, 1)
    current = appearance(2, 'card-b'); store.notePlayerRevision(2)
    assert.equal(store.orderCardImage, null)
    await store.loadPlayer()
    assert.equal(count, 2); assert.equal(store.orderCardImage.id, 'card-b')
  })
  await check('null/remove/reset projection uses the original placeholder state', async ({ store }) => {
    let current = appearance()
    api.playerApi.appearance = async () => current
    await store.loadPlayer()
    current = appearance(2, null); store.notePlayerRevision(2); await store.loadPlayer()
    assert.equal(store.orderCardImage, null); assert.equal(store.playerSaved.revision, 2)
    assert.equal(store.needsPlayerRefresh(), false)
    current = appearance(3, 'card-b'); store.notePlayerRevision(3); await store.loadPlayer()
    current = appearance(4, null); store.notePlayerRevision(4); await store.loadPlayer()
    assert.equal(store.orderCardImage, null); assert.equal(store.playerSaved.revision, 4)
  })
  await check('failed configuration clears old state and ordinary retry obeys backoff', async ({ store }) => {
    let count = 0, fail = false
    api.playerApi.appearance = async () => { count++; if (fail) throw new Error('unit read failure'); return appearance() }
    await store.loadPlayer(); fail = true; await store.loadPlayer(true)
    assert.equal(store.orderCardImage, null); assert.equal(store.playerSaved, null)
    fail = false; await store.loadPlayer()
    assert.equal(count, 2)
    now += 15001; await store.loadPlayer()
    assert.equal(count, 3); assert.equal(store.orderCardImage.id, 'card-a')
  })
  await check('noncanonical/private-alternative URLs and invalid MIME/revision fail closed', async ({ store }) => {
    let current = appearance()
    api.playerApi.appearance = async () => current
    const invalid = [
      { ...image(), url: 'https://example.invalid/card.png' },
      { ...image(), url: '//example.invalid/card.png' },
      { ...image(), url: 'data:image/png;base64,AA==' },
      { ...image(), url: '/api/studio/public-assets/card-a' },
      { ...image(), url: '/api/studio/uploads/card-b' },
      { ...image(), mime: 'text/html' }
    ]
    for (const value of invalid) {
      current = appearance(); await store.loadPlayer(true)
      assert.ok(store.orderCardImage)
      current = { revision: 1, orderCardImage: value }; await store.loadPlayer(true)
      assert.equal(store.orderCardImage, null)
    }
    current = { revision: -1, orderCardImage: image() }; await store.loadPlayer(true)
    assert.equal(store.orderCardImage, null)
  })
  await check('cancellation rejects late store results even when a fixture ignores AbortSignal', async ({ store }) => {
    const old = deferred(), next = deferred(); const signals = []; let count = 0
    api.playerApi.appearance = signal => { signals.push(signal); return count++ ? next.promise : old.promise }
    const first = store.loadPlayer(true)
    store.cancelPlayerRead(); assert.equal(signals[0].aborted, true)
    const second = store.loadPlayer(true)
    next.resolve(appearance(2, 'card-b')); await second
    old.resolve(appearance(1)); await first
    assert.equal(store.orderCardImage.id, 'card-b'); assert.equal(store.playerSaved.revision, 2)
  })
  await check('account A late result cannot replace account B image', async ({ session, store }) => {
    const old = deferred(); let count = 0
    api.playerApi.appearance = () => count++ ? Promise.resolve(appearance(2, 'card-b')) : old.promise
    const first = store.loadPlayer()
    session.acceptUser(actor('actor-b'))
    assert.equal(store.orderCardImage, null)
    await store.loadPlayer(); old.resolve(appearance()); await first
    assert.equal(store.orderCardImage.id, 'card-b'); assert.equal(store.playerSaved.revision, 2)
  })
  await check('logout and permission revocation clear state and reject a late result', async ({ session, store }) => {
    const hold = deferred(); let calls = 0
    api.playerApi.appearance = () => { calls++; return hold.promise }
    const first = store.loadPlayer()
    session.clearSession(); hold.resolve(appearance()); await first
    assert.equal(store.orderCardImage, null); assert.equal(store.playerSaved, null)
    await store.loadPlayer(); assert.equal(calls, 1)
    session.acceptUser(actor()); api.playerApi.appearance = async () => appearance()
    await store.loadPlayer(); assert.ok(store.orderCardImage)
    session.acceptUser(actor('actor-a', { playerAccess: { login: false } }))
    assert.equal(store.orderCardImage, null); await store.loadPlayer(); assert.equal(store.playerSaved, null)
  })
  await check('real client request parser forwards Retry-After; even forced wake cannot bypass it', async ({ store }) => {
    let count = 0
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/studio/player/appearance'); assert.equal(options.cache, 'no-store')
      assert.equal(options.credentials, 'same-origin'); count++
      return count === 1
        ? new Response('{"message":"unit throttled"}', { status: 429, headers: { 'Retry-After': '30', 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify(appearance()), { headers: { 'Content-Type': 'application/json' } })
    }
    await store.loadPlayer(true); assert.equal(store.orderCardImage, null); assert.equal(count, 1)
    now += 20000; await store.loadPlayer(true); assert.equal(count, 1)
    now += 10001; await store.loadPlayer(true); assert.equal(count, 2); assert.ok(store.orderCardImage)
  })
  await check('stale configuration below latest summary does not resurrect old art', async ({ store }) => {
    api.playerApi.appearance = async () => appearance(1)
    store.notePlayerRevision(2); await store.loadPlayer(true)
    assert.equal(store.playerSaved, null); assert.equal(store.orderCardImage, null)
  })
  await check('new legal GET retries the same image with a fresh attempt key; error wiring has stale event guard and no retry loop', async ({ store }) => {
    api.playerApi.appearance = async () => appearance()
    await store.loadPlayer(); const first = store.playerImageKey
    await store.loadPlayer(true); assert.notEqual(store.playerImageKey, first)
    const card = await readFile(resolve(clientRoot, 'src/views/player/OrderCard.vue'), 'utf8')
    assert.match(card, /:key="appearance\.playerImageKey"/)
    // Pixels now use the shared authenticated thumbnail component. The stable
    // per-attempt key destroys old instances; its generation guard rejects late failures.
    assert.match(card, /<PrivateImage/)
    assert.match(card, /:context="appearance\.playerImageKey"/)
    const component = await readFile(resolve(clientRoot, 'src/views/player/PrivateImage.vue'), 'utf8')
    assert.match(component, /token === generation && epoch === sessionRevision\(\)/)
    assert.match(card, /<PlayerIcon v-else name="game"/)
  })
  await check('one scheduler handles first reads, ordinary/revision changes, visibility and online without duplicate listeners', async ({ store }) => {
    const timers = new Set(), setOriginal = globalThis.setTimeout, clearOriginal = globalThis.clearTimeout
    const additions = [], removals = []
    const surface = () => {
      const target = new EventTarget()
      const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target)
      target.addEventListener = (type, ...args) => { additions.push(type); add(type, ...args) }
      target.removeEventListener = (type, ...args) => { removals.push(type); remove(type, ...args) }
      return target
    }
    globalThis.window = surface(); globalThis.document = surface(); document.visibilityState = 'visible'
    globalThis.setTimeout = (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer }
    globalThis.clearTimeout = timer => timers.delete(timer)
    let stop, stopSecond, stopSummary, count = 0, revision = 1, changed = true
    const first = deferred()
    api.playerApi.appearance = () => { count++; return count === 1 ? first.promise : Promise.resolve(appearance(revision, revision === 1 ? 'card-a' : 'card-b')) }
    const tick = async () => {
      now += 16000
      const timer = [...timers].at(-1); assert.ok(timer, 'one coordinator schedules its next read')
      timers.delete(timer); timer.callback(); await flush()
    }
    try {
      stopSummary = api.setPlayerSummaryProvider(async () => { store.notePlayerRevision(revision); return { version: revision, changed } })
      stop = api.registerPlayerReader({ topics: ['appearance'], active: () => true,
        needsRefresh: store.needsPlayerRefresh, refreshOnWake: true,
        refresh: (_changed, context) => store.loadPlayer(context?.revalidate, context?.signal), onPause: store.cancelPlayerRead })
      stopSecond = api.registerPlayerReader({ active: () => false, refresh: () => {} })
      const initial = store.loadPlayer(true), wake = api.reconcilePlayerReads()
      first.resolve(appearance()); await Promise.all([initial, wake]); await flush()
      assert.equal(count, 1)
      window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online'))
      await flush(); assert.equal(count, 1, 'one same-time wake batch')
      changed = true; await tick(); assert.equal(count, 1, 'ordinary business version cannot reload unchanged art')
      revision = 2; await tick(); assert.equal(count, 2); assert.equal(store.orderCardImage.id, 'card-b')
      document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))
      assert.equal(store.orderCardImage, null); assert.equal(timers.size, 0)
      document.visibilityState = 'visible'; now += 1000; document.dispatchEvent(new Event('visibilitychange'))
      await flush(); assert.equal(count, 3); assert.ok(store.orderCardImage)
      navigator.onLine = false; window.dispatchEvent(new Event('offline'))
      assert.equal(store.orderCardImage, null); assert.equal(timers.size, 0)
      navigator.onLine = true; now += 1000; window.dispatchEvent(new Event('online'))
      await flush(); assert.equal(count, 4); assert.ok(store.orderCardImage)
      assert.deepEqual(additions.sort(), ['focus', 'offline', 'online', 'visibilitychange'].sort())
    } finally {
      stop?.(); stopSecond?.(); stopSummary?.()
      assert.deepEqual(removals.sort(), ['focus', 'offline', 'online', 'visibilitychange'].sort())
      assert.equal(timers.size, 0)
      globalThis.setTimeout = setOriginal; globalThis.clearTimeout = clearOriginal
      globalThis.window = windowOriginal; globalThis.document = documentOriginal
    }
  })
  await check('new card image implementation introduces no browser persistence or extra polling/notification writes', async () => {
    const [store, card, shell, worker] = await Promise.all([
      readFile(resolve(clientRoot, 'src/stores/appearance.ts'), 'utf8'),
      readFile(resolve(clientRoot, 'src/views/player/OrderCard.vue'), 'utf8'),
      readFile(resolve(clientRoot, 'src/views/player/PlayerShell.vue'), 'utf8'),
      readFile(resolve(clientRoot, 'public/player-sw.js'), 'utf8')
    ])
    for (const source of [store, card]) assert.doesNotMatch(source, /localStorage|indexedDB|CacheStorage|caches\.|setInterval|addEventListener\(['"](?:online|offline|focus|visibilitychange)/)
    assert.doesNotMatch(shell, /setInterval|saveSubscription|testPush|saveAppearance/)
    assert.doesNotMatch(worker, /addEventListener\(['"]fetch|caches\.|indexedDB|localStorage/)
    assert.match(shell, /appearance\.notePlayerRevision\(summary\.appearanceRevision\)/)
  })
  report.passed = true
} catch (error) { report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1 }
finally {
  globalThis.fetch = fetchOriginal; Date.now = dateOriginal
  globalThis.window = windowOriginal; globalThis.document = documentOriginal
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  else delete globalThis.navigator
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, failures: report.failures.map(item => item.message), output }))
}
