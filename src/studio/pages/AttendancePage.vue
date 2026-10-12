<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import {
    ElAlert,
    ElButton,
    ElDatePicker,
    ElDialog,
    ElForm,
    ElFormItem,
    ElInput,
    ElInputNumber,
    ElMessage,
    ElOption,
    ElSelect,
    ElTable,
    ElTableColumn,
    ElTag,
    ElTimePicker
  } from 'element-plus'
  import type { Attendance } from '@/types/studio'
  import { useStudio } from '../useStudio'

  const { data, can, mutate } = useStudio()
  const queryUser = ref('')
  const status = ref('')
  const rows = computed(() =>
    (data.value?.attendance || [])
      .filter(
        (row) =>
          (!queryUser.value || row.userId === queryUser.value) &&
          (!status.value || row.status === status.value)
      )
      .sort((a, b) => b.date.localeCompare(a.date))
  )
  const totalHours = computed(() =>
    rows.value
      .filter((row) => row.status === 'present')
      .reduce((sum, row) => sum + row.actualHours, 0)
  )
  const open = ref(false)
  const saving = ref(false)
  const form = reactive({
    id: '',
    userId: '',
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    start: '09:00',
    end: '18:00',
    status: 'scheduled' as Attendance['status'],
    actualHours: 0,
    remark: ''
  })
  const manualHours = ref(false)
  const originalShift = ref('09:00|18:00')
  const labels = { scheduled: '待登记', present: '到岗', leave: '请假', absent: '缺勤' }
  const futureDate = computed(
    () => form.date > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  )
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
    const [sh, sm] = start.split(':').map(Number)
    const [eh, em] = end.split(':').map(Number)
    if ([sh, sm, eh, em].some((v) => v == null || !Number.isFinite(v))) return 0
    let minutes = eh! * 60 + em! - (sh! * 60 + sm!)
    if (minutes < 0) minutes += 24 * 60
    return Math.round((minutes / 60) * 100) / 100
  }
  const plannedHours = computed(() => hours(form.start, form.end))
  const shiftChanged = computed(() => originalShift.value !== `${form.start}|${form.end}`)
  watch(
    () => [form.start, form.end, form.status],
    () => {
      if (!manualHours.value && form.status === 'present') form.actualHours = plannedHours.value
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
    Object.assign(
      form,
      {
        id: '',
        userId: '',
        date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
        start: '09:00',
        end: '18:00',
        status: 'scheduled',
        actualHours: 0,
        remark: ''
      },
      row || {}
    )
    form.start = timePart(form.start)
    form.end = timePart(form.end)
    form.actualHours = row?.actualHours ?? 0
    manualHours.value = !!row && row.status === 'present'
    originalShift.value = `${form.start}|${form.end}`
    open.value = true
  }
  async function save() {
    if (!form.userId || !form.date || !form.start || !form.end)
      return void ElMessage.warning('请填写人员、日期和班次起止时间')
    if (!plannedHours.value) return void ElMessage.warning('班次起止时间不能相同')
    if (
      form.status === 'present' &&
      form.date > new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    )
      return void ElMessage.warning('未来班次请先保存为“待登记”，到岗后再登记实际工时')
    if (
      form.status === 'present' &&
      (!Number.isFinite(form.actualHours) ||
        form.actualHours < 0 ||
        form.actualHours > plannedHours.value)
    ) {
      return void ElMessage.warning(
        `实际工时应在 0 至 ${plannedHours.value} 小时之间，请核对班次或手工工时`
      )
    }
    saving.value = true
    try {
      await mutate('/attendance', {
        ...form,
        id: form.id || undefined,
        actualHours: form.status === 'present' ? form.actualHours : 0
      })
      open.value = false
      ElMessage.success('排班考勤已保存')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      saving.value = false
    }
  }
</script>

<template>
  <div>
    <div class="page-heading"
      ><div><h2>排班与考勤</h2><p>按人安排班次，由人事人工登记出勤，支持跨夜班次。</p></div
      ><ElButton v-if="can('attendance.manage')" type="primary" @click="edit()"
        >+ 新增排班 / 考勤</ElButton
      ></div
    >
    <div class="metric-grid"
      ><div class="metric-card"
        ><span>筛选范围出勤工时</span
        ><strong>{{ totalHours.toFixed(2) }}<small> 小时</small></strong></div
      ><div class="metric-card"
        ><span>到岗记录</span
        ><strong
          >{{ rows.filter((row) => row.status === 'present').length }}<small> 次</small></strong
        ></div
      ><div class="metric-card"
        ><span>请假 / 缺勤</span
        ><strong
          >{{ rows.filter((row) => ['leave', 'absent'].includes(row.status)).length
          }}<small> 次</small></strong
        ></div
      ><div class="metric-card"
        ><span>排班待登记</span
        ><strong
          >{{ rows.filter((row) => row.status === 'scheduled').length }}<small> 次</small></strong
        ></div
      ></div
    >
    <div class="panel">
      <div class="toolbar"
        ><ElSelect
          v-model="queryUser"
          clearable
          filterable
          placeholder="全部人员"
          style="width: 220px"
          ><ElOption
            v-for="item in data?.users"
            :key="item.id"
            :value="item.id"
            :label="item.name" /></ElSelect
        ><ElSelect v-model="status" clearable placeholder="全部出勤状态" style="width: 170px"
          ><ElOption
            v-for="(label, key) in labels"
            :key="key"
            :value="key"
            :label="label" /></ElSelect
      ></div>
      <ElAlert
        title="当前工时用于排班与考勤，不直接影响工资。尚未配置迟到、请假或缺勤扣款规则。"
        type="info"
        :closable="false"
        class="attendance-note"
      />
      <ElTable :data="rows" stripe
        ><ElTableColumn prop="date" label="班次日期" width="130" /><ElTableColumn
          label="人员"
          min-width="130"
          ><template #default="{ row }">{{
            data?.users.find((item) => item.id === row.userId)?.name || row.userId
          }}</template></ElTableColumn
        ><ElTableColumn label="班次" min-width="200"
          ><template #default="{ row }"
            >{{ timePart(row.start) }} — {{ timePart(row.end) }}
            <ElTag v-if="timePart(row.end) < timePart(row.start)" size="small" type="info"
              >次日</ElTag
            ></template
          ></ElTableColumn
        ><ElTableColumn label="出勤状态" width="110"
          ><template #default="{ row }"
            ><ElTag
              :type="
                row.status === 'present'
                  ? 'success'
                  : row.status === 'leave'
                    ? 'warning'
                    : row.status === 'scheduled'
                      ? 'info'
                      : 'danger'
              "
              >{{ labels[row.status as Attendance['status']] }}</ElTag
            ></template
          ></ElTableColumn
        ><ElTableColumn label="实际工时" width="130"
          ><template #default="{ row }">{{ row.actualHours.toFixed(2) }} h</template></ElTableColumn
        ><ElTableColumn
          prop="remark"
          label="备注"
          min-width="180"
          show-overflow-tooltip
        /><ElTableColumn v-if="can('attendance.manage')" label="操作" width="100"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="edit(row)">编辑</ElButton></template
          ></ElTableColumn
        ></ElTable
      >
    </div>
    <ElDialog
      class="studio-dialog"
      v-model="open"
      :title="form.id ? '编辑考勤记录' : '新增排班与考勤'"
      width="min(560px, 94vw)"
    >
      <ElForm label-position="top" @submit.prevent="save"
        ><ElFormItem label="人员" required
          ><ElSelect v-model="form.userId" filterable style="width: 100%"
            ><ElOption
              v-for="item in data?.users"
              :key="item.id"
              :value="item.id"
              :label="item.name" /></ElSelect></ElFormItem
        ><ElFormItem label="班次开始日期" required
          ><ElDatePicker
            v-model="form.date"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%" /></ElFormItem
        ><div class="attendance-grid"
          ><ElFormItem label="上班时间" required
            ><ElTimePicker
              v-model="form.start"
              format="HH:mm"
              value-format="HH:mm"
              style="width: 100%" /></ElFormItem
          ><ElFormItem label="下班时间" required
            ><ElTimePicker
              v-model="form.end"
              format="HH:mm"
              value-format="HH:mm"
              style="width: 100%" /></ElFormItem></div
        ><p class="muted"
          >应工作 {{ plannedHours }} 小时{{
            form.end < form.start ? '，下班时间归属次日' : ''
          }}。待登记、请假与缺勤的实际工时记为 0。</p
        ><ElFormItem label="出勤状态"
          ><ElSelect v-model="form.status" style="width: 100%"
            ><ElOption
              v-for="(label, key) in labels"
              :key="key"
              :value="key"
              :label="label"
              :disabled="key === 'present' && futureDate" /></ElSelect></ElFormItem
        ><ElFormItem label="实际工作时长（小时）" required
          ><div class="attendance-hours"
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
            ></div
          ><p class="muted">{{
            form.status !== 'present'
              ? '待登记、请假与缺勤保存为 0 小时，确认到岗后再计入实际工时。'
              : manualHours
                ? '已采用人工工时，调整班次将保留该值，请核对后保存。'
                : '当前按班次计算；手工修改后保留人工值。'
          }}</p></ElFormItem
        ><ElAlert
          v-if="form.status === 'present' && manualHours && shiftChanged"
          title="班次已变更，人工登记的实际工时已保留。请核对是否仍准确，或点击“按班次时长填入”重新计算。"
          type="warning"
          :closable="false"
          class="attendance-note" />
        <ElFormItem label="备注"
          ><ElInput
            v-model="form.remark"
            type="textarea"
            :rows="3"
            maxlength="1000"
            placeholder="填写请假原因或班次说明" /></ElFormItem
      ></ElForm>
      <template #footer
        ><ElButton @click="open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存记录</ElButton></template
      >
    </ElDialog>
  </div>
</template>

<style scoped>
  .attendance-note {
    margin-bottom: 20px;
  }

  .attendance-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .metric-card small {
    font-size: 14px;
    font-weight: 400;
  }

  .attendance-hours {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
  }
</style>
