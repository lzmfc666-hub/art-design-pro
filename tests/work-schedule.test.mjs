import { testMutate } from './helpers/current-intent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, createStudioService } from '../server/studio.mjs'

const PASSWORD = 'isolated-work-schedule-test-password'
const rejects = (fn, status = 400) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status)

function fixture(t) {
  let clock = new Date('2026-10-13T04:00:00Z')
  const service = createStudioService({
    dbPath: ':memory:',
    password: PASSWORD,
    seed: false,
    clock: () => clock
  })
  t.after(() => service.close())
  const level = testMutate(service, 'admin', '/levels', { name: '班次测试等级', delaySeconds: 0 })
  const people = {}
  for (const role of ['hr', 'support', 'finance', 'admin', 'player']) {
    people[role] = testMutate(service, 'admin', '/users', {
      username: `schedule-${role}`,
      name: `班次测试${role}`,
      role,
      status: 'active',
      maxActiveOrders: 2,
      levelId: level.id,
      permissionOverrides: {},
      password: PASSWORD
    })
  }
  const set = (changes = {}, actor = people.hr.id) =>
    testMutate(service, actor, '/work-schedules', {
      userId: people.support.id,
      effectiveFrom: '2026-10-13',
      enabled: true,
      start: '09:00',
      end: '18:00',
      remark: '个人上班时间',
      ...changes
    })
  return {
    service,
    people,
    set,
    time(value) {
      clock = new Date(value)
    }
  }
}

test('人事可按人员设置固定班次、跨夜班次和未来停用，不生成考勤或工资', (t) => {
  const f = fixture(t)
  const before = f.service.bootstrap('admin')
  const day = f.set()
  rejects(() => f.set({ userId: f.people.player.id }))
  const night = f.set({ userId: f.people.finance.id, start: '22:30', end: '06:30' })
  const future = f.set({ effectiveFrom: '2026-10-15', start: '10:00', end: '19:00' })
  const disabled = f.set({ effectiveFrom: '2026-10-20', enabled: false })
  assert.equal(night.start, '22:30')
  assert.equal(night.end, '06:30')
  assert.equal(disabled.start, '')
  assert.equal(disabled.end, '')
  assert.equal(disabled.enabled, false)
  const snapshot = f.service.bootstrap('admin')
  assert.deepEqual(
    snapshot.workSchedules.map((item) => item.id),
    [day.id, night.id, future.id, disabled.id]
  )
  assert.deepEqual(snapshot.attendance, before.attendance)
  assert.deepEqual(snapshot.salaryPlans, before.salaryPlans)
  assert.deepEqual(snapshot.payrolls, before.payrolls)
  assert.deepEqual(snapshot.reports.payroll, before.reports.payroll)
  const audit = f.service.logs('admin', { entity: 'work-schedule', source: 'all' })
  assert.equal(audit.total, 4)
  assert.equal(audit.records[0].actorId, f.people.hr.id)
  assert.equal(audit.records.find((row) => row.entityId === disabled.id).after.enabled, false)
})

test('当天班次可更正，历史班次拒绝回写，已登记日考勤及实际工时保留', (t) => {
  const f = fixture(t)
  const first = f.set()
  const updated = f.set({ start: '10:00', end: '19:00' })
  assert.equal(updated.id, first.id)
  assert.equal(f.service.bootstrap('admin').workSchedules.length, 1)
  const attendance = testMutate(f.service, f.people.hr.id, '/attendance', {
    userId: f.people.support.id,
    date: '2026-10-13',
    status: 'normal',
    start: '10:00',
    end: '19:00',
    actualHours: 7.5,
    remark: '日考勤单独登记'
  })
  f.set({ start: '11:00', end: '20:00' })
  assert.deepEqual(f.service.bootstrap('admin').attendance, [attendance])
  f.time('2026-10-14T04:00:00Z')
  rejects(() => f.set({ start: '08:00' }))
  const next = f.set({ effectiveFrom: '2026-10-14', start: '08:00', end: '17:00' })
  const schedules = f.service.bootstrap('admin').workSchedules
  assert.equal(schedules.length, 2)
  assert.equal(schedules[0].start, '11:00')
  assert.equal(schedules[1].id, next.id)
  assert.deepEqual(f.service.bootstrap('admin').attendance, [attendance])
})

test('班次服务拒绝无效日期、时钟、同起止时间和停用人员，失败不留部分数据', (t) => {
  const f = fixture(t)
  for (const changes of [
    { effectiveFrom: '2026-10-12' },
    { effectiveFrom: '2026-02-30' },
    { start: '24:00' },
    { end: '12:60' },
    { start: '9:00' },
    { start: '09:00', end: '09:00' },
    { start: null },
    { enabled: 'true' },
    { remark: 'x'.repeat(1001) }
  ])
    rejects(() => f.set(changes))
  rejects(() => f.set({ userId: 'missing-user' }), 404)
  testMutate(f.service, 'admin', '/users', { ...f.people.support, status: 'disabled' })
  rejects(() => f.set())
  assert.equal(f.service.bootstrap('admin').workSchedules.length, 0)
  assert.equal(f.service.logs('admin', { entity: 'work-schedule', source: 'all' }).total, 0)
})

test('固定班次按考勤权限管理，其他人员仅能看本人，授权撤销立即生效', (t) => {
  const f = fixture(t)
  const own = f.set()
  f.set({ userId: f.people.hr.id })
  for (const role of ['support', 'finance', 'admin', 'player'])
    rejects(() => f.set({}, f.people[role].id), 403)
  assert.equal(f.service.bootstrap(f.people.hr.id).workSchedules.length, 2)
  assert.equal(f.service.bootstrap(f.people.finance.id).workSchedules.length, 2)
  assert.deepEqual(
    f.service.bootstrap(f.people.support.id).workSchedules.map((item) => item.id),
    [own.id]
  )
  assert.deepEqual(f.service.bootstrap(f.people.admin.id).workSchedules, [])
  assert.deepEqual(f.service.bootstrap(f.people.player.id).workSchedules, [])
  const audit = f.service.logs(f.people.admin.id, { entity: 'work-schedule', source: 'all' })
  assert.ok(audit.records.every((item) => item.before === null && item.after === null))
  testMutate(f.service, 'admin', '/users', {
    ...f.people.hr,
    permissionOverrides: { 'attendance.manage': false }
  })
  rejects(() => f.set(), 403)
  assert.equal(f.service.bootstrap(f.people.hr.id).workSchedules.length, 1)
})

test('旧数据缺少固定班次字段时正常读取，后续保存持久化到业务状态', (t) => {
  const f = fixture(t)
  const legacy = JSON.parse(
    f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  )
  delete legacy.workSchedules
  f.service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(legacy))
  assert.deepEqual(f.service.bootstrap(f.people.hr.id).workSchedules, [])
  const schedule = f.set()
  const stored = JSON.parse(
    f.service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json
  )
  assert.deepEqual(stored.workSchedules, [schedule])
  assert.deepEqual(stored.attendance, [])
})
