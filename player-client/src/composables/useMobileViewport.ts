import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** Keep the independent player scroller inside the visible mobile viewport. */
export function useMobileViewport(scroller: Ref<HTMLElement | undefined>) {
  const viewportHeight = ref<number | null>(null)
  const viewportTop = ref(0)
  const keyboardOpen = ref(false)
  let naturalHeight = 0
  let frame = 0
  let viewport: VisualViewport | null = null
  let focusTimer: ReturnType<typeof setTimeout> | undefined

  const viewportStyle = computed(() => ({
    '--p-viewport-height': viewportHeight.value === null ? '100dvh' : `${viewportHeight.value}px`,
    '--p-viewport-top': `${viewportTop.value}px`
  }))

  function editableFocus() {
    const element = document.activeElement
    if (!(element instanceof HTMLElement)) return null
    if (element.isContentEditable || element instanceof HTMLTextAreaElement) return element
    if (element instanceof HTMLSelectElement) return element
    if (element instanceof HTMLInputElement &&
      !['button', 'checkbox', 'color', 'file', 'hidden', 'radio', 'range', 'submit'].includes(element.type)) {
      return element
    }
    return null
  }

  function revealFocusedInput() {
    const element = editableFocus()
    const container = scroller.value
    if (!element || !container?.contains(element)) return
    const input = element.getBoundingClientRect()
    const visible = container.getBoundingClientRect()
    const gap = 16
    const bottomDelta = input.bottom - (visible.bottom - gap)
    const topDelta = input.top - (visible.top + gap)
    // Tall textareas stay aligned at their top; moving the outer document can hide the header.
    if (input.height > visible.height - gap * 2) {
      if (topDelta !== 0) container.scrollTop += topDelta
    } else if (bottomDelta > 0) {
      container.scrollTop += bottomDelta
    } else if (topDelta < 0) {
      container.scrollTop += topDelta
    }
  }

  function updateViewport() {
    frame = 0
    // Preserve browser pinch zoom; its smaller viewport is not a software keyboard.
    if (viewport && Math.abs(viewport.scale - 1) > 0.05) return
    const height = viewport?.height ?? window.innerHeight
    const focused = editableFocus()
    if (!focused) naturalHeight = Math.max(window.innerHeight, height)
    if (!naturalHeight) naturalHeight = Math.max(window.innerHeight, height)
    viewportHeight.value = Math.max(1, Math.round(height))
    viewportTop.value = Math.max(0, Math.round(viewport?.offsetTop ?? 0))
    keyboardOpen.value = !!focused && naturalHeight - height > 100
    // Vue applies the new scroller height in this microtask before reading input geometry.
    queueMicrotask(() => revealFocusedInput())
  }

  function scheduleViewport() {
    if (!frame) frame = requestAnimationFrame(updateViewport)
  }

  function handleFocus() {
    scheduleViewport()
    if (focusTimer) clearTimeout(focusTimer)
    focusTimer = setTimeout(scheduleViewport, 350)
  }

  onMounted(() => {
    viewport = window.visualViewport
    naturalHeight = Math.max(window.innerHeight, viewport?.height ?? 0)
    window.addEventListener('resize', scheduleViewport, { passive: true })
    window.addEventListener('orientationchange', scheduleViewport, { passive: true })
    viewport?.addEventListener('resize', scheduleViewport, { passive: true })
    viewport?.addEventListener('scroll', scheduleViewport, { passive: true })
    document.addEventListener('focusin', handleFocus)
    document.addEventListener('focusout', handleFocus)
    scheduleViewport()
  })

  onBeforeUnmount(() => {
    if (frame) cancelAnimationFrame(frame)
    if (focusTimer) clearTimeout(focusTimer)
    window.removeEventListener('resize', scheduleViewport)
    window.removeEventListener('orientationchange', scheduleViewport)
    viewport?.removeEventListener('resize', scheduleViewport)
    viewport?.removeEventListener('scroll', scheduleViewport)
    document.removeEventListener('focusin', handleFocus)
    document.removeEventListener('focusout', handleFocus)
  })

  return { viewportStyle, keyboardOpen }
}
