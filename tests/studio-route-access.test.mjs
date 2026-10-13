import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/utils/auth/studio-access.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture(grants) {
  // 执行实际权限工具，仅将 Pinia 依赖替换成本次服务器授权集合。
  const script = compiled.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '')
  return new Function(
    'useStudio',
    `${script}\nreturn {canAccessStudioPage,dataInspectionPermissions}`
  )(() => ({ can: (permission) => grants.has(permission) }))
}

test('数据检查必须全部授权，缺少任何一项均拒绝，不影响既有页面的任一授权规则', () => {
  const full = fixture(
    new Set([
      'settings.manage',
      'logs.view',
      'reports.export',
      'orders.view',
      'users.manage',
      'salary.all',
      'profit.view',
      'finance.review',
      'finance.refunds',
      'finance.withdrawals',
      'finance.expenses'
    ])
  )
  assert.equal(full.canAccessStudioPage(full.dataInspectionPermissions, 'all'), true)
  for (const revoked of full.dataInspectionPermissions) {
    const current = fixture(
      new Set(full.dataInspectionPermissions.filter((permission) => permission !== revoked))
    )
    assert.equal(
      current.canAccessStudioPage(current.dataInspectionPermissions, 'all'),
      false,
      revoked
    )
  }
  const ordinaryAdmin = fixture(
    new Set(['settings.manage', 'logs.view', 'users.manage', 'orders.view', 'reports.export'])
  )
  assert.equal(
    ordinaryAdmin.canAccessStudioPage(ordinaryAdmin.dataInspectionPermissions, 'all'),
    false
  )
  assert.equal(ordinaryAdmin.canAccessStudioPage(['templates.manage', 'settings.manage']), true)
  assert.equal(ordinaryAdmin.canAccessStudioPage(['finance.review', 'finance.withdrawals']), false)
  assert.equal(ordinaryAdmin.canAccessStudioPage(undefined), true)
})
