<template>
  <div class="art-card p-5 h-128 mb-5 overflow-hidden">
    <div class="art-card-header"
      ><div class="title"><h4>最近订单</h4><p>按创建时间排序</p></div
      ><ElButton v-if="can('orders.view')" type="primary" link @click="$router.push('/orders/list')"
        >全部订单</ElButton
      ></div
    >
    <ArtTable :data="rows" :height="350" :showTableHeader="false" :border="false">
      <ElTableColumn label="订单 / 项目" min-width="190"
        ><template #default="{ row }"
          ><ElButton
            v-if="can('orders.view')"
            link
            type="primary"
            @click="$router.push({ path: '/orders/list', query: { id: row.id } })"
            >{{ row.orderNo }}</ElButton
          ><span v-else>{{ row.orderNo }}</span
          ><p class="text-xs text-g-500">{{ row.title }}</p></template
        ></ElTableColumn
      >
      <ElTableColumn label="金额" min-width="100"
        ><template #default="{ row }">{{ money(row.amount) }}</template></ElTableColumn
      >
      <ElTableColumn label="状态" min-width="100"
        ><template #default="{ row }"
          ><ElTag
            :type="
              row.status === 'completed' ? 'success' : row.status === 'review' ? 'warning' : 'info'
            "
            >{{ statusLabels[row.status as OrderStatus] }}</ElTag
          ></template
        ></ElTableColumn
      >
    </ArtTable>
  </div>
</template>
<script setup lang="ts">
  import { useStudio, money, statusLabels } from '@/hooks/business/useStudio'
  import type { OrderStatus } from '@/types/studio'
  const { data, can } = useStudio()
  const rows = computed(() =>
    [...(data.value?.orders || [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6)
  )
</script>
