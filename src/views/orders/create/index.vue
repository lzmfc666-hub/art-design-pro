<script setup lang="ts">
  import { computed, reactive, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { ElMessage, type UploadFile } from 'element-plus'
  import type { Attachment, OrderTemplate } from '@/types/studio'
  import { useStudio, money, formatTime } from '@/hooks/business/useStudio'

  const { data, can, mutate, upload, loading, refresh } = useStudio()
  const router = useRouter()
  const saving = ref(false)
  const uploading = ref(false)
  const customerSaving = ref(false)
  const customerDialog = ref(false)
  const customerDraft = reactive({ name: '', contact: '', gameId: '', remark: '' })
  const form = reactive({
    templateId: '',
    customerId: '',
    platformId: '',
    shopId: '',
    externalOrderNo: '',
    channel: '微信',
    roomCode: '',
    gameId: '',
    map: '不限',
    amount: null as number | null,
    reward: null as number | null,
    remark: '',
    dispatchMode: 'pool' as 'pool' | 'direct',
    assignedTo: '',
    payOnArrival: false,
    receivedAmount: null as number | null,
    paidAt: new Date().toISOString(),
    receipt: null as Attachment | null
  })
  const templates = computed(() => data.value?.templates.filter((item) => item.active) ?? [])
  const selectedTemplate = computed(() =>
    templates.value.find((item) => item.id === form.templateId)
  )
  const selectedPlatform = computed(() =>
    data.value?.platforms.find((item) => item.id === form.platformId)
  )
  const isHall = computed(
    () => selectedPlatform.value?.id === 'hall' || selectedPlatform.value?.name === '游戏大厅'
  )
  const isXianyu = computed(
    () => selectedPlatform.value?.id === 'xianyu' || selectedPlatform.value?.name === '闲鱼'
  )
  const shops = computed(
    () => data.value?.shops.filter((item) => item.platformId === form.platformId) ?? []
  )
  const players = computed(
    () =>
      data.value?.users.filter((item) => item.role === 'player' && item.status === 'active') ?? []
  )
  const pendingOrders = computed(() =>
    (data.value?.orders ?? [])
      .filter((item) => item.status === 'pending')
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  )
  const toCents = (amount: number | null) => Math.round(Number(amount) * 100)
  const personName = (id: string | null) =>
    data.value?.users.find((item) => item.id === id)?.name ?? '—'
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : '操作失败，请稍后重试'

  function selectTemplate(template: OrderTemplate) {
    form.templateId = template.id
    form.amount = template.amount === null ? null : template.amount / 100
    form.reward = template.reward === null ? null : template.reward / 100
    form.receivedAmount = form.amount
    form.map = template.map || '不限'
    form.remark = template.remark
  }
  watch(
    () => form.platformId,
    () => {
      form.shopId = isXianyu.value ? (shops.value[0]?.id ?? '') : ''
      form.payOnArrival = false
      form.externalOrderNo = ''
    }
  )
  watch(
    () => form.customerId,
    (id) => {
      const customer = data.value?.customers.find((item) => item.id === id)
      if (customer) form.gameId = customer.gameId
    }
  )
  watch(
    () => form.amount,
    (amount, old) => {
      if (form.receivedAmount === old || form.receivedAmount === null) form.receivedAmount = amount
    }
  )

  async function uploadReceipt(file: UploadFile) {
    if (!file.raw || uploading.value) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.raw.type)) {
      ElMessage.warning('请上传 PNG、JPG 或 WebP 图片')
      return
    }
    if (file.raw.size > 8 * 1024 * 1024) {
      ElMessage.warning('凭证图片不能超过 8 MB')
      return
    }
    uploading.value = true
    try {
      form.receipt = await upload(file.raw)
      ElMessage.success('付款凭证已上传')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      uploading.value = false
    }
  }

  async function saveCustomer() {
    if (customerSaving.value) return
    if (!customerDraft.name.trim()) {
      ElMessage.warning('请填写客户名称')
      return
    }
    customerSaving.value = true
    try {
      const result = (await mutate('/customers', {
        ...customerDraft,
        name: customerDraft.name.trim()
      })) as { id?: string; customer?: { id: string } }
      form.customerId =
        result?.id ??
        result?.customer?.id ??
        data.value?.customers.find(
          (item) =>
            item.name === customerDraft.name.trim() && item.contact === customerDraft.contact
        )?.id ??
        ''
      customerDialog.value = false
      Object.assign(customerDraft, { name: '', contact: '', gameId: '', remark: '' })
      ElMessage.success('客户已建档')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      customerSaving.value = false
    }
  }

  async function submitOrder() {
    if (saving.value || uploading.value) return
    const warning = !form.templateId
      ? '请先选择订单项目'
      : !form.customerId
        ? '请选择或新增客户'
        : !form.platformId
          ? '请选择订单来源'
          : !form.roomCode.trim() && !form.gameId.trim()
            ? '房间码与客户游戏 ID 至少填写一项'
            : form.amount === null || !Number.isFinite(form.amount) || form.amount <= 0
              ? '请填写有效的客户订单金额'
              : form.reward === null || !Number.isFinite(form.reward) || form.reward < 0
                ? '请填写有效的整单打手报酬'
                : isXianyu.value && !form.shopId
                  ? '请选择闲鱼店铺'
                  : isXianyu.value && !form.externalOrderNo.trim()
                    ? '请填写闲鱼平台订单号'
                    : form.dispatchMode === 'direct' && !form.assignedTo
                      ? '请选择要指派的打手'
                      : !form.payOnArrival &&
                          (form.receivedAmount === null || form.receivedAmount <= 0)
                        ? '普通订单须先确认客户已付款'
                        : !form.payOnArrival &&
                            toCents(form.receivedAmount) !== toCents(form.amount)
                          ? '普通订单须足额收款，请核对订单金额与实收金额'
                          : !form.payOnArrival && !form.paidAt
                            ? '请选择客户实际付款时间'
                            : !form.payOnArrival && !isXianyu.value && !form.receipt
                              ? '请上传客户付款凭证'
                              : ''
    if (warning) {
      ElMessage.warning(warning)
      return
    }
    saving.value = true
    try {
      const result = (await mutate('/orders', {
        ...form,
        amount: toCents(form.amount),
        reward: toCents(form.reward),
        receivedAmount: form.payOnArrival ? 0 : toCents(form.receivedAmount),
        paidAt: form.payOnArrival ? null : form.paidAt,
        receipt: form.payOnArrival || isXianyu.value ? null : form.receipt,
        shopId: isXianyu.value ? form.shopId : null,
        assignedTo: form.dispatchMode === 'direct' ? form.assignedTo : null,
        roomCode: form.roomCode.trim(),
        gameId: form.gameId.trim(),
        externalOrderNo: form.externalOrderNo.trim()
      })) as { id?: string; order?: { id: string } }
      ElMessage.success(
        form.dispatchMode === 'direct' ? '订单已发布，等待指定打手接单' : '订单已发布到抢单池'
      )
      const id = result?.id ?? result?.order?.id
      if (can('orders.view')) {
        await router.push(id ? { path: '/orders/list', query: { id } } : '/orders/list')
      } else {
        Object.assign(form, {
          templateId: '',
          customerId: '',
          platformId: '',
          shopId: '',
          externalOrderNo: '',
          channel: '微信',
          roomCode: '',
          gameId: '',
          map: '不限',
          amount: null,
          reward: null,
          remark: '',
          dispatchMode: 'pool',
          assignedTo: '',
          payOnArrival: false,
          receivedAmount: null,
          paidAt: new Date().toISOString(),
          receipt: null
        })
      }
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      saving.value = false
    }
  }

  defineOptions({ name: 'OrderCreate' })
  onMounted(() => refresh().catch(() => {}))
</script>
<template>
  <div>
    <ElRow :gutter="20">
      <ElCol :xs="24" :lg="16">
        <ElCard class="mb-5">
          <template #header
            ><div class="flex justify-between items-center"
              ><span class="font-semibold">创建订单</span
              ><ElTag type="info">金额单位：元</ElTag></div
            ></template
          >
          <ElForm
            novalidate
            :model="form"
            label-position="top"
            :disabled="saving"
            @submit.prevent="submitOrder"
          >
            <ElFormItem label="订单项目" required>
              <ElSelect
                v-model="form.templateId"
                filterable
                placeholder="选择已启用的订单模板"
                @change="
                  (id: string) => {
                    const item = templates.find((t) => t.id === id)
                    if (item) selectTemplate(item)
                  }
                "
              >
                <ElOption
                  v-for="item in templates"
                  :key="item.id"
                  :label="item.name + ' · ' + item.game"
                  :value="item.id"
                />
              </ElSelect>
            </ElFormItem>
            <ElAlert
              v-if="selectedTemplate"
              :title="selectedTemplate.description || selectedTemplate.name"
              type="info"
              :closable="false"
              class="mb-5"
            />
            <ElRow :gutter="20">
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="客户档案" required
                  ><div class="flex w-full gap-2"
                    ><ElSelect v-model="form.customerId" filterable placeholder="选择客户"
                      ><ElOption
                        v-for="item in data?.customers"
                        :key="item.id"
                        :value="item.id"
                        :label="item.name + (item.contact ? ' · ' + item.contact : '')" /></ElSelect
                    ><ElButton :disabled="customerSaving" @click="customerDialog = true"
                      >新增</ElButton
                    ></div
                  ></ElFormItem
                ></ElCol
              >
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="沟通渠道"
                  ><ElSelect v-model="form.channel" filterable allow-create default-first-option
                    ><ElOption
                      v-for="item in ['微信', '企业微信', '平台内沟通', '游戏内沟通']"
                      :key="item"
                      :value="item"
                      :label="item" /></ElSelect></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="订单来源" required
                  ><ElSelect v-model="form.platformId" placeholder="选择来源"
                    ><ElOption
                      v-for="item in data?.platforms"
                      :key="item.id"
                      :value="item.id"
                      :label="item.name" /></ElSelect></ElFormItem
              ></ElCol>
              <ElCol v-if="isXianyu" :xs="24" :sm="12"
                ><ElFormItem label="闲鱼店铺" required
                  ><ElSelect v-model="form.shopId" placeholder="选择店铺"
                    ><ElOption
                      v-for="item in shops"
                      :key="item.id"
                      :value="item.id"
                      :label="item.name" /></ElSelect
                  ><p v-if="!shops.length" class="text-xs text-warning"
                    >请先在业务配置中建立店铺。</p
                  ></ElFormItem
                ></ElCol
              >
              <ElCol v-if="isXianyu" :xs="24" :sm="12"
                ><ElFormItem label="平台订单号" required
                  ><ElInput
                    v-model="form.externalOrderNo"
                    maxlength="100"
                    placeholder="填写完整平台订单号" /></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="房间码"
                  ><ElInput
                    v-model="form.roomCode"
                    maxlength="100"
                    placeholder="房间码与游戏 ID 至少填一项" /></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="客户游戏 ID"
                  ><ElInput v-model="form.gameId" maxlength="100" /></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="地图"
                  ><ElSelect v-model="form.map" filterable allow-create default-first-option
                    ><ElOption
                      v-for="item in [
                        '不限',
                        '零号大坝',
                        '长弓溪谷',
                        '巴克什',
                        '航天基地',
                        '潮汐监狱'
                      ]"
                      :key="item"
                      :value="item"
                      :label="item" /></ElSelect></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="客户订单金额（元）" required
                  ><ElInputNumber
                    v-model="form.amount"
                    :min="0.01"
                    :precision="2"
                    :step="0.01"
                    controls-position="right"
                    class="!w-full"
                    placeholder="待配置，请填写" /></ElFormItem
              ></ElCol>
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="整单打手报酬（元）" required
                  ><ElInputNumber
                    v-model="form.reward"
                    :min="0"
                    :precision="2"
                    :step="0.01"
                    controls-position="right"
                    class="!w-full"
                    placeholder="待配置，请填写" /></ElFormItem
              ></ElCol>
            </ElRow>
            <ElFormItem label="打手可见备注"
              ><ElInput
                v-model="form.remark"
                type="textarea"
                :rows="3"
                maxlength="2000"
                show-word-limit
                placeholder="订单向打手开放后即可查看"
            /></ElFormItem>
            <ElDivider content-position="left">收款确认</ElDivider>
            <ElFormItem v-if="isHall" label="大厅付款方式"
              ><ElSwitch v-model="form.payOnArrival" active-text="落地付：先发布，后补收款"
            /></ElFormItem>
            <ElAlert
              v-if="form.payOnArrival"
              title="落地付订单发布后须补录实际收款时间与凭证，收款前不能通过财务验收。"
              type="warning"
              :closable="false"
              show-icon
              class="mb-5"
            />
            <template v-else>
              <ElRow :gutter="20"
                ><ElCol :xs="24" :sm="12"
                  ><ElFormItem label="已收金额（元）" required
                    ><ElInputNumber
                      v-model="form.receivedAmount"
                      :min="0.01"
                      :precision="2"
                      :step="0.01"
                      class="!w-full"
                      controls-position="right" /></ElFormItem></ElCol
                ><ElCol :xs="24" :sm="12"
                  ><ElFormItem label="客户实际付款时间" required
                    ><ElDatePicker
                      v-model="form.paidAt"
                      type="datetime"
                      value-format="YYYY-MM-DDTHH:mm:ssZ"
                      format="YYYY-MM-DD HH:mm"
                      class="!w-full" /></ElFormItem></ElCol
              ></ElRow>
              <ElFormItem v-if="!isXianyu" label="付款凭证" required
                ><ElUpload
                  :auto-upload="false"
                  :show-file-list="false"
                  :on-change="uploadReceipt"
                  :disabled="uploading || saving"
                  accept="image/png,image/jpeg,image/webp"
                  ><ElButton :loading="uploading"
                    ><ArtSvgIcon icon="ri:upload-2-line" class="mr-1" />{{
                      form.receipt ? '替换凭证' : '上传付款凭证'
                    }}</ElButton
                  ><template #tip
                    ><p class="text-xs text-g-500">JPG / PNG / WebP，最大 8MB</p></template
                  ></ElUpload
                ><ElLink
                  v-if="form.receipt"
                  :href="form.receipt.url"
                  target="_blank"
                  rel="noopener"
                  type="primary"
                  class="ml-3"
                  >{{ form.receipt.name }}</ElLink
                ></ElFormItem
              >
              <ElAlert
                v-else
                title="闲鱼订单免传付款截图，请核对平台订单号与实际付款时间。"
                type="info"
                :closable="false"
                class="mb-5"
              />
            </template>
            <ElDivider content-position="left">派单安排</ElDivider>
            <ElFormItem label="派单方式"
              ><ElRadioGroup v-model="form.dispatchMode"
                ><ElRadioButton value="pool">公开抢单池</ElRadioButton
                ><ElRadioButton value="direct">指定打手</ElRadioButton></ElRadioGroup
              ></ElFormItem
            >
            <ElFormItem v-if="form.dispatchMode === 'direct'" label="指定打手" required
              ><ElSelect v-model="form.assignedTo" filterable placeholder="等待指定打手本人接单"
                ><ElOption
                  v-for="item in players"
                  :key="item.id"
                  :value="item.id"
                  :label="
                    item.name + ' · 执行中 ' + (item.activeOrders || 0) + '/' + item.maxActiveOrders
                  " /></ElSelect
            ></ElFormItem>
            <ElAlert
              v-else
              title="订单发布后，按等级配置的等待时间向打手开放。"
              type="info"
              :closable="false"
            />
            <div class="flex justify-end gap-3 mt-5"
              ><ElButton v-if="can('orders.view')" @click="router.push('/orders/list')"
                >返回订单</ElButton
              ><ElButton
                type="primary"
                :loading="saving"
                :disabled="uploading"
                native-type="submit"
                >{{ form.payOnArrival ? '发布落地付订单' : '确认收款并发布订单' }}</ElButton
              ></div
            >
          </ElForm>
        </ElCard>
      </ElCol>
      <ElCol :xs="24" :lg="8">
        <div class="art-card p-5 mb-5"
          ><div class="art-card-header"
            ><div class="title"><h4>下单核对</h4><p>提交后保存项目快照</p></div></div
          ><ElDescriptions :column="1" border
            ><ElDescriptionsItem label="订单项目">{{
              selectedTemplate?.name || '未选择'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="客户金额">{{
              form.amount == null ? '待填写' : money(toCents(form.amount))
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="整单报酬">{{
              form.reward == null ? '待填写' : money(toCents(form.reward))
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="订单来源">{{
              selectedPlatform?.name || '未选择'
            }}</ElDescriptionsItem></ElDescriptions
          ><p class="text-xs text-g-500 mt-4 leading-6"
            >单人完成获得整单报酬；有一名队友时固定平分。完成材料由打手本人提交，再由财务验收。</p
          ></div
        >
        <div class="art-card p-5"
          ><div class="art-card-header"
            ><div class="title"
              ><h4>待接订单</h4><p>共 {{ pendingOrders.length }} 笔</p></div
            ><ElButton :loading="loading" link @click="refresh().catch(() => {})"
              ><ArtSvgIcon icon="ri:refresh-line" /></ElButton></div
          ><ArtTable
            :data="pendingOrders.slice(0, 8)"
            :height="340"
            :showTableHeader="false"
            :border="false"
            ><ElTableColumn label="项目" min-width="140"
              ><template #default="{ row }"
                ><ElButton
                  v-if="can('orders.view')"
                  link
                  type="primary"
                  @click="router.push({ path: '/orders/list', query: { id: row.id } })"
                  >{{ row.title }}</ElButton
                ><span v-else>{{ row.title }}</span
                ><p class="text-xs text-g-500">{{ formatTime(row.publishedAt) }}</p></template
              ></ElTableColumn
            ><ElTableColumn label="派单" min-width="110"
              ><template #default="{ row }">{{
                row.assignedTo ? personName(row.assignedTo) : '抢单池'
              }}</template></ElTableColumn
            ></ArtTable
          ></div
        >
      </ElCol>
    </ElRow>
    <ElDialog
      v-model="customerDialog"
      title="新增客户档案"
      width="min(540px, 94vw)"
      :close-on-click-modal="!customerSaving"
      :close-on-press-escape="!customerSaving"
      :show-close="!customerSaving"
      ><ElForm
        :model="customerDraft"
        label-position="top"
        :disabled="customerSaving"
        @submit.prevent="saveCustomer"
        ><ElFormItem label="客户姓名 / 称呼" required
          ><ElInput v-model="customerDraft.name" maxlength="100" /></ElFormItem
        ><ElFormItem label="联系方式"
          ><ElInput v-model="customerDraft.contact" maxlength="100" /></ElFormItem
        ><ElFormItem label="客户游戏 ID"
          ><ElInput v-model="customerDraft.gameId" maxlength="100" /></ElFormItem
        ><ElFormItem label="客户备注"
          ><ElInput
            v-model="customerDraft.remark"
            type="textarea"
            :rows="3"
            maxlength="2000" /></ElFormItem></ElForm
      ><template #footer
        ><ElButton :disabled="customerSaving" @click="customerDialog = false">取消</ElButton
        ><ElButton type="primary" :loading="customerSaving" @click="saveCustomer"
          >保存并选择</ElButton
        ></template
      ></ElDialog
    >
  </div>
</template>
