export interface PlatformRules {
  requiresShop: boolean
  requiresExternalOrderNo: boolean
  requiresReceipt: boolean
  allowPayOnArrival: boolean
}

/** 旧来源缺少 rules 时沿用原下单要求；新来源由明确规则控制。 */
export function rulesForPlatform(
  platform?: { id?: string; rules?: Partial<PlatformRules> } | null
): PlatformRules {
  const defaults: PlatformRules = {
    requiresShop: platform?.id === 'xianyu',
    requiresExternalOrderNo: platform?.id === 'xianyu',
    requiresReceipt: platform?.id !== 'xianyu',
    allowPayOnArrival: platform?.id === 'hall'
  }
  for (const key of Object.keys(defaults) as (keyof PlatformRules)[]) {
    const value = platform?.rules?.[key]
    if (typeof value === 'boolean') defaults[key] = value
  }
  return defaults
}

export const platformRuleLabels: { key: keyof PlatformRules; label: string }[] = [
  { key: 'requiresShop', label: '下单必须选择店铺' },
  { key: 'requiresExternalOrderNo', label: '下单必须填写平台订单号' },
  { key: 'requiresReceipt', label: '确认收款必须上传付款凭证' },
  { key: 'allowPayOnArrival', label: '允许先发布、后补收款（落地付）' }
]
