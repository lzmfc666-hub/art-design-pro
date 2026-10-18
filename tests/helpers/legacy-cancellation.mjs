/** Explicit pre-upgrade fixture, never a compatibility adapter for current writes. */
export function legacyCancellationFixture(service, record, reason = '升级前取消记录') {
  if (service.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file)
    throw new Error('Legacy cancellation fixtures only accept in-memory test databases')
  const state = JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const row = state.orders.find(row => row.id === record.id)
  if (!row || row.status === 'canceled') throw new Error('Expected an uncanceled legacy fixture')
  Object.assign(row, { canceledFrom: row.status, rewardBeforeCancellation: row.reward,
    status: 'canceled', canceledAt: '2026-10-13T04:00:00Z', cancelReason: reason,
    compensationPending: row.assignments.length > 0, compensationSettled: row.assignments.length === 0 })
  if (!row.compensationPending) row.reward = 0
  row.revision++
  service.db.prepare('UPDATE studio_state SET json=? WHERE id=1').run(JSON.stringify(state))
  return service.orderDetail('admin', row.id).order
}
