import type { Attachment } from './studio'

export interface AppearanceBackground {
  mode: 'default' | 'color' | 'image'
  color: string
  image: Attachment | null
  overlay: number
}
export interface PublicAppearance {
  studioName: string
  logo: Attachment | null
  login: {
    title: string
    subtitle: string
    description: string
    illustration: { mode: 'default' | 'image'; image: Attachment | null }
    background: AppearanceBackground
  }
  glass: { enabled: boolean }
}
export const DEFAULT_APPEARANCE: PublicAppearance = {
  studioName: '电竞工作室',
  logo: null,
  login: {
    title: '欢迎使用工作室打手端',
    subtitle: '开始今天的任务',
    description: '账号由工作室管理员分配，忘记密码请联系管理员。',
    illustration: { mode: 'default', image: null },
    background: { mode: 'default', color: '#eef4ff', image: null, overlay: 50 }
  },
  glass: { enabled: false }
}
