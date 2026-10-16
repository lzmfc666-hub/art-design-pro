import { studioRequest } from './studio'
import type { PlayerContentFeed, Publication } from '@/types/content'

export const contentApi = {
  feed: (signal?: AbortSignal) =>
    studioRequest<PlayerContentFeed>('player/content', undefined, 'GET', signal),
  detail: (id: string, signal?: AbortSignal) =>
    studioRequest<Publication>(`player/content/${encodeURIComponent(id)}`, undefined, 'GET', signal)
}

/** Content pictures are read from the protected worker endpoint, never a supplied external URL. */
export function contentImageUrl(item: Publication | null | undefined) {
  const url = item?.image?.url || ''
  return /^\/api\/studio\/player\/content-assets\/[A-Za-z0-9_-]+$/.test(url) ? url : ''
}
