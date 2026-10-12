<template>
  <div class="flex w-full h-screen">
    <LoginLeftView />
    <div class="relative flex-1">
      <AuthTopBar />
      <div class="auth-right-wrap">
        <div class="form">
          <h3 class="title">账号由管理员分配</h3>
          <ElAlert
            class="mt-7.5"
            title="请联系工作室管理员创建账号、分配角色和权限。已有账号可返回登录。"
            type="info"
            :closable="false"
            show-icon
          />
          <ElButton
            class="w-full custom-height mt-5"
            type="primary"
            @click="$router.push({ name: 'Login' })"
            >返回登录</ElButton
          >
        </div>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
  defineOptions({ name: 'Register' })
</script>
<style scoped>
  @import '../login/style.css';
</style>
