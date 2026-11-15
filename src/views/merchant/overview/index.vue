<script setup lang="ts">
  import { ref, watch } from 'vue'
  import { studioRequest } from '@/api/studio'
  import { useStudio, money, formatTime, statusLabels } from '@/hooks/business/useStudio'
  import type { MerchantOverview } from '@/types/studio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'

  const { user, clearSession } = useStudio()
  const report = ref<MerchantOverview | null>(null)
  const dates = ref<[string, string] | null>(null)
  const loading = ref(false)
  const error = ref('')
  let version = 0
  async function load() {
    const requestVersion = ++version
    const identity = `${user.value?.id}:${user.value?.merchantId}`
    loading.value = true
    error.value = ''
    const query = dates.value ? `?start=${dates.value[0]}&end=${dates.value[1]}` : ''
    try {
      const result = await studioRequest<MerchantOverview>(`merchant/overview${query}`)
      if (requestVersion === version && identity === `${user.value?.id}:${user.value?.merchantId}`)
        report.value = result
    } catch (cause) {
      if (requestVersion !== version) return
      report.value = null
      error.value = cause instanceof Error ? cause.message : '看板读取失败，请重试'
      if ((cause as { status?: number }).status === 401) clearSession()
    } finally {
      if (requestVersion === version) loading.value = false
    }
  }
  function showAllHistory() {
    dates.value = null
    void load()
  }
  watch(
    () => `${user.value?.id}:${user.value?.merchantId}`,
    () => {
      report.value = null
      if (user.value?.role === 'merchant') void load()
    },
    { immediate: true }
  )
</script>

<template>
  <div>
    <BusinessPageHeader
      title="商家数据看板"
      description="本商家全部账号的订单和结算数据，客户价为约定价格，到账以总后台确认为准。"
      icon="ri:store-2-line"
    />
    <ElCard shadow="never" class="mb-4">
      <ElSpace wrap>
        <ElDatePicker
          v-model="dates"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
        />
        <ElButton type="primary" :loading="loading" @click="load">查询数据</ElButton>
        <ElButton :disabled="loading" @click="showAllHistory">全部历史</ElButton>
        <ElButton @click="$router.push('/merchant/create')">发布订单</ElButton>
      </ElSpace>
      <p class="text-xs text-g-500 mt-3"
        >默认显示本商家全部历史订单；选择日期后按订单创建日期筛选。</p
      >
    </ElCard>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" class="mb-4" />
    <template v-if="report">
      <ElCard shadow="never" class="mb-4" v-loading="loading">
        <ElDescriptions title="订单概况" :column="3" border>
          <ElDescriptionsItem label="全部订单">{{ report.summary.orders }}</ElDescriptionsItem>
          <ElDescriptionsItem label="待接单">{{ report.summary.pending }}</ElDescriptionsItem>
          <ElDescriptionsItem label="接单中">{{ report.summary.active }}</ElDescriptionsItem>
          <ElDescriptionsItem label="待验收">{{ report.summary.review }}</ElDescriptionsItem>
          <ElDescriptionsItem label="已完成">{{ report.summary.completed }}</ElDescriptionsItem>
          <ElDescriptionsItem label="已取消">{{ report.summary.canceled }}</ElDescriptionsItem>
        </ElDescriptions>
      </ElCard>
      <ElCard shadow="never" class="mb-4">
        <ElDescriptions title="商家结算" :column="2" border>
          <ElDescriptionsItem label="约定客户金额">{{
            money(report.summary.merchantCustomerAmount)
          }}</ElDescriptionsItem>
          <ElDescriptionsItem label="应付金小盾">{{
            money(report.summary.receivableAmount)
          }}</ElDescriptionsItem>
          <ElDescriptionsItem label="总后台确认到账">{{
            money(report.summary.receivedAmount)
          }}</ElDescriptionsItem>
          <ElDescriptionsItem label="尚未结清">{{
            money(report.summary.outstandingAmount)
          }}</ElDescriptionsItem>
        </ElDescriptions>
        <p class="text-xs text-g-500 mt-3"
          >统计范围：{{
            report.range.start && report.range.end
              ? `${report.range.start} 至 ${report.range.end}`
              : '全部历史'
          }}。数据读取于 {{ formatTime(report.generatedAt) }}。约定客户金额不代表已核实客户付款。</p
        >
      </ElCard>
      <ElCard shadow="never">
        <template #header
          ><div class="flex justify-between items-center"
            ><strong>最近订单</strong
            ><ElButton link type="primary" @click="$router.push('/merchant/orders')"
              >查看全部</ElButton
            ></div
          ></template
        >
        <ElTable
          :data="report.recentOrders"
          :empty-text="
            report.range.start ? '所选日期内暂无订单，可调整日期或查看全部历史' : '本商家暂无订单'
          "
        >
          <ElTableColumn label="订单" min-width="200"
            ><template #default="{ row }"
              ><ElButton
                link
                type="primary"
                @click="$router.push({ path: '/merchant/orders', query: { id: row.id } })"
                >{{ row.title }}</ElButton
              ><p class="text-xs text-g-500">{{ row.orderNo }}</p></template
            ></ElTableColumn
          >
          <ElTableColumn label="订单状态" min-width="100"
            ><template #default="{ row }">{{
              statusLabels[row.status as keyof typeof statusLabels]
            }}</template></ElTableColumn
          >
          <ElTableColumn label="约定客户金额" min-width="130"
            ><template #default="{ row }">{{
              money(row.merchantCustomerAmount)
            }}</template></ElTableColumn
          >
          <ElTableColumn label="应付金小盾" min-width="130"
            ><template #default="{ row }">{{ money(row.amount) }}</template></ElTableColumn
          >
          <ElTableColumn label="创建时间" min-width="170"
            ><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></ElTableColumn
          >
        </ElTable>
      </ElCard>
    </template>
  </div>
</template>
