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
