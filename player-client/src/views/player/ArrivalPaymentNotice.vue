<template>
  <aside v-if="visible" class="p-arrival-payment-notice" role="note" aria-label="落地付付款提醒">
    <PlayerIcon name="wallet" />
    <strong>此单为落地付，落地后让老板联系客服付款</strong>
  </aside>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import type { PlayerOrder } from '@/types/player'
  import PlayerIcon from './PlayerIcon.vue'

  const props = defineProps<{ order: PlayerOrder }>()
  const visible = computed(
    () =>
      props.order.payOnArrival === true &&
      props.order.paymentConfirmed === false &&
      !props.order.historyOnly &&
      ['pending', 'active'].includes(props.order.status) &&
      !props.order.fullRefund &&
      !props.order.refundPending &&
      !['refunded', 'refund-pending'].includes(props.order.displayStatus || '')
  )
</script>

<style scoped>
  .p-arrival-payment-notice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 12px 0;
    padding: 12px;
    border: 1px solid #edbc61;
    border-left: 5px solid #d99110;
    border-radius: 10px;
    background: #fff4d8;
    color: #724100;
    overflow-wrap: anywhere;
  }
  .p-arrival-payment-notice svg {
    flex: 0 0 20px;
    width: 20px;
    height: 20px;
    margin-top: 2px;
  }
  .p-arrival-payment-notice strong {
    font-size: 14px;
    font-weight: 700;
    line-height: 1.6;
  }
</style>
