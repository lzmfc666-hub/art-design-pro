/** 展示名称集中维护；角色默认权限由服务器提供。 */
export const permissionLabels: Record<string, string> = {
  'orders.view': '查看全部订单',
  'orders.create': '创建和派单',
  'orders.edit': '编辑实际订单',
  'finance.review': '财务验收',
  'finance.refunds': '处理退款',
  'finance.withdrawals': '提现发放',
  'finance.expenses': '费用记账',
  'salary.view': '查看本人工资',
  'salary.all': '查看全员工资',
  'salary.manage': '工资方案及月结',
  'profit.view': '查看工作室利润',
  'users.manage': '人员管理',
  'templates.manage': '订单模板维护',
  'settings.manage': '来源和等级配置',
  'attendance.manage': '排班考勤管理',
  'logs.view': '查看操作日志',
  'reports.export': '导出业务数据'
}
