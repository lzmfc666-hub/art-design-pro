import test from 'node:test'
import assert from 'node:assert/strict'
import { createUploadCleanup } from '../server/upload-cleanup.mjs'

const isolatedCleanup = (options) =>
  createUploadCleanup({
    enabled: false,
    intervalMinutes: 60,
    retentionDays: 7,
    limit: 50,
    ...options
  })

test('废弃上传回收默认关闭，开启后每轮限量且至少保留7天，指标不含文件及个人信息', () => {
  let calls = 0
  const disabled = isolatedCleanup({
    enabled: false,
    collect() {
      calls++
    }
  })
  disabled.start()
  assert.deepEqual(disabled.run(), { skipped: true })
  assert.equal(calls, 0)
  disabled.close()
  const scheduled = isolatedCleanup({
    enabled: true,
    clock: () => new Date('2026-10-14T00:00:00Z'),
    collect(input) {
      calls++
      assert.deepEqual(input, { before: '2026-10-07T00:00:00.000Z', limit: 50 })
      return {
        scanned: 10,
        deleted: 2,
        bytes: 200,
        protected: 8,
        privateRecord: 'must-not-be-in-metrics'
      }
    }
  })
  assert.deepEqual(scheduled.run(), { ok: true, scanned: 10, deleted: 2, bytes: 200, protected: 8 })
  assert.equal(calls, 1)
  assert.equal(scheduled.metrics().lastRunAt, '2026-10-14T00:00:00.000Z')
  assert.equal(JSON.stringify(scheduled.metrics()).includes('must-not-be-in-metrics'), false)
  scheduled.close()
  assert.deepEqual(scheduled.run(), { skipped: true })
  assert.throws(() => isolatedCleanup({ retentionDays: 6 }), /至少保留7天/)
  assert.throws(() => isolatedCleanup({ limit: 51 }), /50条/)
})

test('回收失败只报告固定错误码并留失败统计，不暴露库路径或跳过引用校验', () => {
  const cleanup = isolatedCleanup({
    enabled: true,
    collect() {
      throw new Error('private database path and data')
    }
  })
  assert.deepEqual(cleanup.run(), { ok: false, code: 'UPLOAD_CLEANUP_FAILED' })
  assert.equal(cleanup.metrics().failed, 1)
  assert.equal(cleanup.metrics().lastResult, null)
  assert.equal(JSON.stringify(cleanup.metrics()).includes('private'), false)
  cleanup.close()
})
