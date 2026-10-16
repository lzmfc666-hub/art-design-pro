import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpsEvents } from '../server/ops-events.mjs'
import { createSupervisorOpsObserver } from '../scripts/studio-service-control.mjs'

test('守护实际写统一运维库，严格事件校验下故障与恢复各一次，供独立告警发送器消费', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-ops-supervisor-'))
  const observer = await createSupervisorOpsObserver({ opsDirectory: directory, environment: 'test' })
  const read = createOpsEvents({ dbPath: join(directory, 'events.sqlite'), environment: 'test' })
  try {
    observer.observe({ service: 'api', type: 'health-failed', category: 'hang' })
    observer.observe({ service: 'api', type: 'health-failed', category: 'hang' })
    observer.observe({ service: 'api', type: 'health-ok' })
    observer.observe({ service: 'api', type: 'health-ok' })
    const events = read.events({ limit: 20 }).filter(row => row.key === 'api.responsiveness')
    assert.equal(events.length, 2)
    assert.deepEqual(events.map(row => row.type).sort(), ['studio.ops.failure', 'studio.ops.recovery'])
    assert.equal(read.snapshot().delivery.state, 'disabled')
    assert.equal(existsSync(join(directory, 'ops-events.sqlite')), false)
  } finally { await observer.close(); await read.close() }
})
test('守护运维存储不能位于网站静态目录', async () => {
  await assert.rejects(createSupervisorOpsObserver({ opsDirectory: resolve('public/forbidden-ops') }), /OPS_CONFIG_INVALID/)
})
