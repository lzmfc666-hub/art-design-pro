<script setup lang="ts">
  import { reactive, ref, watch, onBeforeUnmount } from 'vue'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import { useStudio } from '@/hooks/business/useStudio'
  import { useUserStore } from '@/store/modules/user'
  import { useRouter } from 'vue-router'
  import { studioRequest } from '@/api/studio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  const { user, data, mutate, clearSession, logout } = useStudio()
  const userStore = useUserStore()
  const router = useRouter()
  const profile = reactive({ name: '' })
  const password = reactive({ currentPassword: '', newPassword: '', confirmation: '' })
  const profileForm = ref<FormInstance>()
  const passwordForm = ref<FormInstance>()
  const savingProfile = ref(false)
  const savingPassword = ref(false)
  const profileRules: FormRules = {
    name: [{ required: true, message: '请输入姓名或称呼', trigger: 'blur' }]
  }
  const passwordRules: FormRules = {
    currentPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
    newPassword: [
      { required: true, message: '请输入新密码', trigger: 'blur' },
      { min: 8, max: 128, message: '密码长度应为 8 至 128 位', trigger: 'blur' }
    ],
    confirmation: [
      {
        validator: (_rule, value, callback) =>
          callback(
            !value || value !== password.newPassword
              ? new Error('两次输入的新密码不一致')
              : undefined
          ),
        trigger: 'blur'
      }
    ]
  }
  function clearPasswords() {
    Object.assign(password, { currentPassword: '', newPassword: '', confirmation: '' })
  }
  watch(
    () => user.value?.name,
    (name) => {
      profile.name = name || ''
    },
    { immediate: true }
  )
  watch(() => user.value?.id, clearPasswords)
  onBeforeUnmount(clearPasswords)
  async function saveProfile() {
    if (savingProfile.value || !(await profileForm.value?.validate().catch(() => false))) return
    savingProfile.value = true
    try {
      await mutate('/profile', { name: profile.name })
      ElMessage.success('个人资料已保存')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      savingProfile.value = false
    }
  }
  async function changePassword() {
    if (savingPassword.value || !(await passwordForm.value?.validate().catch(() => false))) return
    savingPassword.value = true
    try {
      await studioRequest(
        '/profile/password',
        { currentPassword: password.currentPassword, newPassword: password.newPassword },
        'POST'
      )
      clearPasswords()
      clearSession()
      await logout().catch(() => undefined)
      userStore.clearSession()
      await router.push({ name: 'MerchantLogin' })
      ElMessage.success('密码已修改，请重新登录')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '密码修改失败')
    } finally {
      savingPassword.value = false
    }
  }
</script>

<template>
  <div>
    <BusinessPageHeader
      title="账号与通知"
      description="账号归属由总后台维护，订单通知仅包含本商家当前可查看的业务。"
      icon="ri:user-settings-line"
    />
    <ElCard shadow="never">
      <ElDescriptions :column="1" border>
        <ElDescriptionsItem label="登录账号">{{ user?.username }}</ElDescriptionsItem>
        <ElDescriptionsItem label="称呼">{{ user?.name }}</ElDescriptionsItem>
        <ElDescriptionsItem label="账号身份">{{
          user?.merchantRole === 'owner' ? '商家主账号' : '商家客服'
        }}</ElDescriptionsItem>
        <ElDescriptionsItem label="所属商家">{{
          data?.merchants?.find((item) => item.id === user?.merchantId)?.name || '响箭电竞'
        }}</ElDescriptionsItem>
        <ElDescriptionsItem label="通知"
          >点击右上方通知，可查看当前有权处理的订单提醒。</ElDescriptionsItem
        >
      </ElDescriptions>
      <ElButton class="mt-4" @click="userStore.logOut">退出商家账号</ElButton>
    </ElCard>
    <ElRow :gutter="20" class="mt-5">
      <ElCol :xs="24" :lg="12">
        <ElCard shadow="never" class="mb-5">
          <template #header>本人资料</template>
          <ElForm
            ref="profileForm"
            :model="profile"
            :rules="profileRules"
            label-position="top"
            :disabled="savingProfile"
            @submit.prevent="saveProfile"
          >
            <ElFormItem label="姓名 / 称呼" prop="name"
              ><ElInput v-model="profile.name" maxlength="100"
            /></ElFormItem>
            <ElButton type="primary" :loading="savingProfile" @click="saveProfile"
              >保存资料</ElButton
            >
          </ElForm>
        </ElCard>
      </ElCol>
      <ElCol :xs="24" :lg="12">
        <ElCard shadow="never">
          <template #header>修改密码</template>
          <ElForm
            ref="passwordForm"
            :model="password"
            :rules="passwordRules"
            label-position="top"
            :disabled="savingPassword"
            @submit.prevent="changePassword"
          >
            <ElFormItem label="当前密码" prop="currentPassword"
              ><ElInput
                v-model="password.currentPassword"
                type="password"
                show-password
                autocomplete="current-password"
                maxlength="128"
            /></ElFormItem>
            <ElFormItem label="新密码" prop="newPassword"
              ><ElInput
                v-model="password.newPassword"
                type="password"
                show-password
                autocomplete="new-password"
                maxlength="128"
            /></ElFormItem>
            <ElFormItem label="确认新密码" prop="confirmation"
              ><ElInput
                v-model="password.confirmation"
                type="password"
                show-password
                autocomplete="new-password"
                maxlength="128"
            /></ElFormItem>
            <p class="text-sm text-g-500 mb-4">修改后所有设备会话将退出，请使用新密码重新登录。</p>
            <ElButton type="primary" :loading="savingPassword" @click="changePassword"
              >修改密码并重新登录</ElButton
            >
          </ElForm>
        </ElCard>
      </ElCol>
    </ElRow>
  </div>
</template>
