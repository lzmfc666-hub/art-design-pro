<template>
  <div class="attendance-page">
    <BusinessPageHeader
      title="排班与考勤"
      description="先安排班次，实际到岗后登记工时；支持跨夜班次、请假和缺勤。"
      icon="ri:calendar-check-line"
    />
    <ElRow :gutter="16" class="mb-4">
      <ElCol :xs="12" :md="6" v-for="item in metrics" :key="item.label" class="mb-4">
        <BusinessStatCard
          :label="item.label"
          :value="`${item.value} ${item.unit}`"
          icon="ri:calendar-check-line"
          tone="info"
          description="按当前筛选范围统计"
        />
      </ElCol>
    </ElRow>
    <ArtSearchBar v-model="search" :items="searchItems" @search="resetPage" @reset="resetSearch" />
    <ElCard class="mt-4">
      <ArtTableHeader v-model:columns="columnChecks" :loading="loading" @refresh="reload">
        <template #left
          ><ElButton
            v-if="can('attendance.manage')"
            type="primary"
            :disabled="saving"
            @click="edit()"
            v-ripple
            >新增排班 / 考勤</ElButton
          ></template
        >
      </ArtTableHeader>
      <ElAlert
        title="支持跨夜班次。工时用于考勤统计，暂不按工时计薪，也不自动扣除请假、缺勤工资。"
        type="info"
        :closable="false"
        class="mb-4"
      />
      <ArtTable
        :data="tableData"
        :columns="columns"
        :loading="loading"
        :pagination="pagination"
        :show-table-header="false"
        height="440"
        @pagination:size-change="handleSizeChange"
        @pagination:current-change="handleCurrentChange"
      >
        <template #userId="{ row }">{{
          data?.users.find((item) => item.id === row.userId)?.name || row.userId
        }}</template>
        <template #shift="{ row }"
          >{{ timePart(row.start) }} — {{ timePart(row.end) }}
          <ElTag v-if="timePart(row.end) < timePart(row.start)" size="small" type="info"
            >次日</ElTag
          ></template
        >
        <template #planned="{ row }"
          >{{ hours(timePart(row.start), timePart(row.end)).toFixed(2) }} h</template
        >
        <template #status="{ row }"
          ><ElTag :type="statusType(row.status)">{{
            labels[row.status as Attendance['status']]
          }}</ElTag></template
        >
        <template #actualHours="{ row }">{{ row.actualHours.toFixed(2) }} h</template>
        <template #operation="{ row }"
          ><ElButton
            v-if="can('attendance.manage')"
            link
            type="primary"
            :disabled="saving"
            @click="edit(row)"
            >编辑记录</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <ElDialog
      v-model="open"
      :title="form.id ? '编辑考勤记录' : '新增排班与考勤'"
      width="min(620px, 94vw)"
      destroy-on-close
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <ElForm
        ref="formRef"
        :model="form"
        :rules="rules"
        :disabled="saving"
        label-position="top"
        @submit.prevent="save"
      >
        <ElFormItem label="人员" prop="userId"
          ><ElSelect v-model="form.userId" filterable class="w-full"
            ><ElOption
              v-for="item in data?.users"
              :key="item.id"
              :value="item.id"
              :label="item.name" /></ElSelect
        ></ElFormItem>
        <ElFormItem label="班次开始日期" prop="date"
          ><ElDatePicker
            v-model="form.date"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
        /></ElFormItem>
        <ElRow :gutter="16">
          <ElCol :xs="24" :sm="12"
            ><ElFormItem label="上班时间" prop="start"
              ><ElTimePicker
                v-model="form.start"
                format="HH:mm"
                value-format="HH:mm"
                style="width: 100%" /></ElFormItem
          ></ElCol>
          <ElCol :xs="24" :sm="12"
            ><ElFormItem label="下班时间" prop="end"
              ><ElTimePicker
                v-model="form.end"
                format="HH:mm"
                value-format="HH:mm"
                style="width: 100%" /></ElFormItem
          ></ElCol>
        </ElRow>
        <p class="mb-4 text-sm text-g-500"
          >应出勤 {{ plannedHours.toFixed(2) }} 小时{{
            form.end < form.start ? '，下班时间归属次日' : ''
          }}。</p
        >
        <ElFormItem label="出勤状态"
          ><ElSelect v-model="form.status" class="w-full"
            ><ElOption
              v-for="(label, key) in labels"
              :key="key"
              :value="key"
              :label="label"
              :disabled="futureDate && key !== 'scheduled'" /></ElSelect
        ></ElFormItem>
        <ElAlert
          v-if="futureDate"
          title="未来班次先保存为待登记，到岗后再登记出勤与实际工时。"
          type="info"
          :closable="false"
          class="mb-4"
        />
        <ElFormItem label="实际工作时长（小时）">
          <ElSpace wrap
            ><ElInputNumber
              :model-value="form.status === 'present' ? form.actualHours : 0"
              :disabled="form.status !== 'present'"
              :min="0"
              :precision="2"
              :step="0.01"
              controls-position="right"
              @update:model-value="changeActualHours"
            /><ElButton
              v-if="form.status === 'present'"
              link
              type="primary"
              @click="usePlannedHours"
              >按班次时长填入</ElButton
            ></ElSpace
          >
          <p class="mt-2 text-xs text-g-500 w-full">{{
            form.status !== 'present'
              ? '待登记、请假与缺勤的实际工时保存为 0。'
              : manualHours
                ? '当前采用人工工时，调整班次时保留人工值。'
                : '当前按班次时长计算，手工修改后保留人工值。'
          }}</p>
        </ElFormItem>
        <ElAlert
          v-if="form.status === 'present' && manualHours && shiftChanged"
          title="班次已变更，人工工时已保留。请核对后保存，或重新按班次时长填入。"
          type="warning"
          :closable="false"
          class="mb-4"
        />
        <ElFormItem label="备注"
          ><ElInput
            v-model="form.remark"
            type="textarea"
            :rows="3"
            maxlength="1000"
            show-word-limit
        /></ElFormItem>
      </ElForm>
      <template #footer
        ><ElButton :disabled="saving" @click="open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存记录</ElButton></template
      >
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import { computed, onMounted, reactive, ref, watch } from 'vue'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import { useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Attendance } from '@/types/studio'

  defineOptions({ name: 'Attendance' })
  const { data, loading, can, mutate, refresh } = useStudio()
  const labels = { scheduled: '待登记', present: '到岗', leave: '请假', absent: '缺勤' }
  const emptySearch = () => ({ userId: '', status: '', dates: null as [string, string] | null })
  const search = ref(emptySearch())
  const searchItems = computed(() => [
    {
      key: 'userId',
      label: '人员',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        options: (data.value?.users || []).map((item) => ({ value: item.id, label: item.name }))
      }
    },
    {
      key: 'status',
      label: '出勤状态',
      type: 'select',
      props: {
        clearable: true,
        options: Object.entries(labels).map(([value, label]) => ({ value, label }))
      }
    },
    {
      key: 'dates',
      label: '班次日期',
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
    (data.value?.attendance || [])
      .filter(
        (row) =>
          (!search.value.userId || row.userId === search.value.userId) &&
          (!search.value.status || row.status === search.value.status) &&
          (!search.value.dates ||
            (row.date >= search.value.dates[0] && row.date <= search.value.dates[1]))
      )
      .sort((a, b) => b.date.localeCompare(a.date))
  )
  const metrics = computed(() => [
    {
      label: '应出勤工时',
      value: rows.value
        .reduce((sum, row) => sum + hours(timePart(row.start), timePart(row.end)), 0)
        .toFixed(2),
      unit: '小时'
    },
    {
      label: '实际出勤工时',
      value: rows.value.reduce((sum, row) => sum + row.actualHours, 0).toFixed(2),
      unit: '小时'
    },
    {
      label: '到岗 / 请假 / 缺勤',
      value: `${rows.value.filter((row) => row.status === 'present').length} / ${rows.value.filter((row) => row.status === 'leave').length} / ${rows.value.filter((row) => row.status === 'absent').length}`,
      unit: '次'
    },
    {
      label: '排班待登记',
      value: rows.value.filter((row) => row.status === 'scheduled').length,
      unit: '次'
    }
  ])
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<Attendance>(() => [
    { prop: 'date', label: '班次日期', width: 130 },
    { prop: 'userId', label: '人员', minWidth: 120, useSlot: true },
    { prop: 'shift', label: '班次时间', minWidth: 200, useSlot: true },
    { prop: 'planned', label: '应出勤工时', width: 130, useSlot: true },
    { prop: 'status', label: '出勤状态', width: 110, useSlot: true },
    { prop: 'actualHours', label: '实际工时', width: 120, useSlot: true },
    { prop: 'remark', label: '备注', minWidth: 200, showOverflowTooltip: true },
    { prop: 'operation', label: '操作', width: 110, fixed: 'right', useSlot: true }
  ])
  function resetSearch() {
    search.value = emptySearch()
    resetPage()
  }
  function statusType(status: Attendance['status']) {
    return ({ scheduled: 'info', present: 'success', leave: 'warning', absent: 'danger' } as const)[
      status
    ]
  }
  function today() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  }
  function timePart(value: string) {
    if (/^\d{2}:\d{2}/.test(value)) return value.slice(0, 5)
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime())
      ? value
      : parsed.toLocaleTimeString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit'
        })
  }
  function hours(start: string | null, end: string | null) {
    if (!start || !end) return 0
    const [sh, sm] = start.split(':').map(Number),
      [eh, em] = end.split(':').map(Number)
    if ([sh, sm, eh, em].some((value) => value == null || !Number.isFinite(value))) return 0
    let minutes = eh! * 60 + em! - sh! * 60 - sm!
    if (minutes < 0) minutes += 1440
    return Math.round((minutes / 60) * 100) / 100
  }
  const open = ref(false),
    saving = ref(false),
    manualHours = ref(false),
    originalShift = ref('')
  const formRef = ref<FormInstance>()
  const emptyForm = () => ({
    id: '',
    userId: '',
    date: today(),
    start: '09:00',
    end: '18:00',
    status: 'scheduled' as Attendance['status'],
    actualHours: 0,
    remark: ''
  })
  const form = reactive(emptyForm())
  const rules: FormRules = Object.fromEntries(
    ['userId', 'date', 'start', 'end'].map((key) => [
      key,
      [{ required: true, message: '此项不能为空', trigger: 'change' }]
    ])
  )
  const futureDate = computed(() => form.date > today())
  const plannedHours = computed(() => hours(form.start, form.end))
  const shiftChanged = computed(() => originalShift.value !== `${form.start}|${form.end}`)
  watch(
    () => [form.start, form.end, form.status],
    () => {
      if (!manualHours.value && form.status === 'present') form.actualHours = plannedHours.value
    }
  )
  watch(
    () => form.date,
    () => {
      if (futureDate.value) form.status = 'scheduled'
    }
  )
  function changeActualHours(value: number | undefined) {
    manualHours.value = true
    form.actualHours = value ?? 0
  }
  function usePlannedHours() {
    form.actualHours = plannedHours.value
    manualHours.value = false
  }
  function edit(row?: Attendance) {
    if (!can('attendance.manage') || saving.value) return
    Object.assign(form, emptyForm(), row || {})
    form.start = timePart(form.start)
    form.end = timePart(form.end)
    form.actualHours = row?.actualHours ?? 0
    manualHours.value = !!row && row.status === 'present'
    originalShift.value = `${form.start}|${form.end}`
    open.value = true
  }
  async function save() {
    if (!can('attendance.manage') || saving.value) return
    saving.value = true
    try {
      if (!(await formRef.value?.validate().catch(() => false))) return
      if (!plannedHours.value) return void ElMessage.warning('班次起止时间不能相同')
      if (futureDate.value && form.status !== 'scheduled')
        return void ElMessage.warning('未来排班只能保存为待登记')
      if (
        form.status === 'present' &&
        (!Number.isFinite(form.actualHours) ||
          form.actualHours < 0 ||
          form.actualHours > plannedHours.value)
      )
        return void ElMessage.warning(`实际工时应在 0 至 ${plannedHours.value} 小时之间`)
      await mutate('/attendance', {
        ...form,
        id: form.id || undefined,
        actualHours: form.status === 'present' ? form.actualHours : 0
      })
      open.value = false
      ElMessage.success('排班考勤已保存')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      saving.value = false
    }
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
