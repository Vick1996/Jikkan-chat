// Needed so notifications also work on mobile browsers (new Notification() is desktop-only).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : clients.openWindow('/')));
});
