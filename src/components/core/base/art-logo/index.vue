<!-- 系统logo -->
<template>
  <div class="flex-cc">
    <img
      v-if="logoUrl && failedLogoUrl !== logoUrl"
      :key="logoUrl"
      :style="customLogoStyle"
      :src="logoUrl"
      :alt="config.studioName"
      class="object-contain"
      @error="handleLogoError"
    />
    <img v-else :style="logoStyle" src="@imgs/common/logo.webp" alt="logo" class="w-full h-full" />
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useAppearance } from '@/hooks/business/useAppearance'

  defineOptions({ name: 'ArtLogo' })

  interface Props {
    /** logo 大小 */
    size?: number | string
  }

  const props = withDefaults(defineProps<Props>(), {
    size: 36
  })

  const logoStyle = computed(() => ({ width: `${props.size}px` }))
  const customLogoStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
  const { config } = useAppearance()
  const failedLogoUrl = ref('')
  const logoUrl = computed(() => {
    const url = config.value.logo?.url
    return typeof url === 'string' && /^\/api\/studio\/uploads\/[A-Za-z0-9_-]+$/.test(url)
      ? url
      : ''
  })
  watch([logoUrl, () => config.value.revision], () => (failedLogoUrl.value = ''))
  function handleLogoError(event: Event) {
    const failed = (event.currentTarget as HTMLImageElement).getAttribute('src')
    if (failed === logoUrl.value) failedLogoUrl.value = failed || ''
  }
</script>
