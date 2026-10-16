<template>
  <div class="overview-detail-explorer">
    <ElResult
      v-if="masked"
      icon="info"
      title="金额已隐藏"
      sub-title="显示金额后查看当前已授权的账户明细。"
    />
    <template v-else>
      <div class="detail-read-toolbar">
        <span>明细由服务器授权筛选 · {{ range.start }} 至 {{ range.end }}</span>
        <ElButton :loading="loading" @click="load">刷新详情</ElButton>
      </div>
      <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon class="mb-4" />
      <div class="detail-explorer-layout">
        <aside v-if="views.length" class="detail-explorer-navigation" aria-label="统计详情分类">
          <button
            v-for="view in views"
            :key="view.id"
            type="button"
            :class="{ active: selectedView === view.id }"
            :disabled="loading || !view.allowed"
            :aria-current="selectedView === view.id ? 'page' : undefined"
            @click="chooseView(view.id)"
          >
            <span>{{ view.label }}</span
            ><small v-if="!view.allowed">权限未开放</small>
          </button>
          <span
            v-if="metric === 'received' && response && !response.capabilities.terminal.supported"
            class="detail-unavailable-dimension"
            >端游 / 手游<br />{{ response.capabilities.terminal.reason }}</span
          >
        </aside>
        <main class="detail-explorer-content">
          <ElSkeleton v-if="loading" :rows="6" animated />
          <template v-else-if="response">
            <div class="detail-view-heading"
              ><div
                ><h3>{{ activeLabel }}</h3
                ><p
                  >筛选后共 {{ response.total }} 条 · 当前 {{ response.records.length }} 条</p
                ></div
              ><ElTag effect="plain" size="small">真实分页明细</ElTag></div
            >
            <form class="detail-keyword-search" @submit.prevent="search">
              <ElInput
                v-model="draftKeyword"
                :maxlength="100"
                clearable
                placeholder="搜索此分类公开的名称、标题或工作室单号"
                aria-label="搜索统计明细"
              />
              <ElButton native-type="submit" type="primary" plain>搜索明细</ElButton>
              <ElButton v-if="keyword" @click="resetSearch">清空</ElButton>
            </form>
            <section v-if="response.groups.length" class="detail-distribution">
              <div class="detail-distribution-heading"
                ><strong>{{ dimensionLabel }}</strong
                ><ElRadioGroup v-model="chartMeasure" size="small"
                  ><ElRadioButton value="count">{{
                    response.groupsInfo.countLabel || '记录数'
                  }}</ElRadioButton
                  ><ElRadioButton v-if="amountAvailable" value="amount">{{
                    response.groupsInfo.amountLabel || '金额'
                  }}</ElRadioButton></ElRadioGroup
                ></div
              >
              <ArtBarChart
                v-if="chartValues.length"
                :key="`${selectedView}:${chartMeasure}`"
                height="260px"
                :data="chartValues"
                :x-axis-data="chartLabels"
                :colors="['#3478f6']"
                :bar-width="'36%'"
                :show-axis-line="false"
              />
              <ElEmpty v-else description="部分分类金额待核实，不以零补图。" :image-size="60" />
              <p class="detail-scope-note"
                >{{
                  chartMeasure === 'amount'
                    ? `${response.groupsInfo.amountLabel || '金额'}，单位：元；负差额保留符号。`
                    : `${response.groupsInfo.countLabel || '当前视图记录数'}；接单记录数与去重订单数分别统计。`
                }}
                图表展示服务器排序的前 {{ chartGroups.length }} 组，共
                {{ response.groupsInfo.total }} 组{{
                  response.groupsInfo.truncated ? '，服务器最多返回100组' : ''
                }}；完整匹配集先分组，未使用当前页凑总数。</p
              >
            </section>
            <ElTable
              :data="response.records"
              border
              max-height="390"
              class="detail-record-table"
              empty-text="所选范围没有匹配记录"
            >
              <ElTableColumn
                v-for="column in response.columns"
                :key="column.key"
                :label="column.label"
                :min-width="column.type === 'datetime' ? 170 : column.type === 'money' ? 130 : 120"
                show-overflow-tooltip
              >
                <template #default="{ row }"
                  ><ElButton
                    v-if="column.key === 'orderNo' && can('orders.view') && (row.orderId || row.id)"
                    link
                    type="primary"
                    @click="openOrder(row)"
                    >{{ cell(row[column.key], column) }}</ElButton
                  ><span v-else>{{ cell(row[column.key], column) }}</span></template
                >
              </ElTableColumn>
            </ElTable>
            <div class="detail-pagination"
              ><span>汇总不受本页条数影响</span
              ><ElPagination
                :current-page="response.current"
                :page-size="response.size"
                :total="response.total"
                :pager-count="5"
                :page-sizes="[10, 20, 50, 100]"
                layout="prev, pager, next, sizes"
                @current-change="changePage"
                @size-change="changeSize"
            /></div>
            <BusinessDetailSection
              title="本分类统计口径"
              description="当前余额、实际发放、付款、创建、完成和接单时间分别保留原业务口径。"
              ><p v-for="note in response.notes" :key="note" class="detail-scope-note">{{
                note
              }}</p></BusinessDetailSection
            >
            <p class="detail-scope-note"
              >数据读取于
              {{ formatTime(response.generatedAt) }}；点击订单后仍按当前权限重新读取详情。</p
            >
          </template>
          <ElEmpty v-else-if="!error" description="正在准备授权明细" :image-size="70" />
        </main>
      </div>
    </template>
  </div>
</template>
<script setup lang="ts">
  import { computed, onBeforeUnmount, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { studioRequest } from '@/api/studio'
  import {
    useStudio,
    money,
    formatTime,
    roleLabels,
    statusLabels
  } from '@/hooks/business/useStudio'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import ArtBarChart from '@/components/core/charts/art-bar-chart/index.vue'
  import type {
    OverviewDetailColumn,
    OverviewDetails,
    OverviewRange,
    OverviewReport
  } from '@/types/overview'
  import type { OrderStatus, Role } from '@/types/studio'
  const props = defineProps<{ metric: string; range: OverviewRange; masked: boolean }>()
  const emit = defineEmits<{ refreshed: [report: OverviewReport]; navigate: [] }>()
  const { user, data, can, clearSession } = useStudio()
  const router = useRouter()
  const response = ref<OverviewDetails | null>(null)
  const views = ref<OverviewDetails['capabilities']['views']>([])
  const selectedView = ref('')
  const draftKeyword = ref('')
  const keyword = ref('')
  const current = ref(1)
  const size = ref(20)
  const loading = ref(false)
  const error = ref('')
  const chartMeasure = ref<'count' | 'amount'>('count')
  let chooseInitialMeasure = true
  let version = 0
  let controller: AbortController | null = null
  const activeLabel = computed(
    () => views.value.find((view) => view.id === selectedView.value)?.label || '业务明细'
  )
  const chartGroups = computed(() => (response.value?.groups || []).slice(0, 12))
  const amountAvailable = computed(() =>
    response.value?.groups.some((group) => group.amount !== null)
  )
  const dimensionLabel = computed(
    () =>
      (
        ({
          date: '每日分布',
          game: '游戏分类',
          project: '项目/价格快照分类',
          platform: '平台分布',
          player: '接单打手分布',
          role: '岗位分布',
          status: '状态分布'
        }) as Record<string, string>
      )[response.value?.groupsInfo.dimension || ''] || '分类分布'
  )
  const chartLabels = computed(() =>
    chartGroups.value.map((group) =>
      response.value?.groupsInfo.dimension === 'status'
        ? cell(group.label, { key: 'status', label: '状态', type: 'status' })
        : response.value?.groupsInfo.dimension === 'role'
          ? roleLabels[group.label as Role] || group.label
          : group.label
    )
  )
  const chartValues = computed(() =>
    chartMeasure.value === 'amount'
      ? chartGroups.value.every((group) => typeof group.amount === 'number')
        ? chartGroups.value.map((group) => group.amount! / 100)
        : []
      : chartGroups.value.map((group) => group.count)
  )
  function clear() {
    controller?.abort()
    controller = null
    version++
    response.value = null
    views.value = []
    loading.value = false
    error.value = ''
  }
  async function load() {
    if (props.masked || !user.value) {
      clear()
      return
    }
    controller?.abort()
    const request = ++version
    const owner = user.value.id
    const parameters = new URLSearchParams({
      metric: props.metric,
      start: props.range.start,
      end: props.range.end,
      current: String(current.value),
      size: String(size.value)
    })
    if (selectedView.value) parameters.set('view', selectedView.value)
    if (keyword.value) parameters.set('keyword', keyword.value)
    const active = new AbortController()
    controller = active
    loading.value = true
    response.value = null
    error.value = ''
    try {
      const result = await studioRequest<OverviewDetails>(
        `overview/details?${parameters}`,
        undefined,
        'GET',
        active.signal
      )
      if (request !== version || active.signal.aborted || user.value?.id !== owner || props.masked)
        return
      response.value = result
      selectedView.value = result.view
      views.value = result.capabilities.views
      if (!amountAvailable.value) chartMeasure.value = 'count'
      else if (chooseInitialMeasure) chartMeasure.value = 'amount'
      chooseInitialMeasure = false
      emit('refreshed', result.overview)
    } catch (cause) {
      if (request !== version || active.signal.aborted || user.value?.id !== owner) return
      if ((cause as { status?: number }).status === 401) clearSession()
      response.value = null
      error.value = cause instanceof Error ? cause.message : '详情读取失败，请重试'
    } finally {
      if (request === version) loading.value = false
    }
  }
  function chooseView(view: string) {
    selectedView.value = view
    current.value = 1
    chooseInitialMeasure = true
    void load()
  }
  function changePage(value: number) {
    current.value = value
    void load()
  }
  function changeSize(value: number) {
    size.value = value
    current.value = 1
    void load()
  }
  function search() {
    keyword.value = draftKeyword.value.trim()
    current.value = 1
    void load()
  }
  function resetSearch() {
    draftKeyword.value = ''
    keyword.value = ''
    current.value = 1
    void load()
  }
  function cell(value: unknown, column: OverviewDetailColumn) {
    if (column.type === 'money') return typeof value === 'number' ? money(value) : '待核实 / 未配置'
    if (value == null || value === '') return '—'
    if (column.type === 'datetime')
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? value
        : formatTime(String(value))
    if (column.key === 'role') return roleLabels[value as Role] || String(value)
    if (column.type === 'status') {
      if (typeof value === 'boolean') return value ? '是' : '否'
      if (
        ['people', 'wallet'].includes(props.metric) &&
        ['active', 'disabled'].includes(String(value))
      )
        return value === 'active' ? '启用' : '停用'
      if (
        ['received', 'orders', 'customers', 'profit', 'accepted', 'personal'].includes(
          props.metric
        ) &&
        statusLabels[value as OrderStatus]
      )
        return statusLabels[value as OrderStatus]
      return (
        (
          {
            paid: '已发放',
            approved: '审核通过',
            rejected: '已拒绝',
            pending: '待审核',
            canceled: '已撤回',
            incomplete: '待核实',
            complete: '完整'
          } as Record<string, string>
        )[String(value)] ||
        statusLabels[value as OrderStatus] ||
        String(value)
      )
    }
    return typeof value === 'boolean' ? (value ? '是' : '否') : String(value)
  }
  async function openOrder(row: Record<string, unknown>) {
    const failure = await router.push({
      path: '/orders/list',
      query: { id: String(row.orderId || row.id) }
    })
    if (!failure) emit('navigate')
  }
  watch(
    [
      () => props.metric,
      () => props.range.start,
      () => props.range.end,
      () => props.masked,
      () => user.value?.id,
      () => data.value?.permissions.join('|')
    ],
    () => {
      clear()
      selectedView.value = ''
      current.value = 1
      chooseInitialMeasure = true
      draftKeyword.value = ''
      keyword.value = ''
      void load()
    },
    { immediate: true, flush: 'sync' }
  )
  onBeforeUnmount(clear)
</script>
<style scoped lang="scss">
  .detail-read-toolbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin: 18px 0;
    padding: 12px 14px;
    background: var(--el-fill-color-light);
    border-radius: 10px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
  .detail-explorer-layout {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 22px;
  }
  .detail-explorer-navigation {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 14px;
    border-right: 1px solid var(--el-border-color-lighter);
  }
  .detail-explorer-navigation button {
    padding: 13px 12px;
    text-align: left;
    font-size: 13px;
    line-height: 1.6;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--el-text-color-secondary);
    cursor: pointer;
  }
  .detail-explorer-navigation button.active {
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-color: var(--el-color-primary-light-8);
    font-weight: 600;
  }
  .detail-explorer-navigation button:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .detail-explorer-navigation small {
    display: block;
    font-size: 11px;
  }
  .detail-unavailable-dimension {
    padding: 12px;
    font-size: 11px;
    line-height: 1.8;
    color: var(--el-text-color-secondary);
  }
  .detail-explorer-content {
    min-width: 0;
  }
  .detail-view-heading,
  .detail-distribution-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 14px;
  }
  .detail-view-heading h3 {
    font-size: 16px;
    font-weight: 650;
  }
  .detail-view-heading p,
  .detail-scope-note {
    margin-top: 7px;
    font-size: 12px;
    line-height: 1.8;
    color: var(--el-text-color-secondary);
    overflow-wrap: anywhere;
  }
  .detail-keyword-search {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }
  .detail-distribution {
    margin-bottom: 20px;
    padding: 16px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 10px;
  }
  .detail-pagination {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }
  .detail-pagination > span {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
  @media (width < 768px) {
    .detail-explorer-layout {
      grid-template-columns: minmax(0, 1fr);
      gap: 14px;
    }
    .detail-explorer-navigation {
      flex-direction: row;
      overflow-x: auto;
      padding-right: 0;
      padding-bottom: 12px;
      border-right: 0;
      border-bottom: 1px solid var(--el-border-color-lighter);
    }
    .detail-explorer-navigation button {
      flex-shrink: 0;
    }
    .detail-unavailable-dimension {
      min-width: 150px;
    }
    .detail-pagination :deep(.el-pagination) {
      flex-wrap: wrap;
      row-gap: 8px;
    }
    .detail-keyword-search {
      flex-wrap: wrap;
    }
    .detail-keyword-search :deep(.el-input) {
      flex-basis: 100%;
    }
  }
</style>
