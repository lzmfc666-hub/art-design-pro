import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultAppearance,
  normalizeAppearance,
  appearanceAttachments,
  publicAppearanceAttachments,
  projectPublicAppearance,
  projectAppearanceAudit
} from '../server/appearance.mjs'

const image = (id) => ({
  id,
  name: `${id}.png`,
  mime: 'image/png',
  size: 64,
  url: `/api/studio/uploads/${id}`
})
const resolver = (value) => image(value.id)

test('older appearance configurations receive default login and glass settings', () => {
  const old = defaultAppearance()
  delete old.login
  delete old.glass
  const result = normalizeAppearance(old, resolver)
  assert.deepEqual(result.login, defaultAppearance().login)
  assert.deepEqual(result.glass, { enabled: false })
  assert.ok(projectAppearanceAudit(old))
})

test('login text and settings are strictly validated and normalized', () => {
  const config = defaultAppearance()
  config.login.title = '  工作室登录  '
  config.login.description = '账号由管理员分配\n忘记密码请联系管理员。'
  config.glass.enabled = true
  const result = normalizeAppearance(config, resolver)
  assert.equal(result.login.title, '工作室登录')
  assert.equal(result.glass.enabled, true)
  for (const invalid of ['<script>alert(1)</script>', '', 'x'.repeat(81), 'bad\u0000text']) {
    const invalidConfig = defaultAppearance()
    invalidConfig.login.title = invalid
    assert.throws(() => normalizeAppearance(invalidConfig, resolver))
  }
  for (const mutate of [
    (value) => {
      value.login.subtitle = 'x'.repeat(201)
    },
    (value) => {
      value.login.description = 'x'.repeat(801)
    },
    (value) => {
      value.login.background.overlay = 91
    },
    (value) => {
      value.login.background.mode = 'image'
    },
    (value) => {
      value.login.background.color = 'url(https://example.com)'
    },
    (value) => {
      value.login.html = '<div />'
    },
    (value) => {
      value.glass.enabled = 'true'
    }
  ]) {
    const invalidConfig = defaultAppearance()
    mutate(invalidConfig)
    assert.throws(() => normalizeAppearance(invalidConfig, resolver))
  }
})

test('login images use the same actual attachment resolver as private appearance images', () => {
  const config = defaultAppearance()
  config.login.background.mode = 'image'
  config.login.background.image = image('login')
  const resolved = []
  const value = normalizeAppearance(config, (attachment) => {
    resolved.push(attachment.id)
    return resolver(attachment)
  })
  assert.deepEqual(resolved, ['login'])
  assert.equal(value.login.background.image.url, '/api/studio/uploads/login')
  assert.throws(
    () =>
      normalizeAppearance(config, () => {
        throw new Error('没有附件权限')
      }),
    /没有附件权限/
  )
})

test('public appearance contains only public brand/login/glass and rewrites public asset URLs', () => {
  const config = defaultAppearance()
  config.logo = image('logo')
  config.page = { ...config.page, mode: 'image', image: image('private-page') }
  config.hero = { ...config.hero, mode: 'image', image: image('private-hero') }
  config.login.background = {
    ...config.login.background,
    mode: 'image',
    image: image('public-login')
  }
  config.revision = 44
  config.updatedBy = 'private-admin-id'
  const value = projectPublicAppearance(config)
  assert.deepEqual(Object.keys(value).sort(), ['glass', 'login', 'logo', 'studioName'])
  assert.equal(value.logo.url, '/api/studio/public-assets/logo')
  assert.equal(value.login.background.image.url, '/api/studio/public-assets/public-login')
  assert.equal(JSON.stringify(value).includes('private-'), false)
  assert.deepEqual(
    publicAppearanceAttachments(config).map((asset) => asset.id),
    ['logo', 'public-login']
  )
  assert.deepEqual(
    appearanceAttachments(config).map((asset) => asset.id),
    ['logo', 'private-page', 'private-hero', 'public-login']
  )
  value.login.title = 'changed'
  assert.notEqual(value.login.title, config.login.title)
})

test('inactive login background is neither projected nor permitted as a public image', () => {
  const config = defaultAppearance()
  config.login.background.image = image('inactive-login')
  assert.deepEqual(publicAppearanceAttachments(config), [])
  assert.equal(projectPublicAppearance(config).login.background.image, null)
  assert.equal(appearanceAttachments(config).length, 1)
  assert.equal(appearanceAttachments(config, { activeOnly: true }).length, 0)
})

test('older login settings keep their text and background while receiving a default left illustration', () => {
  const config = defaultAppearance()
  delete config.login.illustration
  config.login.title = '原有登录文案'
  config.login.background = { ...config.login.background, mode: 'image', image: image('login-bg') }
  const normalized = normalizeAppearance(config, resolver)
  assert.deepEqual(normalized.login.illustration, { mode: 'default', image: null })
  assert.equal(normalized.login.title, '原有登录文案')
  assert.equal(normalized.login.background.image.id, 'login-bg')
  assert.deepEqual(projectPublicAppearance(config).login.illustration, {
    mode: 'default',
    image: null
  })
  assert.deepEqual(projectAppearanceAudit(config).login.illustration, {
    mode: 'default',
    image: null
  })
})

test('left illustration has independent validation and public attachment projection', () => {
  const config = defaultAppearance()
  config.login.illustration = { mode: 'image', image: image('left') }
  const result = normalizeAppearance(config, resolver)
  assert.equal(result.login.background.mode, 'default')
  assert.equal(result.login.illustration.image.url, '/api/studio/uploads/left')
  assert.equal(
    projectPublicAppearance(config).login.illustration.image.url,
    '/api/studio/public-assets/left'
  )
  assert.deepEqual(
    publicAppearanceAttachments(config).map((row) => row.id),
    ['left']
  )
  assert.deepEqual(
    appearanceAttachments(config, { activeOnly: true }).map((row) => row.id),
    ['left']
  )
  config.login.illustration.mode = 'default'
  assert.equal(projectPublicAppearance(config).login.illustration.image, null)
  assert.deepEqual(publicAppearanceAttachments(config), [])
  assert.deepEqual(appearanceAttachments(config, { activeOnly: true }), [])
  assert.equal(appearanceAttachments(config)[0].id, 'left')
  for (const illustration of [
    null,
    'image',
    { mode: 'external', image: null },
    { mode: 'image', image: null },
    { mode: 'default', image: null, html: '<img>' }
  ]) {
    assert.throws(() =>
      normalizeAppearance({ ...config, login: { ...config.login, illustration } }, resolver)
    )
  }
})
