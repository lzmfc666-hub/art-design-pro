<template>
  <div class="merchant-management-page">
    <BusinessPageHeader
      title="商家管理"
      description="集中维护商家资料、登录账号、专属模板和订单，选择商家后各标签沿用同一筛选。"
      icon="ri:store-2-line"
      :badge="`${merchants.length} 家合作商家`"
    >
      <template #actions>
        <ElButton :loading="loading" @click="reload">刷新数据</ElButton>
        <ElButton
          v-if="can('users.manage')"
          type="primary"
          :disabled="hasDetail"
          @click="editMerchant()"
          >新增商家</ElButton
        >
      </template>
    </BusinessPageHeader>
    <ElCard shadow="never" class="mb-4">
      <div class="merchant-scope">
        <label for="merchant-scope">当前商家</label>
        <ElSelect
          id="merchant-scope"
          placeholder="全部商家"
          :model-value="merchantId"
          filterable
          :disabled="hasDetail"
          @change="changeMerchant"
        >
          <ElOption label="全部商家" value="" />
          <ElOption
            v-for="item in merchants"
            :key="item.id"
            :value="item.id"
            :label="`${item.name}${item.status === 'disabled' ? '（停用）' : ''}`"
          />
        </ElSelect>
        <span class="text-sm text-g-500">{{
          selectedMerchant
            ? `正在管理：${selectedMerchant.name}`
            : merchantId
              ? '该商家不存在或当前账号无权查看'
              : '可先查看全部资料、账号和模板，再选择商家查看订单。'
        }}</span>
      </div>
      <ElTabs :model-value="activeSection" @tab-change="changeSection">
        <ElTabPane
          v-for="item in sections"
          :key="item.name"
          :name="item.name"
          :label="item.label"
          :disabled="hasDetail"
        />
      </ElTabs>
    </ElCard>

    <ElCard v-if="activeSection === 'directory' && can('users.manage')" shadow="never">
      <ElAlert
        title="先新增商家，再在本页创建商家账号、配置专属模板；商家默认客户与来源平台由系统绑定。"
        type="info"
        :closable="false"
        class="mb-4"
      />
      <ElTable :data="visibleMerchants" :loading="loading">
        <ElTableColumn prop="name" label="商家名称" min-width="180" />
        <ElTableColumn label="状态" width="100"
          ><template #default="{ row }"
            ><ElTag :type="row.status === 'active' ? 'success' : 'info'">{{
              row.status === 'active' ? '启用' : '停用'
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="登录账号" width="110"
          ><template #default="{ row }">{{ merchantAccounts(row.id) }}</template></ElTableColumn
        >
        <ElTableColumn label="专属模板" width="110"
          ><template #default="{ row }">{{ merchantTemplates(row.id) }}</template></ElTableColumn
        >
        <ElTableColumn label="操作" min-width="290" fixed="right"
          ><template #default="{ row }">
            <ElButton link type="primary" @click="editMerchant(row)">编辑资料</ElButton>
            <ElButton link type="primary" @click="openSection(row.id, 'accounts')">账号</ElButton>
            <ElButton
              v-if="can('templates.manage')"
              link
              type="primary"
              @click="openSection(row.id, 'templates')"
              >模板</ElButton
            >
            <ElButton
              v-if="can('orders.view')"
              link
              type="primary"
              @click="openSection(row.id, 'orders')"
              >订单</ElButton
            >
          </template></ElTableColumn
        >
      </ElTable>
    </ElCard>
    <MerchantAccounts
      v-else-if="activeSection === 'accounts' && can('users.manage')"
      :key="`accounts:${merchantId}`"
      :merchant-id="merchantId"
    />
    <BusinessConfig
      v-else-if="activeSection === 'templates' && can('templates.manage')"
      :key="`templates:${merchantId}`"
      merchant-templates
      :merchant-id="merchantId"
    />
    <template v-else-if="activeSection === 'orders' && can('orders.view')">
      <OrderList
        v-if="selectedMerchant"
        :key="`orders:${selectedMerchant.id}`"
        :merchant-id="selectedMerchant.id"
      />
      <ElCard v-else shadow="never"
        ><ElEmpty description="请先在上方选择一家商家，再查看订单及收款明细"
      /></ElCard>
    </template>
    <ElEmpty v-else description="当前账号没有可使用的商家管理权限" />

    <ElDialog
      v-model="merchantDialog"
      title="商家资料"
      width="min(520px, 94vw)"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <ElForm label-position="top" :disabled="saving" @submit.prevent="saveMerchant">
        <ElFormItem label="商家名称" required
          ><ElInput v-model="merchant.name" maxlength="100" placeholder="输入合作商家名称"
        /></ElFormItem>
        <ElFormItem label="状态"
          ><ElSwitch
            v-model="merchant.status"
            active-value="active"
            inactive-value="disabled"
            active-text="启用"
            inactive-text="停用"
        /></ElFormItem>
      </ElForm>
      <template #footer
        ><ElButton :disabled="saving" @click="merchantDialog = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveMerchant"
          >保存商家</ElButton
        ></template
      >
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import { ElMessage } from 'element-plus'
  import { useStudio } from '@/hooks/business/useStudio'
  import type { Merchant } from '@/types/studio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessConfig from '@/views/system/business/index.vue'
  import OrderList from '@/views/orders/list/index.vue'
  import MerchantAccounts from './modules/MerchantAccounts.vue'

  defineOptions({ name: 'MerchantManagement' })
  const { data, user, loading, can, mutate, refresh } = useStudio()
  const route = useRoute(),
    router = useRouter()
  const merchants = computed(() => data.value?.merchants || [])
  const merchantId = computed(() =>
    typeof route.query.merchant === 'string' ? route.query.merchant : ''
  )
  const selectedMerchant = computed(() =>
    merchants.value.find((item) => item.id === merchantId.value)
  )
  const visibleMerchants = computed(() =>
    merchants.value.filter((item) => !merchantId.value || item.id === merchantId.value)
  )
  const hasDetail = computed(() => route.query.secondary !== undefined)
  const sections = computed(() =>
    [
      { name: 'directory', label: '商家资料', permission: 'users.manage' },
      { name: 'accounts', label: '商家账号', permission: 'users.manage' },
      { name: 'templates', label: '专属模板', permission: 'templates.manage' },
      { name: 'orders', label: '商家订单', permission: 'orders.view' }
    ].filter((item) => can(item.permission))
  )
  const activeSection = computed(
    () =>
      sections.value.find((item) => item.name === route.query.section)?.name ||
      sections.value[0]?.name ||
      ''
  )
  const merchantAccounts = (id: string) =>
    (data.value?.users || []).filter(
      (item) => item.role === 'merchant' && !item.deletedAt && item.merchantId === id
    ).length
  const merchantTemplates = (id: string) =>
    (data.value?.templates || []).filter((item) => item.merchantId === id).length
  function openSection(id: string, section: string) {
    if (hasDetail.value || saving.value) return
    void router.push({ path: route.path, query: { section, ...(id ? { merchant: id } : {}) } })
  }
  function changeMerchant(value: string) {
    openSection(value, activeSection.value)
  }
  function changeSection(value: string | number) {
    openSection(merchantId.value, String(value))
  }
  const merchantDialog = ref(false),
    saving = ref(false)
  const merchant = reactive<{ id?: string; name: string; status: Merchant['status'] }>({
    name: '',
    status: 'active'
  })
  function editMerchant(row?: Merchant) {
    if (!can('users.manage') || saving.value) return
    Object.assign(merchant, { id: row?.id, name: row?.name || '', status: row?.status || 'active' })
    merchantDialog.value = true
  }
  async function saveMerchant() {
    if (saving.value || !can('users.manage')) return
    if (!merchant.name.trim()) {
      ElMessage.warning('请输入商家名称')
      return
    }
    saving.value = true
    try {
      await mutate('/merchants', { ...merchant, name: merchant.name.trim() })
      merchantDialog.value = false
      ElMessage.success('商家资料已保存')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '商家保存失败')
    } finally {
      saving.value = false
    }
  }
  async function reload() {
    try {
      await refresh()
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '刷新失败')
    }
  }
  watch([() => user.value?.id, () => can('users.manage')], ([owner, allowed], [previousOwner]) => {
    if (!allowed || owner !== previousOwner) merchantDialog.value = false
  })
</script>

<style scoped lang="scss">
  .merchant-scope {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding-bottom: 20px;

    .el-select {
      width: 250px;
      max-width: 100%;
    }
  }
</style>
