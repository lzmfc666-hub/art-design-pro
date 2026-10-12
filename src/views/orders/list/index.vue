<template>
  <div>
    <BusinessPageHeader
      title="订单管理"
      description="查看履约进度、收款情况与历史处理记录，按状态快速定位需要处理的订单。"
      icon="ri:file-list-3-line"
      :badge="`${data?.orders.length || 0} 笔可见订单`"
    />
    <ArtSearchBar
      v-show="showSearchBar"
      v-model="search"
      :items="searchItems"
      @search="applySearch"
      @reset="resetSearch"
    />
    <ElCard class="art-table-card" :class="{ 'mt-3': showSearchBar }">
      <ElTabs v-model="activeStatus" @tab-change="applyStatus">
        <ElTabPane v-for="item in statusTabs" :key="item.value" :name="item.value"
          ><template #label
            ><span
              >{{ item.label
              }}<ElTag size="small" effect="plain" class="ml-2">{{ item.count }}</ElTag></span
            ></template
          ></ElTabPane
        >
      </ElTabs>
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
        height="500"
        empty-text="没有符合筛选条件的订单，可调整条件或创建新订单"
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
    <ElDrawer
      v-model="drawer"
      title="订单详情"
      size="min(960px, 96vw)"
      destroy-on-close
      :close-on-click-modal="!detailBusy"
      :close-on-press-escape="!detailBusy"
      :show-close="!detailBusy"
      :before-close="closeDrawer"
      ><OrderDetail v-if="selectedId" :order-id="selectedId" @busy="detailBusy = $event"
    /></ElDrawer>
  </div>
</template>
<script setup lang="ts">
  import { useStudio, money, formatTime, statusLabels } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Order, OrderStatus } from '@/types/studio'
  import OrderDetail from '../modules/order-detail.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { onBeforeRouteLeave, useRouter } from 'vue-router'
  import { ElMessage } from 'element-plus'
  defineOptions({ name: 'OrderList' })
  const { data, can, loading, refresh } = useStudio()
  const route = useRoute()
  const router = useRouter()
  const initial = () => ({
    orderNo: '',
    externalOrderNo: '',
    title: '',
    customerName: '',
    contact: '',
    gameId: '',
    roomCode: '',
    shopId: '',
    leaderId: '',
    status: validStatus(route.query.status),
    platformId: '',
    creatorId: '',
    payment: typeof route.query.payment === 'string' ? route.query.payment : '',
    dates: null as [string, string] | null,
    dateKey: 'createdAt'
  })
  const search = ref(initial())
  const applied = ref(initial())
  const showSearchBar = ref(true)
  const selectedId = ref('')
  const drawer = ref(false)
  const detailBusy = ref(false)
  function validStatus(value: unknown) {
    return typeof value === 'string' && value in statusLabels ? value : ''
  }
  const activeStatus = computed({
    get: () => search.value.status || 'all',
    set: (value: string) => {
      search.value.status = value === 'all' ? '' : value
    }
  })
  const statusTabs = computed(() =>
    [
      { value: 'all', label: '全部订单' },
      ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))
    ].map((item) => ({
      ...item,
      count: (data.value?.orders || []).filter(
        (order) => item.value === 'all' || order.status === item.value
      ).length
    }))
  )
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
      key: 'dateKey',
      label: '日期口径',
      type: 'select',
      props: {
        options: [
          { value: 'createdAt', label: '创建日期' },
          { value: 'paidAt', label: '客户付款日期' },
          { value: 'completedAt', label: '完成日期' }
        ]
      }
    },
    {
      key: 'dates',
      label: '日期范围',
      type: 'daterange',
      props: {
        type: 'daterange',
        valueFormat: 'YYYY-MM-DD',
        startPlaceholder: '开始日期',
        endPlaceholder: '结束日期'
      }
    },
    ...[
      ['orderNo', '工作室订单号'],
      ['externalOrderNo', '平台订单号'],
      ['title', '订单项目'],
      ['customerName', '客户名称'],
      ['contact', '客户联系方式'],
      ['gameId', '客户游戏 ID'],
      ['roomCode', '房间码']
    ].map(([key, label]) => ({
      key,
      label,
      type: 'input',
      props: { clearable: true, placeholder: `按${label}搜索` }
    })),
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
      key: 'shopId',
      label: '来源店铺',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        options: (data.value?.shops || [])
          .filter((item) => !search.value.platformId || item.platformId === search.value.platformId)
          .map((item) => ({ label: item.name, value: item.id }))
      }
    },
    {
      key: 'leaderId',
      label: '负责人',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        options: (data.value?.users || [])
          .filter((item) => item.role === 'player')
          .map((item) => ({ label: item.name, value: item.id }))
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
    const matches = (value: string | undefined, filter: string | undefined) =>
      !filter || (value || '').toLowerCase().includes(filter.trim().toLowerCase())
    return [...(data.value?.orders || [])]
      .filter(
        (o) =>
          matches(o.orderNo, f.orderNo) &&
          matches(o.externalOrderNo, f.externalOrderNo) &&
          matches(o.title, f.title) &&
          matches(customerName(o.customerId), f.customerName) &&
          matches(data.value?.customers.find((c) => c.id === o.customerId)?.contact, f.contact) &&
          matches(o.gameId, f.gameId) &&
          matches(o.roomCode, f.roomCode) &&
          (!f.shopId || o.shopId === f.shopId) &&
          (!f.leaderId || o.leaderId === f.leaderId) &&
          (!f.status || o.status === f.status) &&
          (!f.platformId || o.platformId === f.platformId) &&
          (!f.creatorId || o.creatorId === f.creatorId) &&
          (!f.dates || matchesDate(o, f.dateKey, f.dates)) &&
          (!f.payment ||
            (f.payment === 'paid'
              ? o.receivedAmount > 0
              : !o.receivedAmount && o.status !== 'canceled'))
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(filtered)
  watch(
    () => search.value.platformId,
    () => {
      if (
        search.value.shopId &&
        !data.value?.shops.some(
          (shop) =>
            shop.id === search.value.shopId &&
            (!search.value.platformId || shop.platformId === search.value.platformId)
        )
      )
        search.value.shopId = ''
    }
  )
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
  function matchesDate(order: Order, key: string, range: [string, string]) {
    const value =
      key === 'paidAt' ? order.paidAt : key === 'completedAt' ? order.completedAt : order.createdAt
    if (!value) return false
    const date = new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    return date >= range[0] && date <= range[1]
  }
  function applyStatus() {
    applySearch()
  }
  function closeDrawer(done: () => void) {
    if (!detailBusy.value) done()
  }
  onBeforeRouteLeave(() => {
    if (!data.value) return true
    if (detailBusy.value) {
      ElMessage.warning('正在保存或上传，请稍后离开')
      return false
    }
    return true
  })
  const resetSearch = () => {
    search.value = { ...initial(), payment: '', status: '' }
    applySearch()
  }
  const reload = () => refresh().catch(() => {})
  function openOrder(order: Order) {
    if (detailBusy.value) return
    selectedId.value = order.id
    drawer.value = true
    void router.replace({ query: { ...route.query, id: order.id } })
  }
  watch(
    () => route.query.status,
    (value) => {
      search.value.status = validStatus(value)
      applySearch()
    }
  )
  watch(
    () => route.query.id,
    (id) => {
      if (route.path !== '/orders/list') return
      if (detailBusy.value && id !== selectedId.value) {
        void router.replace({ query: { ...route.query, id: selectedId.value } })
        return
      }
      if (typeof id === 'string' && id) {
        selectedId.value = id
        drawer.value = true
      } else if (!detailBusy.value) {
        drawer.value = false
      }
    },
    { immediate: true }
  )
  watch(drawer, (visible) => {
    if (!visible && route.path === '/orders/list' && route.query.id && !detailBusy.value) {
      const query = { ...route.query }
      delete query.id
      void router.replace({ query })
    }
  })
  watch(
    () => route.query.payment,
    (value) => {
      search.value.payment = typeof value === 'string' ? value : ''
      applySearch()
    }
  )
  onMounted(reload)
</script>
