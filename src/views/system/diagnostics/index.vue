<template>
  <div>
    <BusinessPageHeader
      title="数据检查"
      description="核对订单关联、打手报酬、提现及工资记录，查看异常和需要人工核对的事项。"
      icon="ri:shield-check-line"
      badge="只读检查"
    />
    <template v-if="allowed">
      <ElCard shadow="never" class="mb-4">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 class="font-medium">业务数据一致性</h3>
            <p class="mt-2 text-sm text-g-500">检查只读取现有记录，不修改订单、余额或结算结果。</p>
          </div>
          <ElButton type="primary" :loading="loading" @click="runInspection">
            {{ report ? '重新检查' : '开始数据检查' }}
          </ElButton>
        </div>
        <p v-if="report" class="mt-3 text-sm text-g-500">
          检查时间：{{ formatTime(report.generatedAt) }}
        </p>
        <ElAlert v-if="error" :title="error" type="error" :closable="false" class="mt-4" />
      </ElCard>
      <template v-if="report">
        <ElAlert
          :title="statusMessage"
          :type="
            report.status === 'error'
              ? 'error'
              : report.status === 'warning'
                ? 'warning'
                : 'success'
          "
          :closable="false"
          show-icon
          class="mb-4"
        />
        <ElRow :gutter="16" class="mb-4">
          <ElCol v-for="item in summaryCards" :key="item.label" :xs="24" :sm="8" class="mb-3">
            <ElCard shadow="never">
              <p class="text-sm text-g-500">{{ item.label }}</p>
              <p class="mt-3 text-2xl font-semibold" :class="item.color">{{ item.value }}</p>
            </ElCard>
          </ElCol>
        </ElRow>
        <ElCard class="mb-4" shadow="never">
          <h3 class="font-medium mb-3">检查项目</h3>
          <ElTable :data="report.checks" row-key="id" style="width: 100%">
            <ElTableColumn prop="label" label="检查项目" min-width="150" />
            <ElTableColumn prop="checkedRecords" label="检查记录" width="100" />
            <ElTableColumn label="结果" width="100">
              <template #default="{ row }">
                <ElTag :type="tagType(row.status)">{{ statusLabels[row.status] }}</ElTag>
              </template>
            </ElTableColumn>
            <ElTableColumn prop="errorCount" label="异常" width="80" />
            <ElTableColumn prop="warningCount" label="待核对" width="90" />
            <ElTableColumn prop="description" label="核对内容" min-width="260" />
          </ElTable>
        </ElCard>
        <ElCard class="mb-4" shadow="never">
          <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
            <h3 class="font-medium">异常与待核对事项</h3>
            <ElRadioGroup v-model="severity" size="small" aria-label="检查结果分类">
              <ElRadioButton value="all">全部</ElRadioButton>
              <ElRadioButton value="error">异常</ElRadioButton>
              <ElRadioButton value="warning">待核对</ElRadioButton>
            </ElRadioGroup>
          </div>
          <ElAlert
            v-if="report.summary.truncated"
            :title="`共发现 ${report.summary.issueCount} 项，本页先显示 ${report.summary.returnedIssues} 项，优先显示异常。核对处理后可重新检查。`"
            type="info"
            :closable="false"
            class="mb-3"
          />
          <ElTable
            :data="visibleIssues"
            row-key="id"
            empty-text="本次检查暂无此类事项"
            style="width: 100%"
          >
            <ElTableColumn label="类型" width="100">
              <template #default="{ row }">
                <ElTag :type="row.severity === 'error' ? 'danger' : 'warning'">
                  {{ row.severity === 'error' ? '异常' : '待核对' }}
                </ElTag>
              </template>
            </ElTableColumn>
            <ElTableColumn label="业务模块" min-width="130">
              <template #default="{ row }">{{ entityLabels[row.entity] || '业务记录' }}</template>
            </ElTableColumn>
            <ElTableColumn prop="entityId" label="关联记录" min-width="190" show-overflow-tooltip />
            <ElTableColumn prop="message" label="检查说明" min-width="320" />
            <ElTableColumn label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <ElButton type="primary" link @click="selectedIssueId = row.id"
                  >查看检查详情</ElButton
                >
                <ElButton
                  v-if="row.entity === 'order' && row.entityId"
                  type="primary"
                  link
                  @click="openOrder(row.entityId)"
                >
                  查看订单
                </ElButton>
                <span v-else class="text-g-500">—</span>
              </template>
            </ElTableColumn>
          </ElTable>
        </ElCard>
        <ElCard shadow="never">
          <h3 class="font-medium mb-3">检查范围</h3>
          <p v-for="note in report.scopeNotes" :key="note" class="text-sm text-g-500 mb-2">{{
            note
          }}</p>
        </ElCard>
      </template>
      <ElCard v-else-if="!loading && !error" shadow="never">
        <ElEmpty description="点击开始数据检查，生成当前数据的检查报告" />
      </ElCard>
      <BusinessDetailPanel
        v-model="issueOpen"
        page-key="diagnostic-issue"
        :record-id="selectedIssueId"
        :restore-error="inspectionRestoreError"
        @restore="restoreInspectionIssue($event)"
        title="数据检查事项详情"
        class="business-detail-dialog"
        width="min(880px, 96vw)"
      >
        <template v-if="selectedIssue">
          <BusinessDetailHeader
            :title="selectedCheck?.label || '业务数据核对'"
            description="核对本次检查发现的关联记录和说明，人工确认后回原模块处理；本窗口没有自动修复或回滚操作。"
            icon="ri:shield-check-line"
            :context="`检查时间：${formatTime(report?.generatedAt)}`"
          />
          <BusinessDetailSummary
            :items="[
              {
                label: '结果级别',
                value: selectedIssue.severity === 'error' ? '异常' : '待核对',
                tone: selectedIssue.severity === 'error' ? 'danger' : 'warning'
              },
              { label: '业务模块', value: entityLabels[selectedIssue.entity] || '业务记录' },
              { label: '检查范围记录数', value: selectedCheck?.checkedRecords ?? '—' }
            ]"
          />
          <BusinessDetailSection title="关联与核对说明"
            ><ElDescriptions :column="1" border
              ><ElDescriptionsItem label="关联记录">{{
                selectedIssue.entityId || '未提供'
              }}</ElDescriptionsItem
              ><ElDescriptionsItem label="检查说明">{{ selectedIssue.message }}</ElDescriptionsItem
              ><ElDescriptionsItem label="核对口径">{{
                selectedCheck?.description || '以本次服务端检查说明为准'
              }}</ElDescriptionsItem></ElDescriptions
            ></BusinessDetailSection
          >
          <BusinessDetailSection title="结果边界"
            ><p class="text-sm text-g-500"
              >此事项来自本次已返回检查集；服务端结果截断时仍须核对完整摘要，并在处理后重新检查。检查不改订单、资金、材料或审计。</p
            ></BusinessDetailSection
          >
        </template>
        <template #footer
          ><ElButton @click="issueOpen = false">关闭</ElButton
          ><ElButton
            v-if="selectedIssue?.entity === 'order' && selectedIssue.entityId"
            type="primary"
            @click="openOrder(selectedIssue.entityId)"
            >查看关联订单</ElButton
          ></template
        >
      </BusinessDetailPanel>
    </template>
    <ElCard v-else><ElEmpty description="当前账号没有完整业务检查权限" /></ElCard>
  </div>
</template>
<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { studioRequest } from '@/api/studio'
  import { useStudio, formatTime } from '@/hooks/business/useStudio'
  import { dataInspectionPermissions } from '@/utils/auth/studio-access'
  import type { DiagnosticsReport } from '@/types/studio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  defineOptions({ name: 'DataDiagnostics' })
  const router = useRouter()
  const { can, clearSession } = useStudio()
  const allowed = computed(() => dataInspectionPermissions.every(can))
  const report = ref<DiagnosticsReport | null>(null)
  const selectedIssueId = ref('')
  const inspectionRestoreError = ref('')
  async function restoreInspectionIssue({
    recordId: id,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    inspectionRestoreError.value = '该检查事项无法在当前结果中恢复，请返回重新检查。'
    if (!id || !allowed.value) return
    await runInspection()
    if (
      isCurrent?.() !== false &&
      allowed.value &&
      report.value?.issues.some((issue) => issue.id === id)
    ) {
      selectedIssueId.value = id
      inspectionRestoreError.value = ''
    }
  }
  const selectedIssue = computed(() =>
    allowed.value ? report.value?.issues.find((row) => row.id === selectedIssueId.value) : undefined
  )
  const selectedCheck = computed(() =>
    report.value?.checks.find((row) => row.id === selectedIssue.value?.checkId)
  )
  const issueOpen = computed({
    get: () => Boolean(selectedIssue.value),
    set: (value) => {
      if (!value) selectedIssueId.value = ''
    }
  })
  const loading = ref(false)
  const error = ref('')
  const severity = ref<'all' | 'error' | 'warning'>('all')
  let version = 0
  let controller: AbortController | undefined
  const statusLabels: Record<string, string> = { ok: '通过', warning: '待核对', error: '异常' }
  const entityLabels: Record<string, string> = {
    order: '订单',
    refund: '客户退款',
    withdrawal: '打手提现',
    wallet: '打手钱包',
    'player-adjustment': '打手扣款 / 补款',
    'reward-review': '人工报酬差额',
    'reward-credit': '打手结算',
    'customer-reference': '客户平台编号',
    'customer-order-reference': '客户平台编号',
    customer: '客户档案',
    payroll: '工资发放',
    'salary-plan': '工资方案',
    attendance: '考勤',
    'work-schedule': '固定班次',
    user: '人员',
    shop: '来源店铺',
    platform: '来源平台',
    template: '订单项目',
    attachment: '业务凭证',
    state: '业务数据'
  }
  const tagType = (status: string) =>
    status === 'error' ? 'danger' : status === 'warning' ? 'warning' : 'success'
  const statusMessage = computed(() =>
    !report.value
      ? ''
      : report.value.status === 'error'
        ? `发现 ${report.value.summary.errorCount} 项数据异常，请根据检查说明核对原始记录。`
        : report.value.status === 'warning'
          ? `未发现数据一致性异常，有 ${report.value.summary.warningCount} 项待核对事项。`
          : '本次检查通过，未发现所检查范围内的数据一致性异常。'
  )
  const summaryCards = computed(() => [
    { label: '记录核对次数', value: report.value?.summary.checkedRecords || 0, color: '' },
    { label: '数据异常', value: report.value?.summary.errorCount || 0, color: 'text-danger' },
    { label: '待核对事项', value: report.value?.summary.warningCount || 0, color: 'text-warning' }
  ])
  const visibleIssues = computed(() =>
    (report.value?.issues || []).filter(
      (issue) => severity.value === 'all' || issue.severity === severity.value
    )
  )
  async function runInspection() {
    if (!allowed.value || loading.value) return
    controller?.abort()
    controller = new AbortController()
    const requestVersion = ++version
    loading.value = true
    error.value = ''
    report.value = null
    severity.value = 'all'
    try {
      const result = await studioRequest<DiagnosticsReport>(
        'diagnostics',
        undefined,
        'GET',
        controller.signal
      )
      if (requestVersion === version && allowed.value) report.value = result
    } catch (cause) {
      if (requestVersion !== version || (cause as Error).name === 'AbortError') return
      if ((cause as { status?: number }).status === 401) clearSession()
      error.value = cause instanceof Error ? cause.message : '数据检查失败，请重试'
    } finally {
      if (requestVersion === version) loading.value = false
    }
  }
  function openOrder(id: string) {
    void router.push({ path: '/orders/list', query: { id } })
  }
  function clearReport() {
    version++
    controller?.abort()
    report.value = null
    error.value = ''
    loading.value = false
  }
  watch(allowed, (value) => {
    if (!value) clearReport()
  })
  onUnmounted(clearReport)
</script>
