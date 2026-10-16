import type { Attachment, Staff, OrderStatus, Submission, Wallet, FundTransaction } from './studio'

export interface PlayerAccount extends Staff {
  avatar?: Attachment | null
}
export interface PlayerReturnRequest {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'obsolete'
  reason: string
  requestedAt: string
  createdAt?: string
  processedAt?: string
  processReason?: string
  processingReason?: string
  responseReason?: string
}
export interface PlayerOrder {
  id: string
  orderNo: string
  title: string
  reward: number
  status: OrderStatus
  dispatchMode: 'pool' | 'direct'
  assignedTo: string | null
  leaderId: string | null
  teammateId?: string | null
  map?: string
  remark?: string
  requirements?: string
  playerRemark?: string
  revision?: number
  dispatchRound?: number
  assignmentId?: string | null
  submissionId?: string | null
  canSubmit?: boolean
  paymentConfirmed?: boolean
  claimBlockedReason?: { code: string; message: string } | null
  submitBlockedReason?: { code: string; message: string } | null
  roomCode?: string
  gameId?: string
  createdAt: string
  publishedAt: string
  completedAt?: string | null
  availableAt?: string
  claimEligible?: boolean
  canClaim?: boolean
  claimReason?: string
  submissions?: Submission[]
  returnRequests?: PlayerReturnRequest[]
  returnRequest?: PlayerReturnRequest | null
  dispatchState?: string
  rejections?: { id: string; playerId: string; reason: string; rejectedAt: string }[]
  participation?: 'current' | 'historical' | 'available'
  lastParticipationAt?: string | null
  historyOnly?: boolean
}
export interface PaymentMethod {
  method: 'wechat' | 'alipay'
  qrCode: Attachment
  updatedAt?: string
}
export interface PlayerWithdrawal {
  id: string
  amount: number
  status: 'pending' | 'approved' | 'paid' | 'rejected' | 'canceled'
  createdAt: string
  processedAt?: string
  paidAt?: string
  canceledAt?: string
  reason?: string
  paymentMethod?: 'wechat' | 'alipay'
  paymentSnapshot?: PaymentMethod
  receipt?: Attachment | null
}
export interface PlayerLedger {
  id: string
  kind: string
  amount?: number
  delta?: number
  createdAt: string
  reason?: string
  title?: string
  orderId?: string | null
  balanceAfter?: number
  manualAmount?: number
  status?: string
}
export interface PlayerWallet extends Wallet {
  withdrawals: PlayerWithdrawal[]
  ledger: PlayerLedger[]
  weeklyLimit: number
  weeklyUsed: number
  weeklyRemaining: number
  weekStart: string
  paymentMethods: PaymentMethod[]
}
export interface PlayerRecordPage<T> {
  records: T[]
  total: number
  current: number
  size: number
}
export interface PlayerRecordQuery {
  current: number
  size: number
  status?: string
  kind?: string
  start?: string
  end?: string
}
export interface PlayerDeviceBinding {
  configured: boolean
  status: 'valid' | 'unbound' | 'invalid' | 'unconfigured'
  pushEnabled: boolean
}
export interface PlayerProfile {
  user: PlayerAccount
  level: { id: string; name: string; delaySeconds: number } | null
  activeOrders: number
  maxActiveOrders: number
  paymentMethods: PaymentMethod[]
}
export interface PlayerOrderPage {
  records: PlayerOrder[]
  total: number
  current: number
  size: number
  counts: Record<string, number>
}
export interface PlayerOrderQuery {
  current: number
  size: number
  scope: 'all' | 'direct' | 'pool' | 'mine'
  status?: string
  keyword?: string
  sortBy?: 'createdAt' | 'participatedAt'
  sortOrder?: 'asc' | 'desc'
}
export interface PlayerChanges {
  version: string | number
  changed: boolean
  serverTime: string
  unreadCount: number
  activeOrders: number
  maxActiveOrders: number
  pendingAssignments: number
  appearanceRevision: number
}
export interface PlayerAppearance {
  revision: number
  orderCardImage: Attachment | null
}
export type PlayerOperationFamily = 'claim' | 'reject' | 'return' | 'submit' | 'withdraw' | 'cancel-withdrawal'
export interface PlayerOperationResult {
  requestId: string
  family: PlayerOperationFamily
  status: 'succeeded' | 'not-recorded'
  operationConfirmed: boolean
  result: 'confirmation-only'
  createdAt: string | null
  lateCommitPossible: boolean
  canCreateNew: false
  canRetryWithOriginal: boolean
  legacy?: boolean
}
export interface PlayerRank {
  userId: string
  name: string
  avatar?: Attachment | null
  rank: number
  orderCount?: number
  amount?: number
}
export interface PlayerLeaderboard {
  month: string
  type: 'orders' | 'withdrawals'
  records: PlayerRank[]
  total: number
  current: number
  size: number
  myRank: PlayerRank | null
  rankingRule: string
}
export interface PlayerNotification {
  id: string
  title: string
  message?: string
  body?: string
  createdAt: string
  readAt?: string | null
  invalidatedAt?: string | null
  link?: string
  href?: string
  orderId?: string | null
  kind?: string
  type?: string
  target?: { orderId: string; dispatchRound: number | null; assignmentId: string | null; submissionId: string | null } | null
}
export interface PlayerNotifications {
  records: PlayerNotification[]
  total: number
  unread: number
  current: number
  size: number
}
export interface PlayerDeposit {
  userId: string
  balance: number
  records: FundTransaction[]
  total: number
  current: number
  size: number
}
