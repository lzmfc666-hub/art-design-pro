<template>
  <div class="overview-page">
    <section
      class="overview-hero"
      :class="{ 'is-custom-hero': appearance.hero.mode !== 'default' }"
      :style="heroStyle"
    >
      <img
        v-if="appearance.hero.showDecoration"
        :src="glassArt"
        class="hero-art"
        alt=""
        aria-hidden="true"
      />
      <div class="hero-topline">
        <div class="hero-greeting"
          ><h2>{{ greeting }}，{{ roleName }} <span class="wave">👋</span></h2
          ><p>数据驱动工作室运营，让订单与财务业务更简单</p></div
        >
        <div class="hero-side"
          ><span class="hero-status"
            ><i :class="{ 'is-loading': overview.loading.value }" />{{
              overview.loading.value
                ? '正在读取最新数据'
                : overview.error.value
                  ? '数据读取失败'
                  : '数据以当前加载结果为准'
            }}</span
          ><ElButton
            v-if="can('templates.manage') || can('settings.manage')"
            type="primary"
            class="hero-config"
            @click="$router.push('/system/business')"
            ><ArtSvgIcon icon="ri:gamepad-line" class="mr-2" />业务配置</ElButton
          ></div
        >
      </div>
      <div class="hero-chips"
        ><span><i />经营工作台</span
        ><span
          v-if="data?.demo"
          class="hero-demo"
          title="此数据库用于验证业务流程，正式启用时请建立正式账号和业务配置。"
          >开发数据</span
        ><span><ArtSvgIcon icon="ri:calendar-2-line" />{{ dateLabel }}</span
        ><span><ArtSvgIcon icon="ri:time-line" />{{ clockLabel }}</span></div
      >
      <div class="hero-shortcuts"
        ><button
          v-for="item in shortcuts"
          :key="item.path"
          :class="`shortcut-${item.color}`"
          @click="$router.push(item.path)"
          ><span class="shortcut-icon"><ArtSvgIcon :icon="item.icon" /></span
          ><span class="min-w-0"
            ><strong>{{ item.label }}</strong
            ><small>{{ item.description }}</small></span
          ><ArtSvgIcon icon="ri:arrow-right-up-line" class="shortcut-arrow" /></button
      ></div>
      <p class="hero-signature">更清晰的经营数据，更高效的工作协作</p>
    </section>

    <section v-if="user?.role !== 'player'" class="range-toolbar">
      <div><h3>时间筛选</h3><p>查看对应时间范围内的数据，比较紧邻的上一时段</p></div>
      <div class="range-controls"
        ><div class="range-presets"
          ><ElButton
            v-for="preset in presets"
            :key="preset.days"
            :type="activePreset === preset.days ? 'primary' : 'default'"
            :plain="activePreset !== preset.days"
            :disabled="overview.loading.value"
            @click="choosePreset(preset.days)"
            >{{ preset.label }}</ElButton
          ></div
        ><ElButton v-if="can('reports.export')" plain class="overview-export" @click="exportRange"
          ><ArtSvgIcon icon="ri:file-excel-2-line" class="mr-1" />导出明细</ElButton
        ><ElDatePicker
          v-model="pickedRange"
          type="daterange"
          popper-class="overview-range-picker"
          value-format="YYYY-MM-DD"
          :clearable="false"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          range-separator="至"
          :disabled-date="disabledDate"
          @change="changeRange" /><ElTooltip content="重新读取业务数据"
          ><ElButton circle :loading="overview.loading.value" aria-label="刷新概览" @click="reload"
            ><ArtSvgIcon icon="ri:refresh-line" /></ElButton></ElTooltip
      ></div>
    </section>
    <ElAlert
      v-if="overview.error.value"
      :title="overview.error.value"
      type="error"
      :closable="false"
      show-icon
      class="mb-5"
      ><ElButton size="small" @click="overview.refresh">重试</ElButton></ElAlert
    >
    <ElResult
      v-if="user?.role === 'player'"
      icon="info"
      title="打手端将独立上线"
      sub-title="请使用分配给你的打手端入口。"
    />
    <template v-else>
      <div class="section-heading"
        ><h3>工作室经营数据</h3
        ><span
          >{{ overview.report.value?.range.start || overview.range.value[0] }} 至
          {{ overview.report.value?.range.end || overview.range.value[1] }} ·
          卡片下方注明数据口径</span
        ><ElButton
          v-if="can('profit.view')"
          link
          type="primary"
          @click="$router.push('/dashboard/analysis')"
          >经营报表<ArtSvgIcon icon="ri:arrow-right-line" class="ml-1" /></ElButton
      ></div>
      <OverviewMetrics
        :report="overview.ready.value ? overview.report.value : null"
        :loading="overview.loading.value"
      />
      <ElCollapse class="scope-collapse mb-5" v-if="overview.report.value?.scopeNotes.length"
        ><ElCollapseItem title="查看统计口径与数据范围" name="scope"
          ><p v-for="note in overview.report.value.scopeNotes" :key="note">{{ note }}</p
          ><p
            >人员与客户旧档案没有建档日期时，新增数量保留“无法追溯”；当前余额不按历史时间回算。</p
          ></ElCollapseItem
        ></ElCollapse
      >
      <div class="section-heading"
        ><h3>经营趋势与业务进度</h3><span>趋势按所选日期，订单进度与待办展示当前业务状态</span></div
      >
      <ElRow :gutter="20"
        ><ElCol :xs="24" :lg="can('orders.view') ? 14 : 24"
          ><OverviewTrend
            :report="overview.report.value"
            :loading="overview.loading.value" /></ElCol
        ><ElCol v-if="can('orders.view')" :xs="24" :lg="10"><ActiveUser /></ElCol
      ></ElRow>
      <ElRow :gutter="20"
        ><ElCol v-if="can('orders.view')" :xs="24" :lg="12"><NewUser /></ElCol
        ><ElCol :xs="24" :md="12" :lg="can('orders.view') ? 6 : 12"><Dynamic /></ElCol
        ><ElCol :xs="24" :md="12" :lg="can('orders.view') ? 6 : 12"><TodoList /></ElCol
      ></ElRow>
      <AboutProject />
    </template>
  </div>
</template>

<script setup lang="ts">
  import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { useAppearance } from '@/hooks/business/useAppearance'
  import { useStudio, roleLabels } from '@/hooks/business/useStudio'
  import { useOverviewReport, dateInShanghai, shiftDate } from '@/hooks/business/useOverviewReport'
  import glassArt from '@imgs/dashboard/overview-glass.svg'
  import OverviewMetrics from './modules/overview-metrics.vue'
  import OverviewTrend from './modules/overview-trend.vue'
  import ActiveUser from './modules/active-user.vue'
  import NewUser from './modules/new-user.vue'
  import Dynamic from './modules/dynamic-stats.vue'
  import TodoList from './modules/todo-list.vue'
  import AboutProject from './modules/about-project.vue'

  defineOptions({ name: 'Console' })
  const { data, user, can, refresh } = useStudio()
  const overview = useOverviewReport()
  const pickedRange = computed({
    get: () => overview.range.value,
    set: (value: unknown) => {
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((item) => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item))
      )
        overview.range.value = [value[0], value[1]]
    }
  })
  const router = useRouter()
  const { config: appearance, icon: appearanceIcon } = useAppearance()
  const heroStyle = computed(() => {
    const hero = appearance.value.hero
    if (hero.mode === 'default') return {}
    if (hero.mode === 'color') {
      const red = parseInt(hero.color.slice(1, 3), 16),
        green = parseInt(hero.color.slice(3, 5), 16),
        blue = parseInt(hero.color.slice(5, 7), 16)
      const light = red * 0.299 + green * 0.587 + blue * 0.114 > 175
      return {
        background: hero.color,
        '--hero-text': light ? '#183654' : '#ffffff',
        '--hero-muted': light ? '#355978' : '#e7f0ff'
      }
    }
    const url = hero.image?.url
    if (!url || !/^\/api\/studio\/uploads\/[A-Za-z0-9_-]+$/.test(url)) return {}
    const shade = `rgba(8,31,69,${Math.max(0, Math.min(70, hero.overlay)) / 100})`
    return {
      backgroundImage: `linear-gradient(${shade},${shade}),url("${url}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      '--hero-text': '#ffffff',
      '--hero-muted': '#e7f0ff'
    }
  })
  const now = ref(new Date())
  let clockTimer: ReturnType<typeof setInterval> | undefined
  let alive = true
  const dateLabel = computed(() =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    }).format(now.value)
  )
  const clockLabel = computed(() =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now.value)
  )
  const greeting = computed(() => {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        hourCycle: 'h23'
      }).format(now.value)
    )
    return hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  })
  const roleName = computed(() => (user.value ? roleLabels[user.value.role] : '欢迎回来'))
  const shortcuts = computed(() =>
    [
      {
        label: '快速下单',
        description: '选择项目，创建订单',
        icon: appearanceIcon('createOrder', 'ri:add-box-line'),
        path: '/orders/create',
        color: 'blue',
        show: can('orders.create')
      },
      {
        label: '派单管理',
        description: '查看订单与接单情况',
        icon: appearanceIcon('orderList', 'ri:user-settings-line'),
        path: '/orders/list',
        color: 'purple',
        show: can('orders.view')
      },
      {
        label: '员工管理',
        description: '管理员工账号与授权',
        icon: appearanceIcon('users', 'ri:group-line'),
        path: '/personnel/employees',
        color: 'green',
        show: can('users.manage')
      },
      {
        label: '财务结算',
        description: '查看经营收支与结算',
        icon: appearanceIcon('finance', 'ri:money-cny-box-line'),
        path: '/finance/settlement',
        color: 'orange',
        show: ['finance.review', 'finance.refunds', 'finance.withdrawals', 'finance.expenses'].some(
          can
        )
      },
      {
        label: '工资核算',
        description: '查看工资、提成与发放',
        icon: appearanceIcon('salary', 'ri:wallet-3-line'),
        path: '/finance/salary',
        color: 'orange',
        show: ['salary.view', 'salary.all', 'salary.manage'].some(can)
      },
      {
        label: '排班考勤',
        description: '登记班次与实际工时',
        icon: appearanceIcon('attendance', 'ri:calendar-check-line'),
        path: '/personnel/attendance',
        color: 'green',
        show: can('attendance.manage')
      },
      {
        label: '数据导出',
        description: '自选模块与报表字段',
        icon: appearanceIcon('export', 'ri:file-excel-2-line'),
        path: '/reports/export',
        color: 'blue',
        show: can('reports.export')
      }
    ]
      .filter((item) => item.show)
      .slice(0, 4)
  )
  const presets = [
    { days: 1, label: '今天' },
    { days: 7, label: '近7天' },
    { days: 30, label: '近30天' }
  ]
  const activePreset = computed(() => {
    const today = dateInShanghai(now.value)
    return (
      presets.find(
        (item) =>
          overview.range.value[1] === today &&
          overview.range.value[0] === shiftDate(today, -item.days + 1)
      )?.days || 0
    )
  })
  const disabledDate = (date: Date) => dateInShanghai(date) > dateInShanghai(now.value)
  function choosePreset(days: number) {
    const end = dateInShanghai(now.value)
    overview.range.value = [shiftDate(end, -days + 1), end]
    void overview.refresh()
  }
  function changeRange() {
    if (overview.range.value?.length === 2) void overview.refresh()
  }
  function exportRange() {
    if (!can('reports.export')) return
    const modules = [
      can('orders.view') ? 'orders' : '',
      can('profit.view') || can('finance.expenses') ? 'expenses' : '',
      can('attendance.manage') ? 'attendance' : ''
    ].filter(Boolean)
    void router.push({
      path: '/reports/export',
      query: {
        modules: modules.length ? modules.join(',') : 'profile',
        start: overview.range.value[0],
        end: overview.range.value[1],
        orderDateKey: 'paidAt'
      }
    })
  }
  async function reload() {
    await refresh().catch(() => {})
    if (alive && user.value && user.value.role !== 'player') await overview.refresh()
  }
  watch(
    () => data.value?.permissions.join('|'),
    (value, previous) => {
      if (value !== previous && previous !== undefined) {
        overview.clear()
        if (alive && value !== undefined && user.value && user.value.role !== 'player')
          void overview.refresh()
      }
    }
  )
  watch(
    user,
    (value) => {
      if (!value) overview.clear()
    },
    { flush: 'sync' }
  )
  onMounted(() => {
    void reload()
    clockTimer = setInterval(() => {
      now.value = new Date()
    }, 30000)
  })
  onUnmounted(() => {
    alive = false
    if (clockTimer) clearInterval(clockTimer)
    overview.clear()
  })
</script>

<style lang="scss" scoped>
  .overview-hero.is-custom-hero {
    color: var(--hero-text);
  }

  .overview-hero.is-custom-hero::before {
    display: none;
  }

  .is-custom-hero .hero-greeting p {
    color: var(--hero-muted);
  }

  .is-custom-hero .hero-status {
    color: var(--hero-muted);
  }

  .overview-hero {
    position: relative;
    min-height: 276px;
    padding: 28px;
    margin-bottom: 20px;
    overflow: hidden;
    color: #fff;
    background: linear-gradient(112deg, #80b7ff 0%, #83b5ff 39%, #b9d6ff 75%, #c8defe 100%);
    border-radius: 20px;
    box-shadow: 0 10px 28px rgb(52 120 246 / 9%);
  }

  .overview-hero::before {
    position: absolute;
    inset: 0;
    pointer-events: none;
    content: '';
    background: radial-gradient(ellipse at 61% 0%, rgb(32 100 240 / 55%), transparent 54%);
  }

  .hero-art {
    position: absolute;
    top: -26px;
    right: 10%;
    width: 620px;
    height: 310px;
    pointer-events: none;
    object-fit: contain;
    opacity: 0.94;
  }

  .hero-topline {
    position: relative;
    z-index: 1;
    display: flex;
    gap: 20px;
    align-items: flex-start;
    justify-content: space-between;
  }

  .hero-greeting h2 {
    margin: 8px 0 10px;
    font-size: 34px;
    font-weight: 700;
    line-height: 1.3;
    text-shadow: 0 3px 10px rgb(19 87 205 / 12%);
    letter-spacing: 1px;
  }

  .hero-greeting p {
    font-size: 16px;
    line-height: 1.6;
    color: rgb(255 255 255 / 95%);
  }

  .wave {
    display: inline-block;
    font-size: 30px;
  }

  .hero-side {
    display: flex;
    gap: 16px;
    align-items: center;
    padding-top: 8px;
  }

  .hero-status {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: #3463a5;
    white-space: nowrap;
  }

  .hero-status i,
  .hero-chips i {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    background: #10b981;
    border-radius: 50%;
  }

  .hero-status .is-loading {
    background: #f59e0b;
  }

  .hero-config {
    height: 46px;
    background: #3478f6;
    border: 0;
    border-radius: 12px;
    box-shadow:
      0 0 0 5px rgb(255 255 255 / 45%),
      0 6px 15px rgb(26 103 233 / 22%);
  }

  .hero-chips {
    position: relative;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 18px 0 20px;
  }

  .hero-chips > span {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    padding: 10px 15px;
    font-size: 12px;
    color: #245792;
    background: rgb(255 255 255 / 36%);
    backdrop-filter: blur(4px);
    border-radius: 30px;
  }

  .hero-shortcuts {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    max-width: 1120px;
  }

  .hero-shortcuts button {
    display: flex;
    gap: 14px;
    align-items: center;
    min-width: 0;
    padding: 14px;
    text-align: left;
    cursor: pointer;
    background: rgb(255 255 255 / 84%);
    border: 1px solid rgb(255 255 255 / 88%);
    border-radius: 16px;
    box-shadow: 0 6px 15px rgb(40 99 190 / 6%);
    transition:
      transform 0.2s,
      box-shadow 0.2s;
  }

  .hero-shortcuts button:hover {
    box-shadow: 0 9px 19px rgb(40 99 190 / 14%);
    transform: translateY(-2px);
  }

  .shortcut-icon {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 45px;
    height: 45px;
    font-size: 24px;
    color: #fff;
    background: linear-gradient(140deg, #75abff, #2464ff);
    border-radius: 12px;
    box-shadow: 0 4px 12px rgb(52 120 246 / 35%);
  }

  .shortcut-purple .shortcut-icon {
    background: linear-gradient(140deg, #c591ff, #8b46f2);
    box-shadow: 0 4px 12px rgb(139 92 246 / 30%);
  }

  .shortcut-green .shortcut-icon {
    background: linear-gradient(140deg, #72dfbd, #0daf7d);
    box-shadow: 0 4px 12px rgb(16 185 129 / 30%);
  }

  .shortcut-orange .shortcut-icon {
    background: linear-gradient(140deg, #ffbd7b, #fa8b27);
    box-shadow: 0 4px 12px rgb(249 154 58 / 30%);
  }

  .hero-shortcuts strong {
    display: block;
    font-size: 14px;
    line-height: 1.5;
    color: #17243c;
  }

  .hero-shortcuts small {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.5;
    color: #6882a5;
  }

  .shortcut-arrow {
    margin-left: auto;
    font-size: 18px;
    color: #7d9bc4;
  }

  .hero-signature {
    position: absolute;
    right: 28px;
    bottom: 27px;
    display: none;
    font-size: 13px;
    color: #427bbd;
    letter-spacing: 2px;
  }

  .range-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    padding: 17px 20px;
    margin-bottom: 18px;
    background: var(--el-bg-color);
    border: 1px solid var(--el-border-color-light);
    border-radius: 16px;
    box-shadow: 0 6px 20px rgb(64 108 171 / 5%);
  }

  .range-toolbar h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .range-toolbar p {
    margin-top: 6px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .range-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  .range-presets {
    display: flex;
    gap: 6px;
  }

  .range-presets .el-button {
    height: 38px;
    margin: 0;
    border-radius: 8px;
  }

  .range-controls :deep(.el-date-editor) {
    width: 330px;
    height: 38px;
    border-radius: 8px;
  }

  .section-heading {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: baseline;
    margin: 18px 3px 14px;
  }

  .section-heading h3 {
    font-size: 15px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .section-heading > span {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .section-heading .el-button {
    margin-left: auto;
  }

  .scope-collapse {
    padding: 0 18px;
    background: var(--el-bg-color);
    border: 1px solid var(--el-border-color-light);
    border-radius: 14px;
  }

  .scope-collapse p {
    margin-bottom: 5px;
    font-size: 12px;
    line-height: 1.8;
    color: var(--el-text-color-secondary);
  }

  :global(.dark .overview-hero) {
    background: linear-gradient(112deg, #174884, #173761 48%, #152c4e 100%);
    border: 1px solid #264674;
  }

  :global(.dark .overview-hero .hero-shortcuts button) {
    background: rgb(21 45 80 / 87%);
    border-color: #335780;
  }

  :global(.dark .overview-hero .hero-shortcuts strong) {
    color: #edf4ff;
  }

  :global(.dark .overview-hero .hero-shortcuts small),
  :global(.dark .overview-hero .hero-status) {
    color: #c0d4f2;
  }

  :global(.dark .overview-hero .hero-chips > span) {
    color: #d8e7fc;
    background: rgb(190 216 255 / 15%);
  }

  @media (width >= 1700px) {
    .hero-art {
      right: 15%;
    }

    .hero-signature {
      display: block;
    }
  }

  @media (width <= 1100px) {
    .hero-side {
      flex-direction: column;
      align-items: flex-end;
    }

    .hero-art {
      right: 0;
      opacity: 0.6;
    }

    .hero-shortcuts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .hero-greeting h2 {
      font-size: 29px;
    }
  }

  @media (width <= 640px) {
    :global(.overview-range-picker .el-date-range-picker) {
      width: calc(100vw - 24px);
      max-width: 340px;
      max-height: 78vh;
      overflow-y: auto;
    }

    :global(.overview-range-picker .el-date-range-picker__content) {
      float: none;
      width: 100%;
      padding: 12px;
      border: 0;
    }

    .overview-hero {
      padding: 20px;
      border-radius: 16px;
    }

    .hero-greeting h2 {
      font-size: 25px;
    }

    .hero-greeting p {
      font-size: 13px;
    }

    .hero-side {
      display: none;
    }

    .hero-art {
      right: -190px;
      width: 440px;
      height: 230px;
      opacity: 0.35;
    }

    .hero-chips {
      gap: 6px;
    }

    .hero-chips > span {
      padding: 8px 10px;
      font-size: 11px;
    }

    .hero-shortcuts {
      gap: 9px;
    }

    .hero-shortcuts button {
      gap: 9px;
      padding: 10px;
    }

    .shortcut-icon {
      width: 35px;
      height: 35px;
      font-size: 19px;
    }

    .shortcut-arrow {
      display: none;
    }

    .hero-shortcuts strong {
      font-size: 12px;
    }

    .hero-shortcuts small {
      font-size: 10px;
    }

    .range-toolbar {
      padding: 16px;
    }

    .range-controls {
      width: 100%;
    }

    .range-controls :deep(.el-date-editor) {
      width: 100%;
      min-width: 0;
    }

    .range-presets {
      flex: 1;
    }

    .range-presets .el-button {
      flex: 1;
    }

    .range-controls .el-button.is-circle {
      margin-left: auto;
    }

    .section-heading > span {
      flex-basis: 100%;
    }

    .scope-collapse {
      padding: 0 12px;
    }
  }
</style>
