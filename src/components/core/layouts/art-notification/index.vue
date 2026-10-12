<!-- 原框架通知面板，业务内容来自当前账号的真实数据。 -->
<template>
  <div
    class="art-notification-panel art-card-sm !shadow-xl"
    :style="{ transform: show ? 'scaleY(1)' : 'scaleY(0.9)', opacity: show ? 1 : 0 }"
    v-show="visible"
    @click.stop
  >
    <div class="flex-cb px-3.5 mt-3.5">
      <span class="text-base font-medium text-g-800">业务通知</span>
      <ElButton link :loading="loading" @click="reload">刷新</ElButton>
    </div>
    <ul class="box-border flex items-end w-full h-12.5 px-3.5 border-b-d">
      <li
        v-for="(item, index) in barList"
        :key="item.name"
        class="h-12 leading-12 mr-5 overflow-hidden text-[13px] text-g-700 c-p select-none"
        :class="{ 'bar-active': barActiveIndex === index }"
        @click="barActiveIndex = index"
      >
        {{ item.name }} ({{ item.num }})
      </li>
    </ul>
    <div class="w-full h-[calc(100%-95px)] flex flex-col">
      <div class="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <p v-if="error" class="px-3.5 pt-3 text-xs text-danger" role="alert">{{ error }}</p>
        <ul v-if="currentItems.length">
          <li
            v-for="item in currentItems"
            :key="item.id"
            class="box-border flex-c px-3.5 py-3.5 c-p last:border-b-0 hover:bg-g-200/60"
            role="button"
            tabindex="0"
            @click="navigate(item)"
            @keydown.enter="navigate(item)"
            @keydown.space.prevent="navigate(item)"
          >
            <div
              class="size-9 shrink-0 leading-9 text-center rounded-lg flex-cc"
              :class="getNoticeClass(item.type)"
            >
              <ArtSvgIcon class="text-lg !bg-transparent" :icon="item.icon" />
            </div>
            <div class="min-w-0 flex-1 ml-3.5">
              <h4 class="text-sm font-normal leading-5.5 text-g-900 break-words">{{
                item.title
              }}</h4>
              <p class="mt-1.5 text-xs text-g-600 break-words">{{ item.description }}</p>
              <p class="mt-1.5 text-xs text-g-500">{{ formatTime(item.createdAt) }}</p>
            </div>
            <ArtSvgIcon icon="ri:arrow-right-s-line" class="ml-2 shrink-0 text-g-500" />
          </li>
        </ul>
        <div v-else class="pt-20 pb-10 text-g-500 text-center !bg-transparent">
          <ArtSvgIcon icon="system-uicons:inbox" class="text-5xl" />
          <p class="mt-3.5 text-xs !bg-transparent">{{ emptyDescription }}</p>
        </div>
      </div>
      <div class="box-border w-full px-3.5 py-3">
        <ElDropdown v-if="navigationTargets.length > 1" class="w-full" trigger="click">
          <ElButton class="w-full" v-ripple>
            进入相关模块
            <ArtSvgIcon icon="ri:arrow-down-s-line" class="ml-2" />
          </ElButton>
          <template #dropdown>
            <ElDropdownMenu>
              <ElDropdownItem
                v-for="target in navigationTargets"
                :key="target.label"
                @click="navigate(target)"
              >
                {{ target.label }}
              </ElDropdownItem>
            </ElDropdownMenu>
          </template>
        </ElDropdown>
        <ElButton
          v-else
          class="w-full"
          :disabled="!navigationTargets.length"
          @click="navigationTargets[0] && navigate(navigationTargets[0])"
          v-ripple
          >{{ navigationTargets[0]?.label || '暂无需要查看的记录' }}</ElButton
        >
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed, onUnmounted, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { useStudio, formatTime, money, statusLabels } from '@/hooks/business/useStudio'
  import { useBusinessTodo, type BusinessTodoTarget } from '@/hooks/business/useBusinessTodo'
  import type { Order } from '@/types/studio'

  defineOptions({ name: 'ArtNotification' })
  interface BusinessNotice extends BusinessTodoTarget {
    id: string
    title: string
    description: string
    createdAt: string
    icon: string
    type: 'primary' | 'warning' | 'danger' | 'success' | 'info'
  }
  const props = defineProps<{ value: boolean }>()
  const emit = defineEmits<{ 'update:value': [value: boolean] }>()
  const router = useRouter()
  const { data, user, can, refresh, loading, error } = useStudio()
  const { items: pendingList } = useBusinessTodo()
  const show = ref(false)
  const visible = ref(false)
  const barActiveIndex = ref(0)
  let animationTimer: ReturnType<typeof setTimeout> | undefined

  const isStaff = computed(() => Boolean(user.value && user.value.role !== 'player'))
  const orderTarget = (orderId: string): BusinessTodoTarget => ({
    path: '/orders/list',
    query: { id: orderId }
  })
  const settlementTarget = (tab: string): BusinessTodoTarget => ({
    path: '/finance/settlement',
    query: { tab }
  })
  function orderTime(order: Order) {
    if (order.status === 'completed') return order.completedAt || order.createdAt
    if (order.status === 'canceled') return order.canceledAt || order.createdAt
    if (order.status === 'review') return order.submissions.at(-1)?.submittedAt || order.createdAt
    if (order.status === 'active') {
      const submission = order.submissions.at(-1)
      return submission?.review === 'returned'
        ? submission.reviewedAt || submission.submittedAt
        : order.assignments.at(-1)?.acceptedAt || order.createdAt
    }
    return order.publishedAt || order.createdAt
  }
  const noticeList = computed<BusinessNotice[]>(() => {
    if (!isStaff.value || !can('orders.view')) return []
    return (data.value?.orders || [])
      .map(
        (order): BusinessNotice => ({
          id: `order:${order.id}`,
          title: `${order.orderNo} · ${statusLabels[order.status]}`,
          description: order.title,
          createdAt: orderTime(order),
          icon: 'ri:file-list-3-line',
          type:
            order.status === 'completed'
              ? 'success'
              : order.status === 'canceled'
                ? 'danger'
                : order.status === 'review'
                  ? 'warning'
                  : 'primary',
          ...orderTarget(order.id)
        })
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
  const resultList = computed<BusinessNotice[]>(() => {
    if (!isStaff.value || !data.value) return []
    const state = data.value
    const rows: BusinessNotice[] = []
    if (can('orders.view')) {
      for (const order of state.orders) {
        for (const submission of order.submissions.filter((item) => item.review)) {
          const passed = submission.review === 'passed'
          rows.push({
            id: `submission:${submission.id}`,
            title: `${order.orderNo} · ${passed ? '验收通过' : '完成材料已退回'}`,
            description: passed ? order.title : submission.reason || '请查看退回原因',
            createdAt: submission.reviewedAt || submission.submittedAt,
            icon: passed ? 'ri:checkbox-circle-line' : 'ri:arrow-go-back-line',
            type: passed ? 'success' : 'warning',
            ...orderTarget(order.id)
          })
        }
      }
    }
    if (can('finance.refunds') || can('orders.view')) {
      for (const refund of state.refunds.filter((item) => item.status !== 'pending')) {
        const paid = refund.status === 'paid'
        const order = state.orders.find((item) => item.id === refund.orderId)
        rows.push({
          id: `refund:${refund.id}`,
          title: `${order?.orderNo || '订单退款'} · ${paid ? '已登记退款' : '退款已驳回'}`,
          description: `${money(refund.amount)}，${refund.manualResolution || refund.reason}`,
          createdAt: refund.processedAt || refund.createdAt,
          icon: 'ri:refund-2-line',
          type: paid ? 'success' : 'danger',
          ...(can('finance.refunds') ? settlementTarget('refunds') : orderTarget(refund.orderId))
        })
      }
    }
    if (can('finance.withdrawals')) {
      const labels = { approved: '提现已审核', paid: '已登记打款', rejected: '提现已驳回' }
      for (const withdrawal of state.withdrawals) {
        if (withdrawal.status === 'pending') continue
        rows.push({
          id: `withdrawal:${withdrawal.id}`,
          title: `${state.users.find((staff) => staff.id === withdrawal.userId)?.name || '打手'} · ${labels[withdrawal.status]}`,
          description: `${money(withdrawal.amount)}${withdrawal.reason ? `，${withdrawal.reason}` : ''}`,
          createdAt: withdrawal.paidAt || withdrawal.processedAt || withdrawal.createdAt,
          icon: 'ri:bank-card-line',
          type: withdrawal.status === 'rejected' ? 'danger' : 'success',
          ...settlementTarget('withdrawals')
        })
      }
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
  const barList = computed(() => [
    { name: '订单动态', num: noticeList.value.length },
    { name: '处理结果', num: resultList.value.length },
    { name: '待办', num: pendingList.value.length }
  ])
  const currentItems = computed(
    () => [noticeList.value, resultList.value, pendingList.value][barActiveIndex.value] || []
  )
  const emptyDescription = computed(() =>
    barActiveIndex.value === 2 ? '当前没有需要处理的待办' : '当前账号暂无可查看的记录'
  )
  const navigationTargets = computed(() => {
    const targets = new Map<string, BusinessTodoTarget & { label: string }>()
    for (const item of currentItems.value) {
      const tab = item.query?.tab
      const key = `${item.path}:${tab || ''}`
      targets.set(key, {
        path: item.path,
        query: tab ? { tab } : undefined,
        label:
          item.path === '/orders/list'
            ? '查看订单管理'
            : tab === 'refunds'
              ? '查看客户退款'
              : tab === 'withdrawals'
                ? '查看打手提现'
                : '查看验收与取消补偿'
      })
    }
    return [...targets.values()]
  })
  const noticeClasses = {
    primary: 'bg-theme/12 text-theme',
    warning: 'bg-warning/12 text-warning',
    danger: 'bg-danger/12 text-danger',
    success: 'bg-success/12 text-success',
    info: 'bg-info/12 text-info'
  }
  const getNoticeClass = (type: BusinessNotice['type']) => noticeClasses[type]
  const financePermissions: Record<string, string> = {
    review: 'finance.review',
    refunds: 'finance.refunds',
    withdrawals: 'finance.withdrawals'
  }
  function navigate(target: BusinessTodoTarget) {
    if (!isStaff.value) return
    if (target.path === '/orders/list' && !can('orders.view')) return
    if (target.path === '/finance/settlement') {
      const permission = financePermissions[target.query?.tab || '']
      if (!permission || !can(permission)) return
    }
    router.push({ path: target.path, query: target.query })
    emit('update:value', false)
  }
  async function reload() {
    if (loading.value || !user.value) return
    try {
      await refresh()
    } catch {
      // Store 保留实际错误信息，面板显示并允许重试。
    }
  }
  watch(
    () => props.value,
    (open) => {
      clearTimeout(animationTimer)
      if (open) {
        if (barActiveIndex.value === 0 && !noticeList.value.length && pendingList.value.length)
          barActiveIndex.value = 2
        visible.value = true
        animationTimer = setTimeout(() => (show.value = true), 5)
        void reload()
      } else {
        show.value = false
        animationTimer = setTimeout(() => (visible.value = false), 350)
      }
    },
    { immediate: true }
  )
  onUnmounted(() => clearTimeout(animationTimer))
</script>

<style scoped>
  @reference '@styles/core/tailwind.css';

  .art-notification-panel {
    @apply absolute
    top-14.5
    right-5
    w-90
    h-125
    overflow-hidden
    transition-all
    duration-300
    origin-top
    will-change-[top,left]
    max-[640px]:top-[65px]
    max-[640px]:right-0
    max-[640px]:w-full
    max-[640px]:h-[80vh];
  }

  .bar-active {
    color: var(--theme-color) !important;
    border-bottom: 2px solid var(--theme-color);
  }

  .scrollbar-thin::-webkit-scrollbar {
    width: 5px !important;
  }

  .dark .scrollbar-thin::-webkit-scrollbar-track {
    background-color: var(--default-box-color);
  }

  .dark .scrollbar-thin::-webkit-scrollbar-thumb {
    background-color: #222 !important;
  }
</style>
