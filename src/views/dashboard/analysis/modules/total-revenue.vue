<template>
  <div class="art-card p-5 mb-5">
    <div class="art-card-header"
      ><div class="title"
        ><h4>成本与费用构成</h4><p>打手成本含未验收预计报酬 · 单位：元</p></div
      ></div
    >
    <ArtBarChart
      height="290px"
      :loading="loading"
      :data="chartData"
      :x-axis-data="['打手报酬', '客服提成', '运营提成', '其他费用']"
      :show-axis-line="false"
      :show-split-line="true"
      :bar-width="30"
    />
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { useStudio } from '@/hooks/business/useStudio'
  const { data, loading } = useStudio()
  const chartData = computed(() => {
    const days = data.value?.reports.days || []
    return ['reward', 'supportCommission', 'operationsCommission', 'expenses'].map(
      (key) =>
        days.reduce(
          (sum, row) =>
            sum + row[key as 'reward' | 'supportCommission' | 'operationsCommission' | 'expenses'],
          0
        ) / 100
    )
  })
</script>
