<template>
  <div v-if="data" class="overview-page">
    <div class="page-heading"
      ><div
        ><h2>{{ greeting }}，{{ user?.name }} <span class="welcome-label">欢迎回到工作台</span></h2
        ><p>每一笔订单，每一份付出，都有清晰的记录。</p></div
      ><div class="overview-actions"
        ><ElDatePicker
          v-model="month"
          type="month"
          value-format="YYYY-MM"
          :clearable="false"
          @change="changeMonth"
        /><ElButton
          v-if="can('orders.create')"
          type="primary"
          :icon="Plus"
          @click="router.push('/dispatch')"
          >快捷下单</ElButton
        ></div
      ></div
    >
    <div class="metric-grid">
      <div class="metric-card"
        ><div class="metric-label">{{ can('profit.view') ? '本月净收入' : '本人完成净业绩' }}</div
        ><span class="metric-icon"
          ><ElIcon><Wallet /></ElIcon></span
        ><div class="metric-value">{{ money(can('profit.view') ? totals.net : personalNet) }}</div
        ><div class="metric-foot">{{
          can('profit.view') ? '按原付款日归属 · 已扣实际退款' : '仅统计本人符合条件的已完成订单'
        }}</div></div
      >
      <div class="metric-card"
        ><div class="metric-label">本月订单</div
        ><span class="metric-icon blue"
          ><ElIcon><Tickets /></ElIcon></span
        ><div class="metric-value"
          >{{ monthOrders.length }}
          <small style="font-size: 12px; font-weight: 400; color: #a3aabc">单</small></div
        ><div class="metric-foot"
          >已完成 {{ monthOrders.filter((o) => o.status === 'completed').length }} 单 ·
          按创建日期</div
        ></div
      >
      <div class="metric-card"
        ><div class="metric-label">{{ can('profit.view') ? '打手报酬成本' : '正在履约' }}</div
        ><span class="metric-icon amber"
          ><ElIcon><User /></ElIcon></span
        ><div class="metric-value">{{
          can('profit.view')
            ? money(totals.reward)
            : data.orders.filter((o) => o.status === 'active').length + ' 单'
        }}</div
        ><div class="metric-foot">{{
          can('profit.view')
            ? `含约定 / 预计成本 ${money(totals.estimatedReward)}`
            : '负责人执行中，等待提交完成材料'
        }}</div></div
      >
      <div class="metric-card"
        ><div class="metric-label">{{ can('profit.view') ? '本月经营利润' : '待财务验收' }}</div
        ><span class="metric-icon green"
          ><ElIcon><TrendCharts /></ElIcon></span
        ><div
          class="metric-value"
          :style="{
            fontSize: can('profit.view') && data.reports.monthlyProfit == null ? '21px' : undefined
          }"
          >{{
            can('profit.view')
              ? data.reports.monthlyProfit == null
                ? '统计待完善'
                : money(data.reports.monthlyProfit)
              : reviewCount + ' 单'
          }}</div
        ><div class="metric-foot">{{
          can('profit.view')
            ? '月报扣除底薪 · 配置缺失时不按零计算'
            : '验收通过后形成打手可提现报酬'
        }}</div></div
      >
    </div>

    <div v-if="can('profit.view')" class="split-grid">
      <section class="panel"
        ><div class="panel-heading"
          ><div><h3>收入与利润趋势</h3><p>客户付款日口径，后续退款及成本调整同步回改</p></div
          ><div class="chart-legend"
            ><span><i></i>净收入</span><span><i></i>日利润</span></div
          ></div
        >
        <div class="chart-wrap"
          ><svg
            viewBox="0 0 680 210"
            preserveAspectRatio="none"
            role="img"
            aria-label="当前月份每日净收入与利润趋势"
          >
            <defs>
              <linearGradient id="incomeFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="#9d8af5" stop-opacity="0.22" />
                <stop offset="100%" stop-color="#9d8af5" stop-opacity="0.01" />
              </linearGradient>
            </defs>
            <g v-for="(tick, i) in ticks" :key="i">
              <line
                x1="46"
                :y1="18 + i * 42"
                x2="670"
                :y2="18 + i * 42"
                stroke="#eef0f7"
                stroke-dasharray="4 5"
              />
              <text x="0" :y="22 + i * 42" class="chart-axis-label">{{ tick }}</text>
            </g>
            <path :d="areaPath" fill="url(#incomeFill)" />
            <polyline
              :points="incomePoints"
              fill="none"
              stroke="#8e7bf0"
              stroke-width="2.5"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <polyline
              v-if="!days.some((d) => d.incomplete)"
              :points="profitPoints"
              fill="none"
              stroke="#69bfad"
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
            /></svg></div
        ><div class="chart-labels"
          ><span v-for="label in chartLabels" :key="label">{{ label }}</span></div
        ><p class="report-note"
          >日报不扣底薪；包含尚未验收的约定打手成本。订单完成后补计提成，历史利润随之更新。{{
            days.some((d) => d.incomplete) ? '当前有工资 / 提成配置未完整，利润曲线暂不展示。' : ''
          }}</p
        >
      </section>
      <section class="panel"
        ><div class="panel-heading"
          ><div><h3>来源渠道</h3><p>本月收款订单的渠道构成</p></div
          ><ElTag type="info" effect="plain" size="small">净收入</ElTag></div
        ><div v-if="!data.reports.channels.length" class="empty-state">本月暂无渠道收入</div
        ><div
          v-for="(channel, index) in data.reports.channels.filter((c) => !c.shopId)"
          :key="channel.platformId"
          class="channel-row"
          ><div class="channel-row-head"
            ><span class="channel-name"
              ><span
                class="channel-symbol"
                :style="{
                  background: channelColors[index % 3] + '18',
                  color: channelColors[index % 3]
                }"
                >{{ channel.name.slice(0, 1) }}</span
              >{{ channel.name }}</span
            ><b style="font-weight: 500">{{ money(channel.net) }}</b></div
          ><ElProgress
            :percentage="Math.round((channel.net / Math.max(totals.net, 1)) * 100)"
            :show-text="false"
            :stroke-width="5"
            :color="channelColors[index % 3]" /></div
        ><div class="channel-total"
          ><span>净收入合计</span><b>{{ money(totals.net) }}</b></div
        ></section
      >
    </div>

    <section class="panel"
      ><div class="panel-heading"
        ><div><h3>待处理事项</h3><p>及时跟进，让每一笔订单顺畅流转</p></div
        ><ElButton text type="primary" @click="router.push('/orders')"
          >查看订单 <ElIcon style="margin-left: 4px"><ArrowRight /></ElIcon></ElButton></div
      ><div class="todo-grid"
        ><button class="todo-item" @click="router.push('/orders?status=pending')"
          ><span class="todo-icon"><Clock /></span
          ><span
            ><b>{{ pendingCount }}</b
            ><small>待接单</small></span
          ><ElIcon><ArrowRight /></ElIcon></button
        ><button class="todo-item" @click="router.push('/orders?status=active')"
          ><span class="todo-icon" style="color: #739fe5; background: #eaf3ff"><VideoPlay /></span
          ><span
            ><b>{{ activeCount }}</b
            ><small>执行中</small></span
          ><ElIcon><ArrowRight /></ElIcon></button
        ><button class="todo-item" @click="router.push('/orders?status=review')"
          ><span class="todo-icon" style="color: #dca368; background: #fff3e7"
            ><DocumentChecked /></span
          ><span
            ><b>{{ reviewCount }}</b
            ><small>待验收</small></span
          ><ElIcon><ArrowRight /></ElIcon></button
        ><button
          v-if="can('finance.withdrawals')"
          class="todo-item"
          @click="router.push('/finance?tab=withdrawals')"
          ><span class="todo-icon" style="color: #65b698; background: #eaf8f2"><Wallet /></span
          ><span
            ><b>{{
              data.withdrawals.filter((w) => ['pending', 'approved'].includes(w.status)).length
            }}</b
            ><small>待处理提现</small></span
          ><ElIcon><ArrowRight /></ElIcon></button
        ><button v-else class="todo-item" @click="router.push('/orders')"
          ><span class="todo-icon" style="color: #65b698; background: #eaf8f2"><CircleCheck /></span
          ><span
            ><b>{{ data.orders.filter((o) => o.status === 'completed').length }}</b
            ><small>已完成订单</small></span
          ><ElIcon><ArrowRight /></ElIcon></button></div
    ></section>

    <div class="split-grid"
      ><section class="panel"
        ><div class="panel-heading"
          ><div><h3>最近订单</h3><p>跟进最新的业务动态</p></div
          ><ElButton text type="primary" @click="router.push('/orders')"
            >全部订单 <ElIcon style="margin-left: 4px"><ArrowRight /></ElIcon></ElButton></div
        ><ElTable
          :data="latestOrders"
          @row-click="openOrder"
          style="cursor: pointer"
          empty-text="暂无订单，开始创建第一笔业务"
          ><ElTableColumn label="订单 / 项目" min-width="170"
            ><template #default="{ row }"
              ><div class="table-primary">{{ row.title }}</div
              ><div class="table-secondary">{{ row.orderNo }}</div></template
            ></ElTableColumn
          ><ElTableColumn label="客户" min-width="90"
            ><template #default="{ row }">{{
              data.customers.find((c) => c.id === row.customerId)?.name || '—'
            }}</template></ElTableColumn
          ><ElTableColumn label="金额" min-width="95"
            ><template #default="{ row }">{{ money(row.amount) }}</template></ElTableColumn
          ><ElTableColumn label="状态" min-width="90"
            ><template #default="{ row }"
              ><ElTag :type="tagType(row.status)" effect="light" size="small">{{
                statusLabels[row.status as OrderStatus]
              }}</ElTag></template
            ></ElTableColumn
          ></ElTable
        ></section
      >
      <section class="panel"
        ><div class="panel-heading"
          ><div
            ><h3>{{ can('profit.view') ? '团队完成业绩' : '我的完成业绩' }}</h3
            ><p>已收款且财务验收通过 · 按完成月</p></div
          ></div
        ><div v-if="!data.reports.performance.length" class="empty-state">暂无已完成业绩</div
        ><div class="performance-list"
          ><div
            v-for="(person, index) in [...data.reports.performance]
              .sort((a, b) => b.net - a.net)
              .slice(0, 5)"
            :key="person.userId"
            class="performance-row"
            ><span class="rank" :class="{ first: index === 0 }">{{
              String(index + 1).padStart(2, '0')
            }}</span
            ><span
              class="user-avatar"
              :style="{
                background: channelColors[index % 3] + '15',
                color: channelColors[index % 3]
              }"
              >{{ person.name.slice(0, 1) }}</span
            ><span class="performance-name"
              >{{ person.name }}<small>完成 {{ person.completed }} 单</small></span
            ><b>{{ money(person.net) }}</b></div
          ></div
        ><p class="report-note" style="margin-top: 24px"
          >业绩与工资查看范围分别控制，编辑订单不改变原创建人的归属。</p
        ></section
      ></div
    >
  </div>
</template>

<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import {
    ArrowRight,
    CircleCheck,
    Clock,
    DocumentChecked,
    Plus,
    Tickets,
    TrendCharts,
    User,
    VideoPlay,
    Wallet
  } from '@element-plus/icons-vue'
  import type { DayReport, Order, OrderStatus } from '@/types/studio'
  import { useStudio, money, statusLabels } from '../useStudio'
  const { data, user, can, selectedMonth, refresh } = useStudio()
  const router = useRouter()
  const month = ref(selectedMonth.value)
  const channelColors = ['#9680e9', '#66b9a7', '#78a2e4']
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hour12: false
    }).format(new Date())
  )
  const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  const days = computed(() => data.value?.reports.days || [])
  const totals = computed(() =>
    days.value.reduce(
      (sum, day) => ({
        net: sum.net + day.net,
        reward: sum.reward + day.reward,
        estimatedReward: sum.estimatedReward + day.estimatedReward
      }),
      { net: 0, reward: 0, estimatedReward: 0 }
    )
  )
  const personalNet = computed(
    () => data.value?.reports.performance.find((p) => p.userId === user.value?.id)?.net || 0
  )
  const monthOrders = computed(
    () =>
      data.value?.orders.filter((order) =>
        new Date(order.createdAt)
          .toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
          .startsWith(month.value)
      ) || []
  )
  const latestOrders = computed(() =>
    [...(data.value?.orders || [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
  )
  const pendingCount = computed(
    () => data.value?.orders.filter((o) => o.status === 'pending').length || 0
  )
  const activeCount = computed(
    () => data.value?.orders.filter((o) => o.status === 'active').length || 0
  )
  const reviewCount = computed(
    () => data.value?.orders.filter((o) => o.status === 'review').length || 0
  )
  const maxValue = computed(() =>
    Math.max(10000, ...days.value.flatMap((day) => [day.net, day.profit || 0]))
  )
  const minValue = computed(() => Math.min(0, ...days.value.map((day) => day.profit || 0)))
  const ticks = computed(() =>
    Array.from({ length: 5 }, (_, i) =>
      ((maxValue.value - ((maxValue.value - minValue.value) * i) / 4) / 100).toLocaleString(
        'zh-CN',
        { maximumFractionDigits: 0 }
      )
    )
  )
  function points(key: 'net' | 'profit') {
    const records: DayReport[] = days.value.length
      ? days.value
      : [{ net: 0, profit: 0 } as DayReport]
    return records
      .map(
        (day, i) =>
          `${46 + (i * 624) / Math.max(1, records.length - 1)},${18 + ((maxValue.value - (day[key] || 0)) * 168) / Math.max(1, maxValue.value - minValue.value)}`
      )
      .join(' ')
  }
  const incomePoints = computed(() => points('net')),
    profitPoints = computed(() => points('profit'))
  const areaPath = computed(
    () =>
      `M46,186 L${incomePoints.value.split(' ').join(' L')} L${days.value.length > 1 ? 670 : 46},186 Z`
  )
  const chartLabels = computed(() =>
    days.value
      .filter(
        (_, i) =>
          i === 0 ||
          i === days.value.length - 1 ||
          i % Math.max(1, Math.floor(days.value.length / 5)) === 0
      )
      .map((d) => d.date.slice(5))
  )
  function tagType(status: OrderStatus) {
    return (
      {
        pending: 'info',
        active: 'primary',
        review: 'warning',
        completed: 'success',
        canceled: 'danger'
      } as const
    )[status]
  }
  function openOrder(order: Order) {
    void router.push(`/orders?id=${order.id}`)
  }
  async function changeMonth(value: string) {
    if (value)
      try {
        await refresh(value)
      } catch {
        /* shell显示错误 */
      }
  }
</script>
