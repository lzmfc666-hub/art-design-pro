import { computed } from 'vue'
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
