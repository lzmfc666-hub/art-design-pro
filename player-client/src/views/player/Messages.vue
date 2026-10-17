<template>
  <section class="p-page">
    <div class="p-section-title"><h2>站内消息 <span>{{ resource.data.value.unread }} 条未读</span></h2>
      <button class="p-text-btn" :disabled="busy || !resource.online.value || !resource.data.value.unread" @click="readAll">全部已读</button>
    </div>
    <p class="p-notice p-info">新单提醒是邀请查看。已读不代表接单，只有订单接受成功后才成为执行任务。</p>
    <PlayerState :loading="resource.loading.value && !resource.data.value.records.length" :error="resource.error.value || error"
      :online="resource.online.value" :empty="!resource.data.value.records.length" empty-text="暂时没有消息"
      hint="指定订单、问题单、存单恢复、退款、验收和提现进展会保留在这里" @retry="resource.refresh()" />
    <div v-if="selected" class="p-card p-message-current" aria-live="polite">
      <div class="p-section-title"><h3>{{ selected.title }}</h3><button class="p-text-btn" @click="selected = null">返回消息</button></div>
      <p>{{ selected.message }}</p>
      <div class="p-actions"><button v-if="selected.path" class="p-btn p-primary" @click="viewCurrent">查看当前{{ selected.order ? '订单' : '记录' }}</button>
        <button v-else class="p-btn p-secondary" @click="router.push('/player/tasks')">查看我的任务</button>
      </div>
    </div>
    <button v-for="item in resource.data.value.records" :key="item.id" :data-notification-id="item.id" class="p-card p-message" :class="{ unread: !item.readAt }"
      :disabled="busy || !resource.online.value" @click="open(item)">
      <span class="p-message-icon"><PlayerIcon name="bell" /></span><div>
        <div class="p-row"><strong>{{ item.title }}</strong><span v-if="!item.readAt" class="p-message-dot" /></div>
        <p>{{ item.body || item.message }}</p><small>{{ notificationLabel(item) }} · {{ dateTime(item.createdAt) }}</small>
      </div><PlayerIcon v-if="item.target || item.orderId || item.href || item.link" name="next" />
    </button>
    <div v-if="resource.data.value.total > resource.data.value.size" class="p-actions">
      <button class="p-btn p-secondary" :disabled="page === 1 || resource.loading.value || busy" @click="page--">上一页</button>
      <span class="p-muted">{{ page }} / {{ Math.ceil(resource.data.value.total / resource.data.value.size) }}</span>
      <button class="p-btn p-secondary" :disabled="page * resource.data.value.size >= resource.data.value.total || resource.loading.value || busy" @click="page++">下一页</button>
    </div>
    <p class="p-hint p-center">消息保留发送时的提醒，当前资格和业务结果以最新订单及记录为准。</p>
  </section>
</template>
<script setup lang="ts">
  import { ref, watch, onDeactivated, onBeforeUnmount } from 'vue'
  import { useRouter } from 'vue-router'
  import { playerApi } from '@/api/player'
  import { useSessionStore } from '@/stores/session'
  import type { PlayerNotification, PlayerNotifications, PlayerOrder } from '@/types/player'
  import { usePlayerResource, dateTime, orderStatus } from './usePlayer'
  import PlayerState from './PlayerState.vue'
  import PlayerIcon from './PlayerIcon.vue'
  const router = useRouter(), session = useSessionStore(), page = ref(1), error = ref(''), busy = ref(false)
  const selected = ref<{ title: string; message: string; path?: string; order?: boolean } | null>(null)
  const resource = usePlayerResource<PlayerNotifications>((signal) => playerApi.notifications(page.value, signal),
    { records: [], total: 0, unread: 0, current: 1, size: 30 })
  let controller: AbortController | null = null, generation = 0
  function cancelReading() { generation++; controller?.abort(); controller = null; busy.value = false; selected.value = null }
  onDeactivated(cancelReading); onBeforeUnmount(cancelReading)
  watch(() => session.epoch, cancelReading)
  watch(page, () => { selected.value = null; void resource.refresh() })
  const notificationLabels: Record<string, string> = { 'problem-open': '问题单提醒', 'problem-closed': '问题处理进展', 'order-stored': '存单提醒', 'order-resumed': '存单恢复', 'refund-result': '退款进展' }
  const notificationLabel = (item: PlayerNotification) => item.invalidatedAt ? '提醒已失效，请重新确认' : ['assigned', 'pool'].includes(item.type || item.kind || '') ? '新单提醒，仍需接受' : notificationLabels[item.type || item.kind || ''] || '业务进展'
  async function readAll() {
    if (busy.value) return
    busy.value = true; error.value = ''
    const epoch = session.epoch, token = generation
    try { await playerApi.readAllNotifications(); if (epoch === session.epoch && token === generation) await resource.refresh() }
    catch (cause) { if (epoch === session.epoch && token === generation) error.value = cause instanceof Error ? cause.message : '操作失败' }
    finally { if (epoch === session.epoch && token === generation) busy.value = false }
  }
  function currentMessage(order: PlayerOrder, item: PlayerNotification) {
    const kind = item.type || item.kind || '', newOrder = kind === 'assigned' || kind === 'pool'
    const statusLabel = orderStatus[order.displayStatus || order.status] || '已更新'
    const target = item.target
    if (target && ((target.dispatchRound !== null && target.dispatchRound !== order.dispatchRound) ||
      (target.assignmentId !== null && target.assignmentId !== order.assignmentId) ||
      (target.submissionId !== null && target.submissionId !== order.submissionId) ||
      (target.problemId != null && target.problemId !== order.problem?.id)))
      return `${item.invalidatedAt ? '这条提醒已失效，请重新确认当前订单。' : ''}这条提醒对应的旧派单、接单或材料目标已变化。当前状态：${statusLabel}。请重新确认当前订单，旧提醒不能用于提交操作。`
    if (item.invalidatedAt) return `这条提醒已失效，请重新确认当前订单。当前状态：${statusLabel}。历史提醒不代表本轮仍待你接受；请进入当前订单重新查看。`
    if (order.fullRefund || order.displayStatus === 'refunded') return '订单已全额退款，不能继续接单、上报或验收。问题反馈与历史处理记录请在当前订单查看。'
    if (order.refundPending || order.displayStatus === 'refund-pending') return '订单正在退款审批中，暂停接单、上报及验收。请查看当前订单，等待后台处理。'
    if (order.stored || order.displayStatus === 'stored') return '订单已存单，暂时停止履约且不占接单名额。请查看存单原因，等待后台恢复安排。'
    if (kind === 'problem-open' || kind === 'problem-closed') return order.problem?.status === 'open'
      ? `本单有待处理问题。当前状态：${statusLabel}。请进入订单查看原因并提交处理反馈，由后台确认关闭。`
      : `请查看当前问题处理记录。当前状态：${statusLabel}。历史提醒不会重新打开已经关闭的问题。`
    if (kind === 'order-resumed' && order.capacityExempt) return '存单已恢复到原负责人任务列表，本轮续做不占接单名额。请进入任务核对当前要求。'
    if (order.status === 'canceled') return '订单已取消，这条提醒不再代表可接单。可以查看当前处理记录。'
    if (order.status === 'completed') return '订单已完成，请查看当前记录；历史提醒不会重新创建任务。'
    if (order.status === 'pending') {
      if (newOrder && (order.dispatchState === 'unassigned' || (kind === 'assigned' && (order.dispatchMode !== 'direct' || order.assignedTo !== session.user?.id))))
        return '订单已交回后台或重新分配，这条提醒不再代表本轮指定。请查看当前订单或返回消息中心。'
      if (kind === 'assigned') return '当前订单仍待你本人接受。阅读消息不代表已接单，请进入订单核对要求和接单资格。'
      return '当前订单待接单，请进入订单重新核对要求与接单资格；提醒发送后资格或轮次可能已变化。'
    }
    if (newOrder && order.leaderId !== session.user?.id) return '订单已被接取或重新分配，请查看最新状态；本次提醒不能继续接单。'
    if (order.status === 'active') return order.leaderId === session.user?.id
      ? '当前已经接受，订单在执行中。请进入任务查看最新状态与要求。'
      : '当前订单已有负责人，请以最新任务记录为准。'
    return `当前状态：${statusLabel}。请进入订单查看当前处理记录。`
  }
  async function open(item: PlayerNotification) {
    if (busy.value || !resource.online.value) return
    busy.value = true; error.value = ''; selected.value = null
    const token = ++generation, epoch = session.epoch
    let destination = ''
    controller = new AbortController()
    try {
      // Read the exact message again even if paging or a new message moved it off this page.
      // Its target confirms the old invitation; current order GET alone grants current access.
      const confirmedNotice = await playerApi.notification(item.id, controller.signal)
      if (token !== generation || epoch !== session.epoch) return
      Object.assign(item, confirmedNotice)
      const orderId = confirmedNotice.target?.orderId || confirmedNotice.orderId
      if (orderId) {
        try {
          const order = await playerApi.order(orderId, controller.signal)
          if (token !== generation || epoch !== session.epoch) return
          const target = confirmedNotice.target
          const targetChanged = !!target && ((target.dispatchRound !== null && target.dispatchRound !== order.dispatchRound) ||
            (target.assignmentId !== null && target.assignmentId !== order.assignmentId) ||
            (target.submissionId !== null && target.submissionId !== order.submissionId) ||
            (target.problemId != null && target.problemId !== order.problem?.id))
          selected.value = { title: item.invalidatedAt ? '这条提醒已失效' : targetChanged ? '旧提醒目标已变化' : '已核对当前订单',
            message: currentMessage(order, confirmedNotice),
            ...(!order.historyOnly ? { path: `/player/orders/${encodeURIComponent(order.id)}` } : {}), order: true }
        } catch (cause) {
          if (token !== generation || epoch !== session.epoch) return
          const status = (cause as { status?: number }).status
          if (![403, 404, 409].includes(status || 0)) throw cause
          selected.value = { title: item.invalidatedAt ? '这条提醒已失效' : '这条订单提醒已变化', message: `${item.invalidatedAt ? '这条提醒已失效，请重新确认当前订单。' : ''}订单可能已被接取、取消或重新分配，当前账号无法继续查看。可以返回消息中心或查看我的任务。` }
        }
      } else {
        const path = (confirmedNotice.href || confirmedNotice.link || '').replace(/^\/?#/, '')
        if (/^\/player\/(withdrawals|wallet|ledger|tasks|lobby|deposit)(?:[?#]|$)/.test(path)) {
          destination = path
        } else selected.value = { title: '业务提醒', message: item.body || item.message || '请查看站内消息和当前业务记录。' }
      }
      if (token !== generation || epoch !== session.epoch) return
      if (!item.readAt) {
        await playerApi.readNotification(item.id)
        if (token !== generation || epoch !== session.epoch) return
        item.readAt = new Date().toISOString()
        resource.data.value.unread = Math.max(0, resource.data.value.unread - 1)
      }
      if (destination && token === generation && epoch === session.epoch) await router.push(destination)
    } catch (cause) {
      if (token === generation && epoch === session.epoch) {
        if ((cause as { status?: number }).status === 404) selected.value = { title: '这条消息已不可读取', message: '请查看当前消息列表与本人任务。历史消息不会恢复详情权限。' }
        else error.value = cause instanceof Error ? cause.message : '读取失败，请重试'
      }
    }
    finally { if (token === generation && epoch === session.epoch) { busy.value = false; controller = null } }
  }
  async function viewCurrent() {
    if (selected.value?.path) await router.push(selected.value.path)
  }
</script>
<style scoped>
  .p-message-current p { line-height: 1.65; overflow-wrap: anywhere; }
  .p-message-current .p-actions { margin-top: 16px; }
  .p-message:disabled { opacity: 0.75; }
</style>
