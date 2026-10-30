import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from './mini-dom.mjs';
import { buildBoard, BUTTON, ACTION_KIND } from './domain.mjs';

const SCRIPTS = ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-threads.js', 'ui-cards.js', 'ui-header.js', 'ui-snapshot.js', 'ui-page-header.js', 'ui-sidebar.js', 'ui-questions.js', 'ui-prompts.js', 'ui-markdown.js', 'ui-hub.js', 'prompts.js', 'rules-editor.js',
  'hub-kit.js', 'sidebar.js', 'app.js', 'app-core.js', 'app-threads.js', 'app-cards.js', 'app-lanes.js', 'app-asks.js', 'app-needs.js', 'app-header.js', 'app-banner.js', 'app-snapshot.js',
  'view-settings.js', 'view-questions.js', 'view-notes.js', 'view-hub.js', 'view-hub-settings.js', 'view-polling.js', 'view-frame.js', 'router.js'];

function memoryStorage(entries = []) {
  const storage = new Map(entries);
  return { storage, localStorage: { get length() { return storage.size; }, key: (i) => [...storage.keys()][i] ?? null, getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) } };
}

function fakePage(localStorage) {
  const listeners = [];
  const captureOf = (opts) => Boolean(opts === true || opts?.capture);
  class Target {
    addEventListener(type, fn, opts) {
      if (!listeners.some((l) => l.target === this && l.type === type && l.fn === fn && l.capture === captureOf(opts))) listeners.push({ target: this, type, fn, capture: captureOf(opts) });
    }
    removeEventListener(type, fn, opts) {
      const i = listeners.findIndex((l) => l.target === this && l.type === type && l.fn === fn && l.capture === captureOf(opts));
      if (i >= 0) listeners.splice(i, 1);
    }
  }
  class El extends Target {
    constructor() {
      super();
      Object.assign(this, { value: '', hidden: false, innerHTML: '', open: false, disabled: false, dataset: {}, attrs: {}, classes: new Set(), els: new Map(), style: { setProperty() {} } });
      this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c),
        toggle: (c, on = !this.classes.has(c)) => { if (on) this.classes.add(c); else this.classes.delete(c); return on; } };
    }
    querySelector(sel) { if (!this.els.has(sel)) this.els.set(sel, new El()); return this.els.get(sel); }
    querySelectorAll() { return []; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    insertAdjacentHTML() {}
    contains() { return false; }
    closest() { return null; }
    matches() { return false; }
    focus() {}
    blur() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  let ids = 0;
  const intervals = new Map();
  const timeouts = new Map();
  const watches = [];
  const document = Object.assign(new Target(), { hidden: false, activeElement: null, documentElement: new El(), querySelector: () => null });
  const observers = new Set();
  class MutationObserver { observe() { observers.add(this); } disconnect() { observers.delete(this); } }
  const win = Object.assign(new Target(), {
    URL, URLSearchParams, localStorage, document, CSS: { escape: (s) => s }, navigator: { platform: 'MacIntel' },
    location: { href: 'https://mac.ts.net/', hash: '', pathname: '/', search: '' }, history: { replaceState() {} }, innerHeight: 844,
    visualViewport: Object.assign(new Target(), { height: 844, offsetTop: 0 }),
    matchMedia: () => Object.assign(new Target(), { matches: false }), MutationObserver,
    fetch: () => new Promise(() => {}),
    setInterval: (fn, ms) => { intervals.set(++ids, { fn, ms }); return ids; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++ids, { fn, ms }); return ids; },
    clearTimeout: (id) => timeouts.delete(id),
    BoardDialogs: { confirm: async () => false, notice: async () => {} },
    BoardAttach: { files: () => [], busy: () => false, clear() {}, paint() {} },
    ClaudeSite: {
      site: (root) => ({
        root, url: (p) => `${root}/${p}`, send: async () => ({}), events: async () => [], syncBadge() {},
        watch: () => { const w = { stopped: false, stop() { w.stopped = true; } }; watches.push(w); return w; },
      }),
    },
  });
  win.window = win;
  vm.createContext(win);
  for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
  const fire = (target, type, ev = {}) => {
    const e = { target, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopImmediatePropagation() {}, ...ev };
    for (const l of listeners.filter((x) => x.target === target && x.type === type).sort((a, b) => b.capture - a.capture)) l.fn(e);
    return e;
  };
  const left = () => ({ listeners: listeners.length, intervals: intervals.size, timeouts: timeouts.size, watches: watches.filter((w) => !w.stopped).length, observers: observers.size });
  return { win, El, Target, fire, left };
}

test("a board view mounted then unmounted leaves no listener, interval, timer or watch behind, and lets go of the shell's change signal", () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  const subscribed = new Set();
  const signal = (fn) => { subscribed.add(fn); return () => subscribed.delete(fn); };
  const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a', { signal });
  const loaded = page.left();
  view.mount();
  const mounted = page.left();
  assert.ok(mounted.listeners > loaded.listeners && mounted.intervals > 0, JSON.stringify(mounted));
  assert.deepEqual([mounted.watches, subscribed.size], [1, 1]);

  page.fire(root.querySelector('#compose'), 'click');
  page.fire(root.querySelector('#sheetClose'), 'click');
  view.unmount();
  assert.deepEqual([page.left(), subscribed.size], [loaded, 0]);
});

test("the board's Settings, Waiting on you and Notes views, mounted then unmounted, leave no listener, interval, timer or watch behind, and stop retrying a load", async () => {
  const page = fakePage(memoryStorage().localStorage);
  let fetches = 0;
  page.win.fetch = () => { fetches++; return Promise.reject(new Error('offline')); };
  const loaded = page.left();
  const views = page.win.AppViews;
  assert.deepEqual(Object.keys(views).sort(), ['frame', 'hub', 'hub-settings', 'notes', 'polling', 'questions', 'settings']);
  for (const [kind, view] of [['settings', {}], ['questions', { id: 'q1' }], ['notes', { item: 'w/A1' }]]) {
    assert.equal(typeof views[kind].markup({ kind, route: 'board-a', ...view }), 'string', kind);
    const v = views[kind].create(new page.El(), 'https://mac.ts.net/board-a', { view: { kind, route: 'board-a', ...view }, reload() {} });
    v.mount();
    await new Promise((r) => setImmediate(r));
    const mounted = page.left();
    assert.ok(mounted.timeouts > loaded.timeouts, `${kind} ${JSON.stringify(mounted)}`);
    v.unmount();
    assert.deepEqual(page.left(), loaded, kind);
    const sent = fetches;
    v.mount();
    v.unmount();
    await new Promise((r) => setImmediate(r));
    assert.ok(fetches > sent, kind);
    assert.deepEqual(page.left(), loaded, kind);
  }
});

test("the hub page, Hub Settings and Polling, mounted then unmounted, load their data from the hub's API, refresh it on an interval and leave no listener or interval behind", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const urls = [];
  page.win.fetch = (url) => { urls.push(url); return Promise.reject(new Error('offline')); };
  const loaded = page.left();
  for (const [kind, view] of [['hub', {}], ['hub-settings', { hash: '#rules' }], ['polling', { w: '09:00' }]]) {
    const views = page.win.AppViews;
    assert.match(views[kind].markup({ kind, ...view }), /<main class="has-top">/, kind);
    const v = views[kind].create(new page.El(), 'https://mac.ts.net/_hub', { view: { kind, ...view }, reload() {}, sidebarChanged() {} });
    v.mount();
    await new Promise((r) => setImmediate(r));
    const mounted = page.left();
    assert.ok(mounted.listeners > loaded.listeners && mounted.intervals > loaded.intervals, `${kind} ${JSON.stringify(mounted)}`);
    v.unmount();
    assert.deepEqual(page.left(), loaded, kind);
    v.mount();
    v.unmount();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(page.left(), loaded, kind);
  }
  assert.deepEqual([...new Set(urls)], ['/_hub/api/hub', '/_hub/api/settings', '/_hub/api/polling?w=09%3A00']);
});

test("a framed page hands each load's URL and title to the shell, hides the shell's header when it draws its own, whose logo toggles the sidebar, sends taps on links to other views and its back arrow to the shell, keeps its own navigations, and leaves nothing behind", () => {
  const page = fakePage(memoryStorage().localStorage);
  const loads = [];
  const opened = [];
  const view = { kind: 'frame', route: 'learn', url: '/learn/' };
  const markup = page.win.AppViews.frame.markup(view, { siteTitle: 'Course' });
  assert.match(markup, /<h1>Course<\/h1>.*<a class="alone" href="\/learn\/\?alone=1" target="_blank"/s);
  assert.match(markup, /<iframe class="frame-page" src="\/learn\/"/);
  const root = new page.El();
  let toggles = 0;
  const ups = [];
  const v = page.win.AppViews.frame.create(root, 'https://mac.ts.net/learn', { view, siteTitle: 'Course', boards: () => new Set(['board-a']),
    open: (href) => opened.push(href), toggleSidebar: () => toggles++, loaded: (url, title) => loads.push([url, title]),
    up: () => ups.push(loads.at(-1)[0]) > 0 && loads.at(-1)[0].includes('/prototype-') });
  const loaded = page.left();
  v.mount();

  const frame = root.querySelector('iframe.frame-page');
  const land = (url, { title = '', header = false } = {}) => {
    const u = new URL(url);
    const doc = Object.assign(new page.Target(), { title, head: new page.El(), documentElement: new page.El(), getElementById: () => null,
      querySelector: (sel) => (header && sel === 'body > header.top' ? {} : null) });
    frame.contentWindow = Object.assign(new page.Target(), { document: doc, location: { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash } });
    doc.defaultView = frame.contentWindow;
    page.fire(frame, 'load');
    return doc;
  };
  const tap = (doc, href, { cls = '', target = '' } = {}) => {
    let prevented = false;
    let stopped = false;
    const a = { href, target, hasAttribute: () => false, classList: { contains: (c) => c === cls }, closest: (sel) => (cls === 'back' && sel === 'header.top' ? {} : null) };
    const logo = cls === 'hub';
    const closest = (sel) => (sel === 'body > header.top a.hub' ? (logo ? a : null) : sel === 'header.top a.back' ? (cls === 'back' ? a : null) : a);
    const ev = { button: 0, target: { closest }, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
    page.fire(doc.defaultView, 'click', ev);
    if (!stopped) page.fire(doc, 'click', ev);
    return prevented;
  };

  const lesson = land('https://mac.ts.net/learn/lesson-1.html', { title: 'Lesson 1' });
  assert.deepEqual(loads.at(-1), ['/learn/lesson-1.html', 'Lesson 1']);
  assert.equal(root.querySelector(':scope > .top h1').textContent, 'Lesson 1');
  assert.equal(root.querySelector(':scope > .top a.alone').href, '/learn/lesson-1.html?alone=1');
  assert.equal(root.classList.contains('own-header'), false);
  assert.equal(tap(lesson, 'https://mac.ts.net/learn/lesson-2.html'), false);
  assert.equal(tap(lesson, 'https://mac.ts.net/learn/lesson-1.html#part-2'), false);
  assert.equal(tap(lesson, 'https://mac.ts.net/learn/notes.pdf'), false);
  assert.equal(tap(lesson, 'https://mac.ts.net/board-a/#item=w%2FA1'), true);
  assert.equal(tap(lesson, 'https://mac.ts.net/_hub/settings'), true);
  assert.equal(tap(lesson, 'https://mac.ts.net/learn/lesson-2.html', { target: '_top' }), true);
  assert.deepEqual(opened, ['https://mac.ts.net/board-a/#item=w%2FA1', 'https://mac.ts.net/_hub/settings', 'https://mac.ts.net/learn/lesson-2.html']);

  const proto = land('https://mac.ts.net/board-a/prototype-x.html?q=q1', { title: 'Prototype', header: true });
  assert.deepEqual([loads.at(-1), root.classList.contains('own-header')], [['/board-a/prototype-x.html?q=q1', 'Prototype'], true]);
  assert.equal(tap(proto, 'https://mac.ts.net/board-a/#item=w%2FA1', { cls: 'back' }), true);
  assert.deepEqual([ups, opened.length], [['/board-a/prototype-x.html?q=q1'], 3]);
  const own = land('https://mac.ts.net/learn/', { title: 'Course', header: true });
  assert.deepEqual([tap(own, 'https://mac.ts.net/_hub/', { cls: 'hub' }), toggles, opened.length], [true, 1, 3]);
  assert.equal(tap(own, 'https://mac.ts.net/_hub/', { cls: 'back' }), true);
  assert.deepEqual([ups.length, opened.at(-1)], [2, 'https://mac.ts.net/_hub/']);

  v.unmount();
  assert.deepEqual(page.left(), loaded);
});

test("a board the app shell leaves keeps its fresh board as its last visit, dropping the least recent boards' past the storage budget, and paints live when the shell says nothing changed since, and dimmed otherwise", () => {
  const { storage, localStorage } = memoryStorage([['boardSnapshot:https://mac.ts.net/old/', 'x'.repeat(2_000_000)],
    ['boardSnapshot:https://mac.ts.net/recent/', 'y'.repeat(1_000_000)], ['boardSnapshots', JSON.stringify(['boardSnapshot:https://mac.ts.net/recent/', 'boardSnapshot:https://mac.ts.net/old/'])]]);
  const page = fakePage(localStorage);
  const site = 'https://mac.ts.net/board-a';
  const left = page.win.BoardView.create(new page.El(), site);
  left.mount();
  const board = { title: 'A', generatedAt: '2026-10-29T10:00:00.000Z', items: [], waves: [], needs: [], answers: [] };
  Object.assign(left.B.state, { board });
  left.B.setView('fresh');
  left.unmount();
  assert.equal(JSON.parse(storage.get(`boardSnapshot:${site}/`)).board.generatedAt, board.generatedAt);
  assert.deepEqual([...storage.keys()].filter((k) => k.startsWith('boardSnapshot:')).sort(), [`boardSnapshot:${site}/`, 'boardSnapshot:https://mac.ts.net/recent/']);

  const back = (live) => {
    const root = new page.El();
    const view = page.win.BoardView.create(root, site, { live });
    view.mount();
    view.unmount();
    return root.dataset.board;
  };
  assert.equal(back({ fresh: { at: board.generatedAt, sig: 's' }, generatedAt: board.generatedAt }), 'fresh');
  assert.equal(back({ fresh: { at: board.generatedAt, sig: 's' }, generatedAt: '2026-10-29T09:00:00.000Z' }), 'snapshot');
  assert.equal(back(null), 'snapshot');
});

test("two boards' stores never share a key: a New task draft stays on its board, the old shared keys move to the first board opened, and a card's draft keeps its key", () => {
  const { storage, localStorage } = memoryStorage([['draft:ask', JSON.stringify('old draft')], ['openItems', JSON.stringify(['w/A1'])], ['draft:w/A1', JSON.stringify('a reply')]]);
  const page = fakePage(localStorage);
  const open = (route) => {
    const root = new page.El();
    const view = page.win.BoardView.create(root, `https://mac.ts.net/${route}`);
    view.mount();
    return { root, view, ask: root.querySelector('#askText'), store: view.B.store };
  };
  const a = open('board-a');
  const b = open('board-b');
  assert.deepEqual([a.ask.value, JSON.parse(JSON.stringify(a.store.get('openItems')))], ['old draft', ['w/A1']]);
  assert.deepEqual([b.ask.value, b.store.get('openItems', null)], ['', null]);

  page.fire(b.ask, 'input', { target: { value: 'for B' } });
  for (const { root } of [a, b]) page.fire(root, 'toggle', { target: { matches: (s) => s === 'details.item', dataset: { key: 'w/A2' }, open: false } });
  for (const { view } of [a, b]) view.unmount();
  assert.deepEqual([open('board-a').ask.value, open('board-b').ask.value], ['old draft', 'for B']);

  const keys = [...storage.keys()].filter((k) => k !== 'draft:w/A1');
  const of = (route) => keys.filter((k) => k.startsWith(`site:${route}:`));
  assert.deepEqual(keys.filter((k) => !of('board-a').includes(k) && !of('board-b').includes(k)), []);
  assert.deepEqual([of('board-a').length > 0, of('board-b').length > 0], [true, true]);
  assert.deepEqual([a.store.get('draft:w/A1'), b.store.get('draft:w/A1')], ['a reply', 'a reply']);
});

test("the page header's logo toggles the sidebar at every width: from 1000px it collapses and restores the rail, which this device remembers, and the rail's own logo hides it; narrower, it opens and closes the drawer; it shows no count, and its label says what waits on the other sites", () => {
  const { storage, localStorage } = memoryStorage();
  const handlers = [];
  const classes = (set = new Set()) => ({ set, add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on = !set.has(c)) => { if (on) set.add(c); else set.delete(c); return on; } });
  const el = () => ({ classList: classes(), attrs: {}, kids: [], innerHTML: '', scrollTop: 0, addEventListener() {},
    setAttribute(k, v) { this.attrs[k] = v; }, querySelector(sel) { return this.kids.find((k) => k.className === sel.slice(1)) || null; },
    append(k) { this.kids.push(k); }, closest: () => null });
  const aside = el();
  const scrim = el();
  const logo = el();
  const html = el();
  const wide = { matches: true, addEventListener() {} };
  const win = { localStorage, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, navigator: { userAgent: 'Mac' }, URL,
    matchMedia: (q) => (q === '(min-width: 1000px)' ? wide : { matches: false }),
    fetch: () => new Promise(() => {}),
    document: { documentElement: html, hidden: false, getElementById: (id) => ({ sidebar: aside, sidebarScrim: scrim })[id] || null,
      querySelectorAll: (sel) => (sel === '.top a.hub' ? [logo] : []), createElement: () => Object.assign(el(), { className: '', textContent: '' }),
      addEventListener: (type, fn) => handlers.push({ type, fn }) } };
  win.window = win;
  vm.createContext(win);
  for (const file of ['ui-page-header.js', 'ui-sidebar.js', 'sidebar.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
  const data = { sites: [{ route: 'a', title: 'A', board: true, count: 1 }, { route: 'b', title: 'B', board: true, count: 2 }, { route: 'learn', title: 'Learn', board: false, count: 0 }] };
  win.Sidebar.mount({ here: 'a', data, poll: false });
  const tap = (target) => { for (const h of handlers.filter((x) => x.type === 'click')) h.fn({ target: { closest: (sel) => (sel === target ? (sel === '.top a.hub' ? logo : {}) : null) }, preventDefault() {} }); };
  const state = () => ({ collapsed: html.classList.contains('sb-collapsed'), stored: storage.get('hub:sidebarCollapsed') ?? null, drawer: aside.classList.contains('open') });

  assert.deepEqual(state(), { collapsed: false, stored: null, drawer: false });
  assert.equal(logo.kids.length, 0);
  assert.equal(logo.attrs['aria-label'], 'Boards, 2 waiting on other boards');
  tap('[data-sidebar-close]');
  assert.deepEqual(state(), { collapsed: true, stored: '1', drawer: false });
  tap('.top a.hub');
  assert.deepEqual(state(), { collapsed: false, stored: '0', drawer: false });
  tap('.top a.hub');
  wide.matches = false;
  tap('.top a.hub');
  assert.deepEqual(state(), { collapsed: true, stored: '1', drawer: true });
  tap('.top a.hub');
  assert.deepEqual(state(), { collapsed: true, stored: '1', drawer: false });
  tap('.top a.hub');
  tap('[data-sidebar-close]');
  assert.deepEqual(state(), { collapsed: true, stored: '1', drawer: false });

  html.classList.set.clear();
  win.Sidebar.mount({ here: 'a', data, poll: false });
  assert.equal(html.classList.contains('sb-collapsed'), true);
});

test("s s shows each sidebar row's key and the next key opens that row through the shell; Escape, a click, a held modifier or 3 s with no key end it with nothing opened; s s does nothing in a text field or with a dialog open; on a drawer it opens the drawer and closes it again; and its keys never count toward the board's n n", () => {
  const page = fakePage(memoryStorage().localStorage);
  const { win } = page;
  win.Element = page.El;
  const aside = new page.El();
  const scrim = new page.El();
  let dialog = null;
  Object.assign(win.document, { getElementById: (id) => ({ sidebar: aside, sidebarScrim: scrim })[id] || null, querySelectorAll: () => [],
    querySelector: (sel) => (sel === 'dialog[open]' ? dialog : null) });
  const wide = Object.assign(new page.Target(), { matches: true });
  win.matchMedia = (q) => (q === '(min-width: 1000px)' ? wide : Object.assign(new page.Target(), { matches: false }));
  let idle = null;
  const setTimeout = win.setTimeout;
  win.setTimeout = (fn, ms) => { if (ms === 3000) idle = fn; return setTimeout(fn, ms); };
  const icon = '<span class="icon" aria-hidden="true"><svg></svg></span>';
  const data = { sites: [{ route: 'hub-orchestrator', title: 'Hub Orchestrator', board: true, created: '2026-10-29T00:00:00Z', icon },
    { route: 'ios', title: 'iOS', board: true, created: '2026-10-22T00:00:00Z', icon }] };
  const board = win.BoardView.create(new page.El(), 'https://mac.ts.net/hub-orchestrator');
  board.mount();
  const opened = [];
  win.Sidebar.mount({ here: 'hub-orchestrator', data, open: (href) => opened.push(href) });

  const body = new page.El();
  const field = Object.assign(new page.El(), { closest: (sel) => (sel.includes('textarea') ? field : null) });
  let at = 0;
  const press = (key, ev = {}) => page.fire(win.document, 'keydown', { key, target: body, timeStamp: at += 100, ...ev });
  const switching = () => aside.classList.contains('ks-on');
  const sw = () => { press('s'); return press('s'); };

  assert.equal(sw().defaultPrevented, true);
  assert.equal(switching(), true);
  assert.match(aside.innerHTML, /href="\/ios\/"><span class="icon" aria-hidden="true"><svg><\/svg><span class="ks-key">2<\/span><\/span><span class="sb-text"><span class="sb-title"><span class="ks-u">i<\/span>OS</);
  assert.equal(press('2').defaultPrevented, true);
  assert.deepEqual([opened, switching()], [['/ios/'], false]);
  sw();
  press('H');
  assert.deepEqual(opened, ['/ios/', '/hub-orchestrator/']);

  sw();
  assert.equal(press('Escape').defaultPrevented, true);
  sw();
  page.fire(win.document, 'pointerdown', { target: body });
  assert.equal(switching(), false);
  sw();
  idle();
  assert.equal(switching(), false);
  sw();
  assert.equal(press('1', { metaKey: true }).defaultPrevented, false);
  sw();
  press('x');
  assert.deepEqual([switching(), opened.length], [false, 2]);

  press('s', { target: field });
  press('s', { target: field });
  assert.equal(switching(), false);
  dialog = {};
  sw();
  assert.equal(switching(), false);
  dialog = null;

  wide.matches = false;
  sw();
  assert.deepEqual([switching(), aside.classList.contains('open')], [true, true]);
  press('Escape');
  assert.deepEqual([switching(), aside.classList.contains('open')], [false, false]);

  const sheet = board.B.root.querySelector('#sheet');
  sw();
  press('n');
  press('n');
  assert.deepEqual([opened.at(-1), sheet.open], ['/_hub/settings', false]);
  press('n');
  assert.equal(sheet.open, true);
  board.unmount();
});

function boardOnDom({ open = [], board, threads, confirm = false }) {
  const page = fakePage(memoryStorage([['site:board-a:openItems', JSON.stringify(open)]]).localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const server = { board, threads };
  const sent = [];
  const confirms = [];
  page.win.BoardDialogs.confirm = async (text) => { confirms.push(text); return confirm; };
  const site = page.win.ClaudeSite.site;
  page.win.ClaudeSite.site = (r) => ({ ...site(r), send: async (kind, data) => { sent.push([kind, data]); return {}; } });
  const posts = [];
  page.win.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'https://mac.ts.net/');
    if (opts.method === 'POST') { posts.push([u.pathname, JSON.parse(opts.body)]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    const body = u.pathname.endsWith('/api/board') ? server.board : server.threads[u.searchParams.get('key')] || [];
    return { ok: true, json: async () => structuredClone(body) };
  };
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = page.win.BoardView.markup({ title: 'A' });
  let signalled = null;
  page.win.BoardView.create(root, 'https://mac.ts.net/board-a', { signal: (fn) => { signalled = fn; return () => {}; } }).mount();
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const change = async (next) => { Object.assign(server, next); signalled(); await settle(); };
  return { page, root, settle, change, sent, confirms, posts, doc: page.win.document };
}
const askCard = (id, lane) => ({ key: `ask:${id}`, id, kind: 'ask', lane, title: `Task ${id}`, deps: [], othersAt: [] });
const boardOf = (items) => ({ title: 'A', generatedAt: '2026-10-30T10:00:00.000Z', items, waves: [], needs: [], answers: [] });
const workCard = (id, extra) => ({ key: `w/${id}`, id, kind: 'work', lane: 'todo', title: `Work ${id}`, ref: id, internal: true, waveTitle: 'W', deps: [], manualSteps: [], othersAt: [], ...extra });

test("an open card shows the one action button the board names, its workflow buttons in one row and the links that leave the board in the next with Install last, and colours orange the button that clears Action needed: Open questions links to its first question, Grill asks for questions or reads Writing questions…, and an ask's Mark as done confirms and sends ask-done", async () => {
  const draft = { state: 'OPEN', isDraft: true, number: 7, url: 'https://github.com/o/r/pull/7', checks: { state: 'pass' } };
  const ready = { ...draft, isDraft: false };
  const install = { url: 'itms-services://?action=download-manifest&url=https://m/x/manifest.plist', label: null, older: false };
  const asking = { actionButton: 'openQuestions', questions: { first: 'q7', open: 1, state: 'open' } };
  const cards = [
    workCard('A1', { ...asking, action: { kind: 'questions', url: 'questions.html#q7', label: 'Answer 1 question' }, resolvedBy: 'openQuestions' }),
    workCard('A2', { actionButton: 'grill' }),
    workCard('A3', { actionButton: 'grill', grilling: true }),
    workCard('A4', { actionButton: null, lane: 'done' }),
    workCard('A5', { ...asking, held: true, holdable: true, action: null, resolvedBy: null }),
    workCard('P1', { ...asking, action: { kind: 'pick', url: 'questions.html#q7', label: 'Prototypes ready: pick a take' }, resolvedBy: 'openQuestions' }),
    workCard('D1', { lane: 'review', actionButton: 'grill', pr: draft, hasNotes: true, install, action: { kind: 'ready', url: draft.url, label: 'Tap Ready on GitHub' }, resolvedBy: 'github' }),
    workCard('R1', { lane: 'review', actionButton: 'grill', pr: ready, install }),
    workCard('S1', { lane: 'review', actionButton: 'grill', pr: ready, manualSteps: ['Run the backfill'], action: { kind: 'steps', url: '#item=w%2FS1', label: 'Run the manual steps, then merge' }, resolvedBy: 'github' }),
    workCard('M1', { lane: 'review', actionButton: 'grill', pr: ready, action: { kind: 'merge', url: '#item=w%2FM1', label: 'Merge' }, resolvedBy: 'merge' }),
    { ...askCard('a1', 'review'), ref: 'Task', actionButton: 'markDone', finishable: true, action: { kind: 'done', url: '#item=ask%3Aa1', label: 'Pick a take' }, resolvedBy: 'markDone' },
    { ...askCard('a2', 'done'), ref: 'Task', actionButton: null },
  ];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: {}, confirm: true });
  await b.settle();
  const row = (key) => b.root.querySelector(`details.item[data-key="${key}"] .detail`)?.querySelector('.actions');
  const labels = (els) => els.map((el) => el.textContent.trim());
  const shown = (key) => ['workflow', 'external', 'resolves'].map((part) => labels(row(key)?.querySelectorAll(part === 'resolves' ? '.resolves' : `.action-row.${part} a, .action-row.${part} button`) || []));
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.key, shown(c.key)])), {
    'w/A1': [['Open questions'], [], ['Open questions']],
    'w/A2': [['Grill'], [], []],
    'w/A3': [['Writing questions…'], [], []],
    'w/A4': [[], [], []],
    'w/A5': [['Resume', 'Open questions'], [], []],
    'w/P1': [['Open questions'], [], ['Open questions']],
    'w/D1': [['Grill'], ['Review draft on GitHub →', 'Notes →', 'Install →'], ['Review draft on GitHub →']],
    'w/R1': [['Grill'], ['Review on GitHub →', 'Install →'], []],
    'w/S1': [['Grill'], ['Review on GitHub →'], ['Review on GitHub →']],
    'w/M1': [['Merge', 'Grill'], ['Review on GitHub →'], ['Merge']],
    'ask:a1': [['Mark as done'], [], ['Mark as done']],
    'ask:a2': [[], [], []],
  });
  assert.equal(row('w/A1').querySelector('a.button').getAttribute('href'), 'questions.html#q7');
  assert.deepEqual(row('w/D1').querySelectorAll('.action-row.external a').map((a) => a.getAttribute('href')), [draft.url, 'notes.html?item=w%2FD1', install.url]);

  b.page.fire(b.root, 'click', { target: row('w/A2').querySelector('button') });
  b.page.fire(b.root, 'click', { target: row('ask:a1').querySelector('button') });
  await b.settle();
  assert.deepEqual(b.confirms, ['Ask Claude for questions about A2?', 'Mark this task done? "Task a1" moves to Done.']);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['grill-more', { key: 'w/A2' }], ['ask-done', { id: 'a1' }]]);
});

test("every owner action kind the board derives makes exactly one of the open card's buttons orange, every action button the board names draws, and the board and the page share one frozen enum of buttons and one of action kinds, each value its name", async () => {
  const question = (id, url = null) => ({ id: `q${id}`, topic: `item:w/${id}`, question: 'Which?', options: [{ id: 'A', label: 'One' }], url });
  const draft = { state: 'OPEN', isDraft: true, checks: { state: 'pass' }, reviews: {} };
  const approved = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', checks: { state: 'pass' }, reviews: {} };
  const built = buildBoard({
    fromWaves: false, now: Date.parse('2026-10-30T10:00:00Z'),
    prs: { 'o/r#1': draft, 'o/r#2': approved, 'o/r#3': approved },
    owner: { items: [question('P', 'prototype-x.html?q=qP'), question('Q')] },
    waves: [{ slug: 'w', wave: { repo: 'o/r', items: [
      { id: 'P', title: 'Pick' }, { id: 'Q', title: 'Questions' }, { id: 'R', title: 'Ready', pr: 1 },
      { id: 'S', title: 'Steps', pr: 2, manual_steps: ['Run the backfill'] }, { id: 'M', title: 'Merge', pr: 3 }, { id: 'G', title: 'Grill' },
    ] } }],
    events: [{ id: 'a1', ts: '2026-10-30T09:00:00Z', kind: 'ask', data: { text: 'Which take?' }, reply: { html: 'Two takes.', at: '2026-10-30T09:10:00Z' } }],
    askProgress: { a1: { state: 'progress', at: '2026-10-30T09:20:00Z', next: 'Pick a take' } },
  });
  assert.deepEqual(built.items.filter((i) => i.action).map((i) => i.action.kind).sort(), Object.values(ACTION_KIND).sort());
  for (const i of built.items) {
    assert.ok(i.actionButton === null || Object.values(BUTTON).includes(i.actionButton), i.key);
    assert.ok(Object.values(BUTTON).includes(i.resolvedBy) === Boolean(i.action), i.key);
  }

  const mounted = async (items) => {
    const b = boardOnDom({ open: items.map((i) => i.key), board: { ...built, items, title: 'A', generatedAt: '2026-10-30T10:00:00.000Z' }, threads: {} });
    await b.settle();
    const row = (key) => b.root.querySelector(`details.item[data-key="${key}"] .detail`)?.querySelector('.actions');
    const counts = Object.fromEntries(items.map((i) => [i.key, [row(i.key)?.querySelectorAll('.action-row.workflow a, .action-row.workflow button').length ?? 0, row(i.key)?.querySelectorAll('.resolves').length ?? 0]]));
    return { counts, ui: b.page.win.BoardUI };
  };
  const shown = await mounted(built.items);
  const without = await mounted(built.items.map((i) => ({ ...i, actionButton: null })));
  for (const i of built.items) {
    const [controls, orange] = shown.counts[i.key];
    assert.deepEqual([controls - without.counts[i.key][0], orange], [i.actionButton ? 1 : 0, i.action ? 1 : 0], `${i.key}: ${i.actionButton}, ${i.action?.kind}`);
  }

  for (const [name, values] of Object.entries({ BUTTON, ACTION_KIND })) {
    assert.deepEqual({ ...shown.ui[name] }, { ...values }, name);
    for (const e of [values, shown.ui[name]]) {
      assert.ok(Object.isFrozen(e), name);
      assert.deepEqual(Object.entries(e).filter(([k, v]) => k !== v), [], name);
    }
  }
  assert.throws(() => { BUTTON.grill = 'markDone'; }, TypeError);
});

test("Needs you shows each pending prompt with its details and answers it from the line: Allow once and Deny on the tap, Always allow after a confirmation naming its rule, one question's option on the tap, and several questions with Send once each has a pick", async () => {
  const at = new Date().toISOString();
  const perm = (id, command) => ({ id, title: 'A', cwd: '~/repo', tool: 'Bash', action: `run ${command}`, detail: command, rule: `Bash(${command})`, questions: null, at });
  const ask = (id, questions) => ({ id, title: 'A', cwd: '~/repo', tool: 'AskUserQuestion', action: null, detail: '', rule: null, at,
    questions: questions.map(([question, labels]) => ({ question, header: '', multiSelect: false, options: labels.map((label) => ({ label, description: `${label} it` })) })) });
  const prompts = [perm('p1', 'npm test'), perm('p2', 'rm -rf build'), perm('p3', 'git push'), ask('p4', [['Colour?', ['Red', 'Blue']], ['Size?', ['S', 'L']]]), ask('p5', [['Go?', ['Yes', 'No']]])];
  const board = { ...boardOf([]), needs: prompts.map((p) => ({ kind: 'Prompt', title: 'x', text: 'x', url: '', prompt: p })) };
  const b = boardOnDom({ board, threads: {}, confirm: true });
  await b.settle();
  const line = (id) => b.root.querySelector(`#waiting li.prompt[data-prompt="${id}"]`);
  const buttons = (id) => line(id).querySelectorAll('button').map((x) => [(x.querySelector('.lbl') || x).textContent.trim(), x.disabled]);
  const tap = async (id, sel) => { b.page.fire(b.root, 'click', { target: line(id).querySelector(sel) }); await b.settle(); };

  assert.equal(b.root.querySelector('#waiting h2').textContent, 'Needs you · 5');
  assert.match(line('p1').textContent, /Bash.*~\/repo.*npm test.*Always allow adds Bash\(npm test\) until the session ends\./s);
  assert.deepEqual(buttons('p1'), [['Allow once', false], ['Always allow', false], ['Deny', false]]);
  assert.deepEqual(buttons('p5'), [['Yes', false], ['No', false], ['Skip', false]]);

  await tap('p1', '[data-prompt-choice="allow"]');
  await tap('p2', '[data-prompt-choice="deny"]');
  await tap('p3', '[data-prompt-choice="always"]');
  assert.deepEqual(b.confirms, ['Always allow Bash(git push) for the rest of this session?']);
  await tap('p5', '[data-prompt-opt="No"]');
  assert.equal(line('p4').querySelector('[data-prompt-send]').disabled, true);
  await tap('p4', '[data-prompt-opt="Blue"]');
  assert.equal(line('p4').querySelector('[data-prompt-opt="Blue"]').getAttribute('aria-pressed'), 'true');
  assert.equal(line('p4').querySelector('[data-prompt-send]').disabled, true);
  await tap('p4', '[data-prompt-opt="S"]');
  await tap('p4', '[data-prompt-send]');
  assert.deepEqual(JSON.parse(JSON.stringify(b.posts)), [
    ['/_hub/prompts/p1/answer', { choice: 'allow' }], ['/_hub/prompts/p2/answer', { choice: 'deny' }], ['/_hub/prompts/p3/answer', { choice: 'always' }],
    ['/_hub/prompts/p5/answer', { choice: 'allow', answers: { 'Go?': 'No' } }], ['/_hub/prompts/p4/answer', { choice: 'allow', answers: { 'Colour?': 'Blue', 'Size?': 'S' } }],
  ]);
  assert.equal(b.root.querySelector('#waiting').hidden, true);
});

test("a thread repaint while a message's edit box is open shows the new message and keeps the edit box's text, cursor and focus", async () => {
  const mine = { ts: '2026-10-30T10:00:00.000Z', who: 'love', text: 'Fix the header', eventId: 'e1', canEdit: true, canDelete: true, state: 'waiting' };
  const b = boardOnDom({ open: ['ask:a1'], board: boardOf([askCard('a1', 'progress')]), threads: { 'ask:a1': [mine] } });
  await b.settle();
  b.page.fire(b.root, 'click', { target: b.root.querySelector('.msg[data-event="e1"] button[data-edit]') });
  await b.settle();
  const ta = b.root.querySelector('.msg[data-event="e1"] .edit-form textarea');
  assert.equal(ta.value, 'Fix the header');
  ta.value = 'Fix the header and the footer';
  ta.setSelectionRange(7, 7);
  b.page.fire(b.root, 'input', { target: ta });

  await b.change({ threads: { 'ask:a1': [mine, { ts: '2026-10-30T10:01:00.000Z', who: 'claude', text: 'Looking at it now' }] } });
  assert.match(b.root.querySelector('[data-thread="ask:a1"] .msgs').textContent, /Looking at it now/);
  assert.equal(b.root.querySelector('.msg[data-event="e1"] .edit-form textarea'), ta);
  assert.deepEqual([ta.value, ta.selectionStart, ta.selectionEnd, b.doc.activeElement === ta], ['Fix the header and the footer', 7, 7, true]);
});

test("a lane repaint while the owner types in a card's reply box moves the other cards and keeps the reply's text, cursor and focus, also when its own card moves lanes, and leaves the + sheet's text alone", async () => {
  const b = boardOnDom({ open: ['ask:a1'], board: boardOf([askCard('a1', 'progress'), askCard('b1', 'todo')]),
    threads: { 'ask:a1': [{ ts: '2026-10-30T10:00:00.000Z', who: 'claude', text: 'Started' }] } });
  await b.settle();
  const ta = b.root.querySelector('form[data-reply="ask:a1"] textarea');
  ta.focus();
  ta.value = 'Half a reply';
  ta.setSelectionRange(4, 4);
  b.page.fire(b.root, 'input', { target: ta });
  b.root.querySelector('#askText').value = 'A new task';
  const lane = (id) => b.root.querySelector(`details.item[data-key="ask:${id}"]`)?.closest('details.lane').dataset.lane;
  const kept = () => [b.root.querySelector('form[data-reply="ask:a1"] textarea') === ta, ta.value, ta.selectionStart, b.doc.activeElement === ta];

  await b.change({ board: boardOf([askCard('b1', 'progress'), askCard('a1', 'progress')]) });
  assert.deepEqual([lane('b1'), lane('a1')], ['progress', 'progress']);
  assert.deepEqual(kept(), [true, 'Half a reply', 4, true]);

  await b.change({ board: boardOf([askCard('a1', 'review'), askCard('b1', 'done')]) });
  assert.deepEqual([lane('a1'), lane('b1')], ['review', 'done']);
  assert.deepEqual(kept(), [true, 'Half a reply', 4, true]);
  assert.equal(b.root.querySelector('#askText').value, 'A new task');
});
