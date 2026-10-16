import { computed, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { playerApi } from '@/api/player'
import { useSessionStore } from '@/stores/session'
import type { Attachment } from '@/types/studio'
import type { ImageKind } from '@/utils/prepareImage'
import { onSessionInvalidated } from '@/api/sessionBoundary'

const imageDrafts = new Map<string, ReturnType<typeof createState>>()
function createState() {
  return {
    file: shallowRef<File | null>(null), attachment: shallowRef<Attachment | null>(null),
    phase: ref<'idle' | 'preparing' | 'uploading' | 'done' | 'error'>('idle'), percent: ref(0), error: ref('')
  }
}
onSessionInvalidated(() => {
  for (const state of imageDrafts.values()) {
    state.file.value = null; state.attachment.value = null; state.phase.value = 'idle'; state.error.value = ''
  }
  imageDrafts.clear()
})

/** Private images are kept only in the current account's memory, never offline storage. */
export function useImageUpload(kind: ImageKind, draftKey?: string) {
  const session = useSessionStore()
  const key = draftKey ? `${session.epoch}:${draftKey}` : ''
  const state = key && imageDrafts.get(key) || createState()
  if (key) imageDrafts.set(key, state)
  const { file, attachment, phase, percent, error } = state
  const busy = computed(() => phase.value === 'preparing' || phase.value === 'uploading')
  let controller: AbortController | null = null, generation = 0
  function cancel() {
    generation++
    controller?.abort()
    controller = null
    if (busy.value) phase.value = file.value ? 'error' : 'idle'
  }
  function clear() {
    cancel()
    file.value = null
    attachment.value = null
    phase.value = 'idle'
    percent.value = 0
    error.value = ''
  }
  async function start(next?: File) {
    if (busy.value) return
    if (next) {
      file.value = next
      attachment.value = null
    }
    if (!file.value) return
    const token = ++generation, epoch = session.epoch
    controller = new AbortController()
    error.value = ''
    phase.value = 'preparing'
    percent.value = 0
    try {
      const uploaded = await playerApi.upload(file.value, {
        kind,
        signal: controller.signal,
        onProgress: (progress: { phase: 'preparing' | 'uploading'; percent: number }) => {
          if (token !== generation || epoch !== session.epoch) return
          phase.value = progress.phase
          percent.value = progress.percent
        }
      })
      if (token !== generation || epoch !== session.epoch) return
      attachment.value = uploaded
      // Once the server attachment exists, saves and retries reuse it.
      file.value = null
      percent.value = 100
      phase.value = 'done'
    } catch (cause) {
      if (token !== generation || epoch !== session.epoch) return
      phase.value = 'error'
      error.value = cause instanceof Error ? cause.message : '图片上传失败，请重试'
    } finally {
      if (token === generation) controller = null
    }
  }
  watch(() => session.epoch, clear)
  const unsubscribe = onSessionInvalidated(clear)
  onDeactivated(cancel)
  onBeforeUnmount(() => { cancel(); unsubscribe(); if (!key) clear() })
  return { attachment, phase, percent, error, busy, start, retry: () => start(), clear }
}
