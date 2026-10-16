<template>
  <div
    class="player-app"
    :class="{ 'p-solid': !(appearance.publicSaved || appearance.effective).glass.enabled, 'p-keyboard-open': keyboardOpen }"
    :style="viewportStyle"
  >
    <header class="p-header">
      <div class="p-header-content p-template-header">
        <span v-if="isTab" class="p-header-spacer" aria-hidden="true" />
        <button v-else class="p-icon-btn" aria-label="返回" @click="back">
          <PlayerIcon name="back" />
        </button>
        <h1 class="p-header-heading">{{ title }}</h1>
        <RouterLink
          v-if="route.path !== '/player/messages'"
          to="/player/messages"
          class="p-icon-btn p-bell"
          aria-label="消息中心"
          ><PlayerIcon name="bell" /><span v-if="unreadCount" class="p-dot"
        /></RouterLink>
        <span v-else class="p-header-spacer" aria-hidden="true" />
      </div>
    </header>
    <main ref="scroller" class="p-main">
      <div v-if="playerReadFailure" class="p-error" role="status">
        {{ playerReadFailure }}
        <button class="p-link-btn" @click="reconcilePlayerReads">核对最新状态</button>
      </div>
      <RouterView v-slot="{ Component }"
        ><KeepAlive include="PlayerLobby,PlayerTasks,PlayerLeaderboard,PlayerMe"
          ><component :is="Component" /></KeepAlive
      ></RouterView>
    </main>
    <nav class="p-nav" aria-label="主导航">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.path"
        :to="tab.path"
        :class="{ active: activeTab === tab.path }"
        ><PlayerIcon :name="tab.icon" /><span>{{ tab.label }}</span></RouterLink
      >
    </nav>
  </div>
</template>
<script setup lang="ts">
  import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { useAppearanceStore } from '@/stores/appearance'
  import { useSessionStore } from '@/stores/session'
  import { playerApi } from '@/api/player'
  import { playerReadFailure, reconcilePlayerReads, registerPlayerReader, setPlayerSummaryProvider } from '@/api/readScheduler'
  import { useMobileViewport } from '@/composables/useMobileViewport'
  import PlayerIcon from './PlayerIcon.vue'
  import './player.css'
  const route = useRoute(),
    router = useRouter(),
    appearance = useAppearanceStore(),
    session = useSessionStore()
  const title = computed(() => String(route.meta.title || '打手端'))
  const tabs = [
    { path: '/player/lobby', label: '接单大厅', icon: 'lobby' },
    { path: '/player/tasks', label: '我的任务', icon: 'tasks' },
    { path: '/player/rank', label: '排行榜', icon: 'rank' },
    { path: '/player/me', label: '我的', icon: 'me' }
  ]
  const isTab = computed(() => tabs.some((tab) => tab.path === route.path))
  const activeTab = computed(() =>
    isTab.value
      ? route.path
      : route.path.startsWith('/player/content')
        ? '/player/lobby'
        : route.path.startsWith('/player/orders')
          ? '/player/tasks'
          : '/player/me'
  )
  const scroller = ref<HTMLElement>()
  const { viewportStyle, keyboardOpen } = useMobileViewport(scroller)
  const positions = new Map<string, number>()
  const unreadCount = ref(0)
  let since: string | number | undefined
  const disposeSummary = setPlayerSummaryProvider(async (signal) => {
    const summary = await playerApi.changes(since, signal)
    if (signal.aborted) throw new DOMException('读取已取消', 'AbortError')
    // The summary includes permission changes in its version but does not expose permissions.
    // Re-read the documented session before promoting changed business data.
    if (summary.changed) {
      const user = await session.checkSession(true, signal)
      if (!user) void router.replace('/player/login')
      if (!user || signal.aborted) throw new DOMException('账号核验已变化', 'AbortError')
    }
    since = summary.version
    unreadCount.value = summary.unreadCount
    appearance.notePlayerRevision(summary.appearanceRevision)
    return { version: summary.version, changed: summary.changed }
  })
  let unregisterSummary: (() => void) | undefined
  const showsOrderCards = () => route.path === '/player/lobby' || route.path === '/player/tasks'
  onMounted(() => {
    // Keep the lightweight summary active even when the current page has no polling resources.
    unregisterSummary = registerPlayerReader({ topics: ['appearance'],
      active: showsOrderCards, needsRefresh: appearance.needsPlayerRefresh, refreshOnWake: true,
      refresh: (_changed, context) => appearance.loadPlayer(context?.revalidate, context?.signal),
      onPause: appearance.cancelPlayerRead })
  })
  onUnmounted(() => { disposeSummary(); unregisterSummary?.(); appearance.cancelPlayerRead(); positions.clear() })
  watch(() => route.path, () => {
    if (showsOrderCards()) void appearance.loadPlayer(true)
    else appearance.cancelPlayerRead()
  }, { immediate: true })
  watch(
    () => route.path,
    async (path, previous) => {
      if (scroller.value) positions.set(previous, scroller.value.scrollTop)
      await nextTick()
      if (scroller.value) scroller.value.scrollTop = positions.get(path) || 0
    },
    { flush: 'pre' }
  )
  function back() {
    if (window.history.state?.back?.startsWith('/player')) router.back()
    else void router.push(activeTab.value)
  }
</script>
