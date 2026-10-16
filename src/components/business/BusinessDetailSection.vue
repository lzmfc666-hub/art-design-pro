<template>
  <section class="business-detail-section">
    <header
      ><h3>{{ title }}</h3
      ><p v-if="description">{{ description }}</p
      ><slot name="actions"
    /></header>
    <div class="business-detail-section-content"><slot /></div>
  </section>
</template>
<script setup lang="ts">
  defineProps<{ title: string; description?: string }>()
</script>
