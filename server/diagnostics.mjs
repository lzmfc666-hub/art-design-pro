const MAX_ISSUES = 100
const ORDER_STATUSES = new Set(['pending', 'active', 'review', 'completed', 'canceled'])
const money = (value, { signed = false } = {}) =>
  Number.isSafeInteger(value) && Math.abs(value) <= 100_000_000_000 && (signed || value >= 0)
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const date = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const asRows = (value) =>
  Array.isArray(value) ? value.filter((row) => row && typeof row === 'object') : []

/** Read-only inspection of saved business records. It does not rebuild or repair any ledger. */
export function buildDiagnosticsReport({
  state,
  customerReferences = [],
  uploadIds = [],
  fundAccounts = [],
  fundTransactions = [],
  now
}) {
  const checks = [
    ['references', '业务关联', '核对档案和订单的关联记录是否存在、店铺是否属于订单来源。'],
    ['orders', '订单状态与金额', '核对状态、实际负责人、收款及完成材料，不将指定待接单当作异常。'],
    ['rewards', '打手报酬与冲正', '核对实际到账记录、结算对象、重复到账及已登记的状态冲正。'],
    ['wallets', '钱包与提现占用', '核对有效到账和扣补款能否覆盖在途与已付提现，不核实银行实收。'],
    ['customerReferences', '客户平台编号', '核对独立编号的客户、来源、店铺关联及重复记录。'],
    ['payroll', '工资发放快照', '核对已发快照算术、人员关联和同月重复底薪，不用当前方案重算历史。'],
    ['attendance', '实际工时登记', '核对已登记工时，正常默认显示及未来排班不视为实际到岗。'],
    [
      'funds',
      '客户储值与打手押金',
      '核对独立账户与不可变流水、原路订单支付退款，不将资金缴纳当营业收入。'
    ],
    ['pending', '配置和人工待办', '未配置工资、取消补偿及线下待追回只列提醒，不视为数据损坏。']
  ].map(([id, label, description]) => ({
    id,
    label,
    description,
    status: 'ok',
    checkedRecords: 0,
    errorCount: 0,
    warningCount: 0
  }))
  const byCheck = new Map(checks.map((row) => [row.id, row]))
  const errors = [],
    warnings = []
  let issueCount = 0
  const inspect = (id, count = 1) => {
    byCheck.get(id).checkedRecords += count
  }
  const issue = (checkId, severity, entity, entityId, message) => {
    const check = byCheck.get(checkId)
    check[severity === 'error' ? 'errorCount' : 'warningCount']++
    check.status = check.errorCount ? 'error' : 'warning'
    issueCount++
    const list = severity === 'error' ? errors : warnings
    if (list.length < MAX_ISSUES)
      list.push({
        id: `check-${issueCount}`,
        checkId,
        severity,
        entity,
        entityId: typeof entityId === 'string' ? entityId : null,
        message
      })
  }
  const tables = Object.fromEntries(
    [
      'users',
      'customers',
      'platforms',
      'shops',
      'templates',
      'orders',
      'rewardCredits',
      'playerAdjustments',
      'withdrawals',
      'refunds',
      'salaryPlans',
      'payrolls',
      'attendance',
      'workSchedules',
      'rewardReviews',
      'commissionAdjustments'
    ].map((key) => [key, asRows(state[key])])
  )
  const maps = Object.fromEntries(
    Object.entries(tables).map(([key, rows]) => [key, new Map(rows.map((row) => [row.id, row]))])
  )
  const uploads = new Set(uploadIds)
  for (const [table, rows] of Object.entries(tables)) {
    if (
      state[table] != null &&
      (!Array.isArray(state[table]) || rows.length !== state[table].length)
    )
      issue(
        'references',
        'error',
        table,
        null,
        '保存的记录集合包含不合法结构，无法逐条核对全部内容。'
      )
    const ids = new Set()
    for (const row of rows) {
      inspect('references')
      if (typeof row.id !== 'string' || !row.id)
        issue('references', 'error', table, row.id, '记录缺少有效唯一标识。')
      else if (ids.has(row.id))
        issue(
          'references',
          'error',
          table,
          row.id,
          '同类记录存在重复唯一标识，关联结果可能不确定。'
        )
      ids.add(row.id)
    }
  }
  const link = (check, entity, row, key, table, label, required = true) => {
    const value = row[key]
    if (!required && (value == null || value === '')) return
    if (!maps[table].has(value)) issue(check, 'error', entity, row.id, `${label}关联不存在。`)
  }
  const attachment = (check, entity, row, value, label) => {
    if (value && !uploads.has(value.id))
      issue(check, 'error', entity, row.id, `${label}关联的上传图片不存在。`)
  }
  for (const shop of tables.shops)
    link('references', 'shop', shop, 'platformId', 'platforms', '店铺来源')
  for (const customer of tables.customers)
    link('references', 'customer', customer, 'platformId', 'platforms', '客户主要来源', false)
  const orderNumbers = new Set()
  for (const order of tables.orders) {
    for (const [key, table, label, required] of [
      ['customerId', 'customers', '客户', true],
      ['platformId', 'platforms', '订单来源', true],
      ['templateId', 'templates', '订单模板', true],
      ['creatorId', 'users', '创建人员', true],
      ['shopId', 'shops', '店铺', false],
      ['leaderId', 'users', '实际负责人', false],
      ['teammateId', 'users', '队友', false],
      ['assignedTo', 'users', '指定接单人', false]
    ])
      link('references', 'order', order, key, table, label, required)
    if (order.shopId && maps.shops.get(order.shopId)?.platformId !== order.platformId)
      issue('references', 'error', 'order', order.id, '订单店铺与来源平台不一致。')
    attachment('references', 'order', order, order.receipt, '付款凭证')
    for (const submission of asRows(order.submissions))
      for (const image of asRows(submission.screenshots))
        attachment('references', 'order', order, image, '完成材料')
    inspect('orders')
    if (!ORDER_STATUSES.has(order.status))
      issue('orders', 'error', 'order', order.id, '订单状态不在允许范围内。')
    for (const [key, label] of [
      ['amount', '客户金额'],
      ['reward', '整单报酬'],
      ['receivedAmount', '实收金额']
    ])
      if (!money(order[key]) || (key === 'amount' && order[key] === 0))
        issue('orders', 'error', 'order', order.id, `${label}不是有效整数分。`)
    if (money(order.receivedAmount) && money(order.amount) && order.receivedAmount > order.amount)
      issue('orders', 'error', 'order', order.id, '实收金额超过当前客户金额。')
    if (order.externalOrderNo) {
      const key = JSON.stringify([order.platformId, order.externalOrderNo])
      if (orderNumbers.has(key))
        issue('orders', 'error', 'order', order.id, '同一来源的平台订单号重复对应多个实际订单。')
      orderNumbers.add(key)
    }
    if (['active', 'review', 'completed'].includes(order.status) && !order.leaderId)
      issue('orders', 'error', 'order', order.id, '执行、验收或完成状态缺少实际负责人。')
    if (
      ['active', 'review'].includes(order.status) &&
      order.leaderId &&
      maps.users.get(order.leaderId)?.role !== 'player'
    )
      issue('orders', 'error', 'order', order.id, '正在执行的负责人不是打手账号。')
    if (order.leaderId && order.teammateId === order.leaderId)
      issue('orders', 'error', 'order', order.id, '负责人和队友是同一人。')
    if (order.teammateId && money(order.reward) && order.reward % 2)
      issue('orders', 'error', 'order', order.id, '双人平分报酬存在未处理的分币尾差。')
    if (order.receivedAmount > 0 && !timestamp(order.paidAt))
      issue('orders', 'error', 'order', order.id, '已有实收金额但没有有效原付款时间。')
    if (
      order.status === 'completed' &&
      (order.receivedAmount !== order.amount ||
        !timestamp(order.paidAt) ||
        !timestamp(order.completedAt))
    )
      issue('orders', 'error', 'order', order.id, '已完成订单缺少足额收款或有效完成时间。')
    const latest = asRows(order.submissions).at(-1)
    const manualReview =
      latest?.source === 'status-correction' &&
      maps.users.has(latest.correctedBy) &&
      typeof latest.correctionReason === 'string' &&
      latest.correctionReason.trim().length > 0 &&
      timestamp(latest.submittedAt) &&
      latest.leaderId === order.leaderId &&
      (latest.teammateId ?? null) === (order.teammateId ?? null)
    if (
      order.status === 'review' &&
      (!latest || (!asRows(latest.screenshots).length && !manualReview) || latest.review)
    )
      issue(
        'orders',
        'error',
        'order',
        order.id,
        '待验收订单没有可审核的最新完成材料或后台登记记录。'
      )
    if (order.status === 'pending' && order.dispatchMode === 'direct' && !order.assignedTo)
      issue('orders', 'error', 'order', order.id, '指定待接单订单缺少指定接单人。')
  }
  const creditPairs = new Set(),
    creditsByOrder = new Map(),
    balance = new Map()
  const addBalance = (userId, amount) => balance.set(userId, (balance.get(userId) || 0) + amount)
  for (const credit of tables.rewardCredits) {
    inspect('rewards')
    link('rewards', 'reward-credit', credit, 'orderId', 'orders', '报酬订单')
    link('rewards', 'reward-credit', credit, 'userId', 'users', '报酬收款人')
    if (!money(credit.amount))
      issue('rewards', 'error', 'reward-credit', credit.id, '报酬到账金额不是有效整数分。')
    else addBalance(credit.userId, credit.amount)
    const pair = JSON.stringify([credit.orderId, credit.userId])
    if (creditPairs.has(pair))
      issue(
        'rewards',
        'error',
        'reward-credit',
        credit.id,
        '同一订单向同一打手存在重复基础到账记录。'
      )
    creditPairs.add(pair)
    const rows = creditsByOrder.get(credit.orderId) || []
    rows.push(credit)
    creditsByOrder.set(credit.orderId, rows)
  }
  for (const adjustment of tables.playerAdjustments) {
    inspect('wallets')
    link('wallets', 'player-adjustment', adjustment, 'userId', 'users', '扣补款打手')
    link('wallets', 'player-adjustment', adjustment, 'orderId', 'orders', '扣补款订单', false)
    const valid =
      money(adjustment.amount) &&
      adjustment.amount > 0 &&
      money(adjustment.appliedAmount) &&
      money(adjustment.manualAmount)
    if (!valid || adjustment.appliedAmount + adjustment.manualAmount !== adjustment.amount)
      issue(
        'wallets',
        'error',
        'player-adjustment',
        adjustment.id,
        '扣补款总额与实际生效、人工差额不一致。'
      )
    if (
      !['deduction', 'supplement'].includes(adjustment.kind) ||
      !['applied', 'manual', 'resolved'].includes(adjustment.status)
    )
      issue('wallets', 'error', 'player-adjustment', adjustment.id, '扣补款类型或处理状态不合法。')
    if (adjustment.kind === 'supplement' && adjustment.manualAmount !== 0)
      issue(
        'wallets',
        'error',
        'player-adjustment',
        adjustment.id,
        '补款不应留下未生效的人工扣款差额。'
      )
    if (adjustment.status === 'manual' && adjustment.manualAmount <= 0)
      issue('wallets', 'error', 'player-adjustment', adjustment.id, '待追回状态没有有效人工差额。')
    if (adjustment.status === 'applied' && adjustment.manualAmount !== 0)
      issue(
        'wallets',
        'error',
        'player-adjustment',
        adjustment.id,
        '已全部生效的扣补款仍留有人工差额。'
      )
    if (adjustment.source === 'status-correction' && !adjustment.orderId)
      issue('wallets', 'error', 'player-adjustment', adjustment.id, '状态冲正流水缺少对应订单。')
    if (
      adjustment.status === 'resolved' &&
      (!['recovered', 'waived'].includes(adjustment.resolution) ||
        !adjustment.resolutionReason ||
        !timestamp(adjustment.resolvedAt))
    )
      issue(
        'wallets',
        'error',
        'player-adjustment',
        adjustment.id,
        '已处理差额缺少有效处理结果、时间或说明。'
      )
    if (valid && ['deduction', 'supplement'].includes(adjustment.kind))
      addBalance(
        adjustment.userId,
        adjustment.kind === 'supplement' ? adjustment.appliedAmount : -adjustment.appliedAmount
      )
    inspect('pending')
    if (adjustment.status === 'manual' && adjustment.manualAmount > 0)
      issue(
        'pending',
        'warning',
        'player-adjustment',
        adjustment.id,
        '已登记线下待追回差额，等待财务人工处理；不属于自动扣款错误。'
      )
  }
  const reviewsByOrder = new Set(tables.rewardReviews.map((row) => row.orderId))
  for (const order of tables.orders) {
    inspect('rewards')
    const credits = creditsByOrder.get(order.id) || []
    const positive = credits.filter((row) => money(row.amount) && row.amount > 0)
    const settled =
      order.status === 'completed' ||
      (order.status === 'canceled' && Boolean(order.compensationSettled))
    const reversal = state.statusCorrectionReversals?.[order.id]
    if (settled && reversal?.active)
      issue('rewards', 'error', 'order', order.id, '订单已结算但仍有生效中的状态冲正记录。')
    if (settled && money(order.reward)) {
      const allocations = new Map()
      if (order.reward > 0 && order.leaderId) {
        allocations.set(order.leaderId, order.teammateId ? order.reward / 2 : order.reward)
        if (order.teammateId) allocations.set(order.teammateId, order.reward / 2)
      }
      const recipients = new Set([...allocations.keys(), ...positive.map((row) => row.userId)])
      const mismatch = [...recipients].some(
        (userId) =>
          credits
            .filter((row) => row.userId === userId)
            .reduce((sum, row) => sum + (money(row.amount) ? row.amount : 0), 0) !==
          (allocations.get(userId) || 0)
      )
      if (mismatch)
        issue(
          'rewards',
          reviewsByOrder.has(order.id) ? 'warning' : 'error',
          'order',
          order.id,
          reviewsByOrder.has(order.id)
            ? '当前报酬与历史到账存在已登记的人工核对差额，请按处理记录确认。'
            : '已结算订单的基础到账人员或金额与结算结果不一致。'
        )
    } else if (
      positive.length &&
      !reversal?.active &&
      !(order.status === 'canceled' && order.compensationPending)
    )
      issue(
        'rewards',
        'error',
        'order',
        order.id,
        '未结算订单有基础报酬到账，且没有有效状态冲正记录。'
      )
    if (reversal?.active) {
      const adjustmentIds = Array.isArray(reversal.adjustmentIds) ? reversal.adjustmentIds : []
      const deductions = adjustmentIds.map((id) => maps.playerAdjustments.get(id))
      if (new Set(adjustmentIds).size !== adjustmentIds.length)
        issue('rewards', 'error', 'order', order.id, '生效中的状态冲正重复引用同一扣款流水。')
      const creditByUser = new Map(),
        deductionByUser = new Map()
      for (const row of positive)
        creditByUser.set(row.userId, (creditByUser.get(row.userId) || 0) + row.amount)
      for (const row of deductions)
        if (row && money(row.amount))
          deductionByUser.set(row.userId, (deductionByUser.get(row.userId) || 0) + row.amount)
      const recipients = new Set([...creditByUser.keys(), ...deductionByUser.keys()])
      if (
        deductions.some(
          (row) =>
            !row ||
            row.orderId !== order.id ||
            row.kind !== 'deduction' ||
            row.source !== 'status-correction'
        ) ||
        [...recipients].some(
          (userId) => (creditByUser.get(userId) || 0) !== (deductionByUser.get(userId) || 0)
        )
      )
        issue(
          'rewards',
          'error',
          'order',
          order.id,
          '生效中的状态冲正与原报酬到账人员或金额不一致。'
        )
    }
    inspect('pending')
    if (order.status === 'canceled' && order.compensationPending)
      issue(
        'pending',
        'warning',
        'order',
        order.id,
        '取消订单待财务确认最终补偿，当前预计成本尚未定稿。'
      )
    if (
      order.status === 'completed' &&
      (!order.commissionSnapshot ||
        order.commissionSnapshot.supportRate == null ||
        order.commissionSnapshot.operationsRate == null)
    )
      issue(
        'pending',
        'warning',
        'order',
        order.id,
        '完成订单的历史计提配置尚未补齐，工资及利润存在未定项。'
      )
  }
  const occupied = new Map(),
    paid = new Map()
  for (const withdrawal of tables.withdrawals) {
    inspect('wallets')
    link('wallets', 'withdrawal', withdrawal, 'userId', 'users', '提现打手')
    if (!money(withdrawal.amount) || withdrawal.amount === 0)
      issue('wallets', 'error', 'withdrawal', withdrawal.id, '提现金额不是有效正整数分。')
    if (!['pending', 'approved', 'paid', 'rejected'].includes(withdrawal.status))
      issue('wallets', 'error', 'withdrawal', withdrawal.id, '提现状态不合法。')
    const target = ['pending', 'approved'].includes(withdrawal.status)
      ? occupied
      : withdrawal.status === 'paid'
        ? paid
        : null
    if (target && money(withdrawal.amount))
      target.set(withdrawal.userId, (target.get(withdrawal.userId) || 0) + withdrawal.amount)
    if (withdrawal.status === 'paid' && (!timestamp(withdrawal.paidAt) || !withdrawal.receipt?.id))
      issue('wallets', 'error', 'withdrawal', withdrawal.id, '已发放提现缺少发放时间或凭证记录。')
    attachment('wallets', 'withdrawal', withdrawal, withdrawal.receipt, '提现凭证')
  }
  for (const userId of new Set([...balance.keys(), ...occupied.keys(), ...paid.keys()])) {
    inspect('wallets')
    if ((balance.get(userId) || 0) < (occupied.get(userId) || 0) + (paid.get(userId) || 0))
      issue(
        'wallets',
        'error',
        'wallet',
        userId,
        '已付款及在途提现超过有效报酬入账，钱包可用余额截零掩盖了实际缺口。'
      )
  }
  const refundReserved = new Map()
  for (const refund of tables.refunds) {
    inspect('orders')
    link('orders', 'refund', refund, 'orderId', 'orders', '退款订单')
    if (!money(refund.amount) || refund.amount === 0)
      issue('orders', 'error', 'refund', refund.id, '退款金额不是有效正整数分。')
    if (!['pending', 'paid', 'rejected'].includes(refund.status))
      issue('orders', 'error', 'refund', refund.id, '退款状态不合法。')
    if (['pending', 'paid'].includes(refund.status) && money(refund.amount))
      refundReserved.set(refund.orderId, (refundReserved.get(refund.orderId) || 0) + refund.amount)
    if (refund.manualRewardReview && !refund.manualResolution) {
      inspect('pending')
      issue(
        'pending',
        'warning',
        'refund',
        refund.id,
        '已提现后的退款差额等待人工登记处理，不自动追回。'
      )
    }
  }
  for (const [orderId, total] of refundReserved)
    if (total > (maps.orders.get(orderId)?.receivedAmount ?? 0))
      issue('orders', 'error', 'order', orderId, '已退款与在途申请合计超过原实收金额。')
  for (const review of tables.rewardReviews)
    if (!review.resolvedAt) {
      inspect('pending')
      issue(
        'pending',
        'warning',
        'reward-review',
        review.id,
        '旧报酬调整已登记人工核对，等待财务记录处理结果。'
      )
    }
  const referenceKeys = new Set()
  for (const reference of asRows(customerReferences)) {
    inspect('customerReferences')
    link(
      'customerReferences',
      'customer-reference',
      reference,
      'customerId',
      'customers',
      '编号客户'
    )
    link(
      'customerReferences',
      'customer-reference',
      reference,
      'platformId',
      'platforms',
      '编号来源'
    )
    link(
      'customerReferences',
      'customer-reference',
      reference,
      'shopId',
      'shops',
      '编号店铺',
      false
    )
    if (reference.shopId && maps.shops.get(reference.shopId)?.platformId !== reference.platformId)
      issue(
        'customerReferences',
        'error',
        'customer-reference',
        reference.id,
        '客户关联编号的店铺与来源不一致。'
      )
    if (typeof reference.externalOrderNo !== 'string' || !reference.externalOrderNo.trim())
      issue(
        'customerReferences',
        'error',
        'customer-reference',
        reference.id,
        '客户关联编号缺少有效平台单号。'
      )
    const key = JSON.stringify([
      reference.customerId,
      reference.platformId,
      reference.shopId || null,
      reference.externalOrderNo
    ])
    if (referenceKeys.has(key))
      issue(
        'customerReferences',
        'error',
        'customer-reference',
        reference.id,
        '同客户、来源、店铺和平台单号存在重复关联。'
      )
    referenceKeys.add(key)
  }
  const basePaid = new Map()
  for (const payroll of tables.payrolls) {
    inspect('payroll')
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(payroll.month || '') ||
      payroll.status !== 'paid' ||
      !timestamp(payroll.paidAt)
    )
      issue('payroll', 'error', 'payroll', payroll.id, '工资发放快照缺少有效核算月份、状态或时间。')
    if (
      !Array.isArray(payroll.lines) ||
      !payroll.lines.length ||
      asRows(payroll.lines).length !== payroll.lines.length
    )
      issue('payroll', 'error', 'payroll', payroll.id, '已发工资快照缺少可核对的员工行。')
    const lineUsers = new Set()
    for (const line of asRows(payroll.lines)) {
      inspect('payroll')
      link('payroll', 'payroll', { ...line, id: payroll.id }, 'userId', 'users', '工资员工')
      if (lineUsers.has(line.userId))
        issue('payroll', 'error', 'payroll', payroll.id, '同一工资快照包含重复员工发放行。')
      lineUsers.add(line.userId)
      if (
        !money(line.base) ||
        !money(line.commission) ||
        !money(line.deduction, { signed: true }) ||
        !money(line.total, { signed: true }) ||
        line.incomplete
      )
        issue('payroll', 'error', 'payroll', payroll.id, '已发工资行仍有未配置或非法金额。')
      else if (line.total !== line.base + line.commission - line.deduction)
        issue(
          'payroll',
          'error',
          'payroll',
          payroll.id,
          '工资快照合计与底薪、佣金、差额扣回不一致。'
        )
      if (money(line.base) && line.base > 0) {
        const key = JSON.stringify([payroll.month, line.userId])
        if (basePaid.has(key))
          issue('payroll', 'error', 'payroll', payroll.id, '同一员工同月在多个快照重复发放正底薪。')
        basePaid.set(key, payroll.id)
      }
    }
  }
  for (const [orderId, entry] of Object.entries(state.commissionPaid || {})) {
    inspect('payroll')
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issue('payroll', 'error', 'commission-paid', orderId, '已付佣金标记结构不合法。')
      continue
    }
    if (!maps.orders.has(orderId) || !maps.payrolls.has(entry.payrollId))
      issue(
        'payroll',
        'error',
        'commission-paid',
        orderId,
        '已付佣金标记关联的订单或工资快照不存在。'
      )
    for (const kind of ['support', 'operations'])
      if (!money(entry[`${kind}Amount`]))
        issue('payroll', 'error', 'commission-paid', orderId, '已付佣金标记金额不是有效整数分。')
  }
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(now))
  const scheduleVersions = new Set()
  for (const schedule of tables.workSchedules) {
    inspect('attendance')
    link('attendance', 'work-schedule', schedule, 'userId', 'users', '固定班次人员')
    const validClock = (value) =>
      typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    const version = JSON.stringify([schedule.userId, schedule.effectiveFrom])
    if (
      !date(schedule.effectiveFrom) ||
      typeof schedule.enabled !== 'boolean' ||
      (schedule.enabled
        ? !validClock(schedule.start) ||
          !validClock(schedule.end) ||
          schedule.start === schedule.end
        : schedule.start !== '' || schedule.end !== '')
    )
      issue(
        'attendance',
        'error',
        'work-schedule',
        schedule.id,
        '固定班次的生效日期、启停状态或上下班时间无效。'
      )
    if (scheduleVersions.has(version))
      issue(
        'attendance',
        'error',
        'work-schedule',
        schedule.id,
        '同一人员同一生效日期存在重复固定班次。'
      )
    scheduleVersions.add(version)
  }
  for (const attendance of tables.attendance) {
    inspect('attendance')
    link('attendance', 'attendance', attendance, 'userId', 'users', '考勤员工')
    if (
      !date(attendance.date) ||
      !['scheduled', 'present', 'normal', 'rest', 'leave', 'absent'].includes(attendance.status)
    )
      issue('attendance', 'error', 'attendance', attendance.id, '考勤日期或状态不合法。')
    if (
      !Number.isFinite(attendance.actualHours) ||
      attendance.actualHours < 0 ||
      attendance.actualHours > 24
    )
      issue('attendance', 'error', 'attendance', attendance.id, '实际工时不在有效范围内。')
    if (
      ['scheduled', 'rest', 'leave', 'absent'].includes(attendance.status) &&
      attendance.actualHours !== 0
    )
      issue('attendance', 'error', 'attendance', attendance.id, '未到岗或休息状态记录了实际工时。')
    if (
      attendance.date > today &&
      (attendance.actualHours > 0 || attendance.hoursRegistered || attendance.status === 'present')
    )
      issue(
        'attendance',
        'error',
        'attendance',
        attendance.id,
        '未来排班被登记为已到岗或实际工时。'
      )
  }
  for (const user of tables.users.filter((row) =>
    ['support', 'support_lead', 'operations', 'finance', 'hr', 'manager'].includes(row.role)
  )) {
    inspect('pending')
    const plans = tables.salaryPlans
      .filter((row) => row.userId === user.id && row.effectiveFrom <= today)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
    const plan = plans[0]
    if (
      !plan ||
      (plan.mode !== 'commission' && plan.base == null) ||
      (plan.mode !== 'fixed' &&
        ['support', 'support_lead'].includes(user.role) &&
        plan.rate == null) ||
      (plan.mode !== 'fixed' &&
        user.role === 'operations' &&
        tables.platforms.some(
          (row) =>
            row.id !== 'hall' && row.name !== '游戏大厅' && plan.platformRates?.[row.id] == null
        ))
    )
      issue(
        'pending',
        'warning',
        'user',
        user.id,
        '当前工资或提成配置未齐，需补齐后月结；不属于已发快照错误。'
      )
  }
  const fundTotals = new Map(),
    fundIds = new Map(),
    refundTotals = new Map()
  for (const row of asRows(fundTransactions)) {
    inspect('funds')
    fundIds.set(row.id, row)
    const key = JSON.stringify([row.type, row.accountId]),
      before = fundTotals.get(key) || 0
    if (
      !['customer', 'deposit'].includes(row.type) ||
      !(row.type === 'customer' ? maps.customers : maps.users).has(row.accountId)
    )
      issue(
        'funds',
        'error',
        'fund-transaction',
        row.id,
        '资金流水关联的账户档案不存在或类型不合法。'
      )
    const positive = ['recharge', 'deposit', 'order-refund'].includes(row.kind)
    if (
      !(
        row.type === 'customer'
          ? ['recharge', 'deduction', 'return', 'order-payment', 'order-refund']
          : ['deposit', 'penalty', 'return']
      ).includes(row.kind)
    )
      issue('funds', 'error', 'fund-transaction', row.id, '资金流水操作类型与账户类型不一致。')
    if (
      !money(row.amount) ||
      row.amount <= 0 ||
      !money(row.delta, { signed: true }) ||
      row.delta !== (positive ? row.amount : -row.amount)
    )
      issue('funds', 'error', 'fund-transaction', row.id, '资金流水金额、方向或整数分不一致。')
    if (
      !Number.isSafeInteger(row.balanceAfter) ||
      row.balanceAfter < 0 ||
      row.balanceAfter !== before + row.delta
    )
      issue('funds', 'error', 'fund-transaction', row.id, '资金流水余额快照与此前累计变动不一致。')
    if (
      row.type === 'deposit' &&
      ['penalty', 'return'].includes(row.kind) &&
      !['leave', 'absconded'].includes(row.exitType)
    )
      issue(
        'funds',
        'error',
        'fund-transaction',
        row.id,
        '押金退还或没收缺少退店/跑路场景，不能作为日常扣罚。'
      )
    if (money(row.delta, { signed: true })) fundTotals.set(key, before + row.delta)
    attachment('funds', 'fund-transaction', row, row.receipt, '资金凭证')
    if (row.kind === 'order-refund') {
      const originalOrder = maps.orders.get(row.orderId)
      if (
        !originalOrder ||
        originalOrder.paymentMethod !== 'balance' ||
        row.accountId !== (originalOrder.balanceCustomerId || originalOrder.customerId)
      )
        issue(
          'funds',
          'error',
          'fund-transaction',
          row.id,
          '储值退款流水没有回到订单原付款客户账户。'
        )
      refundTotals.set(row.orderId, (refundTotals.get(row.orderId) || 0) + row.amount)
    }
  }
  const accountKeys = new Set()
  for (const row of asRows(fundAccounts)) {
    inspect('funds')
    const key = JSON.stringify([row.type, row.accountId])
    accountKeys.add(key)
    if (
      !Number.isSafeInteger(row.balance) ||
      row.balance < 0 ||
      row.balance !== (fundTotals.get(key) || 0)
    )
      issue(
        'funds',
        'error',
        'fund-account',
        row.accountId,
        '当前储值或押金余额与独立流水累计不一致。'
      )
  }
  for (const key of fundTotals.keys())
    if (!accountKeys.has(key))
      issue(
        'funds',
        'error',
        'fund-account',
        JSON.parse(key)[1],
        '已有资金流水但对应账户余额记录不存在。'
      )
  for (const order of tables.orders.filter((row) => row.paymentMethod === 'balance')) {
    inspect('funds')
    const payment = fundIds.get(order.balanceTransactionId)
    if (
      !payment ||
      payment.type !== 'customer' ||
      payment.kind !== 'order-payment' ||
      payment.orderId !== order.id ||
      payment.accountId !== (order.balanceCustomerId || order.customerId) ||
      payment.amount !== order.receivedAmount ||
      payment.createdAt !== order.paidAt
    )
      issue(
        'funds',
        'error',
        'order',
        order.id,
        '储值付款订单与原客户扣款流水、实收或付款时间不一致。'
      )
    const expectedRefund = tables.refunds
      .filter((row) => row.orderId === order.id && row.status === 'paid')
      .reduce((total, row) => total + row.amount, 0)
    if ((refundTotals.get(order.id) || 0) !== expectedRefund)
      issue('funds', 'error', 'order', order.id, '储值订单已退款金额与原路回到账户的流水不一致。')
  }
  for (const refund of tables.refunds.filter(
    (row) => row.status === 'paid' && maps.orders.get(row.orderId)?.paymentMethod === 'balance'
  )) {
    const row = fundIds.get(refund.balanceTransactionId)
    if (
      !row ||
      row.kind !== 'order-refund' ||
      row.orderId !== refund.orderId ||
      row.amount !== refund.amount ||
      refund.refundMethod !== 'balance'
    )
      issue(
        'funds',
        'error',
        'refund',
        refund.id,
        '已付储值退款记录与原路回账流水指针或金额不一致。'
      )
  }
  const errorCount = checks.reduce((sum, row) => sum + row.errorCount, 0)
  const warningCount = checks.reduce((sum, row) => sum + row.warningCount, 0)
  const issues = [...errors, ...warnings].slice(0, MAX_ISSUES)
  return {
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    status: errorCount ? 'error' : warningCount ? 'warning' : 'ok',
    summary: {
      checkedRecords: checks.reduce((sum, row) => sum + row.checkedRecords, 0),
      errorCount,
      warningCount,
      issueCount,
      returnedIssues: issues.length,
      truncated: issueCount > issues.length
    },
    checks,
    issues,
    scopeNotes: [
      '检查只读取当前保存的业务记录，不修改数据、不迁移旧日志、不写入审计，也不自动修复。',
      '检查记录数是各项核对次数之和，同一业务记录可能参与不同项目；最多返回100条问题，错误优先，总数保留。',
      '指定待接单、未配置比例、未来正常排班、取消补偿待核对及已登记线下待追回均按原业务规则处理。',
      '工资快照保留原值，不按当前方案重新计算；提现凭证存在不代表已核实银行实际到账。'
    ]
  }
}
