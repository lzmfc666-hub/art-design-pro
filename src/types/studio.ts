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
}
export interface Customer {
  id: string
  createdAt?: string
  name: string
  contact: string
  gameId: string
  remark: string
}
export interface Platform {
  id: string
  name: string
  operatorCommission: boolean
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
  submittedAt: string
  leaderId: string
  teammateId: string | null
  screenshots: Attachment[]
  review?: string
  reason?: string
  reviewedAt?: string
  reviewerId?: string
}
export interface Assignment {
  leaderId: string
  acceptedAt: string
  releasedAt?: string
  reason?: string
}
export interface Order {
  id: string
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
  status: OrderStatus
  dispatchMode: 'pool' | 'direct'
  assignedTo: string | null
  leaderId: string | null
  teammateId: string | null
  creatorId: string
  createdAt: string
  publishedAt: string
  completedAt: string | null
  remark: string
  snapshot: OrderTemplate
  assignments: Assignment[]
  submissions: Submission[]
  canceledAt?: string
  cancelReason?: string
  canceledFrom?: OrderStatus
  compensationPending?: boolean
  compensationSettled?: boolean
  commissionSnapshot?: {
    supportRate: number | null
    operationsRate: number | null
    operationsId: string | null
  }
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
}
export interface Withdrawal {
  id: string
  userId: string
  amount: number
  status: 'pending' | 'approved' | 'paid' | 'rejected'
  createdAt: string
  processedAt?: string
  paidAt?: string
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
export interface Attendance {
  id: string
  userId: string
  date: string
  start: string
  end: string
  status: 'scheduled' | 'present' | 'leave' | 'absent'
  actualHours: number
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
export interface DayReport {
  date: string
  received: number
  refunds: number
  net: number
  reward: number
  supportCommission: number
  operationsCommission: number
  expenses: number
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
  demo: boolean
}
