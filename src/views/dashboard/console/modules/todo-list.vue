<template>
  <div class="art-card h-128 p-5 mb-5">
    <div class="art-card-header"
      ><div class="title"><h4>待办事项</h4><p>根据账号权限展示</p></div></div
    >
    <ElEmpty v-if="!items.length" description="当前暂无待办" :image-size="80" />
    <div
      v-for="item in items"
      :key="item.label"
      class="flex items-center justify-between py-4 border-b border-g-300"
      ><ElButton link @click="$router.push(item.path)">{{ item.label }}</ElButton
      ><ElTag :type="item.count ? 'warning' : 'info'">{{ item.count }}</ElTag></div
    >
  </div>
</template>
<script setup lang="ts">
  import { useStudio } from '@/hooks/business/useStudio'
  const { data, can } = useStudio()
  const items = computed(() =>
    [
      {
        label: '待确认收款',
        count: (data.value?.orders || []).filter(
          (o) => !o.receivedAmount && o.status !== 'canceled'
        ).length,
        path: '/orders/list?payment=unpaid',
        show: can('orders.edit')
      },
      {
        label: '待验收订单',
        count: (data.value?.orders || []).filter((o) => o.status === 'review').length,
        path: '/finance/settlement?tab=review',
        show: can('finance.review')
      },
      {
        label: '待审核退款',
        count: (data.value?.refunds || []).filter((r) => r.status === 'pending').length,
        path: '/finance/settlement?tab=refunds',
        show: can('finance.refunds')
      },
      {
        label: '待处理提现',
        count: (data.value?.withdrawals || []).filter((w) =>
          ['pending', 'approved'].includes(w.status)
        ).length,
        path: '/finance/settlement?tab=withdrawals',
        show: can('finance.withdrawals')
      },
      {
        label: '取消报酬待确认',
        count: (data.value?.orders || []).filter((o) => o.compensationPending).length,
        path: '/finance/settlement?tab=review',
        show: can('finance.review')
      }
    ].filter((i) => i.show)
  )
</script>
