<script lang="ts">
  type PanelNavigationGate = {
    index: (query: import('vue-router').LocationQuery) => number
    participates: (from: import('vue-router').RouteLocationNormalized) => boolean
    confirm: (
      to: import('vue-router').RouteLocationNormalized,
      from: import('vue-router').RouteLocationNormalized
    ) => Promise<boolean>
    accept: () => Promise<boolean>
  }
  // Transient view callbacks only. No record objects or form bodies enter navigation state.
  const pageNavigationGates = new WeakMap<object, Set<PanelNavigationGate>>()
  const pendingPageNavigation = new WeakMap<object, { key: string; result: Promise<boolean> }>()
</script>
<script setup lang="ts">
  import {
    computed,
    getCurrentInstance,
    nextTick,
    onActivated,
    onBeforeUnmount,
    onDeactivated,
    onMounted,
    ref,
    useAttrs,
    useId,
    watch
  } from 'vue'
  import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
  import type { LocationQuery, LocationQueryRaw, RouteLocationNormalized } from 'vue-router'
  import { ElButton, ElDialog, ElEmpty, ElMessage } from 'element-plus'

  defineOptions({ name: 'BusinessDetailPanel', inheritAttrs: false })
  const props = withDefaults(
    defineProps<{
      modelValue: boolean
      pageKey: string
      recordId?: string
      title?: string
      mode?: 'page' | 'dialog'
      showClose?: boolean
      closeOnPressEscape?: boolean
      beforeClose?: (done: () => void) => void | Promise<void>
      restoreError?: string
    }>(),
    { title: '', mode: 'page', showClose: true, closeOnPressEscape: true, restoreError: '' }
  )
  const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    close: []
    closed: []
    open: []
    opened: []
    restore: [value: { recordId?: string; isCurrent?: () => boolean }]
  }>()
  const route = useRoute(),
    router = useRouter(),
    attrs = useAttrs(),
    instance = getCurrentInstance()
  const ownerPath = route.path,
    titleId = `business-secondary-${useId()}`
  const mounted = ref(false),
    activated = ref(true),
    lifecycleOpen = ref(false)
  const openedRecord = ref(''),
    closing = ref(false)
  let disposed = false,
    restoreToken = '',
    restoreIssue = 0,
    navigationToken = '',
    guardToken = 0
  let pushing = false,
    approvedLocation = '',
    negotiating = false,
    stagedClose = false,
    leavingLocation = ''
  let openDepth = 0,
    initialScroll: { main: number; window: number } | null = null
  let suspendedScroll: { main: number; window: number } | null = null
  const isOwner = computed(() => activated.value && route.path === ownerPath)
  const safeKey = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value)
  const safeRecord = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
  type Entry = { key: string; record: string }
  function readStack(query: LocationQuery): Entry[] | null {
    const keys =
      query.secondary === undefined
        ? []
        : Array.isArray(query.secondary)
          ? query.secondary
          : [query.secondary]
    const records =
      query.secondaryRecord === undefined
        ? keys.map(() => '')
        : Array.isArray(query.secondaryRecord)
          ? query.secondaryRecord
          : [query.secondaryRecord]
    if (
      keys.length > 16 ||
      keys.length !== records.length ||
      !keys.every(safeKey) ||
      !records.every(safeRecord)
    )
      return null
    return keys.map((key, index) => ({ key: key as string, record: records[index] as string }))
  }
  const stack = computed(() => readStack(route.query) || [])
  const ownIndex = computed(() => stack.value.findLastIndex((entry) => entry.key === props.pageKey))
  const top = computed(() => stack.value.at(-1))
  const isTop = computed(
    () =>
      isOwner.value &&
      props.mode === 'page' &&
      top.value?.key === props.pageKey &&
      (!props.modelValue || top.value.record === openedRecord.value)
  )
  const pageVisible = computed(
    () =>
      mounted.value &&
      isOwner.value &&
      props.mode === 'page' &&
      (props.modelValue || ownIndex.value >= 0)
  )
  const blocked = computed(() => !props.showClose || !props.closeOnPressEscape)
  const pageClass = computed(() => {
    const values: string[] = []
    const visit = (value: unknown) => {
      if (typeof value === 'string') values.push(...value.split(/\s+/))
      else if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object')
        Object.entries(value).forEach(([key, enabled]) => {
          if (enabled) visit(key)
        })
    }
    visit(attrs.class)
    return values.filter((name) => name && !/^el-(?:dialog|drawer)(?:$|__|--)/.test(name))
  })
  function withStack(entries: Entry[], query = route.query): LocationQueryRaw {
    const result: LocationQueryRaw = { ...query }
    if (entries.length) {
      result.secondary = entries.map((entry) => entry.key)
      result.secondaryRecord = entries.map((entry) => entry.record)
    } else {
      delete result.secondary
      delete result.secondaryRecord
    }
    return result
  }
  function entryIndex(query: LocationQuery) {
    return (readStack(query) || []).findLastIndex(
      (entry) => entry.key === props.pageKey && entry.record === openedRecord.value
    )
  }
  const scrollPosition = () => ({
    main: document.getElementById('app-main')?.scrollTop || 0,
    window: window.scrollY
  })
  const scrollTo = (position: { main: number; window: number }) => {
    document.getElementById('app-main')?.scrollTo({ top: position.main })
    window.scrollTo({ top: position.window })
  }
  async function finishClose(update = true) {
    if (!lifecycleOpen.value) {
      stagedClose = false
      return
    }
    lifecycleOpen.value = false
    stagedClose = false
    guardToken++
    if (update) emit('update:modelValue', false)
    emit('close')
    await nextTick()
    if (initialScroll && isOwner.value && stack.value.length === openDepth) scrollTo(initialScroll)
    initialScroll = null
    suspendedScroll = null
    if (!disposed) emit('closed')
  }
  // Promise callbacks are awaited; a callback that invokes done later without returning
  // its promise can resume the original navigation once, after the first attempt is blocked.
  async function approveClose(later: () => void) {
    if (blocked.value) {
      ElMessage.warning('正在处理，请稍后返回')
      return false
    }
    if (!props.beforeClose) return true
    let approved = false,
      returned = false,
      promiseReturned = false
    const token = ++guardToken
    const done = () => {
      if (token !== guardToken || disposed) return
      approved = true
      if (returned && !promiseReturned) later()
    }
    try {
      const result = props.beforeClose(done)
      returned = true
      promiseReturned = Boolean(result && typeof result.then === 'function')
      if (promiseReturned) await result
      return approved
    } catch {
      return false
    }
  }
  async function acceptModelClose() {
    if (!props.modelValue) return true
    negotiating = true
    emit('update:modelValue', false)
    await nextTick()
    const accepted = !props.modelValue
    stagedClose = accepted
    negotiating = false
    return accepted
  }
  async function navigateOut() {
    if (!isOwner.value || props.mode !== 'page') return
    // Approval cancels the pending restore immediately, even before a browser
    // history transition has committed its target URL.
    restoreIssue++
    const index = ownIndex.value
    if (index < 0) {
      await finishClose()
      return
    }
    const target = {
      path: ownerPath,
      query: withStack(stack.value.slice(0, index)),
      hash: route.hash
    }
    const resolved = router.resolve(target).fullPath
    approvedLocation = resolved
    // Native hash navigation can leave history.state.back describing a different
    // entry from the browser's actual predecessor. An approved close must commit
    // the calculated stack target before lifecycle cleanup can allow restoration.
    // Browser Back/Forward remain separate navigations governed by the same gates.
    await router.replace(target)
  }
  async function requestClose() {
    if (closing.value || !isOwner.value) return
    closing.value = true
    const location = route.fullPath
    const later = () => {
      if (isOwner.value && route.fullPath === location)
        void (async () => {
          if (await acceptModelClose()) await navigateOut()
        })()
    }
    try {
      if ((await approveClose(later)) && (await acceptModelClose())) await navigateOut()
    } finally {
      closing.value = false
      void restoreFromRoute()
    }
  }
  async function confirmNavigation(to: RouteLocationNormalized, from: RouteLocationNormalized) {
    if (
      !activated.value ||
      props.mode !== 'page' ||
      from.path !== ownerPath ||
      !props.modelValue ||
      entryIndex(from.query) < 0
    )
      return true
    if (to.fullPath === approvedLocation) {
      approvedLocation = ''
      return true
    }
    const next = readStack(to.query) || []
    // A child may finish while this retained parent is refreshing its record.
    // Keeping the same page and record does not discard the parent's busy body.
    if (
      to.path === ownerPath &&
      next.some((entry) => entry.key === props.pageKey && entry.record === openedRecord.value)
    )
      return true
    if (blocked.value && to.fullPath !== from.fullPath) {
      ElMessage.warning('正在处理，请稍后离开')
      return false
    }
    const fromPath = from.fullPath
    const later = () => {
      if (isOwner.value && route.fullPath === fromPath)
        void (async () => {
          if (await acceptModelClose()) {
            approvedLocation = to.fullPath
            await router.push({ path: to.path, query: to.query, hash: to.hash })
          }
        })()
    }
    return approveClose(later)
  }
  const navigationGate: PanelNavigationGate = {
    index: entryIndex,
    participates: (from) =>
      !disposed &&
      activated.value &&
      props.mode === 'page' &&
      from.path === ownerPath &&
      props.modelValue &&
      entryIndex(from.query) >= 0,
    confirm: confirmNavigation,
    accept: acceptModelClose
  }
  const gateSet = pageNavigationGates.get(router) || new Set<PanelNavigationGate>()
  gateSet.add(navigationGate)
  pageNavigationGates.set(router, gateSet)
  async function guard(to: RouteLocationNormalized, from: RouteLocationNormalized) {
    if (activated.value && from.path === ownerPath && to.path !== ownerPath)
      leavingLocation = to.fullPath
    if (!navigationGate.participates(from)) return true
    const key = JSON.stringify([from.fullPath, to.fullPath])
    const pending = pendingPageNavigation.get(router)
    if (pending?.key === key) return pending.result
    const gates = [...gateSet]
      .filter((gate) => gate.participates(from))
      .sort((a, b) => b.index(from.query) - a.index(from.query))
    const closingGates = gates.filter((gate) => to.path !== from.path || gate.index(to.query) < 0)
    const result = (async () => {
      // Confirm every open layer before discarding any body. Deeper unknown intents
      // can reject navigation before an ancestor's update handler unmounts them.
      for (const gate of gates) if (!(await gate.confirm(to, from))) return false
      for (const gate of closingGates) if (!(await gate.accept())) return false
      return true
    })()
    pendingPageNavigation.set(router, { key, result })
    try {
      return await result
    } finally {
      if (pendingPageNavigation.get(router)?.result === result) pendingPageNavigation.delete(router)
    }
  }
  onBeforeRouteUpdate(guard)
  onBeforeRouteLeave(guard)
  async function pushEntry() {
    if (!mounted.value || !isOwner.value || props.mode !== 'page' || pushing || !props.modelValue)
      return
    const record = props.recordId ?? ''
    if (!safeKey(props.pageKey) || !safeRecord(record)) {
      ElMessage.error('详情标识无效，请从列表重新打开')
      await finishClose()
      return
    }
    const entries = readStack(route.query) || []
    const index = entries.findLastIndex((entry) => entry.key === props.pageKey)
    if (!initialScroll) {
      initialScroll = scrollPosition()
      openDepth = index >= 0 ? index : entries.length
    }
    openedRecord.value = record
    if (index >= 0 && entries[index].record === record) return
    const next =
      index >= 0
        ? [...entries.slice(0, index), { key: props.pageKey, record }]
        : [...entries, { key: props.pageKey, record }]
    pushing = true
    try {
      const failure = await router.push({
        path: ownerPath,
        query: withStack(next),
        hash: route.hash
      })
      if (failure && props.modelValue && isOwner.value && ownIndex.value < 0) await finishClose()
    } finally {
      pushing = false
    }
  }
  async function restoreFromRoute() {
    if (
      !mounted.value ||
      !isOwner.value ||
      props.mode !== 'page' ||
      negotiating ||
      pushing ||
      closing.value ||
      stagedClose
    )
      return
    const entries = readStack(route.query)
    if (!entries) {
      ElMessage.warning('详情地址无效，请从列表重新打开')
      await router.replace({ path: ownerPath, query: withStack([]), hash: route.hash })
      return
    }
    const index = entries.findLastIndex((entry) => entry.key === props.pageKey)
    if (index < 0 || props.modelValue) return
    const entry = entries[index],
      token = JSON.stringify([route.fullPath, entry.key, entry.record])
    if (restoreToken === token) return
    restoreToken = token
    if (instance?.vnode.props?.onRestore) {
      const issue = ++restoreIssue
      const isCurrent = () =>
        !disposed &&
        mounted.value &&
        isOwner.value &&
        props.mode === 'page' &&
        restoreToken === token &&
        restoreIssue === issue &&
        !negotiating &&
        !pushing &&
        !closing.value &&
        !stagedClose &&
        !leavingLocation &&
        stack.value.some((current) => current.key === entry.key && current.record === entry.record)
      emit('restore', { ...(entry.record ? { recordId: entry.record } : {}), isCurrent })
    } else {
      ElMessage.info('这份详情需要从上一页重新打开')
      await router.replace({
        path: ownerPath,
        query: withStack(entries.slice(0, index)),
        hash: route.hash
      })
    }
  }
  watch(
    () => [props.modelValue, props.recordId] as const,
    async ([visible], [before]) => {
      if (props.mode !== 'page') return
      if (visible) {
        openedRecord.value = props.recordId ?? ''
        const opening = !lifecycleOpen.value
        if (opening) {
          lifecycleOpen.value = true
          emit('open')
        }
        await pushEntry()
        await nextTick()
        if (opening && !disposed && lifecycleOpen.value) emit('opened')
      } else if (before || lifecycleOpen.value) {
        if (negotiating || stagedClose) return
        // A caller's successful save/permission cleanup is already authorized. Never
        // rewrite a new route after this cached page has been left.
        await nextTick()
        if (!leavingLocation && isOwner.value && entryIndex(route.query) >= 0) await navigateOut()
        await finishClose(false)
      }
    },
    { flush: 'post' }
  )
  watch(
    () => route.fullPath,
    async () => {
      const token = route.fullPath
      navigationToken = token
      if (pushing || props.mode !== 'page') return
      if (lifecycleOpen.value && (!isOwner.value || entryIndex(route.query) < 0))
        await finishClose()
      if (disposed || navigationToken !== token) return
      if (isOwner.value && ownIndex.value < 0) restoreToken = ''
      await restoreFromRoute()
    },
    { flush: 'post' }
  )
  watch(isTop, async (visible, before) => {
    if (!visible && before && props.modelValue && ownIndex.value >= 0)
      suspendedScroll = scrollPosition()
    if (visible) {
      await nextTick()
      if (isTop.value) scrollTo(suspendedScroll || { main: 0, window: 0 })
    }
  })
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isTop.value && props.closeOnPressEscape) {
      event.preventDefault()
      void requestClose()
    }
  }
  function attachKeyboard() {
    window.removeEventListener('keydown', escape)
    window.addEventListener('keydown', escape)
  }
  onMounted(async () => {
    mounted.value = true
    attachKeyboard()
    if (props.modelValue && props.mode === 'page') {
      lifecycleOpen.value = true
      openedRecord.value = props.recordId ?? ''
      emit('open')
      await pushEntry()
      if (!disposed) emit('opened')
    } else await restoreFromRoute()
  })
  onActivated(() => {
    activated.value = true
    if (mounted.value) {
      attachKeyboard()
      void restoreFromRoute()
    }
  })
  onDeactivated(() => {
    activated.value = false
    restoreToken = ''
    restoreIssue++
    window.removeEventListener('keydown', escape)
  })
  const removeBeforeEach = router.beforeEach((to, from) => {
    if (activated.value && from.path === ownerPath && to.path !== ownerPath)
      leavingLocation = to.fullPath
  })
  const removeAfterEach = router.afterEach(async (_to, _from, failure) => {
    const wasLeaving = Boolean(leavingLocation)
    leavingLocation = ''
    if (
      !failure ||
      (!stagedClose && !(wasLeaving && !props.modelValue)) ||
      disposed ||
      !isOwner.value ||
      entryIndex(route.query) < 0
    )
      return
    // A different guard may have rejected navigation after this caller approved
    // discarding its view. Restore only through the caller's original initialization.
    await finishClose(false)
    restoreToken = ''
    await restoreFromRoute()
  })
  onBeforeUnmount(() => {
    disposed = true
    guardToken++
    gateSet.delete(navigationGate)
    removeBeforeEach()
    removeAfterEach()
    window.removeEventListener('keydown', escape)
  })
  defineExpose({ close: requestClose })
</script>

<template>
  <ElDialog
    v-if="mode === 'dialog'"
    v-bind="$attrs"
    :model-value="modelValue"
    :title="title"
    :show-close="showClose"
    :close-on-press-escape="closeOnPressEscape"
    :before-close="beforeClose"
    @update:model-value="emit('update:modelValue', $event)"
    @open="emit('open')"
    @opened="emit('opened')"
    @close="emit('close')"
    @closed="emit('closed')"
  >
    <template v-if="$slots.header" #header="scope"><slot name="header" v-bind="scope" /></template>
    <slot />
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </ElDialog>
  <Teleport v-else-if="pageVisible" to="#app-main">
    <section
      v-show="isTop"
      class="business-secondary-page business-detail-page-panel"
      :class="pageClass"
      :data-secondary-page="pageKey"
      :data-page-key="pageKey"
      :aria-labelledby="titleId"
    >
      <header class="business-detail-panel-header">
        <ElButton :disabled="blocked || closing" @click="requestClose">返回上一页</ElButton>
        <div class="business-detail-panel-title">
          <slot
            name="header"
            :close="requestClose"
            :titleId="titleId"
            titleClass="business-detail-panel-heading"
          >
            <h2 :id="titleId" class="business-detail-panel-heading">{{ title }}</h2>
          </slot>
        </div>
        <ElButton
          v-if="showClose"
          circle
          aria-label="关闭详情页"
          :disabled="blocked || closing"
          @click="requestClose"
          >×</ElButton
        >
      </header>
      <div class="business-detail-panel-body">
        <slot v-if="modelValue" />
        <ElEmpty
          v-else
          :description="restoreError || '正在按当前权限读取详情，请稍候；也可返回上一页重新打开。'"
        />
      </div>
      <footer v-if="modelValue && $slots.footer" class="business-detail-panel-footer"
        ><slot name="footer"
      /></footer>
    </section>
  </Teleport>
</template>

<style scoped>
  :global(#app-main:has(> .business-secondary-page:not([style*='display: none'])) > #app-content) {
    display: none;
  }
  .business-secondary-page {
    flex: 1;
    min-width: 0;
    margin: 16px;
    color: var(--el-text-color-primary);
  }
  .business-detail-panel-header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 18px;
    border: 1px solid var(--el-border-color-light);
    border-radius: 14px 14px 0 0;
    background: var(--el-bg-color);
  }
  .business-detail-panel-title {
    flex: 1;
    min-width: 0;
  }
  .business-detail-panel-heading {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  .business-detail-panel-body {
    min-width: 0;
    padding: 20px;
    border: 1px solid var(--el-border-color-light);
    border-top: 0;
    border-radius: 0 0 14px 14px;
    background: var(--el-bg-color);
    overflow-wrap: anywhere;
  }
  .business-detail-panel-footer {
    position: sticky;
    bottom: 0;
    z-index: 40;
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 10px;
    padding: 16px 24px;
    border: 1px solid var(--el-border-color-light);
    border-radius: 12px;
    background: var(--el-bg-color);
    box-shadow: 0 -4px 16px rgb(0 0 0 / 4%);
  }
  @media (width <= 640px) {
    .business-secondary-page {
      margin: 10px;
    }
    .business-detail-panel-header {
      gap: 10px;
      padding: 14px;
      flex-wrap: wrap;
    }
    .business-detail-panel-title {
      order: 3;
      flex-basis: 100%;
    }
    .business-detail-panel-header > :last-child {
      margin-left: auto;
    }
    .business-detail-panel-body {
      padding: 14px;
    }
    .business-detail-panel-footer {
      padding: 14px 16px;
    }
  }
</style>
