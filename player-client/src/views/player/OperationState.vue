<template>
  <div v-if="operation?.message || operation?.state === 'unknown'" class="p-notice p-operation-state" :class="operation?.reservationWaiting || operation?.state === 'unknown' ? 'p-warning' : operation?.state === 'confirmed' ? 'p-success' : 'p-error'" role="status">
    <p>{{ operation?.message }}</p>
    <div v-if="operation?.state === 'unknown'" class="p-actions">
      <button type="button" class="p-btn p-secondary" :disabled="operation.checking || !online" @click="$emit('check')">{{ operation.checking ? '正在核对…' : '核对结果' }}</button>
      <button v-if="operation.retryAllowed && allowRetry !== false" type="button" class="p-btn p-secondary" :disabled="operation.checking || !online" @click="retryConfirm = true">重试原请求</button>
    </div>
    <div v-if="retryConfirm && allowRetry !== false && operation?.retryAllowed && operation.state === 'unknown'" class="p-operation-confirm">
      <p>将使用原编号、原内容和原目标重试，不能修改这次请求。仍可能需要等待后台确认。</p>
      <div class="p-actions"><button type="button" class="p-btn p-secondary" @click="retryConfirm = false">继续等待</button><button type="button" class="p-btn" :disabled="!online" @click="retryConfirm = false; $emit('retry')">确认重试原请求</button></div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PlayerOperation } from '@/api/operations'
const props = defineProps<{ operation: PlayerOperation | null; online: boolean; allowRetry?: boolean }>()
defineEmits<{ check: []; retry: [] }>()
const retryConfirm = ref(false)
watch(() => [props.operation?.requestId, props.operation?.retryAllowed, props.operation?.state, props.allowRetry], () => retryConfirm.value = false)
</script>
<style scoped>
.p-notice.p-operation-state { display: block; }
.p-operation-state .p-actions { margin-top: 12px; }
.p-operation-state .p-btn { flex-shrink: 0; }
</style>
