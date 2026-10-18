<template>
  <div v-if="amount > 0">
    <ElFormItem label="退款去向" required>
      <ElRadioGroup
        :model-value="destination"
        :disabled="disabled"
        @update:model-value="$emit('update:destination', $event as RefundDestination)"
      >
        <ElRadio value="cash">退给老板（线下退款，不加账户余额）</ElRadio>
        <ElRadio value="balance">回客户余额</ElRadio>
      </ElRadioGroup>
    </ElFormItem>
    <template v-if="destination === 'cash'">
      <ElFormItem label="线下退款渠道" required
        ><ElSelect
          :model-value="channel || undefined"
          :disabled="disabled"
          placeholder="请选择实际退款渠道"
          @update:model-value="$emit('update:channel', $event)"
          ><ElOption
            v-for="(label, value) in refundChannelLabels"
            :key="value"
            :value="value"
            :label="label" /></ElSelect
      ></ElFormItem>
      <ElFormItem v-if="channel === 'other'" label="其他渠道说明" required
        ><ElInput
          :model-value="channelNote"
          :disabled="disabled"
          maxlength="500"
          placeholder="填写具体退款渠道"
          @update:model-value="$emit('update:channelNote', $event)"
      /></ElFormItem>
      <ElCheckbox
        v-if="canConfirm"
        :model-value="actualRefundConfirmed"
        :disabled="disabled"
        class="mb-4"
        @update:model-value="$emit('update:actualRefundConfirmed', Boolean($event))"
        >我已完成实际线下退款</ElCheckbox
      >
      <p v-else class="text-xs text-g-500 mb-3">当前账号仅提交退款申请，实际退款由财务核实确认。</p>
    </template>
  </div>
  <ElAlert
    :title="refundOutcome(destination, canConfirm, actualRefundConfirmed, amount)"
    type="warning"
    :closable="false"
    show-icon
    class="mb-4"
  />
</template>
<script setup lang="ts">
  import type { RefundDestination } from '@/types/studio'
  import { refundChannelLabels, refundOutcome } from '@/utils/business/refund-options'
  defineProps<{
    destination: RefundDestination
    channel: string
    channelNote: string
    actualRefundConfirmed: boolean
    canConfirm: boolean
    amount: number
    disabled?: boolean
  }>()
  defineEmits<{
    'update:destination': [value: RefundDestination]
    'update:channel': [value: string]
    'update:channelNote': [value: string]
    'update:actualRefundConfirmed': [value: boolean]
  }>()
</script>
