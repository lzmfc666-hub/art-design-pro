<template>
  <ElDialog
    v-model="visible"
    :title="
      accountKind === 'player'
        ? row
          ? '编辑打手档案'
          : '新增打手账号'
        : row
          ? '编辑人员档案'
          : '新增人员账号'
    "
    width="min(820px, 94vw)"
    destroy-on-close
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :show-close="!saving"
  >
    <ElForm
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      :disabled="saving"
      @submit.prevent="submit"
    >
      <ElTabs>
        <ElTabPane label="基本资料">
          <ElRow :gutter="20">
            <ElCol :xs="24" :sm="12"
              ><ElFormItem label="姓名 / 称呼" prop="name"
                ><ElInput v-model="form.name" maxlength="100" /></ElFormItem
            ></ElCol>
            <ElCol :xs="24" :sm="12"
              ><ElFormItem label="登录账号" prop="username"
                ><ElInput v-model="form.username" :disabled="!isAdmin" maxlength="64" /></ElFormItem
            ></ElCol>
            <ElCol v-if="accountKind !== 'player'" :xs="24" :sm="12"
              ><ElFormItem label="角色" prop="role"
                ><ElSelect v-model="form.role" :disabled="row?.id === user?.id"
                  ><ElOption
                    v-for="(label, role) in selectableRoles"
                    :key="role"
                    :value="role"
                    :label="label" /></ElSelect></ElFormItem
            ></ElCol>
            <ElCol :xs="24" :sm="12"
              ><ElFormItem label="账号状态"
                ><ElSwitch
                  v-model="form.status"
                  active-value="active"
                  inactive-value="disabled"
                  active-text="启用"
                  inactive-text="停用"
                  :disabled="row?.id === user?.id" /></ElFormItem
            ></ElCol>
            <template v-if="form.role === 'player'">
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="打手等级" prop="levelId"
                  ><ElSelect v-model="form.levelId"
                    ><ElOption
                      v-for="level in data?.levels"
                      :key="level.id"
                      :value="level.id"
                      :label="`${level.name}（接单延迟 ${level.delaySeconds} 秒）`" /></ElSelect></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="同时接单上限"
                  ><ElInputNumber v-model="form.maxActiveOrders" :min="1" :max="100" /></ElFormItem
              ></ElCol>
            </template>
            <ElCol v-if="isAdmin" :span="24"
              ><ElFormItem :label="row ? '重置密码（留空保持原密码）' : '初始密码'" prop="password"
                ><ElInput
                  v-model="form.password"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  maxlength="128"
                  placeholder="8 至 128 位" /></ElFormItem
            ></ElCol>
          </ElRow>
          <template v-if="form.role === 'player'">
            <ElDivider content-position="left">打手操作权限</ElDivider>
            <ElAlert
              title="三项权限分别控制登录、接新订单和申请新提现。关闭接单不影响已接订单提交，关闭提现不改变已赚报酬；停用或关闭登录前，请先核对在进行订单及人员移交。"
              type="info"
              :closable="false"
              class="mb-4"
            />
            <ElRow :gutter="20">
              <ElCol :xs="24" :sm="8"
                ><ElFormItem label="允许登录"
                  ><ElSwitch
                    v-model="form.playerAccess.login"
                    active-text="允许"
                    inactive-text="禁止" /></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="8"
                ><ElFormItem label="允许接新订单"
                  ><ElSwitch
                    v-model="form.playerAccess.claim"
                    active-text="允许"
                    inactive-text="禁止" /></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="8"
                ><ElFormItem label="允许申请新提现"
                  ><ElSwitch
                    v-model="form.playerAccess.withdraw"
                    active-text="允许"
                    inactive-text="禁止" /></ElFormItem
              ></ElCol>
            </ElRow>
          </template>
        </ElTabPane>
        <ElTabPane label="个人权限">
          <ElAlert
            :closable="false"
            :title="
              form.role === 'super_admin'
                ? '超级管理员始终拥有全部权限，只能由超级管理员维护。'
                : exportRestricted
                  ? '客服岗位固定不可导出；其他权限默认继承角色，可按个人覆盖。'
                  : '默认继承角色权限；允许或禁止会覆盖此人员的角色默认值。'
            "
            type="info"
            class="mb-4"
          />
          <ElTable :data="permissionRows" max-height="430">
            <ElTableColumn prop="label" label="业务权限" min-width="160" />
            <ElTableColumn label="角色默认" width="110"
              ><template #default="{ row: permission }"
                ><ElTag :type="permission.enabled ? 'success' : 'info'">{{
                  permission.enabled ? '允许' : '禁止'
                }}</ElTag></template
              ></ElTableColumn
            >
            <ElTableColumn label="个人设置" width="160"
              ><template #default="{ row: permission }"
                ><ElTag v-if="permission.key === 'reports.export' && exportRestricted" type="info">
                  固定不可导出 </ElTag
                ><ElSelect
                  v-else
                  :model-value="overrideValue(permission.key)"
                  :disabled="form.role === 'super_admin'"
                  @update:model-value="setOverride(permission.key, $event)"
                  ><ElOption label="继承角色" value="default" /><ElOption
                    label="允许"
                    value="allow" /><ElOption label="禁止" value="deny" /></ElSelect></template
            ></ElTableColumn>
          </ElTable>
        </ElTabPane>
      </ElTabs>
    </ElForm>
    <template #footer
      ><ElButton :disabled="saving" @click="visible = false">取消</ElButton
      ><ElButton type="primary" :loading="saving" @click="submit">保存档案</ElButton></template
    >
  </ElDialog>
</template>

<script setup lang="ts">
  import { computed, reactive, ref, watch, nextTick } from 'vue'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import { roleLabels, useStudio } from '@/hooks/business/useStudio'
  import type { Role, Staff } from '@/types/studio'
  import { permissionLabels } from './permissions'

  const visible = defineModel<boolean>('visible', { required: true })
  const props = defineProps<{ row?: Staff; defaultRole?: Role; accountKind?: 'staff' | 'player' }>()
  const emit = defineEmits<{ saved: []; busy: [value: boolean] }>()
  const { data, user, mutate } = useStudio()
  const isAdmin = computed(() => ['super_admin', 'admin'].includes(user.value?.role || ''))
  const selectableRoles = computed(() =>
    Object.fromEntries(
      Object.entries(roleLabels).filter(
        ([key]) =>
          (key !== 'super_admin' || user.value?.role === 'super_admin') &&
          (props.accountKind !== 'staff' || key !== 'player') &&
          (props.accountKind !== 'player' || key === 'player')
      )
    )
  )
  const formRef = ref<FormInstance>()
  const saving = ref(false)
  const form = reactive({
    username: '',
    name: '',
    role: 'support' as Role,
    status: 'active' as Staff['status'],
    levelId: '',
    maxActiveOrders: 1,
    password: '',
    permissionOverrides: {} as Record<string, boolean>,
    playerAccess: { login: true, claim: true, withdraw: true }
  })
  watch(saving, (value) => emit('busy', value))
  const exportRestricted = computed(() => ['support', 'support_lead'].includes(form.role))
  const rules: FormRules = {
    name: [{ required: true, message: '请输入姓名或称呼', trigger: 'blur' }],
    username: [
      { required: true, message: '请输入登录账号', trigger: 'blur' },
      { pattern: /^[a-zA-Z0-9_.@-]+$/, message: '仅支持字母、数字和 _.@-', trigger: 'blur' }
    ],
    levelId: [
      {
        validator: (_rule, value, callback) =>
          callback(form.role === 'player' && !value ? new Error('请选择打手等级') : undefined),
        trigger: 'change'
      }
    ],
    password: [
      {
        validator: (_rule, value, callback) =>
          callback(
            (!props.row || value) && (value.length < 8 || value.length > 128)
              ? new Error('密码长度应为 8 至 128 位')
              : undefined
          ),
        trigger: 'blur'
      }
    ]
  }
  const permissionRows = computed(() =>
    Object.entries(permissionLabels).map(([key, label]) => ({
      key,
      label,
      enabled: data.value?.roleDefaults?.[form.role]?.includes(key) ?? false
    }))
  )
  watch(visible, (open) => {
    if (!open) return
    Object.assign(
      form,
      {
        username: '',
        name: '',
        role: props.accountKind === 'player' ? 'player' : props.defaultRole || 'support',
        status: 'active',
        levelId: '',
        maxActiveOrders: 1,
        password: ''
      },
      props.row || {}
    )
    form.password = ''
    form.permissionOverrides = { ...(props.row?.permissionOverrides || {}) }
    form.playerAccess = { login: true, claim: true, withdraw: true, ...props.row?.playerAccess }
    if (props.accountKind === 'player') form.role = 'player'
    nextTick(() => formRef.value?.clearValidate())
  })
  function overrideValue(key: string) {
    return form.permissionOverrides[key] == null
      ? 'default'
      : form.permissionOverrides[key]
        ? 'allow'
        : 'deny'
  }
  function setOverride(key: string, value: string) {
    if (key === 'reports.export' && exportRestricted.value) return
    if (value === 'default') delete form.permissionOverrides[key]
    else form.permissionOverrides[key] = value === 'allow'
  }
  async function submit() {
    if (saving.value) return
    saving.value = true
    try {
      if (!(await formRef.value?.validate().catch(() => false))) return
      await mutate('/users', {
        ...form,
        playerAccess: form.role === 'player' ? { ...form.playerAccess } : undefined,
        permissionOverrides: exportRestricted.value
          ? { ...form.permissionOverrides, 'reports.export': false }
          : form.permissionOverrides,
        id: props.row?.id,
        levelId: form.levelId || undefined,
        password: form.password || undefined
      })
      visible.value = false
      ElMessage.success('人员档案已保存')
      emit('saved')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      saving.value = false
    }
  }
</script>
