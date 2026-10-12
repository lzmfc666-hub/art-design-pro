<template>
  <ElRow :gutter="20">
    <ElCol v-for="item in cards" :key="item.label" :xs="12" :lg="6" class="mb-5">
      <BusinessStatCard
        :label="item.label"
        :value="item.value"
        :description="item.note"
        :icon="item.icon"
        :tone="item.tone"
      />
    </ElCol>
  </ElRow>
</template>
<script setup lang="ts">
  import { useStudio, money } from '@/hooks/business/useStudio'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  const { data, user, can } = useStudio()
  const cards = computed(() => {
    const orders = data.value?.orders || []
    const days = data.value?.reports.days || []
    const mine = data.value?.reports.performance.find((row) => row.userId === user.value?.id)
    return [
      {
        label: can('profit.view') ? '所选月份净收入' : '所选月份个人业绩',
        value: money(can('profit.view') ? days.reduce((sum, d) => sum + d.net, 0) : mine?.net || 0),
        note: can('profit.view') ? '按客户原付款日统计' : '完成订单扣除累计退款',
        icon: 'ri:money-cny-circle-line',
        tone: 'primary' as const
      },
      {
        label: '等待接单',
        value: orders.filter((o) => o.status === 'pending').length,
        note: '已发布，等待打手接单',
        icon: 'ri:time-line',
        tone: 'info' as const
      },
      {
        label: '正在执行',
        value: orders.filter((o) => o.status === 'active').length,
        note: '由打手端提交完成材料',
        icon: 'ri:gamepad-line',
        tone: 'success' as const
      },
      {
        label: '待财务验收',
        value: orders.filter((o) => o.status === 'review').length,
        note: '验收后计入可提现报酬',
        icon: 'ri:checkbox-circle-line',
        tone: 'warning' as const
      }
    ]
  })
</script>
