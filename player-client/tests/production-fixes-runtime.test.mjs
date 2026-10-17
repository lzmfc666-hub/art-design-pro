import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Controlled HTTP faults exercise actual client runtime; this does not claim production network performance.
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(resolve(tmpdir(), 'studio-player-fixes-'))
const require = createRequire(await realpath(resolve(clientRoot, 'node_modules/vite/package.json')))
const { build } = require('esbuild')
await build({ stdin: { contents: `
  export * from './src/api/privateImages'
  export * from './src/api/studio'
  export * from './src/api/sessionBoundary'
  export * from './src/api/orderTarget'
  export * from './src/api/operations'
  export { useSessionStore } from './src/stores/session'
  export { createPinia, setActivePinia } from 'pinia'
`, resolveDir: clientRoot, sourcefile: 'production-fixes-runtime-entry.ts', loader: 'ts' },
  outfile: resolve(output, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', tsconfig: resolve(clientRoot, 'tsconfig.json') })
const api = await import(pathToFileURL(resolve(output, 'runtime.mjs')).href)
let responseDelay = 0, requests = [], active = 0, maxActive = 0, actor = 'player-a', failedWrite = false
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  requests.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks) })
  active++; maxActive = Math.max(maxActive, active)
  await new Promise(done => setTimeout(done, responseDelay))
  response.setHeader('X-Studio-User', actor)
  if (request.url.includes('/uploads/') || request.url.includes('/content-assets/')) {
    response.setHeader('Content-Type', 'image/webp'); response.end(Buffer.from(`pixels:${actor}:${request.url}`))
  } else if (request.url.includes('/problem-feedback') && failedWrite) response.destroy()
  else { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}') }
  active--
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const originalFetch = globalThis.fetch
globalThis.fetch = (url, options) => originalFetch(new URL(url, base), options)
api.setActivePinia(api.createPinia())
const session = api.useSessionStore()
const user = id => ({ id, username: id, name: id, role: 'player', status: 'active', maxActiveOrders: 3, playerAccess: { login: true, claim: true, withdraw: true } })
session.acceptUser(user(actor))
api.setPrincipalVerifier(id => id === session.user?.id)
api.setRequestActorProvider(() => session.user?.id)
api.setUnauthorizedHandler(() => {})
function reset() { api.clearPrivateImages(); requests = []; responseDelay = 0; maxActive = 0 }

await test('production-fix player runtime boundaries', async suite => {
  try {
    await suite.test('binary upload preserves exact bytes, MIME, Unicode name and captured actor', async () => {
      reset()
      const bytes = Buffer.from([0, 255, 1, 3, 5, 7])
      await api.studioRequest('uploads', new Blob([bytes], { type: 'image/png' }), 'POST', undefined, { uploadName: '完成截图.png', expectedActorId: 'player-a' })
      assert.deepEqual(requests[0].body, bytes)
      assert.equal(requests[0].headers['content-type'], 'image/png')
      assert.equal(requests[0].headers['x-upload-name'], encodeURIComponent('完成截图.png'))
      assert.equal(requests[0].headers['x-studio-actor'], 'player-a')
      assert.equal(requests[0].headers['x-studio-client'], 'player')
    })
    await suite.test('same thumbnail and context merge; repeated display uses only memory; new revision reauthorizes', async () => {
      reset(); responseDelay = 20
      const url = '/api/studio/uploads/image-a?variant=thumb'
      const [first, second] = await Promise.all([api.privateImageBlob(url, 'order:1'), api.privateImageBlob(url, 'order:1')])
      assert.equal(first, second); assert.equal(requests.length, 1)
      assert.equal(await api.privateImageBlob(url, 'order:1'), first); assert.equal(requests.length, 1)
      await api.privateImageBlob(url, 'order:2'); assert.equal(requests.length, 2)
      assert.equal(requests[0].headers['cache-control'], 'no-cache')
    })
    await suite.test('thumbnail transfer concurrency is bounded at four', async () => {
      reset(); responseDelay = 15
      await Promise.all(Array.from({ length: 16 }, (_, index) => api.privateImageBlob(`/api/studio/uploads/grid-${index}?variant=thumb`)))
      assert.equal(requests.length, 16); assert.ok(maxActive <= 4, `observed ${maxActive} active image reads`)
    })
    await suite.test('bounded LRU drops old entries; originals are never retained for repeat retrieval', async () => {
      reset()
      for (let index = 0; index < 50; index++) await api.privateImageBlob(`/api/studio/uploads/lru-${index}?variant=thumb`)
      await api.privateImageBlob('/api/studio/uploads/lru-0?variant=thumb')
      assert.equal(requests.length, 51)
      await api.privateImageBlob('/api/studio/uploads/original')
      await api.privateImageBlob('/api/studio/uploads/original')
      assert.equal(requests.length, 53)
    })
    await suite.test('session and permission boundaries erase pixels, abort old reads and force current-account retrieval', async () => {
      reset()
      const url = '/api/studio/uploads/shared?variant=thumb'
      await api.privateImageBlob(url)
      api.invalidateSessionRequests('permissions')
      await api.privateImageBlob(url); assert.equal(requests.length, 2)
      responseDelay = 60
      const old = api.privateImageBlob('/api/studio/uploads/late?variant=thumb')
      const rejection = assert.rejects(old)
      session.acceptUser(user('player-b')); actor = 'player-b'
      await rejection
      responseDelay = 0
      const current = await api.privateImageBlob(url)
      assert.match(await current.text(), /player-b/)
      session.acceptUser(user('player-a')); actor = 'player-a'
    })
    await suite.test('external addresses are refused and content derivatives retain canonical protected route', async () => {
      reset()
      assert.equal(api.thumbnailUrl('/api/studio/player/content-assets/banner', 'display'), '/api/studio/player/content-assets/banner?variant=display')
      assert.equal(api.thumbnailUrl('https://outside.invalid/p.png'), '')
      await assert.rejects(api.readStudioImage('https://outside.invalid/p.png', new AbortController().signal))
      assert.equal(requests.length, 0)
    })
    await suite.test('issue target permits current teammate, rejects outsiders, stale assignment and closed issue', () => {
      const order = { id: 'order-a', revision: 7, assignmentId: 'assignment-a', leaderId: 'leader-a', teammateId: 'mate-a', problem: { id: 'problem-a', status: 'open' } }
      assert.deepEqual(api.problemFeedbackTarget(order, 'mate-a'), { expectedRevision: 7, assignmentId: 'assignment-a', leaderId: 'leader-a' })
      assert.throws(() => api.problemFeedbackTarget(order, 'outside'), /问题已变化/)
      assert.throws(() => api.problemFeedbackTarget({ ...order, assignmentId: null }, 'mate-a'))
      assert.deepEqual(api.problemFeedbackTarget({ ...order, status: 'completed', assignmentId: null }, 'mate-a'), { expectedRevision: 7, assignmentId: null, leaderId: 'leader-a' })
      assert.throws(() => api.problemFeedbackTarget({ ...order, problem: { id: 'problem-a', status: 'closed' } }, 'mate-a'))
      assert.notEqual(api.orderTargetKey(order), api.orderTargetKey({ ...order, displayStatus: 'refunded' }))
      assert.notEqual(api.orderTargetKey(order), api.orderTargetKey({ ...order, problem: { id: 'problem-b', status: 'open' } }))
    })
    await suite.test('problem feedback response loss locks family and original-result acknowledgement releases it without replay', async () => {
      reset(); failedWrite = true
      const operation = api.usePlayerOperation('problem-feedback')
      const intent = api.captureOperation('problem-feedback', 'player/orders/order-a/problem-feedback', { expectedRevision: 7, assignmentId: 'assignment-a', leaderId: 'player-a', problemId: 'problem-a', message: '已联系处理' })
      const result = await operation.execute(intent)
      assert.equal(result.state, 'unknown'); assert.equal(operation.pending.value, true)
      assert.equal(await operation.execute(api.captureOperation('problem-feedback', intent.path, { message: '重复请求' })), null)
      assert.equal(requests.length, 1)
      api.setOperationLookup(async original => ({ requestId: original.requestId, family: original.family, status: 'succeeded', operationConfirmed: true, result: 'confirmation-only', createdAt: new Date().toISOString(), lateCommitPossible: false, canCreateNew: false, canRetryWithOriginal: false }))
      assert.equal((await operation.check()).state, 'confirmed')
      assert.equal(operation.pending.value, false); assert.equal(requests.length, 1)
      const payload = JSON.parse(requests[0].body.toString())
      assert.equal(payload.problemId, 'problem-a'); assert.equal(payload.message, '已联系处理'); assert.equal(payload.requestId, intent.requestId)
    })
  } finally {
    api.clearPrivateImages(); globalThis.fetch = originalFetch
    await new Promise(done => server.close(done))
  }
})
