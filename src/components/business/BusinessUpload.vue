<template>
  <div>
    <ElUpload
      action="#"
      :auto-upload="false"
      :show-file-list="false"
      :drag="drag"
      accept="image/jpeg,image/png,image/webp"
      :disabled="busy || disabled"
      :on-change="select"
    >
      <div v-if="drag" class="receipt-drop-zone"
        ><ArtSvgIcon icon="ri:upload-cloud-2-line" /><strong>{{
          busy ? '正在上传凭证…' : '拖动凭证图片到这里'
        }}</strong
        ><span>或点击选择图片</span></div
      >
      <ElButton v-else :loading="busy" :disabled="disabled"
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
  const props = withDefaults(
    defineProps<{ modelValue: Attachment | null; disabled?: boolean; drag?: boolean }>(),
    { disabled: false, drag: true }
  )
  const emit = defineEmits<{
    'update:modelValue': [value: Attachment | null]
    busy: [value: boolean]
  }>()
  const { upload } = useStudio()
  const busy = ref(false)
  async function select(file: UploadFile) {
    if (!file.raw || busy.value || props.disabled) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.raw.type))
      return void ElMessage.warning('请上传 PNG、JPG 或 WebP 图片')
    if (file.raw.size <= 0 || file.raw.size > 8 * 1024 * 1024)
      return void ElMessage.warning('凭证图片应大于 0 且不超过 8MB')
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

<style scoped lang="scss">
  .receipt-drop-zone {
    display: flex;
    flex-direction: column;
    gap: 7px;
    align-items: center;
    padding: 5px 12px;

    :deep(.art-svg-icon) {
      width: 28px;
      height: 28px;
      color: var(--el-color-primary);
    }

    strong {
      font-size: 13px;
      font-weight: 500;
      color: var(--el-text-color-primary);
    }

    span {
      font-size: 12px;
      color: var(--el-text-color-secondary);
    }
  }
</style>
