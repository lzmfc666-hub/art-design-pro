<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
  import { EditPen, Upload, Check, Close, Position, RefreshLeft } from '@element-plus/icons-vue'
  import { useStudio, money, formatTime, statusLabels } from '../useStudio'
  import type { Attachment, AuditLog, OrderStatus } from '@/types/studio'

  const props = defineProps<{ orderId: string }>()
  const { data, can, mutate, upload } = useStudio()
  const order = computed(() => data.value?.orders.find((item) => item.id === props.orderId))
  const activeTab = ref('information')
  const dialog = ref<
    | 'payment'
    | 'dispatch'
    | 'release'
    | 'cancel'
    | 'refund'
    | 'edit'
    | 'adjust'
    | 'cancel-settle'
    | 'review-return'
    | null
  >(null)
  const saving = ref(false)
  const uploading = ref(false)
  const remarkEditing = ref(false)
  const remarkDraft = ref('')
  const fields = reactive({
    amount: null as number | null,
    reward: null as number | null,
    reason: '',
    paidAt: '',
    receipt: null as Attachment | null,
    dispatchMode: 'pool' as 'pool' | 'direct',
    assignedTo: '',
    teammateId: '',
    roomCode: '',
    gameId: '',
    map: '',
    channel: '',
    remark: ''
  })
  const platform = computed(() =>
    data.value?.platforms.find((item) => item.id === order.value?.platformId)
  )
  const customer = computed(() =>
    data.value?.customers.find((item) => item.id === order.value?.customerId)
  )
  const shop = computed(() => data.value?.shops.find((item) => item.id === order.value?.shopId))
  const isHall = computed(
    () => platform.value?.id === 'hall' || platform.value?.name === '游戏大厅'
  )
  const isXianyu = computed(
    () => platform.value?.id === 'xianyu' || platform.value?.name === '闲鱼'
  )
  const players = computed(
    () =>
      data.value?.users.filter((item) => item.role === 'player' && item.status === 'active') ?? []
  )
  const refunds = computed(
    () => data.value?.refunds.filter((item) => item.orderId === props.orderId) ?? []
  )
  const refunded = computed(() =>
    refunds.value
      .filter((item) => item.status === 'paid')
      .reduce((sum, item) => sum + item.amount, 0)
  )
  const refundOccupied = computed(() =>
    refunds.value
      .filter((item) => item.status !== 'rejected')
      .reduce((sum, item) => sum + item.amount, 0)
  )
  const refundAvailable = computed(() =>
    Math.max(0, (order.value?.receivedAmount ?? 0) - refundOccupied.value)
  )
  const logs = computed(() =>
    (data.value?.logs ?? [])
      .filter(
        (item) =>
          item.entityId === props.orderId ||
          refunds.value.some((refund) => refund.id === item.entityId)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const canEdit = computed(() => can('orders.edit'))
  const canReview = computed(() => can('finance.review'))
  const canCancel = computed(
    () =>
      !!order.value &&
      ((canEdit.value && ['pending', 'active', 'review'].includes(order.value.status)) ||
        (canReview.value && order.value.status === 'completed'))
  )
  const canRefund = computed(
    () => !isHall.value && refundAvailable.value > 0 && (canEdit.value || can('finance.refunds'))
  )
  const dialogTitle = computed(
    () =>
      ({
        payment: '确认客户收款',
        dispatch: '重新派单',
        release: '解除当前接单',
        cancel: '取消订单',
        refund: can('finance.refunds') ? '登记实际退款' : '发起退款申请',
        edit: '编辑实际订单',
        adjust: '财务金额更正',
        'cancel-settle': '确认取消订单打手报酬',
        'review-return': '退回完成材料'
      })[dialog.value ?? 'payment']
  )
  const staffName = (id: string | null | undefined) =>
    data.value?.users.find((item) => item.id === id)?.name ?? '—'
  const toCents = (amount: number | null) => Math.round(Number(amount) * 100)
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : '操作失败，请稍后重试'
  const tagType = (value: OrderStatus) =>
    ({
      pending: 'info',
      active: 'primary',
      review: 'warning',
      completed: 'success',
      canceled: 'danger'
    })[value] as 'info' | 'primary' | 'warning' | 'success' | 'danger'

  watch(
    () => props.orderId,
    () => {
      activeTab.value = 'information'
      remarkEditing.value = false
      dialog.value = null
    }
  )

  function openAction(action: NonNullable<typeof dialog.value>) {
    if (!order.value || saving.value) return
    Object.assign(fields, {
      amount: action === 'refund' ? refundAvailable.value / 100 : order.value.amount / 100,
      reward: order.value.reward / 100,
      reason: '',
      paidAt: new Date().toISOString(),
      receipt: null,
      dispatchMode: order.value.dispatchMode,
      assignedTo: order.value.assignedTo ?? '',
      teammateId: order.value.teammateId ?? '',
      roomCode: order.value.roomCode,
      gameId: order.value.gameId,
      map: order.value.map,
      channel: order.value.channel,
      remark: order.value.remark
    })
    dialog.value = action
  }

  function startRemarkEdit() {
    if (!order.value || saving.value) return
    remarkDraft.value = order.value.remark
    remarkEditing.value = true
  }

  function updateDialogVisibility(visible: boolean) {
    if (!visible && !saving.value && !uploading.value) dialog.value = null
  }

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
      fields.receipt = await upload(file.raw)
      ElMessage.success('付款凭证已上传')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      uploading.value = false
    }
  }

  async function submitAction() {
    if (!order.value || !dialog.value || saving.value || uploading.value) return
    const action = dialog.value
    const requiresReason = [
      'release',
      'cancel',
      'refund',
      'edit',
      'adjust',
      'cancel-settle',
      'review-return'
    ].includes(action)
    if (requiresReason && !fields.reason.trim()) {
      ElMessage.warning('请填写本次操作的原因或处理说明')
      return
    }
    if (action === 'payment') {
      if (fields.amount === null || fields.amount <= 0 || !Number.isFinite(fields.amount)) {
        ElMessage.warning('请填写有效收款金额')
        return
      }
      if (toCents(fields.amount) !== order.value.amount) {
        ElMessage.warning('请确认足额收款，实收金额须与订单金额一致')
        return
      }
      if (!fields.paidAt) {
        ElMessage.warning('请选择客户实际付款时间')
        return
      }
      if (!isXianyu.value && !fields.receipt) {
        ElMessage.warning('请上传客户付款凭证')
        return
      }
    }
    if (action === 'dispatch' && fields.dispatchMode === 'direct' && !fields.assignedTo) {
      ElMessage.warning('请选择指定打手')
      return
    }
    if (
      action === 'refund' &&
      (fields.amount === null ||
        fields.amount <= 0 ||
        toCents(fields.amount) > refundAvailable.value)
    ) {
      ElMessage.warning('退款金额须大于零，且不能超过剩余可退金额')
      return
    }
    if (
      ['edit', 'adjust', 'cancel-settle'].includes(action) &&
      (fields.reward === null || fields.reward < 0 || !Number.isFinite(fields.reward))
    ) {
      ElMessage.warning('请填写有效的打手总报酬')
      return
    }
    if (
      (action === 'adjust' || action === 'edit') &&
      (fields.amount === null || fields.amount <= 0 || !Number.isFinite(fields.amount))
    ) {
      ElMessage.warning('请填写有效的订单金额')
      return
    }
    if (action === 'edit' && !fields.roomCode.trim() && !fields.gameId.trim()) {
      ElMessage.warning('房间码与客户游戏 ID 至少填写一项')
      return
    }
    saving.value = true
    try {
      if (action === 'refund') {
        await mutate('/refunds', {
          orderId: order.value.id,
          amount: toCents(fields.amount),
          reason: fields.reason.trim()
        })
      } else {
        const body: Record<string, unknown> = { action, reason: fields.reason.trim() }
        if (action === 'payment')
          Object.assign(body, {
            action: 'confirm-payment',
            receivedAmount: toCents(fields.amount),
            paidAt: fields.paidAt,
            receipt: isXianyu.value ? null : fields.receipt
          })
        if (action === 'dispatch')
          Object.assign(body, {
            dispatchMode: fields.dispatchMode,
            assignedTo: fields.dispatchMode === 'direct' ? fields.assignedTo : null
          })
        if (action === 'adjust')
          Object.assign(body, { amount: toCents(fields.amount), reward: toCents(fields.reward) })
        if (action === 'edit')
          Object.assign(body, {
            amount: toCents(fields.amount),
            reward: toCents(fields.reward),
            roomCode: fields.roomCode.trim(),
            gameId: fields.gameId.trim(),
            map: fields.map,
            channel: fields.channel,
            remark: fields.remark
          })
        if (action === 'cancel-settle')
          Object.assign(body, {
            reward: toCents(fields.reward),
            teammateId: fields.teammateId || null
          })
        await mutate(`/orders/${encodeURIComponent(order.value.id)}/action`, body)
      }
      dialog.value = null
      ElMessage.success(
        action === 'refund' && !can('finance.refunds')
          ? '退款申请已提交财务审核'
          : '处理已保存，并记录操作日志'
      )
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      saving.value = false
    }
  }

  async function saveRemark() {
    if (!order.value || saving.value) return
    saving.value = true
    try {
      await mutate(`/orders/${encodeURIComponent(order.value.id)}/action`, {
        action: 'remark',
        remark: remarkDraft.value
      })
      remarkEditing.value = false
      ElMessage.success('打手可见备注已保存')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      saving.value = false
    }
  }

  async function passReview() {
    if (!order.value || saving.value) return
    saving.value = true
    try {
      await ElMessageBox.confirm(
        '请核对完成截图和负责人 / 队友信息。验收通过后，本单报酬将计入对应打手的可提现金额。',
        '确认财务验收通过',
        { confirmButtonText: '核对无误，通过验收', cancelButtonText: '继续核对', type: 'warning' }
      )
    } catch {
      saving.value = false
      return
    }
    try {
      await mutate(`/orders/${encodeURIComponent(order.value.id)}/action`, {
        action: 'review-pass'
      })
      ElMessage.success('财务验收通过，订单已完成')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      saving.value = false
    }
  }

  const actionLabels: Record<string, string> = {
    create: '创建订单',
    'order.create': '创建订单',
    'confirm-payment': '确认收款',
    dispatch: '调整派单',
    release: '解除接单',
    remark: '修改备注',
    cancel: '取消订单',
    'review-pass': '验收通过',
    'review-return': '退回完成材料',
    adjust: '更正订单金额 / 报酬',
    'cancel-settle': '确认取消补偿',
    claim: '打手接单',
    submit: '提交完成材料',
    refund: '退款处理',
    edit: '编辑实际订单'
  }
  function logAction(action: string) {
    if (action.startsWith('订单：')) {
      const [code, ...reason] = action.slice(3).split(' · ')
      return `${actionLabels[code] ?? code}${reason.length ? ' · ' + reason.join(' · ') : ''}`
    }
    return actionLabels[action] ?? action
  }
  const fieldLabels: Record<string, string> = {
    amount: '订单金额',
    reward: '打手总报酬',
    receivedAmount: '收款金额',
    remark: '打手可见备注',
    status: '订单状态',
    assignedTo: '指定打手',
    leaderId: '负责人',
    teammateId: '队友',
    reason: '原因',
    cancelReason: '取消原因',
    dispatchMode: '派单方式',
    paidAt: '客户付款时间',
    roomCode: '房间码',
    gameId: '客户游戏 ID',
    map: '地图',
    channel: '成交 / 沟通渠道'
  }
  function logValue(key: string, value: unknown) {
    if (value === null || value === undefined || value === '') return '未填写'
    if (['amount', 'reward', 'receivedAmount'].includes(key)) return money(Number(value))
    if (key === 'status') return statusLabels[value as OrderStatus] ?? String(value)
    if (['assignedTo', 'leaderId', 'teammateId'].includes(key)) return staffName(String(value))
    if (key === 'dispatchMode') return value === 'pool' ? '抢单池' : '直接指定'
    if (key === 'paidAt') return formatTime(String(value))
    return String(value)
  }
  function logChanges(log: AuditLog) {
    const before =
      log.before && typeof log.before === 'object' ? (log.before as Record<string, unknown>) : {}
    const after =
      log.after && typeof log.after === 'object' ? (log.after as Record<string, unknown>) : {}
    return Object.keys(fieldLabels)
      .filter((key) => key in after && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map(
        (key) =>
          `${fieldLabels[key]}：${key in before ? logValue(key, before[key]) + ' → ' : ''}${logValue(key, after[key])}`
      )
  }
</script>

<template>
  <div v-if="order" class="order-detail">
    <div class="detail-title"
      ><div
        ><div class="detail-order-no">{{ order.orderNo }}</div
        ><h2>{{ order.title }}</h2
        ><p class="muted"
          >由 {{ staffName(order.creatorId) }} 创建于 {{ formatTime(order.createdAt) }}</p
        ></div
      ><el-tag :type="tagType(order.status)" size="large" round>{{
        statusLabels[order.status]
      }}</el-tag></div
    >
    <div class="detail-metrics"
      ><div
        ><span>订单金额</span><strong>{{ money(order.amount) }}</strong></div
      ><div
        ><span>累计收款</span><strong>{{ money(order.receivedAmount) }}</strong></div
      ><div
        ><span>实际退款</span><strong class="refund-amount">{{ money(refunded) }}</strong></div
      ><div
        ><span>剩余净收入</span
        ><strong class="net-amount">{{ money(order.receivedAmount - refunded) }}</strong></div
      ></div
    >

    <el-alert
      v-if="order.status === 'canceled'"
      class="detail-alert"
      type="error"
      :closable="false"
      show-icon
      :title="`订单已取消：${order.cancelReason || '已记录取消操作'}`"
      :description="
        order.compensationPending
          ? '本单有履约历史，最终打手报酬待财务确认，确认前保留约定成本。'
          : order.compensationSettled && order.assignments.length > 0
            ? '财务已确认本单最终报酬及补偿结算。'
            : '订单终止履约，实际退款另行记录。'
      "
    />
    <el-alert
      v-if="!order.receivedAmount && order.status !== 'canceled'"
      class="detail-alert"
      type="warning"
      :closable="false"
      show-icon
      title="客户收款尚未确认"
      description="落地付订单请及时补录客户实际付款时间与凭证，收款后才可完成财务验收。"
    />

    <div class="detail-actions">
      <el-button
        v-if="canEdit && ['pending', 'active', 'review'].includes(order.status)"
        :icon="EditPen"
        :disabled="saving"
        @click="openAction('edit')"
        >编辑订单</el-button
      >
      <el-button
        v-if="canEdit && order.status !== 'canceled' && !order.receivedAmount"
        type="primary"
        plain
        :disabled="saving"
        @click="openAction('payment')"
        >确认收款</el-button
      >
      <el-button
        v-if="canEdit && order.status === 'pending'"
        :icon="Position"
        :disabled="saving"
        @click="openAction('dispatch')"
        >调整派单</el-button
      >
      <el-button
        v-if="canEdit && order.status === 'active'"
        :icon="RefreshLeft"
        :disabled="saving"
        @click="openAction('release')"
        >解除接单</el-button
      >
      <el-button
        v-if="canReview && order.status === 'review'"
        type="success"
        :icon="Check"
        :loading="saving"
        @click="passReview"
        >验收通过</el-button
      >
      <el-button
        v-if="canReview && order.status === 'review'"
        type="warning"
        plain
        :disabled="saving"
        @click="openAction('review-return')"
        >退回材料</el-button
      >
      <el-button v-if="canRefund" :disabled="saving" @click="openAction('refund')">{{
        can('finance.refunds') ? '登记退款' : '申请退款'
      }}</el-button>
      <el-button
        v-if="canReview && ['completed', 'canceled'].includes(order.status)"
        :disabled="saving"
        @click="openAction('adjust')"
        >金额 / 报酬更正</el-button
      >
      <el-button
        v-if="canReview && order.status === 'canceled' && order.compensationPending"
        type="warning"
        :disabled="saving"
        @click="openAction('cancel-settle')"
        >确认最终报酬</el-button
      >
      <el-button
        v-if="canCancel"
        type="danger"
        plain
        :icon="Close"
        :disabled="saving"
        @click="openAction('cancel')"
        >取消订单</el-button
      >
    </div>

    <el-tabs v-model="activeTab" class="detail-tabs">
      <el-tab-pane label="订单信息" name="information">
        <el-descriptions :column="2" border class="detail-descriptions">
          <el-descriptions-item label="客户">{{ customer?.name ?? '—' }}</el-descriptions-item
          ><el-descriptions-item label="联系方式">{{
            customer?.contact || '—'
          }}</el-descriptions-item>
          <el-descriptions-item label="订单来源">{{ platform?.name ?? '—' }}</el-descriptions-item
          ><el-descriptions-item label="闲鱼店铺">{{ shop?.name || '—' }}</el-descriptions-item>
          <el-descriptions-item label="沟通渠道">{{ order.channel || '—' }}</el-descriptions-item
          ><el-descriptions-item label="平台订单号"
            ><span class="long-value">{{
              order.externalOrderNo || '—'
            }}</span></el-descriptions-item
          >
          <el-descriptions-item label="房间码">{{ order.roomCode || '—' }}</el-descriptions-item
          ><el-descriptions-item label="客户游戏 ID">{{
            order.gameId || '—'
          }}</el-descriptions-item>
          <el-descriptions-item label="地图">{{ order.map || '不限' }}</el-descriptions-item
          ><el-descriptions-item label="派单方式">{{
            order.dispatchMode === 'pool' ? '公共抢单池' : '直接指定'
          }}</el-descriptions-item>
          <el-descriptions-item label="接单负责人"
            >{{ staffName(order.leaderId)
            }}<span v-if="!order.leaderId && order.assignedTo" class="muted"
              >（指定 {{ staffName(order.assignedTo) }}，待接单）</span
            ></el-descriptions-item
          ><el-descriptions-item label="队友">{{
            order.teammateId ? staffName(order.teammateId) : '独自完成 / 尚未上报'
          }}</el-descriptions-item>
          <el-descriptions-item label="客户付款时间">{{
            order.paidAt ? formatTime(order.paidAt) : '待确认'
          }}</el-descriptions-item
          ><el-descriptions-item label="客服确认时间">{{
            order.receivedAt ? formatTime(order.receivedAt) : '待确认'
          }}</el-descriptions-item>
          <el-descriptions-item label="整单打手报酬"
            >{{ money(order.reward)
            }}<el-tag
              v-if="order.compensationPending"
              type="warning"
              size="small"
              class="inline-tag"
              >待财务确认</el-tag
            ></el-descriptions-item
          ><el-descriptions-item label="完成时间">{{
            order.completedAt ? formatTime(order.completedAt) : '—'
          }}</el-descriptions-item>
          <el-descriptions-item label="付款凭证" :span="2"
            ><a
              v-if="order.receipt"
              :href="order.receipt.url"
              target="_blank"
              rel="noopener noreferrer"
              class="attachment-link"
              >{{ order.receipt.name }}</a
            ><span v-else class="muted">{{
              isXianyu ? '闲鱼免传付款截图，保留平台订单号核对' : '尚未上传'
            }}</span></el-descriptions-item
          >
        </el-descriptions>

        <section class="detail-section"
          ><div class="detail-section-heading"
            ><h3>打手可见备注</h3
            ><el-button
              v-if="canEdit && !remarkEditing"
              :icon="EditPen"
              link
              type="primary"
              @click="startRemarkEdit"
              >编辑备注</el-button
            ></div
          ><template v-if="remarkEditing"
            ><el-input
              v-model="remarkDraft"
              type="textarea"
              :rows="4"
              maxlength="2000"
              show-word-limit
            /><div class="remark-actions"
              ><el-button :disabled="saving" @click="remarkEditing = false">取消</el-button
              ><el-button type="primary" :loading="saving" @click="saveRemark"
                >保存备注</el-button
              ></div
            ></template
          ><p v-else class="remark-content" :class="{ muted: !order.remark }">{{
            order.remark || '暂无备注'
          }}</p
          ><p class="section-help"
            >打手在订单对其开放时可见；已完成订单也可修改，修改过程保留日志。</p
          ></section
        >

        <section class="detail-section"
          ><div class="detail-section-heading"
            ><h3>退款记录</h3><span class="muted">取消订单与实际退款分别记录</span></div
          ><div v-if="!refunds.length" class="detail-empty">{{
            isHall ? '游戏大厅不提供退款流程' : '暂无退款记录'
          }}</div
          ><div v-for="item in refunds" :key="item.id" class="refund-row"
            ><div
              ><strong>{{ money(item.amount) }}</strong
              ><el-tag
                :type="
                  item.status === 'paid'
                    ? 'success'
                    : item.status === 'pending'
                      ? 'warning'
                      : 'info'
                "
                size="small"
                >{{
                  item.status === 'paid'
                    ? '已退款'
                    : item.status === 'pending'
                      ? '待财务审核'
                      : '已驳回'
                }}</el-tag
              ><p>{{ item.reason }}</p
              ><p v-if="item.manualRewardReview && !item.manualResolution" class="manual-note"
                >打手已提现，报酬差额待财务人工确认并登记。</p
              ><p v-if="item.manualResolution" class="manual-note"
                >人工处理：{{ item.manualResolution }}</p
              ></div
            ><div class="refund-meta"
              ><span>{{ staffName(item.requestedBy) }}</span
              ><span>{{ formatTime(item.createdAt) }}</span
              ><span v-if="item.processedAt">处理于 {{ formatTime(item.processedAt) }}</span></div
            ></div
          ></section
        >

        <el-collapse class="snapshot-collapse"
          ><el-collapse-item title="查看下单时的项目快照" name="snapshot"
            ><el-descriptions :column="2" border
              ><el-descriptions-item label="项目名称">{{
                order.snapshot.name
              }}</el-descriptions-item
              ><el-descriptions-item label="游戏">{{ order.snapshot.game }}</el-descriptions-item
              ><el-descriptions-item label="模板客户价">{{
                money(order.snapshot.amount)
              }}</el-descriptions-item
              ><el-descriptions-item label="模板打手价">{{
                money(order.snapshot.reward)
              }}</el-descriptions-item
              ><el-descriptions-item label="规格 / 目标" :span="2">{{
                order.snapshot.description || '—'
              }}</el-descriptions-item
              ><el-descriptions-item label="模板默认备注" :span="2">{{
                order.snapshot.remark || '—'
              }}</el-descriptions-item></el-descriptions
            ><p class="section-help">此处为历史快照，模板后续变更不会覆盖。</p></el-collapse-item
          ></el-collapse
        >
      </el-tab-pane>

      <el-tab-pane :label="`完成材料 (${order.submissions.length})`" name="submissions">
        <div v-if="!order.submissions.length" class="detail-empty materials-empty"
          >负责人尚未通过打手端提交完成材料。</div
        >
        <section
          v-for="(submission, index) in [...order.submissions].reverse()"
          :key="submission.id"
          class="submission-card"
          ><div class="submission-heading"
            ><div
              ><strong>第 {{ order.submissions.length - index }} 次提交</strong
              ><span class="muted">{{ formatTime(submission.submittedAt) }}</span></div
            ><el-tag
              :type="
                submission.review === 'passed' || submission.review === 'pass'
                  ? 'success'
                  : submission.review === 'returned' || submission.review === 'return'
                    ? 'warning'
                    : 'info'
              "
              >{{
                submission.review === 'passed' || submission.review === 'pass'
                  ? '已通过'
                  : submission.review === 'returned' || submission.review === 'return'
                    ? '已退回'
                    : '已提交'
              }}</el-tag
            ></div
          ><p class="submission-people"
            >负责人 {{ staffName(submission.leaderId) }}<span>·</span
            >{{
              submission.teammateId ? '队友 ' + staffName(submission.teammateId) : '独自完成'
            }}</p
          ><div class="screenshot-grid"
            ><el-image
              v-for="(file, imageIndex) in submission.screenshots"
              :key="file.id"
              :src="file.url"
              :preview-src-list="submission.screenshots.map((item) => item.url)"
              :initial-index="imageIndex"
              fit="cover"
              preview-teleported
              ><template #error
                ><a :href="file.url" target="_blank" rel="noopener noreferrer"
                  >查看 {{ file.name }}</a
                ></template
              ></el-image
            ></div
          ><div v-if="submission.reason" class="return-reason"
            ><strong>退回原因</strong><p>{{ submission.reason }}</p></div
          ><p v-if="submission.reviewedAt" class="section-help"
            >{{ staffName(submission.reviewerId) }} · {{ formatTime(submission.reviewedAt) }}</p
          ></section
        >
      </el-tab-pane>

      <el-tab-pane label="接单历史" name="assignments"
        ><div v-if="!order.assignments.length" class="detail-empty">尚无打手接单记录。</div
        ><el-timeline v-else class="assignment-timeline"
          ><el-timeline-item
            v-for="(assignment, index) in [...order.assignments].reverse()"
            :key="`${assignment.leaderId}-${assignment.acceptedAt}`"
            :timestamp="formatTime(assignment.acceptedAt)"
            placement="top"
            :type="assignment.releasedAt ? 'info' : 'primary'"
            ><div class="assignment-card"
              ><strong>{{ staffName(assignment.leaderId) }} 接单</strong
              ><el-tag v-if="!assignment.releasedAt && index === 0" type="success" size="small">{{
                order.status === 'canceled' ? '取消前负责人' : '当前负责人'
              }}</el-tag
              ><p v-if="assignment.releasedAt" class="muted"
                >{{ formatTime(assignment.releasedAt) }} 解除接单</p
              ><p v-if="assignment.reason">原因：{{ assignment.reason }}</p></div
            ></el-timeline-item
          ></el-timeline
        ></el-tab-pane
      >

      <el-tab-pane label="操作日志" name="logs"
        ><div v-if="!can('logs.view')" class="detail-empty">当前账号没有查看操作日志的权限。</div
        ><div v-else-if="!logs.length" class="detail-empty">暂无操作日志。</div
        ><el-timeline v-else class="order-log-timeline"
          ><el-timeline-item
            v-for="log in logs"
            :key="log.id"
            :timestamp="formatTime(log.createdAt)"
            placement="top"
            ><div class="log-heading"
              ><strong>{{ logAction(log.action) }}</strong
              ><span>{{ log.actorName }}</span></div
            ><p v-for="(change, index) in logChanges(log)" :key="index" class="log-change">{{
              change
            }}</p></el-timeline-item
          ></el-timeline
        ></el-tab-pane
      >
    </el-tabs>

    <el-dialog
      :model-value="!!dialog"
      :title="dialogTitle"
      width="min(540px, 94vw)"
      append-to-body
      :close-on-click-modal="!saving && !uploading"
      :close-on-press-escape="!saving && !uploading"
      :show-close="!saving && !uploading"
      @update:model-value="updateDialogVisibility"
    >
      <el-form label-position="top" @submit.prevent="submitAction">
        <template v-if="dialog === 'payment'"
          ><el-form-item label="客户实际收款金额（元）" required
            ><el-input-number
              v-model="fields.amount"
              :min="0.01"
              :precision="2"
              :step="0.01"
              :controls="false" /></el-form-item
          ><el-form-item label="客户实际付款时间" required
            ><el-date-picker
              v-model="fields.paidAt"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm:ssZ"
              format="YYYY-MM-DD HH:mm" /></el-form-item
          ><el-form-item v-if="!isXianyu" label="付款凭证" required
            ><div class="dialog-upload"
              ><el-upload
                :auto-upload="false"
                :show-file-list="false"
                :on-change="uploadReceipt"
                :disabled="uploading || saving"
                accept="image/png,image/jpeg,image/webp"
                ><el-button :icon="Upload" :loading="uploading">{{
                  fields.receipt ? '更换凭证' : '上传付款凭证'
                }}</el-button></el-upload
              ><a
                v-if="fields.receipt"
                :href="fields.receipt.url"
                target="_blank"
                rel="noopener noreferrer"
                >{{ fields.receipt.name }}</a
              ><span v-else class="muted">图片最大 8 MB</span></div
            ></el-form-item
          ><el-alert
            v-else
            title="闲鱼免传付款截图，请核对平台订单号及实际付款时间。"
            :closable="false"
            type="info"
        /></template>
        <template v-if="dialog === 'dispatch'"
          ><el-form-item label="派单方式"
            ><el-radio-group v-model="fields.dispatchMode"
              ><el-radio-button value="pool">公开抢单池</el-radio-button
              ><el-radio-button value="direct">指定打手</el-radio-button></el-radio-group
            ></el-form-item
          ><el-form-item v-if="fields.dispatchMode === 'direct'" label="指定打手" required
            ><el-select v-model="fields.assignedTo" filterable placeholder="请选择打手"
              ><el-option
                v-for="item in players"
                :key="item.id"
                :label="`${item.name} · 执行中 ${item.activeOrders ?? 0}/${item.maxActiveOrders}`"
                :value="item.id" /></el-select></el-form-item
          ><el-alert
            title="派单后等待打手本人接单。发布到公共抢单池后，按配置的等级延迟开放。"
            type="info"
            :closable="false"
        /></template>
        <template v-if="dialog === 'refund'"
          ><el-alert
            :title="`剩余可退 ${money(refundAvailable)}（已扣除已退款及待审核申请）`"
            type="info"
            :closable="false"
            class="dialog-alert"
          /><el-form-item label="本次退款金额（元）" required
            ><el-input-number
              v-model="fields.amount"
              :min="0.01"
              :max="refundAvailable / 100"
              :precision="2"
              :step="0.01"
              :controls="false" /></el-form-item
          ><p class="section-help">{{
            can('finance.refunds')
              ? '提交表示财务已完成实际退款。收入统计回到原付款日更新。'
              : '提交申请后由财务审核处理，实际退款另行记录。'
          }}</p></template
        >
        <template v-if="dialog === 'edit'">
          <el-alert
            title="修改保存到当前实际订单，原创建人及模板快照保持不变。已收款订单修改金额时，收款登记金额同步更正；实际退款请另走退款流程。"
            type="info"
            :closable="false"
            class="dialog-alert"
          />
          <div class="edit-form-grid">
            <el-form-item label="房间码"
              ><el-input
                v-model="fields.roomCode"
                maxlength="100"
                placeholder="房间码与游戏 ID 至少填写一项"
            /></el-form-item>
            <el-form-item label="客户游戏 ID"
              ><el-input v-model="fields.gameId" maxlength="100"
            /></el-form-item>
            <el-form-item label="地图"
              ><el-select v-model="fields.map" filterable allow-create default-first-option
                ><el-option
                  v-for="item in ['不限', '零号大坝', '长弓溪谷', '巴克什', '航天基地', '潮汐监狱']"
                  :key="item"
                  :label="item"
                  :value="item" /></el-select
            ></el-form-item>
            <el-form-item label="成交 / 沟通渠道"
              ><el-select v-model="fields.channel" filterable allow-create default-first-option
                ><el-option
                  v-for="item in ['微信', '企业微信', '平台内沟通', '游戏内沟通']"
                  :key="item"
                  :label="item"
                  :value="item" /></el-select
            ></el-form-item>
            <el-form-item label="订单金额（元）" required
              ><el-input-number
                v-model="fields.amount"
                :min="0.01"
                :precision="2"
                :step="0.01"
                :controls="false"
            /></el-form-item>
            <el-form-item label="整单打手报酬（元）" required
              ><el-input-number
                v-model="fields.reward"
                :min="0"
                :precision="2"
                :step="0.01"
                :controls="false"
            /></el-form-item>
          </div>
          <el-form-item label="打手可见备注"
            ><el-input
              v-model="fields.remark"
              type="textarea"
              :rows="3"
              maxlength="2000"
              show-word-limit
          /></el-form-item>
        </template>
        <template v-if="dialog === 'adjust'"
          ><el-alert
            title="更正会同步修正订单金额和已有收款登记金额，并更新原付款日的统计；历史修改记录保留。实际退款须另走退款流程。"
            type="warning"
            :closable="false"
            class="dialog-alert" /><el-form-item label="更正后订单金额（元）" required
            ><el-input-number
              v-model="fields.amount"
              :min="0.01"
              :precision="2"
              :step="0.01"
              :controls="false" /></el-form-item
          ><el-form-item label="更正后整单打手报酬（元）" required
            ><el-input-number
              v-model="fields.reward"
              :min="0"
              :precision="2"
              :step="0.01"
              :controls="false" /></el-form-item
        ></template>
        <template v-if="dialog === 'cancel-settle'"
          ><el-alert
            title="确认的是整单最终打手报酬。补偿单保留已取消状态，确认后才形成打手可提现报酬。"
            type="warning"
            :closable="false"
            class="dialog-alert" /><el-form-item label="最终整单打手报酬（元）" required
            ><el-input-number
              v-model="fields.reward"
              :min="0"
              :precision="2"
              :step="0.01"
              :controls="false" /></el-form-item
          ><el-form-item label="结算负责人"
            ><el-input
              :model-value="
                staffName(
                  order.leaderId || order.assignments[order.assignments.length - 1]?.leaderId
                )
              "
              disabled /></el-form-item
          ><el-form-item label="队友（可选，选择后两人平分）"
            ><el-select
              v-model="fields.teammateId"
              clearable
              filterable
              placeholder="不选择则由负责人独自获得"
              ><el-option
                v-for="item in players.filter(
                  (item) =>
                    item.id !==
                    (order?.leaderId || order?.assignments[order.assignments.length - 1]?.leaderId)
                )"
                :key="item.id"
                :label="item.name"
                :value="item.id" /></el-select></el-form-item
        ></template>
        <el-alert
          v-if="dialog === 'cancel'"
          title="取消将终止本单履约，并保留历史记录。实际退款须单独处理；有履约历史的打手报酬由财务确认。"
          type="warning"
          :closable="false"
          class="dialog-alert"
        />
        <el-alert
          v-if="dialog === 'release'"
          title="解除后清空当前负责人并返回待接单。原负责人将不能再提交完成材料，请随后重新派单。"
          type="warning"
          :closable="false"
          class="dialog-alert"
        />
        <el-alert
          v-if="dialog === 'review-return'"
          title="退回后保留原负责人，订单返回接单中，由打手补图或处理后重新提交。"
          type="info"
          :closable="false"
          class="dialog-alert"
        />
        <el-form-item
          v-if="dialog && !['payment', 'dispatch'].includes(dialog)"
          :label="dialog === 'review-return' ? '退回原因 / 需补充的内容' : '原因 / 处理说明'"
          required
          ><el-input
            v-model="fields.reason"
            type="textarea"
            :rows="3"
            maxlength="1000"
            show-word-limit
            placeholder="请填写具体原因，将作为操作记录保存"
        /></el-form-item>
      </el-form>
      <template #footer
        ><el-button :disabled="saving || uploading" @click="dialog = null">返回</el-button
        ><el-button
          :type="dialog === 'cancel' ? 'danger' : 'primary'"
          :loading="saving"
          :disabled="uploading"
          @click="submitAction"
          >{{
            dialog === 'refund' && !can('finance.refunds') ? '提交退款申请' : '确认保存'
          }}</el-button
        ></template
      >
    </el-dialog>
  </div>
  <el-empty v-else description="未找到该订单，或当前账号无权查看" />
</template>

<style scoped>
  .order-detail {
    color: #42465b;
  }

  .detail-title {
    display: flex;
    gap: 18px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }

  .detail-order-no {
    font-size: 12px;
    color: #9a9fb0;
  }

  .detail-title h2 {
    margin: 9px 0;
    font-size: 23px;
    color: #30344b;
  }

  .detail-title p {
    margin: 0;
    font-size: 12px;
  }

  .detail-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    padding: 22px 0;
    margin-bottom: 24px;
    background: #f7f8fc;
    border-radius: 12px;
  }

  .detail-metrics > div {
    display: grid;
    gap: 11px;
    padding: 0 20px;
    border-right: 1px solid #e9ebf2;
  }

  .detail-metrics > div:last-child {
    border: 0;
  }

  .detail-metrics span {
    font-size: 12px;
    color: #979daf;
  }

  .detail-metrics strong {
    font-size: 22px;
    font-weight: 600;
    color: #3c4258;
  }

  .detail-metrics .net-amount {
    color: #6b5df7;
  }

  .detail-metrics .refund-amount {
    color: #b48b5d;
  }

  .detail-alert {
    margin-bottom: 16px;
  }

  .detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 22px;
  }

  .detail-actions .el-button + .el-button {
    margin-left: 0;
  }

  .detail-tabs :deep(.el-tabs__item) {
    font-size: 13px;
  }

  .detail-tabs :deep(.el-tabs__header) {
    margin-bottom: 22px;
  }

  .detail-descriptions {
    margin-bottom: 22px;
  }

  .detail-descriptions :deep(.el-descriptions__label) {
    width: 110px;
    font-weight: 400;
    color: #9399aa;
    white-space: nowrap;
    background: #fafbfe;
  }

  .detail-descriptions :deep(.el-descriptions__content) {
    font-size: 12px;
    color: #51576b;
  }

  .long-value {
    overflow-wrap: anywhere;
  }

  .inline-tag {
    margin-left: 7px;
  }

  .attachment-link,
  .dialog-upload a {
    color: #6b5df7;
    overflow-wrap: anywhere;
  }

  .detail-section {
    padding: 18px;
    margin: 20px 0;
    border: 1px solid #eceef5;
    border-radius: 10px;
  }

  .detail-section-heading {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .detail-section-heading h3 {
    margin: 0;
    font-size: 14px;
  }

  .detail-section-heading > span {
    font-size: 11px;
  }

  .remark-content {
    margin: 0;
    font-size: 13px;
    line-height: 1.9;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .section-help {
    margin: 12px 0 0;
    font-size: 11px;
    line-height: 1.8;
    color: #9ba1b2;
  }

  .remark-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 14px;
  }

  .detail-empty {
    padding: 20px;
    font-size: 12px;
    color: #9ba1b2;
    text-align: center;
  }

  .refund-row {
    display: flex;
    gap: 12px;
    justify-content: space-between;
    padding: 15px 0;
    border-bottom: 1px solid #f1f2f7;
  }

  .refund-row:last-child {
    padding-bottom: 0;
    border: 0;
  }

  .refund-row strong {
    margin-right: 12px;
    font-size: 15px;
  }

  .refund-row p {
    margin: 9px 0 0;
    font-size: 12px;
    line-height: 1.8;
  }

  .refund-meta {
    display: grid;
    align-content: start;
    justify-items: end;
    font-size: 11px;
    line-height: 1.8;
    color: #9ba1b2;
    white-space: nowrap;
  }

  .manual-note {
    color: #bd9148;
  }

  .snapshot-collapse {
    margin-top: 24px;
  }

  .snapshot-collapse :deep(.el-collapse-item__header) {
    font-size: 12px;
    color: #949aab;
  }

  .submission-card {
    padding: 20px;
    margin-bottom: 20px;
    border: 1px solid #eceef5;
    border-radius: 10px;
  }

  .submission-heading {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }

  .submission-heading > div {
    display: flex;
    gap: 14px;
    align-items: center;
  }

  .submission-heading strong {
    font-size: 14px;
  }

  .submission-heading .muted {
    font-size: 11px;
  }

  .submission-people {
    margin: 15px 0;
    font-size: 12px;
    color: #8a91a5;
  }

  .submission-people span {
    margin: 0 8px;
  }

  .screenshot-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .screenshot-grid .el-image {
    width: 100%;
    height: 145px;
    background: #f4f5f9;
    border-radius: 8px;
  }

  .screenshot-grid :deep(.el-image__error a) {
    padding: 10px;
    font-size: 12px;
    color: #6b5df7;
  }

  .return-reason {
    padding: 13px;
    margin-top: 15px;
    font-size: 12px;
    color: #a37e43;
    background: #fff7e9;
    border-radius: 8px;
  }

  .return-reason strong {
    font-size: 11px;
  }

  .return-reason p {
    margin: 7px 0 0;
    line-height: 1.7;
  }

  .materials-empty {
    padding: 70px 20px;
  }

  .assignment-timeline,
  .order-log-timeline {
    padding-left: 4px;
    margin-top: 16px;
  }

  .assignment-card {
    padding: 16px;
    border: 1px solid #eceef5;
    border-radius: 8px;
  }

  .assignment-card strong {
    margin-right: 12px;
    font-size: 13px;
  }

  .assignment-card p {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 1.8;
  }

  .log-heading {
    display: flex;
    gap: 14px;
    align-items: center;
    font-size: 13px;
  }

  .log-heading > span {
    font-size: 12px;
    color: #969dad;
  }

  .log-change {
    margin: 7px 0 0;
    font-size: 12px;
    line-height: 1.8;
    color: #8e95a8;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .dialog-alert {
    margin-bottom: 20px;
  }

  .edit-form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 16px;
  }

  .dialog-upload {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  .dialog-upload > span {
    font-size: 12px;
  }

  .el-dialog .el-input-number,
  .el-dialog .el-select {
    width: 100%;
  }

  :deep(.el-dialog .el-date-editor) {
    width: 100%;
  }

  @media (width <= 620px) {
    .detail-metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px 0;
    }

    .detail-metrics > div:nth-child(2) {
      border-right: 0;
    }

    .detail-metrics strong {
      font-size: 19px;
    }

    .detail-title h2 {
      font-size: 20px;
    }

    .detail-section-heading > span {
      display: none;
    }

    .refund-row {
      flex-direction: column;
    }

    .refund-meta {
      justify-items: start;
    }

    .screenshot-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .submission-heading > div {
      display: grid;
      gap: 6px;
    }

    .detail-descriptions :deep(.el-descriptions__label) {
      width: auto;
      font-size: 11px;
    }

    .detail-descriptions :deep(.el-descriptions__cell) {
      padding: 8px !important;
    }
  }
</style>
