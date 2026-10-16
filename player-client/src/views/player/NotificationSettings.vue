<template>
  <section class="p-page">
    <PlayerState :loading="resource.loading.value && !resource.data.value" :error="resource.error.value || error" :online="resource.online.value" @retry="resource.refresh()" />
    <template v-if="resource.data.value">
      <div class="p-card"><h3>业务提醒</h3><p class="p-hint">指定订单、退单、验收和提现结果始终保留站内消息。提醒与接受订单是两件事。</p>
        <label class="p-toggle-row"><span><strong>公共抢单新单提醒</strong><small>默认关闭，可按需要开启</small></span>
          <input type="checkbox" :checked="resource.data.value.settings.pool" :disabled="busy || !resource.online.value" @change="savePool" /></label>
        <label class="p-toggle-row"><span><strong>允许浏览器推送</strong><small>账号提醒开关，设备还需授权和绑定</small></span>
          <input type="checkbox" :checked="resource.data.value.settings.push" :disabled="busy || !resource.online.value" @change="savePush" /></label>
      </div>
      <div class="p-card"><h3>关闭页面后的提醒</h3>
        <dl class="p-detail-list">
          <div><dt>浏览器能力</dt><dd>{{ supported ? '支持推送接口' : '当前浏览器不支持' }}</dd></div>
          <div><dt>浏览器通知权限</dt><dd>{{ permissionLabel }}</dd></div>
          <div><dt>浏览器设备订阅</dt><dd>{{ resource.data.value.browserSubscribed ? '本机已有订阅' : '本机未订阅' }}</dd></div>
          <div><dt>本机账号绑定</dt><dd>{{ bindingLabel }}</dd></div>
          <div><dt>服务端推送配置</dt><dd>{{ resource.data.value.config.configured ? '已配置' : '尚未配置' }}</dd></div>
          <div><dt>服务端推送可用</dt><dd>{{ resource.data.value.config.enabled ? '可用' : '暂不可用' }}</dd></div>
        </dl>
        <p v-if="resource.data.value.config.reason" class="p-notice p-warning">{{ resource.data.value.config.reason }}</p>
        <p v-if="binding === 'unknown' && resource.data.value.browserSubscribed" class="p-hint">本机暂时无法核对订阅指纹，浏览器已有订阅不代表已绑定当前账号。可重新读取或主动确认绑定。</p>
        <p v-if="!supported" class="p-hint">仍可正常接单和查看站内消息。可尝试支持通知的浏览器或添加到手机桌面。</p>
        <p v-if="permission === 'denied'" class="p-hint">浏览器已拒绝通知，请在系统或浏览器设置中允许后重新核对。</p>
        <button v-if="binding !== 'valid'" class="p-btn p-primary p-full" :disabled="busy || !supported || !resource.data.value.config.enabled || !resource.data.value.config.configured || permission === 'denied' || !resource.online.value" @click="enable">
          {{ busy ? '正在处理…' : resource.data.value.browserSubscribed ? '确认本账号设备绑定' : '授权并绑定本机通知' }}
        </button>
        <button v-if="binding === 'valid' || resource.data.value.browserSubscribed" class="p-btn p-secondary p-full" :disabled="busy || !resource.online.value" @click="disable">解除本账号本机通知</button>
        <button v-if="binding === 'valid'" class="p-btn p-secondary p-full" :disabled="busy || !resource.online.value || !resource.data.value.settings.push || !resource.data.value.config.enabled" @click="test">发送测试提醒</button>
        <p v-if="success" class="p-notice p-success" aria-live="polite">{{ success }}</p>
      </div>
      <div class="p-card"><h3>实际到达需要手机核对</h3>
        <p class="p-hint">使用浏览器菜单的“添加到主屏幕”或“安装应用”。苹果设备关闭页面后的推送通常需要从主屏幕打开并授权。</p>
        <p class="p-hint">订阅完成、后台确认绑定及提醒已排队都不代表手机已收到。请在真实手机上核对锁屏、关闭页面和网络变化场景。</p>
        <p class="p-hint">退出登录会撤销该账号订阅，可能影响同账号其他设备。重新登录后按需要主动绑定。</p>
      </div>
    </template>
  </section>
</template>
<script setup lang="ts">
  import { computed, ref, onActivated, onDeactivated, onBeforeUnmount, watch } from 'vue'
  import { playerApi } from '@/api/player'
  import { pushFingerprint } from '@/api/pushFingerprint'
  import type { PlayerDeviceBinding } from '@/types/player'
  import { useSessionStore } from '@/stores/session'
  import { usePlayerResource } from './usePlayer'
  import PlayerState from './PlayerState.vue'
  type State = { settings: { pool: boolean; push: boolean }; config: Awaited<ReturnType<typeof playerApi.pushConfig>>; browserSubscribed: boolean; binding: PlayerDeviceBinding | null }
  const session = useSessionStore()
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext
  const permission = ref<NotificationPermission>(supported ? Notification.permission : 'default')
  const busy = ref(false), error = ref(''), success = ref('')
  const resource = usePlayerResource<State | null>(async (signal) => {
    const [settings, config] = await Promise.all([playerApi.settings(signal), playerApi.pushConfig(signal)])
    let browserSubscribed = false, fingerprint: Awaited<ReturnType<typeof pushFingerprint>> = null
    if (supported) {
      const registration = await navigator.serviceWorker.getRegistration('/')
      const subscription = await registration?.pushManager.getSubscription()
      browserSubscribed = !!subscription
      if (subscription) fingerprint = await pushFingerprint(subscription.toJSON())
    }
    const binding = browserSubscribed && !fingerprint ? null : await playerApi.subscriptionStatus(fingerprint, signal)
    return { settings, config, browserSubscribed, binding }
  }, null, false)
  const permissionLabel = computed(() => permission.value === 'granted' ? '已允许' : permission.value === 'denied' ? '已拒绝' : '尚未授权')
  const binding = computed(() => resource.data.value?.binding?.status || 'unknown')
  const bindingLabel = computed(() => ({ valid: '后台已确认当前账号绑定有效', unbound: '未绑定当前账号或已失效', invalid: '本机订阅与后台绑定不一致', unconfigured: '服务未配置，尚不能核对有效绑定', unknown: '待确认，未自动绑定' })[binding.value])
  watch(() => resource.data.value, () => { if (supported) permission.value = Notification.permission })
  let generation = 0, active = true
  const current = (token: number, epoch: number) => active && token === generation && epoch === session.epoch
  function abandon() { active = false; generation++; busy.value = false; error.value = ''; success.value = '' }
  onActivated(() => { active = true; if (supported) permission.value = Notification.permission })
  onDeactivated(abandon); onBeforeUnmount(abandon)
  watch(() => session.epoch, abandon)
  async function operation(action: (token: number, epoch: number) => Promise<void>) {
    if (busy.value || !resource.online.value) return
    busy.value = true; error.value = ''; success.value = ''
    const token = ++generation, epoch = session.epoch
    try { await action(token, epoch) }
    catch (cause) { if (current(token, epoch)) error.value = cause instanceof Error ? cause.message : '操作结果未确认，请重新核对设置' }
    finally { if (current(token, epoch)) busy.value = false }
  }
  function savePool(event: Event) {
    const input = event.target as HTMLInputElement, before = resource.data.value!.settings.pool, push = resource.data.value!.settings.push, desired = input.checked
    return operation(async (token, epoch) => {
      try { await playerApi.saveSettings(desired, push) }
      catch (cause) { if (current(token, epoch)) input.checked = before; throw cause }
      if (current(token, epoch)) await resource.refresh()
    })
  }
  function savePush(event: Event) {
    const input = event.target as HTMLInputElement, before = resource.data.value!.settings.push, pool = resource.data.value!.settings.pool, desired = input.checked
    return operation(async (token, epoch) => {
      try { await playerApi.saveSettings(pool, desired) }
      catch (cause) { if (current(token, epoch)) input.checked = before; throw cause }
      if (current(token, epoch)) await resource.refresh()
    })
  }
  async function readyRegistration() {
    await navigator.serviceWorker.register('/player-sw.js', { scope: '/', updateViaCache: 'none' })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('通知组件尚未准备好，请稍后再试')), 15000)
      })])
    } finally { clearTimeout(timeout) }
  }
  function enable() {
    if (busy.value || !supported || !resource.data.value?.config.enabled || !resource.data.value.config.configured) return
    // Permission prompt remains in the direct user gesture, never in a read/poll hook.
    return operation(async (token, epoch) => {
      const allowed = await Notification.requestPermission()
      if (!current(token, epoch)) return
      permission.value = allowed
      if (allowed !== 'granted') throw new Error('通知未获得授权，站内消息仍可正常使用。')
      const config = resource.data.value!.config, pool = resource.data.value!.settings.pool
      const registration = await readyRegistration()
      if (!current(token, epoch)) return
      const key = config.publicKey.replace(/-/g, '+').replace(/_/g, '/'), raw = atob(key.padEnd(Math.ceil(key.length / 4) * 4, '=')), bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0))
      const subscription = (await registration.pushManager.getSubscription()) || (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes.buffer }))
      if (!current(token, epoch)) return
      await playerApi.saveSubscription(subscription.toJSON())
      if (!current(token, epoch)) return
      await playerApi.saveSettings(pool, true)
      if (!current(token, epoch)) return
      await resource.refresh()
      if (current(token, epoch)) success.value = '后台已确认本机账号绑定，账号推送开关已开启；是否到达请以手机实际显示为准。'
    })
  }
  function disable() {
    return operation(async (token, epoch) => {
      const registration = await navigator.serviceWorker.getRegistration('/'), subscription = await registration?.pushManager.getSubscription()
      if (!current(token, epoch)) return
      if (subscription) {
        await playerApi.removeSubscription(subscription.endpoint)
        if (!current(token, epoch)) return
        await subscription.unsubscribe()
      }
      if (!current(token, epoch)) return
      await resource.refresh()
      if (current(token, epoch)) success.value = '本账号本机订阅已解除，站内消息继续保留。'
    })
  }
  function test() {
    return operation(async (token, epoch) => {
      await playerApi.testPush()
      if (current(token, epoch)) success.value = '测试提醒已排队，请在本机核对是否实际收到；排队不代表到达。'
    })
  }
</script>
