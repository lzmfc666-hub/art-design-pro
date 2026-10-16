/* Notification-only worker. No API/image cache, write queue, private data or business actions. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('工作室有新的消息', {
      body: '打开打手端查看当前账号的消息。',
      icon: '/player-icon.svg',
      badge: '/player-icon.svg',
      tag: 'studio-player-message',
      // Repeated deliveries update the same generic reminder without repeating an alert.
      renotify: false,
      data: { url: '/#/player/messages' }
    })
  )
})
self.addEventListener('message', (event) => {
  if (!['player-session-ended', 'player-session-changed'].includes(event.data?.type)) return
  event.waitUntil(
    self.registration.getNotifications({ tag: 'studio-player-message' }).then((items) => {
      for (const notification of items) notification.close()
    })
  )
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const url = new URL('/#/player/messages', self.location.origin).href
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const client = windows.find((item) => item.url.startsWith(self.location.origin + '/'))
      if (client) {
        await client.navigate(url)
        await client.focus()
      } else await self.clients.openWindow(url)
    })()
  )
})
