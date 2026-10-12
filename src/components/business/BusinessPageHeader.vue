<template>
  <ElCard shadow="never" class="mb-5 business-page-header">
    <div class="header-layout">
      <div class="header-main">
        <span v-if="icon" class="header-icon"><ArtSvgIcon :icon="icon" /></span>
        <div class="min-w-0">
          <div class="flex items-center gap-3 flex-wrap"
            ><h2 class="text-xl font-semibold">{{ title }}</h2
            ><ElTag v-if="badge" effect="plain" size="small">{{ badge }}</ElTag></div
          >
          <p v-if="description" class="text-sm text-g-500 mt-2 leading-6">{{ description }}</p>
          <slot />
        </div>
      </div>
      <div v-if="$slots.actions" class="header-actions"><slot name="actions" /></div>
    </div>
  </ElCard>
</template>
<script setup lang="ts">
  defineProps<{ title: string; description?: string; icon?: string; badge?: string }>()
</script>
<style lang="scss" scoped>
  .business-page-header {
    flex-shrink: 0;
  }

  .header-layout {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    align-items: center;
    justify-content: space-between;
  }

  .header-main {
    display: flex;
    flex: 1;
    gap: 14px;
    align-items: flex-start;
    min-width: 0;
  }

  .header-icon {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    font-size: 22px;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-radius: 12px;
  }

  .header-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  @media (width <= 640px) {
    .header-main {
      flex-basis: 100%;
    }

    .header-actions {
      width: 100%;
    }
  }
</style>
