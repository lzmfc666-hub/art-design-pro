import { computed, ref, toRaw } from 'vue'
import { defineStore } from 'pinia'
import { studioRequest } from '@/api/studio'
import { useStudioStore } from './studio'
import {
  DEFAULT_APPEARANCE,
  completeAppearance,
  type AppearanceConfig,
  type PublicAppearance
} from '@/types/appearance'

const clone = (value: AppearanceConfig): AppearanceConfig =>
  JSON.parse(JSON.stringify(toRaw(value)))
export const useAppearanceStore = defineStore('appearance', () => {
  const saved = ref<AppearanceConfig>(clone(DEFAULT_APPEARANCE))
  const draft = ref<AppearanceConfig | null>(null)
  const publicSaved = ref<PublicAppearance | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const effective = computed(() => {
    if (useStudioStore().user) return draft.value || saved.value
    return { ...clone(DEFAULT_APPEARANCE), ...(publicSaved.value || {}) }
  })
  let requestVersion = 0
  let publicRequestVersion = 0
  function publicProjection(value: PublicAppearance): PublicAppearance {
    const publicImage = (image: PublicAppearance['logo']) =>
      image ? { ...image, url: `/api/studio/public-assets/${image.id}` } : null
    return JSON.parse(
      JSON.stringify({
        studioName: value.studioName,
        logo: publicImage(value.logo),
        login: {
          ...value.login,
          background: {
            ...value.login.background,
            image:
              value.login.background.mode === 'image'
                ? publicImage(value.login.background.image)
                : null
          }
        },
        glass: { enabled: value.glass.enabled }
      })
    )
  }
  function acceptServer(value: AppearanceConfig) {
    if (value.revision < saved.value.revision) return
    saved.value = clone(completeAppearance(value))
    publicSaved.value = publicProjection(saved.value)
    publicRequestVersion++
  }
  function beginPreview(value: AppearanceConfig) {
    if (useStudioStore().can('settings.manage')) draft.value = clone(value)
  }
  function stopPreview() {
    draft.value = null
  }
  function clear() {
    requestVersion++
    saved.value = clone(DEFAULT_APPEARANCE)
    draft.value = null
    loading.value = false
    saving.value = false
  }
  async function request<T>(path: string, body?: unknown) {
    try {
      return await studioRequest<T>(path, body, body ? 'POST' : 'GET')
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) {
        clear()
        useStudioStore().clearSession()
      }
      throw cause
    }
  }
  async function load() {
    const version = ++requestVersion
    loading.value = true
    try {
      const result = completeAppearance(await request<AppearanceConfig>('appearance'))
      if (version === requestVersion) acceptServer(result)
      return result
    } finally {
      if (version === requestVersion) loading.value = false
    }
  }
  async function loadPublic() {
    const version = ++publicRequestVersion
    const result = await studioRequest<PublicAppearance>('appearance/public')
    if (version === publicRequestVersion) publicSaved.value = publicProjection(result)
    return result
  }
  async function save(value: AppearanceConfig) {
    if (saving.value) throw new Error('正在保存，请稍后操作')
    saving.value = true
    const version = ++requestVersion
    try {
      const result = await request<AppearanceConfig>('appearance', {
        config: clone(value),
        revision: value.revision
      })
      if (version === requestVersion) {
        acceptServer(result)
        stopPreview()
      }
      return result
    } finally {
      if (version === requestVersion) saving.value = false
    }
  }
  async function reset(revision = saved.value.revision) {
    if (saving.value) throw new Error('正在保存，请稍后操作')
    saving.value = true
    const version = ++requestVersion
    try {
      const result = await request<AppearanceConfig>('appearance/reset', { revision })
      if (version === requestVersion) {
        acceptServer(result)
        stopPreview()
      }
      return result
    } finally {
      if (version === requestVersion) saving.value = false
    }
  }
  return {
    saved,
    draft,
    effective,
    publicSaved,
    loading,
    saving,
    load,
    loadPublic,
    save,
    reset,
    beginPreview,
    stopPreview,
    clear,
    acceptServer
  }
})
