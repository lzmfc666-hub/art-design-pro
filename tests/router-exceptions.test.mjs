import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createMemoryHistory, createRouter } from 'vue-router'
import { RoutePermissionValidator } from '../src/router/core/RoutePermissionValidator.ts'

// 读取实际路由源码，转成可在 Node 中执行的模块；类型导入由 TS 移除。
// 懒加载 Vue 组件的函数不会执行，注册时只替换组件，保留真实路径、名字及层级。
async function readRouteModule(relativePath) {
  const url = new URL(relativePath, import.meta.url)
  const result = ts.transpileModule(readFileSync(url, 'utf8'), {
    fileName: url.pathname,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true
  })
  assert.deepEqual(
    (result.diagnostics || []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    ),
    [],
    `路由源码应可转译：${relativePath}`
  )
  let output = result.outputText
  const dependencyPattern = /from ['"]([^'"]+)['"]/g
  const dependencies = [...output.matchAll(dependencyPattern)]
  for (const dependency of dependencies) {
    if (!dependency[1].startsWith('.')) continue
    const dependencyUrl = new URL(`${dependency[1]}.ts`, url)
    const nested = ts.transpileModule(readFileSync(dependencyUrl, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText
    output = output.replace(
      dependency[0],
      `from 'data:text/javascript;base64,${Buffer.from(nested).toString('base64')}'`
    )
  }
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

const { staticRoutes } = await readRouteModule('../src/router/routes/staticRoutes.ts')
const { exceptionRoutes } = await readRouteModule('../src/router/modules/exception.ts')
const DummyComponent = { render: () => null }
const withDummyComponents = (route) => ({
  ...route,
  ...(route.component ? { component: DummyComponent } : {}),
  ...(route.components
    ? {
        components: Object.fromEntries(
          Object.keys(route.components).map((key) => [key, DummyComponent])
        )
      }
    : {}),
  ...(route.children ? { children: route.children.map(withDummyComponents) } : {})
})

function assertStaticExceptions(router, stage) {
  for (const [name, path] of [
    ['Exception403', '/403'],
    ['Exception500', '/500']
  ]) {
    assert.equal(router.hasRoute(name), true, `${stage}必须保留静态 ${name}`)
    const resolved = router.resolve({ name })
    assert.equal(resolved.name, name)
    assert.equal(resolved.path, path, `${stage}不能改写静态异常页路径`)
  }
  assert.equal(router.hasRoute('Exception404'), true, `${stage}必须保留静态 Exception404`)
  const notFound = router.resolve({
    name: 'Exception404',
    params: { pathMatch: ['unknown', 'nested'] }
  })
  assert.equal(notFound.name, 'Exception404')
  assert.equal(notFound.path, '/unknown/nested')
  assert.equal(notFound.matched.at(-1).path, '/:pathMatch(.*)*')
}

test('动态异常示例注册与反复注销后，静态异常页按名可访问且未知路径仍回退404', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: staticRoutes.map(withDummyComponents)
  })
  assertStaticExceptions(router, '注册前')
  for (let cycle = 1; cycle <= 3; cycle++) {
    const unregister = router.addRoute(withDummyComponents(exceptionRoutes))
    for (const status of ['403', '404', '500']) {
      const sample = exceptionRoutes.children.find((route) => route.path === status)
      assert.ok(sample, `实际示例源码应保留 ${status} 路径`)
      await router.push(`/exception/${status}`)
      assert.equal(router.currentRoute.value.name, sample.name)
      assert.equal(router.currentRoute.value.path, `/exception/${status}`)
    }
    unregister()
    assertStaticExceptions(router, `第 ${cycle} 次注销后`)
    await router.push(`/never-registered/${cycle}/nested`)
    assert.equal(router.currentRoute.value.name, 'Exception404')
    assert.equal(router.currentRoute.value.matched.at(-1).path, '/:pathMatch(.*)*')
  }
})

test('菜单父目录不授予未列出的子页权限，隐藏路由、精确嵌套页和动态参数仍可访问', () => {
  const systemMenu = [
    {
      path: '/system',
      name: 'System',
      meta: { title: '系统管理' },
      children: [
        {
          path: '/system/user-center',
          name: 'UserCenter',
          meta: { title: '个人中心', isHide: true }
        }
      ]
    }
  ]
  assert.equal(RoutePermissionValidator.hasPermission('/system/appearance', systemMenu), false)
  assert.deepEqual(
    RoutePermissionValidator.validatePath('/system/appearance', systemMenu, '/dashboard/console'),
    { path: '/dashboard/console', hasPermission: false }
  )
  assert.equal(RoutePermissionValidator.hasPermission('/system/user-center', systemMenu), true)
  assert.deepEqual(
    RoutePermissionValidator.validatePath('/system/user-center', systemMenu, '/dashboard/console'),
    { path: '/system/user-center', hasPermission: true }
  )
  const nestedMenu = [
    {
      path: '/reports',
      meta: { title: '报表' },
      children: [
        {
          path: '/reports/statistics',
          meta: { title: '统计' },
          children: [{ path: '/reports/statistics/daily', meta: { title: '日报' } }]
        }
      ]
    },
    {
      path: '/article',
      meta: { title: '文章' },
      children: [{ path: '/article/detail/:id', meta: { title: '文章详情', isHide: true } }]
    }
  ]
  assert.equal(
    RoutePermissionValidator.hasPermission('/reports/statistics/daily', nestedMenu),
    true
  )
  assert.equal(
    RoutePermissionValidator.hasPermission('/reports/statistics/missing', nestedMenu),
    false
  )
  assert.equal(RoutePermissionValidator.hasPermission('/article/detail/42', nestedMenu), true)
  assert.equal(
    RoutePermissionValidator.hasPermission('/article/detail/42/comments', nestedMenu),
    false
  )
  assert.equal(RoutePermissionValidator.hasPermission('/article/detail', nestedMenu), false)
  assert.equal(RoutePermissionValidator.hasPermission('/articles/detail/42', nestedMenu), false)
})
