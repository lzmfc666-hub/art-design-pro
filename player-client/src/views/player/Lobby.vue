<template>
  <section class="p-page p-lobby-page" :aria-busy="!!busy || resource.loading.value">
    <LobbyPublications />
    <div class="p-segments p-tab-strip"
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
      <div class="p-lobby-quota p-row">
        <span v-if="profile.data.value">
          执行中 {{ profile.data.value.activeOrders }} / {{ profile.data.value.maxActiveOrders }} 单
          <small> · 共 {{ resource.data.value?.total ?? '—' }} 个订单</small>
        </span>
        <span v-else>{{ profile.error.value ? '接单名额暂未获取' : '接单名额加载中…' }}</span>
        <button class="p-icon-btn" aria-label="刷新订单" @click="refresh">
          <PlayerIcon name="refresh" />
        </button>
      </div>
      <div v-if="profile.data.value && quotaWarning" class="p-notice p-warning">{{
        profile.data.value.user.playerAccess?.claim === false
          ? '接单权限已关闭，已有任务仍可提交。'
          : '当前执行名额已满，暂停新增接单。已有任务仍可查看，待验收后释放名额。'
      }}</div>
      <OperationState :operation="claimOperation.operation.value" :online="resource.online.value && !busy" @check="checkClaim" @retry="retryClaim" />
      <PlayerState
        :loading="resource.loading.value && !resource.data.value"
        :error="resource.error.value || profile.error.value || actionError"
        :online="resource.online.value"
        :empty="!!resource.data.value && !resource.data.value.records.length"
        empty-text="暂时没有可接订单"
        hint="指定订单和等级开放的公共订单会显示在这里"
        @retry="refresh"
      />
      <OrderCard
        v-for="order in resource.data.value?.records || []"
        :key="order.id"
        :order="order"
        claim
        :busy="busy === order.id || claimOperation.pending.value"
        :allowed="!busy && resource.online.value && !resource.stale.value && !claimOperation.pending.value"
        @claim="claim"
      />
      <PlayerPagination v-if="resource.data.value" :current="resource.data.value.current" :size="resource.data.value.size" :total="resource.data.value.total" :busy="resource.loading.value || claimOperation.pending.value" @change="page = $event" />
      <p class="p-hint p-center">接单中占用名额，待验收释放名额。申请退单期间仍占用。</p>
    </div>
  </section>
</template>
<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { playerApi } from '@/api/player'
  import type { PlayerOrder, PlayerProfile, PlayerOrderPage, PlayerOrderQuery } from '@/types/player'
  import { captureOperation, operationMessage, usePlayerOperation } from '@/api/operations'
  import { dispatchTarget } from '@/api/orderTarget'
  import { invalidatePlayerReads } from '@/api/readScheduler'
  import { usePlayerResource } from './usePlayer'
  import PlayerIcon from './PlayerIcon.vue'
  import PlayerState from './PlayerState.vue'
  import OrderCard from './OrderCard.vue'
  import LobbyPublications from './LobbyPublications.vue'
  import OperationState from './OperationState.vue'
  import PlayerPagination from './PlayerPagination.vue'
  defineOptions({ name: 'PlayerLobby' })
  const filter = ref<PlayerOrderQuery['scope']>('all'),
    page = ref(1),
    busy = ref(''),
    actionError = ref('')
  const resource = usePlayerResource<PlayerOrderPage | null>(
    signal => playerApi.ordersPage({ current: page.value, size: 20, scope: filter.value, status: 'pending' }, signal),
    null, true, { topics: ['orders'] }
  )
  const profile = usePlayerResource<PlayerProfile | null>(playerApi.profile, null, true, { topics: ['profile', 'orders'] })
  const claimOperation = usePlayerOperation('claim')
  const filters: { value: PlayerOrderQuery['scope']; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'direct', label: '指定给我' },
    { value: 'pool', label: '公共订单' }
  ]
  const quotaWarning = computed(
    () =>
      !!profile.data.value &&
      (profile.data.value.user.playerAccess?.claim === false ||
      profile.data.value.activeOrders >= profile.data.value.maxActiveOrders)
  )
  watch(filter, () => {
    if (page.value !== 1) page.value = 1
    else reloadQuery()
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
  async function refresh() {
    actionError.value = ''
    await Promise.all([resource.refresh(), profile.refresh()])
  }
  async function claim(snapshot: Readonly<PlayerOrder>) {
    if (busy.value || claimOperation.pending.value) return
    busy.value = snapshot.id
    actionError.value = ''
    try {
      if (!resource.online.value || resource.stale.value || snapshot.canClaim !== true) {
        actionError.value = '请刷新订单状态后重新确认'
        return
      }
      const intent = captureOperation('claim', `player/orders/${encodeURIComponent(snapshot.id)}/claim`, dispatchTarget(snapshot))
      const result = await claimOperation.execute(intent)
      if (result?.state === 'confirmed') await invalidatePlayerReads()
      else if (result?.state === 'rejected') await refresh()
    } catch (cause) {
      actionError.value = operationMessage(cause)
      await resource.refresh(true)
    } finally {
      busy.value = ''
    }
  }
  async function checkClaim() {
    if (busy.value) return
    busy.value = 'checking'
    try { const result = await claimOperation.check(); if (result?.state === 'confirmed') await invalidatePlayerReads() }
    finally { busy.value = '' }
  }
  async function retryClaim() {
    if (busy.value) return
    busy.value = 'retrying'
    try {
      const result = await claimOperation.retryOriginal()
      if (result?.state === 'confirmed') await invalidatePlayerReads()
      else if (result?.state === 'rejected') await refresh()
    } finally { busy.value = '' }
  }
</script>
