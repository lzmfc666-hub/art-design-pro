import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as XLSX from 'xlsx'
import { computed, nextTick, readonly, ref } from 'vue'
import { parse } from '@vue/compiler-sfc'
import { buildReportWorkbook, ReportWorkbookError } from '../src/utils/excel/report-workbook.ts'

const roundTrip = (sheets, options) => {
  const workbook = buildReportWorkbook(sheets, options)
  return XLSX.read(XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }), {
    type: 'buffer',
    cellNF: true
  })
}
const textField = (key, label = key) => ({ key, label, type: 'text' })
const numberField = (key, label = key) => ({ key, label, type: 'number' })

test('xlsx 文件往返保留选定字段、文本编号和公式前缀，金额是可计算数字', () => {
  const values = ['0000123', '123456789012345678901234', '=SUM(A1:A2)', '+123', '-001', '@用户名']
  const workbook = roundTrip([
    {
      name: '订单',
      fields: [textField('code', '订单号'), numberField('amount', '金额（元）')],
      rows: values.map((code, index) => ({
        code,
        amount: index === 0 ? 1234.56 : -12.34,
        privateColumn: '未选择的敏感字段'
      }))
    }
  ])
  const sheet = workbook.Sheets.订单
  assert.equal(sheet['!ref'], 'A1:B7')
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1 })[0], ['订单号', '金额（元）'])
  values.forEach((value, index) => {
    const cell = sheet[`A${index + 2}`]
    assert.equal(cell.v, value)
    assert.equal(cell.t, 's')
    assert.equal(cell.f, undefined)
  })
  assert.equal(sheet.B2.v, 1234.56)
  assert.equal(sheet.B2.t, 'n')
  assert.equal(sheet.B2.z, '0.00')
  assert.equal(sheet.B3.v, -12.34)
  assert.equal(sheet.C1, undefined)
})

test('空模块仍有所选表头，多张工作表和自定义序号按选择顺序导出', () => {
  const workbook = roundTrip(
    [
      {
        name: '空模块',
        fields: [textField('b', '后列'), textField('a', '前列')],
        rows: []
      },
      {
        name: '工时',
        fields: [numberField('hours', '实际工时（小时）'), textField('name', '人员')],
        rows: [
          { name: '甲', hours: 2.75 },
          { name: '乙', hours: 1 }
        ]
      }
    ],
    { autoIndex: true, indexColumnTitle: '编号' }
  )
  assert.deepEqual(workbook.SheetNames, ['空模块', '工时'])
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets.空模块, { header: 1 }), [
    ['编号', '后列', '前列']
  ])
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets.工时, { header: 1 }), [
    ['编号', '实际工时（小时）', '人员'],
    [1, 2.75, '甲'],
    [2, 1, '乙']
  ])
})

test('数字字段的待配置占位保留为文本，不当作零，空白仍为空白', () => {
  const workbook = roundTrip([
    {
      name: '工资',
      fields: [numberField('amount', '底薪（元）'), numberField('rate', '提成（%）')],
      rows: [
        { amount: '待配置', rate: '待配置' },
        { amount: null, rate: '' },
        { amount: 0, rate: 3.25 }
      ]
    }
  ])
  assert.equal(workbook.Sheets.工资.A2.v, '待配置')
  assert.equal(workbook.Sheets.工资.A2.t, 's')
  assert.equal(workbook.Sheets.工资.B2.v, '待配置')
  assert.equal(workbook.Sheets.工资.A3.v, '')
  assert.equal(workbook.Sheets.工资.A4.v, 0)
  assert.equal(workbook.Sheets.工资.B4.v, 3.25)
  assert.equal(workbook.Sheets.工资.B4.t, 'n')
})

test('工作表名称合法、最长31字符，并在截断后按不区分大小写去重', () => {
  const names = [
    '非法[]:*?/\\名称',
    "'引号名称'",
    'x'.repeat(45),
    'X'.repeat(45),
    '[]:*?/\\',
    '',
    '😀'.repeat(30),
    '😀'.repeat(30)
  ]
  const workbook = roundTrip(names.map((name) => ({ name, fields: [textField('a')], rows: [] })))
  assert.equal(workbook.SheetNames.length, names.length)
  assert.equal(new Set(workbook.SheetNames.map((name) => name.toLowerCase())).size, names.length)
  workbook.SheetNames.forEach((name) => {
    assert.ok(name.length > 0 && name.length <= 31)
    assert.doesNotMatch(name, /[\\/*?:[\]]/)
    assert.ok(!name.startsWith("'") && !name.endsWith("'"))
    assert.ok(!/[\ud800-\udbff]$/.test(name))
  })
  assert.equal(workbook.SheetNames[4], 'Sheet')
  assert.equal(workbook.SheetNames[5], 'Sheet (2)')
})

test('maxRows 校验所有工作表合计，等于限制可导出，超过限制拒绝', () => {
  const sheets = ['一', '二'].map((name) => ({
    name,
    fields: [numberField('value')],
    rows: [{ value: 1 }, { value: 2 }]
  }))
  assert.equal(buildReportWorkbook(sheets, { maxRows: 4 }).SheetNames.length, 2)
  assert.throws(
    () => buildReportWorkbook(sheets, { maxRows: 3 }),
    (error) => error.code === 'EXCEED_MAX_ROWS' && error.details.currentRows === 4
  )
  assert.equal(
    buildReportWorkbook([{ name: '空表', fields: [textField('value')], rows: [] }], { maxRows: 0 })
      .SheetNames.length,
    1
  )
})

test('拒绝无字段、重复字段、非有限数值和非法行，原始输入保持不变', () => {
  const valid = { name: '报表', fields: [numberField('amount')], rows: [{ amount: 12.34 }] }
  const copy = structuredClone(valid)
  buildReportWorkbook([valid], { autoIndex: true })
  assert.deepEqual(valid, copy)
  assert.throws(
    () => buildReportWorkbook([]),
    (error) => error.code === 'NO_SHEETS'
  )
  assert.throws(
    () => buildReportWorkbook([{ ...valid, fields: [] }]),
    (error) => error.code === 'NO_FIELDS'
  )
  assert.throws(
    () => buildReportWorkbook([{ ...valid, fields: [textField('a'), textField('a')] }]),
    (error) => error.code === 'INVALID_FIELDS'
  )
  for (const amount of [NaN, Infinity, '=A1', '金额错误']) {
    assert.throws(
      () => buildReportWorkbook([{ ...valid, rows: [{ amount }] }]),
      (error) => error.code === 'INVALID_NUMBER'
    )
  }
  assert.throws(
    () => buildReportWorkbook([{ ...valid, rows: [null] }]),
    (error) => error.code === 'INVALID_ROW'
  )
})

// 执行组件的真实 setup 逻辑，仅替代 Vue 宏及文件下载，验证异步流程和原 API。
const componentSource = parse(
  readFileSync(
    new URL('../src/components/core/forms/art-excel-export/index.vue', import.meta.url),
    'utf8'
  )
).descriptor.scriptSetup.content
const setupSource = stripTypeScriptTypes(
  componentSource.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, ''),
  { mode: 'strip' }
)

const exportHarness = (props) => {
  const events = []
  const downloads = []
  let exposed
  const bindings = {
    XLSX,
    FileSaver: { saveAs: (blob, filename) => downloads.push({ blob, filename }) },
    ref,
    computed,
    nextTick,
    readonly,
    buildReportWorkbook,
    ReportWorkbookError,
    ElMessage: { success() {}, error() {} },
    console: { error() {} },
    defineOptions() {},
    defineProps: () => props,
    withDefaults: (values, defaults) => ({
      ...Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [
          key,
          typeof value === 'function' ? value() : value
        ])
      ),
      ...values
    }),
    defineEmits:
      () =>
      (event, ...args) =>
        events.push({ event, args }),
    defineExpose: (value) => {
      exposed = value
    }
  }
  new Function(...Object.keys(bindings), setupSource)(...Object.values(bindings))
  return { exposed, events, downloads }
}
const downloadedWorkbook = async (download) =>
  XLSX.read(await download.blob.arrayBuffer(), { type: 'array' })

test('prepareExport 可在初始空数据时点击，before-export 先触发，等待期间重复调用被锁定', async () => {
  let resolvePreparation
  let prepareCount = 0
  const harness = exportHarness({
    filename: '新鲜测试',
    prepareExport: () => {
      prepareCount++
      assert.equal(harness.events[0].event, 'before-export')
      return new Promise((resolve) => {
        resolvePreparation = resolve
      })
    }
  })
  assert.equal(harness.exposed.hasData.value, true)
  const exporting = harness.exposed.exportData()
  assert.equal(harness.exposed.isExporting.value, true)
  await harness.exposed.exportData()
  assert.equal(prepareCount, 1)
  assert.equal(harness.downloads.length, 0)
  resolvePreparation([{ name: '新鲜数据', fields: [textField('a')], rows: [{ a: '最新记录' }] }])
  await exporting
  assert.equal(harness.exposed.isExporting.value, false)
  assert.equal(harness.downloads.length, 1)
  const workbook = await downloadedWorkbook(harness.downloads[0])
  assert.equal(workbook.Sheets.新鲜数据.A2.v, '最新记录')
  assert.deepEqual(harness.events.find((entry) => entry.event === 'export-success').args, [
    '新鲜测试',
    1
  ])
})

test('准备数据失败触发 export-error 并恢复按钮，已有旧数据不会被下载', async () => {
  const harness = exportHarness({
    data: [{ a: '旧数据' }],
    prepareExport: async () => {
      throw new Error('当前账号无权导出此模块')
    }
  })
  await harness.exposed.exportData()
  assert.equal(harness.downloads.length, 0)
  assert.equal(harness.exposed.isExporting.value, false)
  assert.match(
    harness.events.find((entry) => entry.event === 'export-error').args[0].message,
    /当前账号无权导出此模块/
  )
  assert.equal(
    harness.events.some((entry) => entry.event === 'export-success'),
    false
  )
})

test('原 data、headers、columns API 继续导出标题、格式化值、数字与序号', async () => {
  const harness = exportHarness({
    data: [{ code: '0001', amount: 12.34, enabled: true }],
    headers: { code: '订单号', enabled: '状态' },
    columns: {
      amount: { title: '金额', width: 20 },
      enabled: { title: '启用', formatter: () => '正常' }
    },
    autoIndex: true,
    filename: '原有示例'
  })
  await harness.exposed.exportData()
  assert.equal(harness.downloads.length, 1)
  const workbook = await downloadedWorkbook(harness.downloads[0])
  assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1, { header: 1 }), [
    ['序号', '订单号', '金额', '启用'],
    [1, '0001', 12.34, '正常']
  ])
})

test('组件导出前拒绝多表总行数超限，显式空表则可下载表头', async () => {
  const sheets = ['甲', '乙'].map((name) => ({
    name,
    fields: [textField('a')],
    rows: [{ a: name }]
  }))
  const limited = exportHarness({ sheets, maxRows: 1 })
  await limited.exposed.exportData()
  assert.equal(limited.downloads.length, 0)
  assert.equal(
    limited.events.find((entry) => entry.event === 'export-error').args[0].code,
    'EXCEED_MAX_ROWS'
  )
  const empty = exportHarness({ sheets: [{ ...sheets[0], rows: [] }] })
  assert.equal(empty.exposed.hasData.value, true)
  await empty.exposed.exportData()
  assert.equal(empty.downloads.length, 1)
  assert.deepEqual(
    XLSX.utils.sheet_to_json((await downloadedWorkbook(empty.downloads[0])).Sheets.甲, {
      header: 1
    }),
    [['a']]
  )
})
