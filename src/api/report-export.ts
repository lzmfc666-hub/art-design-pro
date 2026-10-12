import { studioRequest } from './studio'
import { useStudioStore } from '@/store/modules/studio'

export interface ReportField {
  key: string
  label: string
  type: 'text' | 'number'
  default?: boolean
}
export interface ReportModule {
  id: string
  label: string
  group: string
  description: string
  dateLabel?: string
  dateKeys?: { key: string; label: string }[]
  fields: ReportField[]
  rowCount: number
}
export interface ExportCatalog {
  month: string
  period?: { type: ReportPeriodType; start: string; end: string; label: string }
  modules: ReportModule[]
}
export interface ReportFilters {
  dateRange?: [string, string]
  keyword?: string
  keywordField?: string
  archived?: 'all' | 'hot' | 'archive'
  personId?: string
  platformId?: string
  status?: string
  orderDateKey?: 'createdAt' | 'paidAt' | 'completedAt'
}
export interface ReportRequest {
  month: string
  period?: { type: ReportPeriodType; date?: string }
  modules: { id: string; fields: string[] }[]
  filters: ReportFilters
}
export interface ReportSheet {
  id: string
  name: string
  fields: ReportField[]
  rows: Record<string, string | number | boolean | null>[]
  rowCount: number
}
export interface ReportResult {
  month: string
  period?: { type: ReportPeriodType; start: string; end: string; label: string }
  sheets: ReportSheet[]
  generatedAt: string
}
export type ReportPeriodType = 'daily' | 'weekly' | 'monthly' | 'total'

async function request<T>(path: string, body?: ReportRequest) {
  try {
    return await studioRequest<T>(path, body, body ? 'POST' : 'GET')
  } catch (cause) {
    if ((cause as { status?: number }).status === 401) useStudioStore().clearSession()
    throw cause
  }
}
export const getExportCatalog = (
  month: string,
  period?: ReportRequest['period'],
  archived: NonNullable<ReportFilters['archived']> = 'all'
) =>
  request<ExportCatalog>(
    `exports/catalog?${new URLSearchParams({ month, archived, ...(period ? { periodType: period.type, ...(period.date ? { periodDate: period.date } : {}) } : {}) }).toString()}`
  )
export const previewReports = (body: ReportRequest) =>
  request<ReportResult>('exports/preview', body)
export const downloadReports = (body: ReportRequest) =>
  request<ReportResult>('exports/download', body)
