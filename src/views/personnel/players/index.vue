<template>
  <div class="players-page">
    <BusinessPageHeader
      title="打手管理"
      description="维护打手档案和三个操作开关，分别管理报酬钱包、独立押金与真实订单历史。"
      icon="ri:gamepad-line"
      :badge="`${pagination.total} 位符合筛选打手`"
    />
    <template v-if="canView">
      <div class="players-stats">
        <BusinessStatCard
          label="符合筛选的打手"
          :value="loading ? '—' : pagination.total"
          icon="ri:team-line"
          description="名单按当前条件和权限分页读取"
        />
        <BusinessStatCard
          label="本页执行中订单"
          :value="loading ? '—' : activeOrders"
          icon="ri:gamepad-line"
          tone="info"
          description="当前页打手已接订单数量"
        />
        <BusinessStatCard
          v-if="canFunds"
          label="本页独立押金"
          :value="loading || depositTotal == null ? '—' : money(depositTotal)"
          icon="ri:shield-check-line"
          tone="success"
          description="独立于报酬，不用于日常扣款"
        />
        <BusinessStatCard
          v-else
          label="档案与操作权限"
          value="分别控制"
          icon="ri:lock-line"
          description="登录、接新订单和申请新提现分别设置"
        />
      </div>
      <ArtSearchBar
        v-model="search"
        :items="searchItems"
        :show-expand="true"
        @search="applySearch"
        @reset="resetSearch"
      />
      <ElAlert v-if="error" :title="error" type="error" :closable="false" class="my-4" />
      <ElCard class="art-table-card players-table-card">
        <ArtTableHeader
          v-model:columns="columnChecks"
          :loading="loading"
          full-class="players-table-card"
          @refresh="reload"
        >
          <template #left
            ><ElSpace wrap
              ><ElButton
                v-if="canManage && isAdmin"
                type="primary"
                :disabled="pageBusy"
                @click="edit()"
                >新增打手账号</ElButton
              ><span class="text-sm text-g-500"
                >账号停用或禁止登录时，无法进入打手端。</span
              ></ElSpace
            ></template
          >
        </ArtTableHeader>
        <ArtTable
          :data="records"
          :columns="columns"
          :loading="loading"
          :pagination="pagination"
          @pagination:size-change="changeSize"
          @pagination:current-change="changePage"
        >
          <template #name="{ row }"
            ><div class="player-name"
              ><ElAvatar :size="34" class="!bg-theme/10 !text-theme">{{
                row.name.slice(0, 1)
              }}</ElAvatar
              ><strong>{{ row.name }}</strong></div
            ></template
          >
          <template #levelId="{ row }">{{
            data?.levels.find((level) => level.id === row.levelId)?.name || '未设置'
          }}</template>
          <template #activeOrders="{ row }"
            >{{ row.activeOrders ?? 0 }} / {{ row.maxActiveOrders }}</template
          >
          <template #status="{ row }"
            ><ElTag :type="row.status === 'active' ? 'success' : 'info'">{{
              row.status === 'active' ? '启用' : '停用'
            }}</ElTag></template
          >
          <template #playerAccess="{ row }"
            ><div class="access-tags"
              ><ElTag size="small" :type="canLogin(row) ? 'success' : 'info'">{{
                canLogin(row) ? '登录允许' : '登录禁止'
              }}</ElTag
              ><ElTag size="small" :type="access(row, 'claim') ? 'success' : 'info'">{{
                access(row, 'claim') ? '接单允许' : '接单禁止'
              }}</ElTag
              ><ElTag size="small" :type="access(row, 'withdraw') ? 'success' : 'info'">{{
                access(row, 'withdraw') ? '新提现允许' : '新提现禁止'
              }}</ElTag></div
            ></template
          >
          <template #available="{ row }">{{
            row.wallet ? money(row.wallet.available) : '—'
          }}</template>
          <template #depositBalance="{ row }">{{
            row.depositBalance == null ? '—' : money(row.depositBalance)
          }}</template>
          <template #operation="{ row }"
            ><ElButton v-if="canManage" link type="primary" :disabled="pageBusy" @click="edit(row)"
              >档案与权限</ElButton
            ><ElButton
              v-if="canFunds || canHistory"
              link
              type="primary"
              :disabled="pageBusy"
              @click="showDetail(row)"
              >{{ canFunds ? '账户与历史' : '订单历史' }}</ElButton
            ></template
          >
        </ArtTable>
      </ElCard>
    </template>
    <ElCard v-else shadow="never"><ElEmpty description="当前账号没有打手管理权限" /></ElCard>
    <UserDialog
      v-model:visible="editorOpen"
      :row="editorRow"
      default-role="player"
      account-kind="player"
      @busy="editorBusy = $event"
      @saved="profileSaved"
      @restore="restorePlayerEditor"
    />
    <BusinessDetailPanel
      page-key="player-detail"
      :record-id="selected?.id"
      @restore="restorePlayerDetail"
      class="business-detail-drawer"
      v-model="detailOpen"
      :title="selected ? `${selected.name} · 打手账户与历史` : '打手详情'"
      size="min(1100px,96vw)"
      :before-close="closeDetail"
      :close-on-click-modal="!pageBusy"
      :close-on-press-escape="!pageBusy"
      :show-close="!pageBusy"
      destroy-on-close
      @closed="selected = null"
    >
      <template v-if="selected">
        <BusinessDetailHeader
          :title="selected.name"
          description="打手档案、操作开关与独立资金账户，按当前权限分别展示。"
          icon="ri:gamepad-line"
          :badge="selected.status === 'active' ? '启用账号' : '停用账号'"
          :context="selected.username"
        />
        <BusinessDetailSummary
          :items="[
            {
              label: '执行中 / 上限',
              value: `${selected.activeOrders ?? 0} / ${selected.maxActiveOrders}`,
              hint: '本人作为有效负责人的接单名额'
            },
            { label: '登录', value: canLogin(selected) ? '允许' : '禁止' },
            { label: '接新订单', value: access(selected, 'claim') ? '允许' : '禁止' },
            { label: '申请新提现', value: access(selected, 'withdraw') ? '允许' : '禁止' }
          ]"
        />
        <ElDescriptions :column="2" border class="mb-4"
          ><ElDescriptionsItem label="登录账号">{{ selected.username }}</ElDescriptionsItem
          ><ElDescriptionsItem label="打手等级">{{
            data?.levels.find((level) => level.id === selected?.levelId)?.name || '未设置'
          }}</ElDescriptionsItem
          ><ElDescriptionsItem label="执行中 / 上限"
            >{{ selected.activeOrders ?? 0 }} / {{ selected.maxActiveOrders }}</ElDescriptionsItem
          ><ElDescriptionsItem label="登录状态">{{
            canLogin(selected) ? '允许登录' : '禁止登录'
          }}</ElDescriptionsItem></ElDescriptions
        >
        <ElAlert
          v-if="(selected.activeOrders || 0) > 0"
          title="当前仍有已接订单在进行。退店、跑路或关闭登录前，请先核对订单和人员移交；资金处理不会自动清空订单或工资。"
          type="warning"
          :closable="false"
          class="mb-4"
        />
        <ElTabs v-model="detailTab" :before-leave="beforeTabLeave">
          <ElTabPane v-if="canFunds" label="报酬钱包与扣补" name="wallet" />
          <ElTabPane v-if="canFunds" label="独立押金账户" name="deposits" />
          <ElTabPane v-if="canHistory" label="订单与接单历史" name="history" />
        </ElTabs>
        <PlayerWallet
          v-if="canFunds && detailTab === 'wallet'"
          :key="selected.id + '-wallet'"
          :player="selected"
          @busy="fundBusy = $event"
          @updated="refreshRows"
        />
        <PlayerDeposits
          v-if="canFunds && detailTab === 'deposits'"
          :key="selected.id + '-deposits'"
          :player="selected"
          @busy="fundBusy = $event"
          @updated="refreshRows"
        />
        <PlayerHistory
          v-if="canHistory && detailTab === 'history'"
          :key="selected.id + '-history'"
          :user-id="selected.id"
        />
      </template>
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
  import { onBeforeRouteLeave, useRoute } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { studioRequest } from '@/api/studio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import { money, useStudio } from '@/hooks/business/useStudio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import UserDialog from '@/views/system/user/modules/user-dialog.vue'
  import PlayerWallet from './modules/player-wallet.vue'
  import PlayerDeposits from './modules/player-deposits.vue'
  import PlayerHistory from './modules/player-history.vue'
  import type { PlayerListRecord, Staff } from '@/types/studio'

  defineOptions({ name: 'Players' })
  const { data, user, can, refresh, clearSession } = useStudio()
  const route = useRoute()
  const canManage = computed(() => can('users.manage'))
  const canFunds = computed(() => can('finance.withdrawals'))
  const canHistory = computed(() => can('orders.view') || canFunds.value)
  const canView = computed(() => canManage.value || canFunds.value)
  const isAdmin = computed(() => ['admin', 'super_admin'].includes(user.value?.role || ''))
  const loading = ref(false),
    error = ref(''),
    records = ref<PlayerListRecord[]>([])
  const pagination = reactive({ current: 1, size: 20, total: 0 })
  const emptySearch = () => ({
    name: '',
    username: '',
    levelId: '',
    status: '',
    login: '',
    claim: '',
    withdraw: ''
  })
  const search = ref(emptySearch()),
    applied = reactive(emptySearch())
  const editorOpen = ref(false),
    editorRow = ref<Staff>(),
    editorBusy = ref(false),
    profileLoading = ref(false)
  const detailOpen = ref(false),
    selected = ref<PlayerListRecord | null>(null),
    detailTab = ref('wallet'),
    fundBusy = ref(false)
  const pageBusy = computed(() => editorBusy.value || fundBusy.value || profileLoading.value)
  const activeOrders = computed(() =>
    records.value.reduce((sum, row) => sum + (row.activeOrders || 0), 0)
  )
  const depositTotal = computed(() =>
    records.value.some((row) => row.depositBalance == null)
      ? null
      : records.value.reduce((sum, row) => sum + (row.depositBalance || 0), 0)
  )
  const access = (row: PlayerListRecord, key: 'login' | 'claim' | 'withdraw') =>
    row.playerAccess?.[key] !== false
  const canLogin = (row: PlayerListRecord) => row.status === 'active' && access(row, 'login')
  const searchItems = computed(() => [
    {
      key: 'name',
      label: '打手名称',
      type: 'input',
      props: { clearable: true, placeholder: '仅搜索打手名称' }
    },
    {
      key: 'username',
      label: '登录账号',
      type: 'input',
      props: { clearable: true, placeholder: '仅搜索登录账号' }
    },
    {
      key: 'levelId',
      label: '打手等级',
      type: 'select',
      props: {
        clearable: true,
        options: (data.value?.levels || []).map((row) => ({ value: row.id, label: row.name }))
      }
    },
    {
      key: 'status',
      label: '账号状态',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { value: 'active', label: '启用' },
          { value: 'disabled', label: '停用' }
        ]
      }
    },
    ...[
      { key: 'login', label: '登录开关' },
      { key: 'claim', label: '接单开关' },
      { key: 'withdraw', label: '新提现开关' }
    ].map((item) => ({
      ...item,
      type: 'select',
      props: {
        clearable: true,
        options: [
          { value: 'true', label: '允许' },
          { value: 'false', label: '禁止' }
        ]
      }
    }))
  ])
  const { columns, columnChecks } = useTableColumns<PlayerListRecord>(() => [
    { prop: 'name', label: '打手名称', minWidth: 155, useSlot: true },
    { prop: 'username', label: '登录账号', minWidth: 150 },
    { prop: 'levelId', label: '等级', minWidth: 120, useSlot: true },
    { prop: 'activeOrders', label: '执行中 / 上限', width: 135, useSlot: true },
    { prop: 'status', label: '账号状态', width: 100, useSlot: true },
    { prop: 'playerAccess', label: '三项操作权限', minWidth: 280, useSlot: true },
    ...(canFunds.value
      ? [
          { prop: 'available', label: '可用报酬', width: 125, useSlot: true },
          { prop: 'depositBalance', label: '独立押金', width: 125, useSlot: true }
        ]
      : []),
    {
      prop: 'operation',
      label: '操作',
      width: canManage.value && canHistory.value ? 240 : 145,
      fixed: 'right',
      useSlot: true
    }
  ])
  let version = 0
  let controller: AbortController | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshPending = false
  const pageActive = () => route.path === '/personnel/players'
  function stopRefresh() {
    version++
    controller?.abort()
    clearTimeout(refreshTimer)
    refreshTimer = undefined
    refreshPending = false
    loading.value = false
  }
  function scheduleRefresh() {
    if (!pageActive() || !canView.value || document.visibilityState === 'hidden') return
    refreshPending = true
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      if (
        !pageActive() ||
        !canView.value ||
        document.visibilityState === 'hidden' ||
        pageBusy.value
      )
        return
      refreshPending = false
      void refreshRows()
    }, 40)
  }
  onMounted(() => {
    window.addEventListener('focus', scheduleRefresh)
    document.addEventListener('visibilitychange', scheduleRefresh)
  })
  onUnmounted(() => {
    stopRefresh()
    window.removeEventListener('focus', scheduleRefresh)
    document.removeEventListener('visibilitychange', scheduleRefresh)
  })
  async function refreshRows() {
    if (!pageActive() || !canView.value) return
    const currentVersion = ++version
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = ''
    try {
      const query = new URLSearchParams({
        current: String(pagination.current),
        size: String(pagination.size),
        ...applied
      })
      const result = await studioRequest<{
        records: PlayerListRecord[]
        total: number
        current: number
        size: number
      }>(`players?${query}`, undefined, 'GET', controller.signal)
      if (currentVersion !== version) return
      const lastPage = Math.max(1, Math.ceil(result.total / result.size))
      if (result.current > lastPage) {
        pagination.current = lastPage
        await refreshRows()
        return
      }
      records.value = result.records
      Object.assign(pagination, { total: result.total, current: result.current, size: result.size })
      if (selected.value) {
        const next = result.records.find((row) => row.id === selected.value?.id)
        if (next) selected.value = next
      }
    } catch (cause) {
      if (currentVersion !== version || (cause as { name?: string }).name === 'AbortError') return
      if ((cause as { status?: number }).status === 401) clearSession()
      records.value = []
      error.value = cause instanceof Error ? cause.message : '打手名单读取失败'
    } finally {
      if (currentVersion === version) loading.value = false
    }
  }
  function applySearch() {
    if (pageBusy.value) return
    for (const key of Object.keys(applied) as (keyof typeof applied)[])
      applied[key] = search.value[key] ?? ''
    pagination.current = 1
    void refreshRows()
  }
  function resetSearch() {
    if (pageBusy.value) return
    search.value = emptySearch()
    applySearch()
  }
  function changePage(current: number) {
    if (!pageBusy.value) {
      pagination.current = current
      void refreshRows()
    }
  }
  function changeSize(size: number) {
    if (!pageBusy.value) {
      pagination.size = size
      pagination.current = 1
      void refreshRows()
    }
  }
  async function reload() {
    if (pageBusy.value) return
    try {
      await refresh()
      await refreshRows()
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '刷新失败')
    }
  }
  async function edit(row?: PlayerListRecord) {
    if (pageBusy.value || !canManage.value || (!row && !isAdmin.value)) return
    profileLoading.value = true
    try {
      if (row) {
        await refresh()
        if (!canManage.value) return
        const complete = data.value?.users.find((person) => person.id === row.id)
        if (!complete || complete.role !== 'player')
          throw new Error('打手档案已变化，请刷新名单后重试')
        editorRow.value = complete
      } else editorRow.value = undefined
      editorOpen.value = true
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '档案读取失败')
    } finally {
      profileLoading.value = false
    }
  }
  function profileSaved() {
    void refreshRows()
  }
  function showDetail(row: PlayerListRecord) {
    if (pageBusy.value) return
    selected.value = row
    detailTab.value = canFunds.value ? 'wallet' : 'history'
    detailOpen.value = true
  }
  async function restorePlayerDetail({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    if (!recordId || pageBusy.value) return
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (!canView.value) return
      const row = await studioRequest<PlayerListRecord>(`players/${encodeURIComponent(recordId)}`)
      if (isCurrent && !isCurrent()) return
      if (!canView.value) return
      showDetail(row)
      const keys = Array.isArray(route.query.secondary)
        ? route.query.secondary
        : [route.query.secondary]
      if (
        keys.some((key) => typeof key === 'string' && key.startsWith('player-deposit-')) &&
        canFunds.value
      )
        detailTab.value = 'deposits'
      else if (keys.includes('player-order-assignments') && canHistory.value)
        detailTab.value = 'history'
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) clearSession()
      selected.value = null
      ElMessage.error(cause instanceof Error ? cause.message : '打手详情读取失败')
    }
  }
  async function restorePlayerEditor({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (!canManage.value) return
      if (recordId === 'new') await edit()
      if (isCurrent && !isCurrent()) return
      else if (recordId) {
        const row = await studioRequest<PlayerListRecord>(`players/${encodeURIComponent(recordId)}`)
        if (isCurrent && !isCurrent()) return
        await edit(row)
        if (isCurrent && !isCurrent()) return
      }
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  function closeDetail(done: () => void) {
    if (pageBusy.value) return void ElMessage.warning('正在保存或上传，请稍后关闭')
    done()
  }
  function beforeTabLeave() {
    if (pageBusy.value) {
      ElMessage.warning('正在保存或上传，请稍后切换')
      return false
    }
    return true
  }
  onBeforeRouteLeave(() => {
    if (pageBusy.value) {
      ElMessage.warning('正在保存或上传，请稍后离开')
      return false
    }
    return true
  })
  watch(
    [() => data.value?.permissions.join('|'), () => user.value?.id],
    () => {
      stopRefresh()
      records.value = []
      pagination.total = 0
      if (!canView.value) {
        detailOpen.value = false
        editorOpen.value = false
        selected.value = null
        return
      }
      if (!canManage.value) editorOpen.value = false
      if (!canFunds.value && detailTab.value !== 'history') detailTab.value = 'history'
      if (!canHistory.value) detailOpen.value = false
      scheduleRefresh()
    },
    { immediate: true }
  )
  watch(() => data.value, scheduleRefresh)
  watch(pageBusy, (busy) => {
    if (!busy && refreshPending) scheduleRefresh()
  })
  let routeFiltersInitialized = false
  let routeName: unknown
  let routeUsername: unknown
  watch(
    [() => route.path, () => route.query.name, () => route.query.username],
    ([path, name, username]) => {
      if (path !== '/personnel/players') {
        stopRefresh()
        return
      }
      if (!routeFiltersInitialized || name !== routeName || username !== routeUsername) {
        routeFiltersInitialized = true
        routeName = name
        routeUsername = username
        search.value.name = typeof name === 'string' ? name : ''
        search.value.username = typeof username === 'string' ? username : ''
        applied.name = search.value.name
        applied.username = search.value.username
        pagination.current = 1
      }
      scheduleRefresh()
    },
    { immediate: true }
  )
</script>

<style scoped lang="scss">
  .players-page {
    display: flex;
    flex-direction: column;
  }

  .players-table-card {
    flex: none;
    height: clamp(420px, 60vh, 680px);
  }

  .players-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
    margin-bottom: 20px;
  }

  .player-name {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .access-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  @media (width < 768px) {
    .players-stats {
      grid-template-columns: 1fr;
      gap: 12px;
    }
  }
</style>
