import { ApiError, shanghaiDate } from './studio.mjs'
import { orderLifecycle } from './order-lifecycle.mjs'

const has = (permissions, ...keys) => keys.every((key) => permissions.includes(key))
const any = (permissions, ...keys) => keys.some((key) => permissions.includes(key))
const within = (value, range) => Boolean(value && value >= range.start && value <= range.end)
const total = (rows, key) => rows.reduce((sum, row) => sum + (row[key] || 0), 0)
const rate = (value, count) => count ? Math.round(value / count * 10000) / 100 : null
const definitions = {
  received: [
    ['days', '每日收入', ['profit.view']],
    ['paid-orders', '付款订单', ['profit.view', 'orders.view']],
    ['by-game', '按游戏', ['profit.view', 'orders.view']],
    ['by-project', '按项目/价格快照', ['profit.view', 'orders.view']],
    ['by-platform', '按平台', ['profit.view', 'orders.view']]
  ],
  orders: [
    ['paid-orders', '付款订单', ['orders.view']],
    ['created-orders', '创建订单', ['orders.view']],
    ['completed-orders', '完成订单', ['orders.view']],
    ['canceled-orders', '取消订单', ['orders.view']],
    ['by-status', '付款订单当前状态', ['orders.view']]
  ],
  customers: [
    ['paying-customers', '付费客户', ['profit.view', 'orders.view']],
    ['repeat-customers', '复购客户', ['profit.view', 'orders.view']],
    ['by-game', '按游戏', ['profit.view', 'orders.view']]
  ],
  profit: [
    ['days', '每日收入与成本', ['profit.view']],
    ['cost-orders', '付款订单成本', ['profit.view', 'orders.view']]
  ],
  people: ['new-staff', 'new-players', 'current-people', 'unknown-date'].map((id, index) =>
    [id, ['新增员工', '新增打手', '当前人员', '创建日期待确认'][index],
      ['users.manage', 'attendance.manage', 'salary.all'], 'any']),
  wallet: [
    ['balances', '当前钱包', ['finance.withdrawals']],
    ['paid-withdrawals', '区间已发提现', ['finance.withdrawals']],
    ['in-flight-withdrawals', '当前在途提现', ['finance.withdrawals']]
  ],
  accepted: [
    ['assignments', '逐次接单', ['orders.view']],
    ['accepted-orders', '去重接单订单', ['orders.view']],
    ['by-player', '按接单打手', ['orders.view']]
  ],
  expenses: [
    ['expense-records', '费用登记', ['finance.expenses', 'profit.view'], 'any'],
    ['reward-adjustments', '报酬人工净调整', ['finance.withdrawals', 'profit.view']]
  ],
  personal: [
    ['completed-orders', '本人完成订单', ['orders.view']],
    ['by-game', '本人按游戏业绩', ['orders.view']]
  ]
}

export function overviewDetailQuery(user, permissions, input = {}) {
  if (user.role === 'player') throw new ApiError('此接口不向打手账号开放', 403)
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ApiError('明细筛选格式无效')
  const metric = input.metric
  if (!Object.hasOwn(definitions, metric)) throw new ApiError('概览指标无效')
  const views = definitions[metric].map(([id, label, keys, mode]) => ({
    id, label, allowed: mode === 'any' ? any(permissions, ...keys) : has(permissions, ...keys)
  }))
  if (!views.some((row) => row.allowed)) throw new ApiError('没有查看此概览指标的权限', 403)
  const view = input.view ?? views[0].id
  if (view === 'by-terminal') throw Object.assign(
    new ApiError('当前订单没有已确认的终端字段，暂不支持终端分类'),
    { code: 'OVERVIEW_VIEW_UNSUPPORTED' })
  const selected = views.find((row) => row.id === view)
  if (!selected) throw new ApiError('概览明细视图无效')
  if (!selected.allowed) throw new ApiError('没有查看此概览明细的权限', 403)
  const current = Number(input.current ?? 1), size = Number(input.size ?? 20)
  if (!Number.isSafeInteger(current) || current < 1 || !Number.isSafeInteger(size) ||
      size < 1 || size > 100 || !Number.isSafeInteger((current - 1) * size))
    throw new ApiError('分页参数无效')
  if (input.keyword != null && typeof input.keyword !== 'string')
    throw new ApiError('搜索条件格式无效')
  const keyword = (input.keyword ?? '').trim()
  if (keyword.length > 100) throw new ApiError('搜索条件最多100字符')
  return { metric, view, current, size, keyword: keyword.toLowerCase(), views }
}

const column = (key, label, type = 'text') => ({ key, label, type })
const orderColumns = [
  column('id', '订单ID'), column('orderNo', '工作室单号'), column('title', '标题'),
  column('game', '游戏'), column('projectName', '项目/价格快照'),
  column('platformName', '平台'), column('shopName', '店铺'), column('status', '当前状态', 'status'),
  column('eventAt', '归属时间', 'datetime'), column('received', '收款', 'money'),
  column('refunds', '原付款日退款', 'money'), column('net', '收入净额', 'money'),
  column('reward', '打手报酬', 'money')
]
const groupColumns = [column('label', '分类'), column('count', '订单数', 'number'),
  column('received', '收款', 'money'), column('refunds', '原付款日退款', 'money'),
  column('net', '收入净额', 'money')]
const countLabels = {
  received: { days: '自然日数', 'paid-orders': '付款订单数', 'by-game': '付款订单数',
    'by-project': '付款订单数', 'by-platform': '付款订单数' },
  orders: { 'paid-orders': '付款订单数', 'created-orders': '创建订单数', 'completed-orders': '完成订单数',
    'canceled-orders': '取消订单数', 'by-status': '付款订单数' },
  customers: { 'paying-customers': '付费客户数', 'repeat-customers': '复购客户数',
    'by-game': '付费客户数（各游戏分别去重）' },
  profit: { days: '自然日数', 'cost-orders': '付款订单数' },
  people: { 'new-staff': '员工档案数', 'new-players': '打手档案数', 'current-people': '人员档案数',
    'unknown-date': '日期待确认档案数' },
  wallet: { balances: '打手钱包数', 'paid-withdrawals': '已发提现记录数',
    'in-flight-withdrawals': '在途提现记录数' },
  accepted: { assignments: '接单次数', 'accepted-orders': '去重接单订单数', 'by-player': '接单次数' },
  expenses: { 'expense-records': '费用登记记录数', 'reward-adjustments': '报酬调整记录数' },
  personal: { 'completed-orders': '本人完成订单数', 'by-game': '本人完成订单数' }
}
const groupSort = (a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key))
const newest = (a, b) => String(b.eventAt || b.createdAt || b.date || '').localeCompare(
  String(a.eventAt || a.createdAt || a.date || '')) ||
  String(b.id || b.assignmentId || b.customerId || b.userId || '').localeCompare(
    String(a.id || a.assignmentId || a.customerId || a.userId || ''))

/** Build only scalar projections from the same complete, authorized overview snapshot. */
export function buildOverviewDetails(snapshots, overview, query, facts = {}) {
  const dates = new Map()
  const dayOf = (value) => {
    if (!value) return null
    const key = value instanceof Date ? value.getTime() : value
    if (!dates.has(key)) dates.set(key, shanghaiDate(value))
    return dates.get(key)
  }
  const snapshot = snapshots[0], range = overview.range
  const { metric, view, keyword, current, size } = query
  const orders = snapshot.orders
  const orderById = new Map(orders.map((row) => [row.id, row]))
  const users = new Map(snapshot.users.map((row) => [row.id, row]))
  const customers = new Map(snapshot.customers.map((row) => [row.id, row]))
  const platforms = new Map(snapshot.platforms.map((row) => [row.id, row.name]))
  const shops = new Map(snapshot.shops.map((row) => [row.id, row.name]))
  const refundTotals = new Map()
  for (const row of snapshot.refunds.filter((row) => row.status === 'paid'))
    refundTotals.set(row.orderId, (refundTotals.get(row.orderId) || 0) + row.amount)
  const financial = (order) => {
    const received = order.receivedAmount, refunds = refundTotals.get(order.id) || 0
    return { received, refunds, net: received - refunds }
  }
  const project = (order) => order.snapshot?.name || '项目快照待确认'
  const game = (order) => order.snapshot?.game || '游戏待确认'
  const orderRecord = (order, eventAt) => ({
    id: order.id, orderNo: order.orderNo || '', title: order.title,
    game: game(order), projectName: project(order),
    platformName: platforms.get(order.platformId) || '平台待确认',
    shopName: shops.get(order.shopId) || (order.shopId ? '店铺待确认' : '无店铺'),
    status: orderLifecycle(snapshot, order).displayStatus, eventAt: eventAt || null,
    ...financial(order),
    reward: orderLifecycle(snapshot, order).effectiveReward
  })
  const paid = orders.filter((row) => row.receivedAmount > 0 && within(dayOf(row.paidAt), range))
  const matches = (row, keys) => !keyword || keys.some((key) =>
    String(row[key] ?? '').toLowerCase().includes(keyword))
  const grouping = (rows, identity, amountKey) => {
    const map = new Map()
    for (const row of rows) {
      const { key, label } = identity(row)
      const entry = map.get(key) || { key, label, count: 0, amount: amountKey ? 0 : null }
      entry.count++
      if (amountKey) {
        if (row[amountKey] == null) entry.amount = null
        else if (entry.amount != null) entry.amount += row[amountKey]
      }
      map.set(key, entry)
    }
    return [...map.values()].sort(groupSort)
  }
  const aggregateOrders = (rows, identity) => {
    const map = new Map()
    for (const order of rows) {
      const { key, label } = identity(order)
      const entry = map.get(key) || { key, label, count: 0, received: 0, refunds: 0, net: 0 }
      entry.count++
      const money = financial(order)
      for (const name of ['received', 'refunds', 'net']) entry[name] += money[name]
      map.set(key, entry)
    }
    return [...map.values()].sort(groupSort)
  }
  let records = [], columns = [], searchKeys = [], groups = [], dimension = 'status'
  let amountKey = null, identity = (row) => ({ key: row.status || 'unknown', label: row.status || '待确认' })
  const notes = [...overview.scopeNotes]

  if (view === 'days') {
    records = [...new Map(snapshots.flatMap((row) => row.reports.days).map((row) =>
      [row.date, row])).values()].filter((row) => within(row.date, range)).map((row) => ({
      date: row.date, received: row.received, refunds: row.refunds, net: row.net,
      ...(metric === 'profit' ? {
        otherIncome: row.otherIncome, reward: row.reward, estimatedReward: row.estimatedReward,
        supportCommission: row.incomplete ? null : row.supportCommission,
        operationsCommission: row.incomplete ? null : row.operationsCommission,
        expenses: row.expenses, profit: row.profit, incomplete: row.incomplete ? '待确认' : '完整'
      } : {})
    }))
    columns = [column('date', '上海自然日'), column('received', '收款', 'money'),
      column('refunds', '原付款日退款', 'money'), column('net', '收入净额', 'money')]
    if (metric === 'profit') columns.push(
      column('otherIncome', '其他收入', 'money'), column('reward', '打手成本', 'money'),
      column('estimatedReward', '其中预计报酬', 'money'),
      column('supportCommission', '客服提成', 'money'), column('operationsCommission', '运营提成', 'money'),
      column('expenses', '费用及报酬净调整', 'money'), column('profit', '区间经营利润', 'money'),
      column('incomplete', '配置状态', 'status'))
    searchKeys = []
    amountKey = metric === 'profit' ? 'profit' : 'received'
    identity = (row) => ({ key: row.date, label: row.date })
    dimension = 'date'
    notes.push('每日经营利润不扣月度底薪；完整月份扣底薪结果以主卡 summary 为准。')
  } else if (metric === 'people') {
    records = snapshot.users.filter((row) =>
      view === 'current-people' || (view === 'unknown-date' ? !row.createdAt :
        (view === 'new-players' ? row.role === 'player' : row.role !== 'player') &&
        within(dayOf(row.createdAt), range))).map((row) => ({
      id: row.id, name: row.name, role: row.role, status: row.status, createdAt: row.createdAt || null
    }))
    columns = [column('id', '人员ID'), column('name', '姓名'), column('role', '角色', 'status'),
      column('status', '当前状态', 'status'), column('createdAt', '档案创建时间', 'datetime')]
    searchKeys = ['name']
    identity = (row) => ({ key: row.role, label: row.role })
    dimension = 'role'
    notes.push('当前人员及未知日期名单为当前档案快照；未知创建时间不会补造，新增分类只展示有可靠日期的记录。')
  } else if (metric === 'wallet') {
    if (view === 'balances') {
      records = snapshot.wallets.map((row) => ({
        userId: row.userId, name: users.get(row.userId)?.name || '打手档案待确认',
        status: users.get(row.userId)?.status || 'unknown',
        earned: row.earned, available: row.available, occupied: row.occupied, paid: row.paid
      }))
      columns = [column('userId', '打手ID'), column('name', '姓名'), column('status', '当前状态', 'status'),
        column('earned', '累计入账', 'money'), column('available', '可提现', 'money'),
        column('occupied', '占用', 'money'), column('paid', '累计已发', 'money')]
      amountKey = 'available'
      records.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))
      notes.push('钱包为当前完整余额，包含停用打手，不受日期区间影响；分类金额为可提现，不含占用。')
    } else {
      records = snapshot.withdrawals.filter((row) => view === 'paid-withdrawals' ?
        row.status === 'paid' && within(dayOf(row.paidAt), range) :
        ['pending', 'approved'].includes(row.status)).map((row) => ({
        id: row.id, userId: row.userId, name: users.get(row.userId)?.name || '打手档案待确认',
        amount: row.amount, status: row.status, createdAt: row.createdAt,
        paidAt: row.paidAt || null, paymentMethod: row.paymentMethod
      }))
      columns = [column('id', '提现ID'), column('userId', '打手ID'), column('name', '姓名'),
        column('amount', '提现金额', 'money'), column('status', '状态', 'status'),
        column('createdAt', '申请时间', 'datetime'), column('paidAt', '发放时间', 'datetime'),
        column('paymentMethod', '收款方式', 'status')]
      amountKey = 'amount'
      if (view === 'in-flight-withdrawals') notes.push('在途提现为当前待审/已批准占用快照，不受日期区间影响。')
    }
    searchKeys = ['name']
  } else if (metric === 'expenses') {
    if (view === 'expense-records') {
      records = snapshot.expenses.filter((row) => !row.deletedAt && within(row.date, range))
        .map((row) => ({ id: row.id, category: row.category, date: row.date, amount: row.amount }))
      columns = [column('id', '费用ID'), column('category', '类别'), column('date', '费用日期'),
        column('amount', '登记费用', 'money')]
      searchKeys = ['category']
      amountKey = 'amount'
      identity = (row) => ({ key: row.category, label: row.category })
      dimension = 'category'
    } else {
      records = snapshot.playerAdjustments.filter((row) => row.source !== 'status-correction' &&
        within(facts.adjustmentDates?.get(row.id), range)).map((row) => {
        const recoveredAmount = row.resolution === 'recovered' ? row.manualAmount : 0
        return {
          id: row.id, userId: row.userId, name: users.get(row.userId)?.name || '打手档案待确认',
          orderId: row.orderId || null, orderNo: orderById.get(row.orderId)?.orderNo || null,
          kind: row.kind, effectiveDate: facts.adjustmentDates.get(row.id), createdAt: row.createdAt,
          appliedAmount: row.appliedAmount, recoveredAmount,
          expenseDelta: row.kind === 'supplement' ? row.appliedAmount : -row.appliedAmount - recoveredAmount,
          status: row.status
        }
      })
      columns = [column('id', '调整ID'), column('name', '打手姓名'), column('orderNo', '关联工作室单号'),
        column('kind', '类型', 'status'), column('effectiveDate', '费用归属日期'),
        column('createdAt', '登记时间', 'datetime'), column('appliedAmount', '已应用金额', 'money'),
        column('recoveredAmount', '已追回人工差额', 'money'), column('expenseDelta', '费用净调整', 'money'),
        column('status', '处理状态', 'status')]
      searchKeys = ['name', 'orderNo']
      amountKey = 'expenseDelta'
      identity = (row) => ({ key: row.kind, label: row.kind === 'supplement' ? '补款' : '扣款' })
      dimension = 'kind'
    }
    notes.push(has(snapshot.permissions, 'profit.view') ?
      '主卡费用合计沿用费用登记加报酬人工净调整；两项是合计的分项，不再次扣减。扣款净调整可为负。' :
      '当前费用权限仅有有效费用登记口径，不包含报酬人工净调整。')
  } else if (metric === 'customers') {
    const customerRows = (cohort) => [...new Set(cohort.map((row) => row.customerId).filter(Boolean))]
      .map((customerId) => {
        const rows = cohort.filter((row) => row.customerId === customerId)
        const lifetime = orders.filter((row) => row.customerId === customerId && row.receivedAmount > 0 &&
          dayOf(row.paidAt) && dayOf(row.paidAt) <= range.end).length
        return { customerId, name: customers.get(customerId)?.name || '客户档案待确认',
          paidOrders: rows.length, received: total(rows, 'receivedAmount'),
          refunds: rows.reduce((sum, row) => sum + (refundTotals.get(row.id) || 0), 0),
          net: rows.reduce((sum, row) => sum + financial(row).net, 0),
          lifetimePaidOrdersUntilEnd: lifetime, repeat: lifetime >= 2 ? '复购' : '首次'
        }
      })
    if (view === 'by-game') {
      records = [...new Set(paid.map(game))].map((label) => {
        const rows = paid.filter((row) => game(row) === label), customerList = customerRows(rows)
        return { key: label, label, count: customerList.length, paidOrders: rows.length,
          received: total(customerList, 'received'), refunds: total(customerList, 'refunds'),
          net: total(customerList, 'net'), repeatCustomers: customerList.filter((row) => row.repeat === '复购').length }
      }).sort(groupSort)
      columns = [column('label', '游戏'), column('count', '付费客户数', 'number'),
        column('paidOrders', '付款订单数', 'number'), column('received', '收款', 'money'),
        column('refunds', '原付款日退款', 'money'), column('net', '收入净额', 'money'),
        column('repeatCustomers', '复购客户数', 'number')]
      searchKeys = ['label']
      notes.push('同一客户购买多个游戏可进入多个分类，分类客户数不能相加当全店去重人数。')
    } else {
      records = customerRows(paid).filter((row) => view !== 'repeat-customers' || row.repeat === '复购')
      columns = [column('customerId', '客户ID'), column('name', '客户姓名'),
        column('paidOrders', '付款订单数', 'number'), column('received', '收款', 'money'),
        column('refunds', '原付款日退款', 'money'), column('net', '收入净额', 'money'),
        column('lifetimePaidOrdersUntilEnd', '截至期末付款订单数', 'number'), column('repeat', '复购分类', 'status')]
      searchKeys = ['name']
      identity = (row) => ({ key: row.repeat, label: row.repeat })
      amountKey = 'received'
      dimension = 'repeat'
    }
  } else if (metric === 'accepted') {
    const assignments = orders.flatMap((order) => (order.assignments || [])
      .filter((row) => within(dayOf(row.acceptedAt), range)).map((row, index) => ({
        assignmentId: row.id || `${order.id}:assignment:${index}`,
        orderId: order.id, orderNo: order.orderNo, title: order.title,
        userId: row.leaderId, name: users.get(row.leaderId)?.name || '打手档案待确认',
        game: game(order), status: orderLifecycle(snapshot, order).displayStatus, eventAt: row.acceptedAt
      })))
    if (view === 'assignments') {
      records = assignments
      columns = [column('assignmentId', '接单ID'), column('orderNo', '工作室单号'), column('title', '标题'),
        column('name', '接单打手'), column('game', '游戏'), column('status', '订单当前状态', 'status'),
        column('eventAt', '接单时间', 'datetime')]
      searchKeys = ['orderNo', 'title', 'name', 'game']
      identity = (row) => ({ key: row.userId, label: row.name })
      dimension = 'player'
    } else if (view === 'by-player') {
      records = [...new Set(assignments.map((row) => row.userId))].map((userId) => {
        const rows = assignments.filter((row) => row.userId === userId)
        const accepted = [...new Set(rows.map((row) => row.orderId))]
        const completedOrders = accepted.filter((orderId) => {
          const order = orderById.get(orderId)
          return order.status === 'completed' && dayOf(order.completedAt) && dayOf(order.completedAt) <= range.end
        }).length
        return { key: userId, label: users.get(userId)?.name || '打手档案待确认', count: rows.length,
          acceptedOrders: accepted.length, completedOrders, completionRate: rate(completedOrders, accepted.length) }
      }).sort(groupSort)
      columns = [column('label', '接单打手'), column('count', '接单次数', 'number'),
        column('acceptedOrders', '去重订单数', 'number'), column('completedOrders', '其中当前已完成', 'number'),
        column('completionRate', '完成率（%）', 'number')]
      searchKeys = ['label']
    } else {
      const latest = new Map()
      for (const row of assignments)
        if (!latest.has(row.orderId) || row.eventAt > latest.get(row.orderId)) latest.set(row.orderId, row.eventAt)
      records = [...latest].map(([orderId, eventAt]) => orderRecord(orderById.get(orderId), eventAt))
      columns = orderColumns
      searchKeys = ['orderNo', 'title', 'game', 'projectName', 'platformName', 'shopName']
    }
    notes.push('接单为逐次事件，去重订单与接单次数分别计数；完成率参考当前状态及截至期末完成时间，不重建全部历史状态。')
  } else {
    let cohort = paid, eventKey = 'paidAt'
    if (view === 'created-orders') { cohort = orders.filter((row) => within(dayOf(row.createdAt), range)); eventKey = 'createdAt' }
    if (view === 'completed-orders') {
      cohort = orders.filter((row) => row.status === 'completed' && within(dayOf(row.completedAt), range))
      eventKey = 'completedAt'
    }
    if (view === 'canceled-orders') {
      cohort = orders.filter((row) => within(dayOf(row.canceledAt), range)); eventKey = 'canceledAt'
    }
    if (metric === 'personal') {
      cohort = orders.filter((row) => row.status === 'completed' && row.receivedAmount > 0 &&
        within(dayOf(row.completedAt), range) && facts.personalOrderIds?.has(row.id))
      eventKey = 'completedAt'
      notes.push('仅当前本人创建或运营归属的已付款完成订单，按完成日统计有效业绩，原退款口径不变。')
    }
    if (['by-game', 'by-project', 'by-platform', 'by-status'].includes(view)) {
      const keyFor = (order) => {
        if (view === 'by-project') return { key: JSON.stringify([order.snapshot?.name || null,
          order.snapshot?.amount ?? null, order.snapshot?.reward ?? null, order.snapshot?.game || null]), label: project(order) }
        if (view === 'by-platform') return { key: order.platformId || 'unknown', label: platforms.get(order.platformId) || '平台待确认' }
        if (view === 'by-status') {
          const status = orderLifecycle(snapshot, order).displayStatus
          return { key: status, label: status }
        }
        return { key: game(order), label: game(order) }
      }
      records = aggregateOrders(cohort, keyFor)
      if (metric === 'personal') {
        for (const row of records) row.net = cohort.filter((order) => keyFor(order).key === row.key)
          .reduce((sum, order) => sum + facts.orderFacts.get(order.id).net, 0)
      }
      columns = groupColumns.map((row) => row.key === 'net' && metric === 'personal' ?
        column('net', '本人有效业绩', 'money') : row)
      if (view === 'by-project') {
        const projects = new Map(cohort.map((order) => [keyFor(order).key, order.snapshot]))
        records = records.map((row) => ({ ...row,
          snapshotAmount: projects.get(row.key)?.amount ?? null,
          snapshotReward: projects.get(row.key)?.reward ?? null }))
        columns = [...columns, column('snapshotAmount', '项目价格快照', 'money'),
          column('snapshotReward', '项目报酬快照', 'money')]
      }
      searchKeys = ['label']
      if (view === 'by-status') notes.push('此状态分类仅针对区间付款订单，按订单当前状态分组；创建/完成/取消时间视图属于不同集合。')
    } else {
      records = cohort.map((row) => orderRecord(row, row[eventKey]))
      columns = orderColumns
      if (metric === 'personal') {
        records = records.map((row) => ({ ...row, net: facts.orderFacts.get(row.id).net }))
        columns = columns.map((row) => row.key === 'net' ? column('net', '本人有效业绩', 'money') : row)
      }
      searchKeys = ['orderNo', 'title', 'game', 'projectName', 'platformName', 'shopName']
      amountKey = metric === 'personal' ? 'net' : 'received'
      if (view === 'cost-orders') {
        records = records.map((row) => {
          const cost = facts.orderFacts?.get(row.id)
          return { ...row, estimatedReward: cost.estimatedReward,
            supportCommission: cost.supportCommission, operationsCommission: cost.operationsCommission,
            incomplete: cost.incomplete ? '待确认' : '完整' }
        })
        columns = [...columns, column('estimatedReward', '其中预计报酬', 'money'),
          column('supportCommission', '客服提成', 'money'), column('operationsCommission', '运营提成', 'money'),
          column('incomplete', '配置状态', 'status')]
        notes.push('订单成本不再次分摊费用、其他收入或底薪；金额缺配置保持待确认，不补零。')
      }
    }
  }

  records = records.filter((row) => matches(row, searchKeys))
  if (view.startsWith('by-')) {
    records.sort(groupSort)
    amountKey = ['received', 'customers', 'orders'].includes(metric) ? 'received' :
      metric === 'personal' ? 'net' : null
    groups = records.map((row) => ({ key: row.key, label: row.label, count: row.count,
      amount: amountKey ? (row[amountKey] ?? null) : null }))
    dimension = view.slice(3)
  } else {
    if (!(metric === 'wallet' && view === 'balances')) records.sort(newest)
    groups = grouping(records, identity, amountKey)
  }
  const groupCount = groups.length
  return {
    metric, view, range: overview.range, comparisonRange: overview.comparisonRange,
    generatedAt: overview.generatedAt, summary: overview.metrics, overview,
    columns, records: records.slice((current - 1) * size, current * size), total: records.length,
    current, size, groups: groups.slice(0, 100),
    groupsInfo: { dimension, total: groupCount, returned: Math.min(groupCount, 100), truncated: groupCount > 100,
      amountLabel: amountKey ? columns.find((row) => row.key === amountKey).label : '无金额口径',
      countLabel: countLabels[metric][view] },
    notes, capabilities: {
      views: query.views,
      terminal: { supported: false, reason: '当前订单没有已确认的端游/手游字段，不能推测终端分类。' },
      game: { supported: true, label: '游戏（订单项目快照）' }
    }
  }
}
