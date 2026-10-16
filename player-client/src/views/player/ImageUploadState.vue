<template>
  <div v-if="phase !== 'idle'" class="p-upload-state" aria-live="polite">
    <template v-if="phase === 'preparing' || phase === 'uploading'">
      <p>{{ phase === 'preparing' ? '正在处理图片，保持文字清晰' : '正在上传图片' }} · {{ Math.round(percent) }}%</p>
      <progress :value="percent" max="100" :aria-label="phase === 'preparing' ? '图片处理进度' : '图片上传进度'" />
    </template>
    <p v-else-if="phase === 'done'" class="p-hint">图片已上传，保存时会沿用这张图片。</p>
    <template v-else-if="phase === 'error'">
      <p class="p-notice p-error" role="alert">{{ error || '图片上传未完成，可以重试或重新选择。' }}</p>
      <button type="button" class="p-btn p-secondary p-full" :disabled="!online" @click="$emit('retry')">重试上传</button>
    </template>
  </div>
</template>
<script setup lang="ts">
  defineProps<{ phase: string; percent: number; error?: string; online: boolean }>()
  defineEmits<{ retry: [] }>()
</script>
<style scoped>
  .p-upload-state { margin: 10px 0; overflow-wrap: anywhere; }
  .p-upload-state p { font-size: 13px; }
  progress { width: 100%; accent-color: #8654ed; height: 7px; border: 0; border-radius: 9px; }
</style>
