<template>
  <div class="appearance-image-upload">
    <ElUpload
      action="#"
      :auto-upload="false"
      :show-file-list="false"
      accept="image/png,image/jpeg,image/webp"
      :disabled="disabled || uploading"
      :on-change="selectImage"
    >
      <div
        class="image-select"
        :class="{ 'image-square': variant === 'square', 'is-disabled': disabled || uploading }"
      >
        <img
          v-if="displayUrl"
          :src="localUrl || studioImageUrl(displayUrl)"
          loading="lazy"
          :alt="label + '预览'"
          :class="{ 'image-contain': variant === 'square' }"
        />
        <div v-else class="image-placeholder"
          ><ArtSvgIcon icon="ri:image-add-line" /><span>上传{{ label }}</span></div
        >
        <span class="image-select-hint"
          ><ArtSvgIcon
            :icon="uploading ? 'ri:loader-4-line' : 'ri:upload-2-line'"
            :class="{ 'is-rotating': uploading }"
          />{{
            uploading ? '正在上传，请稍候' : displayUrl ? '点击替换图片' : '点击选择图片'
          }}</span
        >
      </div>
    </ElUpload>
    <div class="upload-caption"
      ><span>{{ filename || recommended || 'PNG / JPG / WebP，最大 8MB' }}</span
      ><ElButton
        v-if="imageUrl"
        link
        type="danger"
        :disabled="disabled || uploading"
        @click="emit('remove')"
        >移除图片</ElButton
      ></div
    >
    <p v-if="filename || recommended" class="upload-tip">PNG / JPG / WebP，最大 8MB</p>
  </div>
</template>

<script setup lang="ts">
  import { computed, nextTick, onUnmounted, ref } from 'vue'
  import { ElMessage, type UploadFile } from 'element-plus'
  import { useStudio } from '@/hooks/business/useStudio'
  import type { Attachment } from '@/types/studio'
  import { studioImageUrl } from '@/utils/studio-image'

  const props = withDefaults(
    defineProps<{
      label: string
      imageUrl?: string
      filename?: string
      recommended?: string
      variant?: 'square' | 'wide'
      disabled?: boolean
    }>(),
    { imageUrl: '', filename: '', recommended: '', variant: 'wide', disabled: false }
  )
  const emit = defineEmits<{
    uploaded: [attachment: Attachment]
    remove: []
    busy: [value: boolean]
  }>()
  const { upload } = useStudio()
  const uploading = ref(false)
  const localUrl = ref('')
  const displayUrl = computed(() => localUrl.value || props.imageUrl)
  let disposed = false

  function releasePreview() {
    if (localUrl.value) URL.revokeObjectURL(localUrl.value)
    localUrl.value = ''
  }
  async function selectImage(file: UploadFile) {
    if (!file.raw || uploading.value || props.disabled) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.raw.type))
      return void ElMessage.warning('请选择 PNG、JPG 或 WebP 图片')
    if (!file.raw.size || file.raw.size > 8 * 1024 * 1024)
      return void ElMessage.warning('图片大小应大于 0 且不超过 8MB')
    releasePreview()
    localUrl.value = URL.createObjectURL(file.raw)
    uploading.value = true
    emit('busy', true)
    try {
      const attachment = await upload(file.raw)
      if (!disposed) {
        emit('uploaded', attachment)
        await nextTick()
        ElMessage.success('图片已上传，保存外观设置后全工作室生效')
      }
    } catch (cause) {
      if (!disposed)
        ElMessage.error(cause instanceof Error ? cause.message : '图片上传失败，请重试')
    } finally {
      releasePreview()
      uploading.value = false
      emit('busy', false)
    }
  }
  onUnmounted(() => {
    disposed = true
    releasePreview()
  })
</script>

<style scoped lang="scss">
  .appearance-image-upload {
    width: 100%;
    max-width: 420px;

    :deep(.el-upload) {
      display: block;
      width: 100%;
    }
  }

  .image-select {
    position: relative;
    height: 156px;
    overflow: hidden;
    cursor: pointer;
    background: var(--el-fill-color-extra-light);
    border: 1px dashed var(--el-border-color);
    border-radius: 12px;

    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    img.image-contain {
      padding: 16px 16px 40px;
      object-fit: contain;
    }
  }

  .image-square {
    width: 156px;
  }

  .image-select.is-disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }

  .image-placeholder {
    display: flex;
    flex-direction: column;
    gap: 9px;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding-bottom: 20px;
    font-size: 13px;
    color: var(--el-text-color-placeholder);

    :deep(.art-svg-icon) {
      width: 30px;
      height: 30px;
      font-size: 30px;
    }
  }

  .image-select-hint {
    position: absolute;
    inset: auto 0 0;
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: center;
    min-height: 30px;
    padding: 6px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-light);
    border-top: 1px solid var(--el-border-color-extra-light);
  }

  .upload-caption {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    margin-top: 9px;
    font-size: 12px;
    color: var(--el-text-color-secondary);

    span {
      max-width: 100%;
      overflow-wrap: anywhere;
    }
  }

  .upload-tip {
    margin-top: 6px;
    font-size: 12px;
    color: var(--el-text-color-placeholder);
  }

  .is-rotating {
    animation: upload-rotate 1s linear infinite;
  }

  @keyframes upload-rotate {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .is-rotating {
      animation: none;
    }
  }
</style>
