// AutoDeck service worker.
// The open tab still drives reminder timing; the SW only renders actionable
// notifications (Mark done / Snooze / View) and routes clicks back to the app —
// which works while the tab is backgrounded. It does NOT fire when the browser
// is fully closed (that needs the Push API + a push server).

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {}
  const action = event.action || 'view'
  event.notification.close()
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    let client = wins.find((c) => 'focus' in c)
    if (client) await client.focus()
    else client = await self.clients.openWindow(data.url || './')
    if (client) client.postMessage({ type: 'reminder-action', action, taskId: data.taskId })
  })())
})
