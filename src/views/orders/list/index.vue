<template>
  <div class="art-full-height">
    <ArtSearchBar
      v-show="showSearchBar"
      v-model="search"
      :items="searchItems"
      @search="applySearch"
      @reset="resetSearch"
    />
    <ElCard class="art-table-card" :class="{ 'mt-3': showSearchBar }">
      <ArtTableHeader
        v-model:columns="columnChecks"
        v-model:showSearchBar="showSearchBar"
        :loading="loading"
        @refresh="reload"
      >
        <template #left
          ><ElSpace wrap
            ><ElButton
              v-if="can('orders.create')"
              type="primary"
              v-ripple
              @click="$router.push('/orders/create')"
              >新增订单</ElButton
            ><ElTag type="warning">待验收 {{ reviewCount }}</ElTag
            ><ElTag type="info">共 {{ filtered.length }} 笔</ElTag></ElSpace
          ></template
        >
      </ArtTableHeader>
      <ArtTable
        :loading="loading"
        :data="tableData"
        :columns="columns"
        :pagination="pagination"
        row-key="id"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
        @row-click="openOrder"
      >
        <template #title="{ row }"
          ><ElButton type="primary" link @click.stop="openOrder(row)">{{ row.title }}</ElButton
          ><p class="text-xs text-g-500">{{ row.orderNo }}</p></template
        >
        <template #customerId="{ row }"
          ><span>{{ customerName(row.customerId) }}</span
          ><p class="text-xs text-g-500"
            >{{ platformName(row.platformId) }} {{ shopName(row.shopId) }}</p
          ></template
        >
        <template #amount="{ row }"
          ><span>{{ money(row.amount) }}</span
          ><p class="text-xs text-g-500">打手 {{ money(row.reward) }}</p></template
        >
        <template #status="{ row }"
          ><ElTag :type="tagType(row.status)">{{ statusLabels[row.status as OrderStatus] }}</ElTag
          ><p v-if="row.compensationPending" class="text-xs text-warning">报酬待确认</p></template
        >
        <template #receivedAmount="{ row }"
          ><ElTag :type="row.receivedAmount ? 'success' : 'warning'">{{
            row.receivedAmount ? '已收款' : '未收款'
          }}</ElTag
          ><p v-if="row.receivedAmount" class="text-xs mt-1">{{
            money(row.receivedAmount)
          }}</p></template
        >
        <template #leaderId="{ row }"
          >{{
            row.leaderId
              ? staffName(row.leaderId)
              : row.assignedTo
                ? staffName(row.assignedTo) + '（待接单）'
                : '抢单池'
          }}<p v-if="row.teammateId" class="text-xs text-g-500"
            >队友 {{ staffName(row.teammateId) }}</p
          ></template
        >
        <template #createdAt="{ row }"
          >{{ formatTime(row.createdAt)
          }}<p class="text-xs text-g-500">{{ staffName(row.creatorId) }}</p></template
        >
        <template #operation="{ row }"
          ><span @click.stop><ArtButtonTable type="view" @click="openOrder(row)" /></span
        ></template>
      </ArtTable>
    </ElCard>
    <ElDrawer v-model="drawer" title="订单详情" size="min(960px, 96vw)" destroy-on-close
      ><OrderDetail v-if="selectedId" :order-id="selectedId"
    /></ElDrawer>
  </div>
</template>
<script setup lang="ts">
  import { useStudio, money, formatTime, statusLabels } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Order, OrderStatus } from '@/types/studio'
  import OrderDetail from '../modules/order-detail.vue'
  defineOptions({ name: 'OrderList' })
  const { data, can, loading, refresh } = useStudio()
  const route = useRoute()
  const initial = () => ({
    keyword: '',
    status: '',
    platformId: '',
    creatorId: '',
    payment: typeof route.query.payment === 'string' ? route.query.payment : ''
  })
  const search = ref(initial())
  const applied = ref(initial())
  const showSearchBar = ref(true)
  const selectedId = ref('')
  const drawer = ref(false)
  const staffName = (id: string | null) => data.value?.users.find((u) => u.id === id)?.name || '—'
  const customerName = (id: string) => data.value?.customers.find((c) => c.id === id)?.name || '—'
  const platformName = (id: string) => data.value?.platforms.find((p) => p.id === id)?.name || '—'
  const shopName = (id: string | null) => data.value?.shops.find((s) => s.id === id)?.name || ''
  const tagType = (s: OrderStatus) =>
    (
      ({
        pending: 'info',
        active: 'primary',
        review: 'warning',
        completed: 'success',
        canceled: 'danger'
      }) as const
    )[s]
  const reviewCount = computed(
    () => (data.value?.orders || []).filter((o) => o.status === 'review').length
  )
  const searchItems = computed(() => [
    {
      key: 'keyword',
      label: '搜索',
      type: 'input',
      props: { placeholder: '订单号、客户、游戏 ID', clearable: true }
    },
    {
      key: 'status',
      label: '订单状态',
      type: 'select',
      props: {
        clearable: true,
        options: Object.entries(statusLabels).map(([value, label]) => ({ value, label }))
      }
    },
    {
      key: 'platformId',
      label: '订单来源',
      type: 'select',
      props: {
        clearable: true,
        options: (data.value?.platforms || []).map((p) => ({ label: p.name, value: p.id }))
      }
    },
    {
      key: 'creatorId',
      label: '创建人',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        options: (data.value?.users || [])
          .filter((u) => u.role !== 'player')
          .map((u) => ({ label: u.name, value: u.id }))
      }
    },
    {
      key: 'payment',
      label: '收款状态',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { label: '已收款', value: 'paid' },
          { label: '待确认收款', value: 'unpaid' }
        ]
      }
    }
  ])
  const filtered = computed(() => {
    const f = applied.value
    const q = f.keyword.trim().toLowerCase()
    return [...(data.value?.orders || [])]
      .filter(
        (o) =>
          (!q ||
            [
              o.orderNo,
              o.title,
              o.externalOrderNo,
              o.gameId,
              o.roomCode,
              customerName(o.customerId),
              data.value?.customers.find((c) => c.id === o.customerId)?.contact
            ].some((v) => v?.toLowerCase().includes(q))) &&
          (!f.status || o.status === f.status) &&
          (!f.platformId || o.platformId === f.platformId) &&
          (!f.creatorId || o.creatorId === f.creatorId) &&
          (!f.payment ||
            (f.payment === 'paid'
              ? o.receivedAmount > 0
              : !o.receivedAmount && o.status !== 'canceled'))
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(filtered)
  const { columns, columnChecks } = useTableColumns<Order>(() => [
    { prop: 'title', label: '订单 / 项目', minWidth: 220, useSlot: true },
    { prop: 'customerId', label: '客户 / 来源', minWidth: 170, useSlot: true },
    { prop: 'amount', label: '订单金额', minWidth: 130, useSlot: true },
    { prop: 'status', label: '订单状态', minWidth: 115, useSlot: true },
    { prop: 'receivedAmount', label: '收款状态', minWidth: 110, useSlot: true },
    { prop: 'leaderId', label: '负责人', minWidth: 160, useSlot: true },
    { prop: 'createdAt', label: '创建时间', minWidth: 180, useSlot: true },
    { prop: 'operation', label: '操作', width: 80, fixed: 'right', useSlot: true }
  ])
  const applySearch = () => {
    applied.value = { ...search.value }
    resetPage()
  }
  const resetSearch = () => {
    search.value = { ...initial(), payment: '' }
    applySearch()
  }
  const reload = () => refresh().catch(() => {})
  function openOrder(order: Order) {
    selectedId.value = order.id
    drawer.value = true
  }
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
    () => route.query.payment,
    (value) => {
      search.value.payment = typeof value === 'string' ? value : ''
      applySearch()
    }
  )
  onMounted(reload)
</script>
