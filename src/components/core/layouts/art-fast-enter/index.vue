<!-- 顶部快速入口面板 -->
<template>
  <ElPopover
    ref="popoverRef"
    :width="700"
    :offset="0"
    :show-arrow="false"
    trigger="hover"
    placement="bottom-start"
    popper-class="fast-enter-popover"
    :popper-style="{
      border: '1px solid var(--default-border)',
      borderRadius: 'calc(var(--custom-radius) / 2 + 4px)'
    }"
  >
    <template #reference>
      <div class="flex-c gap-2">
        <slot />
      </div>
    </template>

    <div class="grid grid-cols-[2fr_0.8fr] max-h-[70vh] overflow-y-auto">
      <div>
        <div class="grid grid-cols-2 gap-1.5">
          <!-- 应用列表 -->
          <div
            v-for="application in enabledApplications"
            :key="application.name"
            class="mr-3 c-p flex-c gap-3 rounded-lg p-2 hover:bg-g-200/70 dark:hover:bg-g-200/90 hover:[&_.app-icon]:!bg-transparent"
            @click="handleApplicationClick(application)"
          >
            <div class="app-icon size-12 flex-cc rounded-lg bg-g-200/80 dark:bg-g-300/30">
              <ArtSvgIcon
                class="text-xl"
                :icon="applicationIcon(application)"
                :style="{ color: application.iconColor }"
              />
            </div>
            <div>
              <h3 class="m-0 text-sm font-medium text-g-800">{{ application.name }}</h3>
              <p class="mt-1 text-xs text-g-600">{{ application.description }}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="border-l-d pl-6 pt-2">
        <h3 class="mb-2.5 text-base font-medium text-g-800">快速链接</h3>
        <ul>
          <li
            v-for="quickLink in enabledQuickLinks"
            :key="quickLink.name"
            class="c-p py-2 hover:[&_span]:text-theme"
            @click="handleQuickLinkClick(quickLink)"
          >
            <span class="text-g-600 no-underline">{{ quickLink.name }}</span>
          </li>
        </ul>
      </div>
    </div>
  </ElPopover>
</template>

<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import { useStudio } from '@/hooks/business/useStudio'
  import { useAppearance } from '@/hooks/business/useAppearance'
  import { appearanceIconForRoute } from '@/utils/ui/appearance-icon'

  defineOptions({ name: 'ArtFastEnter' })

  const router = useRouter()
  const popoverRef = ref()
  const { user, can } = useStudio()
  const { icon } = useAppearance()

  interface StudioQuickLink {
    name: string
    routeName: string
    permissions?: string[]
    templateExample?: boolean
  }
  interface StudioApplication extends StudioQuickLink {
    description: string
    icon: string
    iconColor: string
  }

  const applications: StudioApplication[] = [
    {
      name: '业务总览',
      routeName: 'Console',
      description: '经营数据与权限内待办',
      icon: 'ri:home-smile-2-line',
      iconColor: 'var(--theme-color)'
    },
    {
      name: '订单管理',
      routeName: 'OrderList',
      description: '查看订单、收款与进度',
      icon: 'ri:file-list-3-line',
      iconColor: 'var(--el-color-primary)',
      permissions: ['orders.view']
    },
    {
      name: '创建与派单',
      routeName: 'OrderCreate',
      description: '按模板创建工作室订单',
      icon: 'ri:add-box-line',
      iconColor: 'var(--el-color-success)',
      permissions: ['orders.create']
    },
    {
      name: '验收与结算',
      routeName: 'Settlement',
      description: '订单验收、退款与提现',
      icon: 'ri:wallet-3-line',
      iconColor: 'var(--el-color-warning)',
      permissions: ['finance.review', 'finance.refunds', 'finance.withdrawals', 'finance.expenses']
    },
    {
      name: '工资与提成',
      routeName: 'Salary',
      description: '查看权限内工资与结算',
      icon: 'ri:money-cny-circle-line',
      iconColor: 'var(--el-color-success)',
      permissions: ['salary.view', 'salary.all', 'salary.manage']
    },
    {
      name: '排班与到岗',
      routeName: 'Attendance',
      description: '人员排班与实际出勤',
      icon: 'ri:calendar-check-line',
      iconColor: 'var(--el-color-primary)',
      permissions: ['attendance.manage']
    },
    {
      name: '老板管理',
      routeName: 'Customers',
      description: '维护客户与游戏信息',
      icon: 'ri:contacts-book-line',
      iconColor: 'var(--el-color-info)',
      permissions: ['users.manage', 'orders.create', 'finance.refunds']
    },
    {
      name: '员工管理',
      routeName: 'User',
      description: '员工账号、岗位与个人权限',
      icon: 'ri:team-line',
      iconColor: 'var(--el-color-primary)',
      permissions: ['users.manage']
    },
    {
      name: '打手管理',
      routeName: 'Players',
      description: '打手档案与离店押金处理',
      icon: 'ri:gamepad-line',
      iconColor: 'var(--el-color-primary)',
      permissions: ['users.manage', 'finance.withdrawals']
    },
    {
      name: '业务配置',
      routeName: 'BusinessConfig',
      description: '模板、平台、店铺与等级',
      icon: 'ri:gamepad-line',
      iconColor: 'var(--el-color-warning)',
      permissions: ['templates.manage', 'settings.manage']
    },
    {
      name: '数据报表',
      routeName: 'ReportExport',
      permissions: ['reports.export'],
      description: '按权限自选字段导出',
      icon: 'ri:file-excel-2-line',
      iconColor: 'var(--el-color-success)'
    }
  ]
  const quickLinks: StudioQuickLink[] = [
    { name: '个人中心', routeName: 'UserCenter' },
    { name: '经营报表', routeName: 'Analysis', permissions: ['profit.view'] },
    { name: '角色与权限', routeName: 'Role', permissions: ['users.manage'] },
    { name: '操作日志', routeName: 'AuditLogs', permissions: ['logs.view'] },
    { name: '原组件示例', routeName: 'Icon', templateExample: true },
    { name: 'Excel 示例', routeName: 'Excel', templateExample: true }
  ]

  const isAccessible = (item: StudioQuickLink) =>
    Boolean(
      user.value &&
        user.value.role !== 'player' &&
        (!item.templateExample || user.value.role === 'super_admin') &&
        (!item.permissions || item.permissions.some((permission) => can(permission)))
    )
  const enabledApplications = computed(() => applications.filter(isAccessible))
  const enabledQuickLinks = computed(() => quickLinks.filter(isAccessible))
  const applicationIcon = (application: StudioApplication) => {
    if (!router.hasRoute(application.routeName)) return application.icon
    const path = router.resolve({ name: application.routeName }).path
    const key = appearanceIconForRoute(path)
    return key ? icon(key, application.icon) : application.icon
  }

  const handleNavigate = (item: StudioQuickLink): void => {
    if (!isAccessible(item) || !router.hasRoute(item.routeName)) return
    router.push({ name: item.routeName })
    popoverRef.value?.hide()
  }
  const handleApplicationClick = handleNavigate
  const handleQuickLinkClick = handleNavigate
</script>
