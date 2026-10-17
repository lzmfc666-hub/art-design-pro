<template>
  <section class="p-page p-tasks-page">
    <div class="p-task-search" role="search">
      <PlayerIcon name="search" />
      <input
        v-model="query"
        type="search"
        maxlength="100"
        autocomplete="off"
        :aria-label="scope === 'mine' ? '搜索本人参与历史' : '搜索全部授权任务'"
        placeholder="搜索全部页的订单号或任务标题"
      />
      <button
        v-if="query"
        type="button"
        class="p-icon-btn"
        aria-label="清除任务搜索"
        @click="query = ''"
        ><PlayerIcon name="close"
      /></button>
    </div>
    <div class="p-segments p-tab-strip" aria-label="任务搜索范围">
      <button :class="{ active: scope === 'mine' }" :aria-pressed="scope === 'mine'" @click="scope = 'mine'">本人参与历史</button>
      <button :class="{ active: scope === 'all' }" :aria-pressed="scope === 'all'" @click="scope = 'all'">全部授权任务</button>
    </div>
    <div class="p-segments p-scroll-segments p-tab-strip"
      ><button
        v-for="item in filters"
        :key="item.value"
        :class="{ active: filter === item.value }"
        :aria-pressed="filter === item.value"
        @click="filter = item.value"
        >{{ item.label }}</button
      ></div
    >
    <div class="p-page-body">
      <p class="p-hint">{{ scope === 'mine' ? '搜索本人当前任务及参与历史' : '搜索全部当前授权任务' }}，匹配全部页的标题与工作室订单号。历史摘要不会恢复私人详情或操作权限。</p>
      <div class="p-task-summary p-task-summary-compact"
        ><div
          ><strong>{{ count('active') }}</strong
          ><span>接单中</span></div
        ><div
          ><strong>{{ count('review') }}</strong
          ><span>待验收</span></div
        ><div
          ><strong>{{ count('completed') }}</strong
          ><span>已完成</span></div
        ></div
      >
      <PlayerState
        :loading="resource.loading.value && !resource.data.value"
        :error="resource.error.value"
        :online="resource.online.value"
        :empty="!!resource.data.value && !orders.length"
        :empty-text="searchTerm ? '没有匹配的任务' : '这里还没有任务'"
        :hint="
          searchTerm
            ? '可尝试其他订单号、任务标题或任务状态，搜索覆盖所选范围的全部页'
            : '接取的任务与实际参与的双人任务会显示在这里'
        "
        @retry="resource.refresh()"
      />
      <OrderCard v-for="order in orders" :key="order.id" :order="order" />
      <PlayerPagination v-if="resource.data.value" :current="resource.data.value.current" :size="resource.data.value.size" :total="resource.data.value.total" :busy="resource.loading.value" @change="page = $event" />
    </div>
  </section>
</template>
<script setup lang="ts">
  import { computed, ref, watch, onBeforeUnmount } from 'vue'
  import { useRoute } from 'vue-router'
  import { playerApi } from '@/api/player'
  import type { PlayerOrderPage, PlayerOrderQuery } from '@/types/player'
  import { usePlayerResource } from './usePlayer'
  import PlayerState from './PlayerState.vue'
  import PlayerIcon from './PlayerIcon.vue'
  import OrderCard from './OrderCard.vue'
  import PlayerPagination from './PlayerPagination.vue'
  defineOptions({ name: 'PlayerTasks' })
  const route = useRoute(),
    filter = ref('active'),
    page = ref(1),
    query = ref(''),
    keyword = ref(''),
    scope = ref<'mine' | 'all'>('mine')
  const resource = usePlayerResource<PlayerOrderPage | null>(
    signal => playerApi.ordersPage({ current: page.value, size: 20, scope: scope.value, keyword: keyword.value,
      ...(scope.value === 'mine' ? { sortBy: 'participatedAt' as const } : {}),
      ...(filter.value === 'all' ? {} : { status: filter.value as PlayerOrderQuery['status'] }) }, signal),
    null, true, { topics: ['orders'] }
  )
  const count = (status: string) => {
    const value = resource.data.value?.counts?.[status]
    return typeof value === 'number' ? value : '—'
  }
  const searchTerm = computed(() => keyword.value)
  const orders = computed(() => resource.data.value?.records || [])
  const filters = [
    { value: 'active', label: '接单中' },
    { value: 'review', label: '待验收' },
    { value: 'completed', label: '已完成' },
    { value: 'stored', label: '存单' },
    { value: 'problem', label: '问题单' },
    { value: 'refund-pending', label: '退款审批中' },
    { value: 'refunded', label: '已退款' },
    { value: 'all', label: '全部' }
  ]
  watch([filter, scope], () => {
    if (page.value !== 1) page.value = 1
    else reloadQuery()
  })
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  watch(query, value => {
    clearTimeout(searchTimer)
    resource.cancel()
    resource.data.value = null
    searchTimer = setTimeout(() => {
      keyword.value = value.trim()
      if (page.value !== 1) page.value = 1
      else reloadQuery()
    }, 300)
  })
  onBeforeUnmount(() => clearTimeout(searchTimer))
  watch(page, reloadQuery)
  watch(() => resource.data.value, result => {
    if (result && page.value > Math.max(1, Math.ceil(result.total / result.size))) {
      page.value = Math.max(1, Math.ceil(result.total / result.size))
    }
  })
  function reloadQuery() {
    resource.cancel()
    resource.data.value = null
    void resource.refresh()
  }
  watch(
    () => route.query.status,
    (status) => {
      if (typeof status === 'string' && filters.some((item) => item.value === status)) {
        filter.value = status
        query.value = ''
      }
    },
    { immediate: true }
  )
</script>
