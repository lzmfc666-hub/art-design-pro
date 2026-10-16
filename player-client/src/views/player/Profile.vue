<template>
  <section class="p-page">
    <PlayerState :loading="resource.loading.value && !resource.data.value" :error="resource.error.value || error"
      :online="resource.online.value" @retry="resource.refresh()" />
    <form v-if="resource.data.value" class="p-card" @submit.prevent="save">
      <div class="p-avatar-editor">
        <img v-if="!avatarFailed && (image.attachment.value || resource.data.value.user.avatar)"
          :src="(image.attachment.value || resource.data.value.user.avatar)?.url" :key="avatarVersion" class="p-avatar p-avatar-large" alt="头像" decoding="async" @error="avatarFailed = true" />
        <span v-else class="p-avatar p-avatar-large">{{ name.slice(0, 1) || '我' }}</span>
        <label class="p-text-btn p-file-label">{{ image.busy.value ? '图片上传中…' : '更换头像' }}
          <input type="file" accept="image/png,image/jpeg,image/webp" :disabled="busy || image.busy.value || uncertain || !resource.online.value" @change="upload" />
        </label>
      </div>
      <p v-if="avatarFailed" class="p-hint">头像暂未加载。<button type="button" class="p-text-btn" :disabled="!resource.online.value" @click="avatarFailed = false; avatarVersion++">重新加载头像</button></p>
      <ImageUploadState :phase="image.phase.value" :percent="image.percent.value" :error="image.error.value"
        :online="resource.online.value" @retry="image.retry()" />
      <label class="p-field">账号<input :value="resource.data.value.user.username" disabled /></label>
      <label class="p-field">昵称<input v-model.trim="name" required maxlength="100" autocomplete="nickname" :disabled="busy || uncertain" /></label>
      <dl class="p-detail-list"><div><dt>等级</dt><dd>{{ resource.data.value.level?.name || '未设置' }}</dd></div>
        <div><dt>接单上限</dt><dd>{{ resource.data.value.maxActiveOrders }} 单</dd></div></dl>
      <p v-if="success" class="p-notice p-success">资料已保存</p>
      <template v-if="uncertain"><p class="p-notice p-warning">保存结果尚未确认，头像和昵称已保留，请先核对结果。</p>
        <button type="button" class="p-btn p-secondary p-full" :disabled="busy || !resource.online.value" @click="checkSaved">{{ busy ? '正在核对…' : '核对保存结果' }}</button></template>
      <button v-else class="p-btn p-primary p-full" :disabled="busy || image.busy.value || !name || !resource.online.value">{{ busy ? '正在保存…' : '保存资料' }}</button>
    </form>
  </section>
</template>
<script setup lang="ts">
  import { ref, watch, toRef } from 'vue'
  import { playerApi } from '@/api/player'
  import type { PlayerProfile } from '@/types/player'
  import { useSessionStore } from '@/stores/session'
  import { useImageUpload } from '@/composables/useImageUpload'
  import { accountDraft } from '@/composables/accountDraft'
  import { usePlayerResource } from './usePlayer'
  import PlayerState from './PlayerState.vue'
  import ImageUploadState from './ImageUploadState.vue'
  const resource = usePlayerResource<PlayerProfile | null>((signal) => playerApi.profile(signal), null, false)
  const draft = accountDraft('profile-operation', () => ({ name: '', uncertain: false, pending: null as { name: string; avatarId?: string } | null }))
  const session = useSessionStore(), image = useImageUpload('avatar', 'profile-avatar'), name = toRef(draft, 'name'), busy = ref(false), error = ref(''), success = ref(false), uncertain = toRef(draft, 'uncertain')
  const avatarFailed = ref(false), avatarVersion = ref(0)
  watch(() => image.attachment.value?.id || resource.data.value?.user.avatar?.id, () => { avatarFailed.value = false })
  watch(() => resource.data.value?.user.name, (value) => { if (value && !name.value) name.value = value })
  async function upload(event: Event) {
    const input = event.target as HTMLInputElement, file = input.files?.[0]
    input.value = ''
    if (!file || busy.value || image.busy.value || uncertain.value) return
    error.value = ''; success.value = false
    await image.start(file)
  }
  async function checkSaved() {
    if (busy.value || !draft.pending) return
    busy.value = true; error.value = ''
    const epoch = session.epoch
    try {
      const result = await playerApi.profile()
      if (epoch !== session.epoch) return
      resource.data.value = result
      if (draft.pending && result.user.name === draft.pending.name && (!draft.pending.avatarId || result.user.avatar?.id === draft.pending.avatarId)) {
        session.acceptUser(result.user); image.clear(); draft.pending = null; uncertain.value = false; success.value = true
      } else error.value = '暂未查到本次保存结果，请稍后再核对；必要时联系后台确认。'
    } catch (cause) {
      if (epoch === session.epoch) error.value = cause instanceof Error ? cause.message : '核对失败，请稍后重试'
    } finally { if (epoch === session.epoch) busy.value = false }
  }
  async function save() {
    if (busy.value || image.busy.value || uncertain.value) return
    busy.value = true; error.value = ''; success.value = false
    const epoch = session.epoch, avatar = image.attachment.value, submittedName = name.value
    draft.pending = { name: submittedName, avatarId: avatar?.id }; uncertain.value = true
    try {
      const user = await playerApi.updateProfile(submittedName, avatar || undefined)
      if (epoch !== session.epoch) return
      session.acceptUser(user)
      image.clear(); draft.pending = null; uncertain.value = false
      await resource.refresh()
      if (epoch === session.epoch) success.value = true
    } catch (cause) {
      if (epoch !== session.epoch) return
      const status = (cause as { status?: number }).status
      if (status && status !== 502 && status !== 504 && (cause as { outcome?: string }).outcome !== 'unknown') uncertain.value = false
      error.value = cause instanceof Error ? cause.message : '保存结果未确认，请核对结果'
    } finally { if (epoch === session.epoch) busy.value = false }
  }
</script>
