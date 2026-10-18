import { studioRequest, uploadStudioImage } from './studio'
import { dailyPlayerOrderPage, isDailyPlayerOrder } from './orderPresentation'
import type { Attachment, Staff } from '@/types/studio'
import type {
  PlayerOrder,
  PlayerWallet,
  PlayerProfile,
  PlayerLeaderboard,
  PaymentMethod,
  PlayerNotifications,
  PlayerDeposit,
  PlayerOrderPage,
  PlayerOrderQuery,
  PlayerChanges,
  PlayerAppearance,
  PlayerOperationResult,
  PlayerRecordPage,
  PlayerRecordQuery,
  PlayerWithdrawal,
  PlayerLedger,
  PlayerDeviceBinding,
  PlayerNotification
} from '@/types/player'

function recordQuery(query: PlayerRecordQuery) {
  const params = new URLSearchParams({ current: String(query.current), size: String(query.size) })
  for (const key of ['status', 'kind', 'start', 'end'] as const) if (query[key]) params.set(key, query[key])
  return params
}

export interface DispatchOperation {
  requestId: string
  expectedRevision: number
  dispatchRound: number
}
export interface AssignmentOperation {
  requestId: string
  expectedRevision: number
  assignmentId: string
  leaderId: string
}

export const playerApi = {
  session: (signal?: AbortSignal) => studioRequest<{ user: Staff | null }>('session', undefined, 'GET', signal),
  login: (username: string, password: string) =>
    studioRequest<{ user: Staff }>('login', { username, password }, 'POST'),
  logout: () => studioRequest('logout', {}, 'POST'),
  profile: (signal?: AbortSignal) => studioRequest<PlayerProfile>('player/profile', undefined, 'GET', signal),
  appearance: (signal?: AbortSignal) => studioRequest<PlayerAppearance>('player/appearance', undefined, 'GET', signal),
  orders: async (signal?: AbortSignal) => (await studioRequest<PlayerOrder[]>('player/orders', undefined, 'GET', signal)).filter(isDailyPlayerOrder),
  ordersPage: async (query: PlayerOrderQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({ current: String(query.current), size: String(query.size), scope: query.scope })
    if (query.status) params.set('status', query.status)
    if (query.keyword) params.set('keyword', query.keyword)
    if (query.sortBy) params.set('sortBy', query.sortBy)
    if (query.sortOrder) params.set('sortOrder', query.sortOrder)
    return dailyPlayerOrderPage(await studioRequest<PlayerOrderPage>(`player/orders?${params}`, undefined, 'GET', signal))
  },
  changes: (since?: string | number, signal?: AbortSignal) =>
    studioRequest<PlayerChanges>(`player/changes${since === undefined ? '' : `?since=${encodeURIComponent(since)}`}`, undefined, 'GET', signal),
  operationResult: (requestId: string, family: PlayerOperationResult['family'], signal?: AbortSignal) =>
    studioRequest<PlayerOperationResult>(`player/operation-results/${encodeURIComponent(requestId)}?family=${encodeURIComponent(family)}`, undefined, 'GET', signal),
  order: (id: string, signal?: AbortSignal) => studioRequest<PlayerOrder>(`player/orders/${encodeURIComponent(id)}`, undefined, 'GET', signal),
  claim: (id: string, target: DispatchOperation, owner: string) => studioRequest(`player/orders/${encodeURIComponent(id)}/claim`, target, 'POST', undefined, { expectedActorId: owner }),
  reject: (id: string, reason: string, target: DispatchOperation, owner: string) =>
    studioRequest(`player/orders/${encodeURIComponent(id)}/reject`, { ...target, reason }, 'POST', undefined, { expectedActorId: owner }),
  returnOrder: (id: string, reason: string, target: AssignmentOperation, owner: string) =>
    studioRequest(`player/orders/${encodeURIComponent(id)}/return-request`, { ...target, reason }, 'POST', undefined, { expectedActorId: owner }),
  submit: (id: string, screenshots: Attachment[], teammateId: string | null, target: AssignmentOperation, owner: string) =>
    studioRequest(
      `player/orders/${encodeURIComponent(id)}/submit`,
      { ...target, screenshots, teammateId },
      'POST', undefined, { expectedActorId: owner }
    ),
  teammates: (signal?: AbortSignal) =>
    studioRequest<{ id: string; name: string; avatar?: Attachment | null }[]>('player/teammates', undefined, 'GET', signal),
  wallet: (signal?: AbortSignal) => studioRequest<PlayerWallet>('player/wallet?includeRecords=false', undefined, 'GET', signal),
  withdrawals: (query: PlayerRecordQuery, signal?: AbortSignal) =>
    studioRequest<PlayerRecordPage<PlayerWithdrawal>>(`player/withdrawals?${recordQuery(query)}`, undefined, 'GET', signal),
  ledger: (query: PlayerRecordQuery, signal?: AbortSignal) =>
    studioRequest<PlayerRecordPage<PlayerLedger>>(`player/wallet/ledger?${recordQuery(query)}`, undefined, 'GET', signal),
  withdraw: (amount: number, paymentMethod: string, requestId: string, owner: string) =>
    studioRequest('player/withdrawals', { amount, paymentMethod, requestId }, 'POST', undefined, { expectedActorId: owner }),
  cancelWithdrawal: (id: string, requestId: string, owner: string) =>
    studioRequest(`player/withdrawals/${encodeURIComponent(id)}/cancel`, { requestId }, 'POST', undefined, { expectedActorId: owner }),
  paymentMethods: (signal?: AbortSignal) => studioRequest<PaymentMethod[]>('player/payment-methods', undefined, 'GET', signal),
  savePayment: (method: string, qrCode: Attachment) =>
    studioRequest('player/payment-methods', { method, qrCode }, 'POST'),
  deposit: (id: string, signal?: AbortSignal) =>
    studioRequest<PlayerDeposit>(`players/${encodeURIComponent(id)}/deposit`, undefined, 'GET', signal),
  depositTransactions: (id: string, current = 1, signal?: AbortSignal) =>
    studioRequest<PlayerDeposit>(
      `players/${encodeURIComponent(id)}/deposit-transactions?current=${current}&size=30`, undefined, 'GET', signal
    ),
  leaderboard: (month: string, type: string, current = 1, signal?: AbortSignal) =>
    studioRequest<PlayerLeaderboard>(
      `player/leaderboard?month=${encodeURIComponent(month)}&type=${encodeURIComponent(type)}&current=${current}&size=100`, undefined, 'GET', signal
    ),
  updateProfile: (name: string, avatar?: Attachment | null) =>
    studioRequest<Staff>('profile', { name, ...(avatar === undefined ? {} : { avatar }) }, 'POST'),
  password: (currentPassword: string, newPassword: string) =>
    studioRequest('profile/password', { currentPassword, newPassword }, 'POST'),
  notifications: (current = 1, signal?: AbortSignal) =>
    studioRequest<PlayerNotifications>(`player/notifications?current=${current}&size=30`, undefined, 'GET', signal),
  notification: (id: string, signal?: AbortSignal) =>
    studioRequest<PlayerNotification>(`player/notifications/${encodeURIComponent(id)}`, undefined, 'GET', signal),
  readNotification: (id: string) =>
    studioRequest(`player/notifications/${encodeURIComponent(id)}/read`, {}, 'POST'),
  readAllNotifications: () => studioRequest('player/notifications/read-all', {}, 'POST'),
  settings: (signal?: AbortSignal) => studioRequest<{ pool: boolean; push: boolean }>('player/notification-settings', undefined, 'GET', signal),
  saveSettings: (pool: boolean, push: boolean) =>
    studioRequest('player/notification-settings', { pool, push }, 'POST'),
  pushConfig: (signal?: AbortSignal) =>
    studioRequest<{ enabled: boolean; publicKey: string; configured: boolean; reason: string }>(
      'player/push-config', undefined, 'GET', signal
    ),
  subscriptionStatus: (fingerprint: { endpointHash: string; subscriptionHash: string } | null, signal?: AbortSignal) =>
    studioRequest<PlayerDeviceBinding>(`player/push-subscriptions/status${fingerprint ? `?${new URLSearchParams(fingerprint)}` : ''}`, undefined, 'GET', signal),
  saveSubscription: (subscription: PushSubscriptionJSON) =>
    studioRequest('player/push-subscriptions', { subscription }, 'POST'),
  removeSubscription: (endpoint: string) =>
    studioRequest('player/push-subscriptions/remove', { endpoint }, 'POST'),
  testPush: () => studioRequest('player/push-subscriptions/test', {}, 'POST'),
  upload: uploadStudioImage
}
