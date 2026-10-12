<template>
  <div>
    <ElUpload
      action="#"
      :auto-upload="false"
      :show-file-list="false"
      accept="image/jpeg,image/png,image/webp"
      :disabled="busy"
      :on-change="select"
    >
      <ElButton :loading="busy"
        ><ArtSvgIcon icon="ri:upload-2-line" class="mr-1" />{{
          modelValue ? '替换凭证' : '上传凭证'
        }}</ElButton
      >
      <template #tip><p class="text-xs text-g-500">JPG / PNG / WebP，最大 8MB</p></template>
    </ElUpload>
    <ElLink
      v-if="modelValue"
      :href="modelValue.url"
      target="_blank"
      rel="noopener"
      type="primary"
      class="mt-2"
      >{{ modelValue.name }}</ElLink
    >
  </div>
</template>
<script setup lang="ts">
  import { ref } from 'vue'
  import { ElMessage, type UploadFile } from 'element-plus'
  import type { Attachment } from '@/types/studio'
  import { useStudio } from '@/hooks/business/useStudio'
  defineProps<{ modelValue: Attachment | null }>()
  const emit = defineEmits<{
    'update:modelValue': [value: Attachment | null]
    busy: [value: boolean]
  }>()
  const { upload } = useStudio()
  const busy = ref(false)
  async function select(file: UploadFile) {
    if (!file.raw || busy.value) return
    busy.value = true
    emit('busy', true)
    try {
      emit('update:modelValue', await upload(file.raw))
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '上传失败')
    } finally {
      busy.value = false
      emit('busy', false)
    }
  }
</script>
