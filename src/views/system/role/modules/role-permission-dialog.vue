<template>
  <ElDialog v-model="visible" :title="`${roleLabels[role]} · 默认权限`" width="min(680px, 94vw)">
    <ElAlert
      class="mb-4"
      type="info"
      :closable="false"
      title="这些权限由服务器校验。个人允许或禁止覆盖在人员档案中设置。"
    />
    <ElTable :data="rows" max-height="470">
      <ElTableColumn prop="label" label="业务功能" min-width="150" />
      <ElTableColumn prop="key" label="权限标识" min-width="180" />
      <ElTableColumn label="默认授权" width="100"
        ><template #default="{ row }"
          ><ElTag :type="row.enabled ? 'success' : 'info'">{{
            row.enabled ? '允许' : '禁止'
          }}</ElTag></template
        ></ElTableColumn
      >
    </ElTable>
    <template #footer><ElButton type="primary" @click="visible = false">关闭</ElButton></template>
  </ElDialog>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import type { Role } from '@/types/studio'
  import { roleLabels, useStudio } from '@/hooks/business/useStudio'
  import { permissionLabels } from '../../user/modules/permissions'

  const visible = defineModel<boolean>({ required: true })
  const props = defineProps<{ role: Role }>()
  const { data } = useStudio()
  const rows = computed(() =>
    Object.entries(permissionLabels).map(([key, label]) => ({
      key,
      label,
      enabled: data.value?.roleDefaults?.[props.role]?.includes(key) ?? false
    }))
  )
</script>
