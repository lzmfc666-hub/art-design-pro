<template>
  <div class="p-pagination">
    <p class="p-hint p-center">共 {{ total }} 条 · 第 {{ current }} / {{ pages }} 页</p>
    <div v-if="pages > 1" class="p-actions">
      <button type="button" class="p-btn p-secondary" :disabled="busy || current <= 1" @click="$emit('change', current - 1)">上一页</button>
      <button type="button" class="p-btn p-secondary" :disabled="busy || current >= pages" @click="$emit('change', current + 1)">下一页</button>
    </div>
  </div>
</template>
<script setup lang="ts">
  import { computed } from 'vue'
  const props = defineProps<{ current: number; size: number; total: number; busy?: boolean }>()
  defineEmits<{ change: [page: number] }>()
  const pages = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.size))))
</script>
