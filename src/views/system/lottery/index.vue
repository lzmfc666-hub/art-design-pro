<script setup lang="ts">
  import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
  import { onBeforeRouteLeave } from 'vue-router'
  import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
  import { studioRequest } from '@/api/studio'
  import { useStudio, formatTime } from '@/hooks/business/useStudio'
  import type { Attachment } from '@/types/studio'
  import {
    lotteryTiers,
    lotteryStatusLabels,
    type LotteryPool,
    type LotteryPrize,
    type LotteryTier,
    type LotteryOrderRecord
  } from '@/types/lottery'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import OrderDetail from '@/views/orders/modules/order-detail.vue'

  defineOptions({ name: 'LotteryManagement' })
  const { user, can, upload, clearSession } = useStudio()
  const allowed = computed(() =>
    ['admin', 'manager', 'owner', 'super_admin'].includes(user.value?.role || '')
  )
  const tab = ref('pools')
  const tier = ref<LotteryTier>('special-small')
  const pools = ref<LotteryPool[]>([])
  const drafts = ref<Partial<Record<LotteryTier, LotteryPrize[]>>>({})
  const loading = ref(false)
  const saving = ref(false)
  const uploadingId = ref('')
  const error = ref('')
  const conflict = ref(false)
  const selectedPool = computed(() => pools.value.find((pool) => pool.tier === tier.value))
  const prizes = computed(() => drafts.value[tier.value] || [])
  const busy = computed(() => saving.value || !!uploadingId.value)
  const dirty = computed(() =>
    pools.value.some(
      (pool) => JSON.stringify(pool.prizes) !== JSON.stringify(drafts.value[pool.tier])
    )
  )
  const selectedDirty = computed(
    () =>
      selectedPool.value &&
      JSON.stringify(selectedPool.value.prizes) !== JSON.stringify(prizes.value)
  )
  let epoch = 0
  let poolVersion = 0
  let listVersion = 0
  const clonePrizes = (rows: LotteryPrize[]): LotteryPrize[] =>
    rows.map((prize) => ({ ...prize, image: prize.image ? { ...prize.image } : null }))
  const errorText = (cause: unknown) =>
    cause instanceof Error ? cause.message : '读取失败，请稍后重试'

  // One unit is 0.0001 percentage points. Sum integers rather than floating point values.
  function probabilityUnits(value: string): number | null {
    if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(value)) return null
    const [whole, fraction = ''] = value.split('.')
    const units = Number(whole) * 10000 + Number(fraction.padEnd(4, '0'))
    return units <= 1000000 ? units : null
  }
  const totalUnits = computed(() => {
    const units = prizes.value.map((prize) => probabilityUnits(prize.probability))
    return units.some((value) => value === null)
      ? null
      : (units as number[]).reduce((sum, value) => sum + value, 0)
  })
  const totalLabel = computed(() => {
    const value = totalUnits.value
    return value === null
      ? '存在无效概率'
      : `${Math.floor(value / 10000)}.${String(value % 10000).padStart(4, '0')}%`
  })
  const valid = computed(
    () =>
      prizes.value.length === 6 &&
      totalUnits.value === 1000000 &&
      prizes.value.every((prize) => prize.title.trim() && prize.image)
  )

  async function confirmDiscard() {
    if (!dirty.value) return true
    try {
      await ElMessageBox.confirm('尚有未保存的奖项配置，是否丢弃这些修改？', '确认丢弃修改', {
        type: 'warning',
        confirmButtonText: '丢弃修改',
        cancelButtonText: '继续编辑'
      })
      return true
    } catch {
      return false
    }
  }
  async function loadPools(confirm = false) {
    if (!allowed.value || busy.value || loading.value) return
    const accountId = user.value?.id
    const generation = epoch
    if (confirm && !(await confirmDiscard())) return
    if (generation !== epoch || accountId !== user.value?.id || !allowed.value) return
    const version = ++poolVersion
    loading.value = true
    error.value = ''
    try {
      const result = await studioRequest<{ tiers: LotteryPool[] }>('lottery/pools')
      if (version !== poolVersion || generation !== epoch || accountId !== user.value?.id) return
      pools.value = result.tiers
      drafts.value = Object.fromEntries(
        result.tiers.map((pool) => [pool.tier, clonePrizes(pool.prizes)])
      )
      conflict.value = false
    } catch (cause) {
      if (version !== poolVersion || generation !== epoch) return
      const status = (cause as { status?: number }).status
      if (status === 401) clearSession()
      if (status === 403) {
        pools.value = []
        drafts.value = {}
      }
      error.value = errorText(cause)
    } finally {
      if (version === poolVersion && generation === epoch) loading.value = false
    }
  }
  async function savePool() {
    if (!allowed.value || busy.value || loading.value || conflict.value || !selectedPool.value)
      return
    if (!valid.value) {
      ElMessage.warning('请填写全部 6 项图片和文字，概率最多 4 位小数且合计为 100%')
      return
    }
    const generation = epoch
    const accountId = user.value?.id
    const targetTier = tier.value
    const revision = selectedPool.value.revision
    const submitted = clonePrizes(prizes.value).map((prize) => ({
      ...prize,
      title: prize.title.trim()
    }))
    saving.value = true
    error.value = ''
    try {
      const saved = await studioRequest<LotteryPool>(
        'lottery/pools',
        { tier: targetTier, revision, prizes: submitted },
        'POST'
      )
      if (generation !== epoch || accountId !== user.value?.id || !allowed.value) return
      pools.value = pools.value.map((pool) => (pool.tier === targetTier ? saved : pool))
      drafts.value[targetTier] = clonePrizes(saved.prizes)
      ElMessage.success('转盘配置已保存，尚未抽奖的兑换码使用最新配置')
    } catch (cause) {
      if (generation !== epoch || accountId !== user.value?.id) return
      const status = (cause as { status?: number }).status
      if (status === 401) clearSession()
      if (status === 403) {
        pools.value = []
        drafts.value = {}
      }
      conflict.value = status === 409 || !status || status >= 500
      error.value =
        status === 409
          ? '其他管理员已修改配置，当前草稿已保留。请读取已保存配置，核对后再修改保存。'
          : conflict.value
            ? '保存结果尚未确认，当前草稿已保留。请读取已保存配置后核对。'
            : errorText(cause)
    } finally {
      if (generation === epoch) saving.value = false
    }
  }
  async function uploadPrizeImage(prize: LotteryPrize, file: UploadFile) {
    if (!file.raw || !allowed.value || busy.value || loading.value || !prizes.value.includes(prize))
      return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.raw.type)) {
      ElMessage.warning('请选择 PNG、JPG 或 WebP 图片')
      return
    }
    if (file.raw.size <= 0 || file.raw.size > 8 * 1024 * 1024) {
      ElMessage.warning('奖项图片应大于 0 且不超过 8MB')
      return
    }
    const generation = epoch
    const accountId = user.value?.id
    uploadingId.value = prize.id
    try {
      const attachment: Attachment = await upload(file.raw)
      if (
        generation === epoch &&
        accountId === user.value?.id &&
        allowed.value &&
        prizes.value.includes(prize)
      ) {
        prize.image = attachment
        ElMessage.success('奖项图片已上传，保存配置后生效')
      }
    } catch (cause) {
      if (generation !== epoch || accountId !== user.value?.id) return
      if ((cause as { status?: number }).status === 401) clearSession()
      ElMessage.error(errorText(cause))
    } finally {
      if (generation === epoch) uploadingId.value = ''
    }
  }

  const records = ref<LotteryOrderRecord[]>([])
  const listLoading = ref(false)
  const listError = ref('')
  const listTier = ref<LotteryTier | ''>('')
  const current = ref(1)
  const size = ref(20)
  const total = ref(0)
  const selectedOrderId = ref('')
  const detailBusy = ref(false)
  const detailOpen = ref(false)
  async function loadOrders() {
    if (!allowed.value) return
    const generation = epoch
    const accountId = user.value?.id
    const version = ++listVersion
    listLoading.value = true
    listError.value = ''
    const query = new URLSearchParams({ current: String(current.value), size: String(size.value) })
    if (listTier.value) query.set('tier', listTier.value)
    try {
      const result = await studioRequest<{
        records: LotteryOrderRecord[]
        total: number
        current: number
        size: number
      }>(`lottery/orders?${query}`)
      if (generation !== epoch || version !== listVersion || accountId !== user.value?.id) return
      records.value = result.records
      total.value = result.total
      current.value = result.current
      size.value = result.size
    } catch (cause) {
      if (generation !== epoch || version !== listVersion) return
      if ((cause as { status?: number }).status === 401) clearSession()
      records.value = []
      total.value = 0
      listError.value = errorText(cause)
    } finally {
      if (generation === epoch && version === listVersion) listLoading.value = false
    }
  }
  function openOrder(orderId: string) {
    if (!can('orders.view') || detailBusy.value) return
    selectedOrderId.value = orderId
    detailOpen.value = true
  }
  function restoreOrder(payload: { recordId?: string; isCurrent?: () => boolean }) {
    if (payload.recordId && allowed.value && can('orders.view') && payload.isCurrent?.() !== false)
      openOrder(payload.recordId)
  }
  function closeDetail(done: () => void) {
    if (!detailBusy.value) done()
  }
  function changeCurrent(value: number) {
    current.value = value
    void loadOrders()
  }
  function orderDetailClosed() {
    selectedOrderId.value = ''
    detailBusy.value = false
  }
  watch([listTier, size], () => {
    current.value = 1
    if (tab.value === 'orders') void loadOrders()
  })
  watch(tab, (value) => {
    if (value === 'orders') void loadOrders()
  })
  watch(
    [() => user.value?.id, () => user.value?.role, allowed],
    () => {
      epoch++
      poolVersion++
      listVersion++
      pools.value = []
      drafts.value = {}
      records.value = []
      total.value = 0
      selectedOrderId.value = ''
      detailOpen.value = false
      detailBusy.value = false
      loading.value = false
      saving.value = false
      uploadingId.value = ''
      listLoading.value = false
      error.value = ''
      listError.value = ''
      conflict.value = false
      if (allowed.value) {
        void loadPools()
        if (tab.value === 'orders') void loadOrders()
      }
    },
    { immediate: true }
  )
  onBeforeRouteLeave(async () => {
    if (!user.value || !allowed.value) return true
    if (busy.value || detailBusy.value) {
      ElMessage.warning('正在处理，请稍候再离开')
      return false
    }
    return confirmDiscard()
  })
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value || busy.value) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  onMounted(() => window.addEventListener('beforeunload', beforeUnload))
  onUnmounted(() => {
    epoch++
    window.removeEventListener('beforeunload', beforeUnload)
  })
</script>

<template>
  <div class="lottery-admin">
    <BusinessPageHeader
      title="转盘管理"
      description="配置四种转盘的奖项与概率，查看兑换码状态和中奖记录。"
      icon="ri:disc-line"
      badge="一码一次"
    />
    <ElAlert
      v-if="!allowed"
      title="仅管理员、店长、老板和超级管理员可管理转盘。"
      type="warning"
      :closable="false"
      show-icon
    />
    <ElCard v-else shadow="never">
      <ElTabs v-model="tab" :before-leave="() => !busy && !detailBusy">
        <ElTabPane name="pools" label="奖项配置" />
        <ElTabPane name="orders" label="转盘订单与中奖记录" />
      </ElTabs>
      <template v-if="tab === 'pools'">
        <div class="lottery-toolbar">
          <ElSelect v-model="tier" :disabled="busy || loading" aria-label="选择转盘">
            <ElOption
              v-for="item in lotteryTiers"
              :key="item.value"
              :value="item.value"
              :label="item.label"
            />
          </ElSelect>
          <ElTag v-if="selectedPool" :type="selectedPool.configured ? 'success' : 'warning'">
            {{ selectedPool.configured ? '已配置' : '尚未配置' }} · 版本 {{ selectedPool.revision }}
          </ElTag>
          <span class="lottery-total" :class="{ 'is-invalid': totalUnits !== 1000000 }"
            >概率合计：{{ totalLabel }}</span
          >
          <ElButton :disabled="busy || loading" :loading="loading" @click="loadPools(true)"
            >读取已保存配置</ElButton
          >
          <ElButton
            type="primary"
            :loading="saving"
            :disabled="busy || loading || conflict || !selectedDirty || !valid"
            @click="savePool"
            >保存当前转盘</ElButton
          >
        </div>
        <ElAlert
          v-if="error"
          :title="error"
          type="error"
          :closable="false"
          show-icon
          class="mb-4"
        />
        <p class="lottery-hint"
          >每盘固定 6 个选项。概率支持 0～100%，最多 4 位小数，六项合计须为
          100%。概率仅后台可见，保存后影响尚未抽奖的兑换码。</p
        >
        <ArtTable
          :data="prizes"
          :loading="loading"
          row-key="id"
          :show-table-header="false"
          :border="false"
          empty-text="尚未读取配置，请点击读取已保存配置"
        >
          <ElTableColumn type="index" label="序号" width="70" />
          <ElTableColumn label="奖项图片" min-width="220">
            <template #default="{ row }">
              <div class="lottery-prize-image">
                <img v-if="row.image" :src="row.image.url" :alt="row.title || '奖项图片'" />
                <span v-else class="lottery-image-empty">待上传图片</span>
                <ElUpload
                  action="#"
                  :auto-upload="false"
                  :show-file-list="false"
                  accept="image/png,image/jpeg,image/webp"
                  :disabled="busy || loading"
                  :on-change="(file: UploadFile) => uploadPrizeImage(row, file)"
                >
                  <ElButton :loading="uploadingId === row.id" :disabled="busy || loading">{{
                    row.image ? '替换图片' : '上传图片'
                  }}</ElButton>
                </ElUpload>
              </div>
              <p class="lottery-hint">PNG / JPG / WebP，最大 8MB</p>
            </template>
          </ElTableColumn>
          <ElTableColumn label="奖项文字" min-width="240">
            <template #default="{ row }"
              ><ElInput
                v-model="row.title"
                :disabled="busy || loading"
                maxlength="80"
                show-word-limit
                placeholder="填写奖项内容"
                :aria-label="`奖项 ${prizes.indexOf(row) + 1} 文字`"
            /></template>
          </ElTableColumn>
          <ElTableColumn label="中奖概率" min-width="200">
            <template #default="{ row }">
              <ElInput
                v-model="row.probability"
                inputmode="decimal"
                :disabled="busy || loading"
                maxlength="8"
                placeholder="例如 0.0001"
                :aria-label="`奖项 ${prizes.indexOf(row) + 1} 概率`"
                ><template #append>%</template></ElInput
              >
              <p v-if="probabilityUnits(row.probability) === null" class="lottery-invalid"
                >请输入 0～100，最多 4 位小数</p
              >
            </template>
          </ElTableColumn>
        </ArtTable>
      </template>
      <template v-else>
        <div class="lottery-toolbar">
          <ElSelect v-model="listTier" clearable placeholder="全部转盘" aria-label="筛选转盘订单">
            <ElOption
              v-for="item in lotteryTiers"
              :key="item.value"
              :value="item.value"
              :label="item.label"
            />
          </ElSelect>
          <ElButton :loading="listLoading" @click="loadOrders">刷新订单</ElButton>
          <span class="lottery-hint">共 {{ total }} 笔；兑换码仅在有权查看的订单详情中提供。</span>
        </div>
        <ElAlert v-if="listError" :title="listError" type="error" :closable="false" class="mb-4" />
        <ArtTable
          :data="records"
          :loading="listLoading"
          row-key="orderId"
          :show-table-header="false"
          :border="false"
          empty-text="暂无转盘订单"
        >
          <ElTableColumn label="订单" min-width="220"
            ><template #default="{ row }"
              ><span>{{ row.title }}</span
              ><p class="lottery-hint">{{ row.orderNo }}</p></template
            ></ElTableColumn
          >
          <ElTableColumn label="转盘" min-width="135"
            ><template #default="{ row }">{{
              lotteryTiers.find((item) => item.value === row.tier)?.label || '—'
            }}</template></ElTableColumn
          >
          <ElTableColumn label="兑换码状态" min-width="140"
            ><template #default="{ row }"
              ><ElTag>{{
                lotteryStatusLabels[row.status as keyof typeof lotteryStatusLabels] || row.status
              }}</ElTag></template
            ></ElTableColumn
          >
          <ElTableColumn label="发码 / 到期时间" min-width="210"
            ><template #default="{ row }"
              ><p>{{ formatTime(row.createdAt) }}</p
              ><p class="lottery-hint">到期：{{ formatTime(row.expiresAt) }}</p></template
            ></ElTableColumn
          >
          <ElTableColumn label="中奖结果" min-width="230"
            ><template #default="{ row }"
              ><div v-if="row.result" class="lottery-result"
                ><img
                  v-if="row.result.image"
                  :src="row.result.image.url"
                  :alt="row.result.title"
                /><div
                  >{{ row.result.title
                  }}<p class="lottery-hint">{{ formatTime(row.result.drawnAt) }}</p></div
                ></div
              ><span v-else>尚未开奖</span></template
            ></ElTableColumn
          >
          <ElTableColumn v-if="can('orders.view')" label="操作" width="110" fixed="right"
            ><template #default="{ row }"
              ><ElButton type="primary" link :disabled="detailBusy" @click="openOrder(row.orderId)"
                >订单详情</ElButton
              ></template
            ></ElTableColumn
          >
        </ArtTable>
        <ElPagination
          class="mt-4"
          :current-page="current"
          :page-size="size"
          :total="total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="changeCurrent"
          @size-change="size = $event"
        />
      </template>
    </ElCard>
    <BusinessDetailPanel
      v-model="detailOpen"
      page-key="lottery-order-detail"
      :record-id="selectedOrderId"
      title="转盘订单详情"
      :before-close="closeDetail"
      :show-close="!detailBusy"
      :close-on-press-escape="!detailBusy"
      @restore="restoreOrder"
      @closed="orderDetailClosed"
    >
      <OrderDetail
        v-if="selectedOrderId && allowed && can('orders.view')"
        :order-id="selectedOrderId"
        @busy="detailBusy = $event"
      />
    </BusinessDetailPanel>
  </div>
</template>

<style scoped lang="scss">
  .lottery-admin {
    min-width: 0;
  }

  .lottery-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin: 4px 0 20px;
  }

  .lottery-toolbar :deep(.el-select) {
    width: 200px;
  }

  .lottery-total {
    margin-right: auto;
    font-size: 14px;
  }

  .lottery-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .lottery-prize-image {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .lottery-prize-image img,
  .lottery-image-empty {
    width: 72px;
    height: 72px;
    object-fit: contain;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 8px;
  }

  .lottery-image-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .lottery-result {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .lottery-result img {
    width: 48px;
    height: 48px;
    object-fit: contain;
    border-radius: 6px;
  }

  .lottery-invalid,
  .is-invalid {
    color: var(--el-color-danger);
  }

  .lottery-invalid {
    margin-top: 6px;
    font-size: 12px;
  }
</style>
