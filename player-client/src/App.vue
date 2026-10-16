<template><RouterView :key="session.epoch" /></template>
<script setup lang="ts">
  import { useSessionStore } from '@/stores/session'
  const session = useSessionStore()
</script>
