import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlayerClientServer } from '../scripts/player-client-server.mjs'

test('独立前端代理固定后台端口，过滤后台Cookie并传递打手会话/身份和私人图片', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'player-proxy-'))
  writeFileSync(join(directory, 'index.html'), '<html>standalone-player</html>')
  writeFileSync(join(directory, 'player-sw.js'), '// standalone-worker')
  const received = []
  const api = createServer(async (req, res) => {
    received.push({
      path: req.url,
      cookie: req.headers.cookie,
      channel: req.headers['x-studio-client']
    })
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Studio-User': 'player-test',
      'Set-Cookie': [
        'studio_player_session=player-new; Path=/; HttpOnly',
        'studio_session=must-not-forward; Path=/; HttpOnly'
      ]
    })
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), path: req.url }))
  })
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
  const player = createPlayerClientServer({
    staticRoot: directory,
    apiTarget: `http://127.0.0.1:${api.address().port}`
  })
  await new Promise((resolve) => player.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => player.close(resolve))
    await new Promise((resolve) => api.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${player.address().port}`
  const result = await fetch(base + '/api/studio/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'studio_session=private-admin; studio_player_session=private-player; unknown=secret',
      'X-Studio-Client': 'admin'
    },
    body: '{"name":"更新昵称"}'
  })
  assert.equal(result.status, 200)
  assert.deepEqual(received[0], {
    path: '/api/studio/profile',
    cookie: 'studio_player_session=private-player',
    channel: 'player'
  })
  assert.equal(result.headers.get('X-Studio-User'), 'player-test')
  assert.equal(result.headers.getSetCookie().length, 1)
  assert.match(result.headers.getSetCookie()[0], /^studio_player_session=/)
  assert.equal((await result.json()).body, '{"name":"更新昵称"}')
  await fetch(base + '/api/studio/uploads/own-image', {
    headers: { Cookie: 'studio_session=private-admin; studio_player_session=private-player' }
  })
  assert.equal(received[1].cookie, 'studio_player_session=private-player')
  assert.equal(await (await fetch(base + '/')).text(), '<html>standalone-player</html>')
  assert.equal(
    await (await fetch(base + '/player/deep-link')).text(),
    '<html>standalone-player</html>'
  )
  assert.equal((await fetch(base + '/player-sw.js')).headers.get('cache-control'), 'no-cache')
  assert.equal((await fetch(base + '/api/arbitrary')).status, 404)
  assert.equal((await fetch(base + '/missing.js')).status, 404)
})

test('独立前端后端断开时返回失败，不伪造提交成功或缓存金融写入', async (t) => {
  const closed = createServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const port = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  const player = createPlayerClientServer({ apiTarget: `http://127.0.0.1:${port}` })
  await new Promise((resolve) => player.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => player.close(resolve)))
  const response = await fetch(
    `http://127.0.0.1:${player.address().port}/api/studio/player/withdrawals`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"amount":1}'
    }
  )
  assert.equal(response.status, 502)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match((await response.json()).message, /无法连接/)
})
