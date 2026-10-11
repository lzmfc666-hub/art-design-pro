<script setup lang="ts">
  import { computed, ref } from 'vue'
  import {
    ElDatePicker,
    ElDialog,
    ElEmpty,
    ElInput,
    ElOption,
    ElSelect,
    ElTable,
    ElTableColumn,
    ElTag,
    ElButton
  } from 'element-plus'
  import type { AuditLog } from '@/types/studio'
  import { formatTime, useStudio } from '../useStudio'

  const { data, can } = useStudio()
  const query = ref('')
  const actor = ref('')
  const entity = ref('')
  const dates = ref<[string, string] | null>(null)
  const selected = ref<AuditLog | null>(null)
  const entities = computed(() => [...new Set((data.value?.logs || []).map((row) => row.entity))])
  const actors = computed(() => [
    ...new Map((data.value?.logs || []).map((row) => [row.actorId, row.actorName])).entries()
  ])
  const rows = computed(() =>
    (data.value?.logs || [])
      .filter(
        (row) =>
          (!actor.value || row.actorId === actor.value) &&
          (!entity.value || row.entity === entity.value) &&
          (!query.value ||
            `${row.action} ${row.entityId} ${row.actorName} ${JSON.stringify(row.before)} ${JSON.stringify(row.after)}`
              .toLowerCase()
              .includes(query.value.toLowerCase())) &&
          (!dates.value ||
            (new Date(row.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) >=
              dates.value[0] &&
              new Date(row.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) <=
                dates.value[1]))
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  function pretty(value: unknown) {
    return value == null ? '无' : JSON.stringify(value, null, 2)
  }
</script>

<template>
  <div>
    <div class="page-heading"
      ><div
        ><h2>操作日志</h2
        ><p>审计业务修改、资金操作与权限配置，保留操作人、时间和修改前后内容。</p></div
      ><ElTag type="info">只读审计记录</ElTag></div
    >
    <div v-if="can('logs.view')" class="panel">
      <div class="toolbar"
        ><ElInput
          v-model="query"
          clearable
          placeholder="搜索动作 / 记录 ID / 修改内容"
          style="width: 290px" /><ElSelect
          v-model="actor"
          clearable
          placeholder="全部操作人"
          style="width: 170px"
          ><ElOption v-for="[id, name] in actors" :key="id" :value="id" :label="name" /></ElSelect
        ><ElSelect v-model="entity" clearable placeholder="全部模块" style="width: 160px"
          ><ElOption v-for="item in entities" :key="item" :value="item" :label="item" /></ElSelect
        ><ElDatePicker
          v-model="dates"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          style="max-width: 280px"
      /></div>
      <ElTable :data="rows" stripe
        ><ElTableColumn label="时间" min-width="180"
          ><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></ElTableColumn
        ><ElTableColumn prop="actorName" label="操作人" width="120" /><ElTableColumn
          prop="action"
          label="动作"
          min-width="170"
        /><ElTableColumn prop="entity" label="模块" width="120" /><ElTableColumn
          prop="entityId"
          label="记录 ID"
          min-width="180"
          show-overflow-tooltip
        /><ElTableColumn label="内容" width="120"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="selected = row">查看前后值</ElButton></template
          ></ElTableColumn
        ></ElTable
      >
      <p class="muted">共 {{ rows.length }} 条符合筛选的记录。原业务记录删除后，审计日志仍保留。</p>
    </div>
    <div v-else class="panel"><ElEmpty description="当前账号没有操作日志查看权限" /></div>
    <ElDialog
      :model-value="!!selected"
      title="审计记录详情"
      width="min(960px, 94vw)"
      @close="selected = null"
      ><template v-if="selected"
        ><p
          >{{ selected.actorName }} · {{ formatTime(selected.createdAt) }} ·
          {{ selected.action }}</p
        ><p class="muted">{{ selected.entity }} / {{ selected.entityId }}</p
        ><div class="logs-diff"
          ><div
            ><h4>修改前</h4><pre>{{ pretty(selected.before) }}</pre></div
          ><div
            ><h4>修改后</h4><pre>{{ pretty(selected.after) }}</pre>
          </div></div
        ></template
      ></ElDialog
    >
  </div>
</template>

<style scoped>
  .logs-diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .logs-diff pre {
    max-height: 60vh;
    padding: 18px;
    margin: 0;
    overflow: auto;
    font-size: 12px;
    line-height: 1.7;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    background: #f6f7fb;
    border-radius: 10px;
  }

  @media (width <= 680px) {
    .logs-diff {
      grid-template-columns: 1fr;
    }
  }
</style>
