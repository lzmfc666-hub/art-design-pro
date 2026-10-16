<template>
  <div>
    <BusinessPageHeader
      title="订单管理"
      description="查看履约进度、收款情况与历史处理记录，按状态快速定位需要处理的订单。"
      icon="ri:file-list-3-line"
      :badge="`${pagination.total} 笔符合筛选订单`"
    />
    <ElAlert
      v-if="noticesError && can('orders.edit')"
      :title="noticesError"
      type="warning"
      :closable="false"
      show-icon
      class="mb-4"
    >
      <ElButton link type="primary" @click="loadNotices">重新读取提醒</ElButton>
    </ElAlert>
    <ElCard v-if="timeoutTotal && can('orders.edit')" class="mb-4" shadow="never">
      <template #header
        ><ElSpace
          ><strong>指定订单待客服处理</strong
          ><ElTag type="warning">{{ timeoutTotal }} 条有效未读提醒</ElTag></ElSpace
        ></template
      >
      <div
        v-for="notice in pendingTimeoutNotices"
        :key="notice.id"
        class="flex items-center justify-between gap-3 mb-3"
      >
        <div
          ><p>{{ notice.title }}</p
          ><p class="text-xs text-g-500"
            >{{ notice.body }} · {{ formatTime(notice.createdAt) }}</p
          ></div
        >
        <ElButton type="primary" plain :disabled="detailBusy" @click="openNotice(notice)"
          >查看并处理</ElButton
        >
      </div>
      <ElPagination
        v-if="timeoutTotal > timeoutPagination.size"
        v-model:current-page="timeoutPagination.current"
        :page-size="timeoutPagination.size"
        :total="timeoutTotal"
        layout="prev, pager, next, total"
        @current-change="loadNotices"
      />
    </ElCard>
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
        :loading="ordersLoading"
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
            ><ElTag type="info">共 {{ pagination.total }} 笔</ElTag></ElSpace
          ></template
        >
      </ArtTableHeader>
      <ArtTable
        :loading="ordersLoading"
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
          ><ElTag :type="tagType(row.status)">{{
            row.dispatchState === 'unassigned' ? '待分配' : statusLabels[row.status as OrderStatus]
          }}</ElTag
          ><p v-if="hasPendingReturn(row)" class="text-xs text-warning">退单待处理</p
          ><p v-if="row.compensationPending" class="text-xs text-warning">报酬待确认</p></template
        >
        <template #receivedAmount="{ row }"
          ><ElTag :type="row.receivedAmount === row.amount ? 'success' : 'warning'">{{
            row.receivedAmount === row.amount
              ? '足额收款'
              : row.receivedAmount
                ? '未足额'
                : '未收款'
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
                : row.dispatchState === 'unassigned'
                  ? '待客服分配'
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
    <BusinessDetailPanel
      page-key="order-detail"
      :record-id="selectedId"
      @restore="restoreOrder"
      @closed="orderDetailClosed"
      class="business-detail-drawer"
      v-model="drawer"
      title="订单详情"
      size="min(1120px, 96vw)"
      destroy-on-close
      :close-on-click-modal="!detailBusy"
      :close-on-press-escape="!detailBusy"
      :show-close="!detailBusy"
      :before-close="closeDrawer"
      ><OrderDetail v-if="selectedId" :order-id="selectedId" @busy="detailBusy = $event"
    /></BusinessDetailPanel>
  </div>
</template>
<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { useStudio, money, formatTime, statusLabels } from '@/hooks/business/useStudio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Order, OrderPage, OrderStatus } from '@/types/studio'
  import OrderDetail from '../modules/order-detail.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router'
  import type { LocationQuery, LocationQueryRaw } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { studioRequest } from '@/api/studio'
  defineOptions({ name: 'OrderList' })
  const { data, user, can, clearSession } = useStudio()
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
  const orderClosing = ref(false)
  const ordersLoading = ref(false)
  const tableData = ref<Order[]>([])
  const counts = ref<Record<string, number>>({})
  const pagination = reactive({ current: 1, size: 20, total: 0 })
  let ordersVersion = 0
  let ordersController: AbortController | null = null
  async function loadOrders() {
    if (!can('orders.view')) {
      ordersVersion++
      ordersController?.abort()
      tableData.value = []
      counts.value = {}
      pagination.total = 0
      ordersLoading.value = false
      return
    }
    const version = ++ordersVersion
    const accountId = user.value?.id
    ordersController?.abort()
    ordersController = new AbortController()
    ordersLoading.value = true
    const query = new URLSearchParams({
      current: String(pagination.current),
      size: String(pagination.size)
    })
    for (const [key, value] of Object.entries(applied.value)) {
      if (key !== 'dates' && value) query.set(key, String(value))
    }
    if (applied.value.dates) {
      query.set('start', applied.value.dates[0])
      query.set('end', applied.value.dates[1])
    }
    try {
      const result = await studioRequest<OrderPage>(
        `orders?${query}`,
        undefined,
        'GET',
        ordersController.signal
      )
      if (version !== ordersVersion || accountId !== user.value?.id) return
      tableData.value = result.records
      counts.value = result.counts || {}
      Object.assign(pagination, { current: result.current, size: result.size, total: result.total })
    } catch (cause) {
      if (version !== ordersVersion || (cause as Error).name === 'AbortError') return
      if ((cause as { status?: number }).status === 401) clearSession()
      ElMessage.error(cause instanceof Error ? cause.message : '订单读取失败')
    } finally {
      if (version === ordersVersion) ordersLoading.value = false
    }
  }
  function handleSizeChange(size: number) {
    pagination.size = size
    pagination.current = 1
    void loadOrders()
  }
  function handleCurrentChange(current: number) {
    pagination.current = current
    void loadOrders()
  }
  interface TimeoutNotice {
    id: string
    type: string
    title: string
    body: string
    orderId: string
    createdAt: string
    readAt?: string | null
  }
  const timeoutNotices = ref<TimeoutNotice[]>([])
  const timeoutTotal = ref(0)
  const timeoutPagination = reactive({ current: 1, size: 10 })
  const noticesError = ref('')
  const pendingTimeoutNotices = computed(() => timeoutNotices.value)
  let notificationTimer: ReturnType<typeof setInterval> | undefined
  let noticesLoading = false
  let noticesDisposed = false
  async function loadNotices() {
    if (!can('orders.edit')) {
      timeoutNotices.value = []
      timeoutTotal.value = 0
      return
    }
    if (noticesLoading || noticesDisposed) return
    const accountId = data.value?.user.id
    noticesLoading = true
    try {
      const result = await studioRequest<{
        records: TimeoutNotice[]
        total: number
        current: number
        size: number
      }>(
        `notifications/timeouts?current=${timeoutPagination.current}&size=${timeoutPagination.size}`
      )
      if (!noticesDisposed && accountId === data.value?.user.id && can('orders.edit')) {
        timeoutNotices.value = result.records
        timeoutTotal.value = result.total
        Object.assign(timeoutPagination, { current: result.current, size: result.size })
        noticesError.value = ''
      }
    } catch (cause) {
      if (!noticesDisposed && accountId === data.value?.user.id)
        noticesError.value = cause instanceof Error ? cause.message : '提醒读取失败，请重试'
    } finally {
      noticesLoading = false
    }
  }
  watch(
    () => data.value?.user.id,
    () => {
      timeoutNotices.value = []
      timeoutTotal.value = 0
      timeoutPagination.current = 1
      tableData.value = []
      counts.value = {}
      pagination.total = 0
      ordersVersion++
      ordersController?.abort()
      noticesError.value = ''
    }
  )
  async function openNotice(notice: TimeoutNotice) {
    if (detailBusy.value) return
    openOrder({ id: notice.orderId })
    try {
      await studioRequest(`notifications/${encodeURIComponent(notice.id)}/read`, {}, 'POST')
      await loadNotices()
      await loadOrders()
    } catch (cause) {
      ElMessage.warning(cause instanceof Error ? cause.message : '提醒处理失败，请刷新后重试')
    }
  }
  function validStatus(value: unknown) {
    return typeof value === 'string' &&
      (value in statusLabels || value === 'unassigned' || value === 'return-pending')
      ? value
      : ''
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
      { value: 'unassigned', label: '待分配' },
      { value: 'return-pending', label: '退单待办' },
      ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))
    ].map((item) => ({
      ...item,
      count: counts.value[item.value] || 0
    }))
  )
  const staffName = (id: string | null) => data.value?.users.find((u) => u.id === id)?.name || '—'
  const hasPendingReturn = (order: Order) =>
    order.returnRequests?.some((row) => row.status === 'pending')
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
  const reviewCount = computed(() => counts.value.review || 0)
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
        options: [
          ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
          { value: 'unassigned', label: '待分配' },
          { value: 'return-pending', label: '退单待办' }
        ]
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
  watch(
    () => data.value,
    () => {
      void loadOrders()
      void loadNotices()
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
    pagination.current = 1
    void loadOrders()
  }
  function applyStatus() {
    applySearch()
  }
  function closeDrawer(done: () => void) {
    if (!detailBusy.value) {
      orderClosing.value = true
      done()
    }
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
  const reload = () => loadOrders()
  function parentOrderId(query: LocationQuery) {
    const keys = Array.isArray(query.secondary) ? query.secondary : [query.secondary]
    const records = Array.isArray(query.secondaryRecord)
      ? query.secondaryRecord
      : [query.secondaryRecord]
    const index = keys.lastIndexOf('order-detail')
    const id = records[index]
    return index >= 0 && typeof id === 'string' && id ? id : ''
  }
  function orderPageQuery(id: string, original: LocationQuery = route.query): LocationQueryRaw {
    const query: LocationQueryRaw = {
      ...original,
      secondary: ['order-detail'],
      secondaryRecord: [id]
    }
    delete query.id
    return query
  }
  onBeforeRouteUpdate((to) => {
    const id = to.query.id
    if (
      to.path !== '/orders/list' ||
      typeof id !== 'string' ||
      !id ||
      id.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(id) ||
      to.query.secondary !== undefined
    )
      return
    // A panel that has already accepted its close must finish returning to the
    // list; an external legacy link retains the live model until guards approve.
    if (!drawer.value && id === selectedId.value && parentOrderId(route.query) === id) return
    return { path: to.path, query: orderPageQuery(id, to.query), hash: to.hash }
  })
  function openOrder(order: Pick<Order, 'id'>) {
    if (detailBusy.value) return
    if (parentOrderId(route.query) === order.id && !route.query.id) {
      selectedId.value = order.id
      drawer.value = true
    } else void router.push({ path: '/orders/list', query: orderPageQuery(order.id) })
  }
  function restoreOrder({ recordId, isCurrent }: { recordId?: string; isCurrent?: () => boolean }) {
    if (isCurrent && !isCurrent()) return

    if (recordId && can('orders.view')) openOrder({ id: recordId })
  }
  watch(
    () => route.query.status,
    (value) => {
      search.value.status = validStatus(value)
      applySearch()
    }
  )
  watch(
    [() => route.query.id, () => route.query.secondary, () => route.query.secondaryRecord],
    ([legacyId]) => {
      if (route.path !== '/orders/list') return
      const canonicalId = parentOrderId(route.query)
      if (typeof legacyId === 'string' && legacyId) {
        if (canonicalId) {
          const query = { ...route.query }
          delete query.id
          void router.replace({ query })
        } else void router.replace({ query: orderPageQuery(legacyId) })
        return
      }
      const id = canonicalId
      // A record switch first closes the previous panel. Reopen through its
      // closed lifecycle so an old close cannot discard the new target's body.
      if (orderClosing.value && !drawer.value && id && id !== selectedId.value) return
      if (detailBusy.value && id !== selectedId.value) {
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
  function orderDetailClosed() {
    orderClosing.value = false
    const targetId = parentOrderId(route.query)
    if (
      !drawer.value &&
      route.path === '/orders/list' &&
      targetId &&
      targetId !== selectedId.value
    ) {
      openOrder({ id: targetId })
      return
    }
    if (!drawer.value && route.path === '/orders/list' && !detailBusy.value) {
      void loadOrders()
      void loadNotices()
    }
    if (
      !drawer.value &&
      route.path === '/orders/list' &&
      route.query.id === selectedId.value &&
      !detailBusy.value
    ) {
      const query = { ...route.query }
      delete query.id
      void router.replace({ query })
    }
  }
  watch(
    () => route.query.payment,
    (value) => {
      search.value.payment = typeof value === 'string' ? value : ''
      applySearch()
    }
  )
  onMounted(() => {
    reload()
    void loadNotices()
    notificationTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadNotices()
        if (!detailBusy.value) reload()
      }
    }, 30_000)
  })
  onActivated(() => {
    void loadOrders()
    void loadNotices()
  })
  onUnmounted(() => {
    noticesDisposed = true
    ordersVersion++
    ordersController?.abort()
    if (notificationTimer) clearInterval(notificationTimer)
  })
</script>
