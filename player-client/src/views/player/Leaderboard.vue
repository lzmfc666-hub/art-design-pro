<template>
  <section class="p-page p-rank-page">
    <div class="p-row p-rank-toolbar"
      ><div class="p-segments"
        ><button :class="{ active: type === 'orders' }" @click="type = 'orders'"
          ><PlayerIcon name="rank" />接单排行</button
        ><button :class="{ active: type === 'withdrawals' }" @click="type = 'withdrawals'"
          ><PlayerIcon name="wallet" />提现排行</button
        ></div
      ><label class="p-month-label"
        ><span>排行月份</span
        ><input v-model="month" type="month" :max="currentMonth()" aria-label="排行月份" /></label
    ></div>
    <PlayerState
      :loading="resource.loading.value"
      :error="resource.error.value"
      :online="resource.online.value"
      :empty="!resource.data.value?.records.length"
      empty-text="本月暂无成绩"
      hint="有效完成订单或财务登记发放后会计入排行"
      @retry="resource.refresh()"
    />
    <template v-if="resource.data.value">
      <div v-if="page === 1 && resource.data.value.records.length" class="p-podium p-rank-podium"
        ><div
          v-for="item in podium"
          :key="item.userId"
          :class="`p-podium-item p-place-${item.rank} p-podium-${item.position}`"
          ><div class="p-rank-medal"
            ><PlayerIcon v-if="item.rank === 1" class="p-crown" name="rank" /><span>{{
              item.rank
            }}</span></div
          ><img v-if="item.avatar" :src="item.avatar.url" class="p-avatar" alt="" /><span
            v-else
            class="p-avatar"
            >{{ item.name.slice(0, 1) }}</span
          ><strong class="p-rank-name">{{ item.name }}</strong
          ><span class="p-rank-score">{{ score(item) }}</span></div
        ></div
      >
      <div class="p-card p-my-rank"
        ><PlayerIcon name="rank" /><div
          ><span>我的排名</span
          ><strong>{{
            resource.data.value.myRank ? `第 ${resource.data.value.myRank.rank} 名` : '暂未上榜'
          }}</strong></div
        ><b>{{
          resource.data.value.myRank
            ? score(resource.data.value.myRank)
            : type === 'orders'
              ? '0 单'
              : '¥ 0.00'
        }}</b></div
      >
      <div v-if="listRecords.length" class="p-card p-rank-list"
        ><div class="p-section-title"
          ><h3>完整榜单</h3><span class="p-muted">{{ resource.data.value.total }} 人</span></div
        ><div
          v-for="item in listRecords"
          :key="item.userId"
          class="p-rank-row"
          :class="{ mine: item.userId === studio.user?.id }"
          ><span class="p-rank-number" :class="`rank-${item.rank}`">{{ item.rank }}</span
          ><img v-if="item.avatar" :src="item.avatar.url" class="p-avatar" alt="" /><span
            v-else
            class="p-avatar"
            >{{ item.name.slice(0, 1) }}</span
          ><strong>{{ item.name }}<small v-if="item.userId === studio.user?.id">我</small></strong
          ><b>{{ score(item) }}</b></div
        ></div
      >
      <PlayerPagination :current="resource.data.value.current" :size="resource.data.value.size" :total="resource.data.value.total" :busy="resource.loading.value" @change="page = $event" />
      <p class="p-hint p-center">{{
        resource.data.value.rankingRule || '相同成绩并列名次，下一名顺延。'
      }}</p>
    </template>
    <p class="p-hint p-center">{{
      type === 'orders'
        ? '仅计负责人有效完成订单。全额退款、取消和未完成订单不计。'
        : '按财务实际登记发放的月份统计，不含待审核、待发放和押金。'
    }}</p>
  </section>
</template>
<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { playerApi } from '@/api/player'
  import { useSessionStore } from '@/stores/session'
  import type { PlayerLeaderboard, PlayerRank } from '@/types/player'
  import { usePlayerResource, currentMonth, money } from './usePlayer'
  import PlayerState from './PlayerState.vue'
  import PlayerIcon from './PlayerIcon.vue'
  import PlayerPagination from './PlayerPagination.vue'
  defineOptions({ name: 'PlayerLeaderboard' })
  const studio = useSessionStore(),
    month = ref(currentMonth()),
    page = ref(1),
    type = ref<'orders' | 'withdrawals'>('orders')
  const resource = usePlayerResource<PlayerLeaderboard | null>(
    signal => playerApi.leaderboard(month.value, type.value, page.value, signal),
    null, true, { topics: ['ranking', 'orders', 'wallet'] }
  )
  watch([month, type], () => {
    if (page.value !== 1) {
      page.value = 1
      return
    }
    reloadQuery()
  })
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
  // Positions affect layout only; medal numbers keep the server's shared ranks.
  const podium = computed(() =>
    (resource.data.value?.records.slice(0, 3) || [])
      .map((item, index) => ({
        ...item,
        position:
          index === 0 ? ('center' as const) : index === 1 ? ('left' as const) : ('right' as const)
      }))
      .sort(
        (a, b) =>
          ({ left: 0, center: 1, right: 2 })[a.position] -
          { left: 0, center: 1, right: 2 }[b.position]
      )
  )
  const listRecords = computed(
    () => resource.data.value?.records.slice(page.value === 1 ? 3 : 0) || []
  )
  const score = (item: PlayerRank) =>
    type.value === 'orders' ? `${item.orderCount || 0} 单` : `¥ ${money(item.amount)}`
</script>
