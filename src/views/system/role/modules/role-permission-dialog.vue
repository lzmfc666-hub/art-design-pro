<template>
  <BusinessDetailPanel
    v-model="visible"
    page-key="role-permissions"
    :record-id="role"
    @restore="emit('restore', $event.recordId)"
    :title="`${roleLabels[role]} · 默认权限`"
    width="min(940px, 96vw)"
    class="business-detail-dialog"
  >
    <BusinessDetailHeader
      description="按业务分类查看服务器定义的岗位默认授权，区分岗位默认与个人额外允许或禁止。"
      icon="ri:user-settings-line"
      :context="`角色编码：${role}`"
      badge="只读权限明细"
    />
    <BusinessDetailSummary
      :items="[
        { label: '默认允许', value: rows.filter((row) => row.enabled).length, tone: 'primary' },
        { label: '默认禁止', value: rows.filter((row) => !row.enabled).length },
        { label: '权限项目', value: rows.length, hint: '完整岗位定义，不受下方筛选影响' }
      ]"
    />
    <ElAlert
      class="mb-4"
      type="info"
      :closable="false"
      title="这些权限由服务器校验。个人允许或禁止覆盖在人员档案中设置。"
    />
    <BusinessDetailSection
      title="业务权限明细"
      description="筛选只改变当前展示；实际访问和提交仍由服务器逐次核验。"
    >
      <ElSpace wrap class="mb-4"
        ><ElInput
          v-model="keyword"
          placeholder="搜索功能名称或权限标识"
          clearable
          aria-label="搜索默认权限"
        /><ElSelect v-model="category" aria-label="权限分类" style="width: 180px"
          ><ElOption label="全部业务分类" value="all" /><ElOption
            label="订单业务"
            value="orders" /><ElOption label="财务与报表" value="finance" /><ElOption
            label="人员与考勤"
            value="people" /><ElOption label="系统与配置" value="system" /></ElSelect
        ><ElTag effect="plain">筛选后 {{ filteredRows.length }} 项</ElTag></ElSpace
      >
      <ElTable :data="filteredRows" max-height="470">
        <ElTableColumn prop="label" label="业务功能" min-width="150" />
        <ElTableColumn prop="key" label="权限标识" min-width="180" />
        <ElTableColumn label="默认授权" width="100"
          ><template #default="{ row }"
            ><ElTag :type="row.enabled ? 'success' : 'info'">{{
              row.enabled ? '允许' : '禁止'
            }}</ElTag></template
          ></ElTableColumn
        >
      </ElTable>
    </BusinessDetailSection>
    <template #footer><ElButton type="primary" @click="visible = false">关闭</ElButton></template>
  </BusinessDetailPanel>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, ref, watch } from 'vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import type { Role } from '@/types/studio'
  import { roleLabels, useStudio } from '@/hooks/business/useStudio'
  import { permissionLabels } from '../../user/modules/permissions'

  const visible = defineModel<boolean>({ required: true })
  const props = defineProps<{ role: Role }>()
  const emit = defineEmits<{ restore: [role: string | undefined] }>()
  const { data } = useStudio()
  const keyword = ref('')
  const category = ref('all')
  const rows = computed(() =>
    Object.entries(permissionLabels).map(([key, label]) => ({
      key,
      label,
      enabled: data.value?.roleDefaults?.[props.role]?.includes(key) ?? false
    }))
  )
  const filteredRows = computed(() =>
    rows.value.filter((row) => {
      const query = keyword.value.trim().toLowerCase()
      const group = row.key.startsWith('orders.')
        ? 'orders'
        : /^(finance|salary|profit|reports)\./.test(row.key)
          ? 'finance'
          : /^(users|attendance)\./.test(row.key)
            ? 'people'
            : 'system'
      return (
        (category.value === 'all' || group === category.value) &&
        `${row.key} ${row.label}`.toLowerCase().includes(query)
      )
    })
  )
  watch(
    () => props.role,
    () => {
      keyword.value = ''
      category.value = 'all'
    }
  )
</script>
