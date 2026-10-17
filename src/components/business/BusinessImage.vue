<template>
  <span ref="container" class="business-image">
    <ElImage ref="image" v-bind="$attrs" :src="pixels" :lazy="false">
      <template #placeholder><span class="business-image-placeholder">图片加载中</span></template>
      <template #error><span class="business-image-placeholder"><span>{{ failed ? '预览不可用' : '图片加载中' }}</span><button v-if="failed" type="button" @click="image?.showPreview()">查看原图</button></span></template>
    </ElImage>
  </span>
</template>

<script setup lang="ts">
  import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { useStudioStore } from '@/store/modules/studio'
  import type { ImageInstance } from 'element-plus'
  import { studioImagePixels, studioImageUrl, type StudioImageVariant } from '@/utils/studio-image'

  defineOptions({ inheritAttrs: false })
  const props = withDefaults(defineProps<{ src?: string; variant?: StudioImageVariant; lazy?: boolean }>(),
    { src: '', variant: 'thumb', lazy: true })
  const studio = useStudioStore(), container = ref<HTMLElement>(), pixels = ref(''), failed = ref(false)
  const image = ref<ImageInstance>()
  const visible = ref(!props.lazy)
  let revision = 0, observer: IntersectionObserver | undefined
  watch(() => [props.src, props.variant, studio.user?.id, visible.value], async () => {
    const current = ++revision
    pixels.value = ''; failed.value = false
    if (!visible.value || !props.src || !studio.user?.id) return
    try {
      const result = await studioImagePixels(studio.user.id, studioImageUrl(props.src, props.variant))
      if (current === revision) pixels.value = result
    } catch { if (current === revision) failed.value = true }
  }, { immediate: true })
  onMounted(() => {
    if (!props.lazy || typeof IntersectionObserver === 'undefined') { visible.value = true; return }
    observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { visible.value = true; observer?.disconnect() }
    }, { rootMargin: '200px' })
    if (container.value) observer.observe(container.value)
  })
  onBeforeUnmount(() => { revision++; observer?.disconnect() })
</script>

<style scoped>
  .business-image { display: inline-flex; max-width: 100%; }
  .business-image-placeholder { display: grid; place-items: center; width: 100%; height: 100%; min-height: 32px; font-size: 12px; color: var(--el-text-color-secondary); background: var(--el-fill-color-light); }
  .business-image-placeholder button { color: var(--el-color-primary); cursor: pointer; }
</style>
