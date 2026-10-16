<template>
  <section class="p-page"
    ><div class="p-card">
      <label class="p-field">流水类型<select v-model="kind" aria-label="流水类型"><option value="">全部类型</option><option v-for="value in filterKinds" :key="value" :value="value">{{ labels[value] }}</option></select></label>
      <label class="p-field">开始日期<input v-model="start" aria-label="账本开始日期" type="date" :max="end || undefined" /></label>
      <label class="p-field">结束日期<input v-model="end" aria-label="账本结束日期" type="date" :min="start || undefined" /></label>
    </div><PlayerState
      :loading="resource.loading.value && !resource.data.value"
      :error="resource.error.value"
      :online="resource.online.value"
      :empty="!records.length"
      empty-text="暂无收支明细"
      @retry="resource.refresh()"
    /><div class="p-card" v-if="records.length"
      ><div v-for="item in records" :key="item.id" class="p-ledger-row"
        ><div
          ><strong>{{ item.title || labels[item.kind] || '账本变动' }}</strong
          ><p>{{ item.reason || '由工作室账本登记' }}</p
          ><p v-if="item.manualAmount" class="p-notice p-warning"
            >另有 ¥{{ money(item.manualAmount) }} 待财务人工核对，不自动扣除未来收入。</p
          ><span>{{ dateTime(item.createdAt) }}</span
          ><RouterLink v-if="item.orderId" :to="`/player/orders/${item.orderId}`" class="p-text-btn"
            >查看关联订单</RouterLink
          ></div
        ><b :class="(item.delta ?? item.amount ?? 0) >= 0 ? 'p-income' : 'p-outgoing'"
          >{{
            item.kind === 'withdrawal-paid' ? '' : (item.delta ?? item.amount ?? 0) >= 0 ? '+' : '−'
          }}
          ¥{{
            money(
              Math.abs(
                item.kind === 'withdrawal-paid'
                  ? item.amount || 0
                  : (item.delta ?? item.amount ?? 0)
              )
            )
          }}</b
        ></div
      ></div
    ><PlayerPagination v-if="resource.data.value" :current="resource.data.value.current" :size="resource.data.value.size" :total="resource.data.value.total" :busy="resource.loading.value" @change="page = $event" /><p class="p-hint p-center">明细来自服务器账本。当前页不用于计算钱包余额；人工待追回不自动扣除未来收入。</p></section
  >
</template>
<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { playerApi } from '@/api/player'
  import type { PlayerRecordPage, PlayerLedger } from '@/types/player'
  import { usePlayerResource, money, dateTime } from './usePlayer'
  import PlayerState from './PlayerState.vue'
  import PlayerPagination from './PlayerPagination.vue'
  const page = ref(1), kind = ref(''), start = ref(''), end = ref('')
  const resource = usePlayerResource<PlayerRecordPage<PlayerLedger> | null>(
    signal => playerApi.ledger({ current: page.value, size: 20, kind: kind.value, start: start.value, end: end.value }, signal),
    null, true, { topics: ['wallet'] })
  const records = computed(() => resource.data.value?.records || [])
  function reloadQuery() { resource.cancel(); resource.data.value = null; void resource.refresh() }
  watch([kind, start, end], () => { if (page.value !== 1) page.value = 1; else reloadQuery() })
  watch(page, reloadQuery)
  watch(() => resource.data.value, result => {
    if (result && page.value > Math.max(1, Math.ceil(result.total / result.size))) page.value = Math.max(1, Math.ceil(result.total / result.size))
  })
  const filterKinds = ['reward', 'reward-correction', 'legacy-reward-snapshot', 'supplement', 'deduction', 'withdrawal-request', 'withdrawal-canceled', 'withdrawal-rejected', 'withdrawal-paid']
  const labels: Record<string, string> = {
    reward: '订单报酬',
    'reward-correction': '报酬更正',
    'legacy-reward-snapshot': '历史报酬余额快照',
    'order-reward': '订单报酬',
    settlement: '订单报酬',
    reversal: '报酬冲正',
    supplement: '财务补款',
    deduction: '财务扣款',
    withdrawal: '提现占用',
    'withdrawal-request': '提现申请占用',
    'withdrawal-canceled': '撤回提现释放',
    'withdrawal-rejected': '驳回提现释放',
    'withdrawal-paid': '提现发放',
    'withdrawal-release': '提现释放',
    manual: '人工财务调整'
  }
</script>
