<template>
  <div class="art-card p-5"
    ><div class="art-card-header"
      ><div class="title"
        ><h4>{{ can('salary.all') || can('profit.view') ? '员工业绩' : '个人业绩' }}</h4
        ><p>{{ selectedMonth }} · 按订单完成月份计入，已扣除实际退款</p></div
      ></div
    >
    <ArtTable
      :data="data?.reports.performance || []"
      :showTableHeader="false"
      :border="false"
      :height="220"
    >
      <ElTableColumn prop="name" label="员工" /><ElTableColumn
        prop="completed"
        label="计入业绩订单"
      /><ElTableColumn label="净成交额"
        ><template #default="{ row }">{{ money(row.net) }}</template></ElTableColumn
      >
    </ArtTable>
  </div>
</template>
<script setup lang="ts">
  import { useStudio, money } from '@/hooks/business/useStudio'
  const { data, can, selectedMonth } = useStudio()
</script>
