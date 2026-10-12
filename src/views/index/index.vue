<!-- 布局容器 -->
<template>
  <div class="app-layout">
    <aside id="app-sidebar">
      <ArtSidebarMenu />
    </aside>

    <main id="app-main" :style="pageBackground">
      <div id="app-header">
        <ArtHeaderBar />
      </div>
      <div id="app-content">
        <ArtPageContent />
      </div>
    </main>

    <div id="app-global">
      <ArtGlobalComponent />
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { useRoute } from 'vue-router'
  import { useAppearance } from '@/hooks/business/useAppearance'
  defineOptions({ name: 'AppLayout' })
  const route = useRoute()
  const { config } = useAppearance()
  const pageBackground = computed(() => {
    if (!route.meta.business || config.value.page.mode === 'default') return {}
    const page = config.value.page
    if (page.mode === 'color') return { backgroundColor: page.color, backgroundImage: 'none' }
    const url = page.image?.url
    if (!url || !/^\/api\/studio\/uploads\/[A-Za-z0-9_-]+$/.test(url)) return {}
    const opacity = Math.max(0, Math.min(90, page.overlay)) / 100
    return {
      backgroundColor: 'var(--default-bg-color)',
      backgroundImage: `linear-gradient(var(--appearance-veil),var(--appearance-veil)),url("${url}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      backgroundAttachment: 'fixed',
      '--appearance-veil': `rgba(255,255,255,${opacity})`,
      '--appearance-dark-veil': `rgba(15,23,42,${opacity})`
    }
  })
</script>

<style lang="scss" scoped>
  @use './style';

  :global(.dark #app-main[style*='--appearance-dark-veil']) {
    --appearance-veil: var(--appearance-dark-veil) !important;
  }
</style>
