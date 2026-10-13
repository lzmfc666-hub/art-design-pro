<script setup lang="ts">
  import { computed, nextTick, reactive, ref, watch } from 'vue'
  import { useRouter, onBeforeRouteLeave } from 'vue-router'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import type { Attachment, Customer, CustomerOrderReference, OrderTemplate } from '@/types/studio'
  import { useStudio, money, formatTime } from '@/hooks/business/useStudio'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import BusinessUpload from '@/components/business/BusinessUpload.vue'
  import { rulesForPlatform } from '@/utils/business/platform-rules'
  import { useMediaQuery } from '@vueuse/core'
  import { studioRequest } from '@/api/studio'

  const { data, user, can, mutate, loading, refresh, clearSession } = useStudio()
  const isMobile = useMediaQuery('(max-width: 640px)')
  const router = useRouter()
  const saving = ref(false)
  const uploading = ref(false)
  const customerSaving = ref(false)
  const customerDialog = ref(false)
  const submitted = ref(false)
  const customerDraft = reactive({
    id: '',
    name: '',
    contact: '',
    gameId: '',
    remark: '',
    platformId: null as string | null
  })
  const customerReference = reactive({ shopId: '', externalOrderNo: '' })
  const savedCustomerReferences = ref<CustomerOrderReference[]>([])
  const customerPlatform = computed(() =>
    data.value?.platforms.find((item) => item.id === customerDraft.platformId)
  )
  const customerRules = computed(() => rulesForPlatform(customerPlatform.value))
  const customerShops = computed(
    () => data.value?.shops.filter((item) => item.platformId === customerDraft.platformId) ?? []
  )
  const customerHasReference = computed(() =>
    savedCustomerReferences.value.some((item) => item.platformId === customerDraft.platformId)
  )
  const operationBusy = computed(() => saving.value || uploading.value || customerSaving.value)
  const form = reactive({
    templateId: '',
    customerId: '',
    platformId: '',
    shopId: '',
    externalOrderNo: '',
    roomCode: '',
    gameId: '',
    map: '不限',
    amount: null as number | null,
    reward: null as number | null,
    remark: '',
    dispatchMode: 'pool' as 'pool' | 'direct',
    assignedTo: '',
    payOnArrival: false,
    paymentMethod: 'cash' as 'cash' | 'balance',
    receivedAmount: null as number | null,
    paidAt: new Date().toISOString(),
    receipt: null as Attachment | null
  })
  const customerBalance = ref<number | null>(null)
  const balanceLoading = ref(false)
  const balanceError = ref('')
  let balanceVersion = 0
  let orderRequestId = crypto.randomUUID()
  watch(
    () => JSON.stringify(form),
    () => {
      orderRequestId = crypto.randomUUID()
    },
    { flush: 'sync' }
  )
  async function loadCustomerBalance() {
    const version = ++balanceVersion
    customerBalance.value = null
    balanceError.value = ''
    balanceLoading.value = false
    if (!form.customerId) return
    balanceLoading.value = true
    try {
      const result = await studioRequest<{ customerId: string; balance: number }>(
        `customers/${encodeURIComponent(form.customerId)}/balance`
      )
      if (version === balanceVersion) customerBalance.value = result.balance
    } catch (cause) {
      if (version !== balanceVersion) return
      if ((cause as { status?: number }).status === 401) clearSession()
      balanceError.value = errorText(cause)
    } finally {
      if (version === balanceVersion) balanceLoading.value = false
    }
  }
  const templates = computed(() => data.value?.templates.filter((item) => item.active) ?? [])
  const steps = computed(() => [
    { label: '选择项目', done: !!form.templateId },
    {
      label: '完善客户与来源',
      done:
        !!form.customerId &&
        !!form.platformId &&
        !!(form.roomCode || form.gameId) &&
        (!rules.value.requiresShop || !!form.shopId) &&
        (!rules.value.requiresExternalOrderNo || !!form.externalOrderNo.trim())
    },
    {
      label: '核对收款与发布',
      done:
        form.paymentMethod === 'balance'
          ? !!form.amount &&
            form.amount > 0 &&
            customerBalance.value !== null &&
            customerBalance.value >= toCents(form.amount)
          : form.payOnArrival ||
            (!!form.receivedAmount &&
              !!form.paidAt &&
              (!rules.value.requiresReceipt || !!form.receipt))
    }
  ])
  const activeStep = computed(() => {
    const index = steps.value.findIndex((step) => !step.done)
    return index === -1 ? 3 : index
  })
  const dirty = computed(
    () =>
      !!(
        form.templateId ||
        form.customerId ||
        form.platformId ||
        form.roomCode ||
        form.gameId ||
        form.remark ||
        form.receipt ||
        customerDraft.name ||
        customerDraft.contact
      )
  )
  onBeforeRouteLeave(async () => {
    if (!user.value) return true
    if (submitted.value) return true
    if (saving.value || uploading.value || customerSaving.value) {
      ElMessage.warning('正在保存或上传，请稍后离开')
      return false
    }
    if (!dirty.value) return true
    try {
      await ElMessageBox.confirm('当前订单尚未发布，离开后会丢失已填写内容。', '离开下单页面', {
        confirmButtonText: '离开页面',
        cancelButtonText: '继续填写',
        type: 'warning'
      })
      return true
    } catch {
      return false
    }
  })
  const selectedTemplate = computed(() =>
    templates.value.find((item) => item.id === form.templateId)
  )
  const selectedPlatform = computed(() =>
    data.value?.platforms.find((item) => item.id === form.platformId)
  )
  const rules = computed(() => rulesForPlatform(selectedPlatform.value))
  const shops = computed(
    () => data.value?.shops.filter((item) => item.platformId === form.platformId) ?? []
  )
  const players = computed(
    () =>
      data.value?.users.filter(
        (item) =>
          item.role === 'player' &&
          item.status === 'active' &&
          item.playerAccess?.login !== false &&
          item.playerAccess?.claim !== false
      ) ?? []
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
  function changeTemplate(id: string) {
    const item = templates.value.find((template) => template.id === id)
    if (item) selectTemplate(item)
  }
  async function openCustomerDialog() {
    if (operationBusy.value) return
    if (!customerDraft.id) {
      customerDraft.platformId = form.platformId || null
      await nextTick()
      customerReference.shopId = customerShops.value.some((item) => item.id === form.shopId)
        ? form.shopId
        : customerRules.value.requiresShop
          ? (customerShops.value[0]?.id ?? '')
          : ''
      customerReference.externalOrderNo = form.externalOrderNo
    }
    customerDialog.value = true
  }
  watch(
    () => customerDraft.platformId,
    () => {
      customerReference.shopId = customerRules.value.requiresShop
        ? (customerShops.value[0]?.id ?? '')
        : ''
      customerReference.externalOrderNo = ''
    }
  )
  watch(
    () => form.platformId,
    () => {
      form.shopId = rules.value.requiresShop ? (shops.value[0]?.id ?? '') : ''
      form.payOnArrival = false
      form.externalOrderNo = ''
    }
  )
  watch(
    () => form.customerId,
    (id) => {
      const customer = data.value?.customers.find((item) => item.id === id)
      if (customer) {
        form.gameId = customer.gameId
        if (!form.platformId && customer.platformId) form.platformId = customer.platformId
      }
      void loadCustomerBalance()
    }
  )
  watch(
    () => form.paymentMethod,
    (method) => {
      form.payOnArrival = false
      form.receipt = null
      if (method === 'balance') void loadCustomerBalance()
    }
  )
  watch(
    () => form.amount,
    (amount, old) => {
      if (form.receivedAmount === old || form.receivedAmount === null) form.receivedAmount = amount
    }
  )

  watch(
    () => rules.value.allowPayOnArrival,
    (allowed) => {
      if (!allowed) form.payOnArrival = false
    }
  )

  async function saveCustomer(selectAfterSave = true) {
    if (customerSaving.value) return
    if (!customerDraft.name.trim()) {
      ElMessage.warning('请填写客户名称')
      return
    }
    const externalOrderNo = customerReference.externalOrderNo.trim()
    const needsReference = customerRules.value.requiresExternalOrderNo
    if (needsReference && !externalOrderNo && (!selectAfterSave || !customerHasReference.value))
      return void ElMessage.warning('当前客户来源要求平台订单号，请填写关联编号')
    if (
      needsReference &&
      externalOrderNo &&
      customerRules.value.requiresShop &&
      !customerReference.shopId
    )
      return void ElMessage.warning('当前客户来源要求店铺，请选择同来源店铺')
    customerSaving.value = true
    try {
      const result = await mutate<Customer>('/customers', {
        ...customerDraft,
        id: customerDraft.id || undefined,
        name: customerDraft.name.trim()
      })
      // 建档与关联编号是独立保存；后续失败时继续维护同一客户，避免重复建档。
      customerDraft.id = result.id
      if (needsReference && externalOrderNo) {
        const submittedReference = {
          customerId: result.id,
          platformId: customerDraft.platformId!,
          shopId: customerReference.shopId || null,
          externalOrderNo
        }
        const sameReference = (item: CustomerOrderReference) =>
          item.platformId === submittedReference.platformId &&
          item.shopId === submittedReference.shopId &&
          item.externalOrderNo === submittedReference.externalOrderNo
        let reference = savedCustomerReferences.value.find(sameReference)
        if (!reference) {
          try {
            reference = await mutate<CustomerOrderReference>(
              '/customer-order-references',
              submittedReference
            )
          } catch (cause) {
            // 编号成功但响应丢失时，核对最新记录后继续，重复编号不会再次入库。
            const recent = await studioRequest<{ records: CustomerOrderReference[] }>(
              `customers/${encodeURIComponent(result.id)}/order-references?current=1&size=100`
            ).catch(() => null)
            reference = recent?.records.find(sameReference)
            if (!reference) throw cause
          }
          savedCustomerReferences.value.unshift(reference)
        }
      }
      if (!selectAfterSave) {
        customerReference.externalOrderNo = ''
        ElMessage.success('客户及关联编号已保存，可继续添加下一条')
        return
      }
      form.customerId = result.id
      if (customerDraft.platformId) form.platformId = customerDraft.platformId
      await nextTick()
      const lastReference = savedCustomerReferences.value.find(
        (item) => item.platformId === form.platformId
      )
      if (lastReference && rules.value.requiresExternalOrderNo) {
        form.shopId = lastReference.shopId || ''
        form.externalOrderNo = lastReference.externalOrderNo
      }
      customerDialog.value = false
      Object.assign(customerDraft, {
        id: '',
        name: '',
        contact: '',
        gameId: '',
        remark: '',
        platformId: null
      })
      savedCustomerReferences.value = []
      Object.assign(customerReference, { shopId: '', externalOrderNo: '' })
      ElMessage.success('客户已建档并选中')
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      customerSaving.value = false
    }
  }

  async function submitOrder() {
    if (operationBusy.value) return
    const balancePayment = form.paymentMethod === 'balance'
    if (
      balancePayment &&
      (balanceLoading.value || customerBalance.value === null || balanceError.value)
    )
      return void ElMessage.warning(balanceError.value || '请选择客户并等待储值余额读取完成')
    if (
      balancePayment &&
      customerBalance.value !== null &&
      toCents(form.amount) > customerBalance.value
    )
      return void ElMessage.warning('客户储值余额不足，请先充值或选择现金 / 平台收款')
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
                : rules.value.requiresShop && !form.shopId
                  ? '请选择来源店铺'
                  : rules.value.requiresExternalOrderNo && !form.externalOrderNo.trim()
                    ? '请填写平台订单号'
                    : form.payOnArrival && !rules.value.allowPayOnArrival
                      ? '当前订单来源不允许落地付'
                      : form.dispatchMode === 'direct' && !form.assignedTo
                        ? '请选择要指派的打手'
                        : !balancePayment &&
                            !form.payOnArrival &&
                            (form.receivedAmount === null || form.receivedAmount <= 0)
                          ? '普通订单须先确认客户已付款'
                          : !balancePayment &&
                              !form.payOnArrival &&
                              toCents(form.receivedAmount) !== toCents(form.amount)
                            ? '普通订单须足额收款，请核对订单金额与实收金额'
                            : !balancePayment && !form.payOnArrival && !form.paidAt
                              ? '请选择客户实际付款时间'
                              : !balancePayment &&
                                  !form.payOnArrival &&
                                  rules.value.requiresReceipt &&
                                  !form.receipt
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
        requestId: orderRequestId,
        amount: toCents(form.amount),
        reward: toCents(form.reward),
        receivedAmount: balancePayment
          ? toCents(form.amount)
          : form.payOnArrival
            ? 0
            : toCents(form.receivedAmount),
        paidAt: balancePayment || form.payOnArrival ? null : form.paidAt,
        receipt:
          balancePayment || form.payOnArrival || !rules.value.requiresReceipt ? null : form.receipt,
        shopId: form.shopId || null,
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
        submitted.value = true
        await router.push(id ? { path: '/orders/list', query: { id } } : '/orders/list')
      } else {
        Object.assign(form, {
          templateId: '',
          customerId: '',
          platformId: '',
          shopId: '',
          externalOrderNo: '',
          roomCode: '',
          gameId: '',
          map: '不限',
          amount: null,
          reward: null,
          remark: '',
          dispatchMode: 'pool',
          assignedTo: '',
          payOnArrival: false,
          paymentMethod: 'cash',
          receivedAmount: null,
          paidAt: new Date().toISOString(),
          receipt: null
        })
      }
    } catch (error) {
      ElMessage.error(errorText(error))
    } finally {
      saving.value = false
      submitted.value = false
    }
  }

  defineOptions({ name: 'OrderCreate' })
  onMounted(() => refresh().catch(() => {}))
  onUnmounted(() => {
    balanceVersion++
  })
</script>
<template>
  <div>
    <BusinessPageHeader
      title="创建与派单"
      description="先选择订单项目，再补充客户、来源与付款信息，发布到抢单池或指定打手。"
      icon="ri:add-box-line"
      badge="价格与模板快照随单保存"
    />
    <ElCard class="mb-5" shadow="never"
      ><ElSteps
        :active="activeStep"
        finish-status="success"
        :simple="!isMobile"
        :direction="isMobile ? 'vertical' : 'horizontal'"
        ><ElStep v-for="step in steps" :key="step.label" :title="step.label" /></ElSteps
    ></ElCard>
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
            :disabled="operationBusy"
            @submit.prevent="submitOrder"
          >
            <ElFormItem label="订单项目" required>
              <ElSelect
                v-model="form.templateId"
                filterable
                placeholder="选择已启用的订单模板"
                @change="changeTemplate"
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
                    ><ElButton :disabled="operationBusy" @click="openCustomerDialog"
                      >新增</ElButton
                    ></div
                  ></ElFormItem
                ></ElCol
              >
              <ElCol :xs="24" :sm="12"
                ><ElFormItem label="订单来源" required
                  ><ElSelect v-model="form.platformId" placeholder="选择来源"
                    ><ElOption
                      v-for="item in data?.platforms"
                      :key="item.id"
                      :value="item.id"
                      :label="item.name" /></ElSelect></ElFormItem
              ></ElCol>
              <ElCol v-if="shops.length || rules.requiresShop" :xs="24" :sm="12"
                ><ElFormItem label="来源店铺" :required="rules.requiresShop"
                  ><ElSelect
                    v-model="form.shopId"
                    :clearable="!rules.requiresShop"
                    placeholder="选择同来源店铺"
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
              <ElCol v-if="rules.requiresExternalOrderNo" :xs="24" :sm="12"
                ><ElFormItem label="平台订单号" required
                  ><ElInput
                    v-model="form.externalOrderNo"
                    maxlength="128"
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
            <ElFormItem label="收款方式" required>
              <ElRadioGroup v-model="form.paymentMethod">
                <ElRadioButton value="cash">现金 / 平台收款</ElRadioButton>
                <ElRadioButton value="balance">老板储值支付</ElRadioButton>
              </ElRadioGroup>
            </ElFormItem>
            <ElFormItem
              v-if="rules.allowPayOnArrival && form.paymentMethod === 'cash'"
              label="付款方式"
              ><ElSwitch v-model="form.payOnArrival" active-text="落地付：先发布，后补收款"
            /></ElFormItem>
            <div v-if="form.paymentMethod === 'balance'" class="mb-5">
              <div class="flex items-center gap-3 flex-wrap mb-3">
                <span
                  >当前储值余额：{{ balanceLoading ? '正在读取…' : money(customerBalance) }}</span
                >
                <ElButton
                  size="small"
                  :disabled="operationBusy || balanceLoading || !form.customerId"
                  @click="loadCustomerBalance"
                  >刷新余额</ElButton
                >
              </div>
              <ElAlert
                v-if="balanceError"
                :title="balanceError"
                type="error"
                :closable="false"
                class="mb-3"
              />
              <ElAlert
                title="发布时从该客户储值余额扣除全额，并记录实际支付时间；按原来源规则允许退款时，会退回原储值账户。无需重复登记现金收款。"
                type="info"
                :closable="false"
              />
            </div>
            <ElAlert
              v-if="form.payOnArrival"
              title="落地付订单发布后须补录实际收款时间与凭证，收款前不能通过财务验收。"
              type="warning"
              :closable="false"
              show-icon
              class="mb-5"
            />
            <template v-else-if="form.paymentMethod === 'cash'">
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
              <ElFormItem v-if="rules.requiresReceipt" label="付款凭证" required
                ><BusinessUpload
                  v-model="form.receipt"
                  :disabled="saving || customerSaving"
                  @busy="uploading = $event"
              /></ElFormItem>
              <ElAlert
                v-else
                title="当前来源无需付款截图，请核对实际付款时间与相关平台信息。"
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
              ><ElButton
                v-if="can('orders.view')"
                :disabled="operationBusy"
                @click="router.push('/orders/list')"
                >返回订单</ElButton
              ><ElButton
                type="primary"
                :loading="saving"
                :disabled="
                  uploading ||
                  customerSaving ||
                  (form.paymentMethod === 'balance' && balanceLoading)
                "
                native-type="submit"
                >{{
                  form.paymentMethod === 'balance'
                    ? '确认储值扣款并发布订单'
                    : form.payOnArrival
                      ? '发布落地付订单'
                      : '确认收款并发布订单'
                }}</ElButton
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
      class="quick-customer-dialog"
      title="新增客户档案"
      width="min(680px, 94vw)"
      :close-on-click-modal="!customerSaving"
      :close-on-press-escape="!customerSaving"
      :show-close="!customerSaving"
      ><ElAlert
        v-if="customerDraft.id"
        title="客户档案已保存；可继续追加编号，保存并选择后返回当前订单。"
        type="success"
        :closable="false"
        class="mb-4"
      /><ElForm
        :model="customerDraft"
        label-position="top"
        :disabled="customerSaving"
        @submit.prevent="saveCustomer()"
        ><ElFormItem label="客户名称" required
          ><ElInput v-model="customerDraft.name" maxlength="100" /></ElFormItem
        ><ElFormItem label="客户来源"
          ><ElSelect v-model="customerDraft.platformId" clearable placeholder="选择来源"
            ><ElOption
              v-for="item in data?.platforms || []"
              :key="item.id"
              :value="item.id"
              :label="item.name" /></ElSelect
        ></ElFormItem>
        <template v-if="customerRules.requiresExternalOrderNo">
          <ElAlert
            :title="`${customerPlatform?.name || '当前来源'}要求平台订单号；可逐条追加多个关联编号。档案编号不会生成业务订单或收入。`"
            type="info"
            :closable="false"
            class="mb-4"
          />
          <ElFormItem
            v-if="customerShops.length || customerRules.requiresShop"
            label="关联店铺"
            :required="customerRules.requiresShop"
            ><ElSelect
              v-model="customerReference.shopId"
              :clearable="!customerRules.requiresShop"
              placeholder="选择同来源店铺"
              ><ElOption
                v-for="item in customerShops"
                :key="item.id"
                :value="item.id"
                :label="item.name" /></ElSelect
          ></ElFormItem>
          <ElFormItem label="关联平台订单号" :required="!customerHasReference"
            ><ElInput
              v-model="customerReference.externalOrderNo"
              maxlength="128"
              placeholder="填写完整编号，可保留开头的 0"
          /></ElFormItem>
        </template>
        <div v-if="savedCustomerReferences.length" class="mb-4">
          <p class="text-sm text-g-500 mb-2"
            >已独立保存 {{ savedCustomerReferences.length }} 条编号</p
          >
          <div class="flex flex-wrap gap-2">
            <ElTag
              v-for="item in savedCustomerReferences"
              :key="item.id"
              :title="item.externalOrderNo"
              class="quick-customer-reference-tag"
            >
              {{ data?.platforms.find((platform) => platform.id === item.platformId)?.name }}：{{
                item.externalOrderNo
              }}
            </ElTag>
          </div>
        </div>
        <ElFormItem label="联系方式"
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
        ><ElButton
          v-if="customerRules.requiresExternalOrderNo"
          :disabled="customerSaving"
          @click="saveCustomer(false)"
          >保存并继续添加编号</ElButton
        ><ElButton type="primary" :loading="customerSaving" @click="saveCustomer()"
          >保存并选择</ElButton
        ></template
      ></ElDialog
    >
  </div>
</template>

<style scoped>
  :deep(.quick-customer-dialog .el-dialog__footer) {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  :deep(.quick-customer-dialog .el-dialog__footer .el-button + .el-button) {
    margin-left: 0;
  }

  .quick-customer-reference-tag {
    max-width: 100%;
    height: auto;
    min-height: 24px;
  }

  .quick-customer-reference-tag :deep(.el-tag__content) {
    overflow-wrap: anywhere;
    white-space: normal;
  }
</style>
