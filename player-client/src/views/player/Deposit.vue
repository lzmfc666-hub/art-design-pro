<template>
  <section class="p-page"
    ><PlayerState
      :loading="resource.loading.value && !resource.data.value"
      :error="resource.error.value"
      :online="resource.online.value"
      @retry="resource.refresh()"
    /><template v-if="resource.data.value"
      ><div class="p-card p-deposit-hero"
        ><PlayerIcon name="shield" /><span>独立押金余额</span
        ><strong>¥ {{ money(resource.data.value.balance) }}</strong
        ><p>押金独立保存，与可提现报酬分开。</p></div
      ><div class="p-notice p-info">押金由财务登记缴纳和退出处理，不作为自动接单门槛。</div
      ><div class="p-section-title"><h3>押金明细</h3></div
      ><PlayerState
        :empty="!resource.data.value.records.length"
        online
        empty-text="暂无押金变动"
      /><div class="p-card" v-if="resource.data.value.records.length"
        ><div v-for="item in resource.data.value.records" :key="item.id" class="p-ledger-row"
          ><div
            ><strong>{{
              item.kind === 'deposit'
                ? '押金缴纳'
                : item.kind === 'return'
                  ? '押金退还'
                  : item.kind === 'penalty'
                    ? '退出扣减'
                    : '押金变动'
            }}</strong
            ><p>{{ item.reason }}</p
            ><span>{{ dateTime(item.createdAt) }}</span
            ><p class="p-hint">变动后余额 ¥ {{ money(item.balanceAfter) }}</p></div
          ><b :class="item.delta >= 0 ? 'p-income' : 'p-outgoing'"
            >{{ item.delta >= 0 ? '+' : '−' }} ¥{{ money(Math.abs(item.delta)) }}</b
          ></div
        ></div
      ><PlayerPagination :current="resource.data.value.current" :size="resource.data.value.size" :total="resource.data.value.total" :busy="resource.loading.value" @change="page = $event" /></template
    ></section
  >
</template>
<script setup lang="ts">
  import { ref, watch } from 'vue'
  import { playerApi } from '@/api/player'
  import { useSessionStore } from '@/stores/session'
  import type { PlayerDeposit } from '@/types/player'
  import { usePlayerResource, money, dateTime } from './usePlayer'
  import PlayerState from './PlayerState.vue'
  import PlayerIcon from './PlayerIcon.vue'
  import PlayerPagination from './PlayerPagination.vue'
  const studio = useSessionStore(),
    page = ref(1)
  const resource = usePlayerResource<PlayerDeposit | null>(
    signal => playerApi.depositTransactions(studio.user!.id, page.value, signal),
    null, true, { topics: ['deposit'] }
  )
  watch(page, () => {
    resource.cancel()
    resource.data.value = null
    void resource.refresh()
  })
  watch(() => resource.data.value, result => {
    if (result && page.value > Math.max(1, Math.ceil(result.total / result.size))) {
      page.value = Math.max(1, Math.ceil(result.total / result.size))
    }
  })
</script>
