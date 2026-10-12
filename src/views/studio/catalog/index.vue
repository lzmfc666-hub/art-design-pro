<template>
  <StudioPageHost><CatalogPage /></StudioPageHost>
</template>

<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import CatalogPage from '@/studio/pages/CatalogPage.vue'
  defineOptions({ name: 'StudioCatalog' })
</script>
