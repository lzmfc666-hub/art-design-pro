<template>
  <StudioPageHost><OrdersPage /></StudioPageHost>
</template>

<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import OrdersPage from '@/studio/pages/OrdersPage.vue'
  defineOptions({ name: 'StudioOrders' })
</script>
