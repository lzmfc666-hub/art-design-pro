import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudioServer } from '../../server/index.mjs'

// Fresh real-HTTP evidence for the independent client's v3.3 handoff. This
// intentionally does not reuse/overwrite the backend's existing test evidence.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(root, 'player-client/.qa', `v33-card-image-http-${randomUUID()}`)
await mkdir(output, { recursive: true })
const password = `v33-isolated-${randomUUID()}`
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const digest = value => createHash('sha256').update(value).digest('hex')
async function backendFingerprint() {
  const files = {}
  async function visit(directory) {
    for (const row of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, row.name)
      if (row.isDirectory()) await visit(path)
      else files[path.slice(root.length + 1).replaceAll('\\', '/')] = digest(await readFile(path))
    }
  }
  await visit(join(root, 'server'))
  return { files, digest: digest(JSON.stringify(files)) }
}
const before = await backendFingerprint()
const contract = await readFile(resolve(root, 'docs/STUDIO-CONTRACT.md'))
const server = createStudioServer({
  dbPath: resolve(output, 'isolated.sqlite'), seed: false, password, maintenanceFromEnv: false,
  backups: { intervalMinutes: 0, directory: resolve(output, 'backups'), failureWebhook: '' },
  notificationIntervalMs: 86_400_000,
  notifications: { pushSender: async () => { throw new Error('External push is disabled in this isolated QA') } }
})
await new Promise(ready => server.listen(0, '127.0.0.1', ready))
const base = `http://127.0.0.1:${server.address().port}/api/studio`
assert.ok(!['3006', '3007', '3008'].includes(new URL(base).port))
const report = { contract: 'v3.3', contractSha256: digest(contract), output, apiBase: base,
  database: resolve(output, 'isolated.sqlite'), cases: [], requests: [], failures: [], passed: false,
  limitations: ['Real isolated loopback HTTP only. Frontend rendering, image decoding and physical phones are validated separately.'] }
const actors = new Map([['admin', { id: 'admin' }]])
const cookies = new Map()
async function request(actor, path, body, expected = 200, binary = false) {
  const row = actors.get(actor)
  const response = await fetch(`${base}/${path.replace(/^\//, '')}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(row?.role === 'player' || actor === 'anonymous-player' ? { 'X-Studio-Client': 'player' } : {}),
      ...(cookies.has(actor) ? { Cookie: cookies.get(actor) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(path === 'login' ? {} : { 'X-Studio-Actor': row?.id || '' }) })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const cookie = response.headers.get('set-cookie')
  if (cookie) cookies.set(actor, cookie.split(';')[0])
  const value = binary ? Buffer.from(await response.arrayBuffer()) : await response.json()
  report.requests.push({ actor, path, method: body === undefined ? 'GET' : 'POST', status: response.status,
    cacheControl: response.headers.get('cache-control'), ...(binary ? {} : { code: value.code || null }) })
  assert.equal(response.status, expected, `${actor} ${path}: ${binary ? response.status : value.message || response.status}`)
  return { value, response }
}
const json = async (...args) => (await request(...args)).value
const success = (name, details = {}) => report.cases.push({ name, passed: true, ...details })
const login = actor => json(actor, 'login', { username: actors.get(actor).username || 'admin', password })
const upload = (actor, name) => json(actor, 'uploads', { name, mime: 'image/png', data: png })
const current = () => json('admin', 'appearance')
async function save(image) {
  const config = await current()
  return json('admin', 'appearance', { config: { ...config, playerOrderCardImage: image }, revision: config.revision })
}
const snapshot = () => ({
  state: server.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json,
  audits: server.service.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n,
  outbox: server.service.db.prepare('SELECT COUNT(*) n FROM player_push_outbox').get().n
})
const imagePath = image => image.url.replace('/api/studio/', '')

try {
  await login('admin')
  const level = await json('admin', 'levels', { name: 'v3.3独立客户端HTTP隔离等级', delaySeconds: 0 })
  for (const [actor, role] of [['A', 'player'], ['B', 'player'], ['staff', 'support']]) {
    const row = await json('admin', 'users', { username: `v33-${actor}-${randomUUID().slice(0, 8)}`, name: `v3.3隔离${actor}`,
      role, status: 'active', levelId: level.id, maxActiveOrders: 3, permissionOverrides: {}, password })
    actors.set(actor, row)
    await login(actor)
  }
  const initial = await json('A', 'player/appearance')
  assert.deepEqual(Object.keys(initial).sort(), ['orderCardImage', 'revision'])
  assert.equal(initial.orderCardImage, null)
  const firstSummary = await json('A', 'player/changes')
  assert.equal(firstSummary.appearanceRevision, initial.revision)
  await request('anonymous-player', 'player/appearance', undefined, 401)
  await request('admin', 'player/appearance', undefined, 403)
  await request('staff', 'player/appearance', undefined, 403)
  success('default null minimal projection; anonymous is 401 and non-player accounts are 403')

  const imageA = await upload('admin', 'v33-client-image-A.png')
  const imageB = await upload('admin', 'v33-client-image-B.png')
  assert.notEqual(imageA.id, imageB.id)
  assert.match(imageA.url, /^\/api\/studio\/uploads\/[^/]+$/)
  await request('A', imagePath(imageA), undefined, 403)
  await request('anonymous-player', imagePath(imageA), undefined, 401)
  await request('anonymous-player', `public-assets/${imageA.id}`, undefined, 404)
  success('real admin uploads remain private before saving and never become anonymous public assets')

  const savedA = await save(imageA)
  const appearanceA = await request('A', 'player/appearance')
  assert.deepEqual(appearanceA.value, { revision: savedA.revision, orderCardImage: imageA })
  assert.equal(appearanceA.response.headers.get('cache-control'), 'no-store')
  for (const actor of ['A', 'B']) {
    const downloaded = await request(actor, imagePath(imageA), undefined, 200, true)
    assert.equal(downloaded.response.headers.get('cache-control'), 'private, no-store')
    assert.equal(downloaded.response.headers.get('content-type'), 'image/png')
    assert.deepEqual(downloaded.value, Buffer.from(png, 'base64'))
  }
  const summaryA = await json('A', `player/changes?since=${encodeURIComponent(firstSummary.version)}`)
  assert.equal(summaryA.changed, true)
  assert.equal(summaryA.appearanceRevision, savedA.revision)
  assert.notEqual(summaryA.version, firstSummary.version)
  success('saved image A is shared to active players by authenticated no-store reads and advances the existing summary', { revision: savedA.revision })

  const readonlyBefore = snapshot()
  await json('A', 'player/appearance')
  await json('A', 'player/changes')
  await request('A', imagePath(imageA), undefined, 200, true)
  assert.deepEqual(snapshot(), readonlyBefore)
  const publicAppearance = await json('anonymous-player', 'appearance/public')
  assert.ok(!Object.hasOwn(publicAppearance, 'playerOrderCardImage'))
  assert.ok(!JSON.stringify(publicAppearance).includes(imageA.id))
  success('appearance, summary and authenticated image reads leave business state, audit and notification outbox unchanged; public projection excludes card image')

  const savedB = await save(imageB)
  const summaryB = await json('A', `player/changes?since=${encodeURIComponent(summaryA.version)}`)
  assert.equal(summaryB.changed, true)
  assert.equal(summaryB.appearanceRevision, savedB.revision)
  assert.deepEqual(await json('A', 'player/appearance'), { revision: savedB.revision, orderCardImage: imageB })
  await request('A', imagePath(imageA), undefined, 403)
  await request('B', imagePath(imageA), undefined, 403)
  await request('admin', imagePath(imageA), undefined, 200, true)
  await request('A', imagePath(imageB), undefined, 200, true)
  success('replacement B advances appearanceRevision, withdraws old shared image A, and preserves independent uploader ownership', { revision: savedB.revision })

  const appearanceBeforeUnrelated = await json('A', 'player/appearance')
  const unrelatedSummary = await json('A', 'player/changes')
  await json('admin', 'customers', { name: 'v3.3不相关业务版本隔离客户', contact: '', gameId: '' })
  const summaryAfterUnrelated = await json('A', `player/changes?since=${encodeURIComponent(unrelatedSummary.version)}`)
  assert.equal(summaryAfterUnrelated.changed, true)
  assert.equal(summaryAfterUnrelated.appearanceRevision, appearanceBeforeUnrelated.revision)
  success('ordinary business change advances the original summary while keeping appearanceRevision stable')

  const beforeStale = await current()
  await request('admin', 'appearance', { config: { ...beforeStale, playerOrderCardImage: null }, revision: savedA.revision }, 409)
  assert.deepEqual(await current(), beforeStale)
  await request('A', 'appearance', { config: { ...beforeStale, playerOrderCardImage: null }, revision: beforeStale.revision }, 403)
  assert.deepEqual(await current(), beforeStale)
  success('stale admin configuration is 409 and player edit is 403 without changing the current image')

  const removed = await save(null)
  const summaryRemoved = await json('A', `player/changes?since=${encodeURIComponent(summaryB.version)}`)
  assert.equal(summaryRemoved.appearanceRevision, removed.revision)
  assert.equal(summaryRemoved.changed, true)
  assert.deepEqual(await json('A', 'player/appearance'), { revision: removed.revision, orderCardImage: null })
  await request('A', imagePath(imageB), undefined, 403)
  success('explicit removal returns null, advances summary and revokes old image B sharing', { revision: removed.revision })

  const restoredA = await save(imageA)
  const reset = await json('admin', 'appearance/reset', { revision: restoredA.revision })
  assert.equal(reset.playerOrderCardImage, null)
  assert.deepEqual(await json('A', 'player/appearance'), { revision: reset.revision, orderCardImage: null })
  assert.equal((await json('A', 'player/changes')).appearanceRevision, reset.revision)
  await request('A', imagePath(imageA), undefined, 403)
  success('real restore-default clears the card image and revokes prior sharing', { revision: reset.revision })

  const privateImage = await upload('B', 'v33-other-player-private-qr.png')
  await json('B', 'player/payment-methods', { method: 'wechat', qrCode: privateImage })
  await request('A', imagePath(privateImage), undefined, 403)
  await request('anonymous-player', imagePath(privateImage), undefined, 401)
  await request('anonymous-player', `public-assets/${privateImage.id}`, undefined, 404)
  const currentBeforePrivate = await current()
  await request('admin', 'appearance', { config: { ...currentBeforePrivate, playerOrderCardImage: privateImage }, revision: currentBeforePrivate.revision }, 403)
  assert.deepEqual(await current(), currentBeforePrivate)
  success('another player private QR remains inaccessible and cannot be shared as a card image')

  await save(imageB)
  await request('A', imagePath(imageB), undefined, 200, true)
  const playerA = actors.get('A')
  await json('admin', 'users', { ...playerA, playerAccess: { login: false, claim: true, withdraw: true } })
  await request('A', 'player/appearance', undefined, 401)
  await request('A', imagePath(imageB), undefined, 401)
  success('revoking player login invalidates both appearance and image reads from the existing session')

  await json('admin', 'users', { ...playerA, status: 'active', playerAccess: { login: true, claim: true, withdraw: true } })
  await login('A')
  await json('A', 'player/appearance')
  await json('admin', 'users', { ...playerA, status: 'disabled', playerAccess: { login: true, claim: true, withdraw: true } })
  await request('A', 'player/appearance', undefined, 401)
  await request('A', imagePath(imageB), undefined, 401)
  await request('B', 'uploads/not-a-real-id', undefined, 404)
  success('disabling the player invalidates a fresh session; unknown authenticated image id is a real 404')

  report.passed = true
} catch (error) {
  report.failures.push({ name: error.name, message: error.message, stack: error.stack })
  process.exitCode = 1
} finally {
  const after = await backendFingerprint()
  report.backendSourceStable = before.digest === after.digest
  if (!report.backendSourceStable) { report.passed = false; report.failures.push({ message: 'Backend source changed during isolated validation; rerun against a stable version.' }); process.exitCode = 1 }
  await writeFile(resolve(output, 'backend-source-before.json'), JSON.stringify(before, null, 2))
  await writeFile(resolve(output, 'backend-source-after.json'), JSON.stringify(after, null, 2))
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  await new Promise(ready => server.close(ready))
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, requests: report.requests.length,
    backendSourceStable: report.backendSourceStable, output, failures: report.failures.map(row => row.message) }, null, 2))
}
