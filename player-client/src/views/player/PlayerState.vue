<template>
  <div v-if="!online" class="p-notice p-warning"
    ><PlayerIcon name="offline" />网络已断开，恢复连接后会自动更新。资金操作需联网。</div
  >
  <div v-if="error" class="p-notice p-error" role="alert"
    ><span>{{ error }}</span
    ><button class="p-text-btn" @click="$emit('retry')">重试</button></div
  >
  <div v-if="loading" class="p-state" aria-live="polite"
    ><span class="p-spinner" />正在读取最新数据…</div
  >
  <div v-else-if="empty && !error" class="p-state"
    ><PlayerIcon name="empty" /><strong>{{ emptyText || '暂时没有记录' }}</strong
    ><p>{{ hint || '有新进展时会自动显示在这里' }}</p></div
  >
</template>
<script setup lang="ts">
  import PlayerIcon from './PlayerIcon.vue'
  defineProps<{
    loading?: boolean
    error?: string
    online?: boolean
    empty?: boolean
    emptyText?: string
    hint?: string
  }>()
  defineEmits<{ retry: [] }>()
</script>
