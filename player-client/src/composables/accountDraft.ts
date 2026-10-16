import { reactive } from 'vue'
import { onSessionInvalidated, sessionRevision } from '@/api/sessionBoundary'

const drafts = new Map<string, { value: object; reset: () => void }>()
onSessionInvalidated(() => { for (const draft of drafts.values()) draft.reset(); drafts.clear() })

/** Navigation drafts exist only in memory and are erased synchronously on account/permission changes. */
export function accountDraft<T extends object>(key: string, initial: () => T): T {
  const scopedKey = `${sessionRevision()}:${key}`, existing = drafts.get(scopedKey)
  if (existing) return existing.value as T
  const value = reactive(initial()) as T
  drafts.set(scopedKey, { value, reset: () => { Object.assign(value, initial()) } })
  return value
}
