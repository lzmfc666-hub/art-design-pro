import { ApiError } from './studio.mjs'

export function platformRules(platform) {
  const xianyu = platform?.id === 'xianyu' || platform?.name === '闲鱼'
  const hall = platform?.id === 'hall' || platform?.name === '游戏大厅'
  return {
    requiresShop: xianyu,
    requiresExternalOrderNo: xianyu,
    requiresReceipt: !xianyu,
    allowPayOnArrival: hall,
    ...(platform?.rules || {})
  }
}
export function normalizePlatformRules(value, fallback) {
  if (value == null) return platformRules(fallback)
  const keys = ['requiresShop', 'requiresExternalOrderNo', 'requiresReceipt', 'allowPayOnArrival']
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof value[key] !== 'boolean')
  )
    throw new ApiError('平台规则应包含四项有效的开关配置')
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}
