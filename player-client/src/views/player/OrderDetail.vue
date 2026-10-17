<template>
  <section class="p-page">
    <PlayerState
      :loading="resource.loading.value && !order"
      :error="resource.error.value || actionError"
      :online="resource.online.value"
      @retry="resource.refresh()"
    />
    <OperationState v-for="item in operationStates" :key="item.family" :operation="item.operation" :online="resource.online.value" :allow-retry="!order?.historyOnly && !resource.stale.value" @check="checkOperation(item.family)" @retry="retryOperation(item.family)" />
    <div v-if="resource.error.value" class="p-actions">
      <RouterLink class="p-btn p-secondary" to="/player/tasks">返回我的任务</RouterLink>
      <RouterLink class="p-btn p-secondary" to="/player/lobby">返回订单大厅</RouterLink>
    </div>
    <template v-if="order">
      <div v-if="targetChanged && !order.historyOnly" class="p-notice p-warning" role="status"><p>订单已变化，请重新确认。已填写内容暂时保留，确认前不会提交到新一轮任务。</p><button type="button" class="p-btn p-secondary" :disabled="busy || uploading || hasPendingOperation" @click="reconfirm">重新确认当前订单</button></div>
      <p v-if="resource.stale.value && resource.online.value" class="p-notice p-info">正在核对最新订单，请等待刷新完成后再操作。</p>
      <p v-if="profile.data.value && profile.data.value.activeOrders >= profile.data.value.maxActiveOrders" class="p-notice p-info">当前执行 {{ profile.data.value.activeOrders }} / {{ profile.data.value.maxActiveOrders }} 单，暂停新增接单。已有任务仍可查看，退单待处理继续占名额。</p>
      <div class="p-card p-detail-hero"
        ><div class="p-row"
          ><span class="p-order-no">{{ order.orderNo }}</span
          ><span class="p-badge" :class="order.displayStatus || order.status">{{
            order.dispatchState === 'unassigned' && (order.displayStatus || order.status) === 'pending'
              ? '客服待分配'
              : orderStatus[order.displayStatus || order.status]
          }}</span></div
        ><h2>{{ order.title }}</h2
        ><div class="p-reward"
          ><small>订单总报酬</small><strong>¥ {{ money(order.reward) }}</strong></div
        ></div
      >
      <div v-if="order.historyOnly" class="p-card p-info" role="status">
        <h3>本人参与历史摘要</h3><p>当前已无本单私人详情及操作权限。历史参与不恢复房间码、客户信息、材料图片或旧操作。</p>
        <p v-if="order.lastParticipationAt">最后参与 {{ dateTime(order.lastParticipationAt) }}</p>
        <RouterLink class="p-btn p-secondary" to="/player/tasks?status=all">返回参与历史</RouterLink>
      </div>
      <template v-if="!order.historyOnly">
      <p v-if="order.executionBlockedReason" class="p-notice p-warning" role="status">{{ order.executionBlockedReason.message }}</p>
      <div v-if="order.storage" class="p-card">
        <h3>{{ order.storage.active ? '订单已存单' : '存单恢复记录' }}</h3>
        <p class="p-preline">{{ order.storage.reason }}</p>
        <p class="p-hint">存单时间 {{ dateTime(order.storage.storedAt) }}<template v-if="order.storage.resumedAt"> · 恢复时间 {{ dateTime(order.storage.resumedAt) }}</template></p>
        <p v-if="order.storage.active" class="p-hint">本单暂时停止履约，不占接单名额，已做进度与原接单历史保留。请等待后台恢复安排。</p>
        <p v-if="order.capacityExempt" class="p-notice p-info">本单由存单恢复给原负责人继续完成，本轮不占接单名额。请按当前订单要求继续服务。</p>
      </div>
      <div v-if="problemRecords.length" class="p-card">
        <h3>问题单与处理记录</h3>
        <div v-for="problem in problemRecords" :key="problem.id" class="p-history">
          <div class="p-row"><strong>{{ problem.status === 'open' ? '问题处理中' : '问题已关闭' }}</strong><span class="p-muted">{{ dateTime(problem.openedAt) }}</span></div>
          <p class="p-preline">{{ problem.reason }}</p>
          <div v-for="feedback in problem.feedback" :key="feedback.id" class="p-problem-feedback">
            <p><strong>{{ feedback.userName }}</strong> · {{ dateTime(feedback.createdAt) }}</p><p class="p-preline">{{ feedback.message }}</p>
          </div>
          <p v-if="problem.status === 'closed'" class="p-hint">后台确认：{{ problem.resolution || '已确认解决' }} · {{ dateTime(problem.closedAt) }}</p>
        </div>
        <form v-if="canFeedback" @submit.prevent="submitProblemFeedback">
          <p class="p-hint">提交处理情况后由后台确认关闭。反馈不会改变订单履约状态或接单名额。</p>
          <label class="p-field">处理反馈<textarea v-model.trim="problemMessage" required maxlength="1000" rows="3" placeholder="说明问题处理情况，等待后台确认" :disabled="blocked" /></label>
          <button class="p-btn p-primary p-full" :disabled="blocked || !problemMessage || !resource.online.value">{{ busy ? '正在提交…' : '提交问题反馈' }}</button>
        </form>
      </div>
      <div class="p-card"
        ><h3>服务要求</h3><p class="p-preline">{{ order.requirements || '请按订单要求完成服务' }}</p
        ><div class="p-player-remark"><h3>打手备注</h3><p class="p-preline">{{ order.playerRemark?.trim() || '暂无补充说明' }}</p></div><dl class="p-detail-list"
          ><div v-if="order.map"
            ><dt>地图 / 项目</dt><dd>{{ order.map }}</dd></div
          ><div
            ><dt>派单方式</dt
            ><dd>{{ order.dispatchMode === 'direct' ? '指定派单' : '公共抢单' }}</dd></div
          ><div
            ><dt>发布时间</dt><dd>{{ dateTime(order.publishedAt || order.createdAt) }}</dd></div
          ><div v-if="order.roomCode"
            ><dt>房间码</dt><dd>{{ order.roomCode }}</dd></div
          ><div v-if="order.gameId"
            ><dt>游戏 ID</dt><dd>{{ order.gameId }}</dd></div
          ></dl
        ></div
      >
      <div v-if="canAccept" class="p-card"
        ><h3>{{ order.dispatchMode === 'direct' ? '指定给你的订单' : '接取订单' }}</h3
        ><p class="p-hint">接受后进入接单中。详情只显示本次执行需要的信息。</p
        ><div class="p-actions"
          ><button
            v-if="order.dispatchMode === 'direct'"
            class="p-btn p-secondary"
            :disabled="blocked || !resource.online.value"
            @click="mode = mode === 'reject' ? '' : 'reject'"
            >拒绝指定</button
          ><button
            class="p-btn p-primary"
            :disabled="blocked || !resource.online.value || order.canClaim !== true || !hasDispatchTarget"
            @click="claim"
            >{{ busy ? '处理中…' : '接受订单' }}</button
          ></div
        ><form v-if="mode === 'reject'" @submit.prevent="reject"
          ><label class="p-field"
            >拒绝原因<textarea
              v-model.trim="reason"
              required
              maxlength="1000"
              rows="3"
              placeholder="填写原因，订单将交回客服重新分配"
            /></label
          ><button
            class="p-btn p-danger p-full"
            :disabled="blocked || !reason || !resource.online.value || !hasDispatchTarget"
            >确认拒绝</button
          ></form
        ></div
      >
      <p v-if="canAccept && order.canClaim !== true" class="p-notice p-warning">{{ order.claimBlockedReason?.message || '当前不能接单，请刷新后查看最新安排。' }}</p>
      <p
        v-if="order.status === 'pending' && order.dispatchState === 'unassigned'"
        class="p-notice p-info"
        >本单已交回客服待分配。原拒单或退单记录保留，请以客服重新安排为准。</p
      >
      <div v-if="isLeader && order.status === 'active' && !order.executionBlockedReason" class="p-card"
        ><h3>提交完成材料</h3
        ><p v-if="order.paymentConfirmed === false" class="p-notice p-warning">付款尚未确认，请联系后台确认付款。足额收款后才可正常上报。</p
        ><p v-if="order.canSubmit !== true" class="p-notice p-warning">{{ order.submitBlockedReason?.message || '当前暂不能上报，请刷新订单或联系后台。' }}</p
        ><p class="p-hint"
          >上传 1～10 张截图，单张不超过 8 MB。支持 JPG、PNG、WebP。财务验收通过后才结算报酬。</p
        ><div class="p-upload-grid"
          ><div v-for="(image, index) in screenshots" :key="image.id" class="p-upload-thumb"
            ><a :href="image.url" target="_blank" rel="noopener"
              ><PrivateImage :src="image.url" :context="`${order.id}:${order.revision}`" :alt="`完成截图 ${index + 1}`" /></a
            ><button
              class="p-remove-image"
              aria-label="删除截图"
              :disabled="blocked || uploading"
              @click="screenshots.splice(index, 1)"
              ><PlayerIcon name="close" /></button></div
          ><label v-if="screenshots.length < 10" class="p-upload-button"
            ><PlayerIcon name="plus" /><span>{{ uploading ? '上传中…' : '添加截图' }}</span
            ><input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              :disabled="uploading || blocked || !resource.online.value"
              @change="upload" /></label></div
        ><div v-for="(item, index) in uploadItems" :key="index" class="p-upload-state" role="status"><span class="p-upload-filename">{{ item.file.name }}</span><span>{{ item.phase === 'preparing' ? '正在处理图片' : item.phase === 'uploading' ? '正在上传' : item.phase === 'done' ? '已上传' : '上传未完成' }} {{ item.percent }}%</span><progress v-if="item.phase === 'preparing' || item.phase === 'uploading'" :value="item.percent" max="100" aria-label="截图上传进度" /><p v-if="item.error">{{ item.error }}</p><button v-if="item.phase === 'error'" type="button" class="p-btn p-secondary" :disabled="uploading || blocked || !resource.online.value" @click="uploadOne(item)">重试这张图片</button></div><label class="p-field"
          >实际参与队友（可选）<select v-model="teammateId" aria-label="实际参与队友（可选）" :disabled="blocked"
            ><option value="">单人完成</option
            ><option v-for="mate in teammates" :key="mate.id" :value="mate.id">{{
              mate.name
            }}</option></select
          ></label
        ><p v-if="teammateId" class="p-notice p-info"
          >双人平分：负责人 ¥{{ money(Math.ceil(order.reward / 2)) }}，队友 ¥{{
            money(Math.floor(order.reward / 2))
          }}。由财务核对。</p
        ><button
          class="p-btn p-primary p-full"
          :disabled="blocked || uploading || !screenshots.length || !resource.online.value || order.canSubmit !== true || order.paymentConfirmed !== true || !hasAssignmentTarget"
          @click="submit"
          >{{ busy ? '正在提交…' : '提交完成，等待验收' }}</button
        ></div
      >
      <div v-if="isLeader && order.status === 'active' && !order.executionBlockedReason" class="p-card"
        ><h3>申请退单</h3><p class="p-hint">客服批准前仍需负责本单。{{ order.capacityExempt ? '本单沿用存单续做免名额规则。' : '退单待处理继续占用接单名额。' }}</p
        ><p v-if="pendingReturn" class="p-notice p-warning">退单申请正在处理中，请等待客服结果。</p
        ><form v-else @submit.prevent="requestReturn"
          ><label class="p-field"
            >退单原因<textarea
              v-model.trim="returnReason"
              required
              maxlength="1000"
              rows="3"
              placeholder="说明无法继续执行的原因"
            /></label
          ><button
            class="p-btn p-secondary p-full"
            :disabled="blocked || !returnReason || !resource.online.value || !hasAssignmentTarget"
            >提交退单申请</button
          ></form
        ></div
      >
      <div v-if="order.rejections?.length" class="p-card">
        <h3>拒单记录</h3>
        <div v-for="rejection in order.rejections" :key="rejection.id" class="p-history">
          <div class="p-row"
            ><strong>已拒绝指定订单</strong
            ><span class="p-muted">{{ dateTime(rejection.rejectedAt) }}</span></div
          >
          <p>{{ rejection.reason }}</p>
        </div>
      </div>
      <div v-if="order.returnRequests?.length" class="p-card"
        ><h3>退单处理记录</h3
        ><div v-for="request in order.returnRequests" :key="request.id" class="p-history"
          ><div class="p-row"
            ><strong>{{ returnStatus[request.status] }}</strong
            ><span class="p-muted">{{
              dateTime(request.requestedAt || request.createdAt)
            }}</span></div
          ><p>{{ request.reason }}</p
          ><p
            v-if="request.processReason || request.processingReason || request.responseReason"
            class="p-hint"
            >处理说明：{{
              request.processReason || request.processingReason || request.responseReason
            }}</p
          ></div
        ></div
      >
      <div v-if="order.submissions?.length" class="p-card"
        ><h3>提交与验收记录</h3
        ><div
          v-for="submission in [...order.submissions].reverse()"
          :key="submission.id"
          class="p-history"
          ><div class="p-row"
            ><strong>{{
              submission.source === 'status-correction' ? '后台登记 / 状态更正' : '完成上报'
            }}</strong
            ><span class="p-muted">{{ dateTime(submission.submittedAt) }}</span></div
          ><p v-if="submission.source === 'status-correction'" class="p-hint">{{
            submission.correctionReason || '后台已登记订单状态，此记录无需完成截图。'
          }}</p
          ><div v-if="submission.screenshots?.length" class="p-image-grid"
            ><template v-for="image in submission.screenshots" :key="image.id">
              <div v-if="image.retentionStatus === 'deleted'" class="p-hint"
                >订单完成满30天，图片已删除</div
              >
              <a v-else :href="image.url" target="_blank" rel="noopener"
                ><PrivateImage :src="image.url" :context="`${order.id}:${order.revision}`" :alt="image.name || '完成截图'" /></a>
            </template></div
          ><p v-if="submission.review" class="p-hint"
            >验收：{{
              ['approved', 'passed'].includes(submission.review)
                ? '已通过'
                : ['rejected', 'returned'].includes(submission.review)
                  ? '已退回'
                  : '等待验收'
            }}
            {{ dateTime(submission.reviewedAt) }}</p
          ><p v-if="submission.reason" class="p-notice p-warning">{{ submission.reason }}</p></div
        ></div
      >
      <p v-if="order.status === 'review' && !order.executionBlockedReason" class="p-notice p-info"
        >正在等待财务验收，本单已释放接单名额。验收通过后报酬计入钱包。</p
      >
      </template>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { playerApi } from '@/api/player'
import type { Attachment } from '@/types/studio'
import type { PlayerOrder, PlayerProfile } from '@/types/player'
import { captureOperation, usePlayerOperation, operationMessage } from '@/api/operations'
import { assignmentTarget, dispatchTarget, problemFeedbackTarget, orderSnapshot, orderTargetKey } from '@/api/orderTarget'
import { invalidatePlayerReads } from '@/api/readScheduler'
import { readOrderDraft, saveOrderDraft, clearOrderDraft } from '@/stores/orderDrafts'
import { safeApiMessage, isAbortError } from '@/api/studio'
import { usePlayerResource, money, dateTime, orderStatus } from './usePlayer'
import PlayerState from './PlayerState.vue'
import PlayerIcon from './PlayerIcon.vue'
import OperationState from './OperationState.vue'
import PrivateImage from './PrivateImage.vue'

const route = useRoute(), studio = useSessionStore()
const viewEpoch = studio.epoch
const resource = usePlayerResource<PlayerOrder | null>(signal => playerApi.order(String(route.params.id), signal), null, true, { topics: ['orders'] })
const profile = usePlayerResource<PlayerProfile | null>(playerApi.profile, null, true, { topics: ['orders', 'profile'] })
const teammateResource = usePlayerResource(playerApi.teammates, [], true, { topics: ['profile'] })
const order = computed(() => resource.data.value?.id === String(route.params.id) ? resource.data.value : null)
const isLeader = computed(() => !order.value?.historyOnly && order.value?.leaderId === studio.user?.id)
const pendingReturn = computed(() => order.value?.returnRequests?.some(item => item.status === 'pending'))
const canAccept = computed(() => !order.value?.historyOnly && !order.value?.executionBlockedReason && order.value?.status === 'pending' && order.value.dispatchState !== 'unassigned' && (order.value.dispatchMode === 'pool' || order.value.assignedTo === studio.user?.id))
const problemRecords = computed(() => [...(order.value?.problem ? [order.value.problem] : []), ...(order.value?.problemHistory || [])].filter((item, index, records) => records.findIndex(other => other.id === item.id) === index))
const canFeedback = computed(() => !order.value?.historyOnly && order.value?.problem?.status === 'open' && (!!order.value.assignmentId || order.value.status === 'completed') && !!order.value.leaderId && !!studio.user?.id && [order.value.leaderId, order.value.teammateId].includes(studio.user.id))
const problemMessage = ref('')
const mode = ref(route.query.action === 'reject' ? 'reject' : ''), reason = ref(''), returnReason = ref(''), busy = ref(false), uploading = ref(false), actionError = ref(''), screenshots = ref<Attachment[]>([]), teammateId = ref(''), target = ref<PlayerOrder | null>(null)
const teammates = computed(() => teammateResource.data.value)
const actions = { claim: usePlayerOperation('claim'), reject: usePlayerOperation('reject'), return: usePlayerOperation('return'), submit: usePlayerOperation('submit'), 'problem-feedback': usePlayerOperation('problem-feedback') }
type Family = keyof typeof actions
const operationStates = computed(() => Object.entries(actions).map(([family, controller]) => ({ family: family as Family, operation: controller.operation.value })))
const hasPendingOperation = computed(() => Object.values(actions).some(item => item.pending.value))
const targetChanged = computed(() => !!order.value && !!target.value && orderTargetKey(order.value) !== orderTargetKey(target.value))
const blocked = computed(() => order.value?.historyOnly || busy.value || hasPendingOperation.value || targetChanged.value || resource.stale.value)
const hasDispatchTarget = computed(() => Number.isSafeInteger(order.value?.revision) && Number.isSafeInteger(order.value?.dispatchRound))
const hasAssignmentTarget = computed(() => Number.isSafeInteger(order.value?.revision) && !!order.value?.assignmentId && order.value?.leaderId === studio.user?.id)
interface UploadItem { file: File; phase: 'preparing' | 'uploading' | 'done' | 'error'; percent: number; error: string }
const uploadItems = ref<UploadItem[]>([])
let uploadController: AbortController | null = null
const returnStatus = { pending: '等待客服处理', approved: '已批准退单', rejected: '已驳回，继续执行', obsolete: '申请已失效' }
function rememberDraft() {
  if (target.value && !order.value?.historyOnly && viewEpoch === studio.epoch) saveOrderDraft(target.value.id, { target: target.value, reason: reason.value, returnReason: returnReason.value, problemMessage: problemMessage.value, teammateId: teammateId.value, screenshots: screenshots.value })
}
watch(() => route.params.id, () => {
  rememberDraft()
  resource.cancel(); uploadController?.abort(); uploadController = null; uploading.value = false
  target.value = null; screenshots.value = []; uploadItems.value = []; teammateId.value = ''; reason.value = ''; returnReason.value = ''; problemMessage.value = ''; actionError.value = ''; busy.value = false
  resource.data.value = null
  void resource.refresh()
})
watch(order, value => {
  if (!value) return
  if (value.historyOnly) {
    uploadController?.abort(); uploadController = null; uploading.value = false
    clearOrderDraft(value.id)
    target.value = null; screenshots.value = []; uploadItems.value = []; teammateId.value = ''; reason.value = ''; returnReason.value = ''; problemMessage.value = ''; mode.value = ''; actionError.value = ''
    return
  }
  if (!target.value) {
    const saved = readOrderDraft(value.id)
    if (saved) { target.value = saved.target; reason.value = saved.reason; returnReason.value = saved.returnReason; problemMessage.value = saved.problemMessage || ''; teammateId.value = saved.teammateId; screenshots.value = saved.screenshots }
    else target.value = orderSnapshot(value)
  }
  if (targetChanged.value) uploadController?.abort()
}, { flush: 'sync' })
watch([reason, returnReason, problemMessage, teammateId, screenshots], rememberDraft, { deep: true })
onBeforeUnmount(() => { rememberDraft(); uploadController?.abort() })
function reconfirm() {
  if (!order.value || order.value.historyOnly || hasPendingOperation.value) return
  const changedRound = target.value && (target.value.assignmentId !== order.value.assignmentId || target.value.dispatchRound !== order.value.dispatchRound || target.value.submissionId !== order.value.submissionId || target.value.leaderId !== order.value.leaderId)
  if (changedRound) { screenshots.value = []; uploadItems.value = []; teammateId.value = '' }
  if (target.value?.problem?.id !== order.value.problem?.id) problemMessage.value = ''
  target.value = orderSnapshot(order.value); mode.value = ''
  actionError.value = changedRound ? '执行轮次已更新，请为当前任务重新选择完成材料。' : ''
  Object.values(actions).forEach(item => item.dismiss())
  rememberDraft()
}
async function finishOperation(family: Family, result: Awaited<ReturnType<typeof actions.claim.execute>>, id: string, epoch: number) {
  if (!result || epoch !== studio.epoch || id !== String(route.params.id)) return
  const expectedPath = `player/orders/${encodeURIComponent(id)}/${family === 'return' ? 'return-request' : family}`
  if (result.path !== expectedPath) { if (result.state === 'confirmed') await invalidatePlayerReads(); return }
  if (result.state === 'confirmed') {
    await resource.refresh(); await invalidatePlayerReads()
    if (epoch !== studio.epoch || id !== String(route.params.id)) return
    mode.value = ''; reason.value = ''; returnReason.value = ''
    if (family === 'submit') { screenshots.value = []; uploadItems.value = [] }
    if (family === 'problem-feedback') problemMessage.value = ''
    clearOrderDraft(id)
    if (order.value && !order.value.historyOnly) target.value = orderSnapshot(order.value)
  } else if (result.state === 'rejected') { actionError.value = result.message; await resource.refresh() }
}
async function run(family: Family, body: Record<string, unknown>) {
  if (blocked.value || !target.value || !resource.online.value) return
  const viewed = orderSnapshot(target.value), epoch = studio.epoch
  busy.value = true; actionError.value = ''
  try {
    const path = `player/orders/${encodeURIComponent(viewed.id)}/${family === 'return' ? 'return-request' : family}`
    const goal = family === 'claim' || family === 'reject' ? dispatchTarget(viewed) : family === 'problem-feedback' ? problemFeedbackTarget(viewed, studio.user!.id) : assignmentTarget(viewed, studio.user!.id)
    const intent = captureOperation(family, path, { ...goal, ...body })
    rememberDraft()
    await finishOperation(family, await actions[family].execute(intent), viewed.id, epoch)
  } catch (cause) {
    if (epoch === studio.epoch && viewed.id === String(route.params.id)) { actionError.value = operationMessage(cause); await resource.refresh() }
  } finally { if (epoch === studio.epoch && viewed.id === String(route.params.id)) busy.value = false }
}
function claim() { if (order.value?.canClaim === true) return run('claim', {}) }
function reject() { return run('reject', { reason: reason.value }) }
function requestReturn() { return run('return', { reason: returnReason.value }) }
function submit() {
  if (order.value?.canSubmit !== true || order.value.paymentConfirmed !== true) return
  return run('submit', { screenshots: screenshots.value, teammateId: teammateId.value || null })
}
function submitProblemFeedback() {
  if (!canFeedback.value || !problemMessage.value || order.value?.problem?.id !== target.value?.problem?.id) return
  return run('problem-feedback', { problemId: target.value!.problem!.id, message: problemMessage.value })
}
async function checkOperation(family: Family) {
  if (busy.value) return
  const id = String(route.params.id), epoch = studio.epoch
  busy.value = true
  try {
    const result = await actions[family].check()
    if (result?.state === 'confirmed') await finishOperation(family, result, id, epoch)
    else if (result) await resource.refresh()
  } finally { if (epoch === studio.epoch && id === String(route.params.id)) busy.value = false }
}
async function retryOperation(family: Family) {
  if (busy.value || order.value?.historyOnly || resource.stale.value) return
  const id = String(route.params.id), epoch = studio.epoch
  busy.value = true
  try { await finishOperation(family, await actions[family].retryOriginal(), id, epoch) }
  finally { if (epoch === studio.epoch && id === String(route.params.id)) busy.value = false }
}
async function uploadOne(item: UploadItem) {
  if (uploading.value || blocked.value || !target.value || screenshots.value.length >= 10) {
    item.phase = 'error'; item.error = '上传已暂停，请核对当前订单后重试。'; return
  }
  const epoch = studio.epoch, key = orderTargetKey(target.value), id = String(route.params.id)
  const controller = new AbortController()
  uploadController = controller; uploading.value = true; item.error = ''; item.phase = 'preparing'
  try {
    const result = await playerApi.upload(item.file, { signal: controller.signal, kind: 'evidence', onProgress: progress => { if (epoch === studio.epoch && id === String(route.params.id)) { item.phase = progress.phase; item.percent = progress.percent } } })
    if (epoch !== studio.epoch || !target.value || id !== String(route.params.id) || key !== orderTargetKey(target.value)) return
    screenshots.value.push(result); item.phase = 'done'; item.percent = 100; rememberDraft()
  } catch (cause) { item.phase = 'error'; item.error = isAbortError(cause) ? '上传已暂停，请重新确认订单后重试。' : safeApiMessage(cause, '图片上传未完成，请核对后重试') }
  finally { if (epoch === studio.epoch && id === String(route.params.id)) uploading.value = false; if (uploadController === controller) uploadController = null }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, files = Array.from(input.files || [])
  if (!target.value || blocked.value) { input.value = ''; return }
  const epoch = studio.epoch, id = String(route.params.id), key = orderTargetKey(target.value)
  if (screenshots.value.length + files.length > 10) { actionError.value = '最多上传 10 张截图'; input.value = ''; return }
  actionError.value = ''
  for (const file of files) {
    if (epoch !== studio.epoch || id !== String(route.params.id) || !target.value || orderTargetKey(target.value) !== key || blocked.value) break
    const item: UploadItem = { file, phase: 'preparing', percent: 0, error: '' }
    uploadItems.value.push(item)
    await uploadOne(uploadItems.value[uploadItems.value.length - 1]!)
    if (targetChanged.value || resource.stale.value) break
  }
  input.value = ''
}
</script>

