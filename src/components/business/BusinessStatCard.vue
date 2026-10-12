<template>
  <div class="art-card business-stat-card" :style="colors">
    <div class="flex items-start justify-between gap-2">
      <span class="text-sm text-g-500">{{ label }}</span
      ><span v-if="icon" class="stat-icon"><ArtSvgIcon :icon="icon" /></span>
    </div>
    <div class="stat-value">{{ value }}</div>
    <p v-if="description" class="text-xs text-g-500 leading-5">{{ description }}</p>
    <slot />
  </div>
</template>
<script setup lang="ts">
  import { computed } from 'vue'
  const props = withDefaults(
    defineProps<{
      label: string
      value: string | number
      icon?: string
      description?: string
      tone?: 'primary' | 'success' | 'warning' | 'danger' | 'info'
    }>(),
    { tone: 'primary' }
  )
  const colors = computed(() => ({
    '--stat-color': `var(--el-color-${props.tone})`,
    '--stat-bg': `var(--el-color-${props.tone}-light-9)`
  }))
</script>
<style lang="scss" scoped>
  .business-stat-card {
    position: relative;
    height: 100%;
    min-height: 142px;
    padding: 18px 20px;
    overflow: hidden;
  }

  .business-stat-card::before {
    position: absolute;
    inset: 18px auto 18px 0;
    width: 3px;
    content: '';
    background: var(--stat-color);
    border-radius: 0 4px 4px 0;
  }

  .stat-icon {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    font-size: 18px;
    color: var(--stat-color);
    background: var(--stat-bg);
    border-radius: 10px;
  }

  .stat-value {
    margin: 5px 0 8px;
    font-size: 26px;
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  @media (width <= 640px) {
    .business-stat-card {
      min-height: 142px;
      padding: 14px;
    }

    .stat-value {
      font-size: 23px;
    }
  }
</style>
