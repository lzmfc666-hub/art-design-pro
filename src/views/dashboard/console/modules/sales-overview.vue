<template>
  <div class="art-card h-105 p-5 mb-5">
    <div class="art-card-header"
      ><div class="title"
        ><h4>{{ can('profit.view') ? '每日净收入' : '个人完成订单' }}</h4
        ><p
          >{{ selectedMonth }} ·
          {{ can('profit.view') ? '退款回到原付款日调整，金额单位：元' : '按本月完成日期统计' }}</p
        ></div
      ></div
    >
    <ArtLineChart
      height="270px"
      :data="series"
      :xAxisData="dates.map((d) => d.slice(8))"
      :showAreaColor="true"
      :showAxisLine="false"
    />
  </div>
</template>
<script setup lang="ts">
  import { useStudio } from '@/hooks/business/useStudio'
  const { data, user, can, selectedMonth } = useStudio()
  const dates = computed(() => {
    const [year, month] = selectedMonth.value.split('-').map(Number)
    const count = new Date(year!, month!, 0).getDate()
    return Array.from(
      { length: count },
      (_, i) => selectedMonth.value + '-' + String(i + 1).padStart(2, '0')
    )
  })
  const series = computed(() =>
    dates.value.map((date) =>
      can('profit.view')
        ? (data.value?.reports.days.find((d) => d.date === date)?.net || 0) / 100
        : (data.value?.orders || []).filter(
            (o) =>
              o.creatorId === user.value?.id &&
              o.status === 'completed' &&
              o.completedAt &&
              new Date(o.completedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) ===
                date
          ).length
    )
  )
</script>
