import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function access(actor, grants = []) {
  const source = readFileSync(new URL('../src/utils/auth/studio-access.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '')
  return new Function('useStudio', `${compiled}\nreturn canAccessStudioPage`)(() => ({
    user: { value: actor },
    can: (permission) => grants.includes(permission)
  }))
}

test('production lottery role restrictions remain mandatory alongside merchant owner metadata', () => {
  const roles = ['admin', 'manager', 'owner', 'super_admin']
  for (const role of [...roles, 'support', 'finance', 'player', 'merchant']) {
    const canAccess = access({ id: role, role, status: 'active' }, ['templates.manage'])
    assert.equal(canAccess(['templates.manage'], 'any', false, roles), roles.includes(role), role)
  }
})

test('merchant owner and explicit route roles are conjunctive with permission checks', () => {
  const owner = { id: 'owner', role: 'merchant', merchantRole: 'owner', status: 'active' }
  assert.equal(access(owner, ['orders.view'])(['orders.view'], 'any', true, ['merchant']), true)
  assert.equal(access(owner, ['orders.view'])(['orders.view'], 'any', true, ['super_admin']), false)
  assert.equal(access(owner)(['orders.view'], 'any', true, ['merchant']), false)
  assert.equal(access({ ...owner, merchantRole: 'support' }, ['orders.view'])(['orders.view'], 'any', true, ['merchant']), false)
  assert.equal(access({ ...owner, status: 'disabled' }, ['orders.view'])(['orders.view'], 'any', true, ['merchant']), false)
})

test('global search enforces production role restrictions for cached menus', () => {
  const source = readFileSync(new URL('../src/components/core/layouts/art-global-search/index.vue', import.meta.url), 'utf8')
  const start = source.indexOf('const flattenAndFilterMenuItems =')
  const end = source.indexOf('// 高亮控制', start)
  assert.ok(start > 0 && end > start)
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  for (const role of ['admin', 'support', 'merchant']) {
    const filter = new Function('canAccessStudioPage', 'formatMenuTitle', 'searchField', `${compiled}\nreturn flattenAndFilterMenuItems`)(
      access({ id: role, role, merchantRole: 'owner', status: 'active' }, ['templates.manage']),
      (value) => value,
      { value: 'title' }
    )
    const result = filter([{ path: '/system/lottery', meta: { title: '转盘管理', studioPermissions: ['templates.manage'], studioRoles: ['admin', 'super_admin'] } }], '转盘')
    assert.equal(result.length, role === 'admin' ? 1 : 0)
  }
})

test('global search removes role-protected history when identity permissions stay the same', () => {
  const source = readFileSync(new URL('../src/components/core/layouts/art-global-search/index.vue', import.meta.url), 'utf8')
  const start = source.indexOf('function pruneHistory()')
  const end = source.indexOf('const addHistory =', start)
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const cached = { path: '/system/lottery', meta: { title: '转盘管理', studioPermissions: ['templates.manage'], studioRoles: ['admin', 'super_admin'] } }
  const history = { value: [cached] }
  const prune = new Function('menuList', 'historyResult', 'userStore', 'can', 'canAccessStudioPage', `${compiled}\nreturn pruneHistory`)(
    { value: [cached] }, history, { setSearchHistory: (value) => { history.value = value } }, () => true,
    access({ id: 'support', role: 'support', status: 'active' }, ['templates.manage'])
  )
  prune()
  assert.deepEqual(history.value, [])
})

function realSearch(actor, categoryValue) {
  const source = readFileSync(new URL('../src/components/core/layouts/art-global-search/index.vue', import.meta.url), 'utf8')
  const categoryStart = source.indexOf('const categories =')
  const categoryEnd = source.indexOf('const fields:', categoryStart)
  const matchingStart = source.indexOf('function businessMatches(')
  const matchingEnd = source.indexOf('\n  watch(', matchingStart)
  assert.ok(categoryStart > 0 && categoryEnd > categoryStart && matchingEnd > matchingStart)
  const code = ts.transpileModule(source.slice(categoryStart, categoryEnd) + '\n' + source.slice(matchingStart, matchingEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function('computed', 'user', 'data', 'can', 'category', 'searchField', 'statusLabels', 'roleLabels', `${code}\nreturn { categories: categories.value, matches: businessMatches('sample') }`)(
    (read) => ({ get value() { return read() } }), { value: actor },
    { value: {
      orders: [{ id: 'own-order', customerId: 'own-customer', orderNo: 'sample-order', title: '任务', status: 'pending' }],
      customers: [{ id: 'own-customer', name: 'sample-customer', contact: 'contact', gameId: 'game', remark: '' }],
      users: [{ id: 'own-user', name: 'sample-staff', username: 'sample-login', role: 'merchant', status: 'active' }]
    } }, () => true, { value: categoryValue },
    { value: categoryValue === 'orders' ? 'orderNo' : 'name' }, { pending: '待接单' }, { merchant: '商家' }
  )
}

test('merchant global business search stays in the merchant channel and omits management categories', () => {
  const actor = { id: 'merchant', role: 'merchant', merchantRole: 'owner', status: 'active' }
  const result = realSearch(actor, 'orders')
  assert.deepEqual(result.categories.map((item) => item.key), ['menu', 'orders'])
  assert.equal(result.matches[0].path, '/merchant/orders?id=own-order')
  assert.deepEqual(realSearch(actor, 'customers').matches, [])
  assert.deepEqual(realSearch(actor, 'people').matches, [])
})

test('internal global business search retains existing order and management destinations', () => {
  const actor = { id: 'admin', role: 'admin', status: 'active' }
  assert.deepEqual(realSearch(actor, 'orders').categories.map((item) => item.key), ['menu', 'orders', 'customers', 'people'])
  assert.equal(realSearch(actor, 'orders').matches[0].path, '/orders/list?id=own-order')
  assert.equal(realSearch(actor, 'customers').matches[0].path, '/personnel/customers?id=own-customer')
  assert.match(realSearch(actor, 'people').matches[0].path, /^\/personnel\/employees\?role=merchant&name=sample-staff$/)
})
