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
  personnel: 'ri:team-line',
  system: 'ri:settings-3-line',
  reports: 'ri:file-excel-2-line',
  createOrder: 'ri:add-box-line',
  orderList: 'ri:list-check-2',
  customers: 'ri:contacts-book-line',
  users: 'ri:user-settings-line',
  roles: 'ri:user-settings-line',
  business: 'ri:gamepad-line',
  appearance: 'ri:palette-line',
  logs: 'ri:history-line',
  attendance: 'ri:calendar-check-line',
  salary: 'ri:money-cny-circle-line',
  export: 'ri:download-2-line',
  profile: 'ri:user-line'
})

// 保留既有图标槽位，兼容旧版按路由路径保存的图标；显式槽位值优先。
export const APPEARANCE_ICON_ROUTE_ALIASES = Object.freeze({
  '/personnel/employees': 'users',
  '/personnel/customers': 'customers',
  '/personnel/players': 'personnel',
  '/system/user': 'users',
  '/orders/customers': 'customers',
  '/dashboard': 'dashboard',
  '/dashboard/console': 'dashboard',
  '/dashboard/analysis': 'dashboard',
  '/orders': 'orders',
  '/orders/create': 'createOrder',
  '/orders/list': 'orderList',
  '/finance': 'finance',
  '/finance/settlement': 'finance',
  '/finance/salary': 'salary',
  '/personnel': 'personnel',
  '/personnel/attendance': 'attendance',
  '/system': 'system',
  '/system/role': 'roles',
  '/system/menu': 'roles',
  '/system/business': 'business',
  '/system/appearance': 'appearance',
  '/system/logs': 'logs',
  '/system/user-center': 'profile',
  '/reports': 'reports',
  '/reports/export': 'export'
})
export function canonicalAppearanceIcons(value) {
  const result = Object.fromEntries(
    Object.entries(value || {}).filter(([key]) => Object.hasOwn(APPEARANCE_ICON_DEFAULTS, key))
  )
  for (const [path, key] of Object.entries(APPEARANCE_ICON_ROUTE_ALIASES)) {
    if (Object.hasOwn(value || {}, path) && !Object.hasOwn(result, key)) result[key] = value[path]
  }
  return result
}

export function defaultAppearance() {
  return {
    studioName: '电竞工作室',
    logo: null,
    page: { mode: 'default', color: '#f5f8fc', image: null, overlay: 50 },
    hero: { mode: 'default', color: '#80b7ff', image: null, overlay: 35, showDecoration: true },
    login: {
      title: '欢迎使用电竞工作室后台',
      subtitle: '统一管理订单、人员与财务',
      description: '账号由工作室管理员分配，忘记密码请联系管理员。',
      illustration: { mode: 'default', image: null },
      background: { mode: 'default', color: '#eef4ff', image: null, overlay: 50 }
    },
    glass: { enabled: false },
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
const plainText = (value, label, max, required = false) => {
  if (
    typeof value !== 'string' ||
    value.trim().length > max ||
    (required && !value.trim()) ||
    /[<>]/.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127
    })
  )
    throw new ApiError(`${label}须为${required ? '非空' : ''}纯文本，最多 ${max} 个字符`)
  return value.trim()
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
    'login',
    'glass',
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
  const defaults = defaultAppearance()
  const loginConfig = config.login === undefined ? defaults.login : config.login
  const glassConfig = config.glass === undefined ? defaults.glass : config.glass
  object(loginConfig, '登录页', ['title', 'subtitle', 'description', 'illustration', 'background'])
  const illustrationConfig =
    loginConfig.illustration === undefined ? defaults.login.illustration : loginConfig.illustration
  object(illustrationConfig, '登录左侧大图', ['mode', 'image'])
  if (!['default', 'image'].includes(illustrationConfig.mode))
    throw new ApiError('请选择默认或自定义登录左侧大图')
  object(loginConfig.background, '登录背景', ['mode', 'color', 'image', 'overlay'])
  object(glassConfig, '毛玻璃', ['enabled'])
  if (typeof glassConfig.enabled !== 'boolean') throw new ApiError('请选择是否启用毛玻璃效果')
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
  const login = {
    title: plainText(loginConfig.title, '登录标题', 80, true),
    subtitle: plainText(loginConfig.subtitle, '登录副标题', 200),
    description: plainText(loginConfig.description, '登录说明', 800),
    illustration: {
      mode: illustrationConfig.mode,
      image: image(illustrationConfig.image)
    },
    background: {
      mode: mode(loginConfig.background.mode),
      color: color(loginConfig.background.color),
      image: image(loginConfig.background.image),
      overlay: overlay(loginConfig.background.overlay, 90)
    }
  }
  if (typeof hero.showDecoration !== 'boolean') throw new ApiError('请选择是否显示首页装饰图形')
  if (login.illustration.mode === 'image' && !login.illustration.image)
    throw new ApiError('自定义登录左侧大图必须先上传图片')
  if (
    (page.mode === 'image' && !page.image) ||
    (hero.mode === 'image' && !hero.image) ||
    (login.background.mode === 'image' && !login.background.image)
  )
    throw new ApiError('图片背景必须先上传图片')
  object(config.icons, '图标', [
    ...Object.keys(APPEARANCE_ICON_DEFAULTS),
    ...Object.keys(APPEARANCE_ICON_ROUTE_ALIASES)
  ])
  for (const value of Object.values(config.icons)) {
    if (
      typeof value !== 'string' ||
      value.length > 64 ||
      !/^ri:[a-z0-9-]+$/.test(value) ||
      !APPEARANCE_ICON_OPTIONS.includes(value)
    )
      throw new ApiError('图标须为受支持的 ri: 图标名称')
  }
  const icons = canonicalAppearanceIcons(config.icons)
  return {
    studioName: config.studioName.trim(),
    logo: image(config.logo),
    page,
    hero,
    login,
    glass: { enabled: glassConfig.enabled },
    icons
  }
}

export function appearanceAttachments(config, { activeOnly = false } = {}) {
  return [
    config?.logo,
    !activeOnly || config?.page?.mode === 'image' ? config?.page?.image : null,
    !activeOnly || config?.hero?.mode === 'image' ? config?.hero?.image : null,
    !activeOnly || config?.login?.background?.mode === 'image'
      ? config?.login?.background?.image
      : null,
    !activeOnly || config?.login?.illustration?.mode === 'image'
      ? config?.login?.illustration?.image
      : null
  ].filter(Boolean)
}

/** 匿名图片只允许当前保存的公开品牌与正在使用的登录图片。 */
export function publicAppearanceAttachments(config) {
  return [
    config?.logo,
    config?.login?.background?.mode === 'image' ? config.login.background.image : null,
    config?.login?.illustration?.mode === 'image' ? config.login.illustration.image : null
  ].filter(Boolean)
}

/** 不携带后台页面、首页、菜单图标、版本或管理员信息。 */
export function projectPublicAppearance(config) {
  const normalized = projectAppearanceAudit(config) || defaultAppearance()
  const publicImage = (attachment) =>
    attachment ? { ...attachment, url: `/api/studio/public-assets/${attachment.id}` } : null
  return {
    studioName: normalized.studioName,
    logo: publicImage(normalized.logo),
    login: {
      title: normalized.login.title,
      subtitle: normalized.login.subtitle,
      description: normalized.login.description,
      illustration: {
        mode: normalized.login.illustration.mode,
        image:
          normalized.login.illustration.mode === 'image'
            ? publicImage(normalized.login.illustration.image)
            : null
      },
      background: {
        ...normalized.login.background,
        image:
          normalized.login.background.mode === 'image'
            ? publicImage(normalized.login.background.image)
            : null
      }
    },
    glass: { enabled: normalized.glass.enabled }
  }
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
