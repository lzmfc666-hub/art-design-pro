<template>
  <div class="attendance-page">
    <BusinessPageHeader
      title="排班与考勤"
      description="按日展示启用人员，可为每人设置固定班次；未登记默认为正常，实际工时单独登记。"
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
    <ElCard v-if="can('attendance.manage')" class="mb-4">
      <div class="schedule-panel-title">
        <div>
          <h3>每人固定班次</h3>
          <p class="mt-1 text-sm text-g-500"
            >设置各自的上、下班时间，支持跨夜；当天单独登记的考勤优先。</p
          >
        </div>
        <ElTag type="info">不自动登记实际工时</ElTag>
      </div>
      <div class="schedule-panel-controls mt-4">
        <ElSelect
          v-model="schedulePersonId"
          filterable
          clearable
          placeholder="选择要设置上班时间的人员"
          aria-label="固定班次人员"
          class="schedule-person-select"
        >
          <ElOption
            v-for="person in activePeople"
            :key="person.id"
            :value="person.id"
            :label="`${person.name} · ${roleLabels[person.role]}`"
          />
        </ElSelect>
        <div class="schedule-panel-summary">
          <p>{{
            schedulePersonId
              ? `当前班次：${scheduleDescription(currentSchedule)}`
              : '选择人员后可查看、调整固定班次'
          }}</p>
          <p v-if="nextSchedule" class="mt-1 text-xs text-g-500">
            {{ nextSchedule.effectiveFrom }} 起：{{ scheduleDescription(nextSchedule) }}
          </p>
        </div>
        <ElButton
          type="primary"
          :disabled="!schedulePersonId || scheduleSaving"
          @click="editSchedule()"
          >设置上班时间</ElButton
        >
      </div>
    </ElCard>
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
          >{{
            row.start && row.end ? timePart(row.start) + ' — ' + timePart(row.end) : '未安排班次'
          }}
          <ElTag v-if="timePart(row.end) < timePart(row.start)" size="small" type="info"
            >次日</ElTag
          >
          <ElTag v-if="row.synthetic && row.start" size="small" type="info" class="ml-2"
            >固定班次</ElTag
          >
        </template>
        <template #planned="{ row }"
          >{{ hours(timePart(row.start), timePart(row.end)).toFixed(2) }} h</template
        >
        <template #status="{ row }"
          ><ElTag :type="statusType(row.status)">{{
            labels[row.status as Attendance['status']]
          }}</ElTag></template
        >
        <template #actualHours="{ row }">{{
          registered(row) ? row.actualHours.toFixed(2) + ' h' : '未登记'
        }}</template>
        <template #operation="{ row }"
          ><ElButton link type="primary" @click="detailId = row.id">查看详情</ElButton
          ><ElButton
            v-if="can('attendance.manage')"
            link
            type="primary"
            :disabled="saving"
            @click="edit(row)"
            >{{ row.synthetic ? '登记考勤' : '编辑记录' }}</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <BusinessDetailPanel
      page-key="attendance-editor"
      :record-id="form.id || (form.userId ? `unregistered:${form.date}:${form.userId}` : 'new')"
      @restore="restoreAttendanceEditor"
      class="business-detail-dialog"
      v-model="open"
      :title="form.id ? '编辑考勤记录' : '新增排班与考勤'"
      width="min(940px, 94vw)"
      destroy-on-close
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <BusinessDetailHeader
        :title="data?.users.find((person) => person.id === form.userId)?.name || '排班与考勤登记'"
        description="核对人员、班次和人工工时，正常状态不会自动登记实际工时。"
        icon="ri:calendar-check-line"
        :context="form.date || '请选择班次开始日期'"
      />
      <BusinessDetailSummary
        :items="[
          { label: '当前表单状态', value: labels[form.status] },
          { label: '应出勤', value: `${plannedHours.toFixed(2)} 小时` },
          {
            label: '人工登记工时',
            value:
              canRegisterHours && form.actualHours !== null
                ? `${form.actualHours.toFixed(2)} 小时`
                : '未登记',
            hint: '核对后保存，不按工时自动计薪'
          }
        ]"
      />
      <ElForm
        ref="formRef"
        :model="form"
        :rules="rules"
        :disabled="saving"
        label-position="top"
        @submit.prevent="save"
      >
        <BusinessDetailSection
          title="人员与班次"
          description="日期归属班次开始日，跨夜下班属于次日。"
        >
          <ElFormItem label="人员" prop="userId"
            ><ElSelect v-model="form.userId" :disabled="!!form.id" filterable class="w-full"
              ><ElOption
                v-for="item in data?.users.filter(
                  (item) => item.status === 'active' || item.id === form.userId
                )"
                :key="item.id"
                :value="item.id"
                :label="item.name" /></ElSelect
          ></ElFormItem>
          <ElFormItem label="班次开始日期" prop="date"
            ><ElDatePicker
              v-model="form.date"
              :disabled="!!form.id"
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
        </BusinessDetailSection>
        <BusinessDetailSection
          title="出勤状态与实际工时"
          description="单独登记的当日考勤优先于固定班次，实际工时采用人工登记。"
        >
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
                :disabled="futureDate && key === 'present'" /></ElSelect
          ></ElFormItem>
          <ElAlert
            v-if="futureDate"
            title="未来日期可安排正常、休息或排班，实际工时需到当天或之后另行登记。"
            type="info"
            :closable="false"
            class="mb-4"
          />
          <ElFormItem label="实际工作时长（小时）">
            <ElSpace wrap
              ><ElInputNumber
                :model-value="canRegisterHours ? form.actualHours : undefined"
                :disabled="!canRegisterHours"
                :min="0"
                :precision="2"
                :step="0.01"
                controls-position="right"
                @update:model-value="changeActualHours"
              /><ElButton
                v-if="canRegisterHours && plannedHours > 0"
                link
                type="primary"
                @click="usePlannedHours"
                >按班次时长填入</ElButton
              ></ElSpace
            >
            <p class="mt-2 text-xs text-g-500 w-full">{{
              !canRegisterHours
                ? '未来日期、休息、待登记、请假与缺勤不计实际工时。'
                : form.actualHours === null
                  ? '留空表示未登记，正常状态不会自动计入实际工时。'
                  : '采用人工登记工时，调整班次不会覆盖此值。'
            }}</p>
          </ElFormItem>
          <ElAlert
            v-if="canRegisterHours && form.actualHours !== null && shiftChanged"
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
        </BusinessDetailSection>
      </ElForm>
      <template #footer
        ><ElButton :disabled="saving" @click="open = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存记录</ElButton></template
      >
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="work-schedule-editor"
      :record-id="`${scheduleForm.userId}:${scheduleForm.effectiveFrom}`"
      @restore="restoreWorkSchedule"
      class="business-detail-dialog"
      v-model="scheduleOpen"
      title="设置个人上班时间"
      width="min(940px, 94vw)"
      destroy-on-close
      :close-on-click-modal="!scheduleSaving"
      :close-on-press-escape="!scheduleSaving"
      :show-close="!scheduleSaving"
    >
      <BusinessDetailHeader
        :title="data?.users.find((person) => person.id === scheduleForm.userId)?.name || '固定班次'"
        description="按生效日期维护个人固定班次，历史版本和已有人工考勤继续保留。"
        icon="ri:calendar-check-line"
        :context="`当前表单生效日：${scheduleForm.effectiveFrom}`"
      />
      <ElForm
        ref="scheduleFormRef"
        :model="scheduleForm"
        :rules="scheduleRules"
        :disabled="scheduleSaving"
        label-position="top"
        @submit.prevent="saveSchedule"
      >
        <BusinessDetailSection
          title="生效日期与固定班次"
          description="设置仅作用于生效日起未单独登记的日期，不自动登记实际工时。"
        >
          <ElFormItem label="人员"
            ><span>{{
              data?.users.find((person) => person.id === scheduleForm.userId)?.name
            }}</span></ElFormItem
          >
          <ElFormItem label="生效日期" prop="effectiveFrom">
            <ElDatePicker
              v-model="scheduleForm.effectiveFrom"
              type="date"
              value-format="YYYY-MM-DD"
              :disabled-date="disablePastDate"
              :clearable="false"
              class="w-full"
              @change="loadScheduleVersion"
            />
          </ElFormItem>
          <ElFormItem label="固定班次">
            <ElSwitch
              v-model="scheduleForm.enabled"
              active-text="启用"
              inactive-text="不安排固定班次"
            />
          </ElFormItem>
          <ElRow v-if="scheduleForm.enabled" :gutter="16">
            <ElCol :xs="24" :sm="12"
              ><ElFormItem label="上班时间" prop="start">
                <ElTimePicker
                  v-model="scheduleForm.start"
                  format="HH:mm"
                  value-format="HH:mm"
                  class="w-full"
                /> </ElFormItem
            ></ElCol>
            <ElCol :xs="24" :sm="12"
              ><ElFormItem label="下班时间" prop="end">
                <ElTimePicker
                  v-model="scheduleForm.end"
                  format="HH:mm"
                  value-format="HH:mm"
                  class="w-full"
                /> </ElFormItem
            ></ElCol>
          </ElRow>
          <p v-if="scheduleForm.enabled" class="mb-4 text-sm text-g-500">
            班次时长 {{ hours(scheduleForm.start, scheduleForm.end).toFixed(2) }} 小时{{
              scheduleForm.end && scheduleForm.start && scheduleForm.end < scheduleForm.start
                ? '，下班时间归属次日'
                : ''
            }}。
          </p>
          <ElFormItem label="备注">
            <ElInput
              v-model="scheduleForm.remark"
              type="textarea"
              :rows="2"
              maxlength="1000"
              show-word-limit
            />
          </ElFormItem>
          <ElAlert
            title="仅影响生效日起尚未单独登记的日期；历史记录、实际工时和工资不变。休息、请假等仍在当天考勤中编辑。"
            type="info"
            :closable="false"
          />
          <p
            v-if="scheduleHistory.some((item) => item.effectiveFrom > scheduleForm.effectiveFrom)"
            class="mt-2 text-xs text-g-500"
          >
            已安排的后续版本仍按各自日期生效；需要修改时，请选择下方对应版本。
          </p>
        </BusinessDetailSection>
        <BusinessDetailSection
          v-if="scheduleHistory.length"
          title="班次设置记录"
          description="该人员全部已授权班次版本；历史版本只读，未来版本沿原入口调整。"
        >
          <ElTable :data="scheduleHistory" max-height="220" size="small">
            <ElTableColumn prop="effectiveFrom" label="生效日期" width="110" />
            <ElTableColumn label="固定班次" min-width="170"
              ><template #default="{ row }">{{ scheduleDescription(row) }}</template></ElTableColumn
            >
            <ElTableColumn label="操作" width="90"
              ><template #default="{ row }">
                <ElButton
                  v-if="row.effectiveFrom >= today()"
                  link
                  type="primary"
                  @click="editSchedule(row.effectiveFrom)"
                  >调整</ElButton
                >
                <span v-else class="text-g-500">历史</span>
              </template></ElTableColumn
            >
            <ElTableColumn prop="remark" label="备注" min-width="180" show-overflow-tooltip />
            <ElTableColumn label="更新人" min-width="120"
              ><template #default="{ row }">{{
                data?.users.find((person) => person.id === row.updatedBy)?.name || '未提供'
              }}</template></ElTableColumn
            >
            <ElTableColumn label="更新时间" min-width="175"
              ><template #default="{ row }">{{
                formatTime(row.updatedAt)
              }}</template></ElTableColumn
            >
          </ElTable>
        </BusinessDetailSection>
      </ElForm>
      <template #footer>
        <ElButton :disabled="scheduleSaving" @click="scheduleOpen = false">取消</ElButton>
        <ElButton type="primary" :loading="scheduleSaving" @click="saveSchedule">保存班次</ElButton>
      </template>
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="attendance-detail"
      :record-id="detailId"
      @restore="restoreAttendanceDetail"
      :model-value="!!detailId"
      class="business-detail-dialog"
      title="考勤详情"
      width="min(960px,94vw)"
      @update:model-value="detailId = ''"
    >
      <template v-if="attendanceDetail">
        <BusinessDetailHeader
          :title="
            data?.users.find((person) => person.id === attendanceDetail?.userId)?.name || '人员'
          "
          description="核对当前记录的班次、出勤状态和人工登记工时。"
          icon="ri:calendar-check-line"
          :badge="attendanceDetail.synthetic ? '未单独登记' : labels[attendanceDetail.status]"
          :context="attendanceDetail.date"
        />
        <BusinessDetailSummary
          :items="[
            {
              label: '应出勤工时',
              value: `${hours(timePart(attendanceDetail.start), timePart(attendanceDetail.end)).toFixed(2)} 小时`
            },
            {
              label: '实际工时',
              value: registered(attendanceDetail)
                ? `${attendanceDetail.actualHours.toFixed(2)} 小时`
                : '未登记',
              hint: '未登记不能视为已按班次完成'
            },
            {
              label: '记录来源',
              value: attendanceDetail.synthetic ? '每日展示 / 固定班次' : '单独登记考勤'
            }
          ]"
        />
        <BusinessDetailSection title="班次与状态">
          <ElDescriptions :column="2" border>
            <ElDescriptionsItem label="班次开始日期">{{
              attendanceDetail.date
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="人员角色">{{
              personRole(attendanceDetail.userId)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="上班时间">{{
              timePart(attendanceDetail.start) || '未安排'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="下班时间"
              >{{ timePart(attendanceDetail.end) || '未安排'
              }}{{
                timePart(attendanceDetail.end) < timePart(attendanceDetail.start) ? '（次日）' : ''
              }}</ElDescriptionsItem
            >
            <ElDescriptionsItem label="出勤状态">{{
              labels[attendanceDetail.status]
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="人工工时登记">{{
              registered(attendanceDetail) ? '已登记' : '未登记'
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="备注" :span="2"
              ><p class="whitespace-pre-wrap break-all">{{
                attendanceDetail.remark || '未填写'
              }}</p></ElDescriptionsItem
            >
          </ElDescriptions>
          <ElAlert
            v-if="attendanceDetail.synthetic"
            title="此行为每日展示的未登记记录，不代表实际到岗；请按原登记入口填写真实考勤。"
            type="info"
            :closable="false"
          />
        </BusinessDetailSection>
      </template>
      <ElEmpty v-else description="记录不在当前筛选范围或已无查看权限，请重新选择" />
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessStatCard from '@/components/business/BusinessStatCard.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import { computed, onMounted, reactive, ref, watch } from 'vue'
  import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
  import { roleLabels, useStudio, formatTime } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import type { Attendance, WorkSchedule } from '@/types/studio'
  type AttendanceRow = Attendance & { synthetic?: boolean }

  defineOptions({ name: 'Attendance' })
  const { data, loading, can, mutate, refresh } = useStudio()
  const activePeople = computed(() =>
    (data.value?.users || []).filter((person) => person.status === 'active')
  )
  const schedulePersonId = ref('')
  const scheduleOpen = ref(false)
  const scheduleSaving = ref(false)
  const scheduleFormRef = ref<FormInstance>()
  const scheduleForm = reactive({
    userId: '',
    effectiveFrom: today(),
    enabled: true,
    start: '09:00' as string | null,
    end: '18:00' as string | null,
    remark: ''
  })
  const scheduleRules: FormRules = {
    effectiveFrom: [{ required: true, message: '请选择生效日期', trigger: 'change' }],
    start: [{ required: true, message: '请选择上班时间', trigger: 'change' }],
    end: [{ required: true, message: '请选择下班时间', trigger: 'change' }]
  }
  const schedulesByPerson = computed(() => {
    const grouped = new Map<string, WorkSchedule[]>()
    for (const schedule of data.value?.workSchedules || []) {
      const records = grouped.get(schedule.userId) || []
      records.push(schedule)
      grouped.set(schedule.userId, records)
    }
    for (const records of grouped.values())
      records.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
    return grouped
  })
  function scheduleFor(userId: string, date: string) {
    return schedulesByPerson.value.get(userId)?.find((item) => item.effectiveFrom <= date)
  }
  const currentSchedule = computed(() => scheduleFor(schedulePersonId.value, today()))
  const nextSchedule = computed(() =>
    (schedulesByPerson.value.get(schedulePersonId.value) || []).findLast(
      (item) => item.effectiveFrom > today()
    )
  )
  const scheduleHistory = computed(() => schedulesByPerson.value.get(scheduleForm.userId) || [])
  function scheduleDescription(schedule?: WorkSchedule) {
    return schedule?.enabled
      ? `${schedule.start} — ${schedule.end}${schedule.end < schedule.start ? '（次日）' : ''}`
      : '未安排固定班次'
  }
  function disablePastDate(date: Date) {
    const calendarDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return calendarDate < today()
  }
  function loadScheduleVersion() {
    const schedule = scheduleFor(scheduleForm.userId, scheduleForm.effectiveFrom)
    Object.assign(scheduleForm, {
      enabled: schedule?.enabled ?? true,
      start: schedule?.start || '09:00',
      end: schedule?.end || '18:00',
      remark: schedule?.remark || ''
    })
    scheduleFormRef.value?.clearValidate()
  }
  function editSchedule(effectiveFrom = today()) {
    if (!can('attendance.manage') || scheduleSaving.value || !schedulePersonId.value) return
    scheduleForm.userId = schedulePersonId.value
    scheduleForm.effectiveFrom = effectiveFrom
    loadScheduleVersion()
    scheduleOpen.value = true
  }
  async function saveSchedule() {
    if (!can('attendance.manage') || scheduleSaving.value) return
    scheduleSaving.value = true
    try {
      if (!(await scheduleFormRef.value?.validate().catch(() => false))) return
      if (scheduleForm.enabled && !hours(scheduleForm.start, scheduleForm.end))
        return void ElMessage.warning('上班和下班时间不能相同，请填写有效班次')
      await mutate('/work-schedules', {
        ...scheduleForm,
        start: scheduleForm.enabled ? scheduleForm.start : '',
        end: scheduleForm.enabled ? scheduleForm.end : ''
      })
      scheduleOpen.value = false
      ElMessage.success('个人上班时间已保存，实际工时仍需单独登记')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '保存班次失败')
    } finally {
      scheduleSaving.value = false
    }
  }
  watch(
    () => can('attendance.manage'),
    (allowed) => {
      if (!allowed) {
        scheduleOpen.value = false
        open.value = false
      }
    }
  )
  const labels = {
    normal: '正常',
    rest: '休息',
    scheduled: '待登记',
    present: '到岗',
    leave: '请假',
    absent: '缺勤'
  }
  const emptySearch = () => ({
    userId: '',
    status: '',
    date: today(),
    dates: null as [string, string] | null
  })
  const search = ref(emptySearch())
  const searchItems = computed(() => [
    {
      key: 'date',
      label: '登记日期',
      type: 'date',
      props: { valueFormat: 'YYYY-MM-DD', clearable: false }
    },
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
  const rows = computed<AttendanceRow[]>(() => {
    const range = search.value.dates
    const date = range ? (range[0] === range[1] ? range[0] : null) : search.value.date || today()
    const recorded = (data.value?.attendance || []).filter((row) =>
      range ? row.date >= range[0] && row.date <= range[1] : row.date === date
    )
    const projected: AttendanceRow[] = date
      ? (data.value?.users || [])
          .filter(
            (user) => user.status === 'active' && !recorded.some((row) => row.userId === user.id)
          )
          .map((user) => {
            const schedule = scheduleFor(user.id, date)
            return {
              id: 'unregistered:' + date + ':' + user.id,
              userId: user.id,
              date,
              start: schedule?.enabled ? schedule.start : '',
              end: schedule?.enabled ? schedule.end : '',
              status: 'normal',
              actualHours: 0,
              hoursRegistered: false,
              remark: '',
              synthetic: true
            } as AttendanceRow
          })
      : []
    return [...recorded, ...projected]
      .filter(
        (row) =>
          (!search.value.userId || row.userId === search.value.userId) &&
          (!search.value.status || row.status === search.value.status)
      )
      .sort((a, b) => b.date.localeCompare(a.date))
  })
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
      value: rows.value.some(registered)
        ? rows.value
            .reduce((sum, row) => sum + (registered(row) ? row.actualHours : 0), 0)
            .toFixed(2)
        : '未登记',
      unit: rows.value.some(registered) ? '小时' : ''
    },
    {
      label: '到岗 / 请假 / 缺勤',
      value: `${rows.value.filter((row) => row.status === 'present').length} / ${rows.value.filter((row) => row.status === 'leave').length} / ${rows.value.filter((row) => row.status === 'absent').length}`,
      unit: '次'
    },
    {
      label: '实际工时未登记',
      value: rows.value.filter(
        (row) =>
          row.date <= today() && ['normal', 'present'].includes(row.status) && !registered(row)
      ).length,
      unit: '次'
    }
  ])
  const detailId = ref('')
  const attendanceDetail = computed<AttendanceRow | undefined>(
    () =>
      data.value?.attendance.find((row) => row.id === detailId.value) ||
      rows.value.find((row) => row.id === detailId.value)
  )
  function restoredAttendance(recordId?: string): AttendanceRow | undefined {
    const existing = data.value?.attendance.find((row) => row.id === recordId)
    if (existing) return existing
    const match = recordId?.match(/^unregistered:(\d{4}-\d{2}-\d{2}):(.+)$/)
    if (!match || !data.value?.users.some((person) => person.id === match[2])) return
    search.value.dates = null
    search.value.date = match[1]
    return rows.value.find((row) => row.id === recordId)
  }
  async function restoreAttendanceDetail({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      const row = restoredAttendance(recordId)
      if (row) detailId.value = row.id
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  async function restoreAttendanceEditor({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (!can('attendance.manage')) return
      if (recordId === 'new') edit()
      else {
        const row = restoredAttendance(recordId)
        if (row) edit(row)
      }
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  async function restoreWorkSchedule({
    recordId,
    isCurrent
  }: {
    recordId?: string
    isCurrent?: () => boolean
  }) {
    try {
      await refresh()
      if (isCurrent && !isCurrent()) return
      if (!can('attendance.manage') || !recordId) return
      const separator = recordId.lastIndexOf(':')
      const owner = recordId.slice(0, separator),
        effectiveFrom = recordId.slice(separator + 1)
      if (
        separator < 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) ||
        !data.value?.users.some((person) => person.id === owner)
      )
        return
      schedulePersonId.value = owner
      editSchedule(effectiveFrom)
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '详情读取失败，请返回列表重试')
    }
  }
  function personRole(id: string) {
    const person = data.value?.users.find((row) => row.id === id)
    return person ? roleLabels[person.role] : '未提供'
  }
  const { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage } =
    useBusinessTable(rows)
  const { columns, columnChecks } = useTableColumns<AttendanceRow>(() => [
    { prop: 'date', label: '班次日期', width: 130 },
    { prop: 'userId', label: '人员', minWidth: 120, useSlot: true },
    { prop: 'shift', label: '班次时间', minWidth: 200, useSlot: true },
    { prop: 'planned', label: '应出勤工时', width: 130, useSlot: true },
    { prop: 'status', label: '出勤状态', width: 110, useSlot: true },
    { prop: 'actualHours', label: '实际工时', width: 120, useSlot: true },
    { prop: 'remark', label: '备注', minWidth: 200, showOverflowTooltip: true },
    { prop: 'operation', label: '操作', width: 205, fixed: 'right', useSlot: true }
  ])
  function resetSearch() {
    search.value = emptySearch()
    resetPage()
  }
  function statusType(status: Attendance['status']) {
    return (
      {
        normal: 'primary',
        rest: 'info',
        scheduled: 'info',
        present: 'success',
        leave: 'warning',
        absent: 'danger'
      } as const
    )[status]
  }
  function today() {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date())
    const value = (key: string) => parts.find((part) => part.type === key)?.value || ''
    return value('year') + '-' + value('month') + '-' + value('day')
  }
  function timePart(value: string) {
    if (!value) return ''
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
    originalShift = ref('')
  const formRef = ref<FormInstance>()
  const emptyForm = () => ({
    id: '',
    userId: '',
    date: today(),
    start: '',
    end: '',
    status: 'normal' as Attendance['status'],
    actualHours: null as number | null,
    remark: ''
  })
  const form = reactive(emptyForm())
  const rules: FormRules = Object.fromEntries(
    ['userId', 'date'].map((key) => [
      key,
      [{ required: true, message: '此项不能为空', trigger: 'change' }]
    ])
  )
  const futureDate = computed(() => form.date > today())
  const plannedHours = computed(() => hours(form.start, form.end))
  const shiftChanged = computed(() => originalShift.value !== `${form.start}|${form.end}`)
  watch(
    () => search.value.date,
    () => {
      search.value.dates = null
      resetPage()
    }
  )
  const canRegisterHours = computed(
    () => !futureDate.value && ['normal', 'present'].includes(form.status)
  )
  function registered(row: AttendanceRow) {
    return row.date <= today() && (row.hoursRegistered ?? row.status === 'present')
  }
  watch(
    () => form.date,
    () => {
      if (futureDate.value && form.status === 'present') form.status = 'normal'
    }
  )
  function changeActualHours(value: number | undefined) {
    form.actualHours = value ?? null
  }
  function usePlannedHours() {
    form.actualHours = plannedHours.value
  }
  function edit(row?: AttendanceRow) {
    if (!can('attendance.manage') || saving.value) return
    Object.assign(
      form,
      emptyForm(),
      row
        ? {
            id: row.id,
            userId: row.userId,
            date: row.date,
            start: row.start,
            end: row.end,
            status: row.status,
            actualHours: row.actualHours,
            remark: row.remark
          }
        : {}
    )
    form.id = row?.synthetic ? '' : row?.id || ''
    if (!row) form.date = search.value.date || today()
    form.start = timePart(form.start)
    form.end = timePart(form.end)
    form.actualHours = row && registered(row) ? row.actualHours : null
    originalShift.value = `${form.start}|${form.end}`
    open.value = true
  }
  watch(
    () => [form.userId, form.date],
    () => {
      if (!open.value || form.id || !form.userId) return
      const existing = data.value?.attendance.find(
        (row) => row.userId === form.userId && row.date === form.date
      )
      if (existing) edit(existing)
      else {
        const schedule = scheduleFor(form.userId, form.date)
        form.start = schedule?.enabled ? schedule.start : ''
        form.end = schedule?.enabled ? schedule.end : ''
        originalShift.value = `${form.start}|${form.end}`
      }
    }
  )
  async function save() {
    if (!can('attendance.manage') || saving.value) return
    saving.value = true
    try {
      if (!(await formRef.value?.validate().catch(() => false))) return
      if (Boolean(form.start) !== Boolean(form.end))
        return void ElMessage.warning('上班与下班时间需要成对填写')
      if (
        (!['normal', 'rest'].includes(form.status) || form.start || form.end) &&
        !plannedHours.value
      )
        return void ElMessage.warning('请填写有效且不相同的班次起止时间')
      if (futureDate.value && form.status === 'present')
        return void ElMessage.warning('未来日期不能登记到岗')
      if (form.status === 'present' && form.actualHours === null)
        return void ElMessage.warning('请手工登记实际工时')
      if (
        canRegisterHours.value &&
        form.actualHours !== null &&
        (!Number.isFinite(form.actualHours) ||
          form.actualHours < 0 ||
          form.actualHours > (plannedHours.value || 24))
      )
        return void ElMessage.warning(`实际工时应在 0 至 ${plannedHours.value || 24} 小时之间`)
      await mutate('/attendance', {
        ...form,
        id: form.id || undefined,
        start: form.start || '',
        end: form.end || '',
        actualHours: canRegisterHours.value ? form.actualHours : form.status === 'rest' ? 0 : null
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

<style scoped lang="scss">
  .schedule-panel-title,
  .schedule-panel-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }

  .schedule-person-select {
    width: min(320px, 100%);
  }

  .schedule-panel-summary {
    flex: 1;
    min-width: 180px;
    font-size: 14px;
  }
</style>
