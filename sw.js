// PCG Portal — Service Worker for Push Notifications

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Handle incoming push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); }
  catch { payload = { title: 'PCG Portal', body: event.data.text() }; }

  const { title = 'PCG Portal', body = '', icon, badge, url, tag } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: icon || '/apple-touch-icon.png',
      badge: badge || '/apple-touch-icon.png',
      tag: tag || undefined,
      renotify: !!tag,
      data: { url: url || '/' },
    })
  );
});

// Handle notification click — open/focus app at the deep link URL
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open, focus it and navigate
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          client.focus();
          if (client.url !== targetUrl) client.navigate(targetUrl);
          return;
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(targetUrl);
    })
  );
});
