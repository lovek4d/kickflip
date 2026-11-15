import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { destOf, pageOf } from './shell.mjs';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'sw.js'), 'utf8');
const ORIGIN = 'https://mac.tail.ts.net';
const SHELL = `${ORIGIN}/`;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const shellAnswer = (body) => new Response(body, { headers: { 'content-type': 'text/html', 'x-app-shell': '1' } });
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const hanging = () => new Promise(() => {});

function worker() {
  const handlers = {};
  const caches = new Map();
  const timers = new Map();
  let now = 0;
  let nextTimer = 1;
  const calls = [];
  const w = {
    network: offline,
    calls,
    sent: [],
    skipped: 0,
    windows: [],
    opened: [],
    shown: [],
    // The notifications on screen, each {title, tag}: a shown one replaces any with its tag, and close removes it.
    showing: [],
    async advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
      await flush();
    },
    async saved() {
      const out = {};
      for (const [k, v] of caches.get('hub-app') || []) out[k] = new TextDecoder().decode(v.body);
      return out;
    },
  };
  const keyOf = (k) => (typeof k === 'string' ? k : k.url);
  const cacheStorage = {
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const m = caches.get(name);
      return {
        async put(key, res) { m.set(keyOf(key), { status: res.status, headers: [...res.headers], body: new Uint8Array(await res.arrayBuffer()) }); },
        async match(key) { const e = m.get(keyOf(key)); return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined; },
        async keys() { return [...m.keys()].map((url) => ({ url })); },
        async delete(key) { return m.delete(keyOf(key)); },
      };
    },
  };
  class MessageChannel {
    constructor() {
      const port1 = { onmessage: null };
      this.port1 = port1;
      this.port2 = { postMessage: (data) => queueMicrotask(() => port1.onmessage?.({ data })) };
    }
  }
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: {
      scope: SHELL,
      showNotification: async (title, opts) => {
        w.shown.push({ title, ...opts });
        w.showing = [...w.showing.filter((n) => !opts?.tag || n.tag !== opts.tag), { title, tag: opts?.tag }];
      },
      getNotifications: async ({ tag } = {}) => w.showing.filter((n) => tag === undefined || n.tag === tag)
        .map((n) => ({ ...n, close: () => { w.showing = w.showing.filter((s) => s.tag !== n.tag || s.title !== n.title); } })),
    },
    location: new URL('/sw.js', ORIGIN),
    skipWaiting: () => { w.skipped++; return Promise.resolve(); },
    clients: {
      claim: async () => {},
      matchAll: async () => w.windows,
      openWindow: async (url) => { w.opened.push(url); },
    },
  };
  const context = vm.createContext({
    self, caches: cacheStorage, URL, Request, Response, MessageChannel, TextDecoder, queueMicrotask,
    fetch: (input, init) => { const url = keyOf(input); calls.push(url); w.sent.push(input); return Promise.resolve().then(() => w.network(url, init)); },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(SRC, context);

  // A request the page makes; null when the worker leaves it to the network.
  w.request = (pathOrUrl, { method = 'GET', mode = 'cors', destination = '' } = {}) => {
    const ev = {
      request: { url: new URL(pathOrUrl, ORIGIN).href, method, mode, destination },
      responded: null,
      waits: [],
      respondWith(p) { this.responded = Promise.resolve(p); },
      waitUntil(p) { this.waits.push(p); },
    };
    handlers.fetch(ev);
    if (!ev.responded) return null;
    const out = { settled: false, text: null, status: null, error: null };
    out.done = ev.responded.then(async (res) => { out.status = res.status; out.text = await res.text(); }, (e) => { out.error = e; })
      .then(async () => { await flush(); out.settled = true; return out; });
    return out;
  };
  w.page = (p, opts = {}) => w.request(p, { mode: 'navigate', destination: 'document', ...opts });
  w.dispatch = async (type, extra = {}) => {
    const ev = { waits: [], waitUntil(p) { this.waits.push(p); }, ...extra };
    handlers[type](ev);
    await flush();
    return ev;
  };
  return w;
}

test('a page load of the shell goes to the network first, and its answer replaces the saved shell', async () => {
  const w = worker();
  w.network = () => shellAnswer('shell v1');
  const r = await w.page('/hub-orchestrator/').done;
  assert.equal(r.text, 'shell v1');
  assert.deepEqual(await w.saved(), { [SHELL]: 'shell v1' });
  w.network = () => shellAnswer('shell v2');
  assert.equal((await w.page('/_hub/settings').done).text, 'shell v2');
  assert.deepEqual(await w.saved(), { [SHELL]: 'shell v2' });
});

test("the worker's own fetch of a page load reaches the hub as a page load, so a site's page still gets the shell", async () => {
  const sites = new Set(['hub-orchestrator', 'learn']);
  const w = worker();
  w.network = () => shellAnswer('the shell');
  for (const p of ['/learn/', '/hub-orchestrator/prototype-a.html?q=q1&from=push', '/hub-orchestrator/']) {
    w.sent.length = 0;
    await w.page(p).done;
    const [sent] = w.sent;
    const headers = { ...Object.fromEntries(sent.headers), 'sec-fetch-dest': 'empty' };
    const u = new URL(sent.url);
    assert.equal(u.href, new URL(p, ORIGIN).href);
    assert.equal(pageOf({ method: sent.method, pathname: u.pathname, search: u.search, dest: destOf(headers), sites }), 'shell', p);
  }
  assert.equal(destOf({ 'sec-fetch-dest': 'iframe' }), 'iframe');
});

test('while the Mac is asleep or the hub down, every page the shell answers, each push URL included, opens from the saved shell', async () => {
  const w = worker();
  w.network = offline;
  const none = await w.page('/hub-orchestrator/').done;
  assert.ok(none.error, 'with no saved shell the load fails as before');

  w.network = () => shellAnswer('the shell');
  await w.page('/').done;
  for (const p of ['/', '/hub-orchestrator/', '/hub-orchestrator/questions.html', '/hub-orchestrator/prototype-sidebar.html?q=q1&from=push', '/_hub/settings', '/learn/']) {
    w.network = offline;
    assert.equal((await w.page(p).done).text, 'the shell', p);
    w.network = () => new Response('Bad Gateway', { status: 502 });
    assert.equal((await w.page(p).done).text, 'the shell', `${p} on a 502`);
  }

  w.network = hanging;
  const slow = w.page('/hub-orchestrator/');
  await w.advance(2999);
  assert.equal(slow.settled, false, 'the network gets three seconds');
  await w.advance(1);
  assert.equal((await slow.done).text, 'the shell');
});

test("a site's own page or an error page reaches the browser and never replaces the saved shell", async () => {
  const w = worker();
  w.network = () => shellAnswer('the shell');
  await w.page('/').done;
  w.network = () => new Response('the board server copy', { headers: { 'content-type': 'text/html' } });
  assert.equal((await w.page('/hub-orchestrator/').done).text, 'the board server copy');
  w.network = () => new Response('No site', { status: 404 });
  assert.equal((await w.page('/gone/').done).status, 404);
  assert.deepEqual(await w.saved(), { [SHELL]: 'the shell' });
});

test('forgetting the shell answers on the port and a slow navigation waits for the network instead of the old shell', async () => {
  const w = worker();
  w.network = () => shellAnswer('old shell');
  await w.page('/').done;
  assert.deepEqual(await w.saved(), { [SHELL]: 'old shell' });
  const answers = [];
  const ev = await w.dispatch('message', { data: { forget: 'shell' }, ports: [{ postMessage: (data) => answers.push({ ...data }) }] });
  await Promise.all(ev.waits);
  assert.deepEqual(answers, [{ forgot: true }]);
  assert.deepEqual(await w.saved(), {});
  let answer;
  w.network = () => new Promise((resolve) => { answer = resolve; });
  const slow = w.page('/_hub/');
  await w.advance(3001);
  assert.equal(slow.settled, false);
  answer(shellAnswer('new shell'));
  assert.equal((await slow.done).text, 'new shell');
  assert.deepEqual(await w.saved(), { [SHELL]: 'new shell' });
});

test("the worker answers with the saved shell exactly the page loads hub/shell.mjs pageOf answers with the shell", async () => {
  const sites = new Set(['hub-orchestrator', 'learn']);
  const paths = ['/', '/_hub/', '/_hub/settings', '/_hub/settings/polling', '/_hub/api/hub', '/_hub/sidebar.json', '/_hub/app/ui.js',
    '/_hub/stream', '/sw.js', '/manifest.webmanifest', '/hub-orchestrator/', '/hub-orchestrator/settings.html', '/hub-orchestrator/questions.html',
    '/hub-orchestrator/notes.html?item=w/1', '/hub-orchestrator/prototype-a.html?q=q1&from=push', '/hub-orchestrator/prototype-a.html?q=q1&alone=1',
    '/hub-orchestrator/api/board', '/hub-orchestrator/uploads/a.png', '/hub-orchestrator/uploads/a.html', '/hub-orchestrator/installs/P2/',
    '/learn/', '/learn/lesson.htm', '/learn/app.js'];
  const w = worker();
  w.network = () => shellAnswer('the shell');
  await w.page('/').done;
  w.network = offline;
  for (const p of paths) {
    const u = new URL(p, ORIGIN);
    const shell = pageOf({ pathname: u.pathname, search: u.search, dest: 'document', sites }) === 'shell';
    const r = w.page(p);
    assert.equal(Boolean(r && (await r.done).text === 'the shell'), shell, p);
  }
});

test("API calls, the hub's stream, uploads, posts, other origins and a frame's page load are never cached or answered by the worker", async () => {
  const w = worker();
  w.network = () => new Response('net', { headers: { 'x-app-shell': '1' } });
  const untouched = [
    ['https://mac.ts.net:8500/', { mode: 'navigate', destination: 'document' }],
    ['/_hub/stream'], ['/_hub/sidebar.json'], ['/_hub/api/hub'], ['/_hub/needs.json'],
    ['/hub-orchestrator/api/board'], ['/hub-orchestrator/api/thread?key=w/1'], ['/hub-orchestrator/api/stream'],
    ['/hub-orchestrator/_claude/events'], ['/hub-orchestrator/uploads/1-shot.png', { destination: 'image' }],
    ['/hub-orchestrator/api/upload', { method: 'POST' }], ['/_hub/settings/notifications', { method: 'POST' }],
    ['/_hub/settings', { method: 'POST', mode: 'navigate', destination: 'document' }],
    ['https://cdn.example.com/_hub/app/ui.js', { destination: 'script' }],
    ['/learn/', { mode: 'navigate', destination: 'iframe' }],
    ['/hub-orchestrator/prototype-a.html?take=A', { mode: 'navigate', destination: 'iframe' }],
    ['/hub-orchestrator/', { mode: 'navigate', destination: 'iframe' }],
    ['/hub-orchestrator/prototype-a.html?q=q1&alone=1', { mode: 'navigate', destination: 'document' }],
    ['/hub-orchestrator/uploads/1-shot.png', { mode: 'navigate', destination: 'document' }],
    ['/sw.js'], ['/manifest.webmanifest'], ['/_hub/icon-180.png?v=1', { destination: 'image' }],
  ];
  for (const [p, opts] of untouched) assert.equal(w.request(p, opts), null, `${opts?.method || 'GET'} ${p} ${opts?.destination || ''}`);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(await w.saved(), {});
});

test("the shell's files go network first by their full URL, and a new version replaces the old one", async () => {
  const w = worker();
  w.network = (url) => new Response(`${new URL(url).pathname}${new URL(url).search}`);
  for (const p of ['/_hub/app/ui.js?v=a', '/_hub/app/style.css?v=s', '/_hub/colors.css?v=c', '/_hub/kickflip.png']) await w.request(p).done;
  w.network = offline;
  assert.equal((await w.request('/_hub/app/ui.js?v=a').done).text, '/_hub/app/ui.js?v=a');
  assert.equal((await w.request('/_hub/kickflip.png').done).text, '/_hub/kickflip.png');

  w.network = (url) => new Response(`new ${new URL(url).search}`);
  assert.equal((await w.request('/_hub/app/ui.js?v=b').done).text, 'new ?v=b');
  assert.deepEqual(Object.keys(await w.saved()).sort(), [
    `${ORIGIN}/_hub/app/style.css?v=s`, `${ORIGIN}/_hub/app/ui.js?v=b`, `${ORIGIN}/_hub/colors.css?v=c`, `${ORIGIN}/_hub/kickflip.png`,
  ]);
  w.network = offline;
  assert.equal((await w.request('/_hub/app/ui.js?v=b').done).text, 'new ?v=b');
  assert.ok((await w.request('/_hub/app/ui.js?v=a').done).error, 'a dropped version is gone');
  w.network = () => new Response('Bad Gateway', { status: 502 });
  assert.equal((await w.request('/_hub/app/style.css?v=s').done).text, '/_hub/app/style.css?v=s');
});

test('installing saves the shell from `/` and the files it links, so one visit is enough to open offline', async () => {
  const html = '<link rel="stylesheet" href="/_hub/colors.css?v=c"><link rel="stylesheet" href="/_hub/app/style.css?v=s"><link rel="manifest" href="/manifest.webmanifest">'
    + '<a href="/_hub/settings"><img src="/_hub/kickflip.png"></a><script src="/_hub/app/ui.js?v=u"></script>';
  const w = worker();
  w.network = (url) => (url === SHELL ? shellAnswer(html) : new Response(`file ${url}`));
  const ev = await w.dispatch('install');
  await Promise.all(ev.waits);
  assert.equal(w.skipped, 1);
  assert.deepEqual(Object.keys(await w.saved()).sort(), [
    SHELL, `${ORIGIN}/_hub/app/style.css?v=s`, `${ORIGIN}/_hub/app/ui.js?v=u`, `${ORIGIN}/_hub/colors.css?v=c`, `${ORIGIN}/_hub/kickflip.png`,
  ]);
  w.network = offline;
  assert.equal((await w.page('/hub-orchestrator/').done).text, html);

  const down = worker();
  const install = await down.dispatch('install');
  await assert.doesNotReject(Promise.all(install.waits), 'an install while the Mac is unreachable still succeeds');
  assert.equal(down.skipped, 1);
});

test("a push tap routes in place in a window that answers, and navigates one that doesn't within 1.5 s or has no app", async () => {
  const URL_ = `${ORIGIN}/hub-orchestrator/#selectedCard=w%2F1&reply`;
  const tap = (w) => w.dispatch('notificationclick', { notification: { data: { url: URL_ }, close() {} } });
  const win = (answer) => {
    const x = { focused: 0, navigated: [], posted: [], focus: async () => { x.focused++; }, navigate: async (u) => { x.navigated.push(u); } };
    x.postMessage = (msg, [port]) => { x.posted.push({ ...msg }); if (answer !== undefined) port.postMessage(answer); };
    return x;
  };

  const routed = worker();
  routed.windows = [win({ routed: true })];
  await Promise.all((await tap(routed)).waits);
  assert.deepEqual(routed.windows[0].posted, [{ open: URL_ }]);
  assert.equal(routed.windows[0].focused, 1);
  assert.deepEqual(routed.windows[0].navigated, []);

  const refused = worker();
  refused.windows = [win({ routed: false })];
  await Promise.all((await tap(refused)).waits);
  assert.deepEqual(refused.windows[0].navigated, [URL_]);

  const silent = worker();
  silent.windows = [win(undefined)];
  const ev = await tap(silent);
  await silent.advance(1499);
  assert.deepEqual(silent.windows[0].navigated, []);
  await silent.advance(1);
  await Promise.all(ev.waits);
  assert.deepEqual(silent.windows[0].navigated, [URL_]);

  const closed = worker();
  await Promise.all((await tap(closed)).waits);
  assert.deepEqual(closed.opened, [URL_]);
});

test('a push under a tag replaces the notification with that tag and alerts again; one without a tag never sets renotify', async () => {
  const w = worker();
  const push = (msg) => w.dispatch('push', { data: { json: () => msg } });
  await Promise.all((await push({ title: 'A1 asks: Which layout?', body: 'Grid · List', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' })).waits);
  await Promise.all((await push({ title: 'A1 asks: Which colour?', body: 'Blue · Red', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' })).waits);
  await Promise.all((await push({ title: "Orch isn't listening", url: '/orch/' })).waits);
  assert.deepEqual(w.shown.map(({ title, tag, renotify }) => [title, tag, renotify]), [
    ['A1 asks: Which layout?', 'item-w/A1', true],
    ['A1 asks: Which colour?', 'item-w/A1', true],
    ["Orch isn't listening", undefined, false],
  ]);
});

// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md
test("a close push closes the notification with its tag, leaving the others; it shows a silent one under the tag first, which iOS needs of every push, and closes that too", async () => {
  const w = worker();
  const push = (msg) => w.dispatch('push', { data: { json: () => msg } });
  await Promise.all((await push({ title: 'A1: Tap Implement', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' })).waits);
  await Promise.all((await push({ title: 'B2: Merge', url: '/orch/#selectedCard=w%2FB2', tag: 'item-w/B2' })).waits);
  await Promise.all((await push({ close: 'item-w/A1' })).waits);
  assert.deepEqual(w.showing.map((n) => n.tag), ['item-w/B2']);
  const quiet = w.shown.at(-1);
  assert.deepEqual([quiet.tag, quiet.silent, quiet.renotify], ['item-w/A1', true, false]);
  await Promise.all((await push({ close: 'item-w/C3' })).waits);
  assert.deepEqual(w.showing.map((n) => n.tag), ['item-w/B2'], 'a close with nothing under its tag leaves nothing behind');
});
