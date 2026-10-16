<template>
  <div class="business-page">
    <BusinessPageHeader
      title="业务配置"
      description="维护订单项目、平台店铺和打手等级，新增业务沿用最新配置。"
      icon="ri:gamepad-line"
      badge="历史订单保留快照"
    />
    <ElCard class="mb-4" shadow="never">
      <ElTabs v-model="tab" :before-leave="preservePanelHeight"
        ><ElTabPane name="templates" label="订单项目 / 模板" /><ElTabPane
          name="sources"
          label="来源平台与店铺" /><ElTabPane name="levels" label="打手等级"
      /></ElTabs>
      <p class="text-sm text-g-500">配置用于新订单，已创建订单保留原模板快照和业务归属。</p>
    </ElCard>
    <div
      ref="panelsRef"
      class="business-config-panels"
      :style="{ minHeight: panelMinHeight ? `${panelMinHeight}px` : undefined }"
    >
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
                link
                type="primary"
                @click="detailTarget = { kind: 'template', id: row.id }"
                >查看详情</ElButton
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
                  v-for="rule in platformRuleLabels.filter(
                    (item) => rulesForPlatform(row)[item.key]
                  )"
                  :key="rule.key"
                  size="small"
                  type="info"
                  >{{ rule.label }}</ElTag
                ></ElSpace
              ></template
            >
            <template #operation="{ row }"
              ><ElButton
                link
                type="primary"
                @click="detailTarget = { kind: 'platform', id: row.id }"
                >查看详情</ElButton
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
              ><ElButton link type="primary" @click="detailTarget = { kind: 'shop', id: row.id }"
                >查看详情</ElButton
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
            ><ElButton link type="primary" @click="detailTarget = { kind: 'level', id: row.id }"
              >查看详情</ElButton
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
    </div>
    <BusinessDetailPanel
      page-key="configuration-details"
      :record-id="detailTarget ? detailTarget.kind + ':' + detailTarget.id : undefined"
      @restore="queueRestore('detail', $event)"
      :restore-error="restoreError"
      :model-value="!!detailTarget"
      title="业务配置详情"
      @update:model-value="!$event && !saving && (detailTarget = null)"
      @close="detailTarget = null"
    >
      <template v-if="detailRecord">
        <BusinessDetailHeader
          :title="detailRecord.name"
          description="查看当前配置和适用范围。新增业务沿用当前配置，已创建订单保留原快照。"
          icon="ri:gamepad-line"
          :badge="configLabels[detailTarget!.kind]"
          :context="detailRecord.id"
        />
        <BusinessDetailSummary :items="detailSummary" />
        <BusinessDetailSection
          v-if="detailTemplate"
          title="项目与默认内容"
          description="模板价格与整单报酬是建单默认值，已有订单按自身快照和实际记录核对。"
        >
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem label="游戏">{{ detailTemplate.game }}</ElDescriptionsItem
            ><ElDescriptionsItem label="规格 / 目标">{{
              detailTemplate.description || '—'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="默认地图">{{
              detailTemplate.map || '—'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="默认打手可见备注">{{
              detailTemplate.remark || '—'
            }}</ElDescriptionsItem></ElDescriptions
          >
        </BusinessDetailSection>
        <BusinessDetailSection
          v-if="detailPlatform"
          title="来源下单规则"
          description="展示当前已有开关；运营提成比例由财务工资方案维护。"
        >
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem
              v-for="rule in platformRuleLabels"
              :key="rule.key"
              :label="rule.label"
              >{{
                rulesForPlatform(detailPlatform)[rule.key] ? '启用' : '未启用'
              }}</ElDescriptionsItem
            ></ElDescriptions
          >
          <p class="text-sm text-g-500 mt-4"
            >所属店铺：{{
              (
                data?.shops
                  .filter((row) => row.platformId === detailPlatform!.id)
                  .map((row) => row.name) || []
              ).join('、') || '暂无店铺'
            }}</p
          >
        </BusinessDetailSection>
        <BusinessDetailSection
          v-if="detailShop"
          title="来源归属"
          description="店铺名称只在同一来源内要求唯一，不同来源可同名。"
          ><ElDescriptions :column="1" border
            ><ElDescriptionsItem label="所属平台">{{
              data?.platforms.find((row) => row.id === detailShop!.platformId)?.name ||
              detailShop.platformId
            }}</ElDescriptionsItem></ElDescriptions
          ></BusinessDetailSection
        >
        <BusinessDetailSection
          v-if="detailLevel"
          title="公共抢单池开放口径"
          description="按派单发布时间计算等级开放延迟，开放后持续可接单。"
          ><ElDescriptions :column="1" border
            ><ElDescriptionsItem label="开放规则">{{
              detailLevel.delaySeconds === 0
                ? '发布后立即开放'
                : `发布 ${detailLevel.delaySeconds} 秒后开放`
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="直接指派"
              >沿用指定负责人的原处理流程。</ElDescriptionsItem
            ></ElDescriptions
          ></BusinessDetailSection
        > </template
      ><ElEmpty v-else description="当前账号没有可读取的配置，请关闭后刷新" />
    </BusinessDetailPanel>
    <BusinessDetailPanel
      page-key="configuration-editor"
      :record-id="
        open ? open + ':' + ({ template, platform, shop, level }[open].id || 'new') : undefined
      "
      @restore="queueRestore('edit', $event)"
      :restore-error="restoreError"
      :model-value="!!open"
      :title="dialogTitle"
      destroy-on-close
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @update:model-value="!$event && !saving && (open = '')"
      @close="open = ''"
    >
      <BusinessDetailHeader
        :title="dialogTitle"
        :description="configDescriptions[open || 'template']"
        icon="ri:settings-3-line"
        :badge="open && { template, platform, shop, level }[open].id ? '编辑已有配置' : '新增配置'"
      />
      <BusinessDetailSummary :items="editingSummary" />
      <BusinessDetailSection
        :title="
          open === 'platform'
            ? '名称与现有下单规则'
            : open === 'template'
              ? '项目内容与默认金额'
              : open === 'level'
                ? '等级与开放延迟'
                : '名称与来源归属'
        "
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
      </BusinessDetailSection>
      <template #footer
        ><ElButton :disabled="saving" @click="open = ''">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存配置</ElButton></template
      >
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import { computed, nextTick, onMounted, reactive, ref } from 'vue'
  import { ElMessage } from 'element-plus'
  import { money, useStudio } from '@/hooks/business/useStudio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import { useTableColumns } from '@/hooks/core/useTableColumns'
  import BusinessAmount from '@/components/business/BusinessAmount.vue'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import type { Level, OrderTemplate, Platform, Shop } from '@/types/studio'
  import {
    rulesForPlatform,
    platformRuleLabels,
    type PlatformRules
  } from '@/utils/business/platform-rules'

  defineOptions({ name: 'BusinessConfig' })
  const { data, loading, can, mutate, refresh } = useStudio()
  const tab = ref('templates')
  const panelsRef = ref<HTMLElement>()
  const panelMinHeight = ref(0)
  async function preservePanelHeight() {
    // 新表格在挂载后才设置高度；先保留旧区域高度，避免中间一帧把页面滚动夹到顶部。
    panelMinHeight.value = Math.max(panelMinHeight.value, panelsRef.value?.offsetHeight || 0)
    await nextTick()
    return true
  }
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
    { prop: 'operation', label: '操作', width: 190, fixed: 'right', useSlot: true }
  ])
  const platformColumns = useTableColumns<Platform>(() => [
    { prop: 'name', label: '来源平台', minWidth: 180 },
    { prop: 'rules', label: '下单规则', minWidth: 320, useSlot: true },
    { prop: 'operation', label: '操作', width: 190, fixed: 'right', useSlot: true }
  ])
  const shopColumns = useTableColumns<Shop>(() => [
    { prop: 'name', label: '来源店铺', minWidth: 180 },
    { prop: 'platformId', label: '所属平台', minWidth: 180, useSlot: true },
    { prop: 'operation', label: '操作', width: 190, fixed: 'right', useSlot: true }
  ])
  const levelColumns = useTableColumns<Level>(() => [
    { prop: 'name', label: '等级名称', minWidth: 180 },
    { prop: 'delaySeconds', label: '开放延迟', minWidth: 260, useSlot: true },
    { prop: 'operation', label: '操作', width: 190, fixed: 'right', useSlot: true }
  ])
  function resetSearch() {
    search.value = { name: '', game: '', description: '', active: '' }
    templateTable.resetPage()
  }
  const open = ref<'' | 'template' | 'platform' | 'shop' | 'level'>(''),
    saving = ref(false)
  const detailTarget = ref<{ kind: 'template' | 'platform' | 'shop' | 'level'; id: string } | null>(
    null
  )
  const configLabels = {
    template: '订单项目',
    platform: '来源平台',
    shop: '来源店铺',
    level: '打手等级'
  }
  const configDescriptions = {
    template: '保存新的建单默认内容。停用后不可用于新订单，已有订单保留原模板快照。',
    platform: '维护来源名称和现有下单规则。保存后新业务沿用最新配置，提成比例仍由财务维护。',
    shop: '维护店铺名称及来源归属，已有订单保留原业务归属快照。',
    level: '维护公共抢单池的现有开放延迟，不改变直接指派流程或接单资格。'
  }
  const detailTemplate = computed(() =>
    detailTarget.value?.kind === 'template'
      ? data.value?.templates.find((row) => row.id === detailTarget.value?.id)
      : undefined
  )
  const detailPlatform = computed(() =>
    detailTarget.value?.kind === 'platform'
      ? data.value?.platforms.find((row) => row.id === detailTarget.value?.id)
      : undefined
  )
  const detailShop = computed(() =>
    detailTarget.value?.kind === 'shop'
      ? data.value?.shops.find((row) => row.id === detailTarget.value?.id)
      : undefined
  )
  const detailLevel = computed(() =>
    detailTarget.value?.kind === 'level'
      ? data.value?.levels.find((row) => row.id === detailTarget.value?.id)
      : undefined
  )
  const detailRecord = computed(
    () => detailTemplate.value || detailPlatform.value || detailShop.value || detailLevel.value
  )
  const detailSummary = computed(() =>
    detailTemplate.value
      ? [
          { label: '客户价格', value: money(detailTemplate.value.amount), tone: 'primary' },
          { label: '整单打手报酬', value: money(detailTemplate.value.reward) },
          { label: '项目状态', value: detailTemplate.value.active ? '启用' : '停用' }
        ]
      : detailPlatform.value
        ? [
            {
              label: '已有下单规则',
              value:
                platformRuleLabels.filter(
                  (rule) => rulesForPlatform(detailPlatform.value)[rule.key]
                ).length + ' 项启用'
            },
            {
              label: '所属店铺',
              value:
                (data.value?.shops.filter((row) => row.platformId === detailPlatform.value?.id)
                  .length || 0) + ' 家'
            }
          ]
        : detailShop.value
          ? [
              {
                label: '所属平台',
                value:
                  data.value?.platforms.find((row) => row.id === detailShop.value?.platformId)
                    ?.name || detailShop.value.platformId
              }
            ]
          : [
              { label: '公共池开放延迟', value: (detailLevel.value?.delaySeconds || 0) + ' 秒' },
              { label: '适用流程', value: '公共抢单池' }
            ]
  )
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
  const editingSummary = computed(() =>
    open.value === 'template'
      ? [
          { label: '客户价格', value: money(template.amount), tone: 'primary' },
          { label: '整单报酬', value: money(template.reward) },
          { label: '保存后状态', value: template.active ? '启用' : '停用' }
        ]
      : open.value === 'platform'
        ? [
            { label: '来源平台', value: platform.name || '待填写' },
            {
              label: '现有规则',
              value:
                platformRuleLabels.filter((rule) => platform.rules[rule.key]).length + ' 项启用'
            }
          ]
        : open.value === 'shop'
          ? [
              { label: '店铺名称', value: shop.name || '待填写' },
              {
                label: '所属平台',
                value: platforms.value.find((row) => row.id === shop.platformId)?.name || '待选择'
              }
            ]
          : [
              { label: '等级名称', value: level.name || '待填写' },
              {
                label: '公共池开放延迟',
                value: level.delaySeconds === 0 ? '立即开放' : level.delaySeconds + ' 秒'
              }
            ]
  )
  const restoreError = ref('')
  const pendingRestore = ref<{
    kind: 'detail' | 'edit'
    recordId?: string
    isCurrent?: () => boolean
  } | null>(null)
  function queueRestore(
    kind: 'detail' | 'edit',
    payload: { recordId?: string; isCurrent?: () => boolean }
  ) {
    restoreError.value = ''
    pendingRestore.value = { kind, ...payload }
    resumeRestore()
  }
  function resumeRestore() {
    if (pendingRestore.value?.isCurrent?.() === false) {
      pendingRestore.value = null
      return
    }
    if (!pendingRestore.value || loading.value || saving.value || !data.value) return
    const request = pendingRestore.value
    pendingRestore.value = null
    const [kind, id] = (request.recordId || '').split(':')
    if (!['template', 'platform', 'shop', 'level'].includes(kind || '') || !id) {
      restoreError.value = '配置标识无效，请返回业务配置重新选择。'
      return
    }
    if (
      request.kind === 'edit' &&
      !can(kind === 'template' ? 'templates.manage' : 'settings.manage')
    ) {
      restoreError.value = '当前账号没有此配置的修改权限，请返回业务配置。'
      return
    }
    tab.value = kind === 'template' ? 'templates' : kind === 'level' ? 'levels' : 'sources'
    if (kind === 'template') {
      const row = data.value.templates.find((item) => item.id === id)
      if (request.kind === 'edit' && id === 'new') editTemplate()
      else if (!row) restoreError.value = '当前账号没有可读取的订单项目，请返回配置列表。'
      else if (request.kind === 'detail') detailTarget.value = { kind: 'template', id: row.id }
      else editTemplate(row)
    } else if (kind === 'platform') {
      const row = data.value.platforms.find((item) => item.id === id)
      if (request.kind === 'edit' && id === 'new') editPlatform()
      else if (!row) restoreError.value = '当前账号没有可读取的来源平台，请返回配置列表。'
      else if (request.kind === 'detail') detailTarget.value = { kind: 'platform', id: row.id }
      else editPlatform(row)
    } else if (kind === 'shop') {
      const row = data.value.shops.find((item) => item.id === id)
      if (request.kind === 'edit' && id === 'new') editShop()
      else if (!row) restoreError.value = '当前账号没有可读取的来源店铺，请返回配置列表。'
      else if (request.kind === 'detail') detailTarget.value = { kind: 'shop', id: row.id }
      else editShop(row)
    } else {
      const row = data.value.levels.find((item) => item.id === id)
      if (request.kind === 'edit' && id === 'new') editLevel()
      else if (!row) restoreError.value = '当前账号没有可读取的打手等级，请返回配置列表。'
      else if (request.kind === 'detail') detailTarget.value = { kind: 'level', id: row.id }
      else editLevel(row)
    }
  }
  watch([data, loading, saving], resumeRestore)
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

<style scoped>
  .business-config-panels {
    overflow-anchor: none;
  }
</style>
