import { computed, ref, shallowRef, onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import { studioRequest } from '@/api/studio'
import { DEFAULT_APPEARANCE, type PublicAppearance } from '@/types/appearance'
import type { PlayerAppearance } from '@/types/player'
import { playerApi } from '@/api/player'
import { onSessionInvalidated, sessionRevision } from '@/api/sessionBoundary'
import { useSessionStore } from './session'

export const useAppearanceStore = defineStore('player-appearance', () => {
  const publicSaved = ref<PublicAppearance | null>(null)
  const effective = computed(() => publicSaved.value || DEFAULT_APPEARANCE)
  // Authenticated card art is deliberately separate from public branding and persistence.
  const session = useSessionStore()
  const playerSaved = shallowRef<PlayerAppearance | null>(null)
  const playerOwner = ref<string | null>(null)
  const playerImageAttempt = ref(0)
  const currentOwner = () => session.user?.role === 'player' && session.user.status === 'active' &&
    session.user.playerAccess?.login !== false ? session.user.id : null
  const orderCardImage = computed(() => currentOwner() === playerOwner.value ? playerSaved.value?.orderCardImage || null : null)
  const playerImageKey = computed(() => `${playerOwner.value}:${playerImageAttempt.value}:${playerSaved.value?.revision}:${orderCardImage.value?.id}`)
  let playerGeneration = 0, expectedPlayerRevision: number | null = null
  let playerController: AbortController | undefined
  let playerRead: Promise<void> | undefined
  let failures = 0, nextAttempt = 0, retryAfterUntil = 0

  function clearPlayerImage() {
    playerSaved.value = null
    playerOwner.value = null
    playerImageAttempt.value++
  }
  function cancelPlayerRead() {
    playerGeneration++
    playerController?.abort('inactive-card-image')
    playerController = undefined
    playerRead = undefined
    clearPlayerImage()
  }
  function resetPlayer() {
    cancelPlayerRead()
    expectedPlayerRevision = null
    failures = nextAttempt = retryAfterUntil = 0
  }
  const unsubscribe = onSessionInvalidated(resetPlayer)
  onScopeDispose(() => { unsubscribe(); resetPlayer() })

  function notePlayerRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      cancelPlayerRead()
      return
    }
    const previous = expectedPlayerRevision
    expectedPlayerRevision = revision
    if ((playerSaved.value && playerSaved.value.revision !== revision) ||
      (previous !== null && previous !== revision && playerRead)) {
      cancelPlayerRead()
      nextAttempt = retryAfterUntil
    }
  }
  function needsPlayerRefresh() {
    return !!currentOwner() && (!playerSaved.value || playerOwner.value !== currentOwner() ||
      (expectedPlayerRevision !== null && playerSaved.value.revision !== expectedPlayerRevision))
  }
  function validPlayerAppearance(value: PlayerAppearance) {
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) return false
    const image = value.orderCardImage
    return image === null || (!!image && typeof image.id === 'string' && image.id.length > 0 &&
      image.url === `/api/studio/uploads/${encodeURIComponent(image.id)}` &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(image.mime))
  }
  async function loadPlayer(revalidate = false, signal?: AbortSignal): Promise<void> {
    const owner = currentOwner()
    if (!owner) { resetPlayer(); return }
    if (signal?.aborted) return
    if (playerRead) return playerRead
    if ((!revalidate && !needsPlayerRefresh()) || Date.now() < retryAfterUntil ||
      (!revalidate && Date.now() < nextAttempt)) return
    const generation = ++playerGeneration, epoch = sessionRevision()
    const request = new AbortController()
    playerController = request
    const cancel = () => request.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    clearPlayerImage()
    const pending = (async () => {
      try {
        const result = await playerApi.appearance(request.signal)
        if (generation !== playerGeneration || epoch !== sessionRevision() || currentOwner() !== owner || request.signal.aborted) return
        if (!validPlayerAppearance(result) || (expectedPlayerRevision !== null && result.revision < expectedPlayerRevision))
          throw new Error('订单图片配置暂不可用')
        playerOwner.value = owner
        playerSaved.value = { revision: result.revision, orderCardImage: result.orderCardImage }
        // A newer authenticated read may precede the next lightweight summary.
        expectedPlayerRevision = result.revision
        failures = nextAttempt = retryAfterUntil = 0
      } catch (cause) {
        if (generation !== playerGeneration || epoch !== sessionRevision() || currentOwner() !== owner) return
        clearPlayerImage()
        if (!request.signal.aborted) {
          failures = Math.min(3, failures + 1)
          retryAfterUntil = Math.max(retryAfterUntil, Date.now() + Number((cause as { retryAfter?: number }).retryAfter || 0))
          nextAttempt = Math.max(retryAfterUntil, Date.now() + 15000 * 2 ** (failures - 1))
        }
      } finally {
        signal?.removeEventListener('abort', cancel)
        if (generation === playerGeneration) { playerRead = undefined; playerController = undefined }
      }
    })()
    playerRead = pending
    return pending
  }
  let version = 0
  async function loadPublic() {
    const requestVersion = ++version
    const result = await studioRequest<PublicAppearance>('appearance/public')
    const publicImage = (image: PublicAppearance['logo']) =>
      image ? { ...image, url: `/api/studio/public-assets/${encodeURIComponent(image.id)}` } : null
    const value: PublicAppearance = {
      studioName: result.studioName,
      logo: publicImage(result.logo),
      login: {
        ...DEFAULT_APPEARANCE.login,
        ...result.login,
        illustration: {
          ...(result.login.illustration || DEFAULT_APPEARANCE.login.illustration),
          image: publicImage(result.login.illustration?.image || null)
        },
        background: {
          ...result.login.background,
          image: publicImage(result.login.background.image)
        }
      },
      glass: result.glass || DEFAULT_APPEARANCE.glass
    }
    if (version === requestVersion) publicSaved.value = value
    return value
  }
  return { publicSaved, effective, loadPublic, playerSaved, orderCardImage, playerImageKey,
    notePlayerRevision, needsPlayerRefresh, loadPlayer, cancelPlayerRead }
})
