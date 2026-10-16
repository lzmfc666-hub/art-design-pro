<template>
  <section
    v-if="currentAnnouncement"
    class="p-publication-notice"
    aria-label="工作室公告"
    @mouseenter="noticeHover = true"
    @mouseleave="noticeHover = false"
    @focusin="noticeFocus = true"
    @focusout="noticeFocus = false"
  >
    <span class="p-publication-icon"><PlayerIcon name="announcement" /></span>
    <RouterLink
      :to="contentPath(currentAnnouncement.id)"
      class="p-publication-link"
      :aria-label="`查看公告：${currentAnnouncement.title}`"
    >
      <small
        >工作室公告
        <span v-if="announcements.length > 1"
          >{{ announcementIndex + 1 }} / {{ announcements.length }}</span
        ></small
      >
      <span ref="noticeViewport" class="p-publication-viewport">
        <span
          ref="noticeText"
          :key="currentAnnouncement.id"
          class="p-publication-text"
          :class="{ 'is-scrolling': noticeOverflow > 0 && !reducedMotion }"
          :style="noticeStyle"
          >{{ currentAnnouncement.text || currentAnnouncement.title }}</span
        >
      </span>
    </RouterLink>
    <div class="p-publication-controls">
      <button
        v-if="!reducedMotion && (noticeOverflow > 0 || announcements.length > 1)"
        class="p-content-control"
        :aria-label="noticePaused ? '继续公告滚动' : '暂停公告滚动'"
        :aria-pressed="noticePaused"
        @click="noticePaused = !noticePaused"
        >{{ noticePaused ? '继续' : '暂停' }}</button
      >
      <button
        v-if="announcements.length > 1"
        class="p-content-control"
        aria-label="下一条公告"
        @click="nextAnnouncement"
        >下一条</button
      >
    </div>
  </section>
  <section
    v-if="currentBanner"
    class="p-banner-carousel"
    aria-roledescription="轮播图"
    aria-label="工作室板报"
    @mouseenter="bannerHover = true"
    @mouseleave="bannerHover = false"
    @focusin="bannerFocus = true"
    @focusout="bannerFocus = false"
  >
    <RouterLink
      :to="contentPath(currentBanner.id)"
      class="p-banner-slide"
      :aria-label="`查看板报：${currentBanner.title}`"
      @touchstart.passive="touchStart"
      @touchend="touchEnd"
      @click.capture="guardSwipeClick"
    >
      <img
        v-if="bannerImage && !failedImages.has(bannerImage)"
        :key="bannerImage"
        :src="bannerImage"
        :alt="currentBanner.title"
        draggable="false"
        @error="failedImages.add(bannerImage)"
      />
      <span v-else class="p-banner-fallback"
        ><PlayerIcon name="image" /><span>{{ currentBanner.title }}</span></span
      >
      <span class="p-banner-caption"
        ><strong>{{ currentBanner.title }}</strong>
        <span v-if="currentBanner.text">{{ currentBanner.text }}</span></span
      >
    </RouterLink>
    <div v-if="banners.length > 1" class="p-banner-tools">
      <button class="p-content-control" aria-label="上一张板报" @click="moveBanner(-1)"
        ><PlayerIcon name="back"
      /></button>
      <div class="p-banner-dots" aria-label="选择板报">
        <button
          v-for="(item, index) in banners"
          :key="item.id"
          :class="{ active: bannerIndex === index }"
          :aria-label="`第 ${index + 1} 张板报：${item.title}`"
          :aria-current="bannerIndex === index ? 'true' : undefined"
          @click="bannerIndex = index"
        />
      </div>
      <button class="p-content-control" aria-label="下一张板报" @click="moveBanner(1)"
        ><PlayerIcon name="next"
      /></button>
      <button
        v-if="!reducedMotion"
        class="p-content-control p-banner-pause"
        :aria-pressed="bannerPaused"
        :aria-label="bannerPaused ? '继续轮播' : '暂停轮播'"
        @click="bannerPaused = !bannerPaused"
        >{{ bannerPaused ? '继续' : '暂停' }}</button
      >
    </div>
  </section>
</template>
<script setup lang="ts">
  import {
    computed,
    nextTick,
    onActivated,
    onDeactivated,
    onMounted,
    onUnmounted,
    reactive,
    ref,
    watch
  } from 'vue'
  import { contentImageUrl } from '@/api/content'
  import { usePlayerContent } from './usePlayerContent'
  import PlayerIcon from './PlayerIcon.vue'
  import './content.css'

  const { announcements, banners, isActive, visible, loadedRevision } = usePlayerContent()
  const announcementIndex = ref(0),
    bannerIndex = ref(0)
  const currentAnnouncement = computed(() => announcements.value[announcementIndex.value])
  const currentBanner = computed(() => banners.value[bannerIndex.value])
  const bannerImage = computed(() => contentImageUrl(currentBanner.value))
  const noticePaused = ref(false),
    bannerPaused = ref(false)
  const noticeHover = ref(false),
    bannerHover = ref(false),
    noticeFocus = ref(false),
    bannerFocus = ref(false)
  const reducedMotion = ref(false),
    noticeOverflow = ref(0)
  const noticeViewport = ref<HTMLElement>(),
    noticeText = ref<HTMLElement>()
  const failedImages = reactive(new Set<string>())
  // Retry transient picture failures after a successful feed refresh, never on each clock tick.
  watch(loadedRevision, () => failedImages.clear())
  let noticeTimer: ReturnType<typeof setTimeout> | undefined,
    bannerTimer: ReturnType<typeof setTimeout> | undefined,
    resizeObserver: ResizeObserver | undefined,
    media: MediaQueryList | undefined,
    touchX = 0,
    touchY = 0,
    swipeAt = -Infinity
  const canAnimate = computed(() => isActive.value && visible.value && !reducedMotion.value)
  const noticeStopped = computed(
    () => !canAnimate.value || noticePaused.value || noticeHover.value || noticeFocus.value
  )
  const bannerStopped = computed(
    () => !canAnimate.value || bannerPaused.value || bannerHover.value || bannerFocus.value
  )
  const noticeDuration = computed(() => Math.max(10000, (noticeOverflow.value / 24) * 1000 + 8000))
  const noticeStyle = computed(() => ({
    '--p-notice-travel': `-${noticeOverflow.value}px`,
    '--p-notice-duration': `${noticeDuration.value}ms`,
    animationPlayState: noticeStopped.value ? 'paused' : 'running'
  }))
  const contentPath = (id: string) => `/player/content/${encodeURIComponent(id)}`
  function nextAnnouncement() {
    announcementIndex.value =
      (announcementIndex.value + 1) % Math.max(1, announcements.value.length)
  }
  function moveBanner(direction: number) {
    bannerIndex.value =
      (bannerIndex.value + direction + banners.value.length) % Math.max(1, banners.value.length)
  }
  async function measureNotice() {
    await nextTick()
    resizeObserver?.disconnect()
    if (!isActive.value) return
    noticeOverflow.value = Math.max(
      0,
      (noticeText.value?.scrollWidth || 0) - (noticeViewport.value?.clientWidth || 0)
    )
    if (noticeViewport.value) resizeObserver?.observe(noticeViewport.value)
  }
  function scheduleNotice() {
    clearTimeout(noticeTimer)
    if (!noticeStopped.value && announcements.value.length > 1)
      noticeTimer = setTimeout(nextAnnouncement, noticeDuration.value + 1000)
  }
  function scheduleBanner() {
    clearTimeout(bannerTimer)
    if (!bannerStopped.value && banners.value.length > 1)
      bannerTimer = setTimeout(() => moveBanner(1), 5000)
  }
  function touchStart(event: TouchEvent) {
    touchX = event.changedTouches[0]?.clientX || 0
    touchY = event.changedTouches[0]?.clientY || 0
  }
  function touchEnd(event: TouchEvent) {
    const dx = (event.changedTouches[0]?.clientX || 0) - touchX,
      dy = (event.changedTouches[0]?.clientY || 0) - touchY
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.3 && banners.value.length > 1) {
      event.preventDefault()
      swipeAt = performance.now()
      moveBanner(dx < 0 ? 1 : -1)
    }
  }
  function guardSwipeClick(event: MouseEvent) {
    if (performance.now() - swipeAt < 500) event.preventDefault()
  }
  function updateMotion() {
    reducedMotion.value = !!media?.matches
  }
  watch(
    () => announcements.value.map((item) => `${item.id}:${item.text}:${item.title}`).join('|'),
    () => {
      announcementIndex.value = 0
      void measureNotice()
      scheduleNotice()
    }
  )
  watch(
    () => banners.value.map((item) => item.id).join('|'),
    () => {
      bannerIndex.value = 0
      scheduleBanner()
    }
  )
  watch([announcementIndex, noticeDuration, noticeStopped], () => {
    void measureNotice()
    scheduleNotice()
  })
  watch([bannerIndex, bannerStopped], scheduleBanner)
  watch(isActive, (active) => {
    if (active) void measureNotice()
    else resizeObserver?.disconnect()
  })
  onMounted(() => {
    media = window.matchMedia('(prefers-reduced-motion: reduce)')
    updateMotion()
    media.addEventListener('change', updateMotion)
    resizeObserver = new ResizeObserver(() => {
      noticeOverflow.value = Math.max(
        0,
        (noticeText.value?.scrollWidth || 0) - (noticeViewport.value?.clientWidth || 0)
      )
    })
    void measureNotice()
  })
  onActivated(() => {
    noticeHover.value = bannerHover.value = noticeFocus.value = bannerFocus.value = false
    void measureNotice()
  })
  onDeactivated(() => {
    clearTimeout(noticeTimer)
    clearTimeout(bannerTimer)
    resizeObserver?.disconnect()
  })
  onUnmounted(() => {
    clearTimeout(noticeTimer)
    clearTimeout(bannerTimer)
    resizeObserver?.disconnect()
    media?.removeEventListener('change', updateMotion)
  })
</script>
