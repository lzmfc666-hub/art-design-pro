<template>
  <StudioPageHost><LogsPage /></StudioPageHost>
</template>

<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import LogsPage from '@/studio/pages/LogsPage.vue'
  defineOptions({ name: 'StudioLogs' })
</script>
