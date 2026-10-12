<template>
  <ElRow :gutter="20">
    <ElCol v-for="item in cards" :key="item.label" :xs="12" :lg="6">
      <div class="art-card relative flex flex-col justify-center h-35 px-5 mb-5">
        <span class="text-sm text-g-600">{{ item.label }}</span
        ><strong class="text-2xl font-semibold mt-2">{{ item.value }}</strong
        ><span class="text-xs text-g-500 mt-2">{{ item.note }}</span>
        <div class="absolute right-5 top-5 rounded-xl p-3 bg-theme/10 text-theme max-sm:hidden"
          ><ArtSvgIcon :icon="item.icon" class="text-xl"
        /></div>
      </div>
    </ElCol>
  </ElRow>
</template>
<script setup lang="ts">
  import { useStudio, money } from '@/hooks/business/useStudio'
  const { data, user, can } = useStudio()
  const cards = computed(() => {
    const orders = data.value?.orders || []
    const days = data.value?.reports.days || []
    const mine = data.value?.reports.performance.find((row) => row.userId === user.value?.id)
    return [
      {
        label: can('profit.view') ? '本月净收入' : '本月个人业绩',
        value: money(can('profit.view') ? days.reduce((sum, d) => sum + d.net, 0) : mine?.net || 0),
        note: can('profit.view') ? '按客户原付款日统计' : '完成订单扣除累计退款',
        icon: 'ri:money-cny-circle-line'
      },
      {
        label: '等待接单',
        value: orders.filter((o) => o.status === 'pending').length,
        note: '已发布，等待打手接单',
        icon: 'ri:time-line'
      },
      {
        label: '正在执行',
        value: orders.filter((o) => o.status === 'active').length,
        note: '由打手端提交完成材料',
        icon: 'ri:gamepad-line'
      },
      {
        label: '待财务验收',
        value: orders.filter((o) => o.status === 'review').length,
        note: '验收后计入可提现报酬',
        icon: 'ri:checkbox-circle-line'
      }
    ]
  })
</script>
