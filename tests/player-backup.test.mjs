import { testMutate } from './helpers/current-intent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStudioServer } from '../server/index.mjs'
import { backupStudioDatabase } from '../scripts/studio-backup.mjs'
import { withdrawalBody } from './player-test-helpers.mjs'

test('SQLite备份恢复保留金额、收款码BLOB、提现快照、消息和审计，并拒绝覆盖旧备份', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'player-backup-'))
  const sourcePath = join(directory, 'source.sqlite'),
    target = join(directory, 'backup.sqlite')
  const source = createStudioServer({
    dbPath: sourcePath,
    password: 'backup-test-only-123',
    seed: false
  })
  let recovered
  t.after(async () => {
    if (source.service.db.isOpen) await new Promise((resolve) => source.close(resolve))
    if (recovered?.service.db.isOpen) await new Promise((resolve) => recovered.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  })
  const mutate = (path, body, actor = 'admin') => testMutate(source.service, actor, path, body)
  const level = mutate('/levels', { name: '备份等级', delaySeconds: 0 })
  const player = mutate('/users', {
    username: 'backup-player',
    name: '备份验证',
    role: 'player',
    status: 'active',
    levelId: level.id,
    maxActiveOrders: 1,
    permissionOverrides: {},
    password: 'backup-test-only-123'
  })
  mutate('/player-adjustments', {
    userId: player.id,
    kind: 'supplement',
    amount: 1001,
    reason: '备份测试'
  })
  const withdrawal = mutate(
    '/player/withdrawals',
    withdrawalBody(source.service, player.id, 100),
    player.id
  )
  mutate(`/withdrawals/${withdrawal.id}/action`, { action: 'approve' })
  mutate('/player/notification-settings', { pool: true, push: false }, player.id)
  await backupStudioDatabase(sourcePath, target)
  await assert.rejects(() => backupStudioDatabase(sourcePath, target), /已存在/)
  recovered = createStudioServer({ dbPath: target, seed: false })
  const wallet = recovered.service.playerWallet(player.id)
  assert.equal(wallet.available, 901)
  assert.equal(wallet.occupied, 100)
  assert.equal(
    wallet.withdrawals[0].paymentSnapshot.qrCode.id,
    withdrawal.paymentSnapshot.qrCode.id
  )
  assert.equal(
    recovered.service.download(player.id, wallet.withdrawals[0].paymentSnapshot.qrCode.id).data
      .length > 0,
    true
  )
  assert.deepEqual(recovered.notifications.settings(player.id), { pool: true, push: false })
  assert.equal(recovered.notifications.list(player.id).total, 1)
  assert.equal(
    recovered.service.bootstrap('admin').logs.some((row) => row.entityId === withdrawal.id),
    true
  )
  assert.equal(JSON.parse(readFileSync(`${target}.json`, 'utf8')).integrity, 'ok')
})
