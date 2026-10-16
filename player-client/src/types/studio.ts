/** Independent snapshots of the backend wire contract, restricted to player business data. */
export type Role =
  | 'owner'
  | 'manager'
  | 'finance'
  | 'hr'
  | 'operations'
  | 'support_lead'
  | 'support'
  | 'admin'
  | 'super_admin'
  | 'player'
export type OrderStatus = 'pending' | 'active' | 'review' | 'completed' | 'canceled'
export interface PlayerAccess {
  login: boolean
  claim: boolean
  withdraw: boolean
}
export interface Staff {
  id: string
  username: string
  name: string
  role: Role
  status: 'active' | 'disabled'
  maxActiveOrders: number
  levelId?: string
  activeOrders?: number
  playerAccess?: PlayerAccess
  avatar?: Attachment | null
}
export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  url: string
}
export interface Submission {
  id: string
  submittedAt: string
  leaderId: string
  teammateId: string | null
  screenshots: Attachment[]
  review?: string
  reason?: string
  reviewedAt?: string
  reviewerId?: string
  recheckBy?: string
  recheckedAt?: string
  recheckReason?: string
  previousSubmissionId?: string
  source?: 'status-correction'
  correctedBy?: string
  correctionReason?: string
}
export interface Wallet {
  userId: string
  earned: number
  occupied: number
  paid: number
  available: number
}
export interface FundTransaction {
  id: string
  accountId: string
  kind:
    | 'recharge'
    | 'deduction'
    | 'return'
    | 'order-payment'
    | 'order-refund'
    | 'deposit'
    | 'penalty'
  amount: number
  delta: number
  balanceAfter: number
  reason: string
  receipt: Attachment | null
  orderId: string | null
  createdAt: string
  createdBy: string
  createdByName: string
  requestId: string
  exitType: 'leave' | 'absconded' | null
}
