<template>
  <div class="art-full-height">
    <BusinessPageHeader
      title="菜单权限"
      description="查看原框架菜单结构、业务准入规则和当前账号访问范围。"
      icon="ri:menu-search-line"
      badge="与实际路由同步"
    />
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
            ><ElTag v-if="row.permissions.length" effect="plain" size="small">{{
              row.permissionMode === 'all' ? '全部满足' : '满足任一'
            }}</ElTag
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
        <template #operation="{ row }"
          ><ElButton type="primary" link @click="selectedPath = row.path"
            >查看准入详情</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <BusinessDetailPanel
      v-model="detailOpen"
      page-key="menu-access"
      :record-id="selectedPath"
      :restore-error="
        selectedPath && !selectedMenu ? '当前没有这条可见路由定义，请返回菜单列表。' : ''
      "
      @restore="selectedPath = $event.recordId || ''"
      title="菜单准入详情"
      width="min(880px, 96vw)"
      class="business-detail-dialog"
    >
      <template v-if="selectedMenu">
        <BusinessDetailHeader
          :title="title(selectedMenu.title)"
          description="查看这条路由的原准入条件和当前账号结果。菜单说明不替代接口权限核验。"
          icon="ri:menu-search-line"
          :context="selectedMenu.path"
          badge="只读路由定义"
        />
        <BusinessDetailSummary
          :items="[
            { label: '当前账户', value: user ? roleLabels[user.role] : '未登录' },
            {
              label: '准入结果',
              value: selectedMenu.access ? '可访问' : '无权限',
              tone: selectedMenu.access ? 'success' : 'warning'
            },
            {
              label: '权限规则',
              value: selectedMenu.permissionMode === 'all' ? '全部满足' : '满足任一'
            }
          ]"
        />
        <BusinessDetailSection title="页面与菜单信息">
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem label="页面范围">{{
              selectedMenu.business ? '工作室业务' : '原框架示例'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="路由地址">{{ selectedMenu.path }}</ElDescriptionsItem
            ><ElDescriptionsItem label="菜单展示">{{
              selectedMenu.hidden ? '隐藏入口，仍按路由权限裁决' : '普通菜单入口'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="子菜单"
              >{{ selectedMenu.children?.length || 0 }} 条直属子菜单</ElDescriptionsItem
            ></ElDescriptions
          >
        </BusinessDetailSection>
        <BusinessDetailSection
          title="访问条件"
          description="有多个条件时按此路由定义判定任一或全部；个人权限允许/禁止由服务器核验。"
        >
          <ElSpace wrap
            ><ElTag v-for="key in selectedMenu.permissions" :key="key" effect="plain">{{
              permissionLabels[key] || key
            }}</ElTag
            ><span v-if="!selectedMenu.permissions.length">{{
              selectedMenu.business
                ? '登录后访问，目录还需有可访问的子页'
                : '仅超级管理员可访问原框架示例'
            }}</span></ElSpace
          >
        </BusinessDetailSection>
      </template>
      <template #footer><ElButton @click="detailOpen = false">关闭</ElButton></template>
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import { canAccessStudioPage } from '@/utils/auth/studio-access'
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
    permissionMode: 'all' | 'any'
    access: boolean
    children?: MenuRow[]
  }
  const { user } = useStudio()
  const { t, te } = useI18n()
  const search = ref({ title: '', path: '', kind: '' })
  const applied = ref({ title: '', path: '', kind: '' })
  const searchItems = [
    {
      key: 'title',
      label: '菜单名称',
      type: 'input',
      props: { clearable: true, placeholder: '按菜单名称搜索' }
    },
    {
      key: 'path',
      label: '路由路径',
      type: 'input',
      props: { clearable: true, placeholder: '按路由路径搜索' }
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
        permissionMode: route.meta.studioPermissionMode === 'all' ? 'all' : 'any',
        access:
          (business || user.value?.role === 'super_admin') &&
          canAccessStudioPage(permissions, route.meta.studioPermissionMode)
      }
      if (route.children?.length) row.children = mapMenus(route.children, path, business)
      if (row.children?.length)
        row.access = row.access && row.children.some((child) => child.access)
      return row
    })
  }
  const menuRows = computed(() => mapMenus(source.value))
  const selectedPath = ref('')
  const selectedMenu = computed(() => {
    const find = (rows: MenuRow[]): MenuRow | undefined => {
      for (const row of rows) {
        if (row.path === selectedPath.value) return row
        const child = row.children && find(row.children)
        if (child) return child
      }
    }
    return find(menuRows.value)
  })
  const detailOpen = computed({
    get: () => Boolean(selectedMenu.value),
    set: (value) => {
      if (!value) selectedPath.value = ''
    }
  })
  function filterRows(rows: MenuRow[]): MenuRow[] {
    return rows.flatMap((row) => {
      const children = row.children ? filterRows(row.children) : []
      const matches =
        title(row.title)
          .toLowerCase()
          .includes((applied.value.title || '').trim().toLowerCase()) &&
        row.path.toLowerCase().includes((applied.value.path || '').trim().toLowerCase()) &&
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
    { prop: 'permissions', label: '访问权限与组合规则', minWidth: 290, useSlot: true },
    { prop: 'access', label: '当前账户', width: 120, useSlot: true },
    { prop: 'component', label: '源码页面', minWidth: 200, checked: false },
    { prop: 'operation', label: '操作', width: 150, fixed: 'right', useSlot: true }
  ])
  function applySearch() {
    applied.value = {
      title: search.value.title || '',
      path: search.value.path || '',
      kind: search.value.kind || ''
    }
  }
  function resetSearch() {
    search.value = { title: '', path: '', kind: '' }
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
