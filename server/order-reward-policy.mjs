/** A closure decision is permanent; later manual supplements never revive the original quote. */
export const REWARD_POLICY_VERSION = 1
export const effectiveOrderReward = order =>
  order.rewardDisposition?.policyVersion === REWARD_POLICY_VERSION && order.rewardDisposition.mode === 'zero-unsettled'
    ? 0 : order.reward

export function hasOrderSettlementHistory(state, order) {
  return Boolean(
    order.status === 'completed' || order.completedAt || order.canceledFrom === 'completed' ||
    (order.compensationSettled && order.assignments?.length) ||
    Object.hasOwn(state.statusCorrectionReversals || {}, order.id) ||
    ['rewardCredits', 'playerRewardLedger', 'playerAdjustments', 'rewardReviews'].some(key =>
      (state[key] || []).some(row => row.orderId === order.id))
  )
}

export function decideOrderReward(state, order, { trigger, decidedAt, decidedBy }) {
  if (order.rewardDisposition) return order.rewardDisposition
  order.rewardDisposition = {
    mode: hasOrderSettlementHistory(state, order) ? 'preserve-settled' : 'zero-unsettled',
    trigger, policyVersion: REWARD_POLICY_VERSION, decidedAt, decidedBy
  }
  return order.rewardDisposition
}
