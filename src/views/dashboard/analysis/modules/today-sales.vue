<template>
  <section class="month-overview">
    <div class="overview-cards">
      <BusinessStatCard
        v-for="item in metrics"
        :key="item.label"
        :label="item.label"
        :value="ready ? item.value : '—'"
        :icon="item.icon"
        :tone="item.tone"
        :description="item.note"
      />
    </div>
    <div class="overview-costs">
      <span
        ><ArtSvgIcon icon="ri:calendar-2-line" />{{
          data?.reports.month || selectedMonth
        }}
        经营收支</span
      >
      <span
        >其他收入 <strong>{{ ready ? money(totals.otherIncome) : '—' }}</strong></span
      >
      <span
        >打手成本 <strong>{{ ready ? money(totals.reward) : '—' }}</strong></span
      >
      <span
        >其中预计 <strong>{{ ready ? money(totals.estimatedReward) : '—' }}</strong></span
      >
      <span
        >其他费用 <strong>{{ ready ? money(totals.expenses) : '—' }}</strong></span
      >
      <span
        >月度底薪 <strong>{{ ready ? money(data?.reports.monthlyBase) : '—' }}</strong></span
      >
    </div>
  </section>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { money, useStudio } from '@/hooks/business/useStudio'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  const { data, selectedMonth, loading, error } = useStudio()
  const ready = computed(
    () =>
      !!data.value &&
      !loading.value &&
      !error.value &&
      data.value.reports.month === selectedMonth.value
  )
  const totals = computed(() =>
    (data.value?.reports.days || []).reduce(
      (sum, row) => ({
        received: sum.received + row.received,
        refunds: sum.refunds + row.refunds,
        net: sum.net + row.net,
        otherIncome: sum.otherIncome + row.otherIncome,
        reward: sum.reward + row.reward,
        estimatedReward: sum.estimatedReward + row.estimatedReward,
        expenses: sum.expenses + row.expenses
      }),
      {
        received: 0,
        refunds: 0,
        net: 0,
        otherIncome: 0,
        reward: 0,
        estimatedReward: 0,
        expenses: 0
      }
    )
  )
  const metrics = computed(() => [
    {
      label: '客户收款',
      value: money(totals.value.received),
      note: '按原付款日归属',
      icon: 'ri:wallet-3-line',
      tone: 'primary' as const
    },
    {
      label: '累计退款',
      value: money(totals.value.refunds),
      note: '含后续回改的实际退款',
      icon: 'ri:refund-2-line',
      tone: 'danger' as const
    },
    {
      label: '净收入',
      value: money(totals.value.net),
      note: '客户收款减累计退款',
      icon: 'ri:bar-chart-grouped-line',
      tone: 'success' as const
    },
    {
      label: '月度利润',
      value:
        data.value?.reports.monthlyProfit == null
          ? '配置未齐'
          : money(data.value.reports.monthlyProfit),
      note: '含其他收入，已扣成本、提成、费用及底薪',
      icon: 'ri:funds-line',
      tone: data.value?.reports.monthlyProfit == null ? ('warning' as const) : ('primary' as const)
    }
  ])
</script>

<style scoped lang="scss">
  .month-overview {
    margin-bottom: 20px;
  }

  .overview-cards {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 20px;
  }

  .overview-costs {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    padding: 16px 20px;
    margin-top: 14px;
    font-size: 13px;
    color: var(--el-text-color-secondary);
    background: var(--el-bg-color);
    border: 1px solid var(--el-border-color-light);
    border-radius: 12px;

    span {
      display: inline-flex;
      gap: 7px;
      align-items: center;
    }

    strong {
      font-weight: 500;
      color: var(--el-text-color-primary);
    }
  }

  @media (width <= 1100px) {
    .overview-cards {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (width <= 640px) {
    .overview-cards {
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .overview-costs {
      gap: 10px 16px;
      padding: 14px;
    }
  }
</style>
