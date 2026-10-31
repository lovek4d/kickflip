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
    URL, URLSearchParams, AbortController, localStorage, document, CSS: { escape: (s) => s }, navigator: { platform: 'MacIntel' },
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

test('Board Settings loads the install script, keeps refused edits unsaved, and saves or clears the path', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  root.querySelector('#installScript').disabled = true;
  root.querySelector('#installSave').disabled = true;
  let saved = '/owner/install.sh';
  let refuse = false;
  const posts = [];
  page.win.fetch = async (url, opts = {}) => {
    let body = {};
    if (url.endsWith('/api/install-script')) {
      if (opts.method === 'POST') {
        posts.push([url, JSON.parse(opts.body)]);
        if (refuse) return { ok: false, json: async () => ({ error: 'Install script must be an absolute path.' }) };
        saved = JSON.parse(opts.body).install_script;
      }
      body = { install_script: saved };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const view = page.win.AppViews.settings.create(root, 'https://mac.ts.net/orch', { reload() {} });
  view.mount();
  await new Promise((resolve) => setImmediate(resolve));
  const input = root.querySelector('#installScript');
  const form = root.querySelector('#installForm');
  const button = root.querySelector('#installSave');
  const status = root.querySelector('#installStatus');
  assert.deepEqual([input.value, input.disabled, button.disabled], ['/owner/install.sh', false, true]);
  input.value = 'relative.sh';
  page.fire(input, 'input');
  assert.equal(form.getAttribute('data-dirty'), '');
  refuse = true;
  page.fire(form, 'submit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, 'Install script must be an absolute path.');
  assert.equal(form.getAttribute('data-dirty'), '');
  assert.equal(button.disabled, false);
  refuse = false;
  for (const value of ['/owner/new install.sh', '']) {
    input.value = value;
    page.fire(input, 'input');
    page.fire(form, 'submit');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([saved, input.disabled, button.disabled, form.getAttribute('data-dirty')], [value, false, true, null]);
    assert.deepEqual(posts.at(-1), ['https://mac.ts.net/orch/api/install-script', { install_script: value }]);
  }
  assert.equal(status.textContent, 'Install builds are off.');
  view.unmount();
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

test("the shell selects Settings on direct loads, sidebar taps, the Hub header's gear, Polling and browser back and forward", async () => {
  for (const path of ['/_hub/', '/_hub/settings', '/_hub/settings/polling?w=09%3A00']) {
    const page = fakePage(memoryStorage().localStorage);
    const { win } = page;
    const doc = win.document;
    const { Element } = miniDom(page.Target, doc);
    Object.defineProperty(Element.prototype, 'href', { get() { return new URL(this.getAttribute('href'), win.location.href).href; } });
    doc.body.innerHTML = '<aside id="sidebar" class="sidebar"></aside><div id="sidebarScrim"></div><script id="sidebarData" type="application/json"></script>';
    doc.getElementById = (id) => doc.body.querySelector(`#${id}`);
    doc.querySelector = (sel) => doc.body.querySelector(sel);
    doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
    doc.getElementById('sidebarData').textContent = JSON.stringify({ sites: [] });
    const scrim = doc.getElementById('sidebarScrim');
    scrim.after = (root) => doc.body.insertBefore(root, scrim.nextSibling);
    let entries = [{ href: `https://mac.ts.net${path}`, state: null }];
    let at = 0;
    win.location = new URL(entries[0].href);
    const write = (state, url) => {
      win.location = new URL(url || win.location.href, win.location.href);
      entries[at] = { href: win.location.href, state };
    };
    win.history = {
      get state() { return entries[at].state; },
      replaceState: (state, _, url) => write(state, url),
      pushState(state, _, url) { entries = entries.slice(0, ++at); write(state, url); },
      go(n) { at += n; win.location = new URL(entries[at].href); page.fire(win, 'popstate', { state: entries[at].state }); },
      back() { this.go(-1); },
    };
    win.scrollTo = () => {};
    win.addEventListener = win.addEventListener.bind(win);
    win.HashChangeEvent = class { constructor(type) { this.type = type; } };
    win.dispatchEvent = (e) => page.fire(win, e.type, e);
    win.top = win;
    for (const kind of ['hub', 'hub-settings', 'polling']) {
      win.AppViews[kind].create = () => ({ B: { state: {} }, mount() {}, unmount() {} });
    }
    vm.runInContext(fs.readFileSync(new URL('./public/shell.js', import.meta.url), 'utf8'), win);
    await win.AppShell.start();
    const selected = () => doc.querySelectorAll('.sb-row[aria-current="page"]').map((a) => a.getAttribute('href'));
    const tap = (a) => page.fire(doc, 'click', { target: a, button: 0 });
    assert.deepEqual(selected(), [path === '/_hub/' ? '/_hub/' : '/_hub/settings'], path);
    win.AppShell.open('/_hub/');
    assert.deepEqual(selected(), ['/_hub/']);
    tap(doc.querySelector('#settingsLink'));
    assert.deepEqual(selected(), ['/_hub/settings']);
    win.AppShell.open('/_hub/settings/polling?w=18%3A00');
    assert.deepEqual(selected(), ['/_hub/settings']);
    win.history.back();
    assert.deepEqual(selected(), ['/_hub/settings']);
    win.history.back();
    assert.deepEqual(selected(), ['/_hub/']);
    win.history.go(1);
    assert.deepEqual(selected(), ['/_hub/settings']);
    win.AppShell.open('/_hub/');
    tap(doc.querySelector('.sb-foot a[href="/_hub/settings"]'));
    assert.deepEqual(selected(), ['/_hub/settings']);
  }
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
  assert.equal(opened.length, 2);
  sw();
  press('p');
  assert.equal(opened.length, 2);
  sw();
  press('s');
  assert.equal(opened.at(-1), '/_hub/settings');
  sw();
  press('2');
  press('n');
  assert.deepEqual([opened.at(-1), sheet.open], ['/ios/', false]);
  press('n');
  assert.equal(sheet.open, true);
  board.unmount();
});

function boardOnDom({ open = [], seen = {}, board, threads, confirm = false, realDialogs = false }) {
  const page = fakePage(memoryStorage([['site:board-a:openItems', JSON.stringify(open)], ['site:board-a:seenThreads', JSON.stringify(seen)]]).localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const server = { board, threads };
  const sent = [];
  const confirms = [];
  const confirmLabels = [];
  page.win.BoardDialogs.confirm = async (text, labels) => { confirms.push(text); confirmLabels.push(labels?.ok ? { ok: labels.ok, cancel: labels.cancel } : undefined); return confirm; };
  if (realDialogs) vm.runInContext(fs.readFileSync(new URL('./public/dialogs.js', import.meta.url), 'utf8'), page.win);
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
  const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a', { signal: (fn) => { signalled = fn; return () => {}; } });
  view.mount();
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const change = async (next) => { Object.assign(server, next); signalled(); await settle(); };
  return { page, root, view, settle, change, sent, confirms, confirmLabels, posts, doc: page.win.document };
}
const askCard = (id, lane) => ({ key: `ask:${id}`, id, kind: 'ask', lane, title: `Task ${id}`, deps: [], othersAt: [] });
const boardOf = (items) => ({ title: 'A', generatedAt: '2026-10-30T10:00:00.000Z', items, waves: [], needs: [], answers: [] });
const workCard = (id, extra) => ({ key: `w/${id}`, id, kind: 'work', lane: 'todo', title: `Work ${id}`, ref: id, internal: true, waveTitle: 'W', deps: [], manualSteps: [], othersAt: [], ...extra });

test("an open card shows its workflow buttons below a final details line of Notes, Install and GitHub links, and colours orange the control that clears Action needed: Open questions links to its first question, Grill asks for questions or reads Writing questions…, and an ask's Mark as done confirms and sends ask-done", async () => {
  const draft = { state: 'OPEN', isDraft: true, number: 7, url: 'https://github.com/o/r/pull/7', checks: { state: 'pass' } };
  const ready = { ...draft, isDraft: false };
  const install = { url: 'itms-services://?action=download-manifest&url=https://m/x/manifest.plist', label: null, older: false };
  const asking = { actionButton: 'openQuestions', questions: { first: 'q7', open: 1, state: 'open' } };
  const cards = [
    workCard('A1', { ...asking, action: { kind: 'questions', url: 'questions.html#q7', label: 'Answer 1 question' }, resolvedBy: 'openQuestions' }),
    workCard('A2', { actionButton: 'grill', bumpable: true }),
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
  const row = (key) => b.root.querySelector(`details.item[data-key="${key}"] .detail`);
  const labels = (els) => els.map((el) => el.textContent.trim());
  const shown = (key) => ['.action-row.workflow a, .action-row.workflow button', '.external-links a', '.actions .resolves, .external-links .resolves'].map((selector) => labels(row(key)?.querySelectorAll(selector) || []));
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.key, shown(c.key)])), {
    'w/A1': [['Open questions'], [], ['Open questions']],
    'w/A2': [['Grill'], [], []],
    'w/A3': [['Writing questions…'], [], []],
    'w/A4': [[], [], []],
    'w/A5': [['Resume', 'Open questions'], [], []],
    'w/P1': [['Open questions'], [], ['Open questions']],
    'w/D1': [['Grill'], ['Notes ↗', 'Install ↗', 'Review draft on GitHub ↗'], ['Review draft on GitHub ↗']],
    'w/R1': [['Grill'], ['Install ↗', 'Review on GitHub ↗'], []],
    'w/S1': [['Grill'], ['Review on GitHub ↗'], ['Review on GitHub ↗']],
    'w/M1': [['Merge', 'Grill'], ['Review on GitHub ↗'], ['Merge']],
    'ask:a1': [['Mark as done'], [], ['Mark as done']],
    'ask:a2': [[], [], []],
  });
  assert.equal(row('w/A1').querySelector('a.button').getAttribute('href'), 'questions.html#q7');
  const external = row('w/D1').querySelector('.grid .external-links');
  assert.deepEqual(external.querySelectorAll('a').map((a) => a.getAttribute('href')), ['notes.html?item=w%2FD1', install.url, draft.url]);
  assert.equal(external.textContent, 'Notes ↗ · Install ↗ · Review draft on GitHub ↗');
  assert.equal(external.parentNode.children.at(-1), external);
  assert.equal(b.root.querySelector('.action-row.external'), null);
  assert.equal(row('w/D1').querySelector('.actions .install, .actions a[target="_blank"]'), null);
  assert.equal(row('w/R1').querySelector('.external-links .resolves'), null);

  b.page.fire(b.root, 'click', { target: row('w/A2').querySelector('button') });
  b.page.fire(b.root, 'click', { target: row('ask:a1').querySelector('button') });
  await b.settle();
  assert.deepEqual(b.confirms, ['Ask Claude for questions about A2?', 'Mark this task done? "Task a1" moves to Done.']);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['grill-more', { key: 'w/A2' }], ['ask-done', { id: 'a1' }]]);
});

test('the install chip and details link confirm with labelled actions while rebuilding, then become current when the install lands', async () => {
  const install = { url: 'https://m/app.apk', sha: 'old', older: true };
  const cards = [workCard('R1', { lane: 'progress', install, builder: { kind: 'install' } }),
    workCard('B1', { lane: 'progress', builder: { kind: 'install' } })];
  const b = boardOnDom({ open: ['w/R1', 'w/B1'], board: boardOf(cards), threads: {} });
  await b.settle();
  const row = (id) => b.root.querySelector(`details[data-key="w/${id}"]`);
  assert.equal(row('B1').querySelector('summary .chip.tone-notice').textContent, 'Building…');
  assert.equal(row('B1').querySelector('.grid .external-links .install').textContent, 'Building…');
  assert.equal(row('B1').querySelector('.grid .external-links .install').getAttribute('href'), null);
  const href = b.page.win.location.href;
  for (const sel of ['summary a[data-install-confirm]', '.grid .external-links a[data-install-confirm]']) {
    const link = row('R1').querySelector(sel);
    assert.equal(link.textContent, sel.startsWith('summary') ? 'Rebuilding…' : 'Rebuilding… ↗');
    b.page.fire(b.root, 'click', { target: link });
    await b.settle();
    assert.equal(b.page.win.location.href, href);
  }
  assert.deepEqual(b.confirms, Array(2).fill('Currently rebuilding with latest changes. Install the existing older build now?'));
  assert.deepEqual(b.confirmLabels, Array(2).fill({ ok: 'Install older build', cancel: 'Cancel' }));
  const allowed = boardOnDom({ open: ['w/R1'], board: boardOf(cards), threads: {}, confirm: true });
  await allowed.settle();
  for (const sel of ['summary a[data-install-confirm]', '.grid .external-links a[data-install-confirm]']) {
    const link = allowed.root.querySelector(sel);
    allowed.page.win.location.href = href;
    const event = allowed.page.fire(allowed.root, 'click', { target: link });
    assert.equal(event.defaultPrevented, true);
    await allowed.settle();
    assert.equal(allowed.page.win.location.href, install.url);
  }
  await b.change({ board: boardOf([workCard('R1', { lane: 'review', install: { ...install, sha: 'new', older: false } }), cards[1]]) });
  assert.equal(row('R1').querySelector('summary .chip.tone-ready').textContent, 'Install');
  assert.equal(row('R1').querySelector('.grid .external-links .install').textContent, 'Install ↗');
  assert.equal(row('R1').querySelector('[data-install-confirm]'), null);
});

test('an install confirmation closes on view unmount and cannot navigate after leaving, including an accepted answer still awaiting its continuation', async () => {
  for (const accept of [false, true]) {
    const install = { url: 'https://m/app.apk', older: true };
    const b = boardOnDom({ open: ['w/R1'], board: boardOf([workCard('R1', { lane: 'progress', install, builder: { kind: 'install' } })]), threads: {}, realDialogs: true });
    await b.settle();
    const href = b.page.win.location.href;
    b.page.fire(b.root, 'click', { target: b.root.querySelector('.external-links a[data-install-confirm]') });
    const sheet = b.doc.body.querySelector('dialog.confirm-sheet');
    assert.ok(sheet?.open);
    if (accept) b.page.fire(sheet, 'click', { target: sheet.querySelector('[data-answer="ok"]') });
    b.view.unmount();
    assert.equal(sheet.open, false);
    assert.equal(b.doc.body.querySelector('dialog.confirm-sheet'), null);
    b.root.remove();
    await b.settle();
    assert.equal(b.page.win.location.href, href);
    assert.deepEqual(b.sent, []);
  }
});

test('labelled confirmations use the modal bottom sheet, preserve text, cancel safely and leave native callers working', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const doc = page.win.document;
  const trigger = doc.body.appendChild(new Element('button'));
  trigger.focus();
  const native = [];
  page.win.confirm = (message) => { native.push(message); return true; };
  page.win.alert = (message) => native.push(message);
  vm.runInContext(fs.readFileSync(new URL('./public/dialogs.js', import.meta.url), 'utf8'), page.win);
  const dialogs = page.win.BoardDialogs;
  assert.equal(await dialogs.confirm('Hold INT-143?'), true);
  await dialogs.notice('Saved');
  assert.deepEqual(native, ['Hold INT-143?', 'Saved']);
  const message = 'Currently rebuilding with latest changes. Install the existing older build now?';
  const labels = { ok: 'Install older build', cancel: 'Cancel' };
  const pending = dialogs.confirm(message, labels);
  const sheet = doc.body.querySelector('dialog.confirm-sheet');
  assert.equal(sheet.open, true);
  assert.equal(sheet.getAttribute('role'), 'alertdialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.equal(sheet.querySelector(`#${sheet.getAttribute('aria-labelledby')}`).textContent, message);
  const ok = sheet.querySelector('[data-answer="ok"]');
  const cancel = sheet.querySelector('[data-answer="cancel"]');
  assert.deepEqual([ok.textContent, cancel.textContent], ['Install older build', 'Cancel']);
  assert.equal(doc.activeElement, cancel);
  page.fire(sheet, 'click', { target: ok });
  assert.equal(await pending, true);
  assert.equal(doc.body.querySelector('dialog'), null);
  assert.equal(doc.activeElement, trigger);
  for (const how of ['button', 'outside', 'escape']) {
    const answer = dialogs.confirm(message, labels);
    const el = doc.body.querySelector('dialog');
    if (how === 'escape') assert.equal(page.fire(el, 'cancel').defaultPrevented, true);
    else page.fire(el, 'click', { target: how === 'button' ? el.querySelector('.cancel') : el });
    assert.equal(await answer, false, how);
    assert.equal(doc.body.querySelector('dialog'), null);
  }
  const first = dialogs.confirm('<b>Build</b>', { ok: '<Install>' });
  assert.equal(doc.body.querySelector('p').textContent, '<b>Build</b>');
  assert.equal(doc.body.querySelector('b'), null);
  const second = dialogs.confirm('Another build?', labels);
  assert.equal(await first, false);
  assert.equal(doc.body.querySelectorAll('dialog').length, 1);
  page.fire(doc.body.querySelector('dialog'), 'cancel');
  assert.equal(await second, false);
});

test("every bumpable card, closed or open, carries the bump icon at its top right and no bump in its button rows; the icon confirms, then sends card-bump, and the lane's latest bump shows it disabled", async () => {
  const cards = [
    workCard('T1', { bumpable: true, bumpedAt: '2026-10-30T09:00:00.000Z', actionButton: 'grill' }),
    workCard('T2', { bumpable: true, bumpedAt: '2026-10-30T08:00:00.000Z', actionButton: 'grill' }),
    workCard('T3', { bumpable: true, holdable: true }),
    workCard('P1', { lane: 'progress', bumpable: true, bumpedAt: '2026-10-30T07:00:00.000Z', holdable: true }),
    workCard('H1', { bumpable: false, held: true, holdable: true }),
  ];
  const b = boardOnDom({ open: ['w/T1', 'w/T3', 'w/H1'], board: boardOf(cards), threads: {}, confirm: true });
  await b.settle();
  const card = (key) => b.root.querySelector(`details.item[data-key="${key}"]`);
  const icon = (key) => card(key).querySelector('summary .ask-actions button[data-confirm="bump"]');
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.key, icon(c.key) ? [icon(c.key).getAttribute('aria-label'), icon(c.key).hasAttribute('disabled')] : null])), {
    'w/T1': ['Bump to top', true], 'w/T2': ['Bump to top', false], 'w/T3': ['Bump to top', false], 'w/P1': ['Bump to top', true], 'w/H1': null,
  });
  for (const key of ['w/T1', 'w/T3', 'w/H1']) assert.equal(card(key).querySelector('.detail .actions [data-confirm="bump"]'), null, key);
  assert.deepEqual(['w/T1', 'w/T3'].map((key) => card(key).querySelector('.detail .action-row.workflow').textContent.trim()), ['Grill', 'Hold']);

  b.page.fire(b.root, 'click', { target: icon('w/T2') });
  await b.settle();
  assert.deepEqual(b.confirms, ['Move T2 to the top of its lane?']);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['card-bump', { key: 'w/T2' }]]);
});

test('the Stalled chip on closed and open cards confirms before sending a builder nudge and shows a sent notice', async () => {
  for (const open of [[], ['w/S1']]) {
    const item = workCard('S1', { lane: 'progress', builder: { stalled: true, progress: 'Running tests', at: null } });
    const b = boardOnDom({ open, board: boardOf([item]), threads: {}, realDialogs: true });
    const confirms = [];
    let accept = false;
    b.page.win.confirm = (message) => { confirms.push(message); return accept; };
    await b.settle();
    const chip = () => b.root.querySelector('summary .line2 button[data-confirm="nudge"]');
    b.page.fire(b.root, 'click', { target: chip() });
    await b.settle();
    assert.deepEqual(confirms, ['Nudge Claude to check this builder?']);
    assert.deepEqual(b.sent, []);
    accept = true;
    b.page.fire(b.root, 'click', { target: chip() });
    await b.settle();
    assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['builder-nudge', { key: 'w/S1' }]]);
    assert.equal(b.root.querySelector('#toast').textContent, 'Nudge sent');
    assert.equal(b.root.querySelector('summary .agent').textContent, 'Running tests');
    assert.equal(b.root.querySelector('details.item').open, open.length > 0);
    b.view.unmount();
  }
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
    const row = (key) => b.root.querySelector(`details.item[data-key="${key}"] .detail`);
    const counts = Object.fromEntries(items.map((i) => [i.key, [row(i.key)?.querySelectorAll('.action-row.workflow a, .action-row.workflow button').length ?? 0, row(i.key)?.querySelectorAll('.actions .resolves, .external-links .resolves').length ?? 0]]));
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

test("a card opened with more than 3 unread messages shows them all, and once closed reopens at its newest 3; Show more adds 3 older ones, and a new message adds below without hiding any until the card closes", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const said = (n, text, extra) => ({ ts: at(n), who: 'claude', text, ...extra });
  const msgs = [said(0, 'One'), said(1, 'Plan written', { kind: 'status' }),
    said(2, 'Two?', { who: 'love', kind: 'item-message', eventId: 'e1', state: 'replied', reply: { html: 'Two.', at: at(3) } }),
    said(5, 'Three', { who: 'Sam' }), said(6, 'Four'), said(7, 'Opened #1', { kind: 'status' }), said(8, 'Five'), said(10, 'Six')];
  const b = boardOnDom({ open: ['w/A1'], seen: { 'w/A1': at(2) }, board: boardOf([workCard('A1', { lane: 'progress' })]), threads: { 'w/A1': msgs } });
  await b.settle();
  const card = b.root.querySelector('details.item[data-key="w/A1"]');
  const thread = () => b.root.querySelector('[data-thread="w/A1"] .msgs');
  const seen = () => [thread().querySelector('[data-thread-more]')?.textContent ?? null, thread().querySelectorAll('.msg .body').map((el) => el.textContent)];
  const toggle = async (open) => { card.open = open; b.page.fire(b.root, 'toggle', { target: card }); await b.settle(); };

  assert.deepEqual(seen(), ['Show more · 2 previous messages', ['Two.', 'Three', 'Four', 'Five', 'Six']]);
  await toggle(false);
  await toggle(true);
  assert.deepEqual(seen(), ['Show more · 4 previous messages', ['Four', 'Five', 'Six']]);
  b.page.fire(b.root, 'click', { target: thread().querySelector('[data-thread-more]') });
  assert.deepEqual(seen(), ['Show more · 1 previous message', ['Two?', 'Two.', 'Three', 'Four', 'Five', 'Six']]);
  await b.change({ threads: { 'w/A1': [...msgs, said(12, 'Seven')] } });
  assert.deepEqual(seen(), ['Show more · 1 previous message', ['Two?', 'Two.', 'Three', 'Four', 'Five', 'Six', 'Seven']]);
  await toggle(false);
  await toggle(true);
  assert.deepEqual(seen(), ['Show more · 5 previous messages', ['Five', 'Six', 'Seven']]);
});

test("a closed card leads its chip row with its count of unread messages, and opening the card reads them, taking away the chip and the chip row it leaves empty", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const b = boardOnDom({ seen: { 'w/A1': at(2), 'w/A2': at(2) },
    board: boardOf([workCard('A1', { othersAt: [at(5), at(6)] }), workCard('A2', { othersAt: [at(5)], held: true })]) });
  await b.settle();
  const card = (key) => b.root.querySelector(`details.item[data-key="${key}"]`);
  const chips = (key) => card(key).querySelector('summary .line2')?.children.map((c) => c.textContent) ?? null;
  assert.deepEqual([chips('w/A1'), chips('w/A2')], [['2 new'], ['1 new', 'held']]);
  for (const key of ['w/A1', 'w/A2']) { card(key).open = true; b.page.fire(b.root, 'toggle', { target: card(key) }); }
  await b.settle();
  assert.deepEqual([chips('w/A1'), chips('w/A2')], [null, ['held']]);
});

function layOut(b) {
  const view = { scrollY: 0, scrolls: [] };
  const all = () => { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(b.doc.body); return out; };
  Object.getPrototypeOf(b.root).getBoundingClientRect = function () {
    const i = all().indexOf(this);
    return { top: i * 2 - view.scrollY, bottom: (i + this.querySelectorAll('*').length + 1) * 2 - view.scrollY };
  };
  b.page.win.scrollBy = (x, y) => { view.scrolls.push(y); view.scrollY += y; };
  return view;
}

function focusMoves(doc) {
  const moves = [];
  let active = doc.activeElement;
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => active, set: (v) => { if (v !== active) moves.push(v); active = v; } });
  return moves;
}

test("a lane repaint while the owner types in a card's reply box moves the other cards and its own card at once, never takes focus off the reply, keeps its text, cursor and place on screen, scrolls for no change below it, and leaves the + sheet's text alone; with no box focused the open card's title row keeps its place", async () => {
  const b = boardOnDom({ open: ['ask:a1'], board: boardOf([askCard('a1', 'progress'), askCard('b1', 'todo')]),
    threads: { 'ask:a1': [{ ts: '2026-10-30T10:00:00.000Z', who: 'claude', text: 'Started' }] } });
  await b.settle();
  const view = layOut(b);
  const moves = focusMoves(b.doc);
  const ta = b.root.querySelector('form[data-reply="ask:a1"] textarea');
  ta.focus();
  ta.value = 'Half a reply';
  ta.setSelectionRange(4, 6);
  b.page.fire(b.root, 'input', { target: ta });
  b.root.querySelector('#askText').value = 'A new task';
  moves.length = 0;
  const lane = (id) => b.root.querySelector(`details.item[data-key="ask:${id}"]`)?.closest('details.lane').dataset.lane;
  const top = (sel) => b.root.querySelector(sel).getBoundingClientRect().top;
  const BOX = 'form[data-reply="ask:a1"] textarea';
  const boxTop = top(BOX);
  const kept = () => [b.root.querySelector(BOX) === ta, ta.value, ta.selectionStart, ta.selectionEnd, b.doc.activeElement === ta, moves.length, top(BOX)];

  await b.change({ board: boardOf([askCard('b1', 'progress'), askCard('a1', 'progress')]) });
  assert.deepEqual([lane('b1'), lane('a1')], ['progress', 'progress']);
  assert.deepEqual(kept(), [true, 'Half a reply', 4, 6, true, 0, boxTop]);
  assert.equal(view.scrolls.length, 1);

  await b.change({ board: boardOf([askCard('b1', 'progress'), askCard('a1', 'progress'), askCard('c1', 'todo')]) });
  assert.deepEqual([view.scrolls.length, top(BOX)], [1, boxTop]);

  await b.change({ board: boardOf([askCard('d1', 'review'), askCard('a1', 'review'), askCard('b1', 'done'), askCard('c1', 'todo')]) });
  assert.deepEqual([lane('d1'), lane('a1'), lane('b1')], ['review', 'review', 'done']);
  assert.deepEqual(kept(), [true, 'Half a reply', 4, 6, true, 0, boxTop]);
  assert.equal(b.root.querySelector('#askText').value, 'A new task');

  ta.blur();
  const TITLE = 'details.item[data-key="ask:a1"] > summary';
  const titleTop = top(TITLE);
  await b.change({ board: boardOf([askCard('e1', 'review'), askCard('d1', 'review'), askCard('a1', 'review'), askCard('b1', 'done'), askCard('c1', 'todo')]) });
  assert.deepEqual([lane('e1'), top(TITLE)], ['review', titleTop]);
});

function questionsOnDom({ topics, questions, at, next }) {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const base = 'https://mac.ts.net/board-a';
  const server = { questions: structuredClone(questions) };
  const ownerTopics = () => topics.map((t) => {
    const qs = server.questions.filter((q) => q.topic === t.id);
    const count = (s) => qs.filter((q) => q.state === s).length;
    return { ...t, state: 'open', questions: qs.map((q) => q.id), open: count('open'), answered: count('answered') };
  }).filter((t) => t.questions.length);
  const body = (url) => (new URL(url, base).pathname.endsWith('/api/board') ? { ...boardOf([]), owner: server.questions, ownerTopics: ownerTopics() } : []);
  page.win.fetch = async (url) => { const b = structuredClone(body(url)); return { ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b }; };
  const site = page.win.ClaudeSite.site;
  page.win.ClaudeSite.site = (r) => ({ ...site(r), send: async (kind, data) => {
    const q = server.questions.find((x) => x.id === data.id);
    q.state = 'answered';
    q.answers.push({ ts: '2026-10-30T10:00:00.000Z', choice: data.choice, note: '', files: [], reply: null });
    return {};
  } });
  Object.assign(page.win, { scrollTo() {}, scrollY: 0, sessionStorage: memoryStorage().localStorage });
  page.win.BoardAttach.paintAll = () => {};
  page.win.location.hash = `#${at}`;
  page.win.history = { state: { idx: 1, up: 1 }, replaceState: (state, _, url) => { page.win.location.hash = url; } };
  const shell = { root: page.win.document.body.appendChild(new Element('div')), board: null };
  const view = { kind: 'questions', route: 'board-a', id: at };
  const decisions = [];
  const nextQuestion = page.win.BoardUI.nextQuestion;
  page.win.BoardUI.nextQuestion = (...args) => {
    decisions.push(JSON.parse(JSON.stringify(args)));
    return next === undefined ? nextQuestion(...args) : next;
  };
  shell.root.innerHTML = page.win.AppViews.questions.markup(view);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const up = () => {
    questionsView.unmount();
    const root = page.win.document.body.appendChild(new Element('div'));
    root.innerHTML = page.win.BoardView.markup({ title: 'A' });
    page.win.BoardView.create(root, base, {}).mount();
    shell.board = root;
    return true;
  };
  const questionsView = page.win.AppViews.questions.create(shell.root, base, { view, up });
  questionsView.mount();
  const $ = (sel) => shell.root.querySelector(sel);
  const answer = (id) => {
    const input = $(`section.q[data-q="${id}"] input[value="A"]`);
    input.type = 'radio';
    page.fire(shell.root, 'change', { target: input });
  };
  const send = async () => { page.fire(shell.root, 'submit', { target: $('#qform') }); await settle(); };
  const shown = () => shell.board ? { board: shell.board.querySelector('#toast').hidden ? '' : shell.board.querySelector('#toast').textContent }
    : { pills: shell.root.querySelectorAll('.topics button').map((b) => [b.dataset.topic, b.getAttribute('aria-pressed')]),
      questions: shell.root.querySelectorAll('section.q').map((s) => s.dataset.q), status: $('#qstatus').textContent, hash: page.win.location.hash };
  return { settle, answer, send, shown, decisions, root: shell.root, page };
}

test("Waiting on you's Send follows the shared next question, leaving an urgent question's solo view, staying on the current topic or going to the board with its Sent toast", async () => {
  const topic = (n) => ({ id: `item:w/T${n}`, title: `INT-${n}: Topic ${n}` });
  const question = (id, n) => ({ id, topic: `item:w/T${n}`, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  const three = [question('q1', 1), question('q2', 2), question('q3', 3)];
  const open = (...ids) => three.filter((q) => ids.includes(q.id)).concat(three.filter((q) => !ids.includes(q.id)).map((q) => ({ ...q, state: 'answered' })));

  const middle = questionsOnDom({ topics: [1, 2, 3].map(topic), questions: three, at: 'q2', next: three[2] });
  await middle.settle();
  middle.answer('q2');
  await middle.send();
  assert.deepEqual(middle.shown(), { pills: [['item:w/T1', 'false'], ['item:w/T3', 'true']], questions: ['q3'], status: 'Sent 1 answer to INT-2.', hash: '#q3' });
  assert.deepEqual(middle.decisions.map(([qs, pills, answered]) => [qs.map((q) => [q.id, q.state]), pills.map((t) => [t.id, t.open]), answered]),
    [[[['q1', 'open'], ['q2', 'answered'], ['q3', 'open']], [['item:w/T1', 1], ['item:w/T2', 1], ['item:w/T3', 1]], { topic: 'item:w/T2' }]]);

  const partial = questionsOnDom({ topics: [1, 2, 3].map(topic), questions: [...three, question('q2b', 2)], at: 'q2', next: question('q2b', 2) });
  await partial.settle();
  partial.answer('q2');
  await partial.send();
  assert.deepEqual(partial.shown(), { pills: [['item:w/T1', 'false'], ['item:w/T2', 'true'], ['item:w/T3', 'false']], questions: ['q2', 'q2b'],
    status: 'Sent 1 answer to INT-2. 1 still open, answer it any time.', hash: '#q2' });

  const last = questionsOnDom({ topics: [1, 2, 3].map(topic), questions: open('q3'), at: 'q3', next: null });
  await last.settle();
  last.answer('q3');
  await last.send();
  assert.deepEqual(last.shown(), { board: 'Sent 1 answer to INT-3.' });

  const urgent = questionsOnDom({ topics: [1, 2, 3].map(topic), questions: three.map((q) => (q.id === 'q3' ? { ...q, urgent: true } : q)), at: '', next: three[0] });
  await urgent.settle();
  assert.deepEqual(urgent.shown().questions, ['q3']);
  urgent.answer('q3');
  await urgent.send();
  assert.deepEqual(urgent.shown(), { pills: [['item:w/T1', 'true'], ['item:w/T2', 'false']], questions: ['q1'], status: 'Sent 1 answer to INT-3.', hash: '#q1' });
});

test("Waiting on you sizes each framed take to its page once it loads, past 80% of the screen's height shows the Open full size button instead, and a repaint keeps both", async () => {
  const takes = [{ id: 'A', label: 'Badge' }, { id: 'B', label: 'Dot' }, { id: 'C', label: 'Thread' }];
  const q = { id: 'q1', topic: 'item:w/T1', source: '', question: 'Which?', context: '', url: 'prototype-unread.html?q=q1', options: takes, answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Unread' }], questions: [q], at: 'q1' });
  v.page.win.innerWidth = 390;
  await v.settle();
  const shot = (id) => v.root.querySelector(`.take[data-opt="${id}"] .take-shot`);
  const observers = [];
  const load = (id, height, href = 'https://mac.ts.net/board-a/prototype-unread.html?q=q1&take=' + id) => {
    const frame = shot(id).querySelector('iframe');
    frame.contentDocument = { location: { href }, body: { getBoundingClientRect: () => ({ height: height() }) } };
    frame.contentWindow = { ResizeObserver: class { constructor(fn) { this.fn = fn; this.on = false; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } } };
    v.page.fire(frame, 'load');
  };
  const takesShown = () => takes.map(({ id }) => {
    const s = shot(id);
    return s ? [s.getAttribute('class'), s.style.height || s.getAttribute('style') || ''] : [...v.root.querySelectorAll(`.take[data-opt="${id}"] a`)].map((a) => a.textContent);
  });
  assert.deepEqual(takesShown(), [['take-shot measuring', ''], ['take-shot measuring', ''], ['take-shot measuring', '']]);

  let aHeight = 0;
  load('A', () => aHeight, 'about:blank');
  aHeight = 213.2;
  load('A', () => aHeight);
  load('B', () => 120);
  load('C', () => 900);
  assert.deepEqual(takesShown(), [['take-shot', '216px'], ['take-shot', '122px'], ['Open full size →This take scrolls, so it opens full size.']]);
  aHeight = 400;
  observers[0].fn();
  assert.equal(shot('A').style.height, '402px');
  assert.deepEqual(observers.map((o) => o.on), [true, true]);

  v.page.fire(vm.runInContext('window', v.page.win), 'hashchange');
  assert.deepEqual(takesShown(), [['take-shot', 'height:402px'], ['take-shot', 'height:122px'], ['Open full size →This take scrolls, so it opens full size.']]);
});
