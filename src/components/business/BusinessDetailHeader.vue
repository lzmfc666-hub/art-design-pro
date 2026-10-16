<template>
  <div class="business-detail-header">
    <span v-if="icon" class="business-detail-header-icon" aria-hidden="true"
      ><component :is="detailIcon" style="width: 22px; height: 22px" />
    </span>
    <div class="business-detail-header-copy">
      <div v-if="title || badge" class="business-detail-header-title">
        <h2 v-if="title">{{ title }}</h2>
        <ElTag v-if="badge" size="small" effect="plain">{{ badge }}</ElTag>
      </div>
      <p>{{ description }}</p>
      <span v-if="context" class="business-detail-context">{{ context }}</span>
      <slot />
    </div>
    <div v-if="$slots.actions" class="business-detail-header-actions"><slot name="actions" /></div>
  </div>
</template>
<script setup lang="ts">
  import {
    Calendar,
    Clock,
    Document,
    Lock,
    Monitor,
    Picture,
    Setting,
    TrendCharts,
    User,
    Wallet
  } from '@element-plus/icons-vue'

  const props = defineProps<{
    title?: string
    description: string
    icon?: string
    badge?: string
    context?: string
  }>()

  // Detail headings use installed icons so they also render without an external icon service.
  const detailIcon = computed(() => {
    const name = props.icon || ''
    if (/money|wallet|bank|refund|bill/.test(name)) return Wallet
    if (/calendar/.test(name)) return Calendar
    if (/history|time/.test(name)) return Clock
    if (/chart|funds/.test(name)) return TrendCharts
    if (/user|contacts|team|gamepad/.test(name)) return User
    if (/shield|lock/.test(name)) return Lock
    if (/image|picture/.test(name)) return Picture
    if (/settings/.test(name)) return Setting
    if (/server/.test(name)) return Monitor
    return Document
  })
</script>
