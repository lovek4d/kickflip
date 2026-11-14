import { web, write, inProcessHub } from '../hub/hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import path from 'node:path';
import { fixedDate } from '../shared/fixed-clock.mjs';
import { miniDom } from './mini-dom.mjs';
import { buildBoard, slimDone, BUTTON, ACTION_KIND } from './domain.mjs';
import { freshSync, stamp, patchSince } from './sync.mjs';
import { transcriptChunk } from './transcript.mjs';

// The patch the server sends a page holding from once the board reads to, as board/sync.mjs makes it, between the
// versions the two boards name. threads, {from, to}, are the cards' threads beside each board.
function boardPatch(from, to, threads = { from: {}, to: {} }) {
  const map = (t) => new Map(Object.entries(t));
  const held = stamp(freshSync(0), from, map(threads.from));
  const now = stamp(held.sync, to, map(threads.to));
  return { ...patchSince(now.sync, now.board, held.sync.n, map(threads.to)), since: from.version, version: to.version };
}

const SCRIPTS = ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-order.js', 'ui-patch.js', 'ui-threads.js', 'ui-cards.js', 'ui-header.js', 'ui-snapshot.js', 'ui-page-header.js', 'ui-sidebar.js', 'ui-questions.js', 'ui-prompts.js', 'ui-markdown.js', 'ui-hub.js', 'prompts.js', 'rules-editor.js',
  'dialogs.js', 'hub-kit.js', 'linear-key.js', 'sidebar.js', 'toasts.js', 'app.js', 'new-task.js', 'app-core.js', 'app-threads.js', 'app-cards.js', 'app-lanes.js', 'app-asks.js', 'app-pane.js', 'app-header.js', 'app-arch.js', 'app-reader.js', 'app-banner.js', 'app-snapshot.js',
  'view-settings.js', 'view-questions.js', 'view-notes.js', 'view-hub.js', 'view-hub-settings.js', 'view-frame.js', 'router.js'];

// The time every test here builds its data from. A fake page's clock starts at it and moves only by its advance(ms)
// (docs/adr/2026-11-13-1417-ui-tests-freeze-date-in-their-sandbox.md). Local noon, so a day either side stays a day.
const NOW = new Date(2026, 10, 13, 12).getTime();

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
    get tagName() { return 'DIV'; }
    get childNodes() { return [this]; }
    get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
    before() {}
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(el) { el.parentNode = this; return el; }
    remove() {}
    getBoundingClientRect() { return { height: 36 }; }
    insertAdjacentHTML() {}
    contains() { return false; }
    closest() { return null; }
    matches() { return false; }
    focus() {}
    blur() {}
    showModal() { this.open = true; this.modal = true; }
    show() { this.open = true; this.modal = false; }
    close() { this.open = false; }
  }
  let ids = 0;
  const intervals = new Map();
  const timeouts = new Map();
  const watches = [];
  const document = Object.assign(new Target(), { hidden: false, activeElement: null, documentElement: Object.assign(new El(), { dataset: { build: 'build-1' } }), querySelector: () => null, createElement: () => new El() });
  let now = 0;
  const frames = new Map();
  const observers = new Set();
  class MutationObserver { observe() { observers.add(this); } unobserve() {} disconnect() { observers.delete(this); } }
  const win = Object.assign(new Target(), {
    Date: fixedDate(() => NOW + now), URL, URLSearchParams, AbortController, localStorage, document, CSS: { escape: (s) => s }, navigator: { platform: 'MacIntel' },
    location: { hostname: 'mac.ts.net', href: 'https://mac.ts.net/', hash: '', pathname: '/', search: '' }, history: { replaceState() {} }, innerHeight: 844,
    scrollX: 0, scrollY: 0, scrollTo(x, y) { win.scrollX = x; win.scrollY = y; },
    visualViewport: Object.assign(new Target(), { height: 844, offsetTop: 0 }),
    matchMedia: (query) => Object.assign(new Target(), { matches: query === '(min-width: 900px)' && win.innerWidth >= 900 }), MutationObserver, ResizeObserver: MutationObserver,
    performance: { now: () => now },
    requestAnimationFrame: (fn) => { frames.set(++ids, fn); return ids; },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: () => new Promise(() => {}),
    setInterval: (fn, ms) => { intervals.set(++ids, { fn, ms }); return ids; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++ids, { fn, ms }); return ids; },
    clearTimeout: (id) => timeouts.delete(id),
    BoardDialogs: { confirm: async () => false, notice: async () => {} },
    BoardAttach: { files: () => [], busy: () => false, clear() {}, paint() {}, paintAll() {} },
    ClaudeSite: {
      site: (root) => ({
        root, url: (p) => new URL(`${root}/${p}`, 'https://mac.ts.net/').href, send: async () => ({}), events: async () => [], syncBadge() {},
        watch: () => { const w = { stopped: false, stop() { w.stopped = true; } }; watches.push(w); return w; },
      }),
    },
  });
  win.window = win;
  vm.createContext(win);
  for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
  Object.assign(win.BoardDialogs, { confirm: async () => false, notice: async () => {} });
  const fire = (target, type, ev = {}) => {
    let stopped = false;
    const e = { target, type, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopImmediatePropagation() { stopped = true; }, ...ev };
    // A tap is a press then a click on the same element, so BoardUI.onBackdrop sees where it began.
    if (type === 'click' && !('pressed' in ev)) for (const l of listeners.filter((x) => x.target === document && x.type === 'pointerdown')) l.fn({ target: e.target });
    for (const l of listeners.filter((x) => x.target === target && x.type === type).sort((a, b) => b.capture - a.capture)) { if (stopped) break; l.fn(e); }
    return e;
  };
  const left = () => ({ listeners: listeners.length, intervals: intervals.size, timeouts: timeouts.size, watches: watches.filter((w) => !w.stopped).length, observers: observers.size, frames: frames.size });
  const advance = (ms) => {
    now += ms;
    const due = [...frames.values()];
    frames.clear();
    due.forEach((fn) => fn(now));
  };
  const runTimers = (ms = Infinity) => {
    for (const [id, t] of [...timeouts]) if (t.ms <= ms) { timeouts.delete(id); t.fn(); }
  };
  const runIntervals = (ms) => { for (const t of [...intervals.values()]) if (t.ms === ms) t.fn(); };
  return { win, El, Target, fire, left, advance, runTimers, runIntervals, listenerCount: (target) => listeners.filter((l) => l.target === target).length };
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
  view.B.toast('Saved');
  view.unmount();
  assert.deepEqual([page.left(), subscribed.size], [loaded, 0]);
});

// docs/adr/2026-11-07-0100-the-plus-is-the-board-pages-alone.md
test("a page that isn't the board's main page has no + and no new-task sheet; the board page has both", () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  const view = page.win.BoardView.page(root, 'https://mac.ts.net/board-a', () => {});
  view.mount();
  assert.doesNotMatch(root.innerHTML, /id="compose"|id="sheet"/);
  view.unmount();
  assert.match(page.win.BoardView.markup({ title: 'Shop' }), /id="compose"[\s\S]*id="sheet"[\s\S]*id="askForm"/);
});

test("a board's header shows the away moon right of its title while the owner reads away, and drops it once they're back", () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  let away = true;
  assert.match(page.win.BoardView.markup({ title: 'Shop' }), /<h1>Shop<\/h1><span class="away-moon" role="img" aria-label="Away" aria-hidden="true"><svg/);
  const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a', { away: () => away });
  view.mount();
  const moon = root.querySelector('.away-moon');
  view.B.renderStatus();
  assert.deepEqual([moon.classList.contains('on'), moon.attrs['aria-hidden']], [true, 'false']);
  away = false;
  view.B.renderStatus();
  assert.deepEqual([moon.classList.contains('on'), moon.attrs['aria-hidden']], [false, 'true']);
  view.unmount();
});

test('the away moon fades in and out with the toasts: 150ms in and 200ms out, 80 and 100 with reduced motion', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.away-moon \{[^}]*transition: opacity 200ms ease/);
  assert.match(css, /\.away-moon\.on \{[^}]*transition: opacity 150ms ease/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\n  \.away-moon \{ transition: opacity 100ms ease[^}]*\}\n  \.away-moon\.on \{ transition: opacity 80ms ease/);
});

function toastOnDom({ reduced = false } = {}) {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  Element.prototype.getBoundingClientRect = () => ({ height: 36 });
  Element.prototype.setPointerCapture = function (id) { this.captured = id; };
  page.win.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' && reduced });
  const root = page.win.document.body.appendChild(new Element('div'));
  const loaded = page.left();
  const view = page.win.BoardView.page(root, 'https://mac.ts.net/_hub', () => {});
  view.mount();
  const toasts = () => root.querySelectorAll('.toast');
  const show = (text) => { view.B.toast(text); return toasts().at(-1); };
  const pointer = (el, type, extra = {}) => page.fire(el, type, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0, ...extra });
  return { page, root, view, loaded, toasts, show, pointer, advance: page.advance };
}

test('shared toasts fade in for 150ms, hold solid for 3s through 100 text characters or 5s above, then fade out for 200ms', () => {
  const t = toastOnDom();
  const short = t.show('😀'.repeat(100));
  const long = t.show('x'.repeat(101));
  assert.equal(short.style.opacity, 0);
  t.advance(75);
  assert.equal(short.style.opacity, .5);
  t.advance(75);
  assert.equal(short.style.opacity, 1);
  t.advance(2999);
  assert.equal(short.style.opacity, 1);
  t.advance(101);
  assert.equal(short.style.opacity, .5);
  assert.equal(long.style.opacity, 1);
  t.advance(100);
  assert.deepEqual(t.toasts(), [long]);
  t.advance(1800);
  assert.equal(long.style.opacity, 1);
  t.advance(100);
  assert.equal(long.style.opacity, .5);
  t.advance(100);
  assert.equal(t.toasts().length, 0);
  assert.equal(t.page.left().frames, 0);
  t.view.unmount();
  assert.deepEqual(t.page.left(), t.loaded);
});

test('hover and held touch pause a toast independently, then resume its remaining time; a long press releases without dismissing', () => {
  const t = toastOnDom();
  const el = t.show('Sending…');
  t.advance(1150);
  t.pointer(el, 'pointerenter', { pointerType: 'mouse' });
  t.advance(4000);
  t.pointer(el, 'pointerdown');
  assert.equal(el.captured, 1);
  t.pointer(el, 'pointerleave', { pointerType: 'mouse' });
  t.advance(4000);
  assert.equal(el.style.opacity, 1);
  t.pointer(el, 'pointerup');
  t.page.fire(el, 'click');
  t.advance(1999);
  assert.equal(el.style.opacity, 1);
  t.advance(101);
  assert.equal(el.style.opacity, .5);
  t.advance(100);
  assert.equal(t.toasts().length, 0);
  t.view.unmount();
  assert.deepEqual(t.page.left(), t.loaded);
});

test('hover during a fade holds full opacity and resumes a fresh exit; blur and hiding the page release holds', () => {
  const t = toastOnDom();
  const el = t.show('Saved');
  t.advance(3250);
  assert.equal(el.style.opacity, .5);
  t.pointer(el, 'pointerenter', { pointerType: 'mouse' });
  t.advance(5000);
  assert.equal(el.style.opacity, 1);
  t.page.fire(vm.runInContext('window', t.page.win), 'blur');
  t.advance(100);
  assert.equal(el.style.opacity, .5);
  t.pointer(el, 'pointerdown');
  t.advance(5000);
  assert.equal(el.style.opacity, 1);
  t.page.win.document.hidden = true;
  t.page.fire(t.page.win.document, 'visibilitychange');
  t.advance(200);
  assert.equal(t.toasts().length, 0);
  t.view.unmount();
});

test('a tap, mouse click while hovered, or keyboard dismissal starts the exit immediately, even while held', () => {
  for (const action of ['tap', 'click', 'Enter', 'Escape', ' ']) {
    const t = toastOnDom();
    const el = t.show('Could not send');
    t.advance(150);
    if (action === 'tap') {
      t.pointer(el, 'pointerdown');
      t.advance(100);
      t.pointer(el, 'pointerup');
      t.page.fire(el, 'click');
    } else {
      t.pointer(el, 'pointerenter', { pointerType: 'mouse' });
      t.page.fire(el, action === 'click' ? 'click' : 'keydown', { key: action });
    }
    t.advance(100);
    assert.equal(el.style.opacity, .5, action);
    t.advance(100);
    assert.equal(t.toasts().length, 0, action);
    t.advance(10000);
    assert.equal(t.toasts().length, 0, action);
    t.view.unmount();
    assert.deepEqual(t.page.left(), t.loaded);
  }
});

test('a canceled or dragged touch resumes the toast without dismissing it', () => {
  for (const type of ['pointercancel', 'lostpointercapture', 'pointerup']) {
    const t = toastOnDom();
    const el = t.show('Saved');
    t.advance(150);
    t.pointer(el, 'pointerdown');
    t.pointer(el, type, { clientX: 20 });
    t.page.fire(el, 'click');
    t.advance(3000);
    assert.equal(el.style.opacity, 1, type);
    t.advance(200);
    assert.equal(t.toasts().length, 0, type);
    t.view.unmount();
  }
});

test('toasts stack newest at the bottom, retain separate timers, and fade the oldest before a fourth can appear, even when held', () => {
  const t = toastOnDom();
  const first = t.show('First');
  t.advance(1150);
  const second = t.show('Second');
  t.advance(1150);
  const third = t.show('Third');
  t.advance(150);
  assert.deepEqual(t.toasts().map((el) => el.parentNode.style.transform), ['translateY(-124px)', 'translateY(-80px)', 'translateY(-36px)']);
  t.pointer(first, 'pointerenter', { pointerType: 'mouse' });
  t.show('Fourth');
  t.show('Fifth');
  assert.deepEqual(t.toasts().map((el) => el.textContent), ['First', 'Second', 'Third']);
  t.advance(100);
  assert.equal(first.style.opacity, .5);
  t.advance(100);
  assert.deepEqual(t.toasts().map((el) => el.textContent), ['Second', 'Third', 'Fourth']);
  t.advance(200);
  assert.deepEqual(t.toasts().map((el) => el.textContent), ['Third', 'Fourth', 'Fifth']);
  t.advance(2700);
  assert.equal(third.style.opacity, .5);
  t.advance(100);
  assert.deepEqual(t.toasts().map((el) => el.textContent), ['Fourth', 'Fifth']);
  assert.equal(second.isConnected, false);
  t.view.unmount();
  assert.deepEqual(t.page.left(), t.loaded);
  assert.equal(t.root.querySelector('.toast-stack'), null);
});

test('reduced motion uses short fades and a toast treats markup as text; leaving a view clears its pending arrivals', () => {
  const t = toastOnDom({ reduced: true });
  const el = t.show('<b>Saved & sent</b>');
  assert.equal(el.textContent, '<b>Saved & sent</b>');
  assert.equal(el.querySelector('b'), null);
  t.advance(40);
  assert.equal(el.style.opacity, .5);
  t.advance(40);
  t.advance(3000);
  t.advance(50);
  assert.equal(el.style.opacity, .5);
  t.advance(50);
  assert.equal(t.toasts().length, 0);
  for (const text of ['1', '2', '3', '4']) t.show(text);
  t.view.unmount();
  t.advance(10000);
  assert.deepEqual(t.page.left(), t.loaded);
  assert.equal(t.toasts().length, 0);
  t.view.B.toast('After leaving');
  assert.equal(t.toasts().length, 0);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.toast-row\s*\{\s*transition: none;/);
});

// docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md
test('offline, the board stays readable with no toast: the header time turns red, refresh retries, Settings still opens, and only a tap or submit that sends is held', async () => {
  const T1 = workCard('T1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 0 });
  const T2 = workCard('T2', { bumpable: true, sortAt: '2026-10-02T00:00:00.000Z', order: 1 });
  const b = boardOnDom({ board: boardOf([T1, T2]), threads: {} });
  await b.settle();
  const { B } = b.view;
  let retries = 0;
  B.loadBoard = async () => { retries++; };
  B.linkDown();
  assert.deepEqual([b.root.querySelectorAll('.toast').length, b.root.classList.contains('offline'), B.state.link], [0, true, 'offline']);
  assert.match(b.root.querySelector('#status').innerHTML, /class="fresh" title="Offline: can't reach the host/);
  assert.equal(b.root.querySelector('#settingsLink').getAttribute('aria-disabled'), null);
  const bump = b.root.querySelector('details.item[data-key="w/T2"] button[data-card-bump]');
  assert.equal(b.page.fire(b.root, 'click', { target: bump }).defaultPrevented, true);
  assert.equal(b.page.fire(b.root, 'submit', { target: b.root.querySelector('#askForm') }).defaultPrevented, true);
  assert.equal(b.page.fire(b.root, 'click', { target: b.root.querySelector('details.item[data-key="w/T2"]') }).defaultPrevented, false, 'a task still opens');
  await b.settle();
  assert.deepEqual(b.sent, []);
  const refresh = b.root.querySelector('#refresh');
  assert.equal(refresh.disabled, false);
  b.page.fire(refresh, 'click');
  assert.equal(retries, 1);
  B.linkUp();
  b.page.fire(b.root, 'click', { target: bump });
  await b.settle();
  assert.deepEqual(b.sent.map(([k]) => k), ['card-bump']);
  b.view.unmount();
});

test("the board's Settings, Waiting on you and Notes views, mounted then unmounted, leave no listener, interval, timer or watch behind, and stop retrying a load", async () => {
  const page = fakePage(memoryStorage().localStorage);
  let fetches = 0;
  page.win.fetch = () => { fetches++; return Promise.reject(new Error('offline')); };
  const loaded = page.left();
  const views = page.win.AppViews;
  assert.deepEqual(Object.keys(views).sort(), ['frame', 'hub', 'notes', 'questions', 'settings']);
  for (const [kind, view] of [['settings', {}], ['questions', { id: 'q1' }], ['notes', { item: 'w/A1' }]]) {
    assert.equal(typeof views[kind].markup({ kind, route: 'board-a', ...view }), 'string', kind);
    const v = views[kind].create(new page.El(), 'https://mac.ts.net/board-a', { view: { kind, route: 'board-a', ...view }, reload() {} });
    v.mount();
    v.B.toast('Saved');
    await new Promise((r) => setImmediate(r));
    const mounted = page.left();
    assert.ok(mounted.timeouts > loaded.timeouts, `${kind} ${JSON.stringify(mounted)}`);
    v.unmount();
    assert.deepEqual(page.left(), loaded, kind);
    const sent = fetches;
    v.mount();
    await new Promise((r) => setImmediate(r));
    v.unmount();
    await new Promise((r) => setImmediate(r));
    assert.ok(fetches > sent, kind);
    assert.deepEqual(page.left(), loaded, kind);
  }
});

// One Board Settings page on a fake board: /api/settings answers what is saved, and a POST is kept in posts and merged
// into it, or answers s.refuse while that holds an error. Other URLs answer from routes by their ending.
function settingsPage({ settings = {}, board = {}, routes = {} } = {}) {
  const page = fakePage(memoryStorage().localStorage);
  const s = { page, root: new page.El(), posts: [], confirms: [], refuse: '', saved: { ...settings } };
  page.win.BoardDialogs.confirm = async (text) => { s.confirms.push(text); return true; };
  page.win.fetch = async (url, opts = {}) => {
    let body = url.endsWith('/api/board') ? board : Object.entries(routes).find(([end]) => url.endsWith(end))?.[1] ?? {};
    if (url.endsWith('/api/settings')) {
      if (opts.method === 'POST') {
        s.posts.push(JSON.parse(opts.body));
        if (s.refuse) return { ok: false, status: 400, text: async () => JSON.stringify({ error: s.refuse }), json: async () => ({ error: s.refuse }) };
        s.saved = { ...s.saved, ...JSON.parse(opts.body) };
      }
      body = { settings: s.saved };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  s.view = page.win.AppViews.settings.create(s.root, '/orch', {});
  s.mount = async () => { s.view.mount(); await tick(); return s; };
  s.set = async (el, value, field = 'value') => { el[field] = value; page.fire(el, 'change'); await tick(); };
  return s;
}

// docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md, docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md,
// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
for (const [key, id] of [['auto_build', 'autoBuild'], ['auto_triage', 'autoTriage'], ['auto_review', 'autoReview'], ['idle_notification', 'idleNotification']]) {
  test(`Board Settings saves ${key} at once with no confirmation, waits on its toggle, and puts the toggle back on refusal`, async () => {
    const s = await settingsPage({ settings: { [key]: false } }).mount();
    const toggle = s.root.querySelector(`#${id}`), status = s.root.querySelector(`#${id}Status`);
    assert.deepEqual([toggle.disabled, toggle.checked], [false, false]);
    const said = [];
    for (const want of [true, false]) {
      toggle.checked = want;
      s.page.fire(toggle, 'change');
      assert.deepEqual([toggle.disabled, toggle.getAttribute('aria-busy')], [true, 'true'], 'the toggle waits, disabled with a spinner, while it saves');
      await tick();
      assert.deepEqual([toggle.disabled, toggle.getAttribute('aria-busy'), toggle.checked, s.posts.at(-1)], [false, null, want, { [key]: want }]);
      said.push(status.textContent);
    }
    assert.notEqual(said[0], said[1], 'the status says which way it saved');
    assert.deepEqual(s.confirms, []);
    s.refuse = 'Cannot save';
    await s.set(toggle, true, 'checked');
    assert.deepEqual([toggle.checked, status.textContent], [false, 'Cannot save']);
    s.view.unmount();
  });
}

// docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md
test("Board Settings' Build target lists the repo's build scripts with a default, names the script it runs and saves a pick at once", async () => {
  const s = await settingsPage({ settings: { build_target: 'gone' }, board: { kind: 'web' }, routes: { '/api/build-targets': { targets: ['ios', 'web'] } } }).mount();
  const select = s.root.querySelector('#buildTarget'), sub = s.root.querySelector('#buildTargetSub'), status = s.root.querySelector('#buildTargetStatus');
  const options = () => [...select.innerHTML.matchAll(/<option value="([^"]*)"( selected)?/g)].map((m) => m[1] + (m[2] ? '*' : ''));
  assert.equal(select.disabled, false);
  assert.deepEqual(options(), ['', 'ios', 'web', 'gone*'], 'a saved script no longer on main stays listed, picked');
  assert.match(sub.innerHTML, /\.kickflip\/build-gone\b/);
  await s.set(select, 'ios');
  assert.deepEqual(s.posts.at(-1), { build_target: 'ios' });
  assert.match(sub.innerHTML, /\.kickflip\/build-ios\b/);
  assert.match(status.textContent, /\.kickflip\/build-ios\b/);
  assert.deepEqual(options(), ['', 'ios*', 'web']);
  await s.set(select, '');
  assert.deepEqual(s.posts.at(-1), { build_target: null });
  assert.match(sub.innerHTML, /\.kickflip\/build\b(?!-)/);
  s.refuse = 'Cannot save';
  await s.set(select, 'web');
  assert.deepEqual([select.value, status.textContent], ['', 'Cannot save']);
  s.view.unmount();
});

// docs/adr/2026-11-04-0119-the-board-server-removes-reviewers-itself.md
test("Board Settings' reviewers Add searches one list of Slack members, guesses the GitHub login from the name, stays off until a login is there, and Save sends the person and draws the server's list", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  const sent = [];
  let refuse = '';
  const base = page.win.ClaudeSite.site;
  page.win.ClaudeSite.site = (r) => ({ ...base(r), send: async (kind, data) => {
    sent.push([kind, JSON.parse(JSON.stringify(data))]);
    if (refuse) throw Object.assign(new Error('send failed: 400'), { status: 400, reason: refuse });
    return { id: `e${sent.length}`, board: { reviewers: ['Bob'] } };
  } });
  page.win.fetch = async (url) => {
    const body = url.endsWith('/api/board') ? { reviewers: ['Ann', 'Bob'], reviewerGithub: { Ann: 'ann-gh', Bob: 'bob-gh' } }
      : url.endsWith('/api/reviewer-people') ? { slack: [{ id: 'U3', name: 'Cy Doe' }, { id: 'U2', name: 'Bob' }], github: ['cy-gh', 'zed'] } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const view = page.win.AppViews.settings.create(root, '/orch', {});
  view.mount();
  await tick();
  const list = root.querySelector('#list'), status = root.querySelector('#saveStatus'), save = root.querySelector('#save');
  const tapRemove = (name) => page.fire(list, 'click', { target: { closest: () => ({ dataset: { name } }) } });
  const saveNow = async () => { page.fire(save, 'click'); await tick(); await tick(); };
  assert.match(list.innerHTML, /Ann[^]*github: ann-gh[^]*Bob/);
  assert.doesNotMatch(list.innerHTML, /U1/, 'the row shows no Slack id');
  tapRemove('Ann');
  assert.equal(save.disabled, false);
  await saveNow();
  assert.deepEqual(sent.at(-1), ['reviewers', { add: [], remove: ['Ann'] }]);
  assert.equal(status.textContent, 'Saved');
  assert.doesNotMatch(list.innerHTML, /Ann/);
  assert.equal(save.disabled, true);

  const addBtn = root.querySelector('#addBtn');
  const tap = (id, attr, value, extra = {}) => page.fire(root.querySelector(id), 'click', { target: { closest: () => ({ dataset: { [attr]: value, ...extra } }) } });
  assert.match(root.querySelector('#slackPeople').innerHTML, /Cy Doe/);
  assert.doesNotMatch(root.querySelector('#slackPeople').innerHTML, />Bob</, 'someone already a reviewer is not offered');
  assert.equal(addBtn.disabled, true);
  tap('#slackPeople', 'slack', 'U3', { name: 'Cy Doe' });
  assert.equal(addBtn.disabled, true, 'a Slack member with no guessable login is not enough');
  assert.match(root.querySelector('#slackPeople').innerHTML, /Cy Doe/, 'the chosen member shows as a chip');
  assert.equal(root.querySelector('#githubFilter').value, '', 'cy-gh is no spelling of Cy Doe');
  root.querySelector('#githubFilter').value = 'cy-gh';
  page.fire(root.querySelector('#githubFilter'), 'input');
  assert.equal(addBtn.disabled, false);
  page.fire(root.querySelector('#addForm'), 'submit');
  assert.match(list.innerHTML, /Cy Doe[^]*new[^]*github: cy-gh/);
  assert.equal(addBtn.disabled, true);
  await saveNow();
  assert.deepEqual(sent.at(-1), ['reviewers', { add: [{ name: 'Cy Doe', slack_user: 'U3', github: 'cy-gh' }], remove: [] }]);
  assert.equal(status.textContent, 'Saved');

  refuse = 'this board has no reviewer "Bob"';
  tapRemove('Bob');
  await saveNow();
  assert.equal(status.textContent, 'this board has no reviewer "Bob"');
  assert.equal(save.disabled, false, 'a refused Save keeps what was staged');
  view.unmount();
});

// docs/adr/2026-11-07-1200-the-reviewer-picker-searches-one-list-and-says-what-it-waits-on.md
test("Board Settings' reviewer picker guesses a login from the Slack name, and says Couldn't load with Retry, never Board restarting, when the board answers with errors", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  let failing = true;
  page.win.fetch = async (url) => {
    if (url.endsWith('/api/reviewer-people') && failing) return { ok: false, status: 502, headers: { get: () => null }, text: async () => 'bad gateway', json: async () => { throw new Error('no'); } };
    const body = url.endsWith('/api/board') ? { reviewers: [], reviewerGithub: {} }
      : url.endsWith('/api/reviewer-people') ? { slack: [{ id: 'U5', name: 'Grace Hopper' }], github: ['ghopper', 'zed'] } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  page.win.BoardUI.fetchJSON = ((real) => (url, opts = {}) => real(url, { ...opts, limit: url.endsWith('/api/reviewer-people') ? 0 : opts.limit }))(page.win.BoardUI.fetchJSON);
  const view = page.win.AppViews.settings.create(root, '/orch', {});
  view.mount();
  await tick(); await tick();
  const people = root.querySelector('#slackPeople');
  assert.match(people.innerHTML, /Couldn(&#39;|')t load the list/);
  assert.match(people.innerHTML, /data-retry/);
  assert.doesNotMatch(root.innerHTML, /Board restarting/);
  failing = false;
  page.fire(people, 'click', { target: { closest: () => ({ dataset: { retry: '' } }) } });
  await tick(); await tick();
  assert.match(people.innerHTML, /Grace Hopper/);
  page.fire(people, 'click', { target: { closest: () => ({ dataset: { slack: 'U5', name: 'Grace Hopper' } }) } });
  assert.equal(root.querySelector('#githubFilter').value, 'ghopper', 'first initial and last name match a collaborator');
  assert.equal(root.querySelector('#addBtn').disabled, false);
  view.unmount();
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test("Board Settings opens with Pause board: the snooze picker's chips, Forever included, then until when with Resume, each saved at once", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  const markup = page.win.AppViews.settings.markup({}, {});
  assert.ok(markup.indexOf('<h2>Pause board</h2>') < markup.indexOf('<h2>Repo</h2>'), 'Pause board is at the top');
  const until = new Date(NOW + 3 * 3600_000).toISOString();
  const posts = [];
  let paused = null;
  let sidebar = 0;
  page.win.fetch = async (url, opts = {}) => {
    let body = {};
    if (url.endsWith('/api/settings')) body = { settings: {}, paused_until: paused, pause_choices: [{ value: '1h', label: '1h', ms: 3600_000 }, { value: '3h', label: '3h', ms: 3 * 3600_000 }, { value: 'forever', label: 'Forever', ms: null }] };
    if (url.endsWith('/api/pause')) {
      posts.push(JSON.parse(opts.body));
      const { pause } = JSON.parse(opts.body);
      if (pause === 'soon') return { ok: false, status: 400, json: async () => ({ error: 'A pause ends after now and within 30 days.' }) };
      paused = pause === 'off' ? null : pause === 'forever' ? 'forever' : until;
      body = { paused_until: paused };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const view = page.win.AppViews.settings.create(root, '/orch', { sidebarChanged: () => { sidebar++; } });
  view.mount();
  await tick();
  const box = root.querySelector('#pauseBoard');
  const status = root.querySelector('#pauseBoardStatus');
  const choices = () => [...box.innerHTML.matchAll(/name="pause" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(choices(), ['1h', '3h', 'forever']);
  assert.match(box.innerHTML, /action="https:\/\/mac\.ts\.net\/orch\/api\/pause"/);
  const submit = async (value) => { page.fire(box, 'submit', { target: new page.El(), submitter: Object.assign(new page.El(), { value }) }); await tick(); await tick(); };
  await submit('3h');
  assert.deepEqual(posts.at(-1), { pause: '3h' });
  assert.deepEqual(choices(), ['off'], 'a paused board offers only Resume');
  const pausedUntil = box.innerHTML, pausedSaid = status.textContent;
  assert.equal(sidebar, 1, 'the sidebar redraws its paused row');
  await submit('off');
  assert.deepEqual(posts.at(-1), { pause: 'off' });
  assert.notEqual(status.textContent, pausedSaid);
  assert.deepEqual(choices(), ['1h', '3h', 'forever']);
  await submit('forever');
  assert.deepEqual(posts.at(-1), { pause: 'forever' });
  assert.deepEqual(choices(), ['off']);
  assert.notEqual(box.innerHTML, pausedUntil, 'a forever pause reads differently from one with an end');
  await submit('off');
  await submit('soon');
  assert.equal(status.textContent, 'A pause ends after now and within 30 days.');
  view.unmount();
});

// docs/adr/2026-11-05-0200-landing-is-one-choice-draft-pr-ready-pr-or-merge.md
test('Board Settings shows Landing above Auto only on a GitHub board that builds from its shared clone or the hub board, with Reviewers while it opens PRs, its choice read from prs and skip_draft', async () => {
  const markup = fakePage(memoryStorage().localStorage).win.AppViews.settings.markup({}, {});
  assert.ok(markup.indexOf('<h2>Landing</h2>') > markup.indexOf('<h2>Tickets</h2>') && markup.indexOf('<h2>Landing</h2>') < markup.indexOf('<h2>Auto</h2>'));
  assert.deepEqual([...markup.matchAll(/data-landing="(\w+)"/g)].map((m) => m[1]), ['draft', 'ready', 'merge']);
  assert.doesNotMatch(markup, /id="prs"|id="skipDraft"/);
  const cases = [
    [{ github: 'owner/project', branch: 'main' }, { prs: true, skip_draft: false }, 'draft'],
    [{ github: 'owner/project', branch: 'main' }, { prs: true, skip_draft: true }, 'ready'],
    [{ github: 'owner/project', branch: 'main' }, { prs: false, skip_draft: true }, 'merge'],
    [{ github: 'owner/project', branch: 'main', local: true }, { prs: true }, null],
    [{ github: 'owner/project', branch: 'main', local: true, hub: true }, { prs: false }, 'merge'],
    [{ github: 'owner/project', branch: 'main', local: true, hub: true }, { prs: true, skip_draft: false }, 'draft'],
    [{ github: 'owner/project', branch: 'main', local: true, hub: true }, { prs: true, skip_draft: true }, 'ready'],
    [{}, { prs: true }, null],
  ];
  const subs = new Map();
  for (const [repoBody, settings, pressed] of cases) {
    const page = fakePage(memoryStorage().localStorage);
    const root = new page.El();
    const view = page.win.AppViews.settings.create(root, '/orch', {});
    page.win.fetch = async (url) => {
      const body = url.includes('board-repo') ? repoBody : url.endsWith('/api/settings') ? { settings } : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    };
    view.mount();
    await tick();
    const label = JSON.stringify([repoBody, settings]);
    assert.equal(root.querySelector('#landingSection').hidden, !pressed, label);
    assert.equal(root.querySelector('#reviewersSection').hidden, pressed === 'merge' || !pressed, label);
    if (pressed) {
      assert.deepEqual(['draft', 'ready', 'merge'].map((v) => root.querySelector(`[data-landing="${v}"]`).getAttribute('aria-pressed')), ['draft', 'ready', 'merge'].map((v) => String(v === pressed)), label);
      subs.set(pressed, [...(subs.get(pressed) || []), root.querySelector('#landingSub').textContent]);
    }
    view.unmount();
  }
  assert.deepEqual([...subs.values()].map((said) => new Set(said).size), [1, 1, 1], 'each choice reads one way wherever it shows');
  assert.equal(new Set([...subs.values()].map((said) => said[0])).size, 3, 'and each reads differently');
});

// docs/adr/2026-11-05-0200-landing-is-one-choice-draft-pr-ready-pr-or-merge.md
test('a Landing tap saves prs and skip_draft together with no confirmation, Merge hides Reviewers, and a refusal keeps the saved choice', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  let refuse = false, saved = { prs: true, skip_draft: false };
  const posts = [], confirms = [];
  page.win.BoardDialogs.confirm = async (text) => { confirms.push(text); return true; };
  page.win.fetch = async (url, opts = {}) => {
    let body = {}, status = 200;
    if (url.includes('board-repo')) body = { github: 'owner/project', branch: 'main' };
    if (url.endsWith('/api/settings')) {
      if (opts.method === 'POST') {
        posts.push(JSON.parse(opts.body));
        if (refuse) { status = 400; body = { error: 'Merge lands each task on main and pushes it, so turn on Push main after a land first' }; }
        else saved = { ...saved, ...JSON.parse(opts.body) };
      }
      if (status === 200) body = { settings: saved };
    }
    return { ok: status === 200, status, text: async () => JSON.stringify(body), json: async () => body };
  };
  const view = page.win.AppViews.settings.create(root, '/orch', {});
  view.mount();
  await tick();
  const button = (v) => root.querySelector(`[data-landing="${v}"]`);
  const pressed = () => ['draft', 'ready', 'merge'].filter((v) => button(v).getAttribute('aria-pressed') === 'true');
  const tap = async (v) => { page.fire(button(v), 'click', { target: button(v) }); await tick(); };
  assert.deepEqual([button('draft').disabled, pressed()], [false, ['draft']]);
  const said = () => root.querySelector('#landingStatus').textContent;
  const subOf = () => root.querySelector('#landingSub').textContent;
  const draftSub = subOf();
  await tap('ready');
  assert.deepEqual([confirms, posts.at(-1), pressed()], [[], { prs: true, skip_draft: true }, ['ready']]);
  const readySaid = said();
  assert.notEqual(subOf(), draftSub, 'the sub reads the new choice');
  refuse = true;
  await tap('merge');
  assert.deepEqual([posts.at(-1), pressed(), said()], [{ prs: false }, ['ready'], 'Merge lands each task on main and pushes it, so turn on Push main after a land first']);
  assert.equal(root.querySelector('#reviewersSection').hidden, false);
  refuse = false;
  await tap('merge');
  assert.deepEqual([posts.at(-1), pressed()], [{ prs: false }, ['merge']]);
  assert.ok(![readySaid, ''].includes(said()) && !said().startsWith('Merge lands'), said());
  assert.deepEqual([root.querySelector('#reviewersSection').hidden, root.querySelector('#landingSection').hidden], [true, false]);
  await tap('draft');
  assert.deepEqual([posts.at(-1), pressed(), subOf()], [{ prs: true, skip_draft: false }, ['draft'], draftSub]);
  assert.equal(root.querySelector('#reviewersSection').hidden, false);
  view.unmount();
});

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md, docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md,
// docs/adr/2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md
const CAPS = [['max_implementers', 'maxImplementers'], ['max_planners', 'maxPlanners'], ['max_serves', 'maxServes']];
for (const [key, id] of CAPS) {
  test(`Board Settings saves ${key} as a whole number from 1 to 99 on change, and puts the saved one back on a bad number or a refusal`, async () => {
    const s = await settingsPage({ settings: { max_implementers: 10, max_planners: 3, max_serves: 6 } }).mount();
    const input = s.root.querySelector(`#${id}`), status = s.root.querySelector(`#${id}Status`);
    const values = () => CAPS.map(([, other]) => s.root.querySelector(`#${other}`).value);
    assert.deepEqual([input.disabled, values()], [false, ['10', '3', '6']]);
    await s.set(input, '4');
    assert.deepEqual([s.posts, input.value], [[{ [key]: 4 }], '4']);
    assert.match(status.textContent, /\b4\b/, 'the status names the number saved');
    const saved = status.textContent;
    for (const bad of ['0', '100', '2.5', '']) {
      await s.set(input, bad);
      assert.deepEqual([s.posts.length, input.value], [1, '4'], bad);
      assert.notEqual(status.textContent, saved, bad);
    }
    s.refuse = 'Cannot save';
    await s.set(input, '7');
    assert.deepEqual([input.value, status.textContent], ['4', 'Cannot save']);
    assert.deepEqual(values().filter((v, i) => CAPS[i][0] !== key), ['10', '3', '6'].filter((v, i) => CAPS[i][0] !== key), 'the other caps stay as saved');
    s.view.unmount();
  });
}

test('Board Settings warns about active work, requires the exact board name and waits for the close response before opening the hub', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  const opened = [];
  const posts = [];
  let answer;
  let sidebarChanges = 0;
  const closure = { title: 'The Shop', hub: false, prs: [{ pr: 42, repo: 'o/r', file: 'shop', id: 'S1' }], builders: [{ label: 'Codex builder', key: 'shop/S1' }] };
  page.win.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push([url, JSON.parse(opts.body), opts.headers['content-type']]);
      return new Promise((resolve) => { answer = resolve; });
    }
    const body = url === '/_hub/close-board/shop' ? closure : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const markup = page.win.AppViews.settings.markup();
  assert.match(markup, /id="closeBoard" disabled/);
  assert.match(markup, /Stop the board’s session[\s\S]*Stop its server[\s\S]*Remove its sidebar row/);
  assert.match(markup, /Keep its folder, tasks, threads and notes/);
  const baseline = page.left();
  const view = page.win.AppViews.settings.create(root, '/shop', { open: (url) => opened.push(url), sidebarChanged: () => sidebarChanges++ });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  view.mount();
  await settle();
  const row = root.querySelector('#closeBoard');
  const sheet = root.querySelector('#closeBoardSheet');
  const typed = root.querySelector('#closeBoardTyped');
  const confirm = root.querySelector('#closeBoardConfirm');
  const form = root.querySelector('#closeBoardForm');
  assert.equal(row.disabled, false);
  page.fire(row, 'click');
  await settle();
  assert.equal(sheet.open, true);
  assert.match(root.querySelector('#closeBoardWarning').innerHTML, /PR #42[\s\S]*Codex builder[\s\S]*PRs stay open on GitHub/);
  for (const name of ['', 'the shop', ' The Shop']) {
    typed.value = name;
    page.fire(typed, 'input');
    assert.equal(confirm.disabled, true);
    page.fire(form, 'submit');
    await settle();
    assert.equal(posts.length, 0);
  }
  typed.value = 'The Shop';
  page.fire(typed, 'input');
  assert.equal(confirm.disabled, false);
  page.fire(form, 'submit');
  page.fire(form, 'submit');
  assert.equal(confirm.disabled, true);
  assert.deepEqual(posts, [['/_hub/close-board', { route: 'shop', name: 'The Shop' }, 'application/json']]);
  assert.deepEqual(opened, []);
  answer({ ok: false, json: async () => ({ error: 'Session did not stop.' }) });
  await settle();
  assert.equal(root.querySelector('#closeBoardError').textContent, 'Session did not stop.');
  assert.equal(sheet.open, true);
  assert.equal(confirm.disabled, false);
  page.fire(form, 'submit');
  answer({ ok: true, json: async () => ({ next: '/_hub/' }) });
  await settle();
  assert.deepEqual(opened, ['/_hub/']);
  assert.equal(sidebarChanges, 1);
  assert.equal(sheet.open, false);
  view.unmount();
  assert.deepEqual(page.left(), baseline);
});

test('Board Settings offers Close board for the hub board like any other once its closure loads', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  const requests = [];
  page.win.fetch = async (url, opts = {}) => {
    requests.push([url, opts.method]);
    const body = url === '/_hub/close-board/dev' ? { title: 'Dev', prs: [], builders: [] } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const view = page.win.AppViews.settings.create(root, '/dev', {});
  view.mount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(root.querySelector('#closeBoard').disabled, false);
  assert.equal(root.querySelector('#closeBoardReason').textContent, '');
  page.fire(root.querySelector('#closeBoardForm'), 'submit');
  assert.equal(requests.some(([, method]) => method === 'POST'), false);
  view.unmount();
});

test('Hub Settings lists closed boards, keeps a refused reopen available, then removes it after reopening', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  Element.prototype.setSelectionRange = () => {};
  page.win.document.getElementById = () => true;
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = page.win.HubSettings.markup();
  const d = { on: { on: true, sub: '', confirm: '' }, weekends: { on: false, sub: '' }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [] }, pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off' }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false },
    closed: [{ route: 'shop', title: 'The <Shop>' }] };
  const posts = [];
  let refuse = true;
  let changed = 0;
  page.win.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push([url, JSON.parse(opts.body), opts.headers['content-type']]);
      return { ok: !refuse, json: async () => refuse ? { error: 'Not signed in.' } : { route: 'shop' } };
    }
    return { ok: true, json: async () => structuredClone(d) };
  };
  const view = page.win.HubSettings.create(root, 'https://mac.ts.net/_hub', { view: { hash: '#closed' }, sidebarChanged: () => changed++ });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  view.mount();
  await settle();
  const top = root;
  assert.match(top.innerHTML, /Closed boards[\s\S]*The &lt;Shop&gt;[\s\S]*data-reopen="shop"/);
  page.fire(root, 'click', { target: root.querySelector('[data-reopen="shop"]') });
  await settle();
  assert.match(top.innerHTML, /Not signed in/);
  assert.match(top.innerHTML, /data-reopen="shop"/);
  refuse = false;
  page.fire(root, 'click', { target: root.querySelector('[data-reopen="shop"]') });
  const reopen = root.querySelector('[data-reopen="shop"]');
  assert.deepEqual([reopen.textContent, reopen.disabled, reopen.getAttribute('aria-busy')], ['Reopen', true, 'true'], 'Reopen waits with its label kept behind the spinner');
  await settle();
  assert.deepEqual(posts.at(-1), ['/_hub/reopen-board', { route: 'shop' }, 'application/json']);
  assert.match(top.innerHTML, /No closed boards/);
  assert.equal(changed, 1);
  view.unmount();
});

test("Restart on a board's row of the Hub page confirms, waits disabled with its spinner until the hub answers, then toasts; a refusal shows above the page, and the hub board has no Restart", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const site = (route, title, restart) => ({ route, title, icon: '', href: `/${route}/`, tone: 'ok', word: 'up · listening · every link passes', lines: [], remembered: [], restart });
  const hub = { hub: { tone: 'ok', word: 'healthy', detail: '2 of 2 sites up' }, integrations: [], awake: { on: false, unsupported: null }, update: { latest: null, auto: true, clone: false }, sites: '2 sites', host: 'mac',
    groups: [{ label: 'Boards', sites: [site('shop', 'The <Shop>', true), site('hub-orchestrator', 'Hub', false)] }], pause: { state: 'normal', machine: { state: 'normal', reason: null } } };
  const settings = { on: { on: true, sub: '', confirm: '' }, weekends: { on: false, sub: '' }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [] }, pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off' }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false }, closed: [] };
  const confirms = [];
  page.win.BoardDialogs.confirm = async (text, labels) => { confirms.push([text, labels?.ok]); return true; };
  const posts = [];
  let answer;
  let holdHub = null;
  page.win.fetch = (url, opts = {}) => {
    if (opts.method === 'POST') { posts.push([url, JSON.parse(opts.body)]); return new Promise((resolve) => { answer = resolve; }); }
    const body = url === '/_hub/api/hub' ? hub : settings;
    return Promise.resolve(url === '/_hub/api/hub' ? holdHub : null).then(() => ({ ok: true, headers: { get: () => null }, json: async () => structuredClone(body) }));
  };
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = page.win.AppViews.hub.markup();
  const view = page.win.AppViews.hub.create(root, 'https://mac.ts.net/_hub', { view: { kind: 'hub' }, sidebarChanged() {} });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  view.mount();
  await settle();
  const button = () => root.querySelector('[data-restart="shop"]');
  const row = () => button().closest('.row');
  assert.equal(root.querySelector('[data-restart="hub-orchestrator"]'), null);
  assert.equal(row().querySelector('a.site-link').getAttribute('href'), '/shop/');
  assert.equal(button().textContent, 'Restart');
  page.fire(root.querySelector('.hub-status'), 'click', { target: button() });
  await settle();
  assert.deepEqual(confirms, [['This stops The <Shop>’s session mid-task, along with any implementer it started, then restarts its server and resumes the session. Its tasks and threads stay. For a stuck board. Restart The <Shop>?', undefined]]);
  assert.deepEqual(posts, [['/_hub/restart-board', { route: 'shop' }]]);
  assert.equal(row().querySelector('.sub').textContent, 'restarting · stopping its session, then starting it again');
  assert.deepEqual([button().textContent, button().disabled, button().getAttribute('aria-busy')], ['Restart', true, 'true'], 'Restart waits with its label kept behind the spinner');
  let release;
  holdHub = new Promise((resolve) => { release = resolve; });
  answer({ ok: true, json: async () => ({ route: 'shop', title: 'The <Shop>', session: 'abc' }) });
  await settle();
  assert.equal(root.querySelector('.toast').textContent, 'The <Shop> is back up, and its session is listening.');
  assert.deepEqual([button().disabled, button().getAttribute('aria-busy'), row().querySelector('.sub').textContent], [true, 'true', 'restarting · stopping its session, then starting it again'], 'the answer ends the request, not the spinner: the row waits for the hub data');
  hub.groups[0].sites[0].word = 'up · restarted';
  release();
  holdHub = null;
  await settle();
  assert.deepEqual([button().textContent, button().disabled, button().getAttribute('aria-busy')], ['Restart', false, null]);
  assert.equal(row().querySelector('.sub').textContent, 'up · restarted');
  page.fire(root.querySelector('.hub-status'), 'click', { target: button() });
  await settle();
  answer({ ok: false, json: async () => ({ error: 'session 1234 did not stop' }) });
  await settle();
  assert.equal(root.querySelector('.hub-status .flash.error').textContent, 'session 1234 did not stop');
  assert.equal(button().textContent, 'Restart');
  view.unmount();
});

// docs/adr/2026-11-03-1915-every-pending-control-waits-in-one-style.md
test("a Hub page form waits on its tapped control: Codex share's tapped segment spins and the other choices are disabled, the Pause stepper's tapped step spins, and Hub Settings' toggle keeps its face, disabled, with a spinner beside it, until the hub answers", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  Element.prototype.setSelectionRange = () => {};
  page.win.document.getElementById = () => true;
  page.win.FormData = class { constructor(form) { return form.querySelectorAll('input[name]').filter((i) => !i.disabled && (i.getAttribute('type') !== 'checkbox' || i.checked)).map((i) => [i.getAttribute('name'), i.value]); } };
  const choices = (on) => ['half', 'auto', 'off'].map((value) => ({ value, label: value, on: value === on }));
  const hub = { hub: { tone: 'ok', word: 'healthy', detail: '' }, integrations: [], awake: { on: false, unsupported: null }, update: { latest: null, auto: true, clone: false }, sites: '0 sites', host: 'mac', groups: [],
    usage: {}, codex: { usable: true, share: 'auto', description: '', choices: choices('auto') }, claude: { builder: 'Opus', description: '', choices: choices('auto') },
    pause: { state: 'normal', pause_at: 90, window: 'five_hour', used: 10, resets_at: new Date(NOW).toISOString(), machine: { state: 'normal', reason: null } } };
  const settings = { on: { on: true, sub: '', confirm: '' }, weekends: { on: false, sub: '' }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [] }, pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off', choices: [] }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false }, closed: [], snooze: { choices: [] } };
  const posts = [];
  let answer;
  page.win.fetch = (url, opts = {}) => {
    if (opts.method === 'POST') { posts.push([url, String(opts.body)]); return new Promise((resolve) => { answer = resolve; }); }
    const body = url === '/_hub/api/hub' ? hub : settings;
    return Promise.resolve({ ok: true, headers: { get: () => null }, json: async () => structuredClone(body) });
  };
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = page.win.AppViews.hub.markup();
  const view = page.win.AppViews.hub.create(root, 'https://mac.ts.net/_hub', { view: { kind: 'hub', hash: '#notifications' }, sidebarChanged() {} });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  view.mount();
  await settle();
  const looks = (form) => form.querySelectorAll('button').map((b) => (b.getAttribute('aria-busy') ? 'waits' : b.disabled ? 'disabled' : 'on'));
  // The Hub page and its settings each wire their own forms, the settings over their own section.
  const submit = (form, submitter) => {
    if (submitter) submitter.name = submitter.getAttribute('name');
    page.fire(form.closest('.hub-settings') || root, 'submit', { target: form, submitter });
  };
  const ok = async () => { answer({ ok: true, json: async () => structuredClone(hub) }); await settle(); };

  const codex = () => root.querySelector('form[action="/_hub/settings/codex"]');
  submit(codex(), codex().querySelector('button[value="half"]'));
  assert.deepEqual(looks(codex()), ['waits', 'disabled', 'disabled']);
  assert.deepEqual(posts.at(-1), ['/_hub/settings/codex', 'value=half']);
  await ok();
  assert.deepEqual(looks(codex()), ['on', 'on', 'on']);

  const step = () => root.querySelector('form[action="/_hub/settings/pause-at"]');
  submit(step(), step().querySelector('button[value="95"]'));
  assert.deepEqual(looks(step()), ['disabled', 'waits']);
  await ok();
  assert.deepEqual(looks(step()), ['on', 'on']);

  const weekends = root.querySelector('.settings-modal input[type="checkbox"][data-submit]');
  weekends.checked = true;
  submit(weekends.closest('form'), null);
  assert.deepEqual([weekends.disabled, weekends.getAttribute('aria-busy'), weekends.previousSibling?.getAttribute('class')], [true, 'true', 'try-spin tap-beside']);
  assert.deepEqual(posts.at(-1), ['/_hub/settings/notifications', 'set=weekends&value=on']);
  answer({ ok: true, json: async () => structuredClone({ ...settings, weekends: { on: true, sub: '' } }) });
  await settle();
  const after = root.querySelector('.settings-modal input[type="checkbox"][data-submit]');
  assert.deepEqual([after.hasAttribute('checked'), after.disabled, after.getAttribute('aria-busy'), root.querySelectorAll('.tap-beside').length], [true, false, null, 0]);
  view.unmount();
});

test("the hub page and Hub Settings, Quiet hours among them, mounted then unmounted, load their data from the hub's API, refresh it on an interval and leave no listener or interval behind", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const urls = [];
  page.win.fetch = (url) => { urls.push(url); return Promise.reject(new Error('offline')); };
  const loaded = page.left();
  for (const [kind, view] of [['hub', { hash: '#rules' }], ['hub', { hash: '#quiet' }]]) {
    const views = page.win.AppViews;
    assert.match(views[kind].markup({ kind, ...view }), /<main class="has-top">/, kind);
    const v = views[kind].create(new page.El(), 'https://mac.ts.net/_hub', { view: { kind, ...view }, reload() {}, sidebarChanged() {} });
    v.mount();
    v.B.toast('Saved');
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
  assert.deepEqual([...new Set(urls)], ['/_hub/api/settings', '/_hub/api/hub']);
});

test("a framed page hands each load's URL and title to the shell, hides the shell's header when it draws its own, whose logo toggles the sidebar, sends taps on links to other views and its back arrow to the shell, keeps its own navigations, and leaves nothing behind", () => {
  const page = fakePage(memoryStorage().localStorage);
  const loads = [];
  const opened = [];
  const view = { kind: 'frame', route: 'learn', url: '/learn/' };
  const markup = page.win.AppViews.frame.markup(view, { siteTitle: 'Course' });
  assert.match(markup, />Open alone <svg class="link-arrow"[^>]*>[^]*<\/svg><\/a>/);
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
  assert.equal(tap(lesson, 'https://mac.ts.net/board-a/#selectedCard=w%2FA1'), true);
  assert.equal(tap(lesson, 'https://mac.ts.net/_hub/settings'), true);
  assert.equal(tap(lesson, 'https://mac.ts.net/learn/lesson-2.html', { target: '_top' }), true);
  assert.deepEqual(opened, ['https://mac.ts.net/board-a/#selectedCard=w%2FA1', 'https://mac.ts.net/_hub/settings', 'https://mac.ts.net/learn/lesson-2.html']);

  const proto = land('https://mac.ts.net/board-a/prototype-x.html?q=q1', { title: 'Prototype', header: true });
  assert.deepEqual([loads.at(-1), root.classList.contains('own-header')], [['/board-a/prototype-x.html?q=q1', 'Prototype'], true]);
  assert.equal(tap(proto, 'https://mac.ts.net/board-a/#selectedCard=w%2FA1', { cls: 'back' }), true);
  assert.deepEqual([ups, opened.length], [['/board-a/prototype-x.html?q=q1'], 3]);
  const own = land('https://mac.ts.net/learn/', { title: 'Course', header: true });
  assert.deepEqual([tap(own, 'https://mac.ts.net/_hub/', { cls: 'hub' }), toggles, opened.length], [true, 1, 3]);
  assert.equal(tap(own, 'https://mac.ts.net/_hub/', { cls: 'back' }), true);
  assert.deepEqual([ups.length, opened.at(-1)], [2, 'https://mac.ts.net/_hub/']);

  v.unmount();
  assert.deepEqual(page.left(), loaded);
});

// Event-loop turns until done() holds. A fake page's fetch and IndexedDB answer in promise jobs and event-loop turns, never
// on a clock, so a chain that hasn't finished within DRAIN_TURNS turns never will, however busy the host is.
const DRAIN_TURNS = 1000;
async function drain(done, what) {
  for (let turn = 0; !done(); turn++) {
    assert.ok(turn < DRAIN_TURNS, `${what}: not done after ${DRAIN_TURNS} event-loop turns`);
    await new Promise(setImmediate);
  }
}

// IndexedDB's object stores in memory, as it answers: asynchronously, each value a copy. rows is the boards store, pages
// the side pages'. broken: every open fails, as in a browser that refuses storage.
function memoryIndexedDB({ broken = false } = {}) {
  const stores = new Map();
  const later = (fn) => Promise.resolve().then(fn);
  const db = {
    close() {},
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) { stores.set(name, new Map()); },
    transaction(name) {
      const rows = stores.get(name);
      const tx = {};
      const ask = (fn) => { const req = {}; later(() => { req.result = fn(); tx.oncomplete?.(); }); return req; };
      tx.objectStore = () => ({ get: (k) => ask(() => structuredClone(rows.get(k))), put: (v, k) => ask(() => { rows.set(k, structuredClone(v)); }) });
      return tx;
    },
  };
  return {
    get rows() { return stores.get('boards'); },
    get pages() { return stores.get('pages'); },
    open() {
      const req = {};
      later(() => {
        if (broken) { req.error = new Error('refused'); req.onerror?.(); return; }
        req.result = db;
        if (!stores.has('pages')) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

// docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md
test("a board view keeps the board and its change number in IndexedDB, and the next mount paints that copy live and asks only for the changes since", async () => {
  const { storage, localStorage } = memoryStorage([['boardSnapshot:https://mac.ts.net/old/', 'x'], ['boardSnapshots', '[]']]);
  const page = fakePage(localStorage);
  const idb = memoryIndexedDB();
  page.win.indexedDB = idb;
  const site = 'https://mac.ts.net/board-a';
  const asked = [];
  const board = { title: 'A', version: 1762400000005, generatedAt: '2026-10-29T10:00:00.000Z', items: [{ key: 'w/A', lane: 'todo', title: 'Kept', changed: 1762400000005 }], files: [], needs: [], answers: [], owner: [], ownerTopics: [] };
  page.win.fetch = async (url) => { asked.push(url); return { ok: true, status: 200, json: async () => board }; };
  const left = page.win.BoardView.create(new page.El(), site);
  left.mount();
  await drain(() => left.B.state.board?.version === board.version, 'the first load lands');
  assert.deepEqual(asked.filter((u) => u.includes('/api/board')), [`${site}/api/board`]);
  left.unmount();
  await drain(() => idb.rows.size === 1, 'the copy saved');
  assert.equal([...idb.rows.values()][0].board.version, board.version);
  assert.deepEqual(JSON.parse(storage.get('site:board-a:copyVersion')), { build: 'build-1', version: board.version }, "app.html's boot asks since this number");
  assert.equal([...storage.keys()].some((k) => k.startsWith('boardSnapshot')), false, "the last visit's old copies in localStorage go");

  asked.length = 0;
  page.win.fetch = async (url) => { asked.push(url); return new Promise(() => {}); };
  const root = new page.El();
  const back = page.win.BoardView.create(root, site);
  back.mount();
  await drain(() => asked.some((u) => u.includes('/api/board')), 'the catch-up asked');
  assert.equal(root.dataset.board, 'fresh', 'the copy paints live, not dimmed');
  assert.equal(back.B.state.board.items[0].title, 'Kept');
  assert.deepEqual(asked.filter((u) => u.includes('/api/board')), [`${site}/api/board?since=${board.version}`]);
  back.unmount();

  page.win.document.documentElement.dataset.build = 'build-2';
  asked.length = 0;
  const other = new page.El();
  const rebuilt = page.win.BoardView.create(other, site);
  rebuilt.mount();
  await drain(() => asked.some((u) => u.includes('/api/board')), 'the load asked');
  assert.deepEqual([other.dataset.board, asked.filter((u) => u.includes('/api/board'))], [undefined, [`${site}/api/board`]], 'a copy saved under another build is no copy');
  rebuilt.unmount();
});

// docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md
test("with no copy to show, a board out of reach shows the landing for its state, retries every 5 s while it can come back, and the board takes its place once it answers", async () => {
  const page = fakePage(memoryStorage().localStorage);
  page.win.indexedDB = memoryIndexedDB();
  const board = { title: 'A', version: 7, generatedAt: '2026-10-29T10:00:00.000Z', items: [{ key: 'w/A', lane: 'todo', title: 'Kept', changed: 7 }], files: [], needs: [], answers: [], owner: [], ownerTopics: [] };
  let answer = { ok: false, status: 502, headers: new Headers({ 'x-kickflip-down': 'stopped' }), json: async () => { throw new Error('html'); } };
  const asked = [];
  page.win.fetch = async (url) => { asked.push(url); return answer; };
  const root = new page.El();
  const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a');
  view.mount();
  const landing = root.querySelector('#downLanding');
  await drain(() => root.classList.contains('down'), 'the landing shows');
  assert.equal(landing.hidden, false);
  assert.match(landing.innerHTML, /data-down="stopped"/);
  assert.match(landing.innerHTML, /Board stopped/);
  assert.deepEqual([root.classList.contains('down'), root.classList.contains('offline'), root.dataset.board], [true, true, undefined]);

  answer = { ok: false, status: 404, headers: new Headers({ 'x-kickflip-down': 'removed' }), json: async () => ({}) };
  page.runIntervals(5000);
  await drain(() => /This board is gone/.test(landing.innerHTML), 'the retry reads the new state');
  const sent = asked.length;
  page.runIntervals(5000);
  assert.equal(asked.length, sent, 'nothing brings a removed board back by itself');

  answer = { ok: true, status: 200, json: async () => board };
  await view.B.loadBoard();
  assert.deepEqual([landing.hidden, root.classList.contains('down'), root.classList.contains('offline'), root.dataset.board], [true, false, false, 'fresh']);
  view.unmount();
});

// docs/adr/2026-11-12-0400-a-board-that-throws-while-drawing-shows-a-landing-with-the-error.md
test('a board that throws while drawing shows the landing with the error and an online header, reports it to the console, and the next clean draw clears it', async () => {
  const page = fakePage(memoryStorage().localStorage);
  page.win.indexedDB = memoryIndexedDB();
  const good = { title: 'A', version: 7, generatedAt: '2026-10-29T10:00:00.000Z', items: [{ key: 'w/A', lane: 'todo', title: 'Kept', changed: 7 }], files: [], needs: [], answers: [], owner: [], ownerTopics: [] };
  const bad = { ...good, version: 8, generatedAt: '2026-10-29T10:01:00.000Z', items: [{ ...good.items[0], prs: 'not a list' }] };
  let answer = bad;
  page.win.fetch = async () => ({ ok: true, status: 200, json: async () => answer });
  let reloads = 0;
  page.win.location.reload = () => { reloads++; };
  const logged = [];
  page.win.console = { error: (...args) => logged.push(args), log() {}, warn() {} };
  const root = new page.El();
  const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a');
  try {
    view.mount();
    const landing = root.querySelector('#downLanding');
    await drain(() => root.classList.contains('down'), 'the landing shows');
    assert.equal(landing.hidden, false);
    assert.match(landing.innerHTML, /data-down="draw"/);
    assert.match(landing.innerHTML, /This board couldn&#39;t draw|This board couldn’t draw|This board couldn't draw/);
    assert.match(landing.innerHTML, /The board loaded, but it threw while drawing\. Your data is fine\./);
    assert.match(landing.innerHTML, /TypeError/);
    assert.doesNotMatch(landing.innerHTML, /Reported/);
    assert.deepEqual([view.B.state.link, root.classList.contains('offline')], ['online', false], 'the header stays online');
    assert.equal(logged.length > 0, true, 'console.error got the throw');
    assert.match(landing.innerHTML, /<button type="button" data-draw="reload">Reload<\/button> <button type="button" data-draw="copy">Copy error<\/button>/);
    page.fire(root, 'click', { target: { closest: (sel) => (sel.includes('data-draw') ? { dataset: { draw: 'reload' } } : null) } });
    assert.equal(reloads, 1);

    answer = { ...good, version: 9, generatedAt: '2026-10-29T10:02:00.000Z' };
    await view.B.loadBoard();
    assert.deepEqual([landing.hidden, root.classList.contains('down')], [true, false], 'a clean draw clears the landing');
  } finally {
    view.unmount();
  }
});

test("out of reach with nothing on screen, the board paints the copy another build saved and asks for the whole board once it answers; a copy whose paint throws leaves the landing", async () => {
  const site = 'https://mac.ts.net/board-a';
  const board = { title: 'A', version: 7, generatedAt: '2026-10-29T10:00:00.000Z', items: [{ key: 'w/A', lane: 'todo', title: 'Kept', changed: 7 }], files: [], needs: [], answers: [], owner: [], ownerTopics: [] };
  for (const saved of [board, { ...board, items: [{ key: 'w/A', lane: 'todo', title: 'Kept', changed: 7, prs: 'not a list' }] }]) {
    const page = fakePage(memoryStorage().localStorage);
    const idb = memoryIndexedDB();
    page.win.indexedDB = idb;
    page.win.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const root = new page.El();
    const view = page.win.BoardView.create(root, site);
    view.mount();
    await drain(() => root.classList.contains('down'), 'the landing shows');
    view.unmount();
    idb.rows.set(`${site}/`, { build: 'build-0', savedAt: board.generatedAt, board: saved, threads: {} });

    const asked = [];
    page.win.fetch = async (url) => { asked.push(url); throw new TypeError('Failed to fetch'); };
    const again = new page.El();
    const back = page.win.BoardView.create(again, site);
    back.mount();
    await drain(() => asked.length > 0 && (again.dataset.board === 'fresh' || again.classList.contains('down')), 'the old copy paints or the landing shows');
    await new Promise((r) => setImmediate(r));
    if (saved === board) {
      assert.deepEqual([again.dataset.board, back.B.state.link, again.classList.contains('down')], ['fresh', 'offline', false], 'the older copy paints, out of reach');
      asked.length = 0;
      await back.B.loadBoard();
      assert.deepEqual(asked, [`${site}/api/board`], 'the next load asks for the whole board');
    } else {
      assert.deepEqual([again.dataset.board, again.classList.contains('down')], [undefined, true], 'a paint that throws leaves the landing');
    }
    back.unmount();
  }
});

// docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md
test("out of reach, Notes show their last answer here under its copy line, or with none the landing for why", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const idb = memoryIndexedDB();
  page.win.indexedDB = idb;
  const notes = { ref: 'INT-1', markdown: '# Plan\n\nKeep the strip.' };
  page.win.fetch = async (url) => { const body = url.includes('/api/notes') ? notes : { items: [] }; return { ok: true, status: 200, text: async () => JSON.stringify(body) }; };
  const open = (item) => {
    const root = new page.El();
    const view = page.win.AppViews.notes.create(root, 'https://mac.ts.net/board-a', { view: { kind: 'notes', route: 'board-a', item } });
    view.mount();
    return { root, view, plan: root.querySelector('#plan') };
  };
  const live = open('w/A1');
  await drain(() => idb.pages?.size === 1, 'the answer saved');
  assert.doesNotMatch(live.plan.innerHTML, /copy-note/);
  live.view.unmount();

  page.win.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const copy = open('w/A1');
  await drain(() => /Keep the strip/.test(copy.plan.innerHTML), 'the copy shows');
  assert.match(copy.plan.innerHTML, /<p class="note copy-note">Copy of the notes as of just now\. Read only\.<\/p>/);
  copy.view.unmount();
  const none = open('w/B2');
  await drain(() => /down-landing/.test(none.plan.innerHTML), 'the landing shows');
  assert.match(none.plan.innerHTML, /Board offline/);
  none.view.unmount();
});

test("out of reach, Waiting on you paints the board's copy with its sending buttons held, or with none the landing", async () => {
  const site = 'https://mac.ts.net/board-a';
  const q = { id: 'q1', topic: 't1', state: 'open', title: 'Which look?', options: [{ id: 'a', label: 'A' }], answers: [], source: 'w/A1' };
  const board = { title: 'A', version: 7, generatedAt: '2026-10-29T10:00:00.000Z', items: [], files: [], needs: [], answers: [], owner: [q],
    ownerTopics: [{ id: 't1', title: 'Look', state: 'open', questions: ['q1'], open: 1, answered: 0, resolved: 0 }] };
  for (const saved of [true, false]) {
    const page = fakePage(memoryStorage().localStorage);
    const idb = memoryIndexedDB();
    page.win.indexedDB = idb;
    if (saved) {
      await page.win.BoardUI.copyStore('boards', 'readwrite', (store) => store.put({ build: 'build-1', savedAt: board.generatedAt, board, threads: {} }, `${site}/`));
    }
    page.win.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const root = new page.El();
    const view = page.win.AppViews.questions.create(root, site, { view: { kind: 'questions', route: 'board-a' } });
    view.mount();
    const pageEl = root.querySelector('#page');
    await drain(() => pageEl.innerHTML !== '', 'the page paints');
    assert.equal(root.classList.contains('offline'), true);
    if (saved) assert.match(pageEl.innerHTML, /<section class="q" id="q1"/);
    else assert.match(pageEl.innerHTML, /down-landing.*Board offline/s);
    const send = { closest: (sel) => (sel === page.win.BoardUI.SENDS ? send : null) };
    assert.equal(page.fire(root, 'click', { target: send }).defaultPrevented, true, 'a sending tap is held');
    view.unmount();
  }
});

test('Waiting on you opens again on the topic it last showed while that topic has an open question, and the first open topic once it has none', async () => {
  const topics = [1, 2].map((n) => ({ id: `item:w/T${n}`, title: `INT-${n}: Topic` }));
  const question = (id, topic) => ({ id, topic, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }], answers: [], state: 'open' });
  const v = questionsOnDom({ topics, questions: [question('q1', topics[0].id), question('q2', topics[1].id)], at: '' });
  await v.settle();
  assert.deepEqual(v.shown().questions, ['q1'], 'a first visit opens the first open topic');
  v.page.fire(v.root, 'click', { target: v.root.querySelector(`button[data-topic="${topics[1].id}"]`) });
  assert.deepEqual(v.shown().questions, ['q2']);
  v.remount();
  await v.settle();
  assert.deepEqual(v.shown().questions, ['q2'], 'a return opens the topic last shown');
  v.server.questions.find((q) => q.id === 'q2').state = 'resolved';
  v.remount();
  await v.settle();
  assert.deepEqual(v.shown().questions, ['q1'], 'a topic with no open question is not kept');
  v.unmount();
});

test("Waiting on you paints the board's saved copy at once, then asks only for the changes since its number", async () => {
  const site = 'https://mac.ts.net/board-a';
  const q = (id, title) => ({ id, topic: 't1', state: 'open', title, question: title, options: [{ id: 'a', label: 'A' }], answers: [], source: 'w/A1' });
  const topic = (qs) => ({ id: 't1', title: 'Look', state: 'open', questions: qs.map((x) => x.id), open: qs.length, answered: 0, resolved: 0 });
  const saved = { title: 'A', version: 7, generatedAt: '2026-10-29T10:00:00.000Z', items: [], files: [], needs: [], answers: [], owner: [q('q1', 'Saved one')], ownerTopics: [topic([q('q1', 'Saved one')])] };
  const page = fakePage(memoryStorage().localStorage);
  page.win.indexedDB = memoryIndexedDB();
  await page.win.BoardUI.copyStore('boards', 'readwrite', (store) => store.put({ build: 'build-1', savedAt: saved.generatedAt, board: saved, threads: {} }, `${site}/`));
  const asked = [];
  let answer;
  page.win.fetch = (url) => { asked.push(url); return new Promise((resolve) => { answer = resolve; }); };
  const root = new page.El();
  const view = page.win.AppViews.questions.create(root, site, { view: { kind: 'questions', route: 'board-a' } });
  view.mount();
  const pageEl = root.querySelector('#page');
  const arrived = [];
  root.querySelector('#qform').querySelector('.bar').insertAdjacentHTML = (where, html) => arrived.push(html);
  await drain(() => asked.length > 0, 'the load asks');
  assert.match(pageEl.innerHTML, /id="q1"/, 'the copy is drawn before the host answers');
  assert.equal(root.classList.contains('offline'), false);
  assert.match(asked[0], /\/api\/board\?since=7$/);
  const next = { ...saved, version: 8, owner: [q('q1', 'Saved one'), q('q2', 'Fresh two')], ownerTopics: [topic([q('q1', 'Saved one'), q('q2', 'Fresh two')])] };
  answer({ ok: true, status: 200, text: async () => JSON.stringify(next), json: async () => next });
  await drain(() => arrived.some((html) => /Fresh two/.test(html)), 'the answer lands as a new card');
  view.unmount();
});

test("out of reach, Board Settings shows each part's last answer here, read only under its copy line, and reopens live once the board answers", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const idb = memoryIndexedDB();
  page.win.indexedDB = idb;
  page.win.fetch = async (url) => { const body = url.endsWith('/api/board') ? { kind: 'web' } : url.endsWith('/api/settings') ? { settings: { auto_build: true } } : {}; return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }; };
  const live = page.win.AppViews.settings.create(new page.El(), '/orch', {});
  live.mount();
  await drain(() => idb.pages?.has('https://mac.ts.net/orch/api/settings'), 'the answers saved');
  live.unmount();

  const answers = page.win.fetch;
  page.win.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const root = new page.El();
  const notes = [];
  root.querySelector('.settings-body').insertAdjacentHTML = (where, html) => notes.push(html);
  let reloads = 0;
  const view = page.win.AppViews.settings.create(root, '/orch', { reload: () => { reloads++; } });
  view.mount();
  const toggle = root.querySelector('#autoBuild');
  await drain(() => toggle.checked === true, 'the copy fills the toggle');
  assert.equal(root.querySelector('.settings-body').inert, true);
  assert.deepEqual(notes.map((h) => h.replace(/<[^>]+>/g, '')), ['Copy of Settings as of just now. Read only.']);
  page.runIntervals(5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(reloads, 0);
  page.win.fetch = answers;
  page.runIntervals(5000);
  await drain(() => reloads === 1, 'it reopens live');
  view.unmount();
});

// docs/adr/2026-11-13-0230-a-card-reference-is-drawn-by-one-helper-with-its-lane-ring.md
// docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md
test("a whole board carries no threads, so every card's thread loads after it, and the saved copy keeps them all; the next mount opens any card from the copy with no request", async () => {
  const { localStorage } = memoryStorage();
  const page = fakePage(localStorage);
  page.win.indexedDB = memoryIndexedDB();
  const site = 'https://mac.ts.net/board-a';
  const lanes = ['review', 'progress', 'todo', 'todo', 'done', 'done'];
  const items = lanes.map((lane, n) => ({ key: `w/${n}`, id: String(n), ref: String(n), kind: 'work', lane, title: `Card ${n}`, deps: [], manualSteps: [], othersAt: [] }));
  const board = { title: 'A', version: 1762400000005, generatedAt: '2026-10-29T10:00:00.000Z', items, files: [], needs: [], answers: [], owner: [], ownerTopics: [] };
  const threadOf = (key) => [{ ts: '2026-10-29T09:00:00.000Z', who: 'claude', text: `Thread of ${key}` }];
  const asked = [];
  page.win.fetch = async (url) => {
    asked.push(url);
    const key = new URL(url).searchParams.get('key');
    return { ok: true, status: 200, json: async () => (key ? threadOf(key) : board) };
  };
  const left = page.win.BoardView.create(new page.El(), site);
  left.mount();
  await drain(() => items.every((i) => left.B.state.threadCache.has(i.key)), "every card's thread loads, Done's too");
  assert.deepEqual(asked.filter((u) => u.includes('/api/thread')).map((u) => new URL(u).searchParams.get('key')).sort(), items.map((i) => i.key));
  left.unmount();

  asked.length = 0;
  page.win.fetch = async (url) => { asked.push(url); return new Promise(() => {}); };
  const { Element } = miniDom(page.Target, page.win.document);
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = page.win.BoardView.markup({ title: 'A' });
  const back = page.win.BoardView.create(root, site);
  back.mount();
  await drain(() => root.dataset.board === 'fresh', 'the copy paints');
  const card = root.querySelector('details.item[data-key="w/5"]');
  card.open = true;
  page.fire(root, 'toggle', { target: card });
  await drain(() => root.querySelector('[data-thread="w/5"]')?.dataset.sig, 'the Done card opens');
  assert.match(root.querySelector('[data-thread="w/5"]').dataset.sig, /Thread of w\/5/, 'its thread draws from the copy');
  assert.deepEqual(asked.filter((u) => !u.includes('/api/board')), [], 'opening the card asked for nothing');
  back.unmount();
});

test("a patch carries the lines added to a card's thread since the page's number: the open card draws them with the board, a closed card opens with them, and nothing asks for a thread", async () => {
  const v1 = { ...boardOf([workCard('A1', { lane: 'progress' }), workCard('A2')]), version: 'v1' };
  const v2 = { ...v1, generatedAt: '2026-10-30T10:00:01.000Z', version: 'v2' };
  const said = (n, text) => ({ ts: `2026-10-30T09:0${n}:00.000Z`, who: 'claude', text });
  const before = { 'w/A1': [said(1, 'One')], 'w/A2': [said(1, 'Uno')] };
  const b = boardOnDom({ open: ['w/A1'], board: v1, threads: before });
  b.server.held = { v1 };
  b.server.heldThreads = { v1: before };
  await drain(() => b.view.B.state.threadCache.size === 2, 'the whole board loads both threads');
  const threadGets = () => b.gets.filter((p) => p.endsWith('/api/thread')).length;
  const loaded = threadGets();
  const shown = (key) => b.root.querySelector(`[data-thread="${key}"] .msgs`).textContent;
  await b.change({ board: v2, threads: { 'w/A1': [said(1, 'One'), said(2, 'Two')], 'w/A2': [said(1, 'Uno'), said(2, 'Dos')] } });
  assert.deepEqual([b.patched, b.view.B.state.board.version], [['v1'], 'v2']);
  assert.match(shown('w/A1'), /One[\s\S]*Two/);
  const card = b.root.querySelector('details.item[data-key="w/A2"]');
  card.open = true;
  b.page.fire(b.root, 'toggle', { target: card });
  await b.settle();
  assert.match(shown('w/A2'), /Uno[\s\S]*Dos/);
  assert.equal(threadGets(), loaded, 'no thread was fetched after the first load');
  b.view.unmount();
});

// docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md: only a whole board's load fetches the open threads beside it.
test("an open card's thread that answers before its whole board waits for that board to land, so a Created ticket line and the ticket badge draw together", async () => {
  const page = fakePage(memoryStorage([['site:board-a:openItems', JSON.stringify(['hub/T-2'])]]).localStorage);
  const site = 'https://mac.ts.net/board-a';
  const item = (ticket) => ({ key: 'hub/T-2', id: 'T-2', ref: ticket || 'T-2', ticket: ticket ? { id: ticket } : null, lane: 'todo', title: 'Two', kind: 'work' });
  const boardOf = (version, ticket) => ({ title: 'A', version, generatedAt: `2026-11-12T23:3${version}:00.000Z`, items: [item(ticket)], files: [], needs: [], answers: [], owner: [], ownerTopics: [] });
  const made = [{ ts: '2026-11-12T23:34:09.229Z', who: 'claude', kind: 'hub', line: 'ticket-made', mark: 'Created ticket', words: 'Created ticket', card: 'hub/T-2', text: 'Created ticket #631', link: '#selectedCard=hub%2FT-2' }];
  const answer = (body) => ({ ok: true, status: 200, json: async () => body });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let threadAnswered = false;
  page.win.fetch = async (url) => {
    if (url.includes('/api/thread')) { threadAnswered = true; return answer(made); }
    await held;
    return answer(boardOf(2, '#631'));
  };
  const view = page.win.BoardView.create(new page.El(), site);
  view.mount();
  const loading = drain(() => view.B.state.board?.version === 2, 'the board lands');
  await drain(() => threadAnswered, 'the thread answered');
  await new Promise((resolve) => setImmediate(resolve));
  assert.notDeepEqual(view.B.state.threadCache.get('hub/T-2'), made, 'the line waits for its board');
  release();
  await loading;
  assert.deepEqual([view.B.state.board.items[0].ref, view.B.state.threadCache.get('hub/T-2')], ['#631', made]);
  view.unmount();
});

test("where IndexedDB refuses or is missing, the board view loads the whole board and paints nothing until it lands", async () => {
  for (const indexedDB of [memoryIndexedDB({ broken: true }), undefined]) {
    const page = fakePage(memoryStorage().localStorage);
    if (indexedDB) page.win.indexedDB = indexedDB;
    const asked = [];
    page.win.fetch = async (url) => { asked.push(url); return new Promise(() => {}); };
    const root = new page.El();
    const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a');
    view.mount();
    await drain(() => asked.length > 0, 'the load asked');
    assert.deepEqual([root.dataset.board, asked.filter((u) => u.includes('/api/board'))], [undefined, ['https://mac.ts.net/board-a/api/board']]);
    view.unmount();
  }
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

test("the page header's logo toggles the sidebar at every width: from 900px it collapses and restores the rail, which this device remembers, and the rail's own logo hides it; narrower, it opens and closes the drawer; it shows no count, and its label says what waits on the other sites", () => {
  const { storage, localStorage } = memoryStorage();
  const handlers = [];
  const classes = (set = new Set()) => ({ set, add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on = !set.has(c)) => { if (on) set.add(c); else set.delete(c); return on; } });
  const el = () => ({ classList: classes(), attrs: {}, kids: [], innerHTML: '', scrollTop: 0, addEventListener() {}, querySelectorAll: () => [],
    setAttribute(k, v) { this.attrs[k] = v; }, querySelector(sel) { return this.kids.find((k) => k.className === sel.slice(1)) || null; },
    append(k) { this.kids.push(k); }, closest: () => null });
  const aside = el();
  const list = { scrollTop: 150, scrollHeight: 1200 };
  const update = { innerHTML: '', replaceWith() {} };
  aside.querySelector = (sel) => sel === '.sb-scroll' ? list : sel === '.sb-update' ? update : null;
  const scrim = el();
  const logo = el();
  const html = el();
  const wide = { matches: true, addEventListener() {} };
  const win = { localStorage, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, navigator: { userAgent: 'Mac' }, URL,
    matchMedia: (q) => (q === '(min-width: 900px)' ? wide : { matches: false }),
    fetch: () => new Promise(() => {}),
    document: { documentElement: html, hidden: false, getElementById: (id) => ({ sidebar: aside, sidebarScrim: scrim })[id] || null,
      querySelectorAll: (sel) => (sel === '.top a.hub' ? [logo] : []), createElement: () => Object.assign(el(), { className: '', textContent: '' }),
      addEventListener: (type, fn) => handlers.push({ type, fn }) } };
  win.window = win;
  vm.createContext(win);
  for (const file of ['ui-progress-bar.js', 'ui-page-header.js', 'ui-sidebar.js', 'sidebar.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
  const data = { sites: [{ route: 'a', title: 'A', board: true, count: 1 }, { route: 'b', title: 'B', board: true, count: 2 }, { route: 'learn', title: 'Learn', board: false, count: 0 }] };
  const sidebar = win.Sidebar.mount({ here: 'a', data, poll: false });
  assert.equal(list.scrollTop, 1200);
  const tap = (target) => { for (const h of handlers.filter((x) => x.type === 'click')) h.fn({ target: { closest: (sel) => (sel === target ? (sel === '.top a.hub' ? logo : {}) : null) }, preventDefault() {} }); };
  const state = () => ({ collapsed: html.classList.contains('sb-collapsed'), stored: storage.get('hub:sidebarCollapsed') ?? null, drawer: aside.classList.contains('open') });

  assert.deepEqual(state(), { collapsed: false, stored: null, drawer: false });
  assert.equal(logo.kids.length, 0);
  assert.equal(logo.attrs['aria-label'], 'Boards, 2 waiting on other boards');
  sidebar.setUpdate('ready');
  assert.equal(logo.attrs['aria-label'], 'Boards, new version ready, 2 waiting on other boards');
  sidebar.setUpdate(null);
  assert.equal(logo.attrs['aria-label'], 'Boards, 2 waiting on other boards');
  // The row names the hub's version once it differs from the one the page booted on, and says New version while it is the same.
  sidebar.setData({ ...data, version: '0.5.0' });
  sidebar.setUpdate('ready');
  assert.match(update.innerHTML, /sb-title">New version</);
  sidebar.setData({ ...data, version: '0.5.1' });
  assert.match(update.innerHTML, /sb-title">v0\.5\.1</);
  sidebar.setUpdate(null);
  tap('[data-sidebar-close]');
  assert.deepEqual(state(), { collapsed: true, stored: '1', drawer: false });
  tap('.top a.hub');
  assert.deepEqual(state(), { collapsed: false, stored: '0', drawer: false });
  tap('.top a.hub');
  wide.matches = false;
  tap('.top a.hub');
  assert.deepEqual(state(), { collapsed: true, stored: '1', drawer: true });
  assert.equal(list.scrollTop, 1200);
  list.scrollTop = 420;
  sidebar.setData(data);
  assert.equal(list.scrollTop, 420);
  tap('.top a.hub');
  assert.deepEqual(state(), { collapsed: true, stored: '1', drawer: false });
  tap('.top a.hub');
  tap('[data-sidebar-close]');
  assert.deepEqual(state(), { collapsed: true, stored: '1', drawer: false });

  html.classList.set.clear();
  win.Sidebar.mount({ here: 'a', data, poll: false });
  assert.equal(html.classList.contains('sb-collapsed'), true);
});

async function shellPage(path, { fetch, sidebarData = { sites: [{ route: 'shop', title: 'The Shop', board: true, icon: '' }, { route: 'other', title: 'Other', board: true, icon: '' }] },
  EventSource, reload, storage = memoryStorage(), realBoards = false, width = 390 } = {}) {
  const page = fakePage(storage.localStorage);
  const { win } = page;
  // One media query object per query, so a test can fire the shell's own 'change' after moving innerWidth.
  win.innerWidth = width;
  const media = new Map();
  win.matchMedia = (query) => {
    if (!media.has(query)) media.set(query, Object.defineProperty(new page.Target(), 'matches', { get: () => query === '(min-width: 900px)' && win.innerWidth >= 900 }));
    return media.get(query);
  };
  const resize = (w) => { win.innerWidth = w; page.fire(win.matchMedia('(min-width: 900px)'), 'change'); };
  const doc = win.document;
  if (fetch) win.fetch = fetch;
  if (EventSource) win.EventSource = EventSource;
  const { Element } = miniDom(page.Target, doc);
  doc.head = new Element('head');
  Object.defineProperty(Element.prototype, 'className', { get() { return this.getAttribute('class') || ''; }, set(value) { this.setAttribute('class', value); } });
  Object.defineProperty(Element.prototype, 'href', { get() { return new URL(this.getAttribute('href'), win.location.href).href; } });
  doc.body.innerHTML = '<aside id="sidebar" class="sidebar"></aside><div id="sidebarScrim"></div><script id="sidebarData" type="application/json"></script>';
  doc.getElementById = (id) => doc.body.querySelector(`#${id}`);
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  doc.getElementById('sidebarData').textContent = JSON.stringify(sidebarData);
  const scrim = doc.getElementById('sidebarScrim');
  scrim.after = (root) => doc.body.insertBefore(root, scrim.nextSibling);
  let entries = [{ href: `https://mac.ts.net${path}`, state: null }];
  let at = 0;
  const locate = (url) => { win.location = new URL(url, win.location.href); if (reload) win.location.reload = reload; };
  locate(entries[0].href);
  const write = (state, url) => {
    locate(url || win.location.href);
    entries[at] = { href: win.location.href, state };
  };
  win.history = {
    get state() { return entries[at].state; },
    replaceState: (state, _, url) => write(state, url),
    pushState(state, _, url) { entries = entries.slice(0, ++at); write(state, url); },
    go(n) { at += n; locate(entries[at].href); page.fire(win, 'popstate', { state: entries[at].state }); },
    back() { this.go(-1); },
  };
  win.scrollTo = () => {};
  win.addEventListener = win.addEventListener.bind(win);
  win.removeEventListener = win.removeEventListener.bind(win);
  win.HashChangeEvent = class { constructor(type) { this.type = type; } };
  win.dispatchEvent = (e) => page.fire(win, e.type, e);
  win.top = win;
  vm.runInContext(fs.readFileSync(new URL('./public/shell.js', import.meta.url), 'utf8'), win);
  let boardUnmounts = 0;
  if (!realBoards) win.BoardView.create = () => ({ B: { state: {} }, mount() {}, unmount() { boardUnmounts++; } });
  await win.AppShell.start();
  const tap = (a) => page.fire(doc, 'click', { target: a, button: 0 });
  return { page, win, doc, tap, resize, selected: () => doc.querySelectorAll('.sb-row[aria-current="page"]').map((a) => a.getAttribute('href')),
    entries: () => entries, position: () => at, boardUnmounts: () => boardUnmounts };
}

test("the browser's scroll restore stays on, and is off only for the reload an update triggers, until that page is left", async () => {
  const { win, doc, page } = await shellPage('/shop/');
  assert.notEqual(win.history.scrollRestoration, 'manual');
  win.AppShell.codeSeen('boot');
  win.AppShell.codeSeen('new');
  page.fire(doc.getElementById('sidebar'), 'click', { target: doc.querySelector('[data-app-reload]') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(win.history.scrollRestoration, 'manual');
  page.fire(win, 'pagehide');
  assert.equal(win.history.scrollRestoration, 'auto');
});

test('a tap, key or scroll tells the hub the owner is here: at once while away, which drops the moon on this page, then at most once a minute', async () => {
  const beats = [];
  let statusPaints = 0;
  const sites = [{ route: 'shop', title: 'The Shop', board: true, icon: '' }];
  const { page, win } = await shellPage('/shop/', {
    sidebarData: { sites, away: true },
    fetch: (url, opts) => { if (url === '/_hub/presence') { beats.push(opts.method); return Promise.resolve({ ok: true }); } return new Promise(() => {}); },
  });
  win.BoardView.create = () => ({ B: { state: {}, renderStatus: () => statusPaints++ }, mount() {}, unmount() {} });
  win.AppShell.open('/other/'); win.AppShell.open('/shop/');
  const painted = statusPaints;
  page.fire(win, 'pointerdown');
  assert.deepEqual(beats, ['POST']);
  assert.equal(statusPaints, painted + 1);
  for (const type of ['keydown', 'scroll', 'pointerdown']) page.fire(win, type);
  assert.deepEqual(beats, ['POST']);
});

test('while a text field is focused the page is typing, and only the + button is disabled', async () => {
  const { page, doc } = await shellPage('/shop/');
  const html = doc.documentElement;
  const field = { matches: (sel) => sel.includes('textarea') };
  page.fire(doc, 'focusin', { target: field });
  assert.equal(html.classList.contains('typing'), true);
  page.fire(doc, 'focusout', { target: field });
  assert.equal(html.classList.contains('typing'), false);
  // A radio or a button never starts it.
  page.fire(doc, 'focusin', { target: { matches: () => false } });
  assert.equal(html.classList.contains('typing'), false);
});

test('the shell uses the inline or fetched boot code, adopts the first live code for cached or unversioned data, and keeps its update row across sidebar events', async () => {
  for (const boot of ['inline', 'fetched', 'cached', 'unversioned']) {
    const storage = memoryStorage([['hub:sidebar', JSON.stringify({ code: 'stored', sites: [] })]]);
    const data = { code: 'boot', sites: [] };
    const sources = [];
    class EventSource {
      static CLOSED = 2;
      constructor() { this.readyState = 1; this.listeners = new Map(); sources.push(this); }
      addEventListener(type, fn) { this.listeners.set(type, fn); }
      close() { this.readyState = EventSource.CLOSED; }
    }
    let reloads = 0;
    const { win, doc, page } = await shellPage('/_hub/', {
      sidebarData: boot === 'inline' ? data : boot === 'unversioned' ? { sites: [] } : null,
      fetch: (url) => url === '/_hub/sidebar.json'
        ? boot === 'cached' ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true, json: async () => data })
        : new Promise(() => {}),
      EventSource, storage, reload: () => reloads++,
    });
    const region = doc.querySelector('.sb-update');
    const logo = doc.querySelector('.view-hub .top a.hub');
    logo.focus();
    win.AppShell.codeSeen('');
    win.AppShell.codeSeen(null);
    const first = boot === 'inline' || boot === 'fetched' ? 'boot' : 'first live';
    sources[0].listeners.get('sidebar')({ data: JSON.stringify({ code: first, sites: [] }) });
    assert.equal(region.innerHTML, '', boot);
    win.fetch = async () => new Response(JSON.stringify({ version: 'new' }), { headers: { 'x-hub-code': 'new' } });
    let paints = 0;
    const live = win.BoardView.page(doc.createElement('div'), '/_hub', (B) => win.HubKit.live(B, {
      url: () => '/_hub/api/hub',
      paint(data) { assert.equal(data.version, 'new'); assert.ok(region.querySelector('[data-app-reload]')); paints++; },
    }));
    live.mount();
    await drain(() => paints, 'the header code check before paint');
    live.unmount();
    const button = region.querySelector('[data-app-reload]');
    assert.ok(button, boot);
    assert.equal(doc.activeElement, logo);
    assert.equal(logo.getAttribute('aria-label'), 'Boards, new version ready');
    sources[0].listeners.get('sidebar')({ data: JSON.stringify({ code: 'newer', sites: [] }) });
    win.AppShell.codeSeen(first);
    assert.equal(doc.querySelector('.sb-update'), region);
    assert.equal(region.querySelector('[data-app-reload]'), button);
    assert.equal(reloads, 0);
    page.fire(doc.getElementById('sidebar'), 'click', { target: button });
    assert.deepEqual([region.querySelector('.sb-go').textContent, region.querySelector('[data-app-reload]').getAttribute('aria-busy')], ['Reload', 'true']);
    assert.ok(region.querySelector('[data-app-reload]').disabled);
    page.runTimers(0);
    assert.equal(reloads, 1);
  }
});

test('a reload forgets the saved shell and waits for the worker reply or one second, keeping the URL and dirty-view guard', async () => {
  for (const responds of [true, false]) {
    let reloads = 0;
    const { win, doc, page } = await shellPage('/shop/#selectedCard=w%2FA1', { reload: () => reloads++ });
    let reply;
    let closed = 0;
    const sent = [];
    win.MessageChannel = class {
      constructor() {
        const port1 = this.port1 = { close: () => closed++ };
        this.port2 = { close: () => closed++, postMessage: (data) => port1.onmessage?.({ data }) };
      }
    };
    win.navigator.serviceWorker = { controller: { postMessage: (data, [port]) => { sent.push({ ...data }); reply = port; } } };
    const dirty = doc.createElement('form');
    dirty.setAttribute('data-dirty', '');
    doc.querySelector('.view-board').appendChild(dirty);
    assert.ok(page.fire(win, 'beforeunload').defaultPrevented);
    win.AppShell.codeSeen('boot');
    win.AppShell.codeSeen('new');
    const region = doc.querySelector('.sb-update');
    page.fire(doc.getElementById('sidebar'), 'click', { target: region.querySelector('[data-app-reload]') });
    assert.deepEqual(sent, [{ forget: 'shell' }]);
    assert.ok(region.querySelector('[data-app-reload]').disabled);
    assert.deepEqual([region.querySelector('.sb-go').textContent, region.querySelector('[data-app-reload]').getAttribute('aria-busy')], ['Reload', 'true']);
    page.runTimers(999);
    assert.equal(reloads, 0);
    if (responds) reply.postMessage({ forgot: true }); else page.runTimers(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reloads, 0);
    assert.equal(closed, 2);
    page.runTimers(0);
    page.runTimers(1000);
    assert.equal(reloads, 1);
    assert.equal(win.location.pathname + win.location.hash, '/shop/#selectedCard=w%2FA1');
  }
});

test('an open shell shows new hub code before the next Hub paint and reloads only on a tap', async (t) => {
  const dir = web;
  const streams = new Set();
  t.after(() => { for (const stream of streams) stream.close(); });
  write(path.join(dir, 'manifest.json'), { version: 1, sites: {} });
  const hub = await inProcessHub(t);
  const base = hub.base;
  // Resolves on the stream's first sidebar event.
  let heard;
  const received = new Promise((resolve) => { heard = resolve; });
  class EventSource {
    static CLOSED = 2;
    constructor(url) {
      this.readyState = 0;
      this.listeners = new Map();
      streams.add(this);
      const drop = () => {
        if (this.readyState === EventSource.CLOSED) return;
        this.readyState = EventSource.CLOSED;
        this.emit('error', {});
      };
      this.req = http.get(new URL(url, base), (res) => {
        this.res = res;
        this.readyState = 1;
        this.emit('open', {});
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk.replace(/\r\n/g, '\n');
          for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const type = /^event: ?(.+)$/m.exec(block)?.[1];
            const data = /^data: ?(.+)$/m.exec(block)?.[1];
            if (type === 'sidebar') heard();
            if (type && data) this.emit(type, { data });
          }
        });
        res.on('error', drop);
        res.on('close', drop);
      });
      this.req.on('error', drop);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    emit(type, event) { for (const fn of this.listeners.get(type) || []) fn(event); }
    close() { this.readyState = EventSource.CLOSED; this.req.destroy(); this.res?.destroy(); streams.delete(this); }
  }
  const sidebar = await fetch(`${base}/_hub/sidebar.json`);
  const sidebarData = await sidebar.json();
  assert.ok(sidebarData.code);
  assert.match(sidebarData.version, /^\d+\.\d+\.\d+/);
  assert.equal(sidebar.headers.get('x-hub-code'), sidebarData.code);
  // The sidebar carries no npm update state, and the hub has no upgrade route.
  assert.equal('upgrade' in sidebarData, false);
  assert.equal((await fetch(`${base}/_hub/upgrade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  const html = await (await fetch(`${base}/_hub/`)).text();
  assert.match(html, /<div class="sb-update" role="status"><\/div>/);
  let reloads = 0;
  const { win, doc, page } = await shellPage('/_hub/', {
    fetch: (url, opts) => fetch(new URL(url, base), opts), sidebarData, EventSource, reload: () => reloads++,
  });
  const status = doc.querySelector('.hub-status');
  const logo = doc.querySelector('.view-hub .top a.hub');
  const region = doc.querySelector('.sb-update');
  // Each Hub paint: whether the update region offered its Reload as it painted. nextPaint() resolves on the next one.
  let paints = [];
  let painted = () => {};
  const nextPaint = () => new Promise((resolve) => { painted = resolve; });
  const innerHTML = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(status), 'innerHTML');
  Object.defineProperty(status, 'innerHTML', {
    get() { return innerHTML.get.call(this); },
    set(value) { paints.push(Boolean(doc.querySelector('.sb-update [data-app-reload]'))); innerHTML.set.call(this, value); painted(); },
  });
  while (!status.innerHTML) await nextPaint();
  await received;
  assert.equal(region.innerHTML, '');
  assert.equal(doc.querySelector('[data-app-reload]'), null);
  assert.equal(logo.getAttribute('aria-label'), 'Boards');
  const file = path.join(dir, 'hub-code.json');
  const code = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...code, hash: `${code.hash}-new` }));
  paints = [];
  const repainted = nextPaint();
  page.fire(doc.querySelector('.view-hub #refresh'), 'click');
  await repainted;
  assert.ok(paints.every(Boolean));
  assert.equal(doc.querySelector('.sb-update'), region);
  assert.equal(region.getAttribute('role'), 'status');
  assert.equal(region.querySelector('.sb-title').textContent, 'New version');
  assert.equal(region.querySelector('.sb-go').textContent, 'Reload');
  assert.ok(doc.documentElement.classList.contains('sb-update'));
  assert.equal(logo.getAttribute('aria-label'), 'Boards, new version ready');
  assert.equal(reloads, 0);
  const button = region.querySelector('[data-app-reload]');
  win.AppShell.codeSeen(sidebarData.code);
  win.AppShell.codeSeen('a later hash');
  assert.equal(region.querySelector('[data-app-reload]'), button);
  page.fire(doc.getElementById('sidebar'), 'click', { target: button });
  assert.deepEqual([region.querySelector('.sb-go').textContent, region.querySelector('[data-app-reload]').getAttribute('aria-busy')], ['Reload', 'true']);
  assert.ok(region.querySelector('[data-app-reload]').disabled);
  assert.equal(reloads, 0);
  page.fire(doc.getElementById('sidebar'), 'click', { target: region.querySelector('[data-app-reload]') });
  page.runTimers(0);
  assert.equal(reloads, 1);
});

test('the Hub row stays selected on old Settings URLs, hub sections, the old Polling page and browser back', async () => {
  for (const path of ['/_hub/', '/_hub/settings', '/_hub/settings#rules', '/_hub/settings/polling?w=09%3A00']) {
    const { win, doc, selected, tap } = await shellPage(path);
    assert.deepEqual(selected(), ['/_hub/'], path);
    assert.equal(doc.querySelector('.sb-row[href="/_hub/settings"]'), null);
    assert.equal(doc.querySelector('#settingsLink'), null);
    win.AppShell.open('/_hub/#notifications');
    assert.deepEqual(selected(), ['/_hub/']);
    win.AppShell.open('/_hub/settings/polling?w=18%3A00');
    assert.deepEqual(selected(), ['/_hub/']);
    win.AppShell.open('/shop/');
    win.history.back();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(selected(), ['/_hub/']);
    tap(doc.querySelector('.sb-utility a[href="/_hub/"]'));
    assert.deepEqual(selected(), ['/_hub/']);
  }
});

test('modal page locking is below 900px and fitted sheets use the current width and latest wide scroll position', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const phoneMedia = /@media\s*\(max-width:\s*899px\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g;
  const lock = /html:has\(dialog:modal\)\s*\{\s*overflow:\s*hidden;\s*\}/g;
  assert.equal((css.match(phoneMedia) || []).join('\n').match(lock)?.length, 1);
  assert.doesNotMatch(css.replace(phoneMedia, ''), lock);

  const page = fakePage(memoryStorage().localStorage);
  const { win } = page;
  const { Element } = miniDom(page.Target, win.document);
  const sheet = win.document.body.appendChild(new Element('dialog'));
  const global = vm.runInContext('window', win);
  for (const width of [1280, 390]) {
    win.innerWidth = width;
    win.scrollTo(0, 120);
    const unfit = win.BoardDialogs.fitSheet(sheet);
    sheet.showModal();
    win.scrollTo(0, 469);
    page.fire(global, 'scroll');
    assert.equal(win.scrollY, width === 390 ? 120 : 469);
    win.innerWidth = 900;
    win.scrollTo(0, 600);
    page.fire(global, 'scroll');
    assert.equal(win.scrollY, 600);
    win.innerWidth = 899;
    win.scrollTo(0, 700);
    page.fire(global, 'scroll');
    assert.equal(win.scrollY, 600);
    sheet.close();
    unfit();
  }
});

test('ask and New board sheets follow the phone keyboard, hold the page still and release viewport listeners on close', () => {
  const page = fakePage(memoryStorage().localStorage);
  const { win } = page;
  const doc = win.document;
  const { Element } = miniDom(page.Target, doc);
  const nativeClose = Element.prototype.close;
  Element.prototype.close = function () { nativeClose.call(this); page.fire(this, 'close'); };
  doc.body.innerHTML = '<aside id="sidebar" class="sidebar"></aside><div id="sidebarScrim"></div>';
  doc.getElementById = (id) => doc.body.querySelector(`#${id}`);
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  win.matchMedia = (query) => Object.assign(new page.Target(), { matches: query === '(prefers-reduced-motion: reduce)' });
  win.Sidebar.mount({ data: { sites: [], repos: [], starting: [] } });
  const aside = doc.getElementById('sidebar');
  const root = doc.body.appendChild(new Element('div'));
  root.innerHTML = win.BoardView.markup({ title: 'A' });
  const view = win.BoardView.create(root, 'https://mac.ts.net/board-a');
  view.mount();
  const vv = win.visualViewport;
  const global = vm.runInContext('window', win);
  const scrolls = [];
  win.scrollTo = (x, y) => { scrolls.push(y); win.scrollY = y; };
  for (const kind of ['board', 'ask']) {
    for (let i = 0; i < 2; i++) {
      const baseline = [page.listenerCount(vv), page.listenerCount(global)];
      vv.height = 844; vv.offsetTop = 0;
      win.scrollY = 120;
      scrolls.length = 0;
      if (kind === 'ask') page.fire(root.querySelector('#compose'), 'click');
      else page.fire(aside, 'click', { target: aside.querySelector('[data-new-board]') });
      const sheet = kind === 'ask' ? root.querySelector('#sheet') : doc.getElementById('newBoardSheet');
      const values = new Map();
      sheet.style.setProperty = (k, v) => values.set(k, v);
      vv.height = 500;
      page.fire(vv, 'resize');
      assert.deepEqual([...values], [['--kb', '344px'], ['--vh', '500px']]);
      assert.equal(sheet.classList.contains('kb'), true);
      assert.equal(sheet.classList.contains('keyboard-sheet'), true);
      vv.offsetTop = 20;
      page.fire(vv, 'scroll');
      assert.equal(values.get('--kb'), '324px');
      vv.height = 844;
      page.fire(vv, 'resize');
      assert.equal(values.get('--kb'), '0px');
      assert.equal(sheet.classList.contains('kb'), false);
      // The file picker's return sends no viewport resize, so the window's focus measures the sheet again.
      vv.height = 500;
      page.fire(global, 'focus');
      assert.equal(values.get('--kb'), '324px');
      vv.height = 844;
      page.fire(global, 'focus');
      assert.equal(values.get('--kb'), '0px');
      win.scrollY = 469;
      page.fire(global, 'scroll');
      assert.deepEqual(scrolls, [120]);
      sheet.close();
      const closed = [page.listenerCount(vv), page.listenerCount(global)];
      values.clear();
      page.fire(vv, 'resize'); page.fire(vv, 'scroll');
      win.scrollY = 300;
      page.fire(global, 'scroll');
      assert.equal(values.size, 0);
      assert.deepEqual(scrolls, [120]);
      assert.deepEqual(closed, baseline);
    }
  }
  page.fire(root.querySelector('#compose'), 'click');
  const values = new Map();
  root.querySelector('#sheet').style.setProperty = (k, v) => values.set(k, v);
  view.unmount();
  values.clear();
  page.fire(vv, 'resize'); page.fire(vv, 'scroll');
  assert.equal(values.size, 0);
});

function repoPage(wide = true) {
  const page = fakePage(memoryStorage().localStorage);
  const { win } = page;
  const doc = win.document;
  const { Element } = miniDom(page.Target, doc);
  const nativeClose = Element.prototype.close;
  Element.prototype.close = function () { nativeClose.call(this); page.fire(this, 'close'); };
  doc.body.innerHTML = '<aside id="sidebar" class="sidebar"></aside><div id="sidebarScrim"></div>';
  doc.getElementById = (id) => doc.body.querySelector(`#${id}`);
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  win.matchMedia = () => Object.assign(new page.Target(), { matches: wide });
  return { ...page, doc, Element };
}
const tick = () => new Promise(setImmediate);
const repoList = [{ github: 'owner/project', private: true, pushedAt: '2026-10-31T12:00:00Z', description: 'The project', clone: '/clone/.repos/owner/project', cloned: false, shared: [] },
  { github: 'org/tools', private: false, pushedAt: '2026-10-01T12:00:00Z', description: 'Tools', clone: '/clone/.repos/org/tools', cloned: true, shared: [{ route: 'tools', title: 'Tools board' }] }];
const repoResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });

test('New board chooses a searchable repo before board details, defaults its branch, posts JSON, and a failed start opens a sheet that retries or dismisses it on rail and drawer', async () => {
  for (const wide of [true, false]) {
    const page = repoPage(wide);
    const { win, doc } = page;
    let data = { sites: [], starting: [] };
    let refusal = 'That board route already exists.';
    let finish;
    let hubKey = false;
    let retryRefusal = 'Couldn’t stop its earlier session: no such job';
    const posted = [], keyPosts = [];
    win.fetch = async (url, options = {}) => {
      if (url === '/_hub/sidebar.json') return repoResponse(data);
      if (url === '/_hub/repos') return repoResponse({ signedIn: true, repos: repoList });
      if (url.startsWith('/_hub/branches')) return repoResponse({ defaultBranch: 'trunk', branches: ['trunk', 'release/next'] });
      if (url === '/_hub/api/linear') return repoResponse(hubKey ? { set: true, workspace: 'Acme', url_key: 'acme', teams: [{ key: 'ENG', name: 'Engineering' }], projects: [{ team: 'ENG', id: 'p1', name: 'Existing' }] } : { set: false });
      if (url === '/_hub/api/settings') return repoResponse({ linear: { set: false, title: 'No key', sub: 'Make a personal API key in Linear, then paste it here.', summary: 'No key' } });
      if (url === '/_hub/settings/linear') { keyPosts.push(String(options.body)); hubKey = true; return repoResponse({ linear: { set: true, title: 'Acme workspace', sub: 'Key ••••••••', summary: 'Key set · Acme workspace' } }); }
      posted.push([url, options.method, options.body && JSON.parse(options.body), options.headers?.['content-type']]);
      if (options.method === 'DELETE') { data = { ...data, starting: [] }; return repoResponse({}); }
      if (url.endsWith('/retry')) {
        if (retryRefusal) return { ok: false, text: async () => retryRefusal };
        data = { ...data, starting: [{ route: 'backend-audit', title: 'Backend audit', repo: repoList[0].clone, step: 'cloning', stepAt: new Date(NOW).toISOString(), askedAt: new Date(NOW).toISOString(), failed: false }] };
        return repoResponse({ route: 'backend-audit' });
      }
      if (refusal) return { ok: false, text: async () => refusal };
      return new Promise((resolve) => { finish = () => { data = { ...data, starting: [{ route: 'backend-audit', title: 'Backend audit', repo: repoList[0].clone, step: 'cloning', stepAt: new Date(NOW).toISOString(), failed: false }] }; resolve(repoResponse({ route: 'backend-audit' })); }; });
    };
    const sidebar = win.Sidebar.mount({ data });
    const aside = doc.getElementById('sidebar');
    const tapNew = () => page.fire(aside, 'click', { target: aside.querySelector('[data-new-board]') });
    tapNew();
    await tick();
    let sheet = doc.getElementById('newBoardSheet');
    const click = (sel) => page.fire(sheet.querySelector('form'), 'click', { target: sheet.querySelector(sel) });
    assert.equal(sheet.open, true);
    assert.equal(sheet.querySelector('[name="name"]'), null);
    assert.match(sheet.textContent, /Newest push first/);
    assert.match(sheet.querySelector('[data-repo="owner/project"]').textContent, /Private.*Pushed.*Not cloned/);
    assert.match(sheet.querySelector('[data-repo="org/tools"]').textContent, /Public.*✓ Cloned · shared with Tools board/);
    const search = sheet.querySelector('[name="search"]');
    search.value = 'org/';
    page.fire(sheet.querySelector('form'), 'input', { target: search });
    assert.equal(sheet.querySelectorAll('[data-repo]').length, 1);
    search.value = '';
    page.fire(sheet.querySelector('form'), 'input', { target: search });
    click('[data-cancel-new]');
    assert.equal(doc.getElementById('newBoardSheet'), null);
    tapNew();
    await tick();
    sheet = doc.getElementById('newBoardSheet');
    click('[data-repo="owner/project"]');
    await tick();
    const form = sheet.querySelector('form');
    const field = (name) => sheet.querySelector(`[name="${name}"]`);
    const start = sheet.querySelector('[type="submit"]');
    assert.equal(field('name').value, 'project');
    assert.equal(field('branch').value, 'trunk');
    assert.equal(start.disabled, false);
    assert.match(sheet.textContent, /Clones to.*\/clone\/.repos\/owner\/project/);
    assert.match(sheet.textContent, /implementers work in separate worktrees/);
    field('name').value = '';
    page.fire(form, 'input', { target: field('name') });
    assert.equal(start.disabled, true);
    field('name').value = 'Backend audit';
    field('purpose').value = 'Review changes';
    page.fire(form, 'input', { target: field('name') });
    page.fire(form, 'input', { target: field('purpose') });
    const control = sheet.querySelector('[data-board-tickets]');
    const pressed = () => control.querySelector('[aria-pressed="true"]').dataset.tkSource;
    assert.equal(pressed(), 'none');
    assert.match(control.textContent, /Every task is numbered T-1, T-2… on this board, with no ticket/);
    assert.equal(start.disabled, false);
    page.fire(control, 'click', { target: control.querySelector('[data-tk-source="linear"]') });
    await tick(); await tick();
    const keyModal = doc.getElementById('linearKeyModal');
    assert.equal(keyModal.open, true);
    assert.equal(sheet.open, true);
    assert.equal(pressed(), 'none');
    page.fire(keyModal.querySelector('.setting-content'), 'paste', { target: keyModal.querySelector('#linearKey'), clipboardData: { getData: () => 'lin_api_new' } });
    await tick(); await tick(); await tick();
    assert.deepEqual(keyPosts, ['key=lin_api_new']);
    assert.equal(doc.getElementById('linearKeyModal'), null);
    assert.equal(pressed(), 'linear');
    assert.deepEqual([control.querySelector('[data-tk="team"]').value, control.querySelector('[data-tk="project"]').value, control.querySelector('[data-tk="newName"]').value], ['ENG', '__new', 'Backend audit']);
    assert.equal(control.querySelector('[data-tk="workspaceText"]'), null);
    assert.equal(start.disabled, false);
    page.fire(control, 'click', { target: control.querySelector(`[data-tk-source="${wide ? 'none' : 'github'}"]`) });
    if (!wide) assert.match(control.textContent, /Issues in owner\/project/);
    field('branch').value = 'release/next';
    page.fire(form, 'change', { target: field('branch') });
    page.fire(form, 'submit');
    await tick();
    assert.equal(sheet.querySelector('[role="alert"]').textContent, refusal);
    assert.equal(start.disabled, false);
    refusal = null;
    page.fire(form, 'submit');
    page.fire(form, 'submit');
    assert.deepEqual([start.textContent, start.disabled, start.getAttribute('aria-busy')], ['Start', true, 'true'], 'Start waits with its label kept behind the spinner');
    assert.equal(posted.length, 2);
    finish();
    await tick();
    assert.deepEqual(posted.at(-1), ['/_hub/new-board', 'POST', { name: 'Backend audit', github: 'owner/project', branch: 'release/next', purpose: 'Review changes', tickets: wide ? { source: 'none' } : { source: 'github' } }, 'application/json']);
    assert.equal(doc.getElementById('newBoardSheet'), null);
    assert.match(aside.querySelector('[data-starting="backend-audit"]').textContent, /Backend audit.*cloning \(0%\) · 0s/);
    assert.equal(aside.querySelector('a[href="/backend-audit/"]'), null);
    assert.equal(aside.classList.contains('open'), !wide);
    const failed = { route: 'backend-audit', title: 'Backend audit', repo: repoList[0].clone, branch: 'release/next', tickets: { source: 'linear', team: 'ENG' }, askedAt: new Date(NOW).toISOString(), failed: true, error: 'claude --bg failed (1): Not logged in' };
    data = { ...data, starting: [failed] };
    win.Sidebar.mount({ data });
    const failedRow = () => aside.querySelector('[data-failed-start="backend-audit"]');
    assert.match(failedRow().textContent, /^\s*Backend audit\s*failed to start\s*$/);
    const openFailed = () => { page.fire(aside, 'click', { target: failedRow() }); return doc.getElementById('failedStartSheet'); };
    let failedSheet = openFailed();
    assert.equal(failedSheet.open, true);
    assert.equal(failedSheet.querySelector('h2').textContent, 'Backend audit failed to start');
    assert.match(failedSheet.textContent, /Not logged in.*Branch\s*release\/next.*Tickets\s*Linear · ENG/s);
    const tapSheet = (sel) => page.fire(failedSheet, 'click', { target: failedSheet.querySelector(sel) });
    tapSheet('[data-failed-retry]');
    const sheetButton = (sel) => failedSheet.querySelector(sel);
    assert.deepEqual([sheetButton('[data-failed-retry]').getAttribute('aria-busy'), sheetButton('[data-failed-retry]').disabled, sheetButton('[data-failed-dismiss]').disabled, sheetButton('[data-failed-dismiss]').getAttribute('aria-busy')],
      ['true', true, true, null], 'Retry waits and Dismiss is disabled');
    await tick();
    assert.deepEqual(posted.at(-1), ['/_hub/new-board/backend-audit/retry', 'POST', {}, 'application/json']);
    assert.equal(failedSheet.open, true);
    assert.equal(failedSheet.querySelector('.fs-refused').textContent, retryRefusal);
    assert.equal(failedSheet.querySelector('.fs-refused').hidden, false);
    assert.deepEqual([sheetButton('[data-failed-retry]').disabled, sheetButton('[data-failed-retry]').getAttribute('aria-busy'), sheetButton('[data-failed-dismiss]').disabled], [false, null, false]);
    retryRefusal = null;
    tapSheet('[data-failed-retry]');
    await tick();
    assert.equal(doc.getElementById('failedStartSheet'), null);
    assert.equal(failedRow(), null);
    assert.match(aside.querySelector('[data-starting="backend-audit"]').textContent, /Backend audit.*(starting orchestrator|cloning \(0%\)) · 0s/);
    data = { ...data, starting: [failed] };
    win.Sidebar.mount({ data });
    failedSheet = openFailed();
    tapSheet('[data-failed-close]');
    assert.equal(doc.getElementById('failedStartSheet'), null);
    failedSheet = openFailed();
    tapSheet('[data-failed-dismiss]');
    await tick();
    assert.equal(posted.at(-1)[1], 'DELETE');
    assert.equal(posted.at(-1)[0], '/_hub/new-board/backend-audit');
    assert.equal(doc.getElementById('failedStartSheet'), null);
    assert.equal(aside.querySelector('[data-starting]'), null);
    sidebar.close();
  }
});

test('the repo sheet names gh auth login when signed out, retries authentication and preserves edited details through Back', async () => {
  const page = repoPage();
  const { win, doc } = page;
  let signedIn = false;
  const urls = [];
  win.fetch = async (url) => {
    urls.push(url);
    return repoResponse(url.startsWith('/_hub/repos') ? { signedIn, repos: repoList } : { defaultBranch: 'main', branches: ['main'] });
  };
  win.BoardDialogs.repoSheet({ save: async () => {} });
  await tick();
  const sheet = doc.getElementById('newBoardSheet');
  const form = sheet.querySelector('form');
  const click = (sel) => page.fire(form, 'click', { target: sheet.querySelector(sel) });
  assert.match(sheet.textContent, /GitHub isn’t connected.*gh auth login/);
  assert.ok(sheet.querySelector('[data-join-hint]'), 'the signed-out sheet points at kickflip join too');
  assert.equal(sheet.querySelector('[data-repo]'), null);
  signedIn = true;
  click('[data-check-auth]');
  await tick();
  assert.ok(urls.includes('/_hub/repos?fresh=1'));
  click('[data-repo="owner/project"]');
  await tick();
  const name = sheet.querySelector('[name="name"]');
  name.value = 'Custom board';
  page.fire(form, 'input', { target: name });
  click('[data-back-repos]');
  await tick();
  click('[data-repo="org/tools"]');
  await tick();
  assert.equal(sheet.querySelector('[name="name"]').value, 'Custom board');
  assert.match(sheet.textContent, /Shared with Tools board/);
  sheet.close();
});

test('pasted unlisted repos use the normal branch and save steps in New board and Change repo', async () => {
  for (const current of [undefined, { github: 'owner/project', branch: 'main' }]) {
    const page = repoPage();
    const { win, doc } = page;
    const urls = [], saved = [];
    const repo = { ...repoList[0], github: 'outside/project', listed: false, private: false };
    let finish;
    win.fetch = async (url) => {
      urls.push(url);
      if (url === '/_hub/repos') return repoResponse({ signedIn: true, repos: repoList });
      if (url.startsWith('/_hub/repo?')) return new Promise((resolve) => { finish = () => resolve(repoResponse(repo)); });
      assert.equal(url, '/_hub/branches?github=outside%2Fproject');
      return repoResponse({ defaultBranch: 'canary', branches: ['canary', 'release'] });
    };
    win.BoardDialogs.repoSheet({ current, save: async (input) => saved.push(JSON.parse(JSON.stringify(input))) });
    await tick();
    const sheet = doc.getElementById('newBoardSheet');
    const form = sheet.querySelector('form');
    assert.equal(sheet.querySelector('[data-join-hint]')?.textContent ?? null, current ? null : 'A repo already on the host running Kickflip? Run kickflip join in its folder.');
    const input = sheet.querySelector('[name="search"]');
    input.value = 'https://github.com/outside/project/tree/canary';
    page.fire(form, 'input', { target: input });
    assert.match(sheet.querySelector('[data-repo-results]').textContent, /Checking…/);
    finish();
    await tick();
    assert.match(sheet.querySelector('[data-repo-results]').textContent, /From your link.*outside\/project.*Not in your list.*Public/);
    const row = sheet.querySelector('[data-repo="outside/project"]');
    page.fire(form, 'click', { target: row });
    await tick();
    assert.equal(sheet.querySelector('[name="branch"]').value, 'canary');
    assert.equal(sheet.querySelector('[type="submit"]').disabled, false);
    page.fire(form, 'submit');
    await tick();
    assert.deepEqual(saved, [current ? { github: 'outside/project', branch: 'canary' } : { github: 'outside/project', branch: 'canary', name: 'project', purpose: '', tickets: { source: 'none' } }]);
    assert.deepEqual(urls, ['/_hub/repos', '/_hub/repo?github=outside%2Fproject', '/_hub/branches?github=outside%2Fproject']);
    assert.equal(doc.getElementById('newBoardSheet'), null);
  }
});

test('repo links highlight listed rows, check other hosts on the hub, refuse local paths, and lookup failures replace the list', async () => {
  const page = repoPage();
  const { win, doc } = page;
  const urls = [];
  win.fetch = async (url) => {
    urls.push(url);
    if (url === '/_hub/repos') return repoResponse({ signedIn: true, repos: repoList });
    return { ok: false, json: async () => ({ error: "Not found, or you don't have access." }) };
  };
  win.BoardDialogs.repoSheet({ save: async () => {} });
  await tick();
  const sheet = doc.getElementById('newBoardSheet');
  const form = sheet.querySelector('form');
  const search = (value) => {
    const input = sheet.querySelector('[name="search"]');
    input.value = value;
    page.fire(form, 'input', { target: input });
  };
  for (const link of ['https://github.com/OWNER/project', 'https://github.com/owner/project.git', 'git@github.com:owner/project.git',
    'ssh://git@github.com/owner/project.git', 'https://github.com/owner/project/tree/main',
    'https://github.com/owner/project/pull/12', 'https://github.com/owner/project/blob/main/a?plain=1#L2']) {
    search(link);
    assert.match(sheet.textContent, /Already in your list/);
    assert.ok(sheet.querySelector('.nb-repo-highlight[data-repo="owner/project"]'));
  }
  for (const link of ['/srv/git/r.git', 'file:///srv/git/r.git', '../r']) {
    search(link);
    assert.equal(sheet.querySelector('[data-repo-results] [role="alert"] .nb-why').textContent, 'Paste the repo’s remote link. Local folders don’t work here.');
  }
  assert.deepEqual(urls, ['/_hub/repos']);
  for (const [link, name] of [['https://gitlab.com/o/r.git', 'gitlab.com/o/r'], ['git@bitbucket.org:o/r.git', 'bitbucket.org/o/r'], ['ssh://git@git.example.com:2222/o/r', 'git.example.com/o/r']]) {
    search(link);
    await tick();
    assert.equal(urls.at(-1), `/_hub/repo?remote=${encodeURIComponent(link)}`);
    assert.equal(sheet.querySelector('[data-repo-results] [role="alert"]').textContent, `${name}Not found, or you don't have access.`);
    assert.equal(sheet.querySelector('[data-repo]'), null);
  }
  urls.length = 1;
  search('https://github.com/outside/missing');
  await tick();
  assert.equal(sheet.querySelector('[data-repo-results] [role="alert"]').textContent, "outside/missingNot found, or you don't have access.");
  assert.equal(sheet.querySelector('[data-repo]'), null);
  search('project');
  assert.ok(sheet.querySelector('[data-repo="owner/project"]'));
  assert.doesNotMatch(sheet.textContent, /From your link|Not in your list/);
  sheet.close();
});

test('a pasted git link on another host picks its host-labelled row, lists branches through remote, starts with remote, and greys out GitHub issues', async () => {
  const page = repoPage();
  const { win, doc } = page;
  const urls = [], saved = [];
  const link = 'git@gitlab.com:acme/firmware.git';
  const repo = { remote: link, host: 'gitlab.com', name: 'gitlab.com/acme/firmware', github: '', pushedAt: '', defaultBranch: 'main', description: '', clone: '/clone/.repos/gitlab.com/acme/firmware', cloned: false, shared: [], listed: false };
  win.fetch = async (url) => {
    urls.push(url);
    if (url === '/_hub/repos') return repoResponse({ signedIn: false, repos: [] });
    if (url.startsWith('/_hub/repo?')) return repoResponse(repo);
    return repoResponse({ defaultBranch: 'main', branches: ['main', 'dev'] });
  };
  win.BoardDialogs.repoSheet({ save: async (input) => saved.push(JSON.parse(JSON.stringify(input))) });
  await tick();
  const sheet = doc.getElementById('newBoardSheet');
  const form = sheet.querySelector('form');
  assert.match(sheet.textContent, /GitHub isn’t connected/);
  const input = sheet.querySelector('[name="search"]');
  input.value = link;
  page.fire(form, 'input', { target: input });
  await tick();
  const row = sheet.querySelector(`[data-repo="${link}"]`);
  assert.match(row.textContent, /^gitlab\.com\/acme\/firmwareNot in your listgitlab\.com · Last push unknown.*Not cloned yet$/);
  page.fire(form, 'click', { target: row });
  await tick();
  assert.match(sheet.querySelector('.nb-selected').textContent, /gitlab\.com\/acme\/firmwaregitlab\.com.*\/clone\/\.repos\/gitlab\.com\/acme\/firmware/);
  assert.equal(sheet.querySelector('[name="name"]').value, 'firmware');
  const github = sheet.querySelector('[data-tk-source="github"]');
  assert.equal(github.getAttribute('aria-disabled'), 'true');
  page.fire(sheet.querySelector('[data-board-tickets]'), 'click', { target: github });
  assert.equal(sheet.querySelector('[data-tk-source="github"]').getAttribute('aria-pressed'), 'false');
  assert.match(sheet.querySelector('[data-board-tickets] [role="status"]').textContent, /GitHub issues need a repo on GitHub, and the repo chosen above isn’t on GitHub/);
  page.fire(form, 'submit');
  await tick();
  assert.deepEqual(saved, [{ name: 'firmware', purpose: '', remote: link, branch: 'main', tickets: { source: 'none' } }]);
  assert.deepEqual(urls, ['/_hub/repos', `/_hub/repo?remote=${encodeURIComponent(link)}`, `/_hub/branches?remote=${encodeURIComponent(link)}`]);
});

test('bare repo lookups debounce, cancel when edited or closed, and ignore stale success and failure responses', async () => {
  const page = repoPage();
  const { win, doc } = page;
  const timers = new Map(), pending = new Map(), urls = [];
  let id = 0;
  win.setTimeout = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
  win.clearTimeout = (id) => timers.delete(id);
  win.fetch = async (url) => {
    urls.push(url);
    if (url === '/_hub/repos') return repoResponse({ signedIn: true, repos: repoList });
    return new Promise((resolve) => pending.set(new URL(url, 'https://test').searchParams.get('github'), resolve));
  };
  win.BoardDialogs.repoSheet({ save: async () => {} });
  await tick();
  const sheet = doc.getElementById('newBoardSheet');
  const form = sheet.querySelector('form');
  const search = (value) => {
    const input = sheet.querySelector('[name="search"]');
    input.value = value;
    page.fire(form, 'input', { target: input });
  };
  search('owner/project');
  assert.equal(timers.size, 0, 'matching bare identities stay ordinary search');
  search('outside/first');
  assert.equal(timers.size, 1);
  assert.deepEqual(urls, ['/_hub/repos']);
  search('outside/second');
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.ms, 500);
  timers.clear(); timer.fn();
  search('https://github.com/outside/third');
  pending.get('outside/third')(repoResponse({ ...repoList[0], github: 'outside/third', listed: false }));
  await tick();
  pending.get('outside/second')({ ok: false, json: async () => ({ error: 'stale failure' }) });
  await tick();
  assert.match(sheet.textContent, /From your link.*outside\/third/);
  assert.doesNotMatch(sheet.textContent, /stale failure/);
  search('https://github.com/outside/late');
  search('tools');
  pending.get('outside/late')(repoResponse({ ...repoList[0], github: 'outside/late', listed: false }));
  await tick();
  assert.ok(sheet.querySelector('[data-repo="org/tools"]'));
  assert.doesNotMatch(sheet.textContent, /From your link/);
  search('outside/cancel');
  assert.equal(timers.size, 1);
  sheet.close();
  assert.equal(timers.size, 0);
  assert.equal(urls.some((url) => url.includes('cancel') || url.includes('first')), false);
});

test('Board Settings saves each Tickets change at once, shows the source and Hub’s key as a status word, opens Hub’s key modal over it for Linear without a working key, and Done waits for a save', async () => {
  const page = repoPage(true);
  const { doc, Element } = page;
  const root = doc.body.appendChild(new Element('div'));
  root.innerHTML = page.win.AppViews.settings.markup();
  let settings = { auto_merge: false, tickets: { source: 'github', account: 'lovek4d' } }, refuse = false, hold = null, hubKey = 'refused';
  const posts = [], keyPosts = [], dismissed = [];
  const KEYS = { url: 'https://linear.app/settings/account/security', label: 'Linear › Settings › Security & access › Personal API keys' };
  const words = () => (hubKey === 'works' ? { set: true, title: 'Acme workspace', sub: 'Key ••••••••', summary: 'Key set · Acme workspace' }
    : { set: true, refused: true, title: 'Acme workspace', down: 'doesn’t work', sub: `Linear refused the key. Make a new one in ${KEYS.label} and paste it here.`, keys: KEYS, summary: 'Key doesn’t work · Acme workspace' });
  page.win.fetch = async (url, options = {}) => {
    if (url === '/_hub/api/settings') return repoResponse({ linear: words() });
    if (url === '/_hub/settings/linear') { keyPosts.push(String(options.body)); await hold?.promise; hubKey = 'works'; return repoResponse({ linear: words() }); }
    if (url === '/_hub/api/linear') {
      return repoResponse(hubKey === 'works' ? { set: true, workspace: 'Acme', url_key: 'acme', teams: [{ key: 'ENG', name: 'Engineering' }, { key: 'OPS', name: 'Ops' }],
        projects: [{ team: 'ENG', id: 'p1', name: 'Existing' }, { team: 'OPS', id: 'p2', name: 'Runbooks' }] } : { set: true, refused: true, workspace: 'Acme', url_key: 'acme' });
    }
    if (url.endsWith('/api/settings')) {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        await hold?.promise;
        if (refuse) return { ok: false, json: async () => ({ error: 'Try again.' }) };
        settings = { ...settings, ...JSON.parse(options.body) };
      }
      return repoResponse({ settings });
    }
    if (url.includes('board-repo')) return repoResponse({ github: 'owner/project', branch: 'main' });
    return repoResponse({});
  };
  const view = page.win.AppViews.settings.create(root, 'https://mac.ts.net/orch', { dismiss: () => dismissed.push(1) });
  view.mount(); await tick();
  const control = root.querySelector('#boardTickets');
  const form = root.querySelector('#ticketsForm');
  const status = root.querySelector('#ticketsStatus');
  const modal = root.querySelector('#boardSettingsModal');
  const done = root.querySelector('.settings-footer [data-settings-dismiss]');
  const pressed = () => control.querySelector('[aria-pressed="true"]').dataset.tkSource;
  const tapLinear = async () => { page.fire(control, 'click', { target: control.querySelector('[data-tk-source="linear"]') }); await tick(); await tick(); };
  assert.equal(root.querySelector('#ticketsSave'), null);
  assert.match(control.textContent, /opens an issue there as gh account lovek4d/);
  await tick();
  assert.equal(control.querySelector('[data-tk-status]').textContent, 'github · Linear refused the key');
  refuse = true; page.fire(control, 'click', { target: control.querySelector('[data-tk-source="none"]') }); await tick();
  assert.deepEqual(posts.at(-1), { tickets: { source: 'none' } });
  assert.equal(status.textContent, 'Try again.');
  assert.equal(form.hasAttribute('data-dirty'), true);
  refuse = false; page.fire(form, 'submit'); await tick();
  assert.deepEqual(posts.at(-1), { tickets: { source: 'none' } });
  assert.equal(status.textContent, 'Saved');
  assert.equal(form.hasAttribute('data-dirty'), false);
  assert.match(control.textContent, /Every task is numbered T-1/);

  const word = () => control.querySelector('[data-tk-status]').textContent;
  assert.equal(word(), 'none · Linear refused the key');
  assert.equal(root.querySelector('#ticketsKey'), null);
  await tapLinear();
  let keyModal = doc.getElementById('linearKeyModal');
  assert.equal(keyModal.open, true);
  assert.equal(modal.open, true);
  assert.equal(pressed(), 'none');
  assert.match(keyModal.textContent, /doesn’t work · Linear refused the key|Linear refused the key/);
  assert.equal(keyModal.querySelector(`a[href="${KEYS.url}"]`).textContent, KEYS.label);
  page.fire(keyModal, 'click', { target: keyModal.querySelector('.settings-footer [data-lk-done]') }); await tick();
  assert.equal(doc.getElementById('linearKeyModal'), null);
  assert.equal(modal.open, true);
  assert.equal(pressed(), 'none');
  assert.equal(posts.length, 2);

  await tapLinear();
  keyModal = doc.getElementById('linearKeyModal');
  hold = Promise.withResolvers();
  page.fire(keyModal.querySelector('.setting-content'), 'paste', { target: keyModal.querySelector('#linearKey'), clipboardData: { getData: () => ' lin_api_new ' } });
  assert.deepEqual(keyPosts, ['key=lin_api_new']);
  assert.match(keyModal.textContent, /Checking the key with Linear…/);
  assert.deepEqual([keyModal.querySelector('.settings-footer [data-lk-done]').getAttribute('aria-busy'), pressed()], ['true', 'none']);
  hold.resolve(); hold = null;
  await tick(); await tick(); await tick();
  assert.equal(doc.getElementById('linearKeyModal'), null);
  assert.equal(modal.open, true);
  assert.equal(pressed(), 'linear');
  assert.equal(word(), 'linear · connected');
  assert.equal(control.querySelector('[data-tk-status]').classList.contains('on'), true);
  assert.equal(control.querySelector('[data-tk="team"]').value, 'ENG');
  assert.equal(control.querySelector('[data-tk="workspaceText"]'), null);
  assert.deepEqual(posts.at(-1), { tickets: { source: 'linear', workspace: 'acme', team: 'ENG', project: 'p1' } });

  hold = Promise.withResolvers();
  const team = control.querySelector('[data-tk="team"]');
  team.value = 'OPS';
  page.fire(root.querySelector('#ticketsForm'), 'change', { target: team });
  page.fire(control, 'change', { target: team });
  assert.deepEqual(posts.at(-1), { tickets: { source: 'linear', workspace: 'acme', team: 'OPS', project: 'p2' } });
  // The changed select keeps its face, disabled, with the spinner after its caption; every other tickets control is disabled.
  const field = (tk) => control.querySelector(`[data-tk="${tk}"]`);
  assert.deepEqual([status.textContent, field('team').disabled, field('team').getAttribute('aria-busy'), field('team').closest('label').querySelector('span > .tap-beside') !== null],
    ['', true, 'true', true]);
  assert.deepEqual([field('project').disabled, control.querySelectorAll('[data-tk-source]').every((b) => b.disabled)], [true, true]);
  assert.deepEqual([done.getAttribute('aria-busy'), done.disabled], ['true', true]);
  page.fire(modal, 'click', { target: done });
  page.fire(modal, 'click', { target: root.querySelector('.settings-head [data-settings-dismiss]') });
  await tick();
  assert.equal(dismissed.length, 0);
  hold.resolve(); hold = null;
  await tick(); await tick();
  assert.equal(status.textContent, 'Saved');
  assert.deepEqual([done.getAttribute('aria-busy'), field('team').disabled, field('team').getAttribute('aria-busy'), control.querySelectorAll('.tap-beside').length], [null, false, null, 0]);
  assert.equal(dismissed.length, 1);
  view.unmount();
});

test('the shared Tickets control shows Linear teams and projects with a supplied key and names a new project after the board', () => {
  const page = repoPage(true);
  const root = page.doc.body.appendChild(new page.Element('div'));
  let name = 'Audit';
  const control = page.win.BoardDialogs.ticketsControl(root, { isNew: true, title: () => name, linear: { set: true, workspace: 'another', teams: [{ key: 'ENG', name: 'Engineering' }], projects: [{ team: 'ENG', id: 'p1', name: 'Existing' }] } });
  page.fire(root, 'click', { target: root.querySelector('[data-tk-source="linear"]') });
  assert.equal(root.querySelector('[data-tk="project"]').value, '__new');
  assert.equal(root.querySelector('[data-tk="newName"]').value, 'Audit');
  name = 'Renamed'; control.nameChanged();
  assert.equal(root.querySelector('[data-tk="newName"]').value, 'Renamed');
  assert.equal(root.querySelector('[data-tk-create]'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(control.read())), { source: 'linear', workspace: 'another', team: 'ENG', new_project: 'Renamed' });
  assert.equal(control.valid(), true);
  const project = root.querySelector('[data-tk="project"]');
  project.value = 'p1'; page.fire(root, 'change', { target: project });
  assert.equal(control.valid(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(control.read())), { source: 'linear', workspace: 'another', team: 'ENG', project: 'p1' });
  control.destroy();
});

test("Board Settings' Tickets source row reads its live state as a status word, from the source and Hub's Linear key", async () => {
  const page = repoPage(true);
  const words = [];
  for (const [value, key, word] of [
    [{ source: 'none' }, { set: false }, 'none · no Linear key'],
    [{ source: 'none' }, { set: true }, 'none · linear key saved'],
    [{ source: 'github' }, { set: false }, 'github · no Linear key'],
    [{ source: 'none' }, { set: true, refused: true }, 'none · Linear refused the key'],
  ]) {
    const root = page.doc.body.appendChild(new page.Element('div'));
    const control = page.win.BoardDialogs.ticketsControl(root, { value, repo: () => 'o/r', keyState: async () => key, loadLinear: async () => ({ set: false }) });
    assert.equal(root.querySelector('[data-tk-status]'), null);
    await tick();
    const status = root.querySelector('[data-tk-status]');
    words.push([status.textContent, status.getAttribute('role'), status.classList.contains('on')]);
    assert.equal(word, status.textContent);
    control.destroy();
  }
  assert.deepEqual(words.map(([, role, on]) => [role, on]), Array(4).fill(['status', false]));
  const plain = page.doc.body.appendChild(new page.Element('div'));
  page.win.BoardDialogs.ticketsControl(plain, { value: { source: 'none' } }).destroy();
  assert.equal(plain.querySelector('[data-tk-status]'), null);
});

test("Board Settings' Tickets control loads Linear once it is the source and creates a new project in the chosen team", async () => {
  const page = repoPage(true);
  const root = page.doc.body.appendChild(new page.Element('div'));
  const loads = [], made = [], changes = [];
  let refuse = true;
  const control = page.win.BoardDialogs.ticketsControl(root, { value: { source: 'none' }, title: () => 'Audit',
    loadLinear: async () => { loads.push(1); return { set: true, workspace: 'Acme', url_key: 'acme', teams: [{ key: 'ENG', name: 'Engineering' }, { key: 'OPS', name: 'Ops' }], projects: [{ team: 'ENG', id: 'p1', name: 'Existing' }] }; },
    createProject: async (team, projectName) => { if (refuse) throw new Error('Linear: name taken'); made.push([team, projectName]); return { id: 'p2', name: projectName, team }; },
    change: (value, valid) => changes.push([value, valid]) });
  assert.equal(loads.length, 0);
  page.fire(root, 'click', { target: root.querySelector('[data-tk-source="linear"]') });
  assert.match(root.textContent, /Loading Linear/);
  await tick();
  assert.equal(loads.length, 1);
  assert.match(root.textContent, /A task gets a ENG issue in Existing, in the Acme workspace from Hub’s key, when it goes ready to build/);
  assert.deepEqual(JSON.parse(JSON.stringify(control.read())), { source: 'linear', workspace: 'acme', team: 'ENG', project: 'p1' });
  const team = root.querySelector('[data-tk="team"]');
  team.value = 'OPS'; page.fire(root, 'change', { target: team });
  const project = root.querySelector('[data-tk="project"]');
  project.value = '__new'; page.fire(root, 'change', { target: project });
  assert.equal(control.valid(), false);
  page.fire(root, 'click', { target: root.querySelector('[data-tk-create]') });
  await tick();
  assert.match(root.textContent, /Linear: name taken/);
  refuse = false;
  page.fire(root, 'click', { target: root.querySelector('[data-tk-create]') });
  await tick();
  assert.deepEqual(made, [['OPS', 'Audit']]);
  assert.deepEqual(JSON.parse(JSON.stringify(control.read())), { source: 'linear', workspace: 'acme', team: 'OPS', project: 'p2' });
  assert.equal(control.valid(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(changes.at(-1))), [{ source: 'linear', workspace: 'acme', team: 'OPS', project: 'p2' }, true]);
  page.fire(root, 'click', { target: root.querySelector('[data-tk-source="none"]') });
  page.fire(root, 'click', { target: root.querySelector('[data-tk-source="linear"]') });
  await tick();
  assert.equal(loads.length, 1);
  control.destroy();
});

test('Board Settings shows repo and branch, changes them as JSON and closes the repo sheet when unmounted', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  const posts = [];
  let selected, closed = 0;
  page.win.BoardDialogs.repoSheet = (options) => { selected = options; return () => { closed++; }; };
  page.win.fetch = async (url, options = {}) => {
    if (url === '/_hub/board-repo/orch') {
      if (options.method === 'POST') { posts.push([url, { ...options.headers }, JSON.parse(options.body)]); return repoResponse({ ...JSON.parse(options.body), repo: '/new' }); }
      return repoResponse({ github: 'owner/project', branch: 'main' });
    }
    return repoResponse({});
  };
  const view = page.win.AppViews.settings.create(root, 'https://mac.ts.net/orch', { reload() {} });
  view.mount();
  await tick();
  assert.equal(root.querySelector('#boardRepoValue').textContent, 'owner/project · main');
  page.fire(root.querySelector('#boardRepo'), 'click');
  assert.equal(selected.current.github, 'owner/project');
  await selected.save({ github: 'org/tools', branch: 'develop' });
  assert.deepEqual(posts, [['/_hub/board-repo/orch', { 'content-type': 'application/json' }, { github: 'org/tools', branch: 'develop' }]]);
  assert.equal(root.querySelector('#boardRepoValue').textContent, 'org/tools · develop');
  assert.match(root.querySelector('#boardRepoStatus').textContent, /session has been told/);
  view.unmount();
  assert.equal(closed, 1);
});

// docs/adr/2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md
test("a starting board's seconds tick in place each second without a repaint, and at join its row turns into the board's row, which fades in", () => {
  const page = repoPage();
  const { win, doc } = page;
  const aside = doc.getElementById('sidebar');
  const asked = Date.parse('2026-11-04T19:00:00.000Z');
  let clock = asked + 3000;
  win.Date = class extends Date { static now() { return clock; } };
  const ticks = [];
  const setInterval = win.setInterval;
  win.setInterval = (fn, ms) => { const id = setInterval(fn, ms); ticks.push({ id, fn, ms }); return id; };
  const starting = [{ route: 'audit', title: 'Backend audit', step: 'starting', stepAt: new Date(asked).toISOString(), failed: false }];
  const sidebar = win.Sidebar.mount({ data: { sites: [], starting } });
  const caption = () => aside.querySelector('[data-starting="audit"] .sb-step');
  const shown = caption();
  assert.equal(shown.textContent, 'starting orchestrator · 3s');
  const tick = ticks.find((t) => t.ms === 1000);
  clock = asked + 5000;
  tick.fn();
  assert.equal(caption(), shown, 'the tick sets the text in place');
  assert.equal(shown.textContent, 'starting orchestrator · 5s');
  clock = asked + 6100;
  sidebar.setData({ sites: [], starting });
  assert.equal(page.left().intervals, 1);
  clock = asked + 9000;
  sidebar.setData({ sites: [{ route: 'audit', title: 'Backend audit', board: true, icon: '<span class="icon"></span>' }], starting: [] });
  assert.equal(aside.querySelector('[data-starting="audit"]'), null);
  const joined = aside.querySelector('a.sb-row[href="/audit/"]');
  assert.equal(joined.classList.contains('sb-joined'), true);
  assert.equal(page.left().intervals, 0, 'no starting row, no tick');
  clock = asked + 10000;
  sidebar.setData({ sites: [{ route: 'audit', title: 'Backend audit', board: true, icon: '<span class="icon"></span>' }], starting: [] });
  const again = aside.querySelector('a.sb-row[href="/audit/"]');
  assert.deepEqual([again.classList.contains('sb-joined'), again.style.animationDelay], [true, '-1000ms'], 'a repaint mid-fade carries it on');
  clock = asked + 9000 + 2500;
  sidebar.setData({ sites: [{ route: 'audit', title: 'Backend audit', board: true, icon: '<span class="icon"></span>' }], starting: [] });
  assert.equal(aside.querySelector('a.sb-row[href="/audit/"]').classList.contains('sb-joined'), false);
});

test("s s shows each sidebar row's key and the Boards label's hint, and the next key opens that row through the shell; Escape, a click, a held modifier or 3 s with no key end it with nothing opened; s s does nothing in a text field or with a dialog open; on a drawer it opens the drawer and closes it again; and its keys never count toward the board's n n; a repaint mid-countdown carries the bar on from where it was", () => {
  const page = fakePage(memoryStorage().localStorage);
  const { win } = page;
  win.Element = page.El;
  const aside = new page.El();
  aside.querySelector('.sb-update').replaceWith = () => {};
  const scrim = new page.El();
  let dialog = null;
  Object.assign(win.document, { getElementById: (id) => ({ sidebar: aside, sidebarScrim: scrim })[id] || null, querySelectorAll: () => [],
    querySelector: (sel) => (sel === 'dialog[open]' ? dialog : null) });
  const wide = Object.assign(new page.Target(), { matches: true });
  win.matchMedia = (q) => (q === '(min-width: 900px)' ? wide : Object.assign(new page.Target(), { matches: false }));
  let idle = null;
  const setTimeout = win.setTimeout;
  win.setTimeout = (fn, ms) => { if (ms === 3000) idle = fn; return setTimeout(fn, ms); };
  const icon = '<span class="icon" aria-hidden="true"><svg></svg></span>';
  const data = { sites: [{ route: 'hub-orchestrator', title: 'Hub Orchestrator', board: true, created: '2026-10-29T00:00:00Z', icon },
    { route: 'ios', title: 'iOS', board: true, created: '2026-10-22T00:00:00Z', icon }] };
  const board = win.BoardView.create(new page.El(), 'https://mac.ts.net/hub-orchestrator');
  board.mount();
  const opened = [];
  const sidebar = win.Sidebar.mount({ here: 'hub-orchestrator', data, open: (href) => opened.push(href) });

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
  assert.match(aside.innerHTML, /<section class="sb-boards" aria-label="Boards"><div class="sb-label ks-label"><span class="ks-label-text">Boards<\/span><span class="ks-label-hint" role="status">– press a key to switch<i class="ks-bar"><\/i><\/span><\/div><div class="sb-group">/);
  assert.equal(aside.querySelector('.ks-bar').style.animationDelay, '0ms');
  page.advance(1200);
  sidebar.setData(data);
  assert.equal(aside.querySelector('.ks-bar').style.animationDelay, '-1200ms');
  assert.equal(aside.querySelector('.ks-bar').style.animationDuration, '3000ms');
  assert.doesNotMatch(aside.innerHTML, /ks-hint/);
  assert.equal(press('Escape').defaultPrevented, true);
  assert.equal(switching(), false);
  sidebar.setData(data);
  assert.doesNotMatch(aside.innerHTML, /ks-label-hint|ks-bar/);
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
  press('u');
  assert.equal(opened.at(-1), '/_hub/');
  sw();
  press('2');
  press('n');
  assert.deepEqual([opened.at(-1), sheet.open], ['/ios/', false]);
  press('n');
  assert.equal(sheet.open, true);
  board.unmount();
});

test("h h on a desktop shows the shortcuts sheet listing each shortcut's keys, and h h again or Escape closes it; it stays shut from a text field, with a modifier, between other keys, with another dialog open, or on a phone", () => {
  const page = fakePage(memoryStorage().localStorage);
  const { win } = page;
  const { Element } = miniDom(page.Target, win.document);
  win.Element = Element;
  const { body } = win.document;
  const aside = body.appendChild(new Element('aside'));
  const scrim = body.appendChild(new Element('div'));
  Object.assign(win.document, { getElementById: (id) => ({ sidebar: aside, sidebarScrim: scrim })[id] || null,
    querySelector: (sel) => body.querySelector(sel), querySelectorAll: (sel) => body.querySelectorAll(sel) });
  const desktop = { matches: true };
  win.matchMedia = (q) => (q === '(hover: hover) and (pointer: fine)' ? desktop : Object.assign(new page.Target(), { matches: false }));
  win.Sidebar.mount({ here: 'shop', data: { sites: [{ route: 'shop', title: 'Shop', board: true, icon: '' }] } });

  const field = body.appendChild(new Element('textarea'));
  const press = (key, ev = {}) => page.fire(win.document, 'keydown', { key, target: body, ...ev });
  const twice = (ev) => { press('h', ev); return press('h', ev); };
  const sheet = () => body.querySelector('#shortcutsSheet');

  assert.equal(twice().defaultPrevented, true);
  assert.equal(sheet().open, true);
  assert.deepEqual([...sheet().querySelectorAll('.sc-group')].map((g) => [g.querySelector('h3').textContent,
    [...g.querySelectorAll('.sc-row')].map((r) => [r.querySelector('.sc-what').firstChild.textContent, [...r.querySelectorAll('kbd')].map((k) => k.textContent).join(' ')])]), [
    ['Anywhere', [['Switch boards and pages', 's s'], ['This help', 'h h'], ['Close', 'Esc']]],
    ['On a board', [['New task', 'n n']]],
    ['Writing', [['Send', '⌘ ↵']]],
  ]);
  assert.equal(press('Escape').defaultPrevented, true);
  assert.equal(sheet(), null);
  twice();
  assert.ok(sheet());
  twice();
  assert.equal(sheet(), null);

  twice({ target: field });
  twice({ metaKey: true });
  press('H', { shiftKey: true });
  press('H', { shiftKey: true });
  press('h');
  press('s');
  press('h');
  assert.equal(sheet(), null);
  const other = body.appendChild(new Element('dialog'));
  other.open = true;
  twice();
  assert.equal(sheet(), null);
  other.remove();
  desktop.matches = false;
  twice();
  assert.equal(sheet(), null);
});

// seen: card key → its readAt on the board, the read mark board/server.mjs keeps for every device.
function boardOnDom({ open = [], seen = {}, stored = [], board, threads, confirm = false, realDialogs = false, send = null, width = 390 }) {
  const { storage, localStorage } = memoryStorage([['site:board-a:openItems', JSON.stringify(open)], ...stored]);
  const page = fakePage(localStorage);
  page.win.innerWidth = width;
  const { Element } = miniDom(page.Target, page.win.document);
  const server = { board: { ...board, items: board.items.map((it) => (seen[it.key] ? { ...it, readAt: seen[it.key] } : it)) }, threads };
  const sent = [];
  const confirms = [];
  const confirmLabels = [];
  page.win.BoardDialogs.confirm = async (text, labels) => { confirms.push(text); confirmLabels.push(labels?.ok ? { ok: labels.ok, cancel: labels.cancel } : undefined); return confirm; };
  const notices = [];
  page.win.BoardDialogs.notice = async (text) => { notices.push(text); };
  if (realDialogs) vm.runInContext(fs.readFileSync(new URL('./public/dialogs.js', import.meta.url), 'utf8'), page.win);
  const site = page.win.ClaudeSite.site;
  // The events POST answers with the board, as board/server.mjs does; send(kind, data, server) answers in its place.
  page.win.ClaudeSite.site = (r) => ({ ...site(r), send: async (kind, data) => { sent.push([kind, data]); return send ? send(kind, data, server) : { id: `e${sent.length}`, board: structuredClone(server.board) }; } });
  const posts = [];
  const gets = [];
  const downloads = [];
  const patched = [];
  page.win.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'https://mac.ts.net/');
    if (opts.method === 'POST') { posts.push([u.pathname, JSON.parse(opts.body)]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    gets.push(u.pathname);
    // A board with a version answers 304 to a request naming it, as board/server.mjs does.
    if (u.pathname.endsWith('/api/board') && server.board.version && opts.headers?.['if-none-match'] === `"${server.board.version}"`) return { ok: false, status: 304, json: async () => { throw new Error('a 304 has no body'); } };
    // A reload naming a version the server holds gets a patch from it, as board/server.mjs answerBoard does.
    const since = u.pathname.endsWith('/api/board') && server.held?.[u.searchParams.get('since')];
    if (since) { patched.push(u.searchParams.get('since')); const patch = boardPatch(since, server.board, { from: server.heldThreads?.[u.searchParams.get('since')] || {}, to: server.threads || {} }); return { ok: true, status: 200, json: async () => structuredClone(patch), text: async () => JSON.stringify(patch) }; }
    if (u.pathname.endsWith('/api/board')) downloads.push(server.board.version);
    if (u.pathname.endsWith('/api/done')) return { ok: true, status: 200, json: async () => structuredClone(server.done(u.searchParams)) };
    const body = u.pathname.endsWith('/api/board') ? server.board : server.threads[u.searchParams.get('key')] || [];
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = page.win.BoardView.markup({ title: 'A' });
  let signalled = null;
  const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a', { signal: (fn) => { signalled = fn; return () => {}; } });
  view.mount();
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const change = async (next) => { Object.assign(server, next); signalled(); await settle(); };
  return { page, root, view, settle, change, sent, confirms, confirmLabels, notices, posts, gets, downloads, patched, server, storage, doc: page.win.document };
}
// The work card an ask became (from_ask; docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md).
const askCard = (id, lane) => ({ key: `w/${id}`, id, kind: 'work', lane, title: `Task ${id}`, ref: `T-${id}`, fromAsk: id, deps: [], manualSteps: [], othersAt: [] });
const boardOf = (items) => ({ title: 'A', generatedAt: '2026-10-30T10:00:00.000Z', items, files: [], needs: [], answers: [], owner: [], ownerTopics: [], doneArchived: 0 });
const workCard = (id, extra) => ({ key: `w/${id}`, id, kind: 'work', lane: 'todo', title: `Work ${id}`, ref: id, internal: true, wave: { slug: 'w1', title: 'W' }, deps: [], manualSteps: [], othersAt: [], ...extra });

// docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
test("the board reloads naming the version it shows, so an unchanged board downloads nothing, and a tap's own change signal finds the POST's board current: one tap, one download", async () => {
  const T1 = workCard('T1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 0 });
  const T2 = workCard('T2', { bumpable: true, sortAt: '2026-10-02T00:00:00.000Z', order: 1 });
  const first = { ...boardOf([T1, T2]), version: 'v1' };
  const bumped = { ...boardOf([{ ...T2, bumpedAt: '2026-10-30T10:00:00.000Z' }, T1]), generatedAt: '2026-10-30T10:00:01.000Z', version: 'v2' };
  const b = boardOnDom({ board: first, threads: {}, send: (kind, data, server) => { server.board = bumped; return { id: 'e1', board: structuredClone(bumped) }; } });
  await b.settle();
  const order = () => b.root.querySelectorAll('.lane[data-lane="todo"] details.item').map((el) => el.dataset.key);
  assert.deepEqual([b.downloads, order()], [['v1'], ['w/T1', 'w/T2']]);
  await b.change({});
  assert.deepEqual([boardGets(b), b.downloads, order()], [2, ['v1'], ['w/T1', 'w/T2']], 'the reload answers 304 and the board stays');
  b.page.fire(b.root, 'click', { target: b.root.querySelector('details.item[data-key="w/T2"] button[data-card-bump]') });
  await b.settle();
  assert.deepEqual(order(), ['w/T2', 'w/T1']);
  await b.change({});
  assert.deepEqual([b.sent.map(([k]) => k), boardGets(b), b.downloads, order()], [['card-bump'], 3, ['v1'], ['w/T2', 'w/T1']], "the tap's change signal downloads nothing");
  await b.change({ board: { ...bumped, title: 'Renamed', version: 'v3' } });
  assert.deepEqual([b.downloads, b.root.querySelector('.top h1').textContent], [['v1', 'v3'], 'Renamed']);
  b.view.unmount();
});

// docs/adr/2026-11-04-0332-the-board-sends-per-card-patches.md
test("a changed board comes as a patch from the version on screen, a reload's and a tap's alike, and the board draws the patched cards", async () => {
  const T1 = workCard('T1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 0 });
  const T2 = workCard('T2', { bumpable: true, sortAt: '2026-10-02T00:00:00.000Z', order: 1 });
  const v1 = { ...boardOf([T1, T2]), version: 'v1' };
  const v2 = { ...boardOf([{ ...T1, title: 'Renamed T1' }, T2]), generatedAt: '2026-10-30T10:00:01.000Z', version: 'v2' };
  const v3 = { ...boardOf([{ ...T2, bumpedAt: '2026-10-30T10:00:02.000Z' }, { ...T1, title: 'Renamed T1' }]), generatedAt: '2026-10-30T10:00:02.000Z', version: 'v3' };
  const b = boardOnDom({ board: v1, threads: {}, send: (kind, data, server) => { server.board = v3; return { id: 'e1', board: structuredClone(boardPatch(server.held[data.since], v3)) }; } });
  b.server.held = { v1, v2 };
  await b.settle();
  const order = () => b.root.querySelectorAll('.lane[data-lane="todo"] details.item').map((el) => el.dataset.key);
  const title = (key) => b.root.querySelector(`details.item[data-key="${key}"]`).textContent;
  await b.change({ board: v2 });
  assert.deepEqual([b.downloads, b.patched, b.view.B.state.board.version], [['v1'], ['v1'], 'v2']);
  assert.match(title('w/T1'), /Renamed T1/);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('details.item[data-key="w/T2"] button[data-card-bump]') });
  await b.settle();
  assert.deepEqual([b.sent.map(([k, d]) => [k, d.since]), b.view.B.state.board.version, order()], [[['card-bump', 'v2']], 'v3', ['w/T2', 'w/T1']]);
  b.view.unmount();
});

test('a tap anywhere on an asleep board, refresh included, asks the hub to wake its session once, and the header keeps reading the age of the data while its title says asleep, then waking… until it listens', async () => {
  const checks = (watcher) => ({ at: '2026-10-30T10:00:00.000Z', every: 30, late: false, watcher, claudeAt: null });
  const b = boardOnDom({ board: { ...boardOf([workCard('A1')]), checks: checks('asleep') }, threads: {} });
  await b.settle();
  const status = () => b.root.querySelector('#status').textContent;
  const title = () => b.root.querySelector('#status .fresh').getAttribute('title');
  assert.equal(status(), 'now');
  assert.match(title(), /^Asleep/);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('#refresh') });
  assert.equal(status(), 'now');
  assert.match(title(), /^Waking/);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('.lane') });
  assert.deepEqual(b.posts.filter(([p]) => p === '/_hub/wake'), [['/_hub/wake', { route: 'board-a' }]]);
  await b.change({ board: { ...b.view.B.state.board, checks: checks('waking') } });
  assert.match(title(), /^Waking/);
  b.page.fire(b.root, 'submit', { target: b.root });
  assert.equal(b.posts.filter(([p]) => p === '/_hub/wake').length, 1);
  await b.change({ board: { ...b.view.B.state.board, checks: checks('running') } });
  assert.doesNotMatch(title(), /^Waking/);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('#refresh') });
  await b.settle();
  assert.equal(b.posts.filter(([p]) => p === '/_hub/wake').length, 1);
  await b.change({ board: { ...b.view.B.state.board, checks: checks('stopped') } });
  assert.equal(status(), 'now');
  assert.match(title(), /^Claude not listening/);
  assert.equal(b.root.querySelector('#status .fresh').getAttribute('class'), 'fresh', 'never coloured');
  b.view.unmount();
});

test("an open card shows its workflow buttons below a final details line of Notes, Install and GitHub links, and colours orange the control that clears Action needed: Questions links to its first question, a grill whose brief the orchestrator owes reads preheating in blue", async () => {
  const draft = { state: 'OPEN', isDraft: true, number: 7, url: 'https://github.com/o/r/pull/7', checks: { state: 'pass' } };
  const ready = { ...draft, isDraft: false };
  const install = { url: 'itms-services://?action=download-manifest&url=https://m/x/manifest.plist', label: null, older: false };
  const asking = { actionButton: 'openQuestions', questions: { first: 'q7', open: 1, state: 'open' } };
  const cards = [
    workCard('A1', { ...asking, action: { kind: 'questions', url: 'questions.html#q7', label: 'Answer 1 question' }, resolvedBy: 'openQuestions' }),
    workCard('A2', { actionButton: null, bumpable: true }),
    workCard('A3', { actionButton: null, grilling: true, planning: 'preheating' }),
    workCard('A4', { actionButton: null, lane: 'done' }),
    workCard('A5', { ...asking, held: true, holdable: true, action: null, resolvedBy: null }),
    workCard('P1', { ...asking, action: { kind: 'pick', url: 'questions.html#q7', label: 'Prototypes ready: pick a take' }, resolvedBy: 'openQuestions' }),
    workCard('D1', { lane: 'review', actionButton: null, pr: draft, hasNotes: true, install, action: { kind: 'ready', url: draft.url, label: 'Tap Ready on GitHub' }, resolvedBy: 'github' }),
    workCard('R1', { lane: 'review', actionButton: null, pr: ready, install }),
    workCard('S1', { lane: 'review', actionButton: null, pr: ready, manualSteps: ['Run the backfill'], action: { kind: 'steps', url: '#selectedCard=w%2FS1', label: 'Run the manual steps, then merge' }, resolvedBy: 'github' }),
    workCard('M1', { lane: 'review', actionButton: null, pr: ready, action: { kind: 'merge', url: '#selectedCard=w%2FM1', label: 'Merge' }, resolvedBy: 'merge' }),
  ];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: {}, confirm: true });
  await b.settle();
  assert.doesNotMatch(b.root.innerHTML, /\u2197/);
  const links = [...b.root.querySelectorAll('.external-links a')];
  assert.ok(links.length);
  for (const link of links) {
    assert.equal(link.querySelectorAll('svg.link-arrow').length, 1);
    assert.equal(link.querySelector('svg.link-arrow').getAttribute('aria-hidden'), 'true');
  }
  const row = (key) => b.root.querySelector(`details.item[data-key="${key}"] .detail`);
  const labels = (els) => els.map((el) => el.textContent.trim());
  const shown = (key) => ['.action-row.workflow a, .action-row.workflow button', '.external-links a', '.actions .resolves, .external-links .resolves, form[data-reply] .resolves'].map((selector) => labels(row(key)?.querySelectorAll(selector) || []));
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.key, shown(c.key)])), {
    'w/A1': [['Questions'], [], ['Questions']],
    'w/A2': [[], [], []],
    'w/A3': [[], [], []],
    'w/A4': [[], [], []],
    'w/A5': [['Unhold', 'Questions'], [], []],
    'w/P1': [['Questions'], [], ['Questions']],
    'w/D1': [['Notes'], ['Install', 'Review draft on GitHub'], ['Review draft on GitHub']],
    'w/R1': [[], ['Install', 'Review on GitHub'], []],
    'w/S1': [[], ['Review on GitHub'], ['Review on GitHub']],
    'w/M1': [['Merge'], ['Review on GitHub'], ['Merge']],
  });
  assert.equal(row('w/A1').querySelector('a.button').getAttribute('href'), 'questions.html#q7');
  const external = row('w/D1').querySelector('.grid .external-links');
  assert.deepEqual(external.querySelectorAll('a').map((a) => a.getAttribute('href')), [install.url, draft.url]);
  assert.equal(external.textContent, 'Install  · Review draft on GitHub ');
  const notes = row('w/D1').querySelector('.action-row.workflow a');
  assert.deepEqual([notes.textContent, notes.getAttribute('href'), notes.getAttribute('class')], ['Notes', 'notes.html?item=w%2FD1', 'button']);
  assert.equal(external.parentNode.children.at(-1), external);
  assert.equal(b.root.querySelector('.action-row.external'), null);
  assert.equal(row('w/D1').querySelector('.actions .install, .actions a[target="_blank"]'), null);
  assert.equal(row('w/R1').querySelector('.external-links .resolves'), null);
  assert.match(b.root.querySelector('details.item[data-key="w/A3"] summary .line3.sub.agent.planner').textContent, /^preheating$/);
  assert.equal(b.root.querySelector('details.item[data-key="w/A2"] summary .line3.planner'), null);
});

// docs/adr/2026-11-05-0430-the-eye-and-fire-send-their-request-at-once.md
test("the thread's eye and fire send their request at once: nothing typed sends the bare request, typed text goes with it, /prototype and /grill in the text still work on Reply, and no toggle or hint remains", async () => {
  const cards = [workCard('A1'), workCard('A2', { prototyping: true })];
  const b = boardOnDom({ open: ['w/A1'], board: boardOf(cards), threads: { 'w/A1': [] } });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/A1"]');
  const eye = () => form().querySelector('button[data-proto]');
  const fire = () => form().querySelector('button[data-grill]');
  const box = () => form().querySelector('textarea');
  const tap = async (button, text = '') => { box().value = text; b.page.fire(b.root, 'click', { target: button }); await b.settle(); };
  const send = async (text) => { box().value = text; b.page.fire(b.root, 'submit', { target: form(), submitter: form().querySelector('button[data-nth="0"]') }); await b.settle(); };
  assert.match(box().getAttribute('placeholder'), /\/prototype, \/grill or \/visual/);
  assert.equal(form().querySelector('[data-hint]'), null);
  assert.deepEqual([eye().getAttribute('aria-pressed'), fire().getAttribute('aria-pressed')], [null, null]);
  await tap(eye());
  await tap(fire(), 'Ask about the colours');
  assert.equal(box().value, '', 'the draft clears');
  await send('/prototype Phone width first');
  await send('/grill');
  await send('Just a reply');
  assert.deepEqual(sentNoIds(b), [
    ['prototype-request', { key: 'w/A1' }], ['grill-more', { key: 'w/A1', text: 'Ask about the colours' }],
    ['prototype-request', { key: 'w/A1', text: 'Phone width first' }], ['grill-more', { key: 'w/A1' }], ['item-message', { key: 'w/A1', text: 'Just a reply', intent: 'reply' }],
  ]);
  b.view.unmount();
});

// docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
test("a Todo card's Implement is in its thread box, quiet while the card isn't ready and builder orange once it is, following each board load; its action row has none", async () => {
  const asking = { actionButton: 'openQuestions', buildable: false, questions: { first: 'q7', open: 1, state: 'open' }, action: { kind: 'questions', url: 'questions.html#q7', label: 'Answer 1 question' } };
  const cards = [workCard('Q1', asking), workCard('R1', { buildable: true, ready: true })];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: { 'w/Q1': [], 'w/R1': [] }, confirm: true });
  await b.settle();
  const implement = (key) => b.root.querySelector(`form[data-reply="${key}"] button[data-intent="build"]`);
  assert.deepEqual([implement('w/Q1').getAttribute('class'), implement('w/R1').getAttribute('class')], ['build', 'build ready']);
  assert.equal(b.root.querySelector('.actions [data-confirm="card-build"]'), null);
  await b.change({ board: boardOf([workCard('Q1', { buildable: true, ready: true }), cards[1]]) });
  assert.equal(implement('w/Q1').getAttribute('class'), 'build ready');
  b.view.unmount();
});

// docs/adr/2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md
test('the New task sheet has two buttons and no Send: Discuss (⌘↵) sends the ask and Implement (⌥↵) sends it with quick: true; Ctrl+↵ stands in for ⌘', async () => {
  const b = boardOnDom({ board: boardOf([]), threads: {} });
  await b.settle();
  const form = b.root.querySelector('#askForm');
  const buttons = () => [...form.querySelectorAll('button[type="submit"]')].map((el) => [el.dataset.intent, el.textContent]);
  assert.deepEqual(buttons(), [['quick', 'Implement⌥↵'], ['discuss', 'Discuss⌘↵']]);
  assert.equal(form.querySelector('.ask-seg'), null);
  const send = async (text, submitter) => {
    b.root.querySelector('#askText').value = text;
    b.page.fire(form, 'submit', { target: form, submitter: form.querySelector(`button[data-intent="${submitter}"]`) });
    await b.settle();
  };
  await send('Plain task', 'discuss');
  await send('Quick task', 'quick');
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['ask', { text: 'Plain task' }], ['ask', { text: 'Quick task', quick: true }]]);
  const pressed = [];
  form.requestSubmit = (s) => pressed.push(s?.dataset.intent ?? null);
  const box = b.root.querySelector('#askText');
  const key = (ev) => b.page.fire(box, 'keydown', { key: 'Enter', target: box, ...ev }).defaultPrevented;
  assert.deepEqual([key({ metaKey: true }), key({ ctrlKey: true }), key({ altKey: true }), key({}), key({ shiftKey: true })], [true, true, true, false, false]);
  assert.deepEqual(pressed, ['discuss', 'discuss', 'quick']);
  b.view.unmount();
});

// docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md
const OUTBOX = 'site:board-a:outbox';
const footOf = (el) => el.querySelector('.msg-foot').textContent.replace(/^[^·]*· ?/, '');
// A thread's lines as read: a status line's words and what follows its time, a message's body and its footer after the time.
const dotted = (text) => text.split('·').map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
function threadLines(b, key) {
  return b.root.querySelectorAll(`[data-thread="${key}"] .msgs > *`).map((el) => {
    if (el.matches('.status-line')) { const [words, , ...rest] = dotted(el.textContent); return [words, ...rest].join(' · '); }
    return `${el.querySelector('.body').textContent.trim()} (${dotted(el.querySelector('.msg-foot').textContent).slice(1).join(' · ')})`;
  });
}
test("Reply clears the box and shows the message at once as sending…, its button never waiting; messages go one at a time in order, a failed one reads not sent and holds the ones behind it, Retry resends it under the same send id and X puts its text back in the box, each after a confirm", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send, confirm: true });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/T1"]');
  const box = () => form().querySelector('textarea');
  const reply = () => form().querySelector('button[data-intent="reply"]');
  const send = async (text) => { box().value = text; b.page.fire(b.root, 'submit', { target: form(), submitter: reply() }); await b.settle(); };
  const queued = () => b.root.querySelectorAll('[data-thread="w/T1"] .msg[data-send]').map((el) => [el.querySelector('.body').textContent, footOf(el)]);
  const posted = () => b.sent.map(([kind, d]) => [kind, d.text, d.sendId]);
  const mine = (n, text) => ({ ts: `2026-10-30T10:0${n}:00.000Z`, who: 'love', via: 'site', kind: 'item-message', text, eventId: `e${n}`, reply: null, state: 'waiting' });

  await send('First');
  assert.deepEqual([box().value, queued(), waitState(reply())], ['', [['First', 'sending…']], IDLE]);
  assert.equal(b.storage.get('draft:w/T1'), '""');
  const [first] = b.sent;
  assert.deepEqual([first[0], first[1].key, first[1].text, first[1].intent, typeof first[1].sendId], ['item-message', 'w/T1', 'First', 'reply', 'string']);
  await send('Second');
  assert.deepEqual([queued(), b.sent.length], [[['First', 'sending…'], ['Second', 'sending…']], 1], 'the second waits for the first');

  b.server.threads['w/T1'] = [mine(1, 'First')];
  sends.answer();
  await b.settle();
  assert.equal(footOf(b.root.querySelector('.msg[data-event="e1"]')), 'waiting…');
  assert.deepEqual([queued(), posted().map(([, text]) => text)], [[['Second', 'sending…']], ['First', 'Second']]);
  const secondId = b.sent[1][1].sendId;
  assert.notEqual(secondId, first[1].sendId);

  sends.answer(false, 'The board server is restarting. Try again in a moment.');
  await b.settle();
  const failed = () => b.root.querySelector(`.msg[data-send="${secondId}"]`);
  assert.deepEqual(queued(), [['Second', 'not sent']]);
  assert.ok(failed().querySelector(`button[data-resend="${secondId}"]`) && failed().querySelector(`button[data-unsend="${secondId}"]`));
  await send('Third');
  assert.deepEqual([queued(), b.sent.length], [[['Second', 'not sent'], ['Third', 'sending…']], 2], 'a message behind a failed one waits');
  assert.deepEqual(JSON.parse(b.storage.get(OUTBOX)).map((m) => [m.text, Boolean(m.failed)]), [['Second', true], ['Third', false]]);

  b.page.fire(b.root, 'click', { target: failed().querySelector('button[data-resend]') });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), posted().at(-1)], ['Send this message again?', ['item-message', 'Second', secondId]]);
  b.server.threads['w/T1'] = [mine(1, 'First'), mine(2, 'Second')];
  sends.answer();
  await b.settle();
  assert.deepEqual(posted().map(([, text]) => text), ['First', 'Second', 'Second', 'Third']);
  sends.answer(false);
  await b.settle();
  assert.deepEqual(queued(), [['Third', 'not sent']]);
  box().value = 'Draft';
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-thread="w/T1"] button[data-unsend]') });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), queued(), box().value, JSON.parse(b.storage.get(OUTBOX))], ['Dismiss this message? Its text goes back in the box.', [], 'Third\n\nDraft', []]);
  assert.equal(b.storage.get('draft:w/T1'), JSON.stringify('Third\n\nDraft'));
  assert.equal(b.root.querySelector('[data-thread="w/T1"]').querySelectorAll('button[data-edit], button[data-withdraw]').length, 0);
  b.view.unmount();
});

test("a thread load that began before the send was answered and already holds the board's line draws the message once: the line's send id takes the page's copy's place", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send });
  await b.settle();
  const form = b.root.querySelector('form[data-reply="w/T1"]');
  form.querySelector('textarea').value = 'Once';
  b.page.fire(b.root, 'submit', { target: form, submitter: form.querySelector('button[data-intent="reply"]') });
  await b.settle();
  const { sendId } = b.sent[0][1];
  const line = { ts: '2026-10-30T10:00:00.000Z', who: 'love', via: 'site', kind: 'item-message', text: 'Once', eventId: 'e1', sendId, reply: null, state: 'waiting' };
  let early;
  const started = new Promise((resolve) => { early = () => resolve([line]); });
  b.view.B.loadThread('w/T1', { force: true, from: started });
  b.server.threads['w/T1'] = [line];
  // The reload the answer forces is slower than the load already running.
  const fetched = b.page.win.fetch;
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  b.page.win.fetch = async (url, opts) => { if (String(url).includes('/api/thread')) await slow; return fetched(url, opts); };
  sends.answer();
  await b.settle();
  early();
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T1'), ['Once (waiting…)'], 'drawn once the early load lands');
  release();
  await b.settle();
  await b.view.B.loadThread('w/T1', { force: true });
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T1'), ['Once (waiting…)'], 'and once after the reload');
  b.view.unmount();
});

// docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md
test("a send whose answer patches in the board's own line shows the message once, as the board has it, before any thread reload answers", async () => {
  const v1 = { ...boardOf([workCard('T1')]), version: 'v1' };
  const v2 = { ...v1, generatedAt: '2026-10-30T10:00:01.000Z', version: 'v2' };
  const mine = { ts: '2026-10-30T10:01:00.000Z', who: 'love', via: 'site', kind: 'item-message', text: 'Hello', files: [], eventId: 'e1', reply: null, state: 'waiting' };
  const b = boardOnDom({ open: ['w/T1'], board: v1, threads: { 'w/T1': [] }, send: (kind, data, server) => {
    server.board = v2;
    server.threads = { 'w/T1': [mine] };
    return { id: 'e1', board: structuredClone(boardPatch(v1, v2, { from: { 'w/T1': [] }, to: server.threads })) };
  } });
  await b.settle();
  const fetchAll = b.page.win.fetch;
  b.page.win.fetch = (url, opts) => (url.includes('/api/thread') ? new Promise(() => {}) : fetchAll(url, opts));
  const form = b.root.querySelector('form[data-reply="w/T1"]');
  form.querySelector('textarea').value = 'Hello';
  b.page.fire(b.root, 'submit', { target: form, submitter: form.querySelector('button[data-intent="reply"]') });
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T1'), ['Hello (waiting…)']);
  b.view.unmount();
});

test("a message the board never recorded survives a reload: the page shows it as sending… again and resends it under its send id, a failed one included", async () => {
  const kept = { sendId: 's-kept', key: 'w/T1', text: 'Kept', files: [], ts: '2026-10-30T10:00:00.000Z', failed: true };
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send, stored: [[OUTBOX, JSON.stringify([kept])]] });
  await b.settle();
  const sent = b.root.querySelector('[data-thread="w/T1"] .msg[data-send="s-kept"]');
  assert.deepEqual([sent.querySelector('.body').textContent, footOf(sent)], ['Kept', 'sending…']);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['item-message', { key: 'w/T1', text: 'Kept', sendId: 's-kept' }]]);
  b.server.threads['w/T1'] = [{ ts: kept.ts, who: 'love', via: 'site', kind: 'item-message', text: 'Kept', eventId: 'e1', reply: null, state: 'waiting' }];
  sends.answer();
  await b.settle();
  assert.deepEqual([b.root.querySelectorAll('[data-thread="w/T1"] .msg[data-send]').length, b.root.querySelectorAll('[data-thread="w/T1"] .msg[data-event="e1"]').length, JSON.parse(b.storage.get(OUTBOX))], [0, 1, []]);
  b.view.unmount();
});

// docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
test("Implement shows its line at once and its button never waits: with text the message's footer reads Implement · sending…, an empty box's line reads Marked as staging · sending…, and the board's line, matched by sendId, takes each one's place", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/T1"]');
  const implement = () => form().querySelector('button[data-intent="build"]');
  const tap = async (text) => { form().querySelector('textarea').value = text; b.page.fire(b.root, 'submit', { target: form(), submitter: implement() }); await b.settle(); };
  await tap('Use the blue');
  assert.deepEqual([form().querySelector('textarea').value, threadLines(b, 'w/T1'), waitState(implement())], ['', ['Use the blue (Implement · sending…)'], IDLE]);
  assert.equal(b.sent[0][1].intent, 'build');
  await tap('');
  assert.deepEqual([threadLines(b, 'w/T1'), waitState(implement())], [['Use the blue (Implement · sending…)', 'Marked as staging · sending…'], IDLE]);
  const at = '2026-10-30T10:05:00.000Z';
  b.server.threads['w/T1'] = [
    { ts: at, who: 'love', via: 'site', kind: 'item-message', text: 'Use the blue', eventId: 'e1', reply: null, state: 'waiting', status: 'Implement' },
    { ts: at, who: 'claude', kind: 'command', command: 'staged', request: true, text: 'Marked as staging' },
  ];
  sends.answer();
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T1'), ['Use the blue (Implement · waiting…)', 'Marked as staging', 'Marked as staging · sending…']);
  const sendId = b.sent.at(-1)[1].sendId;
  b.server.threads['w/T1'] = [...b.server.threads['w/T1'], { ts: '2026-10-30T10:06:00.000Z', who: 'claude', kind: 'command', command: 'staged', request: true, mark: 'Marked as staging', text: 'Marked as staging', sendId }];
  sends.answer();
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T1'), ['Use the blue (Implement · waiting…)', 'Marked as staging', 'Marked as staging']);
  assert.deepEqual(sentNoIds(b).at(-1), ['item-message', { key: 'w/T1', text: '', intent: 'build' }]);
  b.view.unmount();
});

// docs/adr/2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md
// docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
test("a Todo card's thread box has Reply (⌘↵) and Implement (⌥↵), which send the message with intent: 'reply' or 'build'; an In Progress card's has Hold (⌥↵) and Reply, and the box follows the card's lane", async () => {
  const b = boardOnDom({ open: ['w/T1', 'w/P1'], board: boardOf([workCard('T1'), workCard('P1', { lane: 'progress' })]), threads: { 'w/T1': [], 'w/P1': [] } });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const buttons = (key) => [...form(key).querySelectorAll('button[type="submit"]')].map((el) => [el.dataset.intent ?? null, el.textContent]);
  assert.deepEqual(buttons('w/T1'), [['build', 'Implement⌥↵'], ['reply', 'Reply⌘↵']]);
  assert.deepEqual(buttons('w/P1'), [[null, 'Hold⌥↵'], ['reply', 'Reply⌘↵']]);
  const send = async (key, text, intent) => {
    form(key).querySelector('textarea').value = text;
    b.page.fire(b.root, 'submit', { target: form(key), submitter: form(key).querySelector(intent ? `button[data-intent="${intent}"]` : 'button[type="submit"]') });
    await b.settle();
  };
  await send('w/T1', 'Use the blue', 'build');
  await send('w/T1', 'Just a reply', 'reply');
  await send('w/P1', 'Later', 'reply');
  assert.deepEqual(sentNoIds(b), [
    ['item-message', { key: 'w/T1', text: 'Use the blue', intent: 'build' }], ['item-message', { key: 'w/T1', text: 'Just a reply', intent: 'reply' }], ['item-message', { key: 'w/P1', text: 'Later', intent: 'reply' }],
  ]);
  // An empty box still sends Implement, bare, on a card ready or not: the board server readies it and builds at once.
  await send('w/T1', '', 'build');
  assert.deepEqual(sentNoIds(b).at(-1), ['item-message', { key: 'w/T1', text: '', intent: 'build' }]);
  await b.change({ board: boardOf([workCard('T1', { ready: true }), workCard('P1', { lane: 'progress' })]) });
  await send('w/T1', '', 'build');
  assert.deepEqual(sentNoIds(b).at(-1), ['item-message', { key: 'w/T1', text: '', intent: 'build' }]);
  const pressed = [];
  for (const key of ['w/T1', 'w/P1']) form(key).requestSubmit = (s) => pressed.push([key, s?.dataset.intent ?? s?.dataset.confirm ?? null]);
  const key = (k, ev) => { const box = form(k).querySelector('textarea'); return b.page.fire(b.root, 'keydown', { key: 'Enter', target: box, ...ev }).defaultPrevented; };
  assert.deepEqual([key('w/T1', { metaKey: true }), key('w/T1', { altKey: true }), key('w/P1', { ctrlKey: true }), key('w/P1', { altKey: true })], [true, true, true, true]);
  assert.deepEqual(pressed, [['w/T1', 'reply'], ['w/T1', 'build'], ['w/P1', 'reply'], ['w/P1', 'hold']]);
  await b.change({ board: boardOf([workCard('T1', { lane: 'progress' }), workCard('P1', { lane: 'progress' })]) });
  assert.deepEqual(buttons('w/T1'), [[null, 'Hold⌥↵'], ['reply', 'Reply⌘↵']]);
  b.view.unmount();
});

// docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md
test("a thread box's row has What's left? at the left and the eye, fire, image and attach at its right, with no lightning and no attach in the text box, and the send pair below", async () => {
  const b = boardOnDom({ open: ['w/T1', 'w/P1'], board: boardOf([workCard('T1'), workCard('P1', { lane: 'progress' })]), threads: { 'w/T1': [], 'w/P1': [] } });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const row = (key) => [...form(key).querySelector('.row').children].map((el) => el.matches('.quick') ? 'chip' : el.matches('.icons') ? 'icons' : el.dataset.sends);
  const icons = (key) => [...form(key).querySelector('.icons').children].map((el) => ['proto', 'grill', 'visual'].find((k) => el.hasAttribute('data-' + k)) || (el.matches('label.attach') ? 'attach' : '?'));
  assert.deepEqual(row('w/T1'), ['chip', 'icons', 'todo']);
  assert.deepEqual(row('w/P1'), ['chip', 'icons', 'progress']);
  for (const key of ['w/T1', 'w/P1']) {
    assert.deepEqual(icons(key), ['proto', 'grill', 'visual', 'attach']);
    assert.equal(form(key).querySelector('.dz .attach'), null);
    assert.ok(form(key).querySelector('.dz .dz-hint'));
  }
  assert.equal(b.root.querySelector('[data-bolt]'), null);
  b.view.unmount();
});

// docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md
test("Done shows only on an In Review card, as Done (⌥↵) then Reply (⌘↵) in its thread box; a Todo card has Close right of Hold in its actions, and an In Progress card neither", async () => {
  const cards = [
    workCard('T1', { finishable: true, holdable: true, hasNotes: true }),
    workCard('P1', { lane: 'progress', finishable: true, holdable: true }),
    workCard('R1', { lane: 'review', finishable: true, holdable: true, awaitsDone: true }),
    workCard('S1', { lane: 'review', stale: true, finishable: true, holdable: true }),
    // An answered ask's card waits in In Review for the owner's Done (docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md).
    { ...askCard('a1', 'review'), finishable: true, awaitsDone: true },
  ];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: Object.fromEntries(cards.map((c) => [c.key, []])), confirm: true });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const sends = (key) => [...form(key).querySelectorAll('button[type="submit"]')].map((el) => el.textContent);
  const actions = (key) => b.root.querySelector(`details.item[data-key="${key}"] .action-row.workflow`)?.querySelectorAll('a, button').map((el) => el.textContent.trim()) ?? [];
  assert.deepEqual(sends('w/R1'), ['Done⌥↵', 'Reply⌘↵']);
  assert.deepEqual(sends('w/S1'), ['Done⌥↵', 'Reply⌘↵']);
  assert.deepEqual(sends('w/a1'), ['Done⌥↵', 'Reply⌘↵']);
  assert.deepEqual(sends('w/P1'), ['Hold⌥↵', 'Reply⌘↵']);
  assert.deepEqual(sends('w/T1'), ['Implement⌥↵', 'Reply⌘↵']);
  assert.equal(form('w/R1').querySelector('[data-confirm="finish"]').getAttribute('class'), 'closes');
  assert.equal(form('w/a1').querySelector('[data-confirm="finish"]').getAttribute('class'), 'closes');
  for (const key of ['w/T1', 'w/P1']) assert.equal(form(key).querySelector('[data-confirm="finish"]'), null);
  assert.deepEqual(actions('w/T1'), ['Hold', 'Close', 'Notes']);
  assert.deepEqual(actions('w/P1'), ['Hold']);
  assert.deepEqual(actions('w/a1'), []);
  // Reply sends the message; Done, tapped or on ⌥↵, confirms and closes the card.
  form('w/R1').querySelector('textarea').value = 'Looks good';
  b.page.fire(b.root, 'submit', { target: form('w/R1'), submitter: form('w/R1').querySelector('button[data-intent="reply"]') });
  await b.settle();
  const pressed = [];
  form('w/R1').requestSubmit = (s) => pressed.push(s.textContent);
  const box = form('w/R1').querySelector('textarea');
  b.page.fire(b.root, 'keydown', { key: 'Enter', target: box, altKey: true });
  assert.deepEqual(pressed, ['Done⌥↵']);
  b.page.fire(b.root, 'submit', { target: form('w/R1'), submitter: form('w/R1').querySelector('[data-confirm="finish"]') });
  await b.settle();
  b.page.fire(b.root, 'click', { target: b.root.querySelector('details.item[data-key="w/T1"] .workflow [data-confirm="finish"]') });
  await b.settle();
  assert.deepEqual(b.confirms.slice(-2), ['Close R1? It moves to Done and Claude stops work on it.', 'Close T1? It moves to Done and Claude stops work on it.']);
  assert.deepEqual(sentNoIds(b), [['item-message', { key: 'w/R1', text: 'Looks good', intent: 'reply' }], ['card-done', { key: 'w/R1' }], ['card-done', { key: 'w/T1' }]]);
  // The box follows the card's lane.
  await b.change({ board: boardOf([{ ...cards[1], lane: 'review' }, ...cards.slice(2)]) });
  assert.deepEqual(sends('w/P1'), ['Done⌥↵', 'Reply⌘↵']);
  b.view.unmount();
});

// docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md
test("an In Progress card's quiet Hold opens the Hold sheet and its orange Resume, while the owner's hold is on, confirms the unhold; a Done card's quiet Reopen confirms and sends card-reopen; every box's other send is Reply", async () => {
  const cards = [
    workCard('P1', { lane: 'progress', holdable: true }),
    workCard('H1', { lane: 'progress', holdable: true, held: true }),
    workCard('U1', { lane: 'progress', holdable: true, builder: { phase: 'building', pause: { cause: 'usage', words: 'usage limit', paused: true } } }),
    workCard('D1', { lane: 'done' }),
  ];
  const holdChoices = [{ value: '1h', label: '1h', ms: 3_600_000 }];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: { ...boardOf(cards), holdChoices }, threads: Object.fromEntries(cards.map((c) => [c.key, []])), confirm: true });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const sends = (key) => [...form(key).querySelectorAll('button[type="submit"]')].map((el) => [el.textContent, el.getAttribute('class') || '', el.dataset.confirm ?? el.dataset.intent]);
  assert.deepEqual(sends('w/P1'), [['Hold⌥↵', '', 'hold'], ['Reply⌘↵', 'primary', 'reply']]);
  assert.deepEqual(sends('w/H1'), [['Resume⌥↵', 'unhold', 'resume'], ['Reply⌘↵', 'primary', 'reply']]);
  assert.deepEqual(sends('w/U1'), [['Hold⌥↵', '', 'hold'], ['Reply⌘↵', 'primary', 'reply']], 'a usage pause is no hold of yours');
  assert.deepEqual(sends('w/D1'), [['Reopen⌥↵', '', 'reopen'], ['Reply⌘↵', 'primary', 'reply']]);
  b.page.fire(b.root, 'submit', { target: form('w/P1'), submitter: form('w/P1').querySelector('[data-confirm="hold"]') });
  await b.settle();
  assert.equal(b.root.querySelector('#holdSheet').open, true);
  b.page.fire(b.root.querySelector('#holdClose'), 'click');
  for (const key of ['w/H1', 'w/D1']) {
    b.page.fire(b.root, 'submit', { target: form(key), submitter: form(key).querySelector('[data-confirm]') });
    await b.settle();
  }
  assert.deepEqual(b.confirms.slice(-2), ['Unhold H1? It can start again once nothing blocks it.', 'Reopen D1? It moves back to Todo, discussing, for you to talk it through again.']);
  assert.deepEqual(sentNoIds(b), [['card-hold', { key: 'w/H1', hold: false }], ['card-reopen', { key: 'w/D1' }]]);
  form('w/D1').querySelector('textarea').value = 'One more thing';
  b.page.fire(b.root, 'submit', { target: form('w/D1'), submitter: form('w/D1').querySelector('button[data-intent="reply"]') });
  await b.settle();
  assert.deepEqual(sentNoIds(b).at(-1), ['item-message', { key: 'w/D1', text: 'One more thing', intent: 'reply' }]);
  b.view.unmount();
});

test('a running badge replaces its install link without confirmation and becomes current after completion', async () => {
  const install = { url: 'https://m/app.apk', sha: 'abcdef1', older: true };
  const b = boardOnDom({ open: ['w/R1'], board: boardOf([workCard('R1', { lane: 'progress', install, builder: { kind: 'install' } })]), threads: {} });
  await b.settle();
  assert.equal(b.root.querySelector('.external-links .install').textContent, 'serving…');
  assert.equal(b.root.querySelector('.external-links .install').getAttribute('href'), null);
  assert.equal(b.root.querySelector('[data-install-confirm]'), null);
  assert.deepEqual(b.confirms, []);
  await b.change({ board: boardOf([workCard('R1', { install: { ...install, older: false } })]) });
  assert.equal(b.root.querySelector('.external-links .install').textContent, 'Install ');
});

test('a card try button confirms, posts through the site URL and reloads; disabled buttons only toast', async () => {
  const card = workCard('R1', { ref: 'INT-41', lane: 'progress', holdable: true, try: { kind: 'web', script: true, changes: true } });
  const b = boardOnDom({ open: ['w/R1'], board: boardOf([card]), threads: {}, confirm: true });
  await b.settle();
  const original = b.page.win.fetch;
  const posts = [];
  b.page.win.fetch = async (url, opts = {}) => {
    if (url.endsWith('/api/try')) { posts.push([url, JSON.parse(opts.body)]); return { ok: false, json: async () => ({ error: 'Already running' }) }; }
    return original(url, opts);
  };
  const workflow = b.root.querySelector('.workflow');
  assert.equal(workflow.children.at(-1).textContent, 'Serve');
  b.page.fire(b.root, 'click', { target: workflow.querySelector('[data-try]') });
  await b.settle();
  assert.deepEqual(b.confirms, ['Serve INT-41? The hub runs its build script.']);
  assert.deepEqual(posts, [['https://mac.ts.net/board-a/api/try', { key: 'w/R1' }]]);
  assert.match(b.root.textContent, /Already running/);
  await b.change({ board: boardOf([{ ...card, try: { ...card.try, kind: 'app', state: 'ready' } }]) });
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-try]') });
  await b.settle();
  assert.match(b.root.textContent, /Nothing new to serve: Install already has this task’s latest push./);
  assert.equal(posts.length, 1);
});

// docs/adr/2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md
test('a web card’s Serve asks the busy host’s question and sends anyway, a cap refusal is a dialog, and Kill confirms and posts the kill', async () => {
  const card = workCard('R1', { ref: 'INT-41', lane: 'progress', holdable: true, try: { kind: 'web', script: true, changes: true, hostBusy: true } });
  const b = boardOnDom({ open: ['w/R1'], board: boardOf([card]), threads: {}, confirm: true });
  await b.settle();
  const original = b.page.win.fetch;
  const posts = [];
  let answer = { ok: false, json: async () => ({ error: 'This board is at its cap of 2 parallel serves. Kill another serve, or raise Maximum parallel serves in Board settings.', ask: 'cap' }) };
  b.page.win.fetch = async (url, opts = {}) => {
    if (/\/api\/try(\/kill)?$/.test(url)) { posts.push([url, JSON.parse(opts.body)]); return answer; }
    return original(url, opts);
  };
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-try]') });
  await b.settle();
  assert.deepEqual(b.confirms, ['The host is busy, start this serve anyway?']);
  assert.deepEqual(posts, [['https://mac.ts.net/board-a/api/try', { key: 'w/R1', anyway: true }]]);
  assert.deepEqual(b.notices, ['This board is at its cap of 2 parallel serves. Kill another serve, or raise Maximum parallel serves in Board settings.']);
  // A busy host the board didn't show yet: the hub's refusal asks the same question, and the tap sends again with anyway.
  await b.change({ board: boardOf([{ ...card, try: { ...card.try, hostBusy: false } }]) });
  let refusals = 1;
  answer = { ok: false, json: async () => (refusals-- > 0 ? { error: 'The host is busy, start this serve anyway?', ask: 'busy' } : { status: 'started' }) };
  b.page.win.fetch = async (url, opts = {}) => {
    if (/\/api\/try(\/kill)?$/.test(url)) { posts.push([url, JSON.parse(opts.body)]); const out = await answer.json(); return { ok: !out.ask, json: async () => out }; }
    return original(url, opts);
  };
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-try]') });
  await b.settle();
  assert.deepEqual(b.confirms.slice(1), ['Serve INT-41? The hub runs its build script.', 'The host is busy, start this serve anyway?']);
  assert.deepEqual(posts.slice(1), [['https://mac.ts.net/board-a/api/try', { key: 'w/R1' }], ['https://mac.ts.net/board-a/api/try', { key: 'w/R1', anyway: true }]]);
  await b.change({ board: boardOf([{ ...card, try: { ...card.try, state: 'ready', port: 8500 } }]) });
  const kill = b.root.querySelector('[data-try-kill]');
  assert.equal(kill.textContent, 'Kill');
  b.page.fire(b.root, 'click', { target: kill });
  await b.settle();
  assert.equal(b.confirms.at(-1), 'Kill INT-41’s serve? Its server stops until you tap Serve.');
  assert.deepEqual(posts.at(-1), ['https://mac.ts.net/board-a/api/try/kill', { key: 'w/R1' }]);
});

test('main paints above the lanes, card failures scroll to their thread and main failures open a log and retry sheet', async () => {
  const data = { ...boardOf([workCard('R1', { try: { kind: 'web', state: 'failed', script: true, changes: true } })]), main: { kind: 'web', state: 'ready', slug: 'o/r', branch: 'main', sha: 'abcdef1', at: new Date(NOW).toISOString(), url: null, port: 8500, script: '.kickflip/build-web' } };
  const b = boardOnDom({ open: ['w/R1'], board: data, threads: {} });
  await b.settle();
  assert.equal(b.root.querySelector('#tryMain a').getAttribute('href'), 'https://mac.ts.net:8500/');
  assert.match(b.root.querySelector('#tryMain').textContent, /o\/rVisit.*main@abcdef1/);
  assert.doesNotMatch(b.root.innerHTML, /\u2197/);
  const links = [...b.root.querySelectorAll('.external-links a, #tryMain a.tone-ready')];
  assert.ok(links.length);
  for (const link of links) {
    assert.equal(link.querySelectorAll('svg.link-arrow').length, 1);
    assert.equal(link.querySelector('svg.link-arrow').getAttribute('aria-hidden'), 'true');
  }
  assert.ok(b.root.innerHTML.indexOf('id="tryMain"') < b.root.innerHTML.indexOf('id="lanes"'));
  assert.equal(b.root.querySelector('#tryMain button'), null);
  const scrolled = [];
  b.root.querySelector('details.item').scrollIntoView = () => scrolled.push('card');
  b.root.querySelector('.thread').scrollIntoView = () => scrolled.push('thread');
  b.page.win.location.hash = '#selectedCard=w%2FR1';
  const event = b.page.fire(b.root, 'click', { target: b.root.querySelector('.external-links [data-try-log]') });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(scrolled, ['thread']);

  const failed = { ...data, main: { ...data.main, state: 'failed' } };
  await b.change({ board: failed });
  const original = b.page.win.fetch;
  const posts = [];
  let lines = ['<script>bad & worse</script>', 'stopped'];
  let refusal = 'Try builds wait on Tailscale: Tailscale isn’t signed in';
  let resolvePost;
  let logReads = 0;
  let holdBoard = false;
  let releaseBoard;
  b.page.win.fetch = async (url, opts = {}) => {
    if (url.endsWith('/api/try/main/log')) {
      logReads++;
      return { ok: true, json: async () => ({ lines }) };
    }
    if (url.endsWith('/api/try')) {
      posts.push([url, JSON.parse(opts.body)]);
      if (!refusal) await new Promise((resolve) => { resolvePost = resolve; });
      return { ok: !refusal, json: async () => refusal ? { error: refusal } : { status: 'started' } };
    }
    if (url.endsWith('/api/board') && holdBoard) {
      holdBoard = false;
      const response = await original(url, opts);
      await new Promise((resolve) => { releaseBoard = resolve; });
      return response;
    }
    return original(url, opts);
  };
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-main-log]') });
  await b.settle();
  const sheet = b.root.querySelector('#mainLogSheet');
  const retry = b.root.querySelector('#mainLogRetry');
  assert.equal(sheet.open, true);
  assert.equal(b.root.querySelector('#mainLogTitle').textContent, 'Main’s serve failed');
  assert.match(b.root.querySelector('#mainLogSource').textContent, /^\.kickflip\/build-web stopped at main@abcdef1/);
  assert.match(b.root.querySelector('#mainLogLines').innerHTML, /&lt;script&gt;bad &amp; worse&lt;\/script&gt;/);
  b.page.fire(retry, 'click');
  await b.settle();
  assert.deepEqual(posts, [['https://mac.ts.net/board-a/api/try', { key: 'main' }]]);
  assert.equal(b.root.querySelector('#mainLogReason').textContent, refusal);
  assert.equal(b.root.querySelector('#mainLogReason').hidden, false);
  assert.equal(retry.disabled, false);
  assert.deepEqual(b.confirms, []);

  refusal = null;
  b.page.fire(retry, 'click');
  await b.settle();
  assert.deepEqual([retry.disabled, retry.getAttribute('aria-busy'), retry.textContent], [true, 'true', 'Retry'], 'Retry waits, its label kept behind the spinner, until main is up or fails');
  await b.change({ board: failed });
  assert.equal(logReads, 1);
  assert.equal(retry.disabled, true);
  const readsBeforeReload = logReads;
  holdBoard = true;
  const staleLoad = b.view.B.loadBoard();
  await b.settle();
  await b.change({ board: { ...failed, main: { ...failed.main, state: 'running' } } });
  resolvePost();
  await b.settle();
  releaseBoard();
  await staleLoad;
  assert.equal(logReads, readsBeforeReload);
  assert.equal(retry.disabled, true);
  lines = ['new failure'];
  await b.change({ board: failed });
  assert.equal(b.root.querySelector('#mainLogLines').textContent, 'new failure');
  assert.deepEqual([retry.disabled, retry.getAttribute('aria-busy')], [false, null]);

  b.page.fire(retry, 'click');
  await b.settle();
  await b.change({ board: { ...failed, main: { ...failed.main, state: 'running' } } });
  resolvePost();
  await b.settle();
  await b.change({ board: data });
  b.page.runTimers(180);
  assert.equal(sheet.open, false);
  assert.match(b.root.textContent, /Main is up again at abcdef1/);
  await b.change({ board: { ...failed, main: { ...failed.main, kind: 'app' } } });
  lines = [];
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-main-log]') });
  await b.settle();
  assert.equal(b.root.querySelector('#mainLogTitle').textContent, 'Main’s serve failed');
  assert.equal(b.root.querySelector('#mainLogLines').textContent, 'No log was written.');
  const cancel = b.page.fire(sheet, 'cancel');
  assert.equal(cancel.defaultPrevented, true);
  b.page.runTimers(180);
  assert.equal(sheet.open, false);
  b.view.unmount();
});

test("Main's refresh icon pulls now and spins only itself until a board shows Main moved, or the answer says nothing was pulled; a tap pulls again after a failure on any device, and a failed pull opens its reason", async () => {
  const main = { kind: 'web', state: 'ready', slug: 'o/r', branch: 'main', sha: 'abcdef1', at: new Date(NOW).toISOString(), url: null, port: 8500, pull: { running: false, error: null } };
  const data = { ...boardOf([]), main };
  const b = boardOnDom({ board: data, threads: {} });
  await b.settle();
  const original = b.page.win.fetch;
  const posts = [];
  let answer;
  b.page.win.fetch = async (url, opts = {}) => {
    if (url.endsWith('/api/try/main/pull')) {
      posts.push([url, opts.body]);
      return new Promise((resolve) => { answer = (out, ok = true) => resolve({ ok, json: async () => out }); });
    }
    return original(url, opts);
  };
  const icon = () => b.root.querySelector('#tryMain [data-main-pull]');
  b.page.fire(b.root, 'click', { target: icon() });
  await b.settle();
  assert.deepEqual(posts, [['https://mac.ts.net/board-a/api/try/main/pull', '{}']]);
  assert.deepEqual(waitState(icon()), WAITING);
  assert.match(b.root.querySelector('#tryMain').textContent, /Visit/);
  answer({ commits: 0 });
  await b.settle();
  assert.deepEqual(waitState(icon()), IDLE, 'a pull that brought no commits changes nothing a board shows, so its answer ends the spinner');

  // A pull that brought commits keeps the spinner past its answer, through a board that still shows nothing, until Main moves.
  b.page.fire(b.root, 'click', { target: icon() });
  await b.settle();
  answer({ commits: 2 });
  await b.settle();
  assert.deepEqual(waitState(icon()), WAITING);
  await b.change({ board: data });
  assert.deepEqual(waitState(icon()), WAITING);
  await b.change({ board: { ...data, main: { ...main, sha: '1234567', state: 'running' } } });
  assert.deepEqual(waitState(icon()), IDLE);
  await b.change({ board: data });
  posts.length = 1;

  const failed = { ...data, main: { ...main, pull: { running: false, error: 'can’t pull: local changes' } } };
  b.page.win.innerWidth = 390;
  await b.change({ board: failed });
  assert.match(icon().getAttribute('class'), /failed/);
  const why = () => b.root.querySelector('#tryMain .main-pull-why');
  assert.equal(why().textContent, 'can’t pull: local changes');
  assert.doesNotMatch(why().getAttribute('class'), /open/);
  // A tap pulls on every device, hover or not; the reason opens on its own only when that pull fails.
  const noHover = b.page.win.matchMedia;
  const tapAndAnswer = async (out, ok = true) => {
    b.page.fire(b.root, 'click', { target: icon() });
    await b.settle();
    answer(out, ok);
    await b.settle();
  };
  await tapAndAnswer({ commits: 0, error: 'can’t pull: local changes' });
  assert.equal(posts.length, 2);
  assert.match(why().getAttribute('class'), /open/);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('#lanes') });
  await b.settle();
  assert.doesNotMatch(why().getAttribute('class'), /open/);

  b.page.win.matchMedia = (query) => ({ ...noHover(query), matches: query === '(hover: hover)' || noHover(query).matches });
  await tapAndAnswer({ commits: 0, error: 'can’t pull: local changes' });
  assert.equal(posts.length, 3);
  assert.match(why().getAttribute('class'), /open/);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('#lanes') });
  await b.settle();
  b.page.win.matchMedia = noHover;

  await tapAndAnswer({ commits: 0 });
  assert.equal(posts.length, 4);
  assert.doesNotMatch(why().getAttribute('class'), /open/);
  await tapAndAnswer({ error: 'The hub is stopping.' }, false);
  assert.equal(posts.length, 5);
  assert.match(b.root.textContent, /The hub is stopping\./);
  assert.doesNotMatch(why().getAttribute('class'), /open/);
  b.view.unmount();
});

test('confirmations are the browser\'s own window.confirm, whatever labels a caller passes, and an aborted signal answers false without asking', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const native = [];
  let answer = true;
  page.win.confirm = (message) => { native.push(message); return answer; };
  page.win.alert = (message) => native.push(message);
  vm.runInContext(fs.readFileSync(new URL('./public/dialogs.js', import.meta.url), 'utf8'), page.win);
  const dialogs = page.win.BoardDialogs;
  assert.equal(await dialogs.confirm('Hold INT-143?'), true);
  assert.equal(await dialogs.confirm('Remove the key?', { ok: 'Remove' }), true);
  answer = false;
  assert.equal(await dialogs.confirm('Restart it?'), false);
  await dialogs.notice('Saved');
  assert.deepEqual(native, ['Hold INT-143?', 'Remove the key?', 'Restart it?', 'Saved']);
  const controller = new AbortController();
  controller.abort();
  answer = true;
  assert.equal(await dialogs.confirm('Never shown?', { signal: controller.signal }), false);
  assert.equal(native.length, 4);
});

test("every bumpable card, closed or open, carries the bump icon at its top right and no bump in its button rows; the icon sends card-bump with no confirm, and on a bumped card it is filled and sends card-unbump", async () => {
  const cards = [
    workCard('T1', { bumpable: true, bumpedAt: '2026-10-30T09:00:00.000Z' }),
    workCard('T2', { bumpable: true, bumpedAt: '2026-10-30T08:00:00.000Z' }),
    workCard('T3', { bumpable: true, holdable: true }),
    workCard('P1', { lane: 'progress', bumpable: true, bumpedAt: '2026-10-30T07:00:00.000Z', holdable: true }),
    workCard('H1', { bumpable: false, held: true, holdable: true }),
  ];
  const b = boardOnDom({ open: ['w/T1', 'w/T3', 'w/H1'], board: boardOf(cards), threads: {}, confirm: true });
  await b.settle();
  const card = (key) => b.root.querySelector(`details.item[data-key="${key}"]`);
  const icon = (key) => card(key).querySelector('summary .ask-actions button[data-card-bump]');
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.key, icon(c.key) ? [icon(c.key).getAttribute('aria-label'), icon(c.key).classList.contains('bumped'), icon(c.key).hasAttribute('disabled')] : null])), {
    'w/T1': ['Unbump', true, false], 'w/T2': ['Unbump', true, false], 'w/T3': ['Bump to top', false, false], 'w/P1': ['Unbump', true, false], 'w/H1': null,
  });
  for (const key of ['w/T1', 'w/T3', 'w/H1']) assert.equal(card(key).querySelector('.detail .actions [data-card-bump]'), null, key);
  assert.deepEqual(['w/T1', 'w/T3'].map((key) => card(key).querySelector('.detail .action-row.workflow')?.textContent.trim() ?? null), [null, 'Hold']);

  b.page.fire(b.root, 'click', { target: icon('w/T3') });
  await b.settle();
  b.page.fire(b.root, 'click', { target: icon('w/T2') });
  await b.settle();
  assert.deepEqual(b.confirms, []);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['card-bump', { key: 'w/T3' }], ['card-unbump', { key: 'w/T2' }]]);
});

// docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md
// A send that waits for the test: answer() settles the oldest, with the server's board, or refuses it with reason.
// What a board sent, without the send id the outbox gives each thread message.
function sentNoIds(b) {
  return JSON.parse(JSON.stringify(b.sent)).map(([kind, { sendId, ...data }]) => [kind, data]);
}
function heldSends() {
  const waiting = [];
  const send = (kind, data, server) => new Promise((resolve, reject) => {
    waiting.push({ ok: () => resolve({ id: 'e1', board: structuredClone(server.board) }), fail: (reason) => reject(Object.assign(new Error('send failed: 500'), { status: 500, reason })) });
  });
  return { send, answer: (ok = true, reason = '') => waiting.shift()[ok ? 'ok' : 'fail'](reason), waiting };
}
const boardGets = (b) => b.gets.filter((p) => p.endsWith('/api/board')).length;
// A waiting button is disabled, marked busy, and keeps its content, which style.css hides behind a spinner.
const waitState = (el) => [el.disabled, el.classList.contains('tap-waiting'), el.getAttribute('aria-busy')];
const WAITING = [true, true, 'true'];
const IDLE = [false, false, null];
const REFUSED = 'Couldn’t write t/T1 to its item file: EACCES: permission denied';

test("waitOn keeps a button waiting through a repaint that replaces it, found again by its data attributes, and settling gives it back the disabled state of its latest markup", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const { setHTML, waitOn } = page.win.BoardUI;
  const root = page.win.document.body.appendChild(new Element('div'));
  const row = (lead, disabled) => `<${lead}></${lead}><button class="primary" data-confirm="hold" data-key="w/T1"${disabled ? ' disabled' : ''}>Hold</button><button>Other</button>`;
  setHTML(root, row('span', false));
  const hold = () => root.querySelector('[data-confirm="hold"]');
  let answer;
  const first = hold();
  const sent = waitOn(first, new Promise((resolve) => { answer = resolve; }));
  assert.deepEqual([waitState(hold()), hold().getAttribute('class')], [WAITING, 'primary tap-waiting']);
  setHTML(root, `<p></p>${row('em', true)}`);
  assert.notEqual(hold(), first);
  assert.deepEqual([waitState(hold()), hold().textContent, waitState(root.querySelector('button:not([data-key])'))], [WAITING, 'Hold', IDLE]);
  answer('ok');
  assert.equal(await sent, 'ok');
  assert.deepEqual([hold().disabled, hold().classList.contains('tap-waiting'), hold().getAttribute('aria-busy')], [true, false, null]);
});

// docs/adr/2026-11-03-1915-every-pending-control-waits-in-one-style.md
test("waitOn with a group disables every choice of the setting while one saves, the spinner only in the tapped one, through a repaint, and settling gives each back its own disabled state", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const { setHTML, waitOn } = page.win.BoardUI;
  const root = page.win.document.body.appendChild(new Element('div'));
  const seg = (off) => `<div role="group"><button data-pick="a">A</button><button data-pick="b">B</button><button data-pick="c"${off ? ' disabled' : ''}>C</button></div>`;
  setHTML(root, seg(true));
  const pick = (v) => root.querySelector(`[data-pick="${v}"]`);
  let answer;
  const sent = waitOn(pick('b'), new Promise((resolve) => { answer = resolve; }), { group: root.querySelectorAll('button') });
  const looks = () => ['a', 'b', 'c'].map((v) => [pick(v).disabled, pick(v).getAttribute('aria-busy'), pick(v).classList.contains('tap-blocked')]);
  assert.deepEqual(looks(), [[true, null, true], [true, 'true', false], [true, null, true]]);
  setHTML(root, `<p></p>${seg(false)}`);
  assert.deepEqual(looks(), [[true, null, true], [true, 'true', false], [true, null, true]], 'a repaint keeps the whole group waiting');
  answer();
  await sent;
  assert.deepEqual(looks(), [[false, null, false], [false, null, false], [false, null, false]]);
});

test("waitOn on a toggle, select or field keeps its face, disabled, with a spinner just before it, or after its caption in a .tk-field, and a button drawn busy in its markup stays busy once the tap settles", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const { waitOn, BUSY } = page.win.BoardUI;
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = '<label class="who"><span>Auto-merge</span><input type="checkbox" class="toggle" id="autoMerge"></label>'
    + `<label class="tk-field"><span>Team</span><select data-tk="team"><option>ENG</option></select></label><button data-confirm="merge"${BUSY}>Merge</button>`;
  const toggle = root.querySelector('#autoMerge');
  const select = root.querySelector('select');
  let answer;
  const held = new Promise((resolve) => { answer = resolve; });
  const saves = Promise.all([waitOn(toggle, held), waitOn(select, held)]);
  const spinners = () => root.querySelectorAll('.tap-beside').map((s) => s.parentNode.tagName + (s.nextSibling === toggle ? ' before the toggle' : ''));
  assert.deepEqual([toggle.disabled, toggle.getAttribute('aria-busy'), select.disabled, spinners()], [true, 'true', true, ['LABEL before the toggle', 'SPAN']]);
  assert.equal(root.querySelector('.tk-field > span').textContent, 'Team');
  const merge = root.querySelector('[data-confirm="merge"]');
  const merging = waitOn(merge, held);
  answer();
  await Promise.all([saves, merging]);
  assert.deepEqual([toggle.disabled, toggle.getAttribute('aria-busy'), select.disabled, spinners()], [false, null, false, []]);
  assert.deepEqual([merge.disabled, merge.getAttribute('aria-busy'), merge.classList.contains('tap-waiting')], [true, 'true', false]);
});

test("a bump or unbump waits for the server: its icon pulses, disabled, and the card stays put through a board landing meanwhile, until the POST's board moves it with no reload of its own; a refusal leaves the card where it was and toasts the server's reason", async () => {
  const T1 = workCard('T1', { bumpable: true, bumpedAt: '2026-10-30T09:00:00.000Z', sortAt: '2026-10-01T00:00:00.000Z', order: 0 });
  const T2 = workCard('T2', { bumpable: true, sortAt: '2026-10-03T00:00:00.000Z', order: 1 });
  const T3 = workCard('T3', { bumpable: true, sortAt: '2026-10-02T00:00:00.000Z', order: 2 });
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([T1, T2, T3]), threads: {}, send: sends.send });
  await b.settle();
  const order = () => b.root.querySelectorAll('.lane[data-lane="todo"] details.item').map((el) => el.dataset.key);
  const icon = (key) => b.root.querySelector(`details.item[data-key="${key}"] button[data-card-bump]`);
  assert.deepEqual(order(), ['w/T1', 'w/T2', 'w/T3']);

  b.page.fire(b.root, 'click', { target: icon('w/T3') });
  assert.deepEqual([order(), waitState(icon('w/T3')), icon('w/T3').classList.contains('bumped')], [['w/T1', 'w/T2', 'w/T3'], WAITING, false]);
  await b.change({});
  assert.deepEqual([order(), waitState(icon('w/T3'))], [['w/T1', 'w/T2', 'w/T3'], WAITING], 'a repaint keeps the icon waiting');
  const loads = boardGets(b);
  b.server.board = boardOf([{ ...T3, bumpedAt: '2026-10-30T10:00:00.000Z' }, T1, T2]);
  sends.answer();
  await b.settle();
  assert.deepEqual([order(), waitState(icon('w/T3')), icon('w/T3').classList.contains('bumped')], [['w/T3', 'w/T1', 'w/T2'], IDLE, true]);
  assert.equal(boardGets(b), loads);
  assert.match(b.root.textContent, /Moved to the top/);

  b.page.fire(b.root, 'click', { target: icon('w/T1') });
  assert.deepEqual([order(), waitState(icon('w/T1'))], [['w/T3', 'w/T1', 'w/T2'], WAITING]);
  sends.answer(false, 'Couldn’t write the event: the board folder is read-only.');
  await b.settle();
  assert.deepEqual([order(), waitState(icon('w/T1')), icon('w/T1').classList.contains('bumped')], [['w/T3', 'w/T1', 'w/T2'], IDLE, true]);
  assert.match(b.root.textContent, /Couldn’t write the event: the board folder is read-only\./);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['card-bump', { key: 'w/T3' }], ['card-unbump', { key: 'w/T1' }]]);
  b.view.unmount();
});

// docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md
const newAsk = (id, at, state = 'waiting', text = `Task ${id}`) => ({ ...askCard(id, 'todo'), isNew: true, created: at, sortAt: at, ask: { eventId: id, state, text, canEdit: true } });
test("a sent ask sits in the New strip above the lanes, never in Todo, reading waiting… then processing...; once ingested it links to its ticket or the card it was added to, with Dismiss in place of Edit and Delete, until it is dismissed or that card is read", async () => {
  const waiting = newAsk('a1', '2026-10-30T09:00:00.000Z', 'waiting', 'Fix the header\nIt jumps on scroll');
  const working = newAsk('a2', '2026-10-30T09:10:00.000Z', 'working', 'Dark mode');
  const made = { ...askCard('a3', 'todo'), id: 'T-7', key: 'w/T-7', ref: 'T-7', title: 'feat: rate limits', phase: 'discussing', turn: 'owner', created: '2026-10-30T08:00:00.000Z', ingested: { at: '2026-10-30T09:20:00.000Z', text: 'Rate limits per API key' } };
  const readAlready = { ...made, id: 'T-8', key: 'w/T-8', ref: 'T-8', fromAsk: 'a5', ingested: { at: '2026-10-30T07:00:00.000Z', text: 'Old' } };
  const into = workCard('T-2', { title: 'Header polish' });
  const merges = [{ key: 'w/T-2', ref: 'T-2', text: 'Also the footer', at: '2026-10-30T09:30:00.000Z', id: 'a4', askedAt: '2026-10-30T09:15:00.000Z', message: 'Also the footer\nand the nav' }];
  const seen = { 'w/T-7': '2026-10-30T09:00:00.000Z', 'w/T-8': '2026-10-30T08:00:00.000Z', 'w/T-2': '2026-10-30T09:00:00.000Z' };
  const b = boardOnDom({ board: { ...boardOf([waiting, working, made, readAlready, into]), merges }, seen, threads: {}, width: 1280 });
  await b.settle();
  const strip = () => b.root.querySelector('#newStrip');
  const afterClick = async () => { b.page.runTimers(0); await b.settle(); };
  const entries = () => strip().querySelectorAll('.new-entry');
  const entry = (id) => strip().querySelector(`.new-entry[data-new="${id}"]`);
  // Above the lanes, titled New with its count; its entries are the asks, oldest sent first.
  assert.equal(strip().hidden, false);
  const ids = strip().parentNode.childNodes.filter((n) => n.nodeType === 1).map((n) => n.getAttribute('id'));
  assert.equal(ids.indexOf('newStrip') + 1, ids.indexOf('lanes'), 'the strip sits directly above the lanes');
  assert.deepEqual([strip().querySelector('.new-head .lane-name').textContent, strip().querySelector('.new-head .count').textContent], ['New', '4']);
  assert.deepEqual(entries().map((el) => el.dataset.new), ['a3', 'a1', 'a2', 'a4']);
  assert.deepEqual(entries().map((el) => el.querySelector('.new-msg').textContent), ['Rate limits per API key', 'Fix the header\nIt jumps on scroll', 'Dark mode', 'Also the footer\nand the nav']);
  assert.deepEqual(entries().map((el) => el.querySelector('.new-line').textContent.trim().replace(/^.*?\d{1,2}:\d{2}\s?[AP]M · /i, '')), ['Ticket created: T-7 · feat: rate limits', 'waiting…', 'processing...', 'Added to T-2']);
  assert.equal(b.root.querySelector('#lanes [data-key="w/a1"], #lanes [data-key="w/a2"]'), null);
  assert.deepEqual(b.root.querySelectorAll('.lane[data-lane="todo"] details.item').map((el) => el.dataset.key), ['w/T-7', 'w/T-8', 'w/T-2']);
  // Waiting and processing entries edit and delete their ask; ingested ones link to the card and dismiss.
  assert.deepEqual(['a1', 'a2'].map((id) => [entry(id).querySelector('button[data-edit]')?.dataset.edit, entry(id).querySelector('button[data-withdraw]')?.dataset.withdraw, entry(id).querySelector('[data-dismiss-new]')]), [['a1', 'a1', null], ['a2', 'a2', null]]);
  assert.deepEqual(['a3', 'a4'].map((id) => [entry(id).querySelector('a.new-link').getAttribute('href'), entry(id).querySelector('button[data-edit], button[data-withdraw]'), entry(id).querySelector('button[data-dismiss-new]').getAttribute('aria-label') + '|' + entry(id).querySelector('button[data-dismiss-new]').textContent]),
    [['#selectedCard=w%2FT-7', null, 'Dismiss|'], ['#selectedCard=w%2FT-2', null, 'Dismiss|']]);
  // The merge is the strip's, not the answer banner's.
  assert.equal(b.root.querySelector('#answers').hidden, true);
  // Dismiss asks nothing and marks the card read at the ingest, on every device.
  b.page.fire(b.root, 'click', { target: entry('a3').querySelector('button[data-dismiss-new]') });
  b.page.fire(b.root, 'click', { target: entry('a4').querySelector('button[data-dismiss-new]') });
  await afterClick();
  assert.deepEqual(b.confirms, []);
  assert.deepEqual(b.posts.filter(([p]) => p.endsWith('/api/read')).map(([, body]) => body), [{ marks: { 'w/T-7': '2026-10-30T09:20:00.000Z' } }, { marks: { 'w/T-2': '2026-10-30T09:30:00.000Z' } }]);
  assert.deepEqual(entries().map((el) => el.dataset.new), ['a1', 'a2']);
  // With nothing in it, the strip hides.
  await b.change({ board: { ...boardOf([made, into]), merges } });
  assert.equal(strip().hidden, true);
  b.view.unmount();
});

test("a New strip link still names its ticket when the browser follows it: the strip repaints after the click, and the clicked entry is removed, not reused for the next", async () => {
  const mk = (n, ask, at) => ({ ...askCard(ask, 'todo'), id: `T-${n}`, key: `w/T-${n}`, ref: `T-${n}`, title: `feat: ticket ${n}`, phase: 'discussing', turn: 'owner', created: '2026-10-30T08:00:00.000Z', ingested: { at, text: `Ask ${n}` } });
  const b = boardOnDom({ board: boardOf([mk(7, 'a3', '2026-10-30T09:20:00.000Z'), mk(8, 'a5', '2026-10-30T09:25:00.000Z')]), seen: {}, threads: {}, width: 1280 });
  await b.settle();
  const links = () => b.root.querySelectorAll('#newStrip a.new-link');
  const [first, second] = links();
  assert.deepEqual([first.getAttribute('href'), second.getAttribute('href')], ['#selectedCard=w%2FT-7', '#selectedCard=w%2FT-8']);
  b.page.fire(b.root, 'click', { target: first });
  assert.equal(first.getAttribute('href'), '#selectedCard=w%2FT-7', 'the link the browser follows is unchanged by the click');
  b.page.runTimers(0);
  await b.settle();
  assert.deepEqual(links().map((a) => a.getAttribute('href')), ['#selectedCard=w%2FT-8']);
  assert.equal(links()[0], second, 'the second entry keeps its own node');
  b.page.fire(b.root, 'click', { target: second });
  assert.equal(second.getAttribute('href'), '#selectedCard=w%2FT-8', 'a lone entry keeps its link through its click');
  b.page.runTimers(0);
  await b.settle();
  b.view.unmount();
});

test("an ask in the New strip edits in place: its edit box opens in its entry, Save sends the edit and the new text shows once the server answers, and Cancel closes it", async () => {
  const a1 = newAsk('a1', '2026-10-30T09:00:00.000Z', 'waiting', 'Fix the header');
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([a1]), threads: {}, send: sends.send });
  await b.settle();
  const entry = () => b.root.querySelector('#newStrip .new-entry[data-new="a1"]');
  const form = () => entry().querySelector('form.edit-form[data-edit-form="a1"]');
  b.page.fire(b.root, 'click', { target: entry().querySelector('button[data-edit]') });
  await b.settle();
  assert.equal(form().querySelector('textarea').value, 'Fix the header');
  assert.equal(entry().querySelector('.new-msg'), null);
  form().querySelector('textarea').value = 'Fix the footer';
  b.page.fire(b.root, 'submit', { target: form() });
  assert.equal(waitState(form().querySelector('button[type="submit"]'))[0], true);
  b.server.board = boardOf([{ ...a1, ask: { ...a1.ask, text: 'Fix the footer', edited: true } }]);
  sends.answer();
  await b.settle();
  assert.equal(form(), null);
  assert.equal(entry().querySelector('.new-msg').textContent, 'Fix the footer');
  assert.match(entry().querySelector('.new-line').textContent, /Edited/);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['ask-edited', { id: 'a1', key: 'w/a1', text: 'Fix the footer' }]]);
  b.page.fire(b.root, 'click', { target: entry().querySelector('button[data-edit]') });
  await b.settle();
  b.page.fire(b.root, 'click', { target: form().querySelector('button[data-edit-cancel]') });
  await b.settle();
  assert.deepEqual([form(), entry().querySelector('.new-msg').textContent], [null, 'Fix the footer']);
  b.view.unmount();
});

test("deleting an ask from the New strip is one events POST: its trash icon waits, the entry stays until the server answers, then leaves with the POST's board; a refusal keeps it and toasts the reason", async () => {
  const a1 = newAsk('a1', '2026-10-30T09:00:00.000Z');
  const a2 = newAsk('a2', '2026-10-30T09:10:00.000Z');
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([a1, a2]), threads: {}, send: sends.send, confirm: true });
  await b.settle();
  const keys = () => b.root.querySelectorAll('#newStrip .new-entry').map((el) => el.dataset.key);
  const trash = (id) => b.root.querySelector(`#newStrip .new-entry[data-new="${id}"] button[data-withdraw]`);
  b.page.fire(b.root, 'click', { target: trash('a1') });
  await b.settle();
  assert.deepEqual([keys(), waitState(trash('a1'))], [['w/a1', 'w/a2'], WAITING]);
  b.server.board = boardOf([a2]);
  sends.answer();
  await b.settle();
  assert.deepEqual(keys(), ['w/a2']);
  assert.match(b.root.textContent, /Deleted/);

  b.page.fire(b.root, 'click', { target: trash('a2') });
  await b.settle();
  sends.answer(false, 'Couldn’t write the event: the board folder is read-only.');
  await b.settle();
  assert.deepEqual([keys(), waitState(trash('a2'))], [['w/a2'], IDLE]);
  assert.match(b.root.textContent, /the board folder is read-only/);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['ask-withdrawn', { id: 'a1', key: 'w/a1' }], ['ask-withdrawn', { id: 'a2', key: 'w/a2' }]]);
  assert.deepEqual(b.posts, [], 'nothing posts besides the one events POST');
  b.view.unmount();
});

// docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md: each button on a card that waits on its tap,
// the card it sits on, the event it sends, and the card once a board shows its change. A Merge rests on its board in the
// Merge race test below.
const HOLD_CHOICES = [{ value: '1h', label: '1h', ms: 3_600_000 }];
const CARD_TAPS = [
  { name: 'Unhold', card: workCard('H1', { held: true, holdable: true }), act: 'resume', kind: 'card-hold', changed: (c) => ({ ...c, held: false }) },
  { name: 'a Hold sheet chip', card: workCard('T1', { holdable: true }), act: 'hold', sheet: true, kind: 'card-hold', changed: (c) => ({ ...c, held: true, heldUntil: '2026-10-30T11:00:00.000Z' }) },
  { name: 'Done', card: workCard('F1', { finishable: true }), act: 'finish', kind: 'card-done', changed: (c) => ({ ...c, lane: 'done', storedLane: 'done' }) },
  { name: 'a bump', card: workCard('B1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 0 }), kind: 'card-bump', changed: (c) => ({ ...c, bumpedAt: '2026-10-30T10:00:01.000Z' }) },
  { name: 'Merge', card: workCard('M1', { lane: 'review', action: { kind: 'merge', url: '#selectedCard=w%2FM1', label: 'Merge' } }), act: 'merge', kind: 'card-merge' },
];

// A board holding the row's card open, its button tapped (and the Hold sheet's chip after it), its POST held.
async function tapCard(row) {
  const sends = heldSends();
  const b = boardOnDom({ open: [row.card.key], board: { ...boardOf([row.card]), holdChoices: HOLD_CHOICES }, threads: {}, send: sends.send, confirm: true });
  await b.settle();
  const card = () => b.root.querySelector(`details.item[data-key="${row.card.key}"]`);
  const button = () => card().querySelector(row.act ? `[data-confirm="${row.act}"]` : 'button[data-card-bump]');
  const before = { label: button().textContent, lane: card().closest('.lane').dataset.lane };
  b.page.fire(b.root, 'click', { target: button() });
  if (row.sheet) b.page.fire(b.root.querySelector('#holdSheet'), 'click', { target: b.root.querySelector('#holdSheet [data-hold-for]') });
  await b.settle();
  return { b, sends, card, button, before };
}

for (const row of CARD_TAPS) {
  test(`${row.name} waits on its button, disabled with its label kept, while the card stays as it was, and a refusal rests it and toasts the server's reason`, async () => {
    const { b, sends, card, button, before } = await tapCard(row);
    assert.deepEqual([waitState(button()), button().textContent, card().closest('.lane').dataset.lane], [WAITING, before.label, before.lane]);
    sends.answer(false, REFUSED);
    await b.settle();
    assert.deepEqual(waitState(button()), IDLE);
    assert.ok(b.root.textContent.includes(REFUSED));
    assert.deepEqual(JSON.parse(JSON.stringify(b.sent)).map(([kind]) => kind), [row.kind]);
    b.view.unmount();
  });
}

// docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md
test("a Merge tap spins until a board shows the card left In Review or the merge refused, with no idle Merge in between, even when a reload races the POST", async () => {
  const merge = { kind: 'merge', url: '#selectedCard=w%2FM1', label: 'Merge' };
  const at = (s) => `2026-10-30T10:00:0${s}.000Z`;
  const boardAt = (s, cards) => ({ ...boardOf(cards), generatedAt: at(s), version: `v${s}` });
  const idle = (id) => workCard(id, { lane: 'review', action: { ...merge, url: `#selectedCard=w%2F${id}` } });
  const merging = (id) => workCard(id, { lane: 'review', merging: true, action: null, next: 'Merging' });
  let answer;
  const send = () => new Promise((resolve) => { answer = resolve; });
  const b = boardOnDom({ open: ['w/M1', 'w/M2'], board: boardAt(0, [idle('M1'), idle('M2')]), threads: {}, send, confirm: true });
  await b.settle();
  const button = (id) => b.root.querySelector(`details.item[data-key="w/${id}"] [data-confirm="merge"]`);
  const busy = (id) => [button(id).disabled, button(id).getAttribute('aria-busy')];
  const BUSY = [true, 'true'];
  // Board reloads wait at the gate until the test opens it.
  const fetch = b.page.win.fetch;
  let open = null;
  let gate = null;
  b.page.win.fetch = (url, opts) => (gate && String(url).includes('api/board') ? gate.then(() => fetch(url, opts)) : fetch(url, opts));

  b.page.fire(b.root, 'click', { target: button('M1') });
  await b.settle();
  assert.deepEqual(busy('M1'), BUSY);
  // A reload lands mid-POST, so the POST's patch no longer fits the board on screen; its own reload is slow.
  await b.change({ board: boardAt(1, [idle('M1'), idle('M2')]) });
  assert.deepEqual(busy('M1'), BUSY, 'a board from before the tap keeps the spinner');
  gate = new Promise((r) => { open = r; });
  b.server.board = boardAt(2, [merging('M1'), idle('M2')]);
  answer({ id: 'e1', board: { since: 'v0', version: 'v2', generatedAt: at(2), set: {}, unset: [], lists: {} } });
  await b.settle();
  assert.deepEqual(busy('M1'), BUSY, 'the POST answered but its board has not landed');
  gate = null;
  open();
  await b.settle();
  assert.deepEqual(busy('M1'), BUSY);
  await b.change({ board: boardAt(3, [merging('M1'), idle('M2')]) });
  assert.deepEqual(busy('M1'), BUSY, 'a status line keeps it merging');
  await b.change({ board: boardAt(4, [workCard('M1', { lane: 'done', storedLane: 'done' }), idle('M2')]) });
  assert.equal(button('M1'), null);
  assert.equal(b.root.querySelector('details.item[data-key="w/M1"]').closest('.lane').dataset.lane, 'done');

  // A refusal: the board after the tap shows the card still In Review and no longer merging.
  b.page.fire(b.root, 'click', { target: button('M2') });
  await b.settle();
  b.server.board = boardAt(5, [workCard('M1', { lane: 'done', storedLane: 'done' }), merging('M2')]);
  answer({ id: 'e2', board: structuredClone(b.server.board) });
  await b.settle();
  assert.deepEqual(busy('M2'), BUSY);
  await b.change({ board: boardAt(6, [workCard('M1', { lane: 'done', storedLane: 'done' }), idle('M2')]) });
  assert.deepEqual(busy('M2'), [false, null]);
  b.view.unmount();
});

// docs/adr/2026-11-03-1915-every-pending-control-waits-in-one-style.md
test("a thread's Reply never waits, and the New task sheet's Send waits, disabled with its label kept, until the server answers, and the sheet has no Sending… line", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/T1"]');
  const send = () => form().querySelector('button[data-intent="reply"]');
  form().querySelector('textarea').value = 'Ship it';
  b.page.fire(b.root, 'submit', { target: form(), submitter: send() });
  await b.settle();
  assert.deepEqual([...waitState(send()), send().textContent], [...IDLE, 'Reply⌘↵']);
  sends.answer();
  await b.settle();

  b.root.querySelector('#askText').value = 'A new task';
  const askSend = b.root.querySelector('#askForm button[data-nth="0"]');
  b.page.fire(b.root.querySelector('#askForm'), 'submit', { target: b.root.querySelector('#askForm'), submitter: askSend });
  await b.settle();
  assert.deepEqual([...waitState(askSend), b.root.querySelector('#askStatus').textContent], [...WAITING, '']);
  sends.answer();
  await b.settle();
  assert.deepEqual(waitState(askSend), IDLE);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)).map(([kind]) => kind), ['item-message', 'ask']);
  b.view.unmount();
});

test("Done lands from the events POST's board in one round trip, with no reload of its own, and the change signal after it reloads the board once", async () => {
  const b = boardOnDom({ open: ['w/D1'], board: boardOf([workCard('D1', { actionButton: 'done', finishable: true })]), threads: {}, confirm: true });
  await b.settle();
  const loads = boardGets(b);
  b.server.board = boardOf([workCard('D1', { lane: 'done', actionButton: null })]);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('button[data-confirm="finish"]') });
  await b.settle();
  assert.ok(b.root.querySelector('.lane[data-lane="done"] details.item[data-key="w/D1"]'));
  assert.equal(boardGets(b), loads);
  await b.change({});
  assert.equal(boardGets(b), loads + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['card-done', { key: 'w/D1' }]]);
  b.view.unmount();
});

test("an ask's edit Save waits for the server with the edit box open; once it answers the new text shows in the New strip, and a refusal keeps the box with what was typed and toasts the reason", async () => {
  const a1 = newAsk('a1', '2026-10-30T09:00:00.000Z', 'waiting', 'Fix the header');
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([a1]), threads: {}, send: sends.send });
  await b.settle();
  const entry = () => b.root.querySelector('#newStrip .new-entry[data-new="a1"]');
  const form = () => entry().querySelector('.edit-form');
  const save = () => form().querySelector('button[type="submit"]');
  b.page.fire(b.root, 'click', { target: entry().querySelector('button[data-edit]') });
  await b.settle();
  form().querySelector('textarea').value = 'Fix the footer';
  b.page.fire(b.root, 'submit', { target: form() });
  assert.deepEqual([waitState(save()), form().querySelector('textarea').value], [WAITING, 'Fix the footer']);
  sends.answer(false, 'The board server is restarting. Try again in a moment.');
  await b.settle();
  assert.deepEqual([waitState(save()), form().querySelector('textarea').value], [IDLE, 'Fix the footer']);
  assert.match(b.root.textContent, /The board server is restarting/);

  b.page.fire(b.root, 'submit', { target: form() });
  b.server.board = boardOf([{ ...a1, ask: { ...a1.ask, text: 'Fix the footer', edited: true } }]);
  sends.answer();
  await b.settle();
  assert.equal(form(), null);
  assert.equal(entry().querySelector('.new-msg').textContent, 'Fix the footer');
  b.view.unmount();
});

// #137: every text box the owner sends from attaches through attach.js: its button inside the box (#256), a file list, and a drop zone round the box.
const composerParts = (form) => form && {
  composer: Boolean(form.closest('[data-composer]')),
  button: Boolean(form.querySelector('.attach input[type="file"][data-attach]')),
  files: Boolean(form.querySelector('[data-files]')),
  drop: Boolean(form.querySelector('.dz > textarea') && form.querySelector('.dz > .dz-hint')),
};
const EVERY_PART = { composer: true, button: true, files: true, drop: true };

test("every text box on a board the owner sends from, the new task, a thread reply and an ask's edit box, takes attachments the same way", async () => {
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1'), newAsk('a1', '2026-10-30T09:00:00.000Z', 'waiting', 'Fix the header')]), threads: { 'w/T1': [] } });
  await b.settle();
  b.page.fire(b.root, 'click', { target: b.root.querySelector('#newStrip .new-entry[data-new="a1"] button[data-edit]') });
  await b.settle();
  const edit = b.root.querySelector('#newStrip .edit-form');
  assert.equal(edit.dataset.composer, 'edit:a1');
  assert.deepEqual([b.root.querySelector('#askForm'), b.root.querySelector('form[data-reply="w/T1"]'), edit].map(composerParts), [EVERY_PART, EVERY_PART, EVERY_PART]);
  b.view.unmount();
});

test("an ask's edit box's attached files go with the edit, Save waits while they upload, and the sent edit clears them", async () => {
  const b = boardOnDom({ board: boardOf([newAsk('a1', '2026-10-30T09:00:00.000Z', 'waiting', 'Fix the header')]), threads: {} });
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  let busy = true;
  const cleared = [];
  Object.assign(b.page.win.BoardAttach, { files: (id) => (id === 'edit:a1' ? [shot] : []), busy: (id) => id === 'edit:a1' && busy, clear: (id) => cleared.push(id) });
  await b.settle();
  b.page.fire(b.root, 'click', { target: b.root.querySelector('#newStrip .new-entry[data-new="a1"] button[data-edit]') });
  await b.settle();
  const form = () => b.root.querySelector('#newStrip .edit-form[data-edit-form="a1"]');
  form().querySelector('textarea').value = 'Fix the footer';
  b.page.fire(b.root, 'submit', { target: form() });
  await b.settle();
  assert.deepEqual(b.sent, [], 'an upload still running holds the save');
  busy = false;
  b.page.fire(b.root, 'submit', { target: form() });
  await b.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['ask-edited', { id: 'a1', key: 'w/a1', text: 'Fix the footer', files: [shot] }]]);
  assert.deepEqual(cleared, ['edit:a1']);
  b.view.unmount();
});

test("a question's note on Waiting on you takes attachments the same way as the board's text boxes", async () => {
  const question = { id: 'q1', topic: 'item:w/T1', source: '', question: 'Question?', context: '', options: [{ id: 'A', label: 'Yes' }], answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question], at: 'q1' });
  await v.settle();
  assert.deepEqual(composerParts(v.root.querySelector('section.q[data-q="q1"] [data-composer="q:q1"]')), EVERY_PART);
  v.unmount();
});

test("Waiting on you names a card's topic from its card, since the board sends that topic with no title", async () => {
  const question = { id: 'q1', topic: 'item:w/T1', source: '', question: 'Question?', context: '', options: [{ id: 'A', label: 'Yes' }], answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', card: 'w/T1' }], items: [workCard('T1', { ref: 'INT-1', title: 'Search' })], questions: [question], at: 'q1' });
  await v.settle();
  assert.match(v.root.querySelector('.topichead').textContent, /^INT-1: Search$/);
  v.unmount();
});

test('Hold opens a sheet of the shared duration picker in place of a confirm, whose chip sends card-hold with that choice, and Unhold confirms naming the time', async () => {
  const until = new Date(NOW + 2 * 86_400_000).toISOString();
  const holdChoices = [['1h', '1h', 3_600_000], ['3h', '3h', 10_800_000], ['6h', '6h', 21_600_000], ['1d', '1d', 86_400_000], ['forever', 'Forever', null]].map(([value, label, ms]) => ({ value, label, ms }));
  const cards = [workCard('T1', { ref: 'INT-41', holdable: true }), workCard('P1', { ref: 'INT-43', lane: 'progress', holdable: true }), workCard('H1', { ref: 'INT-42', held: true, heldUntil: until, holdable: true })];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: { ...boardOf(cards), holdChoices }, threads: {}, confirm: true });
  await b.settle();
  const button = (key, act) => b.root.querySelector(`details.item[data-key="${key}"] [data-confirm="${act}"]`);
  const sheet = b.root.querySelector('#holdSheet');
  b.page.fire(b.root, 'click', { target: button('w/P1', 'hold') });
  await b.settle();
  assert.deepEqual([sheet.open, sheet.querySelector('#holdTitle').textContent, sheet.querySelector('#holdLede').textContent],
    [true, 'Hold INT-43', 'Claude stops work on it until then. Forever holds it until you unhold it.']);
  b.page.fire(sheet.querySelector('#holdClose'), 'click');
  b.page.runTimers();
  assert.equal(sheet.open, false);
  b.page.fire(b.root, 'click', { target: button('w/T1', 'hold') });
  await b.settle();
  assert.deepEqual(b.confirms, []);
  assert.deepEqual([sheet.open, sheet.querySelector('#holdTitle').textContent, sheet.querySelector('#holdLede').textContent],
    [true, 'Hold INT-41', 'It won’t start until then. Forever holds it until you unhold it.']);
  const chips = sheet.querySelectorAll('[data-hold-for]');
  // The page words each chip's end from its length when the sheet opens.
  const words = (ms) => (ms === null ? 'until you unhold it' : `until ${b.page.win.BoardUI.heldUntilWords(new Date(NOW + ms))}`);
  assert.deepEqual(chips.map((c) => [c.textContent, c.getAttribute('aria-label')]), holdChoices.map((c) => [c.label, `${c.label}, ${words(c.ms)}`]));
  assert.ok(sheet.querySelector('.dur-custom [data-hold-at]'));
  b.page.fire(sheet, 'click', { target: chips[1] });
  await b.settle();
  b.page.runTimers();
  assert.equal(sheet.open, false);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['card-hold', { key: 'w/T1', hold: true, for: '3h' }]]);
  b.page.fire(b.root, 'click', { target: button('w/H1', 'resume') });
  await b.settle();
  assert.deepEqual(b.confirms, [`Unhold INT-42? It's held until ${b.page.win.BoardUI.heldUntilWords(until)}. It can start again once nothing blocks it.`]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent.at(-1))), ['card-hold', { key: 'w/H1', hold: false }]);
});

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
test("a stale card's status line is no button, closed or open, and a stalled card's Send is the orange control that clears its Action needed", async () => {
  for (const open of [[], ['w/S1']]) {
    const item = workCard('S1', { lane: 'progress', stale: true, builder: { stale: true, progress: 'Running tests', at: null } });
    const b = boardOnDom({ open, board: boardOf([item]), threads: { 'w/S1': [] } });
    await b.settle();
    const line = b.root.querySelector('summary .line3.agent');
    assert.deepEqual([line.tagName.toLowerCase(), line.classList.contains('stale'), line.textContent], ['div', false, 'Running tests']);
    assert.equal(b.root.querySelector('[data-confirm="nudge"]'), null);
    b.view.unmount();
  }
  const stalled = workCard('S1', { lane: 'progress', stalled: 'Crashed twice', action: { kind: 'stalled', url: '#selectedCard=w%2FS1', label: 'stalled: Crashed twice' }, resolvedBy: 'reply' });
  const b = boardOnDom({ open: ['w/S1'], board: boardOf([stalled]), threads: { 'w/S1': [] } });
  await b.settle();
  const send = b.root.querySelector('form[data-reply="w/S1"] button[data-intent="reply"]');
  assert.deepEqual([send.textContent, send.classList.contains('resolves')], ['Reply⌘↵', true]);
  await b.change({ board: boardOf([workCard('S1', { lane: 'progress' })]) });
  assert.equal(b.root.querySelector('form[data-reply="w/S1"] button[data-intent="reply"]').classList.contains('resolves'), false);
  b.view.unmount();
});

test("every owner action kind the board derives makes exactly one of the open card's buttons orange, every action button the board names draws, and the board and the page share one frozen enum of buttons and one of action kinds, each value its name", async () => {
  const question = (id, url = null) => ({ id: `q${id}`, topic: `item:w/${id}`, question: 'Which?', options: [{ id: 'A', label: 'One' }], url });
  const draft = { state: 'OPEN', isDraft: true, checks: { state: 'pass' }, reviews: {} };
  const approved = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', checks: { state: 'pass' }, reviews: {} };
  const built = buildBoard({
    fromWaves: false, now: Date.parse('2026-10-30T10:00:00Z'),
    prs: { 'o/r#1': draft, 'o/r#2': approved, 'o/r#3': approved },
    owner: { items: [question('P', 'prototype-x.html?q=qP'), question('Q')] },
    files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [
      { id: 'P', title: 'Pick' }, { id: 'Q', title: 'Questions' }, { id: 'R', title: 'Ready', pr: 1 },
      { id: 'S', title: 'Steps', pr: 2, manual_steps: ['Run the backfill'] }, { id: 'M', title: 'Merge', pr: 3 }, { id: 'G', title: 'Grill' },
      { id: 'X', title: 'Stalled', lane: 'progress', stalled: { reason: 'Crashed twice', at: '2026-10-30T09:00:00Z' } },
      { id: 'I', title: 'Implement', phase: 'discussing', waits_on_owner: { on: 'implement', at: '2026-10-30T09:00:00Z' } },
      { id: 'C', title: 'Close', waits_on_owner: { on: 'close', at: '2026-10-30T09:00:00Z' } },
    ] } }],
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
    const counts = Object.fromEntries(items.map((i) => [i.key, [row(i.key)?.querySelectorAll('.action-row.workflow a, .action-row.workflow button').length ?? 0, row(i.key)?.querySelectorAll('.actions .resolves, .external-links .resolves, form[data-reply] .resolves').length ?? 0]]));
    return { counts, ui: b.page.win.BoardUI };
  };
  const shown = await mounted(built.items);
  const without = await mounted(built.items.map((i) => ({ ...i, actionButton: null })));
  for (const i of built.items) {
    const [controls, orange] = shown.counts[i.key];
    assert.deepEqual([controls - without.counts[i.key][0], orange], [i.actionButton ? 1 : 0, i.action ? 1 : 0], `${i.key}: ${i.actionButton}, ${i.action?.kind}`);
    assert.equal(Boolean(i.prototypes?.open), i.action?.kind === ACTION_KIND.pick, i.key);
  }

  for (const [name, values] of Object.entries({ BUTTON, ACTION_KIND })) {
    assert.deepEqual({ ...shown.ui[name] }, { ...values }, name);
    for (const e of [values, shown.ui[name]]) {
      assert.ok(Object.isFrozen(e), name);
      assert.deepEqual(Object.entries(e).filter(([k, v]) => k !== v), [], name);
    }
  }
  assert.throws(() => { BUTTON.merge = 'done'; }, TypeError);
});

test("a card opened with more than 3 unread messages shows them all, and once closed reopens at its newest 3; Show more adds 3 older ones, and a new message adds below without hiding any until the card closes", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const said = (n, text, extra) => ({ ts: at(n), who: 'claude', text, ...extra });
  const msgs = [said(0, 'One'), said(1, 'Plan written', { kind: 'status' }),
    said(2, 'Two?', { who: 'love', kind: 'item-message', eventId: 'e1', state: 'replied', reply: { html: 'Two.', at: at(3) } }),
    said(5, 'Three', { who: 'Sam' }), said(6, 'Four'), said(7, 'Opened #1', { kind: 'status' }), said(8, 'Five'), said(10, 'Six')];
  const othersAt = [at(0), at(3), at(6), at(8), at(10)];
  const b = boardOnDom({ open: ['w/A1'], seen: { 'w/A1': at(2) }, board: boardOf([workCard('A1', { lane: 'progress', othersAt })]), threads: { 'w/A1': msgs } });
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
  await b.change({ threads: { 'w/A1': [...msgs, said(12, 'Seven')] }, board: boardOf([workCard('A1', { lane: 'progress', othersAt: [...othersAt, at(12)] })]) });
  assert.deepEqual(seen(), ['Show more · 1 previous message', ['Two?', 'Two.', 'Three', 'Four', 'Five', 'Six', 'Seven']]);
  await toggle(false);
  await toggle(true);
  assert.deepEqual(seen(), ['Show more · 5 previous messages', ['Five', 'Six', 'Seven']]);
});

test("a closed card ends its time line with its count of unread messages, and opening the card reads them, taking away the count and the line it leaves empty", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const b = boardOnDom({ seen: { 'w/A1': at(2), 'w/A2': at(2) },
    board: boardOf([workCard('A1', { othersAt: [at(5), at(6)] }), workCard('A2', { othersAt: [at(5)], held: true, sortAt: at(6) })]) });
  await b.settle();
  const card = (key) => b.root.querySelector(`details.item[data-key="${key}"]`);
  const chips = (key) => card(key).querySelector('summary .line2')?.children.map((c) => c.textContent) ?? null;
  const last = (key) => card(key).querySelector('summary .card-time')?.textContent ?? null;
  const alert = (key) => card(key).querySelector('summary .card-alert')?.textContent ?? null;
  const time = b.page.win.BoardUI.cardTime(at(6));
  assert.deepEqual([chips('w/A1'), alert('w/A1'), chips('w/A2'), last('w/A2'), alert('w/A2')], [null, '2 new messages', null, `${time} · held`, '1 new message']);
  for (const key of ['w/A1', 'w/A2']) { card(key).open = true; b.page.fire(b.root, 'toggle', { target: card(key) }); }
  await b.settle();
  assert.deepEqual([alert('w/A1'), alert('w/A2'), last('w/A2')], [null, null, `${time} · held`]);
});

// docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md
test("opening a card reads it up to the newest message it shows: the page posts that mark to the board for every device and takes the card's answer off the banner at once; a redraw with nothing newer posts nothing", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const board = { ...boardOf([workCard('A1', { othersAt: [at(5)] }), workCard('A2', { othersAt: [at(3)], questions: { askedAt: [at(7)] } })]),
    answers: [{ key: 'w/A1', id: 'A1', text: 'Work A1', at: at(5) }] };
  const b = boardOnDom({ seen: { 'w/A1': at(2), 'w/A2': at(2) }, board, threads: {} });
  await b.settle();
  const banner = () => b.root.querySelector('#answers');
  const card = (key) => b.root.querySelector(`details.item[data-key="${key}"]`);
  const reads = () => b.posts.filter(([p]) => p.endsWith('/api/read')).map(([, body]) => body);
  assert.equal(banner().hidden, false);
  card('w/A1').open = true; b.page.fire(b.root, 'toggle', { target: card('w/A1') });
  assert.equal(banner().hidden, true, 'the banner redraws as the task opens');
  card('w/A2').open = true; b.page.fire(b.root, 'toggle', { target: card('w/A2') });
  await b.settle();
  assert.deepEqual(reads(), [{ marks: { 'w/A1': at(5) } }, { marks: { 'w/A2': at(7) } }], "a question's ask counts as shown");
  await b.change({ board: { ...board, version: 'v2' } });
  assert.equal(reads().length, 2);
  assert.deepEqual([...b.storage.keys()].filter((k) => /seenThreads|dismissedAnswers/.test(k)), []);
});

test("the banner's ✕ marks each answer it shows read on the board, so the answers leave it on every device", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const board = { ...boardOf([workCard('A1', { othersAt: [at(5)] }), workCard('A2', { othersAt: [at(7)] })]),
    answers: [{ key: 'w/A2', id: 'A2', text: 'Work A2', at: at(7) }, { key: 'w/A1', id: 'A1', text: 'Work A1', at: at(5) }] };
  const b = boardOnDom({ seen: { 'w/A1': at(2), 'w/A2': at(2) }, board, threads: {} });
  await b.settle();
  const banner = b.root.querySelector('#answers');
  assert.match(banner.textContent, /2 answers/);
  b.page.fire(banner, 'click', { target: banner.querySelector('.answer-dismiss') });
  await b.settle();
  assert.equal(banner.hidden, true);
  assert.deepEqual(b.posts.filter(([p]) => p.endsWith('/api/read')).map(([, body]) => body), [{ marks: { 'w/A2': at(7), 'w/A1': at(5) } }]);
});

test("a mark made on another device reaches the page with the board, taking away the card's unread count and its answer; old browser marks are dropped", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const board = { ...boardOf([workCard('A1', { othersAt: [at(5)] })]), answers: [{ key: 'w/A1', id: 'A1', text: 'Work A1', at: at(5) }] };
  const b = boardOnDom({ seen: { 'w/A1': at(2) }, stored: [['site:board-a:seenThreads', JSON.stringify({ 'w/A1': at(9) })], ['site:board-a:dismissedAnswers', '{}'], ['seenThreads', '{}']], board, threads: {} });
  await b.settle();
  const last = () => b.root.querySelector('details.item[data-key="w/A1"] summary .card-alert')?.textContent ?? null;
  assert.deepEqual([last(), b.root.querySelector('#answers').hidden], ['1 new message', false], 'the board\'s mark counts, not the browser\'s');
  assert.deepEqual([...b.storage.keys()].filter((k) => /seenThreads|dismissedAnswers/.test(k)), []);
  await b.change({ board: { ...board, items: [{ ...board.items[0], readAt: at(5) }], version: 'v2' } });
  assert.deepEqual([last(), b.root.querySelector('#answers').hidden], [null, true]);
  assert.deepEqual(b.posts.filter(([p]) => p.endsWith('/api/read')), []);
});

test("opening a building card takes away its unread count and keeps the phase bars, which then end its time line", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const b = boardOnDom({ seen: { 'w/A1': at(2) },
    board: boardOf([workCard('A1', { lane: 'progress', sortAt: at(6), othersAt: [at(5)], builder: { progress: 'Checking · the limiter', phase: 'checking', at: null } })]) });
  await b.settle();
  const card = b.root.querySelector('details.item[data-key="w/A1"]');
  const row = () => card.querySelector('summary .card-time');
  const time = b.page.win.BoardUI.cardTime(at(6));
  const lastChild = () => row().children[row().children.length - 1];
  const alert = () => card.querySelector('summary .card-alert');
  assert.equal(row().textContent, `${time} · `);
  assert.equal(alert().textContent, '1 new message');
  assert.equal(row().querySelector('.phase-bars').getAttribute('aria-label'), 'Checking, step 3 of 4');
  card.open = true; b.page.fire(b.root, 'toggle', { target: card });
  await b.settle();
  assert.equal(row().textContent, `${time} · `);
  assert.equal(alert(), null);
  assert.equal(lastChild().getAttribute('class'), 'phase-bars');
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
  const b = boardOnDom({ open: ['w/a1'], board: boardOf([askCard('a1', 'progress'), askCard('b1', 'todo')]),
    threads: { 'w/a1': [{ ts: '2026-10-30T10:00:00.000Z', who: 'claude', text: 'Started' }] } });
  await b.settle();
  const view = layOut(b);
  const moves = focusMoves(b.doc);
  const ta = b.root.querySelector('form[data-reply="w/a1"] textarea');
  ta.focus();
  ta.value = 'Half a reply';
  ta.setSelectionRange(4, 6);
  b.page.fire(b.root, 'input', { target: ta });
  b.root.querySelector('#askText').value = 'A new task';
  moves.length = 0;
  const lane = (id) => b.root.querySelector(`details.item[data-key="w/${id}"]`)?.closest('details.lane').dataset.lane;
  const top = (sel) => b.root.querySelector(sel).getBoundingClientRect().top;
  const BOX = 'form[data-reply="w/a1"] textarea';
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
  const TITLE = 'details.item[data-key="w/a1"] > summary';
  const titleTop = top(TITLE);
  await b.change({ board: boardOf([askCard('e1', 'review'), askCard('d1', 'review'), askCard('a1', 'review'), askCard('b1', 'done'), askCard('c1', 'todo')]) });
  assert.deepEqual([lane('e1'), top(TITLE)], ['review', titleTop]);
});

test("Done closes the card and leaves the page where it is as the card moves to Done, unflashed, and the owner's reply leaves its card untinted, while a card another hand moves flashes once, and a card another hand updates takes the tint in its place", async () => {
  const board = boardOf([askCard('b1', 'progress'), { ...askCard('a1', 'review'), finishable: true }, workCard('C1')]);
  const b = boardOnDom({ open: ['w/a1'], board, threads: {}, confirm: true });
  await b.settle();
  const view = layOut(b);
  const card = () => b.root.querySelector('details.item[data-key="w/a1"]');
  const tinting = () => [...b.root.querySelectorAll('details.item.tint')].map((el) => el.dataset.key);
  assert.deepEqual(tinting(), []);
  board.items[1] = { ...board.items[1], threadCount: 1 };
  const form = card().querySelector('form[data-reply="w/a1"]');
  form.querySelector('textarea').value = 'On it';
  b.page.fire(b.root, 'submit', { target: form, submitter: form.querySelector('button[data-intent="reply"]') });
  await b.settle();
  await b.change({ board });
  assert.deepEqual([b.sent.map(([kind]) => kind), tinting()], [['item-message'], []]);
  const open = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(b.root), 'open');
  const el = card();
  Object.defineProperty(el, 'open', { get: open.get, set(v) {
    const was = this.open;
    open.set.call(this, v);
    if (was !== this.open) queueMicrotask(() => b.page.fire(b.root, 'toggle', { target: this }));
  } });
  board.items[1] = { ...board.items[1], lane: 'done', finishable: false };
  b.page.fire(b.root, 'click', { target: card().querySelector('.detail button[data-confirm="finish"]') });
  await b.settle();
  assert.deepEqual([card().closest('details.lane').dataset.lane, card().open, b.page.win.localStorage.getItem('site:board-a:openItems'), view.scrolls],
    ['done', false, '[]', []]);
  assert.deepEqual(tinting(), []);

  board.items[0] = { ...board.items[0], lane: 'review' };
  await b.change({ board });
  assert.deepEqual(tinting(), ['w/b1']);
  board.items[2] = { ...board.items[2], builder: { progress: 'Tests pass' } };
  await b.change({ board });
  assert.deepEqual(tinting(), ['w/b1', 'w/C1'], 'an update takes the same tint a move does');
  assert.equal(b.root.querySelectorAll('.flash').length, 0, 'no border variant is left');
  // docs/adr/2026-11-05-2345-new-todo-cards-join-the-bottom.md
  board.items.push(workCard('C2'));
  await b.change({ board });
  assert.deepEqual(tinting(), ['w/b1', 'w/C1', 'w/C2'], 'a work task that joins Todo takes the tint');
  // docs/adr/2026-11-06-0300-a-new-task-lands-at-the-bottom-of-todo-and-flashes-blue.md
  // docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md: a New task lands in the New strip, and its
  // card takes the tint once ingested into Todo.
  const n2 = { ...askCard('n2', 'todo'), isNew: true, sortAt: '2026-10-30T08:00:00.000Z', ask: { eventId: 'n2', state: 'waiting', askedAt: '2026-10-30T08:00:00.000Z', text: 'Task n2', files: [], canEdit: true } };
  board.items.push(n2);
  await b.change({ board });
  assert.deepEqual(tinting(), ['w/b1', 'w/C1', 'w/C2']);
  board.items[board.items.length - 1] = { ...n2, isNew: false, ask: null, title: 'feat: n2', phase: 'discussing', turn: 'owner', ingested: { at: '2026-10-30T09:00:00.000Z', text: 'Task n2' } };
  await b.change({ board });
  assert.deepEqual(tinting(), ['w/b1', 'w/C1', 'w/C2', 'w/n2'], 'an ingested task joining Todo takes the tint');
});

function questionsOnDom({ topics, questions, at, next, gate = null, items = [], embedded = false, queue = [] }) {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const base = 'https://mac.ts.net/board-a';
  const server = { questions: structuredClone(questions) };
  const ownerTopics = () => topics.map((t) => {
    const qs = server.questions.filter((q) => q.topic === t.id);
    const count = (s) => qs.filter((q) => q.state === s).length;
    return { ...t, state: qs.every((q) => q.state === 'resolved') ? 'resolved' : 'open', questions: qs.map((q) => q.id), open: count('open'), answered: count('answered'), resolved: count('resolved') };
  }).filter((t) => t.questions.length);
  // As board/server.mjs answers: /api/board leaves resolved questions out, and /api/questions?topic= answers a topic's.
  const boardBody = () => ({ ...boardOf(items), owner: server.questions.filter((q) => q.state !== 'resolved'), ownerTopics: ownerTopics(), queue });
  const body = (u) => (u.pathname.endsWith('/api/board') ? boardBody()
    : u.pathname.endsWith('/api/questions') ? { questions: server.questions.filter((q) => q.topic === u.searchParams.get('topic') && q.state === 'resolved') } : []);
  const gets = [];
  page.win.fetch = async (url) => {
    const u = new URL(url, base);
    gets.push(u.pathname + u.search);
    const b = structuredClone(body(u));
    return { ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b };
  };
  const site = page.win.ClaudeSite.site;
  const sent = [];
  page.win.ClaudeSite.site = (r) => ({ ...site(r), send: async (kind, data) => {
    sent.push([kind, data]);
    const q = server.questions.find((x) => x.id === (data.id ?? data.question));
    // A question's prototype request is recorded, and reads requested, as board/server.mjs does, once gate (if any) settles.
    if (kind === 'prototype-request') {
      await gate?.promise;
      if (gate?.refuse) throw Object.assign(new Error('send failed: 400'), { status: 400, reason: gate.refuse });
      Object.assign(q, { state: 'requested', request: { id: 'r1', ts: '2026-10-30T10:00:00.000Z', note: data.note, choice: data.choice } });
      topics.find((t) => t.id === q.topic).round = { n: (q.round || 0) + 1, state: 'making' };
      return { id: 'e1', board: structuredClone(boardBody()) };
    }
    // An Implement or Done tap is recorded and the card leaves the queue, as board/server.mjs records it.
    if (kind === 'card-build' || kind === 'card-done') {
      queue.splice(0, queue.length, ...queue.filter((e) => e.key !== data.key));
      return { id: 'c1', board: structuredClone(boardBody()) };
    }
    // A reopen opens its sent question again, as board/server.mjs's ownerQuestion reads it.
    if (kind === 'question-reopen') {
      Object.assign(q, { state: 'open', reopened: true });
      delete q.resolved;
      return { id: 'o1', board: structuredClone(boardBody()) };
    }
    // An owner-answers batch is recorded all or none, as board/server.mjs records it, once gate (if any) settles.
    await gate?.promise;
    if (gate?.refuse) throw Object.assign(new Error('send failed: 400'), { status: 400, reason: gate.refuse });
    for (const a of data.answers) {
      const q = server.questions.find((x) => x.id === a.id);
      Object.assign(q, { state: 'answered', reopened: false });
      q.answers.push({ ts: '2026-10-30T10:00:00.000Z', choice: a.choice, note: a.note, files: [], reply: null });
    }
    return { ids: data.answers.map((_, n) => `e${n}`), board: structuredClone(boardBody()) };
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
  // Embedded, the lanes' board stands in: held, sent for and reloaded by the host, and taken by the pane as it lands.
  let held = boardBody();
  const host = {
    board: () => held,
    send: async (kind, data) => { const out = await page.win.ClaudeSite.site(base).send(kind, data); held = out.board; questionsView.B.take(held); return out; },
    reload: async () => { held = boardBody(); questionsView.B.take(held); return true; },
  };
  let questionsView = page.win.AppViews.questions.create(shell.root, base, embedded ? { view, embedded: true, host } : { view, up });
  const idle = page.left();
  questionsView.mount();
  const $ = (sel) => shell.root.querySelector(sel);
  const answer = (id) => {
    const input = $(`section.q[data-q="${id}"] input[value="A"]`);
    input.type = 'radio';
    page.fire(shell.root, 'change', { target: input });
  };
  const send = async () => { page.fire(shell.root, 'submit', { target: $('#qform') }); await settle(); };
  const shown = () => shell.board ? { board: shell.board.querySelector('.toast')?.textContent || '' }
    : { pills: shell.root.querySelectorAll('.topics button').map((b) => [b.dataset.topic, b.getAttribute('aria-pressed')]),
      questions: shell.root.querySelectorAll('section.q').map((s) => s.dataset.q), status: $('#qstatus').textContent, hash: page.win.location.hash };
  // The shell mounting a fresh view of the page, as a return from the board does.
  const remount = () => {
    page.win.location.hash = '';
    questionsView.unmount();
    shell.root = page.win.document.body.appendChild(new Element('div'));
    shell.root.innerHTML = page.win.AppViews.questions.markup(view);
    questionsView = page.win.AppViews.questions.create(shell.root, base, { view, up });
    questionsView.mount();
    return shell.root;
  };
  return { settle, answer, send, shown, decisions, sent, gets, server, get root() { return shell.root; }, page, idle, remount, unmount: () => questionsView.unmount() };
}

// docs/adr/2026-11-06-0037-the-open-questions-page-shows-open-questions-only.md: a push tap on a stale page
test("a link to a question this page has not loaded yet loads the board, then opens that question's topic", async () => {
  const a = { id: 'item:w/A', title: 'INT-1: A' };
  const b = { id: 'item:w/B', title: 'INT-2: B' };
  const mk = (id, topic) => ({ id, topic, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }], answers: [], state: 'open' });
  const topics = [a];
  const v = questionsOnDom({ topics, questions: [mk('q1', a.id)], at: 'q1' });
  await v.settle();
  assert.deepEqual(v.shown().questions, ['q1']);
  topics.push(b);
  v.server.questions.push(mk('q2', b.id));
  v.page.win.location.hash = '#q2';
  v.page.fire(vm.runInContext('window', v.page.win), 'hashchange');
  await v.settle();
  assert.deepEqual(v.shown().questions, ['q2']);
  v.unmount();
});

test('tapping the marked option again clears the pick: the suggestion stays cleared, Send stays off until a note, and Space on it clears it too', async () => {
  const topic = { id: 'item:w/T1', title: 'INT-1: Topic' };
  const question = { id: 'q1', topic: topic.id, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], suggested: { option: 'A', card: '#1', answer: 'yes' }, state: 'open' };
  const v = questionsOnDom({ topics: [topic], questions: [question], at: 'q1' });
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  const radio = (id) => { const i = $(`section.q[data-q="q1"] input[value="${id}"]`); i.type = 'radio'; return i; };
  const draft = () => JSON.parse(v.page.win.localStorage.getItem('qdraft:q1') ?? '{}');
  const tap = (input, was) => {
    input.checked = was; // the radio is already checked when the tap lands
    v.page.fire(v.root, 'pointerdown', { target: input });
    input.checked = true; // a click leaves a radio checked
    v.page.fire(v.root, 'click', { target: input });
  };
  assert.equal($('#send').disabled, false, 'the suggestion is pre-checked, so Send is on');
  tap(radio('A'), true);
  assert.deepEqual([radio('A').checked, draft()], [false, { choice: null }]);
  assert.equal($('#send').disabled, true, 'a cleared pick with no note stays unsent');

  const note = $('section.q[data-q="q1"] textarea.note');
  note.value = 'Neither';
  v.page.fire(v.root, 'input', { target: note });
  assert.equal($('#send').disabled, false, 'a note alone sends');
  await v.send();
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent)), [['owner-answers', { answers: [{ id: 'q1', question: 'Q?', choice: null, label: '', note: 'Neither' }] }]]);
});

test('a tap on an option that was not marked marks it, and Space on the marked one clears it', async () => {
  const topic = { id: 'item:w/T1', title: 'INT-1: Topic' };
  const question = { id: 'q1', topic: topic.id, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [topic], questions: [question], at: 'q1' });
  await v.settle();
  const radio = (id) => { const i = v.root.querySelector(`section.q[data-q="q1"] input[value="${id}"]`); i.type = 'radio'; return i; };
  const draft = () => JSON.parse(v.page.win.localStorage.getItem('qdraft:q1') ?? '{}');
  const a = radio('A');
  v.page.fire(v.root, 'pointerdown', { target: a });
  a.checked = true;
  v.page.fire(v.root, 'change', { target: a });
  v.page.fire(v.root, 'click', { target: a });
  assert.deepEqual([a.checked, draft()], [true, { choice: 'A' }], 'the first tap marks');
  v.page.fire(v.root, 'keydown', { target: a, key: ' ' });
  v.page.fire(v.root, 'click', { target: a });
  assert.deepEqual([a.checked, draft()], [false, { choice: null }], 'Space on the marked one clears it');
});

test("Waiting on you's Send follows the shared next question, leaving an urgent question's solo view, staying on the current topic or going to the board with its Sent toast", async () => {
  const topic = (n) => ({ id: `item:w/T${n}`, title: `INT-${n}: Topic ${n}` });
  const question = (id, n) => ({ id, topic: `item:w/T${n}`, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  const three = [question('q1', 1), question('q2', 2), question('q3', 3)];
  const open = (...ids) => three.filter((q) => ids.includes(q.id)).concat(three.filter((q) => !ids.includes(q.id)).map((q) => ({ ...q, state: 'answered' })));

  const middle = questionsOnDom({ topics: [1, 2, 3].map(topic), questions: three, at: 'q2', next: three[2] });
  await middle.settle();
  middle.answer('q2');
  await middle.send();
  assert.deepEqual(middle.shown(), { pills: [['item:w/T1', 'false'], ['item:w/T3', 'true']], questions: ['q3'], status: 'sent 1 answer · 2 still open', hash: '#q3' });
  assert.deepEqual(middle.decisions.map(([qs, pills, answered]) => [qs.map((q) => [q.id, q.state]), pills.map((t) => [t.id, t.open]), answered]),
    [[[['q1', 'open'], ['q2', 'answered'], ['q3', 'open']], [['item:w/T1', 1], ['item:w/T2', 1], ['item:w/T3', 1]], { topic: 'item:w/T2' }]]);

  const partial = questionsOnDom({ topics: [1, 2, 3].map(topic), questions: [...three, question('q2b', 2)], at: 'q2', next: question('q2b', 2) });
  await partial.settle();
  partial.answer('q2');
  await partial.send();
  assert.deepEqual(partial.shown(), { pills: [['item:w/T1', 'false'], ['item:w/T2', 'true'], ['item:w/T3', 'false']], questions: ['q2', 'q2b'],
    status: 'sent 1 answer · 3 still open', hash: '#q2' });

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
  assert.deepEqual(urgent.shown(), { pills: [['item:w/T1', 'true'], ['item:w/T2', 'false']], questions: ['q1'], status: 'sent 1 answer · 2 still open', hash: '#q1' });
});

test("a Send's move on is skipped when you switched topics while it was recorded: the page stays, with the Sent toast", async () => {
  const topic = (n) => ({ id: `item:w/T${n}`, title: `INT-${n}: Topic ${n}` });
  const question = (id, n) => ({ id, topic: `item:w/T${n}`, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  let release;
  const gate = { promise: new Promise((r) => { release = r; }) };
  const v = questionsOnDom({ topics: [1, 2, 3].map(topic), questions: [question('q1', 1), question('q2', 2), question('q3', 3)], at: 'q1', gate });
  await v.settle();
  v.answer('q1');
  await v.send();
  const pill = v.root.querySelector('.topics button[data-topic="item:w/T3"]');
  v.page.fire(v.root, 'click', { target: pill });
  release();
  await v.settle();
  assert.deepEqual([v.shown().pills, v.shown().questions, v.shown().hash],
    [[['item:w/T1', 'false'], ['item:w/T2', 'false'], ['item:w/T3', 'true']], ['q3'], '#q3']);
  assert.equal(v.page.win.document.body.querySelector('.toast')?.textContent, 'Sent 1 answer to INT-1.');
});

test('on a phone, a tap on a pill only picks the topic, the topic title opens its card on the board, and the pill reads the whole title', async () => {
  const question = (id, topic) => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }, { id: 'item:w/T2', title: '#422: Open-items pills' }],
    questions: [question('q1', 'item:w/T1'), question('q2', 'item:w/T2')], at: 'q1' });
  await v.settle();
  const opened = [];
  v.page.win.AppShell = { open: (href) => { opened.push(href); return true; } };
  const pill = (id) => v.root.querySelector(`button[data-topic="${id}"]`);
  assert.deepEqual([pill('item:w/T1').querySelector('.name').textContent, pill('item:w/T2').querySelector('.name').textContent], ['INT-1: Search', '#422: Open-items pills']);
  v.page.fire(v.root, 'click', { target: pill('item:w/T2') });
  await v.settle();
  assert.deepEqual(opened, [], 'a tap only picks the topic');
  v.page.fire(v.root, 'click', { target: pill('item:w/T2') });
  await v.settle();
  assert.deepEqual(opened, [], 'a second tap opens nothing either');
  v.page.fire(v.root, 'click', { target: v.root.querySelector('.topichead .topic-title') });
  assert.equal(opened.length, 1);
  assert.match(opened[0], /\/#item=w%2FT2$/);
});

// docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
test("Waiting on you loads a topic's resolved questions only once the topic shows, and its Send draws from the POST's board with no reload of its own", async () => {
  const question = (id, topic, state = 'open') => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }, { id: 'item:w/T2', title: 'INT-2: Old' }],
    questions: [question('q1', 'item:w/T1'), question('q2', 'item:w/T1'), question('r1', 'item:w/T1', 'resolved'), question('q3', 'item:w/T2'), question('r2', 'item:w/T2', 'resolved')], at: 'q1' });
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  const resolvedShown = () => v.root.querySelectorAll('details.done section.q').map((s) => s.dataset.q);
  assert.deepEqual(v.gets, ['/board-a/api/board', '/board-a/api/questions?topic=item%3Aw%2FT1']);
  assert.deepEqual([v.shown().questions, resolvedShown()], [['r1', 'q1', 'q2'], ['r1']]);
  v.page.fire(v.root, 'click', { target: v.root.querySelector('.topics button[data-topic="item:w/T2"]') });
  await v.settle();
  assert.deepEqual([v.gets.at(-1), resolvedShown()], ['/board-a/api/questions?topic=item%3Aw%2FT2', ['r2']]);
  v.page.fire(v.root, 'click', { target: v.root.querySelector('button[data-topic="item:w/T1"]') });
  await v.settle();
  const loads = v.gets.length;
  v.answer('q1');
  await v.send();
  assert.deepEqual([v.shown().status, resolvedShown()], ['sent 1 answer · 2 still open', ['r1']]);
  assert.deepEqual(v.gets.slice(loads), [], 'the Send downloads nothing beyond its own answer');
  v.unmount();
});

// docs/adr/2026-11-06-0037-the-open-questions-page-shows-open-questions-only.md
test("Waiting on you with no open question shows only the hub's moon, centred, with 'no open questions' under it in muted text: no topic waiting on Claude and no resolved topic is listed", async () => {
  const question = (id, topic, state) => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state,
    ...(state === 'resolved' ? { resolved: 'Picked A', resolved_at: '2026-10-30T09:00:00.000Z', reask: null } : {}) });
  const questions = [question('a1', 'item:w/T1', 'answered'), question('r1', 'item:w/T2', 'resolved')];
  const topics = [{ id: 'item:w/T1', title: 'INT-1: Search' }, { id: 'item:w/T2', title: 'INT-2: Old' }];
  const v = questionsOnDom({ topics, questions, at: '' });
  await v.settle();
  const page = v.root.querySelector('#page');
  assert.deepEqual(page.children.map((c) => c.getAttribute('class')), ['q-empty']);
  const empty = page.querySelector('.q-empty');
  assert.equal(empty.querySelector('svg').getAttribute('width'), '72');
  assert.equal(empty.querySelector('svg path').getAttribute('d'), 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', "the hub's moon");
  assert.deepEqual([empty.querySelector('p').textContent, empty.querySelector('p').getAttribute('class')], ['no open questions', 'muted']);
  assert.equal(v.root.querySelector('[data-topic]'), null);
  assert.equal(v.root.querySelector('#progress').textContent, '');
  v.unmount();

  const linked = questionsOnDom({ topics, questions, at: 'r1' });
  await linked.settle();
  assert.deepEqual(linked.root.querySelectorAll('details.resolved-group section.q').map((s) => s.dataset.q), ['r1'], "a link to a resolved question, as a work item's Questions button sends, still opens its topic");
  linked.unmount();
});

test("Waiting on you shows the shown topic's resolved questions above its open ones and ends at its Send bar, with no topic list under it", async () => {
  const question = (id, topic, state = 'open') => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state,
    ...(state === 'resolved' ? { resolved: 'Picked A', resolved_at: '2026-10-30T09:00:00.000Z', reask: null } : {}) });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }, { id: 'item:w/T2', title: 'INT-2: Waiting' }, { id: 'item:w/T3', title: 'INT-3: Old' }],
    questions: [question('q1', 'item:w/T1'), question('r1', 'item:w/T1', 'resolved'), question('q2', 'item:w/T1'), question('a1', 'item:w/T2', 'answered'), question('r3', 'item:w/T3', 'resolved')], at: 'q1' });
  await v.settle();
  const form = v.root.querySelector('#qform');
  assert.deepEqual(form.children.map((c) => c.dataset.q || c.getAttribute('class').split(' ').at(-1)), ['resolved-group', 'q1', 'q2', 'bar']);
  assert.equal(v.root.querySelector('#page').children.at(-1), form, 'Send ends the page');
  v.server.questions.push(question('q4', 'item:w/T1'));
  v.page.fire(v.page.win.document, 'visibilitychange');
  await v.settle();
  assert.equal(v.root.querySelector('#qform'), form, 'an arrival draws in place');
  assert.deepEqual(form.children.map((c) => c.dataset.q || c.getAttribute('class').split(' ').at(-1)), ['resolved-group', 'q1', 'q2', 'q4', 'bar'], 'a new question goes after the last open one');
  assert.equal(v.root.querySelector('#page').children.at(-1), form);
  v.unmount();
});

test("Waiting on you puts the tapped topic pill's first question in the URL, so going back reopens the topic last shown", async () => {
  const question = (id, topic) => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }, { id: 'item:w/T2', title: 'INT-2: Old' }],
    questions: [question('q1', 'item:w/T1'), question('q2', 'item:w/T2')], at: 'q1' });
  await v.settle();
  v.page.fire(v.root, 'click', { target: v.root.querySelector('button[data-topic="item:w/T2"]') });
  await v.settle();
  assert.equal(v.page.win.location.hash, '#q2');
  v.unmount();
});

// docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md
test("Waiting on you folds a topic's sent and resolved questions under a collapsed 'resolved (N)' at load, read-only; tapping one's green Resolved badge confirms, reopens it in the form with its pick and note, and the reopened answer sends again", async () => {
  const question = (id, state = 'open') => ({ id, topic: 'item:w/T1', source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state,
    ...(state === 'resolved' ? { resolved: 'Picked A', resolved_at: '2026-10-30T09:00:00.000Z', reask: null } : {}) });
  const sent = { ...question('s1', 'answered'), answers: [{ ts: '2026-10-30T08:00:00.000Z', choice: 'B', note: 'Not yet', files: [], reply: null }] };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question('q1'), question('r1', 'resolved'), sent, question('r2', 'resolved')], at: 'q1' });
  const confirms = [];
  let agree = false;
  v.page.win.BoardDialogs.confirm = async (message) => { confirms.push(message); return agree; };
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  const group = $('details.done.resolved-group');
  assert.equal(group.hasAttribute('open'), false);
  assert.deepEqual(group.querySelector('summary').querySelectorAll('span').map((s) => s.textContent), ['›', 'resolved (3)']);
  assert.deepEqual(group.querySelectorAll('section.q').map((s) => s.dataset.q), ['r1', 's1', 'r2']);
  assert.equal(group.querySelectorAll('textarea').length, 0);
  assert.deepEqual(group.querySelectorAll('section.q .muted.small').filter((m) => /^\d\./.test(m.textContent)).map((m) => m.textContent), ['2. ', '3. ', '4. '], 'each keeps its number on the task');
  const tap = () => $('section.q[data-q="s1"] [data-reopen]');
  v.page.fire(v.root, 'click', { target: tap() });
  await v.settle();
  assert.deepEqual([confirms, v.sent], [['Reopen this question?'], []]);
  agree = true;
  v.page.fire(v.root, 'click', { target: tap() });
  await v.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent)), [['question-reopen', { key: 'w/T1', question: 's1' }]]);
  assert.deepEqual($('#qform').children.filter((c) => c.matches('section.q')).map((c) => c.dataset.q), ['q1', 's1'], 'the reopened question joins the form');
  assert.equal($('section.q[data-q="s1"] textarea.note').value, 'Not yet');
  assert.equal($('section.q[data-q="s1"] input[value="B"]').hasAttribute('checked'), true);
  assert.equal($('#send').disabled, false, 'its pick is ready to send again');
  await v.send();
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent.at(-1))), ['owner-answers', { answers: [{ id: 's1', question: 'Question s1?', choice: 'B', label: 'B. No', note: 'Not yet' }] }]);
  assert.deepEqual($('#qform').children.filter((c) => c.matches('section.q.resolved')).map((c) => c.dataset.q), ['s1'], 'sent again, it stays in place, resolved');
  v.unmount();
});

// docs/adr/2026-11-06-1100-resolved-questions-fold-away-once-you-leave-their-topic.md
test("Waiting on you keeps a sent question in place only while its topic shows: a pill tap folds it, and coming back shows it already under 'resolved (N)'", async () => {
  const question = (id, topic) => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }, { id: 'item:w/T2', title: 'INT-2: Old' }],
    questions: [question('q1', 'item:w/T1'), question('q2', 'item:w/T1'), question('q3', 'item:w/T2')], at: 'q1' });
  await v.settle();
  const folded = () => v.root.querySelectorAll('details.done section.q').map((s) => s.dataset.q);
  v.answer('q1');
  await v.send();
  assert.deepEqual([v.shown().questions, folded()], [['q1', 'q2'], []], 'in place while its topic shows');
  v.page.fire(v.root, 'click', { target: v.root.querySelector('button[data-topic="item:w/T2"]') });
  await v.settle();
  v.page.fire(v.root, 'click', { target: v.root.querySelector('button[data-topic="item:w/T1"]') });
  await v.settle();
  assert.deepEqual([v.shown().questions, folded()], [['q1', 'q2'], ['q1']]);
  assert.deepEqual(v.root.querySelector('details.done summary').querySelectorAll('span').map((s) => s.textContent), ['›', 'resolved (1)']);
  v.unmount();
});

test("Waiting on you's last Send in the board's pane, with no topic or board to go on to, shows the moon and 'no open questions' with the Sent line as a toast", async () => {
  const q = { id: 'q1', topic: 'item:w/T1', source: '', question: 'Question q1?', context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [q], at: 'q1', next: null, embedded: true });
  await v.settle();
  v.answer('q1');
  await v.send();
  assert.equal(v.root.querySelector('.q-empty p').textContent, 'no open questions');
  assert.equal(v.root.querySelector('#qform'), null);
  v.unmount();
});

// docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md
test("Waiting on you's eye on each question, beside its box with the attach button inside, asks for a prototype of that question with its note and pick, waits for the server, then resolves it and moves on as Send does: to the topic's next open question, or back to the board", async () => {
  const question = (id) => ({ id, topic: 'item:w/T1', source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  let release;
  const gate = { promise: new Promise((r) => { release = r; }) };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question('q1'), question('q2')], at: 'q1', gate });
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  const eye = (id) => $(`section.q[data-q="${id}"] .note-tools [data-proto]`);
  assert.deepEqual($('section.q[data-q="q1"] .note-tools').children.map((c) => c.getAttribute('title') || c.getAttribute('class')), ['Ask for a prototype instead', 'pending-files']);
  assert.ok($('section.q[data-q="q1"] .dz > .attach input[data-attach]'));
  assert.equal($('#qform .bar [data-proto]'), null);
  assert.equal(eye('q1').disabled, false);
  assert.equal($('.topichead .chip'), null);

  const note = $('section.q[data-q="q2"] textarea.note');
  note.value = 'Show it on a phone';
  v.page.fire(v.root, 'input', { target: note });
  const pickB = $('section.q[data-q="q2"] input[value="B"]');
  pickB.type = 'radio';
  v.page.fire(v.root, 'change', { target: pickB });
  v.page.fire(v.root, 'click', { target: eye('q2') });
  await v.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent)), [['prototype-request', { key: 'w/T1', question: 'q2', note: 'Show it on a phone', choice: 'B' }]]);
  assert.deepEqual([$('#qstatus').textContent, eye('q2').disabled, eye('q2').getAttribute('aria-busy')], ['', true, 'true'], 'the eye waits in place of a Sending… line');
  assert.deepEqual(v.shown().questions, ['q1', 'q2']);
  assert.equal($('details.done'), null);
  release();
  await v.settle();
  assert.deepEqual(v.shown(), { pills: [], questions: ['q1', 'q2'], status: 'prototype requested. 1 still open.', hash: '#q1' });
  assert.ok($('#qstatus .try-spin'));
  assert.equal($('details.done'), null, 'the requested question stays in place');
  assert.equal($('section.q[data-q="q2"] [data-proto]'), null);
  assert.deepEqual(v.root.querySelectorAll('.pr-busy').map((s) => s.dataset.q), ['q2'], 'in the blue tint');
  assert.equal($('.topichead .chip').textContent, 'Prototype round 1');
  assert.ok($('.topichead .chip.tone-normal .try-spin'));
  assert.equal($('#send').disabled, true);
  assert.equal($('#send .key-hint').textContent, '⌘↵', 'Send is the shared send button, its key inside it');
  assert.equal($('.send-hint'), null);

  v.page.fire(v.root, 'click', { target: eye('q1') });
  await v.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent[1])), ['prototype-request', { key: 'w/T1', question: 'q1', note: '', choice: null }]);
  assert.deepEqual(v.shown(), { board: 'Prototype requested for INT-1.' });
});

// docs/adr/2026-11-04-2200-overnight-triage-suggests-your-earlier-answers.md
test("Waiting on you's Send sends a suggested option pre-checked, saying so on its bar until the owner picks another", async () => {
  const question = (id, extra = {}) => ({ id, topic: 'item:w/T1', source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open', ...extra });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question('q1', { suggested: { option: 'B', card: '#186', answer: 'No.' } }), question('q2')], at: 'q1' });
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  assert.deepEqual([$('#qstatus').textContent, $('#send').disabled], ['suggested options are selected', false]);
  assert.equal($('section.q[data-q="q1"] input[value="B"]').hasAttribute('checked'), true);
  v.answer('q1');
  assert.deepEqual([$('#qstatus').textContent, $('#send').disabled], ['', false]);
  const pickB = $('section.q[data-q="q1"] input[value="B"]');
  pickB.type = 'radio';
  v.page.fire(v.root, 'change', { target: pickB });
  assert.equal($('#qstatus').textContent, 'suggested options are selected');
  await v.send();
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent)), [['owner-answers', { answers: [{ id: 'q1', question: 'Question q1?', choice: 'B', label: 'B. No', note: '' }] }]]);
  assert.equal(v.shown().status, 'sent 1 answer · 1 still open');
  v.unmount();
});

test("Waiting on you's eye on a refused request keeps the question open with its draft and says why", async () => {
  const question = (id) => ({ id, topic: 'item:w/T1', source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question('q1')], at: 'q1', gate: { promise: Promise.resolve(), refuse: 'q1 is no longer asked here.' } });
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  const note = $('section.q textarea.note');
  note.value = 'Bigger';
  v.page.fire(v.root, 'input', { target: note });
  v.page.fire(v.root, 'click', { target: $('section.q .note-tools [data-proto]') });
  await v.settle();
  assert.equal($('#qstatus').textContent, 'Nothing was sent: q1 is no longer asked here.');
  assert.deepEqual(v.shown().questions, ['q1']);
  assert.equal($('section.q textarea.note').value, 'Bigger');
  v.unmount();
});

test("Waiting on you's Send carries every ready answer in one request, waits disabled with its spinner until the server answers, then shows them all sent at once, or on a refusal keeps every draft and says why", async () => {
  const question = (id) => ({ id, topic: 'item:w/T1', source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  let release;
  const gate = { promise: new Promise((r) => { release = r; }) };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question('q1'), question('q2'), question('q3')], at: 'q1', next: question('q3'), gate });
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  const draft = (page, id) => JSON.parse(page.win.localStorage.getItem(`qdraft:${id}`) || '{}');
  // Sent questions stay in place in the form, resolved, until the page loads again.
  const waiting = () => $('#qform').children.filter((c) => c.matches('section.q.resolved')).map((s) => s.dataset.q);
  v.answer('q1');
  v.answer('q2');
  await v.send();
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent)), [['owner-answers', { answers: [
    { id: 'q1', question: 'Question q1?', choice: 'A', label: 'A. Yes', note: '' },
    { id: 'q2', question: 'Question q2?', choice: 'A', label: 'A. Yes', note: '' }] }]]);
  assert.deepEqual([$('#qstatus').textContent, $('#send').disabled, $('#send').getAttribute('aria-busy')], ['', true, 'true']);
  assert.deepEqual(waiting(), []);
  assert.deepEqual([draft(v.page, 'q1'), draft(v.page, 'q2')], [{ choice: 'A' }, { choice: 'A' }]);
  release();
  await v.settle();
  assert.equal(v.sent.length, 1);
  assert.deepEqual(waiting(), ['q1', 'q2']);
  assert.deepEqual([draft(v.page, 'q1'), draft(v.page, 'q2')], [{}, {}]);
  assert.equal($('#qstatus').textContent, 'sent 2 answers · 1 still open');

  const refused = { promise: Promise.resolve(), refuse: 'Question q2 is no longer asked here. Reload to see what is.' };
  const r = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question('q1'), question('q2')], at: 'q1', gate: refused });
  await r.settle();
  r.answer('q1');
  r.answer('q2');
  await r.send();
  assert.equal(r.root.querySelector('#qstatus').textContent, 'Nothing was sent: Question q2 is no longer asked here. Reload to see what is.');
  assert.deepEqual(r.shown().questions, ['q1', 'q2']);
  assert.deepEqual([draft(r.page, 'q1'), draft(r.page, 'q2')], [{ choice: 'A' }, { choice: 'A' }]);
  await r.send();
  assert.deepEqual(JSON.parse(JSON.stringify(r.sent.map(([, d]) => d.answers.map((a) => a.id)))), [['q1', 'q2'], ['q1', 'q2']]);
  v.unmount();
  r.unmount();
});

// docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md
test('Waiting on you frames no take: a prototype question shows its options and a View prototypes link to the viewer, and a choice only drafts', async () => {
  const takes = [{ id: 'A', label: 'Badge' }, { id: 'B', label: 'Dot', recommended: true }, { id: 'C', label: 'Thread' }];
  const q = { id: 'q1', topic: 'item:w/T1', source: '', question: 'Which?', context: '', url: 'prototype-unread.html?q=q1', options: takes, answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Unread' }], questions: [q], at: 'q1' });
  v.page.win.innerWidth = 1100;
  await v.settle();
  assert.equal(v.root.querySelectorAll('iframe').length, 0);
  const view = v.root.querySelectorAll('a.proto-view');
  assert.deepEqual(view.map((a) => [a.getAttribute('href'), a.textContent]), [['prototype-unread.html?q=q1', 'View prototypes']]);
  const section = v.root.querySelector('section.q');
  v.answer('q1');
  assert.equal(JSON.parse(v.page.win.localStorage.getItem('qdraft:q1')).choice, 'A');
  assert.equal(v.root.querySelector('section.q'), section);
  v.page.win.innerWidth = 390;
  v.page.fire(vm.runInContext('window', v.page.win), 'resize');
  assert.equal(v.root.querySelector('section.q'), section);
  v.unmount();
  assert.deepEqual(v.page.left(), v.idle);
});

// docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md
test("from 900px every questions URL, a link, a push or a hand-off, shows the board at the board's URL and opens its topic in the pane, with no history entry on the same board", async () => {
  const s = await shellPage('/_hub/', { width: 1280 });
  const focused = [];
  s.win.BoardView.create = () => ({ B: { state: {}, focusQuestion: (id) => { focused.push(id); return true; } }, mount() {}, unmount() {} });
  s.win.AppShell.open('/shop/#selectedCard=w%2FA1');
  const board = s.doc.querySelector('.view-board');
  const count = s.entries().length;
  assert.equal(s.win.AppShell.open('/shop/questions.html?from=push#q2'), true, 'a push tap');
  assert.deepEqual([s.doc.querySelector('.view-board'), s.win.location.pathname + s.win.location.hash, s.entries().length, focused], [board, '/shop/#selectedCard=w%2FA1', count, ['q2']], 'the open task stays open');
  focused.length = 0;
  const a = s.doc.createElement('a');
  a.setAttribute('href', 'questions.html#q3');
  board.appendChild(a);
  s.tap(a);
  assert.deepEqual([s.doc.querySelector('.view-board'), s.win.location.pathname, s.entries().length, focused], [board, '/shop/', count, ['q3']], 'a link on the board');
  focused.length = 0;
  s.win.AppShell.open('/shop/questions.html');
  assert.deepEqual([s.doc.querySelector('.view-board'), s.doc.querySelector('.view-questions'), focused], [board, null, [null]], 'All open questions opens the pane as it stands');
  focused.length = 0;
  s.win.AppShell.open('/other/questions.html#q9');
  await new Promise(setImmediate);
  assert.deepEqual([s.win.location.pathname, s.doc.querySelectorAll('.view-board').length, s.doc.querySelector('.view-questions'), focused], ['/other/', 1, null, ['q9']], "another board's questions open that board");
});

// docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md
test('widening past 900px on Questions swaps to the board with that topic open in the pane; narrowing on the board stays on the board', async () => {
  const s = await shellPage('/_hub/');
  const focused = [];
  s.win.BoardView.create = () => ({ B: { state: {}, focusQuestion: (id) => { focused.push(id); return true; } }, mount() {}, unmount() {} });
  s.win.AppShell.open('/shop/');
  s.win.AppShell.open('/shop/questions.html#q2');
  assert.ok(s.doc.querySelector('.view-questions'), 'a phone shows Questions as its own page');
  s.resize(1280);
  await new Promise(setImmediate);
  assert.deepEqual([s.doc.querySelector('.view-questions'), Boolean(s.doc.querySelector('.view-board')), s.win.location.pathname, focused], [null, true, '/shop/', ['q2']]);
  const board = s.doc.querySelector('.view-board');
  s.resize(390);
  assert.deepEqual([s.doc.querySelector('.view-board'), s.win.location.pathname], [board, '/shop/']);
});

// docs/adr/2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md
test("from 900px a prototype URL, a link, a push, a cold load or a widening, shows the board at the board's URL with the prototype open in its pane; a phone frames the full page", async () => {
  const stub = (opened) => () => ({ B: { state: {}, openViewer: (url) => { opened.push(url); return true; } }, mount() {}, unmount() {} });
  const s = await shellPage('/_hub/', { width: 1280 });
  const opened = [];
  s.win.BoardView.create = stub(opened);
  s.win.AppShell.open('/shop/#item=w%2FA1');
  const board = s.doc.querySelector('.view-board');
  const count = s.entries().length;
  assert.equal(s.win.AppShell.open('/shop/prototype-x.html?q=q2&from=push'), true, 'a push tap');
  assert.deepEqual([s.doc.querySelector('.view-board'), s.doc.querySelector('.view-frame'), s.win.location.pathname + s.win.location.hash, s.entries().length],
    [board, null, '/shop/#item=w%2FA1', count], 'the open task stays open, with no history entry');
  assert.deepEqual(opened.map((u) => new URL(u).pathname + new URL(u).search), ['/shop/prototype-x.html?q=q2&from=push']);
  opened.length = 0;
  const a = s.doc.createElement('a');
  a.setAttribute('href', 'prototype-x.html?q=q3');
  board.appendChild(a);
  s.tap(a);
  assert.deepEqual([s.doc.querySelector('.view-board'), opened.map((u) => new URL(u).pathname + new URL(u).search)], [board, ['/shop/prototype-x.html?q=q3']], 'a link on the board');
  opened.length = 0;
  s.win.AppShell.open('/other/prototype-y.html?q=q9');
  await new Promise(setImmediate);
  assert.deepEqual([s.win.location.pathname, s.doc.querySelector('.view-frame'), opened.map((u) => new URL(u).pathname)], ['/other/', null, ['/other/prototype-y.html']], "another board's prototype opens that board");

  const cold = await shellPage('/shop/prototype-x.html?q=q2', { width: 1280 });
  assert.deepEqual([cold.win.location.pathname, Boolean(cold.doc.querySelector('.view-board')), cold.doc.querySelector('.view-frame')], ['/shop/', true, null], 'a cold load lands on the board URL');

  const phoneOpened = [];
  const phone = await shellPage('/_hub/');
  phone.win.BoardView.create = stub(phoneOpened);
  phone.win.AppShell.open('/shop/');
  phone.win.AppShell.open('/shop/prototype-x.html?q=q2');
  assert.deepEqual([Boolean(phone.doc.querySelector('.view-frame')), phoneOpened], [true, []], 'a phone frames the full page');
  phone.resize(1280);
  await new Promise(setImmediate);
  assert.deepEqual([phone.doc.querySelector('.view-frame'), Boolean(phone.doc.querySelector('.view-board')), phone.win.location.pathname, phoneOpened.map((u) => new URL(u).pathname)],
    [null, true, '/shop/', ['/shop/prototype-x.html']], 'widening past 900px swaps to the board with the prototype in its pane');
});

test('the board gear opens a board-only modal over the same board, closes without history entries and keeps back to Hub', async () => {
  const { win, doc, page, entries, position, boardUnmounts } = await shellPage('/_hub/');
  win.AppShell.open('/shop/#selectedCard=w%2FA1');
  const board = doc.querySelector('.view-board');
  const count = entries().length;
  const baseline = page.left();
  const gear = board.querySelector('#settingsLink');
  gear.removeAttribute('aria-disabled');
  doc.activeElement = gear;
  page.fire(doc, 'click', { target: gear, button: 0 });
  const modal = doc.querySelector('#boardSettingsModal');
  assert.ok(modal?.open);
  assert.equal(doc.querySelector('.view-board'), board);
  assert.equal(boardUnmounts(), 0);
  assert.equal(entries().length, count);
  assert.equal(position(), 1);
  assert.equal(win.location.pathname, '/shop/settings.html');
  assert.match(modal.textContent, /Board settingsThe Shop/);
  assert.match(modal.textContent, /Reviewers|Device installs|Auto-merge|Rules|Close board/);
  assert.doesNotMatch(modal.textContent, /Notifications|Codex|For every board/);
  assert.equal(modal.querySelector('.top'), null);
  assert.match(modal.textContent, /Reopen later from Hub → Closed boards/);
  const dismiss = modal.querySelector('[data-settings-dismiss]');
  page.fire(modal, 'click', { target: dismiss });
  assert.equal(doc.querySelector('#boardSettingsModal'), null);
  assert.equal(win.location.pathname + win.location.hash, '/shop/#selectedCard=w%2FA1');
  assert.equal(doc.activeElement, gear);
  assert.equal(entries().length, count);
  assert.deepEqual(page.left(), baseline);
  win.history.back();
  assert.equal(win.location.pathname, '/_hub/');
});

test('old board settings deep links open the board and modal, and Escape and Done guard unsaved edits', async () => {
  const { win, doc, page, entries } = await shellPage('/shop/settings.html?from=push');
  const board = doc.querySelector('.view-board');
  const modal = doc.querySelector('#boardSettingsModal');
  assert.ok(board);
  assert.ok(modal?.open);
  assert.equal(entries().length, 1);
  const dirty = modal.querySelector('#ticketsForm');
  dirty.setAttribute('data-dirty', '');
  let asks = 0;
  win.BoardDialogs.confirm = async () => { asks++; return false; };
  assert.equal(page.fire(modal, 'cancel').defaultPrevented, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(asks, 1);
  assert.ok(modal.open);
  win.BoardDialogs.confirm = async () => true;
  page.fire(modal, 'click', { target: modal.querySelector('.settings-footer button') });
  await new Promise((r) => setImmediate(r));
  assert.equal(doc.querySelector('#boardSettingsModal'), null);
  assert.equal(doc.querySelector('.view-board'), board);
  assert.equal(win.location.pathname, '/shop/');
  assert.equal(entries().length, 1);
});

test('leaving a board with its settings open releases the modal and returning with back restores the modal over the board', async () => {
  const { win, doc, boardUnmounts } = await shellPage('/shop/settings.html');
  const modal = doc.querySelector('#boardSettingsModal');
  win.AppShell.open('/_hub/');
  assert.equal(doc.querySelector('#boardSettingsModal'), null);
  assert.equal(modal.open, false);
  assert.equal(boardUnmounts(), 1);
  assert.equal(doc.querySelector('.view-settings'), null);
  win.history.back();
  await new Promise((r) => setImmediate(r));
  assert.ok(doc.querySelector('.view-board'));
  assert.ok(doc.querySelector('#boardSettingsModal').open);
});

test("switching to another board through the sidebar and back returns to the page's scroll and open threads, and on a desktop to the box being typed in with its text and selection, but not to a box blurred inside the board, nor on a phone, nor when the link names a card", async () => {
  const said = (n) => ({ ts: `2026-10-30T10:0${n}:00.000Z`, who: 'claude', text: `Line ${n}` });
  const threads = { 'w/a1': [], 'w/b1': [1, 2, 3, 4, 5].map(said) };
  const fetch = async (url) => {
    const u = new URL(url, 'https://mac.ts.net/');
    const body = u.pathname.endsWith('/api/board') ? boardOf([askCard('a1', 'progress'), askCard('b1', 'progress'), newAsk('n1', '2026-10-30T09:00:00.000Z', 'waiting', 'Fix the header')]) : threads[u.searchParams.get('key')] || [];
    return { ok: true, json: async () => structuredClone(body) };
  };
  const storage = memoryStorage([['site:shop:openItems', JSON.stringify(['w/a1', 'w/b1'])]]);
  const { win, doc, page, tap } = await shellPage('/shop/', { fetch, storage, realBoards: true });
  let desktop = true;
  win.matchMedia = (query) => Object.assign(new page.Target(), { matches: query === '(hover: hover) and (pointer: fine)' && desktop });
  win.scrollTo = (x, y) => { win.scrollY = y; };
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  const $ = (sel) => doc.querySelector(`.view-board ${sel}`);
  const row = (route) => doc.querySelector(`.sb-row[href="/${route}/"]`);
  const press = (el) => page.fire(doc, 'pointerdown', { target: el });
  const switchTo = async (route) => {
    press(row(route));
    doc.activeElement?.blur();
    tap(row(route));
    await settle();
  };
  const lines = () => $('[data-thread="w/b1"] .msgs').querySelectorAll('.msg .body').map((el) => el.textContent);
  const focused = (el) => (el?.closest('.edit-form') ? 'edit' : el?.closest('form[data-reply]') ? 'reply' : null);
  const shown = () => [win.location.pathname, win.scrollY, focused(doc.activeElement)];

  page.fire(doc.querySelector('.view-board'), 'click', { target: $('[data-thread="w/b1"] [data-thread-more]') });
  assert.deepEqual(lines(), ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5']);
  page.fire(doc.querySelector('.view-board'), 'click', { target: $('#newStrip .new-entry[data-new="n1"] button[data-edit]') });
  await settle();
  const edit = $('.edit-form textarea');
  edit.value = 'Fix the header and the footer';
  edit.setSelectionRange(4, 10);
  page.fire(doc.querySelector('.view-board'), 'input', { target: edit });
  edit.focus();
  win.scrollY = 640;
  await switchTo('other');
  assert.deepEqual(shown(), ['/other/', 0, null]);
  await switchTo('shop');
  const back = $('.edit-form textarea');
  assert.notEqual(back, edit);
  assert.deepEqual(shown(), ['/shop/', 640, 'edit']);
  assert.deepEqual([back.value, back.selectionStart, back.selectionEnd], ['Fix the header and the footer', 4, 10]);
  assert.deepEqual(lines(), ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5']);

  const reply = () => $('form[data-reply="w/a1"] textarea');
  reply().focus();
  press($('main'));
  reply().blur();
  win.scrollY = 320;
  await switchTo('other');
  await switchTo('shop');
  assert.deepEqual(shown(), ['/shop/', 320, null]);

  desktop = false;
  reply().focus();
  press($('.top a.hub'));
  await switchTo('other');
  await switchTo('shop');
  assert.deepEqual(shown(), ['/shop/', 320, null]);

  desktop = true;
  reply().focus();
  await switchTo('other');
  win.AppShell.open('/shop/#selectedCard=w%2Fb1');
  await settle();
  assert.deepEqual(shown(), ['/shop/', 0, null]);
});

test('a stored link to the old Polling page opens Hub with Quiet hours, and modal links and dismissal preserve history', async () => {
  const requests = [];
  const settings = { on: { on: true }, weekends: { on: false }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [] }, closed: [], pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off' }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false } };
  const { win, doc, page, entries, tap } = await shellPage('/_hub/settings/polling?w=18%3A00&from=push', {
    fetch: async (url) => {
      requests.push(url);
      if (url === '/_hub/api/settings') return { ok: true, json: async () => structuredClone(settings) };
      return new Promise(() => {});
    },
  });
  const settle = () => new Promise((r) => setImmediate(r));
  await settle();
  const modal = doc.querySelector('#hubSettingsModal');
  assert.equal(modal.open, true);
  assert.equal(doc.querySelector('.top h1').textContent, 'Hub');
  assert.equal(doc.querySelector('#hubSettingsTitle').textContent, 'Quiet hours');
  assert.equal(doc.querySelector('input[type=time]').value, '22:00');
  assert.ok(requests.includes('/_hub/api/settings'));
  assert.equal(win.location.pathname, '/_hub/');
  assert.equal(win.location.hash, '#quiet');
  assert.equal(win.history.state.pushed, true);
  const count = entries().length;
  const dismiss = modal.querySelector('.settings-footer button');
  page.fire(doc.querySelector('.hub-settings'), 'click', { target: dismiss });
  assert.equal(modal.open, false);
  assert.equal(doc.activeElement, doc.querySelector('#quiet'));
  assert.equal(win.location.href, 'https://mac.ts.net/_hub/');
  assert.equal(entries().length, count);
  for (const href of ['/_hub/settings', '/_hub/settings#notifications', '/_hub/#rules', '/_hub/settings/polling?w=08%3A00']) {
    const link = doc.createElement('a');
    link.setAttribute('href', href);
    tap(link); await settle();
    assert.equal(modal.open, true);
    assert.equal(entries().length, count);
  }
  assert.equal(doc.querySelector('#hubSettingsTitle').textContent, 'Quiet hours');
  win.AppShell.open('/_hub/settings#rules'); await settle();
  const editor = doc.querySelector('#hubRules');
  editor.setAttribute('data-dirty', '');
  const rulesURL = win.location.href;
  win.AppShell.open('/_hub/#notifications'); await settle();
  assert.equal(doc.querySelector('#hubRules'), editor);
  assert.equal(win.location.href, rulesURL);
  win.AppShell.open('/shop/'); await settle();
  assert.equal(doc.querySelector('#hubRules'), editor);
  win.BoardDialogs.confirm = async () => true;
  win.AppShell.open('/_hub/settings/polling?w=08%3A00'); await settle();
  assert.equal(doc.querySelector('#hubRules'), null);
  assert.equal(entries().length, count);
  win.AppShell.open('/shop/');
  assert.equal(doc.querySelector('#hubSettingsModal'), null);
  win.history.back(); await settle();
  assert.equal(doc.querySelector('#hubSettingsModal').open, true);
  assert.equal(doc.querySelector('#hubSettingsTitle').textContent, 'Quiet hours');
});

test('legacy hub links open one modal, guard dirty rules on every dismissal, restore focus and clean up', async () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  page.win.document.getElementById = () => true;
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = page.win.HubSettings.markup();
  const data = { on: { on: true }, weekends: { on: false }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [] }, closed: [], pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off' }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false } };
  page.win.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
  page.win.RulesEditor.mount = () => ({ set() {} });
  const baseline = page.left();
  const view = page.win.HubSettings.create(root, '/_hub', { view: { hash: '#closed' } });
  view.mount();
  const settle = () => new Promise((r) => setImmediate(r));
  await settle();
  const modal = root.querySelector('#hubSettingsModal');
  assert.equal(modal.open, true);
  assert.equal(page.win.document.activeElement.id, 'hubSettingsTitle');
  for (const [hash, title] of [['#rules', 'Rules for every board'], ['#push', 'Notifications'], ['#closed-boards', 'Closed boards']]) {
    page.win.location = new URL(`https://mac.ts.net/_hub/settings${hash}`);
    page.fire(vm.runInContext('window', page.win), 'hashchange');
    await settle();
    assert.equal(root.querySelector('#hubSettingsTitle').textContent, title);
    assert.equal(modal.open, true);
    assert.equal(root.querySelectorAll('details').length, 0);
  }
  await view.B.openSettings({ hash: '#rules' });
  const editor = root.querySelector('#hubRules');
  editor.setAttribute('data-dirty', '');
  let confirms = 0;
  page.win.BoardDialogs.confirm = async () => { confirms++; return false; };
  const dismissers = [
    () => page.fire(modal, 'cancel'),
    () => page.fire(root, 'click', { target: modal, clientX: -1, clientY: -1 }),
    ...root.querySelectorAll('[data-settings-dismiss]').map((button) => () => page.fire(root, 'click', { target: button })),
  ];
  for (const dismiss of dismissers) {
    dismiss(); await settle();
    assert.equal(modal.open, true);
    assert.equal(root.querySelector('#hubRules'), editor);
  }
  assert.equal(confirms, 4);
  page.win.BoardDialogs.confirm = async () => true;
  dismissers[0](); await settle();
  assert.equal(modal.open, false);
  assert.equal(page.win.document.activeElement, root.querySelector('#rules'));
  assert.equal(root.querySelector('[data-dirty]'), null);
  view.unmount();
  assert.deepEqual(page.left(), baseline);
});

// docs/adr/2026-11-05-0802-todo-has-no-queue.md
test("Todo has no Queued section: its cards show in the server's order, a bumped one first, each with its bump icon", async () => {
  const cards = [workCard('P1', { lane: 'progress', bumpable: true }), workCard('T2', { bumpable: true, bumpedAt: '2026-11-04T10:00:00.000Z', ready: true }), workCard('T1', { bumpable: true })];
  const b = boardOnDom({ board: boardOf(cards), threads: {} });
  await b.settle();
  assert.equal(b.root.querySelector('.lane-queue'), null);
  const todo = b.root.querySelector('details.lane[data-lane="todo"]');
  assert.deepEqual(todo.querySelectorAll('details.item').map((el) => el.dataset.key), ['w/T2', 'w/T1']);
  assert.deepEqual(['w/T2', 'w/T1'].map((key) => todo.querySelector(`details.item[data-key="${key}"] button[data-card-bump]`).getAttribute('aria-label')), ['Unbump', 'Bump to top']);
  assert.equal(todo.querySelector('summary .count').textContent, '2');
});

// docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md
test('every lane lists its cards plainly, with no wave band, group header or Plan waves row, and a card blocked by another reads the blocked-by line', async () => {
  const cards = [workCard('A3'), workCard('A2', { blockedBy: [{ key: 'w/A9', ref: 'A9' }] }), workCard('A6', { ready: true, buildable: true }), workCard('A8', { lane: 'progress' }), workCard('A1', { lane: 'done' })];
  const b = boardOnDom({ board: boardOf(cards), threads: {}, confirm: true });
  await b.settle();
  const todo = () => b.root.querySelector('details.lane[data-lane="todo"] > .list');
  assert.deepEqual(todo().querySelectorAll('details.item').map((el) => el.dataset.key), ['w/A3', 'w/A2', 'w/A6']);
  assert.equal(b.root.querySelector('.wb, .wb-head, [data-band], button[data-plan], #waves'), null);
  assert.equal(b.root.querySelector('details.item[data-key="w/A2"] .card-blocked').textContent, 'blocked by A9');
  assert.doesNotMatch(b.root.querySelector('#lanes').textContent, /Wave|Plan waves|No wave/);
});

// docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md
test("each lane shows its cards in the order they arrive, with no sort icon in its header, and each card's time line is the time its lane sorts by", async () => {
  const cards = [
    workCard('R1', { lane: 'review', sortAt: '2026-10-29T08:00:00.000Z', created: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-30T08:00:00.000Z' }),
    workCard('R2', { lane: 'review', sortAt: '2026-10-28T08:00:00.000Z', created: '2026-10-02T08:00:00.000Z' }),
    workCard('P1', { lane: 'progress', sortAt: '2026-10-27T08:00:00.000Z' }),
    { ...askCard('n1', 'todo'), isNew: true, ref: 'New', sortAt: '2026-10-30T08:00:00.000Z', ask: { eventId: 'n1', state: 'waiting', askedAt: '2026-10-30T08:00:00.000Z', text: 'Task n1', files: [], canEdit: true } },
    workCard('T3', { sortAt: '2026-10-21T08:00:00.000Z', created: '2026-10-21T08:00:00.000Z', updatedAt: '2026-10-28T08:00:00.000Z' }),
    workCard('T2', { sortAt: '2026-10-20T08:00:00.000Z', created: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-29T08:00:00.000Z' }),
    workCard('D1', { lane: 'done', sortAt: '2026-10-25T08:00:00.000Z', created: '2026-10-01T08:00:00.000Z' }),
    workCard('D2', { lane: 'done', sortAt: '2026-10-24T08:00:00.000Z', created: '2026-10-09T08:00:00.000Z' }),
  ];
  const b = boardOnDom({ board: boardOf(cards), threads: {} });
  await b.settle();
  const lane = (id) => b.root.querySelector(`#lanes details.lane[data-lane="${id}"]`);
  const order = (id) => lane(id).querySelectorAll('details.item').map((el) => el.dataset.key);
  const times = (id) => lane(id).querySelectorAll('details.item').map((el) => el.querySelector('summary .card-time time')?.getAttribute('datetime') ?? null);
  assert.deepEqual(['review', 'progress', 'todo', 'done'].map(order), [['w/R1', 'w/R2'], ['w/P1'], ['w/T3', 'w/T2'], ['w/D1', 'w/D2']], 'a New task sits in the New strip, not Todo');
  assert.deepEqual(['review', 'todo', 'done'].map(times), [
    ['2026-10-29T08:00:00.000Z', '2026-10-28T08:00:00.000Z'], ['2026-10-21T08:00:00.000Z', '2026-10-20T08:00:00.000Z'], ['2026-10-25T08:00:00.000Z', '2026-10-24T08:00:00.000Z'],
  ]);
  assert.equal(b.root.querySelector('.lane-sort, .lane-sort-menu, [data-lane-sort]'), null);
});

// docs/adr/2026-11-09-1430-answered-asks-fold-into-the-one-done-list.md
test('answered asks sit in the one Done list among the work cards by time, 10 shown, then a Show more that adds 10 and says how many are left', async () => {
  const day = (n) => `2026-10-${String(30 - n).padStart(2, '0')}T08:00:00.000Z`;
  const work = Array.from({ length: 12 }, (_, n) => workCard(`D${n}`, { lane: 'done', sortAt: day(2 * n) }));
  const asks = Array.from({ length: 11 }, (_, n) => ({ ...askCard(`a${n}`, 'done'), sortAt: day(2 * n + 1) }));
  const all = [...work, ...asks].sort((x, y) => y.sortAt.localeCompare(x.sortAt));
  const b = boardOnDom({ open: ['w/a10'], board: boardOf([...work, ...asks]), threads: {} });
  await b.settle();
  const lane = (id) => b.root.querySelector(`#lanes details.lane[data-lane="${id}"]`);
  const keys = (id) => lane(id).querySelectorAll('details.item').map((el) => el.dataset.key);
  const more = (id) => lane(id).querySelector('[data-lane-more]');
  assert.deepEqual(b.root.querySelectorAll('#lanes details.lane').map((el) => el.dataset.lane), ['review', 'progress', 'todo', 'done']);
  assert.equal(lane('done').querySelector('summary .lane-name').textContent, 'Done');
  assert.equal(lane('done').querySelector('summary .count').textContent, '23');
  assert.equal(lane('done').querySelector('details.fold'), null);
  assert.deepEqual(keys('done'), all.slice(0, 10).map((c) => c.key));
  assert.equal(more('done').textContent, 'Show more · 13 older tasks');
  assert.ok(more('done').classList.contains('thread-more'));
  b.page.fire(b.root, 'click', { target: more('done') });
  await b.settle();
  assert.deepEqual([keys('done').length, more('done').textContent], [20, 'Show more · 3 older tasks']);
  b.page.fire(b.root, 'click', { target: more('done') });
  await b.settle();
  assert.deepEqual([keys('done'), more('done')], [all.map((c) => c.key), null]);
});

test("a finished wave's cards sit in Done's one newest-first list, and Done draws no fold", async () => {
  const cards = [['A', 'w', 3], ['B', 'w', 1], ['C', 'v', 2]].map(([id, file, n]) => workCard(id, { key: `${file}/${id}`, file, lane: 'done', sortAt: `2026-10-0${n}T08:00:00.000Z` }));
  const b = boardOnDom({ board: boardOf(cards), threads: {} });
  await b.settle();
  const done = b.root.querySelector('#lanes details.lane[data-lane="done"]');
  assert.equal(done.querySelector('details.fold'), null);
  assert.equal(done.querySelector('summary .count').textContent, '3');
  assert.deepEqual(done.querySelectorAll('details.item').map((el) => el.dataset.key), ['w/A', 'v/C', 'w/B']);
});

// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
test('past the 100 Done cards the board carries, Show more fetches the next 100 from the archive, 10 shown per tap, and an archived card opens', async () => {
  const day = (n) => new Date(Date.parse('2026-11-04T10:00:00Z') - n * 60000).toISOString();
  const card = (n) => workCard(`D${n}`, { lane: 'done', sortAt: day(n) });
  const archive = Array.from({ length: 130 }, (_, n) => card(100 + n));
  const b = boardOnDom({ board: { ...boardOf(Array.from({ length: 100 }, (_, n) => card(n))), doneArchived: 130 }, threads: { 'w/D205': [{ ts: day(205), who: 'claude', text: 'Old news.' }] } });
  const asked = [];
  b.server.done = (params) => {
    asked.push(params.get('before'));
    const from = params.get('before') ? archive.findIndex((c) => `${c.sortAt}|${c.key}` === params.get('before')) + 1 : 0;
    const cards = archive.slice(from, from + 100);
    return { cards, left: archive.length - from - cards.length };
  };
  await b.settle();
  const lane = () => b.root.querySelector('#lanes details.lane[data-lane="done"]');
  const shown = () => lane().querySelectorAll('details.item').length;
  const more = () => lane().querySelector('[data-lane-more]');
  const tap = async (n = 1) => { for (let i = 0; i < n; i++) { b.page.fire(b.root, 'click', { target: more() }); await b.settle(); } };
  const seen = () => [shown(), more()?.textContent ?? null, lane().querySelector('summary .count').textContent];
  assert.deepEqual(seen(), [10, 'Show more · 220 older tasks', '230']);
  await tap(9);
  assert.deepEqual([...seen(), asked], [100, 'Show more · 130 older tasks', '230', []]);
  await tap();
  assert.deepEqual([...seen(), asked], [110, 'Show more · 120 older tasks', '230', [null]]);
  await tap(9);
  assert.deepEqual([...seen(), asked.length], [200, 'Show more · 30 older tasks', '230', 1]);
  await tap();
  assert.deepEqual([...seen(), asked], [210, 'Show more · 20 older tasks', '230', [null, `${day(199)}|w/D199`]]);
  await tap(2);
  assert.deepEqual(seen(), [230, null, '230']);
  const old = lane().querySelector('details.item[data-key="w/D205"]');
  old.open = true;
  b.page.fire(b.root, 'toggle', { target: old });
  await b.settle();
  assert.match(old.querySelector('.detail').innerHTML, /Old news\./);
  b.view.unmount();
});

test('a slim Done card draws as the whole card does, closed and open', async () => {
  const t = (m) => `2026-11-04T0${m}:00:00.000Z`;
  const built = buildBoard({
    files: [{ slug: 'w', agents: { A1: { main: { kind: 'claude', started: t(1), done: t(2) } } }, itemFile: { title: 'W', repo: 'o/r', items: [
      { id: 'A1', title: 'Merged', lane: 'done', lane_at: t(3), closed_at: t(3), prs: [{ number: 7, merged_at: t(3) }], branch: 'a1', plan: 'a1.md', manual_steps: ['Restart the hub'], parent: 'A2', related: ['A3'] },
      { id: 'A2', title: 'Parent', lane: 'done', lane_at: t(4), closed_at: t(4), notes: 'Why' },
      { id: 'A3', title: 'Dropped', lane: 'done', lane_at: t(5), closed_at: t(5) },
      { id: 'A4', title: 'Open', lane: 'todo', deps: ['A2'] },
    ] } }],
    prs: { 'o/r#7': { state: 'MERGED', mergedAt: t(3), title: 'Merged', checks: { state: 'pass' }, reviews: {} } },
    owner: { items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }], resolved: 'Answered', resolved_at: t(2) }] },
    threads: { 'w/A1': [{ ts: t(2), who: 'love', text: 'Ship it' }], 'w/A2': [{ ts: t(4), who: 'claude', text: 'Done.' }] }, events: [],
  });
  const done = built.items.filter((i) => i.lane === 'done');
  assert.equal(done.length, 3);
  const draw = async (items) => {
    const b = boardOnDom({ open: done.map((i) => i.key), seen: { 'w/A1': t(0) }, board: { ...built, ...boardOf(items), waveBands: built.waveBands }, threads: {} });
    await b.settle();
    const html = b.root.querySelector('#lanes details.lane[data-lane="done"]').innerHTML;
    b.view.unmount();
    return html;
  };
  const whole = await draw(built.items);
  assert.match(whole, /Restart the hub/);
  assert.equal(await draw(built.items.map((i) => (i.lane === 'done' ? slimDone(i) : i))), whole);
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test('Board Settings holds every automatic job in one Auto section, short labels in order, Auto review off until loaded on', () => {
  const page = fakePage(memoryStorage().localStorage);
  const html = page.win.AppViews.settings.markup({}, { siteTitle: 'Orch' });
  const auto = html.slice(html.indexOf('<h2>Auto</h2>'), html.indexOf('<h2>Reviewers</h2>'));
  assert.deepEqual([...auto.matchAll(/<label class="who" for="(\w+)"><span><span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]), [
    ['maxImplementers', 'Maximum parallel implementers'], ['maxPlanners', 'Maximum parallel planners'], ['maxServes', 'Maximum parallel serves'], ['autoBuild', 'Auto serve'], ['autoReview', 'Auto review'], ['autoMerge', 'Auto-merge'],
    ['autoTriage', 'Triage overnight'], ['idleNotification', 'Idle notification'],
  ]);
  assert.match(auto, /May use a lot of usage\./);
  assert.doesNotMatch(html, /<h2>(Merging|Builds|Todo)<\/h2>/);
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test("the Auto Review lane leads the lanes; a held review's #review= link opens it, and Post it waits for the server with both buttons off", async () => {
  const held = { number: 437, title: 'One endpoint', author: 'Quinn', url: 'https://github.com/o/r/pull/437', asked: false, touches: [{ key: 'w/A1', ref: '#41' }],
    state: 'needs', at: '2026-10-30T09:58:00.000Z', text: 'Clashes with #41.', reviewUrl: null };
  const reviews = { on: true, shown: true, at: '2026-10-30T09:56:00.000Z', repo: 'o/r', cards: [held], earlier: [], waiting: 0, due: null };
  const board = { ...boardOf([workCard('A1')]), reviews, needs: [{ kind: 'Review', title: 'PR #437 One endpoint', text: 'x', url: '#review=437', review: 437 }] };
  let answer;
  const b = boardOnDom({ board, threads: {}, send: (kind, data, server) => new Promise((resolve) => { answer = () => resolve({ id: 'e1', board: structuredClone(server.board) }); }) });
  await b.settle();
  assert.equal(b.root.querySelectorAll('#lanes details.lane')[0].dataset.lane, 'reviews');
  const card = () => b.root.querySelector('#lanes details.rv-card[data-review="437"]');
  assert.equal(card().open, false);
  b.page.win.location.hash = '#review=437';
  b.page.fire(vm.runInContext('window', b.page.win), 'hashchange');
  await b.settle();
  assert.equal(card().open, true);
  const post = () => card().querySelector('button[data-review-answer="post"]');
  b.page.fire(b.root, 'click', { target: post() });
  await b.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['review-answer', { pr: 437, answer: 'post' }]]);
  const skip = () => card().querySelector('button[data-review-answer="skip"]');
  assert.deepEqual([post().disabled, post().getAttribute('aria-busy'), skip().disabled, skip().getAttribute('aria-busy')], [true, 'true', true, null], 'the tapped answer waits and the other is disabled');
  await b.change({});
  assert.deepEqual([post().getAttribute('aria-busy'), skip().disabled], ['true', true], 'a repaint keeps them waiting');
  answer();
  await b.settle();
  assert.deepEqual([post().disabled, post().getAttribute('aria-busy'), skip().disabled], [false, null, false]);
});

// docs/adr/2026-11-03-1921-board-settings-grant-a-boards-session-permissions.md
test("Board Settings' Permissions switches sit below Auto, wait for the server with a spinner beside them, and note a refusal", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const html = page.win.AppViews.settings.markup({}, { siteTitle: 'Orch' });
  assert.ok(html.indexOf('<h2>Auto</h2>') < html.indexOf('<h2>Permissions</h2>') && html.indexOf('<h2>Permissions</h2>') < html.indexOf('<h2>Reviewers</h2>'));
  const rules = { pushMain: 'Bash(git push origin main)', pushTags: 'Bash(git push origin v*)', draftPr: 'Bash(gh pr create --draft *)' };
  const names = { pushMain: 'Push main after a land', pushTags: 'Push release tags', draftPr: 'Open draft PRs' };
  const state = { pushMain: false, pushTags: true, draftPr: false };
  let answer = null;
  const posts = [];
  const view = () => ({ file: '/r/.claude/settings.local.json', permissions: Object.keys(rules).map((id) => ({ id, name: names[id], allows: `Allows ${id}.`, rule: rules[id], on: state[id],
    refused: id === 'pushTags' && state[id] ? { command: 'git push origin v0.9.0', how: 'denied', at: '2026-11-03T20:00:00.000Z' } : null })) });
  const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 400, text: async () => JSON.stringify(body), json: async () => body });
  page.win.fetch = async (url, opts = {}) => {
    if (!url.endsWith('/api/permissions')) return reply({});
    if (opts.method !== 'POST') return reply(view());
    posts.push(JSON.parse(opts.body));
    return new Promise((resolve) => { answer = (ok = true) => { if (ok) state[posts.at(-1).id] = posts.at(-1).on; resolve(ok ? reply(view()) : reply({ error: 'Cannot save' }, false)); }; });
  };
  const { Element } = miniDom(page.Target, page.win.document);
  const mount = async () => {
    const root = page.win.document.body.appendChild(new Element('div'));
    root.innerHTML = html;
    const v = page.win.AppViews.settings.create(root, '/orch', {});
    v.mount();
    await tick(); await tick();
    return { root, v };
  };
  const { root, v } = await mount();
  const toggle = (id) => root.querySelector(`#perm-${id}`);
  assert.deepEqual(Object.keys(rules).map((id) => [toggle(id).checked, toggle(id).disabled]), [[false, false], [true, false], [false, false]]);
  const rows = [...root.querySelectorAll('#permissions label.who')];
  assert.deepEqual(rows.map((r) => r.querySelector('span span').textContent), Object.values(names));
  assert.match(rows[1].innerHTML, /Writes <code>Bash\(git push origin v\*\)<\/code>/);
  assert.equal(root.querySelector('#permissions .refused-note').textContent, 'Auto mode still refused this once: git push origin v0.9.0. Approve it under /permissions, Recently blocked.');
  assert.equal(root.querySelector('#permissionsNotOwner'), null);

  const change = (id) => page.fire(root.querySelector('#permissions'), 'change', { target: toggle(id) });
  toggle('pushMain').checked = true;
  change('pushMain');
  await tick();
  assert.deepEqual(posts, [{ id: 'pushMain', on: true }]);
  assert.deepEqual([toggle('pushMain').checked, toggle('pushMain').disabled, toggle('pushMain').classList.contains('tap-waiting')], [false, true, true], 'nothing changes before the server answers');
  assert.ok(toggle('pushMain').parentNode.querySelector('.toggle-spin'), 'the spinner sits beside the switch');
  answer();
  await tick(); await tick();
  assert.deepEqual([toggle('pushMain').checked, toggle('pushMain').disabled, toggle('pushMain').classList.contains('tap-waiting')], [true, false, false]);
  assert.match(root.querySelector('#perm-pushMainStatus').textContent, /^Saved\./);

  toggle('pushTags').checked = false;
  change('pushTags');
  await tick();
  answer(false);
  await tick(); await tick();
  assert.deepEqual([toggle('pushTags').checked, toggle('pushTags').disabled], [true, false]);
  assert.equal(root.querySelector('#perm-pushTagsStatus').textContent, 'Cannot save');
  v.unmount();
});

// docs/adr/2026-11-04-2345-a-builders-log-and-notes-open-in-a-sheet.md
function readerOnDom(logText, { width = 390, topics = null } = {}) {
  const launch = { ts: '2026-10-30T09:00:00.000Z', who: 'claude', kind: 'agent', run: 'r1', agent: 'Claude Sonnet implementer', text: 'Claude Sonnet implementer started', finished: false, log: 'builder-A1-1.log' };
  const card = workCard('A1', { lane: 'progress', hasNotes: true });
  const b = boardOnDom({ open: ['w/A1'], width, board: topics ? { ...questionsBoard(topics, []), items: [card] } : boardOf([card]), threads: { 'w/A1': [launch] } });
  const log = { text: logText };
  const moves = [];
  b.page.win.history = { state: { idx: 3 }, pushState(state, _, url) { moves.push(['push', state, url]); this.state = state; }, replaceState() {}, back() { moves.push(['back']); } };
  const boardFetch = b.page.win.fetch;
  b.page.win.fetch = async (url, opts) => {
    const u = new URL(url, 'https://mac.ts.net/');
    if (u.pathname.endsWith('/api/transcript')) {
      b.gets.push(`${u.pathname}?${u.searchParams}`);
      const bytes = Buffer.from(log.text);
      const from = Number(u.searchParams.get('from'));
      return { ok: true, status: 200, json: async () => ({ ...transcriptChunk(bytes.subarray(from), from), size: bytes.length }) };
    }
    if (u.pathname.endsWith('/api/log')) { b.gets.push(`${u.pathname}?${u.searchParams}`); return { ok: true, status: 200, json: async () => ({ text: log.text, truncated: false, size: log.text.length }) }; }
    if (u.pathname.endsWith('/api/notes')) { b.gets.push(`${u.pathname}?${u.searchParams}`); return { ok: true, status: 200, json: async () => ({ key: 'w/A1', ref: 'A1', title: 'Work A1', markdown: '# The plan\n\nBuild it, then see [the prototype](prototype-reader.html).' }) }; }
    return boardFetch(url, opts);
  };
  const tap = (el) => b.page.fire(b.root, 'click', { target: el, button: 0 });
  const sheet = () => b.root.querySelector('#readerSheet');
  return { ...b, log, moves, tap, sheet, inSheet: (sel) => sheet().querySelector(sel) };
}
test('on desktop the reader sheet opens non-modal over the right pane: a click on the left pane leaves it open, and its ✕ and Escape close it; a phone keeps the modal sheet', async () => {
  const r = readerOnDom('plain log text');
  await r.settle();
  const link = r.root.querySelector('a[href="log.html?file=builder-A1-1.log"]');
  r.page.win.innerWidth = 1200;
  r.tap(link);
  await r.settle();
  assert.deepEqual([r.sheet().open, r.sheet().modal], [true, false], 'wide: dialog.show(), no backdrop');
  r.page.fire(r.page.win, 'click', { target: r.root });
  assert.equal(r.sheet().open, true, 'a click outside the sheet does not close it');
  r.page.fire(r.page.win.document, 'keydown', { key: 'Escape' });
  assert.equal(r.sheet().open, false, 'Escape closes it');
  r.tap(link);
  await r.settle();
  r.page.fire(r.sheet(), 'click', { target: r.inSheet('[data-reader="close"]') });
  assert.equal(r.sheet().open, false, 'its ✕ closes it');
  r.page.win.innerWidth = 600;
  r.tap(link);
  await r.settle();
  assert.deepEqual([r.sheet().open, r.sheet().modal], [true, true], 'narrow: modal as before');
});

const streamLine = (e) => `${JSON.stringify(e)}\n`;
const said = (text) => streamLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const called = (name, input, id = 't1') => streamLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const answered = (content, id = 't1') => streamLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

test("a run's View transcript opens its transcript in a sheet over the board: Claude's words, each call one line with its output on tap, read on from where it left off, following new lines while read at the end, a raw toggle, and Escape, a tap outside or Back closes it", async () => {
  const r = readerOnDom(streamLine({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', cwd: '/wt/A1' }) + said('Reading the notes first.')
    + called('Bash', { command: 'node --test board/view.test.mjs', description: 'Run the tests' }) + answered([{ type: 'text', text: 'ℹ pass 6' }]));
  await r.settle();
  const link = r.root.querySelector('a[href="log.html?file=builder-A1-1.log"]');
  assert.equal(link.textContent, 'View transcript');
  assert.equal(r.tap(link).defaultPrevented, true, 'the link opens the sheet in place of the log page');
  await r.settle();
  assert.equal(r.sheet().open, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.moves)), [['push', { idx: 4, reader: true }, 'https://mac.ts.net/']], 'Back has an entry to close it with');
  assert.deepEqual(r.gets.filter((g) => /api\/(log|transcript)/.test(g)), ['/board-a/api/transcript?file=builder-A1-1.log&from=0']);
  assert.equal(r.inSheet('#readerTitle').textContent, 'builder transcript');
  assert.equal(r.inSheet('.reader-ref').textContent, 'builder-A1-1.log');
  const rows = () => r.sheet().querySelectorAll('.reader-row').map((row) => [row.getAttribute('class').replace('reader-row ', ''), row.textContent]);
  assert.deepEqual(rows(), [['sys', 'startclaude-sonnet-5-5 in /wt/A1'], ['text md', 'Reading the notes first.'], ['tool call', '▸bashnode --test board/view.test.mjs']]);
  assert.equal(r.inSheet('.reader-out'), null, "a call's output is shut");
  r.page.fire(r.sheet(), 'click', { target: r.inSheet('.reader-row.call .reader-tag') });
  assert.deepEqual([rows()[2][1], r.inSheet('.reader-out').textContent], ['▾bashnode --test board/view.test.mjs', 'ℹ pass 6'], 'a tap on the call opens its output');
  r.page.fire(r.sheet(), 'click', { target: r.inSheet('.reader-row.call') });
  assert.equal(r.inSheet('.reader-out'), null, 'and a second tap shuts it');
  assert.equal(r.inSheet('.reader-status').textContent, 'following');

  // Read at the end, a new line scrolls into view; scrolled up, the sheet stays put and counts what came.
  const body = r.inSheet('.reader-body');
  Object.assign(body, { scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });
  const read = Buffer.byteLength(r.log.text);
  r.log.text += said('Committing.');
  r.page.runTimers(3000);
  await r.settle();
  assert.equal(rows().at(-1)[1], 'Committing.');
  assert.equal(r.gets.at(-1), `/board-a/api/transcript?file=builder-A1-1.log&from=${read}`, 'each read starts where the last one ended');
  assert.equal(body.scrollTop, body.scrollHeight);
  body.scrollTop = 0;
  r.page.fire(body, 'scroll', { target: body });
  assert.equal(r.inSheet('.reader-status').textContent, 'paused');
  r.log.text += called('Read', { file_path: '/wt/A1/board/public/app.js' }, 't2');
  r.page.runTimers(3000);
  await r.settle();
  assert.deepEqual([body.scrollTop, r.inSheet('.reader-new').hidden, r.inSheet('.reader-new').textContent], [0, false, '1 new line ↓']);
  assert.equal(rows().at(-1)[0], 'tool', 'a call with no output yet has nothing to open');
  r.log.text += answered('const app = 1;', 't2');
  r.page.runTimers(3000);
  await r.settle();
  assert.equal(r.inSheet('.reader-new').textContent, '1 new line ↓', "an output joins its call's line, not a line of its own");
  r.page.fire(r.sheet(), 'click', { target: r.sheet().querySelectorAll('.reader-row.call').at(-1) });
  assert.equal(r.inSheet('.reader-out').textContent, 'const app = 1;', "the output that came later opens on the call's line");
  r.page.fire(r.sheet(), 'click', { target: r.inSheet('.reader-new') });
  assert.deepEqual([body.scrollTop, r.inSheet('.reader-new').hidden, r.inSheet('.reader-status').textContent], [1000, true, 'following']);

  r.page.fire(r.sheet(), 'click', { target: r.inSheet('[data-reader="raw"]') });
  await r.settle();
  assert.equal(r.inSheet('[data-reader="raw"]').getAttribute('aria-pressed'), 'true');
  assert.equal(r.gets.at(-1), '/board-a/api/log?file=builder-A1-1.log', 'raw reads the file as it is');
  assert.equal(r.inSheet('.reader-raw').textContent, r.log.text);

  // The run's result ends the following.
  r.log.text += streamLine({ type: 'result', subtype: 'success', is_error: false, result: 'Built #254 and committed it.' });
  r.page.runTimers(3000);
  await r.settle();
  r.page.fire(r.sheet(), 'click', { target: r.inSheet('[data-reader="raw"]') });
  assert.deepEqual(rows().at(-1), ['text end md', 'doneBuilt #254 and committed it.']);
  assert.equal(r.inSheet('.reader-status').textContent, 'finished');
  const gets = r.gets.length;
  r.page.runTimers(3000);
  await r.settle();
  assert.equal(r.gets.length, gets, 'a finished log is read no more');

  r.page.fire(r.sheet(), 'cancel', { target: r.sheet() });
  assert.equal(r.sheet().open, false);
  assert.deepEqual(r.moves.at(-1), ['back'], 'Escape takes back the entry it pushed');

  r.tap(link);
  await r.settle();
  r.page.fire(r.sheet(), 'click', { target: r.sheet() });
  assert.deepEqual([r.sheet().open, r.moves.at(-1)], [false, ['back']], 'a tap on the dim area closes it');

  r.tap(link);
  await r.settle();
  const backs = r.moves.filter(([m]) => m === 'back').length;
  r.page.fire(vm.runInContext('window', r.page.win), 'popstate', { state: { idx: 3 } });
  assert.equal(r.sheet().open, false, 'Back closes it');
  assert.equal(r.moves.filter(([m]) => m === 'back').length, backs, 'and Back already took the entry');
  r.view.unmount();
});

// docs/adr/2026-11-09-1453-orchestrator-messages-replies-and-transcript-text-are-markdown.md
test("View transcript draws Claude's text rows and its final result as compact markdown, and calls and outputs as written", async () => {
  const r = readerOnDom(said('Plan:\n\n- **read** the notes\n- run `tests`') + called('Bash', { command: 'echo **x**' }) + answered([{ type: 'text', text: '**out**' }])
    + streamLine({ type: 'result', subtype: 'success', is_error: false, result: '## Done\n\nAll *green*.' }));
  await r.settle();
  r.tap(r.root.querySelector('a[href^="log.html"]'));
  await r.settle();
  const said1 = r.inSheet('.reader-row.text');
  assert.match(said1.innerHTML, /^<p>Plan:<\/p>\s*<ul><li><strong>read<\/strong> the notes<\/li><li>run <code>tests<\/code><\/li><\/ul>$/);
  assert.match(r.inSheet('.reader-row.end').innerHTML, /<span class="reader-tag">done<\/span><h2>Done<\/h2>\s*<p>All <em>green<\/em>\.<\/p>/);
  assert.equal(r.inSheet('.reader-row.call').textContent, '▸bashecho **x**');
  r.page.fire(r.sheet(), 'click', { target: r.inSheet('.reader-row.call') });
  assert.equal(r.inSheet('.reader-out').textContent, '**out**');
  r.view.unmount();
});

test("an older log of a run's final text reads as text, with no raw toggle", async () => {
  const r = readerOnDom('I built #214 and committed it.\nThe full suite passed.\n');
  await r.settle();
  r.tap(r.root.querySelector('a[href^="log.html"]'));
  await r.settle();
  assert.equal(r.inSheet('.reader-text').textContent, 'I built #214 and committed it.\nThe full suite passed.\n');
  assert.equal(r.inSheet('[data-reader="raw"]'), null);
  r.view.unmount();
});

test("a card's Notes open, rendered, in the same sheet, and a link in them closes it first", async () => {
  const r = readerOnDom('');
  await r.settle();
  const notes = r.root.querySelector('a[href="notes.html?item=w%2FA1"]');
  assert.equal(r.tap(notes).defaultPrevented, true);
  await r.settle();
  assert.equal(r.sheet().open, true);
  assert.ok(r.gets.includes('/board-a/api/notes?item=w%2FA1'));
  assert.deepEqual([r.inSheet('#readerTitle').textContent, r.inSheet('.reader-ref').textContent], ['notes', 'A1 notes']);
  assert.equal(r.inSheet('.reader-md h1').textContent, 'The plan');
  assert.equal(r.inSheet('.reader-status'), null);
  assert.equal(r.inSheet('[data-reader="raw"]'), null);
  const tapped = r.page.fire(r.sheet(), 'click', { target: r.inSheet('.reader-md p') });
  assert.equal(r.sheet().open, true, 'a tap in the sheet keeps it open');
  assert.equal(tapped.defaultPrevented, false);

  const shown = [];
  r.page.win.AppShell = { open: (href) => { shown.push(href); return true; } };
  const link = r.inSheet('.reader-md a');
  assert.equal(link.getAttribute('href'), 'prototype-reader.html');
  assert.equal(r.page.fire(r.sheet(), 'click', { target: link, button: 0 }).defaultPrevented, true);
  assert.deepEqual([r.sheet().open, r.moves.at(-1)[0], shown], [false, 'back', []], 'the sheet closes and takes its entry back first');
  r.page.fire(vm.runInContext('window', r.page.win), 'popstate', { state: { idx: 3 } });
  assert.deepEqual(shown, ['https://mac.ts.net/prototype-reader.html'], 'then the link opens through the shell');
  r.view.unmount();
});

test("the reader sheet wraps long lines in monospace and never scrolls sideways", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.reader-body \{[^}]*overflow-x: hidden/);
  assert.match(css, /\.reader-row \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.reader-raw, \.reader-text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*ui-monospace/);
  assert.match(css, /\.reader-sheet \{[^}]*height: 85dvh/);
});

// docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
test("Prototype, Grill and Visual show their line at once as sending…, their button never waiting; the board's line takes its place, a failed one reads not sent, and Retry resends it in place under its send id", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/A1'], board: boardOf([workCard('A1')]), threads: { 'w/A1': [] }, send: sends.send, confirm: true });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/A1"]');
  const button = (sel) => form().querySelector(sel);
  const tap = async (sel, text = '') => { form().querySelector('textarea').value = text; b.page.fire(b.root, 'click', { target: button(sel) }); await b.settle(); };
  await tap('button[data-proto]');
  assert.deepEqual([waitState(button('button[data-proto]')), threadLines(b, 'w/A1')], [IDLE, ['Prototype requested · sending…']]);
  await tap('button[data-grill]', 'Ask about the colours');
  await tap('button[data-visual]');
  assert.deepEqual([waitState(button('button[data-grill]')), waitState(button('button[data-visual]')), threadLines(b, 'w/A1')],
    [IDLE, IDLE, ['Prototype requested · sending…', 'Ask about the colours (Grill requested · sending…)', 'Visual requested · sending…']]);
  assert.equal(b.sent.length, 1, 'one at a time, in order');
  b.server.threads['w/A1'] = [{ ts: '2026-10-30T10:00:00.000Z', who: 'love', via: 'site', kind: 'prototype-request', text: 'Prototype requested', request: true, command: 'prototype', eventId: 'e1', reply: null, state: 'waiting' }];
  sends.answer();
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/A1'), ['Prototype requested · waiting…', 'Ask about the colours (Grill requested · sending…)', 'Visual requested · sending…']);
  sends.answer(false, REFUSED);
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/A1'), ['Prototype requested · waiting…', 'Ask about the colours (Grill requested · not sent)', 'Visual requested · sending…']);
  assert.equal(b.root.querySelector('.toast').textContent, REFUSED);
  const grillId = b.sent[1][1].sendId;
  b.page.fire(b.root, 'click', { target: b.root.querySelector(`[data-thread="w/A1"] button[data-resend="${grillId}"]`) });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), b.sent.at(-1)[0], b.sent.at(-1)[1].sendId], ['Send this message again?', 'grill-more', grillId]);
  assert.deepEqual(sentNoIds(b), [['prototype-request', { key: 'w/A1' }], ['grill-more', { key: 'w/A1', text: 'Ask about the colours' }], ['grill-more', { key: 'w/A1', text: 'Ask about the colours' }]]);
  b.view.unmount();
});

// docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
test("a reply box's Hold, after its sheet, and Resume, Done and Reopen, after their confirm, show their line at once as sending…, their button never waiting, end plain once the board has them, and a failed one retries in place", async () => {
  const cards = [
    workCard('P1', { lane: 'progress', holdable: true }),
    workCard('H1', { lane: 'progress', holdable: true, held: true }),
    workCard('R1', { lane: 'review' }),
    workCard('D1', { lane: 'done' }),
  ];
  const sends = heldSends();
  const b = boardOnDom({ open: cards.map((c) => c.key), board: { ...boardOf(cards), holdChoices: HOLD_CHOICES }, threads: Object.fromEntries(cards.map((c) => [c.key, []])), send: sends.send, confirm: true });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const second = (key) => form(key).querySelector('[data-confirm]');
  const tap = async (key) => { b.page.fire(b.root, 'submit', { target: form(key), submitter: second(key) }); await b.settle(); };
  await tap('w/P1');
  b.page.fire(b.root.querySelector('#holdSheet'), 'click', { target: b.root.querySelector('#holdSheet [data-hold-for]') });
  await b.settle();
  for (const key of ['w/H1', 'w/R1', 'w/D1']) await tap(key);
  assert.deepEqual(cards.map((c) => [threadLines(b, c.key), waitState(second(c.key))]), [
    [['Held · sending…'], IDLE], [['Resumed · sending…'], IDLE], [['Marked done · sending…'], IDLE], [['Reopened · sending…'], IDLE],
  ]);
  assert.deepEqual(sentNoIds(b), [['card-hold', { key: 'w/P1', hold: true, for: '1h' }], ['card-hold', { key: 'w/H1', hold: false }], ['card-done', { key: 'w/R1' }], ['card-reopen', { key: 'w/D1' }]]);
  b.server.threads['w/P1'] = [{ ts: '2026-10-30T10:00:00.000Z', who: 'love', kind: 'command', command: 'hold', request: true, mark: 'Held', text: 'Held until 11:00 AM' }];
  sends.answer();
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/P1'), ['Held until 11:00 AM']);
  sends.answer(false, REFUSED);
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/H1'), ['Resumed · not sent']);
  const resumeId = b.sent[1][1].sendId;
  b.page.fire(b.root, 'click', { target: b.root.querySelector(`[data-thread="w/H1"] button[data-resend="${resumeId}"]`) });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), threadLines(b, 'w/H1'), b.sent.at(-1)[1].sendId], ['Send “Resumed” again?', ['Resumed · sending…'], resumeId]);
  b.view.unmount();
});

for (const row of CARD_TAPS.filter((r) => r.changed)) {
  test(`${row.name} spins until a board shows its change, while its POST is still out`, async () => {
    const { b, sends, card, button } = await tapCard(row);
    const show = (c) => b.change({ board: { ...boardOf([c]), holdChoices: HOLD_CHOICES } });
    await show(row.card);
    assert.deepEqual(waitState(button()), WAITING, 'a board without the change keeps the spinner');
    await show(row.changed(row.card));
    assert.equal(card().querySelector('.tap-waiting'), null);
    assert.equal(sends.waiting.length, 1, 'the POST is still out');
    sends.answer();
    await b.settle();
    b.view.unmount();
  });
}

test("a tap whose POST board cannot land because a reload won the race keeps its spinner until a board made after the tap is drawn", async () => {
  const T1 = workCard('T1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 0 });
  const T2 = workCard('T2', { bumpable: true, sortAt: '2026-10-02T00:00:00.000Z', order: 1 });
  const v1 = { ...boardOf([T1, T2]), version: 'v1', generatedAt: '2026-10-30T10:00:00.000Z' };
  const raced = { ...v1, version: 'v1b', generatedAt: '2026-10-30T10:00:00.500Z' };
  const bumped = { ...boardOf([{ ...T2, bumpedAt: '2026-10-30T10:00:01.000Z' }, T1]), version: 'v2', generatedAt: '2026-10-30T10:00:01.000Z' };
  let hold = null;
  const b = boardOnDom({ board: v1, threads: {}, send: async (kind, data, server) => {
    // A change signal's reload lands while the POST is out, without the tap.
    await b.change({ board: raced });
    server.board = bumped;
    hold = new Promise((resolve) => { b.release = resolve; });
    return { id: 'e1', board: structuredClone(boardPatch(v1, bumped)) };
  } });
  await b.settle();
  const fetched = b.page.win.fetch;
  b.page.win.fetch = async (url, opts) => { if (hold && String(url).includes('/api/board')) await hold; return fetched(url, opts); };
  const order = () => b.root.querySelectorAll('.lane[data-lane="todo"] details.item').map((el) => el.dataset.key);
  const bump = () => b.root.querySelector('details.item[data-key="w/T2"] button[data-card-bump]');
  b.page.fire(b.root, 'click', { target: bump() });
  await b.settle();
  assert.deepEqual([order(), bump().getAttribute('aria-busy')], [['w/T1', 'w/T2'], 'true'], 'the board on screen lacks the bump, so the button still spins');
  b.release();
  hold = null;
  await b.settle();
  assert.deepEqual([order(), bump().getAttribute('aria-busy')], [['w/T2', 'w/T1'], null]);
  b.view.unmount();
});

test("Waiting on you's Send, Prototype and Reopen stay busy until the page has moved on, not until their POST answers", async () => {
  const question = (id, state = 'open', extra = {}) => ({ id, topic: 'item:w/T1', source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state, ...extra });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question('q1'), question('q2'), question('q3'), question('r1', 'resolved', { resolved: 'Picked A', resolved_at: '2026-10-30T09:00:00.000Z', reask: null })], at: 'q1' });
  v.page.win.BoardDialogs.confirm = async () => true;
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  const fetched = v.page.win.fetch;
  let hold = null;
  v.page.win.fetch = async (url, opts) => { if (hold && /\/api\/(board|questions)/.test(String(url))) await hold; return fetched(url, opts); };
  // A poll's load is out when the tap's POST answers: the page moves on only once it has landed.
  const slowLoad = () => { let release; hold = new Promise((resolve) => { release = () => { hold = null; resolve(); }; }); v.page.fire(v.page.win.document, 'visibilitychange', {}); return release; };

  let release = slowLoad();
  v.answer('q1');
  await v.send();
  assert.deepEqual([$('#send').disabled, $('#send').getAttribute('aria-busy'), v.sent.length], [true, 'true', 1], 'the POST answered, the page has not moved on');
  release();
  await v.settle();
  assert.deepEqual([$('#send').getAttribute('aria-busy'), v.shown().status], [null, 'sent 1 answer · 2 still open']);

  release = slowLoad();
  v.page.fire(v.root, 'click', { target: $('section.q[data-q="q2"] [data-proto]') });
  await v.settle();
  const eye = () => $('section.q[data-q="q2"] [data-proto]');
  assert.equal(v.sent.at(-1)[0], 'prototype-request');
  assert.deepEqual([eye().disabled, eye().getAttribute('aria-busy')], [true, 'true']);
  release();
  await v.settle();
  assert.match(v.shown().status, /^prototype requested/);

  v.page.fire(v.root, 'click', { target: $('section.q[data-q="r1"] [data-reopen]') });
  await v.settle();
  assert.equal(v.sent.at(-1)[0], 'question-reopen');
  assert.ok($('section.q[data-q="r1"] textarea.note'), 'the badge rests only once the page shows the question open');
  v.unmount();
});

test("a Permissions switch keeps its spinner past the server's answer until the new face is drawn", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const html = page.win.AppViews.settings.markup({}, { siteTitle: 'Orch' });
  let on = false;
  let holdBody = null;
  const view = () => ({ permissions: [{ id: 'pushMain', name: 'Push main', allows: 'Allows it.', rule: 'Bash(git push origin main)', on, refused: null }] });
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => { await holdBody; return body; } });
  page.win.fetch = async (url, opts = {}) => {
    if (!url.endsWith('/api/permissions')) return reply({});
    if (opts.method === 'POST') { on = JSON.parse(opts.body).on; return reply(view()); }
    return reply(view());
  };
  const { Element } = miniDom(page.Target, page.win.document);
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = html;
  const v = page.win.AppViews.settings.create(root, '/orch', {});
  v.mount();
  await tick(); await tick();
  const toggle = () => root.querySelector('#perm-pushMain');
  let release;
  holdBody = new Promise((resolve) => { release = resolve; });
  toggle().checked = true;
  page.fire(root.querySelector('#permissions'), 'change', { target: toggle() });
  await tick(); await tick();
  assert.deepEqual([toggle().checked, toggle().disabled], [false, true], 'the answer came, but the old face stays under its spinner');
  release();
  holdBody = null;
  await tick(); await tick();
  assert.deepEqual([toggle().checked, toggle().disabled], [true, false]);
  v.unmount();
});

const openQuestion = (id, topic, extra = {}) => ({ id, topic, source: 'Grill', question: `Question ${id}?`, context: `Why ${id}`, answers: [], state: 'open',
  options: [{ id: 'A', label: 'Yes', detail: 'Do it', recommended: true }, { id: 'B', label: 'No', detail: 'Leave it' }], ...extra });
const questionsBoard = (questions, needs = [], queue = []) => {
  const topics = [...new Set(questions.map((q) => q.topic))].map((id) => ({ id, title: `Topic ${id}`, state: 'open', questions: questions.filter((q) => q.topic === id).map((q) => q.id),
    open: questions.filter((q) => q.topic === id && q.state === 'open').length, answered: 0, resolved: 0 }));
  return { ...boardOf([]), owner: questions, ownerTopics: topics, needs, queue };
};

// docs/adr/2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md
test("from 900px Waiting on you sits in a pane beside the lanes with a drag seam, and no width draws the orange Needs you deck or its lines, a card's Action needed included", async () => {
  const action = { kind: 'Action needed', title: 'GH-9: Merge it', text: '', url: '#selectedCard=w%2FGH-9', key: 'w/GH-9', questions: null, ready: null, action: { label: 'Merge', url: '#selectedCard=w%2FGH-9' } };
  const board = questionsBoard([openQuestion('q1', 't1')], [action]);
  const wide = boardOnDom({ board, threads: {}, width: 1280 });
  await wide.settle();
  const pane = wide.root.querySelector('#boardPane');
  assert.equal(pane.getAttribute('aria-label'), 'Waiting on you');
  assert.deepEqual(pane.querySelectorAll('.pane-questions section.q').map((s) => s.dataset.q), ['q1']);
  assert.equal(pane.querySelector('.pane-questions header'), null, 'the pane has no header of its own');
  assert.ok(wide.root.querySelector('.split > .col-handle[data-col="pane"]'), 'the seam between the lanes and the pane drags');
  const narrow = boardOnDom({ board, threads: {} });
  await narrow.settle();
  assert.equal(narrow.root.querySelector('#boardPane .pane-questions'), null, 'a phone mounts no pane');
  for (const b of [wide, narrow]) {
    assert.deepEqual([b.root.querySelector('#needsDeck'), b.root.querySelector('#waiting'), b.root.querySelector('.deck-card')], [null, null, null], 'no Needs you deck or lines');
    b.view.unmount();
  }
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /needs-deck|deck-card/, 'the stylesheet keeps no deck rules');
});

// docs/adr/2026-11-14-2230-the-desktop-pane-shows-the-lanes-board.md
test("the desktop Waiting on you pane shows the board the lanes hold, with no /api/board fetch of its own, and repaints when the lanes' board changes", async () => {
  const board = { ...questionsBoard([openQuestion('q1', 't1')], []), version: 'v1' };
  const wide = boardOnDom({ board, threads: {}, width: 1280 });
  await wide.settle();
  const pane = wide.root.querySelector('#boardPane');
  const asked = () => pane.querySelectorAll('.pane-questions section.q').map((s) => s.dataset.q);
  const fetches = () => wide.gets.filter((g) => g.endsWith('/api/board')).length;
  assert.deepEqual([asked(), fetches()], [['q1'], 1], 'one board fetch paints the lanes and the pane');
  await wide.change({ board: { ...questionsBoard([openQuestion('q1', 't1'), openQuestion('q2', 't1')], []), version: 'v2' } });
  assert.deepEqual([asked(), fetches()], [['q1', 'q2'], 2], "the lanes' next load repaints the pane, which asks for nothing");
  wide.view.unmount();
});

// docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md
test("on a desktop, focusQuestion opens a question's or topic's topic in the pane and focuses its pill, a resolved topic or no topic included, once the pane has loaded; a phone has no pane", async () => {
  const board = questionsBoard([openQuestion('q1', 't1'), openQuestion('q2', 't2')], []);
  board.ownerTopics.push({ id: 't0', title: 'Topic t0', state: 'resolved', questions: ['q0'], open: 0, answered: 0, resolved: 1 });
  const wide = boardOnDom({ board, threads: {}, width: 1280 });
  assert.equal(wide.view.B.focusQuestion('q2'), false, 'before the pane loads there is nothing to open, so the shell waits');
  await wide.settle();
  const pill = (id) => wide.root.querySelector(`#boardPane button[data-topic="${id}"]`);
  const scrolled = [];
  wide.root.constructor.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.dataset.topic); };
  assert.equal(pill('t1').getAttribute('aria-pressed'), 'true');
  assert.equal(wide.view.B.focusQuestion('q2'), true);
  assert.deepEqual([pill('t2').getAttribute('aria-pressed'), wide.doc.activeElement, scrolled], ['true', pill('t2'), ['t2']], 'a question opens its topic');
  assert.equal(wide.view.B.focusQuestion('t1'), true);
  assert.deepEqual([pill('t1').getAttribute('aria-pressed'), wide.doc.activeElement], ['true', pill('t1')], 'a topic id opens that topic');
  const fetch = wide.page.win.fetch;
  wide.page.win.fetch = async (url, opts) => (String(url).includes('/api/questions')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ questions: [openQuestion('q0', 't0', { state: 'resolved', resolved: 'Done' })] }) } : fetch(url, opts));
  assert.equal(wide.view.B.focusQuestion('q0'), true);
  await wide.settle();
  assert.deepEqual([pill('t0').getAttribute('aria-pressed'), wide.root.querySelector('#boardPane section.q.resolved').dataset.q], ['true', 'q0'], 'a resolved topic opens in the pane too');
  assert.match(pill('t0').textContent, /resolved/);
  assert.equal(wide.view.B.focusQuestion(null), true);
  assert.equal(pill('t1').getAttribute('aria-pressed'), 'true', 'no topic opens the first with an open question');
  assert.equal(wide.view.B.focusQuestion('gone'), true);
  assert.equal(pill('t1').getAttribute('aria-pressed'), 'true', 'a topic that is gone does the same');
  const narrow = boardOnDom({ board, threads: {} });
  await narrow.settle();
  assert.equal(narrow.view.B.focusQuestion('q2'), false, 'a phone has no pane');
});

// docs/adr/2026-11-12-2359-a-topic-in-the-questions-pane-closes-the-overlays-over-it.md
test('a topic picked in the questions pane, by a pill or a questions URL, closes the reader sheet and the prototype viewer over the pane', async () => {
  const r = readerOnDom('plain log text', { width: 1280, topics: [openQuestion('q1', 'item:w/T1'), openQuestion('q2', 'item:w/P1')] });
  await r.settle();
  const link = r.root.querySelector('a[href="log.html?file=builder-A1-1.log"]');
  const pill = (id) => r.root.querySelector(`#boardPane button[data-topic="${id}"]`);
  const pick = async (id) => { r.page.fire(r.root.querySelector('#boardPane .pane-questions'), 'click', { target: pill(id) }); await r.settle(); };
  r.tap(link);
  await r.settle();
  assert.equal(r.sheet().open, true);
  await pick('item:w/P1');
  assert.equal(r.sheet().open, false, 'a pill tap closes the reader');
  r.tap(link);
  await r.settle();
  r.view.B.focusQuestion('q1');
  assert.equal(r.sheet().open, false, 'a questions URL closes the reader');
  r.view.B.openViewer('prototype-x2.html?q=q2');
  await pick('item:w/P1');
  assert.equal(r.root.querySelector('#boardPane .pane-viewer'), null, 'a pill tap closes the prototype viewer');
  r.view.unmount();
});

// docs/adr/2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md
test("on a desktop a prototype opens in the right pane under a top bar of ‹ Open questions, ⤢ and the card's Round pill; ⤢ widens it over the lanes and back, ‹ and a focused question return to Waiting on you, and a phone has no pane", async () => {
  const round = (n, q, state) => ({ n, q, url: `prototype-x${n}.html?q=${q}`, confirm: false, state });
  const board = { ...questionsBoard([openQuestion('q1', 'item:w/T1'), openQuestion('q2', 'item:w/P1', { url: 'prototype-x2.html?q=q2' })], []),
    items: [workCard('T1'), workCard('P1', { ref: '#287', questions: { topic: 'item:w/P1' }, prototypes: { open: true, rounds: [round(1, 'q0', 'resolved'), round(2, 'q2', 'open')] } })] };
  const wide = boardOnDom({ board, threads: {}, width: 1280 });
  const pane = wide.root.querySelector('#boardPane');
  assert.equal(wide.view.B.openViewer('prototype-x2.html?q=q2'), true, 'the pane opens it before the board loads');
  await wide.settle();
  const viewer = () => pane.querySelector('.pane-viewer');
  const frame = () => viewer().querySelector('iframe.pv-frame');
  assert.ok(pane.classList.contains('viewing'));
  assert.equal(frame().getAttribute('src'), 'prototype-x2.html?q=q2');
  const top = viewer().querySelector('.pv-top');
  assert.deepEqual([...top.children].map((el) => el.textContent.trim()), ['‹ Open questions', '', '⤢', 'Round 2 of 2 · earlier']);
  const tap = async (target) => { wide.page.fire(wide.root, 'click', { target }); await wide.settle(); };
  const widen = () => viewer().querySelector('[data-pv="widen"]');
  await tap(widen());
  assert.deepEqual([pane.classList.contains('widened'), widen().getAttribute('aria-pressed')], [true, 'true'], '⤢ widens the pane over the lanes');
  await tap(widen());
  assert.deepEqual([pane.classList.contains('widened'), widen().getAttribute('aria-pressed')], [false, 'false'], 'and back');
  await tap(viewer().querySelector('[data-ps-top="rounds"]'));
  assert.match(viewer().querySelector('.ps-sheet').textContent, /Rounds on #287/);
  await tap(viewer().querySelector('[data-ps-round="prototype-x1.html?q=q0"]'));
  assert.deepEqual([frame().getAttribute('src'), viewer().querySelector('.ps-sheet')], ['prototype-x1.html?q=q0', null], 'a round in the sheet opens in the same pane');
  await tap(viewer().querySelector('[data-ps-top="rounds"]'));
  await tap(viewer().querySelector('[data-ps-round="prototype-x2.html?q=q2"]'));
  await tap(viewer().querySelector('[data-pv="back"]'));
  const pill = (id) => pane.querySelector(`.pane-questions button[data-topic="${id}"]`);
  assert.deepEqual([viewer(), pane.classList.contains('viewing'), pill('item:w/P1').getAttribute('aria-pressed')], [null, false, 'true'], "‹ returns to Waiting on you with the round's question focused");
  wide.view.B.openViewer('prototype-x2.html?q=q2');
  await tap(widen());
  assert.equal(wide.view.B.focusQuestion('q1'), true);
  assert.deepEqual([viewer(), pane.classList.contains('viewing'), pane.classList.contains('widened'), pill('item:w/T1').getAttribute('aria-pressed')], [null, false, false, 'true'], 'Choose this, through the shell, does the same');
  const hashTo = async (hash) => { wide.page.win.location.hash = hash; wide.page.fire(vm.runInContext('window', wide.page.win), 'hashchange'); await wide.settle(); };
  wide.view.B.openViewer('prototype-x2.html?q=q2');
  await hashTo('#item=w%2FT1');
  assert.ok(viewer(), 'a task opened on the board leaves the viewer open');
  await hashTo('#item=w%2FP1&reply');
  assert.deepEqual([viewer(), pane.classList.contains('viewing')], [null, false], "a push to a task's thread closes the viewer, so the thread shows");
  wide.view.B.openViewer('prototype-x2.html?q=q2');
  await hashTo('#selectedCard=w%2FT1');
  assert.ok(viewer(), 'a #selectedCard= task without reply leaves the viewer open');
  await hashTo('#selectedCard=w%2FP1&reply');
  assert.deepEqual([viewer(), pane.classList.contains('viewing')], [null, false], 'a push writing #selectedCard=<key>&reply closes the viewer too');
  const narrow = boardOnDom({ board, threads: {} });
  await narrow.settle();
  assert.equal(narrow.view.B.openViewer('prototype-x2.html?q=q2'), false, 'a phone has no pane');
});

// docs/adr/2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md
test("at every width the board header's ? carries the queue's count as a badge, the rows the page lists (a topic with open questions, a tap), and opens Questions, whose ✓ goes back to the board; the bulb and gear sit at the foot of the board, never in the header", async () => {
  const queue = [{ kind: 'implement', key: 'w/T9', title: 'T9: Card', word: 'Implement', label: 'Tap Implement', fault: false, since: '2026-11-02T10:00:00.000Z', progress: false }];
  for (const width of [390, 1280]) {
    const b = boardOnDom({ board: questionsBoard([openQuestion('q1', 't1'), openQuestion('q2', 't1'), openQuestion('q3', 't2')], [], queue), threads: {}, width });
    await b.settle();
    const ask = b.root.querySelector('.top #questionsLink');
    assert.equal(ask.getAttribute('href'), 'questions.html');
    assert.deepEqual([ask.querySelector('.q-badge').hidden, ask.querySelector('.q-badge').textContent, ask.getAttribute('aria-label')], [false, '3', 'Open questions, 3 open'], 'two topics and one tap');
    assert.equal(b.root.querySelector('.top #archBulb'), null);
    assert.equal(b.root.querySelector('.top #settingsLink'), null);
    const foot = b.root.querySelector('main .board-foot');
    assert.ok(foot.querySelector('#archBulb'));
    assert.equal(foot.querySelector('#settingsLink').getAttribute('href'), 'settings.html');
    await b.change({ board: questionsBoard([]) });
    assert.deepEqual([ask.querySelector('.q-badge').hidden, ask.getAttribute('aria-label')], [true, 'Open questions']);
    const markup = b.page.win.AppViews.questions.markup();
    assert.match(markup, /<a class="ghost icon pages-switch back" href="\.\/" aria-label="Back to the board"[^>]*><svg/);
    assert.doesNotMatch(markup, /id="questionsLink"/);
    assert.doesNotMatch(b.page.win.AppViews.questions.markup({ embedded: true }), /pages-switch/);
    b.view.unmount();
  }
});

test("on a desktop, one click on a pill in the pane opens that topic's card on the board and scrolls to it, a topic with nothing on the board does nothing, and a phone has no pane", async () => {
  const board = { ...questionsBoard([openQuestion('q1', 'item:w/T1'), openQuestion('q3', 'item:w/T9')], []), items: [workCard('T1'), workCard('T2')] };
  const wide = boardOnDom({ board, threads: {}, width: 1280 });
  await wide.settle();
  const scrolled = [];
  wide.root.constructor.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.dataset.key || this.dataset.topic); };
  const dbl = async (id) => { const target = wide.root.querySelector(`#boardPane button[data-topic="${id}"]`); const slot = wide.root.querySelector('#boardPane .pane-questions'); wide.page.fire(slot, 'click', { target }); await wide.settle(); };
  await dbl('item:w/T1');
  assert.deepEqual([wide.page.win.location.hash, wide.root.querySelector('details.item[data-key="w/T1"]').open, scrolled.at(-1)], ['#selectedCard=w%2FT1', true, 'w/T1'], 'a task topic opens its task');
  scrolled.length = 0;
  await dbl('item:w/T9');
  assert.deepEqual([scrolled, wide.page.win.location.hash], [[], '#selectedCard=w%2FT1'], 'a topic with nothing on the board does nothing');
  const narrow = boardOnDom({ board, threads: {} });
  await narrow.settle();
  assert.equal(narrow.root.querySelector('#boardPane button[data-topic]'), null, 'a phone has no pane to double-click');
});

test("a topic or question arriving on Waiting on you inserts its pill or card in place, leaving the open topic's cards and the note being typed as they were", async () => {
  const question = (id, topic) => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  const topics = [{ id: 'item:w/T1', title: 'INT-1: Search' }, { id: 'item:w/T3', title: 'INT-3: Sort' }];
  const v = questionsOnDom({ topics, questions: [question('q1', 'item:w/T1'), question('q3', 'item:w/T3')], at: 'q1' });
  await v.settle();
  const card = v.root.querySelector('section.q[data-q="q1"]');
  const reload = async () => { v.page.fire(v.page.win.document, 'visibilitychange'); await v.settle(); };
  card.querySelector('textarea').value = 'half typed';

  topics.splice(1, 0, { id: 'item:w/T2', title: 'INT-2: Filter' });
  v.server.questions.push(question('q2', 'item:w/T2'));
  await reload();
  assert.deepEqual(v.shown().pills, [['item:w/T1', 'true'], ['item:w/T2', 'false'], ['item:w/T3', 'false']]);
  assert.equal(v.root.querySelector('section.q[data-q="q1"]'), card, 'the open topic did not repaint');
  assert.deepEqual(v.root.querySelectorAll('.topics button').map((b) => b.classList.contains('arrived')), [false, true, false], 'only the new pill slides in, then settles');
  assert.equal(v.root.querySelector('textarea').value, 'half typed', 'the note being typed stays');

  v.server.questions.push(question('q1b', 'item:w/T1'));
  await reload();
  assert.deepEqual(v.shown().questions, ['q1', 'q1b']);
  assert.equal(v.root.querySelector('section.q[data-q="q1"]'), card);
  assert.equal(v.root.querySelector('button[data-topic="item:w/T1"] .n').textContent, '2');
  assert.deepEqual(v.root.querySelector('#qform').children.map((c) => c.dataset.q || c.getAttribute('class')), ['q1', 'q1b', 'bar'], 'the new task goes after the last open one');
  v.unmount();
});

// docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md
test("Board settings' Sharing lists who can look and who was just refused, adds by a tap or a typed login, removes, and copies the board's link", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  const ago = (ms) => new Date(NOW - ms).toISOString();
  let sharing = { link: 'https://studio.tail1234.ts.net/orch/', people: [{ login: 'maya@github', name: 'Maya Ortiz', now: true, at: ago(1000) }, { login: 'sam@example.com', name: null, now: false, at: ago(2 * 86_400_000) }, { login: 'kim@github', name: 'Kim', now: false, at: null }],
    refused: [{ login: 'jo@github', name: 'Jo Park', at: ago(4 * 60_000) }, { login: 'lee@example.com', name: null, at: ago(10_000) }] };
  const posts = [];
  const copied = [];
  page.win.navigator.clipboard = { writeText: async (text) => { copied.push(text); } };
  page.win.fetch = async (url, opts = {}) => {
    let body = {};
    if (url === '/_hub/share/orch') body = sharing;
    if (url.endsWith('/api/share')) { posts.push(JSON.parse(opts.body)); body = { share: [] }; }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const view = page.win.AppViews.settings.create(root, '/orch', {});
  view.mount();
  await tick();
  const list = root.querySelector('#shareList');
  assert.match(list.innerHTML, /Maya Ortiz<span class="muted small sub">maya@github · <span class="share-now">viewing now<\/span><\/span>/);
  assert.match(list.innerHTML, /sam@example\.com<span class="muted small sub">2 d ago<\/span>/);
  assert.match(list.innerHTML, /Kim<span class="muted small sub">kim@github · not seen yet<\/span>/);
  assert.match(list.innerHTML, /data-share-remove="maya@github"[^>]*aria-label="Remove Maya Ortiz"/);
  const refused = root.querySelector('#shareRefused');
  assert.match(refused.innerHTML, /Jo Park<span class="muted small sub">jo@github · 4 min ago<\/span>[^]*data-share-add="jo@github"/);
  assert.match(refused.innerHTML, /lee@example\.com<span class="muted small sub">just now<\/span>/);

  const tap = async (id, attr, login) => { page.fire(root.querySelector(id), 'click', { target: { closest: (sel) => (sel.includes(attr) ? { dataset: { [attr === 'data-share-add' ? 'shareAdd' : 'shareRemove']: login } } : null) } }); await tick(); await tick(); };
  sharing = { ...sharing, people: [...sharing.people, { login: 'jo@github', name: 'Jo Park', now: false, at: null }], refused: sharing.refused.slice(1) };
  await tap('#shareRefused', 'data-share-add', 'jo@github');
  assert.deepEqual(posts.at(-1), { add: 'jo@github' });
  assert.match(list.innerHTML, /Jo Park/);
  assert.doesNotMatch(refused.innerHTML, /Jo Park/);
  await tap('#shareList', 'data-share-remove', 'kim@github');
  assert.deepEqual(posts.at(-1), { remove: 'kim@github' });
  root.querySelector('#shareLogin').value = '  new@github ';
  page.fire(root.querySelector('#shareAdd'), 'submit');
  await tick(); await tick();
  assert.deepEqual(posts.at(-1), { add: 'new@github' });
  assert.equal(root.querySelector('#shareLogin').value, '');
  page.fire(root.querySelector('#shareCopy'), 'click');
  await tick();
  assert.deepEqual([copied, root.querySelector('#shareStatus').textContent], [['https://studio.tail1234.ts.net/orch/'], 'Copied https://studio.tail1234.ts.net/orch/']);
  view.unmount();
});

test("Board settings' Sharing sits under Reviewers with one line to reach the host and Tailscale's Machines page", () => {
  const html = fakePage(memoryStorage().localStorage).win.AppViews.settings.markup({}, { siteTitle: 'Orch' });
  assert.ok(html.indexOf('<h2>Reviewers</h2>') < html.indexOf('<h2>Sharing</h2>') && html.indexOf('<h2>Sharing</h2>') < html.indexOf('<h2>Rules</h2>'));
  assert.match(html, /View, or Full: everything but Merge and Board settings\. Nothing else on the host opens for them\./);
  assert.match(html, /They also need the host shared to them in Tailscale \(<a href="https:\/\/login\.tailscale\.com\/admin\/machines" target="_blank" rel="noopener">Tailscale’s Machines page <svg[^>]*class="link-arrow"[^>]*>.*?<\/svg><\/a>\)\. Then send them this link\./);
  assert.doesNotMatch(html, /↗/);
  assert.match(html, /<button type="button" id="shareCopy">Copy link<\/button>/);
});

// docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md
test("Board settings' Sharing sets each person View or Full with one tap, saying what each level can do", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  let sharing = { link: null, people: [{ login: 'dana@github', name: 'Dana Reyes', level: 'full', now: true, at: null }, { login: 'sam@github', name: 'Sam', level: 'view', now: false, at: null }], refused: [] };
  const posts = [];
  page.win.fetch = async (url, opts = {}) => {
    let body = {};
    if (url === '/_hub/share/orch') body = sharing;
    if (url.endsWith('/api/share')) { posts.push(JSON.parse(opts.body)); body = { share: [] }; }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const view = page.win.AppViews.settings.create(root, '/orch', {});
  view.mount();
  await tick();
  const list = root.querySelector('#shareList');
  assert.match(list.innerHTML, /<span role="group" class="share-level" aria-label="Dana Reyes’s access"><button type="button" data-share-level="view" data-login="dana@github" aria-pressed="false">View<\/button><button type="button" data-share-level="full" data-login="dana@github" aria-pressed="true">Full<\/button><\/span>/);
  assert.match(list.innerHTML, /Answers, taps task buttons and adds New tasks\. Merge and Board settings stay yours\./);
  assert.match(list.innerHTML, /data-share-level="view" data-login="sam@github" aria-pressed="true"/);
  assert.match(list.innerHTML, /Looks only\. Visit links open\./);
  sharing = { ...sharing, people: sharing.people.map((p) => (p.login === 'sam@github' ? { ...p, level: 'full' } : p)) };
  page.fire(list, 'click', { target: { closest: (sel) => (sel.includes('data-share-level') ? { dataset: { shareLevel: 'full', login: 'sam@github' } } : null) } });
  await tick(); await tick();
  assert.deepEqual(posts.at(-1), { login: 'sam@github', level: 'full' });
  assert.match(list.innerHTML, /data-share-level="full" data-login="sam@github" aria-pressed="true"/);
  view.unmount();
});

test("a Full person's board opens with a Full strip saying Merge and Board settings are the owner's", () => {
  const { BoardView } = fakePage(memoryStorage().localStorage).win;
  assert.match(BoardView.markup({ title: 'Orch', shared: { by: 'Love', full: true } }), /<p class="view-only-strip"><b>Full\.<\/b> Shared with you by Love\. You can answer and act\. Merge and Board settings are Love’s\.<\/p>/);
  assert.match(BoardView.markup({ title: 'Orch', shared: { by: null, full: true } }), /<b>Full\.<\/b> Shared with you\. You can answer and act\. Merge and Board settings are the owner’s\./);
});

test("the shell marks a board someone has Full on, follows a level change on the stream, and hides Board settings and disables Merge at every level", async () => {
  const sources = [];
  class EventSource {
    static CLOSED = 2;
    constructor() { this.readyState = 1; this.listeners = new Map(); sources.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    close() { this.readyState = EventSource.CLOSED; }
  }
  const sites = [{ route: 'shop', title: 'The Shop', board: true, icon: '' }, { route: 'other', title: 'Other', board: true, icon: '' }];
  const { win, doc } = await shellPage('/shop/', { sidebarData: { sites, shared: { by: 'Love', full: ['shop'] } }, EventSource, fetch: () => new Promise(() => {}) });
  const html = doc.documentElement;
  const strip = () => doc.querySelector('.view-only-strip').textContent;
  assert.deepEqual([html.classList.contains('shared-view'), html.classList.contains('shared-full')], [true, true]);
  assert.match(strip(), /^Full\./);
  win.AppShell.open('/other/');
  assert.deepEqual([html.classList.contains('shared-view'), html.classList.contains('shared-full')], [true, false]);
  assert.match(strip(), /^View only\./);
  win.AppShell.open('/shop/');
  sources[0].listeners.get('sidebar')({ data: JSON.stringify({ sites, shared: { by: 'Love', full: [] } }) });
  assert.equal(html.classList.contains('shared-full'), false);
  assert.match(strip(), /^View only\./);

  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.shared-view:not\(\.shared-full\) :is\(#compose, \[data-composer\], \.actions button, button\[data-confirm\]\) \{ display: none !important; \}/);
  assert.match(css, /\.shared-view :is\(#settingsLink, #archBulb\) \{ display: none !important; \}/);
  assert.match(css, /\.shared-full button\[data-confirm="merge"\] \{[^}]*pointer-events: none;/);
});

test("a shared person's board opens with a View only strip naming who shared it", () => {
  const { BoardView } = fakePage(memoryStorage().localStorage).win;
  assert.match(BoardView.markup({ title: 'Orch', shared: { by: 'Love <K>' } }), /<main>\s*<p class="view-only-strip"><b>View only\.<\/b> Shared with you by Love &lt;K&gt;\. You can look and open Visit links\.<\/p>/);
  assert.match(BoardView.markup({ title: 'Orch', shared: { by: null } }), /<b>View only\.<\/b> Shared with you\. You can look and open Visit links\./);
  assert.doesNotMatch(BoardView.markup({ title: 'Orch' }), /view-only-strip/);
});

test("a shared person's tap on an asleep board never asks the hub to wake the owner's session", async () => {
  const checks = { at: '2026-10-30T10:00:00.000Z', every: 30, late: false, watcher: 'asleep', claudeAt: null };
  const b = boardOnDom({ board: { ...boardOf([workCard('A1')]), checks }, threads: {} });
  await b.settle();
  b.page.win.document.documentElement.classList.add('shared-view');
  b.page.fire(b.root, 'click', { target: b.root.querySelector('.lane') });
  assert.deepEqual(b.posts.filter(([p]) => p === '/_hub/wake'), []);
  b.view.unmount();
});

// docs/adr/2026-11-05-2330-the-plus-lives-on-the-board-pane.md
test("the + is on the board's left pane on desktop and gone from the Open questions page", async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('./public/shell.js', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /BoardNewTask/);
  assert.doesNotMatch(css, /view-questions[^{]*\.fab/);
  assert.match(css, /@media \(min-width: 900px\) \{[^@]*\.view-board \.fab \{ right: calc\(var\(--pane-w, calc\(50% /);
});

test("a card's workflow buttons run quiet first: Hold, Notes, Serve, then Questions, then Merge", async () => {
  const ready = { state: 'OPEN', isDraft: false, number: 7, url: 'https://github.com/o/r/pull/7', checks: { state: 'pass' } };
  const full = {
    lane: 'review', holdable: true, hasNotes: true, pr: ready, try: { kind: 'web', script: true, changes: true },
    action: { kind: 'merge', url: '#selectedCard=w%2FM1', label: 'Merge' }, resolvedBy: 'merge',
  };
  const cards = [
    workCard('F1', { ...full, actionButton: 'openQuestions', questions: { first: 'q7', open: 1, state: 'open' } }),
    workCard('F2', { ...full, actionButton: null }),
    workCard('F3', { ...full, actionButton: 'openQuestions', questions: { first: 'q7', open: 1, state: 'open' }, prototypes: { open: false, rounds: [{ n: 1, q: 'q6', url: 'prototype-x.html?q=q6', confirm: false, state: 'resolved' }] } }),
  ];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: {}, confirm: true });
  await b.settle();
  const order = (key) => b.root.querySelector(`details.item[data-key="${key}"] .action-row.workflow`).querySelectorAll('a, button').map((el) => el.textContent.trim());
  assert.deepEqual(order('w/F1'), ['Hold', 'Notes', 'Serve', 'Questions', 'Merge']);
  assert.deepEqual(order('w/F2'), ['Hold', 'Notes', 'Serve', 'Merge']);
  assert.deepEqual(order('w/F3'), ['Hold', 'Notes', 'Serve', 'Questions', 'Merge']);
});

// docs/adr/2026-11-09-1100-needs-you-button-reaches-the-prototypes.md
test("a card with prototypes has no Prototypes button: its Questions button opens its questions page, solid orange while a round waits on the owner's pick", async () => {
  const round = (n, q, state) => ({ n, q, url: `prototype-x${n}.html?q=${q}`, confirm: false, state });
  const cards = [
    workCard('P1', { actionButton: 'openQuestions', questions: { first: 'q2', open: 1, state: 'open' }, action: { kind: 'pick', url: 'questions.html#q2', label: 'Prototypes ready: pick a take' }, resolvedBy: 'openQuestions',
      prototypes: { open: true, rounds: [round(1, 'q1', 'resolved'), round(2, 'q2', 'open')] } }),
    workCard('P3', { actionButton: 'openQuestions', lane: 'done', questions: { first: 'q1', open: 0, state: 'resolved' }, prototypes: { open: false, rounds: [round(1, 'q1', 'resolved')] } }),
  ];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: {} });
  await b.settle();
  const buttons = (key) => [...b.root.querySelectorAll(`details.item[data-key="${key}"] .action-row.workflow a`)];
  assert.deepEqual(buttons('w/P1').map((a) => a.textContent.trim()), ['Questions']);
  assert.equal(buttons('w/P1')[0].getAttribute('href'), 'questions.html#q2');
  assert.equal(buttons('w/P1')[0].getAttribute('class'), 'button resolves');
  assert.deepEqual(buttons('w/P3').map((a) => [a.textContent.trim(), a.getAttribute('href')]), [['Questions', 'questions.html#q1']]);
  b.view.unmount();
});

test("a card the reader closes stays closed through a repaint that changed its summary text", () => {
  const page = fakePage(memoryStorage().localStorage);
  const { Element } = miniDom(page.Target, page.win.document);
  const { setHTML } = page.win.BoardUI;
  const root = page.win.document.body.appendChild(new Element('div'));
  const card = (ago, open) => `<details class="item" data-key="w/T1"${open ? ' open' : ''}><summary>Card · ${ago}</summary><p>body</p></details>`;
  const el = () => root.querySelector('details.item');
  const toggle = (open) => { el().open = open; page.fire(page.win.document, 'toggle', { target: el() }); };
  setHTML(root, card('1m ago', false));
  toggle(true);
  setHTML(root, card('1m ago', false));
  assert.equal(el().open, true);
  setHTML(root, card('2m ago', true));
  toggle(false);
  setHTML(root, card('3m ago', false));
  setHTML(root, card('1m ago', false));
  assert.equal(el().open, false);
});

// docs/adr/2026-11-11-1400-one-selected-look-no-yellow-fill.md
test('an In Progress pill is a faint orange tint, and every selected option and pill draws the one blue selected look', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const lines = css.split('\n');
  const rule = (sel) => lines.find((l) => l.startsWith(`${sel} {`));
  assert.match(rule('.view-questions .topics button.progress'), /border-color: var\(--line\); background: color-mix\(in srgb, var\(--color-notice\) 12%, var\(--panel\)\)/);
  assert.match(css, /--sel-bg: var\(--accent-soft\); --sel-line: var\(--accent\)/);
  for (const sel of ['.view-questions .opt:has(input:checked)', '.view-questions .topics button[aria-pressed="true"]', '.view-questions .topics button.progress[aria-pressed="true"]']) {
    assert.match(rule(sel), /border-color: var\(--sel-line\); background: var\(--sel-bg\)/, sel);
    assert.doesNotMatch(rule(sel), /color-notice|color: #000/, sel);
  }
});

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
test("the thread's image button, after the eye and fire and before attach, asks for a visual at once, with the typed text if any, as /visual does on Reply", async () => {
  const b = boardOnDom({ open: ['w/A1'], board: boardOf([workCard('A1')]), threads: { 'w/A1': [] } });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/A1"]');
  const image = () => form().querySelector('button[data-visual]');
  const box = () => form().querySelector('textarea');
  const icons = [...form().querySelector('.icons').children];
  assert.equal(icons.at(-2), image(), 'the image follows the eye and fire');
  assert.ok(icons.at(-1).matches('label.attach'), 'attach follows the image');
  assert.equal(image().getAttribute('aria-label'), 'Ask for a visual');
  assert.match(box().getAttribute('placeholder'), /\/prototype, \/grill or \/visual asks for one/);
  const tap = async (text = '') => { box().value = text; b.page.fire(b.root, 'click', { target: image() }); await b.settle(); };
  await tap();
  await tap('Draw the land queue');
  box().value = '/visual Compare the two takes';
  b.page.fire(b.root, 'submit', { target: form(), submitter: form().querySelector('button[data-nth="0"]') });
  await b.settle();
  assert.deepEqual(sentNoIds(b), [
    ['visual-request', { key: 'w/A1' }], ['visual-request', { key: 'w/A1', text: 'Draw the land queue' }], ['visual-request', { key: 'w/A1', text: 'Compare the two takes' }],
  ]);
  b.view.unmount();
});

test('a resolved question card has no border or tint of its own; the Resolved badge alone marks it', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.q\.resolved\s*\{/, 'no rule styles the resolved task itself');
});

// docs/adr/2026-11-12-0600-the-todo-header-has-a-filter.md
test('the Todo header filter lists five boxes, all checked; unchecking one hides only the cards with that property, the icon goes orange and the count reads N of M', async () => {
  const cards = [
    workCard('R1', { phase: 'ready', ready: true }), workCard('R2', { phase: 'staging' }), workCard('D1', { phase: 'discussing', turn: 'owner' }), workCard('D2', { phase: 'new' }),
    workCard('P1', { phase: 'grilling' }), workCard('P2', { phase: 'prototyping' }), workCard('B1', { phase: 'ready', blocked: true }), workCard('H1', { phase: 'grilling', held: true }),
    workCard('HB', { phase: 'ready', held: true, blocked: true })];
  const b = boardOnDom({ board: boardOf(cards), threads: {} });
  await b.settle();
  const todo = () => b.root.querySelector('details.lane[data-lane="todo"]');
  const keys = () => todo().querySelectorAll('details.item').map((el) => el.dataset.key.slice(2));
  const btn = () => todo().querySelector('button.lane-filter');
  const box = (name) => todo().querySelector(`[data-todo-filter="${name}"]`);
  const tap = async (el) => { b.page.fire(b.root, 'click', { target: el }); await b.settle(); };
  assert.equal(keys().length, 9);
  assert.equal(todo().querySelector('summary .count').textContent, '9');
  assert.ok(!btn().classList.contains('on'));
  assert.equal(todo().querySelector('.lane-filter-menu'), null);
  await tap(btn());
  assert.deepEqual(todo().querySelectorAll('[data-todo-filter]').map((el) => [el.dataset.todoFilter, el.getAttribute('aria-checked')]),
    [['ready', 'true'], ['discussing', 'true'], ['planning', 'true'], ['blocked', 'true'], ['held', 'true']]);
  assert.equal(todo().open, true);
  await tap(box('held'));
  assert.deepEqual(keys(), ['R1', 'R2', 'D1', 'D2', 'P1', 'P2', 'B1']);
  assert.ok(btn().classList.contains('on'));
  assert.equal(todo().querySelector('summary .count').textContent, '7 of 9');
  await tap(box('blocked'));
  assert.deepEqual(keys(), ['R1', 'R2', 'D1', 'D2', 'P1', 'P2']);
  await tap(box('held')); await tap(box('blocked'));
  await tap(box('ready'));
  assert.deepEqual(keys(), ['D1', 'D2', 'P1', 'P2', 'H1']);
  await tap(box('ready')); await tap(box('discussing'));
  assert.deepEqual(keys(), ['R1', 'R2', 'P1', 'P2', 'B1', 'H1', 'HB']);
  await tap(box('discussing')); await tap(box('planning'));
  assert.deepEqual(keys(), ['R1', 'R2', 'D1', 'D2', 'B1', 'HB']);
  await tap(box('planning'));
  assert.equal(keys().length, 9);
  assert.ok(!btn().classList.contains('on'));
  assert.equal(todo().querySelector('summary .count').textContent, '9');
});

test('the Todo filter is remembered on this device', async () => {
  const cards = [workCard('R1', { phase: 'ready', ready: true }), workCard('H1', { phase: 'grilling', held: true })];
  const first = boardOnDom({ board: boardOf(cards), threads: {} });
  await first.settle();
  first.page.fire(first.root, 'click', { target: first.root.querySelector('button.lane-filter') }); await first.settle();
  first.page.fire(first.root, 'click', { target: first.root.querySelector('[data-todo-filter="held"]') }); await first.settle();
  const again = boardOnDom({ board: boardOf(cards), threads: {}, stored: [...first.storage] });
  await again.settle();
  assert.deepEqual(again.root.querySelectorAll('details.lane[data-lane="todo"] details.item').map((el) => el.dataset.key), ['w/R1']);
  assert.ok(again.root.querySelector('button.lane-filter').classList.contains('on'));
});

test('a project made with New project… lands A–Z among the team’s projects, with New project… last', async () => {
  const page = repoPage(true);
  const root = page.doc.body.appendChild(new page.Element('div'));
  const control = page.win.BoardDialogs.ticketsControl(root, { value: { source: 'none' }, title: () => 'beta',
    loadLinear: async () => ({ set: true, workspace: 'Acme', url_key: 'acme', teams: [{ key: 'ENG', name: 'Engineering' }], projects: [{ team: 'ENG', id: 'p1', name: 'Alpha' }, { team: 'ENG', id: 'p2', name: 'Zed' }] }),
    createProject: async (team, name) => ({ id: 'p3', name, team }), change: () => {} });
  page.fire(root, 'click', { target: root.querySelector('[data-tk-source="linear"]') });
  await tick();
  const project = root.querySelector('[data-tk="project"]');
  project.value = '__new'; page.fire(root, 'change', { target: project });
  page.fire(root, 'click', { target: root.querySelector('[data-tk-create]') });
  await tick();
  assert.deepEqual([...root.querySelector('[data-tk="project"]').querySelectorAll('option')].map((o) => o.textContent), ['Alpha', 'beta', 'Zed', 'New project…']);
  control.destroy();
});

// docs/adr/2026-11-14-2330-the-questions-page-is-one-queue-of-what-the-badge-counts.md
test("Waiting on you is one queue: question pills and tap rows in the board's order, a count that is the rows, Implement and Done tapped in place, the rest opening the card", async () => {
  const question = (id, topic) => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }], answers: [], state: 'open' });
  const tap = (kind, key, word, more = {}) => ({ kind, key, title: `${key.split('/')[1]}: Card`, word, label: `Tap ${word}`, fault: false, since: '2026-11-02T10:00:00.000Z', progress: false, ...more });
  const queue = [tap('implement', 'w/T2', 'Implement'), { kind: 'question', id: 'item:w/T1', since: '2026-11-03T10:00:00.000Z' }, tap('done', 'w/T4', 'Done'),
    tap('action', 'w/T5', 'Action', { label: 'stalled: tests fail', fault: true })];
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'T1: Search' }], questions: [question('q1', 'item:w/T1')], at: 'q1', queue });
  const confirms = [];
  v.page.win.BoardDialogs.confirm = async (text) => { confirms.push(text); return true; };
  await v.settle();
  const order = () => v.root.querySelectorAll('.topics > *').map((n) => n.dataset.tap || n.dataset.topic);
  assert.deepEqual(order(), ['w/T2', 'item:w/T1', 'w/T4', 'w/T5'], 'questions and taps interleave in the board order');
  assert.equal(v.root.querySelector('.q-count').textContent, `${queue.length} need you`, 'the count is the rows');
  assert.equal(v.root.querySelector('.tap[data-tap="w/T5"]').classList.contains('fault'), true);
  assert.deepEqual(v.root.querySelectorAll('.tap button').map((b) => b.textContent), ['Implement', 'Done', 'Open']);

  v.page.fire(v.root, 'click', { target: v.root.querySelector('.tap[data-tap="w/T2"] button') });
  await v.settle();
  assert.deepEqual([confirms, JSON.parse(JSON.stringify(v.sent))], [['Implement T2?'], [['card-build', { key: 'w/T2' }]]]);
  assert.deepEqual(order(), ['item:w/T1', 'w/T4', 'w/T5'], 'the recorded tap leaves the queue');
  assert.equal(v.root.querySelector('.q-count').textContent, '3 need you');

  v.page.fire(v.root, 'click', { target: v.root.querySelector('.tap[data-tap="w/T4"] button') });
  await v.settle();
  assert.deepEqual([confirms.at(-1), v.sent.at(-1)[0]], ['Mark done T4?', 'card-done']);
  v.unmount();
});

test('Waiting on you with only taps shows the queue and no form, and with nothing the moon', async () => {
  const queue = [{ kind: 'implement', key: 'w/T2', title: 'T2: Card', word: 'Implement', label: 'Tap Implement', fault: false, since: '2026-11-02T10:00:00.000Z', progress: false }];
  const v = questionsOnDom({ topics: [], questions: [], at: '', queue });
  await v.settle();
  assert.deepEqual([v.root.querySelectorAll('.tap').length, v.root.querySelector('#qform'), v.root.querySelector('.q-empty')], [1, null, null]);
  v.unmount();
  const none = questionsOnDom({ topics: [], questions: [], at: '' });
  await none.settle();
  assert.ok(none.root.querySelector('.q-empty'));
  none.unmount();
});
