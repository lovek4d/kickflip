import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { pageOf, versionAppAssets } from './shell.mjs';
import { hubStream } from './stream.mjs';
import { until } from '../shared/test-helpers.mjs';

const boards = new Set(['hub-orchestrator', 'ios']);
const sites = new Set([...boards, 'learn']);

test("a browser's page load of `/` or of any site's page gets the shell, and any GET of `/` or a hub page; frames, curl, API calls, uploads, Open alone and other files still reach the site, and the hub's own paths the hub", () => {
  const cases = [
    [{ pathname: '/', dest: 'document' }, 'shell'],
    [{ pathname: '/' }, 'shell'],
    [{ pathname: '/hub-orchestrator/', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/', dest: 'iframe' }, 'forward'],
    [{ pathname: '/hub-orchestrator/' }, 'forward'],
    [{ pathname: '/hub-orchestrator/', dest: 'document', method: 'POST' }, 'forward'],
    [{ pathname: '/hub-orchestrator/api/board', dest: 'empty' }, 'forward'],
    [{ pathname: '/hub-orchestrator/api/board', dest: 'document' }, 'forward'],
    [{ pathname: '/hub-orchestrator/api/stream', dest: 'empty' }, 'forward'],
    [{ pathname: '/hub-orchestrator/api/upload', dest: 'empty', method: 'POST' }, 'forward'],
    [{ pathname: '/hub-orchestrator/uploads/1-shot.png', dest: 'image' }, 'forward'],
    [{ pathname: '/hub-orchestrator/uploads/1-shot.png', dest: 'document' }, 'forward'],
    [{ pathname: '/hub-orchestrator/uploads/1-page.html', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/settings.html', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/questions.html', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/notes.html', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/plan.html', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/settings.html', dest: 'iframe' }, 'forward'],
    [{ pathname: '/hub-orchestrator/questions.html' }, 'forward'],
    [{ pathname: '/hub-orchestrator/prototype-sidebar.html', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/prototype-sidebar.html', search: '?q=q1&from=push', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/prototype-sidebar.html', search: '?take=A', dest: 'iframe' }, 'forward'],
    [{ pathname: '/hub-orchestrator/prototype-sidebar.html', search: '?q=q1&alone=1', dest: 'document' }, 'forward'],
    [{ pathname: '/hub-orchestrator/shots-gallery.html', dest: 'document' }, 'shell'],
    [{ pathname: '/hub-orchestrator/installs/P2/', dest: 'document' }, 'shell'],
    [{ pathname: '/learn/', dest: 'document' }, 'shell'],
    [{ pathname: '/learn/', dest: 'iframe' }, 'forward'],
    [{ pathname: '/learn/', dest: 'document', search: '?alone=1' }, 'forward'],
    [{ pathname: '/learn/settings.html', dest: 'document' }, 'shell'],
    [{ pathname: '/learn/lessons/0001.html', dest: 'document' }, 'shell'],
    [{ pathname: '/learn/lessons/0001.html', dest: 'iframe' }, 'forward'],
    [{ pathname: '/learn/assets/course.css', dest: 'style' }, 'forward'],
    [{ pathname: '/learn', dest: 'document' }, 'forward'],
    [{ pathname: '/gone/', dest: 'document' }, 'forward'],
    [{ pathname: '/_hub/', dest: 'document' }, 'shell'],
    [{ pathname: '/_hub/settings', dest: 'document' }, 'shell'],
    [{ pathname: '/_hub/settings/polling', search: '?w=09%3A00', dest: 'document' }, 'shell'],
    [{ pathname: '/_hub/settings', dest: 'iframe' }, 'shell'],
    [{ pathname: '/_hub/' }, 'shell'],
    [{ pathname: '/_hub/settings', method: 'HEAD' }, 'shell'],
    [{ pathname: '/_hub/settings/polling', method: 'POST', dest: 'empty' }, 'hub'],
    [{ pathname: '/_hub/settings/notifications', method: 'POST', dest: 'empty' }, 'hub'],
    [{ pathname: '/_hub/api/hub', dest: 'empty' }, 'hub'],
    [{ pathname: '/_hub', dest: 'document' }, 'hub'],
    [{ pathname: '/_hub/sidebar.json', dest: 'empty' }, 'hub'],
    [{ pathname: '/sw.js', dest: 'serviceworker' }, 'hub'],
  ];
  assert.deepEqual(cases.map(([req]) => pageOf({ ...req, sites })), cases.map(([, page]) => page));
});

test("the hub serves the shell for a page load of exactly the URLs the app's router shows in place, so a reload lands on the same view", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(new URL('../board/public/router.js', import.meta.url), 'utf8'), context);
  const { viewOf, mounted } = context.AppRouter;
  const paths = ['/hub-orchestrator/', '/hub-orchestrator/settings.html', '/hub-orchestrator/questions.html', '/hub-orchestrator/notes.html',
    '/hub-orchestrator/plan.html', '/hub-orchestrator/prototype-x.html', '/hub-orchestrator/installs/P2/', '/hub-orchestrator/uploads/1-shot.png',
    '/hub-orchestrator/api/board', '/learn/', '/learn/lessons/0001.html', '/learn/lessons/0001.htm', '/learn/assets/course.css', '/learn/data',
    '/_hub/', '/_hub/settings', '/_hub/settings/polling', '/_hub/api/polling', '/_hub/sidebar.json', '/_hub/kickflip.png'];
  for (const p of paths) {
    const routed = mounted(viewOf(`https://mac.ts.net${p}`, { boards, base: 'https://mac.ts.net/' }));
    assert.equal(pageOf({ pathname: p, dest: 'document', sites }) === 'shell', routed, p);
  }
});

test("the shell's /_hub/app/ links name each file's version, and a file with none keeps its plain link", () => {
  const html = '<link rel="stylesheet" href="/_hub/app/style.css"><script src="/_hub/app/app.js"></script><script src="/_hub/app/gone.js"></script><link href="colors.css">';
  assert.equal(versionAppAssets(html, (f) => (f === 'gone.js' ? null : `v-${f}`)),
    '<link rel="stylesheet" href="/_hub/app/style.css?v=v-style.css"><script src="/_hub/app/app.js?v=v-app.js"></script><script src="/_hub/app/gone.js"></script><link href="colors.css">');
});

function fakeBoard(port = 0) {
  const streams = new Set();
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/stream') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('retry: 3000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
  });
  return new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    listening: () => streams.size,
    change: () => { for (const res of streams) res.write(`event: change\ndata: {"at":"${new Date().toISOString()}"}\n\n`); },
    stop: () => new Promise((done) => { for (const res of streams) res.destroy(); server.close(done); }),
  })));
}

const listen = (port) => listenAt(port, '/_hub/stream');
function listenAt(port, pathname) {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (type) events.push({ type, data: JSON.parse(data) });
      }
    });
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}

test("a board's change reaches /_hub/stream as change {route} with the sidebar's new data, and the stream recovers after the board restarts", async () => {
  let board = await fakeBoard();
  const port = board.port;
  let waiting = 0;
  const relay = hubStream({ targets: () => [{ route: 'ios', port }], sidebar: async ({ fresh }) => ({ waiting, fresh: [...fresh] }), retryMs: 30, settleMs: 10 });
  const hub = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve, reject) => hub.once('error', reject).listen(0, '127.0.0.1', resolve));
  const page = listen(hub.address().port);
  try {
    await until(() => board.listening() === 1 && page.events.some((e) => e.type === 'sidebar'), 'the hub connects to the board and sends the initial sidebar');
    assert.deepEqual(page.events, [{ type: 'sidebar', data: { waiting: 0, fresh: [] } }]);

    waiting = 1;
    board.change();
    await until(() => page.events.length === 3, 'the board change and refreshed sidebar reach the page');
    assert.deepEqual(page.events.slice(1), [{ type: 'change', data: { route: 'ios' } }, { type: 'sidebar', data: { waiting: 1, fresh: ['ios'] } }]);

    await board.stop();
    board = await fakeBoard(port);
    await until(() => board.listening() === 1 && page.events.some((e, i) => i > 2 && e.type === 'change'), 'the hub reconnects after the board restarts');
    board.change();
    await until(() => page.events.filter((e) => e.type === 'change').length === 3, 'the restarted board sends its next change');
    assert.deepEqual(page.events.filter((e) => e.type === 'change').map((e) => e.data), [{ route: 'ios' }, { route: 'ios' }, { route: 'ios' }]);

    page.close();
    await until(() => board.listening() === 0, 'the hub lets go of the board once no page listens');
  } finally {
    page.close();
    relay.close();
    await board.stop();
    await new Promise((r) => hub.close(r));
  }
});

test("a watcher file written or removed in a board's data folder sends the sidebar at once, without a board change", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-watch-'));
  fs.mkdirSync(path.join(dir, 'data'));
  let listening = false;
  let reads = 0;
  const relay = hubStream({ targets: () => [], watched: () => [{ route: 'ios', dir }], sidebar: async () => { reads++; return { listening }; }, retryMs: 30, settleMs: 10, sidebarMs: 60_000 });
  const hub = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve, reject) => hub.once('error', reject).listen(0, '127.0.0.1', resolve));
  const page = listen(hub.address().port);
  try {
    await until(() => page.events.length === 1, 'the initial sidebar');
    // A Mac's file watch goes live a moment after fs.watch returns, and under load misses a write made before then. So the
    // test writes the watcher file, the sidebar unchanged, until the hub reads the sidebar for it.
    const before = reads;
    await until(() => { fs.writeFileSync(path.join(dir, 'data', 'watcher.json'), '{}'); return reads > before; }, 'the hub watching the data folder');
    listening = true;
    fs.writeFileSync(path.join(dir, 'data', 'watcher.json'), '{"pid":1}');
    await until(() => page.events.some((e) => e.data.listening), 'the sidebar after the watcher starts');
    listening = false;
    fs.rmSync(path.join(dir, 'data', 'watcher.json'));
    await until(() => page.events.at(-1).data.listening === false && page.events.length === 3, 'the sidebar after the watcher goes');
  } finally {
    page.close();
    relay.close();
    await new Promise((r) => hub.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md
test("a shared person's stream carries only their boards' changes and their view of the sidebar", async () => {
  const ios = await fakeBoard();
  const web = await fakeBoard();
  let waiting = 0;
  const relay = hubStream({ targets: () => [{ route: 'ios', port: ios.port }, { route: 'web', port: web.port }], sidebar: async () => ({ waiting, routes: ['ios', 'web'] }), retryMs: 30, settleMs: 10 });
  const hub = http.createServer((req, res) => relay.handle(req, res, req.url.endsWith('?shared') ? { routes: new Set(['web']), view: (data) => ({ routes: data.routes.filter((r) => r === 'web') }) } : null));
  await new Promise((resolve, reject) => hub.once('error', reject).listen(0, '127.0.0.1', resolve));
  const owner = listen(hub.address().port);
  try {
    await until(() => owner.events.length === 1 && ios.listening() === 1 && web.listening() === 1, 'the owner stream holds both boards');
    const shared = listenAt(hub.address().port, '/_hub/stream?shared');
    await until(() => shared.events.length === 1, "the shared person's first sidebar");
    assert.deepEqual(shared.events, [{ type: 'sidebar', data: { routes: ['web'] } }]);
    waiting = 1;
    ios.change();
    web.change();
    await until(() => owner.events.filter((e) => e.type === 'change').length === 2 && shared.events.length >= 2, 'both changes');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(shared.events.filter((e) => e.type === 'change').map((e) => e.data), [{ route: 'web' }]);
    assert.ok(shared.events.filter((e) => e.type === 'sidebar').every((e) => JSON.stringify(e.data) === '{"routes":["web"]}'));
    shared.close();
  } finally {
    owner.close();
    relay.close();
    await ios.stop();
    await web.stop();
    await new Promise((r) => hub.close(r));
  }
});
