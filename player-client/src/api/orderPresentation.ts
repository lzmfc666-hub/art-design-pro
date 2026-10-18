import type { PlayerOrder, PlayerOrderPage } from '@/types/player'

/** Settlement decisions belong to the server. Older projections keep their original reward. */
export function effectiveOrderReward(order: Readonly<PlayerOrder>) {
  return Number.isSafeInteger(order.effectiveReward) && order.effectiveReward! >= 0
    ? order.effectiveReward!
    : order.reward
}

/** A refund display label can mask cancellation, so always use the raw fulfillment status. */
export function isDailyPlayerOrder(order: Readonly<PlayerOrder>) {
  return order.status !== 'canceled'
}

/** Defensive handling for old/mixed responses; the server owns counts across other pages. */
export function dailyPlayerOrderPage(page: PlayerOrderPage): PlayerOrderPage {
  const removed = page.records.filter((order) => !isDailyPlayerOrder(order))
  const records = page.records.filter(isDailyPlayerOrder)
  const counts: Record<string, number> = { ...page.counts, canceled: 0 }
  if (typeof counts.all === 'number') counts.all = Math.max(0, counts.all - removed.length)
  for (const order of removed) {
    const status = order.displayStatus || order.status
    if (status !== 'canceled' && typeof counts[status] === 'number')
      counts[status] = Math.max(0, counts[status]! - 1)
    if (order.problem?.status === 'open' && typeof counts.problem === 'number')
      counts.problem = Math.max(0, counts.problem - 1)
  }
  return { ...page, records, counts, total: Math.max(records.length, page.total - removed.length) }
}
