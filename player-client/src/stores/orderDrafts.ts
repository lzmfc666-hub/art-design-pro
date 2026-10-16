import { onSessionInvalidated } from '@/api/sessionBoundary'
import type { Attachment } from '@/types/studio'
import type { PlayerOrder } from '@/types/player'

export interface OrderDraft {
  target: PlayerOrder
  reason: string
  returnReason: string
  teammateId: string
  screenshots: Attachment[]
}
const drafts = new Map<string, OrderDraft>()
onSessionInvalidated(() => drafts.clear())
export const readOrderDraft = (id: string) => {
  const draft = drafts.get(id)
  return draft ? JSON.parse(JSON.stringify(draft)) as OrderDraft : null
}
export const saveOrderDraft = (id: string, draft: OrderDraft) => {
  if (drafts.size >= 30 && !drafts.has(id)) drafts.delete(drafts.keys().next().value!)
  drafts.set(id, JSON.parse(JSON.stringify(draft)))
}
export const clearOrderDraft = (id: string) => drafts.delete(id)
