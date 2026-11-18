import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pageOf, versionAppAssets } from './shell.mjs';
import { hubStream } from './stream.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

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
  const waiting = new Set();
  const moved = () => { for (const w of waiting) if (streams.size === w.count) { waiting.delete(w); w.resolve(); } };
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/stream') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('retry: 3000\n\n');
    streams.add(res);
    moved();
    req.on('close', () => { streams.delete(res); moved(); });
  });
  return new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    // Resolves once the board holds exactly count streams.
    streams: (count) => new Promise((resolve) => { waiting.add({ count, resolve }); moved(); }),
    change: () => { for (const res of streams) res.write(`event: change\ndata: {"at":"${new Date().toISOString()}"}\n\n`); },
    stop: () => new Promise((done) => { for (const res of streams) res.destroy(); server.close(done); }),
  })));
}

const listen = (port) => listenAt(port, '/_hub/stream');
function listenAt(port, pathname) {
  const events = [];
  const waiting = new Set();
  const moved = () => { for (const w of waiting) if (w.predicate(events)) { waiting.delete(w); w.resolve(); } };
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
      moved();
    });
  });
  req.on('error', () => {});
  // Resolves once predicate(events) holds, checked as each chunk arrives.
  return { events, close: () => req.destroy(), waitFor: (predicate) => new Promise((resolve) => { waiting.add({ predicate, resolve }); moved(); }) };
}

// The relay's retry and settle timers run under t.mock.timers, which the test ticks; the pages and boards are awaited by their events.
const mockTimers = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

test("a board's change reaches /_hub/stream as change {route} with the sidebar's new data, and the stream recovers after the board restarts", async (t) => {
  mockTimers(t);
  let board = await fakeBoard();
  const port = board.port;
  let waiting = 0;
  const relay = hubStream({ targets: () => [{ route: 'ios', port }], sidebar: async ({ fresh }) => ({ waiting, fresh: [...fresh] }), settleMs: 10 });
  const hub = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve, reject) => hub.once('error', reject).listen(0, '127.0.0.1', resolve));
  const page = listen(hub.address().port);
  try {
    await Promise.all([board.streams(1), page.waitFor((events) => events.some((e) => e.type === 'sidebar'))]);
    assert.deepEqual(page.events, [{ type: 'sidebar', data: { waiting: 0, fresh: [] } }]);

    waiting = 1;
    board.change();
    await page.waitFor((events) => events.some((e) => e.type === 'change'));
    t.mock.timers.tick(10);
    await page.waitFor((events) => events.length === 3);
    assert.deepEqual(page.events.slice(1), [{ type: 'change', data: { route: 'ios' } }, { type: 'sidebar', data: { waiting: 1, fresh: ['ios'] } }]);

    await board.stop();
    board = await fakeBoard(port);
    // The hub's reconcile, which its clock runs, finds the board's stream gone and connects again: run it until the restarted board has a stream.
    let reconnected = false;
    board.streams(1).then(() => { reconnected = true; });
    while (!reconnected) {
      relay.reconcile();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await page.waitFor((events) => events.filter((e) => e.type === 'change').length === 2);
    board.change();
    await page.waitFor((events) => events.filter((e) => e.type === 'change').length === 3);
    assert.deepEqual(page.events.filter((e) => e.type === 'change').map((e) => e.data), [{ route: 'ios' }, { route: 'ios' }, { route: 'ios' }]);

    page.close();
    await board.streams(0);
  } finally {
    page.close();
    relay.close();
    await board.stop();
    await new Promise((r) => hub.close(r));
  }
});

test("a watcher file written or removed in a board's data folder sends the sidebar at once, without a board change", async (t) => {
  mockTimers(t);
  const dir = tempDir('shell-watcher-');
  fs.mkdirSync(path.join(dir, 'data'));
  const file = path.join(dir, 'data', 'watcher.json');
  const watching = [];
  let asked = 0;
  const watch = (folder, onEvent) => { watching.push({ folder, onEvent }); return { on() {}, close() {} }; };
  let listening = false;
  const relay = hubStream({ targets: () => [], watched: () => [{ route: 'ios', dir }], watch, sidebar: async () => { asked += 1; return { listening }; }, settleMs: 10 });
  const hub = http.createServer((req, res) => relay.handle(req, res));
  await new Promise((resolve, reject) => hub.once('error', reject).listen(0, '127.0.0.1', resolve));
  const page = listen(hub.address().port);
  try {
    await page.waitFor((events) => events.length === 1);
    assert.deepEqual(watching.map((w) => w.folder), [path.join(dir, 'data')]);
    const fire = () => { watching[0].onEvent('rename', 'watcher.json'); t.mock.timers.tick(10); };
    listening = true;
    fs.writeFileSync(file, JSON.stringify({ pid: 1, since: 'a' }));
    fire();
    await page.waitFor((events) => events.some((e) => e.data.listening));
    // A write that only moves the checks counter asks for no sidebar.
    fs.writeFileSync(file, JSON.stringify({ pid: 1, since: 'a', checks: 1 }));
    fire();
    listening = false;
    fs.writeFileSync(file, JSON.stringify({ pid: 1, since: 'a', exited_at: 'b' }));
    fire();
    await page.waitFor((events) => events.at(-1).data.listening === false && events.length === 3);
    assert.equal(asked, 3, 'the first send, the start and the exit, not the counter');
  } finally {
    page.close();
    relay.close();
    await new Promise((r) => hub.close(r));
    fs.rmSync(dir, { recursive: true });
  }
});

