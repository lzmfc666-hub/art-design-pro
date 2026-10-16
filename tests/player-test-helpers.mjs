import { randomUUID } from 'node:crypto'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='

/** Existing financial regression fixtures now supply the v1.0 payment snapshot contract. */
export function withdrawalBody(service, userId, amount) {
  if (!service.playerPaymentMethods(userId).some((row) => row.method === 'wechat')) {
    const qrCode = service.upload(userId, { name: '收款码.png', mime: 'image/png', data: png })
    service.mutate(userId, '/player/payment-methods', { method: 'wechat', qrCode })
  }
  return { amount, paymentMethod: 'wechat', requestId: randomUUID() }
}
