import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adminSessionUser,
  adminLoginRedirect,
  isPlayerEntryPath
} from '../src/utils/auth/admin-entry.ts'

test('后台会话恢复忽略旧打手身份，并保留管理角色本人信息', () => {
  assert.equal(adminSessionUser({ id: 'legacy-player', role: 'player' }), null)
  assert.equal(adminSessionUser(null), null)
  assert.equal(adminSessionUser(undefined), null)
  for (const role of ['super_admin', 'admin', 'owner', 'manager', 'finance', 'hr', 'support']) {
    const user = { id: `staff-${role}`, role }
    assert.equal(adminSessionUser(user), user)
  }
})

test('后台登录后拒绝打手目标和外站，保留业务目标的查询和锚点', () => {
  for (const target of [
    undefined,
    null,
    ['/orders/list'],
    '',
    'https://outside.invalid',
    '//outside.invalid',
    '/\\outside.invalid',
    '/auth',
    '/auth/login?redirect=/player/lobby',
    '/player',
    '/player?from=old-bookmark',
    '/player/lobby',
    '/player/orders/example?from=message#details'
  ]) {
    assert.equal(adminLoginRedirect(target), '/dashboard/console', String(target))
  }
  for (const target of [
    '/dashboard/console',
    '/orders/list?status=pending#details',
    '/personnel/players',
    '/system/appearance'
  ]) {
    assert.equal(adminLoginRedirect(target), target)
  }
})

test('显式打手旧书签仍属于打手入口，后台打手管理页面不被误判', () => {
  for (const path of ['/player', '/player/login', '/player/lobby?from=legacy']) {
    assert.equal(isPlayerEntryPath(path), true)
  }
  for (const path of ['/auth/login', '/dashboard/console', '/personnel/players', '/players']) {
    assert.equal(isPlayerEntryPath(path), false)
  }
})
