<script setup lang="ts">
  import { useStudio } from '@/hooks/business/useStudio'
  import { useUserStore } from '@/store/modules/user'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  const { user, data } = useStudio()
  const userStore = useUserStore()
</script>

<template>
  <div>
    <BusinessPageHeader title="账号与通知" description="账号归属由总后台维护，订单通知仅包含本商家当前可查看的业务。" icon="ri:user-settings-line" />
    <ElCard shadow="never">
      <ElDescriptions :column="1" border>
        <ElDescriptionsItem label="登录账号">{{ user?.username }}</ElDescriptionsItem>
        <ElDescriptionsItem label="称呼">{{ user?.name }}</ElDescriptionsItem>
        <ElDescriptionsItem label="所属商家">{{ data?.merchants?.find(item => item.id === user?.merchantId)?.name || '响箭电竞' }}</ElDescriptionsItem>
        <ElDescriptionsItem label="通知">点击右上方通知，可查看当前有权处理的订单提醒。</ElDescriptionsItem>
      </ElDescriptions>
      <ElButton class="mt-4" @click="userStore.logOut">退出商家账号</ElButton>
    </ElCard>
  </div>
</template>
