<script setup lang="ts">
  import { computed, reactive, ref } from 'vue'
  import {
    ElButton,
    ElDialog,
    ElEmpty,
    ElForm,
    ElFormItem,
    ElInput,
    ElInputNumber,
    ElMessage,
    ElOption,
    ElSelect,
    ElSwitch,
    ElTable,
    ElTableColumn,
    ElTabPane,
    ElTabs,
    ElTag
  } from 'element-plus'
  import type { Customer, Role, Staff } from '@/types/studio'
  import { roleLabels, useStudio } from '../useStudio'

  const { data, user, can, mutate } = useStudio()
  const tab = ref('staff')
  const query = ref('')
  const isAdmin = computed(() => ['super_admin', 'admin'].includes(user.value?.role || ''))
  const selectableRoles = computed(() =>
    Object.fromEntries(
      Object.entries(roleLabels).filter(
        ([role]) => role !== 'super_admin' || user.value?.role === 'super_admin'
      )
    )
  )
  const staffRows = computed(() =>
    (data.value?.users || []).filter(
      (item) =>
        (tab.value === 'players' ? item.role === 'player' : item.role !== 'player') &&
        `${item.name} ${item.username}`.toLowerCase().includes(query.value.toLowerCase())
    )
  )
  const customers = computed(() =>
    (data.value?.customers || []).filter((item) =>
      `${item.name} ${item.contact} ${item.gameId}`
        .toLowerCase()
        .includes(query.value.toLowerCase())
    )
  )
  const permissions = [
    ['orders.view', '查看全部订单'],
    ['orders.create', '创建和派单'],
    ['orders.edit', '编辑实际订单'],
    ['finance.review', '财务验收'],
    ['finance.refunds', '处理退款'],
    ['finance.withdrawals', '提现发放'],
    ['finance.expenses', '费用记账'],
    ['salary.view', '查看本人工资'],
    ['salary.all', '查看全员工资'],
    ['salary.manage', '工资方案及月结'],
    ['profit.view', '查看工作室利润'],
    ['users.manage', '人员管理'],
    ['templates.manage', '订单模板维护'],
    ['settings.manage', '来源和等级配置'],
    ['attendance.manage', '排班考勤管理'],
    ['logs.view', '查看操作日志']
  ]
  const personOpen = ref(false)
  const customerOpen = ref(false)
  const saving = ref(false)
  const person = reactive({
    id: '',
    username: '',
    name: '',
    role: 'support' as Role,
    status: 'active' as Staff['status'],
    levelId: '',
    maxActiveOrders: 1,
    permissionOverrides: {} as Record<string, boolean>,
    password: ''
  })
  const customer = reactive({ id: '', name: '', contact: '', gameId: '', remark: '' })
  function editPerson(row?: Staff) {
    Object.assign(
      person,
      {
        id: '',
        username: '',
        name: '',
        role: tab.value === 'players' ? 'player' : 'support',
        status: 'active',
        levelId: '',
        maxActiveOrders: 1,
        permissionOverrides: {},
        password: ''
      },
      row || {}
    )
    person.permissionOverrides = { ...(row?.permissionOverrides || {}) }
    personOpen.value = true
  }
  function overrideValue(key: string) {
    return person.permissionOverrides[key] == null
      ? 'default'
      : person.permissionOverrides[key]
        ? 'allow'
        : 'deny'
  }
  function setOverride(key: string, value: string) {
    if (value === 'default') delete person.permissionOverrides[key]
    else person.permissionOverrides[key] = value === 'allow'
  }
  async function savePerson() {
    if (!person.username.trim() || !person.name.trim())
      return void ElMessage.warning('请填写账号和姓名')
    if (!person.id && person.password.length < 8) return void ElMessage.warning('初始密码至少 8 位')
    if (person.password && person.password.length < 8)
      return void ElMessage.warning('重置密码至少 8 位')
    if (person.role === 'player' && !person.levelId) return void ElMessage.warning('请选择打手等级')
    saving.value = true
    try {
      await mutate('/users', {
        ...person,
        id: person.id || undefined,
        password: person.password || undefined,
        levelId: person.levelId || undefined
      })
      personOpen.value = false
      ElMessage.success('人员档案已保存')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      saving.value = false
    }
  }
  function editCustomer(row?: Customer) {
    Object.assign(customer, { id: '', name: '', contact: '', gameId: '', remark: '' }, row || {})
    customerOpen.value = true
  }
  async function saveCustomer() {
    if (!customer.name.trim()) return void ElMessage.warning('请填写客户姓名或称呼')
    saving.value = true
    try {
      await mutate('/customers', { ...customer, id: customer.id || undefined })
      customerOpen.value = false
      ElMessage.success('客户档案已保存')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      saving.value = false
    }
  }
</script>

<template>
  <div>
    <div class="page-heading">
      <div><h2>人员与客户</h2><p>员工、打手与客户分别建档，权限按角色和个人开关管理。</p></div>
      <ElButton
        v-if="can('users.manage') && (tab === 'customers' || isAdmin)"
        type="primary"
        @click="tab === 'customers' ? editCustomer() : editPerson()"
        >{{
          tab === 'customers'
            ? '+ 新增客户'
            : tab === 'players'
              ? '+ 新建打手账号'
              : '+ 新建员工账号'
        }}</ElButton
      >
    </div>
    <div class="panel">
      <ElTabs v-model="tab">
        <ElTabPane label="员工档案" name="staff" />
        <ElTabPane label="打手档案" name="players" />
        <ElTabPane label="客户档案" name="customers" />
      </ElTabs>
      <div class="toolbar"
        ><ElInput
          v-model="query"
          clearable
          :placeholder="tab === 'customers' ? '搜索客户 / 联系方式 / 游戏 ID' : '搜索姓名 / 账号'"
          style="max-width: 340px"
        /><span class="muted">账号创建及密码重置由管理员操作</span></div
      >
      <ElTable v-if="tab !== 'customers'" :data="staffRows" stripe>
        <ElTableColumn prop="name" label="姓名" min-width="130" />
        <ElTableColumn prop="username" label="登录账号" min-width="150" />
        <ElTableColumn label="角色" width="120"
          ><template #default="{ row }">{{
            roleLabels[row.role as Role] || row.role
          }}</template></ElTableColumn
        >
        <ElTableColumn v-if="tab === 'players'" label="等级" width="130"
          ><template #default="{ row }">{{
            data?.levels.find((level) => level.id === row.levelId)?.name || '未设置'
          }}</template></ElTableColumn
        >
        <ElTableColumn v-if="tab === 'players'" label="接单数量 / 上限" width="150"
          ><template #default="{ row }"
            >{{ row.activeOrders ?? 0 }} / {{ row.maxActiveOrders }}</template
          ></ElTableColumn
        >
        <ElTableColumn label="状态" width="100"
          ><template #default="{ row }"
            ><ElTag :type="row.status === 'active' ? 'success' : 'info'">{{
              row.status === 'active' ? '启用' : '停用'
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="个人权限" width="130"
          ><template #default="{ row }"
            >{{ Object.keys(row.permissionOverrides || {}).length }} 项覆盖</template
          ></ElTableColumn
        >
        <ElTableColumn v-if="can('users.manage')" label="操作" width="110" fixed="right"
          ><template #default="{ row }"
            ><ElButton
              v-if="row.role !== 'super_admin' || user?.role === 'super_admin'"
              link
              type="primary"
              @click="editPerson(row)"
              >编辑档案</ElButton
            ></template
          ></ElTableColumn
        >
        <template #empty><ElEmpty description="暂无匹配人员" /></template>
      </ElTable>
      <ElTable v-else :data="customers" stripe>
        <ElTableColumn prop="name" label="客户称呼" min-width="130" />
        <ElTableColumn prop="contact" label="联系方式" min-width="180" />
        <ElTableColumn prop="gameId" label="游戏 ID" min-width="160" />
        <ElTableColumn prop="remark" label="备注" min-width="230" show-overflow-tooltip />
        <ElTableColumn v-if="can('users.manage')" label="操作" width="100"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="editCustomer(row)">编辑</ElButton></template
          ></ElTableColumn
        >
      </ElTable>
    </div>
    <ElDialog
      class="studio-dialog"
      v-model="personOpen"
      :title="person.id ? '编辑人员档案' : '新建人员账号'"
      width="min(760px, 94vw)"
      destroy-on-close
    >
      <ElForm label-position="top" @submit.prevent="savePerson">
        <div class="people-grid">
          <ElFormItem label="姓名 / 称呼" required
            ><ElInput v-model="person.name" maxlength="60"
          /></ElFormItem>
          <ElFormItem label="登录账号" required
            ><ElInput v-model="person.username" :disabled="!isAdmin" maxlength="60"
          /></ElFormItem>
          <ElFormItem label="角色"
            ><ElSelect v-model="person.role" style="width: 100%"
              ><ElOption
                v-for="(label, key) in selectableRoles"
                :key="key"
                :value="key"
                :label="label" /></ElSelect
          ></ElFormItem>
          <ElFormItem label="账号状态"
            ><ElSwitch
              v-model="person.status"
              active-value="active"
              inactive-value="disabled"
              active-text="启用"
              inactive-text="停用"
          /></ElFormItem>
          <ElFormItem v-if="person.role === 'player'" label="打手等级" required
            ><ElSelect v-model="person.levelId" style="width: 100%"
              ><ElOption
                v-for="level in data?.levels"
                :key="level.id"
                :value="level.id"
                :label="level.name" /></ElSelect
          ></ElFormItem>
          <ElFormItem v-if="person.role === 'player'" label="同时接单上限"
            ><ElInputNumber v-model="person.maxActiveOrders" :min="1" :max="100"
          /></ElFormItem>
          <ElFormItem
            v-if="isAdmin"
            :label="person.id ? '重置密码（留空不修改）' : '初始密码'"
            :required="!person.id"
            ><ElInput
              v-model="person.password"
              type="password"
              show-password
              autocomplete="new-password"
              placeholder="至少 8 位"
          /></ElFormItem>
        </div>
        <p v-if="person.role === 'super_admin'" class="muted"
          >超级管理员始终拥有全部权限；账号只能由超级管理员维护。</p
        >
        <p v-else class="muted"
          >个人权限默认继承角色。逐项选择“允许”或“禁止”覆盖角色默认权限；工资及数据范围由接口同步校验。</p
        >
        <div class="people-permissions"
          ><div v-for="[key, label] in permissions" :key="key" class="people-permission"
            ><span>{{ label }}</span
            ><ElSelect
              :disabled="person.role === 'super_admin'"
              :model-value="overrideValue(key!)"
              @update:model-value="setOverride(key!, $event)"
              ><ElOption label="角色默认" value="default" /><ElOption
                label="允许"
                value="allow" /><ElOption label="禁止" value="deny" /></ElSelect></div
        ></div>
      </ElForm>
      <template #footer
        ><ElButton @click="personOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="savePerson"
          >保存档案</ElButton
        ></template
      >
    </ElDialog>
    <ElDialog
      class="studio-dialog"
      v-model="customerOpen"
      :title="customer.id ? '编辑客户' : '新增客户'"
      width="min(520px, 94vw)"
    >
      <ElForm label-position="top" @submit.prevent="saveCustomer"
        ><ElFormItem label="客户称呼" required
          ><ElInput v-model="customer.name" maxlength="60" /></ElFormItem
        ><ElFormItem label="联系方式"
          ><ElInput v-model="customer.contact" maxlength="120" /></ElFormItem
        ><ElFormItem label="客户游戏 ID"
          ><ElInput v-model="customer.gameId" maxlength="120" /></ElFormItem
        ><ElFormItem label="备注"
          ><ElInput
            v-model="customer.remark"
            type="textarea"
            :rows="3"
            maxlength="1000" /></ElFormItem
      ></ElForm>
      <template #footer
        ><ElButton @click="customerOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveCustomer"
          >保存客户</ElButton
        ></template
      >
    </ElDialog>
  </div>
</template>

<style scoped>
  .people-grid,
  .people-permissions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 20px;
  }

  .people-permission {
    display: flex;
    gap: 14px;
    align-items: center;
    justify-content: space-between;
    padding: 9px 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .people-permission .el-select {
    flex-shrink: 0;
    width: 118px;
  }

  @media (width <= 620px) {
    .people-grid,
    .people-permissions {
      grid-template-columns: 1fr;
    }
  }
</style>
