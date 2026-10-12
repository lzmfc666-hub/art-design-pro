<template>
  <StudioPageHost><PeoplePage /></StudioPageHost>
</template>

<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import PeoplePage from '@/studio/pages/PeoplePage.vue'
  defineOptions({ name: 'StudioPeople' })
</script>
