<template>
  <section class="p-page">
    <PlayerState :loading="resource.loading.value && !resource.data.value.length" :error="resource.error.value || error"
      :online="resource.online.value" @retry="resource.refresh()" />
    <p class="p-notice p-info">收款码仅本人和授权财务可见。修改只影响新申请，历史提现保留当时的快照。</p>
    <p v-if="success" class="p-notice p-success">{{ success }}</p>
    <div v-for="method in methods" :key="method.value" class="p-card">
      <div class="p-section-title"><h3>{{ method.label }}收款码</h3>
        <span class="p-badge" :class="existing(method.value) ? 'active' : 'pending'">{{ existing(method.value) ? '已保存' : '未设置' }}</span>
      </div>
      <img v-if="!imageFailed[method.value] && (uploads[method.value].attachment.value || existing(method.value)?.qrCode)"
        :src="(uploads[method.value].attachment.value || existing(method.value)?.qrCode)?.url"
        :key="`${method.value}:${imageVersion[method.value] || 0}`" class="p-qr-preview" :alt="`${method.label}收款码`" loading="lazy" decoding="async" @error="imageFailed[method.value] = true" />
      <div v-else-if="imageFailed[method.value]" class="p-qr-empty"><PlayerIcon name="qr" /><p>收款码图片暂未加载，请重新核对网络与权限。</p>
        <button type="button" class="p-text-btn" :disabled="!resource.online.value" @click="retryImage(method.value)">重新加载图片</button></div>
      <div v-else class="p-qr-empty"><PlayerIcon name="qr" /><p>上传本人{{ method.label }}收款码</p></div>
      <label class="p-btn p-secondary p-full p-file-label">{{ uploads[method.value].busy.value ? '图片上传中…' : '选择收款码图片' }}
        <input type="file" accept="image/png,image/jpeg,image/webp" :disabled="!!busy || anyUploadBusy || !!checking || !!uncertain[method.value] || !resource.online.value"
          @change="upload($event, method.value)" />
      </label>
      <ImageUploadState :phase="uploads[method.value].phase.value" :percent="uploads[method.value].percent.value"
        :error="uploads[method.value].error.value" :online="resource.online.value" @retry="uploads[method.value].retry()" />
      <template v-if="uploads[method.value].attachment.value">
        <p v-if="uncertain[method.value]" class="p-notice p-warning">保存结果尚未确认，图片已保留，请先核对结果。</p>
        <button v-if="uncertain[method.value]" class="p-btn p-secondary p-full" :disabled="!!busy || !!checking || !resource.online.value"
          @click="checkSaved(method.value)">{{ checking === method.value ? '正在核对…' : '核对保存结果' }}</button>
        <button v-else class="p-btn p-primary p-full" :disabled="!!busy || anyUploadBusy || !resource.online.value"
          @click="save(method.value)">{{ busy === method.value ? '正在保存…' : `保存${method.label}收款码` }}</button>
      </template>
    </div>
    <p class="p-hint p-center">支持 PNG、JPEG、WebP，上传前会适当处理大图。请检查收款对象与二维码清晰度，单张上传不超过 8 MB。</p>
  </section>
</template>
<script setup lang="ts">
  import { computed, ref, reactive, watch } from 'vue'
  import { playerApi } from '@/api/player'
  import type { PaymentMethod } from '@/types/player'
  import { useSessionStore } from '@/stores/session'
  import { useImageUpload } from '@/composables/useImageUpload'
  import { accountDraft } from '@/composables/accountDraft'
  import { usePlayerResource } from './usePlayer'
  import PlayerState from './PlayerState.vue'
  import PlayerIcon from './PlayerIcon.vue'
  import ImageUploadState from './ImageUploadState.vue'
  type Method = 'wechat' | 'alipay'
  const methods: { value: Method; label: string }[] = [{ value: 'wechat', label: '微信' }, { value: 'alipay', label: '支付宝' }]
  const resource = usePlayerResource<PaymentMethod[]>((signal) => playerApi.paymentMethods(signal), [], false)
  const session = useSessionStore(), uploads = { wechat: useImageUpload('qr', 'payment-wechat'), alipay: useImageUpload('qr', 'payment-alipay') }
  const draft = accountDraft('payment-operation', () => ({ uncertain: {} as Partial<Record<Method, boolean>> }))
  const uncertain = draft.uncertain, busy = ref(''), checking = ref(''), error = ref(''), success = ref('')
  const imageFailed = reactive<Partial<Record<Method, boolean>>>({}), imageVersion = reactive<Partial<Record<Method, number>>>({})
  const anyUploadBusy = computed(() => uploads.wechat.busy.value || uploads.alipay.busy.value)
  const existing = (method: string) => resource.data.value.find((item) => item.method === method)
  function retryImage(method: Method) { imageFailed[method] = false; imageVersion[method] = (imageVersion[method] || 0) + 1 }
  for (const method of methods) watch(() => uploads[method.value].attachment.value?.id || existing(method.value)?.qrCode.id, () => { imageFailed[method.value] = false })
  async function upload(event: Event, method: Method) {
    const input = event.target as HTMLInputElement, file = input.files?.[0]
    input.value = ''
    if (!file || busy.value || anyUploadBusy.value || uncertain[method]) return
    error.value = ''; success.value = ''
    await uploads[method].start(file)
  }
  async function checkSaved(method: Method) {
    if (busy.value || checking.value) return
    checking.value = method; error.value = ''
    const epoch = session.epoch, target = uploads[method].attachment.value
    try {
      const result = await playerApi.paymentMethods()
      if (epoch !== session.epoch) return
      resource.data.value = result
      if (target && result.some((item) => item.method === method && item.qrCode.id === target.id)) {
        uploads[method].clear(); delete uncertain[method]
        success.value = '已核对，收款码已保存，新提现申请使用此资料。'
      } else {
        // A differing read cannot prove that an unconfirmed settings write will never finish.
        error.value = '暂未查到这张收款码的保存结果，请稍后再核对；必要时联系后台确认。'
      }
    } catch (cause) {
      if (epoch === session.epoch) error.value = cause instanceof Error ? cause.message : '核对失败，请稍后重试'
    } finally { if (epoch === session.epoch) checking.value = '' }
  }
  async function save(method: Method) {
    const target = uploads[method].attachment.value
    if (busy.value || !target || uncertain[method]) return
    busy.value = method; error.value = ''; success.value = ''
    uncertain[method] = true
    const epoch = session.epoch
    try {
      await playerApi.savePayment(method, target)
      if (epoch !== session.epoch) return
      uploads[method].clear(); delete uncertain[method]
      await resource.refresh()
      if (epoch === session.epoch) success.value = '收款码已保存，新提现申请使用此资料。'
    } catch (cause) {
      if (epoch !== session.epoch) return
      const status = (cause as { status?: number }).status
      if (status && status !== 502 && status !== 504 && (cause as { outcome?: string }).outcome !== 'unknown') delete uncertain[method]
      error.value = cause instanceof Error ? cause.message : '保存结果未确认，请核对结果'
    } finally { if (epoch === session.epoch) busy.value = '' }
  }
</script>
