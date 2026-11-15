import { randomUUID } from 'node:crypto'
import { createStudioService } from '../../server/studio.mjs'
import { testMutate } from './current-intent.mjs'

export const merchantPassword = 'isolated-merchant-integration-password'
export const merchantPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

export function merchantFixture(t, service = null) {
  let clock = new Date('2026-11-08T04:00:00Z')
  const current = service || createStudioService({
    dbPath: ':memory:', seed: false, password: merchantPassword, clock: () => clock
  })
  if (!service) t.after(() => current.close())
  const mutate = (path, body, actor = 'admin') => testMutate(current, actor, path, body)
  const merchants = [0, 1].map(() =>
    mutate('/merchants', { name: '响箭电竞', status: 'active' })
  )
  const accounts = [0, 0, 1].map((merchant, index) =>
    mutate('/users', {
      username: `merchant-user-${index}`, name: `商家账号${index}`, role: 'merchant',
      merchantId: merchants[merchant].id, status: 'active', maxActiveOrders: 1,
      permissionOverrides: {}, password: merchantPassword
    })
  )
  const templates = merchants.map((merchant, index) => mutate('/templates', {
    name: `商家任务${index}`, merchantId: merchant.id, game: '游戏', description: '完成任务',
    amount: 8000, merchantCustomerAmount: 10000, reward: 6000, map: '不限',
    remark: 'INTERNAL-TEMPLATE-NOTE', active: true
  }))
  const level = mutate('/levels', { name: '商家测试等级', delaySeconds: 0 })
  const players = [0, 1].map((index) => mutate('/users', {
    username: `merchant-player-${index}`, name: `打手${index}`, role: 'player',
    status: 'active', levelId: level.id, maxActiveOrders: 2, permissionOverrides: {},
    password: merchantPassword
  }))
  const orderBody = (template = templates[0], extra = {}) => ({
    templateId: template.id, expectedTemplateRevision: template.revision,
    roomCode: 'MERCHANT-ROOM', dispatchMode: 'pool', requestId: randomUUID(), ...extra
  })
  const order = (extra = {}, actor = accounts[0].id, template = templates[0]) =>
    mutate('/orders', orderBody(template, extra), actor)
  const upload = (actor = 'admin') => current.upload(actor, { name: 'picture.png', mime: 'image/png', data: merchantPng })
  return {
    service: current, mutate, merchants, accounts, templates, players, orderBody, order, upload,
    setTime(value) { clock = new Date(value) }
  }
}
