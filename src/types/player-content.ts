import type { Attachment } from './studio'

export type PlayerContentType = 'announcement' | 'banner'
export type PlayerContentStatus = 'draft' | 'scheduled' | 'active' | 'expired' | 'offline'

export interface PlayerContentFields {
  type: PlayerContentType
  title: string
  text: string
  body: string
  image: Attachment | null
  sortOrder: number
  startAt: string | null
  endAt: string | null
}

export interface PlayerContentPublication extends PlayerContentFields {
  id: string
  publishedAt: string
}

export interface PlayerContentItem extends PlayerContentFields {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
  updatedBy: string
  status: PlayerContentStatus
  hasUnpublishedChanges: boolean
  published: PlayerContentPublication | null
}

export interface PlayerContentList {
  items: PlayerContentItem[]
  serverTime: string
}
