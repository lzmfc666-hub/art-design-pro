<template>
  <div class="art-card h-128 p-5 mb-5">
    <div class="art-card-header"
      ><div class="title"><h4>最近动态</h4><p>业务操作记录</p></div></div
    >
    <ElScrollbar height="355px"
      ><ElEmpty v-if="!rows.length" description="暂无操作记录" :image-size="70" /><div
        v-for="row in rows"
        :key="row.id"
        class="py-3 border-b border-g-300"
        ><p class="text-sm">{{ row.actorName }} · {{ row.action }}</p
        ><p class="text-xs text-g-500 mt-1">{{ formatTime(row.createdAt) }}</p></div
      ></ElScrollbar
    >
  </div>
</template>
<script setup lang="ts">
  import { useStudio, formatTime } from '@/hooks/business/useStudio'
  const { data } = useStudio()
  const rows = computed(() => (data.value?.logs || []).slice(0, 8))
</script>
