<script setup lang="ts">
  import { computed, reactive, ref } from 'vue'
  import {
    ElAlert,
    ElButton,
    ElDialog,
    ElForm,
    ElFormItem,
    ElInput,
    ElInputNumber,
    ElMessage,
    ElOption,
    ElSelect,
    ElSwitch,
    ElTable,
    ElTableColumn,
    ElTabPane,
    ElTabs,
    ElTag
  } from 'element-plus'
  import type { Level, OrderTemplate, Platform, Shop } from '@/types/studio'
  import { money, useStudio } from '../useStudio'
  import ManagementAmount from '../components/ManagementAmount.vue'

  const { data, can, mutate } = useStudio()
  const tab = ref('templates')
  const query = ref('')
  const templates = computed(() =>
    (data.value?.templates || []).filter((row) => `${row.name} ${row.game}`.includes(query.value))
  )
  const shopPlatforms = computed(() =>
    (data.value?.platforms || []).filter((row) => row.name.includes('闲鱼'))
  )
  const open = ref<'' | 'template' | 'platform' | 'shop' | 'level'>('')
  const saving = ref(false)
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
  const platform = reactive<{ id?: string; name: string; operatorCommission: boolean }>({
    name: '',
    operatorCommission: false
  })
  const isHall = computed(() => platform.id === 'hall' || platform.name.trim() === '游戏大厅')
  const shop = reactive<{ id?: string; name: string; platformId: string }>({
    name: '',
    platformId: ''
  })
  const level = reactive<{ id?: string; name: string; delaySeconds: number }>({
    name: '',
    delaySeconds: 0
  })
  function editTemplate(row?: OrderTemplate) {
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
    Object.assign(platform, { id: undefined, name: '', operatorCommission: false }, row || {})
    open.value = 'platform'
  }
  function editShop(row?: Shop) {
    Object.assign(
      shop,
      { id: undefined, name: '', platformId: shopPlatforms.value[0]?.id || '' },
      row || {}
    )
    open.value = 'shop'
  }
  function editLevel(row?: Level) {
    Object.assign(level, { id: undefined, name: '', delaySeconds: 0 }, row || {})
    open.value = 'level'
  }
  async function save() {
    const models = { template, platform, shop, level }
    if (!open.value) return
    const body = models[open.value]
    if (!body.name.trim()) return void ElMessage.warning('请填写名称')
    if (open.value === 'template' && !template.game.trim())
      return void ElMessage.warning('请填写游戏名称')
    if (open.value === 'shop' && !shop.platformId)
      return void ElMessage.warning('请先建立闲鱼来源平台')
    if (open.value === 'platform' && isHall.value) platform.operatorCommission = false
    const paths = {
      template: '/templates',
      platform: '/platforms',
      shop: '/shops',
      level: '/levels'
    }
    saving.value = true
    try {
      await mutate(paths[open.value], { ...body })
      open.value = ''
      ElMessage.success('配置已保存')
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
      ><div
        ><h2>游戏与业务配置</h2
        ><p>维护订单项目、获客来源与接单等级，历史订单保留创建时的模板快照。</p></div
      ><ElButton
        v-if="tab === 'templates' && can('templates.manage')"
        type="primary"
        @click="editTemplate()"
        >+ 新增订单项目</ElButton
      ><ElButton
        v-if="tab === 'levels' && can('settings.manage')"
        type="primary"
        @click="editLevel()"
        >+ 新增等级</ElButton
      ></div
    >
    <div class="panel">
      <ElTabs v-model="tab"
        ><ElTabPane name="templates" label="订单项目 / 模板" /><ElTabPane
          name="sources"
          label="来源平台与店铺" /><ElTabPane name="levels" label="打手等级"
      /></ElTabs>
      <template v-if="tab === 'templates'">
        <div class="toolbar"
          ><ElInput
            v-model="query"
            placeholder="搜索项目名称 / 游戏"
            clearable
            style="max-width: 320px"
          /><span class="muted">空白价格表示待配置，实际下单时必须填写有效金额。</span></div
        >
        <ElTable :data="templates" stripe
          ><ElTableColumn prop="name" label="订单项目" min-width="150" /><ElTableColumn
            prop="game"
            label="游戏"
            min-width="140"
          /><ElTableColumn
            prop="description"
            label="规格 / 目标"
            min-width="180"
            show-overflow-tooltip
          /><ElTableColumn label="客户价格" width="130"
            ><template #default="{ row }">{{ money(row.amount) }}</template></ElTableColumn
          ><ElTableColumn label="整单打手报酬" width="150"
            ><template #default="{ row }">{{ money(row.reward) }}</template></ElTableColumn
          ><ElTableColumn prop="map" label="默认地图" width="120" /><ElTableColumn
            label="状态"
            width="90"
            ><template #default="{ row }"
              ><ElTag :type="row.active ? 'success' : 'info'">{{
                row.active ? '启用' : '停用'
              }}</ElTag></template
            ></ElTableColumn
          ><ElTableColumn v-if="can('templates.manage')" label="操作" width="90"
            ><template #default="{ row }"
              ><ElButton link type="primary" @click="editTemplate(row)">编辑</ElButton></template
            ></ElTableColumn
          ></ElTable
        >
      </template>
      <template v-if="tab === 'sources'">
        <div class="panel-heading"
          ><div
            ><h3>订单来源平台</h3
            ><p class="muted"
              >获客来源独立于成交渠道。运营提成参与范围由此设置，比例由财务维护。</p
            ></div
          ><ElButton v-if="can('settings.manage')" @click="editPlatform()"
            >+ 新增来源</ElButton
          ></div
        >
        <ElTable :data="data?.platforms || []"
          ><ElTableColumn prop="name" label="来源平台" min-width="180" /><ElTableColumn
            label="参与运营提成"
            min-width="180"
            ><template #default="{ row }"
              ><ElTag :type="row.operatorCommission ? 'success' : 'info'">{{
                row.operatorCommission ? '参与，比例由财务配置' : '不参与'
              }}</ElTag></template
            ></ElTableColumn
          ><ElTableColumn v-if="can('settings.manage')" label="操作" width="100"
            ><template #default="{ row }"
              ><ElButton link type="primary" @click="editPlatform(row)">编辑</ElButton></template
            ></ElTableColumn
          ></ElTable
        >
        <div class="panel-heading catalog-section"
          ><div
            ><h3>闲鱼店铺</h3><p class="muted">派单时选择店铺，按平台汇总并保留店铺明细。</p></div
          ><ElButton
            v-if="can('settings.manage')"
            :disabled="!shopPlatforms.length"
            @click="editShop()"
            >+ 新增店铺</ElButton
          ></div
        >
        <ElTable :data="data?.shops || []"
          ><ElTableColumn prop="name" label="店铺名称" min-width="180" /><ElTableColumn
            label="所属平台"
            min-width="180"
            ><template #default="{ row }">{{
              data?.platforms.find((item) => item.id === row.platformId)?.name || row.platformId
            }}</template></ElTableColumn
          ><ElTableColumn v-if="can('settings.manage')" label="操作" width="100"
            ><template #default="{ row }"
              ><ElButton link type="primary" @click="editShop(row)">编辑</ElButton></template
            ></ElTableColumn
          ></ElTable
        >
      </template>
      <template v-if="tab === 'levels'">
        <ElAlert
          title="公共抢单池从订单发布时间计算开放延迟。高等级先开放，后开放等级出现后，前面等级仍可接单；直接指派使用指定负责人流程。"
          type="info"
          :closable="false"
          show-icon
          class="catalog-note"
        />
        <ElTable :data="[...(data?.levels || [])].sort((a, b) => a.delaySeconds - b.delaySeconds)"
          ><ElTableColumn prop="name" label="等级名称" min-width="160" /><ElTableColumn
            label="开放延迟"
            min-width="200"
            ><template #default="{ row }">{{
              row.delaySeconds === 0 ? '立即开放' : `发布 ${row.delaySeconds} 秒后开放`
            }}</template></ElTableColumn
          ><ElTableColumn v-if="can('settings.manage')" label="操作" width="100"
            ><template #default="{ row }"
              ><ElButton link type="primary" @click="editLevel(row)">编辑规则</ElButton></template
            ></ElTableColumn
          ></ElTable
        >
      </template>
    </div>
    <ElDialog
      :model-value="!!open"
      :title="
        open === 'template'
          ? '订单项目配置'
          : open === 'platform'
            ? '来源平台配置'
            : open === 'shop'
              ? '闲鱼店铺配置'
              : '打手等级配置'
      "
      width="min(620px, 94vw)"
      @close="open = ''"
    >
      <ElForm label-position="top" @submit.prevent="save">
        <template v-if="open === 'template'"
          ><ElFormItem label="项目名称" required
            ><ElInput
              v-model="template.name"
              maxlength="100"
              placeholder="例如 70 788w / 娱乐单" /></ElFormItem
          ><ElFormItem label="游戏" required
            ><ElInput v-model="template.game" maxlength="100" /></ElFormItem
          ><ElFormItem label="规格 / 目标"
            ><ElInput v-model="template.description" maxlength="500" /></ElFormItem
          ><div class="catalog-grid"
            ><ElFormItem label="客户价格（元）"
              ><ManagementAmount v-model="template.amount" /></ElFormItem
            ><ElFormItem label="整单打手报酬（元）"
              ><ManagementAmount v-model="template.reward" /></ElFormItem></div
          ><ElFormItem label="默认地图"
            ><ElInput v-model="template.map" maxlength="100" /></ElFormItem
          ><ElFormItem label="默认打手可见备注"
            ><ElInput
              v-model="template.remark"
              type="textarea"
              :rows="3"
              maxlength="2000" /></ElFormItem
          ><ElFormItem label="项目状态"
            ><ElSwitch
              v-model="template.active"
              active-text="启用"
              inactive-text="停用" /></ElFormItem
          ><p class="muted">未确定的价格保持留空。修改模板不会覆盖已有订单。</p></template
        >
        <template v-if="open === 'platform'"
          ><ElFormItem label="来源平台名称" required
            ><ElInput v-model="platform.name" maxlength="60" /></ElFormItem
          ><ElFormItem label="是否参与运营提成"
            ><ElSwitch v-model="platform.operatorCommission" :disabled="isHall" /></ElFormItem
          ><p class="muted">{{
            isHall ? '游戏大厅不参与运营提成。' : '开启后仍需财务为运营配置该平台的提成比例。'
          }}</p></template
        >
        <template v-if="open === 'shop'"
          ><ElFormItem label="店铺名称" required
            ><ElInput v-model="shop.name" maxlength="60" /></ElFormItem
          ><ElFormItem label="所属平台" required
            ><ElSelect v-model="shop.platformId" style="width: 100%"
              ><ElOption
                v-for="item in shopPlatforms"
                :key="item.id"
                :value="item.id"
                :label="item.name" /></ElSelect></ElFormItem
        ></template>
        <template v-if="open === 'level'"
          ><ElFormItem label="等级名称" required
            ><ElInput v-model="level.name" maxlength="60" /></ElFormItem
          ><ElFormItem label="公共抢单池开放延迟（秒）"
            ><ElInputNumber
              v-model="level.delaySeconds"
              :min="0"
              :max="86400"
              :precision="0" /></ElFormItem
        ></template>
      </ElForm>
      <template #footer
        ><ElButton @click="open = ''">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存配置</ElButton></template
      >
    </ElDialog>
  </div>
</template>

<style scoped>
  .catalog-section {
    margin-top: 32px;
  }

  .catalog-note {
    margin: 6px 0 22px;
  }

  .catalog-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  @media (width <= 560px) {
    .catalog-grid {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }
</style>
