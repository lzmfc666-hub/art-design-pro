import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { finished } from 'node:stream/promises'
import { createCappedLogSink, appendCappedEvent } from '../scripts/studio-log-sink.mjs'

test('进程日志容量有上限，满后消费stdout且只警告一次，既有内容不删除', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'studio-log-cap-')), 'owned.log')
  let warnings = 0
  const sink = createCappedLogSink(path, { maxBytes: 100, onCapacity: () => warnings++ })
  sink.write(Buffer.alloc(95, 'a')); sink.write(Buffer.alloc(100, 'b')); sink.end(Buffer.alloc(100, 'c'))
  await finished(sink)
  assert.equal(statSync(path).size, 100); assert.equal(warnings, 1)
  assert.equal(readFileSync(path, 'utf8'), 'a'.repeat(95) + 'b'.repeat(5))
  const oversized = 'preserved-record-'.repeat(20)
  writeFileSync(path, oversized)
  const next = createCappedLogSink(path, { maxBytes: 100 }); next.end('must-not-replace')
  await finished(next); assert.equal(readFileSync(path, 'utf8'), oversized)
})
test('JSON事件容量不截断记录、不清理外部文件', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'studio-event-cap-')), 'owned.jsonl')
  assert.equal(appendCappedEvent(path, { status: 'one' }, 24), true)
  assert.equal(appendCappedEvent(path, { status: 'two' }, 24), false)
  assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse), [{ status: 'one' }])
})
