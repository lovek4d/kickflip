// The hub's one event stream, GET /_hub/stream, which the app shell holds in place of a stream per board
// (docs/adr/0055-one-app-for-the-whole-hub.md). While any page listens, the hub holds each board server's own
// api/stream (docs/adr/0031-the-board-reloads-on-a-change-signal.md) and passes each change on as
// `event: change` with data {route}. A board whose stream comes back, such as after a restart, gets one change too,
// since it may have changed while its stream was down. `event: sidebar` carries what /_hub/sidebar.json would answer
// whenever that differs from the last one sent: after a board's change, and on a timer for what no stream reports,
// such as a site going down or a page's waiting count.
import http from 'node:http';

// targets() → [{route, port}], the boards to hold; sidebar({fresh}) → the sidebar data, fresh naming the routes whose
// waiting counts to refetch. → {handle(req, res), close()}
export function hubStream({ targets, sidebar, retryMs = 2000, sidebarMs = 15_000, pingMs = 25_000, settleMs = 300, log = () => {} }) {
  const clients = new Set();
  const upstreams = new Map(); // route → {port, req}
  const opened = new Set(); // routes whose stream has opened since the first page started listening
  let lastSidebar = null;
  let timers = [];
  let pendingFresh = new Set();
  let sidebarTimer = null;

  const write = (text, to = clients) => { for (const res of to) res.write(text); };
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  async function refreshSidebar(fresh = []) {
    let data;
    try { data = await sidebar({ fresh: new Set(fresh) }); } catch (e) { log(`sidebar for the stream failed: ${e.message}`); return; }
    const json = JSON.stringify(data);
    if (json === lastSidebar) return;
    lastSidebar = json;
    write(`event: sidebar\ndata: ${json}\n\n`);
  }
  function sidebarSoon(route) {
    pendingFresh.add(route);
    if (sidebarTimer) return;
    sidebarTimer = setTimeout(() => {
      sidebarTimer = null;
      const fresh = [...pendingFresh];
      pendingFresh = new Set();
      refreshSidebar(fresh);
    }, settleMs);
  }

  function changed(route) {
    write(event('change', { route }));
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

  function startHolding() {
    reconcile();
    timers = [setInterval(reconcile, retryMs), setInterval(() => refreshSidebar(), sidebarMs), setInterval(() => write(': ping\n\n'), pingMs)];
  }
  function stopHolding() {
    for (const t of timers) clearInterval(t);
    timers = [];
    clearTimeout(sidebarTimer);
    sidebarTimer = null;
    pendingFresh = new Set();
    for (const u of upstreams.values()) u.req?.destroy();
    upstreams.clear();
    opened.clear();
    lastSidebar = null;
  }

  // Written straight to the socket, unbuffered and never gzipped, like each board's own stream.
  function handle(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    if (clients.size === 1) startHolding();
    if (lastSidebar) write(`event: sidebar\ndata: ${lastSidebar}\n\n`, [res]);
    else refreshSidebar();
    req.on('close', () => {
      clients.delete(res);
      if (!clients.size) stopHolding();
    });
  }

  function close() {
    for (const res of clients) res.end();
    clients.clear();
    stopHolding();
  }

  return { handle, close };
}
