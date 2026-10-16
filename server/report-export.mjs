import { ApiError, permissionsFor, shanghaiDate } from './studio.mjs'
import { APPEARANCE_ICON_DEFAULTS } from './appearance.mjs'
import { platformRules } from './platform-rules.mjs'

const MAX_ROWS = 100000
const roleNames = {
  owner: '工作室老板',
  manager: '店长',
  finance: '财务',
  hr: '人事',
  operations: '运营',
  support_lead: '客服主管',
  support: '客服',
  admin: '管理员',
  super_admin: '超级管理员',
  player: '打手'
}
const statuses = {
  pending: '待处理',
  active: '接单中 / 启用',
  review: '待验收',
  completed: '已完成',
  canceled: '已取消',
  paid: '已发放 / 已退款',
  rejected: '已驳回',
  approved: '审核通过',
  scheduled: '排班待登记',
  normal: '正常',
  rest: '休息',
  present: '实际到岗',
  leave: '请假',
  absent: '缺勤',
  disabled: '已停用'
}
const yuan = (value) => (value == null ? '待配置' : value / 100)
const percent = (value) => (value == null ? '待配置' : value / 100)
const timeFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})
const displayTime = (value) => {
  if (!value) return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : 'Invalid Date'
}
const permissionNames = {
  'orders.view': '查看全部订单',
  'orders.create': '创建和派单',
  'orders.edit': '编辑订单',
  'finance.review': '财务验收',
  'finance.refunds': '客户退款',
  'finance.withdrawals': '提现发放',
  'finance.expenses': '费用记账',
  'salary.view': '本人工资',
  'salary.all': '全员工资',
  'salary.manage': '工资方案及月结',
  'profit.view': '经营利润',
  'users.manage': '人员管理',
  'templates.manage': '订单模板',
  'settings.manage': '业务配置',
  'attendance.manage': '排班考勤',
  'logs.view': '操作日志',
  'reports.export': '导出业务数据'
}
const permissionText = (keys) => keys.map((key) => permissionNames[key] || key).join('、')
function* mapRows(rows, mapper) {
  let index = 0
  for (const row of rows) yield mapper(row, index++, rows)
}
function* flatMapRows(rows, mapper) {
  let index = 0
  for (const row of rows) yield* mapper(row, index++, rows)
}
const field = (key, label, type = 'text', selected = true) => ({
  key,
  label,
  type,
  default: selected
})
const fields = (items) =>
  items.map(([key, label, type, selected]) => field(key, label, type, selected))
const menuRows = [
  ['业务总览', '/dashboard/console', []],
  ['经营报表', '/dashboard/analysis', ['profit.view']],
  ['订单管理', '/orders/list', ['orders.view']],
  ['创建与派单', '/orders/create', ['orders.create']],
  ['老板管理', '/personnel/customers', ['orders.create', 'users.manage', 'finance.refunds']],
  [
    '验收与结算',
    '/finance/settlement',
    ['finance.review', 'finance.refunds', 'finance.withdrawals', 'finance.expenses']
  ],
  ['工资与提成', '/finance/salary', ['salary.view', 'salary.all', 'salary.manage']],
  ['排班与到岗', '/personnel/attendance', ['attendance.manage']],
  ['员工管理', '/personnel/employees', ['users.manage']],
  ['打手管理', '/personnel/players', ['users.manage', 'finance.withdrawals']],
  ['角色与权限', '/system/role', ['users.manage']],
  ['业务配置', '/system/business', ['templates.manage', 'settings.manage']],
  ['界面外观', '/system/appearance', ['settings.manage']],
  ['菜单权限', '/system/menu', ['users.manage']],
  ['操作日志', '/system/logs', ['logs.view']],
  ['个人中心', '/system/user-center', []],
  ['自选导出', '/reports/export', ['reports.export']]
]

function modulesFor(snapshot) {
  if (
    ['support', 'support_lead'].includes(snapshot.user.role) ||
    !snapshot.permissions.includes('reports.export')
  )
    throw new ApiError('客服账号不开放数据导出，或当前账号没有导出权限', 403)
  const can = (...keys) =>
    snapshot.user.role !== 'player' && keys.some((key) => snapshot.permissions.includes(key))
  const names = new Map()
  const name = (table, id) => {
    if (!id) return ''
    if (!names.has(table))
      names.set(table, new Map(snapshot[table].map((row) => [row.id, row.name])))
    return names.get(table).get(id) || id
  }
  const person = (id) => name('users', id)
  const platform = (id) => name('platforms', id)
  const shop = (id) => name('shops', id)
  const customer = (id) => name('customers', id)
  let orderMap
  const orderIdentity = (id) => {
    if (id && !orderMap) orderMap = new Map(snapshot.orders.map((row) => [row.id, row]))
    const order = orderMap?.get(id)
    return {
      orderNo: order?.orderNo || id,
      orderTitle: order?.title || '',
      platformName: platform(order?.platformId),
      _platforms: [order?.platformId],
      _people: [order?.creatorId, order?.leaderId, order?.teammateId]
    }
  }
  const receipt = (value) => ({ receiptName: value?.name || '', receiptUrl: value?.url || '' })
  const ownOrSalary = can('salary.view', 'salary.all')
  const all = []
  const add = (id, label, group, allowed, columns, rows, description = '', dateLabel = '') => {
    if (allowed)
      all.push({ id, label, group, description, dateLabel, fields: fields(columns), rows })
  }
  const monetary = (keys) => keys.map(([key, label]) => [key, label + '（元）', 'number'])
  const report = snapshot.reports
  const period = snapshot.exportPeriod
  const periodText = period ? `${period.label} ${period.start} 至 ${period.end}` : report.month
  const customerFundKinds = {
    recharge: '充值',
    deduction: '非订单扣款',
    return: '余额退还',
    'order-payment': '订单余额付款',
    'order-refund': '订单余额退款'
  }
  const depositKinds = { deposit: '缴纳押金', penalty: '离店押金没收', return: '押金退还' }
  const exitTypes = { leave: '离店', absconded: '跑路' }
  add(
    'customerAccounts',
    '老板客户储值账户',
    '人员资金',
    can('orders.view', 'orders.create', 'users.manage', 'finance.refunds'),
    [
      ['customerId', '客户 ID', 'text', false],
      ['customerName', '老板客户'],
      ['balance', '当前储值余额（元）', 'number'],
      ['balanceScope', '余额口径']
    ],
    () =>
      mapRows(snapshot.customerBalances || [], (row) => ({
        customerId: row.customerId,
        customerName: customer(row.customerId),
        balance: yuan(row.balance),
        balanceScope: '当前余额快照，并非所选期间期末余额',
        _customers: [row.customerId]
      })),
    '当前储值账户余额，不按所选日报、周报、月报或总计区间重建历史余额。充值、余额退还不计订单收入，交易明细见老板储值流水。'
  )
  add(
    'customerTransactions',
    '老板客户储值流水',
    '人员资金',
    can('finance.refunds'),
    [
      ['id', '流水 ID', 'text', false],
      ['accountId', '客户 ID', 'text', false],
      ['customerName', '老板客户'],
      ['kind', '交易类型'],
      ['amount', '交易金额（元）', 'number'],
      ['delta', '余额变动（元）', 'number'],
      ['balanceAfter', '本笔交易后余额（元）', 'number'],
      ['reason', '登记原因'],
      ['orderNo', '关联工作室订单号'],
      ['createdByName', '登记人'],
      ['createdAt', '登记时间'],
      ['receiptName', '凭证名称', 'text', false],
      ['receiptUrl', '凭证站内地址', 'text', false]
    ],
    () =>
      mapRows(snapshot.customerTransactions || [], (row) => ({
        id: row.id,
        accountId: row.accountId,
        customerName: customer(row.accountId),
        kind: customerFundKinds[row.kind] || row.kind,
        amount: yuan(row.amount),
        delta: yuan(row.delta),
        balanceAfter: yuan(row.balanceAfter),
        reason: row.reason,
        orderNo: row.orderId ? orderIdentity(row.orderId).orderNo : '',
        createdByName: row.createdByName || person(row.createdBy),
        createdAt: displayTime(row.createdAt),
        ...receipt(row.receipt),
        _date: row.createdAt,
        _people: [row.createdBy],
        _customers: [row.accountId]
      })),
    '按实际登记日期筛选完整授权流水，不只导出页面分页。充值和退还不计收入；订单余额支付按订单只计一次收入，非订单扣款计其他收入。交易后余额是该笔记录的余额，不代表所选期间末余额。',
    '实际交易登记日期'
  )
  add(
    'playerDeposits',
    '打手押金账户',
    '人员资金',
    can('finance.withdrawals') || snapshot.user.role === 'player',
    [
      ['userId', '打手 ID', 'text', false],
      ['name', '打手'],
      ['balance', '当前押金余额（元）', 'number'],
      ['balanceScope', '余额口径']
    ],
    () =>
      mapRows(snapshot.playerDeposits || [], (row) => ({
        userId: row.userId,
        name: person(row.userId),
        balance: yuan(row.balance),
        balanceScope: '当前余额快照，并非所选期间期末余额',
        _people: [row.userId]
      })),
    '当前押金余额与打手报酬钱包分开，不按报表期间重建历史。日常扣款只走报酬钱包；押金退还和没收仅用于离店或跑路处理。'
  )
  add(
    'playerDepositTransactions',
    '打手押金流水',
    '人员资金',
    can('finance.withdrawals') || snapshot.user.role === 'player',
    [
      ['id', '流水 ID', 'text', false],
      ['accountId', '打手 ID', 'text', false],
      ['name', '打手'],
      ['kind', '交易类型'],
      ['exitType', '离店类型'],
      ['amount', '交易金额（元）', 'number'],
      ['delta', '押金变动（元）', 'number'],
      ['balanceAfter', '本笔交易后押金余额（元）', 'number'],
      ['reason', '登记原因'],
      ['createdByName', '登记人'],
      ['createdAt', '登记时间'],
      ['receiptName', '凭证名称', 'text', false],
      ['receiptUrl', '凭证站内地址', 'text', false]
    ],
    () =>
      mapRows(snapshot.playerDepositTransactions || [], (row) => ({
        id: row.id,
        accountId: row.accountId,
        name: person(row.accountId),
        kind: depositKinds[row.kind] || row.kind,
        exitType: exitTypes[row.exitType] || '',
        amount: yuan(row.amount),
        delta: yuan(row.delta),
        balanceAfter: yuan(row.balanceAfter),
        reason: row.reason,
        createdByName: row.createdByName || person(row.createdBy),
        createdAt: displayTime(row.createdAt),
        ...receipt(row.receipt),
        _date: row.createdAt,
        _people: [row.accountId, row.createdBy]
      })),
    '按实际登记日期筛选完整授权流水。缴纳和退还押金不计收入；离店或跑路时的押金没收计其他收入，与日常报酬钱包扣款分开。交易后余额不代表所选期间期末余额。',
    '实际交易登记日期'
  )
  add(
    'playerAdjustments',
    '打手扣款与补款',
    '财务结算',
    can('finance.withdrawals'),
    [
      ['name', '打手'],
      ['kind', '调整类型'],
      ['amount', '申请金额（元）', 'number'],
      ['appliedAmount', '已入账金额（元）', 'number'],
      ['manualAmount', '待人工差额（元）', 'number'],
      ['status', '处理状态'],
      ['orderNo', '关联订单号'],
      ['reason', '原因'],
      ['createdByName', '登记人'],
      ['createdAt', '登记时间'],
      ['resolution', '差额处理结果'],
      ['resolutionReason', '处理说明']
    ],
    () =>
      mapRows(snapshot.playerAdjustments || [], (row) => ({
        ...row,
        name: person(row.userId),
        kind: row.kind === 'deduction' ? '扣款' : '补款',
        amount: yuan(row.amount),
        appliedAmount: yuan(row.appliedAmount),
        manualAmount: yuan(row.manualAmount),
        status: { applied: '已入账', manual: '待人工处理', resolved: '已处理' }[row.status],
        orderNo: orderIdentity(row.orderId).orderNo,
        createdByName: person(row.createdBy),
        createdAt: displayTime(row.createdAt),
        resolution:
          row.resolution === 'recovered'
            ? '已线下追回'
            : row.resolution === 'waived'
              ? '免除差额'
              : '',
        _date: row.createdAt,
        _status: row.status,
        _people: [row.userId, row.createdBy]
      })),
    '独立扣补款流水；已付提现不重写，差额按财务登记的实际处理结果保存。',
    '调整登记日期'
  )
  add(
    'rewardReviews',
    '旧报酬人工差额',
    '财务结算',
    can('finance.withdrawals'),
    [
      ['orderNo', '关联订单号'],
      ['expectedReward', '整单应结报酬（元）', 'number'],
      ['reason', '更正原因'],
      ['createdAt', '登记时间'],
      ['resolution', '人工处理说明'],
      ['resolvedAt', '处理时间']
    ],
    () =>
      mapRows(snapshot.rewardReviews || [], (row) => ({
        ...row,
        orderNo: orderIdentity(row.orderId).orderNo,
        expectedReward: yuan(row.expectedReward),
        createdAt: displayTime(row.createdAt),
        resolvedAt: displayTime(row.resolvedAt),
        _date: row.createdAt
      })),
    '旧报酬更正的人工处理记录，不将未知差额伪造为单个打手扣款。',
    '登记日期'
  )
  add(
    'customerOrderReferences',
    '客户平台订单号',
    '客户与配置',
    can('orders.create', 'users.manage', 'orders.view'),
    [
      ['customerName', '客户名称'],
      ['platformName', '订单来源'],
      ['shopName', '来源店铺'],
      ['externalOrderNo', '平台订单编号']
    ],
    () =>
      flatMapRows(snapshot.customers, (row) =>
        mapRows(row.orderReferences || [], (reference) => ({
          customerName: row.name,
          platformName: platform(reference.platformId),
          shopName: shop(reference.shopId),
          externalOrderNo: reference.externalOrderNo,
          _platforms: [reference.platformId]
        }))
      ),
    '客户档案中的平台编号关联记录，不形成订单营收。日期范围不适用。'
  )
  add(
    'overview',
    period ? `${period.label}经营汇总` : '经营月度汇总',
    '经营报表',
    can('profit.view'),
    [
      ['month', '统计区间'],
      ...monetary([
        ['received', '收款'],
        ['refunds', '退款'],
        ['net', '净收入'],
        ['otherIncome', '其他收入（非订单扣款 / 离店押金没收）'],
        ['reward', '打手成本（含预计）'],
        ['estimatedReward', '预计打手成本'],
        ['supportCommission', '客服提成'],
        ['operationsCommission', '运营提成'],
        ['expenses', '费用'],
        ['monthlyBase', '月度底薪'],
        ['monthlyProfit', '完整月份利润（已扣底薪）'],
        ['operatingProfit', '区间经营利润（未扣底薪）']
      ]),
      ['incomplete', '统计是否完整']
    ],
    () => [
      {
        month: periodText,
        ...Object.fromEntries(
          [
            'received',
            'refunds',
            'net',
            'otherIncome',
            'reward',
            'estimatedReward',
            'supportCommission',
            'operationsCommission',
            'expenses'
          ].map((key) => [
            key,
            ['supportCommission', 'operationsCommission'].includes(key) &&
            report.days.some((row) => row.incomplete)
              ? '待配置'
              : yuan(report.days.reduce((sum, row) => sum + (row[key] ?? 0), 0))
          ])
        ),
        monthlyBase: yuan(report.monthlyBase),
        monthlyProfit: yuan(report.monthlyProfit),
        operatingProfit: report.days.some((row) => row.profit == null)
          ? '待配置'
          : yuan(report.days.reduce((sum, row) => sum + row.profit, 0)),
        incomplete: report.days.some((row) => row.profit == null)
          ? '不完整 / 待配置'
          : report.monthlyBase == null && period && period.type !== 'monthly'
            ? '区间经营口径完整；未计底薪（非整月或待配置）'
            : report.monthlyProfit == null
              ? '底薪待配置'
              : '完整'
      }
    ],
    '按所选报表区间汇总；订单收入和成本归属原付款日，其他收入按非订单客户扣款及离店押金没收的实际登记日计入利润。充值、押金缴纳及退还不计收入；余额支付订单只计一次订单收入。日/周报不摊底薪，工资发放按实际发放日；追加的明细字段筛选不回改经营汇总。'
  )
  add(
    'days',
    '每日经营报表',
    '经营报表',
    can('profit.view'),
    [
      ['date', '客户付款归属日'],
      ...monetary([
        ['received', '收款'],
        ['refunds', '退款'],
        ['net', '净收入'],
        ['otherIncome', '其他收入（非订单扣款 / 离店押金没收）'],
        ['reward', '打手成本（含预计）'],
        ['estimatedReward', '预计打手成本'],
        ['supportCommission', '客服提成'],
        ['operationsCommission', '运营提成'],
        ['expenses', '费用'],
        ['profit', '日利润']
      ]),
      ['incomplete', '配置状态']
    ],
    () =>
      mapRows(report.days, (row) => ({
        ...row,
        ...Object.fromEntries(
          [
            'received',
            'refunds',
            'net',
            'otherIncome',
            'reward',
            'estimatedReward',
            'supportCommission',
            'operationsCommission',
            'expenses',
            'profit'
          ].map((key) => [
            key,
            ['supportCommission', 'operationsCommission'].includes(key) && row.incomplete
              ? '待配置'
              : yuan(key === 'otherIncome' ? (row[key] ?? 0) : row[key])
          ])
        ),
        incomplete: row.incomplete ? '配置未齐' : '完整',
        _date: row.date
      })),
    '订单收入与退款归属原付款日；非订单扣款及离店押金没收按实际登记日计其他收入，已包含在日利润，不再次叠加。充值、押金缴退不计经营收入，日利润未扣月底薪。',
    '订单付款 / 其他收入登记日'
  )
  add(
    'channels',
    '平台与店铺报表',
    '经营报表',
    can('profit.view'),
    [
      ['name', '平台 / 店铺'],
      ['platformName', '来源平台'],
      ['shopName', '店铺'],
      ['orders', '订单数', 'number'],
      ...monetary([
        ['received', '收款'],
        ['refunds', '退款'],
        ['net', '净收入']
      ])
    ],
    () =>
      mapRows(report.channels, (row) => ({
        ...row,
        received: yuan(row.received),
        refunds: yuan(row.refunds),
        net: yuan(row.net),
        platformName: platform(row.platformId),
        shopName: shop(row.shopId),
        _platforms: [row.platformId]
      })),
    '按所选报表区间的原付款日汇总；平台与所属店铺不能重复相加，追加明细筛选不重算该汇总。'
  )
  add(
    'performance',
    '员工业绩',
    '经营报表',
    snapshot.user.role !== 'player',
    [
      ['name', '员工'],
      ['orders', '计入业绩订单', 'number'],
      ['completed', '完成订单', 'number'],
      ['net', '业绩净收入（元）', 'number'],
      ['month', '业绩统计区间']
    ],
    () =>
      mapRows(report.performance, (row) => ({
        ...row,
        net: yuan(row.net),
        month: periodText,
        _people: [row.userId]
      })),
    '按所选报表区间的订单完成日期统计；仅当前账号可见的本人或全员业绩，追加明细筛选不重算该汇总。'
  )
  const orderColumns = [
    ['id', '记录 ID', 'text', false],
    ['orderNo', '工作室订单号'],
    ['title', '订单项目'],
    ['customerName', '客户'],
    ['platformName', '来源平台'],
    ['shopName', '来源店铺'],
    ['externalOrderNo', '平台订单号'],
    ['status', '订单状态'],
    ['creatorName', '创建人'],
    ['leaderName', '负责人'],
    ['teammateName', '队友'],
    ['roomCode', '房间码'],
    ['gameId', '客户游戏 ID'],
    ['map', '地图'],
    ...monetary([
      ['amount', '客户订单金额'],
      ['reward', '整单打手报酬'],
      ['receivedAmount', '已收金额']
    ]),
    ['createdAt', '创建时间'],
    ['paidAt', '客户付款时间'],
    ['receivedAt', '客服确认收款时间', 'text', false],
    ['publishedAt', '发布时间', 'text', false],
    ['completedAt', '完成时间'],
    ['dispatchMode', '派单方式'],
    ['dispatchState', '分配状态'],
    ['assignedName', '指定打手'],
    ['remark', '内部备注'],
    ['playerRemark', '打手备注'],
    ['receiptName', '付款凭证名称', 'text', false],
    ['receiptUrl', '付款凭证地址', 'text', false],
    ['cancelReason', '取消原因', 'text', false]
  ]
  add(
    'orders',
    '订单明细',
    '订单业务',
    can('orders.view'),
    orderColumns,
    () =>
      mapRows(snapshot.orders, (row) => ({
        ...row,
        amount: yuan(row.amount),
        reward: yuan(row.reward),
        receivedAmount: yuan(row.receivedAmount),
        customerName: customer(row.customerId),
        platformName: platform(row.platformId),
        shopName: shop(row.shopId),
        creatorName: person(row.creatorId),
        leaderName: person(row.leaderId),
        teammateName: person(row.teammateId),
        assignedName: person(row.assignedTo),
        status: {
          pending: row.dispatchState === 'unassigned' ? '待分配' : '待接单',
          active: '接单中',
          review: '待验收',
          completed: '已完成',
          canceled: '已取消'
        }[row.status],
        dispatchMode: row.dispatchMode === 'direct' ? '指定打手' : '抢单池',
        dispatchState: row.dispatchState === 'unassigned' ? '待客服分配' : '已发布 / 已指定',
        ...receipt(row.receipt),
        ...Object.fromEntries(
          ['createdAt', 'paidAt', 'receivedAt', 'publishedAt', 'completedAt'].map((key) => [
            key,
            displayTime(row[key])
          ])
        ),
        _dates: { createdAt: row.createdAt, paidAt: row.paidAt, completedAt: row.completedAt },
        _status: row.status,
        _people: [row.creatorId, row.leaderId, row.teammateId, row.assignedTo],
        _platforms: [row.platformId]
      })),
    '导出当前权限可见订单；日期可选创建、付款或完成时间。',
    '所选订单日期口径'
  )
  add(
    'orderReturns',
    '打手退单申请',
    '订单业务',
    can('orders.view'),
    [
      ['orderNo', '订单号'],
      ['orderTitle', '项目'],
      ['leaderName', '原负责人'],
      ['reason', '申请原因'],
      ['status', '处理状态'],
      ['requestedAt', '申请时间'],
      ['processedAt', '处理时间'],
      ['processedName', '处理人'],
      ['processReason', '处理说明']
    ],
    () =>
      flatMapRows(snapshot.orders, (order) =>
        mapRows(order.returnRequests || [], (row) => ({
          ...orderIdentity(order.id),
          leaderName: person(row.leaderId),
          reason: row.reason,
          status: { pending: '待处理', approved: '已批准', rejected: '已驳回', obsolete: '已失效' }[
            row.status
          ],
          requestedAt: displayTime(row.requestedAt),
          processedAt: displayTime(row.processedAt),
          processedName: person(row.processedBy),
          processReason: row.processReason || '',
          _date: row.requestedAt,
          _status: row.status,
          _people: [row.leaderId, row.processedBy, order.creatorId]
        }))
      ),
    '退单申请与客户退款分别记录；保留原负责人及客服处理说明。',
    '退单申请日期'
  )
  add(
    'orderRejections',
    '指定订单拒单',
    '订单业务',
    can('orders.view'),
    [
      ['orderNo', '订单号'],
      ['orderTitle', '项目'],
      ['playerName', '原指定打手'],
      ['reason', '拒绝原因'],
      ['rejectedAt', '拒绝时间']
    ],
    () =>
      flatMapRows(snapshot.orders, (order) =>
        mapRows(order.rejections || [], (row) => ({
          ...orderIdentity(order.id),
          playerName: person(row.playerId),
          reason: row.reason,
          rejectedAt: displayTime(row.rejectedAt),
          _date: row.rejectedAt,
          _people: [row.playerId, order.creatorId]
        }))
      ),
    '接受前拒绝指定订单的历史；拒绝后保留客户订单并交回客服分配。',
    '拒单日期'
  )
  add(
    'orderAssignments',
    '接单与解除记录',
    '订单业务',
    can('orders.view'),
    [
      ['orderNo', '订单号'],
      ['orderTitle', '项目'],
      ['leaderName', '接单负责人'],
      ['acceptedAt', '接单时间'],
      ['releasedAt', '解除时间'],
      ['reason', '解除原因']
    ],
    () =>
      flatMapRows(snapshot.orders, (order) =>
        mapRows(order.assignments || [], (row) => ({
          ...orderIdentity(order.id),
          leaderName: person(row.leaderId),
          acceptedAt: displayTime(row.acceptedAt),
          releasedAt: displayTime(row.releasedAt),
          reason: row.reason || '',
          _date: row.acceptedAt,
          _people: [row.leaderId, order.creatorId]
        }))
      ),
    '订单历史接单和解除明细。',
    '接单日期'
  )
  add(
    'orderSubmissions',
    '完成上报记录',
    '订单业务',
    can('orders.view'),
    [
      ['orderNo', '订单号'],
      ['orderTitle', '项目'],
      ['leaderName', '负责人'],
      ['teammateName', '队友'],
      ['submittedAt', '上报时间'],
      ['source', '提交来源'],
      ['correctedByName', '后台登记人'],
      ['correctionReason', '后台登记原因'],
      ['review', '验收结果'],
      ['reviewerName', '审核人'],
      ['reviewedAt', '审核时间'],
      ['reason', '退回原因'],
      ['screenshots', '截图名称与地址']
    ],
    () =>
      flatMapRows(snapshot.orders, (order) =>
        mapRows(order.submissions || [], (row) => ({
          ...orderIdentity(order.id),
          leaderName: person(row.leaderId),
          teammateName: person(row.teammateId),
          submittedAt: displayTime(row.submittedAt),
          source: row.source === 'status-correction' ? '后台状态登记（免截图）' : '打手上报',
          correctedByName: person(row.correctedBy),
          correctionReason: row.correctionReason || '',
          reviewedAt: displayTime(row.reviewedAt),
          reviewerName: person(row.reviewerId),
          review: row.review || '待验收',
          reason: row.reason || '',
          screenshots: (row.screenshots || [])
            .map((image) => `${image.name}：${image.url}`)
            .join('\n'),
          _date: row.submittedAt,
          _people: [row.leaderId, row.teammateId, row.reviewerId, order.creatorId]
        }))
      ),
    '保留上报、退回和验收记录；截图导出名称与地址，不打包图片。',
    '上报日期'
  )
  add(
    'refunds',
    '客户退款',
    '财务结算',
    can('finance.refunds', 'orders.view'),
    [
      ['id', '退款 ID', 'text', false],
      ['orderNo', '订单号'],
      ['orderTitle', '项目'],
      ['amount', '退款金额（元）', 'number'],
      ['status', '处理状态'],
      ['reason', '退款原因'],
      ['requestedName', '申请人'],
      ['createdAt', '申请时间'],
      ['processedAt', '处理时间'],
      ['processedName', '处理人'],
      ['manualRewardReview', '提现后差额待人工处理'],
      ['manualResolution', '人工处理结果']
    ],
    () =>
      mapRows(snapshot.refunds, (row) => ({
        ...row,
        ...orderIdentity(row.orderId),
        amount: yuan(row.amount),
        status: { pending: '待审核', paid: '已退款', rejected: '已驳回' }[row.status],
        requestedName: person(row.requestedBy),
        processedName: person(row.processedBy),
        createdAt: displayTime(row.createdAt),
        processedAt: displayTime(row.processedAt),
        manualRewardReview: row.manualRewardReview ? '是' : '否',
        manualResolution: row.manualResolution || '',
        _status: row.status,
        _date: row.createdAt,
        _people: [row.requestedBy, row.processedBy, ...orderIdentity(row.orderId)._people]
      })),
    '仅当前可见订单的退款；人工差额登记与说明一起导出。',
    '申请日期'
  )
  add(
    'withdrawals',
    '打手提现',
    '财务结算',
    can('finance.withdrawals') || snapshot.user.role === 'player',
    [
      ['id', '提现 ID', 'text', false],
      ['name', '打手'],
      ['amount', '提现金额（元）', 'number'],
      ['status', '处理状态'],
      ['createdAt', '申请时间'],
      ['processedAt', '审核时间'],
      ['paidAt', '发放时间'],
      ['canceledAt', '撤回时间'],
      ['weekStart', '次数所属自然周'],
      ['paymentMethod', '收款方式'],
      ['paymentSnapshotUpdatedAt', '申请时收款资料更新时间'],
      ['paymentQrCodeName', '申请时收款码名称'],
      ['paymentQrCodeUrl', '申请时收款码地址', 'text', false],
      ['processedName', '处理人'],
      ['reason', '处理说明'],
      ['receiptName', '发放凭证名称'],
      ['receiptUrl', '发放凭证地址']
    ],
    () =>
      mapRows(snapshot.withdrawals, (row) => ({
        ...row,
        name: person(row.userId),
        amount: yuan(row.amount),
        status: {
          pending: '待审核',
          approved: '待发放',
          paid: '已发放',
          rejected: '已驳回',
          canceled: '已撤回'
        }[row.status],
        paymentMethod:
          { wechat: '微信', alipay: '支付宝' }[row.paymentSnapshot?.method || row.paymentMethod] ||
          '历史记录未登记',
        paymentSnapshotUpdatedAt: displayTime(row.paymentSnapshot?.updatedAt),
        paymentQrCodeName: row.paymentSnapshot?.qrCode?.name || '',
        paymentQrCodeUrl: row.paymentSnapshot?.qrCode?.url || '',
        processedName: person(row.processedBy),
        ...receipt(row.receipt),
        createdAt: displayTime(row.createdAt),
        processedAt: displayTime(row.processedAt),
        paidAt: displayTime(row.paidAt),
        canceledAt: displayTime(row.canceledAt),
        _date: row.createdAt,
        _status: row.status,
        _people: [row.userId]
      })),
    '财务可导可见打手记录；打手仅可导本人提现。',
    '申请日期'
  )
  add(
    'wallets',
    '打手报酬余额',
    '财务结算',
    can('finance.withdrawals') || snapshot.user.role === 'player',
    [
      ['name', '打手'],
      ...monetary([
        ['earned', '已确认报酬'],
        ['occupied', '在途提现'],
        ['paid', '已发放'],
        ['available', '可提现']
      ])
    ],
    () =>
      mapRows(snapshot.wallets, (row) => ({
        name: person(row.userId),
        ...Object.fromEntries(
          ['earned', 'occupied', 'paid', 'available'].map((key) => [key, yuan(row[key])])
        ),
        _people: [row.userId]
      })),
    '当前余额快照，不按日期范围回溯。'
  )
  add(
    'expenses',
    '费用报账',
    '财务结算',
    can('finance.expenses', 'profit.view'),
    [
      ['id', '费用 ID', 'text', false],
      ['date', '发生日期'],
      ['category', '费用类别'],
      ['purpose', '用途'],
      ['amount', '支出金额（元）', 'number'],
      ['creatorName', '经办人'],
      ['status', '入账状态'],
      ['deletedAt', '删除时间'],
      ['receiptName', '凭证名称'],
      ['receiptUrl', '凭证地址']
    ],
    () =>
      mapRows(snapshot.expenses, (row) => ({
        ...row,
        amount: yuan(row.amount),
        creatorName: person(row.createdBy),
        ...receipt(row.receipt),
        status: row.deletedAt ? '已删除' : '已入账',
        deletedAt: displayTime(row.deletedAt),
        _status: row.deletedAt ? 'deleted' : 'active',
        _date: row.date,
        _people: [row.createdBy]
      })),
    '包含已删除和可恢复记录，可按状态筛选。',
    '实际发生日期'
  )
  const payrollColumns = [
    ['name', '员工'],
    ['role', '角色'],
    ['month', period && period.type !== 'monthly' ? '发放统计区间' : '核算月份'],
    ['settlementState', '金额来源'],
    ...monetary([
      ['base', '底薪'],
      ['commission', '提成'],
      ['deduction', '退款扣回'],
      ['total', period && period.type !== 'monthly' ? '实发金额合计' : '工资金额合计']
    ]),
    ['incomplete', '配置状态']
  ]
  const monthPayroll = !period || period.type === 'monthly'
  let paidLineCount
  const paidLines = () =>
    (paidLineCount ??= snapshot.payrolls
      .filter((row) => row.month === report.month)
      .reduce((sum, row) => sum + row.lines.length, 0))
  const payrollRow = (row, index) => ({
    ...row,
    role: roleNames[row.role],
    month: monthPayroll ? report.month : periodText,
    settlementState: monthPayroll
      ? index < paidLines()
        ? '已发快照'
        : '待结算 / 差额'
      : '实际已发汇总',
    ...Object.fromEntries(
      ['base', 'commission', 'deduction', 'total'].map((key) => [key, yuan(row[key])])
    ),
    incomplete: row.incomplete ? '配置未齐' : '完整',
    _people: [row.userId]
  })
  add(
    'payroll',
    monthPayroll ? '工资核算' : '已发工资汇总',
    '工资与提成',
    ownOrSalary,
    payrollColumns,
    () => mapRows(report.payroll, payrollRow),
    monthPayroll
      ? '按所选核算月份导出已发快照与待结算差额，金额来源分列，不将历史已发金额再次计为待发。追加明细筛选不重算该核算。'
      : '按所选报表区间的实际发放日期汇总已发工资；不按天摊分月度工资，也不包含待结算金额。'
  )
  add(
    'payrollHistory',
    '工资发放明细',
    '工资与提成',
    ownOrSalary,
    [
      ['month', '实际核算月份'],
      ...payrollColumns.filter(([key]) => key !== 'total' && key !== 'month'),
      ['total', '本次发放金额（元）', 'number'],
      ['payrollId', '发放记录 ID', 'text', false],
      ['paidAt', '发放时间'],
      ['paidByName', '经办人']
    ],
    () =>
      flatMapRows(
        snapshot.payrolls.filter((row) => !monthPayroll || row.month === report.month),
        (payroll) =>
          mapRows(payroll.lines, (row) => ({
            ...payrollRow(row, 0),
            settlementState: '已发快照',
            month: payroll.month,
            payrollId: payroll.id,
            paidAt: displayTime(payroll.paidAt),
            paidByName: person(payroll.paidBy),
            _date: payroll.paidAt,
            _periodFilter: !monthPayroll,
            _people: [row.userId, payroll.paidBy]
          }))
      ),
    monthPayroll
      ? '所选核算月份的原始发放快照与补结算，发放可能发生在次月；仅主动填写明细日期范围时按发放日进一步筛选。'
      : '按实际发放日期筛选所选报表区间的发放快照，保留真实核算月份，不改写历史金额。',
    '实际发放日期'
  )
  add(
    'salaryPlans',
    '工资方案',
    '工资与提成',
    ownOrSalary,
    [
      ['name', '员工'],
      ['mode', '工资模式'],
      ['base', '底薪 / 固定工资（元）', 'number'],
      ['rate', '客服提成（%）', 'number'],
      ['platformRates', '平台提成（%）'],
      ['effectiveFrom', '生效日期'],
      ['hourlyEnabled', '按工时计薪']
    ],
    () =>
      mapRows(snapshot.salaryPlans, (row) => ({
        ...row,
        name: person(row.userId),
        mode: { base_commission: '底薪加提成', commission: '纯提成', fixed: '固定工资' }[row.mode],
        base: row.mode === 'commission' ? '' : yuan(row.base),
        rate:
          row.mode === 'fixed' ||
          snapshot.users.find((person) => person.id === row.userId)?.role === 'operations'
            ? ''
            : percent(row.rate),
        platformRates: Object.entries(row.platformRates)
          .map(([key, value]) => `${platform(key)}：${percent(value)}${value == null ? '' : '%'}`)
          .join('；'),
        hourlyEnabled: row.hourlyEnabled ? '是' : '否',
        _date: row.effectiveFrom,
        _periodFilter: false,
        _people: [row.userId]
      })),
    '当前权限可见工资方案；按生效日期筛选，不将缺配置金额视为零。',
    '方案生效日期'
  )
  add(
    'workSchedules',
    '每人固定班次',
    '人员管理',
    true,
    [
      ['name', '人员'],
      ['effectiveFrom', '生效日期'],
      ['enabled', '固定班次'],
      ['start', '上班时间'],
      ['end', '下班时间'],
      ['overnight', '是否跨夜'],
      ['remark', '说明'],
      ['updatedByName', '设置人'],
      ['updatedAt', '设置时间']
    ],
    () =>
      mapRows(snapshot.workSchedules || [], (row) => ({
        ...row,
        name: person(row.userId),
        enabled: row.enabled ? '启用' : '停用',
        overnight: row.enabled && row.end < row.start ? '次日下班' : '',
        updatedByName: person(row.updatedBy),
        updatedAt: displayTime(row.updatedAt),
        _date: row.effectiveFrom,
        _periodFilter: false,
        _people: [row.userId]
      })),
    '当前权限可见的固定班次版本；不自动生成考勤或实际工时。报表账期不截断配置版本，可额外按生效日期筛选。',
    '班次生效日期'
  )
  add(
    'attendance',
    '排班与考勤',
    '人员管理',
    true,
    [
      ['name', '人员'],
      ['date', '班次开始日期'],
      ['start', '上班时间'],
      ['end', '下班时间'],
      ['status', '出勤状态'],
      ['actualHours', '实际工时（小时）', 'number'],
      ['remark', '备注']
    ],
    () =>
      mapRows(snapshot.attendance, (row) => ({
        ...row,
        name: person(row.userId),
        status: statuses[row.status],
        _status: row.status,
        _date: row.date,
        _people: [row.userId]
      })),
    '人工实际工时原值导出；未到岗排班不累计实际工时。',
    '班次开始日期'
  )
  add(
    'staff',
    '员工档案',
    '人员管理',
    can('users.manage'),
    [
      ['name', '姓名 / 称呼'],
      ['username', '登录账号'],
      ['role', '角色'],
      ['status', '账号状态'],
      ['permissions', '实际业务权限'],
      ['permissionOverrides', '个人权限覆盖', 'text', false]
    ],
    () =>
      mapRows(
        snapshot.users.filter((row) => row.role !== 'player'),
        (row) => ({
          ...row,
          role: roleNames[row.role],
          status: row.status === 'active' ? '启用' : '停用',
          permissions: permissionText(permissionsFor(row)),
          permissionOverrides: Object.entries(row.permissionOverrides || {})
            .map(([key, value]) => `${permissionNames[key] || key}：${value ? '允许' : '禁止'}`)
            .join('；'),
          _status: row.status,
          _people: [row.id]
        })
      ),
    '当前员工和权限配置快照，仅含非打手账号，不导出密码、密码哈希或登录会话；日期范围不适用。'
  )
  add(
    'players',
    '打手档案',
    '人员管理',
    can('users.manage'),
    [
      ['name', '打手姓名 / 称呼'],
      ['username', '登录账号'],
      ['status', '账号状态'],
      ['levelName', '打手等级'],
      ['maxActiveOrders', '接单上限', 'number'],
      ['activeOrders', '执行中订单', 'number'],
      ['loginAllowed', '允许登录'],
      ['claimAllowed', '允许新接单'],
      ['withdrawAllowed', '允许申请提现'],
      ['permissions', '实际业务权限'],
      ['permissionOverrides', '个人权限覆盖', 'text', false]
    ],
    () =>
      mapRows(
        snapshot.users.filter((row) => row.role === 'player'),
        (row) => ({
          ...row,
          status: row.status === 'active' ? '启用' : '停用',
          levelName: snapshot.levels.find((level) => level.id === row.levelId)?.name || '',
          loginAllowed: row.playerAccess?.login === false ? '禁止' : '允许',
          claimAllowed: row.playerAccess?.claim === false ? '禁止' : '允许',
          withdrawAllowed: row.playerAccess?.withdraw === false ? '禁止' : '允许',
          permissions: permissionText(permissionsFor(row)),
          permissionOverrides: Object.entries(row.permissionOverrides || {})
            .map(([key, value]) => `${permissionNames[key] || key}：${value ? '允许' : '禁止'}`)
            .join('；'),
          _status: row.status,
          _people: [row.id]
        })
      ),
    '当前打手档案及操作开关，不包含密码或登录会话。登录、新接单及新提现分别控制，已有订单继续按实际权限处理；日期范围不适用。'
  )
  add(
    'roles',
    '角色默认权限',
    '人员管理',
    can('users.manage'),
    [
      ['name', '角色'],
      ['code', '角色代码'],
      ['permissionCount', '权限数量', 'number'],
      ['permissions', '角色默认权限']
    ],
    () =>
      mapRows(Object.entries(snapshot.roleDefaults), ([role, permissions]) => ({
        name: roleNames[role],
        code: role,
        permissionCount: permissions.length,
        permissions: permissionText(permissions)
      })),
    '服务器实际角色默认权限；个人覆盖见人员档案。日期范围不适用。'
  )
  add(
    'menus',
    '菜单权限规则',
    '人员管理',
    can('users.manage'),
    [
      ['name', '业务菜单'],
      ['path', '页面地址'],
      ['permissions', '准入权限'],
      ['rule', '授权规则']
    ],
    () =>
      mapRows(menuRows, ([name, path, permissions]) => ({
        name,
        path,
        permissions: permissionText(permissions),
        rule: permissions.length
          ? '任意一项准入权限满足；子页按业务权限限制'
          : '已登录账号；导出内容按数据权限限制'
      })),
    '工作室业务菜单的准入规则；原组件及模板演示保持独立。日期范围不适用。'
  )
  add(
    'customers',
    '客户档案',
    '客户与配置',
    can('orders.create', 'users.manage', 'orders.view'),
    [
      ['name', '客户名称'],
      ['contact', '联系方式'],
      ['gameId', '客户游戏 ID'],
      ['remark', '客户备注']
    ],
    () => mapRows(snapshot.customers, (row) => ({ ...row })),
    '当前客户配置，日期范围不适用。'
  )
  add(
    'templates',
    '订单项目模板',
    '客户与配置',
    can('templates.manage', 'orders.view', 'orders.create'),
    [
      ['name', '项目'],
      ['game', '游戏'],
      ['description', '规格 / 目标'],
      ['amount', '客户价格（元）', 'number'],
      ['reward', '打手报酬（元）', 'number'],
      ['map', '默认地图'],
      ['remark', '默认备注'],
      ['active', '是否启用']
    ],
    () =>
      mapRows(snapshot.templates, (row) => ({
        ...row,
        amount: yuan(row.amount),
        reward: yuan(row.reward),
        active: row.active ? '启用' : '停用',
        _status: row.active ? 'active' : 'disabled'
      })),
    '当前订单项目配置，历史订单仍保留自己的快照。日期范围不适用。'
  )
  add(
    'platforms',
    '订单来源',
    '客户与配置',
    can('settings.manage', 'templates.manage', 'orders.view', 'orders.create'),
    [
      ['id', '来源代码'],
      ['name', '来源名称'],
      ['requiresShop', '下单需要店铺'],
      ['requiresExternalOrderNo', '需要平台订单号'],
      ['requiresReceipt', '收款需要付款凭证'],
      ['allowPayOnArrival', '允许落地付']
    ],
    () =>
      mapRows(snapshot.platforms, (row) => ({
        ...row,
        ...Object.fromEntries(
          Object.entries(platformRules(row)).map(([key, value]) => [key, value ? '是' : '否'])
        ),
        _platforms: [row.id]
      })),
    '当前来源平台配置，日期范围不适用。'
  )
  add(
    'shops',
    '店铺配置',
    '客户与配置',
    can('settings.manage', 'orders.view', 'orders.create'),
    [
      ['name', '店铺名称'],
      ['platformName', '所属平台'],
      ['id', '店铺代码']
    ],
    () =>
      mapRows(snapshot.shops, (row) => ({
        ...row,
        platformName: platform(row.platformId),
        _platforms: [row.platformId]
      })),
    '当前店铺配置，日期范围不适用。'
  )
  add(
    'levels',
    '打手等级配置',
    '客户与配置',
    can('settings.manage', 'users.manage'),
    [
      ['name', '等级名称'],
      ['delaySeconds', '抢单开放延迟（秒）', 'number'],
      ['id', '等级代码']
    ],
    () => mapRows(snapshot.levels, (row) => ({ ...row })),
    '当前打手等级配置，日期范围不适用。'
  )
  add(
    'appearance',
    '界面外观配置',
    '客户与配置',
    can('settings.manage'),
    [
      ['studioName', '工作室名称'],
      ['logoName', 'Logo 图片名称'],
      ['logoUrl', 'Logo 站内地址'],
      ['pageMode', '页面背景类型'],
      ['pageColor', '页面背景颜色'],
      ['pageImageName', '页面背景图片名称'],
      ['pageImageUrl', '页面背景图片站内地址'],
      ['pageOverlay', '页面图片遮罩（%）', 'number'],
      ['heroMode', '主页横幅背景类型'],
      ['heroColor', '主页横幅背景颜色'],
      ['heroImageName', '横幅背景图片名称'],
      ['heroImageUrl', '横幅背景图片站内地址'],
      ['heroOverlay', '横幅图片遮罩（%）', 'number'],
      ['showDecoration', '展示原玻璃装饰图'],
      ['loginTitle', '登录标题'],
      ['loginSubtitle', '登录副标题'],
      ['loginDescription', '登录说明'],
      ['loginIllustrationMode', '登录左侧大图类型'],
      ['loginIllustrationName', '登录左侧大图名称'],
      ['loginIllustrationUrl', '登录左侧大图站内地址'],
      ['loginBackgroundMode', '登录整体背景类型'],
      ['loginBackgroundColor', '登录整体背景颜色'],
      ['loginBackgroundName', '登录整体背景图片名称'],
      ['loginBackgroundUrl', '登录整体背景站内地址'],
      ['glassEnabled', '毛玻璃效果'],
      ['icons', '菜单与快捷入口预设图标'],
      ['revision', '配置版本', 'number'],
      ['updatedAt', '保存时间']
    ],
    () =>
      snapshot.appearance
        ? [
            (() => {
              const config = snapshot.appearance
              const modeLabels = { default: '原默认背景', color: '纯色', image: '图片' }
              const imageUrl = (image) =>
                typeof image?.url === 'string' &&
                /^\/api\/studio\/uploads\/[A-Za-z0-9_-]+$/.test(image.url)
                  ? image.url
                  : ''
              const iconLabels = {
                dashboard: '工作台',
                orders: '订单业务',
                finance: '财务管理',
                personnel: '人员管理',
                system: '系统管理',
                reports: '数据报表',
                createOrder: '创建与派单',
                orderList: '订单管理',
                customers: '老板管理',
                users: '员工管理',
                roles: '角色与权限',
                business: '业务配置',
                appearance: '界面外观',
                logs: '操作日志',
                attendance: '排班与到岗',
                salary: '工资与提成',
                export: '自选导出',
                profile: '个人中心'
              }
              return {
                studioName: config.studioName,
                logoName: config.logo?.name || '',
                logoUrl: imageUrl(config.logo),
                pageMode: modeLabels[config.page.mode],
                pageColor: config.page.color,
                pageImageName: config.page.image?.name || '',
                pageImageUrl: imageUrl(config.page.image),
                pageOverlay: config.page.overlay,
                heroMode: modeLabels[config.hero.mode],
                heroColor: config.hero.color,
                heroImageName: config.hero.image?.name || '',
                heroImageUrl: imageUrl(config.hero.image),
                heroOverlay: config.hero.overlay,
                showDecoration: config.hero.showDecoration ? '是' : '否',
                loginTitle: config.login?.title || '',
                loginSubtitle: config.login?.subtitle || '',
                loginDescription: config.login?.description || '',
                loginIllustrationMode:
                  config.login?.illustration?.mode === 'image' ? '自定义图片' : '默认大图',
                loginIllustrationName: config.login?.illustration?.image?.name || '',
                loginIllustrationUrl: imageUrl(config.login?.illustration?.image),
                loginBackgroundMode: modeLabels[config.login?.background?.mode || 'default'],
                loginBackgroundColor: config.login?.background?.color || '',
                loginBackgroundName: config.login?.background?.image?.name || '',
                loginBackgroundUrl: imageUrl(config.login?.background?.image),
                glassEnabled: config.glass?.enabled ? '启用' : '停用',
                icons: Object.entries(APPEARANCE_ICON_DEFAULTS)
                  .map(([key, original]) => `${iconLabels[key]}：${config.icons[key] || original}`)
                  .join('；'),
                revision: config.revision,
                updatedAt: displayTime(config.updatedAt)
              }
            })()
          ]
        : [],
    '当前已保存的共享外观配置；图片仅导出名称与站内地址，地址需登录并按附件权限访问，不包含图片文件内容。日期范围不适用。'
  )
  add(
    'logs',
    '操作日志',
    '审计与个人',
    can('logs.view'),
    [
      ['id', '日志 ID', 'text', false],
      ['actorName', '操作人'],
      ['action', '操作动作'],
      ['entity', '业务类型'],
      ['entityId', '记录 ID'],
      ['createdAt', '操作时间'],
      ['before', '修改前', 'text', false],
      ['after', '修改后', 'text', false]
    ],
    () =>
      mapRows(snapshot.logs, (row) => ({
        ...row,
        createdAt: displayTime(row.createdAt),
        get before() {
          return row.before == null ? '' : JSON.stringify(row.before)
        },
        get after() {
          return row.after == null ? '' : JSON.stringify(row.after)
        },
        _date: row.createdAt,
        _people: [row.actorId]
      })),
    '全量可见审计日志；工资与订单敏感内容继续按服务器权限过滤。',
    '操作日期'
  )
  add(
    'profile',
    '本人账号资料',
    '审计与个人',
    true,
    [
      ['name', '本人称呼'],
      ['username', '登录账号'],
      ['role', '角色'],
      ['status', '状态'],
      ['permissions', '本人业务权限']
    ],
    () => [
      {
        name: snapshot.user.name,
        username: snapshot.user.username,
        role: roleNames[snapshot.user.role],
        status: snapshot.user.status === 'active' ? '启用' : '停用',
        permissions: permissionText(snapshot.permissions),
        _people: [snapshot.user.id]
      }
    ],
    '当前账号资料，不包含密码或会话；日期范围不适用。'
  )
  return all
}

export function getExportCatalog(snapshot) {
  return {
    month: snapshot.reports.month,
    period: snapshot.exportPeriod,
    modules: modulesFor(snapshot).map(({ rows, ...item }) => ({
      ...item,
      rowCount: snapshot.catalogOnly
        ? null
        : item.id === 'customerOrderReferences' && snapshot.customerOrderReferenceCount != null
          ? snapshot.customerOrderReferenceCount
          : item.id === 'logs' && snapshot.auditLogCount != null
            ? snapshot.auditLogCount
            : (snapshot.fundCounts?.[item.id] ?? countRows(rows()))
    }))
  }
}
function countRows(rows) {
  if (Array.isArray(rows)) return rows.length
  let count = 0
  for (const row of rows) {
    if (row) count++
  }
  return count
}
const invalid = (message, status = 400) => {
  throw new ApiError(message, status)
}
function filterOptions(filters) {
  if (filters == null) return {}
  if (typeof filters !== 'object' || Array.isArray(filters)) invalid('导出范围格式无效')
  const allowed = [
    'dateRange',
    'keyword',
    'keywordField',
    'archived',
    'personId',
    'customerId',
    'platformId',
    'status',
    'orderDateKey'
  ]
  if (Object.keys(filters).some((key) => !allowed.includes(key))) invalid('导出筛选项无效')
  for (const key of ['keyword', 'keywordField', 'personId', 'customerId', 'platformId', 'status']) {
    if (filters[key] != null && (typeof filters[key] !== 'string' || filters[key].length > 200))
      invalid('导出筛选项过长或格式无效')
  }
  if (filters.keyword?.trim() && !filters.keywordField) invalid('请选择要查询的具体字段')
  if (filters.archived != null && !['all', 'hot', 'archive'].includes(filters.archived))
    invalid('日志归档范围无效')
  if (
    filters.orderDateKey &&
    !['createdAt', 'paidAt', 'completedAt'].includes(filters.orderDateKey)
  )
    invalid('订单日期口径无效')
  if (filters.dateRange != null) {
    const range = filters.dateRange
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      range.some(
        (date) =>
          typeof date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date
      ) ||
      range[0] > range[1]
    )
      invalid('请选择有效的开始与结束日期')
  }
  return filters
}

export function buildExportSheets(snapshot, request, { previewLimit } = {}) {
  if (
    !request ||
    !Array.isArray(request.modules) ||
    request.modules.length === 0 ||
    request.modules.length > 64
  )
    invalid('请选择 1 至 64 个导出模块')
  if (request.month && request.month !== snapshot.reports.month) invalid('核算月份与当前数据不一致')
  const options = { ...filterOptions(request.filters) }
  const periodRange = snapshot.exportPeriod
    ? [snapshot.exportPeriod.start, snapshot.exportPeriod.end]
    : null
  const requestedRange = options.dateRange
  const catalog = new Map(modulesFor(snapshot).map((item) => [item.id, item]))
  if (
    options.keyword?.trim() &&
    !request.modules.some((selection) =>
      catalog
        .get(selection?.id)
        ?.fields.some((field) => field.key === options.keywordField && field.type === 'text')
    )
  )
    invalid('所选模块中没有此可查询字段')
  const used = new Set()
  let total = 0
  const selections = request.modules.map((selection) => {
    if (!selection || typeof selection.id !== 'string' || selection.id.length > 80)
      invalid('导出模块格式无效')
    const item = catalog.get(selection.id)
    if (!item) invalid('当前账号无权导出此模块，或模块不存在', 403)
    if (used.has(item.id)) invalid('导出模块不能重复')
    used.add(item.id)
    if (
      !Array.isArray(selection.fields) ||
      selection.fields.length === 0 ||
      selection.fields.length > item.fields.length ||
      new Set(selection.fields).size !== selection.fields.length
    )
      invalid('每个模块请至少选择一项且不重复的字段')
    const selected = selection.fields.map((key) => {
      const definition = item.fields.find((field) => field.key === key)
      if (!definition) invalid('导出字段无效或不可见')
      return definition
    })
    return { item, selected }
  })
  const sheets = selections.map(({ item, selected }) => {
    const matches = (row) => {
      if (options.personId && row._people && !row._people.includes(options.personId)) return false
      if (options.customerId && row._customers && !row._customers.includes(options.customerId))
        return false
      if (options.platformId && row._platforms && !row._platforms.includes(options.platformId))
        return false
      if (options.status && row._status && row._status !== options.status) return false
      if (
        options.keyword?.trim() &&
        !String(
          item.fields.some((field) => field.key === options.keywordField)
            ? (row[options.keywordField] ?? '')
            : ''
        )
          .toLowerCase()
          .includes(options.keyword.trim().toLowerCase())
      )
        return false
      const dateRange =
        row._periodFilter === false
          ? requestedRange
          : periodRange && requestedRange
            ? [
                periodRange[0] > requestedRange[0] ? periodRange[0] : requestedRange[0],
                periodRange[1] < requestedRange[1] ? periodRange[1] : requestedRange[1]
              ]
            : requestedRange || periodRange
      if (dateRange && ('_date' in row || row._dates)) {
        const value = row._dates ? row._dates[options.orderDateKey || 'createdAt'] : row._date
        if (!value) return false
        const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : shanghaiDate(value)
        if (date < dateRange[0] || date > dateRange[1]) return false
      }
      return true
    }
    let rowCount = 0
    const rows = []
    for (const row of item.rows()) {
      if (!matches(row)) continue
      rowCount++
      total++
      if (total > MAX_ROWS) invalid(`导出超过 ${MAX_ROWS} 条，请缩小范围后重试`)
      if (previewLimit == null || rows.length < previewLimit)
        rows.push(Object.fromEntries(selected.map((field) => [field.key, row[field.key] ?? ''])))
    }
    return { id: item.id, name: item.label, fields: selected, rows, rowCount }
  })
  return {
    month: snapshot.reports.month,
    period: snapshot.exportPeriod,
    sheets,
    generatedAt: new Date().toISOString()
  }
}
