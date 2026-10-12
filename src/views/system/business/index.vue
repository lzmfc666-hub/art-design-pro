<template>
  <div class="business-page">
    <BusinessPageHeader
      title="业务配置"
      description="维护订单项目、平台店铺和打手等级，新增业务沿用最新配置。"
      icon="ri:gamepad-line"
      badge="历史订单保留快照"
    />
    <ElCard class="mb-4" shadow="never">
      <ElTabs v-model="tab"
        ><ElTabPane name="templates" label="订单项目 / 模板" /><ElTabPane
          name="sources"
          label="来源平台与店铺" /><ElTabPane name="levels" label="打手等级"
      /></ElTabs>
      <p class="text-sm text-g-500">配置用于新订单，已创建订单保留原模板快照和业务归属。</p>
    </ElCard>
    <template v-if="tab === 'templates'">
      <ArtSearchBar
        v-model="search"
        :items="searchItems"
        @search="templateTable.resetPage"
        @reset="resetSearch"
      />
      <ElCard class="mt-4">
        <ArtTableHeader
          v-model:columns="templateColumns.columnChecks.value"
          :loading="loading"
          @refresh="reload"
        >
          <template #left
            ><ElButton
              v-if="can('templates.manage')"
              type="primary"
              :disabled="saving"
              @click="editTemplate()"
              v-ripple
              >新增订单项目</ElButton
            ><span class="ml-3 text-sm text-g-500"
              >空白价格表示待配置，下单时必须填写有效金额。</span
            ></template
          >
        </ArtTableHeader>
        <ArtTable
          :data="templateTable.tableData.value"
          :columns="templateColumns.columns.value"
          :loading="loading"
          :pagination="templateTable.pagination"
          height="440"
          @pagination:size-change="templateTable.handleSizeChange"
          @pagination:current-change="templateTable.handleCurrentChange"
        >
          <template #amount="{ row }">{{ money(row.amount) }}</template
          ><template #reward="{ row }">{{ money(row.reward) }}</template>
          <template #active="{ row }"
            ><ElTag :type="row.active ? 'success' : 'info'">{{
              row.active ? '启用' : '停用'
            }}</ElTag></template
          >
          <template #operation="{ row }"
            ><ElButton
              v-if="can('templates.manage')"
              link
              type="primary"
              :disabled="saving"
              @click="editTemplate(row)"
              >编辑配置</ElButton
            ></template
          >
        </ArtTable>
      </ElCard>
    </template>
    <template v-else-if="tab === 'sources'">
      <ElCard class="mb-4">
        <ArtTableHeader
          v-model:columns="platformColumns.columnChecks.value"
          :loading="loading"
          @refresh="reload"
        >
          <template #left
            ><ElButton
              v-if="can('settings.manage')"
              type="primary"
              :disabled="saving"
              @click="editPlatform()"
              v-ripple
              >新增来源平台</ElButton
            ><span class="ml-3 text-sm text-g-500"
              >各来源独立配置下单规则；运营提成比例由财务维护。</span
            ></template
          >
        </ArtTableHeader>
        <ArtTable
          :data="platformTable.tableData.value"
          :columns="platformColumns.columns.value"
          :loading="loading"
          :pagination="platformTable.pagination"
          height="280"
          @pagination:size-change="platformTable.handleSizeChange"
          @pagination:current-change="platformTable.handleCurrentChange"
        >
          <template #rules="{ row }"
            ><ElSpace wrap
              ><ElTag
                v-for="rule in platformRuleLabels.filter((item) => rulesForPlatform(row)[item.key])"
                :key="rule.key"
                size="small"
                type="info"
                >{{ rule.label }}</ElTag
              ></ElSpace
            ></template
          >
          <template #operation="{ row }"
            ><ElButton
              v-if="can('settings.manage')"
              link
              type="primary"
              :disabled="saving"
              @click="editPlatform(row)"
              >编辑平台</ElButton
            ></template
          >
        </ArtTable>
      </ElCard>
      <ElCard>
        <ArtTableHeader
          v-model:columns="shopColumns.columnChecks.value"
          :loading="loading"
          @refresh="reload"
        >
          <template #left
            ><ElButton
              v-if="can('settings.manage')"
              type="primary"
              :disabled="saving || !shopPlatforms.length"
              @click="editShop()"
              v-ripple
              >新增来源店铺</ElButton
            ></template
          >
        </ArtTableHeader>
        <ArtTable
          :data="shopTable.tableData.value"
          :columns="shopColumns.columns.value"
          :loading="loading"
          :pagination="shopTable.pagination"
          :show-table-header="false"
          height="240"
          @pagination:size-change="shopTable.handleSizeChange"
          @pagination:current-change="shopTable.handleCurrentChange"
        >
          <template #platformId="{ row }">{{
            data?.platforms.find((item) => item.id === row.platformId)?.name || row.platformId
          }}</template>
          <template #operation="{ row }"
            ><ElButton
              v-if="can('settings.manage')"
              link
              type="primary"
              :disabled="saving"
              @click="editShop(row)"
              >编辑店铺</ElButton
            ></template
          >
        </ArtTable>
      </ElCard>
    </template>
    <ElCard v-else>
      <ArtTableHeader
        v-model:columns="levelColumns.columnChecks.value"
        :loading="loading"
        @refresh="reload"
      >
        <template #left
          ><ElButton
            v-if="can('settings.manage')"
            type="primary"
            :disabled="saving"
            @click="editLevel()"
            v-ripple
            >新增等级</ElButton
          ></template
        >
      </ArtTableHeader>
      <ElAlert
        title="公共抢单池按发布时间计算等级开放延迟；等级开放后持续可接单，直接指派采用指定负责人流程。"
        type="info"
        :closable="false"
        class="mb-4"
      />
      <ArtTable
        :data="levelTable.tableData.value"
        :columns="levelColumns.columns.value"
        :loading="loading"
        :pagination="levelTable.pagination"
        :show-table-header="false"
        height="360"
        @pagination:size-change="levelTable.handleSizeChange"
        @pagination:current-change="levelTable.handleCurrentChange"
      >
        <template #delaySeconds="{ row }">{{
          row.delaySeconds === 0 ? '立即开放' : `发布 ${row.delaySeconds} 秒后开放`
        }}</template>
        <template #operation="{ row }"
          ><ElButton
            v-if="can('settings.manage')"
            link
            type="primary"
            :disabled="saving"
            @click="editLevel(row)"
            >编辑规则</ElButton
          ></template
        >
      </ArtTable>
    </ElCard>
    <ElDialog
      :model-value="!!open"
      :title="dialogTitle"
      width="min(640px, 94vw)"
      destroy-on-close
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @close="open = ''"
    >
      <ElForm :disabled="saving" label-position="top" @submit.prevent="save">
        <template v-if="open === 'template'">
          <ElFormItem label="项目名称" required
            ><ElInput v-model="template.name" maxlength="100" placeholder="例如 70 788w / 娱乐单"
          /></ElFormItem>
          <ElFormItem label="游戏" required
            ><ElInput v-model="template.game" maxlength="100"
          /></ElFormItem>
          <ElFormItem label="规格 / 目标"
            ><ElInput v-model="template.description" maxlength="500"
          /></ElFormItem>
          <ElRow :gutter="16"
            ><ElCol :xs="24" :sm="12"
              ><ElFormItem label="客户价格（元）"
                ><BusinessAmount v-model="template.amount" /></ElFormItem></ElCol
            ><ElCol :xs="24" :sm="12"
              ><ElFormItem label="整单打手报酬（元）"
                ><BusinessAmount v-model="template.reward" /></ElFormItem></ElCol
          ></ElRow>
          <ElFormItem label="默认地图"
            ><ElInput v-model="template.map" maxlength="100"
          /></ElFormItem>
          <ElFormItem label="默认打手可见备注"
            ><ElInput
              v-model="template.remark"
              type="textarea"
              :rows="3"
              maxlength="2000"
              show-word-limit
          /></ElFormItem>
          <ElFormItem label="项目状态"
            ><ElSwitch v-model="template.active" active-text="启用" inactive-text="停用"
          /></ElFormItem>
          <p class="text-sm text-g-500"
            >未确定的价格保持留空。停用后不可用于创建新订单，已有订单保持原快照。</p
          >
        </template>
        <template v-else-if="open === 'platform'">
          <ElFormItem label="来源平台名称" required
            ><ElInput v-model="platform.name" maxlength="60"
          /></ElFormItem>
          <ElFormItem v-for="rule in platformRuleLabels" :key="rule.key" :label="rule.label"
            ><ElSwitch v-model="platform.rules[rule.key]" /></ElFormItem
          ><ElAlert
            title="所有来源都可建立店铺；运营提成比例由财务在工资方案中维护，填 0 表示不计提。"
            type="info"
            :closable="false"
          />
        </template>
        <template v-else-if="open === 'shop'">
          <ElFormItem label="店铺名称" required
            ><ElInput v-model="shop.name" maxlength="60"
          /></ElFormItem>
          <p class="text-xs text-g-500 mb-4"
            >店铺名称只需在同一来源内唯一，不同来源可使用同名店铺。</p
          >
          <ElFormItem label="所属平台" required
            ><ElSelect v-model="shop.platformId" class="w-full"
              ><ElOption
                v-for="item in shopPlatforms"
                :key="item.id"
                :value="item.id"
                :label="item.name" /></ElSelect
          ></ElFormItem>
        </template>
        <template v-else-if="open === 'level'">
          <ElFormItem label="等级名称" required
            ><ElInput v-model="level.name" maxlength="60"
          /></ElFormItem>
          <ElFormItem label="公共抢单池开放延迟（秒）"
            ><ElInputNumber
              v-model="level.delaySeconds"
              :min="0"
              :max="86400"
              :precision="0"
              controls-position="right"
          /></ElFormItem>
        </template>
      </ElForm>
      <template #footer
        ><ElButton :disabled="saving" @click="open = ''">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存配置</ElButton></template
      >
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { computed, onMounted, reactive, ref } from 'vue'
  import { ElMessage } from 'element-plus'
  import { money, useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import type { Level, OrderTemplate, Platform, Shop } from '@/types/studio'
  import {
    rulesForPlatform,
    platformRuleLabels,
    type PlatformRules
  } from '@/utils/business/platform-rules'

  defineOptions({ name: 'BusinessConfig' })
  const { data, loading, can, mutate, refresh } = useStudio()
  const tab = ref('templates')
  const search = ref({ name: '', game: '', description: '', active: '' })
  const searchItems = [
    {
      key: 'name',
      label: '项目名称',
      type: 'input',
      props: { clearable: true, placeholder: '按项目名称搜索' }
    },
    {
      key: 'game',
      label: '游戏',
      type: 'input',
      props: { clearable: true, placeholder: '按游戏名称搜索' }
    },
    {
      key: 'description',
      label: '规格 / 目标',
      type: 'input',
      props: { clearable: true, placeholder: '按规格内容搜索' }
    },
    {
      key: 'active',
      label: '项目状态',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { value: 'active', label: '启用' },
          { value: 'disabled', label: '停用' }
        ]
      }
    }
  ]
  const templates = computed(() =>
    (data.value?.templates || []).filter(
      (row) =>
        row.name.toLowerCase().includes((search.value.name || '').trim().toLowerCase()) &&
        row.game.toLowerCase().includes((search.value.game || '').trim().toLowerCase()) &&
        row.description
          .toLowerCase()
          .includes((search.value.description || '').trim().toLowerCase()) &&
        (!search.value.active || row.active === (search.value.active === 'active'))
    )
  )
  const platforms = computed(() => data.value?.platforms || [])
  const shops = computed(() => data.value?.shops || [])
  const levels = computed(() =>
    [...(data.value?.levels || [])].sort((a, b) => a.delaySeconds - b.delaySeconds)
  )
  const shopPlatforms = platforms
  const templateTable = useBusinessTable(templates),
    platformTable = useBusinessTable(platforms),
    shopTable = useBusinessTable(shops),
    levelTable = useBusinessTable(levels)
  const templateColumns = useTableColumns<OrderTemplate>(() => [
    { prop: 'name', label: '订单项目', minWidth: 150 },
    { prop: 'game', label: '游戏', minWidth: 140 },
    { prop: 'description', label: '规格 / 目标', minWidth: 200, showOverflowTooltip: true },
    { prop: 'amount', label: '客户价格', width: 130, useSlot: true },
    { prop: 'reward', label: '整单打手报酬', width: 150, useSlot: true },
    { prop: 'map', label: '默认地图', width: 130 },
    { prop: 'active', label: '状态', width: 90, useSlot: true },
    { prop: 'operation', label: '操作', width: 110, fixed: 'right', useSlot: true }
  ])
  const platformColumns = useTableColumns<Platform>(() => [
    { prop: 'name', label: '来源平台', minWidth: 180 },
    { prop: 'rules', label: '下单规则', minWidth: 320, useSlot: true },
    { prop: 'operation', label: '操作', width: 110, fixed: 'right', useSlot: true }
  ])
  const shopColumns = useTableColumns<Shop>(() => [
    { prop: 'name', label: '来源店铺', minWidth: 180 },
    { prop: 'platformId', label: '所属平台', minWidth: 180, useSlot: true },
    { prop: 'operation', label: '操作', width: 110, fixed: 'right', useSlot: true }
  ])
  const levelColumns = useTableColumns<Level>(() => [
    { prop: 'name', label: '等级名称', minWidth: 180 },
    { prop: 'delaySeconds', label: '开放延迟', minWidth: 260, useSlot: true },
    { prop: 'operation', label: '操作', width: 110, fixed: 'right', useSlot: true }
  ])
  function resetSearch() {
    search.value = { name: '', game: '', description: '', active: '' }
    templateTable.resetPage()
  }
  const open = ref<'' | 'template' | 'platform' | 'shop' | 'level'>(''),
    saving = ref(false)
  const template = reactive<Omit<OrderTemplate, 'id'> & { id?: string }>({
    name: '',
    game: '三角洲行动',
    description: '',
    amount: null,
    reward: null,
    map: '不限',
    remark: '',
    active: true
  })
  const platform = reactive<{ id?: string; name: string; rules: PlatformRules }>({
    name: '',
    rules: rulesForPlatform()
  })
  const shop = reactive<{ id?: string; name: string; platformId: string }>({
    name: '',
    platformId: ''
  })
  const level = reactive<{ id?: string; name: string; delaySeconds: number }>({
    name: '',
    delaySeconds: 0
  })
  const dialogTitle = computed(
    () =>
      ({
        template: '订单项目配置',
        platform: '来源平台配置',
        shop: '来源店铺配置',
        level: '打手等级配置'
      })[open.value || 'template']
  )
  function editTemplate(row?: OrderTemplate) {
    if (!can('templates.manage') || saving.value) return
    Object.assign(
      template,
      {
        id: undefined,
        name: '',
        game: '三角洲行动',
        description: '',
        amount: null,
        reward: null,
        map: '不限',
        remark: '',
        active: true
      },
      row || {}
    )
    open.value = 'template'
  }
  function editPlatform(row?: Platform) {
    if (!can('settings.manage') || saving.value) return
    Object.assign(platform, { id: row?.id, name: row?.name || '', rules: rulesForPlatform(row) })
    open.value = 'platform'
  }
  function editShop(row?: Shop) {
    if (!can('settings.manage') || saving.value) return
    Object.assign(
      shop,
      { id: undefined, name: '', platformId: shopPlatforms.value[0]?.id || '' },
      row || {}
    )
    open.value = 'shop'
  }
  function editLevel(row?: Level) {
    if (!can('settings.manage') || saving.value) return
    Object.assign(level, { id: undefined, name: '', delaySeconds: 0 }, row || {})
    open.value = 'level'
  }
  async function save() {
    if (
      !open.value ||
      saving.value ||
      !can(open.value === 'template' ? 'templates.manage' : 'settings.manage')
    )
      return
    const models = { template, platform, shop, level },
      body = models[open.value]
    if (!body.name.trim()) return void ElMessage.warning('请填写名称')
    if (open.value === 'template' && !template.game.trim())
      return void ElMessage.warning('请填写游戏名称')
    if (open.value === 'shop' && !shop.platformId) return void ElMessage.warning('请选择来源平台')
    saving.value = true
    try {
      await mutate(
        { template: '/templates', platform: '/platforms', shop: '/shops', level: '/levels' }[
          open.value
        ],
        { ...body }
      )
      open.value = ''
      ElMessage.success('业务配置已保存')
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
