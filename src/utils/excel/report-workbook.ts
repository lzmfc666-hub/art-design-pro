import * as XLSX from 'xlsx'

export type ReportValue = string | number | boolean | null

export interface ReportField {
  key: string
  label: string
  type: 'text' | 'number'
}

export interface ReportSheet {
  name: string
  fields: ReportField[]
  rows: Record<string, ReportValue>[]
}

export interface ReportWorkbookOptions {
  maxRows?: number
  autoIndex?: boolean
  indexColumnTitle?: string
}

export class ReportWorkbookError extends Error {
  code: string
  details?: unknown

  constructor(message: string, code: string, details?: unknown) {
    super(message)
    this.name = 'ReportWorkbookError'
    this.code = code
    this.details = details
  }
}

/** 截断时保留完整 Unicode 字符，同时遵守 Excel 的 31 字符长度限制。 */
const truncateSheetName = (name: string, maxLength: number): string => {
  let result = ''
  for (const character of name) {
    if (result.length + character.length > maxLength) break
    result += character
  }
  return result
}

const uniqueSheetName = (name: string, usedNames: Set<string>): string => {
  const cleanName = Array.from(name, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
  const baseName =
    cleanName
      .replace(/[\\/*?:[\]]/g, ' ')
      .trim()
      .replace(/^'+|'+$/g, '')
      .trim() || 'Sheet'
  let candidate = truncateSheetName(baseName, 31)
  let suffixNumber = 2

  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` (${suffixNumber++})`
    candidate = `${truncateSheetName(baseName, 31 - suffix.length)}${suffix}`
  }

  usedNames.add(candidate.toLowerCase())
  return candidate
}

/** 文本始终按字符串写入，保留前导零、长编号和看似公式的内容。 */
const textCell = (value: string): XLSX.CellObject => ({ t: 's', v: value, z: '@' })

const valueCell = (
  value: ReportValue | undefined,
  field: ReportField,
  rowIndex: number
): XLSX.CellObject => {
  if (value === null || value === undefined || value === '') return textCell('')

  if (field.type === 'number') {
    // 未配置的业务金额保持明确占位，不能误写成零或阻断整份报表。
    if (value === '待配置') return textCell(value)

    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN

    if (!Number.isFinite(numericValue)) {
      throw new ReportWorkbookError(
        `第 ${rowIndex + 1} 行的“${field.label}”必须是有效数字`,
        'INVALID_NUMBER',
        { rowIndex, fieldKey: field.key }
      )
    }

    return {
      t: 'n',
      v: numericValue,
      z: /（元）|（%）/.test(field.label) ? '0.00' : '0.###############'
    }
  }

  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new ReportWorkbookError('单元格包含不支持的数据类型', 'INVALID_CELL_VALUE', {
      rowIndex,
      fieldKey: field.key
    })
  }

  return textCell(String(value))
}

/** 仅按所选字段创建工作簿；所有工作表合计遵守最大数据行数限制。 */
export const buildReportWorkbook = (
  sheets: ReportSheet[],
  options: ReportWorkbookOptions = {}
): XLSX.WorkBook => {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new ReportWorkbookError('没有可导出的工作表', 'NO_SHEETS')
  }

  const maxRows = options.maxRows ?? 100000
  if (!Number.isSafeInteger(maxRows) || maxRows < 0) {
    throw new ReportWorkbookError('最大导出行数必须是非负整数', 'INVALID_MAX_ROWS')
  }

  let totalRows = 0
  for (const sheet of sheets) {
    if (!sheet || typeof sheet.name !== 'string' || !Array.isArray(sheet.rows)) {
      throw new ReportWorkbookError('工作表数据格式无效', 'INVALID_SHEET')
    }

    if (!Array.isArray(sheet.fields) || sheet.fields.length === 0) {
      throw new ReportWorkbookError('每个工作表至少需要选择一个字段', 'NO_FIELDS')
    }

    const fieldKeys = new Set<string>()
    for (const field of sheet.fields) {
      if (
        !field ||
        typeof field.key !== 'string' ||
        field.key === '' ||
        typeof field.label !== 'string' ||
        !['text', 'number'].includes(field.type) ||
        fieldKeys.has(field.key)
      ) {
        throw new ReportWorkbookError('工作表字段配置无效或重复', 'INVALID_FIELDS')
      }
      fieldKeys.add(field.key)
    }

    if (sheet.fields.length + (options.autoIndex ? 1 : 0) > 16384) {
      throw new ReportWorkbookError('工作表列数超过 Excel 限制', 'EXCEED_MAX_COLUMNS')
    }

    if (sheet.rows.length > 1048575) {
      throw new ReportWorkbookError('工作表行数超过 Excel 限制', 'EXCEED_SHEET_ROWS')
    }

    totalRows += sheet.rows.length
  }

  if (totalRows > maxRows) {
    throw new ReportWorkbookError(`数据行数超过限制（${maxRows}行）`, 'EXCEED_MAX_ROWS', {
      currentRows: totalRows,
      maxRows
    })
  }

  const workbook = XLSX.utils.book_new()
  const usedNames = new Set<string>()

  for (const sheet of sheets) {
    const offset = options.autoIndex ? 1 : 0
    const labels = sheet.fields.map((field) => field.label)
    if (options.autoIndex) labels.unshift(options.indexColumnTitle ?? '序号')

    const worksheet: XLSX.WorkSheet = {}
    const widths = labels.map((label) => label.length)
    labels.forEach((label, columnIndex) => {
      worksheet[XLSX.utils.encode_cell({ r: 0, c: columnIndex })] = textCell(label)
    })

    sheet.rows.forEach((row, rowIndex) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new ReportWorkbookError('数据行必须是对象格式', 'INVALID_ROW', { rowIndex })
      }

      if (options.autoIndex) {
        worksheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: 0 })] = {
          t: 'n',
          v: rowIndex + 1
        }
      }

      sheet.fields.forEach((field, fieldIndex) => {
        const columnIndex = fieldIndex + offset
        const value = Object.hasOwn(row, field.key) ? row[field.key] : undefined
        const cell = valueCell(value, field, rowIndex)
        worksheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex })] = cell
        if (rowIndex < 100) {
          widths[columnIndex] = Math.max(widths[columnIndex], String(cell.v ?? '').length)
        }
      })
    })

    worksheet['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: sheet.rows.length, c: labels.length - 1 }
    })
    worksheet['!cols'] = widths.map((width) => ({ wch: Math.min(Math.max(width + 2, 8), 50) }))
    XLSX.utils.book_append_sheet(workbook, worksheet, uniqueSheetName(sheet.name, usedNames))
  }

  return workbook
}
