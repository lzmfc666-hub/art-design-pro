<template>
  <ElDialog
    v-model="visible"
    :title="row ? '编辑人员档案' : '新增人员账号'"
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
            <ElCol :xs="24" :sm="12"
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
        </ElTabPane>
        <ElTabPane label="个人权限">
          <ElAlert
            :closable="false"
            :title="
              form.role === 'super_admin'
                ? '超级管理员始终拥有全部权限，只能由超级管理员维护。'
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
                ><ElSelect
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
  const props = defineProps<{ row?: Staff; defaultRole?: Role }>()
  const emit = defineEmits<{ saved: [] }>()
  const { data, user, mutate } = useStudio()
  const isAdmin = computed(() => ['super_admin', 'admin'].includes(user.value?.role || ''))
  const selectableRoles = computed(() =>
    Object.fromEntries(
      Object.entries(roleLabels).filter(
        ([key]) => key !== 'super_admin' || user.value?.role === 'super_admin'
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
    permissionOverrides: {} as Record<string, boolean>
  })
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
        role: props.defaultRole || 'support',
        status: 'active',
        levelId: '',
        maxActiveOrders: 1,
        password: ''
      },
      props.row || {}
    )
    form.password = ''
    form.permissionOverrides = { ...(props.row?.permissionOverrides || {}) }
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
