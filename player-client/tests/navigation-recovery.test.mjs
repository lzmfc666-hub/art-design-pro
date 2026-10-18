import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Pure client runtime only: no browser, database, active build directory or server is modified.
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(resolve(tmpdir(), 'studio-navigation-recovery-'))
const dependency = createRequire(await realpath(resolve(clientRoot, 'node_modules/vite/package.json')))
const { build } = dependency('esbuild')
await build({ entryPoints: [resolve(clientRoot, 'src/api/navigationRecovery.ts')], outfile: resolve(output, 'runtime.mjs'),
  bundle: true, platform: 'node', format: 'esm', tsconfig: resolve(clientRoot, 'tsconfig.json') })
const api = await import(pathToFileURL(resolve(output, 'runtime.mjs')).href)
const origin = 'https://player.example.test/site/?existing=1#/player/lobby'
const paths = new Set(['/player/lobby', '/player/tasks', '/player/rank', '/player/me', '/player/login'])
const resolveTarget = value => paths.has(new URL(value, 'https://player.example.test').pathname) ? value : null
const resourceError = () => new TypeError('Failed to fetch dynamically imported module: https://player.example.test/assets/Me-old.js')
function fixture() {
  let href = origin, replacements = [], reloads = 0
  const recovery = api.createNavigationLoadRecovery({ resolveTarget, href: () => href,
    replaceHref: value => { replacements.push(value); href = value }, reload: () => { reloads++ } })
  return { recovery, replacements, reloads: () => reloads, href: () => href }
}

test('仅明确的模块/CSS资源错误触发提示，业务、语法及通用网络错误不误判', () => {
  for (const error of [resourceError(), new TypeError('error loading dynamically imported module: https://player.example.test/assets/Rank-old.js'),
    new TypeError('Importing a module script failed.'), new Error('Unable to preload CSS for /assets/Rank-old.css')])
    assert.equal(api.isNavigationResourceError(error), true)
  for (const error of [new TypeError('Failed to fetch'), new SyntaxError('Unexpected token <'), new ReferenceError('missing is not defined'),
    new Error('当前账号没有此操作权限'), new Error('HTTP 503'), 'Failed to fetch dynamically imported module: user text', null, {}]) {
    assert.equal(api.isNavigationResourceError(error), false)
    const f = fixture(); assert.equal(f.recovery.report(error, '/player/me'), false); assert.equal(f.recovery.failure.value, null)
  }
})

test('目标必须为同源内置路由，外链、catch-all、非法编码和非HTTP页面均被拒绝', () => {
  assert.equal(api.safeNavigationTarget('/player/tasks?status=stored', origin, resolveTarget), '/player/tasks?status=stored')
  assert.equal(api.safeNavigationTarget('/player/rank', origin, resolveTarget), '/player/rank')
  for (const target of ['https://outside.invalid/player/me', '//outside.invalid/player/me', 'javascript:alert(1)', '/admin',
    '/player/not-installed', '/player/me\\outside', '/player/%5c%5coutside.invalid', '/player/../admin', '/player/%00me',
    '/player/%E0%A4%A', '/player/me\n', '/player/' + 'x'.repeat(2050)])
    assert.equal(api.safeNavigationTarget(target, origin, resolveTarget), null, target)
  assert.equal(api.safeNavigationTarget('/player/me', 'file:///private/index.html', resolveTarget), null)
  assert.equal(api.safeNavigationTarget('/player/me', origin, () => '//outside.invalid/player/me'), null)
})

test('捕捉失败只保存内存目标，不自动刷新、导航、提交或保留原异常内容', () => {
  const f = fixture()
  assert.equal(f.recovery.report(new Error('Unable to preload CSS for /assets/PRIVATE-RESOURCE.css'), '/player/rank'), true)
  assert.deepEqual(f.recovery.failure.value, { target: '/player/rank' })
  assert.doesNotMatch(JSON.stringify(f.recovery.failure.value), /PRIVATE|assets|Error/)
  assert.deepEqual(f.replacements, []); assert.equal(f.reloads(), 0)
  assert.equal(f.recovery.report(resourceError(), '/player/me'), true)
  assert.deepEqual(f.recovery.failure.value, { target: '/player/me' })
  assert.deepEqual(f.replacements, []); assert.equal(f.reloads(), 0)
})

test('显式按钮才刷新一次并打开目标hash，保留同源路径和查询，全程不触碰浏览器存储', () => {
  const f = fixture(), names = ['localStorage', 'sessionStorage'], previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  let storageAccesses = 0
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, get() { storageAccesses++; throw new Error('navigation recovery must not access storage') } })
  try {
    f.recovery.report(resourceError(), '/player/tasks?status=stored')
    assert.equal(f.recovery.refresh(), true)
    assert.equal(f.href(), 'https://player.example.test/site/?existing=1#/player/tasks?status=stored')
    assert.equal(f.reloads(), 1); assert.equal(f.replacements.length, 1)
    assert.equal(f.recovery.refresh(), false); assert.equal(f.reloads(), 1)
    assert.equal(storageAccesses, 0)
  } finally {
    names.forEach((name, index) => { if (previous[index]) Object.defineProperty(globalThis, name, previous[index]); else delete globalThis[name] })
  }
})

test('刷新前重新校验内置路由，若目标已不允许则不执行导航或刷新', () => {
  let allowed = true, replaced = 0, reloaded = 0
  const recovery = api.createNavigationLoadRecovery({ resolveTarget: value => allowed ? resolveTarget(value) : null,
    href: () => origin, replaceHref: () => { replaced++ }, reload: () => { reloaded++ } })
  assert.equal(recovery.report(resourceError(), '/player/me'), true)
  allowed = false
  assert.equal(recovery.refresh(), false); assert.equal(recovery.failure.value, null)
  assert.equal(replaced, 0); assert.equal(reloaded, 0)
})

test('成功导航或用户暂不刷新可清除错误；清除和刷新异常都不会产生自动重试循环', () => {
  const f = fixture()
  f.recovery.report(resourceError(), '/player/rank'); f.recovery.clear()
  assert.equal(f.recovery.failure.value, null); assert.equal(f.recovery.refresh(), false); assert.equal(f.reloads(), 0)
  let attempts = 0
  const recovery = api.createNavigationLoadRecovery({ resolveTarget, href: () => origin,
    replaceHref: () => { attempts++; throw new Error('browser navigation blocked') }, reload: () => { throw new Error('must not reload') } })
  recovery.report(resourceError(), '/player/me')
  assert.equal(recovery.refresh(), false); assert.equal(attempts, 1)
  assert.equal(recovery.refreshing.value, false)
  recovery.clear(); assert.equal(attempts, 1)
})
