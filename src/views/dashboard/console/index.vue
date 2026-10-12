<template>
  <div v-loading="loading && !data">
    <ArtBasicBanner
      class="workspace-welcome mb-5"
      height="auto"
      box-style="!bg-theme/10"
      :decoration="false"
      :button-config="{ show: false, text: '' }"
      :image-config="{ src: bannerCover, width: '15rem', right: '0', bottom: '-3rem' }"
    >
      <template #title
        ><div class="relative z-10"
          ><ElTag effect="plain" size="small" class="mb-3">{{
            user ? roleLabels[user.role] : '工作台'
          }}</ElTag
          ><h2 class="text-2xl font-semibold text-g-900">{{ user?.name }}，欢迎回来</h2></div
        ></template
      >
      <template #subtitle
        ><p class="text-g-600 mt-3 leading-6 max-w-2xl"
          >订单进度、经营数据和待处理事项集中查看，开始今天的工作。</p
        ></template
      >
      <ElSpace wrap class="relative z-10 mt-5"
        ><ElDatePicker
          v-model="month"
          type="month"
          value-format="YYYY-MM"
          :clearable="false"
          style="width: 150px"
          @change="changeMonth"
        /><ElButton :loading="loading" @click="reload"
          ><ArtSvgIcon icon="ri:refresh-line" class="mr-1" />刷新</ElButton
        ><ElButton
          v-if="can('orders.create')"
          type="primary"
          @click="$router.push('/orders/create')"
          >创建订单</ElButton
        ></ElSpace
      >
      <div class="relative z-10 text-xs text-g-500 mt-4"
        >{{ dateLabel
        }}<span v-if="lastUpdatedAt"> · 数据更新于 {{ formatTime(lastUpdatedAt) }}</span></div
      >
    </ArtBasicBanner>
    <ElResult
      v-if="user?.role === 'player'"
      icon="info"
      title="打手端将独立上线"
      sub-title="请使用分配给你的打手端入口。"
    />
    <template v-else>
      <CardList />
      <div class="art-card p-5 mb-5">
        <div class="flex items-center justify-between flex-wrap gap-3 mb-4"
          ><div
            ><h3 class="font-semibold">常用工作入口</h3
            ><p class="text-xs text-g-500 mt-1">按当前账号权限显示</p></div
          ><ElTag type="info" effect="plain">{{ data?.reports.month || selectedMonth }}</ElTag></div
        >
        <div class="workspace-shortcuts"
          ><ElButton
            v-for="item in shortcuts"
            :key="item.path"
            class="!ml-0"
            @click="$router.push(item.path)"
            ><ArtSvgIcon :icon="item.icon" class="text-lg mr-2 text-theme" />{{
              item.label
            }}</ElButton
          ></div
        >
      </div>
      <ElRow :gutter="20"
        ><ElCol :xs="24" :lg="10"><ActiveUser /></ElCol
        ><ElCol :xs="24" :lg="14"><SalesOverview /></ElCol
      ></ElRow>
      <ElRow :gutter="20"
        ><ElCol :xs="24" :lg="12"><NewUser /></ElCol
        ><ElCol :xs="24" :md="12" :lg="6"><Dynamic /></ElCol
        ><ElCol :xs="24" :md="12" :lg="6"><TodoList /></ElCol
      ></ElRow>
      <AboutProject />
    </template>
  </div>
</template>
<script setup lang="ts">
  import { useStudio, roleLabels, formatTime } from '@/hooks/business/useStudio'
  import bannerCover from '@imgs/login/lf_icon2.webp'
  import CardList from './modules/card-list.vue'
  import ActiveUser from './modules/active-user.vue'
  import SalesOverview from './modules/sales-overview.vue'
  import NewUser from './modules/new-user.vue'
  import Dynamic from './modules/dynamic-stats.vue'
  import TodoList from './modules/todo-list.vue'
  import AboutProject from './modules/about-project.vue'
  defineOptions({ name: 'Console' })
  const { data, user, can, loading, refresh, selectedMonth, lastUpdatedAt } = useStudio()
  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(new Date())
  const shortcuts = computed(() =>
    [
      {
        label: '创建订单',
        icon: 'ri:add-box-line',
        path: '/orders/create',
        show: can('orders.create')
      },
      {
        label: '订单管理',
        icon: 'ri:file-list-3-line',
        path: '/orders/list',
        show: can('orders.view')
      },
      {
        label: '财务结算',
        icon: 'ri:wallet-3-line',
        path: '/finance/settlement',
        show: ['finance.review', 'finance.refunds', 'finance.withdrawals', 'finance.expenses'].some(
          can
        )
      },
      {
        label: '工资核算',
        icon: 'ri:money-cny-circle-line',
        path: '/finance/salary',
        show: ['salary.view', 'salary.all', 'salary.manage'].some(can)
      },
      { label: '人员管理', icon: 'ri:team-line', path: '/system/user', show: can('users.manage') },
      {
        label: '排班考勤',
        icon: 'ri:calendar-check-line',
        path: '/personnel/attendance',
        show: can('attendance.manage')
      },
      { label: '数据导出', icon: 'ri:file-excel-2-line', path: '/reports/export', show: true }
    ].filter((item) => item.show)
  )
  const month = computed({
    get: () => selectedMonth.value,
    set: (value: string) => {
      if (value) selectedMonth.value = value
    }
  })
  const reload = () => refresh().catch(() => {})
  const changeMonth = (value: string | null) => {
    if (value) void refresh(value).catch(() => {})
  }
  onMounted(reload)
</script>
<style lang="scss" scoped>
  .workspace-welcome {
    min-height: 240px;
    padding: 24px 28px;
  }

  .workspace-shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  @media (width <= 640px) {
    .workspace-welcome {
      padding: 20px;
    }

    .workspace-shortcuts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .workspace-shortcuts .el-button {
      width: 100%;
      padding-inline: 8px;
    }
  }
</style>
