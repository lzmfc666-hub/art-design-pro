import type { Attachment } from './studio'

export type LotteryTier = 'special-small' | 'special-medium' | 'value-large' | 'ultimate-large'

export interface LotteryPrize {
  id: string
  title: string
  image: Attachment | null
  probability: string
}

export interface LotteryPool {
  tier: LotteryTier
  title: string
  revision: number
  configured: boolean
  prizes: LotteryPrize[]
}

export type LotteryCodeStatus = 'not-issued' | 'available' | 'drawn' | 'expired' | 'void'

export interface LotteryResult {
  prizeId: string
  title: string
  image: Attachment | null
  drawnAt: string
}

export interface LotteryOrderRecord {
  orderId: string
  orderNo: string
  tier: LotteryTier
  title: string
  status: LotteryCodeStatus
  createdAt: string | null
  expiresAt: string | null
  result: LotteryResult | null
}

export interface LotteryCodeResponse {
  code: string | null
  tier: LotteryTier
  status: LotteryCodeStatus
  createdAt: string | null
  expiresAt: string | null
  result: LotteryResult | null
}

export const lotteryTiers: { value: LotteryTier; label: string }[] = [
  { value: 'special-small', label: '特惠小转盘' },
  { value: 'special-medium', label: '特惠中转盘' },
  { value: 'value-large', label: '超值大转盘' },
  { value: 'ultimate-large', label: '终极大转盘' }
]

export const lotteryStatusLabels: Record<LotteryCodeStatus, string> = {
  'not-issued': '待首次接单发码',
  available: '待抽奖',
  drawn: '已抽奖',
  expired: '已过期',
  void: '已作废'
}
