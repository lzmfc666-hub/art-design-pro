<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { Search, Plus, Refresh } from '@element-plus/icons-vue'
  import { useStudio, money, formatTime, statusLabels } from '../useStudio'
  import type { Order, OrderStatus } from '@/types/studio'
  import OrderDetail from './OrderDetail.vue'

  const { data, can, loading, refresh } = useStudio()
  const router = useRouter()
  const route = useRoute()
  const keyword = ref('')
  const status = ref<OrderStatus | 'all'>('all')
  const platformId = ref('')
  const creatorId = ref('')
  const payment = ref('')
  const page = ref(1)
  const selectedId = ref('')
  const drawer = ref(false)
  const pageSize = 12
  const orders = computed(() => data.value?.orders ?? [])
  const states: { value: OrderStatus | 'all'; label: string }[] = [
    { value: 'all', label: '全部订单' },
    { value: 'pending', label: '待接单' },
    { value: 'active', label: '接单中' },
    { value: 'review', label: '待验收' },
    { value: 'completed', label: '已完成' },
    { value: 'canceled', label: '已取消' }
  ]
  const count = (value: string) =>
    orders.value.filter((order) => value === 'all' || order.status === value).length
  const filtered = computed(() => {
    const query = keyword.value.trim().toLowerCase()
    return orders.value
      .filter((order) => {
        const customer = data.value?.customers.find((item) => item.id === order.customerId)
        const matchesQuery =
          !query ||
          [
            order.orderNo,
            order.title,
            order.externalOrderNo,
            order.gameId,
            order.roomCode,
            customer?.name,
            customer?.contact
          ].some((value) => value?.toLowerCase().includes(query))
        return (
          matchesQuery &&
          (status.value === 'all' || order.status === status.value) &&
          (!platformId.value || order.platformId === platformId.value) &&
          (!creatorId.value || order.creatorId === creatorId.value) &&
          (!payment.value ||
            (payment.value === 'paid'
              ? order.receivedAmount > 0
              : order.receivedAmount === 0 && order.status !== 'canceled'))
        )
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
  const visibleOrders = computed(() =>
    filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize)
  )
  const staffName = (id: string | null) =>
    data.value?.users.find((item) => item.id === id)?.name ?? '—'
  const customerName = (id: string) =>
    data.value?.customers.find((item) => item.id === id)?.name ?? '未找到客户'
  const platformName = (id: string) =>
    data.value?.platforms.find((item) => item.id === id)?.name ?? '—'
  const shopName = (id: string | null) => data.value?.shops.find((item) => item.id === id)?.name
  const tagType = (value: OrderStatus) =>
    ({
      pending: 'info',
      active: 'primary',
      review: 'warning',
      completed: 'success',
      canceled: 'danger'
    })[value] as 'info' | 'primary' | 'warning' | 'success' | 'danger'

  function openOrder(order: Order) {
    selectedId.value = order.id
    drawer.value = true
  }
  function selectUnpaid() {
    payment.value = 'unpaid'
    status.value = 'all'
  }
  function resetFilters() {
    keyword.value = ''
    platformId.value = ''
    creatorId.value = ''
    payment.value = ''
    status.value = 'all'
  }
  watch([keyword, status, platformId, creatorId, payment], () => {
    page.value = 1
  })
  watch(
    () => route.query.id,
    (id) => {
      if (typeof id === 'string' && id) {
        selectedId.value = id
        drawer.value = true
      }
    },
    { immediate: true }
  )
  watch(
    () => filtered.value.length,
    (length) => {
      page.value = Math.max(1, Math.min(page.value, Math.ceil(length / pageSize)))
    }
  )
</script>

<template>
  <div class="orders-page">
    <div class="page-heading">
      <div><h2>订单管理</h2><p>掌握每一笔订单，从收款到结算全程留痕。</p></div>
      <el-button
        v-if="can('orders.create')"
        type="primary"
        :icon="Plus"
        @click="router.push('/dispatch')"
        >快捷下单</el-button
      >
    </div>

    <div class="order-summary">
      <button class="summary-tile" @click="status = 'pending'"
        ><span class="tile-icon pending">◷</span
        ><div
          ><span>等待接单</span><strong>{{ count('pending') }}</strong></div
        ></button
      >
      <button class="summary-tile" @click="status = 'active'"
        ><span class="tile-icon active">↗</span
        ><div
          ><span>正在执行</span><strong>{{ count('active') }}</strong></div
        ></button
      >
      <button class="summary-tile" @click="status = 'review'"
        ><span class="tile-icon review">✓</span
        ><div
          ><span>财务待验收</span><strong>{{ count('review') }}</strong></div
        ></button
      >
      <button class="summary-tile" @click="selectUnpaid"
        ><span class="tile-icon unpaid">¥</span
        ><div
          ><span>待确认收款</span
          ><strong>{{
            orders.filter((item) => !item.receivedAmount && item.status !== 'canceled').length
          }}</strong></div
        ></button
      >
    </div>

    <section class="panel orders-panel">
      <div class="order-tabs" aria-label="订单状态筛选">
        <button
          v-for="item in states"
          :key="item.value"
          :class="{ selected: status === item.value }"
          @click="status = item.value"
        >
          {{ item.label }}<span>{{ count(item.value) }}</span>
        </button>
      </div>
      <div class="toolbar order-filters">
        <el-input
          v-model="keyword"
          placeholder="搜索订单号、项目、客户或游戏 ID"
          :prefix-icon="Search"
          clearable
          class="order-search"
        />
        <el-select v-model="platformId" placeholder="全部来源" clearable
          ><el-option
            v-for="item in data?.platforms"
            :key="item.id"
            :label="item.name"
            :value="item.id"
        /></el-select>
        <el-select v-model="creatorId" placeholder="全部创建人" clearable filterable
          ><el-option
            v-for="item in data?.users.filter((user) => user.role !== 'player')"
            :key="item.id"
            :label="item.name"
            :value="item.id"
        /></el-select>
        <el-select v-model="payment" placeholder="收款状态" clearable
          ><el-option label="已确认收款" value="paid" /><el-option
            label="待确认收款"
            value="unpaid"
        /></el-select>
        <el-button @click="resetFilters">重置</el-button>
        <el-button :icon="Refresh" :loading="loading" aria-label="刷新订单" @click="refresh()" />
      </div>
      <el-table
        v-loading="loading"
        :data="visibleOrders"
        row-key="id"
        empty-text="暂无符合条件的订单"
        @row-click="openOrder"
        class="order-table"
      >
        <el-table-column label="订单 / 项目" min-width="220">
          <template #default="{ row }"
            ><div class="order-title">{{ row.title }}</div
            ><div class="muted small-text">{{ row.orderNo }}</div></template
          >
        </el-table-column>
        <el-table-column label="客户 / 来源" min-width="155">
          <template #default="{ row }"
            ><div>{{ customerName(row.customerId) }}</div
            ><div class="muted small-text"
              >{{ platformName(row.platformId)
              }}<template v-if="shopName(row.shopId)"> · {{ shopName(row.shopId) }}</template></div
            ></template
          >
        </el-table-column>
        <el-table-column label="订单金额" min-width="130">
          <template #default="{ row }"
            ><strong class="amount-text">{{ money(row.amount) }}</strong
            ><div class="muted small-text">打手 {{ money(row.reward) }}</div></template
          >
        </el-table-column>
        <el-table-column label="履约状态" min-width="115"
          ><template #default="{ row }"
            ><el-tag :type="tagType(row.status)" effect="light" round>{{
              statusLabels[row.status as OrderStatus]
            }}</el-tag
            ><div v-if="row.compensationPending" class="compensation-note"
              >报酬待确认</div
            ></template
          ></el-table-column
        >
        <el-table-column label="收款状态" min-width="110"
          ><template #default="{ row }"
            ><span :class="row.receivedAmount > 0 ? 'paid-text' : 'unpaid-text'">{{
              row.receivedAmount > 0 ? '已收款' : row.status === 'canceled' ? '未收款' : '待收款'
            }}</span
            ><div v-if="row.receivedAmount" class="muted small-text">{{
              money(row.receivedAmount)
            }}</div></template
          ></el-table-column
        >
        <el-table-column label="负责人" min-width="120"
          ><template #default="{ row }"
            ><div>{{
              row.leaderId
                ? staffName(row.leaderId)
                : row.assignedTo
                  ? staffName(row.assignedTo)
                  : '抢单池'
            }}</div
            ><div v-if="!row.leaderId && row.assignedTo" class="muted small-text"
              >等待指定打手接单</div
            ><div v-if="row.teammateId" class="muted small-text"
              >队友 {{ staffName(row.teammateId) }}</div
            ></template
          ></el-table-column
        >
        <el-table-column label="创建时间" min-width="160"
          ><template #default="{ row }"
            ><div class="small-text">{{ formatTime(row.createdAt) }}</div
            ><div class="muted small-text">{{ staffName(row.creatorId) }}</div></template
          ></el-table-column
        >
        <el-table-column label="操作" width="80" fixed="right"
          ><template #default="{ row }"
            ><el-button type="primary" link @click.stop="openOrder(row)">详情</el-button></template
          ></el-table-column
        >
      </el-table>
      <div class="table-footer"
        ><span class="muted">共 {{ filtered.length }} 笔订单</span
        ><el-pagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="filtered.length"
          layout="prev, pager, next"
          hide-on-single-page
      /></div>
    </section>

    <el-drawer v-model="drawer" title="订单详情" size="min(920px, 96vw)" destroy-on-close>
      <OrderDetail v-if="selectedId" :order-id="selectedId" />
    </el-drawer>
  </div>
</template>

<style scoped>
  .order-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .summary-tile {
    display: flex;
    gap: 15px;
    align-items: center;
    padding: 21px 24px;
    text-align: left;
    cursor: pointer;
    background: white;
    border: 1px solid #e9ebf2;
    border-radius: 14px;
    transition:
      border-color 0.2s,
      transform 0.2s;
  }

  .summary-tile:hover {
    border-color: #b7affb;
    transform: translateY(-2px);
  }

  .summary-tile div {
    display: grid;
    gap: 5px;
  }

  .summary-tile div > span {
    font-size: 13px;
    color: #858a9b;
  }

  .summary-tile strong {
    font-size: 26px;
    font-weight: 650;
    color: #24283d;
  }

  .tile-icon {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    font-size: 23px;
    border-radius: 13px;
  }

  .pending {
    color: #7563ed;
    background: #f0edff;
  }

  .active {
    color: #4087e9;
    background: #eaf3ff;
  }

  .review {
    color: #d4a044;
    background: #fff5df;
  }

  .unpaid {
    color: #30a889;
    background: #e7f7f2;
  }

  .orders-panel {
    padding: 0;
    overflow: hidden;
  }

  .order-tabs {
    display: flex;
    gap: 24px;
    padding: 0 24px;
    overflow-x: auto;
    border-bottom: 1px solid #eff0f5;
  }

  .order-tabs button {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 20px 0 17px;
    font-size: 14px;
    color: #7c8194;
    white-space: nowrap;
    cursor: pointer;
    background: none;
    border: 0;
    border-bottom: 3px solid transparent;
  }

  .order-tabs button.selected {
    font-weight: 600;
    color: #6b5df7;
    border-bottom-color: #6b5df7;
  }

  .order-tabs button span {
    padding: 1px 6px;
    font-size: 11px;
    background: #f3f4f8;
    border-radius: 5px;
  }

  .order-tabs button.selected span {
    background: #efedff;
  }

  .order-filters {
    flex-wrap: wrap;
    gap: 10px;
    padding: 21px 24px;
  }

  .order-filters .el-select {
    width: 145px;
  }

  .order-search {
    flex: 1;
    width: min(320px, 100%);
    min-width: 230px;
  }

  .order-title {
    margin-bottom: 4px;
    font-weight: 600;
    color: #30344b;
  }

  .small-text {
    font-size: 12px;
    line-height: 1.8;
  }

  .amount-text {
    font-weight: 600;
    color: #30344b;
  }

  .paid-text {
    color: #32a582;
  }

  .unpaid-text {
    color: #d79c37;
  }

  .compensation-note {
    margin-top: 5px;
    font-size: 11px;
    color: #c99138;
  }

  .table-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 24px;
    font-size: 13px;
  }

  .order-table :deep(.el-table__row) {
    cursor: pointer;
  }

  .order-table :deep(.el-table__cell) {
    padding: 15px 0;
  }

  .order-table :deep(.el-table__cell:first-child .cell) {
    padding-left: 24px;
  }

  @media (width <= 980px) {
    .order-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .order-tabs {
      gap: 18px;
    }
  }

  @media (width <= 560px) {
    .order-summary {
      gap: 10px;
    }

    .summary-tile {
      gap: 10px;
      padding: 15px;
    }

    .tile-icon {
      width: 36px;
      height: 36px;
    }

    .order-filters {
      padding: 16px;
    }

    .order-filters .el-select {
      flex: 1;
      min-width: 120px;
    }

    .order-search {
      min-width: 100%;
    }
  }
</style>
