<template>
  <section class="p-page">
    <PlayerState
      :loading="resource.loading.value && !wallet"
      :error="resource.error.value || error"
      :online="resource.online.value"
      @retry="resource.refresh()"
    />
    <OperationState :operation="operation.operation.value" :online="resource.online.value" @check="checkResult" @retry="retryOriginal" />
    <template v-if="wallet">
      <div class="p-card p-wallet-preview"
        ><span>可提现报酬</span><strong>¥ {{ money(wallet.available) }}</strong
        ><div class="p-wallet-stats"
          ><div
            ><span>在途提现</span><b>¥ {{ money(wallet.occupied) }}</b></div
          ><div
            ><span>财务已登记发放</span><b>¥ {{ money(wallet.paid) }}</b></div
          ></div
        ></div
      >
      <div v-if="success" class="p-notice p-success">{{ success }}</div>
      <form class="p-card" @submit.prevent="withdraw"
        ><div class="p-section-title"
          ><h3>申请提现</h3><span class="p-badge active">手续费 0</span></div
        ><p class="p-hint"
          >本周已用 {{ wallet.weeklyUsed }} / {{ wallet.weeklyLimit }} 次，剩余
          {{ wallet.weeklyRemaining }} 次。北京时间周一重置。</p
        ><p v-if="studio.user?.playerAccess?.withdraw === false" class="p-notice p-warning"
          >后台已关闭新提现申请，请联系财务。</p
        ><label class="p-field"
          >提现金额（元）<div class="p-amount-input"
            ><span>¥</span
            ><input
              v-model="amount"
              aria-label="提现金额（元）"
              type="text"
              inputmode="decimal"
              required
              :disabled="busy || operation.pending.value"
              placeholder="最低 0.01"
            /><button type="button" class="p-text-btn" :disabled="busy || operation.pending.value" @click="amount = money(wallet.available)"
              >全部</button
            ></div
          ></label
        ><label class="p-field"
          >收款方式<select v-model="paymentMethod" required aria-label="收款方式" :disabled="busy || operation.pending.value"
            ><option value="" disabled>请选择已保存的收款码</option
            ><option
              v-for="method in wallet.paymentMethods || []"
              :key="method.method"
              :value="method.method"
              >{{ method.method === 'wechat' ? '微信' : '支付宝' }}</option
            ></select
          ></label
        ><RouterLink
          v-if="!wallet.paymentMethods?.length"
          to="/player/payment"
          class="p-notice p-info"
          >请先保存微信或支付宝收款码 <PlayerIcon name="next" /></RouterLink
        ><p class="p-hint">申请时保存当前收款码快照。提交后金额被占用；仅待审核可自行撤回。</p
        ><button
          class="p-btn p-primary p-full"
          :disabled="
            busy ||
            operation.pending.value ||
            resource.stale.value ||
            !resource.online.value ||
            studio.user?.playerAccess?.withdraw === false ||
            wallet.weeklyRemaining < 1 ||
            !wallet.paymentMethods?.length
          "
          >{{ busy ? '正在申请…' : '提交提现申请' }}</button
        ></form
      >
      <div class="p-link-grid"
        ><RouterLink to="/player/withdrawals" class="p-card"
          ><PlayerIcon name="wallet" /><strong>提现记录</strong></RouterLink
        ><RouterLink to="/player/ledger" class="p-card"
          ><PlayerIcon name="receipt" /><strong>收支明细</strong></RouterLink
        ></div
      ><p class="p-hint p-center">发放由财务人工登记，请以实际支付到账为准。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
  import { computed, ref, toRefs } from 'vue'
  import { playerApi } from '@/api/player'
  import { useSessionStore } from '@/stores/session'
  import type { PlayerWallet } from '@/types/player'
  import { usePlayerResource, money } from './usePlayer'
  import { captureOperation, usePlayerOperation, operationMessage } from '@/api/operations'
  import { accountDraft } from '@/composables/accountDraft'
  import { invalidatePlayerReads } from '@/api/readScheduler'
  import OperationState from './OperationState.vue'
  import PlayerState from './PlayerState.vue'
  import PlayerIcon from './PlayerIcon.vue'
  const studio = useSessionStore(),
    resource = usePlayerResource<PlayerWallet | null>(playerApi.wallet, null, true, { topics: ['wallet'] })
  const wallet = computed(() => resource.data.value),
    busy = ref(false),
    error = ref(''),
    success = ref('')
  const { amount, paymentMethod } = toRefs(accountDraft('wallet-input', () => ({ amount: '', paymentMethod: '' })))
  const operation = usePlayerOperation('withdraw')
  // Same-account permission changes clear page caches, but cannot erase an uncertain intent.
  const original = operation.operation.value
  if (operation.pending.value && original?.path === 'player/withdrawals') {
    if (typeof original.body.amount === 'number') amount.value = money(original.body.amount)
    if (original.body.paymentMethod === 'wechat' || original.body.paymentMethod === 'alipay') paymentMethod.value = original.body.paymentMethod
  }
  async function finish(result: Awaited<ReturnType<typeof operation.execute>>, epoch: number) {
    if (!result || epoch !== studio.epoch) return
    if (result.state === 'confirmed') {
      await resource.refresh(); await invalidatePlayerReads()
      if (epoch !== studio.epoch) return
      amount.value = ''; success.value = '原申请已确认，请查看最新提现记录。'
    } else if (result.state === 'rejected') error.value = result.message
  }
  async function checkResult() {
    if (busy.value) return
    const epoch = studio.epoch; busy.value = true
    try { const result = await operation.check(); await finish(result, epoch); if (result && result.state !== 'confirmed') await resource.refresh() }
    finally { if (epoch === studio.epoch) busy.value = false }
  }
  async function retryOriginal() {
    if (busy.value) return
    const epoch = studio.epoch; busy.value = true
    try { await finish(await operation.retryOriginal(), epoch) }
    finally { if (epoch === studio.epoch) busy.value = false }
  }
  async function withdraw() {
    if (busy.value || operation.pending.value || !wallet.value || resource.stale.value || !resource.online.value) return
    error.value = ''
    success.value = ''
    if (!/^\d+(\.\d{1,2})?$/.test(amount.value.trim())) {
      error.value = '请输入有效金额，最多两位小数'
      return
    }
    const cents = Math.round(Number(amount.value) * 100)
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > wallet.value.available) {
      error.value = '金额须大于 0，且不超过可提现余额'
      return
    }
    if (!paymentMethod.value) {
      error.value = '请选择收款方式'
      return
    }
    busy.value = true
    const epoch = studio.epoch
    try {
      const intent = captureOperation('withdraw', 'player/withdrawals', { amount: cents, paymentMethod: paymentMethod.value })
      await finish(await operation.execute(intent), epoch)
    } catch (cause) {
      if (epoch === studio.epoch) error.value = operationMessage(cause)
    } finally {
      if (epoch === studio.epoch) busy.value = false
    }
  }
</script>
