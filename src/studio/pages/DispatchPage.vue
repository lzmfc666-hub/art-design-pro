<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { ElMessage, type UploadFile } from 'element-plus'
  import { Plus, Upload, ArrowRight, Check, Refresh } from '@element-plus/icons-vue'
  import type { Attachment, OrderTemplate } from '@/types/studio'
  import { useStudio, money, formatTime } from '../useStudio'

  const { data, can, mutate, upload, loading, refresh } = useStudio()
  const router = useRouter()
  const saving = ref(false)
  const uploading = ref(false)
  const customerSaving = ref(false)
  const customerDialog = ref(false)
  const customerDraft = reactive({ name: '', contact: '', gameId: '', remark: '' })
  const form = reactive({
    templateId: '',
    customerId: '',
    platformId: '',
    shopId: '',
    externalOrderNo: '',
    channel: '微信',
    roomCode: '',
    gameId: '',
    map: '不限',
    amount: null as number | null,
    reward: null as number | null,
    remark: '',
    dispatchMode: 'pool' as 'pool' | 'direct',
    assignedTo: '',
    payOnArrival: false,
    receivedAmount: null as number | null,
    paidAt: new Date().toISOString(),
    receipt: null as Attachment | null
  })
  const templates = computed(() => data.value?.templates.filter((item) => item.active) ?? [])
  const selectedTemplate = computed(() =>
    templates.value.find((item) => item.id === form.templateId)
  )
  const selectedPlatform = computed(() =>
    data.value?.platforms.find((item) => item.id === form.platformId)
  )
  const isHall = computed(
    () => selectedPlatform.value?.id === 'hall' || selectedPlatform.value?.name === '游戏大厅'
  )
  const isXianyu = computed(
    () => selectedPlatform.value?.id === 'xianyu' || selectedPlatform.value?.name === '闲鱼'
  )
  const shops = computed(
    () => data.value?.shops.filter((item) => item.platformId === form.platformId) ?? []
  )
  const players = computed(
    () =>
      data.value?.users.filter((item) => item.role === 'player' && item.status === 'active') ?? []
  )
  const pendingOrders = computed(() =>
    (data.value?.orders ?? [])
      .filter((item) => item.status === 'pending')
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  )
  const toCents = (amount: number | null) => Math.round(Number(amount) * 100)
  const personName = (id: string | null) =>
    data.value?.users.find((item) => item.id === id)?.name ?? '—'
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : '操作失败，请稍后重试'

  function selectTemplate(template: OrderTemplate) {
    form.templateId = template.id
    form.amount = template.amount === null ? null : template.amount / 100
    form.reward = template.reward === null ? null : template.reward / 100
    form.receivedAmount = form.amount
    form.map = template.map || '不限'
    form.remark = template.remark
  }
  watch(
    () => form.platformId,
    () => {
      form.shopId = isXianyu.value ? (shops.value[0]?.id ?? '') : ''
      form.payOnArrival = false
      form.externalOrderNo = ''
    }
  )
  watch(
    () => form.customerId,
    (id) => {
      const customer = data.value?.customers.find((item) => item.id === id)
      if (customer) form.gameId = customer.gameId
    }
  )
  watch(
    () => form.amount,
    (amount, old) => {
      if (form.receivedAmount === old || form.receivedAmount === null) form.receivedAmount = amount
    }
  )

  async function uploadReceipt(file: UploadFile) {
    if (!file.raw || uploading.value) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.raw.type)) {
      ElMessage.warning('请上传 PNG、JPG 或 WebP 图片')
      return
    }
    if (file.raw.size > 8 * 1024 * 1024) {
      ElMessage.warning('凭证图片不能超过 8 MB')
      return
    }
    uploading.value = true
    try {
      form.receipt = await upload(file.raw)
      ElMessage.success('付款凭证已上传')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      uploading.value = false
    }
  }

  async function saveCustomer() {
    if (customerSaving.value) return
    if (!customerDraft.name.trim()) {
      ElMessage.warning('请填写客户名称')
      return
    }
    customerSaving.value = true
    try {
      const result = (await mutate('/customers', {
        ...customerDraft,
        name: customerDraft.name.trim()
      })) as { id?: string; customer?: { id: string } }
      form.customerId =
        result?.id ??
        result?.customer?.id ??
        data.value?.customers.find(
          (item) =>
            item.name === customerDraft.name.trim() && item.contact === customerDraft.contact
        )?.id ??
        ''
      customerDialog.value = false
      Object.assign(customerDraft, { name: '', contact: '', gameId: '', remark: '' })
      ElMessage.success('客户已建档')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      customerSaving.value = false
    }
  }

  async function submitOrder() {
    if (saving.value || uploading.value) return
    const warning = !form.templateId
      ? '请先选择订单项目'
      : !form.customerId
        ? '请选择或新增客户'
        : !form.platformId
          ? '请选择订单来源'
          : !form.roomCode.trim() && !form.gameId.trim()
            ? '房间码与客户游戏 ID 至少填写一项'
            : form.amount === null || !Number.isFinite(form.amount) || form.amount <= 0
              ? '请填写有效的客户订单金额'
              : form.reward === null || !Number.isFinite(form.reward) || form.reward < 0
                ? '请填写有效的整单打手报酬'
                : isXianyu.value && !form.shopId
                  ? '请选择闲鱼店铺'
                  : isXianyu.value && !form.externalOrderNo.trim()
                    ? '请填写闲鱼平台订单号'
                    : form.dispatchMode === 'direct' && !form.assignedTo
                      ? '请选择要指派的打手'
                      : !form.payOnArrival &&
                          (form.receivedAmount === null || form.receivedAmount <= 0)
                        ? '普通订单须先确认客户已付款'
                        : !form.payOnArrival &&
                            toCents(form.receivedAmount) !== toCents(form.amount)
                          ? '普通订单须足额收款，请核对订单金额与实收金额'
                          : !form.payOnArrival && !form.paidAt
                            ? '请选择客户实际付款时间'
                            : !form.payOnArrival && !isXianyu.value && !form.receipt
                              ? '请上传客户付款凭证'
                              : ''
    if (warning) {
      ElMessage.warning(warning)
      return
    }
    saving.value = true
    try {
      const result = (await mutate('/orders', {
        ...form,
        amount: toCents(form.amount),
        reward: toCents(form.reward),
        receivedAmount: form.payOnArrival ? 0 : toCents(form.receivedAmount),
        paidAt: form.payOnArrival ? null : form.paidAt,
        receipt: form.payOnArrival || isXianyu.value ? null : form.receipt,
        shopId: isXianyu.value ? form.shopId : null,
        assignedTo: form.dispatchMode === 'direct' ? form.assignedTo : null,
        roomCode: form.roomCode.trim(),
        gameId: form.gameId.trim(),
        externalOrderNo: form.externalOrderNo.trim()
      })) as { id?: string; order?: { id: string } }
      ElMessage.success(
        form.dispatchMode === 'direct' ? '订单已发布，等待指定打手接单' : '订单已发布到抢单池'
      )
      const id = result?.id ?? result?.order?.id
      await router.push(id ? { path: '/orders', query: { id } } : '/orders')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      saving.value = false
    }
  }
</script>

<template>
  <div class="dispatch-page">
    <div class="page-heading">
      <div><h2>快捷下单 / 派单大厅</h2><p>选项目、补信息、确认收款，一次完成发单。</p></div>
      <el-button :icon="ArrowRight" @click="router.push('/orders')">查看全部订单</el-button>
    </div>

    <div v-if="!can('orders.create')" class="panel empty-state">当前账号没有创建订单的权限。</div>
    <div v-else class="dispatch-layout">
      <div class="creation-column">
        <section class="panel template-panel">
          <div class="panel-heading"
            ><div
              ><h3><span class="step-index">01</span>选择订单项目</h3
              ><p class="muted">使用预设项目快速创建，历史订单保留下单时的价格快照。</p></div
            ><span class="muted">{{ templates.length }} 个可用项目</span></div
          >
          <div v-if="templates.length" class="template-grid">
            <button
              v-for="item in templates"
              :key="item.id"
              class="template-card"
              :class="{ selected: form.templateId === item.id }"
              @click="selectTemplate(item)"
            >
              <div class="template-top"
                ><span class="game-label">{{ item.game }}</span
                ><el-icon v-if="form.templateId === item.id" class="selected-check"
                  ><Check /></el-icon
              ></div>
              <h4>{{ item.name }}</h4
              ><p>{{ item.description || '自定义游戏服务项目' }}</p>
              <div class="template-prices"
                ><strong>{{ money(item.amount) }}</strong
                ><span>打手 {{ money(item.reward) }}</span></div
              >
            </button>
          </div>
          <el-empty
            v-else
            description="暂无启用的订单模板，请先在游戏管理中配置"
            :image-size="70"
          />
        </section>

        <section class="panel creation-panel">
          <div class="panel-heading"
            ><div
              ><h3><span class="step-index">02</span>填写订单信息</h3
              ><p class="muted">{{
                selectedTemplate ? `当前项目：${selectedTemplate.name}` : '请先选择上方订单项目'
              }}</p></div
            ><el-tag effect="plain" type="info">金额单位：元</el-tag></div
          >
          <el-form label-position="top" @submit.prevent="submitOrder">
            <div class="form-grid">
              <el-form-item label="客户" required
                ><div class="customer-selector"
                  ><el-select
                    v-model="form.customerId"
                    placeholder="选择客户，可搜索姓名 / 联系方式"
                    filterable
                    ><el-option
                      v-for="item in data?.customers"
                      :key="item.id"
                      :label="`${item.name}${item.contact ? ' · ' + item.contact : ''}`"
                      :value="item.id" /></el-select
                  ><el-button :icon="Plus" @click="customerDialog = true">新增</el-button></div
                ></el-form-item
              >
              <el-form-item label="成交 / 沟通渠道"
                ><el-select v-model="form.channel" filterable allow-create default-first-option
                  ><el-option
                    v-for="item in ['微信', '企业微信', '平台内沟通', '游戏内沟通']"
                    :key="item"
                    :label="item"
                    :value="item" /></el-select
              ></el-form-item>
              <el-form-item label="订单来源" required
                ><el-select v-model="form.platformId" placeholder="选择获客来源"
                  ><el-option
                    v-for="item in data?.platforms"
                    :key="item.id"
                    :label="item.name"
                    :value="item.id" /></el-select
              ></el-form-item>
              <el-form-item v-if="isXianyu" label="闲鱼店铺" required
                ><el-select v-model="form.shopId" placeholder="请选择店铺"
                  ><el-option
                    v-for="item in shops"
                    :key="item.id"
                    :label="item.name"
                    :value="item.id" /></el-select
                ><div v-if="!shops.length" class="field-note warning-note"
                  >该来源尚未配置店铺，请联系管理员。</div
                ></el-form-item
              >
              <el-form-item v-if="isXianyu" label="平台订单号" required
                ><el-input
                  v-model="form.externalOrderNo"
                  placeholder="完整填写平台订单号"
                  maxlength="100"
              /></el-form-item>
              <el-form-item label="房间码"
                ><el-input
                  v-model="form.roomCode"
                  placeholder="房间码和游戏 ID 至少填写一项"
                  maxlength="100"
              /></el-form-item>
              <el-form-item label="客户游戏 ID"
                ><el-input v-model="form.gameId" placeholder="输入客户游戏 ID" maxlength="100"
              /></el-form-item>
              <el-form-item label="地图"
                ><el-select v-model="form.map" filterable allow-create default-first-option
                  ><el-option
                    v-for="item in [
                      '不限',
                      '零号大坝',
                      '长弓溪谷',
                      '巴克什',
                      '航天基地',
                      '潮汐监狱'
                    ]"
                    :key="item"
                    :label="item"
                    :value="item" /></el-select
              ></el-form-item>
              <el-form-item label="客户订单金额（元）" required
                ><el-input-number
                  v-model="form.amount"
                  :min="0.01"
                  :precision="2"
                  :step="0.01"
                  :controls="false"
                  placeholder="待配置，请填写"
              /></el-form-item>
              <el-form-item label="整单打手总报酬（元）" required
                ><el-input-number
                  v-model="form.reward"
                  :min="0"
                  :precision="2"
                  :step="0.01"
                  :controls="false"
                  placeholder="待配置，请填写"
                /><div class="field-note">独自完成全拿；有一名队友时两人平分。</div></el-form-item
              >
              <el-form-item class="full-width" label="打手可见备注"
                ><el-input
                  v-model="form.remark"
                  type="textarea"
                  :rows="3"
                  maxlength="2000"
                  show-word-limit
                  placeholder="填写服务要求、注意事项或结单提醒，打手开放查看订单时可见"
              /></el-form-item>
            </div>

            <div class="form-section-title"
              ><span class="step-index">03</span><h3>收款确认</h3
              ><el-switch v-if="isHall" v-model="form.payOnArrival" active-text="大厅落地付"
            /></div>
            <el-alert
              v-if="form.payOnArrival"
              type="warning"
              :closable="false"
              show-icon
              title="落地付可先发布订单，客户付款后须在订单详情确认收款并上传凭证。"
            />
            <div v-else class="form-grid payment-grid">
              <el-form-item label="已收金额（元）" required
                ><el-input-number
                  v-model="form.receivedAmount"
                  :min="0.01"
                  :precision="2"
                  :step="0.01"
                  :controls="false"
                  placeholder="客户实际支付金额"
              /></el-form-item>
              <el-form-item label="客户实际付款时间" required
                ><el-date-picker
                  v-model="form.paidAt"
                  type="datetime"
                  value-format="YYYY-MM-DDTHH:mm:ssZ"
                  format="YYYY-MM-DD HH:mm"
                  placeholder="选择付款时间"
                /><div class="field-note"
                  >收入按这个日期归属，客服确认时间另行留存。</div
                ></el-form-item
              >
              <el-form-item v-if="!isXianyu" class="full-width" label="客户付款凭证" required>
                <div class="receipt-uploader"
                  ><el-upload
                    accept="image/png,image/jpeg,image/webp"
                    :auto-upload="false"
                    :show-file-list="false"
                    :on-change="uploadReceipt"
                    :disabled="uploading || saving"
                    ><el-button :icon="Upload" :loading="uploading">{{
                      form.receipt ? '更换付款凭证' : '上传付款凭证'
                    }}</el-button></el-upload
                  ><a
                    v-if="form.receipt"
                    :href="form.receipt.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="receipt-name"
                    >{{ form.receipt.name }}</a
                  ><span v-else class="muted">PNG / JPG / WebP，最大 8 MB</span></div
                >
              </el-form-item>
              <div v-else class="full-width field-note xianyu-note"
                >闲鱼订单免传付款截图，通过平台订单号核对；结单完成截图仍须由打手提交。</div
              >
            </div>

            <div class="form-section-title"
              ><span class="step-index">04</span><h3>选择派单方式</h3></div
            >
            <div class="dispatch-options"
              ><button
                type="button"
                :class="{ selected: form.dispatchMode === 'pool' }"
                @click="form.dispatchMode = 'pool'"
                ><strong>发布到抢单池</strong><span>按打手等级依次开放，打手自行接单</span></button
              ><button
                type="button"
                :class="{ selected: form.dispatchMode === 'direct' }"
                @click="form.dispatchMode = 'direct'"
                ><strong>直接指定打手</strong><span>指定负责人后，由该打手确认接单</span></button
              ></div
            >
            <el-form-item
              v-if="form.dispatchMode === 'direct'"
              label="指定打手"
              required
              class="assigned-field"
              ><el-select v-model="form.assignedTo" filterable placeholder="请选择启用中的打手"
                ><el-option
                  v-for="item in players"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.name} · 执行中 ${item.activeOrders ?? 0}/${item.maxActiveOrders}`" /></el-select
            ></el-form-item>
            <div class="creation-footer"
              ><div
                ><span class="muted">订单金额</span
                ><strong>{{ form.amount === null ? '待填写' : money(toCents(form.amount)) }}</strong
                ><span class="muted"
                  >· 打手报酬
                  {{ form.reward === null ? '待填写' : money(toCents(form.reward)) }}</span
                ></div
              ><el-button
                type="primary"
                size="large"
                :loading="saving"
                :disabled="uploading"
                native-type="submit"
                >{{
                  form.dispatchMode === 'direct' ? '创建并指派订单' : '创建并发布订单'
                }}</el-button
              ></div
            >
          </el-form>
        </section>
      </div>

      <aside class="queue-column">
        <section class="panel queue-panel"
          ><div class="panel-heading"
            ><h3
              >等待接单 <span class="queue-count">{{ pendingOrders.length }}</span></h3
            ><el-button
              link
              :icon="Refresh"
              :loading="loading"
              aria-label="刷新待接订单"
              @click="refresh()" /></div
          ><div class="queue-tabs"
            ><span
              >抢单池
              {{ pendingOrders.filter((item) => item.dispatchMode === 'pool').length }}</span
            ><span
              >已指定
              {{ pendingOrders.filter((item) => item.dispatchMode === 'direct').length }}</span
            ></div
          ><div v-if="!pendingOrders.length" class="empty-state">暂无等待接单的订单</div
          ><button
            v-for="order in pendingOrders.slice(0, 8)"
            :key="order.id"
            class="queue-item"
            @click="router.push({ path: '/orders', query: { id: order.id } })"
            ><div class="queue-item-top"
              ><strong>{{ order.title }}</strong
              ><span>{{ money(order.reward) }}</span></div
            ><div class="muted queue-order-no">{{ order.orderNo }}</div
            ><div class="queue-bottom"
              ><el-tag
                size="small"
                :type="order.dispatchMode === 'pool' ? 'info' : 'primary'"
                effect="light"
                >{{
                  order.dispatchMode === 'pool'
                    ? '公开抢单池'
                    : '指定 ' + personName(order.assignedTo)
                }}</el-tag
              ><span class="muted">{{ formatTime(order.publishedAt) }}</span></div
            ></button
          ><el-button
            v-if="pendingOrders.length"
            class="all-orders-button"
            text
            @click="router.push('/orders')"
            >查看订单管理 <el-icon><ArrowRight /></el-icon></el-button
        ></section>
        <section class="dispatch-tips"
          ><span class="tips-label">派单提示</span
          ><p>普通订单先确认客户付款。只有游戏大厅支持落地付。</p
          ><p>创建订单会保存项目内容与价格快照，后续模板修改不影响历史记录。</p
          ><p>指派成功后仍需打手接单，完成材料也由打手端提交。</p></section
        >
      </aside>
    </div>

    <el-dialog
      class="studio-dialog"
      v-model="customerDialog"
      title="新增客户"
      width="min(480px, 94vw)"
      :close-on-click-modal="!customerSaving"
      :close-on-press-escape="!customerSaving"
    >
      <el-form label-position="top" @submit.prevent="saveCustomer"
        ><el-form-item label="客户名称" required
          ><el-input
            v-model="customerDraft.name"
            maxlength="100"
            placeholder="客户姓名或昵称" /></el-form-item
        ><el-form-item label="联系方式"
          ><el-input
            v-model="customerDraft.contact"
            maxlength="100"
            placeholder="微信、企微或手机号" /></el-form-item
        ><el-form-item label="游戏 ID"
          ><el-input v-model="customerDraft.gameId" maxlength="100" /></el-form-item
        ><el-form-item label="客户备注"
          ><el-input
            v-model="customerDraft.remark"
            type="textarea"
            :rows="2"
            maxlength="1000" /></el-form-item
      ></el-form>
      <template #footer
        ><el-button :disabled="customerSaving" @click="customerDialog = false">取消</el-button
        ><el-button type="primary" :loading="customerSaving" @click="saveCustomer"
          >保存客户</el-button
        ></template
      >
    </el-dialog>
  </div>
</template>

<style scoped>
  .dispatch-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 330px;
    gap: 24px;
    align-items: start;
  }

  .creation-column {
    display: grid;
    gap: 24px;
    min-width: 0;
  }

  .panel-heading h3 {
    display: flex;
    gap: 10px;
    align-items: center;
    margin: 0;
    font-size: 16px;
  }

  .panel-heading p {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 1.6;
  }

  .panel-heading > span {
    font-size: 12px;
    white-space: nowrap;
  }

  .step-index {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
    font-size: 11px;
    font-weight: 700;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-radius: 8px;
  }

  .template-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 20px;
  }

  .template-card {
    min-width: 0;
    padding: 18px;
    text-align: left;
    cursor: pointer;
    background: var(--el-bg-color);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 10px;
    transition: 0.2s;
  }

  .template-card.selected {
    background: var(--el-fill-color-light);
    border-color: var(--el-color-primary);
    box-shadow: 0 0 0 1px var(--el-color-primary);
  }

  .template-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 18px;
  }

  .game-label {
    font-size: 11px;
    color: var(--el-text-color-regular);
  }

  .selected-check {
    color: var(--el-color-primary);
  }

  .template-card h4 {
    margin: 12px 0 6px;
    font-size: 17px;
    color: var(--el-text-color-primary);
  }

  .template-card p {
    margin: 0 0 18px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-regular);
  }

  .template-prices {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }

  .template-prices strong {
    font-size: 19px;
    color: var(--el-color-primary);
  }

  .template-prices > span {
    font-size: 12px;
    color: var(--el-text-color-regular);
  }

  .creation-panel .el-form {
    margin-top: 23px;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 20px;
  }

  .full-width {
    grid-column: 1 / -1;
  }

  .customer-selector {
    display: flex;
    gap: 8px;
    width: 100%;
  }

  .form-grid .el-select,
  .form-grid .el-input-number,
  .form-grid :deep(.el-date-editor) {
    width: 100%;
  }

  .customer-selector .el-select {
    flex: 1;
    min-width: 0;
  }

  .field-note {
    margin-top: 6px;
    font-size: 11px;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
  }

  .warning-note {
    color: #c89240;
  }

  .form-section-title {
    display: flex;
    gap: 10px;
    align-items: center;
    padding-top: 22px;
    margin: 6px 0 20px;
    border-top: 1px solid var(--el-border-color-lighter);
  }

  .form-section-title h3 {
    margin: 0;
    font-size: 15px;
  }

  .form-section-title .el-switch {
    margin-left: auto;
  }

  .receipt-uploader {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    width: 100%;
  }

  .receipt-uploader > span {
    font-size: 12px;
  }

  .receipt-name {
    font-size: 12px;
    color: var(--el-color-primary);
    overflow-wrap: anywhere;
  }

  .xianyu-note {
    padding: 10px 12px;
    margin: 0 0 22px;
    background: var(--el-fill-color-light);
    border-radius: 7px;
  }

  .dispatch-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 20px;
  }

  .dispatch-options button {
    display: grid;
    gap: 8px;
    padding: 16px;
    text-align: left;
    cursor: pointer;
    background: var(--el-bg-color);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 9px;
  }

  .dispatch-options button.selected {
    background: var(--el-fill-color-light);
    border-color: var(--el-color-primary);
  }

  .dispatch-options strong {
    font-size: 13px;
    color: var(--el-text-color-primary);
  }

  .dispatch-options span {
    font-size: 11px;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }

  .assigned-field .el-select {
    width: 100%;
  }

  .creation-footer {
    display: flex;
    gap: 15px;
    align-items: center;
    justify-content: space-between;
    padding-top: 22px;
    margin-top: 24px;
    border-top: 1px solid var(--el-border-color-lighter);
  }

  .creation-footer > div {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: 12px;
  }

  .creation-footer strong {
    font-size: 21px;
    color: var(--el-color-primary);
  }

  .creation-footer .el-button {
    flex-shrink: 0;
  }

  .payment-grid {
    margin-bottom: 12px;
  }

  .queue-panel {
    padding-bottom: 8px;
  }

  .queue-count {
    padding: 3px 7px;
    font-size: 12px;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-radius: 6px;
  }

  .queue-tabs {
    display: flex;
    gap: 24px;
    padding-bottom: 15px;
    margin: 20px 0 7px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .queue-item {
    display: block;
    width: 100%;
    padding: 18px 0;
    text-align: left;
    cursor: pointer;
    background: none;
    border: 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .queue-item-top {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }

  .queue-item-top strong {
    font-size: 13px;
    color: var(--el-text-color-primary);
  }

  .queue-item-top > span {
    font-size: 14px;
    font-weight: 600;
    color: var(--el-color-primary);
  }

  .queue-order-no {
    margin: 8px 0 12px;
    font-size: 11px;
  }

  .queue-bottom {
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: space-between;
  }

  .queue-bottom > span {
    font-size: 10px;
  }

  .all-orders-button {
    width: 100%;
    margin-top: 8px;
    font-size: 12px;
  }

  .all-orders-button .el-icon {
    margin-left: 8px;
  }

  .dispatch-tips {
    padding: 24px 5px;
  }

  .tips-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-regular);
  }

  .dispatch-tips p {
    margin: 13px 0 0;
    font-size: 12px;
    line-height: 1.9;
    color: var(--el-text-color-secondary);
  }

  @media (width <= 1200px) {
    .dispatch-layout {
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: 18px;
    }

    .creation-footer {
      flex-direction: column;
      align-items: stretch;
    }
  }

  @media (width <= 1000px) {
    .dispatch-layout {
      grid-template-columns: 1fr;
    }

    .queue-column {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
  }

  @media (width <= 600px) {
    .form-grid,
    .template-grid,
    .dispatch-options,
    .queue-column {
      grid-template-columns: 1fr;
    }

    .full-width {
      grid-column: auto;
    }

    .panel-heading > span {
      display: none;
    }

    .creation-footer .el-button {
      width: 100%;
    }
  }
</style>
