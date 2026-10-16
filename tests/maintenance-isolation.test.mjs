import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStudioServer } from '../server/index.mjs'

function runIsolatedChild(t, { fromEnvironment = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-maintenance-isolation-'))
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = `
    import { createStudioServer } from ${JSON.stringify(pathToFileURL(resolve('server/index.mjs')).href)};
    import { existsSync } from 'node:fs';
    const server = createStudioServer({
      dbPath: ${JSON.stringify(fromEnvironment ? join(directory, 'isolated.sqlite') : ':memory:')},
      seed: false, password: 'isolated-maintenance-test-only-123',
      ...( ${fromEnvironment} ? {maintenanceFromEnv: true} : {})
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const result = { backupsEnabled: server.backups.metrics().enabled, backupMaxTotalBytes: server.backups.metrics().maxTotalBytes, backupMinFreeBytes: server.backups.metrics().minFreeBytes, cleanupEnabled: server.uploadCleanup.metrics().enabled, backupCompleted: server.backups.metrics().completed, cleanupNeverRun: server.uploadCleanup.metrics().lastRunAt === null, ambientDirectoryCreated: existsSync(${JSON.stringify(join(directory, 'ambient-backups'))}) };
    await new Promise(resolve => server.close(resolve));
    console.log(JSON.stringify(result));
  `
  // The child receives only OS path variables and invented test settings. It
  // never inherits or inspects the parent's real maintenance/push credentials.
  const environment = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    TMP: directory,
    TEMP: directory,
    STUDIO_BACKUP_DIR: join(directory, 'ambient-backups'),
    STUDIO_BACKUP_INTERVAL_MINUTES: fromEnvironment ? '60' : '1',
    STUDIO_BACKUP_RETENTION_COUNT: fromEnvironment ? '2' : '999',
    STUDIO_BACKUP_MAX_TOTAL_BYTES: fromEnvironment ? String(6 * 1024 ** 3) : 'invalid-capacity',
    STUDIO_BACKUP_MIN_FREE_BYTES: fromEnvironment ? String(8 * 1024 ** 3) : 'invalid-free-space',
    STUDIO_BACKUP_FAILURE_WEBHOOK: 'https://dummy.invalid/no-real-webhook',
    STUDIO_UPLOAD_GC_ENABLED: 'true',
    STUDIO_UPLOAD_GC_INTERVAL_MINUTES: fromEnvironment ? '60' : '0',
    STUDIO_UPLOAD_GC_RETENTION_DAYS: fromEnvironment ? '7' : '1',
    STUDIO_PUSH_PUBLIC_KEY: fromEnvironment ? '' : 'invalid-dummy-public-key',
    STUDIO_PUSH_PRIVATE_KEY: fromEnvironment ? '' : 'invalid-dummy-private-key',
    STUDIO_PUSH_SUBJECT: 'mailto:dummy@example.invalid',
    STUDIO_ADMIN_PASSWORD: 'must-not-be-used-test-only'
  }
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve('.'),
    env: environment,
    encoding: 'utf8',
    timeout: 15000
  })
  return JSON.parse(output.trim())
}

test('显式测试数据库忽略环境备份/回收/推送配置，畸形假密钥也不会读取或触发外发', (t) => {
  assert.deepEqual(runIsolatedChild(t), {
    backupsEnabled: false,
    backupMaxTotalBytes: 0,
    backupMinFreeBytes: 0,
    cleanupEnabled: false,
    backupCompleted: 0,
    cleanupNeverRun: true,
    ambientDirectoryCreated: false
  })
})

test('只有显式maintenanceFromEnv=true才接受计划配置，关闭服务器不执行待到期任务', (t) => {
  assert.deepEqual(runIsolatedChild(t, { fromEnvironment: true }), {
    backupsEnabled: true,
    backupMaxTotalBytes: 6 * 1024 ** 3,
    backupMinFreeBytes: 8 * 1024 ** 3,
    cleanupEnabled: true,
    backupCompleted: 0,
    cleanupNeverRun: true,
    ambientDirectoryCreated: false
  })
})

test('显式空白或无效数据库路径在打开数据库前拒绝，不能隐式回退到业务默认路径', () => {
  for (const dbPath of [undefined, null, '', '   ', false])
    assert.throws(
      () => createStudioServer({ dbPath, password: 'invalid-path-test-only' }),
      /测试不能回退到默认业务库/
    )
})
