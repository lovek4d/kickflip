// The hub's service worker, served at /sw.js with scope /. Push messages come
// from push.mjs as {title, body, url, tag, silent, badge}; url is a path on the hub, and badge, when
// present, is the Home Screen app badge count; a {close: tag} push closes that tag's notification (closeTagged).
// It keeps the app shell and its files, network first, so the app opens from the last copy while the host is asleep
// (docs/adr/2026-10-29-2005-one-app-for-the-whole-hub.md). Nothing else is cached: API calls, streams, uploads and frames always
// go to the network, except a served page opened in a frame and its own files, which go network first the same way
// (docs/adr/2026-11-17-1900-served-pages-open-from-the-workers-copy.md).
// A {forget: 'shell'} message drops the saved shell before the owner's reload and replies on its port.
const CACHE = 'hub-app';
const SHELL = new URL('/', self.registration.scope).href;
// A sleeping host over Tailscale leaves a request hanging rather than failing, so a saved copy answers after this long.
const NETWORK_WAIT_MS = 3000;

// The paths hub/shell.mjs pageOf answers with the shell on a page load; hub/sw.test.mjs checks they agree.
const HUB_PAGES = new Set(['/', '/_hub/', '/_hub/settings', '/_hub/settings/polling']);
function isShellPage(url) {
  if (HUB_PAGES.has(url.pathname)) return true;
  if (url.searchParams.has('alone')) return false;
  const m = /^\/([^/]+)\/(.*)$/.exec(url.pathname);
  return Boolean(m) && m[1] !== '_hub' && (m[2] === '' || m[2].endsWith('/') || /\.html?$/.test(m[2]));
}
const isAsset = (url) => url.pathname.startsWith('/_hub/app/') || url.pathname === '/_hub/colors.css' || url.pathname === '/_hub/kickflip.png';
// hub/hub.mjs marks the shell it serves with the sidebar written in; a site's own page and the board server's copy
// aren't, so neither replaces the saved shell.
// A served page's files: scripts, styles, images and fonts of a site's own path, not its API, events or uploads.
const isSiteFile = (url, req) => ['script', 'style', 'image', 'font'].includes(req.destination)
  && !/^\/(_hub|[^/]+\/(api|_claude|uploads)(\/|$))/.test(url.pathname) && url.pathname !== '/sw.js' && url.pathname !== '/manifest.webmanifest';
const isHtml = (res) => res.ok && res.headers.get('x-app-shell') !== '1' && /^text\/html/.test(res.headers.get('content-type') || '');
const isShell = (res) => res.ok && res.headers.get('x-app-shell') === '1';

// Saves res under key, dropping any other version of the same file.
async function save(key, res) {
  const cache = await caches.open(CACHE);
  await cache.put(key, res);
  const { pathname } = new URL(key);
  for (const old of await cache.keys()) {
    const u = new URL(old.url);
    if (u.pathname === pathname && u.href !== key) await cache.delete(old);
  }
}
const saved = async (key) => (await caches.open(CACHE)).match(key, { ignoreVary: true });

// The network's answer, else the copy saved under key when the network fails, answers a 5xx (Tailscale's answer while
// the hub is down) or takes too long. An answer keep accepts replaces the copy.
function networkFirst(event, request, key, keep) {
  const net = fetch(request).then((res) => {
    if (keep(res)) event.waitUntil(save(key, res.clone()).catch(() => {}));
    return res;
  });
  event.waitUntil(net.catch(() => {}));
  return new Promise((resolve, reject) => {
    const fallback = (otherwise) => saved(key).then((hit) => (hit ? resolve(hit) : otherwise())).catch(otherwise);
    const timer = setTimeout(() => fallback(() => {}), NETWORK_WAIT_MS);
    net.then((res) => {
      clearTimeout(timer);
      if (res.status >= 500) fallback(() => resolve(res)); else resolve(res);
    }, (err) => {
      clearTimeout(timer);
      fallback(() => reject(err));
    });
  });
}

// The shell from `/` and the files it links, so one visit is enough to open offline.
async function saveShell() {
  const res = await fetch(SHELL, { cache: 'no-store' });
  if (!isShell(res)) return;
  const html = await res.clone().text();
  await save(SHELL, res);
  const urls = new Set([...html.matchAll(/\b(?:src|href)="(\/_hub\/[^"]+)"/g)].map((m) => new URL(m[1], SHELL)).filter(isAsset).map((u) => u.href));
  await Promise.all([...urls].map(async (u) => {
    try { const r = await fetch(u); if (r.ok) await save(u, r); } catch {}
  }));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(saveShell().catch(() => {}));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.forget !== 'shell') return;
  event.waitUntil((async () => {
    await (await caches.open(CACHE)).delete(SHELL);
    event.ports[0]?.postMessage({ forgot: true });
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // A frame's page load goes network first under its own URL, so a frame never shows the shell in place of its page.
    if (req.destination === 'iframe') {
      event.respondWith(networkFirst(event, req, url.href, isHtml));
      return;
    }
    if (req.destination !== 'document' || !isShellPage(url)) return;
    // The hub tells the shell from a site's page by Sec-Fetch-Dest, which this fetch would lose (hub/shell.mjs destOf).
    const page = new Request(url.href, { headers: { 'x-app-shell': '1' }, cache: 'no-store', redirect: 'manual' });
    event.respondWith(networkFirst(event, page, SHELL, isShell));
    return;
  }
  if (isAsset(url) || isSiteFile(url, req)) event.respondWith(networkFirst(event, req, url.href, (res) => res.ok));
});

self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { body: event.data ? event.data.text() : '' }; }
  // A badge failure must never stop the notification: iOS revokes push from an app whose push shows nothing.
  let badge = null;
  try {
    const nav = self.navigator;
    if (Number.isInteger(msg.badge) && nav && 'setAppBadge' in nav) badge = (msg.badge > 0 ? nav.setAppBadge(msg.badge) : nav.clearAppBadge()).catch(() => {});
  } catch {}
  if (msg.close) { event.waitUntil(Promise.all([closeTagged(msg.close), badge])); return; }
  // renotify alerts again for a push that replaces one with its tag; a silent push, a board's live notification updated
  // after its first alert (push.mjs deliver), replaces it without alerting. Browsers throw on renotify without a tag.
  // iOS home-screen apps don't replace a notification by tag, so the ones with the tag from before the push are closed
  // once the new one shows (it must show first: iOS revokes push from an app whose push shows nothing).
  event.waitUntil(Promise.all([showReplacing(msg), badge]));
});

async function showReplacing(msg) {
  const older = msg.tag ? await self.registration.getNotifications({ tag: msg.tag }) : [];
  await self.registration.showNotification(msg.title || 'Claude', {
    body: msg.body || '',
    tag: msg.tag || undefined,
    silent: Boolean(msg.silent),
    renotify: Boolean(msg.tag) && !msg.silent,
    icon: '/_hub/icon-192.png',
    data: { url: new URL(msg.url || '/', self.registration.scope).href },
  });
  for (const n of older) n.close();
}

// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md
// A {close: tag} push, for a push that no longer waits on the owner (push.mjs withdraw), closes the notification with
// that tag. iOS revokes push from an app whose push shows nothing, so it first shows a silent one under the tag, which
// replaces the one on screen without alerting, and then closes it.
async function closeTagged(tag) {
  await self.registration.showNotification('Claude', { tag, silent: true, renotify: false, icon: '/_hub/icon-192.png' });
  for (const n of await self.registration.getNotifications({ tag })) n.close();
}

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
