<template>
  <StudioPageHost><AttendancePage /></StudioPageHost>
</template>

<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import AttendancePage from '@/studio/pages/AttendancePage.vue'
  defineOptions({ name: 'StudioAttendance' })
</script>
