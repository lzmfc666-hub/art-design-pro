import type { Attachment } from './studio'

/** Only the published worker-facing projection is exposed to this application. */
export interface Publication {
  id: string
  type: 'announcement' | 'banner'
  title: string
  text: string
  body: string
  image: Attachment | null
  sortOrder: number
  startAt: string | null
  endAt: string | null
  publishedAt: string
}

export interface PlayerContentFeed {
  announcements: Publication[]
  banners: Publication[]
  serverTime: string
}
