// The hub's service worker, served at /sw.js with scope /. Push messages come
// from push.mjs as {title, body, url, tag, badge}; url is a path on the hub, and badge, when
// present, is the Home Screen app badge count.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { body: event.data ? event.data.text() : '' }; }
  // A badge failure must never stop the notification: iOS revokes push from an app whose push shows nothing.
  let badge = null;
  try {
    const nav = self.navigator;
    if (Number.isInteger(msg.badge) && nav && 'setAppBadge' in nav) badge = (msg.badge > 0 ? nav.setAppBadge(msg.badge) : nav.clearAppBadge()).catch(() => {});
  } catch {}
  event.waitUntil(Promise.all([self.registration.showNotification(msg.title || 'Claude', {
    body: msg.body || '',
    tag: msg.tag || undefined,
    icon: '/_hub/icon-192.png',
    data: { url: new URL(msg.url || '/', self.registration.scope).href },
  }), badge]));
});

// The app shell (board/public/shell.js) answers {open: url} on the message's port with {routed: true} when it shows the
// URL in place; a window that doesn't answer in time, such as an older page, is navigated, which reloads it.
const ROUTE_WAIT_MS = 1500;
function routeInPlace(win, url) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), ROUTE_WAIT_MS);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data?.routed === true); };
    try { win.postMessage({ open: url }, [channel.port2]); } catch { clearTimeout(timer); resolve(false); }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => 'focus' in w);
    if (!win) return self.clients.openWindow(url);
    await win.focus();
    if (await routeInPlace(win, url)) return;
    return win.navigate(url);
  })());
});
