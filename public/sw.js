// Web Push: the server sends {title, body} when the other Member writes. Skip it if the chat is already visible.
self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.some(c => c.visibilityState === 'visible')) return;
    return self.registration.showNotification(d.title || 'Jikkan', { body: d.body, tag: 'jikkan', renotify: true });
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : clients.openWindow('/')));
});
