<template>
  <StudioPageHost><DispatchPage /></StudioPageHost>
</template>

<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import DispatchPage from '@/studio/pages/DispatchPage.vue'
  defineOptions({ name: 'StudioDispatch' })
</script>
