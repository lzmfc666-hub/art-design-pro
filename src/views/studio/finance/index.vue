<template>
  <StudioPageHost><FinancePage /></StudioPageHost>
</template>

<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import FinancePage from '@/studio/pages/FinancePage.vue'
  defineOptions({ name: 'StudioFinance' })
</script>
