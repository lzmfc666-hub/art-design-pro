<!-- 导出 Excel 文件 -->
<template>
  <ElButton
    :type="type"
    :size="size"
    :loading="isExporting"
    :disabled="disabled || isExporting || !hasData"
    v-ripple
    @click="handleExport"
  >
    <template #loading>
      <ElIcon class="is-loading">
        <Loading />
      </ElIcon>
      {{ loadingText }}
    </template>
    <slot>{{ buttonText }}</slot>
  </ElButton>
</template>

<script setup lang="ts">
  import * as XLSX from 'xlsx'
  import FileSaver from 'file-saver'
  import { ref, computed, nextTick, readonly } from 'vue'
  import { Loading } from '@element-plus/icons-vue'
  import type { ButtonType } from 'element-plus'
  import {
    buildReportWorkbook,
    ReportWorkbookError,
    type ReportSheet,
    type ReportValue
  } from '@/utils/excel/report-workbook'

  defineOptions({ name: 'ArtExcelExport' })

  /** 保留原单表导出数据格式。 */
  type ExportValue = string | number | boolean | null | undefined | Date

  interface ExportData {
    [key: string]: ExportValue
  }

  interface ColumnConfig {
    title: string
    width?: number
    formatter?: (value: ExportValue, row: ExportData, index: number) => string
  }

  interface ExportOptions {
    /** 原单表数据源，与 headers、columns 一起继续受支持。 */
    data?: ExportData[]
    /** 每张工作表仅导出 fields 中明确选择的字段。 */
    sheets?: ReportSheet[]
    /** 点击时获取最新且已按权限过滤的数据；失败时终止下载。 */
    prepareExport?: () => Promise<ReportSheet[]>
    filename?: string
    sheetName?: string
    type?: ButtonType
    size?: 'large' | 'default' | 'small'
    disabled?: boolean
    buttonText?: string
    loadingText?: string
    autoIndex?: boolean
    indexColumnTitle?: string
    columns?: Record<string, ColumnConfig>
    headers?: Record<string, string>
    /** 所有工作表合计的最大数据行数。 */
    maxRows?: number
    showSuccessMessage?: boolean
    showErrorMessage?: boolean
    workbookOptions?: {
      creator?: string
      lastModifiedBy?: string
      created?: Date
      modified?: Date
    }
  }

  const props = withDefaults(defineProps<ExportOptions>(), {
    data: () => [],
    filename: () => `export_${new Date().toISOString().slice(0, 10)}`,
    sheetName: 'Sheet1',
    type: 'primary',
    size: 'default',
    disabled: false,
    buttonText: '导出 Excel',
    loadingText: '导出中...',
    autoIndex: false,
    indexColumnTitle: '序号',
    columns: () => ({}),
    headers: () => ({}),
    maxRows: 100000,
    showSuccessMessage: true,
    showErrorMessage: true,
    workbookOptions: () => ({})
  })

  const emit = defineEmits<{
    'before-export': [data: ExportData[]]
    'export-success': [filename: string, rowCount: number]
    'export-error': [error: ExportError]
    'export-progress': [progress: number]
  }>()

  class ExportError extends ReportWorkbookError {
    constructor(message: string, code: string, details?: unknown) {
      super(message, code, details)
      this.name = 'ExportError'
    }
  }

  const isExporting = ref(false)

  /** 预处理导出允许初始数据为空；显式工作表允许仅导出表头。 */
  const hasData = computed(
    () =>
      Boolean(props.prepareExport) ||
      (props.sheets !== undefined
        ? Array.isArray(props.sheets) && props.sheets.length > 0
        : Array.isArray(props.data) && props.data.length > 0)
  )

  const formatLegacyValue = (
    value: ExportValue,
    key: string,
    row: ExportData,
    index: number
  ): ReportValue => {
    const column = props.columns[key]
    if (column?.formatter) return column.formatter(value, row, index)
    if (value === null || value === undefined) return ''
    if (value instanceof Date) return value.toLocaleDateString('zh-CN')
    if (typeof value === 'boolean') return value ? '是' : '否'
    return value
  }

  /** 将原 API 转成单张报表，同时保留标题、格式化函数和数值类型。 */
  const createLegacySheets = (data: ExportData[]): ReportSheet[] => {
    if (!Array.isArray(data)) {
      throw new ExportError('数据必须是数组格式', 'INVALID_DATA_TYPE')
    }
    if (data.length === 0) throw new ExportError('没有可导出的数据', 'NO_DATA')
    if (data.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new ExportError('数据行必须是对象格式', 'INVALID_ROW')
    }

    const keys = [...new Set(data.flatMap((row) => Object.keys(row)))]
    const fields: ReportSheet['fields'] = keys.map((key) => {
      const values = data.map((row) => row[key]).filter((value) => value != null)
      return {
        key,
        label: props.columns[key]?.title || props.headers[key] || key,
        type:
          !props.columns[key]?.formatter &&
          values.length > 0 &&
          values.every((value) => typeof value === 'number')
            ? 'number'
            : 'text'
      }
    })

    return [
      {
        name: props.sheetName,
        fields,
        rows: data.map((row, index) =>
          Object.fromEntries(keys.map((key) => [key, formatLegacyValue(row[key], key, row, index)]))
        )
      }
    ]
  }

  const downloadWorkbook = async (workbook: XLSX.WorkBook): Promise<void> => {
    workbook.Props = {
      Title: props.filename,
      Subject: '数据导出',
      Author: props.workbookOptions.creator || 'Art Design Pro',
      Manager: props.workbookOptions.lastModifiedBy || '',
      Company: '系统导出',
      Category: '数据',
      Keywords: 'excel,export,data',
      Comments: '由系统自动生成',
      CreatedDate: props.workbookOptions.created || new Date(),
      ModifiedDate: props.workbookOptions.modified || new Date()
    }

    emit('export-progress', 70)
    const excelBuffer = XLSX.write(workbook, {
      bookType: 'xlsx',
      type: 'array',
      compression: true
    })
    const blob = new Blob([excelBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    emit('export-progress', 95)

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    FileSaver.saveAs(blob, `${props.filename}_${timestamp}.xlsx`)
    emit('export-progress', 100)
    await nextTick()
  }

  const handleExport = async (): Promise<void> => {
    if (isExporting.value || props.disabled) return
    isExporting.value = true

    try {
      // 先通知父组件，再读取新鲜数据；预处理失败时不会使用旧数据下载。
      emit('before-export', props.data)
      emit('export-progress', 10)
      const sheets = props.prepareExport
        ? await props.prepareExport()
        : (props.sheets ?? createLegacySheets(props.data))
      emit('export-progress', 30)

      const workbook = buildReportWorkbook(sheets, {
        maxRows: props.maxRows,
        autoIndex: props.autoIndex,
        indexColumnTitle: props.indexColumnTitle
      })

      if (!props.prepareExport && props.sheets === undefined) {
        const worksheet = workbook.Sheets[workbook.SheetNames[0]]
        sheets[0].fields.forEach((field, index) => {
          const width = props.columns[field.key]?.width
          if (width && worksheet['!cols']) {
            worksheet['!cols'][index + (props.autoIndex ? 1 : 0)] = { wch: width }
          }
        })
      }

      emit('export-progress', 50)
      const rowCount = sheets.reduce((count, sheet) => count + sheet.rows.length, 0)
      await downloadWorkbook(workbook)
      emit('export-success', props.filename, rowCount)

      if (props.showSuccessMessage) {
        ElMessage.success({ message: `成功导出 ${rowCount} 条数据`, duration: 3000 })
      }
    } catch (error) {
      const exportError =
        error instanceof ReportWorkbookError
          ? new ExportError(error.message, error.code, error.details)
          : new ExportError(
              `导出失败: ${error instanceof Error ? error.message : String(error)}`,
              'EXPORT_FAILED',
              error
            )
      emit('export-error', exportError)

      if (props.showErrorMessage) {
        ElMessage.error({ message: exportError.message, duration: 5000 })
      }
      console.error('Excel 导出错误:', exportError)
    } finally {
      isExporting.value = false
      emit('export-progress', 0)
    }
  }

  defineExpose({
    exportData: handleExport,
    isExporting: readonly(isExporting),
    hasData
  })
</script>

<style scoped>
  .is-loading {
    animation: rotating 2s linear infinite;
  }

  @keyframes rotating {
    0% {
      transform: rotate(0deg);
    }

    100% {
      transform: rotate(360deg);
    }
  }
</style>
