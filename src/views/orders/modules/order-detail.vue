<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, reactive, ref, watch } from 'vue'
  import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
  import { useStudio, money, formatTime, statusLabels } from '@/hooks/business/useStudio'
  import type {
    Attachment,
    AuditLog,
    Order,
    OrderDetailResponse,
    OrderDispatchTarget,
    OrderExpectedState,
    OrderStatus,
    Refund
  } from '@/types/studio'
  import { rulesForPlatform } from '@/utils/business/platform-rules'
  import { studioRequest } from '@/api/studio'
  import { createStudioMutationIntent } from '@/api/studio-mutation'
  import { businessConfirmMessage } from '@/utils/business/confirm-message'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'

  const props = defineProps<{ orderId: string }>()
  const emit = defineEmits<{ busy: [value: boolean] }>()
  const { data, user, can, mutate, upload, clearSession } = useStudio()
  const detail = ref<Order | null>(null)
  const detailRefunds = ref<Refund[] | null>(null)
  const detailLogs = ref<AuditLog[] | null>(null)
  const detailLoading = ref(false)
  const detailError = ref('')
  const order = computed(() => detail.value)
  let detailVersion = 0
  const actionIntent = createStudioMutationIntent()
  const remarkIntent = createStudioMutationIntent()
  const reviewIntent = createStudioMutationIntent()
  const expected = ref<OrderExpectedState | null>(null)
  const remarkExpected = ref<OrderExpectedState | null>(null)
  function expectedState(row: Order): OrderExpectedState {
    return {
      expectedRevision: row.revision,
      dispatchRound: row.dispatchRound,
      assignmentId: row.assignmentId,
      submissionId: row.submissionId,
      leaderId: row.leaderId
    }
  }
  async function loadOrder(reconfirm = false) {
    if (!user.value || !props.orderId) {
      detail.value = null
      detailRefunds.value = null
      detailLogs.value = null
      detailLoading.value = false
      return
    }
    const version = ++detailVersion
    const id = props.orderId
    const accountId = user.value?.id
    detailLoading.value = true
    detailError.value = ''
    try {
      const result = await studioRequest<OrderDetailResponse>(`orders/${encodeURIComponent(id)}`)
      if (version !== detailVersion || id !== props.orderId || accountId !== user.value?.id) return
      detail.value = result.order
      detailRefunds.value = result.refunds || null
      detailLogs.value = result.logs || null
      if (reconfirm) {
        dialog.value = null
        remarkEditing.value = false
        actionIntent.complete()
        remarkIntent.complete()
        reviewIntent.complete()
        expected.value = null
        remarkExpected.value = null
      }
    } catch (cause) {
      if (version !== detailVersion) return
      const status = (cause as { status?: number }).status
      if (status === 401) clearSession()
      if (status === 401 || status === 403 || status === 404) {
        detail.value = null
        detailRefunds.value = null
        detailLogs.value = null
      }
      detailError.value = cause instanceof Error ? cause.message : '订单读取失败，请重试'
    } finally {
      if (version === detailVersion) detailLoading.value = false
    }
  }
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
    | 'correct-status'
    | 'return-approve'
    | 'return-reject'
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
    returnRequestId: '',
    paidAt: '',
    receipt: null as Attachment | null,
    paymentMethod: 'cash' as 'cash' | 'balance',
    dispatchMode: 'pool' as 'pool' | 'direct',
    assignedTo: '',
    status: 'pending' as OrderStatus,
    leaderId: '',
    teammateId: '',
    roomCode: '',
    gameId: '',
    map: '',
    remark: '',
    playerRemark: '',
    cashAmountCorrection: false
  })
  const dispatchTargets = ref<OrderDispatchTarget[] | null>(null)
  const targetsLoading = ref(false)
  const targetsError = ref('')
  let targetsVersion = 0
  async function loadTargets() {
    const version = ++targetsVersion
    const accountId = user.value?.id
    targetsLoading.value = true
    targetsError.value = ''
    try {
      const result = await studioRequest<{ records: OrderDispatchTarget[] }>(
        'orders/dispatch-targets'
      )
      if (version === targetsVersion && accountId === user.value?.id)
        dispatchTargets.value = result.records
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) clearSession()
      if (version === targetsVersion)
        targetsError.value = cause instanceof Error ? cause.message : '派单目标读取失败'
    } finally {
      if (version === targetsVersion) targetsLoading.value = false
    }
  }
  const balance = ref<number | null>(null)
  const balanceLoading = ref(false)
  const balanceError = ref('')
  let balanceVersion = 0
  async function loadBalance() {
    const version = ++balanceVersion
    balance.value = null
    balanceError.value = ''
    if (!order.value || dialog.value !== 'payment' || fields.paymentMethod !== 'balance') {
      balanceLoading.value = false
      return
    }
    balanceLoading.value = true
    try {
      const result = await studioRequest<{ customerId: string; balance: number }>(
        `customers/${encodeURIComponent(order.value.customerId)}/balance`
      )
      if (version === balanceVersion) balance.value = result.balance
    } catch (cause) {
      if (version !== balanceVersion) return
      if ((cause as { status?: number }).status === 401) clearSession()
      balanceError.value = cause instanceof Error ? cause.message : '储值余额加载失败'
    } finally {
      if (version === balanceVersion) balanceLoading.value = false
    }
  }
  watch([() => fields.paymentMethod, dialog, () => props.orderId], () => {
    void loadBalance()
  })
  onUnmounted(() => {
    balanceVersion++
    detailVersion++
    targetsVersion++
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
  const rules = computed(() => rulesForPlatform(platform.value))
  const players = computed(
    () =>
      (
        dispatchTargets.value ??
        data.value?.users.filter((item) => item.role === 'player') ??
        []
      ).filter(
        (item) =>
          item.status === 'active' &&
          item.playerAccess?.login !== false &&
          item.playerAccess?.claim !== false
      ) ?? []
  )
  const correctionPlayers = computed(
    () => dispatchTargets.value ?? data.value?.users.filter((item) => item.role === 'player') ?? []
  )
  function playerCapacity(id: string) {
    const player = (dispatchTargets.value ?? data.value?.users ?? []).find((item) => item.id === id)
    if (!player) return '打手信息待刷新'
    return `接单中 ${player.activeOrders || 0}/${player.maxActiveOrders} · 待接受 ${player.pendingAssignments || 0}`
  }
  const correctionWarnings = computed(() => {
    const player = correctionPlayers.value.find((item) => item.id === fields.leaderId)
    if (!player) return []
    const rows: string[] = []
    if (player.status !== 'active') rows.push('负责人账号已停用')
    if (player.playerAccess?.login === false) rows.push('负责人登录开关已关闭')
    if (player.playerAccess?.claim === false) rows.push('负责人接单开关已关闭')
    const active =
      (player.activeOrders || 0) +
      (fields.status === 'active' &&
      !(order.value?.status === 'active' && order.value.leaderId === player.id)
        ? 1
        : 0)
    if (active > player.maxActiveOrders)
      rows.push(`更正后负责人接单中 ${active} 单，超过上限 ${player.maxActiveOrders} 单`)
    return rows
  })
  watch(
    () => fields.leaderId,
    (id) => {
      if (fields.teammateId === id) fields.teammateId = ''
    }
  )
  const refunds = computed(
    () =>
      detailRefunds.value ??
      data.value?.refunds.filter((item) => item.orderId === props.orderId) ??
      []
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
    (detailLogs.value ?? data.value?.logs ?? [])
      .filter(
        (item) =>
          item.entityId === props.orderId ||
          refunds.value.some((refund) => refund.id === item.entityId)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const canEdit = computed(() => can('orders.edit'))
  const cashAmountChanged = computed(
    () =>
      !!order.value &&
      order.value.paymentMethod !== 'balance' &&
      ['edit', 'adjust'].includes(dialog.value || '') &&
      fields.amount !== null &&
      toCents(fields.amount) !== order.value.amount
  )
  const pendingReturn = computed(() =>
    order.value?.returnRequests?.find((item) => item.status === 'pending')
  )
  const returnStatusLabels = {
    pending: '待客服处理',
    approved: '已批准退单',
    rejected: '已驳回',
    obsolete: '已失效'
  }
  const canReview = computed(() => can('finance.review'))
  const canCorrectStatus = computed(
    () =>
      can('orders.edit') &&
      ['finance', 'manager', 'owner', 'super_admin'].includes(user.value?.role || '')
  )
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
        'review-return': '退回完成材料',
        'correct-status': '财务订单状态更正',
        'return-approve': '批准打手退单',
        'return-reject': '驳回打手退单'
      })[dialog.value ?? 'payment']
  )
  const staffName = (id: string | null | undefined) =>
    data.value?.users.find((item) => item.id === id)?.name ?? '—'
  const actionDescription = computed(() => {
    const descriptions: Record<string, string> = {
      payment: '核对付款方式、实际金额与付款时间后登记收款。',
      dispatch: '调整本轮派单安排；指定打手仍需本人接受订单。',
      release: '核对当前负责人后解除接单，原履约与接单记录继续保留。',
      cancel: '终止履约并说明原因，退款与最终报酬分别处理。',
      refund: '核对可退额度与原付款方式，记录申请或实际退款。',
      edit: '修改当前履约资料与备注，历史记录和下单快照继续保留。',
      adjust: '核对原金额与报酬，按实际业务填写更正依据。',
      'cancel-settle': '核对取消订单的实际履约人员，确认最终整单报酬。',
      'review-return': '针对当前完成材料填写退回原因，原材料记录继续保留。',
      'correct-status': '登记真实状态及实际履约人员，并核对对应资金影响。',
      'return-approve': '核对申请人和退单原因，批准后进入重新分配流程。',
      'return-reject': '保留原负责人继续执行，并明确说明驳回依据。'
    }
    return descriptions[dialog.value || ''] || '核对当前订单后操作。'
  })
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
    [() => props.orderId, () => user.value?.id, () => data.value?.permissions.join('|')],
    () => {
      actionIntent.complete()
      remarkIntent.complete()
      reviewIntent.complete()
      expected.value = null
      remarkExpected.value = null
      activeTab.value = 'information'
      remarkEditing.value = false
      dialog.value = null
      detail.value = null
      detailRefunds.value = null
      detailLogs.value = null
      dispatchTargets.value = null
      targetsVersion++
      void loadOrder()
    },
    { immediate: true }
  )

  function openAction(action: NonNullable<typeof dialog.value>) {
    if (!order.value || saving.value) return
    if (actionIntent.uncertain) {
      ElMessage.warning('上一次提交结果尚未确认，请按原内容重试，或刷新订单后重新核对')
      return
    }
    expected.value = expectedState(order.value)
    Object.assign(fields, {
      amount: action === 'refund' ? refundAvailable.value / 100 : order.value.amount / 100,
      reward: order.value.reward / 100,
      reason: '',
      returnRequestId: pendingReturn.value?.id || '',
      paidAt: new Date().toISOString(),
      receipt: null,
      paymentMethod: 'cash',
      dispatchMode: order.value.dispatchMode,
      assignedTo: order.value.assignedTo ?? '',
      status: order.value.status,
      leaderId: order.value.leaderId ?? order.value.assignedTo ?? '',
      teammateId: order.value.teammateId ?? '',
      roomCode: order.value.roomCode,
      gameId: order.value.gameId,
      map: order.value.map,
      remark: order.value.remark,
      playerRemark: order.value.playerRemark || '',
      cashAmountCorrection: false
    })
    dialog.value = action
    if (action === 'dispatch' || action === 'correct-status') void loadTargets()
  }

  function startRemarkEdit() {
    if (!order.value || saving.value) return
    remarkExpected.value = expectedState(order.value)
    remarkDraft.value = order.value.playerRemark || ''
    remarkEditing.value = true
  }
  async function restoreAction({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    const separator = recordId?.indexOf(':') ?? -1
    if (!recordId || separator < 0 || recordId.slice(separator + 1) !== props.orderId) return
    const action = recordId.slice(0, separator) as NonNullable<typeof dialog.value>
    await loadOrder()
    if (isCurrent && !isCurrent()) return
    const row = order.value
    if (!row || saving.value || uploading.value) return
    const permitted: Record<NonNullable<typeof dialog.value>, boolean> = {
      payment: canEdit.value && row.status !== 'canceled' && !row.receivedAmount,
      dispatch: canEdit.value && row.status === 'pending',
      release: canEdit.value && row.status === 'active',
      cancel: canCancel.value,
      refund: canRefund.value,
      edit: canEdit.value && ['pending', 'active', 'review'].includes(row.status),
      adjust: canReview.value && ['completed', 'canceled'].includes(row.status),
      'cancel-settle': canReview.value && row.status === 'canceled' && !!row.compensationPending,
      'review-return': canReview.value && row.status === 'review',
      'correct-status': canCorrectStatus.value,
      'return-approve': canEdit.value && !!pendingReturn.value,
      'return-reject': canEdit.value && !!pendingReturn.value
    }
    if (permitted[action]) openAction(action)
    else ElMessage.warning('这项操作当前不可用，请返回订单核对最新状态和权限')
  }

  function updateDialogVisibility(visible: boolean) {
    if (visible || saving.value || uploading.value) return
    if (actionIntent.uncertain) {
      ElMessage.warning('上一次提交结果尚未确认，请按原内容重试，或刷新订单后重新核对')
      return
    }
    dialog.value = null
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
    if (!order.value || !dialog.value || !expected.value || saving.value || uploading.value) return
    const action = dialog.value
    if (
      ['dispatch', 'correct-status'].includes(action) &&
      (targetsLoading.value || targetsError.value)
    ) {
      ElMessage.warning(targetsError.value || '正在读取最新派单人数和权限，请稍后确认')
      return
    }
    const requiresReason = [
      'release',
      'cancel',
      'refund',
      'edit',
      'adjust',
      'cancel-settle',
      'review-return',
      'correct-status',
      'return-approve',
      'return-reject'
    ].includes(action)
    if (requiresReason && !fields.reason.trim()) {
      ElMessage.warning('请填写本次操作的原因或处理说明')
      return
    }
    if (['return-approve', 'return-reject'].includes(action) && !fields.returnRequestId) {
      ElMessage.warning('退单申请已变化，请刷新订单后处理')
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
      if (
        fields.paymentMethod === 'balance' &&
        (balanceLoading.value ||
          balance.value === null ||
          balanceError.value ||
          balance.value < order.value.amount)
      ) {
        ElMessage.warning(balanceError.value || '请确认储值余额已读取且足够支付整笔订单')
        return
      }
      if (fields.paymentMethod === 'cash' && !fields.paidAt) {
        ElMessage.warning('请选择客户实际付款时间')
        return
      }
      if (fields.paymentMethod === 'cash' && rules.value.requiresReceipt && !fields.receipt) {
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
    if (cashAmountChanged.value && order.value.receivedAmount > 0 && !fields.cashAmountCorrection) {
      ElMessage.warning('已收款现金单改金额须确认是历史录错更正，并会回改原实收与原付款日统计')
      return
    }
    if (action === 'correct-status') {
      if (!canCorrectStatus.value) return void ElMessage.warning('当前账号没有状态更正权限')
      if (fields.status === order.value.status)
        return void ElMessage.warning('请先选择需要更正的新状态')
      if (['active', 'review', 'completed'].includes(fields.status) && !fields.leaderId)
        return void ElMessage.warning('执行、验收和完成状态必须选择负责人')
      if (fields.leaderId && fields.leaderId === fields.teammateId)
        return void ElMessage.warning('负责人和队友不能是同一人')
      if (fields.status === 'completed' && order.value.receivedAmount !== order.value.amount)
        return void ElMessage.warning('已完成状态须已足额收款')
    }
    saving.value = true
    try {
      if (action === 'refund') {
        await mutate(
          '/refunds',
          actionIntent.prepare('/refunds', {
            orderId: order.value.id,
            expectedRevision: expected.value.expectedRevision,
            amount: toCents(fields.amount),
            reason: fields.reason.trim()
          })
        )
      } else {
        const body: Record<string, unknown> = {
          action,
          reason: fields.reason.trim(),
          ...expected.value
        }
        if (action === 'return-approve' || action === 'return-reject')
          body.returnRequestId = fields.returnRequestId
        if (action === 'payment')
          Object.assign(body, {
            action: 'confirm-payment',
            paymentMethod: fields.paymentMethod,
            receivedAmount: toCents(fields.amount),
            paidAt: fields.paymentMethod === 'balance' ? null : fields.paidAt,
            receipt:
              fields.paymentMethod === 'balance' || !rules.value.requiresReceipt
                ? null
                : fields.receipt
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
            remark: fields.remark,
            playerRemark: fields.playerRemark
          })
        if (cashAmountChanged.value)
          Object.assign(body, {
            amountChangeKind:
              order.value.receivedAmount > 0 ? 'historical-correction' : 'price-change',
            affectsHistoricalReceived: order.value.receivedAmount > 0 && fields.cashAmountCorrection
          })
        if (action === 'correct-status')
          Object.assign(body, {
            status: fields.status,
            leaderId: fields.leaderId || null,
            teammateId: fields.teammateId || null
          })
        if (action === 'cancel-settle')
          Object.assign(body, {
            reward: toCents(fields.reward),
            teammateId: fields.teammateId || null
          })
        const path = `/orders/${encodeURIComponent(order.value.id)}/action`
        await mutate(path, actionIntent.prepare(path, body))
      }
      actionIntent.complete()
      dialog.value = null
      await loadOrder()
      ElMessage.success(
        action === 'refund' && !can('finance.refunds')
          ? '退款申请已提交财务审核'
          : '处理已保存，并记录操作日志'
      )
    } catch (error) {
      actionIntent.fail(error)
      ElMessage.error(errorText(error))
    } finally {
      saving.value = false
    }
  }

  async function saveRemark() {
    if (!order.value || !remarkExpected.value || saving.value) return
    saving.value = true
    try {
      const path = `/orders/${encodeURIComponent(order.value.id)}/action`
      await mutate(
        path,
        remarkIntent.prepare(path, {
          action: 'remark',
          ...remarkExpected.value,
          playerRemark: remarkDraft.value
        })
      )
      remarkIntent.complete()
      remarkEditing.value = false
      await loadOrder()
      ElMessage.success('打手可见备注已保存')
    } catch (error) {
      remarkIntent.fail(error)
      ElMessage.error(errorText(error))
    } finally {
      saving.value = false
    }
  }

  async function passReview() {
    if (!order.value || saving.value) return
    const captured = expectedState(order.value)
    const path = `/orders/${encodeURIComponent(order.value.id)}/action`
    saving.value = true
    try {
      await ElMessageBox.confirm(
        businessConfirmMessage(
          '请核对完成材料或后台登记原因，以及负责人 / 队友信息。验收通过后，本单报酬将计入对应打手的可提现金额。',
          [
            { label: '订单', value: `${order.value.orderNo} · ${order.value.title}` },
            { label: '当前版本', value: captured.expectedRevision },
            { label: '待验收材料', value: captured.submissionId || '当前记录未提供材料编号' },
            { label: '负责人', value: staffName(order.value.leaderId) },
            {
              label: '队友',
              value: order.value.teammateId ? staffName(order.value.teammateId) : '无，独自完成'
            },
            { label: '整单报酬', value: money(order.value.reward) }
          ],
          '以上为发起确认时的订单信息；状态或材料变化后须刷新并重新核对。'
        ),
        '确认财务验收通过',
        { confirmButtonText: '核对无误，通过验收', cancelButtonText: '继续核对', type: 'warning' }
      )
    } catch {
      saving.value = false
      return
    }
    try {
      await mutate(path, reviewIntent.prepare(path, { action: 'review-pass', ...captured }))
      reviewIntent.complete()
      await loadOrder()
      ElMessage.success('财务验收通过，订单已完成')
    } catch (error) {
      reviewIntent.fail(error)
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
    'return-request': '申请退单',
    'return-approve': '批准打手退单',
    'return-reject': '驳回打手退单',
    'reject-assignment': '拒绝指定订单',
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
    remark: '内部备注',
    playerRemark: '打手可见备注',
    status: '订单状态',
    assignedTo: '指定打手',
    leaderId: '负责人',
    teammateId: '队友',
    reason: '原因',
    cancelReason: '取消原因',
    dispatchMode: '派单方式',
    dispatchState: '分配状态',
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
    if (key === 'dispatchState') return value === 'unassigned' ? '待客服分配' : '已发布 / 已指定'
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
  async function copyOrderNo() {
    if (!order.value) return
    try {
      await navigator.clipboard.writeText(order.value.orderNo)
      ElMessage.success('订单号已复制')
    } catch {
      ElMessage.warning('复制失败，请手动选择订单号')
    }
  }
</script>
<template>
  <div class="business-detail-page">
    <ElAlert v-if="detailError" :title="detailError" type="error" :closable="false" class="mb-4" />
    <ElButton
      class="mb-4"
      :loading="detailLoading"
      :disabled="saving || uploading"
      @click="loadOrder(true)"
    >
      刷新订单并重新确认操作
    </ElButton>
    <template v-if="order">
      <BusinessDetailHeader
        :title="order.title"
        :description="order.orderNo"
        icon="ri:file-list-3-line"
        :badge="order.dispatchState === 'unassigned' ? '待分配' : statusLabels[order.status]"
        :context="`${staffName(order.creatorId)} 创建于 ${formatTime(order.createdAt)} · 当前版本 ${order.revision} · 派单第 ${order.dispatchRound} 轮`"
      >
        <template #actions>
          <ElButton link size="small" aria-label="复制订单号" @click="copyOrderNo"
            ><ArtSvgIcon icon="ri:file-copy-line" class="mr-1" />复制订单号</ElButton
          >
        </template>
      </BusinessDetailHeader>
      <BusinessDetailSummary
        :items="[
          { label: '订单金额', value: money(order.amount), hint: '当前客户应付金额' },
          { label: '累计收款', value: money(order.receivedAmount), tone: 'primary' },
          { label: '累计退款', value: money(refunded), hint: '仅已完成退款', tone: 'warning' },
          {
            label: '剩余净收入',
            value: money(order.receivedAmount - refunded),
            hint: '实收减已退款'
          }
        ]"
      />
      <ElAlert
        v-if="order.dispatchState === 'unassigned'"
        title="订单待客服重新分配"
        description="请调整派单，重新指定打手或放回公共抢单池。"
        type="warning"
        :closable="false"
        show-icon
        class="mb-4"
      />
      <ElAlert
        v-if="pendingReturn"
        :title="'打手申请退单：' + staffName(pendingReturn.leaderId)"
        :description="pendingReturn.reason + '；批准前继续占用该打手的执行名额。'"
        type="warning"
        :closable="false"
        show-icon
        class="mb-4"
      />
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
        v-if="order.receivedAmount !== order.amount && order.status !== 'canceled'"
        title="尚未足额收款：可以按来源规则接单，打手正常上报前必须确认足额付款。"
        type="warning"
        :closable="false"
        show-icon
        class="mb-4"
      />
      <ElSpace wrap class="mb-5">
        <ElButton
          v-if="canEdit && pendingReturn"
          type="warning"
          :disabled="saving || uploading"
          @click="openAction('return-approve')"
          >批准退单</ElButton
        >
        <ElButton
          v-if="canEdit && pendingReturn"
          :disabled="saving || uploading"
          @click="openAction('return-reject')"
          >驳回退单</ElButton
        >
        <ElButton
          v-if="canCorrectStatus"
          type="warning"
          plain
          :disabled="saving || uploading"
          @click="openAction('correct-status')"
          >更正订单状态</ElButton
        >
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
          <BusinessDetailSection
            title="客户与履约资料"
            description="客户、来源与当前履约人员使用已授权的真实订单信息。"
          >
            <ElDescriptions :column="2" border>
              <ElDescriptionsItem label="客户">{{ customer?.name || '—' }}</ElDescriptionsItem
              ><ElDescriptionsItem label="联系方式">{{
                customer?.contact || '—'
              }}</ElDescriptionsItem>
              <ElDescriptionsItem label="订单来源">{{ platform?.name || '—' }}</ElDescriptionsItem
              ><ElDescriptionsItem label="店铺">{{ shop?.name || '—' }}</ElDescriptionsItem
              ><ElDescriptionsItem label="平台订单号">{{
                order.externalOrderNo || '—'
              }}</ElDescriptionsItem>
              <ElDescriptionsItem label="房间码">{{ order.roomCode || '—' }}</ElDescriptionsItem
              ><ElDescriptionsItem label="客户游戏 ID">{{
                order.gameId || '—'
              }}</ElDescriptionsItem>
              <ElDescriptionsItem label="地图">{{ order.map || '不限' }}</ElDescriptionsItem
              ><ElDescriptionsItem label="派单方式">{{
                order.dispatchState === 'unassigned'
                  ? '待客服分配'
                  : order.dispatchMode === 'pool'
                    ? '公开抢单池'
                    : '指定打手'
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
              <ElDescriptionsItem label="收款方式">{{
                order.paymentMethod === 'balance' ? '老板储值支付' : '现金 / 平台收款'
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
                  !rules.requiresReceipt ? '本来源免传付款截图，请核对收款记录' : '尚未上传'
                }}</span></ElDescriptionsItem
              >
            </ElDescriptions>
          </BusinessDetailSection>
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
            ><p class="whitespace-pre-wrap text-sm leading-6">{{
              order.playerRemark || '暂无公开备注'
            }}</p
            ><ElButton v-if="canEdit" type="primary" link class="mt-2" @click="startRemarkEdit"
              >编辑备注</ElButton
            ></div
          >
          <p class="text-xs text-g-500 mt-3"
            >仅此备注向符合接单资格的打手展示，内部及历史备注不会自动公开。</p
          >
          <ElDivider content-position="left">内部备注 / 历史备注</ElDivider>
          <p class="whitespace-pre-wrap text-sm leading-6">{{ order.remark || '暂无内部备注' }}</p>
          <BusinessDetailSection
            title="退款记录"
            description="该订单的退款申请与处理记录；取消订单和实际退款分别记录。"
          >
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
          </BusinessDetailSection>
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
        <ElTabPane
          :label="
            '拒单 / 退单记录 (' +
            ((order.returnRequests?.length || 0) + (order.rejections?.length || 0)) +
            ')'
          "
          name="returns"
        >
          <BusinessDetailHeader
            description="保留各轮次的拒单、退单申请及处理依据；只有当前待处理申请可由原操作入口审批。"
            icon="ri:history-line"
          />
          <ElEmpty
            v-if="!order.returnRequests?.length && !order.rejections?.length"
            description="暂无拒单或退单记录"
          />
          <ElCard
            v-for="rejection in [...(order.rejections || [])].reverse()"
            :key="rejection.id"
            class="mb-4"
            shadow="never"
          >
            <template #header
              ><ElSpace
                ><span
                  >{{ staffName(rejection.playerId) }} ·
                  {{ formatTime(rejection.rejectedAt) }}</span
                ><ElTag type="info">拒绝指定订单</ElTag></ElSpace
              ></template
            >
            <p class="whitespace-pre-wrap">拒绝原因：{{ rejection.reason }}</p>
          </ElCard>
          <ElCard
            v-for="request in [...(order.returnRequests || [])].reverse()"
            :key="request.id"
            class="mb-4"
            shadow="never"
          >
            <template #header
              ><ElSpace
                ><span
                  >{{ staffName(request.leaderId) }} · {{ formatTime(request.requestedAt) }}</span
                ><ElTag :type="request.status === 'pending' ? 'warning' : 'info'">{{
                  returnStatusLabels[request.status]
                }}</ElTag></ElSpace
              ></template
            >
            <p class="whitespace-pre-wrap">申请原因：{{ request.reason }}</p>
            <p v-if="request.processedAt" class="mt-3 text-sm text-g-500"
              >{{ staffName(request.processedBy) }} 于 {{ formatTime(request.processedAt) }} 处理</p
            >
            <p v-if="request.processReason" class="mt-2 whitespace-pre-wrap"
              >处理说明：{{ request.processReason }}</p
            >
          </ElCard>
        </ElTabPane>
        <ElTabPane :label="'完成材料 (' + order.submissions.length + ')'" name="submissions">
          <BusinessDetailHeader
            description="按提交时间展示该订单全部完成材料，历史退回和复核记录继续保留。"
            icon="ri:image-line"
          />
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
                ><span
                  >{{
                    submission.recheckBy
                      ? '财务复核申请：'
                      : submission.source === 'status-correction'
                        ? '后台登记：'
                        : '打手提交：'
                  }}{{ formatTime(submission.recheckedAt || submission.submittedAt) }}</span
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
            ><ElAlert
              v-if="submission.source === 'status-correction' && !submission.recheckBy"
              title="后台状态登记（免截图）"
              :description="
                '登记人 ' +
                staffName(submission.correctedBy || '') +
                '；' +
                (submission.correctionReason || '')
              "
              type="info"
              :closable="false"
              class="mb-4" /><ElAlert
              v-if="submission.recheckBy"
              title="财务复核（沿用原完成材料）"
              :description="
                '原材料提交于 ' +
                formatTime(submission.submittedAt) +
                '，申请人 ' +
                staffName(submission.recheckBy) +
                '；' +
                (submission.recheckReason || '')
              "
              type="info"
              :closable="false"
              class="mb-4" /><p class="text-sm mb-3"
              >负责人 {{ staffName(submission.leaderId) }} · 队友
              {{ submission.teammateId ? staffName(submission.teammateId) : '无，独自完成' }}</p
            ><BusinessDetailSummary
              :items="[
                { label: '派单轮次', value: submission.dispatchRound },
                { label: '提交时间', value: formatTime(submission.submittedAt) },
                {
                  label: '审核人',
                  value: submission.reviewerId ? staffName(submission.reviewerId) : '尚未审核'
                },
                { label: '审核时间', value: formatTime(submission.reviewedAt) }
              ]" /><ElSpace wrap
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
          ><BusinessDetailHeader
            description="展示该订单完整接单记录，当前负责人和已解除记录分别保留。"
            icon="ri:team-line" /><ArtTable
            :data="order.assignments"
            :height="360"
            :showTableHeader="false"
            ><ElTableColumn prop="dispatchRound" label="派单轮次" width="100" />
            <ElTableColumn type="expand"
              ><template #default="{ row }"
                ><BusinessDetailSection title="单次接单详情">
                  <ElDescriptions :column="2" border>
                    <ElDescriptionsItem label="负责人">{{
                      staffName(row.leaderId)
                    }}</ElDescriptionsItem>
                    <ElDescriptionsItem label="派单轮次">{{
                      row.dispatchRound ?? '未提供'
                    }}</ElDescriptionsItem>
                    <ElDescriptionsItem label="实际接单">{{
                      formatTime(row.acceptedAt)
                    }}</ElDescriptionsItem>
                    <ElDescriptionsItem label="解除时间">{{
                      formatTime(row.releasedAt)
                    }}</ElDescriptionsItem>
                    <ElDescriptionsItem label="解除原因" :span="2"
                      ><p class="whitespace-pre-wrap break-all">{{
                        row.reason || '未填写'
                      }}</p></ElDescriptionsItem
                    >
                  </ElDescriptions>
                </BusinessDetailSection></template
              ></ElTableColumn
            >
            <ElTableColumn label="负责人"
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
          ><BusinessDetailHeader
            description="显示该订单及退款最近最多 200 条授权操作记录，按最新时间排序。"
            icon="ri:history-line" /><ElTimeline class="mt-4"
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
      <BusinessDetailPanel
        page-key="order-action"
        :record-id="dialog ? `${dialog}:${orderId}` : ''"
        @restore="restoreAction"
        class="business-detail-dialog"
        :model-value="!!dialog"
        :title="dialogTitle"
        width="min(880px, 94vw)"
        append-to-body
        :close-on-click-modal="!saving && !uploading"
        :close-on-press-escape="!saving && !uploading"
        :show-close="!saving && !uploading"
        @update:model-value="updateDialogVisibility"
      >
        <BusinessDetailHeader
          :title="order.title"
          :description="actionDescription"
          icon="ri:file-list-3-line"
          :badge="statusLabels[order.status]"
          :context="order.orderNo"
        />
        <BusinessDetailSummary
          :items="[
            { label: '当前订单金额', value: money(order.amount) },
            { label: '已收款', value: money(order.receivedAmount) },
            { label: '整单打手报酬', value: money(order.reward) },
            { label: '当前负责人', value: staffName(order.leaderId || order.assignedTo) }
          ]"
        />
        <ElForm
          novalidate
          :model="fields"
          label-position="top"
          :disabled="saving || uploading"
          @submit.prevent="submitAction"
        >
          <BusinessDetailSection
            title="本次操作填写内容"
            description="请核对下方填写内容及现有业务提示；保存后保留原历史记录。"
          >
            <template v-if="dialog === 'payment'"
              ><ElFormItem label="收款方式" required
                ><ElRadioGroup v-model="fields.paymentMethod"
                  ><ElRadioButton value="cash">现金 / 平台收款</ElRadioButton
                  ><ElRadioButton value="balance">老板储值支付</ElRadioButton></ElRadioGroup
                ></ElFormItem
              >
              <ElAlert
                v-if="fields.paymentMethod === 'balance'"
                :title="`本次扣款 ${money(order.amount)}；可用储值 ${balanceLoading ? '读取中' : money(balance)}。确认后将扣款并记录付款时间；按原来源规则允许退款时退回原储值账户。`"
                type="info"
                :closable="false"
                class="mb-4" />
              <ElAlert
                v-if="fields.paymentMethod === 'balance' && balanceError"
                :title="balanceError"
                type="error"
                :closable="false"
                class="mb-4" />
              <ElFormItem label="客户实际收款金额（元）" required
                ><ElInputNumber
                  v-model="fields.amount"
                  :disabled="fields.paymentMethod === 'balance'"
                  :min="0.01"
                  :precision="2"
                  class="!w-full" /></ElFormItem
              ><ElFormItem v-if="fields.paymentMethod === 'cash'" label="客户实际付款时间" required
                ><ElDatePicker
                  v-model="fields.paidAt"
                  type="datetime"
                  value-format="YYYY-MM-DDTHH:mm:ssZ"
                  format="YYYY-MM-DD HH:mm"
                  class="!w-full" /></ElFormItem
              ><ElFormItem
                v-if="fields.paymentMethod === 'cash' && rules.requiresReceipt"
                label="付款凭证"
                required
                ><ElUpload
                  drag
                  class="payment-receipt-upload"
                  :auto-upload="false"
                  :show-file-list="false"
                  :on-change="uploadReceipt"
                  :disabled="uploading || saving"
                  accept="image/png,image/jpeg,image/webp"
                  ><p class="mb-3 text-sm text-g-500">拖动付款图片到这里，或点击上传</p
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
              ><ElAlert
                v-if="fields.paymentMethod === 'cash' && !rules.requiresReceipt"
                title="本来源免传截图，请核对实际收款和平台订单号。"
                type="info"
                :closable="false"
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
                    :label="item.name + ' · ' + playerCapacity(item.id)" /></ElSelect></ElFormItem
              ><ElAlert
                title="指定待接单不预占名额。打手本人接受时由服务器核对最新等级、开关及接单中数量；达到上限时不得新增接单。"
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
                  ? order.paymentMethod === 'balance'
                    ? '确认后退款会自动回原客户储值账户，不再重复线下转账。'
                    : '确认保存表示已完成实际退款，统计回到原付款日更新。'
                  : '申请提交财务审核，实际退款另行登记。'
              }}</p></template
            >
            <template v-if="dialog === 'edit'"
              ><ElAlert
                :title="
                  order.paymentMethod === 'balance'
                    ? '储值已支付订单的客户金额固定；可修改履约信息及报酬并记录原因，退款走原储值账户。'
                    : '保留原创建人和模板快照。已付款现金金额仅允许明确的历史录错更正，未付款改价不产生实收；实际退款单独登记，不能用改价代替追加收款。'
                "
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
                    ><ElInput v-model="fields.map" maxlength="100" /></ElFormItem></ElCol></ElRow
              ><ElFormItem label="内部备注（保留历史内容，不向打手公开）"
                ><ElInput
                  v-model="fields.remark"
                  type="textarea"
                  :rows="3"
                  maxlength="2000"
                  show-word-limit /></ElFormItem
              ><ElFormItem label="打手可见备注"
                ><ElInput
                  v-model="fields.playerRemark"
                  type="textarea"
                  :rows="3"
                  maxlength="2000"
                  show-word-limit /></ElFormItem
            ></template>
            <ElAlert
              v-if="['dispatch', 'correct-status'].includes(dialog || '') && targetsError"
              :title="targetsError"
              type="error"
              :closable="false"
              class="mb-4"
            >
              <ElButton link type="primary" @click="loadTargets">重新读取打手名额</ElButton>
            </ElAlert>
            <template v-if="dialog === 'correct-status'">
              <ElAlert
                title="后台状态更正无需上传截图。执行、验收与完成需指定实际负责人，完成需足额收款；系统同步处理财务影响并保留原因。实际退款仍需另行登记。"
                type="warning"
                :closable="false"
                class="mb-4"
              />
              <ElFormItem label="更正后状态" required
                ><ElSelect v-model="fields.status" class="w-full"
                  ><ElOption
                    v-for="(label, status) in statusLabels"
                    :key="status"
                    :value="status"
                    :label="label" /></ElSelect
              ></ElFormItem>
              <ElFormItem
                label="负责人"
                :required="['active', 'review', 'completed'].includes(fields.status)"
                ><ElSelect v-model="fields.leaderId" clearable filterable class="w-full"
                  ><ElOption
                    v-for="item in correctionPlayers"
                    :key="item.id"
                    :value="item.id"
                    :label="
                      item.name +
                      ' · ' +
                      playerCapacity(item.id) +
                      (item.status === 'disabled' ? '（已停用）' : '')
                    " /></ElSelect
              ></ElFormItem>
              <ElAlert
                v-if="correctionWarnings.length"
                title="本次后台更正包含例外情况，请核对并填写原因"
                :description="
                  correctionWarnings.join('；') + '。既有订单会保留；全部记录操作人、原因及前后值。'
                "
                type="warning"
                :closable="false"
                class="mb-4"
              />
              <ElFormItem label="队友（可选）"
                ><ElSelect v-model="fields.teammateId" clearable filterable class="w-full"
                  ><ElOption
                    v-for="item in correctionPlayers.filter((item) => item.id !== fields.leaderId)"
                    :key="item.id"
                    :value="item.id"
                    :label="
                      item.name + (item.status === 'disabled' ? '（已停用）' : '')
                    " /></ElSelect
              ></ElFormItem>
            </template>
            <ElAlert
              v-if="dialog === 'adjust'"
              title="现金改价须区分历史录错与实际交易。历史录错更正会回改原付款日实收；真实追加收费目前没有补收流程，实际退款请另行登记。"
              type="warning"
              :closable="false"
              class="mb-4"
            />
            <ElRow v-if="dialog === 'edit' || dialog === 'adjust'" :gutter="16"
              ><ElCol :xs="24" :sm="12"
                ><ElFormItem label="订单金额（元）" required
                  ><ElInputNumber
                    v-model="fields.amount"
                    :disabled="order.paymentMethod === 'balance'"
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
            <ElAlert
              v-if="cashAmountChanged && !order.receivedAmount"
              title="本次是未付款订单改价，不产生收款流水，也不增加历史实收。"
              type="info"
              :closable="false"
              class="mb-4"
            />
            <ElFormItem
              v-if="cashAmountChanged && order.receivedAmount > 0"
              label="现金历史金额更正"
              required
            >
              <ElCheckbox v-model="fields.cashAmountCorrection">
                确认仅更正历史录错：同步更正原实收及原付款日统计，未发生新收款或实际退款
              </ElCheckbox>
            </ElFormItem>
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
              v-if="dialog === 'return-approve'"
              title="批准后释放负责人及接单名额，订单进入客服待分配；请再决定指定打手或开放抢单。客户退款和打手补偿另行处理。"
              type="warning"
              :closable="false"
              class="mb-4"
            />
            <ElAlert
              v-if="dialog === 'return-reject'"
              title="驳回后保留原负责人执行，处理原因会显示给申请打手。"
              type="info"
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
              title="退回绑定当前材料。退回后保留原负责人，订单回到接单中并占用名额；即使超限仍保留此单，达到上限后禁止新增接单。"
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
          </BusinessDetailSection>
        </ElForm>
        <template #footer
          ><ElButton
            v-if="actionIntent.uncertain"
            :disabled="saving || uploading"
            @click="loadOrder(true)"
            >刷新订单并重新确认操作</ElButton
          ><ElButton :disabled="saving || uploading" @click="updateDialogVisibility(false)"
            >返回</ElButton
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
      </BusinessDetailPanel>
    </template>
    <ElEmpty
      v-else
      :description="detailLoading ? '正在读取最新订单' : '订单不存在或当前账号无权查看'"
    />
  </div>
</template>

<style scoped>
  .payment-receipt-upload {
    width: 100%;
  }

  .payment-receipt-upload :deep(.el-upload),
  .payment-receipt-upload :deep(.el-upload-dragger) {
    width: 100%;
  }

  .payment-receipt-upload :deep(.el-upload-dragger) {
    height: auto;
    padding: 24px 16px;
  }
</style>
