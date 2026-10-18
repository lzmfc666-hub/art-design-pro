<template>
  <RouterView :key="session.epoch" />
  <aside v-if="navigationLoadRecovery.failure.value" class="player-navigation-recovery" role="alert" aria-live="assertive">
    <h2>页面暂时无法打开</h2>
    <p>页面资源未能加载，可能是版本已更新或网络中断。请连接网络后刷新并打开刚才选择的页面。</p>
    <p class="player-navigation-recovery-note">刷新可能丢失未提交的输入，不会自动提交订单或资金操作。</p>
    <div>
      <button type="button" :disabled="navigationLoadRecovery.refreshing.value" @click="navigationLoadRecovery.refresh()">{{ navigationLoadRecovery.refreshing.value ? '正在刷新…' : '刷新并打开页面' }}</button>
      <button type="button" class="player-navigation-recovery-dismiss" :disabled="navigationLoadRecovery.refreshing.value" @click="navigationLoadRecovery.clear()">暂不刷新</button>
    </div>
  </aside>
</template>
<script setup lang="ts">
  import { useSessionStore } from '@/stores/session'
  import { navigationLoadRecovery } from '@/router'
  const session = useSessionStore()
</script>
<style scoped>
  .player-navigation-recovery { position: fixed; z-index: 1000; top: calc(env(safe-area-inset-top, 0px) + 14px); left: 50%; transform: translateX(-50%); box-sizing: border-box; width: min(460px, calc(100% - 24px)); padding: 18px; border: 1px solid #e6d9ff; border-radius: 16px; background: #fff; color: #273043; box-shadow: 0 8px 32px #27304330; font-family: sans-serif; }
  .player-navigation-recovery h2 { margin: 0 0 10px; font-size: 17px; }
  .player-navigation-recovery p { margin: 8px 0; font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; }
  .player-navigation-recovery .player-navigation-recovery-note { color: #66728a; font-size: 12px; }
  .player-navigation-recovery > div { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .player-navigation-recovery button { min-height: 42px; padding: 9px 14px; border: 0; border-radius: 10px; background: #7959db; color: #fff; font-size: 14px; cursor: pointer; }
  .player-navigation-recovery button:disabled { opacity: .65; cursor: wait; }
  .player-navigation-recovery .player-navigation-recovery-dismiss { background: #f0f3fa; color: #44516a; }
</style>
