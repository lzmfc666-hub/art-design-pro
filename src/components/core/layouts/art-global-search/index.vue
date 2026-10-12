<!-- 全局搜索组件 -->
<template>
  <div class="layout-search">
    <ElDialog
      v-model="showSearchDialog"
      width="min(680px, 94vw)"
      :show-close="false"
      :lock-scroll="false"
      modal-class="search-modal"
      @close="closeSearchDialog"
    >
      <ElTabs v-model="category" class="search-categories"
        ><ElTabPane v-for="item in categories" :key="item.key" :name="item.key" :label="item.label"
      /></ElTabs>
      <ElSelect v-model="searchField" class="search-field" placeholder="选择搜索字段"
        ><ElOption
          v-for="item in fieldOptions"
          :key="item.key"
          :value="item.key"
          :label="item.label"
      /></ElSelect>
      <ElInput
        v-model.trim="searchVal"
        :placeholder="`搜索${fieldOptions.find((item) => item.key === searchField)?.label || '当前字段'}（Ctrl + K）`"
        @input="search"
        @blur="searchBlur"
        ref="searchInput"
        :prefix-icon="Search"
        class="h-12"
      >
        <template #suffix>
          <div
            class="h-4.5 flex-cc rounded border border-g-300 dark:!bg-g-200/50 !bg-box px-1.5 text-g-500"
          >
            <ArtSvgIcon icon="fluent:arrow-enter-left-20-filled" />
          </div>
        </template>
      </ElInput>
      <ElScrollbar class="mt-5" max-height="370px" ref="searchResultScrollbar" always>
        <div class="result w-full" v-show="searchResult.length">
          <div
            class="box !mt-0 c-p text-base leading-none"
            v-for="(item, index) in searchResult"
            :key="index"
          >
            <div
              class="mt-2 h-12 flex-cb rounded-custom-sm bg-g-200/80 px-4 text-sm text-g-700"
              :class="isHighlighted(index) ? 'highlighted !bg-theme/70 !text-white' : ''"
              @click="searchGoPage(item)"
              @mouseenter="highlightOnHover(index)"
            >
              <div class="min-w-0"
                ><span class="block truncate">{{ formatMenuTitle(item.meta.title) }}</span
                ><span v-if="item.description" class="text-xs opacity-75 block truncate mt-1">{{
                  item.description
                }}</span></div
              >
              <ArtSvgIcon v-show="isHighlighted(index)" icon="fluent:arrow-enter-left-20-filled" />
            </div>
          </div>
        </div>
        <ElEmpty
          v-if="searchVal && !searchResult.length"
          description="当前分类和字段没有匹配记录"
          :image-size="75"
        />

        <div
          class="history-result"
          v-show="canUseHistory && searchResult.length === 0 && historyResult.length > 0"
        >
          <p class="text-xs text-g-500">{{ $t('search.historyTitle') }}</p>
          <div class="mt-1.5 w-full">
            <div
              class="box mt-2 h-12 c-p flex-cb rounded-custom-sm bg-g-200/80 px-4 text-sm text-g-800"
              v-for="(item, index) in historyResult"
              :key="index"
              :class="
                historyHIndex === index
                  ? 'highlighted !bg-theme/70 !text-white [&_.selected-icon]:!text-white'
                  : ''
              "
              @click="searchGoPage(item)"
              @mouseenter="highlightOnHoverHistory(index)"
            >
              {{ formatMenuTitle(item.meta.title) }}
              <div
                class="size-5 selected-icon select-none rounded-full text-g-500 flex-cc c-p"
                @click.stop="deleteHistory(index)"
              >
                <ArtSvgIcon icon="ri:close-large-fill" class="text-xs" />
              </div>
            </div>
          </div>
        </div>
      </ElScrollbar>

      <template #footer>
        <div class="dialog-footer box-border flex-c border-t-d pt-4.5 pb-1">
          <div class="flex-cc">
            <ArtSvgIcon icon="fluent:arrow-enter-left-20-filled" class="keyboard" />
            <span class="mr-3.5 text-xs text-g-700">{{ $t('search.selectKeydown') }}</span>
          </div>
          <div class="flex-c">
            <ArtSvgIcon icon="ri:arrow-up-wide-fill" class="keyboard" />
            <ArtSvgIcon icon="ri:arrow-down-wide-fill" class="keyboard" />
            <span class="mr-3.5 text-xs text-g-700">{{ $t('search.switchKeydown') }}</span>
          </div>
          <div class="flex-c">
            <i class="keyboard !w-8 flex-cc"><p class="text-[10px] font-medium">ESC</p></i>
            <span class="mr-3.5 text-xs text-g-700">{{ $t('search.exitKeydown') }}</span>
          </div>
        </div>
      </template>
    </ElDialog>
  </div>
</template>

<script lang="ts" setup>
  import { useUserStore } from '@/store/modules/user'
  import { AppRouteRecord } from '@/types/router'
  import { Search } from '@element-plus/icons-vue'
  import { mittBus } from '@/utils/sys'
  import { useMenuStore } from '@/store/modules/menu'
  import { formatMenuTitle } from '@/utils/router'
  import { handleMenuJump } from '@/utils/navigation'
  import { type ScrollbarInstance } from 'element-plus'
  import { useStudio, statusLabels, roleLabels } from '@/hooks/business/useStudio'

  defineOptions({ name: 'ArtGlobalSearch' })

  const userStore = useUserStore()
  const { menuList } = storeToRefs(useMenuStore())

  const showSearchDialog = ref(false)
  const searchVal = ref('')
  interface SearchRoute extends AppRouteRecord {
    businessRecord?: boolean
    description?: string
  }
  const searchResult = ref<SearchRoute[]>([])
  const { data, can } = useStudio()
  type SearchCategory = 'menu' | 'orders' | 'customers' | 'people'
  const category = ref<SearchCategory>('menu')
  const searchField = ref('title')
  const categories = computed(() =>
    [
      { key: 'menu', label: '菜单', allowed: true },
      { key: 'orders', label: '订单', allowed: can('orders.view') },
      { key: 'customers', label: '客户', allowed: can('orders.create') || can('users.manage') },
      { key: 'people', label: '人员', allowed: can('users.manage') }
    ].filter((item) => item.allowed)
  )
  const fields: Record<SearchCategory, { key: string; label: string }[]> = {
    menu: [
      { key: 'title', label: '菜单名称' },
      { key: 'path', label: '页面路径' }
    ],
    orders: [
      ['orderNo', '工作室订单号'],
      ['externalOrderNo', '平台订单号'],
      ['title', '订单项目'],
      ['customerName', '客户名称'],
      ['contact', '客户联系方式'],
      ['gameId', '客户游戏 ID'],
      ['roomCode', '房间码']
    ].map(([key, label]) => ({ key, label })),
    customers: [
      ['name', '客户名称'],
      ['contact', '联系方式'],
      ['gameId', '游戏 ID'],
      ['remark', '备注']
    ].map(([key, label]) => ({ key, label })),
    people: [
      { key: 'name', label: '人员名称' },
      { key: 'username', label: '登录账号' }
    ]
  }
  const fieldOptions = computed(() => fields[category.value])
  const canUseHistory = computed(() => category.value === 'menu' && !searchVal.value)
  const historyMaxLength = 10

  const { searchHistory: historyResult } = storeToRefs(userStore)

  const searchInput = ref<HTMLInputElement | null>(null)
  const highlightedIndex = ref(0)
  const historyHIndex = ref(0)
  const searchResultScrollbar = ref<ScrollbarInstance>()
  const isKeyboardNavigating = ref(false) // 新增状态：是否正在使用键盘导航

  // 生命周期钩子
  onMounted(() => {
    mittBus.on('openSearchDialog', openSearchDialog)
    document.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown)
    mittBus.off('openSearchDialog', openSearchDialog)
  })

  // 键盘快捷键处理
  const handleKeydown = (event: KeyboardEvent) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    const isCommandKey = isMac ? event.metaKey : event.ctrlKey

    if (isCommandKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      showSearchDialog.value = true
      focusInput()
    }

    // 当搜索对话框打开时，处理方向键和回车键
    if (showSearchDialog.value) {
      if (
        ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key) &&
        (event.target as HTMLElement | null)?.closest?.('.el-select, .el-tabs__nav')
      )
        return
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        highlightPrevious()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        highlightNext()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        selectHighlighted()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        showSearchDialog.value = false
      }
    }
  }

  const focusInput = () => {
    setTimeout(() => {
      searchInput.value?.focus()
    }, 100)
  }

  // 搜索逻辑
  const search = (val: string) => {
    highlightedIndex.value = 0
    if (val) {
      searchResult.value = (
        category.value === 'menu'
          ? flattenAndFilterMenuItems(menuList.value, val)
          : businessMatches(val)
      ).slice(0, 30)
    } else {
      searchResult.value = []
    }
  }
  function businessMatches(value: string): SearchRoute[] {
    const q = value.toLowerCase()
    const result: SearchRoute[] = []
    if (category.value === 'orders' && can('orders.view'))
      for (const order of data.value?.orders || []) {
        const customer = data.value?.customers.find((item) => item.id === order.customerId)
        const values: Record<string, string | undefined> = {
          orderNo: order.orderNo,
          externalOrderNo: order.externalOrderNo,
          title: order.title,
          roomCode: order.roomCode,
          gameId: order.gameId,
          customerName: customer?.name,
          contact: customer?.contact
        }
        if (values[searchField.value]?.toLowerCase().includes(q))
          result.push({
            path: `/orders/list?id=${encodeURIComponent(order.id)}`,
            meta: { title: `${order.orderNo} · ${order.title}` },
            businessRecord: true,
            description: `订单 · ${customer?.name || '客户'} · ${statusLabels[order.status]}`
          })
        if (result.length >= 30) break
      }
    if (category.value === 'people' && can('users.manage'))
      for (const person of data.value?.users || []) {
        if (
          (searchField.value === 'username' ? person.username : person.name)
            .toLowerCase()
            .includes(q)
        )
          result.push({
            path: `/system/user?role=${person.role}&${searchField.value}=${encodeURIComponent(searchField.value === 'username' ? person.username : person.name)}`,
            meta: { title: person.name },
            businessRecord: true,
            description: `人员 · ${roleLabels[person.role]} · ${person.status === 'active' ? '启用' : '停用'}`
          })
        if (result.length >= 30) break
      }
    if (category.value === 'customers' && (can('users.manage') || can('orders.create')))
      for (const customer of data.value?.customers || []) {
        const values: Record<string, string> = {
          name: customer.name,
          contact: customer.contact,
          gameId: customer.gameId,
          remark: customer.remark
        }
        if (values[searchField.value]?.toLowerCase().includes(q))
          result.push({
            path: `/orders/customers?id=${encodeURIComponent(customer.id)}`,
            meta: { title: customer.name },
            businessRecord: true,
            description: `客户 · ${customer.gameId || '未填写游戏 ID'}`
          })
        if (result.length >= 30) break
      }
    return result
  }
  watch([() => data.value?.permissions.join('|'), menuList], () => {
    pruneHistory()
    if (!categories.value.some((item) => item.key === category.value)) category.value = 'menu'
    if (searchVal.value) search(searchVal.value)
  })
  watch(category, () => {
    searchField.value = fieldOptions.value[0].key
    search(searchVal.value)
  })
  watch(searchField, () => search(searchVal.value))

  const flattenAndFilterMenuItems = (items: AppRouteRecord[], val: string): AppRouteRecord[] => {
    const lowerVal = val.toLowerCase()
    const result: AppRouteRecord[] = []

    const flattenAndMatch = (item: AppRouteRecord) => {
      if (item.meta?.isHide) return
      if (item.meta.studioPermissions?.length && !item.meta.studioPermissions.some(can)) return

      const lowerItemTitle = (
        searchField.value === 'path' ? item.path : formatMenuTitle(item.meta.title)
      ).toLowerCase()

      if (item.children && item.children.length > 0) {
        item.children.forEach(flattenAndMatch)
        return
      }

      if (
        lowerItemTitle.includes(lowerVal) &&
        ((item.path && item.path.trim()) || item.meta.link || item.meta.isIframe)
      ) {
        result.push({ ...item, children: undefined })
      }
    }

    items.forEach(flattenAndMatch)
    return result
  }

  // 高亮控制并实现滚动条跟随
  const highlightPrevious = () => {
    if (
      searchVal.value
        ? !searchResult.value.length
        : !canUseHistory.value || !historyResult.value.length
    )
      return
    isKeyboardNavigating.value = true
    if (searchVal.value) {
      highlightedIndex.value =
        (highlightedIndex.value - 1 + searchResult.value.length) % searchResult.value.length
      scrollToHighlightedItem()
    } else {
      historyHIndex.value =
        (historyHIndex.value - 1 + historyResult.value.length) % historyResult.value.length
      scrollToHighlightedHistoryItem()
    }
    // 延迟重置键盘导航状态，防止立即被 hover 覆盖
    setTimeout(() => {
      isKeyboardNavigating.value = false
    }, 100)
  }

  const highlightNext = () => {
    if (
      searchVal.value
        ? !searchResult.value.length
        : !canUseHistory.value || !historyResult.value.length
    )
      return
    isKeyboardNavigating.value = true
    if (searchVal.value) {
      highlightedIndex.value = (highlightedIndex.value + 1) % searchResult.value.length
      scrollToHighlightedItem()
    } else {
      historyHIndex.value = (historyHIndex.value + 1) % historyResult.value.length
      scrollToHighlightedHistoryItem()
    }
    setTimeout(() => {
      isKeyboardNavigating.value = false
    }, 100)
  }

  const scrollToHighlightedItem = () => {
    nextTick(() => {
      if (!searchResultScrollbar.value || !searchResult.value.length) return

      const scrollWrapper = searchResultScrollbar.value.wrapRef
      if (!scrollWrapper) return

      const highlightedElements = scrollWrapper.querySelectorAll('.result .box')
      if (!highlightedElements[highlightedIndex.value]) return

      const highlightedElement = highlightedElements[highlightedIndex.value] as HTMLElement
      const itemHeight = highlightedElement.offsetHeight
      const scrollTop = scrollWrapper.scrollTop
      const containerHeight = scrollWrapper.clientHeight
      const itemTop = highlightedElement.offsetTop
      const itemBottom = itemTop + itemHeight

      if (itemTop < scrollTop) {
        searchResultScrollbar.value.setScrollTop(itemTop)
      } else if (itemBottom > scrollTop + containerHeight) {
        searchResultScrollbar.value.setScrollTop(itemBottom - containerHeight)
      }
    })
  }

  const scrollToHighlightedHistoryItem = () => {
    nextTick(() => {
      if (!searchResultScrollbar.value || !historyResult.value.length) return

      const scrollWrapper = searchResultScrollbar.value.wrapRef
      if (!scrollWrapper) return

      const historyItems = scrollWrapper.querySelectorAll('.history-result .box')
      if (!historyItems[historyHIndex.value]) return

      const highlightedElement = historyItems[historyHIndex.value] as HTMLElement
      const itemHeight = highlightedElement.offsetHeight
      const scrollTop = scrollWrapper.scrollTop
      const containerHeight = scrollWrapper.clientHeight
      const itemTop = highlightedElement.offsetTop
      const itemBottom = itemTop + itemHeight

      if (itemTop < scrollTop) {
        searchResultScrollbar.value.setScrollTop(itemTop)
      } else if (itemBottom > scrollTop + containerHeight) {
        searchResultScrollbar.value.setScrollTop(itemBottom - containerHeight)
      }
    })
  }

  const selectHighlighted = () => {
    if (searchVal.value && searchResult.value.length) {
      searchGoPage(searchResult.value[highlightedIndex.value])
    } else if (canUseHistory.value && historyResult.value.length) {
      searchGoPage(historyResult.value[historyHIndex.value])
    }
  }

  const isHighlighted = (index: number) => {
    return highlightedIndex.value === index
  }

  const searchBlur = () => {
    highlightedIndex.value = 0
  }

  const searchGoPage = (item: AppRouteRecord) => {
    showSearchDialog.value = false
    if (!(item as SearchRoute).businessRecord) addHistory(item)
    handleMenuJump(item)
    searchVal.value = ''
    searchResult.value = []
  }

  // 历史记录管理
  const updateHistory = () => {
    if (Array.isArray(historyResult.value)) {
      userStore.setSearchHistory(historyResult.value)
    }
  }
  function pruneHistory() {
    if (!menuList.value.length) return
    const allowed = new Set<string>()
    const visit = (items: AppRouteRecord[]) =>
      items.forEach((item) => {
        if (item.meta.isHide) return
        if (item.meta.studioPermissions?.length && !item.meta.studioPermissions.some(can)) return
        if (item.children?.length) visit(item.children)
        else allowed.add(item.path || String(item.meta.link || ''))
      })
    visit(menuList.value)
    const filtered = historyResult.value.filter((item: AppRouteRecord) =>
      allowed.has(item.path || String(item.meta.link || ''))
    )
    if (filtered.length !== historyResult.value.length) userStore.setSearchHistory(filtered)
  }

  const addHistory = (item: AppRouteRecord) => {
    const itemKey = item.path || String(item.meta.link || '')
    const hasItemIndex = historyResult.value.findIndex(
      (historyItem: AppRouteRecord) =>
        (historyItem.path || String(historyItem.meta.link || '')) === itemKey
    )

    if (hasItemIndex !== -1) {
      historyResult.value.splice(hasItemIndex, 1)
    } else if (historyResult.value.length >= historyMaxLength) {
      historyResult.value.pop()
    }

    const cleanedItem = { ...item, meta: { ...item.meta } }
    delete cleanedItem.children
    delete cleanedItem.meta.authList
    historyResult.value.unshift(cleanedItem)
    updateHistory()
  }

  const deleteHistory = (index: number) => {
    historyResult.value.splice(index, 1)
    updateHistory()
  }

  // 对话框控制
  const openSearchDialog = () => {
    pruneHistory()
    showSearchDialog.value = true
    focusInput()
  }

  const closeSearchDialog = () => {
    searchVal.value = ''
    searchResult.value = []
    highlightedIndex.value = 0
    historyHIndex.value = 0
  }

  // 修改 hover 高亮逻辑，只有在非键盘导航时才生效
  const highlightOnHover = (index: number) => {
    if (!isKeyboardNavigating.value && searchVal.value) {
      highlightedIndex.value = index
    }
  }

  const highlightOnHoverHistory = (index: number) => {
    if (!isKeyboardNavigating.value && canUseHistory.value) {
      historyHIndex.value = index
    }
  }
</script>
<style lang="scss" scoped>
  .layout-search {
    .search-field {
      width: 100%;
      margin-bottom: 12px;
    }

    :deep(.search-modal) {
      background-color: rgb(0 0 0 / 20%);
    }

    :deep(.el-dialog__body) {
      padding: 5px 0 0 !important;
    }

    :deep(.el-dialog__header) {
      padding: 0;
    }

    .el-input {
      :deep(.el-input__wrapper) {
        background-color: var(--art-gray-200);
        border: 1px solid var(--default-border-dashed);
        border-radius: calc(var(--custom-radius) / 2 + 2px) !important;
        box-shadow: none;
      }

      :deep(.el-input__inner) {
        color: var(--art-gray-800) !important;
      }
    }
  }

  .dark .layout-search {
    .el-input {
      :deep(.el-input__wrapper) {
        background-color: #333;
        border: 1px solid #4c4d50;
      }
    }

    :deep(.search-modal) {
      background-color: rgb(23 23 26 / 60%);
      backdrop-filter: none;
    }

    :deep(.el-dialog) {
      background-color: #252526;
    }
  }
</style>

<style scoped>
  @reference '@styles/core/tailwind.css';

  .keyboard {
    @apply mr-2 
    box-border
    h-5 
    w-5.5
    rounded
    border 
    border-g-400 
    px-1 
    text-g-500
    shadow-[0_2px_0_var(--default-border-dashed)] 
    last-of-type:mr-1.5;
  }
</style>
