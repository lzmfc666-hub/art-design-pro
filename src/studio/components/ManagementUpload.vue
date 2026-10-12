<script setup lang="ts">
  import { ref } from 'vue'
  import { ElButton, ElMessage } from 'element-plus'
  import type { Attachment } from '@/types/studio'
  import { useStudio } from '../useStudio'

  defineProps<{ modelValue: Attachment | null }>()
  const emit = defineEmits<{ 'update:modelValue': [value: Attachment | null] }>()
  const { upload } = useStudio()
  const input = ref<HTMLInputElement | null>(null)
  const busy = ref(false)
  async function select(event: Event) {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0]
    if (!file) return
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 8 * 1024 * 1024
    ) {
      ElMessage.warning('请上传 8MB 以内的 JPG、PNG 或 WebP 图片')
      target.value = ''
      return
    }
    busy.value = true
    try {
      emit('update:modelValue', await upload(file))
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      busy.value = false
      target.value = ''
    }
  }
</script>

<template>
  <div class="management-upload">
    <input
      ref="input"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      hidden
      @change="select"
    />
    <ElButton :loading="busy" @click="input?.click()">{{
      modelValue ? '替换凭证' : '上传凭证'
    }}</ElButton>
    <a v-if="modelValue" :href="modelValue.url" target="_blank" rel="noopener">{{
      modelValue.name
    }}</a>
    <span v-else class="muted">JPG / PNG / WebP，最大 8MB</span>
  </div>
</template>

<style scoped>
  .management-upload {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  .management-upload a {
    max-width: 230px;
    overflow: hidden;
    color: var(--el-color-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
