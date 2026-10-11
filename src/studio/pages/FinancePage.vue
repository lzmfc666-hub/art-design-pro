<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import {
    ElAlert,
    ElButton,
    ElDatePicker,
    ElDialog,
    ElEmpty,
    ElForm,
    ElFormItem,
    ElInput,
    ElMessage,
    ElMessageBox,
    ElOption,
    ElSelect,
    ElSwitch,
    ElTable,
    ElTableColumn,
    ElTabPane,
    ElTabs,
    ElTag
  } from 'element-plus'
  import type { Attachment, Expense, Refund, Withdrawal } from '@/types/studio'
  import { formatTime, money, useStudio } from '../useStudio'
  import ManagementAmount from '../components/ManagementAmount.vue'
  import ManagementSalary from '../components/ManagementSalary.vue'
  import ManagementUpload from '../components/ManagementUpload.vue'

  const { data, can, mutate, refresh } = useStudio()
  const router = useRouter()
  const tabs = computed(() =>
    [
      { name: 'review', label: '订单验收', visible: can('finance.review') },
      { name: 'refunds', label: '退款处理', visible: can('finance.refunds') },
      { name: 'withdrawals', label: '打手提现', visible: can('finance.withdrawals') },
      { name: 'expenses', label: '费用报账', visible: can('finance.expenses') },
      {
        name: 'salary',
        label: can('salary.all') ? '员工工资' : '本人工资',
        visible: can('salary.view') || can('salary.all') || can('salary.manage')
      },
      { name: 'reports', label: '经营报表', visible: can('profit.view') }
    ].filter((item) => item.visible)
  )
  const tab = ref('')
  watch(
    tabs,
    (value) => {
      if (!value.some((item) => item.name === tab.value)) tab.value = value[0]?.name || ''
    },
    { immediate: true }
  )
  const month = ref(
    data.value?.reports.month ||
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7)
  )
  const saving = ref(false)
  const filter = ref('')
  const includeDeleted = ref(false)
  const reviewOrders = computed(() =>
    (data.value?.orders || []).filter((row) => row.status === 'review')
  )
  const refunds = computed(() =>
    (data.value?.refunds || [])
      .filter(
        (row) =>
          !filter.value ||
          row.status === filter.value ||
          (filter.value === 'manual' && row.manualRewardReview && !row.manualResolution)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const withdrawals = computed(() =>
    (data.value?.withdrawals || [])
      .filter((row) => !filter.value || row.status === filter.value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const expenses = computed(() =>
    (data.value?.expenses || [])
      .filter((row) => includeDeleted.value || !row.deletedAt)
      .sort((a, b) => b.date.localeCompare(a.date))
  )
  const totals = computed(() =>
    (data.value?.reports.days || []).reduce(
      (sum, row) => ({
        received: sum.received + row.received,
        refunds: sum.refunds + row.refunds,
        net: sum.net + row.net,
        reward: sum.reward + row.reward,
        expenses: sum.expenses + row.expenses
      }),
      { received: 0, refunds: 0, net: 0, reward: 0, expenses: 0 }
    )
  )
  watch(tab, () => {
    filter.value = ''
  })
  function personName(id: string) {
    return data.value?.users.find((item) => item.id === id)?.name || id
  }
  function orderName(id: string) {
    return data.value?.orders.find((item) => item.id === id)?.orderNo || id
  }
  function viewOrder(id: string) {
    router.push({ path: '/orders', query: { id } })
  }
  async function changeMonth(value: string | null) {
    if (!value) return
    try {
      await refresh(value)
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '查询失败')
    }
  }
  async function action(path: string, body: Record<string, unknown>, message: string) {
    saving.value = true
    try {
      await mutate(path, body)
      ElMessage.success(message)
      return true
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '操作失败')
      return false
    } finally {
      saving.value = false
    }
  }
  const actionDialog = reactive({
    open: false,
    title: '',
    path: '',
    action: '',
    reason: '',
    required: false
  })
  function reasonAction(path: string, value: string, title: string) {
    Object.assign(actionDialog, {
      open: true,
      title,
      path,
      action: value,
      reason: '',
      required: true
    })
  }
  async function saveReason() {
    if (!actionDialog.reason.trim()) return void ElMessage.warning('请填写处理原因或说明')
    if (
      await action(
        actionDialog.path,
        { action: actionDialog.action, reason: actionDialog.reason },
        '处理结果已保存'
      )
    )
      actionDialog.open = false
  }
  async function approveRefund(row: Refund) {
    try {
      await ElMessageBox.confirm(
        `确认已向客户实际退款 ${money(row.amount)}？退款将归属原订单付款日统计。`,
        '审核并登记退款',
        { type: 'warning', confirmButtonText: '确认已退款', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    await action(`/refunds/${row.id}/action`, { action: 'approve' }, '退款已登记')
  }
  async function approveWithdrawal(row: Withdrawal) {
    try {
      await ElMessageBox.confirm(
        `确认审核通过 ${personName(row.userId)} 的 ${money(row.amount)} 提现申请？`,
        '提现审核',
        { confirmButtonText: '审核通过', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    await action(`/withdrawals/${row.id}/action`, { action: 'approve' }, '提现已审核，等待人工转账')
  }
  const payDialog = reactive({
    open: false,
    id: '',
    name: '',
    amount: 0,
    receipt: null as Attachment | null
  })
  function openPay(row: Withdrawal) {
    Object.assign(payDialog, {
      open: true,
      id: row.id,
      name: personName(row.userId),
      amount: row.amount,
      receipt: null
    })
  }
  async function savePay() {
    if (!payDialog.receipt) return void ElMessage.warning('请上传实际转账凭证')
    if (
      await action(
        `/withdrawals/${payDialog.id}/action`,
        { action: 'pay', receipt: payDialog.receipt },
        '已登记发放'
      )
    )
      payDialog.open = false
  }
  const expenseDialog = reactive({
    open: false,
    category: '',
    amount: null as number | null,
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    purpose: '',
    receipt: null as Attachment | null
  })
  function newExpense() {
    Object.assign(expenseDialog, {
      open: true,
      category: '',
      amount: null,
      date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
      purpose: '',
      receipt: null
    })
  }
  async function saveExpense() {
    if (
      !expenseDialog.category.trim() ||
      !expenseDialog.purpose.trim() ||
      !expenseDialog.date ||
      expenseDialog.amount == null ||
      expenseDialog.amount <= 0 ||
      !expenseDialog.receipt
    )
      return void ElMessage.warning('请填写类别、有效金额、日期、用途并上传费用凭证')
    const { category, amount, date, purpose, receipt } = expenseDialog
    if (await action('/expenses', { category, amount, date, purpose, receipt }, '费用已直接入账'))
      expenseDialog.open = false
  }
  async function removeExpense(row: Expense) {
    const restore = !!row.deletedAt
    try {
      await ElMessageBox.confirm(
        restore
          ? '恢复这笔费用并重新计入统计？'
          : '删除这笔费用并撤回统计影响？原记录及日志仍保留，可恢复。',
        restore ? '恢复费用' : '删除费用',
        { type: 'warning', confirmButtonText: restore ? '恢复' : '删除', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    await action(
      `/expenses/${row.id}/action`,
      { action: restore ? 'restore' : 'delete' },
      restore ? '费用已恢复' : '费用已删除，可恢复'
    )
  }
  const refundDialog = reactive({
    open: false,
    orderId: '',
    amount: null as number | null,
    reason: ''
  })
  const refundableOrders = computed(() =>
    (data.value?.orders || []).filter((row) => {
      const platform = data.value?.platforms.find((item) => item.id === row.platformId)
      return (
        !platform?.name.includes('大厅') &&
        row.receivedAmount >
          (data.value?.refunds || [])
            .filter((item) => item.orderId === row.id && item.status === 'paid')
            .reduce((sum, item) => sum + item.amount, 0)
      )
    })
  )
  function newRefund() {
    Object.assign(refundDialog, { open: true, orderId: '', amount: null, reason: '' })
  }
  const refundableAmount = computed(() => {
    const order = data.value?.orders.find((row) => row.id === refundDialog.orderId)
    return order
      ? order.receivedAmount -
          (data.value?.refunds || [])
            .filter((row) => row.orderId === order.id && ['paid', 'pending'].includes(row.status))
            .reduce((sum, row) => sum + row.amount, 0)
      : 0
  })
  async function saveRefund() {
    if (
      !refundDialog.orderId ||
      !refundDialog.reason.trim() ||
      refundDialog.amount == null ||
      refundDialog.amount <= 0 ||
      refundDialog.amount > refundableAmount.value
    )
      return void ElMessage.warning('请选择订单，填写有效退款金额与原因')
    if (
      await action(
        '/refunds',
        { orderId: refundDialog.orderId, amount: refundDialog.amount, reason: refundDialog.reason },
        '实际退款已登记'
      )
    )
      refundDialog.open = false
  }
</script>

<template>
  <div>
    <div class="page-heading"
      ><div><h2>财务工作台</h2><p>验收、退款、人工发放与经营核算，每笔操作保留审计记录。</p></div
      ><ElDatePicker
        v-if="['salary', 'reports'].includes(tab)"
        v-model="month"
        type="month"
        value-format="YYYY-MM"
        :clearable="false"
        style="width: 160px"
        @change="changeMonth"
    /></div>
    <div v-if="tabs.length" class="panel">
      <ElTabs v-model="tab"
        ><ElTabPane v-for="item in tabs" :key="item.name" :name="item.name" :label="item.label"
      /></ElTabs>
      <template v-if="tab === 'review'">
        <div class="panel-heading"
          ><div
            ><h3
              >待验收订单 <ElTag>{{ reviewOrders.length }}</ElTag></h3
            ><p class="muted"
              >查看负责人提交的截图与队友信息后验收。验收通过后才形成可提现报酬。</p
            ></div
          ></div
        >
        <ElTable :data="reviewOrders" stripe
          ><ElTableColumn prop="orderNo" label="订单号" min-width="180" /><ElTableColumn
            prop="title"
            label="订单项目"
            min-width="160" /><ElTableColumn label="负责人" width="130"
            ><template #default="{ row }">{{
              personName(row.leaderId || row.assignedTo || '')
            }}</template></ElTableColumn
          ><ElTableColumn label="客户收款" width="140"
            ><template #default="{ row }">{{ money(row.receivedAmount) }}</template></ElTableColumn
          ><ElTableColumn label="整单报酬" width="130"
            ><template #default="{ row }">{{ money(row.reward) }}</template></ElTableColumn
          ><ElTableColumn label="完成截图" width="120"
            ><template #default="{ row }"
              >{{ row.submissions.at(-1)?.screenshots.length || 0 }} 张</template
            ></ElTableColumn
          ><ElTableColumn label="操作" width="140"
            ><template #default="{ row }"
              ><ElButton type="primary" link @click="viewOrder(row.id)"
                >核查并验收</ElButton
              ></template
            ></ElTableColumn
          ><template #empty><ElEmpty description="当前没有待验收订单" /></template
        ></ElTable>
      </template>
      <template v-if="tab === 'refunds'">
        <div class="toolbar"
          ><ElSelect v-model="filter" clearable placeholder="全部退款记录" style="width: 190px"
            ><ElOption label="待审核" value="pending" /><ElOption
              label="已退款"
              value="paid" /><ElOption label="已驳回" value="rejected" /><ElOption
              label="报酬差额待人工处理"
              value="manual" /></ElSelect
          ><ElButton type="primary" @click="newRefund">+ 登记实际退款</ElButton></div
        >
        <ElAlert
          title="退款回到原付款日调整经营统计。打手已经提现后的报酬差额，由财务人工确认并登记处理结果，不自动扣回打手余额；报酬更正从订单详情操作。"
          type="warning"
          :closable="false"
          show-icon
          class="finance-note"
        />
        <ElTable :data="refunds" stripe
          ><ElTableColumn label="关联订单" min-width="170"
            ><template #default="{ row }"
              ><ElButton link type="primary" @click="viewOrder(row.orderId)">{{
                orderName(row.orderId)
              }}</ElButton></template
            ></ElTableColumn
          ><ElTableColumn label="退款金额" width="125"
            ><template #default="{ row }">{{ money(row.amount) }}</template></ElTableColumn
          ><ElTableColumn
            prop="reason"
            label="原因"
            min-width="180"
            show-overflow-tooltip
          /><ElTableColumn label="申请 / 实退时间" min-width="180"
            ><template #default="{ row }">{{
              formatTime(row.processedAt || row.createdAt)
            }}</template></ElTableColumn
          ><ElTableColumn label="状态" width="110"
            ><template #default="{ row }"
              ><ElTag
                :type="
                  row.status === 'paid' ? 'success' : row.status === 'rejected' ? 'info' : 'warning'
                "
                >{{
                  row.status === 'pending' ? '待审核' : row.status === 'paid' ? '已退款' : '已驳回'
                }}</ElTag
              ></template
            ></ElTableColumn
          ><ElTableColumn label="报酬差额" min-width="180"
            ><template #default="{ row }"
              ><ElTag v-if="row.manualRewardReview && !row.manualResolution" type="warning"
                >待财务人工处理</ElTag
              ><span v-else-if="row.manualResolution" :title="row.manualResolution"
                >已登记：{{ row.manualResolution }}</span
              ><span v-else class="muted">—</span></template
            ></ElTableColumn
          ><ElTableColumn label="操作" width="170" fixed="right"
            ><template #default="{ row }"
              ><template v-if="row.status === 'pending'"
                ><ElButton link type="primary" :disabled="saving" @click="approveRefund(row)"
                  >确认退款</ElButton
                ><ElButton
                  link
                  type="danger"
                  @click="reasonAction(`/refunds/${row.id}/action`, 'reject', '驳回退款申请')"
                  >驳回</ElButton
                ></template
              ><ElButton
                v-if="row.manualRewardReview && !row.manualResolution"
                link
                type="primary"
                @click="
                  reasonAction(`/refunds/${row.id}/action`, 'resolve', '登记报酬差额人工处理结果')
                "
                >登记处理</ElButton
              ></template
            ></ElTableColumn
          ></ElTable
        >
      </template>
      <template v-if="tab === 'withdrawals'">
        <div class="toolbar"
          ><ElSelect v-model="filter" clearable placeholder="全部提现记录" style="width: 180px"
            ><ElOption label="待审核" value="pending" /><ElOption
              label="待发放"
              value="approved" /><ElOption label="已发放" value="paid" /><ElOption
              label="已驳回"
              value="rejected" /></ElSelect
          ><span class="muted">提现先占用额度；审核通过后由财务人工转账，再登记发放。</span></div
        >
        <ElTable :data="withdrawals" stripe
          ><ElTableColumn label="打手" min-width="120"
            ><template #default="{ row }">{{ personName(row.userId) }}</template></ElTableColumn
          ><ElTableColumn label="申请金额" width="140"
            ><template #default="{ row }"
              ><strong>{{ money(row.amount) }}</strong></template
            ></ElTableColumn
          ><ElTableColumn label="申请时间" min-width="175"
            ><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></ElTableColumn
          ><ElTableColumn label="状态" width="110"
            ><template #default="{ row }"
              ><ElTag
                :type="
                  row.status === 'paid' ? 'success' : row.status === 'rejected' ? 'info' : 'warning'
                "
                >{{
                  { pending: '待审核', approved: '待发放', paid: '已发放', rejected: '已驳回' }[
                    row.status as Withdrawal['status']
                  ]
                }}</ElTag
              ></template
            ></ElTableColumn
          ><ElTableColumn label="发放时间 / 原因" min-width="180"
            ><template #default="{ row }">{{
              row.paidAt ? formatTime(row.paidAt) : row.reason || '—'
            }}</template></ElTableColumn
          ><ElTableColumn label="凭证" width="100"
            ><template #default="{ row }"
              ><a v-if="row.receipt" :href="row.receipt.url" target="_blank" rel="noopener"
                >查看凭证</a
              ><span v-else>—</span></template
            ></ElTableColumn
          ><ElTableColumn label="操作" width="180" fixed="right"
            ><template #default="{ row }"
              ><template v-if="row.status === 'pending'"
                ><ElButton link type="primary" :disabled="saving" @click="approveWithdrawal(row)"
                  >审核通过</ElButton
                ><ElButton
                  link
                  type="danger"
                  @click="reasonAction(`/withdrawals/${row.id}/action`, 'reject', '驳回提现申请')"
                  >驳回</ElButton
                ></template
              ><ElButton
                v-if="row.status === 'approved'"
                type="primary"
                size="small"
                @click="openPay(row)"
                >登记已转账</ElButton
              ><ElButton
                v-if="row.status === 'approved'"
                link
                type="danger"
                @click="
                  reasonAction(`/withdrawals/${row.id}/action`, 'reject', '驳回尚未发放的提现申请')
                "
                >驳回</ElButton
              ></template
            ></ElTableColumn
          ></ElTable
        >
      </template>
      <template v-if="tab === 'expenses'">
        <div class="toolbar"
          ><ElButton type="primary" @click="newExpense">+ 录入费用</ElButton
          ><ElSwitch v-model="includeDeleted" active-text="显示已删除记录" /><span class="muted"
            >费用提交即入账，误录可删除并恢复。</span
          ></div
        >
        <ElTable :data="expenses" stripe
          ><ElTableColumn prop="date" label="发生日期" width="130" /><ElTableColumn
            prop="category"
            label="类别"
            width="130"
          /><ElTableColumn label="金额" width="130"
            ><template #default="{ row }">{{ money(row.amount) }}</template></ElTableColumn
          ><ElTableColumn
            prop="purpose"
            label="用途"
            min-width="220"
            show-overflow-tooltip
          /><ElTableColumn label="经办人" width="120"
            ><template #default="{ row }">{{ personName(row.createdBy) }}</template></ElTableColumn
          ><ElTableColumn label="状态" width="100"
            ><template #default="{ row }"
              ><ElTag :type="row.deletedAt ? 'info' : 'success'">{{
                row.deletedAt ? '已删除' : '已入账'
              }}</ElTag></template
            ></ElTableColumn
          ><ElTableColumn label="凭证" width="100"
            ><template #default="{ row }"
              ><a v-if="row.receipt" :href="row.receipt.url" target="_blank" rel="noopener"
                >查看凭证</a
              ><span v-else>—</span></template
            ></ElTableColumn
          ><ElTableColumn label="操作" width="100"
            ><template #default="{ row }"
              ><ElButton
                link
                :type="row.deletedAt ? 'primary' : 'danger'"
                :disabled="saving"
                @click="removeExpense(row)"
                >{{ row.deletedAt ? '恢复' : '删除' }}</ElButton
              ></template
            ></ElTableColumn
          ></ElTable
        >
      </template>
      <ManagementSalary v-if="tab === 'salary'" :month="month" />
      <template v-if="tab === 'reports'">
        <ElAlert
          title="经营数据按客户原付款日归属；退款、完成后提成及报酬更正回改原付款日。预计打手成本已计入，提现发放不再重复扣成本。日报不扣底薪，月报再扣当月底薪。"
          type="info"
          :closable="false"
          show-icon
          class="finance-note"
        />
        <div class="metric-grid finance-metrics"
          ><div class="metric-card"
            ><span>客户收款</span><strong>{{ money(totals.received) }}</strong></div
          ><div class="metric-card"
            ><span>累计退款</span><strong>{{ money(totals.refunds) }}</strong></div
          ><div class="metric-card"
            ><span>净收入</span><strong>{{ money(totals.net) }}</strong></div
          ><div class="metric-card"
            ><span>月度利润（扣底薪）</span
            ><strong>{{ money(data?.reports.monthlyProfit ?? null) }}</strong></div
          ></div
        >
        <div class="panel-heading"
          ><h3>{{ data?.reports.month }} 每日经营明细</h3
          ><span class="muted">月度底薪：{{ money(data?.reports.monthlyBase ?? null) }}</span></div
        >
        <ElTable :data="data?.reports.days || []" stripe
          ><ElTableColumn prop="date" label="付款归属日" width="130" /><ElTableColumn
            label="收款"
            width="120"
            ><template #default="{ row }">{{ money(row.received) }}</template></ElTableColumn
          ><ElTableColumn label="累计退款" width="120"
            ><template #default="{ row }">{{ money(row.refunds) }}</template></ElTableColumn
          ><ElTableColumn label="净收入" width="120"
            ><template #default="{ row }">{{ money(row.net) }}</template></ElTableColumn
          ><ElTableColumn label="打手成本" width="130"
            ><template #default="{ row }"
              >{{ money(row.reward)
              }}<small v-if="row.estimatedReward" class="muted finance-secondary"
                >含预计 {{ money(row.estimatedReward) }}</small
              ></template
            ></ElTableColumn
          ><ElTableColumn label="客服提成" width="120"
            ><template #default="{ row }">{{
              money(row.supportCommission)
            }}</template></ElTableColumn
          ><ElTableColumn label="运营提成" width="120"
            ><template #default="{ row }">{{
              money(row.operationsCommission)
            }}</template></ElTableColumn
          ><ElTableColumn label="其他费用" width="120"
            ><template #default="{ row }">{{ money(row.expenses) }}</template></ElTableColumn
          ><ElTableColumn label="日报利润" width="140"
            ><template #default="{ row }"
              ><strong>{{ money(row.profit) }}</strong
              ><small v-if="row.incomplete" class="finance-secondary">配置未齐</small></template
            ></ElTableColumn
          ></ElTable
        >
        <div class="panel-heading finance-section"><h3>来源平台 / 店铺经营</h3></div
        ><ElTable :data="data?.reports.channels || []"
          ><ElTableColumn prop="name" label="来源 / 店铺" min-width="200" /><ElTableColumn
            prop="orders"
            label="订单数"
            width="120"
          /><ElTableColumn label="收款" min-width="140"
            ><template #default="{ row }">{{ money(row.received) }}</template></ElTableColumn
          ><ElTableColumn label="累计退款" min-width="140"
            ><template #default="{ row }">{{ money(row.refunds) }}</template></ElTableColumn
          ><ElTableColumn label="净收入" min-width="140"
            ><template #default="{ row }">{{ money(row.net) }}</template></ElTableColumn
          ></ElTable
        >
      </template>
    </div>
    <div v-else class="panel"><ElEmpty description="当前账号没有财务或工资查看权限" /></div>
    <ElDialog v-model="actionDialog.open" :title="actionDialog.title" width="min(560px, 94vw)"
      ><ElAlert
        v-if="actionDialog.action === 'resolve'"
        title="请记录财务确认的差额、处理方式和结果。本操作只登记人工处理说明，不自动追回或扣减打手余额。"
        type="warning"
        :closable="false"
        class="finance-note"
      /><ElInput
        v-model="actionDialog.reason"
        type="textarea"
        :rows="5"
        maxlength="2000"
        show-word-limit
        placeholder="填写原因 / 具体处理结果"
      /><template #footer
        ><ElButton @click="actionDialog.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveReason"
          >保存处理结果</ElButton
        ></template
      ></ElDialog
    >
    <ElDialog v-model="payDialog.open" title="登记提现已发放" width="min(540px, 94vw)"
      ><p>{{ payDialog.name }} · 实际转账 {{ money(payDialog.amount) }}</p
      ><p class="muted">请完成实际人工转账后上传凭证，系统记录本次发放时间及经办人。</p
      ><ManagementUpload v-model="payDialog.receipt" /><template #footer
        ><ElButton @click="payDialog.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="savePay">确认已发放</ElButton></template
      ></ElDialog
    >
    <ElDialog v-model="expenseDialog.open" title="录入费用（提交即入账）" width="min(560px, 94vw)"
      ><ElForm label-position="top" @submit.prevent="saveExpense"
        ><ElFormItem label="费用类别" required
          ><ElInput
            v-model="expenseDialog.category"
            placeholder="如房租、设备、推广、日常支出"
            maxlength="100" /></ElFormItem
        ><ElFormItem label="金额（元）" required
          ><ManagementAmount
            v-model="expenseDialog.amount"
            placeholder="填写实际支出" /></ElFormItem
        ><ElFormItem label="发生日期" required
          ><ElDatePicker
            v-model="expenseDialog.date"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%" /></ElFormItem
        ><ElFormItem label="用途" required
          ><ElInput
            v-model="expenseDialog.purpose"
            type="textarea"
            :rows="3"
            maxlength="1000" /></ElFormItem
        ><ElFormItem label="费用凭证" required
          ><ManagementUpload v-model="expenseDialog.receipt" /></ElFormItem></ElForm
      ><template #footer
        ><ElButton @click="expenseDialog.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveExpense"
          >提交入账</ElButton
        ></template
      ></ElDialog
    >
    <ElDialog v-model="refundDialog.open" title="登记已实际发生的退款" width="min(620px, 94vw)"
      ><ElForm label-position="top" @submit.prevent="saveRefund"
        ><ElFormItem label="关联订单（不含大厅来源）" required
          ><ElSelect v-model="refundDialog.orderId" filterable style="width: 100%"
            ><ElOption
              v-for="row in refundableOrders"
              :key="row.id"
              :value="row.id"
              :label="`${row.orderNo} · ${row.title}`" /></ElSelect></ElFormItem
        ><ElFormItem label="退款金额（元）" required
          ><ManagementAmount v-model="refundDialog.amount" placeholder="实际退款金额" /></ElFormItem
        ><p class="muted">可申请余额：{{ money(refundableAmount) }}，已扣除待审核申请占用。</p
        ><ElFormItem label="退款原因" required
          ><ElInput
            v-model="refundDialog.reason"
            type="textarea"
            :rows="3"
            maxlength="2000" /></ElFormItem
        ><ElAlert
          title="财务直接登记即视为已退款。请先完成实际退款，再保存记录。"
          type="warning"
          :closable="false" /></ElForm
      ><template #footer
        ><ElButton @click="refundDialog.open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveRefund"
          >确认实际退款并登记</ElButton
        ></template
      ></ElDialog
    >
  </div>
</template>

<style scoped>
  .finance-note {
    margin: 8px 0 22px;
  }

  .finance-section {
    margin-top: 30px;
  }

  .finance-metrics {
    margin-top: 22px;
  }

  .finance-secondary {
    display: block;
    font-size: 11px;
    line-height: 1.6;
    color: #9b7835;
  }

  a {
    color: #6b5df7;
  }
</style>
