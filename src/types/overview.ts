export interface OverviewRange {
  start: string
  end: string
  days: number
}

/** 金额为整数分；无权查看、历史未知或配置未齐的值使用 null。 */
export interface OverviewMetrics {
  received: number | null
  refunds: number | null
  net: number | null
  orderCount: number | null
  createdOrders: number | null
  completedOrders: number | null
  canceledOrders: number | null
  payingCustomers: number | null
  repeatCustomers: number | null
  customerRepeatRate: number | null
  averageOrderAmount: number | null
  estimatedReward: number | null
  reward: number | null
  expenses: number | null
  otherIncome: number | null
  supportCommission: number | null
  operationsCommission: number | null
  periodOperatingProfit: number | null
  fullMonthsProfit: number | null
  monthlyBase: number | null
  profitIncomplete: number | null
  playerAvailable: number | null
  playerOccupied: number | null
  playerPaid: number | null
  playerAccepted: number | null
  playerAcceptedOrders: number | null
  playerCompletedOrders: number | null
  playerUnique: number | null
  playerCompletionRate: number | null
  staffCount: number | null
  playerCount: number | null
  newStaff: number | null
  newPlayers: number | null
  newCustomers: number | null
  personalNet: number | null
  personalCompletedOrders: number | null
  salaryPending?: number | null
  salaryPaid?: number | null
  salaryIncompleteCount?: number | null
}

export interface OverviewDay {
  date: string
  received: number | null
  refunds: number | null
  net: number | null
  otherIncome: number | null
  orders: number | null
  createdOrders: number | null
  completedOrders: number | null
  canceledOrders: number | null
  payingCustomers: number | null
  profit: number | null
  accepted: number | null
  expenses: number | null
  personalNet: number | null
  personalCompletedOrders: number | null
}

export interface OverviewReport {
  range: OverviewRange
  comparisonRange: OverviewRange
  generatedAt: string
  permissions: string[]
  metrics: OverviewMetrics
  comparison: OverviewMetrics
  changes: Partial<Record<keyof OverviewMetrics, number | null>>
  series: OverviewDay[]
  scopeNotes: string[]
  creationDateCoverage: Record<
    'staff' | 'players' | 'customers',
    { known: number; unknown: number; inRange: number }
  >
}
