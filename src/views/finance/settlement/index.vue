<template>
  <div class="finance-page">
    <BusinessPageHeader
      title="财务结算"
      description="核查订单材料、登记客户退款与打手发放，让每笔收付都有凭据。"
      icon="ri:bank-card-line"
      badge="人工收付 · 凭证留档"
    >
      <template #actions>
        <ElButton :loading="loading" :disabled="operationBusy" @click="reload">
          <ArtSvgIcon icon="ri:refresh-line" class="mr-1" />刷新记录
        </ElButton>
        <ElButton
          v-if="activeTab && (activeTab !== 'review' || can('orders.view'))"
          type="primary"
          plain
          :disabled="operationBusy"
          @click="exportCurrent"
        >
          <ArtSvgIcon icon="ri:file-excel-2-line" class="mr-1" />导出当前模块
        </ElButton>
      </template>
    </BusinessPageHeader>
    <div v-if="tabs.length" class="finance-stats">
      <BusinessStatCard
        v-if="can('finance.review')"
        label="待验收与补偿"
        :value="data ? reviewCount + compensationCount : '—'"
        icon="ri:checkbox-circle-line"
        :tone="reviewCount + compensationCount ? 'warning' : 'success'"
        :description="`待验收 ${reviewCount} 单 · 取消补偿 ${compensationCount} 单`"
        ><ElButton link type="primary" :disabled="operationBusy" @click="activeTab = 'review'"
          >查看待办<ArtSvgIcon icon="ri:arrow-right-line" class="ml-1" /></ElButton
      ></BusinessStatCard>
      <BusinessStatCard
        v-if="can('finance.refunds')"
        label="退款待处理"
        :value="data ? refundTodos : '—'"
        icon="ri:refund-2-line"
        :tone="refundTodos ? 'danger' : 'success'"
        :description="`待审核 ${pendingRefunds} 笔 · 差额待处理 ${manualRefunds} 笔`"
        ><ElButton link type="primary" :disabled="operationBusy" @click="activeTab = 'refunds'"
          >查看退款<ArtSvgIcon icon="ri:arrow-right-line" class="ml-1" /></ElButton
      ></BusinessStatCard>
      <BusinessStatCard
        v-if="can('finance.withdrawals')"
        label="提现待审核 / 发放"
        :value="data ? pendingWithdrawals.length : '—'"
        icon="ri:wallet-3-line"
        :tone="pendingWithdrawals.length ? 'warning' : 'success'"
        :description="`待审核 ${withdrawalReviewCount} 笔 · 待发放 ${withdrawalPayCount} 笔`"
        ><span class="text-sm text-g-500"
          >合计 {{ data ? money(withdrawalTotal) : '—' }}</span
        ></BusinessStatCard
      >
      <BusinessStatCard
        v-if="can('finance.expenses')"
        label="本月已入账费用"
        :value="data ? money(monthExpenseTotal) : '—'"
        icon="ri:bill-line"
        tone="info"
        :description="`${selectedMonth} · ${monthExpenses.length} 笔有效记录`"
        ><ElButton link type="primary" :disabled="operationBusy" @click="activeTab = 'expenses'"
          >管理费用<ArtSvgIcon icon="ri:arrow-right-line" class="ml-1" /></ElButton
      ></BusinessStatCard>
    </div>
    <ElCard shadow="never">
      <ElTabs v-model="activeTab" :before-leave="() => !operationBusy">
        <ElTabPane
          v-for="item in tabs"
          :key="item.name"
          :name="item.name"
          :label="item.label"
          :disabled="operationBusy"
        />
      </ElTabs>
      <div v-if="activeDescription" class="finance-section-heading">
        <div
          ><h3>{{ activeDescription.title }}</h3
          ><p>{{ activeDescription.description }}</p></div
        >
        <ElTag v-if="operationBusy" type="warning" effect="plain">正在保存，请稍候</ElTag>
        <ElTag v-else type="info" effect="plain">仅显示当前权限可见记录</ElTag>
      </div>
      <OrderReview
        v-if="activeTab === 'review' && can('finance.review')"
        @busy="operationBusy = $event"
      />
      <RefundRecords
        v-else-if="activeTab === 'refunds' && can('finance.refunds')"
        @busy="operationBusy = $event"
      />
      <WithdrawalRecords
        v-else-if="activeTab === 'withdrawals' && can('finance.withdrawals')"
        @busy="operationBusy = $event"
      />
      <ExpenseRecords
        v-else-if="activeTab === 'expenses' && can('finance.expenses')"
        @busy="operationBusy = $event"
      />
      <ElEmpty v-else description="当前账号没有财务结算权限" />
    </ElCard>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { useStudio, money } from '@/hooks/business/useStudio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import OrderReview from '../modules/order-review.vue'
  import RefundRecords from '../modules/refund-records.vue'
  import WithdrawalRecords from '../modules/withdrawal-records.vue'
  import ExpenseRecords from '../modules/expense-records.vue'

  defineOptions({ name: 'Settlement' })
  const { can, data, loading, refresh, selectedMonth } = useStudio()
  const activeTab = ref('review')
  const operationBusy = ref(false)
  const route = useRoute()
  const router = useRouter()
  const reviewCount = computed(
    () => (data.value?.orders || []).filter((row) => row.status === 'review').length
  )
  const compensationCount = computed(
    () =>
      (data.value?.orders || []).filter(
        (row) => row.status === 'canceled' && row.compensationPending && !row.compensationSettled
      ).length
  )
  const pendingRefunds = computed(
    () => (data.value?.refunds || []).filter((row) => row.status === 'pending').length
  )
  const manualRefunds = computed(
    () =>
      (data.value?.refunds || []).filter((row) => row.manualRewardReview && !row.manualResolution)
        .length
  )
  const refundTodos = computed(
    () =>
      (data.value?.refunds || []).filter(
        (row) => row.status === 'pending' || (row.manualRewardReview && !row.manualResolution)
      ).length
  )
  const pendingWithdrawals = computed(() =>
    (data.value?.withdrawals || []).filter((row) => ['pending', 'approved'].includes(row.status))
  )
  const withdrawalReviewCount = computed(
    () => pendingWithdrawals.value.filter((row) => row.status === 'pending').length
  )
  const withdrawalPayCount = computed(
    () => pendingWithdrawals.value.filter((row) => row.status === 'approved').length
  )
  const withdrawalTotal = computed(() =>
    pendingWithdrawals.value.reduce((sum, row) => sum + row.amount, 0)
  )
  const monthExpenses = computed(() =>
    (data.value?.expenses || []).filter(
      (row) => !row.deletedAt && row.date.startsWith(selectedMonth.value)
    )
  )
  const monthExpenseTotal = computed(() =>
    monthExpenses.value.reduce((sum, row) => sum + row.amount, 0)
  )
  const sections: Record<string, { title: string; description: string; modules: string }> = {
    review: {
      title: '核查交付，再确认结算',
      description: '查看上报材料与订单金额，处理待验收订单和取消补偿。',
      modules: 'orders,orderSubmissions'
    },
    refunds: {
      title: '客户退款与报酬差额',
      description: '退款回到原付款日调整；已提现报酬差额由财务登记处理结果。',
      modules: 'refunds'
    },
    withdrawals: {
      title: '打手提现与人工发放',
      description: '审核申请后登记实际发放，保存对应付款凭证。',
      modules: 'withdrawals,wallets'
    },
    expenses: {
      title: '日常费用与凭证',
      description: '按实际发生日期记账，已删除记录保留恢复入口。',
      modules: 'expenses'
    }
  }
  const activeDescription = computed(() => sections[activeTab.value])
  const tabs = computed(() =>
    [
      { name: 'review', label: '订单验收 / 取消补偿', permission: 'finance.review' },
      { name: 'refunds', label: '客户退款', permission: 'finance.refunds' },
      { name: 'withdrawals', label: '打手提现', permission: 'finance.withdrawals' },
      { name: 'expenses', label: '费用报账', permission: 'finance.expenses' }
    ].filter((item) => can(item.permission))
  )
  watch(
    () => route.fullPath,
    () => {
      if (route.path !== '/finance/settlement') return
      const query = route.query.tab
      if (operationBusy.value) {
        syncTabQuery(activeTab.value)
        return
      }
      const requested = typeof query === 'string' ? query : ''
      const items = tabs.value
      if (items.some((item) => item.name === requested)) activeTab.value = requested
      else if (!items.some((item) => item.name === activeTab.value))
        activeTab.value = items[0]?.name || ''
      syncTabQuery(activeTab.value)
    },
    { immediate: true }
  )
  watch(
    tabs,
    (items) => {
      if (!items.some((item) => item.name === activeTab.value)) {
        const requested = typeof route.query.tab === 'string' ? route.query.tab : ''
        activeTab.value = items.some((item) => item.name === requested)
          ? requested
          : items[0]?.name || ''
      }
      syncTabQuery(activeTab.value)
    },
    { immediate: true }
  )
  watch(activeTab, syncTabQuery)
  function syncTabQuery(tab: string) {
    if (route.path !== '/finance/settlement') return
    if (tab && route.query.tab !== tab) void router.replace({ query: { ...route.query, tab } })
  }
  function exportCurrent() {
    if (!operationBusy.value && activeDescription.value)
      void router.push({
        path: '/reports/export',
        query: { modules: activeDescription.value.modules }
      })
  }
  async function reload() {
    try {
      await refresh()
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '刷新失败')
    }
  }
</script>

<style scoped lang="scss">
  .finance-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 20px;
    margin-bottom: 20px;
  }

  .finance-section-heading {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    margin: 10px 0 22px;

    h3 {
      font-size: 16px;
      font-weight: 600;
    }

    p {
      margin-top: 6px;
      font-size: 13px;
      line-height: 1.7;
      color: var(--el-text-color-secondary);
    }
  }

  @media (width <= 640px) {
    .finance-stats {
      grid-template-columns: 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }

    .finance-section-heading {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
