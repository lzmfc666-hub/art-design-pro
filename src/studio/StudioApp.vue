<template>
  <ElConfigProvider :locale="zhCn">
    <div v-if="booting" class="boot-screen"
      ><div class="brand-mark">J</div><p>正在连接工作室…</p></div
    >
    <div v-else-if="!user" class="login-page">
      <div class="login-story">
        <div class="login-brand"
          ><span class="brand-mark">J</span> 金盾电竞 <small>STUDIO</small></div
        >
        <div class="login-intro"
          ><span class="eyebrow">工作室的每一份努力，都清晰可见</span
          ><h1>专注每一单<br />让运营更有序。</h1
          ><p
            >从接单到结算，连接客户、团队与经营数据。<br />为高效协作而设计的工作室管理后台。</p
          ></div
        >
        <div class="login-steps"
          ><span>01 <b>高效派单</b></span
          ><span>02 <b>透明履约</b></span
          ><span>03 <b>清晰结算</b></span></div
        >
        <span class="login-copyright">JINDUN ESPORTS · WORKSPACE</span>
      </div>
      <div class="login-form-wrap">
        <div class="login-form"
          ><span class="eyebrow">WELCOME BACK</span><h2>登录工作室</h2
          ><p class="muted">使用管理员分配的账号继续</p>
          <ElAlert
            v-if="connectionError"
            :title="connectionError"
            type="error"
            :closable="false"
            show-icon
            class="login-alert"
          />
          <ElForm @submit.prevent="submitLogin" label-position="top" size="large">
            <ElFormItem label="账号"
              ><ElInput
                v-model="username"
                placeholder="请输入账号"
                autocomplete="username"
                :prefix-icon="User"
            /></ElFormItem>
            <ElFormItem label="密码"
              ><ElInput
                v-model="password"
                type="password"
                show-password
                placeholder="请输入密码"
                autocomplete="current-password"
                :prefix-icon="Lock"
            /></ElFormItem>
            <ElButton type="primary" native-type="submit" :loading="signingIn" class="login-submit"
              >登录 <ElIcon><ArrowRight /></ElIcon
            ></ElButton>
          </ElForm>
          <div class="login-note"
            ><ElIcon><Shield /></ElIcon
            ><span>账号由管理员统一建立；需要帮助请联系工作室管理员。</span></div
          >
        </div>
      </div>
    </div>
    <div v-else-if="user.role === 'player'" class="boot-screen"
      ><div class="brand-mark">J</div><h2>请使用独立打手端</h2
      ><p class="muted">此入口供工作室管理人员使用，打手端正在准备中。</p
      ><ElButton @click="signOut">退出登录</ElButton></div
    >
    <div v-else class="studio-layout" :class="{ 'sidebar-collapsed': collapsed }">
      <div v-if="mobileNav" class="sidebar-mask" @click="mobileNav = false"></div>
      <aside class="studio-sidebar" :class="{ 'mobile-open': mobileNav }">
        <RouterLink class="brand" to="/overview"
          ><span class="brand-mark">J</span
          ><span class="brand-copy"><b>金盾电竞</b><small>工作室管理后台</small></span></RouterLink
        >
        <div class="sidebar-section-label">工作空间</div>
        <nav class="studio-nav"
          ><RouterLink
            v-for="item in visibleNavigation"
            :key="item.path"
            :to="item.path"
            :title="item.label"
            @click="mobileNav = false"
            ><ElIcon><component :is="item.icon" /></ElIcon><span>{{ item.label }}</span
            ><span v-if="item.path === '/orders' && pendingCount" class="nav-count">{{
              pendingCount
            }}</span></RouterLink
          ></nav
        >
        <div class="sidebar-footer"
          ><span class="live-dot"></span><span>团队协作 · 有序运转</span></div
        >
      </aside>
      <section class="studio-workspace">
        <header class="studio-header">
          <div class="header-location"
            ><ElButton text circle aria-label="展开或收起菜单" @click="toggleNavigation"
              ><ElIcon :size="20"><Fold /></ElIcon></ElButton
            ><span class="header-parent">工作台</span><span class="header-divider">/</span
            ><b>{{ route.meta.title }}</b></div
          >
          <div class="header-tools"
            ><span class="header-date">{{ todayLabel }}</span
            ><ElTooltip content="刷新数据"
              ><ElButton text circle :loading="loading" aria-label="刷新数据" @click="reload"
                ><ElIcon :size="18"><Refresh /></ElIcon></ElButton></ElTooltip
            ><ElBadge :value="pendingReviews" :hidden="!pendingReviews" :max="99"
              ><ElButton
                text
                circle
                aria-label="待处理事项"
                @click="router.push(can('finance.review') ? '/finance' : '/orders')"
                ><ElIcon :size="19"><Bell /></ElIcon></ElButton></ElBadge
            ><span class="header-tool-divider"></span
            ><ElDropdown @command="handleCommand"
              ><button class="profile-button"
                ><span class="user-avatar">{{ user.name.slice(0, 1) }}</span
                ><span
                  ><b>{{ user.name }}</b
                  ><small>{{ roleLabels[user.role] }}</small></span
                ><ElIcon><ArrowDown /></ElIcon></button
              ><template #dropdown
                ><ElDropdownMenu
                  ><ElDropdownItem command="logout">退出登录</ElDropdownItem></ElDropdownMenu
                ></template
              ></ElDropdown
            ></div
          >
        </header>
        <main class="studio-main">
          <div v-if="data?.demo" class="development-note"
            ><span class="live-dot"></span>本地开发环境 · 当前包含用于检查流程的示例数据</div
          >
          <ElAlert
            v-if="error"
            :title="error"
            type="error"
            show-icon
            :closable="false"
            style="margin-bottom: 20px"
          />
          <RouterView v-if="data && routeAllowed" />
          <div v-else-if="!routeAllowed" class="panel empty-state"
            ><h2>当前账号没有此模块的访问权限</h2
            ><ElButton @click="router.push('/overview')">返回工作台</ElButton></div
          >
        </main>
        <footer class="studio-footer"
          ><span>金盾电竞 · 工作室管理系统</span><span>专注业务，让协作更简单</span></footer
        >
      </section>
    </div>
  </ElConfigProvider>
</template>

<script setup lang="ts">
  import { computed, onMounted, ref } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import zhCn from 'element-plus/es/locale/lang/zh-cn'
  import {
    ArrowDown,
    ArrowRight,
    Bell,
    Calendar,
    DataAnalysis,
    Document,
    Fold,
    Grid,
    Lock,
    Monitor,
    Refresh,
    Setting,
    Tickets,
    User,
    CircleCheck as Shield
  } from '@element-plus/icons-vue'
  import { useStudio, roleLabels } from './useStudio'

  const { user, data, loading, error, init, login, logout, refresh, can } = useStudio()
  const route = useRoute(),
    router = useRouter()
  const booting = ref(true),
    signingIn = ref(false),
    connectionError = ref('')
  const username = ref(''),
    password = ref(''),
    collapsed = ref(false),
    mobileNav = ref(false)
  const navigation = [
    { path: '/overview', label: '数据概览', icon: DataAnalysis, permission: '' },
    { path: '/dispatch', label: '快捷下单', icon: Grid, permission: 'orders.create' },
    { path: '/orders', label: '订单管理', icon: Tickets, permission: 'orders.view' },
    { path: '/catalog', label: '游戏与业务配置', icon: Monitor, permission: 'catalog' },
    { path: '/people', label: '用户管理', icon: User, permission: 'users.manage' },
    { path: '/attendance', label: '人事考勤', icon: Calendar, permission: 'attendance.manage' },
    { path: '/finance', label: '财务管理', icon: Document, permission: 'finance' },
    { path: '/logs', label: '操作日志', icon: Setting, permission: 'logs.view' }
  ]
  function hasModule(permission: string) {
    if (permission === 'finance')
      return [
        'finance.review',
        'finance.refunds',
        'finance.withdrawals',
        'finance.expenses',
        'salary.view',
        'salary.manage',
        'profit.view'
      ].some(can)
    if (permission === 'catalog') return can('templates.manage') || can('settings.manage')
    return !permission || can(permission)
  }
  const visibleNavigation = computed(() => navigation.filter((item) => hasModule(item.permission)))
  const routeAllowed = computed(() =>
    hasModule(navigation.find((item) => item.path === route.path)?.permission || '')
  )
  const pendingCount = computed(
    () => data.value?.orders.filter((order) => order.status === 'pending').length || 0
  )
  const pendingReviews = computed(() =>
    can('finance.review')
      ? data.value?.orders.filter((order) => order.status === 'review').length || 0
      : pendingCount.value
  )
  const todayLabel = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  })
  function toggleNavigation() {
    if (window.innerWidth < 900) mobileNav.value = !mobileNav.value
    else collapsed.value = !collapsed.value
  }
  async function submitLogin() {
    if (!username.value.trim() || !password.value) return ElMessage.warning('请输入账号和密码')
    signingIn.value = true
    connectionError.value = ''
    try {
      await login(username.value.trim(), password.value)
      password.value = ''
      await router.push('/overview')
    } catch (cause) {
      connectionError.value = cause instanceof Error ? cause.message : '登录失败'
    } finally {
      signingIn.value = false
    }
  }
  async function reload() {
    try {
      await refresh()
    } catch {
      /* 页面显示服务错误 */
    }
  }
  async function signOut() {
    try {
      await logout()
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '退出失败')
    }
  }
  function handleCommand(command: string) {
    if (command === 'logout') void signOut()
  }
  onMounted(async () => {
    try {
      await init()
    } catch (cause) {
      connectionError.value = cause instanceof Error ? cause.message : '后台连接失败'
    } finally {
      booting.value = false
    }
  })
</script>
