<template>
  <div class="logs-page">
    <BusinessPageHeader
      title="操作日志"
      description="按条件查询全部有权查看的实时与归档记录，操作前后值保留审计留痕。"
      icon="ri:history-line"
      badge="只读审计"
    />
    <template v-if="can('logs.view')">
      <ElCard v-if="can('settings.manage')" class="mb-5" shadow="never" v-loading="storageLoading">
        <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div
            ><h3 class="font-medium">日志存储管理</h3
            ><p class="mt-2 text-sm text-g-500"
              >仅归档超过 {{ storage?.retentionDays ?? 90 }} 天，或超出
              {{ storage?.hotMaxRows ?? 10000 }} 条的较旧记录；近期日志保留在实时记录中。</p
            ></div
          >
          <ElSpace wrap>
            <ElButton v-if="canInspect" @click="router.push('/system/diagnostics')"
              >数据检查</ElButton
            >
            <ElButton :disabled="maintenanceBusy || !can('reports.export')" @click="exportArchive"
              >导出可见日志</ElButton
            >
            <ElButton :loading="maintenanceBusy" :disabled="maintenanceBusy" @click="archiveNow"
              >主动归档</ElButton
            >
            <ElButton
              v-if="storage?.canBackup"
              type="danger"
              plain
              :disabled="maintenanceBusy || !storage?.archiveRows"
              @click="openPurge"
              >清理已备份归档</ElButton
            >
          </ElSpace>
        </div>
        <ElDescriptions :column="2" border>
          <ElDescriptionsItem label="实时记录">{{ storage?.hotRows ?? '—' }} 条</ElDescriptionsItem>
          <ElDescriptionsItem label="归档记录"
            >{{ storage?.archiveRows ?? '—' }} 条</ElDescriptionsItem
          >
          <ElDescriptionsItem label="归档体积">{{
            bytes(storage?.archiveBytes)
          }}</ElDescriptionsItem>
          <ElDescriptionsItem label="归档容量">{{
            bytes(storage?.archiveMaxBytes)
          }}</ElDescriptionsItem>
          <ElDescriptionsItem label="实时保留规则">{{
            storage ? storage.retentionDays + ' 天 / ' + storage.hotMaxRows + ' 条' : '—'
          }}</ElDescriptionsItem>
        </ElDescriptions>
        <ElAlert
          v-if="archiveResult"
          :title="archiveResult.message"
          :type="archiveResult.type"
          :closable="false"
          class="mt-4"
        />
        <ElAlert
          v-if="storage?.warning"
          title="归档容量接近上限，请先下载并核对备份，再按日期清理已备份归档。"
          type="warning"
          :closable="false"
          class="mt-4"
        />
        <p v-if="storageError" role="alert" class="mt-3 text-sm text-danger">{{ storageError }}</p>
      </ElCard>
      <ArtSearchBar
        v-model="search"
        :items="searchItems"
        :show-expand="true"
        @search="applySearch"
        @reset="resetSearch"
      />
      <ElAlert v-if="loadError" :title="loadError" type="error" :closable="false" class="mt-4" />
      <ElCard class="art-table-card">
        <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload">
          <template #left
            ><ElSpace wrap
              ><ElRadioGroup v-model="search.source" size="small" aria-label="日志来源">
                <ElRadioButton value="all">全部日志</ElRadioButton>
                <ElRadioButton value="hot">实时日志</ElRadioButton>
                <ElRadioButton value="archive">归档日志</ElRadioButton>
              </ElRadioGroup>
              <ElTag type="info">共 {{ pagination.total }} 条符合条件记录</ElTag></ElSpace
            ></template
          >
        </ArtTableHeader>
        <ArtTable
          :data="records"
          :columns="columns"
          :loading="loading"
          :pagination="pagination"
          :empty-text="
            applied.source === 'archive'
              ? '暂无符合条件的归档日志；近期记录请切换至实时日志查看'
              : '暂无符合条件的日志，可调整筛选条件'
          "
          height="440"
          @pagination:size-change="handleSizeChange"
          @pagination:current-change="handleCurrentChange"
        >
          <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
          <template #operation="{ row }"
            ><ElButton link type="primary" :disabled="detailLoading" @click="showDetail(row.id)"
              >查看前后值</ElButton
            ></template
          >
        </ArtTable>
      </ElCard>
    </template>
    <ElCard v-else><ElEmpty description="当前账号没有日志查看权限" /></ElCard>
    <ElDialog v-model="detailOpen" title="审计记录详情" width="min(1040px, 94vw)">
      <div v-loading="detailLoading" class="min-h-30">
        <ElAlert v-if="detailError" :title="detailError" type="error" :closable="false" />
        <template v-if="selected">
          <ElDescriptions :column="2" border class="mb-5">
            <ElDescriptionsItem label="操作人">{{ selected.actorName }}</ElDescriptionsItem
            ><ElDescriptionsItem label="时间">{{
              formatTime(selected.createdAt)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="动作">{{ selected.action }}</ElDescriptionsItem
            ><ElDescriptionsItem label="业务记录"
              >{{ selected.entity }} / {{ selected.entityId }}</ElDescriptionsItem
            >
          </ElDescriptions>
          <ElRow :gutter="16"
            ><ElCol :xs="24" :md="12"
              ><h3 class="mb-3 font-medium">修改前</h3
              ><pre class="audit-value">{{ pretty(selected.before) }}</pre></ElCol
            ><ElCol :xs="24" :md="12"
              ><h3 class="mb-3 font-medium">修改后</h3
              ><pre class="audit-value">{{ pretty(selected.after) }}</pre>
            </ElCol></ElRow
          >
        </template>
      </div>
    </ElDialog>
    <ElDialog
      v-model="purge.open"
      title="完整备份与归档清理"
      width="min(640px, 94vw)"
      :close-on-click-modal="!maintenanceBusy && !backupBusy"
      :close-on-press-escape="!maintenanceBusy && !backupBusy"
      :show-close="!maintenanceBusy && !backupBusy"
    >
      <ElAlert
        title="先选择日期并下载完整原始备份，核对保存后再清理。普通可见日志导出经过脱敏，不能替代完整备份。清理无法从网站恢复，实时日志保留。"
        type="warning"
        :closable="false"
        show-icon
        class="mb-5"
      />
      <ElForm
        label-position="top"
        :disabled="maintenanceBusy || backupBusy"
        @submit.prevent="purgeArchive"
      >
        <ElFormItem label="清理此日期之前的归档" required>
          <ElDatePicker
            v-model="purge.beforeDate"
            type="date"
            value-format="YYYY-MM-DD"
            class="!w-full"
          />
        </ElFormItem>
        <ElFormItem label="完整归档备份" required>
          <ElButton
            type="primary"
            plain
            :loading="backupBusy"
            :disabled="!purge.beforeDate || maintenanceBusy || backupBusy || !storage?.canBackup"
            @click="downloadBackup"
            >下载完整归档备份</ElButton
          >
          <p v-if="purge.backupToken" class="mt-2 text-sm text-success"
            >已生成 {{ purge.backupCount }} 条记录的完整备份并开始下载，请核对文件已完整保存。</p
          >
          <p v-else class="mt-2 text-xs text-g-500"
            >完整备份完成后才可勾选确认；修改日期或归档范围变化需要重新备份。</p
          >
        </ElFormItem>
        <ElFormItem label="清理原因" required>
          <ElInput
            v-model="purge.reason"
            type="textarea"
            :rows="3"
            maxlength="1000"
            show-word-limit
          />
        </ElFormItem>
        <ElCheckbox v-model="purge.backupConfirmed" :disabled="!purge.backupToken || backupBusy"
          >我已核对并保存本次将清理记录的完整原始归档备份</ElCheckbox
        >
      </ElForm>
      <template #footer>
        <ElButton :disabled="maintenanceBusy || backupBusy" @click="purge.open = false"
          >取消</ElButton
        >
        <ElButton
          type="danger"
          :loading="maintenanceBusy"
          :disabled="
            backupBusy ||
            !purge.backupToken ||
            !purge.backupConfirmed ||
            !purge.beforeDate ||
            !purge.reason.trim()
          "
          @click="purgeArchive"
          >确认清理归档</ElButton
        >
      </template>
    </ElDialog>
  </div>
</template>
<script setup lang="ts">
  import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
  import { onBeforeRouteLeave, useRouter } from 'vue-router'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { studioRequest } from '@/api/studio'
  import { dataInspectionPermissions } from '@/utils/auth/studio-access'
  import { formatTime, useStudio } from '@/hooks/business/useStudio'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { AuditLog } from '@/types/studio'
  defineOptions({ name: 'AuditLogs' })
  interface LogPage {
    records: AuditLog[]
    total: number
    current: number
    size: number
  }
  interface LogStorage {
    hotRows: number
    archiveRows: number
    archiveBytes: number
    archiveMaxBytes: number
    retentionDays: number
    hotMaxRows: number
    warning: boolean
    canBackup: boolean
  }
  const { data, user, can, clearSession } = useStudio()
  const canInspect = computed(() => dataInspectionPermissions.every(can))
  const router = useRouter()
  const initialSearch = () => ({
    actorId: '',
    entity: '',
    entityId: '',
    action: '',
    keyword: '',
    source: 'all',
    dates: null as [string, string] | null
  })
  const search = ref(initialSearch())
  const applied = ref(initialSearch())
  const pagination = reactive({ current: 1, size: 20, total: 0 })
  const records = ref<AuditLog[]>([])
  const loading = ref(false),
    loadError = ref(''),
    storageLoading = ref(false),
    storageError = ref('')
  const storage = ref<LogStorage | null>(null)
  const maintenanceBusy = ref(false)
  const archiveResult = ref<{ type: 'success' | 'info' | 'error'; message: string } | null>(null)
  const backupBusy = ref(false)
  const purge = reactive({
    open: false,
    beforeDate: '',
    reason: '',
    backupConfirmed: false,
    backupToken: '',
    backupCount: 0
  })
  let requestVersion = 0,
    detailVersion = 0
  let controller: AbortController | undefined
  const searchItems = computed(() => [
    {
      key: 'actorId',
      label: '操作人',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        allowCreate: true,
        options: (data.value?.users || []).map((row) => ({ value: row.id, label: row.name }))
      }
    },
    {
      key: 'action',
      label: '操作动作',
      type: 'input',
      props: { clearable: true, placeholder: '按动作搜索' }
    },
    {
      key: 'entity',
      label: '业务模块',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        allowCreate: true,
        options: [
          'order',
          'refund',
          'withdrawal',
          'expense',
          'customer',
          'user',
          'attendance',
          'work-schedule',
          'platform',
          'shop',
          'template',
          'level',
          'salary-plan',
          'payroll',
          'appearance',
          'upload'
        ].map((value) => ({ value, label: value === 'work-schedule' ? '个人固定班次' : value }))
      }
    },
    {
      key: 'entityId',
      label: '业务记录ID',
      type: 'input',
      props: { clearable: true, placeholder: '独立查询记录ID' }
    },
    {
      key: 'keyword',
      label: '修改内容',
      type: 'input',
      props: { clearable: true, placeholder: '查询修改前后内容' }
    },
    {
      key: 'source',
      label: '存储位置',
      type: 'select',
      props: {
        options: [
          { value: 'all', label: '全部日志' },
          { value: 'hot', label: '实时日志' },
          { value: 'archive', label: '归档日志' }
        ]
      }
    },
    {
      key: 'dates',
      label: '操作日期',
      type: 'daterange',
      props: {
        type: 'daterange',
        valueFormat: 'YYYY-MM-DD',
        startPlaceholder: '开始日期',
        endPlaceholder: '结束日期'
      }
    }
  ])
  const { columns, columnChecks } = useTableColumns<AuditLog>(() => [
    { prop: 'createdAt', label: '操作时间', minWidth: 190, useSlot: true },
    { prop: 'actorName', label: '操作人', minWidth: 120 },
    { prop: 'action', label: '动作', minWidth: 160 },
    { prop: 'entity', label: '业务模块', width: 140 },
    { prop: 'entityId', label: '记录ID', minWidth: 210, showOverflowTooltip: true },
    { prop: 'operation', label: '内容', width: 120, fixed: 'right', useSlot: true }
  ])
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    try {
      return await studioRequest<T>(path, body, body === undefined ? 'GET' : 'POST', signal)
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) clearSession()
      throw cause
    }
  }
  async function loadRecords() {
    if (!can('logs.view')) {
      records.value = []
      return
    }
    const version = ++requestVersion
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    loadError.value = ''
    const query = new URLSearchParams({
      current: String(pagination.current),
      size: String(pagination.size),
      source: applied.value.source || 'all'
    })
    for (const key of ['actorId', 'entity', 'entityId', 'action', 'keyword'] as const)
      if (applied.value[key].trim()) query.set(key, applied.value[key].trim())
    if (applied.value.dates) {
      query.set('start', applied.value.dates[0])
      query.set('end', applied.value.dates[1])
    }
    try {
      const result = await request<LogPage>(
        'logs?' + query.toString(),
        undefined,
        controller.signal
      )
      if (version !== requestVersion) return
      records.value = result.records
      Object.assign(pagination, { total: result.total, current: result.current, size: result.size })
    } catch (cause) {
      if (version === requestVersion && (cause as Error).name !== 'AbortError') {
        loadError.value = cause instanceof Error ? cause.message : '日志加载失败'
        records.value = []
        pagination.total = 0
      }
    } finally {
      if (version === requestVersion) loading.value = false
    }
  }
  async function loadStorage() {
    if (!can('settings.manage') || !can('logs.view')) {
      storage.value = null
      return
    }
    storageLoading.value = true
    storageError.value = ''
    try {
      const result = await request<LogStorage>('logs/storage')
      if (can('settings.manage') && can('logs.view')) storage.value = result
    } catch (cause) {
      storageError.value = cause instanceof Error ? cause.message : '存储信息加载失败'
    } finally {
      storageLoading.value = false
    }
  }
  async function reload() {
    await Promise.all([loadRecords(), loadStorage()])
  }
  function applySearch() {
    applied.value = { ...search.value, dates: search.value.dates ? [...search.value.dates] : null }
    pagination.current = 1
    void loadRecords()
  }
  function resetSearch() {
    search.value = initialSearch()
    applySearch()
  }
  function handleSizeChange(size: number) {
    pagination.size = Math.min(size, 200)
    pagination.current = 1
    void loadRecords()
  }
  function handleCurrentChange(current: number) {
    pagination.current = current
    void loadRecords()
  }
  const selected = ref<AuditLog | null>(null),
    detailOpen = ref(false),
    detailLoading = ref(false),
    detailError = ref('')
  async function showDetail(id: string) {
    if (!can('logs.view')) return
    const version = ++detailVersion
    detailOpen.value = true
    detailLoading.value = true
    detailError.value = ''
    selected.value = null
    try {
      const result = await request<AuditLog>('logs/' + encodeURIComponent(id))
      if (version === detailVersion) selected.value = result
    } catch (cause) {
      if (version === detailVersion)
        detailError.value = cause instanceof Error ? cause.message : '详情加载失败'
    } finally {
      if (version === detailVersion) detailLoading.value = false
    }
  }
  function bytes(value?: number) {
    return value === undefined ? '—' : (value / 1024 / 1024).toFixed(2) + ' MB'
  }
  function pretty(value: unknown) {
    return value == null ? '无' : JSON.stringify(value, null, 2)
  }
  function exportArchive() {
    if (can('reports.export'))
      void router.push({
        path: '/reports/export',
        query: { module: 'logs', periodType: 'total', archived: 'archive' }
      })
  }
  function openPurge() {
    if (maintenanceBusy.value || backupBusy.value || !storage.value?.canBackup) return
    Object.assign(purge, {
      open: true,
      beforeDate: '',
      reason: '',
      backupConfirmed: false,
      backupToken: '',
      backupCount: 0
    })
  }
  watch(
    () => purge.beforeDate,
    () => {
      purge.backupToken = ''
      purge.backupConfirmed = false
      purge.backupCount = 0
    }
  )
  watch(
    () => storage.value?.canBackup,
    (allowed) => {
      if (allowed === false) {
        purge.open = false
        purge.backupToken = ''
        purge.backupConfirmed = false
      }
    }
  )
  async function downloadBackup() {
    if (backupBusy.value || maintenanceBusy.value || !storage.value?.canBackup || !purge.beforeDate)
      return
    const beforeDate = purge.beforeDate
    backupBusy.value = true
    purge.backupToken = ''
    purge.backupConfirmed = false
    try {
      const response = await fetch(
        '/api/studio/logs/archive-backup?beforeDate=' + encodeURIComponent(beforeDate),
        { credentials: 'same-origin' }
      )
      if (!response.ok) {
        if (response.status === 401) clearSession()
        const error = await response.json().catch(() => ({}))
        throw new Error(error.message || '完整归档备份失败')
      }
      const token = response.headers.get('X-Studio-Backup-Token')
      const countHeader = response.headers.get('X-Studio-Backup-Count')
      const count = Number(countHeader)
      const blob = await response.blob()
      if (
        !token ||
        countHeader === null ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        purge.beforeDate !== beforeDate
      )
        throw new Error('备份凭据或日期无效，请重新下载完整备份')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'studio-audit-archive-before-' + beforeDate + '.json'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      purge.backupToken = token
      purge.backupCount = count
      ElMessage.success('完整备份已开始下载，请核对文件并确认已保存')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '备份失败')
      await loadStorage()
    } finally {
      backupBusy.value = false
    }
  }
  async function archiveNow() {
    if (maintenanceBusy.value || !can('settings.manage') || !can('logs.view')) return
    maintenanceBusy.value = true
    archiveResult.value = null
    try {
      const result = await request<{ affectedRows: number; storage: LogStorage }>(
        'logs/maintenance',
        { action: 'archive' }
      )
      storage.value = result.storage
      archiveResult.value = {
        type: result.affectedRows ? 'success' : 'info',
        message: result.affectedRows
          ? `本次已归档 ${result.affectedRows} 条记录，日志已保留，可切换至“归档日志”查看。`
          : `本次归档 0 条：暂无超过 ${result.storage.retentionDays} 天或超出 ${result.storage.hotMaxRows} 条保留数量的实时日志，无需归档。`
      }
      pagination.current = 1
      await reload()
      if (result.affectedRows) ElMessage.success(`已归档 ${result.affectedRows} 条记录`)
      else ElMessage.info('暂无符合规则的记录，已保留近期实时日志')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '归档失败'
      archiveResult.value = { type: 'error', message }
      ElMessage.error(message)
    } finally {
      maintenanceBusy.value = false
    }
  }
  async function purgeArchive() {
    if (
      maintenanceBusy.value ||
      backupBusy.value ||
      !storage.value?.canBackup ||
      !purge.backupToken ||
      !can('settings.manage') ||
      !can('logs.view') ||
      !purge.backupConfirmed ||
      !purge.beforeDate ||
      !purge.reason.trim()
    )
      return
    maintenanceBusy.value = true
    try {
      await ElMessageBox.confirm(
        '确认已保存完整备份，并永久删除 ' + purge.beforeDate + ' 之前的归档记录？',
        '确认清理归档',
        {
          type: 'warning',
          confirmButtonText: '已备份，确认清理',
          cancelButtonText: '继续核对',
          closeOnClickModal: false
        }
      )
      await request('logs/maintenance', {
        action: 'purge-archive',
        beforeDate: purge.beforeDate,
        backupConfirmed: true,
        backupToken: purge.backupToken,
        reason: purge.reason.trim()
      })
      purge.open = false
      purge.backupConfirmed = false
      pagination.current = 1
      await reload()
      ElMessage.success('指定日期之前的归档已清理，实时日志保留')
    } catch (cause) {
      if (cause !== 'cancel' && cause !== 'close')
        ElMessage.error(cause instanceof Error ? cause.message : '清理失败')
      if ((cause as { status?: number })?.status === 409) {
        purge.backupToken = ''
        purge.backupConfirmed = false
        purge.backupCount = 0
      }
    } finally {
      maintenanceBusy.value = false
    }
  }
  watch(
    () => search.value.source,
    (source) => {
      applied.value.source = source
      pagination.current = 1
      void loadRecords()
    }
  )
  watch(
    () => can('logs.view'),
    (allowed) => {
      if (!allowed) {
        requestVersion++
        detailVersion++
        controller?.abort()
        records.value = []
        selected.value = null
        detailOpen.value = false
        storage.value = null
        archiveResult.value = null
        purge.open = false
      }
    }
  )
  watch(
    () => can('settings.manage'),
    (allowed) => {
      if (!allowed) purge.open = false
    }
  )
  onBeforeRouteLeave(() => !user.value || (!maintenanceBusy.value && !backupBusy.value))
  onMounted(() => void reload())
  onUnmounted(() => {
    requestVersion++
    detailVersion++
    controller?.abort()
  })
</script>
<style scoped>
  .audit-value {
    max-height: 55vh;
    padding: 16px;
    margin-bottom: 16px;
    overflow: auto;
    font-size: 12px;
    line-height: 1.7;
    color: var(--el-text-color-primary);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    background: var(--el-fill-color-light);
    border-radius: 8px;
  }

  :deep(.el-checkbox__label) {
    white-space: normal;
  }

  @media (width <= 640px) {
    :deep(.el-descriptions__label) {
      width: 90px;
    }

    :deep(.el-descriptions__content) {
      overflow-wrap: anywhere;
    }
  }
</style>
