<template>
  <div class="logs-page art-full-height">
    <BusinessPageHeader
      title="操作日志"
      description="追溯订单与财务处理、人员配置和业务变更，按权限查看历史前后值。"
      icon="ri:history-line"
      badge="审计留痕"
    />
    <template v-if="can('logs.view')">
      <ArtSearchBar
        v-model="search"
        :items="searchItems"
        :show-expand="true"
        @search="resetPage"
        @reset="resetSearch"
      />
      <ElCard class="art-table-card">
        <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload">
          <template #left
            ><ElTag type="info">只读审计记录</ElTag
            ><span class="ml-3 text-sm text-g-500"
              >保留操作人及修改前后内容，业务记录删除后日志仍保留。</span
            ></template
          >
        </ArtTableHeader>
        <ArtTable
          :data="tableData"
          :columns="columns"
          :loading="loading"
          :pagination="pagination"
          @pagination:size-change="handleSizeChange"
          @pagination:current-change="handleCurrentChange"
        >
          <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
          <template #operation="{ row }"
            ><ElButton link type="primary" @click="selected = row">查看前后值</ElButton></template
          >
        </ArtTable>
      </ElCard>
    </template>
    <ElCard v-else><ElEmpty description="当前账号没有日志查看权限" /></ElCard>
    <ElDialog
      :model-value="!!selected"
      title="审计记录详情"
      width="min(1040px, 94vw)"
      @close="selected = null"
    >
      <template v-if="selected">
        <ElDescriptions :column="2" border class="mb-5">
          <ElDescriptionsItem label="操作人">{{ selected.actorName }}</ElDescriptionsItem>
          <ElDescriptionsItem label="时间">{{ formatTime(selected.createdAt) }}</ElDescriptionsItem>
          <ElDescriptionsItem label="动作">{{ selected.action }}</ElDescriptionsItem>
          <ElDescriptionsItem label="业务记录"
            >{{ selected.entity }} / {{ selected.entityId }}</ElDescriptionsItem
          >
        </ElDescriptions>
        <ElRow :gutter="16">
          <ElCol :xs="24" :md="12"
            ><h3 class="mb-3 font-medium">修改前</h3
            ><pre class="audit-value">{{ pretty(selected.before) }}</pre>
          </ElCol>
          <ElCol :xs="24" :md="12"
            ><h3 class="mb-3 font-medium">修改后</h3
            ><pre class="audit-value">{{ pretty(selected.after) }}</pre>
          </ElCol>
        </ElRow>
      </template>
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { computed, onMounted, ref } from 'vue'
  import { formatTime, useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { AuditLog } from '@/types/studio'

  defineOptions({ name: 'AuditLogs' })
  const { data, loading, can, refresh } = useStudio()
  const emptySearch = () => ({
    query: '',
    actor: '',
    entity: '',
    dates: null as [string, string] | null
  })
  const search = ref(emptySearch())
  const searchItems = computed(() => [
    {
      key: 'query',
      label: '日志搜索',
      type: 'input',
      props: { clearable: true, placeholder: '动作 / 记录 ID / 修改内容' }
    },
    {
      key: 'actor',
      label: '操作人',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        options: [
          ...new Map((data.value?.logs || []).map((row) => [row.actorId, row.actorName])).entries()
        ].map(([value, label]) => ({ value, label }))
      }
    },
    {
      key: 'entity',
      label: '业务模块',
      type: 'select',
      props: {
        clearable: true,
        options: [...new Set((data.value?.logs || []).map((row) => row.entity))].map((value) => ({
          value,
          label: value
        }))
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
  const rows = computed(() =>
    (data.value?.logs || [])
      .filter((row) => {
        const date = new Date(row.createdAt).toLocaleDateString('en-CA', {
          timeZone: 'Asia/Shanghai'
        })
        return (
          (!search.value.actor || row.actorId === search.value.actor) &&
          (!search.value.entity || row.entity === search.value.entity) &&
          (!search.value.query ||
            `${row.action} ${row.entityId} ${row.actorName} ${JSON.stringify(row.before)} ${JSON.stringify(row.after)}`
              .toLowerCase()
              .includes((search.value.query || '').trim().toLowerCase())) &&
          (!search.value.dates || (date >= search.value.dates[0] && date <= search.value.dates[1]))
        )
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<AuditLog>(() => [
    { prop: 'createdAt', label: '操作时间', minWidth: 190, useSlot: true },
    { prop: 'actorName', label: '操作人', minWidth: 120 },
    { prop: 'action', label: '动作', minWidth: 160 },
    { prop: 'entity', label: '业务模块', width: 140 },
    { prop: 'entityId', label: '记录 ID', minWidth: 210, showOverflowTooltip: true },
    { prop: 'operation', label: '内容', width: 120, fixed: 'right', useSlot: true }
  ])
  const selected = ref<AuditLog | null>(null)
  function pretty(value: unknown) {
    return value == null ? '无' : JSON.stringify(value, null, 2)
  }
  function resetSearch() {
    search.value = emptySearch()
    resetPage()
  }
  async function reload() {
    try {
      await refresh()
    } catch {
      /* 页面公共错误提示保留重试入口。 */
    }
  }
  onMounted(reload)
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
</style>
