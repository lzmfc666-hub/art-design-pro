<template>
  <StudioPageHost><OverviewPage /></StudioPageHost>
</template>

<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import OverviewPage from '@/studio/pages/OverviewPage.vue'
  defineOptions({ name: 'StudioOverview' })
</script>
