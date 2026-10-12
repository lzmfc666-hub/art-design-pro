<template>
  <div class="art-full-height">
    <ArtSearchBar
      v-model="search"
      :items="searchItems"
      @search="applySearch"
      @reset="resetSearch"
    />
    <ElCard class="art-table-card">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="loadMenus">
        <template #left
          ><ElSpace wrap
            ><ElButton @click="toggleExpand" v-ripple>{{
              expanded ? '收起全部' : '展开全部'
            }}</ElButton
            ><ElTag type="info">当前账户：{{ user ? roleLabels[user.role] : '—' }}</ElTag></ElSpace
          ></template
        >
      </ArtTableHeader>
      <ElAlert
        class="mb-4"
        :closable="false"
        type="info"
        title="菜单结构只读。需要调整人员的业务权限，请前往人员管理；授权结果会同步影响菜单显示和操作权限。"
      />
      <ArtTable
        ref="tableRef"
        row-key="path"
        :data="filteredMenus"
        :columns="columns"
        :loading="loading"
        :default-expand-all="expanded"
        :tree-props="{ children: 'children' }"
      >
        <template #title="{ row }"
          ><span>{{ title(row.title) }}</span
          ><ElTag v-if="row.hidden" class="ml-2" size="small" type="info">隐藏菜单</ElTag></template
        >
        <template #kind="{ row }"
          ><ElTag :type="row.business ? 'success' : 'info'">{{
            row.business ? '工作室业务' : '原框架示例'
          }}</ElTag></template
        >
        <template #permissions="{ row }"
          ><ElSpace wrap
            ><ElTag v-for="permission in row.permissions" :key="permission" type="info">{{
              permissionLabels[permission] || permission
            }}</ElTag
            ><span v-if="!row.permissions.length" class="text-g-500">{{
              row.business ? '登录后按子页权限访问' : '超级管理员'
            }}</span></ElSpace
          ></template
        >
        <template #access="{ row }"
          ><ElTag :type="row.access ? 'success' : 'warning'">{{
            row.access ? '可访问' : '无权限'
          }}</ElTag></template
        >
      </ArtTable>
    </ElCard>
  </div>
</template>

<script setup lang="ts">
  import { computed, ref, nextTick, onMounted } from 'vue'
  import { useI18n } from 'vue-i18n'
  import { ElMessage } from 'element-plus'
  import { fetchGetMenuList } from '@/api/system-manage'
  import { useStudio, roleLabels } from '@/hooks/business/useStudio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { AppRouteRecord } from '@/types/router'
  import { permissionLabels } from '../user/modules/permissions'

  defineOptions({ name: 'Menus' })
  interface MenuRow {
    title: string
    path: string
    component: string
    hidden: boolean
    business: boolean
    permissions: string[]
    access: boolean
    children?: MenuRow[]
  }
  const { user, can } = useStudio()
  const { t, te } = useI18n()
  const search = ref({ keyword: '', kind: '' })
  const applied = ref({ keyword: '', kind: '' })
  const searchItems = [
    {
      key: 'keyword',
      label: '菜单 / 路径',
      type: 'input',
      props: { clearable: true, placeholder: '搜索菜单名称或路由' }
    },
    {
      key: 'kind',
      label: '菜单范围',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { value: 'business', label: '工作室业务' },
          { value: 'example', label: '原框架示例' }
        ]
      }
    }
  ]
  const source = ref<AppRouteRecord[]>([])
  const loading = ref(false)
  const expanded = ref(false)
  const tableRef = ref()
  function title(value: string) {
    return te(value) ? t(value) : value
  }
  function mapMenus(routes: AppRouteRecord[], parentPath = '', parentBusiness = false): MenuRow[] {
    return routes.map((route) => {
      const path = route.path.startsWith('/')
        ? route.path
        : `${parentPath}/${route.path}`.replace(/\/+/g, '/')
      const business = (route.meta.business ?? parentBusiness) && !route.meta.templateExample
      const permissions = route.meta.studioPermissions || []
      const row: MenuRow = {
        title: route.meta.title,
        path,
        component: typeof route.component === 'string' ? route.component : '—',
        hidden: !!route.meta.isHide,
        business,
        permissions,
        access:
          (business || user.value?.role === 'super_admin') &&
          (!permissions.length || permissions.some(can))
      }
      if (route.children?.length) row.children = mapMenus(route.children, path, business)
      if (row.children?.length)
        row.access = row.access && row.children.some((child) => child.access)
      return row
    })
  }
  const menuRows = computed(() => mapMenus(source.value))
  function filterRows(rows: MenuRow[]): MenuRow[] {
    return rows.flatMap((row) => {
      const children = row.children ? filterRows(row.children) : []
      const matches =
        `${title(row.title)} ${row.path}`
          .toLowerCase()
          .includes(applied.value.keyword.toLowerCase()) &&
        (!applied.value.kind || row.business === (applied.value.kind === 'business'))
      return matches || children.length
        ? [{ ...row, children: children.length ? children : undefined }]
        : []
    })
  }
  const filteredMenus = computed(() => filterRows(menuRows.value))
  const { columns, columnChecks } = useTableColumns<MenuRow>(() => [
    { prop: 'title', label: '菜单名称', minWidth: 240, useSlot: true },
    { prop: 'path', label: '路由路径', minWidth: 230 },
    { prop: 'kind', label: '范围', width: 140, useSlot: true },
    { prop: 'permissions', label: '访问权限（满足其中一项）', minWidth: 290, useSlot: true },
    { prop: 'access', label: '当前账户', width: 120, useSlot: true },
    { prop: 'component', label: '源码页面', minWidth: 200, checked: false }
  ])
  function applySearch() {
    applied.value = { keyword: search.value.keyword || '', kind: search.value.kind || '' }
  }
  function resetSearch() {
    search.value = { keyword: '', kind: '' }
    applySearch()
  }
  async function loadMenus() {
    loading.value = true
    try {
      source.value = await fetchGetMenuList()
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '菜单加载失败')
    } finally {
      loading.value = false
    }
  }
  async function toggleExpand() {
    expanded.value = !expanded.value
    await nextTick()
    const visit = (rows: MenuRow[]) =>
      rows.forEach((row) => {
        if (row.children?.length) {
          tableRef.value?.elTableRef?.toggleRowExpansion(row, expanded.value)
          visit(row.children)
        }
      })
    visit(filteredMenus.value)
  }
  onMounted(loadMenus)
</script>
