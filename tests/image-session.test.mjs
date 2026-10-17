import test from 'node:test'
import assert from 'node:assert/strict'
import { clearStudioImageSession, studioImagePixels, studioImageUrl } from '../src/utils/studio-image.ts'

test('展示URL保留原附件、只为本站图片追加派生尺寸与版本', () => {
  assert.equal(studioImageUrl('/api/studio/uploads/picture'), '/api/studio/uploads/picture?variant=thumb&v=picture')
  assert.equal(studioImageUrl('/api/studio/player/content-assets/content', 'display'),
    '/api/studio/player/content-assets/content?variant=display&v=content')
  assert.equal(studioImageUrl('/api/studio/public-assets/logo'), '/api/studio/public-assets/logo?variant=thumb&v=logo')
  assert.equal(studioImageUrl('blob:local-preview'), 'blob:local-preview')
})

test('私人缩图仅在当前账号内复用，清会话撤销Blob且不同账号重新鉴权', async t => {
  const originalFetch = globalThis.fetch
  let requests = 0, actor = 'first'
  globalThis.fetch = async (url, options) => {
    requests++
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'same-origin')
    return new Response(new Blob(['image-content'], { type: 'image/webp' }), { headers: { 'X-Studio-User': actor } })
  }
  t.after(() => { clearStudioImageSession(); globalThis.fetch = originalFetch })
  clearStudioImageSession()
  const path = '/api/studio/uploads/private?variant=thumb'
  const a = await studioImagePixels('first', path)
  assert.equal(await studioImagePixels('first', path), a)
  assert.equal(requests, 1)
  actor = 'second'
  const b = await studioImagePixels('second', path)
  assert.notEqual(a, b)
  assert.equal(requests, 2)
  clearStudioImageSession()
  assert.notEqual(await studioImagePixels('second', path), b)
  assert.equal(requests, 3)
})

test('切换账号或退出后，晚到图片响应不能进入新会话，响应账号不符拒绝使用', async t => {
  const originalFetch = globalThis.fetch
  let respond
  globalThis.fetch = () => new Promise(resolve => { respond = resolve })
  t.after(() => { clearStudioImageSession(); globalThis.fetch = originalFetch })
  clearStudioImageSession()
  const request = studioImagePixels('old', '/api/studio/uploads/private?variant=thumb')
  const rejected = assert.rejects(request, /会话已变更/)
  clearStudioImageSession()
  respond(new Response(new Blob(['old-private'], { type: 'image/webp' }), { headers: { 'X-Studio-User': 'old' } }))
  await rejected
  globalThis.fetch = async () => new Response(new Blob(['other-private'], { type: 'image/webp' }),
    { headers: { 'X-Studio-User': 'other' } })
  await assert.rejects(studioImagePixels('new', '/api/studio/uploads/private?variant=thumb'), /不可读取/)
})
