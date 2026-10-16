<template>
  <div class="p-order-number">
    <button
      type="button"
      class="p-order-number-copy"
      :aria-label="`复制订单号 ${orderNo}`"
      title="长按或点击复制订单号"
      @pointerdown="startPress"
      @pointermove="movePress"
      @pointerup="stopPress"
      @pointercancel="stopPress"
      @pointerleave="stopPress"
      @contextmenu.prevent
      @click="clickCopy"
    >
      <span class="p-order-number-value">{{ orderNo }}</span>
      <span class="p-order-copy-hint" role="status" aria-live="polite">{{ copied ? '已复制订单号' : '长按复制' }}</span>
    </button>
    <div v-if="copyUnavailable" class="p-order-copy-manual">
      <span>请选中下方订单号复制</span>
      <input :value="orderNo" readonly aria-label="手动复制订单号" @focus="selectNumber" />
    </div>
  </div>
</template>

<script setup lang="ts">
  import { onBeforeUnmount, ref, watch } from 'vue'

  const props = defineProps<{ orderNo: string }>()
  const copied = ref(false), copyUnavailable = ref(false)
  let pressTimer: ReturnType<typeof setTimeout> | undefined
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined
  let pressPoint: { x: number; y: number } | undefined
  let suppressClick = false, copying = false, disposed = false
  let generation = 0

  function stopPress() {
    clearTimeout(pressTimer)
    pressTimer = undefined
    pressPoint = undefined
  }
  function startPress(event: PointerEvent) {
    stopPress()
    suppressClick = false
    if (!event.isPrimary || event.button !== 0) return
    pressPoint = { x: event.clientX, y: event.clientY }
    const number = props.orderNo
    pressTimer = setTimeout(() => {
      suppressClick = true
      void copyNumber(number)
    }, 550)
  }
  function movePress(event: PointerEvent) {
    if (pressPoint && Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y) > 10) {
      suppressClick = true
      stopPress()
    }
  }
  function clickCopy(event: MouseEvent) {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false
      return
    }
    void copyNumber(props.orderNo)
  }
  function selectNumber(event: FocusEvent) {
    (event.target as HTMLInputElement).select()
  }
  function legacyCopy(number: string) {
    const focused = document.activeElement as HTMLElement | null
    const input = document.createElement('textarea')
    input.value = number
    input.readOnly = true
    input.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;pointer-events:none'
    document.body.appendChild(input)
    try {
      input.select()
      input.setSelectionRange(0, number.length)
      return document.execCommand('copy')
    } finally {
      input.remove()
      focused?.focus({ preventScroll: true })
    }
  }
  async function copyNumber(number: string) {
    if (copying || !number || number !== props.orderNo) return
    copying = true
    const currentGeneration = generation
    let success = false
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(number)
          success = true
        } catch {
          if (!disposed && currentGeneration === generation) success = legacyCopy(number)
        }
      } else {
        success = legacyCopy(number)
      }
    } catch {
      success = false
    } finally {
      copying = false
    }
    if (disposed || currentGeneration !== generation) return
    clearTimeout(feedbackTimer)
    copied.value = success
    copyUnavailable.value = !success
    if (success) feedbackTimer = setTimeout(() => { copied.value = false }, 2500)
  }
  watch(() => props.orderNo, () => {
    generation++
    stopPress()
    clearTimeout(feedbackTimer)
    copied.value = false
    copyUnavailable.value = false
    suppressClick = false
  })
  onBeforeUnmount(() => {
    disposed = true
    generation++
    stopPress()
    clearTimeout(feedbackTimer)
  })
</script>
