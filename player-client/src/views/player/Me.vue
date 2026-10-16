<template>
  <section class="p-page p-me-page">
    <PlayerState
      :loading="profile.loading.value && !profile.data.value"
      :error="
        profile.error.value || wallet.error.value || deposit.error.value
      "
      :online="profile.online.value"
      @retry="refresh"
    />
    <div class="p-me-hero">
      <RouterLink to="/player/profile" class="p-me-identity">
        <img
          v-if="account?.avatar"
          :src="account.avatar.url"
          class="p-avatar p-avatar-large"
          alt="头像"
        />
        <span v-else class="p-avatar p-avatar-large">{{
          (account?.name || '我').slice(0, 1)
        }}</span>
        <div>
          <h2>{{ account?.name || '我的账号' }}</h2>
          <p>账号：{{ account?.username || '—' }}</p>
        </div>
        <PlayerIcon name="next" />
      </RouterLink>
      <div class="p-me-stats">
        <RouterLink to="/player/wallet">
          <strong>¥ {{ wallet.data.value ? money(wallet.data.value.available) : '—' }}</strong>
          <span>可提现报酬</span>
        </RouterLink>
        <RouterLink to="/player/tasks?status=completed">
          <strong>查看任务</strong>
          <span>已完成订单</span>
        </RouterLink>
      </div>
    </div>
    <div class="p-account-card">
      <div class="p-account-heading">
        <span class="p-account-emblem"><PlayerIcon name="rank" /></span>
        <h3>账号信息</h3>
        <span class="p-account-status">{{
          account?.status === 'active' ? '正常' : '状态待确认'
        }}</span>
      </div>
      <div class="p-account-grid">
        <div class="p-account-cell">
          <span class="p-account-icon"><PlayerIcon name="rank" /></span>
          <div
            ><span>打手等级</span><strong>{{ profile.data.value?.level?.name || '—' }}</strong></div
          >
        </div>
        <div class="p-account-cell">
          <span class="p-account-icon"><PlayerIcon name="tasks" /></span>
          <div>
            <span>接单名额</span>
            <strong>{{
              profile.data.value
                ? `${profile.data.value.activeOrders} / ${profile.data.value.maxActiveOrders}`
                : '—'
            }}</strong>
          </div>
        </div>
        <RouterLink to="/player/deposit" class="p-account-cell p-account-deposit">
          <span class="p-account-icon"><PlayerIcon name="shield" /></span>
          <div
            ><span>独立押金</span
            ><strong
              >¥ {{ deposit.data.value ? money(deposit.data.value.balance) : '—' }}</strong
            ></div
          >
          <PlayerIcon name="next" />
        </RouterLink>
      </div>
    </div>
    <div class="p-card p-menu-list"
      ><RouterLink v-for="item in menu" :key="item.path" :to="item.path"
        ><span class="p-menu-icon" :class="`icon-${item.icon}`"
          ><PlayerIcon :name="item.icon" /></span
        ><span>{{ item.label }}</span
        ><small v-if="item.note">{{ item.note }}</small
        ><PlayerIcon name="next" /></RouterLink
    ></div>
    <p v-if="logoutError" class="p-notice p-error">{{ logoutError }}</p
    ><button class="p-btn p-secondary p-full p-logout" :disabled="loggingOut" @click="logout"
      ><PlayerIcon name="logout" />{{ loggingOut ? '正在退出…' : '退出登录' }}</button
    >
  </section>
</template>
<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { playerApi } from '@/api/player'
  import { announcePlayerSession } from '@/api/crossTabSession'
  import type { PlayerDeposit, PlayerProfile, PlayerWallet } from '@/types/player'
  import { safeApiMessage } from '@/api/studio'
  import { useSessionStore } from '@/stores/session'
  import { usePlayerResource, money } from './usePlayer'
  import PlayerIcon from './PlayerIcon.vue'
  import PlayerState from './PlayerState.vue'
  defineOptions({ name: 'PlayerMe' })
  const studio = useSessionStore(),
    router = useRouter()
  const profile = usePlayerResource<PlayerProfile | null>(playerApi.profile, null, true, { topics: ['profile', 'orders'] }),
    wallet = usePlayerResource<PlayerWallet | null>(playerApi.wallet, null, true, { topics: ['wallet'] }),
    deposit = usePlayerResource<PlayerDeposit | null>(
      signal => playerApi.deposit(studio.user!.id, signal),
      null, true, { topics: ['deposit'] }
    )
  const account = computed(() => profile.data.value?.user || studio.user)
  const loggingOut = ref(false),
    logoutError = ref('')
  const menu = [
    { path: '/player/payment', label: '收款信息', icon: 'qr', note: '微信 / 支付宝' },
    { path: '/player/wallet', label: '钱包与提现', icon: 'wallet' },
    { path: '/player/withdrawals', label: '提现记录', icon: 'wallet' },
    { path: '/player/ledger', label: '收支明细', icon: 'receipt' },
    { path: '/player/profile', label: '个人资料', icon: 'me' },
    { path: '/player/deposit', label: '独立押金', icon: 'shield', note: '与报酬分开' },
    { path: '/player/messages', label: '消息中心', icon: 'bell' },
    { path: '/player/notifications', label: '通知设置', icon: 'settings' },
    { path: '/player/password', label: '修改密码', icon: 'lock' }
  ]
  async function refresh() {
    await Promise.all([profile.refresh(), wallet.refresh(), deposit.refresh()])
  }
  async function logout() {
    if (loggingOut.value) return
    loggingOut.value = true
    logoutError.value = ''
    const epoch = studio.epoch
    try {
      try {
        if ('serviceWorker' in navigator) {
          const registration = await navigator.serviceWorker.getRegistration('/')
          if (epoch !== studio.epoch) return
          const subscription = await registration?.pushManager.getSubscription()
          if (epoch !== studio.epoch) return
          if (subscription) {
            await playerApi.removeSubscription(subscription.endpoint).catch(() => {})
            if (epoch !== studio.epoch) return
            await subscription.unsubscribe().catch(() => {})
          }
        }
      } catch {
        /* 推送解绑异常不阻断服务器退出，服务器统一撤销本账号绑定。 */
      }
      if (epoch !== studio.epoch) return
      await playerApi.logout()
      if (epoch !== studio.epoch) return
      announcePlayerSession('logout')
      studio.clearSession()
      await router.replace('/player/login')
    } catch (cause) {
      logoutError.value = safeApiMessage(cause, '退出失败，请重试')
    } finally {
      loggingOut.value = false
    }
  }
</script>
