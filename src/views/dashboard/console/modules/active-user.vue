<template>
  <div class="art-card h-105 p-5 mb-5">
    <div class="art-card-header"
      ><div class="title"><h4>订单进度</h4><p>当前可查看的全部订单</p></div></div
    >
    <ArtBarChart height="240px" :data="chartData" :xAxisData="labels" :showAxisLine="false" />
    <div class="flex justify-between text-sm mt-3"
      ><span class="text-g-500">已完成 {{ completed }} 笔</span
      ><span class="text-theme">共 {{ data?.orders.length || 0 }} 笔</span></div
    >
  </div>
</template>
<script setup lang="ts">
  import { useStudio, statusLabels } from '@/hooks/business/useStudio'
  import type { OrderStatus } from '@/types/studio'
  const { data } = useStudio()
  const statuses: OrderStatus[] = ['pending', 'active', 'review', 'completed', 'canceled']
  const labels = statuses.map((s) => statusLabels[s])
  const chartData = computed(() =>
    statuses.map((s) => (data.value?.orders || []).filter((o) => o.status === s).length)
  )
  const completed = computed(
    () => (data.value?.orders || []).filter((o) => o.status === 'completed').length
  )
</script>
