<template>
  <div class="art-card p-5 mb-5">
    <div class="art-card-header"
      ><div class="title"><h4>每日收款与净收入</h4><p>原付款日归属 · 单位：元</p></div></div
    >
    <ArtLineChart
      v-if="days.length"
      height="290px"
      :loading="loading"
      :data="chartData"
      :x-axis-data="xAxisData"
      :show-legend="true"
      :show-axis-label="true"
      :show-axis-line="false"
      :show-split-line="true"
      :smooth="false"
    />
    <ElEmpty v-else description="当前月份没有经营记录" :image-size="100" class="h-72" />
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { useStudio } from '@/hooks/business/useStudio'
  import type { LineDataItem } from '@/types/component/chart'
  const { data, loading } = useStudio()
  const days = computed(() => data.value?.reports.days || [])
  const xAxisData = computed(() => days.value.map((row) => row.date.slice(5)))
  const chartData = computed<LineDataItem[]>(() => [
    { name: '客户收款', data: days.value.map((row) => row.received / 100) },
    { name: '累计退款', data: days.value.map((row) => row.refunds / 100) },
    { name: '净收入', data: days.value.map((row) => row.net / 100) }
  ])
</script>
