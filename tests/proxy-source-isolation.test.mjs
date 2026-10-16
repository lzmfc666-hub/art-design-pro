import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPlayerClientServer } from '../scripts/player-client-server.mjs'

test('独立代理基础设施：清理用户伪造的真实来源和通道，可信代理链必须显式配置', async (t) => {
  const received = []
  const backend = createServer((req, res) => {
    received.push(req.headers)
    res.end('{}')
  })
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const upstream = `http://127.0.0.1:${backend.address().port}`
  const proxy = createPlayerClientServer({ apiTarget: upstream })
  const trustedProxy = createPlayerClientServer({
    apiTarget: upstream,
    trustedProxies: ['127.0.0.1']
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => trustedProxy.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await Promise.all(
      [proxy, trustedProxy, backend].map(
        (server) => new Promise((resolve) => server.close(resolve))
      )
    )
  })
  const headers = {
    'X-Forwarded-For': '198.51.100.21',
    'X-Forwarded-Host': 'evil.invalid',
    'X-Forwarded-Proto': 'https',
    'X-Real-IP': '198.51.100.22',
    Forwarded: 'for=198.51.100.23',
    'X-Studio-Client': 'admin'
  }
  assert.equal(
    (await fetch(`http://127.0.0.1:${proxy.address().port}/api/studio/session`, { headers }))
      .status,
    200
  )
  assert.equal(received[0]['x-forwarded-for'], '127.0.0.1')
  assert.equal(received[0].forwarded, undefined)
  assert.equal(received[0]['x-real-ip'], undefined)
  assert.equal(received[0]['x-forwarded-host'], undefined)
  assert.equal(received[0]['x-forwarded-proto'], undefined)
  assert.equal(received[0]['x-studio-client'], 'player')
  await fetch(`http://127.0.0.1:${trustedProxy.address().port}/api/studio/session`, { headers })
  assert.equal(received[1]['x-forwarded-for'], '198.51.100.21')
})
