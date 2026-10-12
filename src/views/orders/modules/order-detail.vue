<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
  import { useStudio, money, formatTime, statusLabels } from '@/hooks/business/useStudio'
  import type { Attachment, AuditLog, OrderStatus } from '@/types/studio'

  const props = defineProps<{ orderId: string }>()
  const emit = defineEmits<{ busy: [value: boolean] }>()
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
  watch([saving, uploading], ([saving, uploading]) => emit('busy', saving || uploading), {
    immediate: true
  })
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
  <div>
    <template v-if="order">
      <div class="flex items-center justify-between gap-3 mb-5"
        ><div
          ><p class="text-xs text-g-500">{{ order.orderNo }}</p
          ><h2 class="text-xl font-semibold mt-2">{{ order.title }}</h2
          ><p class="text-xs text-g-500 mt-2"
            >{{ staffName(order.creatorId) }} 创建于 {{ formatTime(order.createdAt) }}</p
          ></div
        ><ElTag :type="tagType(order.status)">{{ statusLabels[order.status] }}</ElTag></div
      >
      <ElRow :gutter="12" class="mb-5"
        ><ElCol
          v-for="item in [
            { label: '订单金额', value: order.amount },
            { label: '累计收款', value: order.receivedAmount },
            { label: '累计退款', value: refunded },
            { label: '剩余净收入', value: order.receivedAmount - refunded }
          ]"
          :key="item.label"
          :xs="12"
          :sm="6"
          ><div class="rounded-lg bg-g-200/60 p-3 mb-3"
            ><p class="text-xs text-g-500">{{ item.label }}</p
            ><strong class="block text-lg mt-2">{{ money(item.value) }}</strong></div
          ></ElCol
        ></ElRow
      >
      <ElAlert
        v-if="order.status === 'canceled'"
        :title="'订单已取消：' + (order.cancelReason || '')"
        :description="
          order.compensationPending
            ? '最终打手报酬待财务确认；取消与实际退款分别记录。'
            : '取消记录与报酬结算记录均已保留。'
        "
        type="warning"
        :closable="false"
        show-icon
        class="mb-4"
      />
      <ElAlert
        v-if="!order.receivedAmount && order.status !== 'canceled'"
        title="客户收款尚未确认，请补录实际付款时间及凭证。"
        type="warning"
        :closable="false"
        show-icon
        class="mb-4"
      />
      <ElSpace wrap class="mb-5">
        <ElButton
          v-if="canEdit && ['pending', 'active', 'review'].includes(order.status)"
          :disabled="saving"
          @click="openAction('edit')"
          >编辑订单</ElButton
        >
        <ElButton
          v-if="canEdit && order.status !== 'canceled' && !order.receivedAmount"
          type="primary"
          :disabled="saving"
          @click="openAction('payment')"
          >确认收款</ElButton
        >
        <ElButton
          v-if="canEdit && order.status === 'pending'"
          :disabled="saving"
          @click="openAction('dispatch')"
          >调整派单</ElButton
        >
        <ElButton
          v-if="canEdit && order.status === 'active'"
          :disabled="saving"
          @click="openAction('release')"
          >解除接单</ElButton
        >
        <ElButton
          v-if="canReview && order.status === 'review'"
          type="success"
          :loading="saving"
          @click="passReview"
          >验收通过</ElButton
        >
        <ElButton
          v-if="canReview && order.status === 'review'"
          type="warning"
          :disabled="saving"
          @click="openAction('review-return')"
          >退回材料</ElButton
        >
        <ElButton v-if="canRefund" :disabled="saving" @click="openAction('refund')">{{
          can('finance.refunds') ? '登记退款' : '申请退款'
        }}</ElButton>
        <ElButton
          v-if="canReview && ['completed', 'canceled'].includes(order.status)"
          :disabled="saving"
          @click="openAction('adjust')"
          >金额 / 报酬更正</ElButton
        >
        <ElButton
          v-if="canReview && order.status === 'canceled' && order.compensationPending"
          type="warning"
          :disabled="saving"
          @click="openAction('cancel-settle')"
          >确认最终报酬</ElButton
        >
        <ElButton
          v-if="canCancel"
          type="danger"
          plain
          :disabled="saving"
          @click="openAction('cancel')"
          >取消订单</ElButton
        >
      </ElSpace>
      <ElTabs v-model="activeTab">
        <ElTabPane label="订单信息" name="information">
          <ElDescriptions :column="2" border>
            <ElDescriptionsItem label="客户">{{ customer?.name || '—' }}</ElDescriptionsItem
            ><ElDescriptionsItem label="联系方式">{{
              customer?.contact || '—'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="订单来源">{{ platform?.name || '—' }}</ElDescriptionsItem
            ><ElDescriptionsItem label="店铺">{{ shop?.name || '—' }}</ElDescriptionsItem>
            <ElDescriptionsItem label="沟通渠道">{{ order.channel || '—' }}</ElDescriptionsItem
            ><ElDescriptionsItem label="平台订单号">{{
              order.externalOrderNo || '—'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="房间码">{{ order.roomCode || '—' }}</ElDescriptionsItem
            ><ElDescriptionsItem label="客户游戏 ID">{{ order.gameId || '—' }}</ElDescriptionsItem>
            <ElDescriptionsItem label="地图">{{ order.map || '不限' }}</ElDescriptionsItem
            ><ElDescriptionsItem label="派单方式">{{
              order.dispatchMode === 'pool' ? '公开抢单池' : '指定打手'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="负责人">{{
              order.leaderId
                ? staffName(order.leaderId)
                : order.assignedTo
                  ? staffName(order.assignedTo) + '（待接单）'
                  : '待接单'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="队友">{{
              order.teammateId ? staffName(order.teammateId) : '独自完成 / 未上报'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="客户付款时间">{{
              formatTime(order.paidAt)
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="客服确认时间">{{
              formatTime(order.receivedAt)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="整单打手报酬"
              >{{ money(order.reward)
              }}<ElTag v-if="order.compensationPending" size="small" type="warning" class="ml-2"
                >待财务确认</ElTag
              ></ElDescriptionsItem
            ><ElDescriptionsItem label="订单完成时间">{{
              formatTime(order.completedAt)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="付款凭证" :span="2"
              ><ElLink
                v-if="order.receipt"
                :href="order.receipt.url"
                target="_blank"
                rel="noopener"
                type="primary"
                >{{ order.receipt.name }}</ElLink
              ><span v-else>{{
                isXianyu ? '闲鱼免传截图，请核对平台订单号' : '尚未上传'
              }}</span></ElDescriptionsItem
            >
          </ElDescriptions>
          <ElDivider content-position="left">打手可见备注</ElDivider>
          <template v-if="remarkEditing"
            ><ElInput
              v-model="remarkDraft"
              type="textarea"
              :rows="4"
              maxlength="2000"
              show-word-limit
            /><ElSpace class="mt-3"
              ><ElButton :disabled="saving" @click="remarkEditing = false">取消</ElButton
              ><ElButton type="primary" :loading="saving" @click="saveRemark"
                >保存备注</ElButton
              ></ElSpace
            ></template
          >
          <div v-else
            ><p class="whitespace-pre-wrap text-sm leading-6">{{ order.remark || '暂无备注' }}</p
            ><ElButton v-if="canEdit" type="primary" link class="mt-2" @click="startRemarkEdit"
              >编辑备注</ElButton
            ></div
          >
          <p class="text-xs text-g-500 mt-3">订单向打手开放时可见；完成后也可修改，全部留痕。</p>
          <ElDivider content-position="left">退款记录</ElDivider>
          <ArtTable :data="refunds" :height="220" :showTableHeader="false" :border="false"
            ><ElTableColumn label="金额" width="120"
              ><template #default="{ row }">{{ money(row.amount) }}</template></ElTableColumn
            ><ElTableColumn label="状态" width="110"
              ><template #default="{ row }"
                ><ElTag
                  :type="
                    row.status === 'paid'
                      ? 'success'
                      : row.status === 'pending'
                        ? 'warning'
                        : 'info'
                  "
                  >{{
                    row.status === 'paid'
                      ? '已退款'
                      : row.status === 'pending'
                        ? '待审核'
                        : '已驳回'
                  }}</ElTag
                ></template
              ></ElTableColumn
            ><ElTableColumn label="处理说明" min-width="240"
              ><template #default="{ row }"
                >{{ row.reason
                }}<p v-if="row.manualRewardReview" class="text-xs text-warning">{{
                  row.manualResolution
                    ? '财务人工处理：' + row.manualResolution
                    : '打手已提现，报酬差额待财务人工确认登记'
                }}</p></template
              ></ElTableColumn
            ><ElTableColumn label="时间" min-width="170"
              ><template #default="{ row }">{{
                formatTime(row.processedAt || row.createdAt)
              }}</template></ElTableColumn
            ></ArtTable
          >
          <ElCollapse class="mt-5"
            ><ElCollapseItem title="下单时的项目快照" name="snapshot"
              ><ElDescriptions :column="2" border
                ><ElDescriptionsItem label="项目名称">{{ order.snapshot.name }}</ElDescriptionsItem
                ><ElDescriptionsItem label="游戏">{{ order.snapshot.game }}</ElDescriptionsItem
                ><ElDescriptionsItem label="模板客户价">{{
                  money(order.snapshot.amount)
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="模板打手价">{{
                  money(order.snapshot.reward)
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="规格 / 目标" :span="2">{{
                  order.snapshot.description || '—'
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="默认备注" :span="2">{{
                  order.snapshot.remark || '—'
                }}</ElDescriptionsItem></ElDescriptions
              ></ElCollapseItem
            ></ElCollapse
          >
        </ElTabPane>
        <ElTabPane :label="'完成材料 (' + order.submissions.length + ')'" name="submissions">
          <ElEmpty
            v-if="!order.submissions.length"
            description="负责人尚未通过打手端提交完成材料"
          />
          <ElCard
            v-for="submission in [...order.submissions].reverse()"
            :key="submission.id"
            class="mb-4"
            shadow="never"
            ><template #header
              ><div class="flex justify-between gap-3"
                ><span>{{ formatTime(submission.submittedAt) }}</span
                ><ElTag
                  :type="
                    submission.review === 'passed'
                      ? 'success'
                      : submission.review === 'returned'
                        ? 'danger'
                        : 'warning'
                  "
                  >{{
                    submission.review === 'passed'
                      ? '验收通过'
                      : submission.review === 'returned'
                        ? '已退回'
                        : '待验收'
                  }}</ElTag
                ></div
              ></template
            ><p class="text-sm mb-3"
              >负责人 {{ staffName(submission.leaderId) }} · 队友
              {{ submission.teammateId ? staffName(submission.teammateId) : '无，独自完成' }}</p
            ><ElSpace wrap
              ><ElImage
                v-for="image in submission.screenshots"
                :key="image.id"
                :src="image.url"
                :preview-src-list="submission.screenshots.map((s) => s.url)"
                :alt="image.name"
                fit="cover"
                class="w-32 h-24 rounded-lg"
                preview-teleported /></ElSpace
            ><ElAlert
              v-if="submission.reason"
              :title="submission.reason"
              type="warning"
              :closable="false"
              class="mt-4"
          /></ElCard>
        </ElTabPane>
        <ElTabPane :label="'接单记录 (' + order.assignments.length + ')'" name="assignments"
          ><ArtTable :data="order.assignments" :height="360" :showTableHeader="false"
            ><ElTableColumn label="负责人"
              ><template #default="{ row }">{{ staffName(row.leaderId) }}</template></ElTableColumn
            ><ElTableColumn label="接单时间"
              ><template #default="{ row }">{{
                formatTime(row.acceptedAt)
              }}</template></ElTableColumn
            ><ElTableColumn label="解除时间"
              ><template #default="{ row }">{{
                formatTime(row.releasedAt)
              }}</template></ElTableColumn
            ><ElTableColumn prop="reason" label="解除原因" /></ArtTable
        ></ElTabPane>
        <ElTabPane :label="'操作记录 (' + logs.length + ')'" name="logs"
          ><ElTimeline class="mt-4"
            ><ElTimelineItem
              v-for="log in logs"
              :key="log.id"
              :timestamp="formatTime(log.createdAt)"
              placement="top"
              ><p class="font-medium">{{ log.actorName }} · {{ logAction(log.action) }}</p
              ><p
                v-for="change in logChanges(log)"
                :key="change"
                class="text-xs text-g-500 mt-2 break-all"
                >{{ change }}</p
              ></ElTimelineItem
            ></ElTimeline
          ><ElEmpty v-if="!logs.length" description="暂无操作记录"
        /></ElTabPane>
      </ElTabs>
      <ElDialog
        :model-value="!!dialog"
        :title="dialogTitle"
        width="min(620px, 94vw)"
        append-to-body
        :close-on-click-modal="!saving && !uploading"
        :close-on-press-escape="!saving && !uploading"
        :show-close="!saving && !uploading"
        @update:model-value="updateDialogVisibility"
      >
        <ElForm
          novalidate
          :model="fields"
          label-position="top"
          :disabled="saving || uploading"
          @submit.prevent="submitAction"
        >
          <template v-if="dialog === 'payment'"
            ><ElFormItem label="客户实际收款金额（元）" required
              ><ElInputNumber
                v-model="fields.amount"
                :min="0.01"
                :precision="2"
                class="!w-full" /></ElFormItem
            ><ElFormItem label="客户实际付款时间" required
              ><ElDatePicker
                v-model="fields.paidAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm:ssZ"
                format="YYYY-MM-DD HH:mm"
                class="!w-full" /></ElFormItem
            ><ElFormItem v-if="!isXianyu" label="付款凭证" required
              ><ElUpload
                :auto-upload="false"
                :show-file-list="false"
                :on-change="uploadReceipt"
                :disabled="uploading || saving"
                accept="image/png,image/jpeg,image/webp"
                ><ElButton :loading="uploading">{{
                  fields.receipt ? '替换凭证' : '上传付款凭证'
                }}</ElButton></ElUpload
              ><ElLink
                v-if="fields.receipt"
                :href="fields.receipt.url"
                target="_blank"
                rel="noopener"
                type="primary"
                class="ml-3"
                >{{ fields.receipt.name }}</ElLink
              ></ElFormItem
            ><ElAlert v-else title="闲鱼免传截图，请核对平台订单号。" type="info" :closable="false"
          /></template>
          <template v-if="dialog === 'dispatch'"
            ><ElFormItem label="派单方式"
              ><ElRadioGroup v-model="fields.dispatchMode"
                ><ElRadioButton value="pool">公开抢单池</ElRadioButton
                ><ElRadioButton value="direct">指定打手</ElRadioButton></ElRadioGroup
              ></ElFormItem
            ><ElFormItem v-if="fields.dispatchMode === 'direct'" label="指定打手" required
              ><ElSelect v-model="fields.assignedTo" filterable
                ><ElOption
                  v-for="item in players"
                  :key="item.id"
                  :value="item.id"
                  :label="
                    item.name + ' · 执行中 ' + (item.activeOrders || 0) + '/' + item.maxActiveOrders
                  " /></ElSelect></ElFormItem
            ><ElAlert
              title="调整后由打手本人接单，抢单池按等级延迟开放。"
              type="info"
              :closable="false"
          /></template>
          <template v-if="dialog === 'refund'"
            ><ElAlert
              :title="'剩余可退 ' + money(refundAvailable) + '，已扣除待审核申请'"
              type="info"
              :closable="false"
              class="mb-4"
            /><ElFormItem label="本次退款金额（元）" required
              ><ElInputNumber
                v-model="fields.amount"
                :min="0.01"
                :max="refundAvailable / 100"
                :precision="2"
                class="!w-full" /></ElFormItem
            ><p class="text-xs text-g-500 mb-4">{{
              can('finance.refunds')
                ? '确认保存表示已完成实际退款，统计回到原付款日更新。'
                : '申请提交财务审核，实际退款另行登记。'
            }}</p></template
          >
          <template v-if="dialog === 'edit'"
            ><ElAlert
              title="更改当前实际订单，并保留原创建人和模板快照。修改金额会同步更正收款登记；实际退款请另行登记。"
              type="info"
              :closable="false"
              class="mb-4" /><ElRow :gutter="16"
              ><ElCol :xs="24" :sm="12"
                ><ElFormItem label="房间码"
                  ><ElInput v-model="fields.roomCode" maxlength="100" /></ElFormItem></ElCol
              ><ElCol :xs="24" :sm="12"
                ><ElFormItem label="客户游戏 ID"
                  ><ElInput v-model="fields.gameId" maxlength="100" /></ElFormItem></ElCol
              ><ElCol :xs="24" :sm="12"
                ><ElFormItem label="地图"
                  ><ElInput v-model="fields.map" maxlength="100" /></ElFormItem></ElCol
              ><ElCol :xs="24" :sm="12"
                ><ElFormItem label="沟通渠道"
                  ><ElInput v-model="fields.channel" maxlength="100" /></ElFormItem></ElCol></ElRow
            ><ElFormItem label="打手可见备注"
              ><ElInput
                v-model="fields.remark"
                type="textarea"
                :rows="3"
                maxlength="2000"
                show-word-limit /></ElFormItem
          ></template>
          <ElAlert
            v-if="dialog === 'adjust'"
            title="更正后同步更新原付款日的成本与利润，实际退款须另行登记。"
            type="warning"
            :closable="false"
            class="mb-4"
          />
          <ElRow v-if="dialog === 'edit' || dialog === 'adjust'" :gutter="16"
            ><ElCol :xs="24" :sm="12"
              ><ElFormItem label="订单金额（元）" required
                ><ElInputNumber
                  v-model="fields.amount"
                  :min="0.01"
                  :precision="2"
                  class="!w-full" /></ElFormItem></ElCol
            ><ElCol :xs="24" :sm="12"
              ><ElFormItem label="整单打手报酬（元）" required
                ><ElInputNumber
                  v-model="fields.reward"
                  :min="0"
                  :precision="2"
                  class="!w-full" /></ElFormItem></ElCol
          ></ElRow>
          <template v-if="dialog === 'cancel-settle'"
            ><ElAlert
              title="取消补偿单保留取消状态，确认后才计入打手可提现报酬。"
              type="warning"
              :closable="false"
              class="mb-4" /><ElFormItem label="最终整单打手报酬（元）" required
              ><ElInputNumber
                v-model="fields.reward"
                :min="0"
                :precision="2"
                class="!w-full" /></ElFormItem
            ><ElFormItem label="结算负责人"
              ><ElInput
                :model-value="
                  staffName(
                    order.leaderId || order.assignments[order.assignments.length - 1]?.leaderId
                  )
                "
                disabled /></ElFormItem
            ><ElFormItem label="队友（可选，选择后两人平分）"
              ><ElSelect v-model="fields.teammateId" clearable filterable
                ><ElOption
                  v-for="item in players.filter(
                    (p) =>
                      p.id !==
                      (order?.leaderId ||
                        order?.assignments[order.assignments.length - 1]?.leaderId)
                  )"
                  :key="item.id"
                  :value="item.id"
                  :label="item.name" /></ElSelect></ElFormItem
          ></template>
          <ElAlert
            v-if="dialog === 'cancel'"
            title="终止订单履约并保留历史记录。有履约历史的最终报酬由财务确认；实际退款须另行登记。"
            type="warning"
            :closable="false"
            class="mb-4"
          />
          <ElAlert
            v-if="dialog === 'release'"
            title="解除后清空当前负责人，订单返回待接单，请重新派单。"
            type="warning"
            :closable="false"
            class="mb-4"
          />
          <ElAlert
            v-if="dialog === 'review-return'"
            title="退回后保留原负责人，订单返回执行中，等待打手补充完成材料。"
            type="info"
            :closable="false"
            class="mb-4"
          />
          <ElFormItem
            v-if="dialog && !['payment', 'dispatch'].includes(dialog)"
            label="原因 / 处理说明"
            required
            ><ElInput
              v-model="fields.reason"
              type="textarea"
              :rows="3"
              maxlength="1000"
              show-word-limit
          /></ElFormItem>
        </ElForm>
        <template #footer
          ><ElButton :disabled="saving || uploading" @click="dialog = null">返回</ElButton
          ><ElButton
            :type="dialog === 'cancel' ? 'danger' : 'primary'"
            :loading="saving"
            :disabled="uploading"
            @click="submitAction"
            >{{
              dialog === 'refund' && !can('finance.refunds') ? '提交退款申请' : '确认保存'
            }}</ElButton
          ></template
        >
      </ElDialog>
    </template>
    <ElEmpty v-else description="订单不存在或当前账号无权查看" />
  </div>
</template>
