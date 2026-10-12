import { computed } from 'vue'
import { useStudio, money } from './useStudio'
import type { Order } from '@/types/studio'

export interface BusinessTodoTarget {
  path: string
  query?: Record<string, string>
}

export interface BusinessTodoItem extends BusinessTodoTarget {
  id: string
  key: string
  title: string
  description: string
  createdAt: string
  icon: string
  type: 'primary' | 'warning' | 'danger' | 'success' | 'info'
}

export interface BusinessTodo extends BusinessTodoTarget {
  key: string
  title: string
  count: number
  description: string
  icon: string
}

/** 工作台与顶栏共用待办；只读取服务端按权限返回的业务记录。 */
export function useBusinessTodo() {
  const { data, user, can } = useStudio()
  const settlement = (tab: string): BusinessTodoTarget => ({
    path: '/finance/settlement',
    query: { tab }
  })
  const orderTarget = (order: Order, tab = 'review'): BusinessTodoTarget =>
    can('orders.view') ? { path: '/orders/list', query: { id: order.id } } : settlement(tab)

  const groups = computed(() => {
    if (!user.value || user.value.role === 'player' || !data.value) return []
    const state = data.value
    const result: (BusinessTodo & { items: BusinessTodoItem[] })[] = []
    function add(
      key: string,
      title: string,
      description: string,
      icon: string,
      target: BusinessTodoTarget,
      items: Omit<BusinessTodoItem, 'key' | 'icon'>[]
    ) {
      if (items.length)
        result.push({
          key,
          title,
          description,
          icon,
          ...target,
          count: items.length,
          items: items.map((item) => ({ ...item, key, icon }))
        })
    }

    if (can('orders.view') && can('orders.edit')) {
      add(
        'payment',
        '待确认收款',
        '核对实际到账与收款凭证',
        'ri:money-cny-circle-line',
        { path: '/orders/list', query: { payment: 'unpaid' } },
        state.orders
          .filter((order) => !order.receivedAmount && order.status !== 'canceled')
          .map((order) => ({
            id: `payment:${order.id}`,
            title: `${order.orderNo} · 待确认收款`,
            description: `${order.title}，订单金额 ${money(order.amount)}`,
            createdAt: order.createdAt,
            type: 'warning',
            ...orderTarget(order)
          }))
      )
    }
    if (can('finance.review')) {
      add(
        'review',
        '待验收订单',
        '核对完成材料并验收或退回',
        'ri:checkbox-circle-line',
        settlement('review'),
        state.orders
          .filter((order) => order.status === 'review')
          .map((order) => ({
            id: `review:${order.id}`,
            title: `${order.orderNo} · 待验收`,
            description: order.title,
            createdAt: order.submissions.at(-1)?.submittedAt || order.createdAt,
            type: 'primary',
            ...orderTarget(order)
          }))
      )
      add(
        'compensation',
        '取消报酬待确认',
        '财务确认取消订单的实际打手补偿',
        'ri:close-circle-line',
        settlement('review'),
        state.orders
          .filter(
            (order) =>
              order.status === 'canceled' && order.compensationPending && !order.compensationSettled
          )
          .map((order) => ({
            id: `compensation:${order.id}`,
            title: `${order.orderNo} · 取消补偿待确认`,
            description: order.cancelReason || order.title,
            createdAt: order.canceledAt || order.createdAt,
            type: 'warning',
            ...orderTarget(order)
          }))
      )
    }
    if (can('finance.refunds')) {
      const orderNo = (orderId: string) =>
        state.orders.find((order) => order.id === orderId)?.orderNo || '订单退款'
      add(
        'refunds',
        '待审核退款',
        '核对客户退款申请并登记实际退款',
        'ri:refund-2-line',
        settlement('refunds'),
        state.refunds
          .filter((refund) => refund.status === 'pending')
          .map((refund) => ({
            id: `refunds:${refund.id}`,
            title: `${orderNo(refund.orderId)} · 退款待审核`,
            description: `${money(refund.amount)}，${refund.reason}`,
            createdAt: refund.createdAt,
            type: 'warning',
            ...settlement('refunds')
          }))
      )
      add(
        'refund-differences',
        '退款后报酬差额待登记',
        '打手已有提现，财务人工核对并登记处理结果',
        'ri:exchange-dollar-line',
        settlement('refunds'),
        state.refunds
          .filter(
            (refund) =>
              refund.status === 'paid' && refund.manualRewardReview && !refund.manualResolution
          )
          .map((refund) => ({
            id: `refund-differences:${refund.id}`,
            title: `${orderNo(refund.orderId)} · 报酬差额待人工处理`,
            description: `已退款 ${money(refund.amount)}，请核对打手报酬差额`,
            createdAt: refund.processedAt || refund.createdAt,
            type: 'danger',
            ...settlement('refunds')
          }))
      )
    }
    if (can('finance.withdrawals')) {
      for (const status of ['pending', 'approved'] as const) {
        const pending = status === 'pending'
        add(
          pending ? 'withdrawal-review' : 'withdrawal-payment',
          pending ? '提现待审核' : '提现待转账',
          pending ? '核对打手提现申请' : '人工转账后登记凭证',
          'ri:bank-card-line',
          settlement('withdrawals'),
          state.withdrawals
            .filter((withdrawal) => withdrawal.status === status)
            .map((withdrawal) => ({
              id: `${pending ? 'withdrawal-review' : 'withdrawal-payment'}:${withdrawal.id}`,
              title: `${state.users.find((staff) => staff.id === withdrawal.userId)?.name || '打手'} · ${pending ? '提现待审核' : '提现待转账'}`,
              description: `申请金额 ${money(withdrawal.amount)}`,
              createdAt: withdrawal.processedAt || withdrawal.createdAt,
              type: pending ? 'warning' : 'primary',
              ...settlement('withdrawals')
            }))
        )
      }
    }
    return result
  })

  const todos = computed<BusinessTodo[]>(() =>
    groups.value.map(({ key, title, count, description, icon, path, query }) => ({
      key,
      title,
      count,
      description,
      icon,
      path,
      query
    }))
  )
  const items = computed<BusinessTodoItem[]>(() =>
    groups.value
      .flatMap((group) => group.items)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const count = computed(() => items.value.length)
  return { todos, items, count }
}
