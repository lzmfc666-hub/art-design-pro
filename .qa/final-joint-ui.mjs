import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer as createViteServer } from 'vite'
import { createStudioServer } from '../server/index.mjs'
import { createServer as createPortProbe } from 'node:net'
import { sourceFingerprint } from '../scripts/studio-source-fingerprint.mjs'

async function freePort() {
  const probe=createPortProbe()
  await new Promise(ready=>probe.listen(0,'127.0.0.1',ready))
  const port=probe.address().port
  await new Promise(close=>probe.close(close))
  return port
}

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const qaRoot = process.env.STUDIO_FINAL_QA_ROOT ? resolve(process.env.STUDIO_FINAL_QA_ROOT, 'joint-ui') : resolve('.qa/final-joint-ui')
const output = resolve(qaRoot, 'run-' + randomUUID())
mkdirSync(output, { recursive: true })
// Keep Vite's derived declarations out of implementation sources during evidence capture.
process.env.STUDIO_QA_DECLARATIONS_DIR = resolve(output, 'generated-types')
const password = 'isolated-backend-stability-test-only'
let time = new Date('2026-10-14T05:00:00Z')
const clock = () => time
const server = createStudioServer({
  dbPath: resolve(output, 'test.sqlite'), seed: false, password, clock,
  backups: { intervalMinutes: 0, directory: resolve(output, 'backups'), failureWebhook: '' },
  notificationIntervalMs: 86400000, notifications: { clock, publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] }
})
const service = server.service
const proxyRequests=[]
server.on('request',req=>{ if(req.url.startsWith('/api/studio/')) proxyRequests.push({path:req.url.split('?')[0],client:req.headers['x-studio-client']||'admin',hasAdminCookie:(req.headers.cookie||'').includes('studio_session='),hasPlayerCookie:(req.headers.cookie||'').includes('studio_player_session=')}) })
const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, { requestId: randomUUID(), ...body })
const current = (id) => service.orderDetail('admin', id).order
const action = (id, body, actor = 'admin') => {
  const row = current(id)
  return mutate(`/orders/${id}/action`, { expectedRevision: row.revision, assignmentId: row.assignmentId,
    submissionId: row.submissionId, dispatchRound: row.dispatchRound, leaderId: row.leaderId, ...body }, actor)
}
const level = mutate('/levels', { name: '后台隔离联调等级', delaySeconds: 0 })
const players = ['A', 'B'].map((name) => mutate('/users', { username: 'isolated-player-' + name, name: '隔离打手' + name,
  role: 'player', status: 'active', levelId: level.id, maxActiveOrders: 1, permissionOverrides: {}, password }))
const finance = mutate('/users', {username:'joint-finance',name:'联合联调财务',role:'finance',status:'active',levelId:level.id,maxActiveOrders:1,permissionOverrides:{},password})
const platform = mutate('/platforms', { name: '隔离测试来源', rules: { requiresShop: false, requiresExternalOrderNo: false,
  requiresReceipt: false, allowPayOnArrival: true } })
const customer = mutate('/customers', { name: '隔离客户', gameId: 'QA' })
const template = mutate('/templates', { name: '隔离后台订单', game: 'QA', amount: 10000, reward: 7000, active: true })
const createOrder = (body = {}) => mutate('/orders', { templateId: template.id, customerId: customer.id, platformId: platform.id,
  roomCode: 'QA', amount: 10000, reward: 7000, receivedAmount: 10000, paidAt: time.toISOString(), dispatchMode: 'pool',
  remark: 'INTERNAL-QA-ONLY', playerRemark: 'PUBLIC-QA-ONLY', ...body })
const orders = Array.from({ length: 23 }, () => createOrder())
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const api = `http://127.0.0.1:${server.address().port}`
const vite = await createViteServer({ cacheDir: resolve(output, 'vite-cache'), server: { host: '127.0.0.1', port: await freePort(),
  strictPort: true, watch: { ignored: ['**/player-client/**', '**/.qa/**', '**/.data/**'] },
  proxy: { '/api': { target: api, changeOrigin: true } } } })
await vite.listen()
const base = `http://127.0.0.1:${vite.httpServer.address().port}`
const playerVite = await createViteServer({root:resolve('player-client'),configFile:resolve('player-client/vite.config.ts'),cacheDir:resolve(output,'player-vite-cache'),server:{host:'127.0.0.1',port:await freePort(),strictPort:true,proxy:{'/api/studio':{target:api,changeOrigin:true,headers:{'X-Studio-Client':'player'}}}}})
await playerVite.listen()
const playerBase=`http://127.0.0.1:${playerVite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
const page = await context.newPage()
const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})
const mobile=await mobileContext.newPage()
mobile.setDefaultTimeout(20000)
const financeContext=await browser.newContext({viewport:{width:1440,height:1100}})
const financePage=await financeContext.newPage()
financePage.setDefaultTimeout(20000)
page.setDefaultTimeout(20000)
const result = { passes: [], pageErrors: [], serverErrors: [], requests: [], output, apiPort: server.address().port,
  uiPort: vite.httpServer.address().port, playerPort:playerVite.httpServer.address().port,proxyRequests, testDatabase: resolve(output, 'test.sqlite'), sourceBefore:sourceFingerprint() }
page.on('pageerror', (error) => result.pageErrors.push(error.message))
page.on('response', (response) => {
  if (response.url().includes('/api/') && response.status() >= 500) result.serverErrors.push({ path: new URL(response.url()).pathname, status: response.status() })
})
page.on('request', (request) => {
  if (request.url().includes('/api/studio/orders/') && request.method() === 'POST') result.requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
})
for(const [name,entry] of [['mobile',mobile],['finance',financePage]]){ entry.on('pageerror',error=>result.pageErrors.push(name+': '+error.message));entry.on('response',reply=>{if(reply.url().includes('/api/studio/')&&reply.status()>=500)result.serverErrors.push({surface:name,path:new URL(reply.url()).pathname,status:reply.status()})});entry.on('request',req=>{if(req.url().includes('/api/studio/')&&req.method()==='POST'&&!req.url().endsWith('/login'))result.requests.push({surface:name,path:new URL(req.url()).pathname,body:req.postDataJSON()})})}
const field = (scope, label) => scope.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label').filter({ hasText: label }) }).first()
const dialog = () => page.locator('.business-detail-page-panel[data-page-key="order-action"]:visible, .el-dialog:visible').last()
const drawer = () => page.locator('.business-detail-page-panel[data-page-key="order-detail"]:visible, .el-drawer:visible').last()
const waitAction = (id) => page.waitForResponse((response) => response.url().endsWith(`/orders/${id}/action`) && response.request().method() === 'POST')
async function waitOrderIdentity(target, id) {
  await target.waitForURL(url => {
    const query = new URL(url.hash.slice(1), url.origin).searchParams
    const index = query.getAll('secondary').lastIndexOf('order-detail')
    return index >= 0 && query.getAll('secondaryRecord')[index] === id
  })
}
async function openOrder(id) {
  if (await drawer().count())
    await drawer().getByRole('button', { name: '刷新订单并重新确认操作', exact: true }).click({ trial: true })
  await page.goto(base + '/#/orders/list?id=' + id)
  await waitOrderIdentity(page, id)
  await drawer().getByText(current(id).orderNo, { exact: true }).first().waitFor()
  await drawer().getByRole('button', { name: '编辑订单', exact: true }).waitFor()
  await page.waitForLoadState('networkidle')
}
async function openEdit() {
  await drawer().getByRole('button', { name: '编辑订单', exact: true }).click()
  await dialog().getByRole('heading', { name: '编辑实际订单', exact: true, level: 2 }).waitFor()
}
async function fillReason(value) {
  await field(dialog(), '原因 / 处理说明').locator('textarea').fill(value)
}
const pass = (name) => { result.passes.push(name); console.log('PASS ' + name) }
try {
  assert.equal((await context.request.post(base + '/api/studio/login', { data: { username: 'admin', password } })).status(), 200)
  await page.goto(base + '/#/orders/list')
  await page.locator('#app-main .el-table__body tr').first().waitFor()
  const firstPage = await context.request.get(base + '/api/studio/orders?current=1&size=20')
  assert.equal((await firstPage.json()).records.length, 20)
  const page2 = page.waitForResponse((response) => response.url().includes('/api/studio/orders?') && new URL(response.url()).searchParams.get('current') === '2')
  await page.locator('#app-main .el-pagination .btn-next').last().click()
  assert.equal((await (await page2).json()).records.length, 3)
  pass('订单列表真实服务端分页与总数')

  await fullLifecycle()

  const editOrder = orders[0]
  await openOrder(editOrder.id)
  await openEdit()
  const oldRevision = current(editOrder.id).revision
  await field(dialog(), '内部备注（保留历史内容，不向打手公开）').locator('textarea').fill('未提交的后台编辑输入')
  action(editOrder.id, { action: 'edit', roomCode: 'QA', gameId: '', map: '', amount: 10000, reward: 7000, remark: '别人后来保存的内容', reason: '并发编辑测试' })
  await fillReason('尝试保存过期内容')
  let waiting = waitAction(editOrder.id)
  await dialog().getByRole('button', { name: '确认保存', exact: true }).click()
  let response = await waiting
  assert.equal(response.status(), 409)
  assert.equal((await response.json()).code, 'ORDER_REVISION_CONFLICT')
  assert.equal(result.requests.at(-1).body.expectedRevision, oldRevision)
  assert.equal(current(editOrder.id).remark, '别人后来保存的内容')
  assert.equal(await field(dialog(), '内部备注（保留历史内容，不向打手公开）').locator('textarea').inputValue(), '未提交的后台编辑输入')
  await page.screenshot({ path: resolve(output, 'edit-conflict.png') })
  pass('多人编辑409，旧版本不会静默覆盖并保留输入')
  await dialog().getByRole('button', { name: '返回', exact: true }).click()
  await drawer().getByRole('button', { name: '刷新订单并重新确认操作', exact: true }).click()
  await drawer().getByText('别人后来保存的内容', { exact: true }).waitFor()

  await drawer().getByRole('button', { name: '编辑备注', exact: true }).click()
  await drawer().locator('textarea').fill('明确公开给打手的说明')
  waiting = waitAction(editOrder.id)
  await drawer().getByRole('button', { name: '保存备注', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.equal(current(editOrder.id).playerRemark, '明确公开给打手的说明')
  assert.equal(current(editOrder.id).remark, '别人后来保存的内容')
  const publicOrder = service.playerOrderDetail(players[0].id, editOrder.id)
  assert.equal(publicOrder.playerRemark, '明确公开给打手的说明')
  assert.equal(publicOrder.remark, undefined)
  assert.equal(publicOrder.amount, undefined)
  pass('公开playerRemark与内部历史备注、客户金额保持隔离')

  await openEdit()
  await field(dialog(), '订单金额（元）').locator('input').fill('120')
  await fillReason('仅修正历史录错金额')
  const requestsBefore = result.requests.length
  await dialog().getByRole('button', { name: '确认保存', exact: true }).click()
  await page.getByText('已收款现金单改金额须确认是历史录错更正，并会回改原实收与原付款日统计', { exact: true }).waitFor()
  assert.equal(result.requests.length, requestsBefore)
  await dialog().getByText('确认仅更正历史录错：同步更正原实收及原付款日统计，未发生新收款或实际退款', { exact: true }).click()
  waiting = waitAction(editOrder.id)
  await dialog().getByRole('button', { name: '确认保存', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.equal(current(editOrder.id).receivedAmount, 12000)
  assert.equal(result.requests.at(-1).body.amountChangeKind, 'historical-correction')
  assert.equal(result.requests.at(-1).body.affectsHistoricalReceived, true)
  await dialog().waitFor({ state: 'hidden' })
  pass('现金历史金额更正必须明确确认影响实收和原付款日统计')

  await openEdit()
  await field(dialog(), '内部备注（保留历史内容，不向打手公开）').locator('textarea').fill('响应丢失安全重试')
  await fillReason('隔离测试实际成功响应丢失')
  const retryRevision = current(editOrder.id).revision
  let aborted = false
  await page.route(`**/api/studio/orders/${editOrder.id}/action`, async (route) => {
    if (!aborted) {
      const actual = await route.fetch()
      assert.equal(actual.status(), 200)
      aborted = true
      await route.abort('failed')
    } else await route.continue()
  })
  await dialog().getByRole('button', { name: '确认保存', exact: true }).click()
  await page.getByText('Failed to fetch', { exact: true }).waitFor()
  const firstRetryBody = result.requests.at(-1).body
  assert.equal(current(editOrder.id).revision, retryRevision + 1)
  waiting = waitAction(editOrder.id)
  await dialog().getByRole('button', { name: '确认保存', exact: true }).click()
  assert.equal((await waiting).status(), 200)
  assert.deepEqual(result.requests.at(-1).body, firstRetryBody)
  assert.equal(current(editOrder.id).revision, retryRevision + 1)
  await dialog().waitFor({ state: 'hidden' })
  await page.unroute(`**/api/studio/orders/${editOrder.id}/action`)
  pass('实际业务成功但响应丢失后原requestId/body重试不重复操作')

  const releaseOrder = orders[1]
  let row = current(releaseOrder.id)
  mutate(`/player/orders/${row.id}/claim`, { expectedRevision: row.revision, dispatchRound: row.dispatchRound }, players[0].id)
  await openOrder(releaseOrder.id)
  await drawer().getByRole('button', { name: '解除接单', exact: true }).click()
  await fillReason('旧页面解除请求')
  const oldAssignment = current(releaseOrder.id).assignmentId
  action(releaseOrder.id, { action: 'release', reason: '实际先解除旧负责人' })
  row = current(releaseOrder.id)
  mutate(`/player/orders/${row.id}/claim`, { expectedRevision: row.revision, dispatchRound: row.dispatchRound }, players[1].id)
  const newAssignment = current(releaseOrder.id).assignmentId
  waiting = waitAction(releaseOrder.id)
  await dialog().getByRole('button', { name: '确认保存', exact: true }).click()
  assert.equal((await waiting).status(), 409)
  assert.equal(result.requests.at(-1).body.assignmentId, oldAssignment)
  assert.equal(result.requests.at(-1).body.leaderId, players[0].id)
  assert.equal(current(releaseOrder.id).assignmentId, newAssignment)
  assert.equal(current(releaseOrder.id).leaderId, players[1].id)
  pass('旧后台解除请求不能解除新接单负责人')
  action(releaseOrder.id,{action:'release',reason:'隔离场景结束，释放新负责人的接单名额'})

  const reviewOrder = orders[2]
  row = current(reviewOrder.id)
  mutate(`/player/orders/${row.id}/claim`, { expectedRevision: row.revision, dispatchRound: row.dispatchRound }, players[0].id)
  const image = service.upload(players[0].id, { name: 'isolated-completion.png', mime: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=' })
  row = current(reviewOrder.id)
  mutate(`/player/orders/${row.id}/submit`, { expectedRevision: row.revision, assignmentId: row.assignmentId,
    leaderId: row.leaderId, screenshots: [image] }, players[0].id)
  await page.goto(base + '/#/orders/list?id=' + reviewOrder.id)
  await drawer().getByRole('button', { name: '验收通过', exact: true }).waitFor()
  const oldSubmission = current(reviewOrder.id).submissionId
  await drawer().getByRole('button', { name: '验收通过', exact: true }).click()
  action(reviewOrder.id, { action: 'review-return', reason: '真实退回旧材料' })
  row = current(reviewOrder.id)
  mutate(`/player/orders/${row.id}/submit`, { expectedRevision: row.revision, assignmentId: row.assignmentId,
    leaderId: row.leaderId, screenshots: [image] }, players[0].id)
  const newSubmission = current(reviewOrder.id).submissionId
  waiting = waitAction(reviewOrder.id)
  await page.getByRole('button', { name: '核对无误，通过验收', exact: true }).click()
  assert.equal((await waiting).status(), 409)
  assert.equal(result.requests.at(-1).body.submissionId, oldSubmission)
  assert.equal(current(reviewOrder.id).submissionId, newSubmission)
  assert.equal(current(reviewOrder.id).status, 'review')
  pass('旧后台验收确认只绑定旧材料，不会审核新一轮材料')

  const directOrder = createOrder({ dispatchMode: 'direct', assignedTo: players[0].id })
  time = new Date(time.valueOf() + 600_000)
  server.notifications.scanTimeouts()
  const timeout = server.notifications.listStaffTimeouts('admin', { current: 1, size: 10 })
  assert.equal(timeout.total, 1)
  for (let index = 0; index < 160; index++) service.db.prepare(
    'INSERT INTO player_notifications(id,user_id,event_key,type,title,body,href,created_at) VALUES(?,?,?,?,?,?,?,?)'
  ).run(randomUUID(), 'admin', 'isolated-history-' + index, 'withdrawal-result', '隔离历史结果', '测试用历史信息',
    '/finance/settlement?tab=withdrawals', new Date(time.valueOf() + 1000).toISOString())
  await page.goto(base + '/#/orders/list')
  await page.getByText('1 条有效未读提醒', { exact: true }).waitFor()
  assert.ok((await page.locator('#app-main').innerText()).includes(directOrder.orderNo))
  pass('有效未读超时提示不被160条更新历史消息挤掉')

  await page.goto(base + '/#/orders/create')
  await page.getByRole('button', { name: '刷新打手接单数量', exact: true }).waitFor()
  const targets = await context.request.get(base + '/api/studio/orders/dispatch-targets')
  assert.equal(targets.status(), 200)
  const target = (await targets.json()).records.find((entry) => entry.id === players[0].id)
  assert.equal(target.activeOrders, 0)
  assert.equal(target.pendingAssignments, 1)
  await page.getByText('指定打手', { exact: true }).first().click()
  await field(page.locator('#app-main'), '指定打手').locator('.el-select').click()
  await page.getByRole('option').filter({ hasText: '隔离打手A' }).waitFor()
  assert.ok((await page.getByRole('option').filter({ hasText: '隔离打手A' }).innerText()).includes('待接受 1'))
  await page.keyboard.press('Escape')
  pass('派单目标按需读取真实接单中/上限/待接受数量')

  await page.goto(base + '/#/safeguard/server')
  await page.getByText('实际运行指标', { exact: true }).waitFor()
  await page.getByText('以下为原框架的服务器界面演示', { exact: true }).waitFor()
  await page.locator('.business-detail-summary-item').filter({ has: page.getByText('请求 P95', { exact: true }) }).waitFor()
  await page.screenshot({ path: resolve(output, 'actual-runtime-metrics.png') })
  pass('真实运行指标与原框架随机演示明确区分')
  await page.goto(base + '/#/reports/export?modules=orders')
  await page.getByRole('button', { name: '预览所选内容', exact: true }).waitFor()
  await page.getByText('预览后显示行数', { exact: true }).first().waitFor()
  assert.ok((await page.locator('#app-main').innerText()).includes('待预览'))
  const catalogReply = await context.request.get(base + '/api/studio/exports/catalog?month=2026-10')
  const module = (await catalogReply.json()).modules.find((entry) => entry.id === 'orders')
  assert.equal(module.rowCount, null)
  waiting = page.waitForResponse((reply) => reply.url().endsWith('/api/studio/exports/preview'))
  await page.getByRole('button', { name: '预览所选内容', exact: true }).click()
  response = await waiting
  assert.equal(response.status(), 200)
  const preview = await response.json()
  assert.equal(preview.sheets.length, 1)
  assert.equal(preview.sheets[0].id, 'orders')
  assert.equal(preview.sheets[0].rowCount, service.ordersPage('admin',{current:1,size:100}).total)
  assert.equal(preview.sheets[0].rows.length, 20)
  const download = page.waitForEvent('download')
  waiting = page.waitForResponse((reply) => reply.url().endsWith('/api/studio/exports/download'))
  await page.getByRole('button', { name: /^下载 Excel/ }).click()
  assert.equal((await waiting).status(), 200)
  await (await download).saveAs(resolve(output, 'selected-orders.xlsx'))
  pass('导出目录未知行数显示待预览，真实预览/Excel仅处理所选订单模块')
  await finalMobileChecks()
  assert.deepEqual(result.pageErrors, [])
  assert.deepEqual(result.serverErrors, [])
  result.success = true
} catch (cause) {
  result.success = false
  result.error = cause.stack || String(cause)
  process.exitCode = 1
  await page.screenshot({ path: resolve(output, 'failure-admin.png') }).catch(() => {})
  await mobile.screenshot({path:resolve(output,'failure-mobile.png')}).catch(()=>{})
  await financePage.screenshot({path:resolve(output,'failure-finance.png')}).catch(()=>{})
  result.failureScreens={admin:await page.locator('body').innerText().catch(()=>''),mobile:await mobile.locator('body').innerText().catch(()=>''),finance:await financePage.locator('body').innerText().catch(()=> '')}
} finally {
  result.sourceAfter=sourceFingerprint()
  result.sourceUnchanged=result.sourceBefore.digest===result.sourceAfter.digest
  if(!result.sourceUnchanged){result.success=false;result.sourceChangeError='Source changed during joint UI acceptance';process.exitCode=1}
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2))
  writeFileSync(resolve(qaRoot,'latest-result.json'), JSON.stringify(result, null, 2))
  await browser.close()
  await vite.close()
  await playerVite.close()
  await new Promise((close) => server.close(close))
  console.log(JSON.stringify({ success: result.success, passes: result.passes, error: result.error, output }))
}

async function mobileRoute(path) {
  await mobile.goto(playerBase + '/#' + path)
  await mobile.locator('.p-header-heading').waitFor()
}
function mobileReply(path, method = 'POST') {
  return mobile.waitForResponse(reply => new URL(reply.url()).pathname === '/api/studio/' + path && reply.request().method() === method)
}
function financeDrawer() {return financePage.locator('.business-detail-page-panel[data-page-key="order-detail"]:visible, .el-drawer:visible').last()}
function financeDialog() {return financePage.locator('.business-detail-page-panel[data-page-key="order-action"]:visible, .business-detail-page-panel[data-page-key="finance-withdrawal-pay"]:visible, .el-dialog:visible').last()}
function financeField(label) {
  return financeDialog().locator('.el-form-item').filter({has:financePage.locator('.el-form-item__label').filter({hasText:label})}).first()
}
async function financeOrder(id) {
  if (await financeDrawer().count())
    await financeDrawer().getByRole('button',{name:'刷新订单并重新确认操作',exact:true}).click({trial:true})
  await financePage.goto(base + '/#/orders/list?id=' + id)
  await waitOrderIdentity(financePage, id)
  await financeDrawer().waitFor()
  await financeDrawer().getByText(current(id).orderNo,{exact:true}).first().waitFor()
  const fresh=financePage.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/studio/orders/'+id&&reply.request().method()==='GET')
  await financeDrawer().getByRole('button',{name:'刷新订单并重新确认操作',exact:true}).click()
  assert.equal((await fresh).status(),200)
  await financePage.waitForLoadState('networkidle')
}
async function refreshMobileOrder(id) {
  await mobile.waitForTimeout(650)
  const response = mobileReply('player/orders/' + id,'GET')
  await mobile.evaluate(()=>window.dispatchEvent(new Event('focus')))
  assert.equal((await response).status(),200)
  const confirm = mobile.getByRole('button',{name:'重新确认当前订单',exact:true})
  if(await confirm.count()) await confirm.click()
}
async function fullLifecycle() {
  assert.equal((await financeContext.request.post(base+'/api/studio/login',{data:{username:finance.username,password}})).status(),200)
  await mobile.goto(playerBase+'/#/player/login')
  await mobile.getByLabel('账号',{exact:true}).fill(players[0].username)
  await mobile.locator('input[name=password]').fill(password)
  let wait=mobileReply('login')
  await mobile.getByRole('button',{name:'登录',exact:true}).click()
  assert.equal((await wait).status(),200)
  await mobile.waitForURL('**/#/player/lobby')
  await mobile.locator('.p-order-card').first().waitFor()
  await mobile.getByText('共 23 条 · 第 1 / 2 页',{exact:true}).waitFor()
  wait=mobile.waitForResponse(reply=>reply.url().includes('/player/orders?')&&new URL(reply.url()).searchParams.get('current')==='2')
  await mobile.getByRole('button',{name:'下一页',exact:true}).click()
  const second=await (await wait).json()
  assert.equal(second.records.length,3);assert.equal(second.total,23)
  assert.ok(proxyRequests.some(req=>req.client==='player'&&req.hasPlayerCookie&&!req.hasAdminCookie))
  pass('手机源码真实代理、登录 Cookie 隔离和服务端20条分页')

  await page.goto(base+'/#/orders/create')
  const createScope=page.locator('#app-main')
  for(const [label,option] of [['订单项目','隔离后台订单'],['客户档案','隔离客户'],['订单来源','隔离测试来源']]) {
    await field(createScope,label).locator('.el-select').click()
    await page.getByRole('option').filter({hasText:option}).click()
  }
  await field(createScope,'房间码').locator('input').fill('PRIVATE-JOINT-ROOM')
  await field(createScope,'客户游戏 ID').locator('input').fill('PRIVATE-JOINT-GAME')
  await field(createScope,'内部备注（模板及历史备注默认保留内部）').locator('textarea').fill('INTERNAL-QA-ONLY')
  await field(createScope,'打手可见备注').locator('textarea').fill('联合验收明确公开说明')
  await field(createScope,'付款方式').locator('.el-switch').click()
  await createScope.getByText('指定打手',{exact:true}).first().click()
  await field(createScope,'指定打手').locator('.el-select').click()
  await page.getByRole('option').filter({hasText:'隔离打手A'}).click()
  const createReply=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/studio/orders'&&reply.request().method()==='POST')
  await createScope.getByRole('button',{name:'发布落地付订单',exact:true}).click()
  const created=await createReply
  assert.equal(created.status(),200,await created.text())
  const order=await created.json()
  assert.equal(current(order.id).assignedTo,players[0].id)
  assert.equal(current(order.id).receivedAmount,0)
  pass('后台页面真实创建落地付指定单，打手账号承接同一隔离库订单')
  await mobileRoute('/player/orders/'+order.id)
  await mobile.getByText('联合验收明确公开说明',{exact:true}).waitFor()
  assert.equal(await mobile.getByText('PRIVATE-JOINT-ROOM',{exact:true}).count(),0)
  assert.equal(await mobile.getByText('INTERNAL-QA-ONLY',{exact:true}).count(),0)
  let detail=await (await mobileContext.request.get(playerBase+'/api/studio/player/orders/'+order.id)).json()
  for(const key of ['amount','receivedAmount','receipt','remark','customerId','customer'])assert.equal(detail[key],undefined,key)
  wait=mobileReply('player/orders/'+order.id+'/claim')
  await mobile.getByRole('button',{name:'接受订单',exact:true}).click()
  assert.equal((await wait).status(),200)
  await mobile.getByText('PRIVATE-JOINT-ROOM',{exact:true}).waitFor()
  await mobile.getByText('付款尚未确认，请联系后台确认付款。足额收款后才可正常上报。',{exact:true}).waitFor()
  assert.equal(await mobile.getByRole('button',{name:'提交完成，等待验收',exact:true}).isDisabled(),true)
  const active=current(order.id)
  const blocked=await mobileContext.request.post(playerBase+'/api/studio/player/orders/'+order.id+'/submit',{headers:{'X-Studio-Actor':players[0].id},data:{requestId:randomUUID(),expectedRevision:active.revision,assignmentId:active.assignmentId,leaderId:active.leaderId,screenshots:[]}})
  assert.equal(blocked.status(),409);assert.equal((await blocked.json()).code,'PAYMENT_NOT_CONFIRMED')
  assert.equal(service.playerProfile(players[0].id).activeOrders,1)
  await mobile.screenshot({path:resolve(output,'mobile-unpaid-submit-blocked.png')})
  pass('真实手机接落地付，内部备注/客户金额不泄露，未足额付款 UI 与服务端均禁止正常上报')

  await financeOrder(order.id)
  await financeDrawer().getByRole('button',{name:'确认收款',exact:true}).click()
  // The fixture clock is deliberately fixed; enter its actual payment time rather than the host's date.
  const fixtureLocal = new Date(time.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
  const paidAtInput = financeField('客户实际付款时间').locator('input')
  await paidAtInput.fill(fixtureLocal)
  await paidAtInput.press('Tab')
  wait=financePage.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/studio/orders/'+order.id+'/action'&&reply.request().method()==='POST')
  await financeDialog().getByRole('button',{name:'确认保存',exact:true}).click()
  const confirmed=await wait;assert.equal(confirmed.status(),200,await confirmed.text())
  await financeDialog().waitFor({state:'hidden'})
  assert.equal(current(order.id).receivedAmount,10000)
  await refreshMobileOrder(order.id)
  assert.equal(await mobile.getByText('付款尚未确认，请联系后台确认付款。足额收款后才可正常上报。',{exact:true}).count(),0)
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64')
  wait=mobileReply('uploads')
  await mobile.locator('input[type=file]').setInputFiles({name:'真实联调完成截图.png',mimeType:'image/png',buffer:image})
  assert.equal((await wait).status(),200)
  await mobile.locator('.p-upload-thumb').waitFor()
  await mobile.getByLabel('实际参与队友（可选）',{exact:true}).selectOption(players[1].id)
  wait=mobileReply('player/orders/'+order.id+'/submit')
  await mobile.getByRole('button',{name:'提交完成，等待验收',exact:true}).click()
  assert.equal((await wait).status(),200)
  await mobile.getByText('正在等待财务验收，本单已释放接单名额。验收通过后报酬计入钱包。',{exact:true}).waitFor()
  assert.equal(current(order.id).status,'review');assert.equal(service.playerProfile(players[0].id).activeOrders,0);assert.equal(service.playerWallet(players[0].id).available,0)
  const oldSubmission=current(order.id).submissionId
  pass('后台确认真实收款后手机按新版本上传并上报，待验收释放名额且报酬未提前入账')

  await financeOrder(order.id)
  await financeDrawer().getByRole('button',{name:'退回材料',exact:true}).click()
  await financeField('原因 / 处理说明').locator('textarea').fill('真实联合验收：请补齐完成截图')
  wait=financePage.waitForResponse(reply=>reply.url().endsWith('/orders/'+order.id+'/action')&&reply.request().method()==='POST')
  await financeDialog().getByRole('button',{name:'确认保存',exact:true}).click()
  assert.equal((await wait).status(),200)
  await financeDialog().waitFor({state:'hidden'})
  await refreshMobileOrder(order.id)
  await mobile.getByText('真实联合验收：请补齐完成截图',{exact:true}).waitFor()
  assert.equal(service.playerProfile(players[0].id).activeOrders,1)
  wait=mobileReply('uploads')
  await mobile.locator('input[type=file]').setInputFiles({name:'补齐后真实截图.png',mimeType:'image/png',buffer:image})
  assert.equal((await wait).status(),200)
  await mobile.locator('.p-upload-thumb').waitFor()
  await mobile.getByLabel('实际参与队友（可选）',{exact:true}).selectOption(players[1].id)
  wait=mobileReply('player/orders/'+order.id+'/submit')
  await mobile.getByRole('button',{name:'提交完成，等待验收',exact:true}).click()
  assert.equal((await wait).status(),200)
  await mobile.getByText('正在等待财务验收，本单已释放接单名额。验收通过后报酬计入钱包。',{exact:true}).waitFor()
  assert.notEqual(current(order.id).submissionId,oldSubmission)
  await financeOrder(order.id)
  await financeDrawer().getByRole('button',{name:'验收通过',exact:true}).click()
  wait=financePage.waitForResponse(reply=>reply.url().endsWith('/orders/'+order.id+'/action')&&reply.request().method()==='POST')
  await financePage.getByRole('button',{name:'核对无误，通过验收',exact:true}).click()
  assert.equal((await wait).status(),200)
  assert.equal(current(order.id).status,'completed');assert.equal(service.playerWallet(players[0].id).available,3500)
  assert.equal(service.playerWallet(players[1].id).available,3500)
  await financePage.screenshot({path:resolve(output,'backend-reviewed-after-mobile-resubmit.png')})
  await refreshMobileOrder(order.id)
  await mobile.screenshot({path:resolve(output,'mobile-completed-after-backend-review.png')})
  pass('财务退回绑定旧材料，手机补齐产生新submissionId，双人报酬各3500分且仅入账一次')

  await mobileRoute('/player/payment')
  const wechat=mobile.locator('.p-card').filter({has:mobile.getByRole('heading',{name:'微信收款码',exact:true})})
  wait=mobileReply('uploads')
  await wechat.locator('input[type=file]').setInputFiles({name:'隔离收款码.png',mimeType:'image/png',buffer:image})
  assert.equal((await wait).status(),200)
  wait=mobileReply('player/payment-methods')
  await wechat.getByRole('button',{name:'保存微信收款码',exact:true}).click()
  assert.equal((await wait).status(),200)
  await mobile.getByText('收款码已保存，新提现申请使用此资料。',{exact:true}).waitFor()
  await mobileRoute('/player/wallet')
  await mobile.getByLabel('提现金额（元）',{exact:true}).fill('35')
  await mobile.getByLabel('收款方式',{exact:true}).selectOption('wechat')
  wait=mobileReply('player/withdrawals')
  await mobile.getByRole('button',{name:'提交提现申请',exact:true}).click()
  const withdrawReply=await wait;assert.equal(withdrawReply.status(),200)
  const withdrawal=await withdrawReply.json()
  await mobile.getByText('原申请已确认，请查看最新提现记录。',{exact:true}).waitFor()
  assert.equal(service.playerWallet(players[0].id).available,0);assert.equal(service.playerWallet(players[0].id).occupied,3500)
  await financePage.goto(base+'/#/finance/settlement?tab=withdrawals')
  const financeFresh=financePage.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/studio/bootstrap')
  await financePage.getByRole('button',{name:'刷新记录',exact:true}).click()
  assert.equal((await financeFresh).status(),200)
  await financePage.locator('.el-table__body tr').filter({hasText:'隔离打手A'}).getByRole('button',{name:'审核通过',exact:true}).click()
  wait=financePage.waitForResponse(reply=>reply.url().endsWith('/withdrawals/'+withdrawal.id+'/action')&&reply.request().method()==='POST')
  await financePage.locator('.el-message-box:visible').getByRole('button',{name:'审核通过',exact:true}).click()
  assert.equal((await wait).status(),200)
  await financePage.locator('.el-table__body tr').filter({hasText:'隔离打手A'}).getByRole('button',{name:'登记已发放',exact:true}).click()
  wait=financePage.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/studio/uploads'&&reply.request().method()==='POST')
  // Keep the response promise observed while waiting for the actual upload input;
  // a locator failure must reach the suite catch/finally and preserve diagnostics.
  wait.catch(()=>{})
  await financeDialog().locator('input[type=file]').setInputFiles({name:'隔离人工发放凭证.png',mimeType:'image/png',buffer:image})
  assert.equal((await wait).status(),200)
  await financeDialog().getByRole('link',{name:'隔离人工发放凭证.png',exact:true}).waitFor()
  wait=financePage.waitForResponse(reply=>reply.url().endsWith('/withdrawals/'+withdrawal.id+'/action')&&reply.request().method()==='POST')
  await financeDialog().getByRole('button',{name:'确认已发放',exact:true}).click()
  assert.equal((await wait).status(),200)
  await financeDialog().waitFor({state:'hidden'})
  assert.equal(service.playerWallet(players[0].id).paid,3500);assert.equal(service.playerWallet(players[0].id).occupied,0)
  await mobileRoute('/player/withdrawals')
  await mobile.locator('.p-badge.paid').getByText('财务已登记发放',{exact:true}).waitFor()
  await mobile.getByText('查看本次收款资料与付款凭证',{exact:true}).click()
  await mobile.getByRole('img',{name:'财务付款凭证',exact:true}).waitFor()
  assert.equal(await mobile.getByRole('img',{name:'财务付款凭证',exact:true}).evaluate(image=>image.complete&&image.naturalWidth>0),true)
  await mobile.screenshot({path:resolve(output,'mobile-withdrawal-paid-with-proof.png')})
  await financePage.screenshot({path:resolve(output,'backend-withdrawal-paid.png')})
  pass('手机真实上传本人收款码→提现→财务审核→上传付款凭证登记发放→手机真实记录与图片可见')
}
async function finalMobileChecks() {
  await mobileRoute('/player/messages')
  const changes=await (await mobileContext.request.get(playerBase+'/api/studio/player/changes')).json()
  const notices=await (await mobileContext.request.get(playerBase+'/api/studio/player/notifications?current=1&size=30')).json()
  assert.equal(changes.unreadCount,notices.unread)
  if(notices.unread){const waiting=mobileReply('player/notifications/read-all');await mobile.getByRole('button',{name:'全部已读',exact:true}).click();assert.equal((await waiting).status(),200);await mobile.getByText('0 条未读',{exact:true}).waitFor()}
  assert.equal((await (await mobileContext.request.get(playerBase+'/api/studio/player/changes')).json()).unreadCount,0)
  const forbidden=await mobileContext.request.get(playerBase+'/api/studio/exports/catalog')
  assert.equal(forbidden.status(),200)
  const personalCatalog=await forbidden.json()
  assert.ok(!personalCatalog.modules.some(row=>['orders','customers','customerOrderReferences','logs','payrolls'].includes(row.id)))
  const internalExport=await mobileContext.request.post(playerBase+'/api/studio/exports/preview',{headers:{'X-Studio-Actor':players[0].id},
    data:{period:{type:'total'},modules:[{id:'orders',fields:['orderNo','amount']}]}})
  assert.equal(internalExport.status(),403)
  pass('手机未读计数与摘要一致，已读清零；导出目录按本人授权投影，内部订单导出403')

  const transferOrder=createOrder({dispatchMode:'direct',assignedTo:players[0].id,roomCode:'PRIVATE-REVOKED-ROOM'})
  await mobileRoute('/player/orders/'+transferOrder.id)
  let waiting=mobileReply('player/orders/'+transferOrder.id+'/claim')
  await mobile.getByRole('button',{name:'接受订单',exact:true}).click();assert.equal((await waiting).status(),200)
  await mobile.getByText('PRIVATE-REVOKED-ROOM',{exact:true}).waitFor()
  action(transferOrder.id,{action:'release',reason:'真实联调解除并转交新负责人'})
  action(transferOrder.id,{action:'dispatch',dispatchMode:'direct',assignedTo:players[1].id})
  let row=current(transferOrder.id)
  mutate('/player/orders/'+transferOrder.id+'/claim',{expectedRevision:row.revision,dispatchRound:row.dispatchRound},players[1].id)
  await mobile.waitForTimeout(650)
  waiting=mobileReply('player/orders/'+transferOrder.id,'GET')
  await mobile.evaluate(()=>window.dispatchEvent(new Event('focus')))
  const historicalReply=await waiting
  assert.equal(historicalReply.status(),200)
  const historical=await historicalReply.json()
  assert.equal(historical.historyOnly,true)
  assert.equal(Object.hasOwn(historical,'roomCode'),false)
  assert.equal(historical.canSubmit,false)
  assert.equal(await mobile.getByText('PRIVATE-REVOKED-ROOM',{exact:true}).count(),0)
  assert.equal(await mobile.getByRole('button',{name:'提交完成，等待验收',exact:true}).count(),0)
  await mobile.screenshot({path:resolve(output,'mobile-revoked-details-cleared.png')})
  pass('真实后台解除并转交后，手机安全历史摘要清除旧私人执行字段与旧上报按钮')

  const uncertainOrder=createOrder({dispatchMode:'direct',assignedTo:players[0].id})
  await mobileRoute('/player/orders/'+uncertainOrder.id)
  let requestBody,committed,originalActor
  await mobileContext.route('**/api/studio/player/orders/'+uncertainOrder.id+'/claim',async route=>{if(route.request().method()!=='POST')return route.continue();requestBody=route.request().postDataJSON();originalActor=route.request().headers()['x-studio-actor'];const real=await route.fetch();assert.equal(real.status(),200);committed=await real.json();await route.abort('failed')})
  await mobile.getByRole('button',{name:'接受订单',exact:true}).click()
  await mobile.getByRole('button',{name:'核对结果',exact:true}).waitFor()
  await mobile.getByRole('button',{name:'核对结果',exact:true}).click()
  await mobile.getByText('原操作已确认，请查看当前最新状态。',{exact:true}).waitFor()
  await mobileContext.unroute('**/api/studio/player/orders/'+uncertainOrder.id+'/claim')
  const retried=await mobileContext.request.post(playerBase+'/api/studio/player/orders/'+uncertainOrder.id+'/claim',{data:requestBody,headers:{'X-Studio-Actor':originalActor}})
  assert.equal(retried.status(),200);assert.deepEqual(await retried.json(),committed);assert.equal(current(uncertainOrder.id).assignments.length,1)
  await mobile.screenshot({path:resolve(output,'mobile-lost-response-unconfirmed-conservative.png')})
  result.limitations=['隔离 Edge 手机视口不等于 Android/iPhone 真机、正式部署或通知实际到达。']
  pass('手机真实成功响应丢失不猜成功/自动重发；HTTP原requestId原内容重试返回原结果且只存在一次接单')

  const otherTab=await mobileContext.newPage()
  otherTab.on('pageerror',error=>result.pageErrors.push('other-mobile-tab: '+error.message))
  await otherTab.goto(playerBase+'/#/player/me')
  await otherTab.getByText('账号：'+players[0].username,{exact:true}).waitFor()
  await mobile.goto(playerBase+'/#/player/login')
  await mobile.getByLabel('账号',{exact:true}).fill(players[1].username)
  await mobile.locator('input[name=password]').fill(password)
  waiting=mobileReply('login')
  await mobile.getByRole('button',{name:'登录',exact:true}).click();assert.equal((await waiting).status(),200)
  await mobile.waitForURL('**/#/player/lobby')
  await otherTab.waitForFunction(()=>location.hash.startsWith('#/player/login'))
  assert.equal(await otherTab.locator('.p-main').count(),0)
  await mobileRoute('/player/me')
  await mobile.getByText('账号：'+players[1].username,{exact:true}).waitFor()
  assert.equal(await mobile.getByText('账号：'+players[0].username,{exact:true}).count(),0)
  assert.equal(await mobile.getByText('核对结果',{exact:true}).count(),0)
  await mobile.locator('.p-nav').getByText('我的任务',{exact:true}).click()
  await mobile.getByPlaceholder('搜索全部页的订单号或任务标题').waitFor()
  assert.equal(await mobile.getByText('INTERNAL-QA-ONLY',{exact:true}).count(),0)
  await mobile.locator('.p-nav').getByText('我的',{exact:true}).click()
  await mobile.getByText('账号：'+players[1].username,{exact:true}).waitFor()
  await mobile.screenshot({path:resolve(output,'mobile-account-switch-caches-isolated.png')})
  await otherTab.close()
  pass('同源手机双标签换号清除旧私人页面与未确认操作，KeepAlive主标签读写归属正确')
}
