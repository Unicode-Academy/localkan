// Localkan service worker: shows push notifications (task done / needs you / failed) and opens
// the right task when one is tapped. Payloads are JSON (see PushPayload in @localkan/protocol).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Localkan', body: event.data ? event.data.text() : '' };
  }
  // Always show something: browsers (Safari especially) revoke push for silent pushes.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Localkan', {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        // The app switches screens on hash changes; no reload needed.
        open.postMessage({ type: 'localkan.open', hash: target.hash });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
