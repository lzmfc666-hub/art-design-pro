import { computed, type CSSProperties } from 'vue'
import type { AppearanceBackground } from '@/types/appearance'
import { useAppearanceStore } from '@/store/modules/appearance'
import { APPEARANCE_ICON_OPTIONS } from '@/types/appearance'

export function useAppearance() {
  const store = useAppearanceStore()
  const config = computed(() => store.effective)
  const icon = (key: string | undefined, fallback: string) => {
    const value = key ? config.value.icons[key] : undefined
    return value && (APPEARANCE_ICON_OPTIONS as readonly string[]).includes(value)
      ? value
      : fallback
  }
  return { config, icon }
}

/** 仅使用本服务的图片附件，不接受任意 URL、HTML 或 CSS 字符串。 */
export function appearanceBackgroundStyle(background: AppearanceBackground): CSSProperties {
  if (background.mode === 'default') return {}
  if (background.mode === 'color')
    return /^#[0-9a-fA-F]{6}$/.test(background.color) ? { background: background.color } : {}
  const url = background.image?.url
  if (!url || !/^\/api\/studio\/(?:uploads|public-assets)\/[A-Za-z0-9_-]+$/.test(url)) return {}
  const opacity = Math.max(0, Math.min(90, background.overlay)) / 100
  return {
    backgroundColor: 'var(--default-bg-color)',
    backgroundImage: `linear-gradient(var(--appearance-veil),var(--appearance-veil)),url("${url}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    '--appearance-veil': `rgba(255,255,255,${opacity})`,
    '--appearance-dark-veil': `rgba(15,23,42,${opacity})`
  }
}

/** 自定义纯色不随深浅主题变化，展示区文字按实际背景选择可读颜色。 */
export function appearanceBackgroundTextStyle(background: AppearanceBackground): CSSProperties {
  if (background.mode !== 'color' || !/^#[0-9a-fA-F]{6}$/.test(background.color)) return {}
  const luminanceOf = (color: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const luminance = luminanceOf(background.color)
  const fallback = luminance > 0.179 ? '#000000' : '#ffffff'
  const readable = (color: string) => {
    const foreground = luminanceOf(color)
    const contrast =
      (Math.max(luminance, foreground) + 0.05) / (Math.min(luminance, foreground) + 0.05)
    return contrast >= 4.5 ? color : fallback
  }
  return {
    '--appearance-background-text': readable(luminance > 0.179 ? '#111827' : '#f8fafc'),
    '--appearance-background-muted-text': readable(luminance > 0.179 ? '#374151' : '#e2e8f0')
  }
}
