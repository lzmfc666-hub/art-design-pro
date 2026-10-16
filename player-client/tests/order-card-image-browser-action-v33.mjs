import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Fresh attachment URLs for a running isolated CUA fixture. This avoids the
// browser's in-memory decoded image reuse when testing 403/404/load delays.
const [metadataArg, action] = process.argv.slice(2)
assert.ok(metadataArg && ['fresh-a', 'fresh-b'].includes(action), 'Usage: node <script> <metadata.private.json> fresh-a|fresh-b')
const metadataPath = resolve(metadataArg)
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
const backend = new URL(metadata.backendBase)
assert.equal(backend.hostname, '127.0.0.1')
assert.ok(!['3006', '3007', '3008'].includes(backend.port))
assert.match(metadataPath.replaceAll('\\', '/'), /\/player-client\/\.qa\/v33-card-image-client\/browser-[^/]+\/metadata\.private\.json$/)
let cookie
async function api(path, body) {
  const response = await fetch(`${backend.origin}/api/studio/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : {
      'Content-Type': 'application/json', ...(path === 'login' ? {} : { 'X-Studio-Actor': 'admin' })
    }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const nextCookie = response.headers.get('set-cookie')
  if (nextCookie) cookie = nextCookie.split(';')[0]
  const value = await response.json()
  assert.equal(response.status, 200, `${path}: ${value.message || response.status}`)
  return value
}
await api('login', { username: 'admin', password: metadata.password })
const color = action === 'fresh-a' ? 'A-blue' : 'B-red'
const bytes = await readFile(resolve(dirname(metadataPath), `image-${color}.png`))
const image = await api('uploads', { name: `fresh-${color}.png`, mime: 'image/png', data: bytes.toString('base64') })
const config = await api('appearance')
const saved = await api('appearance', { config: { ...config, playerOrderCardImage: image }, revision: config.revision })
console.log(JSON.stringify({ revision: saved.revision, id: image.id }))
