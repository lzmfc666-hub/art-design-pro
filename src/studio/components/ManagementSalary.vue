<script setup lang="ts">
  import { computed, reactive, ref } from 'vue'
  import {
    ElAlert,
    ElButton,
    ElDatePicker,
    ElDialog,
    ElEmpty,
    ElForm,
    ElFormItem,
    ElMessage,
    ElMessageBox,
    ElOption,
    ElSelect,
    ElTable,
    ElTableColumn,
    ElTag
  } from 'element-plus'
  import type { Payroll, Role, SalaryPlan } from '@/types/studio'
  import { formatTime, money, roleLabels, useStudio } from '../useStudio'
  import ManagementAmount from './ManagementAmount.vue'

  const props = defineProps<{ month: string }>()
  const { data, user, can, mutate, loading } = useStudio()
  const staff = computed(() => (data.value?.users || []).filter((row) => row.role !== 'player'))
  const lines = computed(() => {
    const visible = (data.value?.reports.payroll || []).filter(
      (row) => can('salary.all') || row.userId === user.value?.id
    )
    // Reports return paid snapshot rows first, followed by new, unpaid adjustments.
    const paidCount = snapshots.value.reduce(
      (sum, record) =>
        sum +
        record.lines.filter((row) => can('salary.all') || row.userId === user.value?.id).length,
      0
    )
    return visible.slice(paidCount)
  })
  const plans = computed(() =>
    (data.value?.salaryPlans || []).filter(
      (row) => can('salary.all') || row.userId === user.value?.id
    )
  )
  const snapshots = computed(() =>
    (data.value?.payrolls || []).filter((row) => row.month === props.month)
  )
  const snapshot = ref<Payroll | null>(null)
  const snapshotLines = computed(() =>
    (snapshot.value?.lines || []).filter(
      (row) => can('salary.all') || row.userId === user.value?.id
    )
  )
  const open = ref(false)
  const saving = ref(false)
  const plan = reactive<{
    id?: string
    userId: string
    mode: SalaryPlan['mode']
    base: number | null
    rate: number | null
    platformRates: Record<string, number | null>
    effectiveFrom: string
    hourlyEnabled: boolean
  }>({
    userId: '',
    mode: 'base_commission',
    base: null,
    rate: null,
    platformRates: {},
    effectiveFrom: '',
    hourlyEnabled: false
  })
  const planRole = computed(() => staff.value.find((row) => row.id === plan.userId)?.role)
  const modeLabels = { base_commission: '底薪 + 提成', commission: '纯提成', fixed: '固定工资' }
  const participating = computed(() =>
    (data.value?.platforms || []).filter((row) => row.operatorCommission)
  )
  function edit(row?: SalaryPlan) {
    Object.assign(
      plan,
      {
        id: undefined,
        userId: '',
        mode: 'base_commission',
        base: null,
        rate: null,
        platformRates: {},
        effectiveFrom: `${props.month}-01`,
        hourlyEnabled: false
      },
      row || {}
    )
    plan.platformRates = Object.fromEntries(
      (data.value?.platforms || []).map((item) => [item.id, row?.platformRates[item.id] ?? null])
    )
    open.value = true
  }
  async function save() {
    if (!plan.userId || !plan.effectiveFrom) return void ElMessage.warning('请选择员工和生效日期')
    if (
      (plan.rate != null && plan.rate > 10000) ||
      Object.values(plan.platformRates).some((value) => value != null && value > 10000)
    )
      return void ElMessage.warning('提成比例不能超过 100%')
    saving.value = true
    try {
      await mutate('/salary-plans', { ...plan, platformRates: { ...plan.platformRates } })
      open.value = false
      ElMessage.success('工资方案已保存')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      saving.value = false
    }
  }
  async function pay() {
    if (loading.value || data.value?.reports.month !== props.month)
      return void ElMessage.warning('请等待当前月份工资加载完成')
    try {
      await ElMessageBox.confirm(
        snapshots.value.length
          ? `确认 ${props.month} 新产生的工资差额已由财务结算？包括后续完成订单的提成及退款扣回，本次不会重复发放已结算金额。`
          : `确认登记 ${props.month} 工资已发放？系统将保存本次金额及提成快照，后续退款差额另记扣回。`,
        snapshots.value.length ? '工资差额补结算' : '月结工资发放',
        {
          confirmButtonText: snapshots.value.length ? '确认已结算' : '确认已发放',
          cancelButtonText: '取消',
          type: 'warning'
        }
      )
    } catch {
      return
    }
    saving.value = true
    try {
      await mutate('/payrolls', { month: props.month })
      ElMessage.success('工资发放快照已保存')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '发放登记失败')
    } finally {
      saving.value = false
    }
  }
</script>

<template>
  <div>
    <ElAlert
      title="工资按订单完成月份计提；已发提成产生的退款差额在退款当月扣回。底薪和比例留空表示待配置，不按 0 元结算。"
      type="info"
      :closable="false"
      show-icon
      class="salary-note"
    />
    <div class="panel-heading"
      ><div
        ><h3
          >{{ month }}
          {{
            snapshots.length ? '待结算工资差额' : can('salary.all') ? '全员工资预核算' : '本人工资'
          }}</h3
        ><p class="muted">{{
          can('salary.all')
            ? '客服工资纳入财务核算，其本人账号不开放工资查看。'
            : '仅展示当前账号的工资数据。'
        }}</p></div
      ><ElButton
        v-if="can('salary.manage')"
        type="primary"
        :loading="saving"
        :disabled="
          loading ||
          data?.reports.month !== month ||
          !lines.length ||
          lines.some((row) => row.incomplete)
        "
        @click="pay"
        >{{
          snapshots.length
            ? lines.length
              ? '登记差额已结算'
              : '本月已发放，无待结算差额'
            : '登记月结工资已发放'
        }}</ElButton
      ></div
    >
    <ElTable :data="lines" stripe
      ><ElTableColumn prop="name" label="员工" min-width="120" /><ElTableColumn
        label="角色"
        width="110"
        ><template #default="{ row }">{{ roleLabels[row.role as Role] }}</template></ElTableColumn
      ><ElTableColumn label="底薪" width="130"
        ><template #default="{ row }">{{ money(row.base) }}</template></ElTableColumn
      ><ElTableColumn label="当月提成" width="130"
        ><template #default="{ row }">{{ money(row.commission) }}</template></ElTableColumn
      ><ElTableColumn label="退款提成扣回" width="150"
        ><template #default="{ row }">{{ money(row.deduction) }}</template></ElTableColumn
      ><ElTableColumn label="应发合计" width="140"
        ><template #default="{ row }"
          ><strong>{{ money(row.total) }}</strong></template
        ></ElTableColumn
      ><ElTableColumn label="状态" width="110"
        ><template #default="{ row }"
          ><ElTag :type="row.incomplete ? 'warning' : 'success'">{{
            row.incomplete ? '配置未齐' : '可结算'
          }}</ElTag></template
        ></ElTableColumn
      ><template #empty
        ><ElEmpty
          :description="
            snapshots.length ? '本月工资已发放，当前没有待结算差额' : '当前月份暂无可见工资数据'
          " /></template
    ></ElTable>
    <div class="panel-heading salary-section"
      ><div
        ><h3>已发放工资快照</h3
        ><p class="muted">发放后保留原记录，后续退款调整不会改写历史发放金额。</p></div
      ></div
    >
    <ElTable :data="snapshots"
      ><ElTableColumn prop="month" label="所属月份" width="150" /><ElTableColumn
        label="登记时间"
        min-width="180"
        ><template #default="{ row }">{{ formatTime(row.paidAt) }}</template></ElTableColumn
      ><ElTableColumn label="经办人" min-width="120"
        ><template #default="{ row }">{{
          data?.users.find((item) => item.id === row.paidBy)?.name || row.paidBy
        }}</template></ElTableColumn
      ><ElTableColumn label="操作" width="100"
        ><template #default="{ row }"
          ><ElButton link type="primary" @click="snapshot = row">查看明细</ElButton></template
        ></ElTableColumn
      ></ElTable
    >
    <template v-if="can('salary.manage')">
      <div class="panel-heading salary-section"
        ><div
          ><h3>员工工资方案</h3
          ><p class="muted">方案支持生效日期；实际订单使用当时的提成归属和比例。</p></div
        ><ElButton @click="edit()">+ 新增工资方案</ElButton></div
      >
      <ElTable :data="plans"
        ><ElTableColumn label="员工" min-width="120"
          ><template #default="{ row }">{{
            staff.find((item) => item.id === row.userId)?.name || row.userId
          }}</template></ElTableColumn
        ><ElTableColumn label="方案" width="140"
          ><template #default="{ row }">{{
            modeLabels[row.mode as SalaryPlan['mode']]
          }}</template></ElTableColumn
        ><ElTableColumn label="底薪" width="130"
          ><template #default="{ row }">{{
            row.mode === 'commission' ? '不适用' : money(row.base)
          }}</template></ElTableColumn
        ><ElTableColumn label="提成比例" min-width="220"
          ><template #default="{ row }"
            ><template v-if="staff.find((item) => item.id === row.userId)?.role === 'operations'">{{
              participating
                .map(
                  (item) =>
                    `${item.name} ${row.platformRates[item.id] == null ? '待配置' : (row.platformRates[item.id]! / 100).toFixed(2) + '%'}`
                )
                .join(' / ') || '无参与平台'
            }}</template
            ><template v-else>{{
              row.mode === 'fixed'
                ? '不适用'
                : row.rate == null
                  ? '待配置'
                  : (row.rate / 100).toFixed(2) + '%'
            }}</template></template
          ></ElTableColumn
        ><ElTableColumn prop="effectiveFrom" label="生效日期" width="130" /><ElTableColumn
          label="操作"
          width="90"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="edit(row)">编辑</ElButton></template
          ></ElTableColumn
        ></ElTable
      >
    </template>
    <ElDialog class="studio-dialog" v-model="open" title="工资方案配置" width="min(600px, 94vw)"
      ><ElForm label-position="top" @submit.prevent="save"
        ><ElFormItem label="员工" required
          ><ElSelect v-model="plan.userId" :disabled="!!plan.id" filterable style="width: 100%"
            ><ElOption
              v-for="item in staff"
              :key="item.id"
              :value="item.id"
              :label="`${item.name} · ${roleLabels[item.role]}`" /></ElSelect></ElFormItem
        ><ElFormItem label="工资方案"
          ><ElSelect v-model="plan.mode" style="width: 100%"
            ><ElOption
              v-for="(label, key) in modeLabels"
              :key="key"
              :label="label"
              :value="key" /></ElSelect></ElFormItem
        ><ElFormItem v-if="plan.mode !== 'commission'" label="底薪 / 固定工资（元）"
          ><ManagementAmount v-model="plan.base" /></ElFormItem
        ><template v-if="plan.mode !== 'fixed'"
          ><template v-if="planRole === 'operations'"
            ><ElFormItem
              v-for="item in participating"
              :key="item.id"
              :label="`${item.name} 运营提成（%）`"
              ><ManagementAmount v-model="plan.platformRates[item.id]!" /></ElFormItem></template
          ><ElFormItem v-else label="客服提成比例（%）"
            ><ManagementAmount v-model="plan.rate" /></ElFormItem></template
        ><ElFormItem label="生效日期" required
          ><ElDatePicker
            v-model="plan.effectiveFrom"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%" /></ElFormItem
        ><p class="muted"
          >金额和比例可留空待配置，配置未齐会阻止月结。按工时计薪暂未启用，考勤不会自动产生工资扣款。</p
        ></ElForm
      ><template #footer
        ><ElButton @click="open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存方案</ElButton></template
      ></ElDialog
    >
    <ElDialog
      class="studio-dialog"
      :model-value="!!snapshot"
      :title="`${snapshot?.month || ''} 工资发放快照`"
      width="min(900px, 94vw)"
      @close="snapshot = null"
      ><ElTable :data="snapshotLines"
        ><ElTableColumn prop="name" label="员工" min-width="110" /><ElTableColumn
          label="底薪"
          min-width="130"
          ><template #default="{ row }">{{ money(row.base) }}</template></ElTableColumn
        ><ElTableColumn label="提成" min-width="130"
          ><template #default="{ row }">{{ money(row.commission) }}</template></ElTableColumn
        ><ElTableColumn label="退款提成扣回" min-width="150"
          ><template #default="{ row }">{{ money(row.deduction) }}</template></ElTableColumn
        ><ElTableColumn label="实发合计" min-width="130"
          ><template #default="{ row }">{{ money(row.total) }}</template></ElTableColumn
        ></ElTable
      ></ElDialog
    >
  </div>
</template>

<style scoped>
  .salary-note {
    margin: 8px 0 24px;
  }

  .salary-section {
    margin-top: 32px;
  }
</style>
