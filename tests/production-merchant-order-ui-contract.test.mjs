import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

async function cancelFromRealUi(merchant) {
  const source = readFileSync(new URL('../src/views/orders/modules/order-detail.vue', import.meta.url), 'utf8')
  const start = source.indexOf('async function submitAction()')
  const end = source.indexOf('async function saveRemark()', start)
  assert.ok(start > 0 && end > start)
  const script = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls = [], warnings = [], errors = []
  const state = {
    order: { value: { id: 'shared-order', amount: 8000, receivedAmount: 8000, status: 'active' } },
    dialog: { value: 'cancel' },
    expected: { value: { expectedRevision: 3 } },
    saving: { value: false },
    uploading: { value: false },
    fields: { amount: 25, reason: '客户要求取消', refundDestination: 'cash', refundChannel: 'wechat', refundChannelNote: '', actualRefundConfirmed: false },
    isMerchant: { value: merchant },
    isHall: { value: false },
    refundAvailable: { value: 8000 },
    cashAmountChanged: { value: false },
    can: () => false,
    toCents: (value) => Math.round(Number(value) * 100),
    validateRefundRoute: () => null,
    refundOutcome: () => '申请已记录',
    actionIntent: { prepare: (_path, body) => body, complete() {}, fail: (error) => errors.push(error) },
    mutate: async (path, body) => calls.push({ path, body }),
    loadOrder: async () => {},
    errorText: (error) => error.message,
    ElMessage: { warning: (value) => warnings.push(value), error: (value) => errors.push(value), success() {} }
  }
  const submit = new Function(...Object.keys(state), `${script}\nreturn submitAction`)(...Object.values(state))
  await submit()
  assert.deepEqual(warnings, [])
  assert.deepEqual(errors, [])
  assert.equal(calls.length, 1)
  return calls[0]
}

test('merchant whole-order cancellation submits task cancellation without financial fields', async () => {
  const { path, body } = await cancelFromRealUi(true)
  assert.equal(path, '/orders/shared-order/action')
  assert.deepEqual(body, { action: 'cancel', reason: '客户要求取消', expectedRevision: 3 })
})

test('internal cancellation preserves production combined cancellation and refund payload', async () => {
  const { body } = await cancelFromRealUi(false)
  assert.equal(body.action, 'cancel-refund')
  assert.equal(body.refundAmount, 2500)
  assert.equal(body.refundDestination, 'cash')
  assert.equal(body.refundChannel, 'wechat')
})

function computedFromSource(source, startName, endName, names, state) {
  const start = source.indexOf(`const ${startName} =`)
  const end = source.indexOf(`const ${endName} =`, start)
  assert.ok(start > 0 && end > start)
  const script = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function('computed', ...Object.keys(state), `${script}\nreturn {${names.join(',')}}`)(
    (read) => ({ get value() { return read() } }), ...Object.values(state)
  )
}

test('merchant order views keep unsupported internal lifecycle and lottery controls hidden', () => {
  const source = readFileSync(new URL('../src/views/orders/modules/order-detail.vue', import.meta.url), 'utf8')
  for (const merchant of [true, false]) {
    const state = {
      isMerchant: { value: merchant },
      user: { value: { id: 'actor', role: merchant ? 'merchant' : 'support' } },
      order: { value: { status: 'active', stored: false, snapshot: { playType: 'lottery' } } },
      can: () => true
    }
    const controls = computedFromSource(source, 'canEdit', 'problems', ['canStore', 'canResume'], state)
    assert.equal(controls.canStore.value, !merchant)
    state.order.value.stored = true
    assert.equal(Boolean(controls.canResume.value), !merchant)
    const lottery = computedFromSource(source, 'isLotteryOrder', 'lotteryStatus', ['isLotteryOrder'], state)
    assert.equal(lottery.isLotteryOrder.value, !merchant)
    for (const action of ['problem-open', 'problem-close']) {
      const button = [...source.matchAll(/<ElButton\b[^>]*>/g)].map((m) => m[0]).find((text) => text.includes(`openAction('${action}')`))
      assert.ok(button, action)
      const expression = button.match(/v-if="([^"]+)"/)[1]
      const visible = new Function('isMerchant', 'canEdit', 'order', `return ${expression}`)(merchant, true, {
        status: 'active', problem: action === 'problem-close' ? { status: 'open' } : null
      })
      assert.equal(Boolean(visible), !merchant, action)
    }
  }
})

test('arrival payment reminder is suppressed for authorized merchant credit while ordinary arrival payment stays visible', () => {
  const source = readFileSync(new URL('../player-client/src/views/player/ArrivalPaymentNotice.vue', import.meta.url), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(script, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '')
  const visible = (order) => new Function('computed', 'defineProps', `${compiled}\nreturn visible.value`)(
    (read) => ({ get value() { return read() } }), () => ({ order })
  )
  const ordinary = { status: 'active', payOnArrival: true, paymentConfirmed: false }
  assert.equal(visible(ordinary), true)
  assert.equal(visible({ ...ordinary, fulfillmentAuthorized: true }), false)
  assert.equal(visible({ ...ordinary, fulfillmentAuthorized: false }), true)
  assert.equal(visible({ ...ordinary, paymentConfirmed: true }), false)
  assert.equal(visible({ ...ordinary, historyOnly: true }), false)
})

function uiExpression(expression, values) {
  const script = ts.transpileModule(`function readValue() { return (${expression}) }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function(...Object.keys(values), `${script}\nreturn readValue()`)(...Object.values(values))
}

function presentationHelpers() {
  const source = readFileSync(new URL('../src/hooks/business/useStudio.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '')
  return new Function(`${compiled}\nreturn { money, orderStatusLabel, statusLabels }`)()
}

function detailAmounts(order, isMerchant = true, refunded = 0) {
  const source = readFileSync(new URL('../src/views/orders/modules/order-detail.vue', import.meta.url), 'utf8')
  const expression = source.match(/<BusinessDetailSummary\s+:items="([\s\S]*?)"\s*\/>/)[1]
  return uiExpression(expression, { order, isMerchant, refunded, ...presentationHelpers() })
}

test('merchant canceled and refunded details separate original quote from current due, net paid and outstanding', () => {
  for (const order of [
    { status: 'canceled', receivedAmount: 0 },
    { status: 'active', displayStatus: 'refunded', fullRefund: true, receivedAmount: 8000 }
  ]) {
    const items = detailAmounts({
      amount: 8000, merchantCustomerAmount: 10000,
      ...order,
      merchantFinancials: { receivableAmount: 0, receivedAmount: 0, outstandingAmount: 0 }
    })
    const values = Object.fromEntries(items.map((item) => [item.label, item.value]))
    assert.equal(values['应付金小盾'], '¥0.00')
    assert.equal(values['约定结算价'], '¥80.00')
    assert.equal(values['净已付'], '¥0.00')
    assert.equal(values['尚未结清'], '¥0.00')
  }
})

test('merchant detail uses server net payment after partial refunds and never invents canceled debt without financial projection', () => {
  const values = Object.fromEntries(detailAmounts({
    amount: 8000, receivedAmount: 8000, merchantCustomerAmount: 10000, status: 'active',
    merchantFinancials: { receivableAmount: 8000, receivedAmount: 6000, outstandingAmount: 2000 }
  }).map((item) => [item.label, item.value]))
  assert.equal(values['应付金小盾'], '¥80.00')
  assert.equal(values['净已付'], '¥60.00')
  assert.equal(values['尚未结清'], '¥20.00')
  const missing = Object.fromEntries(detailAmounts({ amount: 8000, receivedAmount: 0, status: 'canceled' }).map((item) => [item.label, item.value]))
  assert.equal(missing['约定结算价'], '¥80.00')
  assert.equal(missing['应付金小盾'], '待核对')
  assert.equal(missing['尚未结清'], '待核对')
})

test('internal detail summary preserves gross receipts, refund and remaining net income presentation', () => {
  const items = detailAmounts({ amount: 8000, receivedAmount: 8000, status: 'active' }, false, 2000)
  assert.deepEqual(items.map((item) => [item.label, item.value]), [
    ['订单金额', '¥80.00'], ['累计收款', '¥80.00'], ['累计退款', '¥20.00'], ['剩余净收入', '¥60.00']
  ])
})

test('merchant overview recent orders present current display status and actual amount due', () => {
  const source = readFileSync(new URL('../src/views/merchant/overview/index.vue', import.meta.url), 'utf8')
  const column = (label, row) => {
    const start = source.indexOf(`<ElTableColumn label="${label}"`)
    assert.ok(start > 0, label)
    const text = source.slice(start, source.indexOf('</ElTableColumn', start))
    return uiExpression(text.match(/{{([\s\S]*?)}}/)[1], { row, ...presentationHelpers() })
  }
  const row = { status: 'active', displayStatus: 'refunded', amount: 8000, merchantFinancials: { receivableAmount: 0 } }
  assert.equal(column('订单状态', row), '已退款')
  assert.equal(column('应付金小盾', row), '¥0.00')
})

test('merchant overview exposes stored, refunded and refund-pending counts without losing existing states', () => {
  const source = readFileSync(new URL('../src/views/merchant/overview/index.vue', import.meta.url), 'utf8')
  const summary = { orders: 8, pending: 1, active: 1, review: 1, completed: 1, canceled: 1, stored: 1, refunded: 1, refundPending: 1 }
  const rendered = new Map([...source.matchAll(/<ElDescriptionsItem label="([^"]+)">{{([\s\S]*?)}}<\/ElDescriptionsItem>/g)].map((match) => [
    match[1], uiExpression(match[2], { report: { summary }, ...presentationHelpers() })
  ]))
  assert.equal(rendered.get('已存单'), 1)
  assert.equal(rendered.get('已退款'), 1)
  assert.equal(rendered.get('退款审批中'), 1)
  assert.equal(['待接单', '接单中', '待验收', '已完成', '已取消', '已存单', '已退款', '退款审批中'].reduce((sum, label) => sum + rendered.get(label), 0), 8)
})

test('merchant public problem status is not rendered as private problem history requiring feedback details', () => {
  const source = readFileSync(new URL('../src/views/orders/modules/order-detail.vue', import.meta.url), 'utf8')
  const publicProblem = { id: 'problem', status: 'open', openedAt: '2026-11-11T06:00:00Z' }
  const merchant = computedFromSource(source, 'problems', 'cashAmountChanged', ['problems', 'storageRecords'], {
    isMerchant: { value: true }, order: { value: { problem: publicProblem } }
  })
  assert.deepEqual(merchant.problems.value, [])
  const internal = computedFromSource(source, 'problems', 'cashAmountChanged', ['problems'], {
    isMerchant: { value: false }, order: { value: { problem: { ...publicProblem, reason: '内部说明', feedback: [] } } }
  })
  assert.equal(internal.problems.value[0].reason, '内部说明')
})
