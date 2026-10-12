<template>
  <div>
    <ElCard class="mb-5" shadow="never">
      <div class="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 class="text-lg font-medium">财务结算</h2>
          <p class="text-g-500 mt-2"
            >核查订单材料、登记客户退款与打手发放，所有处理保留操作记录。</p
          >
        </div>
        <ElTag type="info" effect="plain">人工收付 · 凭证留档</ElTag>
      </div>
    </ElCard>
    <ElCard shadow="never">
      <ElTabs v-model="activeTab" :before-leave="() => !operationBusy">
        <ElTabPane v-for="item in tabs" :key="item.name" :name="item.name" :label="item.label" />
      </ElTabs>
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
  import { useRoute } from 'vue-router'
  import { useStudio } from '@/hooks/business/useStudio'
  import OrderReview from '../modules/order-review.vue'
  import RefundRecords from '../modules/refund-records.vue'
  import WithdrawalRecords from '../modules/withdrawal-records.vue'
  import ExpenseRecords from '../modules/expense-records.vue'

  defineOptions({ name: 'Settlement' })
  const { can } = useStudio()
  const activeTab = ref('review')
  const operationBusy = ref(false)
  const route = useRoute()
  const tabs = computed(() =>
    [
      { name: 'review', label: '订单验收 / 取消补偿', permission: 'finance.review' },
      { name: 'refunds', label: '客户退款', permission: 'finance.refunds' },
      { name: 'withdrawals', label: '打手提现', permission: 'finance.withdrawals' },
      { name: 'expenses', label: '费用报账', permission: 'finance.expenses' }
    ].filter((item) => can(item.permission))
  )
  watch(
    [() => route.query.tab, tabs],
    ([query, items]) => {
      const requested = typeof query === 'string' ? query : ''
      if (items.some((item) => item.name === requested)) activeTab.value = requested
      else if (!items.some((item) => item.name === activeTab.value))
        activeTab.value = items[0]?.name || ''
    },
    { immediate: true }
  )
</script>
