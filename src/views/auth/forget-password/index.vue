<template>
  <div class="flex w-full h-screen">
    <LoginLeftView />
    <div class="relative flex-1">
      <AuthTopBar />
      <div class="auth-right-wrap">
        <div class="form">
          <h3 class="title">联系管理员重置密码</h3>
          <ElAlert
            class="mt-7.5"
            title="忘记密码请联系工作室管理员。登录后也可在个人中心验证旧密码并自行修改。"
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
  defineOptions({ name: 'ForgetPassword' })
</script>
<style scoped>
  @import '../login/style.css';
</style>
