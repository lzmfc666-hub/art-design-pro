<template>
  <img ref="element" :src="pixels || undefined" :alt="alt" :loading="lazy ? 'lazy' : 'eager'" decoding="async" @error="failed" />
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { privateImageBlob, thumbnailUrl } from '@/api/privateImages'
import { onSessionInvalidated, sessionRevision } from '@/api/sessionBoundary'

const props = withDefaults(defineProps<{ src?: string; alt?: string; context?: string; lazy?: boolean; thumbnail?: boolean; variant?: 'thumb' | 'display' }>(), {
  alt: '', context: '', lazy: true, thumbnail: true, variant: 'thumb'
})
const emit = defineEmits<{ error: [event: Event]; load: [] }>()
const pixels = ref(''), element = ref<HTMLImageElement>()
let generation = 0, observer: IntersectionObserver | undefined, visible = !props.lazy
function release() { if (pixels.value) URL.revokeObjectURL(pixels.value); pixels.value = '' }
function failed(event: Event) { release(); emit('error', event) }
async function load() {
  const token = ++generation, epoch = sessionRevision()
  release()
  const url = props.thumbnail ? thumbnailUrl(props.src || '', props.variant) : props.src
  if (!url || !visible) return
  try {
    const blob = await privateImageBlob(url, props.context)
    if (token !== generation || epoch !== sessionRevision()) return
    pixels.value = URL.createObjectURL(blob); emit('load')
  } catch {
    if (token === generation && epoch === sessionRevision()) emit('error', new Event('error'))
  }
}
const unsubscribe = onSessionInvalidated(() => { generation++; release() })
watch(() => [props.src, props.context, props.thumbnail, props.variant], () => void load())
onMounted(async () => {
  await nextTick()
  if (props.lazy && typeof IntersectionObserver !== 'undefined' && element.value) {
    observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { visible = true; observer?.disconnect(); void load() }
    }, { rootMargin: '200px' })
    observer.observe(element.value)
  } else { visible = true; void load() }
})
onBeforeUnmount(() => { generation++; observer?.disconnect(); unsubscribe(); release() })
</script>
