// Daddy-Do service worker: makes the app installable on Android and handles
// taps on system notifications (opens the app on the right ticket).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Network-only pass-through (the app needs live data); presence of a fetch handler
// keeps older Chrome versions happy about installability.
self.addEventListener('fetch', () => {});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const ticket = event.notification.data?.ticket;
  const url = ticket ? `/?ticket=${ticket}` : '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        await w.focus();
        if (ticket) w.navigate?.(url);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
