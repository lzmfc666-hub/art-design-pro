import { ApiError, permissionsFor, shanghaiDate } from './studio.mjs'
import { APPEARANCE_ICON_DEFAULTS } from './appearance.mjs'

const MAX_ROWS = 100000
const roleNames = {
  owner: '老板',
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
  present: '实际到岗',
  leave: '请假',
  absent: '缺勤',
  disabled: '已停用'
}
const yuan = (value) => (value == null ? '待配置' : value / 100)
const percent = (value) => (value == null ? '待配置' : value / 100)
const displayTime = (value) =>
  value ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }) : ''
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
  'logs.view': '操作日志'
}
const permissionText = (keys) => keys.map((key) => permissionNames[key] || key).join('、')
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
  ['客户档案', '/orders/customers', ['orders.create', 'users.manage']],
  [
    '验收与结算',
    '/finance/settlement',
    ['finance.review', 'finance.refunds', 'finance.withdrawals', 'finance.expenses']
  ],
  ['工资与提成', '/finance/salary', ['salary.view', 'salary.all', 'salary.manage']],
  ['排班与到岗', '/personnel/attendance', ['attendance.manage']],
  ['人员管理', '/system/user', ['users.manage']],
  ['角色与权限', '/system/role', ['users.manage']],
  ['业务配置', '/system/business', ['templates.manage', 'settings.manage']],
  ['界面外观', '/system/appearance', ['settings.manage']],
  ['菜单权限', '/system/menu', ['users.manage']],
  ['操作日志', '/system/logs', ['logs.view']],
  ['个人中心', '/system/user-center', []],
  ['自选导出', '/reports/export', []]
]

function modulesFor(snapshot) {
  const can = (...keys) => keys.some((key) => snapshot.permissions.includes(key))
  const person = (id) => snapshot.users.find((row) => row.id === id)?.name || id || ''
  const platform = (id) => snapshot.platforms.find((row) => row.id === id)?.name || id || ''
  const shop = (id) => snapshot.shops.find((row) => row.id === id)?.name || id || ''
  const customer = (id) => snapshot.customers.find((row) => row.id === id)?.name || id || ''
  const orderMap = new Map(snapshot.orders.map((row) => [row.id, row]))
  const orderIdentity = (id) => {
    const order = orderMap.get(id)
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
  add(
    'overview',
    '经营月度汇总',
    '经营报表',
    can('profit.view'),
    [
      ['month', '核算月份'],
      ...monetary([
        ['received', '收款'],
        ['refunds', '退款'],
        ['net', '净收入'],
        ['reward', '已确认打手成本'],
        ['estimatedReward', '预计打手成本'],
        ['supportCommission', '客服提成'],
        ['operationsCommission', '运营提成'],
        ['expenses', '费用'],
        ['monthlyBase', '月度底薪'],
        ['monthlyProfit', '月度利润']
      ]),
      ['incomplete', '统计是否完整']
    ],
    [
      {
        month: report.month,
        ...Object.fromEntries(
          [
            'received',
            'refunds',
            'net',
            'reward',
            'estimatedReward',
            'supportCommission',
            'operationsCommission',
            'expenses'
          ].map((key) => [key, yuan(report.days.reduce((sum, row) => sum + row[key], 0))])
        ),
        monthlyBase: yuan(report.monthlyBase),
        monthlyProfit: yuan(report.monthlyProfit),
        incomplete: report.monthlyProfit == null ? '不完整 / 待配置' : '完整'
      }
    ],
    '按所选核算月份汇总；订单收入和成本归属原付款日。此汇总不按明细筛选条件重新计算。'
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
        ['reward', '已确认打手成本'],
        ['estimatedReward', '预计打手成本'],
        ['supportCommission', '客服提成'],
        ['operationsCommission', '运营提成'],
        ['expenses', '费用'],
        ['profit', '日利润']
      ]),
      ['incomplete', '配置状态']
    ],
    report.days.map((row) => ({
      ...row,
      ...Object.fromEntries(
        [
          'received',
          'refunds',
          'net',
          'reward',
          'estimatedReward',
          'supportCommission',
          'operationsCommission',
          'expenses',
          'profit'
        ].map((key) => [key, yuan(row[key])])
      ),
      incomplete: row.incomplete ? '配置未齐' : '完整',
      _date: row.date
    })),
    '所选月份的日报；退款回到原付款日调整。',
    '客户付款归属日'
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
    report.channels.map((row) => ({
      ...row,
      received: yuan(row.received),
      refunds: yuan(row.refunds),
      net: yuan(row.net),
      platformName: platform(row.platformId),
      shopName: shop(row.shopId),
      _platforms: [row.platformId]
    })),
    '所选月份的渠道汇总，按平台筛选；日期范围不重算月度汇总。'
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
      ['month', '业绩月份']
    ],
    report.performance.map((row) => ({
      ...row,
      net: yuan(row.net),
      month: report.month,
      _people: [row.userId]
    })),
    '按订单完成月份统计；只导出当前账号可见的本人或全员业绩，日期范围不重算月度汇总。'
  )
  const orderColumns = [
    ['id', '记录 ID', 'text', false],
    ['orderNo', '工作室订单号'],
    ['title', '订单项目'],
    ['customerName', '客户'],
    ['platformName', '来源平台'],
    ['shopName', '闲鱼店铺'],
    ['externalOrderNo', '平台订单号'],
    ['status', '订单状态'],
    ['creatorName', '创建人'],
    ['leaderName', '负责人'],
    ['teammateName', '队友'],
    ['channel', '沟通渠道'],
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
    ['assignedName', '指定打手'],
    ['remark', '打手可见备注'],
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
    snapshot.orders.map((row) => ({
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
        pending: '待接单',
        active: '接单中',
        review: '待验收',
        completed: '已完成',
        canceled: '已取消'
      }[row.status],
      dispatchMode: row.dispatchMode === 'direct' ? '指定打手' : '抢单池',
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
    snapshot.orders.flatMap((order) =>
      order.assignments.map((row) => ({
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
      ['review', '验收结果'],
      ['reviewerName', '审核人'],
      ['reviewedAt', '审核时间'],
      ['reason', '退回原因'],
      ['screenshots', '截图名称与地址']
    ],
    snapshot.orders.flatMap((order) =>
      order.submissions.map((row) => ({
        ...orderIdentity(order.id),
        leaderName: person(row.leaderId),
        teammateName: person(row.teammateId),
        submittedAt: displayTime(row.submittedAt),
        reviewedAt: displayTime(row.reviewedAt),
        reviewerName: person(row.reviewerId),
        review: row.review || '待验收',
        reason: row.reason || '',
        screenshots: row.screenshots.map((image) => `${image.name}：${image.url}`).join('\n'),
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
    snapshot.refunds.map((row) => ({
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
      ['reason', '处理说明'],
      ['receiptName', '发放凭证名称'],
      ['receiptUrl', '发放凭证地址']
    ],
    snapshot.withdrawals.map((row) => ({
      ...row,
      name: person(row.userId),
      amount: yuan(row.amount),
      status: { pending: '待审核', approved: '待发放', paid: '已发放', rejected: '已驳回' }[
        row.status
      ],
      ...receipt(row.receipt),
      createdAt: displayTime(row.createdAt),
      processedAt: displayTime(row.processedAt),
      paidAt: displayTime(row.paidAt),
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
    snapshot.wallets.map((row) => ({
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
    snapshot.expenses.map((row) => ({
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
    ['month', '核算月份'],
    ...monetary([
      ['base', '底薪'],
      ['commission', '提成'],
      ['deduction', '退款扣回'],
      ['total', '待结算合计']
    ]),
    ['incomplete', '配置状态']
  ]
  const payrollRow = (row) => ({
    ...row,
    role: roleNames[row.role],
    month: report.month,
    ...Object.fromEntries(
      ['base', 'commission', 'deduction', 'total'].map((key) => [key, yuan(row[key])])
    ),
    incomplete: row.incomplete ? '配置未齐' : '完整',
    _people: [row.userId]
  })
  add(
    'payroll',
    '工资核算',
    '工资与提成',
    ownOrSalary,
    payrollColumns,
    report.payroll.map(payrollRow),
    '按所选月份核算；已发放月份显示待补结算差额，缺失金额保持待配置。日期范围不重算月度工资。'
  )
  add(
    'payrollHistory',
    '工资发放明细',
    '工资与提成',
    ownOrSalary,
    [
      ...payrollColumns.filter(([key]) => key !== 'total'),
      ['total', '本次发放金额（元）', 'number'],
      ['payrollId', '发放记录 ID', 'text', false],
      ['paidAt', '发放时间'],
      ['paidByName', '经办人']
    ],
    snapshot.payrolls
      .filter((row) => row.month === report.month)
      .flatMap((payroll) =>
        payroll.lines.map((row) => ({
          ...payrollRow(row),
          month: payroll.month,
          payrollId: payroll.id,
          paidAt: displayTime(payroll.paidAt),
          paidByName: person(payroll.paidBy),
          _date: payroll.paidAt,
          _people: [row.userId, payroll.paidBy]
        }))
      ),
    '所选核算月份的原始发放快照及补结算，不改写历史金额。',
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
    snapshot.salaryPlans.map((row) => ({
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
      _people: [row.userId]
    })),
    '当前权限可见工资方案；按生效日期筛选，不将缺配置金额视为零。',
    '方案生效日期'
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
    snapshot.attendance.map((row) => ({
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
    '人员档案',
    '人员管理',
    can('users.manage'),
    [
      ['name', '姓名 / 称呼'],
      ['username', '登录账号'],
      ['role', '角色'],
      ['status', '账号状态'],
      ['levelName', '打手等级'],
      ['maxActiveOrders', '接单上限', 'number'],
      ['activeOrders', '执行中订单', 'number'],
      ['permissions', '实际业务权限'],
      ['permissionOverrides', '个人权限覆盖', 'text', false]
    ],
    snapshot.users.map((row) => ({
      ...row,
      role: roleNames[row.role],
      status: row.status === 'active' ? '启用' : '停用',
      levelName: snapshot.levels.find((level) => level.id === row.levelId)?.name || '',
      permissions: permissionText(permissionsFor(row)),
      permissionOverrides: Object.entries(row.permissionOverrides)
        .map(([key, value]) => `${permissionNames[key] || key}：${value ? '允许' : '禁止'}`)
        .join('；'),
      _status: row.status,
      _people: [row.id]
    })),
    '人员和权限配置快照，不导出密码、密码哈希或登录会话；日期范围不适用。'
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
    Object.entries(snapshot.roleDefaults).map(([role, permissions]) => ({
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
    menuRows.map(([name, path, permissions]) => ({
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
      ['name', '客户称呼'],
      ['contact', '联系方式'],
      ['gameId', '客户游戏 ID'],
      ['remark', '客户备注']
    ],
    snapshot.customers.map((row) => ({ ...row })),
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
    snapshot.templates.map((row) => ({
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
      ['operatorCommission', '参与运营提成']
    ],
    snapshot.platforms.map((row) => ({
      ...row,
      operatorCommission: row.operatorCommission ? '是' : '否',
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
    snapshot.shops.map((row) => ({
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
    snapshot.levels.map((row) => ({ ...row })),
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
      ['icons', '菜单与快捷入口预设图标'],
      ['revision', '配置版本', 'number'],
      ['updatedAt', '保存时间']
    ],
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
              personnel: '排班考勤',
              system: '系统管理',
              reports: '数据报表',
              createOrder: '创建与派单',
              orderList: '订单管理',
              customers: '客户档案',
              users: '人员管理',
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
    snapshot.logs.map((row) => ({
      ...row,
      createdAt: displayTime(row.createdAt),
      before: row.before == null ? '' : JSON.stringify(row.before),
      after: row.after == null ? '' : JSON.stringify(row.after),
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
    [
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
    modules: modulesFor(snapshot).map(({ rows, ...item }) => ({ ...item, rowCount: rows.length }))
  }
}
const invalid = (message, status = 400) => {
  throw new ApiError(message, status)
}
function filterOptions(filters) {
  if (filters == null) return {}
  if (typeof filters !== 'object' || Array.isArray(filters)) invalid('导出范围格式无效')
  const allowed = ['dateRange', 'keyword', 'personId', 'platformId', 'status', 'orderDateKey']
  if (Object.keys(filters).some((key) => !allowed.includes(key))) invalid('导出筛选项无效')
  for (const key of ['keyword', 'personId', 'platformId', 'status']) {
    if (filters[key] != null && (typeof filters[key] !== 'string' || filters[key].length > 200))
      invalid('导出筛选项过长或格式无效')
  }
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
    request.modules.length > 30
  )
    invalid('请选择 1 至 30 个导出模块')
  if (request.month && request.month !== snapshot.reports.month) invalid('核算月份与当前数据不一致')
  const options = filterOptions(request.filters)
  const catalog = new Map(modulesFor(snapshot).map((item) => [item.id, item]))
  const used = new Set()
  let total = 0
  const sheets = request.modules.map((selection) => {
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
    const matching = item.rows.filter((row) => {
      if (options.personId && row._people && !row._people.includes(options.personId)) return false
      if (options.platformId && row._platforms && !row._platforms.includes(options.platformId))
        return false
      if (options.status && row._status && row._status !== options.status) return false
      if (
        options.keyword?.trim() &&
        !JSON.stringify(
          Object.fromEntries(item.fields.map((field) => [field.key, row[field.key] ?? '']))
        )
          .toLowerCase()
          .includes(options.keyword.trim().toLowerCase())
      )
        return false
      if (options.dateRange && ('_date' in row || row._dates)) {
        const value = row._dates ? row._dates[options.orderDateKey || 'createdAt'] : row._date
        if (!value) return false
        const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : shanghaiDate(value)
        if (date < options.dateRange[0] || date > options.dateRange[1]) return false
      }
      return true
    })
    total += matching.length
    if (total > MAX_ROWS) invalid(`导出超过 ${MAX_ROWS} 条，请缩小范围后重试`)
    const rows = (previewLimit == null ? matching : matching.slice(0, previewLimit)).map((row) =>
      Object.fromEntries(selected.map((field) => [field.key, row[field.key] ?? '']))
    )
    return { id: item.id, name: item.label, fields: selected, rows, rowCount: matching.length }
  })
  return { month: snapshot.reports.month, sheets, generatedAt: new Date().toISOString() }
}
