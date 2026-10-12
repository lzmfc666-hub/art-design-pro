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
  modules: ReportModule[]
}
export interface ReportFilters {
  dateRange?: [string, string]
  keyword?: string
  personId?: string
  platformId?: string
  status?: string
  orderDateKey?: 'createdAt' | 'paidAt' | 'completedAt'
}
export interface ReportRequest {
  month: string
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
  sheets: ReportSheet[]
  generatedAt: string
}

async function request<T>(path: string, body?: ReportRequest) {
  try {
    return await studioRequest<T>(path, body, body ? 'POST' : 'GET')
  } catch (cause) {
    if ((cause as { status?: number }).status === 401) useStudioStore().clearSession()
    throw cause
  }
}
export const getExportCatalog = (month: string) =>
  request<ExportCatalog>(`exports/catalog?month=${encodeURIComponent(month)}`)
export const previewReports = (body: ReportRequest) =>
  request<ReportResult>('exports/preview', body)
export const downloadReports = (body: ReportRequest) =>
  request<ReportResult>('exports/download', body)
