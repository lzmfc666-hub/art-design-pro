<template>
  <article class="p-card p-order-card">
    <div class="p-order-card-header">
      <OrderNumber :order-no="order.orderNo" />
      <span class="p-badge" :class="order.displayStatus || order.status">{{
        order.dispatchState === 'unassigned' && (order.displayStatus || order.status) === 'pending'
          ? '客服待分配'
          : orderStatus[order.displayStatus || order.status]
      }}</span>
    </div>
    <div class="p-order-card-main">
      <div class="p-order-thumb" aria-hidden="true">
        <PrivateImage v-if="appearance.orderCardImage && failedImageKey !== appearance.playerImageKey"
          :key="appearance.playerImageKey" :src="appearance.orderCardImage.url" :context="appearance.playerImageKey"
          alt="" @error="failedImageKey = appearance.playerImageKey" />
        <PlayerIcon v-else name="game" />
      </div>
      <div class="p-order-details">
        <div class="p-order-heading">
          <span v-if="order.historyOnly" class="p-order-title">{{ order.title }}</span>
          <RouterLink v-else :to="`/player/orders/${order.id}`" class="p-order-title">{{
            order.title
          }}</RouterLink>
        </div>
        <div v-if="order.requirements" class="p-order-description-block">
          <p
            ref="requirementsText"
            class="p-order-description"
            :class="{ 'p-order-description-expanded': requirementsExpanded }"
          >
            <span class="p-order-description-label">任务要求：</span>{{ order.requirements }}
          </p>
          <button
            v-if="requirementsOverflow || requirementsExpanded"
            type="button"
            class="p-text-btn p-description-toggle"
            :aria-expanded="requirementsExpanded"
            @click="requirementsExpanded = !requirementsExpanded"
            >{{ requirementsExpanded ? '收起任务要求' : '展开任务要求' }}</button
          >
        </div>
        <div v-if="order.playerRemark" class="p-order-description-block">
          <p
            ref="remarkText"
            class="p-order-description"
            :class="{ 'p-order-description-expanded': remarkExpanded }"
          >
            <span class="p-order-description-label">打手备注：</span>{{ order.playerRemark }}
          </p>
          <button
            v-if="remarkOverflow || remarkExpanded"
            type="button"
            class="p-text-btn p-description-toggle"
            :aria-expanded="remarkExpanded"
            @click="remarkExpanded = !remarkExpanded"
            >{{ remarkExpanded ? '收起打手备注' : '展开打手备注' }}</button
          >
        </div>
        <div class="p-order-meta">
          <span class="p-muted">{{ dateTime(order.publishedAt || order.createdAt) }}</span>
        </div>
        <div v-if="order.map || isAssignedDirect || hasPendingReturn || order.participation === 'historical' || order.problem?.status === 'open' || order.capacityExempt" class="p-tags">
          <span v-if="order.map">{{ order.map }}</span>
          <span v-if="isAssignedDirect" class="p-tag-blue">指定给我</span>
          <span v-if="hasPendingReturn" class="p-tag-orange">退单处理中</span>
          <span v-if="order.participation === 'historical'" class="p-tag-blue">历史参与</span>
          <span v-if="order.problem?.status === 'open'" class="p-tag-orange">问题单</span>
          <span v-if="order.capacityExempt" class="p-tag-blue">存单续做 · 不占名额</span>
        </div>
        <p v-if="order.historyOnly" class="p-hint">仅保留参与摘要，当前无私人详情及操作权限。{{ order.lastParticipationAt ? `最后参与 ${dateTime(order.lastParticipationAt)}` : '' }}</p>
      </div>
    </div>
    <p v-if="readOnlyReason" class="p-hint">{{ readOnlyReason.message }}</p>
    <p v-else-if="order.status === 'pending' && !claimable" class="p-hint">{{
      order.claimBlockedReason?.message || order.claimReason ||
      (!hasDispatchVersion ? '订单信息尚未更新，请刷新后重新确认' : '') ||
      (order.availableAt && new Date(order.availableAt).getTime() > Date.now()
        ? `开放时间 ${dateTime(order.availableAt)}`
        : '当前无法接单，请查看个人接单权限与名额')
    }}</p>
    <div class="p-row p-order-footer p-order-footer-actions">
      <div class="p-reward"
        ><small>订单报酬</small><strong>¥ {{ money(order.reward) }}</strong></div
      >
      <span v-if="order.historyOnly" class="p-muted">历史摘要</span>
      <div v-else-if="claim" class="p-order-action-group"
        ><RouterLink
          v-if="isAssignedDirect"
          :to="`/player/orders/${order.id}?action=reject`"
          class="p-btn p-secondary"
          >拒绝</RouterLink
        ><button
          class="p-btn p-primary"
          :disabled="busy || claimQueued || !claimable"
          @click="requestClaim"
          >{{
            busy || claimQueued ? '正在接单…' : order.dispatchMode === 'direct' ? '接受订单' : '立即接单'
          }}</button
        ></div
      >
      <RouterLink v-else :to="`/player/orders/${order.id}`" class="p-btn p-primary"
        >查看任务</RouterLink
      >
    </div>
  </article>
</template>
<script setup lang="ts">
  import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
  import type { PlayerOrder } from '@/types/player'
  import { money, dateTime, orderStatus } from './usePlayer'
  import PlayerIcon from './PlayerIcon.vue'
  import OrderNumber from './OrderNumber.vue'
  import { useAppearanceStore } from '@/stores/appearance'
  import PrivateImage from './PrivateImage.vue'
  import { playerOrderBlockedReason } from '@/api/orderAccess'
  const props = defineProps<{
    order: PlayerOrder
    claim?: boolean
    busy?: boolean
    allowed?: boolean
  }>()
  const emit = defineEmits<{ claim: [order: Readonly<PlayerOrder>] }>()
  const appearance = useAppearanceStore()
  const readOnlyReason = computed(() => playerOrderBlockedReason(props.order))
  const failedImageKey = ref('')
  const claimQueued = ref(false)
  const requirementsExpanded = ref(false), remarkExpanded = ref(false)
  const requirementsText = ref<HTMLElement>(), remarkText = ref<HTMLElement>()
  const requirementsOverflow = ref(false), remarkOverflow = ref(false)
  let textObserver: ResizeObserver | undefined

  function measureDescriptions() {
    if (!requirementsExpanded.value) {
      const element = requirementsText.value
      requirementsOverflow.value = !!element && element.scrollHeight > element.clientHeight + 1
    }
    if (!remarkExpanded.value) {
      const element = remarkText.value
      remarkOverflow.value = !!element && element.scrollHeight > element.clientHeight + 1
    }
  }
  async function observeDescriptions() {
    await nextTick()
    textObserver?.disconnect()
    if (requirementsText.value) textObserver?.observe(requirementsText.value)
    if (remarkText.value) textObserver?.observe(remarkText.value)
    measureDescriptions()
  }
  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      textObserver = new ResizeObserver(measureDescriptions)
    }
    void observeDescriptions()
  })
  onBeforeUnmount(() => textObserver?.disconnect())
  watch(
    () => [props.order.id, props.order.revision, props.order.dispatchRound, props.order.assignmentId],
    () => {
      claimQueued.value = false
      requirementsExpanded.value = false
      remarkExpanded.value = false
      void observeDescriptions()
    }
  )
  watch(() => [props.order.requirements, props.order.playerRemark], () => void observeDescriptions())
  watch(() => props.busy, (busy, wasBusy) => {
    if (!busy && wasBusy) claimQueued.value = false
  })
  watch([requirementsExpanded, remarkExpanded], () => void nextTick(measureDescriptions))
  const hasDispatchVersion = computed(() =>
    Number.isSafeInteger(props.order.revision) && Number.isSafeInteger(props.order.dispatchRound)
  )
  const claimable = computed(
    () =>
      props.allowed !== false &&
      !props.order.historyOnly &&
      !readOnlyReason.value &&
      props.order.canClaim === true &&
      hasDispatchVersion.value
  )
  function requestClaim() {
    if (props.busy || claimQueued.value || !claimable.value) return
    // Capture the rendered target before any refresh can replace its identity or version.
    const snapshot = JSON.parse(JSON.stringify(props.order)) as PlayerOrder
    claimQueued.value = true
    emit('claim', Object.freeze(snapshot))
  }
  const hasPendingReturn = computed(() =>
    props.order.returnRequests?.some((item) => item.status === 'pending')
  )
  const isAssignedDirect = computed(
    () =>
      !props.order.historyOnly &&
      !readOnlyReason.value &&
      props.order.dispatchMode === 'direct' &&
      props.order.status === 'pending' &&
      props.order.dispatchState !== 'unassigned' &&
      !!props.order.assignedTo
  )
</script>
