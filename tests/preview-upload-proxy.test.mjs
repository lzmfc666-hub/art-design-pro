import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { uploadPreviewFixture } from './helpers/upload-preview-fixture.mjs'

const png = () => sharp({ create: { width: 96, height: 72, channels: 3, background: '#4399cc' } }).png().toBuffer()
async function request(f, channel, actor, path, body) {
  const response = await fetch(f.bases[channel] + '/api/studio/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Cookie: actor.cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Studio-Actor': actor.user.id }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await response.json()
  assert.equal(response.status, 200, JSON.stringify(data))
  return data
}
async function upload(f, channel, actor, name, data) {
  const response = await fetch(f.bases[channel] + '/api/studio/uploads', { method: 'POST',
    headers: { Cookie: actor.cookie, 'X-Studio-Actor': actor.user.id,
      'Content-Type': 'image/png', 'X-Upload-Name': encodeURIComponent(name) }, body: data })
  const image = await response.json()
  assert.equal(response.status, 200, JSON.stringify(image))
  assert.equal(image.name, name)
  assert.deepEqual(f.api.service.download(actor.user.id, image.id).data, data)
  assert.equal(f.uploads.at(-1).nameHeader, encodeURIComponent(name))
  assert.equal(f.uploads.at(-1).actor, actor.user.id)
  return image
}

test('真实后台预览代理保留二进制文件名与账号，中文空格Logo可上传并保存外观', async t => {
  const f = await uploadPreviewFixture(); t.after(() => f.stop())
  const actor = await f.login(), data = await png()
  const image = await upload(f, 'admin', actor, '工作室 中文 Logo 带空格.png', data)
  const config = await request(f, 'admin', actor, 'appearance')
  const saved = await request(f, 'admin', actor, 'appearance', { revision: config.revision, config: { ...config, logo: image } })
  assert.equal(saved.logo.name, image.name)
  const original = await fetch(f.bases.admin + '/api/studio/public-assets/' + image.id)
  assert.equal(original.status, 200)
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), data)
  assert.equal(f.uploads.at(-1).channel, 'admin')
})

test('真实打手代理头像与订单材料上传均保留中文空格名称、原字节及业务引用', async t => {
  const f = await uploadPreviewFixture(); t.after(() => f.stop())
  const actor = await f.login('player'), data = await png()
  const avatar = await upload(f, 'player', actor, '我的 中文 头像.png', data)
  const profile = await request(f, 'player', actor, 'profile', { name: actor.user.name, avatar })
  assert.equal(profile.avatar.name, avatar.name)
  const image = await upload(f, 'player', actor, '订单 完成材料 中文 空格.png', data)
  const order = await request(f, 'player', actor, `player/orders/${f.order.id}`)
  const submitted = await request(f, 'player', actor, `player/orders/${f.order.id}/submit`, {
    requestId: randomUUID(), expectedRevision: order.revision, assignmentId: order.assignmentId,
    leaderId: order.leaderId, screenshots: [image], teammateId: null
  })
  assert.equal(submitted.status, 'review')
  assert.equal(submitted.submissions.at(-1).screenshots[0].name, image.name)
  assert.equal(f.uploads.at(-1).channel, 'player')
})

test('预览代理保留后端文件名编码及actor校验，不用兜底文件名掩盖错误', async t => {
  const f = await uploadPreviewFixture(); t.after(() => f.stop())
  const actor = await f.login(), data = await png()
  const post = headers => fetch(f.bases.admin + '/api/studio/uploads', { method: 'POST',
    headers: { Cookie: actor.cookie, 'X-Studio-Actor': actor.user.id, 'Content-Type': 'image/png', ...headers }, body: data })
  const missing = await post({})
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).message, '请提供有效图片文件名')
  assert.equal((await post({ 'X-Upload-Name': '%invalid' })).status, 400)
  assert.equal((await post({ 'X-Upload-Name': encodeURIComponent('wrong actor.png'), 'X-Studio-Actor': 'another-account' })).status, 409)
  assert.equal(f.uploads.length, 3)
})
