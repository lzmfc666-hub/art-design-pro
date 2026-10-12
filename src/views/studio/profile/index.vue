<template>
  <StudioPageHost>
    <section v-if="user" class="panel">
      <div class="page-heading"
        ><div><h2>个人资料</h2><p>账号和权限由工作室管理员维护。</p></div></div
      >
      <ElDescriptions :column="1" border>
        <ElDescriptionsItem label="姓名">{{ user.name }}</ElDescriptionsItem>
        <ElDescriptionsItem label="登录账号">{{ user.username }}</ElDescriptionsItem>
        <ElDescriptionsItem label="身份">{{
          isStudioSuperAdmin(user) ? '超级管理员' : roleLabels[user.role]
        }}</ElDescriptionsItem>
        <ElDescriptionsItem label="账号状态">{{
          user.status === 'active' ? '正常' : '停用'
        }}</ElDescriptionsItem>
      </ElDescriptions>
    </section>
  </StudioPageHost>
</template>
<script setup lang="ts">
  import StudioPageHost from '@/studio/StudioPageHost.vue'
  import { useStudio, roleLabels } from '@/studio/useStudio'
  import { isStudioSuperAdmin } from '@/studio/framework-auth'
  defineOptions({ name: 'StudioProfile' })
  const { user } = useStudio()
</script>
