<template>
  <div class="art-card p-5 mb-5">
    <div class="art-card-header">
      <div class="title"
        ><h4>{{ data?.reports.month || selectedMonth }} 经营概览</h4
        ><p>来自实际订单、退款及费用记录</p></div
      >
      <ElTag :type="data?.reports.monthlyProfit == null ? 'warning' : 'success'" effect="plain">{{
        data?.reports.monthlyProfit == null ? '核算配置待补齐' : '核算配置完整'
      }}</ElTag>
    </div>
    <ElRow :gutter="20">
      <ElCol v-for="item in metrics" :key="item.label" :lg="6" :sm="12" :xs="24">
        <div class="border border-g-300/85 rounded-xl px-5 py-5 mb-4">
          <div class="size-11 rounded-lg flex-cc bg-theme/10"
            ><ArtSvgIcon :icon="item.icon" class="text-xl text-theme"
          /></div>
          <p class="text-g-500 mt-4">{{ item.label }}</p
          ><p class="text-2xl font-medium mt-2 break-all">{{ item.value }}</p
          ><p class="text-xs text-g-500 mt-2">{{ item.note }}</p>
        </div>
      </ElCol>
    </ElRow>
    <div class="flex flex-wrap gap-x-7 gap-y-2 text-sm text-g-500"
      ><span>打手成本 {{ money(totals.reward) }}</span
      ><span>其中预计成本 {{ money(totals.estimatedReward) }}</span
      ><span>其他费用 {{ money(totals.expenses) }}</span
      ><span>月度底薪 {{ money(data?.reports.monthlyBase) }}</span></div
    >
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { money, useStudio } from '@/hooks/business/useStudio'
  const { data, selectedMonth } = useStudio()
  const totals = computed(() =>
    (data.value?.reports.days || []).reduce(
      (sum, row) => ({
        received: sum.received + row.received,
        refunds: sum.refunds + row.refunds,
        net: sum.net + row.net,
        reward: sum.reward + row.reward,
        estimatedReward: sum.estimatedReward + row.estimatedReward,
        expenses: sum.expenses + row.expenses
      }),
      { received: 0, refunds: 0, net: 0, reward: 0, estimatedReward: 0, expenses: 0 }
    )
  )
  const metrics = computed(() => [
    {
      label: '客户收款',
      value: money(totals.value.received),
      note: '按原付款日归属',
      icon: 'ri:wallet-3-line'
    },
    {
      label: '累计退款',
      value: money(totals.value.refunds),
      note: '含后续回改的实际退款',
      icon: 'ri:refund-2-line'
    },
    {
      label: '净收入',
      value: money(totals.value.net),
      note: '客户收款减累计退款',
      icon: 'ri:bar-chart-grouped-line'
    },
    {
      label: '月度利润',
      value:
        data.value?.reports.monthlyProfit == null
          ? '配置未齐'
          : money(data.value.reports.monthlyProfit),
      note: '已扣成本、提成、费用及底薪',
      icon: 'ri:funds-line'
    }
  ])
</script>
