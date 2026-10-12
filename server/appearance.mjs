import { ApiError } from './studio.mjs'

// 与前端 src/types/appearance.ts 的可选图标保持一致，避免查询不存在的图标资源。
export const APPEARANCE_ICON_OPTIONS = Object.freeze([
  'ri:pie-chart-line',
  'ri:dashboard-line',
  'ri:home-smile-2-line',
  'ri:file-list-3-line',
  'ri:list-check-2',
  'ri:add-box-line',
  'ri:wallet-3-line',
  'ri:money-cny-circle-line',
  'ri:funds-line',
  'ri:calendar-check-line',
  'ri:team-line',
  'ri:group-line',
  'ri:user-settings-line',
  'ri:contacts-book-line',
  'ri:settings-3-line',
  'ri:palette-line',
  'ri:gamepad-line',
  'ri:history-line',
  'ri:file-excel-2-line',
  'ri:download-2-line',
  'ri:user-line',
  'ri:shield-check-line',
  'ri:star-line',
  'ri:customer-service-2-line'
])

export const APPEARANCE_ICON_DEFAULTS = Object.freeze({
  dashboard: 'ri:pie-chart-line',
  orders: 'ri:file-list-3-line',
  finance: 'ri:wallet-3-line',
  personnel: 'ri:calendar-check-line',
  system: 'ri:settings-3-line',
  reports: 'ri:file-excel-2-line',
  createOrder: 'ri:add-box-line',
  orderList: 'ri:list-check-2',
  customers: 'ri:contacts-book-line',
  users: 'ri:team-line',
  roles: 'ri:user-settings-line',
  business: 'ri:gamepad-line',
  appearance: 'ri:palette-line',
  logs: 'ri:history-line',
  attendance: 'ri:calendar-check-line',
  salary: 'ri:money-cny-circle-line',
  export: 'ri:download-2-line',
  profile: 'ri:user-line'
})

export function defaultAppearance() {
  return {
    studioName: '电竞工作室',
    logo: null,
    page: { mode: 'default', color: '#f5f8fc', image: null, overlay: 50 },
    hero: { mode: 'default', color: '#80b7ff', image: null, overlay: 35, showDecoration: true },
    icons: {},
    revision: 0
  }
}

const object = (value, label, keys) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ApiError(`${label}配置无效`)
  return value
}
const color = (value) => {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))
    throw new ApiError('背景颜色须为 #rrggbb')
  return value.toLowerCase()
}
const mode = (value) => {
  if (!['default', 'color', 'image'].includes(value))
    throw new ApiError('请选择默认、纯色或图片背景')
  return value
}
const overlay = (value, max) => {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new ApiError(`背景遮罩须为 0 至 ${max} 的整数`)
  return value
}

export function validateAppearanceRevision(value, current) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError('外观配置版本无效')
  if (value !== current) throw new ApiError('外观配置已被其他人更新，请重新加载后再保存', 409)
  if (current >= Number.MAX_SAFE_INTEGER) throw new ApiError('外观配置版本已达上限', 409)
}

/** attachmentResolver 必须根据真实上传记录校验归属，并返回规范化的服务器附件信息。 */
export function normalizeAppearance(config, attachmentResolver) {
  object(config, '外观', [
    'studioName',
    'logo',
    'page',
    'hero',
    'icons',
    'revision',
    'updatedAt',
    'updatedBy'
  ])
  if (
    typeof config.studioName !== 'string' ||
    !config.studioName.trim() ||
    config.studioName.trim().length > 40 ||
    /[<>]/.test(config.studioName) ||
    config.studioName.split('').some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    throw new ApiError('工作室名称须为 1 至 40 个字符，不含 HTML 或控制字符')
  object(config.page, '页面背景', ['mode', 'color', 'image', 'overlay'])
  object(config.hero, '首页背景', ['mode', 'color', 'image', 'overlay', 'showDecoration'])
  const image = (value) => {
    if (value == null) return null
    object(value, '图片附件', ['id', 'name', 'mime', 'size', 'url'])
    if (typeof value.id !== 'string' || !value.id || value.id.length > 128)
      throw new ApiError('图片附件 ID 无效')
    return attachmentResolver(value)
  }
  const page = {
    mode: mode(config.page.mode),
    color: color(config.page.color),
    image: image(config.page.image),
    overlay: overlay(config.page.overlay, 90)
  }
  const hero = {
    mode: mode(config.hero.mode),
    color: color(config.hero.color),
    image: image(config.hero.image),
    overlay: overlay(config.hero.overlay, 70),
    showDecoration: config.hero.showDecoration
  }
  if (typeof hero.showDecoration !== 'boolean') throw new ApiError('请选择是否显示首页装饰图形')
  if ((page.mode === 'image' && !page.image) || (hero.mode === 'image' && !hero.image))
    throw new ApiError('图片背景必须先上传图片')
  object(config.icons, '图标', Object.keys(APPEARANCE_ICON_DEFAULTS))
  const icons = {}
  for (const [key, value] of Object.entries(config.icons)) {
    if (
      typeof value !== 'string' ||
      value.length > 64 ||
      !/^ri:[a-z0-9-]+$/.test(value) ||
      !APPEARANCE_ICON_OPTIONS.includes(value)
    )
      throw new ApiError('图标须为受支持的 ri: 图标名称')
    icons[key] = value
  }
  return { studioName: config.studioName.trim(), logo: image(config.logo), page, hero, icons }
}

export function appearanceAttachments(config, { activeOnly = false } = {}) {
  return [
    config?.logo,
    !activeOnly || config?.page?.mode === 'image' ? config?.page?.image : null,
    !activeOnly || config?.hero?.mode === 'image' ? config?.hero?.image : null
  ].filter(Boolean)
}

/** 对存储的外观审计记录白名单投影，不接受任意 CSS、HTML 或未知历史字段。 */
export function projectAppearanceAudit(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  try {
    const value = normalizeAppearance(config, (attachment) => {
      if (
        typeof attachment.mime !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mime) ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size <= 0 ||
        attachment.size > 8 * 1024 * 1024 ||
        attachment.url !== `/api/studio/uploads/${attachment.id}`
      )
        throw new ApiError('审计附件无效')
      return {
        id: attachment.id,
        name: String(attachment.name || ''),
        mime: attachment.mime,
        size: attachment.size,
        url: attachment.url
      }
    })
    return {
      ...value,
      revision: Number.isSafeInteger(config.revision) ? config.revision : 0,
      ...(typeof config.updatedAt === 'string' ? { updatedAt: config.updatedAt } : {}),
      ...(typeof config.updatedBy === 'string' ? { updatedBy: config.updatedBy } : {})
    }
  } catch {
    return null
  }
}
