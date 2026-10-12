<template>
  <div v-if="show" class="flex justify-end mb-3">
    <ElButton size="small" @click="openExport"
      ><ArtSvgIcon icon="ri:file-excel-2-line" class="mr-1" />导出本模块</ElButton
    >
  </div>
</template>
<script setup lang="ts">
  import { computed } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { useStudio } from '@/hooks/business/useStudio'
  const route = useRoute()
  const router = useRouter()
  const { user, can } = useStudio()
  const modules: Record<string, string> = {
    '/orders/list': 'orders',
    '/orders/create': 'orders',
    '/orders/customers': 'customers',
    '/dashboard/analysis': 'days',
    '/finance/salary': 'payroll',
    '/personnel/attendance': 'attendance',
    '/system/user': 'staff',
    '/system/role': 'roles',
    '/system/menu': 'menus',
    '/system/business': 'templates',
    '/system/appearance': 'appearance',
    '/system/logs': 'logs',
    '/system/user-center': 'profile'
  }
  const show = computed(
    () =>
      route.meta.business &&
      can('reports.export') &&
      ![
        '/reports/export',
        '/finance/settlement',
        '/finance/salary',
        '/dashboard/analysis'
      ].includes(route.path) &&
      (route.path !== '/system/appearance' || can('settings.manage')) &&
      user.value?.role !== 'player'
  )
  function openExport() {
    if (!can('reports.export')) return
    if (route.path === '/system/appearance' && !can('settings.manage')) return
    let module = modules[route.path] || 'profile'
    if (route.path === '/dashboard/console')
      module = can('profit.view') ? 'overview' : 'performance'
    if (route.path === '/finance/settlement')
      module = ['refunds', 'withdrawals', 'expenses'].includes(String(route.query.tab))
        ? String(route.query.tab)
        : 'orders'
    const related: Record<string, string> = {
      '/finance/settlement': 'orders,refunds,withdrawals,wallets,expenses',
      '/finance/salary': 'payroll,payrollHistory,salaryPlans',
      '/system/business': 'templates,platforms,shops,levels'
    }
    void router.push({
      path: '/reports/export',
      query: { module, ...(related[route.path] ? { modules: related[route.path] } : {}) }
    })
  }
</script>
