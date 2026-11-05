// The hub's one event stream, GET /_hub/stream, which the app shell holds in place of a stream per board
// (docs/adr/2026-10-29-2005-one-app-for-the-whole-hub.md). While any page listens, the hub holds each board server's own
// api/stream (docs/adr/2026-10-29-1639-the-board-reloads-on-a-change-signal.md) and passes each change on as
// `event: change` with data {route}. A board whose stream comes back, such as after a restart, gets one change too,
// since it may have changed while its stream was down. `event: sidebar` carries what /_hub/sidebar.json would answer
// whenever that differs from the last one sent: after a board's change, and on a timer for what no stream reports,
// such as a site going down or a page's waiting count; and when a board's data/watcher.json is written or removed, since
// a session's watcher starting or exiting is what the sidebar's listening word follows (boards.mjs listenState). A
// shared person's page (hub/share.mjs) gets only their boards' changes and their own view of each sidebar.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// targets() → [{route, port}], the boards to hold; sidebar({fresh}) → the sidebar data, fresh naming the routes whose
// waiting counts to refetch; watched() → [{route, dir}], the boards whose data/watcher.json to watch.
// → {handle(req, res, viewer), close(), changed(route), refresh()}; viewer is null for the owner, or {routes: Set, view(sidebar data) → data}
export function hubStream({ targets, watched = () => [], sidebar, retryMs = 2000, sidebarMs = 15_000, pingMs = 25_000, settleMs = 300, log = () => {} }) {
  const clients = new Map(); // res → viewer
  const upstreams = new Map(); // route → {port, req}
  const watchers = new Map(); // dir → fs.FSWatcher on dir/data
  const opened = new Set(); // routes whose stream has opened since the first page started listening
  let lastSidebar = null;
  let lastData = null;
  let timers = [];
  let pendingFresh = new Set();
  let sidebarTimer = null;

  const write = (text) => { for (const res of clients.keys()) res.write(text); };
  const sidebarTo = (res, data, json) => {
    const viewer = clients.get(res);
    res.write(`event: sidebar\ndata: ${viewer ? JSON.stringify(viewer.view(data)) : json}\n\n`);
  };
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  async function refreshSidebar(fresh = []) {
    let data;
    try { data = await sidebar({ fresh: new Set(fresh) }); } catch (e) { log(`sidebar for the stream failed: ${e.message}`); return; }
    const json = JSON.stringify(data);
    if (json === lastSidebar) return;
    lastSidebar = json;
    lastData = data;
    for (const res of clients.keys()) sidebarTo(res, data, json);
  }
  function sidebarSoon(route) {
    if (route) pendingFresh.add(route);
    if (sidebarTimer) return;
    sidebarTimer = setTimeout(() => {
      sidebarTimer = null;
      const fresh = [...pendingFresh];
      pendingFresh = new Set();
      refreshSidebar(fresh);
    }, settleMs);
  }

  function changed(route) {
    const text = event('change', { route });
    for (const [res, viewer] of clients) if (!viewer || viewer.routes.has(route)) res.write(text);
    sidebarSoon(route);
  }

  function connect(route, port) {
    const u = { port, req: null };
    upstreams.set(route, u);
    const drop = () => {
      if (upstreams.get(route) === u) upstreams.delete(route);
      u.req?.destroy();
    };
    u.req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); drop(); return; }
      if (opened.has(route)) changed(route);
      opened.add(route);
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.replace(/\r\n/g, '\n');
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: ?change$/m.test(block)) changed(route);
        }
      });
      res.on('close', drop);
      res.on('error', drop);
    });
    u.req.on('error', drop);
  }

  function reconcile() {
    let want;
    try { want = new Map(targets().map((t) => [t.route, t.port])); } catch (e) { log(`stream targets failed: ${e.message}`); return; }
    for (const [route, u] of upstreams) {
      if (want.get(route) !== u.port) { upstreams.delete(route); u.req?.destroy(); }
    }
    for (const [route, port] of want) if (!upstreams.has(route)) connect(route, port);
  }

  // fs.watch on the data folder, not the file, which is replaced when written; a folder that doesn't exist yet is tried again on the next reconcile.
  function watchWatchers() {
    let want;
    try { want = new Set(watched().map((w) => w.dir)); } catch (e) { log(`stream watched failed: ${e.message}`); return; }
    for (const [dir, w] of watchers) if (!want.has(dir)) { w.close(); watchers.delete(dir); }
    for (const dir of want) {
      if (watchers.has(dir)) continue;
      try {
        const w = fs.watch(path.join(dir, 'data'), (_, name) => { if (name === 'watcher.json') sidebarSoon(); });
        w.on('error', () => { w.close(); watchers.delete(dir); });
        watchers.set(dir, w);
      } catch {}
    }
  }

  function startHolding() {
    reconcile();
    watchWatchers();
    timers = [setInterval(() => { reconcile(); watchWatchers(); }, retryMs), setInterval(() => refreshSidebar(), sidebarMs), setInterval(() => write(': ping\n\n'), pingMs)];
  }
  function stopHolding() {
    for (const t of timers) clearInterval(t);
    timers = [];
    clearTimeout(sidebarTimer);
    sidebarTimer = null;
    pendingFresh = new Set();
    for (const u of upstreams.values()) u.req?.destroy();
    upstreams.clear();
    for (const w of watchers.values()) w.close();
    watchers.clear();
    opened.clear();
    lastSidebar = null;
    lastData = null;
  }

  // Written straight to the socket, unbuffered and never gzipped, like each board's own stream.
  function handle(req, res, viewer = null) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.set(res, viewer);
    if (clients.size === 1) startHolding();
    if (lastSidebar) sidebarTo(res, lastData, lastSidebar);
    else refreshSidebar();
    req.on('close', () => {
      clients.delete(res);
      if (!clients.size) stopHolding();
    });
  }

  function close() {
    for (const res of clients.keys()) res.end();
    clients.clear();
    stopHolding();
  }

  // changed(route) passes on a change the board's own stream can't see, such as a pending prompt; refresh() resends
  // the sidebar when it differs.
  return {
    handle, close,
    changed: (route) => { if (clients.size) changed(route); },
    refresh: () => { if (clients.size) refreshSidebar(); },
  };
}
