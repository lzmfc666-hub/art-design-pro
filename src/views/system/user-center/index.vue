<template>
  <div class="w-full">
    <ElRow :gutter="20">
      <ElCol :xs="24" :lg="8">
        <div class="art-card-sm relative overflow-hidden text-center mb-5">
          <img class="h-40 w-full object-cover" src="@imgs/user/bg.webp" alt="" />
          <div class="px-6 pb-6">
            <ElAvatar
              class="!-mt-10 !h-20 !w-20 relative !bg-theme !text-2xl !border-4 !border-white"
              >{{ user?.name.slice(0, 1) }}</ElAvatar
            >
            <h2 class="mt-4 text-xl">{{ user?.name }}</h2>
            <ElTag class="mt-3">{{ user ? roleLabels[user.role] : '—' }}</ElTag>
            <ElDescriptions class="mt-6" :column="1" border>
              <ElDescriptionsItem label="登录账号">{{ user?.username }}</ElDescriptionsItem>
              <ElDescriptionsItem label="账号状态"
                ><ElTag :type="user?.status === 'active' ? 'success' : 'info'">{{
                  user?.status === 'active' ? '启用' : '停用'
                }}</ElTag></ElDescriptionsItem
              >
              <ElDescriptionsItem label="业务权限"
                >{{ data?.permissions.length || 0 }} 项</ElDescriptionsItem
              >
              <ElDescriptionsItem v-if="user?.role === 'player'" label="等级">{{
                data?.levels.find((level) => level.id === user?.levelId)?.name || '未设置'
              }}</ElDescriptionsItem>
            </ElDescriptions>
          </div>
        </div>
        <div class="art-card-sm p-5 mb-5">
          <h3 class="font-medium mb-4">所选月份个人业绩</h3>
          <ElDescriptions :column="1">
            <ElDescriptionsItem label="完成订单"
              >{{ performance?.completed ?? 0 }} 单</ElDescriptionsItem
            >
            <ElDescriptionsItem label="订单净业绩">{{
              money(performance?.net ?? 0)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="实到工时"
              >{{ actualHours.toFixed(1) }} 小时</ElDescriptionsItem
            >
            <template v-if="can('salary.view') || can('salary.all')">
              <ElDescriptionsItem label="月工资合计">{{ money(payrollTotal) }}</ElDescriptionsItem>
              <ElDescriptionsItem label="已发工资">{{ money(paidSalary) }}</ElDescriptionsItem>
              <ElDescriptionsItem label="待结算 / 差额">{{
                money(pendingSalary)
              }}</ElDescriptionsItem>
            </template>
          </ElDescriptions>
          <p class="text-xs text-g-500 mt-3"
            >{{ selectedMonth }} ·
            业绩按完成月份归属，净业绩扣除已支付退款；运营按订单运营归属统计。</p
          >
          <p v-if="can('salary.view') || can('salary.all')" class="text-xs text-g-500 mt-2"
            >月工资合计包含已发工资和待结算差额；负差额表示待扣回提成。缺少工资配置时显示“待配置”。</p
          >
        </div>
      </ElCol>
      <ElCol :xs="24" :lg="16">
        <div class="art-card-sm mb-5">
          <h3 class="p-5 border-b border-g-300 font-medium">基本资料</h3>
          <ElForm
            ref="profileFormRef"
            :model="profile"
            :rules="profileRules"
            class="p-5"
            label-position="top"
            @submit.prevent="saveProfile"
          >
            <ElFormItem label="姓名 / 称呼" prop="name"
              ><ElInput v-model="profile.name" maxlength="100"
            /></ElFormItem>
            <p class="text-sm text-g-500 mb-5"
              >登录账号和岗位角色由管理员维护。姓名修改会同步显示在工作室后台。</p
            >
            <ElButton type="primary" :loading="savingProfile" v-ripple @click="saveProfile"
              >保存资料</ElButton
            >
          </ElForm>
        </div>
        <div class="art-card-sm mb-5">
          <h3 class="p-5 border-b border-g-300 font-medium">账户安全</h3>
          <ElForm
            ref="passwordFormRef"
            :model="password"
            :rules="passwordRules"
            class="p-5"
            label-position="top"
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
                placeholder="8 至 128 位"
            /></ElFormItem>
            <ElFormItem label="确认新密码" prop="confirmation"
              ><ElInput
                v-model="password.confirmation"
                type="password"
                show-password
                autocomplete="new-password"
                maxlength="128"
            /></ElFormItem>
            <p class="text-sm text-g-500 mb-5"
              >修改密码后，所有设备上的当前会话会退出，请使用新密码重新登录。</p
            >
            <ElButton type="primary" :loading="savingPassword" v-ripple @click="changePassword"
              >修改密码并重新登录</ElButton
            >
          </ElForm>
        </div>
        <div class="art-card-sm p-5">
          <h3 class="font-medium mb-4">我的近期操作</h3>
          <ArtTable :data="myLogs" :columns="activityColumns" height="300">
            <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
          </ArtTable>
        </div>
      </ElCol>
    </ElRow>
  </div>
</template>

<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import { useStudio, roleLabels, money, formatTime } from '@/hooks/business/useStudio'
  import { studioRequest } from '@/api/studio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'

  defineOptions({ name: 'UserCenter' })
  const { data, user, selectedMonth, can, mutate, logout, clearSession } = useStudio()
  const profileFormRef = ref<FormInstance>()
  const passwordFormRef = ref<FormInstance>()
  const profile = reactive({ name: '' })
  const password = reactive({ currentPassword: '', newPassword: '', confirmation: '' })
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
            value !== password.newPassword || !value
              ? new Error('两次输入的新密码不一致')
              : undefined
          ),
        trigger: 'blur'
      }
    ]
  }
  watch(
    () => user.value?.name,
    (name) => {
      profile.name = name || ''
    },
    { immediate: true }
  )
  const performance = computed(() =>
    data.value?.reports.performance.find((row) => row.userId === user.value?.id)
  )
  const payrollLines = computed(() =>
    (data.value?.reports.payroll || []).filter((row) => row.userId === user.value?.id)
  )
  const payrollTotal = computed(() =>
    !payrollLines.value.length ||
    payrollLines.value.some((row) => row.incomplete || row.total == null)
      ? null
      : payrollLines.value.reduce((sum, row) => sum + row.total!, 0)
  )
  const paidSalary = computed(() =>
    (data.value?.payrolls || [])
      .filter((payroll) => payroll.month === selectedMonth.value)
      .flatMap((payroll) => payroll.lines)
      .filter((row) => row.userId === user.value?.id)
      .reduce((sum, row) => sum + (row.total || 0), 0)
  )
  const pendingSalary = computed(() =>
    payrollTotal.value == null ? null : payrollTotal.value - paidSalary.value
  )
  const actualHours = computed(() =>
    (data.value?.attendance || [])
      .filter(
        (row) =>
          row.userId === user.value?.id &&
          row.date.startsWith(selectedMonth.value) &&
          row.status === 'present'
      )
      .reduce((sum, row) => sum + row.actualHours, 0)
  )
  const myLogs = computed(() =>
    (data.value?.logs || []).filter((log) => log.actorId === user.value?.id).slice(0, 10)
  )
  const { columns: activityColumns } = useTableColumns(() => [
    { prop: 'createdAt', label: '操作时间', minWidth: 180, useSlot: true },
    { prop: 'action', label: '操作内容', minWidth: 200 }
  ])
  async function saveProfile() {
    if (!(await profileFormRef.value?.validate().catch(() => false))) return
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
    if (!(await passwordFormRef.value?.validate().catch(() => false))) return
    savingPassword.value = true
    try {
      await studioRequest(
        '/profile/password',
        { currentPassword: password.currentPassword, newPassword: password.newPassword },
        'POST'
      )
      Object.assign(password, { currentPassword: '', newPassword: '', confirmation: '' })
      // 密码已经保存且服务端已撤销所有会话，本地立即清除身份。
      clearSession()
      // 此请求只清理浏览器 cookie；网络失败不改变已完成的改密结果。
      await logout().catch(() => undefined)
      ElMessage.success('密码已修改，请重新登录')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '密码修改失败')
    } finally {
      savingPassword.value = false
    }
  }
</script>
