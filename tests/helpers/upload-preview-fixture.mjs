import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createStudioServer } from '../../server/index.mjs'
import { adminProxy } from '../../scripts/studio-production-fixes-preview.mjs'
import { createPlayerClientServer } from '../../scripts/player-client-server.mjs'

const listen = server => new Promise((done, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); done() })
})
const close = server => new Promise(done => {
  if (!server?.listening) return done()
  server.close(done); server.closeIdleConnections?.()
})

/** Real API + exact preview admin proxy + exact player proxy, disposable memory
 * data only. Never reads the persistent preview/production database or accounts.
 */
export async function uploadPreviewFixture({ adminDirectory = resolve('dist'), playerDirectory = resolve('player-client/dist') } = {}) {
  const password = `isolated-upload-${randomUUID()}`, uploads = []
  const api = createStudioServer({ dbPath: ':memory:', password, seed: false, maintenanceFromEnv: false,
    staticRoot: adminDirectory, notificationIntervalMs: 86400000,
    uploadCleanup: { enabled: false }, backups: { intervalMinutes: 0 },
    notifications: { publicKey: '', privateKey: '', subject: '', allowedPushHosts: [] } })
  api.prependListener('request', req => {
    if (req.method === 'POST' && req.url === '/api/studio/uploads') uploads.push({
      nameHeader: req.headers['x-upload-name'] || null, actor: req.headers['x-studio-actor'] || null,
      channel: req.headers['x-studio-client'] || 'admin', type: req.headers['content-type'] || null
    })
  })
  let admin, player
  try {
    await listen(api)
    const apiBase = `http://127.0.0.1:${api.address().port}`
    admin = adminProxy(apiBase, 'isolated-upload-proxy-test')
    player = createPlayerClientServer({ apiTarget: apiBase, staticRoot: playerDirectory })
    await listen(admin); await listen(player)
    const bases = { api: apiBase, admin: `http://127.0.0.1:${admin.address().port}`, player: `http://127.0.0.1:${player.address().port}` }
    const mutate = (path, body, actor = 'admin') => api.service.mutate(actor, path, { requestId: randomUUID(), ...body })
    const level = mutate('/levels', { name: '上传验收等级', delaySeconds: 0 })
    const person = mutate('/users', { username: 'upload-player', name: '上传验收打手', role: 'player', status: 'active',
      levelId: level.id, maxActiveOrders: 3, permissionOverrides: {}, password })
    const customer = mutate('/customers', { name: '上传隔离客户', contact: '', gameId: '', remark: '' })
    const template = mutate('/templates', { name: '上传接口回归订单', game: '隔离游戏', amount: 2000, reward: 1000, active: true })
    const order = mutate('/orders', { customerId: customer.id, templateId: template.id, platformId: 'xianyu', shopId: 'jindun',
      externalOrderNo: randomUUID(), roomCode: 'ISOLATED', receivedAmount: 2000, paidAt: new Date().toISOString(), dispatchMode: 'pool' })
    mutate(`/player/orders/${order.id}/claim`, { expectedRevision: order.revision, dispatchRound: order.dispatchRound }, person.id)
    async function login(channel = 'admin') {
      const response = await fetch(bases[channel] + '/api/studio/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: channel === 'admin' ? 'admin' : person.username, password }) })
      if (!response.ok) throw new Error('隔离上传测试登录失败')
      return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user }
    }
    return { api, bases, person, order, password, uploads, login, async stop() {
      await Promise.all([close(admin), close(player)]); await close(api)
    } }
  } catch (error) { await Promise.all([close(admin), close(player)]); await close(api); throw error }
}
