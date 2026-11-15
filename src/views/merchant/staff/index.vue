<script setup lang="ts">
  import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { useStudio, formatTime } from '@/hooks/business/useStudio'
  import { studioRequest } from '@/api/studio'
  import { createStudioMutationIntent } from '@/api/studio-mutation'
  import {
    isMerchantOwner,
    canDeleteMerchantAccount,
    canEditMerchantAccount
  } from '@/utils/auth/studio-user'
  import type { Staff } from '@/types/studio'

  const { user, mutate, clearSession } = useStudio()
  const allowed = computed(() => isMerchantOwner(user.value))
  const rows = ref<Staff[]>([])
  const loading = ref(false)
  const loadError = ref('')
  const query = ref('')
  const visibleRows = computed(() =>
    rows.value.filter(
      (row) =>
        !row.deletedAt &&
        `${row.username} ${row.name}`.toLowerCase().includes(query.value.trim().toLowerCase())
    )
  )
  let version = 0
  let controller: AbortController | null = null
  async function loadStaff() {
    if (!allowed.value) return
    const current = ++version
    const actorId = user.value?.id
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    loadError.value = ''
    try {
      const result = await studioRequest<{ records: Staff[] }>(
        'merchant/staff',
        undefined,
        'GET',
        controller.signal
      )
      if (current === version && actorId === user.value?.id && allowed.value)
        rows.value = result.records
    } catch (error) {
      if (current !== version || (error as Error).name === 'AbortError') return
      rows.value = []
      if ((error as { status?: number }).status === 401) clearSession()
      loadError.value = error instanceof Error ? error.message : '客服账号读取失败'
    } finally {
      if (current === version) loading.value = false
    }
  }

  const dialogVisible = ref(false)
  const editing = ref<Staff | null>(null)
  const formRef = ref<FormInstance>()
  const form = reactive({
    username: '',
    name: '',
    status: 'active' as Staff['status'],
    password: ''
  })
  const saving = ref(false)
  const uncertain = ref(false)
  const saveIntent = createStudioMutationIntent()
  const rules: FormRules = {
    username: [
      { required: true, message: '请输入登录账号', trigger: 'blur' },
      { pattern: /^[a-zA-Z0-9_.@-]+$/, message: '仅支持字母、数字和 _.@-', trigger: 'blur' }
    ],
    name: [{ required: true, message: '请输入客服昵称', trigger: 'blur' }],
    password: [
      {
        validator: (_rule, value, callback) =>
          callback(
            (!editing.value || value) && (value.length < 8 || value.length > 128)
              ? new Error('密码长度应为 8 至 128 位')
              : undefined
          ),
        trigger: 'blur'
      }
    ]
  }
  function edit(row?: Staff) {
    if (
      !allowed.value ||
      saving.value ||
      uncertain.value ||
      (row && !canEditMerchantAccount(user.value, row))
    )
      return
    saveIntent.complete()
    editing.value = row || null
    Object.assign(form, {
      username: row?.username || '',
      name: row?.name || '',
      status: row?.status || 'active',
      password: ''
    })
    formRef.value?.clearValidate()
    dialogVisible.value = true
  }
  async function save() {
    if (
      !allowed.value ||
      saving.value ||
      (editing.value && !canEditMerchantAccount(user.value, editing.value))
    )
      return
    if (!(await formRef.value?.validate().catch(() => false))) return
    const body = editing.value
      ? {
          id: editing.value.id,
          name: form.name,
          status: form.status,
          ...(form.password ? { password: form.password } : {})
        }
      : { username: form.username, name: form.name, status: form.status, password: form.password }
    saving.value = true
    try {
      await mutate('/merchant/staff', saveIntent.prepare('/merchant/staff', body))
      saveIntent.complete()
      uncertain.value = false
      dialogVisible.value = false
      form.password = ''
      ElMessage.success('客服账号已保存')
      await loadStaff()
    } catch (error) {
      saveIntent.fail(error)
      uncertain.value = saveIntent.uncertain
      ElMessage.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      saving.value = false
    }
  }

  const deleting = ref(false)
  const pendingDelete = ref<Staff | null>(null)
  const deleteIntent = createStudioMutationIntent()
  async function remove(row: Staff, retry = false) {
    if (deleting.value || !canDeleteMerchantAccount(user.value, row)) return
    if (pendingDelete.value && pendingDelete.value.id !== row.id) return
    if (!retry) {
      try {
        await ElMessageBox.confirm(
          `删除客服“${row.name}”？该账号将不能登录，登录账号可重新使用；历史订单、操作责任与记录继续保留，在途订单仍由本商家继续处理。`,
          '删除客服',
          {
            confirmButtonText: '删除登录资格',
            cancelButtonText: '取消',
            type: 'warning'
          }
        )
      } catch {
        return
      }
    }
    deleting.value = true
    try {
      const path = `/merchant/staff/${row.id}/delete`
      await mutate(path, deleteIntent.prepare(path, {}))
      deleteIntent.complete()
      pendingDelete.value = null
      ElMessage.success('客服登录资格已删除，历史记录已保留')
      await loadStaff()
    } catch (error) {
      deleteIntent.fail(error)
      pendingDelete.value = deleteIntent.uncertain ? row : null
      ElMessage.error(error instanceof Error ? error.message : '删除失败')
    } finally {
      deleting.value = false
    }
  }

  watch(
    () => `${user.value?.id}:${user.value?.merchantId}:${user.value?.merchantRole}`,
    () => {
      ++version
      controller?.abort()
      rows.value = []
      dialogVisible.value = false
      Object.assign(form, { username: '', name: '', status: 'active', password: '' })
      editing.value = null
      uncertain.value = false
      pendingDelete.value = null
      saveIntent.complete()
      deleteIntent.complete()
      if (allowed.value) void loadStaff()
    },
    { immediate: true }
  )
  onBeforeUnmount(() => {
    ++version
    controller?.abort()
    form.password = ''
  })
</script>

<template>
  <div>
    <BusinessPageHeader
      title="客服管理"
      description="管理本商家客服。客服共享本商家订单，可派单、跟进和取消未验收订单；按商家统一结算，保留每位客服的操作责任。"
      icon="ri:customer-service-2-line"
    />
    <ElAlert v-if="!allowed" title="仅本商家主账号可以管理客服" type="warning" :closable="false" />
    <ElCard v-else shadow="never">
      <ElAlert v-if="loadError" :title="loadError" type="error" :closable="false" class="mb-4" />
      <ElAlert
        v-if="pendingDelete"
        title="上次删除的结果尚未确认，请重试原操作。"
        type="warning"
        :closable="false"
        class="mb-4"
      >
        <ElButton :loading="deleting" @click="remove(pendingDelete, true)">重试删除</ElButton>
      </ElAlert>
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <ElButton type="primary" :disabled="!!pendingDelete" @click="edit()">新增客服</ElButton>
        <ElInput v-model="query" placeholder="搜索登录账号或客服昵称" clearable class="!w-64" />
        <ElButton :loading="loading" @click="loadStaff">刷新</ElButton>
        <span class="text-sm text-g-500">共 {{ visibleRows.length }} 个客服账号</span>
      </div>
      <ElTable v-loading="loading" :data="visibleRows" row-key="id">
        <ElTableColumn prop="username" label="登录账号" min-width="160" />
        <ElTableColumn prop="name" label="客服昵称" min-width="150" />
        <ElTableColumn label="状态" width="100"
          ><template #default="{ row }"
            ><ElTag :type="row.status === 'active' ? 'success' : 'info'">{{
              row.status === 'active' ? '启用' : '停用'
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="创建时间" min-width="180"
          ><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></ElTableColumn
        >
        <ElTableColumn label="操作" width="200" fixed="right"
          ><template #default="{ row }">
            <ElButton
              v-if="canEditMerchantAccount(user, row)"
              link
              type="primary"
              :disabled="!!pendingDelete || deleting"
              @click="edit(row)"
              >编辑客服</ElButton
            >
            <ElButton
              v-if="canDeleteMerchantAccount(user, row)"
              link
              type="danger"
              :disabled="!!pendingDelete || deleting"
              @click="remove(row)"
              >删除客服</ElButton
            >
          </template></ElTableColumn
        >
      </ElTable>
      <p class="text-sm text-g-500 mt-4"
        >离职可先停用；删除只取消登录资格，历史归属保留。主账号交接由总后台超级管理员处理。</p
      >
    </ElCard>
    <ElDialog
      v-model="dialogVisible"
      :title="editing ? '编辑客服' : '新增客服'"
      width="min(520px, 94vw)"
      destroy-on-close
      :close-on-click-modal="!saving && !uncertain"
      :close-on-press-escape="!saving && !uncertain"
      :show-close="!saving && !uncertain"
    >
      <ElAlert
        v-if="uncertain"
        title="保存结果尚未确认，请按原内容重试保存。"
        type="warning"
        :closable="false"
        class="mb-4"
      />
      <ElForm
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        :disabled="saving || uncertain"
        @submit.prevent="save"
      >
        <ElFormItem label="登录账号" prop="username"
          ><ElInput v-model="form.username" :disabled="!!editing" maxlength="64" autocomplete="off"
        /></ElFormItem>
        <ElFormItem label="客服昵称" prop="name"
          ><ElInput v-model="form.name" maxlength="100"
        /></ElFormItem>
        <ElFormItem :label="editing ? '重置密码（留空保持原密码）' : '初始密码'" prop="password"
          ><ElInput
            v-model="form.password"
            type="password"
            show-password
            autocomplete="new-password"
            maxlength="128"
            placeholder="8 至 128 位"
        /></ElFormItem>
        <ElFormItem label="账号状态"
          ><ElSwitch
            v-model="form.status"
            active-value="active"
            inactive-value="disabled"
            active-text="启用"
            inactive-text="停用"
        /></ElFormItem>
      </ElForm>
      <template #footer
        ><ElButton :disabled="saving || uncertain" @click="dialogVisible = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">{{
          uncertain ? '重试保存' : '保存客服'
        }}</ElButton></template
      >
    </ElDialog>
  </div>
</template>
