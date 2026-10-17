<template>
  <section class="p-page"
    ><div class="p-card">
      <label class="p-field">提现状态<select v-model="status" aria-label="提现状态" :disabled="!!busy"><option value="all">全部状态</option><option v-for="(label, value) in withdrawalStatus" :key="value" :value="value">{{ label }}</option></select></label>
      <label class="p-field">开始日期<input v-model="start" aria-label="提现开始日期" type="date" :max="end || undefined" :disabled="!!busy" /></label>
      <label class="p-field">结束日期<input v-model="end" aria-label="提现结束日期" type="date" :min="start || undefined" :disabled="!!busy" /></label>
    </div><PlayerState
      :loading="resource.loading.value && !resource.data.value"
      :error="resource.error.value || error"
      :online="resource.online.value"
      :empty="!records.length"
      empty-text="暂无提现记录"
      @retry="resource.refresh()"
    /><OperationState :operation="operation.operation.value" :online="resource.online.value" @check="checkResult" @retry="retryOriginal" /><div v-for="item in records" :key="item.id" class="p-card"
      ><div class="p-row"
        ><strong class="p-amount">¥ {{ money(item.amount) }}</strong
        ><span class="p-badge" :class="item.status">{{ withdrawalStatus[item.status] }}</span></div
      ><p class="p-hint"
        >申请于 {{ dateTime(item.createdAt) }} ·
        {{
          item.paymentMethod === 'wechat'
            ? '微信'
            : item.paymentMethod === 'alipay'
              ? '支付宝'
              : '历史提现'
        }}</p
      ><p
        v-if="item.reason"
        class="p-notice"
        :class="item.status === 'rejected' ? 'p-warning' : 'p-info'"
        >{{ item.reason }}</p
      ><p v-if="item.paidAt" class="p-hint">财务登记发放：{{ dateTime(item.paidAt) }}</p
      ><p v-if="item.canceledAt" class="p-hint">撤回时间：{{ dateTime(item.canceledAt) }}</p
      ><details v-if="item.paymentSnapshot || item.receipt" class="p-withdraw-details"
        ><summary>查看本次收款资料与付款凭证</summary
        ><p v-if="item.paymentSnapshot" class="p-hint"
          >本次申请保存的{{ item.paymentSnapshot.method === 'wechat' ? '微信' : '支付宝' }}收款码</p
        ><a
          v-if="item.paymentSnapshot?.qrCode"
          :href="item.paymentSnapshot.qrCode.url"
          target="_blank"
          rel="noopener"
          ><PrivateImage
            :src="item.paymentSnapshot.qrCode.url"
            class="p-qr-preview"
            alt="本次提现收款码快照" /></a
        ><p v-if="item.receipt" class="p-hint">财务上传的付款凭证</p
        ><a v-if="item.receipt" :href="item.receipt.url" target="_blank" rel="noopener"
          ><PrivateImage :src="item.receipt.url" class="p-qr-preview" alt="财务付款凭证" /></a></details
      ><button
        v-if="item.status === 'pending'"
        class="p-btn p-secondary p-full"
        :disabled="!!busy || operation.pending.value || resource.stale.value || !resource.online.value"
        @click="cancelTarget = item.id"
        >撤回申请</button
      ><div v-if="cancelTarget === item.id" class="p-notice p-warning p-cancel-confirm"
        ><p>撤回将释放金额及本次申请所属周的次数，保留历史记录。</p
        ><div class="p-actions"
          ><button class="p-btn p-secondary" :disabled="!!busy" @click="cancelTarget = ''"
            >保留申请</button
          ><button
            class="p-btn p-danger"
            :disabled="!!busy || operation.pending.value || resource.stale.value || !resource.online.value"
            @click="cancel(item.id)"
            >{{ busy ? '撤回中…' : '确认撤回' }}</button
          ></div
        ></div
      ></div
    ><PlayerPagination v-if="resource.data.value" :current="resource.data.value.current" :size="resource.data.value.size" :total="resource.data.value.total" :busy="resource.loading.value || !!busy" @change="page = $event" /><RouterLink to="/player/wallet" class="p-btn p-primary p-full">申请提现</RouterLink></section
  >
</template>
<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { playerApi } from '@/api/player'
  import type { PlayerRecordPage, PlayerWithdrawal } from '@/types/player'
  import { usePlayerResource, money, dateTime, withdrawalStatus } from './usePlayer'
  import { captureOperation, usePlayerOperation, operationMessage } from '@/api/operations'
  import { useSessionStore } from '@/stores/session'
  import { invalidatePlayerReads } from '@/api/readScheduler'
  import OperationState from './OperationState.vue'
  import PlayerState from './PlayerState.vue'
  import PlayerPagination from './PlayerPagination.vue'
  import PrivateImage from './PrivateImage.vue'
  const studio = useSessionStore()
  const page = ref(1), status = ref('all'), start = ref(''), end = ref('')
  const resource = usePlayerResource<PlayerRecordPage<PlayerWithdrawal> | null>(
    signal => playerApi.withdrawals({ current: page.value, size: 20, status: status.value, start: start.value, end: end.value }, signal),
    null, true, { topics: ['wallet'] }),
    error = ref(''),
    busy = ref(''),
    cancelTarget = ref('')
  const records = computed(() => resource.data.value?.records || [])
  function reloadQuery() { resource.cancel(); resource.data.value = null; cancelTarget.value = ''; void resource.refresh() }
  watch([status, start, end], () => { if (page.value !== 1) page.value = 1; else reloadQuery() })
  watch(page, reloadQuery)
  watch(() => resource.data.value, result => {
    if (result && page.value > Math.max(1, Math.ceil(result.total / result.size))) page.value = Math.max(1, Math.ceil(result.total / result.size))
  })
  const operation = usePlayerOperation('cancel-withdrawal')
  async function finish(result: Awaited<ReturnType<typeof operation.execute>>, epoch: number) {
    if (!result || epoch !== studio.epoch) return
    if (result.state === 'confirmed') { await resource.refresh(); await invalidatePlayerReads(); if (epoch === studio.epoch) cancelTarget.value = '' }
    else if (result.state === 'rejected') error.value = result.message
  }
  async function checkResult() {
    if (busy.value) return
    const epoch = studio.epoch; busy.value = 'checking'
    try { const result = await operation.check(); await finish(result, epoch); if (result && result.state !== 'confirmed') await resource.refresh() }
    finally { if (epoch === studio.epoch) busy.value = '' }
  }
  async function retryOriginal() {
    if (busy.value) return
    const epoch = studio.epoch; busy.value = 'retrying'
    try { await finish(await operation.retryOriginal(), epoch) }
    finally { if (epoch === studio.epoch) busy.value = '' }
  }
  async function cancel(id: string) {
    if (busy.value || operation.pending.value || resource.stale.value || !resource.online.value) return
    busy.value = id
    error.value = ''
    const epoch = studio.epoch
    try {
      const intent = captureOperation('cancel-withdrawal', `player/withdrawals/${encodeURIComponent(id)}/cancel`, {})
      await finish(await operation.execute(intent), epoch)
    } catch (cause) {
      if (epoch === studio.epoch) error.value = operationMessage(cause)
    } finally {
      if (epoch === studio.epoch) busy.value = ''
    }
  }
</script>
