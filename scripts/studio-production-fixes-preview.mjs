import { createServer, request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createStudioServer } from '../server/index.mjs'
import { createPlayerClientServer } from './player-client-server.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const qaRoot = join(root, '.qa', 'production-fixes-20261018')
const defaultDirectory = join(qaRoot, 'preview')
const defaultPorts = { admin: 3106, api: 3107, player: 3108 }
const safeError = () => new Error('隔离预览未能启动；现有数据未重置，请检查端口、构建及私人预览记录。')
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
})
const close = server => new Promise(resolve => {
  if (!server?.listening) return resolve()
  server.close(resolve); server.closeIdleConnections?.()
})
function checkedDirectory(directory) {
  const target = resolve(directory), distance = relative(qaRoot, target)
  if (!distance || distance.startsWith('..') || isAbsolute(distance) || !/^preview[^\\/]*$/.test(distance)) throw safeError()
  mkdirSync(target, { recursive: true, mode: 0o700 })
  if (lstatSync(target).isSymbolicLink() || realpathSync(target).toLowerCase() !== target.toLowerCase()) throw safeError()
  return target
}
function readPrivateJson(path) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw safeError()
  return JSON.parse(readFileSync(path, 'utf8'))
}
function checkedBuildDirectory(directory, expected, privateDirectory) {
  const target = resolve(directory), canonical = realpathSync(target)
  const qaDistance = relative(qaRoot, target), privateDistance = relative(target, privateDirectory)
  const defaultBuild = target.toLowerCase() === expected.toLowerCase()
  if ((!defaultBuild && (!qaDistance || qaDistance.startsWith('..') || isAbsolute(qaDistance))) ||
      canonical.toLowerCase() !== target.toLowerCase() || lstatSync(target).isSymbolicLink() ||
      !lstatSync(target).isDirectory() || !privateDistance || (!privateDistance.startsWith('..') && !isAbsolute(privateDistance)))
    throw safeError()
  const index = join(target, 'index.html')
  if (!lstatSync(index).isFile() || lstatSync(index).isSymbolicLink()) throw safeError()
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || /^(?:\.env(?:\..*)?|\.git|node_modules|.*\.sqlite(?:-wal|-shm)?|.*\.private\.json|credentials(?:\..*)?)$/i.test(entry.name)) throw safeError()
      if (entry.isDirectory()) visit(join(directory, entry.name))
    }
  }
  visit(target)
  return target
}
export function adminProxy(apiBase, instanceId) {
  const target = new URL(apiBase)
  return createServer((req, res) => {
    if (req.url === '/__preview/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify({ format: 'studio-isolated-preview-v1', instanceId, production: false }))
    }
    const headers = { host: target.host, 'x-forwarded-for': req.socket.remoteAddress || '127.0.0.1' }
    for (const name of ['accept', 'accept-encoding', 'content-type', 'content-length', 'origin', 'referer', 'if-none-match', 'x-studio-actor', 'x-upload-name'])
      if (req.headers[name]) headers[name] = req.headers[name]
    const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith('studio_session='))
    if (cookies.length) headers.cookie = cookies.join('; ')
    const upstream = httpRequest({ hostname: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers, timeout: 60000 }, response => {
      const returned = { ...response.headers }
      delete returned.connection
      if (returned['set-cookie']) returned['set-cookie'] = returned['set-cookie'].filter(value => value.startsWith('studio_session='))
      res.writeHead(response.statusCode || 502, returned)
      response.on('error', () => res.destroy()); response.pipe(res)
    })
    upstream.on('timeout', () => upstream.destroy())
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end('{"message":"隔离预览接口暂时不可连接"}')
    })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
    req.pipe(upstream)
  })
}
async function seedPreview(service, credentials) {
  const mutate = (path, body, actor = 'admin') => service.mutate(actor, path, { requestId: randomUUID(), ...body })
  const state = () => JSON.parse(service.db.prepare('SELECT json FROM studio_state WHERE id=1').get().json)
  const level = mutate('/levels', { name: '验收演示等级', delaySeconds: 0 })
  const people = {}
  for (const [key, role, name] of [['player', 'player', '演示打手'], ['staff', 'support', '内部客服员工'], ['hr', 'hr', '内部人事员工']]) {
    const account = credentials.accounts[key]
    people[key] = mutate('/users', { username: account.username, name, role, status: 'active', maxActiveOrders: 3,
      levelId: level.id, permissionOverrides: {}, password: account.password })
  }
  for (const key of ['staff', 'hr']) mutate('/work-schedules', { userId: people[key].id,
    effectiveFrom: '2026-10-18', enabled: true, start: '09:00', end: '18:00', remark: '仅内部员工参与排班的隔离演示' })
  const customer = mutate('/customers', { name: '隔离演示客户（非真实）', contact: '仅用于本地验收', gameId: 'DEMO_ONLY' })
  const imageBytes = await sharp({ create: { width: 1280, height: 800, channels: 3, background: '#a2b5f6' } }).png().toBuffer()
  const upload = (name, actor = 'admin') => service.upload(actor, { name, mime: 'image/png', data: imageBytes.toString('base64') })
  const receipt = upload('隔离演示收款凭证.png'), material = upload('隔离演示完成材料.png', people.player.id), card = upload('隔离演示任务卡图.png')
  const appearance = state().appearance
  mutate('/appearance', { revision: appearance.revision, config: { ...appearance, studioName: '金盾电竞 · 隔离验收', playerOrderCardImage: card } })
  const purpose = {}
  const newOrder = (key, title, remark) => {
    const template = mutate('/templates', { name: title, game: '三角洲行动', description: remark, map: '航天基地', amount: 10000, reward: 3000, active: true })
    const order = mutate('/orders', { customerId: customer.id, templateId: template.id, platformId: 'xianyu', shopId: 'jindun',
      externalOrderNo: `DEMO-${randomUUID()}`, roomCode: '仅本地验收演示', gameId: 'DEMO_ONLY', amount: 10000, reward: 3000,
      receivedAmount: 10000, paidAt: new Date().toISOString(), receipt, dispatchMode: 'pool', playerRemark: remark, remark: '隔离演示数据，正式人员、订单和图片不在此处' })
    purpose[key] = order.id; return order
  }
  const target = order => {
    const row = service.orderDetail('admin', order.id).order
    return { expectedRevision: row.revision, dispatchRound: row.dispatchRound, assignmentId: row.assignmentId, leaderId: row.leaderId, submissionId: row.submissionId }
  }
  const action = (order, action, extra = {}) => mutate(`/orders/${order.id}/action`, { ...target(order), action, reason: '隔离演示操作', ...extra })
  const claim = order => mutate(`/player/orders/${order.id}/claim`, target(order), people.player.id)
  newOrder('normal', '普通待接单 · 可正常接取', '这是普通订单，用于对比退款和存单拦截。')
  const resumed = newOrder('resumed', '存单已恢复 · 原负责人不占名额', '本单恢复给原负责人继续完成，本轮不占接单名额。')
  claim(resumed); action(resumed, 'store', { reason: '客户暂停，已完成一半，进度保留' }); action(resumed, 'resume', { mode: 'original' })
  const pendingStored = newOrder('pendingStored', '无人接单存单 · 恢复后回大厅', '当前已存单，恢复后重新进入公共大厅。')
  action(pendingStored, 'store', { reason: '客户暂不继续，尚无人接取' })
  const activeStored = newOrder('activeStored', '有负责人存单 · 已释放名额', '当前已存单，原接单历史与负责人保留。')
  claim(activeStored); action(activeStored, 'store', { reason: '客户临时暂停，已做进度保留，暂不结算' })
  const refunded = newOrder('refunded', '已全额退款 · 不可再接取', '财务记录已退款，订单仍保留原履约历史。')
  mutate('/refunds', { orderId: refunded.id, ...target(refunded), amount: 10000, reason: '演示全额退款后的执行拦截' })
  const pendingRefund = newOrder('pendingRefund', '全额退款审批中 · 暂停履约', '审批期间停止上报和验收，批准前原名额保留。')
  claim(pendingRefund)
  mutate('/refunds', { orderId: pendingRefund.id, ...target(pendingRefund), amount: 10000, reason: '演示客服申请全额退款，等待财务审批' }, people.staff.id)
  const problem = newOrder('problem', '问题单 · 由后台客服处理', '问题未关闭时打手仅查看，后台客服处理并记录结果后关闭。')
  claim(problem); action(problem, 'problem-open', { reason: '客户反馈进度不清楚，由后台客服核对处理，打手暂停操作' })
  const review = newOrder('review', '待验收 · 认证缩略图与原图对比', '完成材料保留原始图片，列表先加载认证缩略图。')
  claim(review); mutate(`/player/orders/${review.id}/submit`, { ...target(review), screenshots: [material], teammateId: null }, people.player.id)
  return { orders: purpose, people: Object.fromEntries(Object.entries(people).map(([key, value]) => [key, value.id])) }
}

/** Dedicated fake-data service; callers must not use it as a production launcher. */
export async function startProductionFixesPreview({ directory = defaultDirectory, ports = defaultPorts,
  adminDirectory = join(root, 'dist'), playerDirectory = join(root, 'player-client/dist') } = {}) {
  const privateDirectory = checkedDirectory(directory), databasePath = join(privateDirectory, 'preview.sqlite')
  const credentialsPath = join(privateDirectory, 'credentials.private.json'), metadataPath = join(privateDirectory, 'preview.json')
  adminDirectory = checkedBuildDirectory(adminDirectory, join(root, 'dist'), privateDirectory)
  playerDirectory = checkedBuildDirectory(playerDirectory, join(root, 'player-client/dist'), privateDirectory)
  const existing = existsSync(databasePath)
  let credentials
  if (existing) {
    credentials = readPrivateJson(credentialsPath)
    if (credentials.format !== 'studio-production-fixes-preview-credentials-v1') throw safeError()
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const marker = db.prepare('SELECT instance_id,seed_complete FROM studio_preview_identity').get()
      if (!marker || marker.instance_id !== credentials.instanceId || marker.seed_complete !== 1) throw safeError()
    } finally { db.close() }
  } else {
    if (existsSync(credentialsPath) || existsSync(metadataPath)) throw safeError()
    const password = `Preview-${randomBytes(12).toString('base64url')}`
    credentials = { format: 'studio-production-fixes-preview-credentials-v1', instanceId: randomUUID(), accounts:
      Object.fromEntries([['admin', 'admin'], ['player', 'preview-player'], ['staff', 'preview-staff'], ['hr', 'preview-hr']].map(([key, username]) => [key, { username, password }])) }
    writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), { flag: 'wx', mode: 0o600 })
  }
  const api = createStudioServer({ dbPath: databasePath, seed: false, password: existing ? undefined : credentials.accounts.admin.password,
    staticRoot: adminDirectory, maintenanceFromEnv: false, trustedProxies: '',
    auditRetentionDays: 90, auditHotMaxRows: 10000, auditArchiveMaxBytes: 500 * 1024 * 1024,
    runtime: { uploadRate: 30, claimRate: 30, uploadConcurrency: 4, uploadPerUser: 2, exportConcurrency: 1,
      diskWarningBytes: 256 * 1024 * 1024, diskMinimumBytes: 64 * 1024 * 1024, walWarningBytes: 256 * 1024 * 1024 },
    monitor: { token: null, diagnosticHoursUTC: [] },
    backups: { intervalMinutes: 0, directory: join(privateDirectory, 'disabled-backups'), retentionCount: 3,
      maxTotalBytes: 0, minFreeBytes: 0, failureWebhook: '', replication: { enabled: false } },
    uploadCleanup: { enabled: false, intervalMinutes: 60, retentionDays: 7, limit: 10 },
    imageArchive: { enabled: false, deletionEnabled: false, directory: join(privateDirectory, 'disabled-image-archive'), holdsFile: undefined },
    notificationIntervalMs: 86400000, notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [],
      pushSender: async () => { throw new Error('外部推送在隔离预览中禁用') } } })
  let admin, player, seeded
  try {
    if (!existing) {
      api.service.db.exec('CREATE TABLE studio_preview_identity(instance_id TEXT PRIMARY KEY,seed_complete INTEGER NOT NULL)')
      api.service.db.prepare('INSERT INTO studio_preview_identity VALUES(?,0)').run(credentials.instanceId)
      seeded = await seedPreview(api.service, credentials)
      api.service.db.prepare('UPDATE studio_preview_identity SET seed_complete=1 WHERE instance_id=?').run(credentials.instanceId)
    }
    await listen(api, ports.api)
    const apiBase = `http://127.0.0.1:${api.address().port}`
    admin = adminProxy(apiBase, credentials.instanceId)
    player = createPlayerClientServer({ staticRoot: playerDirectory, apiTarget: apiBase, trustedProxies: '' })
    await listen(admin, ports.admin); await listen(player, ports.player)
    const previous = existing && existsSync(metadataPath) ? readPrivateJson(metadataPath) : null
    const metadata = { format: 'studio-production-fixes-preview-v1', production: false, instanceId: credentials.instanceId,
      pid: process.pid, startedAt: new Date().toISOString(), seededNewDatabase: !existing,
      urls: { admin: `http://127.0.0.1:${admin.address().port}/#/auth/login`, api: apiBase,
        player: `http://127.0.0.1:${player.address().port}/#/player/login` },
      builds: { adminDirectory, playerDirectory },
      data: seeded || previous?.data || null, jobs: { externalPush: false, backup: false, imageCleanup: false, externalMonitor: false } }
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 })
    let stopped = false
    return { ...metadata, credentials, service: api.service, async stop() {
      if (stopped) return; stopped = true
      await Promise.all([close(admin), close(player)]); await close(api)
    } }
  } catch (error) {
    await Promise.all([close(admin), close(player)])
    if (api.listening) await close(api)
    else { api.emit('close') }
    throw error
  }
}

async function status() {
  try {
    const metadata = readPrivateJson(join(defaultDirectory, 'preview.json'))
    const origin = new URL(metadata.urls.admin).origin
    const response = await fetch(`${origin}/__preview/status`, { signal: AbortSignal.timeout(3000) })
    const identity = await response.json()
    const ready = await fetch(`${metadata.urls.api}/api/studio/health/ready`, { signal: AbortSignal.timeout(3000) })
    const running = response.ok && ready.ok && identity.instanceId === metadata.instanceId
    return { running, production: false, urls: metadata.urls }
  } catch { return { running: false, production: false } }
}
export function parsePreviewArguments(args) {
  if (args.length === 1 && args[0] === '--status') return { status: true }
  const fields = { '--admin-directory': 'adminDirectory', '--player-directory': 'playerDirectory' }, options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = fields[args[index]], value = args[index + 1]
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw safeError()
    options[key] = resolve(value)
  }
  if (Boolean(options.adminDirectory) !== Boolean(options.playerDirectory)) throw safeError()
  return options
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The launcher is a separate process. Never inherit production credentials or job settings.
  for (const name of Object.keys(process.env)) if (name.startsWith('STUDIO_')) delete process.env[name]
  try {
    const options = parsePreviewArguments(process.argv.slice(2))
    if (options.status) console.log(JSON.stringify(await status()))
    else {
      const preview = await startProductionFixesPreview(options)
      console.log(JSON.stringify({ running: true, production: false, urls: preview.urls, testAccounts: preview.credentials.accounts }))
      const stop = () => void preview.stop().then(() => process.exit(0))
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
    }
  } catch { console.error(safeError().message); process.exitCode = 1 }
}
