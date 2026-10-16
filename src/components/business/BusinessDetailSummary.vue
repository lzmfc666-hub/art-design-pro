<template>
  <div class="business-detail-summary">
    <div v-for="(item, index) in items" :key="index" class="business-detail-summary-item">
      <span>{{ item.label }}</span>
      <strong
        :class="
          ['primary', 'success', 'warning', 'danger'].includes(item.tone || '')
            ? `tone-${item.tone}`
            : ''
        "
        >{{ item.value ?? '—' }}</strong
      >
      <small v-if="item.hint">{{ item.hint }}</small>
    </div>
  </div>
</template>
<script setup lang="ts">
  defineProps<{
    items: {
      label: string
      value: string | number | null | undefined
      hint?: string
      tone?: string
    }[]
  }>()
</script>
