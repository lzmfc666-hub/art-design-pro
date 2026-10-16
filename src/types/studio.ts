import type { AppearanceConfig } from './appearance'

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
export interface Staff {
  id: string
  createdAt?: string
  username: string
  name: string
  role: Role
  status: 'active' | 'disabled'
  levelId?: string
  maxActiveOrders: number
  permissionOverrides: Record<string, boolean>
  activeOrders?: number
  pendingAssignments?: number
  playerAccess?: PlayerAccess
}
export interface PlayerAccess {
  login: boolean
  claim: boolean
  withdraw: boolean
}
export interface Customer {
  id: string
  createdAt?: string
  name: string
  contact: string
  gameId: string
  remark: string
  platformId?: string | null
  orderReferences?: CustomerOrderReference[]
  orderReferenceCount?: number
  balance?: number
}
export interface CustomerOrderReference {
  id: string
  customerId: string
  platformId: string
  shopId: string | null
  externalOrderNo: string
}
export interface PlatformRules {
  requiresShop: boolean
  requiresExternalOrderNo: boolean
  requiresReceipt: boolean
  allowPayOnArrival: boolean
}
export interface Platform {
  id: string
  name: string
  operatorCommission?: boolean
  rules?: PlatformRules
}
export interface Shop {
  id: string
  platformId: string
  name: string
}
export interface Level {
  id: string
  name: string
  delaySeconds: number
}
export interface OrderTemplate {
  id: string
  name: string
  game: string
  description: string
  amount: number | null
  reward: number | null
  map: string
  remark: string
  active: boolean
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
  assignmentId: string | null
  dispatchRound: number
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
export interface Assignment {
  id: string
  dispatchRound: number
  leaderId: string
  acceptedAt: string
  releasedAt?: string
  reason?: string
}
export interface OrderReturnRequest {
  id: string
  assignmentId: string
  dispatchRound: number
  leaderId: string
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'obsolete'
  requestedAt: string
  processedAt?: string
  processedBy?: string
  processReason?: string
}
export interface OrderAssignmentRejection {
  id: string
  dispatchRound: number
  playerId: string
  reason: string
  rejectedAt: string
}
export interface PlayerPaymentSnapshot {
  method: 'wechat' | 'alipay'
  qrCode: Attachment
  updatedAt: string
}
export interface Order {
  id: string
  revision: number
  dispatchRound: number
  assignmentId: string | null
  submissionId: string | null
  orderNo: string
  templateId: string
  title: string
  customerId: string
  platformId: string
  shopId: string | null
  externalOrderNo: string
  channel: string
  roomCode: string
  gameId: string
  map: string
  amount: number
  reward: number
  receivedAmount: number
  paidAt: string | null
  receivedAt: string | null
  receipt: Attachment | null
  paymentMethod?: 'cash' | 'balance'
  balanceTransactionId?: string
  balanceCustomerId?: string
  status: OrderStatus
  dispatchMode: 'pool' | 'direct'
  dispatchState?: 'ready' | 'unassigned'
  assignedTo: string | null
  assignedAt?: string
  leaderId: string | null
  teammateId: string | null
  creatorId: string
  createdAt: string
  publishedAt: string
  completedAt: string | null
  remark: string
  playerRemark: string
  paymentConfirmed?: boolean
  canClaim?: boolean
  canSubmit?: boolean
  claimBlockedReason?: { code: string; message: string } | null
  submitBlockedReason?: { code: string; message: string } | null
  snapshot: OrderTemplate
  assignments: Assignment[]
  submissions: Submission[]
  returnRequests?: OrderReturnRequest[]
  rejections?: OrderAssignmentRejection[]
  canceledAt?: string
  cancelReason?: string
  canceledFrom?: OrderStatus
  rewardBeforeCancellation?: number
  compensationPending?: boolean
  compensationSettled?: boolean
  commissionSnapshot?: {
    supportRate: number | null
    operationsRate: number | null
    operationsId: string | null
  }
}
export interface OrderPage {
  records: Order[]
  total: number
  current: number
  size: number
  counts?: Record<string, number>
}
export interface OrderDetailResponse {
  order: Order
  refunds?: Refund[]
  logs?: AuditLog[]
}
export interface OrderExpectedState {
  expectedRevision: number
  dispatchRound: number
  assignmentId: string | null
  submissionId: string | null
  leaderId: string | null
}
export type OrderDispatchTarget = Pick<
  Staff,
  | 'id'
  | 'name'
  | 'status'
  | 'levelId'
  | 'maxActiveOrders'
  | 'activeOrders'
  | 'pendingAssignments'
  | 'playerAccess'
>
export interface StudioChangesSummary {
  version: string
  changed: boolean
  serverTime: string
  orderCounts: Record<string, number>
}
export interface Refund {
  id: string
  orderId: string
  amount: number
  reason: string
  status: 'pending' | 'paid' | 'rejected'
  requestedBy: string
  createdAt: string
  processedAt?: string
  processedBy?: string
  manualRewardReview?: boolean
  manualResolution?: string
  requestId?: string
  refundMethod?: 'cash' | 'balance'
  balanceTransactionId?: string
}
export interface Withdrawal {
  id: string
  userId: string
  amount: number
  status: 'pending' | 'approved' | 'paid' | 'rejected' | 'canceled'
  createdAt: string
  processedAt?: string
  processedBy?: string
  canceledAt?: string
  paidAt?: string
  paymentMethod?: 'wechat' | 'alipay'
  paymentSnapshot?: PlayerPaymentSnapshot
  weekStart?: string
  requestId?: string
  reason?: string
  receipt?: Attachment | null
}
export interface Expense {
  id: string
  category: string
  amount: number
  date: string
  purpose: string
  receipt: Attachment | null
  createdBy: string
  deletedAt?: string | null
}
export interface WorkSchedule {
  id: string
  userId: string
  effectiveFrom: string
  enabled: boolean
  start: string
  end: string
  remark: string
  updatedAt: string
  updatedBy: string
}
export interface Attendance {
  id: string
  userId: string
  date: string
  start: string
  end: string
  status: 'scheduled' | 'present' | 'normal' | 'rest' | 'leave' | 'absent'
  actualHours: number
  hoursRegistered?: boolean
  remark: string
}
export interface SalaryPlan {
  id: string
  userId: string
  mode: 'base_commission' | 'commission' | 'fixed'
  base: number | null
  rate: number | null
  platformRates: Record<string, number | null>
  effectiveFrom: string
  hourlyEnabled: boolean
}
export interface PayrollLine {
  userId: string
  name: string
  role: Role
  base: number | null
  commission: number | null
  deduction: number
  total: number | null
  incomplete: boolean
}
export interface Payroll {
  id: string
  month: string
  status: 'paid'
  lines: PayrollLine[]
  paidAt: string
  paidBy: string
}
export interface AuditLog {
  id: string
  actorId: string
  actorName: string
  action: string
  entity: string
  entityId: string
  before: unknown
  after: unknown
  createdAt: string
}
export type DiagnosticsStatus = 'ok' | 'warning' | 'error'
export interface DiagnosticsIssue {
  id: string
  checkId: string
  severity: 'error' | 'warning'
  entity: string
  entityId: string | null
  message: string
}
export interface DiagnosticsCheck {
  id: string
  label: string
  status: DiagnosticsStatus
  checkedRecords: number
  errorCount: number
  warningCount: number
  description: string
}
export interface DiagnosticsReport {
  generatedAt: string
  readOnly: true
  status: DiagnosticsStatus
  summary: {
    checkedRecords: number
    errorCount: number
    warningCount: number
    issueCount: number
    returnedIssues: number
    truncated: boolean
  }
  checks: DiagnosticsCheck[]
  issues: DiagnosticsIssue[]
  scopeNotes: string[]
}
export interface DayReport {
  date: string
  received: number
  refunds: number
  net: number
  reward: number
  supportCommission: number
  operationsCommission: number
  expenses: number
  otherIncome: number
  profit: number | null
  incomplete: boolean
  estimatedReward: number
}
export interface ChannelReport {
  platformId: string
  shopId?: string | null
  name: string
  orders: number
  received: number
  refunds: number
  net: number
}
export interface Performance {
  userId: string
  name: string
  orders: number
  completed: number
  net: number
}
export interface Wallet {
  userId: string
  earned: number
  occupied: number
  paid: number
  available: number
}
export interface PlayerAdjustment {
  id: string
  userId: string
  orderId: string | null
  kind: 'deduction' | 'supplement'
  amount: number
  appliedAmount: number
  manualAmount: number
  status: 'applied' | 'manual' | 'resolved'
  createdAt: string
  createdBy: string
  reason: string
  source?: 'manual' | 'status-correction'
  resolution?: 'recovered' | 'waived'
  resolvedAt?: string
  resolvedBy?: string
  resolutionReason?: string
}
export interface CustomerBalanceAccount {
  customerId: string
  balance: number
}
export interface PlayerDepositAccount {
  userId: string
  balance: number
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
export interface PlayerListRecord extends Omit<Staff, 'permissionOverrides'> {
  playerAccess: PlayerAccess
  wallet?: Wallet
  depositBalance?: number
}
export interface RewardReview {
  id: string
  orderId: string
  expectedReward: number
  reason: string
  createdAt: string
  actorId: string
  resolvedAt?: string
  resolvedBy?: string
  resolution?: string
}
export interface StudioData {
  appearance?: AppearanceConfig
  user: Staff
  permissions: string[]
  roleDefaults: Record<Role, string[]>
  users: Staff[]
  customers: Customer[]
  platforms: Platform[]
  shops: Shop[]
  levels: Level[]
  templates: OrderTemplate[]
  orders: Order[]
  refunds: Refund[]
  withdrawals: Withdrawal[]
  expenses: Expense[]
  attendance: Attendance[]
  workSchedules?: WorkSchedule[]
  salaryPlans: SalaryPlan[]
  payrolls: Payroll[]
  logs: AuditLog[]
  reports: {
    days: DayReport[]
    channels: ChannelReport[]
    performance: Performance[]
    payroll: PayrollLine[]
    month: string
    monthlyBase: number | null
    monthlyProfit: number | null
  }
  wallets: Wallet[]
  customerBalances?: CustomerBalanceAccount[]
  playerDeposits?: PlayerDepositAccount[]
  customerTransactions?: FundTransaction[]
  playerDepositTransactions?: FundTransaction[]
  playerAdjustments?: PlayerAdjustment[]
  rewardReviews?: RewardReview[]
  demo: boolean
}
