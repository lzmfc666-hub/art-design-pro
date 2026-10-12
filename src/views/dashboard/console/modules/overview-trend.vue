<template>
  <div class="art-card overview-trend">
    <div class="trend-heading"
      ><div
        ><h4>所选区间趋势</h4><p>{{ report?.range.start }} 至 {{ report?.range.end }}</p></div
      ><ElRadioGroup v-model="metric" size="small"
        ><ElRadioButton v-for="option in options" :key="option.key" :value="option.key">{{
          option.label
        }}</ElRadioButton></ElRadioGroup
      ></div
    >
    <ArtLineChart
      v-if="points.length && available"
      height="270px"
      :data="points"
      :x-axis-data="dates"
      :colors="['#3478f6']"
      :show-area-color="true"
      :show-axis-line="false"
      :loading="loading"
    />
    <ElEmpty
      v-else
      :description="loading ? '正在读取趋势' : '当前权限未开放这项数据'"
      :image-size="85"
    />
    <p class="trend-note"
      >{{ activeLabel }}{{ monetary ? ' · 单位：元' : ' · 单位：笔'
      }}{{
        metric === 'net' || metric === 'refunds'
          ? ' · 收入及退款回归客户原付款日'
          : ' · 按所选日期统计'
      }}</p
    >
  </div>
</template>
<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import type { OverviewReport, OverviewDay } from '@/types/overview'
  const props = defineProps<{ report: OverviewReport | null; loading: boolean }>()
  const metric = ref<keyof OverviewDay>('net')
  const allOptions = [
    { key: 'net' as const, label: '净收入' },
    { key: 'createdOrders' as const, label: '下单' },
    { key: 'refunds' as const, label: '退款' },
    { key: 'expenses' as const, label: '费用' }
  ]
  const options = computed(() =>
    allOptions.filter((option) => props.report?.series.some((day) => day[option.key] != null))
  )
  const monetary = computed(() => ['net', 'refunds', 'expenses'].includes(metric.value))
  const available = computed(() => options.value.some((option) => option.key === metric.value))
  const activeLabel = computed(
    () => allOptions.find((item) => item.key === metric.value)?.label || ''
  )
  const points = computed(() =>
    (props.report?.series || []).map(
      (day) => Number(day[metric.value] || 0) / (monetary.value ? 100 : 1)
    )
  )
  const dates = computed(() => (props.report?.series || []).map((day) => day.date.slice(5)))
  watch(
    options,
    (value) => {
      if (!value.some((item) => item.key === metric.value) && value[0]) metric.value = value[0].key
    },
    { immediate: true }
  )
</script>
<style lang="scss" scoped>
  .overview-trend {
    min-height: 420px;
    padding: 20px;
    margin-bottom: 20px;
    overflow: hidden;
  }

  .trend-heading {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 22px;
  }

  .trend-heading h4 {
    font-size: 16px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .trend-heading p,
  .trend-note {
    margin-top: 7px;
    font-size: 12px;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
  }

  @media (width <= 640px) {
    .overview-trend {
      padding: 16px;
    }
  }
</style>
