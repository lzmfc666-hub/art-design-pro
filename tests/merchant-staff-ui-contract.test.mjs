import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function evaluate(relative, expose, studio = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const script = compiled.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '')
  return new Function(
    'useStudio',
    `${script}\nreturn {${expose.map((name) => `${name}: typeof ${name} === 'function' ? ${name} : undefined`).join(',')}}`
  )(() => studio)
}

const merchant = (id, merchantRole = 'support', extra = {}) => ({
  id,
  role: 'merchant',
  merchantId: 'merchant-a',
  merchantRole,
  status: 'active',
  ...extra
})

test('merchant staff menu and direct page gate require current merchant owner, not shared order grants', () => {
  for (const actor of [
    merchant('owner', 'owner'),
    merchant('support'),
    { id: 'admin', role: 'super_admin' },
    null
  ]) {
    const gate = evaluate('../src/utils/auth/studio-access.ts', ['canAccessStudioPage'], {
      can: () => true,
      user: { value: actor }
    })
    assert.equal(
      gate.canAccessStudioPage(undefined, 'any', true),
      actor?.merchantRole === 'owner',
      JSON.stringify(actor)
    )
    assert.equal(gate.canAccessStudioPage(['orders.view']), true)
  }
})

test('merchant account UI permissions preserve owner scope and reserve total backend deletion and transfer for super admin', () => {
  const helpers = evaluate('../src/utils/auth/studio-user.ts', [
    'isMerchantOwner',
    'canEditMerchantAccount',
    'canDeleteMerchantAccount',
    'canAssignMerchantOwner'
  ])
  for (const [name, fn] of Object.entries(helpers))
    assert.equal(typeof fn, 'function', `${name} must implement actual UI policy`)
  const owner = merchant('owner', 'owner')
  const staff = merchant('staff')
  const foreign = merchant('foreign', 'support', { merchantId: 'merchant-b' })
  const superAdmin = { id: 'super', role: 'super_admin', status: 'active' }
  const admin = { id: 'admin', role: 'admin', status: 'active' }
  assert.equal(helpers.isMerchantOwner(owner), true)
  assert.equal(helpers.isMerchantOwner(merchant('old')), false)
  assert.equal(helpers.canEditMerchantAccount(owner, staff, true), true)
  assert.equal(helpers.canEditMerchantAccount(owner, foreign, true), false)
  assert.equal(helpers.canEditMerchantAccount(owner, owner, true), false)
  assert.equal(helpers.canEditMerchantAccount(staff, merchant('other'), true), false)
  assert.equal(helpers.canEditMerchantAccount(null, staff, true), false)
  assert.equal(helpers.canDeleteMerchantAccount(owner, staff), true)
  assert.equal(helpers.canDeleteMerchantAccount(owner, foreign), false)
  assert.equal(helpers.canDeleteMerchantAccount(staff, merchant('other')), false)
  assert.equal(helpers.canDeleteMerchantAccount(admin, staff), false)
  assert.equal(helpers.canDeleteMerchantAccount(superAdmin, staff), true)
  assert.equal(helpers.canDeleteMerchantAccount(superAdmin, owner), false)
  assert.equal(
    helpers.canDeleteMerchantAccount(
      superAdmin,
      merchant('gone', 'support', { deletedAt: '2026-11-11T00:00:00Z' })
    ),
    false
  )
  assert.equal(helpers.canEditMerchantAccount(admin, owner, true), false)
  assert.equal(helpers.canEditMerchantAccount(superAdmin, owner, true), true)
  assert.equal(helpers.canAssignMerchantOwner(superAdmin, staff), true)
  assert.equal(helpers.canAssignMerchantOwner(admin, staff), false)
  assert.equal(helpers.canAssignMerchantOwner(owner, staff), false)
  assert.equal(helpers.canAssignMerchantOwner(superAdmin, owner), false)
})

test('menu access scope changes on owner status, merchant, identity and login eligibility without permission changes', () => {
  const { studioAccessScopeSignature } = evaluate('../src/utils/auth/studio-access.ts', [
    'studioAccessScopeSignature'
  ])
  assert.equal(
    typeof studioAccessScopeSignature,
    'function',
    'menu invalidation must track complete current identity'
  )
  const actor = merchant('same-user')
  const permissions = ['orders.view', 'orders.edit']
  const original = studioAccessScopeSignature(actor, permissions)
  for (const next of [
    { ...actor, merchantRole: 'owner' },
    { ...actor, id: 'new-user' },
    { ...actor, merchantId: 'merchant-b' },
    { ...actor, status: 'disabled' },
    { ...actor, deletedAt: '2026-11-11T00:00:00Z' },
    { ...actor, role: 'support' }
  ])
    assert.notEqual(studioAccessScopeSignature(next, permissions), original, JSON.stringify(next))
  assert.equal(studioAccessScopeSignature(actor, undefined), undefined)
  assert.equal(studioAccessScopeSignature(actor, [...permissions].reverse()), original)
})

test('global search applies owner-only metadata even before the menu list refresh completes', () => {
  const source = readFileSync(
    new URL('../src/components/core/layouts/art-global-search/index.vue', import.meta.url),
    'utf8'
  )
  const start = source.indexOf('const flattenAndFilterMenuItems =')
  const end = source.indexOf('// 高亮控制', start)
  assert.ok(start > 0 && end > start)
  const script = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  for (const actor of [merchant('owner', 'owner'), merchant('support')]) {
    const { canAccessStudioPage } = evaluate(
      '../src/utils/auth/studio-access.ts',
      ['canAccessStudioPage'],
      { can: () => true, user: { value: actor } }
    )
    const filter = new Function(
      'canAccessStudioPage',
      'formatMenuTitle',
      'searchField',
      `${script}\nreturn flattenAndFilterMenuItems`
    )(canAccessStudioPage, (value) => value, { value: 'title' })
    const results = filter(
      [{ path: '/merchant/staff', meta: { title: '客服管理', merchantOwnerOnly: true } }],
      '客服'
    )
    assert.equal(results.length, actor.merchantRole === 'owner' ? 1 : 0)
  }
})

test('global search history removes owner-only destinations immediately after owner rights are lost', () => {
  const source = readFileSync(
    new URL('../src/components/core/layouts/art-global-search/index.vue', import.meta.url),
    'utf8'
  )
  const start = source.indexOf('function pruneHistory()')
  const end = source.indexOf('const addHistory =', start)
  const script = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const actor = merchant('same-user', 'support')
  const { canAccessStudioPage } = evaluate(
    '../src/utils/auth/studio-access.ts',
    ['canAccessStudioPage'],
    { can: () => true, user: { value: actor } }
  )
  const cached = { path: '/merchant/staff', meta: { title: '客服管理', merchantOwnerOnly: true } }
  const history = { value: [cached] }
  const prune = new Function(
    'menuList',
    'historyResult',
    'userStore',
    'can',
    'canAccessStudioPage',
    `${script}\nreturn pruneHistory`
  )(
    { value: [cached] },
    history,
    {
      setSearchHistory: (value) => {
        history.value = value
      }
    },
    () => true,
    canAccessStudioPage
  )
  prune()
  assert.deepEqual(history.value, [])
})
