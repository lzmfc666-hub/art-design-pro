<template>
  <div v-loading="loading && !data" class="studio-content">
    <ElAlert
      v-if="error"
      class="studio-notice"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    >
      <ElButton size="small" @click="reload">重新加载</ElButton>
    </ElAlert>
    <ElResult
      v-if="user?.role === 'player'"
      icon="info"
      title="打手端将独立上线"
      sub-title="此处为管理后台，请使用工作室分配的管理账号。"
    />
    <ElResult
      v-else-if="!allowed"
      icon="warning"
      title="没有访问权限"
      sub-title="该功能权限已调整，请联系工作室管理员。"
    />
    <slot v-else />
  </div>
</template>

<script setup lang="ts">
  import { useStudio } from './useStudio'
  import { canAccessStudioPage } from './route-access'
  import './studio-framework.css'
  const { data, user, loading, error, refresh } = useStudio()
  const route = useRoute()
  const allowed = computed(() => canAccessStudioPage(route.meta.studioPermissions))
  async function reload() {
    try {
      await refresh()
    } catch {
      /* 错误由上方提示展示，保留已加载数据。 */
    }
  }
  onMounted(reload)
</script>
