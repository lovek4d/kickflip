import { web, write, inProcessHub } from '../hub/hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import path from 'node:path';
import { fixedDate } from '../shared/fixed-clock.mjs';
import { miniDom } from './mini-dom.mjs';
import { footerOf, buildBoard, slimDone, BUTTON, ACTION_KIND } from './domain.mjs';
import { freshSync, stamp, patchSince } from './sync.mjs';
import { transcriptChunk } from './transcript.mjs';

// The patch the server sends a page holding from once the board reads to, as board/sync.mjs makes it, between the
// versions the two boards name. threads, {from, to}, are the cards' threads beside each board.
function boardPatch(from, to, threads = { from: {}, to: {} }, notes = { from: {}, to: {} }) {
  const map = (t) => new Map(Object.entries(t));
  // Every card's notes, null for none, as board/server.mjs buildPageBoard stamps them.
  const notesOf = (board, n) => new Map(board.items.map((i) => [i.key, n[i.key] ?? null]));
  const held = stamp(freshSync(0), from, map(threads.from), notesOf(from, notes.from));
  const now = stamp(held.sync, to, map(threads.to), notesOf(to, notes.to));
  return { ...patchSince(now.sync, now.board, held.sync.n, map(threads.to), notesOf(to, notes.to)), since: from.version, version: to.version };
}

const SCRIPTS = ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-order.js', 'ui-selection.js', 'ui-patch.js', 'ui-threads.js', 'ui-cards.js', 'ui-header.js', 'ui-snapshot.js', 'ui-page-header.js', 'ui-icon-text.js', 'ui-waits.js', 'ui-sidebar.js', 'ui-questions.js', 'ui-prompts.js', 'ui-markdown.js', 'ui-hub.js', 'prompts.js', 'rules-editor.js',
  'dialogs.js', 'hub-kit.js', 'linear-key.js', 'slack-emoji.js', 'sidebar.js', 'toasts.js', 'popup.js', 'drafts.js', 'app.js', 'new-task.js', 'app-core.js', 'app-threads.js', 'app-cards.js', 'app-lanes.js', 'app-asks.js', 'app-search.js', 'app-pane.js', 'app-selection.js', 'app-header.js', 'app-arch.js', 'app-waits.js', 'app-reader.js', 'app-questions-sheet.js', 'app-lightbox.js', 'app-banner.js', 'app-snapshot.js',
  'view-settings.js', 'view-notes.js', 'view-hub.js', 'view-hub-settings.js', 'view-frame.js', 'router.js'];

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
    // An Event a page script made and sends itself, such as the sheet stack's cancel and sheet-return (ui.js).
    dispatchEvent(e) {
      for (const l of listeners.filter((x) => x.target === this && x.type === e.type)) l.fn(e);
      return !e.defaultPrevented;
    }
  }
  class El extends Target {
    constructor() {
      super();
      Object.assign(this, { value: '', hidden: false, innerHTML: '', open: false, disabled: false, dataset: {}, attrs: {}, classes: new Set(), els: new Map(), style: { setProperty() {}, removeProperty() {} } });
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
    showPopover() {}
    hidePopover() {}
    insertAdjacentHTML() {}
    contains() { return false; }
    closest() { return null; }
    matches() { return false; }
    focus() {}
    blur() {}
    showModal() { this.open = true; this.modal = true; }
    show() { this.open = true; this.modal = false; }
    close() {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new Event('close'));
    }
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
  // resized() runs every live ResizeObserver's callback, as the browser does after a layout that changed a size.
  class ResizeObserver extends MutationObserver { constructor(fn) { super(); this.fn = fn; } }
  const resized = () => { for (const o of [...observers]) if (o instanceof ResizeObserver) o.fn([]); };
  const win = Object.assign(new Target(), {
    Date: fixedDate(() => NOW + now), URL, URLSearchParams, AbortController, Event, localStorage, document, CSS: { escape: (s) => s }, navigator: { platform: 'MacIntel' },
    location: { hostname: 'mac.ts.net', href: 'https://mac.ts.net/', hash: '', pathname: '/', search: '' }, history: { state: null, replaceState(_state, _title, url) { win.location.hash = url?.includes('#') ? url.slice(url.indexOf('#')) : ''; }, pushState(state) { this.state = state; }, back() {} }, innerHeight: 844,
    scrollX: 0, scrollY: 0, scrollTo(x, y) { win.scrollX = x; win.scrollY = y; },
    visualViewport: Object.assign(new Target(), { height: 844, offsetTop: 0, width: 390, offsetLeft: 0 }),
    getComputedStyle: () => ({ scrollMarginTop: '8px', scrollMarginRight: '8px', scrollMarginBottom: '8px', scrollMarginLeft: '8px' }),
    matchMedia: (query) => Object.assign(new Target(), { matches: query === '(min-width: 900px)' && win.innerWidth >= 900 }), MutationObserver, ResizeObserver,
    performance: { now: () => now },
    requestAnimationFrame: (fn) => { frames.set(++ids, fn); return ids; },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: () => new Promise(() => {}),
    setInterval: (fn, ms) => { intervals.set(++ids, { fn, ms }); return ids; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++ids, { fn, ms }); return ids; },
    clearTimeout: (id) => timeouts.delete(id),
    BoardDialogs: { confirm: async () => false, notice: async () => {} },
    // attach.js's surface, idle; boxesOn fakes its boxes for a test. onChange keeps its listeners, which tell calls.
    BoardAttach: (() => {
      const heard = [];
      return { files: () => [], busy: () => false, settled: async () => true, restore() {}, clear() {}, paint() {}, paintAll() {}, list: () => [], move() {}, saved: () => [], retryFailed() {},
        onChange(fn) { heard.push(fn); return () => heard.splice(heard.indexOf(fn), 1); }, tell: (id) => heard.forEach((fn) => fn(id)) };
    })(),
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
  return { win, El, Target, fire, left, advance, runTimers, runIntervals, resized, listenerCount: (target) => listeners.filter((l) => l.target === target).length };
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
  assert.deepEqual([mounted.watches, subscribed.size], [0, 1], 'the change signal, and no events watch');

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
  assert.match(page.win.BoardView.markup({ title: 'Shop' }), /<h1><button [^>]*id="boardMenuOpen"[^>]*>Shop<\/button><\/h1><span class="away-moon" role="img" aria-label="Away" aria-hidden="true"><svg/);
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
// docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md
test('offline, the board stays readable with no toast and nothing held: the header time turns red, refresh retries, Settings still opens, and a tap reads waiting for the host until the link is back, when it goes out on its own', async () => {
  const T1 = workCard('T1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 0 });
  const T2 = workCard('T2', { bumpable: true, sortAt: '2026-10-02T00:00:00.000Z', order: 1 });
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([T1, T2]), threads: { 'w/T1': [] } });
  await b.settle();
  const { B } = b.view;
  let retries = 0;
  const load = B.loadBoard;
  B.loadBoard = async () => { retries++; };
  B.linkDown();
  assert.deepEqual([b.root.querySelectorAll('.toast').length, b.root.classList.contains('offline'), B.state.link], [0, true, 'offline']);
  assert.match(b.root.querySelector('#status').innerHTML, /class="fresh" title="Offline: can't reach the host/);
  b.page.fire(b.root.querySelector('#boardMenuOpen'), 'click', { target: b.root.querySelector('#boardMenuOpen') });
  assert.equal(b.root.querySelector('#boardMenu #settingsLink').getAttribute('aria-disabled'), null, 'Settings stays live offline');
  const bump = bumpItem(b, 'w/T1');
  assert.equal(b.page.fire(b.root, 'click', { target: bump }).defaultPrevented, true, 'the bump is taken, not held');
  const form = b.root.querySelector('form[data-reply="w/T1"]');
  form.querySelector('textarea').value = 'While away';
  b.page.fire(b.root, 'submit', { target: form, submitter: form.querySelector('button[data-intent="reply"]') });
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T1'), ['Moved to the top · waiting for the host', 'While away (waiting for the host)']);
  assert.deepEqual([b.sent, b.root.querySelectorAll('[data-resend]').length], [[], 0], 'nothing sends and nothing asks for Retry');
  const refresh = b.root.querySelector('#refresh');
  assert.equal(refresh.disabled, false);
  b.page.fire(refresh, 'click');
  assert.equal(retries, 1);
  B.loadBoard = load;
  B.linkUp();
  await b.settle();
  assert.deepEqual(sentNoIds(b).map(([k]) => k).sort(), ['card-bump', 'item-message']);
  b.view.unmount();
});

test("a send that gets no answer at all marks the board out of reach and its tap waits for the host, holding the ones behind it, never reading not sent; one with no answer in 15 s reads not sent with Retry", async () => {
  const unreachable = () => Promise.reject(Object.assign(new TypeError('Failed to fetch'), { unreachable: true }));
  let send = unreachable;
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: (...args) => send(...args) });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/T1"]');
  const reply = async (text) => { form().querySelector('textarea').value = text; b.page.fire(b.root, 'submit', { target: form(), submitter: form().querySelector('button[data-intent="reply"]') }); await b.settle(); };
  await reply('First');
  await reply('Second');
  assert.equal(b.view.B.state.link, 'offline');
  assert.deepEqual([threadLines(b, 'w/T1'), b.sent.length], [['First (waiting for the host)', 'Second (waiting for the host)'], 1]);

  send = () => new Promise(() => {});
  b.view.B.linkUp();
  await b.settle();
  assert.deepEqual([threadLines(b, 'w/T1'), b.sent.length], [['First (sending…)', 'Second (sending…)'], 2], 'the link back sends the first again, with no Retry');
  b.page.runTimers(14_999);
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T1'), ['First (sending…)', 'Second (sending…)']);
  b.page.runTimers(15_000);
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T1'), ['First (not sent)', 'Second (sending…)']);
  assert.ok(b.root.querySelector('[data-thread="w/T1"] button[data-resend]'));
  b.view.unmount();
});

test("the board's Settings and Notes views, mounted then unmounted, leave no listener, interval, timer or watch behind, and stop retrying a load", async () => {
  const page = fakePage(memoryStorage().localStorage);
  let fetches = 0;
  page.win.fetch = () => { fetches++; return Promise.reject(new Error('offline')); };
  const loaded = page.left();
  const views = page.win.AppViews;
  assert.deepEqual(Object.keys(views).sort(), ['frame', 'hub', 'notes', 'settings']);
  for (const [kind, view] of [['settings', {}], ['notes', { item: 'w/A1' }]]) {
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
// into it, or answers s.refuse while that holds an error. Other URLs answer from routes by their ending. The board's
// rules events answer s.rules, each read counted in s.rulesReads; ctx goes to the view.
// dom: a mini-dom.mjs root that parses what the view draws, for a test that reads inside it.
function settingsPage({ settings = {}, board = {}, routes = {}, ctx = {}, dom = false } = {}) {
  const page = fakePage(memoryStorage().localStorage);
  const Element = dom && miniDom(page.Target, page.win.document).Element;
  const root = dom ? page.win.document.body.appendChild(new Element('div')) : new page.El();
  const s = { page, root, posts: [], confirms: [], refuse: '', saved: { ...settings }, rules: [], rulesReads: 0,
    descriptionPosts: [], description: { description: 'Sells shoes', source: 'new-board', at: '2026-11-12T12:00:00' } };
  const site = page.win.ClaudeSite.site;
  page.win.ClaudeSite.site = (r) => ({ ...site(r), events: async (opts) => { if (opts?.kind !== 'rules') return []; s.rulesReads++; return structuredClone(s.rules); } });
  page.win.BoardDialogs.confirm = async (text) => { s.confirms.push(text); return true; };
  page.win.fetch = async (url, opts = {}) => {
    let body = url.endsWith('/api/board') ? board : Object.entries(routes).find(([end]) => url.endsWith(end))?.[1] ?? {};
    if (url.endsWith('/api/description')) {
      if (opts.method === 'POST') {
        s.descriptionPosts.push(JSON.parse(opts.body));
        if (s.refuse) return { ok: false, status: 400, text: async () => JSON.stringify({ error: s.refuse }), json: async () => ({ error: s.refuse }) };
        s.description = { description: JSON.parse(opts.body).description, source: 'settings', at: '2026-11-16T12:00:00' };
      }
      body = s.description;
    }
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
  if (dom) root.innerHTML = page.win.AppViews.settings.markup({}, {});
  s.view = page.win.AppViews.settings.create(s.root, '/orch', ctx);
  s.mount = async () => { s.view.mount(); await tick(); return s; };
  s.set = async (el, value, field = 'value') => { el[field] = value; page.fire(el, 'change'); await tick(); };
  return s;
}

// docs/adr/2026-11-15-1921-the-browsers-polls-ride-the-change-stream.md
test("Board Settings reads Claude's replies to a rules change when it opens and on each of its board's change signals, never on a timer", async () => {
  let signalled = null;
  const s = await settingsPage({ ctx: { signal: (fn) => { signalled = fn; return () => { signalled = null; }; } } }).mount();
  const replies = () => s.root.querySelector('#rulesReplies').innerHTML;
  assert.equal(s.rulesReads, 1);
  assert.equal(s.page.left().watches, 0, 'no events watch');
  s.rules = [{ id: 'r1', kind: 'rules', reply: null }];
  signalled();
  await tick();
  assert.deepEqual([s.rulesReads, /Waiting for Claude/.test(replies())], [2, true]);
  for (const ms of [5000, 10000, 15000, 30000, 60000]) s.page.runIntervals(ms);
  s.page.runTimers();
  await tick();
  assert.equal(s.rulesReads, 2, 'no timer reads the replies');
  s.rules = [{ id: 'r1', kind: 'rules', reply: { html: '<p>Noted.</p>' } }];
  signalled();
  await tick();
  assert.match(replies(), /Noted\./);
  s.view.unmount();
  assert.equal(signalled, null, 'closing lets go of the signal');
});

// docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md, docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md,
// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
for (const [key, id] of [['auto_build', 'autoBuild'],['auto_review', 'autoReview'], ['idle_notification', 'idleNotification']]) {
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

// docs/adr/2026-11-14-1500-a-tool-use-setting-sets-how-readily-the-orchestrator-uses-tools.md
test('Board Settings reads Tool use from the saved setting, saves a tap at once, and keeps the saved level on refusal', async () => {
  const s = await settingsPage({ settings: { tool_use: 'normal' } }).mount();
  const button = (level) => s.root.querySelector(`[data-tool-use="${level}"]`), sub = s.root.querySelector('#toolUseSub');
  const pressed = () => ['normal', 'high'].map((level) => button(level).getAttribute('aria-pressed'));
  assert.deepEqual(pressed(), ['true', 'false']);
  const normalSub = sub.textContent;
  s.page.fire(button('high'), 'click');
  await tick();
  assert.deepEqual([pressed(), s.posts.at(-1), s.confirms], [['false', 'true'], { tool_use: 'high' }, []]);
  assert.notEqual(sub.textContent, normalSub, 'the help line follows the level');
  s.refuse = 'Cannot save';
  s.page.fire(button('normal'), 'click');
  await tick();
  assert.deepEqual([pressed(), s.root.querySelector('#toolUseStatus').textContent], [['false', 'true'], 'Cannot save']);
  s.view.unmount();
  const high = await settingsPage({ settings: { tool_use: 'high' } }).mount();
  assert.deepEqual(['normal', 'high'].map((level) => high.root.querySelector(`[data-tool-use="${level}"]`).getAttribute('aria-pressed')), ['false', 'true']);
  high.view.unmount();
});

// docs/adr/2026-11-16-2000-board-settings-edits-the-boards-description.md
test("Board Settings' Description textarea shows the saved text and how it was set, saves on blur and says how, reverts an emptied value, and sends nothing for an unchanged one", async () => {
  const s = settingsPage({ dom: true });
  await s.mount();
  const box = s.root.querySelector('#boardDescription');
  const source = () => s.root.querySelector('#boardDescriptionSource').textContent;
  const status = () => s.root.querySelector('#boardDescriptionStatus').textContent;
  const blur = async () => { s.page.fire(box, 'blur'); await tick(); };
  assert.deepEqual([box.value, box.disabled, source()], ['Sells shoes', false, 'Set at New board · 11/12']);
  await blur();
  assert.deepEqual(s.descriptionPosts, []);
  box.value = '';
  await blur();
  assert.deepEqual([box.value, status(), s.descriptionPosts], ['Sells shoes', 'A board needs a description', []]);
  box.value = ' Sells shoes and socks ';
  await blur();
  assert.deepEqual(s.descriptionPosts, [{ description: 'Sells shoes and socks' }]);
  assert.deepEqual([box.value, source(), status()], ['Sells shoes and socks', 'Edited here · 11/16', 'Saved. The hub routes by it from the next request.']);
  s.refuse = 'A description is at most 240 characters';
  box.value = 'Too long';
  await blur();
  assert.deepEqual([box.value, status()], ['Sells shoes and socks', 'A description is at most 240 characters']);
  s.view.unmount();
});

// docs/adr/2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md
test("Board Settings has no Builders, Orchestrators or Maximum parallel land tests: those are Hub settings' alone, and the page asks the hub for no board model", async () => {
  const s = settingsPage({ dom: true });
  const asked = [];
  const base = s.page.win.fetch;
  s.page.win.fetch = async (url, opts = {}) => { asked.push(url); return base(url, opts); };
  await s.mount();
  for (const id of ['boardModels', 'buildersModel', 'orchestratorsModel', 'orchestratorRestart', 'maxLandTests']) assert.equal(s.root.querySelector(`#${id}`), null, id);
  assert.doesNotMatch(s.root.innerHTML, /Builders|Orchestrators|land tests|Restart the session now/);
  assert.deepEqual(asked.filter((url) => url.includes('board-model')), []);
  s.view.unmount();
});

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

// docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md
// A Board Settings page whose server keeps the scripts view: GET and POST api/scripts, and api/settings {scripts}.
function scriptsPage({ source = 'repo', repo = [], kickflip = {} } = {}) {
  const s = settingsPage({ dom: true, settings: source === 'kickflip' ? { scripts: 'kickflip' } : {} });
  s.scripts = { ...kickflip };
  s.scriptPosts = [];
  s.reads = { targets: 0, permissions: 0 };
  const view = () => ({ source: s.saved.scripts || 'repo', repo, scripts: [...new Set(['build', ...Object.keys(s.scripts).sort(), 'release'])].map((name) => ({ name, text: s.scripts[name] ?? '' })) });
  const answer = (body, ok = true) => ({ ok, status: ok ? 200 : 400, text: async () => JSON.stringify(body), json: async () => body });
  const base = s.page.win.fetch;
  s.page.win.fetch = async (url, opts = {}) => {
    if (url.endsWith('/api/build-targets')) { s.reads.targets++; return answer({ targets: Object.keys(s.scripts).filter((n) => n.startsWith('build-')).map((n) => n.slice(6)) }); }
    if (url.endsWith('/api/permissions')) { s.reads.permissions++; return answer({ permissions: [] }); }
    if (url.endsWith('/api/settings') && opts.method === 'POST' && JSON.parse(opts.body).scripts === 'repo') {
      s.posts.push(JSON.parse(opts.body));
      s.saved = { ...s.saved };
      delete s.saved.scripts;
      return answer({ settings: s.saved });
    }
    if (!url.endsWith('/api/scripts')) return base(url, opts);
    if (opts.method !== 'POST') return answer(view());
    const body = JSON.parse(opts.body);
    s.scriptPosts.push(body);
    if (s.refuse) return answer({ error: s.refuse }, false);
    s.scripts[body.name] = body.text;
    return answer(view());
  };
  s.$ = (sel) => s.root.querySelector(sel);
  s.boxes = () => s.root.querySelectorAll('#scriptsList textarea').map((t) => [t.id, t.value]);
  s.source = (value) => s.$(`[data-scripts-source="${value}"]`);
  s.click = async (el) => { s.page.fire(el, 'click'); await tick(); await tick(); };
  s.save = async (name) => { s.page.fire(s.$('#scriptsList'), 'click', { target: s.$(`[data-script-save="${name}"]`) }); await tick(); await tick(); };
  s.type = (name, text) => { const box = s.$(`#script-${name}`); box.value = text; s.page.fire(s.$('#scriptsList'), 'input', { target: box }); };
  return s;
}

test("Board Settings' Scripts switch shows Repo only while main has the board's scripts or it is the source, saves a tap at once and names the chosen home under Build target", async () => {
  const none = await scriptsPage({ source: 'kickflip', repo: [] }).mount();
  await tick();
  assert.deepEqual([none.source('repo').hidden, none.source('kickflip').getAttribute('aria-pressed')], [true, 'true'], 'a repo with none of the scripts hides Repo');
  assert.match(none.$('#buildTargetSub').innerHTML, /kickflip’s <code>build<\/code>/);
  none.view.unmount();

  const s = await scriptsPage({ source: 'repo', repo: ['build', 'release'] }).mount();
  await tick();
  assert.deepEqual([s.source('repo').hidden, s.source('repo').getAttribute('aria-pressed'), s.source('kickflip').getAttribute('aria-pressed')], [false, 'true', 'false']);
  assert.equal(s.$('#scriptsBoxes').hidden, true, 'kickflip’s scripts are edited while they are the source');
  assert.match(s.$('#buildTargetSub').innerHTML, /<code>\.kickflip\/build<\/code> from each task’s branch/);
  const reads = { ...s.reads };
  await s.click(s.source('kickflip'));
  assert.deepEqual(s.posts.at(-1), { scripts: 'kickflip' });
  assert.deepEqual([s.source('kickflip').getAttribute('aria-pressed'), s.$('#scriptsBoxes').hidden], ['true', false]);
  assert.deepEqual(s.boxes(), [['script-build', ''], ['script-release', '']]);
  assert.match(s.$('#scriptsSourceStatus').textContent, /^Saved\. The hub runs kickflip’s scripts/);
  assert.match(s.$('#buildTargetSub').innerHTML, /kickflip’s <code>build<\/code>/);
  assert.deepEqual([s.reads.targets > reads.targets, s.reads.permissions > reads.permissions], [true, true], 'the targets and Run release script follow the source');
  await s.click(s.source('repo'));
  assert.deepEqual([s.posts.at(-1), s.source('repo').getAttribute('aria-pressed'), s.$('#scriptsBoxes').hidden], [{ scripts: 'repo' }, 'true', true]);
  s.view.unmount();
});

test("Board Settings' Scripts code box shows each kickflip script, Save sends an edit and marks it saved, a refusal keeps the edit, and Add build target opens a new box", async () => {
  const s = await scriptsPage({ source: 'kickflip', kickflip: { 'build-web': '#!/bin/sh\necho web\n' } }).mount();
  await tick();
  assert.deepEqual(s.boxes(), [['script-build', ''], ['script-build-web', '#!/bin/sh\necho web\n'], ['script-release', '']]);
  const save = (name) => s.$(`[data-script-save="${name}"]`);
  assert.equal(save('build').disabled, true, 'nothing to save yet');
  s.type('build', '#!/bin/sh\necho build\n');
  assert.deepEqual([save('build').disabled, s.$('#scriptsList').hasAttribute('data-dirty')], [false, true]);
  const reads = { ...s.reads };
  await s.save('build');
  assert.deepEqual(s.scriptPosts.at(-1), { name: 'build', text: '#!/bin/sh\necho build\n' });
  assert.deepEqual([save('build').disabled, s.$('#scriptsList').hasAttribute('data-dirty'), s.$('#script-buildStatus').textContent],
    [true, false, 'Saved. Main rebuilds with it; each task takes it from its next build.']);
  assert.deepEqual([s.reads.targets > reads.targets, s.reads.permissions > reads.permissions], [true, true]);

  s.refuse = 'script set release needs the script’s text';
  s.type('release', '  ');
  await s.save('release');
  assert.deepEqual([s.$('#script-release').value, s.$('#script-releaseStatus').textContent, s.$('#scriptsList').hasAttribute('data-dirty')], ['  ', 'script set release needs the script’s text', true]);
  s.refuse = '';
  s.type('release', '');

  s.$('#scriptTarget').value = 'a b';
  s.page.fire(s.$('#scriptAdd'), 'submit');
  await tick();
  assert.deepEqual([s.boxes().length, s.$('#scriptAddStatus').textContent], [3, 'A target is letters, digits, “.”, “_” or “-”.']);
  s.$('#scriptTarget').value = 'ios';
  s.page.fire(s.$('#scriptAdd'), 'submit');
  await tick();
  assert.deepEqual(s.boxes().map(([id]) => id), ['script-build', 'script-build-ios', 'script-build-web', 'script-release']);
  assert.deepEqual([s.$('#scriptTarget').value, s.$('#scriptAddStatus').textContent], ['', '']);
  s.type('build-ios', '#!/bin/sh\necho ios\n');
  await s.save('build-ios');
  assert.deepEqual(s.scriptPosts.at(-1), { name: 'build-ios', text: '#!/bin/sh\necho ios\n' });
  assert.equal(s.$('#script-build-iosStatus').textContent, 'Saved. Pick it under Build target to run it.');
  assert.equal(s.$('#scriptsList').hasAttribute('data-dirty'), false);
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

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
// docs/adr/2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md
const CAPS = [['max_implementers', 'maxImplementers'], ['max_serves', 'maxServes']];
for (const [key, id] of CAPS) {
  test(`Board Settings saves ${key} as a whole number from 1 to 99 on change, and puts the saved one back on a bad number or a refusal`, async () => {
    const s = await settingsPage({ settings: { max_implementers: 10, max_serves: 6 } }).mount();
    const input = s.root.querySelector(`#${id}`), status = s.root.querySelector(`#${id}Status`);
    const values = () => CAPS.map(([, other]) => s.root.querySelector(`#${other}`).value);
    assert.deepEqual([input.disabled, values()], [false, ['10', '6']]);
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
    assert.deepEqual(values().filter((v, i) => CAPS[i][0] !== key), ['10', '6'].filter((v, i) => CAPS[i][0] !== key), 'the other caps stay as saved');
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
  const d = { on: { on: true, sub: '', confirm: '' }, weekends: { on: false, sub: '' }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [], overnight: { starts: '', jobs: [] } }, pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off' }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false }, alerts: { summary: 'Off', note: '', kinds: [] },
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
  const settings = { on: { on: true, sub: '', confirm: '' }, weekends: { on: false, sub: '' }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [], overnight: { starts: '', jobs: [] } }, pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off' }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false }, alerts: { summary: 'Off', note: '', kinds: [] }, closed: [] };
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
    usage: {}, codex: { usable: true, share: 'auto', description: '', choices: choices('auto') }, claude: { builder: 'Opus', builders: { name: 'builders', label: 'Builders', description: '', choices: choices('auto') }, orchestrators: { name: 'orchestrators', label: 'Orchestrators', description: '', choices: choices('auto') } },
    pause: { state: 'normal', pause_at: 90, window: 'five_hour', used: 10, resets_at: new Date(NOW).toISOString(), machine: { state: 'normal', reason: null } } };
  const settings = { on: { on: true, sub: '', confirm: '' }, weekends: { on: false, sub: '' }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [], overnight: { starts: '', jobs: [] } }, pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off', choices: [] }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false }, alerts: { summary: 'Off', note: '', kinds: [] }, closed: [], snooze: { choices: [] } };
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
  const v = page.win.AppViews.frame.create(root, 'https://mac.ts.net/learn', { view, siteTitle: 'Course', boards: () => new Set(['board-a']),
    open: (href) => opened.push(href), toggleSidebar: () => toggles++, loaded: (url, title) => loads.push([url, title]) });
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

  assert.equal(tap(lesson, 'https://mac.ts.net/board-a/prototype-x.html?q=q1'), true, "a board's card page goes to the shell, which opens it in the board's sheet");
  assert.equal(tap(lesson, 'https://mac.ts.net/board-a/shots-gallery.html'), false, 'any other board page stays in the frame');
  const own = land('https://mac.ts.net/learn/', { title: 'Course', header: true });
  assert.deepEqual([root.classList.contains('own-header'), tap(own, 'https://mac.ts.net/_hub/', { cls: 'hub' }), toggles, opened.length], [true, true, 1, 4]);
  assert.equal(tap(own, 'https://mac.ts.net/_hub/', { cls: 'back' }), true);
  assert.deepEqual(opened.slice(3), ['https://mac.ts.net/board-a/prototype-x.html?q=q1', 'https://mac.ts.net/_hub/']);

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
  assert.equal(root.classList.contains('loading'), false, 'the copy lifts the loading screen before the catch-up answers');
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
  assert.equal(root.classList.contains('loading'), false, 'the landing replaces the loading screen');

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

// docs/adr/2026-11-17-0017-one-loading-screen-until-the-board-first-paints.md
// A board view on mini-dom whose /api/board answers only as each test says; threads and notes answer empty at once.
function loadingBoard({ width = 390, board: answerBoard }) {
  const page = fakePage(memoryStorage().localStorage);
  page.win.innerWidth = width;
  page.win.indexedDB = memoryIndexedDB();
  const { Element } = miniDom(page.Target, page.win.document);
  const asked = [];
  page.win.fetch = (url, opts = {}) => {
    if (url.includes('/api/notes')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ notes: {} }) });
    if (!url.includes('/api/board')) return Promise.resolve({ ok: true, status: 200, json: async () => [], text: async () => '[]' });
    asked.push(url);
    return answerBoard(opts);
  };
  const root = page.win.document.body.appendChild(new Element('div'));
  root.className = 'view-board';
  root.innerHTML = page.win.BoardView.markup({ title: 'Hub Orchestrator' });
  const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a');
  view.mount();
  return { page, root, view, asked, slow: () => root.querySelector('#boardLoading .board-loading-slow') };
}

test("a board with no saved copy opens on one loading screen over the lanes and the pane, with its name; from 5 s a line says the host is slow; the first paint lifts it with both panes drawn", async () => {
  const board = { ...boardOf([workCard('T1')]), title: 'Hub Orchestrator', version: 3 };
  let answer = null;
  const b = loadingBoard({ width: 1200, board: () => new Promise((resolve) => { answer = () => resolve({ ok: true, status: 200, json: async () => structuredClone(board) }); }) });
  await drain(() => answer, 'the board load asked');
  assert.equal(b.root.classList.contains('loading'), true);
  assert.match(b.root.querySelector('#boardLoading').textContent, /Hub Orchestrator/, "the screen names the board");
  b.page.runTimers(4999);
  assert.equal(b.slow().hidden, true, 'no slow line before 5 s');
  b.page.runTimers(5000);
  assert.equal(b.slow().hidden, false, 'the slow line from 5 s');
  answer();
  await drain(() => !b.root.classList.contains('loading'), 'the first paint lifts the screen');
  assert.match(b.root.querySelector('#lanes').textContent, /Work T1/, 'the lanes painted under it');
  assert.match(b.root.querySelector('#boardPane').textContent, /Open a card to see it here/, 'the pane painted under it');
  b.view.unmount();
});

test("with no saved copy, a load that times out or that nothing answers keeps the loading screen and retries every 5 s; only the hub saying the board is down swaps in the landing", async () => {
  let answer = 'hang';
  const b = loadingBoard({ board: (opts) => {
    if (answer === 'hang') return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    if (answer === 'none') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(answer);
  } });
  const landing = b.root.querySelector('#downLanding');
  await drain(() => b.asked.length === 1, 'the load asked');
  b.page.runTimers(20000);
  await drain(() => b.view.B.state.down, 'the load times out');
  assert.deepEqual([b.root.classList.contains('loading'), b.root.classList.contains('down'), landing.hidden], [true, false, true], 'a timeout keeps the loading screen');

  answer = 'none';
  b.page.runIntervals(5000);
  await drain(() => b.asked.length === 2, 'it retries');
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
  assert.deepEqual([b.root.classList.contains('loading'), b.root.classList.contains('down'), landing.hidden], [true, false, true], 'an unanswered load keeps it');

  answer = { ok: false, status: 502, headers: new Headers({ 'x-kickflip-down': 'stopped' }), json: async () => { throw new Error('html'); } };
  b.page.runIntervals(5000);
  await drain(() => b.root.classList.contains('down'), 'the landing shows');
  assert.deepEqual([b.root.classList.contains('loading'), landing.hidden], [false, false]);
  assert.match(landing.innerHTML, /data-down="stopped"/);
  b.view.unmount();
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
    assert.equal(root.classList.contains('loading'), false, 'the landing replaces the loading screen');
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

test("out of reach with nothing on screen, the board paints the copy another build saved and asks for the whole board once it answers; a copy whose paint throws leaves the loading screen", async () => {
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
    await drain(() => view.B.state.down, 'the load reads as unanswered');
    view.unmount();
    idb.rows.set(`${site}/`, { build: 'build-0', savedAt: board.generatedAt, board: saved, threads: {} });

    const asked = [];
    page.win.fetch = async (url) => { asked.push(url); throw new TypeError('Failed to fetch'); };
    const again = new page.El();
    const back = page.win.BoardView.create(again, site);
    back.mount();
    await drain(() => asked.length > 0 && (again.dataset.board === 'fresh' || back.B.state.down), 'the old copy paints or the load reads as unanswered');
    await new Promise((r) => setImmediate(r));
    if (saved === board) {
      assert.deepEqual([again.dataset.board, back.B.state.link, again.classList.contains('down')], ['fresh', 'offline', false], 'the older copy paints, out of reach');
      asked.length = 0;
      await back.B.loadBoard();
      assert.deepEqual(asked, [`${site}/api/board`], 'the next load asks for the whole board');
    } else {
      assert.deepEqual([again.dataset.board, again.classList.contains('down'), again.classList.contains('loading')], [undefined, false, true],
        'a paint that throws leaves the loading screen, as nothing answered');
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

// docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md
test("Notes paint at once from the board's saved copy, which holds every card's notes, then take the live answer", async () => {
  const site = 'https://mac.ts.net/board-a';
  const page = fakePage(memoryStorage().localStorage);
  page.win.indexedDB = memoryIndexedDB();
  const board = { title: 'A', version: 7, generatedAt: '2026-10-29T10:00:00.000Z', items: [{ key: 'w/A1', ref: 'INT-1', lane: 'todo' }], owner: [], ownerTopics: [] };
  await page.win.BoardUI.copyStore('boards', 'readwrite', (store) => store.put({ build: 'build-1', savedAt: board.generatedAt, board, threads: {}, notes: { 'w/A1': '# Saved\n\nFrom the copy.' } }, `${site}/`));
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  page.win.fetch = async (url) => {
    const body = url.includes('/api/notes') ? await answered : { items: board.items };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const root = new page.El();
  const view = page.win.AppViews.notes.create(root, site, { view: { kind: 'notes', route: 'board-a', item: 'w/A1' } });
  view.mount();
  const plan = root.querySelector('#plan');
  await drain(() => /From the copy/.test(plan.innerHTML), 'the copy paints before the answer');
  assert.doesNotMatch(plan.innerHTML, /Loading the notes|copy-note/);
  assert.equal(root.querySelector('#ref').textContent, 'INT-1 notes');
  answer({ key: 'w/A1', ref: 'INT-1', title: 'One', markdown: '# Live\n\nFrom the board.' });
  await drain(() => /From the board/.test(plan.innerHTML), 'the live answer takes its place');
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

test("two boards' stores never share a key: the old shared keys move to the first board opened, a New task draft among them, and a card's old draft keeps its key", () => {
  const { storage, localStorage } = memoryStorage([['draft:ask', JSON.stringify('old draft')], ['openItems', JSON.stringify(['w/A1'])], ['draft:w/A1', JSON.stringify('a reply')]]);
  const page = fakePage(localStorage);
  const open = (route) => {
    const root = new page.El();
    const view = page.win.BoardView.create(root, `https://mac.ts.net/${route}`);
    view.mount();
    return { root, view, store: view.B.store };
  };
  const a = open('board-a');
  const b = open('board-b');
  assert.deepEqual([a.store.get('draft:ask'), JSON.parse(JSON.stringify(a.store.get('openItems')))], ['old draft', ['w/A1']]);
  assert.deepEqual([b.store.get('draft:ask', null), b.store.get('openItems', null)], [null, null]);

  for (const { root } of [a, b]) page.fire(root, 'toggle', { target: { matches: (s) => s === 'details.item', dataset: { key: 'w/A2' }, open: false } });
  for (const { view } of [a, b]) view.unmount();

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
  for (const file of ['ui-progress-bar.js', 'ui-icon-text.js', 'ui-page-header.js', 'ui-sidebar.js', 'sidebar.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
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
  EventSource, reload, storage = memoryStorage(), realBoards = false, width = 390, indexedDB = null } = {}) {
  const page = fakePage(storage.localStorage);
  const { win } = page;
  if (indexedDB) win.indexedDB = indexedDB;
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
      assert.deepEqual([...values], [['--kb', '344px'], ['--sheet-full', '844px'], ['--vh', '500px']]);
      assert.equal(sheet.classList.contains('kb'), true);
      assert.equal(sheet.classList.contains('keyboard-sheet'), true);
      vv.offsetTop = 20;
      page.fire(vv, 'scroll');
      assert.equal(values.get('--kb'), '324px');
      // The pan lowers vh + kb to 824, but the sheet keeps the height it opened at.
      assert.equal(values.get('--sheet-full'), '844px');
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
    assert.equal(start.disabled, true, 'Start is off while Description is empty');
    assert.match(sheet.textContent, /Clones to.*\/clone\/.repos\/owner\/project/);
    assert.match(sheet.textContent, /implementers work in separate worktrees/);
    field('name').value = '';
    page.fire(form, 'input', { target: field('name') });
    assert.equal(start.disabled, true);
    field('name').value = 'Backend audit';
    page.fire(form, 'input', { target: field('name') });
    assert.equal(start.disabled, true, 'Start waits for a Description');
    assert.match(sheet.textContent, /Description/);
    assert.match(sheet.textContent, /Used by the hub for request routing/);
    assert.match(sheet.innerHTML, /name="purpose"[^>]* required=""/);
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
    assert.equal(sheet.querySelector('[data-nb-model]'), null, 'New board asks no model: a new board starts on Hub default');
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

// docs/adr/2026-11-18-0600-new-starts-a-board-or-a-teach-course.md
test('New opens on Board, and its Course posts a name and what to learn to the hub, showing the course starting at the end of Pages; a taken name stays in the sheet', async () => {
  const page = repoPage();
  const { win, doc } = page;
  let data = { sites: [{ route: 'learn', title: 'Learn', board: false, icon: '' }], starting: [] };
  let refusal = 'That name is taken: a board or page already has its route. Pick another name.';
  const posted = [];
  win.fetch = async (url, options = {}) => {
    if (url === '/_hub/sidebar.json') return repoResponse(data);
    if (url === '/_hub/repos') return repoResponse({ signedIn: true, repos: repoList });
    posted.push([url, options.method, JSON.parse(options.body), options.headers?.['content-type']]);
    if (refusal) return { ok: false, text: async () => refusal };
    data = { ...data, starting: [{ route: 'rust-ownership', title: 'Rust ownership', course: true, step: 'starting', stepAt: new Date().toISOString(), failed: false }] };
    return repoResponse({ route: 'rust-ownership' });
  };
  const sidebar = win.Sidebar.mount({ data });
  const aside = doc.getElementById('sidebar');
  assert.equal(aside.querySelector('[data-new-board]').textContent.trim(), 'New');
  page.fire(aside, 'click', { target: aside.querySelector('[data-new-board]') });
  await tick();
  const sheet = doc.getElementById('newBoardSheet');
  const form = sheet.querySelector('form');
  const click = (sel) => page.fire(form, 'click', { target: sheet.querySelector(sel) });
  const pressed = () => sheet.querySelector('[data-nb-kind][aria-pressed="true"]').textContent;
  assert.equal(sheet.querySelector('h2').textContent, 'New');
  assert.equal(pressed(), 'Board');
  assert.match(sheet.textContent, /Newest push first/);
  click('[data-nb-kind="course"]');
  assert.equal(pressed(), 'Course');
  assert.equal(sheet.querySelector('[data-repo]'), null, 'Course drops the repo picker');
  const start = sheet.querySelector('[type="submit"]');
  assert.deepEqual([start.hidden, start.disabled], [false, true]);
  assert.match(sheet.textContent, /Name \(becomes the route\).*What do you want to learn\?.*Start runs \/teach and writes lesson 1\./s);
  const name = sheet.querySelector('[name="course-name"]');
  name.value = 'Rust ownership';
  page.fire(form, 'input', { target: name });
  assert.equal(sheet.querySelector('[data-course-route]').textContent, 'Opens at /rust-ownership/');
  assert.equal(start.disabled, true, 'Start waits for what to learn');
  const learn = sheet.querySelector('[name="learn"]');
  learn.value = ' Borrowing, from scratch ';
  page.fire(form, 'input', { target: learn });
  assert.equal(start.disabled, false);
  click('[data-nb-kind="board"]');
  await tick();
  assert.match(sheet.textContent, /Newest push first/);
  click('[data-nb-kind="course"]');
  assert.deepEqual([sheet.querySelector('[name="course-name"]').value, sheet.querySelector('[name="learn"]').value], ['Rust ownership', ' Borrowing, from scratch '], 'the course draft survives a switch');
  page.fire(form, 'submit');
  await tick();
  assert.equal(sheet.querySelector('[role="alert"]').textContent, refusal);
  assert.equal(sheet.open, true);
  refusal = null;
  page.fire(form, 'submit');
  await tick(); await tick();
  assert.deepEqual(posted.at(-1), ['/_hub/new-course', 'POST', { name: 'Rust ownership', learn: 'Borrowing, from scratch' }, 'application/json']);
  assert.equal(doc.getElementById('newBoardSheet'), null);
  const pages = aside.querySelector('.sb-pages');
  assert.match(pages.textContent, /Learn.*Rust ownership.*writing lesson 1 · \d+s/s);
  sidebar.close();
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
  assert.ok(sheet.querySelector('[data-nb-source="folder"]'), 'the signed-out sheet offers a folder on this Mac too');
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
    assert.equal(sheet.querySelector('[data-nb-source][aria-pressed="true"]')?.textContent ?? null, current ? null : 'GitHub', 'only New picks a source');
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
    if (!current) {
      assert.equal(sheet.querySelector('[type="submit"]').disabled, true, 'Start waits for a Description');
      sheet.querySelector('[name="purpose"]').value = 'Outside work';
      page.fire(form, 'input', { target: sheet.querySelector('[name="purpose"]') });
    }
    assert.equal(sheet.querySelector('[type="submit"]').disabled, false);
    page.fire(form, 'submit');
    await tick();
    assert.deepEqual(saved, [current ? { github: 'outside/project', branch: 'canary' } : { github: 'outside/project', branch: 'canary', name: 'project', purpose: 'Outside work', tickets: { source: 'none' } }]);
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
    assert.equal(sheet.querySelector('[data-repo-results] [role="alert"] .nb-why').textContent, 'That’s a folder. Pick Folder on this Mac above.');
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
  sheet.querySelector('[name="purpose"]').value = 'Firmware work';
  page.fire(form, 'input', { target: sheet.querySelector('[name="purpose"]') });
  page.fire(form, 'submit');
  await tick();
  assert.deepEqual(saved, [{ name: 'firmware', purpose: 'Firmware work', remote: link, branch: 'main', tickets: { source: 'none' } }]);
  assert.deepEqual(urls, ['/_hub/repos', `/_hub/repo?remote=${encodeURIComponent(link)}`, `/_hub/branches?remote=${encodeURIComponent(link)}`]);
});

// docs/adr/2026-11-18-0724-a-new-board-can-anchor-on-a-folder-on-this-mac.md
test('Folder on this Mac suggests folders as you type, shows what the hub found, holds Next for a non-repo until Make it a git repo, and starts with the folder', async () => {
  const page = repoPage();
  const { win, doc } = page;
  const urls = [], saved = [];
  const found = {
    '~/dev/shop': { folder: '~/dev/shop', path: '/home/o/dev/shop', git: true, github: 'acme/shop', branch: 'trunk', branches: ['trunk', 'alpha'] },
    '~/dev/diary': { folder: '~/dev/diary', path: '/home/o/dev/diary', git: true, branch: 'main', branches: ['main'] },
    '~/dev/poems': { folder: '~/dev/poems', path: '/home/o/dev/poems', git: false, branch: 'main', branches: ['main'] },
  };
  win.setTimeout = (fn) => { fn(); return 1; };
  win.fetch = async (url) => {
    urls.push(url);
    const q = new URL(url, 'https://test').searchParams;
    if (url === '/_hub/repos') return repoResponse({ signedIn: true, repos: repoList });
    if (url.startsWith('/_hub/folders?')) return repoResponse({ folders: Object.keys(found).filter((f) => f.startsWith(q.get('q'))) });
    const at = found[q.get('path')];
    if (at) return repoResponse(at);
    return q.get('path') === '~' ? { ok: false, status: 400, json: async () => ({ error: 'That’s your whole home folder. Pick a folder inside it.' }) }
      : { ok: false, status: 404, json: async () => ({ error: 'No folder there.' }) };
  };
  win.BoardDialogs.repoSheet({ save: async (input, selected) => saved.push(JSON.parse(JSON.stringify([input, selected]))) });
  await tick();
  const sheet = doc.getElementById('newBoardSheet');
  const form = sheet.querySelector('form');
  const click = (sel) => page.fire(form, 'click', { target: sheet.querySelector(sel) });
  const type = async (value) => {
    const input = sheet.querySelector('[name="folder-path"]');
    input.value = value;
    page.fire(form, 'input', { target: input });
    await tick(); await tick();
  };
  const results = () => sheet.querySelector('[data-folder-results]').textContent;
  const next = sheet.querySelector('[data-folder-next]');
  assert.deepEqual([...sheet.querySelectorAll('[data-nb-source]')].map((b) => b.textContent), ['GitHub', 'Other git host', 'Folder on this Mac']);
  click('[data-nb-source="git"]');
  assert.equal(sheet.querySelector('[name="search"]').getAttribute('placeholder'), 'https://host/path or user@host:path');
  assert.equal(sheet.querySelector('[data-repo]'), null, 'Other git host lists no GitHub repos');
  click('[data-nb-source="folder"]');
  assert.equal(next.hidden, false);
  assert.match(results(), /Start typing a path under ~/);
  await type('~/dev/');
  assert.deepEqual([...sheet.querySelectorAll('[data-folder]')].map((b) => b.dataset.folder), ['~/dev/shop', '~/dev/diary', '~/dev/poems']);
  assert.equal(urls.some((u) => u.startsWith('/_hub/folder?')), false, 'a path ending in a slash is still being typed');
  await type('~');
  assert.match(results(), /That’s your whole home folder/);
  assert.equal(next.disabled, true);
  await type('~/dev/nothing');
  assert.match(results(), /No folder there\. Keep typing, or tap a suggestion\./);
  await type('~/dev/d');
  click('[data-folder="~/dev/diary"]');
  await tick(); await tick();
  assert.equal(sheet.querySelector('[name="folder-path"]').value, '~/dev/diary');
  assert.equal(results(), 'Git repo · no remote · lands won’t push');
  assert.equal(next.disabled, false);
  await type('~/dev/poems');
  assert.match(results(), /^Not a git repoMake it a git repogit init, and commit what’s there as the first commit\. Applies when you tap Start\./);
  assert.equal(next.disabled, true, 'Next waits for Make it a git repo');
  const toggle = sheet.querySelector('[name="git-init"]');
  toggle.checked = true;
  page.fire(form, 'change', { target: toggle });
  assert.equal(sheet.querySelector('[data-folder-line]').textContent, 'Will be a git repo · no remote · lands won’t push');
  assert.equal(next.disabled, false);
  click('[data-folder-next]');
  assert.match(sheet.querySelector('.nb-selected').textContent, /^~\/dev\/poemsWill be a git repo/);
  assert.equal(sheet.querySelector('[name="branch"]').disabled, true);
  assert.match(sheet.textContent, /A new repo starts on main\..*On this board, lands fast-forward main and never push\./s);
  assert.equal(sheet.querySelector('[name="name"]').value, 'poems');
  assert.equal(sheet.querySelector('[data-tk-source="github"]').getAttribute('aria-disabled'), 'true');
  sheet.querySelector('[name="purpose"]').value = 'Poems';
  page.fire(form, 'input', { target: sheet.querySelector('[name="purpose"]') });
  page.fire(form, 'submit');
  await tick();
  assert.deepEqual(saved, [[{ name: 'poems', purpose: 'Poems', folder: '/home/o/dev/poems', git_init: true, branch: 'main', tickets: { source: 'none' } }, { clone: '/home/o/dev/poems', cloned: true }]]);

  win.BoardDialogs.repoSheet({ save: async (input) => saved.push(JSON.parse(JSON.stringify(input))) });
  await tick();
  const again = doc.getElementById('newBoardSheet');
  page.fire(again.querySelector('form'), 'click', { target: again.querySelector('[data-nb-source="folder"]') });
  const input = again.querySelector('[name="folder-path"]');
  input.value = '~/dev/shop';
  page.fire(again.querySelector('form'), 'input', { target: input });
  await tick(); await tick();
  assert.equal(again.querySelector('[data-folder-results]').textContent, 'Git repo · github.com/acme/shop · trunk');
  page.fire(again.querySelector('form'), 'click', { target: again.querySelector('[data-folder-next]') });
  assert.deepEqual([...again.querySelectorAll('[name="branch"] option')].map((o) => o.value), ['trunk', 'alpha']);
  assert.match(again.textContent, /Read from the folder\. New implementers branch from trunk\..*On this board, lands fast-forward trunk in this folder\./s);
  assert.notEqual(again.querySelector('[data-tk-source="github"]').getAttribute('aria-disabled'), 'true', 'a GitHub clone can file GitHub issues');
  page.fire(again.querySelector('form'), 'click', { target: again.querySelector('[data-back-repos]') });
  await tick(); await tick();
  assert.equal(again.querySelector('[name="folder-path"]').value, '~/dev/shop', 'Back keeps the folder');
  page.fire(again.querySelector('form'), 'click', { target: again.querySelector('[data-folder-next]') });
  again.querySelector('[name="purpose"]').value = 'Shop';
  page.fire(again.querySelector('form'), 'input', { target: again.querySelector('[name="purpose"]') });
  page.fire(again.querySelector('form'), 'submit');
  await tick();
  assert.deepEqual(saved.at(-1), { name: 'shop', purpose: 'Shop', folder: '/home/o/dev/shop', branch: 'trunk', tickets: { source: 'none' } });
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
    assert.match(status.innerHTML, /it-(grey|green)/);
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

test("Board Settings' repo row reads Local only, lands don't push, for a board with no remote", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const root = new page.El();
  page.win.fetch = async (url) => repoResponse(url === '/_hub/board-repo/diary' ? { github: '', branch: 'trunk', repo: '/home/o/dev/diary', local: true } : {});
  const view = page.win.AppViews.settings.create(root, 'https://mac.ts.net/diary', { reload() {} });
  view.mount();
  await tick();
  assert.equal(root.querySelector('#boardRepoValue').textContent, 'Local only, lands don’t push · trunk');
  view.unmount();
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
  // Another dialog open (a side sheet left behind after a thread send) no longer blocks n n; the open New task sheet does.
  sheet.close();
  dialog = {};
  press('n');
  press('n');
  assert.equal(sheet.open, true);
  dialog = null;
  board.unmount();
});

test("h h on a desktop shows the shortcuts sheet listing each shortcut's keys, and h h again or Escape closes it; it stays shut from a text field, with a modifier, between other keys, or on a phone; another open dialog doesn't block it, and h h does nothing while it is open", () => {
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
    ['On a board', [['New task', 'n n'], ['Search tasks', 'f f']]],
    ['Writing', [['Send', '⌘ ↵']]],
  ]);
  assert.equal(press('Escape').defaultPrevented, true);
  assert.equal(sheet(), null);
  twice();
  assert.ok(sheet());
  twice();
  assert.ok(sheet(), 'h h does nothing while the help is open');
  press('Escape');
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
  assert.ok(sheet(), 'another open dialog no longer blocks h h');
  press('Escape');
  other.remove();
  desktop.matches = false;
  twice();
  assert.equal(sheet(), null);
});

// seen: card key → its readAt on the board, the read mark board/server.mjs keeps for every device.
// streaming: {open}, the shell's change stream as the view reads it (BoardView.create's streaming), or null for a board
// outside the shell.
function boardOnDom({ open = [], seen = {}, stored = [], filter = null, board, threads, notes, confirm = false, realDialogs = false, send = null, width = 390, streaming = null, pause = null }) {
  const { storage, localStorage } = memoryStorage([['site:board-a:openItems', JSON.stringify(open)], ...stored]);
  const page = fakePage(localStorage);
  page.win.innerWidth = width;
  const { Element } = miniDom(page.Target, page.win.document);
  const server = { board: { ...board, items: board.items.map((it) => (seen[it.key] ? { ...it, readAt: seen[it.key] } : it)) }, threads, notes };
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
  // A draft saved answers with the server's time of the save, each later than the last, as board/drafts.mjs saveDraft does.
  let draftSaves = 0;
  page.win.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'https://mac.ts.net/');
    if (opts.method === 'POST' && u.pathname.endsWith('/api/drafts')) { posts.push([u.pathname, JSON.parse(opts.body)]); const at = `2026-11-13T12:00:00.${String(++draftSaves).padStart(3, '0')}Z`; return { ok: true, status: 200, json: async () => ({ at }) }; }
    if (opts.method === 'POST') { posts.push([u.pathname, JSON.parse(opts.body)]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    gets.push(u.pathname);
    if (u.pathname.endsWith('/api/settings')) return { ok: true, status: 200, json: async () => ({ pause_choices: [{ value: '1h', label: '1h', ms: 3600_000 }, { value: 'forever', label: 'Forever', ms: null }] }) };
    // A board with a version answers 304 to a request naming it, as board/server.mjs does.
    if (u.pathname.endsWith('/api/board') && server.board.version && opts.headers?.['if-none-match'] === `"${server.board.version}"`) return { ok: false, status: 304, json: async () => { throw new Error('a 304 has no body'); } };
    // A reload naming a version the server holds gets a patch from it, as board/server.mjs answerBoard does.
    const since = u.pathname.endsWith('/api/board') && server.held?.[u.searchParams.get('since')];
    if (since) {
      const at = u.searchParams.get('since');
      patched.push(at);
      const patch = boardPatch(since, server.board, { from: server.heldThreads?.[at] || {}, to: server.threads || {} }, { from: server.heldNotes?.[at] || {}, to: server.notes || {} });
      return { ok: true, status: 200, json: async () => structuredClone(patch), text: async () => JSON.stringify(patch) };
    }
    if (u.pathname.endsWith('/api/board')) downloads.push(server.board.version);
    if (u.pathname.endsWith('/api/notes') && u.searchParams.has('all')) return { ok: true, status: 200, json: async () => structuredClone({ notes: server.notes || {} }) };
    if (u.pathname.endsWith('/api/done')) return { ok: true, status: 200, json: async () => structuredClone(server.done(u.searchParams)) };
    const body = u.pathname.endsWith('/api/board') ? server.board : server.threads[u.searchParams.get('key')] || [];
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  const root = page.win.document.body.appendChild(new Element('div'));
  root.innerHTML = page.win.BoardView.markup({ title: 'A' });
  let signalled = null;
  const view = page.win.BoardView.create(root, 'https://mac.ts.net/board-a', { signal: (fn) => { signalled = fn; return () => {}; }, ...(streaming ? { streaming: () => streaming.open } : {}), ...(pause ? { pause: () => pause.now } : {}) });
  view.mount();
  // The board filter starts with every box checked; filter names the unchecked ones the owner already set.
  if (filter) view.B.state.boardFilter = filter;
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const change = async (next) => { Object.assign(server, next); signalled(); await settle(); };
  return { page, root, view, settle, change, sent, confirms, confirmLabels, notices, posts, gets, downloads, patched, server, storage, doc: page.win.document };
}
// The work card an ask became (from_ask; docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md).
const askCard = (id, lane) => ({ key: `w/${id}`, id, kind: 'work', lane, title: `Task ${id}`, ref: `T-${id}`, fromAsk: id, deps: [], manualSteps: [], othersAt: [] });
const boardOf = (items) => ({ title: 'A', generatedAt: '2026-10-30T10:00:00.000Z', items, files: [], needs: [], answers: [], owner: [], ownerTopics: [], doneArchived: 0 });
const workCard = (id, extra) => {
  const it = { key: `w/${id}`, id, kind: 'work', lane: 'todo', title: `Work ${id}`, ref: id, internal: true, wave: { slug: 'w1', title: 'W' }, deps: [], manualSteps: [], othersAt: [], ...extra };
  return { footer: footerOf({ blockedBy: [], ...it }), ...it };
};

// docs/adr/2026-11-15-1921-the-browsers-polls-ride-the-change-stream.md
test("an idle open board asks the host nothing while the change stream is open: its 15 s check runs only while the stream is down, a pending GitHub check waits for the change signal, and no asks watch polls", async () => {
  const stream = { open: true };
  const board = { ...boardOf([workCard('T1')]), version: 'v1', checks: { requested: { state: 'pending', at: '2026-10-30T10:00:00.000Z' } } };
  const b = boardOnDom({ board, threads: {}, streaming: stream });
  await b.settle();
  // The 30 s count-up (ui.js recount) reads the page's elements.
  b.page.win.document.querySelectorAll = () => [];
  const asked = b.gets.length;
  assert.equal(b.page.left().watches, 0, 'no asks watch');
  for (let minute = 0; minute < 5; minute++) for (const ms of [5000, 15000, 15000]) b.page.runIntervals(ms);
  await b.settle();
  assert.deepEqual(b.gets.slice(asked), [], 'five idle minutes with the stream open ask nothing');
  await b.change({ board: { ...board, checks: { requested: { state: 'landed', at: '2026-10-30T10:00:00.000Z' } }, version: 'v2' } });
  assert.deepEqual([boardGets(b), b.downloads], [2, ['v1', 'v2']], 'the change signal brings the landed check');
  stream.open = false;
  b.page.runIntervals(15000);
  await b.settle();
  assert.equal(boardGets(b), 3, 'with the stream down the 15 s check reloads');
  b.view.unmount();
});

test('a page runs its repaints from one 15 s timer: a 30 s job runs every second beat, and the down-check runs only while the stream is down', () => {
  const page = fakePage(memoryStorage().localStorage);
  const stream = { open: true };
  const runs = [];
  const view = page.win.BoardView.page(new page.El(), 'https://mac.ts.net/board-a', (B) => {
    B.tick(() => runs.push('each'));
    B.tick(() => runs.push('second'), 2);
    B.whileDown(() => stream.open, () => runs.push('down'));
  });
  view.mount();
  assert.equal(page.left().intervals, 1, 'one page timer');
  page.runIntervals(15000);
  page.runIntervals(15000);
  assert.deepEqual(runs, ['each', 'each', 'second']);
  stream.open = false;
  page.runIntervals(15000);
  assert.deepEqual(runs.slice(3), ['each', 'down']);
  view.unmount();
  assert.equal(page.left().intervals, 0);
});

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
  b.page.fire(b.root, 'click', { target: bumpItem(b, 'w/T2') });
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
  b.page.fire(b.root, 'click', { target: bumpItem(b, 'w/T2') });
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
  assert.match(title(), /^Asleep/, 'the header says waking only when the server does');
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
    workCard('A5', { ...asking, ownerBlock: { until: null }, holdable: true, action: null, resolvedBy: null }),
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
    'w/A5': [['Unblock', 'Questions'], [], []],
    'w/P1': [['Questions'], [], ['Questions']],
    'w/D1': [['Notes'], ['Install', 'Review draft on GitHub'], ['Review draft on GitHub']],
    'w/R1': [[], ['Install', 'Review on GitHub'], []],
    'w/S1': [[], ['Review on GitHub'], ['Review on GitHub']],
    'w/M1': [['Merge'], ['Review on GitHub'], ['Merge']],
  });
  assert.equal(row('w/A1').querySelector('button.button').dataset.questions, 'q7');
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
test("the thread's Prototype and Grill send their request at once: nothing typed sends the bare request, typed text goes with it, /prototype and /grill in the text still work on Reply, and no toggle or hint remains", async () => {
  const cards = [workCard('A1'), workCard('A2', { prototyping: true })];
  const b = boardOnDom({ open: ['w/A1'], board: boardOf(cards), threads: { 'w/A1': [] } });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/A1"]');
  const eye = () => form().querySelector('button[data-proto]');
  const fire = () => form().querySelector('button[data-grill]');
  const box = () => form().querySelector('textarea');
  const tap = async (button, text = '') => { box().value = text; b.page.fire(b.root, 'click', { target: button }); await b.settle(); };
  const send = async (text) => { box().value = text; b.page.fire(b.root, 'submit', { target: form(), submitter: form().querySelector('button[data-nth="0"]') }); await b.settle(); };
  assert.match(box().getAttribute('placeholder'), /\/prototype, \/grill, \/visual or \/review/);
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
test("a Todo card's Implement is in its thread box: enabled while the card owes it; once it is staged or ready it is a quiet Cancel that sends card-cancel at once with no confirm, following each board load; its action row has none", async () => {
  const asking = { actionButton: 'openQuestions', buildable: false, questions: { first: 'q7', open: 1, state: 'open' }, action: { kind: 'questions', url: 'questions.html#q7', label: 'Answer 1 question' } };
  const cards = [workCard('Q1', asking), workCard('S1', { staging: true }), workCard('R1', { buildable: true, ready: true })];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: { 'w/Q1': [], 'w/S1': [], 'w/R1': [] }, confirm: true });
  await b.settle();
  const second = (key) => b.root.querySelector(`form[data-reply="${key}"] button[type="submit"]`);
  const shape = (key) => [second(key).textContent.replace(/⌥↵$/, ''), second(key).getAttribute('class') || '', second(key).disabled];
  assert.deepEqual([shape('w/Q1'), shape('w/S1'), shape('w/R1')], [['Implement', 'build', false], ['Cancel', '', false], ['Cancel', '', false]]);
  assert.ok(b.root.querySelector('form[data-reply="w/R1"] button[data-intent="reply"]'));
  assert.equal(b.root.querySelector('.actions [data-confirm="card-build"]'), null);
  const form = b.root.querySelector('form[data-reply="w/S1"]');
  b.page.fire(b.root, 'submit', { target: form, submitter: second('w/S1') });
  await b.settle();
  assert.deepEqual(b.confirms, [], 'no confirm');
  assert.deepEqual(sentNoIds(b), [['card-cancel', { key: 'w/S1' }]]);
  await b.change({ board: boardOf([workCard('Q1', { buildable: true, ready: true }), cards[1], cards[2]]) });
  assert.deepEqual(shape('w/Q1'), ['Cancel', '', false]);
  b.view.unmount();
});

test("a thread's request words show only while its card is in Todo, disabled with Implement once it is staged or ready", async () => {
  const cards = [workCard('T1'), workCard('S1', { staging: true }), workCard('P1', { lane: 'progress' }), workCard('R1', { lane: 'review' })];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: { 'w/T1': [], 'w/S1': [], 'w/P1': [], 'w/R1': [] } });
  await b.settle();
  const row = (key) => {
    const el = b.root.querySelector(`[data-thread="${key}"]`);
    return [el.dataset.requestWords, [...el.querySelectorAll('.request-row button')].map((x) => x.disabled).join()];
  };
  assert.deepEqual([row('w/T1'), row('w/S1'), row('w/P1'), row('w/R1')],
    [['shown', 'false,false,false,false'], ['shown', 'true,true,true,true'], ['hidden', 'false,false,false,false'], ['hidden', 'false,false,false,false']]);
  assert.equal(b.root.querySelectorAll('[data-thread="w/P1"] button[data-intent="reply"]').length, 1, 'send stays');
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
  assert.deepEqual(sentNoIds(b), [['ask', { text: 'Plain task' }], ['ask', { text: 'Quick task', quick: true }]]);
  const pressed = [];
  form.requestSubmit = (s) => pressed.push(s?.dataset.intent ?? null);
  const box = b.root.querySelector('#askText');
  const key = (ev) => b.page.fire(box, 'keydown', { key: 'Enter', target: box, ...ev }).defaultPrevented;
  assert.deepEqual([key({ metaKey: true }), key({ ctrlKey: true }), key({ altKey: true }), key({}), key({ shiftKey: true })], [true, true, true, false, false]);
  assert.deepEqual(pressed, ['discuss', 'discuss', 'quick']);
  b.view.unmount();
});

// docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md
test("the New task box has the thread's request words spread under its text box, the attach icon inside the box; each sends the task at once with its request, as /prototype, /grill or /visual in the text does", async () => {
  const b = boardOnDom({ board: boardOf([]), threads: {} });
  await b.settle();
  const form = b.root.querySelector('#askForm');
  assert.deepEqual(form.querySelector('.note-tools').children.map((c) => c.getAttribute('class')), ['pending-files', 'request-row']);
  assert.deepEqual(form.querySelector('.note-tools .request-row').children.map((c) => c.getAttribute('title')), ['Ask for prototypes', 'Ask for a grill', 'Ask for a visual']);
  assert.deepEqual(form.querySelector('.request-row').children.slice(0, 3).map((c) => c.textContent), ['Prototype⌥P', 'Grill⌥G', 'Visual⌥V']);
  assert.ok(form.querySelector('.dz .attach'));
  assert.equal(form.querySelector('.request-row .attach'), null);
  const tap = async (text, sel) => {
    b.page.fire(b.root.querySelector('#compose'), 'click');
    b.root.querySelector('#askText').value = text;
    b.page.fire(b.root, 'click', { target: form.querySelector(sel) });
    await b.settle();
    b.page.runTimers(180);
    await b.settle();
  };
  await tap('Show the header', '[data-proto]');
  assert.equal(b.root.querySelector('#sheet').open, false);
  await tap('Ask me about the footer', '[data-grill]');
  await tap('Draw the queue', '[data-visual]');
  await tap('', '[data-visual]');
  b.root.querySelector('#askText').value = 'Pick a colour /grill';
  b.page.fire(form, 'submit', { target: form, submitter: form.querySelector('button[data-intent="discuss"]') });
  await b.settle();
  assert.deepEqual(sentNoIds(b), [
    ['ask', { text: 'Show the header', request: 'prototype' }], ['ask', { text: 'Ask me about the footer', request: 'grill' }],
    ['ask', { text: 'Draw the queue', request: 'visual' }], ['ask', { text: 'Pick a colour', request: 'grill' }],
  ]);
  b.view.unmount();
});

// docs/adr/2026-11-14-2350-a-new-task-shows-at-once-in-the-new-strip-as-sending.md
// The New strip's rows the page hasn't sent yet, as read: the task's text and what follows its time.
const askOut = (b) => b.root.querySelectorAll('#newStrip .new-entry[data-send]').map((el) => [el.querySelector('.new-msg').textContent, dotted(el.querySelector('.new-line').textContent).slice(1).join(' · ')]);
const askFoot = (el) => dotted(el.querySelector('.new-line').textContent);
// Opens the New task box, types text and taps the button of intent; the box's close animation runs out.
async function askTap(b, text, intent) {
  const form = b.root.querySelector('#askForm');
  b.page.fire(b.root.querySelector('#compose'), 'click');
  b.root.querySelector('#askText').value = text;
  const button = form.querySelector(`button[data-intent="${intent}"]`);
  b.page.fire(form, 'submit', { target: form, submitter: button });
  await b.settle();
  b.page.runTimers(180);
  await b.settle();
  return button;
}
const recorded = (id, at, text, sendId) => { const it = newAsk(id, at, 'waiting', text); return { ...it, ask: { ...it.ask, askedAt: at, sendId } }; };
test("Implement or Discuss in the New task box closes it at once, its button never waiting, and the task joins the end of the New strip reading <time> · sending…; tasks go one at a time in order under send ids, and the board's own row, matched by its send id, takes each one's place reading <time> · waiting…", async () => {
  const sends = heldSends();
  const older = newAsk('a0', '2026-11-13T09:00:00.000Z');
  const b = boardOnDom({ board: boardOf([older]), threads: {}, send: sends.send });
  await b.settle();
  const sheet = b.root.querySelector('#sheet');
  const implement = await askTap(b, 'Fix the header', 'quick');
  assert.deepEqual([sheet.open, waitState(implement), b.root.querySelector('#askText').value], [false, IDLE, '']);
  assert.deepEqual(askOut(b), [['Fix the header', 'sending…']]);
  const [stored] = JSON.parse(b.storage.get(OUTBOX));
  const row = b.root.querySelector(`#newStrip .new-entry[data-send="${stored.sendId}"]`);
  assert.equal(row.querySelector('.new-time').textContent, b.page.win.BoardUI.time(stored.ts), 'the time leads the footer');
  assert.deepEqual(b.root.querySelectorAll('#newStrip .new-entry').map((el) => el.dataset.new), ['a0', stored.sendId], 'at the end of the strip');
  assert.equal(b.root.querySelector('#newStrip summary .count').textContent, '2');
  assert.equal(row.querySelectorAll('button[data-edit], button[data-withdraw]').length, 0);

  await askTap(b, 'Dark mode', 'discuss');
  assert.deepEqual([askOut(b), b.sent.length], [[['Fix the header', 'sending…'], ['Dark mode', 'sending…']], 1], 'the second waits for the first');
  const [kind, first] = b.sent[0];
  assert.deepEqual([kind, first.text, first.quick, first.key, first.sendId], ['ask', 'Fix the header', true, undefined, stored.sendId]);

  b.server.board = boardOf([older, recorded('e1', stored.ts, 'Fix the header', first.sendId)]);
  sends.answer();
  await b.settle();
  assert.deepEqual(askOut(b), [['Dark mode', 'sending…']]);
  assert.deepEqual(askFoot(b.root.querySelector('#newStrip .new-entry[data-new="e1"]')), [b.page.win.BoardUI.time(stored.ts), 'waiting…']);
  assert.deepEqual(sentNoIds(b), [['ask', { text: 'Fix the header', quick: true }], ['ask', { text: 'Dark mode' }]]);
  assert.notEqual(b.sent[1][1].sendId, first.sendId);
  b.view.unmount();
});

test("a New task the board didn't take reads <time> · not sent with Retry and X in its strip row, each after a confirm: Retry sends it again under the same send id, and X drops the row and reopens the New task box with its text before the draft and its files back", async () => {
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([]), threads: {}, send: sends.send, confirm: true });
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const boxes = boxesOn(b.page.win);
  boxes.put('ask', [boxes.up(shot)]);
  await b.settle();
  await askTap(b, 'Fix the header', 'quick');
  const { sendId } = b.sent[0][1];
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent[0][1].files)), [shot]);
  sends.answer(false, 'The board server is restarting. Try again in a moment.');
  await b.settle();
  const row = () => b.root.querySelector(`#newStrip .new-entry[data-send="${sendId}"]`);
  assert.deepEqual(askOut(b), [['Fix the header', 'not sent']]);
  assert.ok(row().querySelector(`button[data-resend="${sendId}"]`) && row().querySelector(`button[data-unsend="${sendId}"]`));
  assert.deepEqual(JSON.parse(b.storage.get(OUTBOX)).map((m) => [m.text, Boolean(m.failed)]), [['Fix the header', true]]);

  b.page.fire(b.root, 'click', { target: row().querySelector('button[data-resend]') });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), askOut(b), b.sent.length, b.sent[1][1].sendId], ['Send this task again?', [['Fix the header', 'sending…']], 2, sendId]);
  sends.answer(false);
  await b.settle();
  assert.deepEqual(askOut(b), [['Fix the header', 'not sent']]);

  b.root.querySelector('#askText').value = 'Draft';
  b.page.fire(b.root, 'click', { target: row().querySelector('button[data-unsend]') });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), askOut(b), JSON.parse(b.storage.get(OUTBOX))], ['Dismiss this task? Its text and files go back in the New task box.', [], []]);
  assert.deepEqual([b.root.querySelector('#sheet').open, b.root.querySelector('#askText').value, draftPosts(b).at(-1)?.text], [true, 'Fix the header\n\nDraft', 'Fix the header\n\nDraft']);
  assert.deepEqual(JSON.parse(JSON.stringify(b.page.win.BoardAttach.files('ask'))), [shot]);
  b.view.unmount();
});

test("a New task the board never recorded survives a reload: the strip shows it as sending… again and resends it under its send id, a failed one included", async () => {
  const kept = { sendId: 's-kept', kind: 'ask', text: 'Kept', files: [], fields: { quick: true }, ts: '2026-11-13T11:00:00.000Z', failed: true };
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([]), threads: {}, send: sends.send, stored: [[OUTBOX, JSON.stringify([kept])]] });
  await b.settle();
  assert.deepEqual(askOut(b), [['Kept', 'sending…']]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['ask', { text: 'Kept', quick: true, sendId: 's-kept' }]]);
  b.server.board = boardOf([recorded('e1', kept.ts, 'Kept', 's-kept')]);
  sends.answer();
  await b.settle();
  assert.deepEqual([askOut(b), b.root.querySelectorAll('#newStrip .new-entry[data-new="e1"]').length, JSON.parse(b.storage.get(OUTBOX))], [[], 1, []]);
  b.view.unmount();
});

// attach.js's boxes, faked on the page's BoardAttach: each box id holds files as attach.js's list does, put sets one,
// finish ends a file's upload, and every change is told to the page's onChange listeners. retried lists retryFailed's boxes.
function boxesOn(win) {
  const A = win.BoardAttach;
  const boxes = new Map();
  const waiters = [];
  const retried = [];
  let seq = 0;
  const get = (id) => boxes.get(id) || [];
  const settle = () => {
    for (const w of waiters.splice(0)) {
      if (A.busy(w.id)) waiters.push(w);
      else w.resolve(!get(w.id).some((p) => p.status === 'error'));
    }
  };
  const changed = (id) => { A.tell(id); settle(); };
  const tile = (name, type, extra) => ({ id: `f${++seq}`, name, type, preview: `blob:${name}`, ...extra });
  Object.assign(A, {
    list: (id) => get(id),
    files: (id) => get(id).filter((p) => p.status === 'done').map((p) => p.file),
    busy: (id) => get(id).some((p) => p.status === 'uploading'),
    settled: (id) => new Promise((resolve) => { waiters.push({ id, resolve }); settle(); }),
    move(from, to) { boxes.set(to, [...get(to), ...get(from)]); boxes.delete(from); changed(from); changed(to); },
    saved: (id) => get(id).map((p) => (p.status === 'done' ? p.file : { name: p.name, type: p.type, lost: true })),
    restore(id, files) { boxes.set(id, [...get(id), ...files.map((f) => (f.lost ? tile(f.name, f.type, { status: 'error', error: 'Lost in a reload', final: true }) : tile(f.name, f.type, { status: 'done', file: f })))]); changed(id); },
    retryFailed(id) { retried.push(id); for (const p of get(id)) if (p.status === 'error' && !p.final) p.status = 'uploading'; changed(id); },
    clear(id) { boxes.delete(id); changed(id); },
  });
  return {
    boxes, retried,
    up: (file) => tile(file.name, file.type, { status: 'done', file }),
    uploading: (file) => tile(file.name, file.type, { status: 'uploading', progress: 0.4, sent: file }),
    put(id, list) { boxes.set(id, list); changed(id); },
    // Ends the named file's upload in whichever box holds it: up as its file, or failed.
    finish(name, ok) {
      const [id, p] = [...boxes].flatMap(([k, l]) => l.filter((x) => x.name === name).map((x) => [k, x]))[0];
      Object.assign(p, ok ? { status: 'done', file: p.sent } : { status: 'error', error: 'Upload failed' });
      changed(id);
    },
    remove(id, name) { boxes.set(id, get(id).filter((p) => p.name !== name)); changed(id); },
  };
}
// docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md
const tilesOf = (row) => row.querySelectorAll('[data-uploads] .file-thumb, [data-uploads] .file-link').map((el) => [el.getAttribute('title'), el.getAttribute('class').split(' ')[1]]);
test("a New task with a file still uploading closes the box at once; its strip row shows the files as tiles under sending…, and the task goes once every file is up, with them as its files", async () => {
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([]), threads: {}, send: sends.send });
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const boxes = boxesOn(b.page.win);
  boxes.put('ask', [boxes.up(shot), boxes.uploading(log)]);
  await b.settle();
  const implement = await askTap(b, 'Look at this', 'quick');
  assert.deepEqual([b.root.querySelector('#sheet').open, waitState(implement), b.sent, askOut(b), boxes.boxes.has('ask')], [false, IDLE, [], [['Look at this', 'sending…']], false]);
  const [stored] = JSON.parse(b.storage.get(OUTBOX));
  const row = () => b.root.querySelector(`#newStrip .new-entry[data-send="${stored.sendId}"]`);
  assert.equal(row().querySelector('[data-uploads]').dataset.uploads, `send:${stored.sendId}`);
  assert.deepEqual(tilesOf(row()), [['shot.png', 'done'], ['run.log', 'uploading']]);
  assert.deepEqual(stored.uploads, [shot, { name: 'run.log', type: 'text/plain', lost: true }], 'kept for a reload');
  boxes.finish('run.log', true);
  await b.settle();
  assert.deepEqual(sentNoIds(b), [['ask', { text: 'Look at this', files: [shot, log], quick: true }]]);
  const [sending] = JSON.parse(b.storage.get(OUTBOX));
  assert.deepEqual([sending.uploads, sending.files, boxes.boxes.has(`send:${stored.sendId}`)], [undefined, [shot, log], false]);
  assert.deepEqual(row().querySelectorAll('.files a').map((a) => a.getAttribute('href')), ['uploads/1-shot.png', 'uploads/2-run.log'], 'the uploaded files, as the thread draws them');
  b.view.unmount();
});

test("an upload that fails sends nothing: the row reads not sent, the file marked with its X; Retry uploads it again and sends once it is up, and a failed file removed by its X lets Retry send without it", async () => {
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([]), threads: {}, send: sends.send, confirm: true });
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const boxes = boxesOn(b.page.win);
  boxes.put('ask', [boxes.up(shot), boxes.uploading(log)]);
  await b.settle();
  await askTap(b, 'Look at this', 'quick');
  const [{ sendId }] = JSON.parse(b.storage.get(OUTBOX));
  const row = () => b.root.querySelector(`#newStrip .new-entry[data-send="${sendId}"]`);
  boxes.finish('run.log', false);
  await b.settle();
  assert.deepEqual([b.sent, askOut(b), tilesOf(row())], [[], [['Look at this', 'not sent']], [['shot.png', 'done'], ['run.log: Upload failed', 'error']]]);
  assert.ok(row().querySelector('[data-uploads] .file-link.error [data-unattach]'), 'the failed file has its X');
  b.page.fire(b.root, 'click', { target: row().querySelector(`button[data-resend="${sendId}"]`) });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), boxes.retried, askOut(b), tilesOf(row())[1]], ['Send this task again?', [`send:${sendId}`], [['Look at this', 'sending…']], ['run.log', 'uploading']]);
  boxes.finish('run.log', true);
  await b.settle();
  assert.deepEqual(sentNoIds(b), [['ask', { text: 'Look at this', files: [shot, log], quick: true }]]);
  b.server.board = boardOf([recorded('e1', '2026-11-13T11:00:00.000Z', 'Look at this', sendId)]);
  sends.answer();
  await b.settle();

  boxes.put('ask', [boxes.up(shot), boxes.uploading(log)]);
  await askTap(b, 'Without the log', 'discuss');
  const second = JSON.parse(b.storage.get(OUTBOX)).at(-1).sendId;
  boxes.finish('run.log', false);
  await b.settle();
  boxes.remove(`send:${second}`, 'run.log');
  await b.settle();
  assert.deepEqual(JSON.parse(b.storage.get(OUTBOX)).at(-1).uploads, [shot], 'the X is kept for a reload');
  b.page.fire(b.root, 'click', { target: b.root.querySelector(`button[data-resend="${second}"]`) });
  await b.settle();
  assert.deepEqual(sentNoIds(b).at(-1), ['ask', { text: 'Without the log', files: [shot] }]);
  b.view.unmount();
});

test("X on a New task whose upload failed reopens the New task box with its text and its files, the failed one still marked", async () => {
  const b = boardOnDom({ board: boardOf([]), threads: {}, send: () => new Promise(() => {}), confirm: true });
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const boxes = boxesOn(b.page.win);
  boxes.put('ask', [boxes.up(shot), boxes.uploading(log)]);
  await b.settle();
  await askTap(b, 'Look at this', 'quick');
  const [{ sendId }] = JSON.parse(b.storage.get(OUTBOX));
  boxes.finish('run.log', false);
  await b.settle();
  b.page.fire(b.root, 'click', { target: b.root.querySelector(`button[data-unsend="${sendId}"]`) });
  await b.settle();
  assert.deepEqual([askOut(b), b.root.querySelector('#sheet').open, b.root.querySelector('#askText').value], [[], true, 'Look at this']);
  assert.deepEqual([...b.page.win.BoardAttach.list('ask')].map((p) => [p.name, p.status]), [['shot.png', 'done'], ['run.log', 'error']]);
  assert.equal(boxes.boxes.has(`send:${sendId}`), false);
  b.view.unmount();
});

test("after a reload a New task's kept files go back in its box: with every one up it sends with them, and with one lost mid-upload it reads not sent, the lost file marked", async () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const whole = { sendId: 's-whole', kind: 'ask', text: 'Whole', files: [], uploads: [shot], ts: '2026-11-13T11:00:00.000Z' };
  const cut = { sendId: 's-cut', kind: 'ask', text: 'Cut', files: [], uploads: [shot, { name: 'run.log', type: 'text/plain', lost: true }], ts: '2026-11-13T11:01:00.000Z', failed: true };
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([]), threads: {}, send: sends.send, stored: [[OUTBOX, JSON.stringify([whole, cut])]] });
  const boxes = boxesOn(b.page.win);
  await b.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['ask', { text: 'Whole', files: [shot], sendId: 's-whole' }]]);
  b.server.board = boardOf([recorded('e1', whole.ts, 'Whole', 's-whole')]);
  sends.answer();
  await b.settle();
  assert.deepEqual([b.sent.length, askOut(b)], [1, [['Cut', 'not sent']]]);
  assert.deepEqual(tilesOf(b.root.querySelector('#newStrip .new-entry[data-send="s-cut"]')), [['shot.png', 'done'], ['run.log: Lost in a reload', 'error']]);
  assert.ok(boxes.boxes.has('send:s-cut'));
  b.view.unmount();
});

test("a tap on a thumbnail opens the image full size over the board, ‹ and › or the arrow keys step through its message's images, and ✕ or the dim area closes it; a modified click opens the file as a link", async () => {
  const a = { name: 'a.png', url: 'uploads/1-a.png', type: 'image/png' };
  const c = { name: 'c.png', url: 'uploads/3-c.png', type: 'image/png' };
  const pdf = { name: 'b.pdf', url: 'uploads/2-b.pdf', type: 'application/pdf' };
  const ask = newAsk('a1', '2026-11-13T09:00:00.000Z');
  const b = boardOnDom({ board: boardOf([{ ...ask, ask: { ...ask.ask, files: [a, pdf, c] } }]), threads: {} });
  await b.settle();
  const box = b.root.querySelector('#lightbox');
  const thumbs = b.root.querySelectorAll('#newStrip a.file-thumb');
  const shown = () => [box.open, box.querySelector('img').getAttribute('src'), box.querySelector('.lightbox-name').textContent, box.querySelector('.lightbox-at').textContent];
  assert.equal(b.page.fire(b.root, 'click', { target: thumbs[0], metaKey: true }).defaultPrevented, false);
  assert.equal(box.open, false);
  assert.equal(b.page.fire(b.root, 'click', { target: thumbs[1] }).defaultPrevented, true);
  assert.deepEqual(shown(), [true, 'uploads/3-c.png', 'c.png', '2 of 2']);
  b.page.fire(b.root, 'click', { target: box.querySelector('[data-lightbox="next"]') });
  assert.deepEqual(shown(), [true, 'uploads/1-a.png', 'a.png', '1 of 2']);
  b.page.fire(box, 'keydown', { target: box, key: 'ArrowLeft' });
  assert.deepEqual(shown().slice(1, 3), ['uploads/3-c.png', 'c.png']);
  b.page.fire(b.root, 'click', { target: box.querySelector('[data-lightbox="close"]') });
  assert.equal(box.open, false);
  b.page.fire(b.root, 'click', { target: thumbs[0] });
  assert.equal(box.open, true);
  b.page.fire(b.root, 'click', { target: box });
  assert.equal(box.open, false, 'the dim area closes it');
  b.page.fire(b.root, 'click', { target: thumbs[0] });
  assert.equal(box.querySelector('.lightbox-nav').hidden, false);
  b.view.unmount();
});

// docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md
const OUTBOX = 'site:board-a:outbox';
const footOf = (el) => el.querySelector('.msg-foot').textContent.replace(/^[^·]*· ?/, '');
// A thread's lines as read: a status line's words and what follows its time, a message's body and its footer after the time.
const dotted = (text) => text.split('·').map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
function threadLines(b, key) {
  // An empty thread's "No messages here yet." note is no line.
  return b.root.querySelectorAll(`[data-thread="${key}"] .msgs > *`).filter((el) => !el.matches('.muted')).map((el) => {
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
  assert.deepEqual(draftPosts(b).at(-1), { id: 'item:w/T1', text: 'Third\n\nDraft', files: [] });
  assert.equal(b.root.querySelector('[data-thread="w/T1"]').querySelectorAll('button[data-edit], button[data-withdraw]').length, 0);
  b.view.unmount();
});

// docs/adr/2026-11-18-1200-composer-drafts-live-on-the-server.md
// The drafts the page saved on the board (POST api/drafts), in order.
const draftPosts = (b) => b.posts.filter(([p]) => p.endsWith('/api/drafts')).map(([, d]) => d);
const draftAt = (n) => `2026-11-13T13:00:0${n}.000Z`;
test("a reply box draws its draft from the board's drafts, and saves what is typed on the board after a 1 s pause, at once as the box loses focus or the page hides, never twice the same; Send empties it there", async () => {
  const board = { ...boardOf([workCard('T1')]), drafts: { 'item:w/T1': { text: 'Begun on the phone', files: [], at: draftAt(1) } } };
  const b = boardOnDom({ open: ['w/T1'], board, threads: { 'w/T1': [] } });
  await b.settle();
  const box = () => b.root.querySelector('form[data-reply="w/T1"] textarea');
  const type = (text) => { box().value = text; b.page.fire(b.root, 'input', { target: box() }); };
  assert.equal(box().value, 'Begun on the phone');

  type('Begun on the phone, then');
  await b.settle();
  assert.deepEqual(draftPosts(b), [], 'nothing while typing goes on');
  b.page.runTimers(1000);
  await b.settle();
  assert.deepEqual(draftPosts(b), [{ id: 'item:w/T1', text: 'Begun on the phone, then', files: [] }]);

  type('Begun on the phone, then the Mac');
  b.page.fire(b.root, 'focusout', { target: box() });
  await b.settle();
  b.page.runTimers(1000);
  b.page.fire(b.root, 'focusout', { target: box() });
  await b.settle();
  assert.deepEqual(draftPosts(b).map((d) => d.text), ['Begun on the phone, then', 'Begun on the phone, then the Mac'], 'the blur saved, its pause ended, and a second blur had nothing new');

  type('Hidden');
  b.doc.hidden = true;
  b.page.fire(b.doc, 'visibilitychange');
  await b.settle();
  b.doc.hidden = false;
  assert.equal(draftPosts(b).at(-1).text, 'Hidden');

  b.page.fire(b.root, 'submit', { target: box().closest('form'), submitter: box().closest('form').querySelector('button[data-intent="reply"]') });
  await b.settle();
  assert.deepEqual([box().value, b.sent.at(-1)[1].text, draftPosts(b).at(-1)], ['', 'Hidden', { id: 'item:w/T1', text: '', files: [] }]);
  b.view.unmount();
});

test("a draft saved on another device fills its box with the board that brings it, files too, but never a box with focus, which keeps what is typed and saves it over the other; an older draft changes nothing", async () => {
  const board = { ...boardOf([workCard('T1')]), drafts: {} };
  const b = boardOnDom({ open: ['w/T1'], board, threads: { 'w/T1': [] } });
  const boxes = boxesOn(b.page.win);
  await b.settle();
  const box = () => b.root.querySelector('form[data-reply="w/T1"] textarea');
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png', size: 3 };
  const drafted = (text, at, files = []) => b.change({ board: { ...board, drafts: { 'item:w/T1': { text, files, at } } } });

  await drafted('From the phone', draftAt(2), [shot]);
  assert.deepEqual([box().value, JSON.parse(JSON.stringify(b.page.win.BoardAttach.files('item:w/T1')))], ['From the phone', [shot]]);
  assert.deepEqual(draftPosts(b), [], 'taking a draft saves nothing back');

  box().focus();
  await drafted('Phone again', draftAt(3));
  assert.equal(box().value, 'From the phone', 'the box being typed in keeps its words');
  box().value = 'Mac words';
  box().blur();
  b.page.fire(b.root, 'focusout', { target: box() });
  await b.settle();
  assert.deepEqual(draftPosts(b), [{ id: 'item:w/T1', text: 'Mac words', files: [shot] }], 'the last save wins');

  await drafted('Stale', draftAt(1));
  assert.equal(box().value, 'Mac words');
  assert.equal(boxes.boxes.get('item:w/T1').length, 1);
  b.view.unmount();
});

test("the New task box draws its draft from the board, and this browser's old drafts move to the board once, each where the board has none for its box, their keys then gone", async () => {
  const stored = [['site:board-a:draft:ask', JSON.stringify('Old task')], ['draft:w/T1', JSON.stringify('Old reply')], ['draft:w/T2', JSON.stringify('Kept on the board')], ['draft:w/T9', JSON.stringify('Another board’s')]];
  const drafts = { 'item:w/T2': { text: 'Newer on the board', files: [], at: draftAt(1) } };
  const b = boardOnDom({ open: ['w/T1', 'w/T2'], stored, board: { ...boardOf([workCard('T1'), workCard('T2')]), drafts }, threads: { 'w/T1': [], 'w/T2': [] } });
  await b.settle();
  assert.deepEqual(draftPosts(b), [{ id: 'ask', text: 'Old task', files: [] }, { id: 'item:w/T1', text: 'Old reply', files: [] }]);
  assert.deepEqual([b.root.querySelector('#askText').value, b.root.querySelector('form[data-reply="w/T1"] textarea').value, b.root.querySelector('form[data-reply="w/T2"] textarea').value],
    ['Old task', 'Old reply', 'Newer on the board']);
  assert.deepEqual([...b.storage.keys()].filter((k) => k.includes('draft:')), ['draft:w/T9']);

  await b.change({ board: { ...boardOf([workCard('T1'), workCard('T2')]), drafts: { ...drafts, ask: { text: 'Old task', files: [], at: draftAt(2) } } } });
  assert.equal(draftPosts(b).length, 2, 'they move once');
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

// docs/adr/2026-11-17-1335-a-sending-card-button-spins-and-the-lane-waits-for-the-board.md,
// docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md
test("a tapped Implement is disabled, with no spinner, while its send is in the outbox, so a second tap can't send it again", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/T1"]');
  const second = () => form().querySelector('button[type="submit"]').textContent.replace(/⌥↵$/, '');
  assert.equal(second(), 'Implement');
  b.page.fire(b.root, 'submit', { target: form(), submitter: form().querySelector('button[data-intent="build"]') });
  await b.settle();
  assert.equal(second(), 'Implement');
  assert.deepEqual(waitState(form().querySelector('button[data-intent="build"]')), [true, false, null]);
  assert.equal(sentNoIds(b).filter(([, d]) => d.intent === 'build').length, 1);
  b.view.unmount();
});

// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md
test("a reply-box tap carries the version of the card it was drawn on, and one the board refuses as moved (409) leaves the outbox with the board's reason as a toast, never not sent", async () => {
  const reason = '#9 is already ready, so nothing changed.';
  const send = (kind, data) => (data.intent === 'build' ? Promise.reject(Object.assign(new Error('send failed: 409'), { status: 409, reason })) : null);
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1', { version: 'todo/ready' })]), threads: { 'w/T1': [] }, send });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/T1"]');
  b.page.fire(b.root, 'submit', { target: form(), submitter: form().querySelector('button[data-intent="build"]') });
  await b.settle();
  assert.deepEqual(sentNoIds(b), [['item-message', { key: 'w/T1', text: '', intent: 'build', version: 'todo/ready' }]]);
  assert.deepEqual(JSON.parse(b.storage.get(OUTBOX)), []);
  assert.equal(b.root.querySelectorAll('[data-thread="w/T1"] .msg[data-send]').length, 0, 'no not-sent line is left');
  assert.ok(b.root.querySelectorAll('.toast').some((t) => t.textContent.includes(reason)));
  b.view.unmount();
});

// docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
test("Implement shows its line at once and its button is disabled from the tap: an empty box's line reads Marked as staged · sending…, and the board's line, matched by sendId, takes its place; with text the message's footer reads Implement · sending…", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1', 'w/T2'], board: boardOf([workCard('T1'), workCard('T2')]), threads: { 'w/T1': [], 'w/T2': [] }, send: sends.send });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const implement = (key) => form(key).querySelector('button[data-intent="build"]');
  const tap = async (key, text) => { form(key).querySelector('textarea').value = text; b.page.fire(b.root, 'submit', { target: form(key), submitter: implement(key) }); await b.settle(); };
  await tap('w/T1', 'Use the blue');
  assert.deepEqual([form('w/T1').querySelector('textarea').value, threadLines(b, 'w/T1'), waitState(implement('w/T1'))], ['', ['Use the blue (Implement · sending…)'], [true, false, null]]);
  assert.equal(b.sent[0][1].intent, 'build');
  await tap('w/T2', '');
  assert.deepEqual([threadLines(b, 'w/T2'), waitState(implement('w/T2'))], [['Marked as staged · sending…'], [true, false, null]]);
  const sendId = b.sent.at(-1)[1].sendId;
  b.server.threads['w/T2'] = [{ ts: '2026-10-30T10:06:00.000Z', who: 'claude', kind: 'command', command: 'staged', request: true, mark: 'Marked as staged', text: 'Marked as staged', sendId }];
  sends.answer();
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/T2'), ['Marked as staged']);
  assert.deepEqual(sentNoIds(b).at(-1), ['item-message', { key: 'w/T2', text: '', intent: 'build' }]);
  b.view.unmount();
});

// docs/adr/2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md
// docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
test("a Todo card's thread box has Reply (⌘↵) and Implement (⌥↵), which send the message with intent: 'reply' or 'build'; an In Progress card's has Block (⌥↵) and Reply, and the box follows the card's lane", async () => {
  const b = boardOnDom({ open: ['w/T1', 'w/P1'], board: boardOf([workCard('T1'), workCard('P1', { lane: 'progress' })]), threads: { 'w/T1': [], 'w/P1': [] } });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const buttons = (key) => [...form(key).querySelectorAll('button[type="submit"]')].map((el) => [el.dataset.intent ?? null, el.textContent]);
  assert.deepEqual(buttons('w/T1'), [['build', 'Implement⌥↵'], ['reply', 'Reply⌘↵']]);
  assert.deepEqual(buttons('w/P1'), [[null, 'Block⌥↵'], ['reply', 'Reply⌘↵']]);
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
  // An empty box still sends Implement, bare: the board server readies the card and builds at once.
  await send('w/T1', '', 'build');
  assert.deepEqual(sentNoIds(b).at(-1), ['item-message', { key: 'w/T1', text: '', intent: 'build' }]);
  const pressed = [];
  for (const key of ['w/T1', 'w/P1']) form(key).requestSubmit = (s) => pressed.push([key, s?.dataset.intent ?? s?.dataset.confirm ?? null]);
  const key = (k, ev) => { const box = form(k).querySelector('textarea'); return b.page.fire(b.root, 'keydown', { key: 'Enter', target: box, ...ev }).defaultPrevented; };
  assert.deepEqual([key('w/T1', { metaKey: true }), key('w/T1', { altKey: true }), key('w/P1', { ctrlKey: true }), key('w/P1', { altKey: true })], [true, true, true, true]);
  assert.deepEqual(pressed, [['w/T1', 'reply'], ['w/T1', 'build'], ['w/P1', 'reply'], ['w/P1', 'hold']]);
  await b.change({ board: boardOf([workCard('T1', { lane: 'progress' }), workCard('P1', { lane: 'progress' })]) });
  const moved = b.root.querySelector('details.item[data-key="w/T1"]');
  assert.equal(moved.open, false, 'a card that changed lane comes back closed');
  moved.open = true;
  b.page.fire(b.root, 'toggle', { target: moved });
  assert.deepEqual(buttons('w/T1'), [[null, 'Block⌥↵'], ['reply', 'Reply⌘↵']]);
  b.view.unmount();
});

// docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md
test("a thread box's row holds only Prototype, Grill, Visual and Review, with the attach icon inside the text box, and the send pair below", async () => {
  const b = boardOnDom({ open: ['w/T1', 'w/P1'], board: boardOf([workCard('T1'), workCard('P1', { lane: 'progress' })]), threads: { 'w/T1': [], 'w/P1': [] } });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const row = (key) => [...form(key).querySelector('.row').children].map((el) => el.matches('.request-row') ? 'request-row' : el.dataset.sends);
  const icons = (key) => [...form(key).querySelector('.request-row').children].map((el) => ['quick', 'proto', 'grill', 'visual', 'review'].find((k) => el.hasAttribute('data-' + k)) || (el.matches('label.attach') ? 'attach' : '?'));
  assert.deepEqual(row('w/T1'), ['request-row', 'todo']);
  assert.deepEqual(row('w/P1'), ['request-row', 'progress']);
  for (const key of ['w/T1', 'w/P1']) {
    assert.deepEqual(icons(key), ['proto', 'grill', 'visual', 'review']);
    assert.ok(form(key).querySelector('.dz .attach'));
    assert.equal(form(key).querySelector('.request-row .attach'), null);
    assert.ok(form(key).querySelector('.dz .dz-hint'));
  }
  assert.equal(b.root.querySelector('[data-bolt]'), null);
  b.view.unmount();
});

// docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md
test("Done is in the ticket actions of a work card in every lane, right of Block, and also in an In Review card's thread actions, as Done (⌥↵) then Reply (⌘↵)", async () => {
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
  assert.deepEqual(sends('w/P1'), ['Block⌥↵', 'Reply⌘↵']);
  assert.deepEqual(sends('w/T1'), ['Implement⌥↵', 'Reply⌘↵']);
  assert.equal(form('w/R1').querySelector('[data-confirm="finish"]').getAttribute('class'), 'closes');
  assert.equal(form('w/a1').querySelector('[data-confirm="finish"]').getAttribute('class'), 'closes');
  // A card waiting only on Done flags every Done button, in the ticket actions as in the thread actions.
  const ticketDone = (key) => b.root.querySelector(`details.item[data-key="${key}"] .action-row.workflow [data-confirm="finish"]`);
  assert.equal(ticketDone('w/R1').getAttribute('class'), 'resolves');
  assert.equal(ticketDone('w/a1').getAttribute('class'), 'resolves');
  assert.equal(ticketDone('w/S1').getAttribute('class'), null);
  for (const key of ['w/T1', 'w/P1']) assert.equal(form(key).querySelector('[data-confirm="finish"]'), null);
  assert.deepEqual(actions('w/T1'), ['Block', 'Done', 'Notes']);
  assert.deepEqual(actions('w/P1'), ['Block', 'Done']);
  assert.deepEqual(actions('w/R1'), ['Block', 'Done']);
  assert.deepEqual(actions('w/a1'), ['Done']);
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
  assert.deepEqual(b.confirms.slice(-2), ['Done R1? It moves to Done and Claude stops work on it.', 'Done T1? It moves to Done and Claude stops work on it.']);
  assert.deepEqual(sentNoIds(b), [['item-message', { key: 'w/R1', text: 'Looks good', intent: 'reply' }], ['card-done', { key: 'w/R1' }], ['card-done', { key: 'w/T1' }]]);
  // The box follows the card's lane.
  await b.change({ board: boardOf([{ ...cards[1], lane: 'review' }, ...cards.slice(2)]) });
  const moved = b.root.querySelector('details.item[data-key="w/P1"]');
  moved.open = true;
  b.page.fire(b.root, 'toggle', { target: moved });
  assert.deepEqual(sends('w/P1'), ['Done⌥↵', 'Reply⌘↵']);
  b.view.unmount();
});

// docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md
test("an In Progress card's quiet Block opens the Block sheet and its orange Unblock, while the owner's block is on, confirms the unblock; a Done card's quiet Reopen confirms and sends card-reopen; every box's other send is Reply", async () => {
  const cards = [
    workCard('P1', { lane: 'progress', holdable: true }),
    workCard('H1', { lane: 'progress', holdable: true, ownerBlock: { until: null }, blocked: true }),
    workCard('U1', { lane: 'progress', holdable: true, builder: { phase: 'building', pause: { cause: 'usage', words: 'usage limit', paused: true } } }),
    workCard('D1', { lane: 'done' }),
  ];
  const holdChoices = [{ value: '1h', label: '1h', ms: 3_600_000 }];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: { ...boardOf(cards), holdChoices }, threads: Object.fromEntries(cards.map((c) => [c.key, []])), confirm: true });
  await b.settle();
  const form = (key) => b.root.querySelector(`form[data-reply="${key}"]`);
  const sends = (key) => [...form(key).querySelectorAll('button[type="submit"]')].map((el) => [el.textContent, el.getAttribute('class') || '', el.dataset.confirm ?? el.dataset.intent]);
  assert.deepEqual(sends('w/P1'), [['Block⌥↵', '', 'hold'], ['Reply⌘↵', 'primary', 'reply']]);
  assert.deepEqual(sends('w/H1'), [['Unblock⌥↵', 'unblock', 'resume'], ['Reply⌘↵', 'primary', 'reply']]);
  assert.deepEqual(sends('w/U1'), [['Block⌥↵', '', 'hold'], ['Reply⌘↵', 'primary', 'reply']], 'a usage pause is no block of yours');
  assert.deepEqual(sends('w/D1'), [['Reopen⌥↵', '', 'reopen'], ['Reply⌘↵', 'primary', 'reply']]);
  b.page.fire(b.root, 'submit', { target: form('w/P1'), submitter: form('w/P1').querySelector('[data-confirm="hold"]') });
  await b.settle();
  assert.equal(b.root.querySelector('#holdSheet').open, true);
  b.page.fire(b.root.querySelector('#holdClose'), 'click');
  for (const key of ['w/H1', 'w/D1']) {
    b.page.fire(b.root, 'submit', { target: form(key), submitter: form(key).querySelector('[data-confirm]') });
    await b.settle();
  }
  assert.deepEqual(b.confirms.slice(-2), ['Unblock H1? It can start again once nothing else blocks it.', 'Reopen D1? It moves back to Todo, discussing, for you to talk it through again.']);
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
  const moved = b.root.querySelector('details.item[data-key="w/R1"]');
  moved.open = true;
  b.page.fire(b.root, 'toggle', { target: moved });
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

test("on the host's own page, served over http while the tailnet is off, Visit opens the try port at 127.0.0.1", async () => {
  const data = { ...boardOf([]), main: { kind: 'web', state: 'ready', slug: 'o/r', branch: 'main', sha: 'abcdef1', at: new Date(NOW).toISOString(), url: null, port: 8500, script: '.kickflip/build-web' } };
  const b = boardOnDom({ board: data, threads: {} });
  Object.assign(b.page.win.location, { protocol: 'http:', hostname: 'localhost', href: 'http://localhost:4500/' });
  await b.change({ board: { ...data, main: { ...data.main, sha: 'abcdef2' } } });
  assert.equal(b.root.querySelector('#tryMain a').getAttribute('href'), 'http://127.0.0.1:8500/');
});

test('main paints above the lanes, card failures scroll to their thread and main failures open a log and retry sheet', async () => {
  const data = { ...boardOf([workCard('R1', { try: { kind: 'web', state: 'failed', script: true, changes: true } })]), main: { kind: 'web', state: 'ready', slug: 'o/r', branch: 'main', sha: 'abcdef1', at: new Date(NOW).toISOString(), url: null, port: 8500, script: '.kickflip/build-web' } };
  const b = boardOnDom({ open: ['w/R1'], board: data, threads: {} });
  await b.settle();
  assert.equal(b.root.querySelector('#tryMain a').getAttribute('href'), 'https://mac.ts.net:8500/');
  assert.match(b.root.querySelector('#tryMain').textContent, /o\/rmain@abcdef1.*Visit/);
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

  // docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md: a failing main's log lines ride the board, so the sheet
  // paints them at once and asks for nothing.
  const failed = { ...data, main: { ...data.main, state: 'failed', log: ['<script>bad & worse</script>', 'stopped'] } };
  await b.change({ board: failed });
  const original = b.page.win.fetch;
  const posts = [];
  let refusal = 'Try builds wait on Tailscale: Tailscale isn’t signed in';
  let resolvePost;
  let logReads = 0;
  let holdBoard = false;
  let releaseBoard;
  b.page.win.fetch = async (url, opts = {}) => {
    if (url.endsWith('/api/try/main/log')) logReads++;
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
  const sheet = b.root.querySelector('#mainLogSheet');
  const retry = b.root.querySelector('#mainLogRetry');
  assert.equal(sheet.open, true);
  assert.match(b.root.querySelector('#mainLogLines').innerHTML, /&lt;script&gt;bad &amp; worse&lt;\/script&gt;/, 'drawn in the same tick as the tap');
  await b.settle();
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
  assert.equal(retry.disabled, true);
  holdBoard = true;
  const staleLoad = b.view.B.loadBoard();
  await b.settle();
  await b.change({ board: { ...failed, main: { ...failed.main, state: 'running' } } });
  resolvePost();
  await b.settle();
  releaseBoard();
  await staleLoad;
  assert.equal(retry.disabled, true);
  await b.change({ board: { ...failed, main: { ...failed.main, log: ['new failure'] } } });
  assert.equal(b.root.querySelector('#mainLogLines').textContent, 'new failure');
  assert.deepEqual([retry.disabled, retry.getAttribute('aria-busy')], [false, null]);
  assert.equal(logReads, 0, 'the sheet never asks for the log');

  b.page.fire(retry, 'click');
  await b.settle();
  await b.change({ board: { ...failed, main: { ...failed.main, state: 'running' } } });
  resolvePost();
  await b.settle();
  await b.change({ board: data });
  b.page.runTimers(180);
  assert.equal(sheet.open, false);
  assert.match(b.root.textContent, /Main is up again at abcdef1/);
  await b.change({ board: { ...failed, main: { ...failed.main, kind: 'app', log: [] } } });
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
  assert.equal(why().popoverOpen, true, 'the open reason is a popup');
  b.page.fire(b.page.win.document, 'click', { target: b.root.querySelector('#lanes') });
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

// docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md: the bump sits in the card's "…" menu.
test("every bumpable card, closed or open, carries the \"…\" at its top right and no bump in its button rows; its menu's Bump sends card-bump with no confirm, and on a bumped card the \"…\" is filled and the menu's Unbump sends card-unbump", async () => {
  const cards = [
    workCard('T1', { bumpable: true, bumpedAt: '2026-10-30T09:00:00.000Z' }),
    workCard('T2', { bumpable: true, bumpedAt: '2026-10-30T08:00:00.000Z' }),
    workCard('T3', { bumpable: true, holdable: true }),
    workCard('P1', { lane: 'progress', bumpable: true, bumpedAt: '2026-10-30T07:00:00.000Z', holdable: true }),
    workCard('H1', { bumpable: false, ownerBlock: { until: null }, holdable: true }),
  ];
  const b = boardOnDom({ open: ['w/T1', 'w/T3', 'w/H1'], board: boardOf(cards), threads: {}, confirm: true });
  await b.settle();
  const card = (key) => b.root.querySelector(`details.item[data-key="${key}"]`);
  const more = (key) => card(key).querySelector('summary .ask-actions button[data-card-menu]');
  const icon = (key) => bumpItem(b, key);
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.key, more(c.key) ? [icon(c.key).textContent, more(c.key).classList.contains('bumped')] : null])), {
    'w/T1': ['Unbump', true], 'w/T2': ['Unbump', true], 'w/T3': ['Bump', false], 'w/P1': ['Unbump', true], 'w/H1': null,
  });
  for (const key of ['w/T1', 'w/T3', 'w/H1']) assert.equal(card(key).querySelector('.detail .actions [data-card-bump]'), null, key);
  assert.deepEqual(['w/T1', 'w/T3'].map((key) => card(key).querySelector('.detail .action-row.workflow')?.textContent.trim() ?? null), [null, 'Block']);

  b.page.fire(b.root, 'click', { target: icon('w/T3') });
  await b.settle();
  b.page.fire(b.root, 'click', { target: icon('w/T2') });
  await b.settle();
  assert.deepEqual(b.confirms, []);
  assert.deepEqual(sentNoIds(b), [['card-bump', { key: 'w/T3' }], ['card-unbump', { key: 'w/T2' }]]);
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
// docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md: a card's Bump or Unbump, in its "…" menu,
// which this opens unless it is open on the card already.
function bumpItem(b, key) {
  const menu = b.root.querySelector('#cardMenu');
  if (menu.hidden || menu.dataset.key !== key) b.page.fire(b.root, 'click', { target: b.root.querySelector(`details.item[data-key="${key}"] button[data-card-menu]`) });
  return menu.querySelector('button[data-card-bump]');
}
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

// docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md
// docs/adr/2026-11-17-1335-a-sending-card-button-spins-and-the-lane-waits-for-the-board.md,
// docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md
test("a bump or unbump goes through the card's outbox: its menu item is disabled and the card keeps its icon and place, and its line reads sending… in the card's thread until the POST's board moves the card with no reload of its own; a refusal reads not sent with Retry and X, and brings the menu item back", async () => {
  const T1 = workCard('T1', { bumpable: true, bumpedAt: '2026-10-30T09:00:00.000Z', sortAt: '2026-10-01T00:00:00.000Z', order: 0 });
  const T2 = workCard('T2', { bumpable: true, sortAt: '2026-10-03T00:00:00.000Z', order: 1 });
  const T3 = workCard('T3', { bumpable: true, sortAt: '2026-10-02T00:00:00.000Z', order: 2 });
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1', 'w/T3'], board: boardOf([T1, T2, T3]), threads: { 'w/T1': [], 'w/T3': [] }, send: sends.send, confirm: true });
  await b.settle();
  const order = () => b.root.querySelectorAll('.lane[data-lane="todo"] details.item').map((el) => el.dataset.key);
  // The card's "…", filled while bumped (docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md).
  const icon = (key) => b.root.querySelector(`details.item[data-key="${key}"] button[data-card-menu]`);
  const rows = () => ['w/T3', 'w/T1'].flatMap((key) => threadLines(b, key).filter((line) => / · (sending…|not sent)/.test(line)).map((line) => `${key} ${line}`));
  assert.deepEqual(order(), ['w/T1', 'w/T2', 'w/T3']);

  b.page.fire(b.root, 'click', { target: bumpItem(b, 'w/T3') });
  await b.settle();
  assert.deepEqual([order(), icon('w/T3').classList.contains('bumped'), rows()], [['w/T1', 'w/T2', 'w/T3'], false, ['w/T3 Moved to the top · sending…']]);
  assert.equal(b.root.querySelectorAll('#newStrip .new-entry[data-send]').length, 0, 'no New strip row');
  assert.deepEqual(waitState(bumpItem(b, 'w/T3')), [true, false, null]);
  b.page.fire(b.root, 'click', { target: icon('w/T3') });
  const loads = boardGets(b);
  b.server.board = boardOf([{ ...T3, bumpedAt: '2026-10-30T10:00:00.000Z' }, T1, T2]);
  sends.answer();
  await b.settle();
  assert.deepEqual([order(), icon('w/T3').classList.contains('bumped'), rows()], [['w/T3', 'w/T1', 'w/T2'], true, []]);
  assert.equal(boardGets(b), loads);

  b.page.fire(b.root, 'click', { target: bumpItem(b, 'w/T1') });
  await b.settle();
  assert.deepEqual([waitState(icon('w/T1')), icon('w/T1').classList.contains('bumped')], [IDLE, true]);
  sends.answer(false, 'Couldn’t write the event: the board folder is read-only.');
  await b.settle();
  assert.deepEqual([order(), icon('w/T1').classList.contains('bumped'), rows()], [['w/T3', 'w/T1', 'w/T2'], true, ['w/T1 Unbumped · not sent']]);
  assert.deepEqual(waitState(bumpItem(b, 'w/T1')), IDLE, 'a send that failed brings the menu item back');
  b.page.fire(b.root, 'click', { target: icon('w/T1') });
  assert.match(b.root.textContent, /Couldn’t write the event: the board folder is read-only\./);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-thread="w/T1"] button[data-unsend]') });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), icon('w/T1').classList.contains('bumped'), rows()], ['Dismiss “Unbumped”?', true, []]);
  assert.deepEqual(sentNoIds(b), [['card-bump', { key: 'w/T3' }], ['card-unbump', { key: 'w/T1' }]]);
  b.view.unmount();
});

// docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md
const newAsk = (id, at, state = 'waiting', text = `Task ${id}`) => ({ ...askCard(id, 'todo'), isNew: true, created: at, sortAt: at, ask: { eventId: id, state, text, canEdit: true } });
test("a sent ask sits in the New strip above the lanes, never in Todo, reading waiting… then thinking…; once ingested it links to its ticket or the card it was added to, with Dismiss in place of Edit and Delete, until it is dismissed or that card is read", async () => {
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
  assert.deepEqual([strip().querySelector('summary .lane-name').textContent, strip().querySelector('summary .count').textContent], ['New', '4']);
  assert.deepEqual(entries().map((el) => el.dataset.new), ['a3', 'a1', 'a2', 'a4']);
  assert.deepEqual(entries().map((el) => el.querySelector('.new-msg').textContent), ['Rate limits per API key', 'Fix the header\nIt jumps on scroll', 'Dark mode', 'Also the footer\nand the nav']);
  assert.deepEqual(entries().map((el) => el.querySelector('.new-line').textContent.trim().replace(/^.*?\d{1,2}:\d{2}\s?[AP]M · /i, '')), ['Ticket created: T-7', 'waiting…', 'thinking…', 'Added to T-2']);
  assert.equal(entry('a1').querySelector('.new-line .pickup-wait').dataset.word, 'waiting…', 'grey, its dot still, counting up in place');
  assert.equal(b.root.querySelector('#lanes [data-key="w/a1"], #lanes [data-key="w/a2"]'), null);
  assert.deepEqual(b.root.querySelectorAll('.lane[data-lane="todo"] details.item').map((el) => el.dataset.key), ['w/T-7', 'w/T-8', 'w/T-2']);
  // Waiting and thinking entries delete their ask and have no Edit; ingested ones link to the card and dismiss.
  assert.deepEqual(['a1', 'a2'].map((id) => [entry(id).querySelector('button[data-edit]'), entry(id).querySelector('button[data-withdraw]')?.dataset.withdraw, entry(id).querySelector('[data-dismiss-new]')]), [[null, 'a1', null], [null, 'a2', null]]);
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

// docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md
// docs/adr/2026-11-16-0946-a-link-onto-a-card-awaiting-a-reply-needs-that-reply-first.md
test("a link to a task still in New opens its row in the New strip, tinted, and opens no card; once triaged the same link opens its card", async () => {
  const b = boardOnDom({ board: boardOf([newAsk('a1', '2026-10-30T09:00:00.000Z'), workCard('T1')]), threads: {}, width: 1280 });
  await b.settle();
  const scrolled = [];
  b.root.constructor.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.dataset.new ? `new:${this.dataset.new}` : this.dataset.key); };
  const follow = async (hash) => { b.page.win.location.hash = hash; b.page.fire(vm.runInContext('window', b.page.win), 'hashchange'); await b.settle(); };
  await follow('#selectedCard=w%2Fa1');
  const row = b.root.querySelector('#newStrip .new-entry[data-new="a1"]');
  assert.deepEqual([scrolled, row.classList.contains('tint')], [['new:a1'], true]);
  assert.equal(JSON.parse(b.storage.get('site:board-a:openItems') || '[]').includes('w/a1'), false, 'no card opens for it');
  scrolled.length = 0;
  await b.change({ board: boardOf([{ ...newAsk('a1', '2026-10-30T09:00:00.000Z'), isNew: false, phase: 'grilling' }, workCard('T1')]) });
  await follow('#selectedCard=w%2FT1');
  await follow('#selectedCard=w%2Fa1');
  assert.deepEqual(scrolled, ['w/T1', 'w/a1']);
  b.view.unmount();
});

test('a New task waiting for pick-up counts its waiting… up from when it was asked, through the shared duration', async () => {
  const askedAt = new Date(NOW - 12 * 60000 - 5000).toISOString();
  const waiting = newAsk('a1', askedAt);
  waiting.ask.askedAt = askedAt;
  const b = boardOnDom({ board: boardOf([waiting]), seen: {}, threads: {}, width: 1280 });
  await b.settle();
  const status = b.root.querySelector('#newStrip .new-entry[data-new="a1"] .pickup-wait');
  assert.equal(status.textContent.trim(), 'waiting… (12m)');
  assert.equal(status.dataset.since, askedAt);
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

test("deleting an ask from the New strip is one events POST through the outbox: its trash icon never waits, a row reads sending… until the POST's board drops the entry; a refusal keeps the entry, reads not sent and toasts the reason", async () => {
  const a1 = newAsk('a1', '2026-10-30T09:00:00.000Z');
  const a2 = newAsk('a2', '2026-10-30T09:10:00.000Z');
  const sends = heldSends();
  const b = boardOnDom({ board: boardOf([a1, a2]), threads: {}, send: sends.send, confirm: true });
  await b.settle();
  const keys = () => b.root.querySelectorAll('#newStrip .new-entry[data-key]').map((el) => el.dataset.key);
  const trash = (id) => b.root.querySelector(`#newStrip .new-entry[data-new="${id}"] button[data-withdraw]`);
  const sending = () => b.root.querySelectorAll('#newStrip .new-entry[data-send]').map((el) => `${el.querySelector('.new-msg').textContent} · ${el.querySelector('.new-line').textContent.split(' · ').slice(1).join(' · ').trim()}`);
  b.page.fire(b.root, 'click', { target: trash('a1') });
  await b.settle();
  assert.deepEqual([keys(), waitState(trash('a1')), sending()], [['w/a1', 'w/a2'], IDLE, ['Deleted: Task a1 · sending…']]);
  b.server.board = boardOf([a2]);
  sends.answer();
  await b.settle();
  assert.deepEqual([keys(), sending()], [['w/a2'], []]);

  b.page.fire(b.root, 'click', { target: trash('a2') });
  await b.settle();
  sends.answer(false, 'Couldn’t write the event: the board folder is read-only.');
  await b.settle();
  assert.deepEqual([keys(), sending()], [['w/a2'], ['Deleted: Task a2 · not sent']]);
  assert.match(b.root.textContent, /the board folder is read-only/);
  assert.deepEqual(sentNoIds(b), [['ask-withdrawn', { id: 'a1', key: 'w/a1' }], ['ask-withdrawn', { id: 'a2', key: 'w/a2' }]]);
  assert.deepEqual(b.posts, [], 'nothing posts besides the one events POST');
  b.view.unmount();
});

// docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md: each tap on a card's face or action row, the
// card it sits on, the event it sends, and its line while unsent: a card tap's in its thread, a bump's in the New strip.
// Each one's button waiting while it sends is SENDING_TAPS's.
const HOLD_CHOICES = [{ value: '1h', label: '1h', ms: 3_600_000 }];
const CARD_TAPS = [
  { name: 'Unblock', card: workCard('H1', { ownerBlock: { until: null }, holdable: true }), act: 'resume', kind: 'card-hold', line: 'Unblocked' },
  { name: 'a Block sheet chip', card: workCard('T1', { holdable: true }), act: 'hold', sheet: true, kind: 'card-hold', line: 'Blocked' },
  { name: 'a bump', card: workCard('B1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 0 }), kind: 'card-bump', line: 'Moved to the top' },
  { name: 'Merge', card: workCard('M1', { lane: 'review', action: { kind: 'merge', url: '#selectedCard=w%2FM1', label: 'Merge' } }), act: 'merge', kind: 'card-merge', line: 'Merge requested' },
];

// A board holding the row's card open, its button tapped (and the Block sheet's chip after it), its POST held.
async function tapCard(row) {
  const sends = heldSends();
  const b = boardOnDom({ open: [row.card.key], board: { ...boardOf([row.card]), holdChoices: HOLD_CHOICES }, threads: {}, send: sends.send, confirm: true });
  await b.settle();
  const card = () => b.root.querySelector(`details.item[data-key="${row.card.key}"]`);
  const button = () => (row.act ? card().querySelector(`[data-confirm="${row.act}"]`) : bumpItem(b, row.card.key));
  const before = { label: button().textContent, lane: card().closest('.lane').dataset.lane };
  b.page.fire(b.root, 'click', { target: button() });
  if (row.sheet) b.page.fire(b.root.querySelector('#holdSheet'), 'click', { target: b.root.querySelector('#holdSheet [data-hold-for]') });
  await b.settle();
  return { b, sends, card, button, before };
}

for (const row of CARD_TAPS) {
  test(`${row.name} goes through the outbox: its line shows at once as sending… in its thread, the card staying where it was, and a refusal reads not sent and toasts the server's reason`, async () => {
    const { b, sends, card, before } = await tapCard(row);
    const lines = () => threadLines(b, row.card.key);
    assert.deepEqual([lines(), card().closest('.lane').dataset.lane], [[`${row.line} · sending…`], before.lane]);
    sends.answer(false, REFUSED);
    await b.settle();
    assert.deepEqual(lines(), [`${row.line} · not sent`]);
    assert.ok(b.root.textContent.includes(REFUSED));
    assert.deepEqual(JSON.parse(JSON.stringify(b.sent)).map(([kind]) => kind), [row.kind]);
    b.view.unmount();
  });
}

// docs/adr/2026-11-17-1335-a-sending-card-button-spins-and-the-lane-waits-for-the-board.md, as
// docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md amends it: every card button
// that sends is disabled, with no spinner (ui.js SENDING), while its tap is in the outbox, its thread shows the tap's line
// with the one spinner, the card stays in its lane, open as it was, and the Action needed that tap resolves clears at
// once; a refused tap (409) brings both back.
const CLOSE = { kind: 'close', url: '#selectedCard=w%2FR1', label: 'Done' };
const SENDING_TAPS = [
  { name: "the thread box's Done", card: workCard('R1', { lane: 'review', finishable: true, action: CLOSE, resolvedBy: 'done', awaitsDone: true }), button: 'form[data-reply] [data-confirm="finish"]', submit: true, clears: true },
  { name: "the ticket actions' Done", card: workCard('R1', { lane: 'review', finishable: true, action: CLOSE, resolvedBy: 'done', awaitsDone: true }), button: '.detail .actions [data-confirm="finish"]', clears: true },
  { name: 'the owner check', card: workCard('R1', { lane: 'review', finishable: true, ownerStep: 'Deploy it', action: CLOSE, resolvedBy: 'done', awaitsDone: true }), button: '.owner-done', clears: true },
  { name: 'Implement', card: workCard('T1', { action: { kind: 'implement', url: '#selectedCard=w%2FT1', label: 'Implement' }, resolvedBy: 'implement' }), button: 'form[data-reply] [data-intent="build"]', submit: true, clears: true },
  { name: 'Cancel', card: workCard('S1', { staging: true }), button: 'form[data-reply] [data-confirm="cancel"]', submit: true },
  { name: 'Block', card: workCard('P1', { lane: 'progress', holdable: true }), button: 'form[data-reply] [data-confirm="hold"]', submit: true, sheet: true },
  { name: 'Unblock', card: workCard('H1', { lane: 'progress', holdable: true, ownerBlock: { until: null }, blocked: true }), button: '.detail .actions [data-confirm="resume"]' },
  { name: 'Reopen', card: workCard('D1', { lane: 'done' }), button: 'form[data-reply] [data-confirm="reopen"]', submit: true },
  { name: 'Merge', card: workCard('M1', { lane: 'review', action: { kind: 'merge', url: '#selectedCard=w%2FM1', label: 'Merge' }, resolvedBy: 'merge' }), button: '[data-confirm="merge"]', clears: true },
  { name: 'Bump', card: workCard('B1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 1 }), bump: true },
  ...[['Prototype', 'proto'], ['Grill', 'grill'], ['Visual', 'visual'], ['Review', 'review']].map(([name, attr]) => ({ name, card: workCard('A1'), button: `form[data-reply] button[data-${attr}]` })),
];
const PENDING = [true, false, null];
for (const row of SENDING_TAPS) {
  test(`${row.name} is disabled, not spinning, while its tap's line sends in its thread, its card staying in its lane${row.clears ? ' with its Action needed cleared' : ''}, and a refused tap (409) brings the button back`, async () => {
    let refuse;
    const send = () => new Promise((resolve, reject) => { refuse = () => reject(Object.assign(new Error('send failed: 409'), { status: 409, reason: 'It moved on.' })); });
    const other = workCard('Z9', { lane: row.card.lane, bumpable: true, sortAt: '2026-09-01T00:00:00.000Z', order: 0 });
    const cards = [other, row.card];
    const b = boardOnDom({ open: [row.card.key], board: { ...boardOf(cards), holdChoices: HOLD_CHOICES }, threads: { [row.card.key]: [] }, send, confirm: true });
    await b.settle();
    const card = () => b.root.querySelector(`details.item[data-key="${row.card.key}"]`);
    const button = () => (row.bump ? bumpItem(b, row.card.key) : card().querySelector(row.button));
    const face = () => [card().closest('.lane').dataset.lane, card().open, b.root.querySelectorAll('details.item').map((el) => el.dataset.key), Boolean(card().querySelector('.card-action'))];
    const before = face();
    assert.deepEqual(waitState(button()), IDLE);
    const tapped = button();
    if (row.submit) b.page.fire(b.root, 'submit', { target: tapped.closest('form'), submitter: tapped });
    else b.page.fire(b.root, 'click', { target: tapped });
    if (row.sheet) b.page.fire(b.root.querySelector('#holdSheet'), 'click', { target: b.root.querySelector('#holdSheet [data-hold-for]') });
    await b.settle();
    assert.equal(b.sent.length, 1);
    assert.deepEqual(waitState(button()), PENDING, 'the button is disabled, with no spinner');
    assert.equal(button().outerHTML.includes('try-spin'), false);
    assert.deepEqual(card().querySelectorAll('.thread .msg[data-send]').map((el) => el.querySelectorAll('.try-spin').length), [1], "the tap's one sending line, with its one spinner");
    assert.deepEqual(face(), [...before.slice(0, 3), row.clears ? false : before[3]], 'the card keeps its lane, open state and place');
    refuse();
    await b.settle();
    assert.deepEqual(waitState(button()), IDLE, 'a refused tap brings the button back');
    assert.deepEqual(face(), before);
    b.view.unmount();
  });
}


// docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md
test("a Merge tap stays disabled, with no spinner, until a board shows the card left In Review or the merge refused, with no idle Merge in between, even when a reload races the POST", async () => {
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
  const BUSY = [true, null];
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
  assert.deepEqual(busy('M1'), BUSY, 'a board from before the tap keeps it disabled');
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
// docs/adr/2026-11-14-2350-a-new-task-shows-at-once-in-the-new-strip-as-sending.md
test("a thread's Reply and the New task box's buttons never wait: each send shows at once and its button is free for the next", async () => {
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

  const askSend = await askTap(b, 'A new task', 'quick');
  assert.deepEqual(waitState(askSend), IDLE);
  sends.answer();
  await b.settle();
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
  assert.deepEqual(sentNoIds(b), [['card-done', { key: 'w/D1' }]]);
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

test("every text box on a board the owner sends from, the new task and a thread reply, takes attachments the same way", async () => {
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1'), newAsk('a1', '2026-10-30T09:00:00.000Z', 'waiting', 'Fix the header')]), threads: { 'w/T1': [] } });
  await b.settle();
  assert.equal(b.root.querySelector('#newStrip button[data-edit], #newStrip .edit-form'), null, 'a New ask has no Edit');
  assert.deepEqual([b.root.querySelector('#askForm'), b.root.querySelector('form[data-reply="w/T1"]')].map(composerParts), [EVERY_PART, EVERY_PART]);
  b.view.unmount();
});

test("a question's note in the questions sheet takes attachments the same way as the board's text boxes", async () => {
  const question = { id: 'q1', topic: 'item:w/T1', source: '', question: 'Question?', context: '', options: [{ id: 'A', label: 'Yes' }], answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question], at: 'q1' });
  await v.settle();
  assert.deepEqual(composerParts(v.root.querySelector('section.q[data-q="q1"] [data-composer="q:q1"]')), EVERY_PART);
  v.unmount();
});

test("the questions sheet names a card's topic from its card, since the board sends that topic with no title", async () => {
  const question = { id: 'q1', topic: 'item:w/T1', source: '', question: 'Question?', context: '', options: [{ id: 'A', label: 'Yes' }], answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', card: 'w/T1' }], items: [workCard('T1', { ref: 'INT-1', title: 'Search' })], questions: [question], at: 'q1' });
  await v.settle();
  assert.equal(v.sheet().querySelector('.reader-ref').textContent, 'INT-1 · Search');
  v.unmount();
});

test('Block opens a sheet of the shared duration picker in place of a confirm, whose chip sends card-hold with that choice, and Unblock confirms naming the time', async () => {
  const until = new Date(NOW + 2 * 86_400_000).toISOString();
  const holdChoices = [['1h', '1h', 3_600_000], ['3h', '3h', 10_800_000], ['6h', '6h', 21_600_000], ['1d', '1d', 86_400_000], ['forever', 'Forever', null]].map(([value, label, ms]) => ({ value, label, ms }));
  const cards = [workCard('T1', { ref: 'INT-41', holdable: true }), workCard('P1', { ref: 'INT-43', lane: 'progress', holdable: true }), workCard('H1', { ref: 'INT-42', ownerBlock: { until }, holdable: true })];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: { ...boardOf(cards), holdChoices }, threads: {}, confirm: true });
  await b.settle();
  const button = (key, act) => b.root.querySelector(`details.item[data-key="${key}"] [data-confirm="${act}"]`);
  const sheet = b.root.querySelector('#holdSheet');
  b.page.fire(b.root, 'click', { target: button('w/P1', 'hold') });
  await b.settle();
  assert.deepEqual([sheet.open, sheet.querySelector('#holdTitle').textContent, sheet.querySelector('#holdLede').textContent],
    [true, 'Block INT-43', 'Claude stops work on it until then. Forever blocks it until you unblock it.']);
  b.page.fire(sheet.querySelector('#holdClose'), 'click');
  b.page.runTimers();
  assert.equal(sheet.open, false);
  b.page.fire(b.root, 'click', { target: button('w/T1', 'hold') });
  await b.settle();
  assert.deepEqual(b.confirms, []);
  assert.deepEqual([sheet.open, sheet.querySelector('#holdTitle').textContent, sheet.querySelector('#holdLede').textContent],
    [true, 'Block INT-41', 'It won’t start until then. Forever blocks it until you unblock it.']);
  const chips = sheet.querySelectorAll('[data-hold-for]');
  // The page words each chip's end from its length when the sheet opens.
  const words = (ms) => (ms === null ? 'until you unblock it' : `until ${b.page.win.BoardUI.heldUntilWords(new Date(NOW + ms))}`);
  assert.deepEqual(chips.map((c) => [c.textContent, c.getAttribute('aria-label')]), holdChoices.map((c) => [c.label, `${c.label}, ${words(c.ms)}`]));
  assert.ok(sheet.querySelector('.dur-custom [data-hold-at]'));
  b.page.fire(sheet, 'click', { target: chips[1] });
  await b.settle();
  b.page.runTimers();
  assert.equal(sheet.open, false);
  assert.deepEqual(sentNoIds(b), [['card-hold', { key: 'w/T1', hold: true, for: '3h' }]]);
  b.page.fire(b.root, 'click', { target: button('w/H1', 'resume') });
  await b.settle();
  assert.deepEqual(b.confirms, [`Unblock INT-42? It's blocked until ${b.page.win.BoardUI.heldUntilWords(until)}. It can start again once nothing else blocks it.`]);
  assert.deepEqual(sentNoIds(b).at(-1), ['card-hold', { key: 'w/H1', hold: false }]);
});

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
test("a stale card's status line is no button, closed or open, and a stalled card's Send is the orange control that clears its Action needed", async () => {
  for (const open of [[], ['w/S1']]) {
    const item = workCard('S1', { lane: 'progress', stale: true, builder: { stale: true, progress: 'Running tests', words: 'Running tests', at: null } });
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
      { id: 'Z', title: 'Script', lane: 'progress' },
    ] } }],
    threads: { 'w/Z': [{ ts: '2026-10-30T09:00:00Z', who: 'claude', text: 'Kills the stuck builder.', script: { id: 's1', body: 'kill 1', sha: 'abc', host: 'mac', user: 'love' } }] },
  });
  assert.deepEqual(built.items.filter((i) => i.action).map((i) => i.action.kind).sort(), Object.values(ACTION_KIND).sort());
  for (const i of built.items) {
    assert.ok(i.actionButton === null || Object.values(BUTTON).includes(i.actionButton), i.key);
    assert.ok(Object.values(BUTTON).includes(i.resolvedBy) === Boolean(i.action), i.key);
  }

  const mounted = async (items) => {
    const b = boardOnDom({ open: items.map((i) => i.key), board: { ...built, items, title: 'A', generatedAt: '2026-10-30T10:00:00.000Z' }, threads: { 'w/Z': built.threadViews['w/Z'] } });
    await b.settle();
    const row = (key) => b.root.querySelector(`details.item[data-key="${key}"] .detail`);
    const counts = Object.fromEntries(items.map((i) => [i.key, [row(i.key)?.querySelectorAll('.action-row.workflow a, .action-row.workflow button').length ?? 0, row(i.key)?.querySelectorAll('.actions .resolves, .external-links .resolves, form[data-reply] .resolves, [data-thread] .script-run.resolves').length ?? 0]]));
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

// docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md
test("a script offer's Run sends only after a full hold, naming the script and its sha; letting go sooner sends nothing, and Decline confirms first", async () => {
  const offer = { ts: '2026-11-13T10:00:00Z', who: 'claude', text: 'Kills the stuck builder.', script: { id: 's1', body: 'kill 1', sha: 'abc', host: 'mac', user: 'love', state: 'waiting' } };
  const b = boardOnDom({ open: ['w/Z'], board: boardOf([workCard('Z', { lane: 'progress' })]), threads: { 'w/Z': [offer] } });
  await b.settle();
  const run = () => b.root.querySelector('[data-thread="w/Z"] button[data-script-run]');
  b.page.fire(b.root, 'pointerdown', { target: run(), button: 0 });
  assert.equal(run().classList.contains('holding'), true);
  b.page.fire(b.page.win.document, 'pointerup', { target: run() });
  b.page.runTimers(900);
  await b.settle();
  assert.deepEqual([b.sent, run().classList.contains('holding')], [[], false]);

  b.page.fire(b.root, 'pointerdown', { target: run(), button: 0 });
  b.page.runTimers(900);
  await b.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)), [['script-run', { key: 'w/Z', id: 's1', sha: 'abc' }]]);

  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-thread="w/Z"] button[data-script-decline]'), detail: 1 });
  await b.settle();
  assert.deepEqual([b.confirms, b.sent.length], [['Decline this script? Nothing runs.'], 1]);
  b.view.unmount();
});

// docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md: a card tap that doesn't go
// through the outbox (a script's Run or Decline, a Serve or Kill) shows its line in the card's thread, sending… with the
// one spinner, while its request is out, and its button is disabled with no spinner of its own.
test("a script's Run and Decline and a card's Serve and Kill each show their sending… line in the thread while their button is disabled, not spinning", async () => {
  const offer = { ts: '2026-11-13T10:00:00Z', who: 'claude', text: 'Kills the stuck builder.', script: { id: 's1', body: 'kill 1', sha: 'abc', host: 'mac', user: 'love', state: 'waiting' } };
  const sends = heldSends();
  const card = workCard('Z', { lane: 'progress', holdable: true, try: { kind: 'web', script: true, changes: true } });
  const b = boardOnDom({ open: ['w/Z'], board: boardOf([card]), threads: { 'w/Z': [offer] }, send: sends.send, confirm: true });
  await b.settle();
  const thread = () => b.root.querySelector('[data-thread="w/Z"]');
  const sending = () => thread().querySelectorAll('.msg[data-send]').map((el) => [el.textContent.split(' · ')[0].trim(), el.querySelectorAll('.try-spin').length]);
  const quiet = (button) => [button.disabled, button.getAttribute('aria-busy'), button.outerHTML.includes('try-spin')];
  b.page.fire(b.root, 'click', { target: thread().querySelector('button[data-script-run]'), detail: 0 });
  await b.settle();
  assert.deepEqual(sending(), [['Ran the script', 1]]);
  assert.deepEqual(quiet(thread().querySelector('button[data-script-run]')), [true, null, false]);
  sends.answer();
  await b.settle();
  assert.deepEqual(sending(), []);
  b.page.fire(b.root, 'click', { target: thread().querySelector('button[data-script-decline]'), detail: 1 });
  await b.settle();
  assert.deepEqual(sending(), [['Declined the script', 1]]);
  assert.deepEqual(quiet(thread().querySelector('button[data-script-decline]')), [true, null, false]);
  sends.answer();
  await b.settle();

  const original = b.page.win.fetch;
  let answer;
  b.page.win.fetch = (url, opts = {}) => (/\/api\/try(\/kill)?$/.test(url) ? new Promise((resolve) => { answer = () => resolve({ ok: true, json: async () => ({ status: 'started' }) }); }) : original(url, opts));
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-try]') });
  await b.settle();
  assert.deepEqual(sending(), [['Serve started', 1]]);
  assert.deepEqual(quiet(b.root.querySelector('[data-try]')), [true, null, false]);
  answer();
  await b.change({ board: boardOf([{ ...card, try: { ...card.try, state: 'ready', port: 8500 } }]) });
  assert.deepEqual(sending(), []);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-try-kill]') });
  await b.settle();
  assert.deepEqual(sending(), [['Serve killed', 1]]);
  assert.deepEqual(quiet(b.root.querySelector('[data-try-kill]')), [true, null, false]);
  answer();
  await b.settle();
  b.view.unmount();
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
    board: boardOf([workCard('A1', { othersAt: [at(5), at(6)] }), workCard('A2', { othersAt: [at(5)], ownerBlock: { until: null }, sortAt: at(6) })]) });
  await b.settle();
  const card = (key) => b.root.querySelector(`details.item[data-key="${key}"]`);
  const chips = (key) => card(key).querySelector('summary .line2')?.children.map((c) => c.textContent) ?? null;
  const last = (key) => card(key).querySelector('summary .card-time')?.textContent ?? null;
  const alert = (key) => card(key).querySelector('summary .card-alert')?.textContent ?? null;
  const time = b.page.win.BoardUI.cardTime(at(6));
  assert.deepEqual([chips('w/A1'), alert('w/A1'), chips('w/A2'), last('w/A2'), alert('w/A2')], [null, '2 new messages', null, `${time} · blocked`, '1 new message']);
  for (const key of ['w/A1', 'w/A2']) { card(key).open = true; b.page.fire(b.root, 'toggle', { target: card(key) }); }
  await b.settle();
  assert.deepEqual([alert('w/A1'), alert('w/A2'), last('w/A2')], [null, null, `${time} · blocked`]);
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

  await b.change({ board: boardOf([askCard('d1', 'review'), askCard('a1', 'progress'), askCard('b1', 'done'), askCard('c1', 'todo')]) });
  assert.deepEqual([lane('d1'), lane('a1'), lane('b1')], ['review', 'progress', 'done']);
  assert.deepEqual(kept(), [true, 'Half a reply', 4, 6, true, 0, boxTop]);
  assert.equal(b.root.querySelector('#askText').value, 'A new task');

  ta.blur();
  const TITLE = 'details.item[data-key="w/a1"] > summary';
  const titleTop = top(TITLE);
  await b.change({ board: boardOf([askCard('e1', 'review'), askCard('d1', 'review'), askCard('a1', 'progress'), askCard('b1', 'done'), askCard('c1', 'todo')]) });
  assert.deepEqual([lane('e1'), top(TITLE)], ['review', titleTop]);
});

test("with nothing open and no box focused, a card leaving a lane above the screen leaves the cards on screen where they were, skipping a card that moved itself", async () => {
  const b = boardOnDom({ board: boardOf([askCard('r1', 'review'), askCard('r2', 'review'), askCard('p1', 'progress'), askCard('p2', 'progress'), askCard('t1', 'todo')]), threads: {} });
  await b.settle();
  const view = layOut(b);
  const top = (id) => b.root.querySelector(`details.item[data-key="w/${id}"]`).getBoundingClientRect().top;
  view.scrollY = top('p1');
  const [p1, p2] = [top('p1'), top('p2')];
  await b.change({ board: boardOf([askCard('r2', 'review'), askCard('p1', 'progress'), askCard('p2', 'progress'), askCard('t1', 'todo'), askCard('r1', 'todo')]) });
  assert.deepEqual([top('p1'), top('p2')], [p1, p2]);
  assert.equal(view.scrolls.length, 1);

  // The first card on screen moves itself, so the next one anchors.
  const t1 = top('t1');
  await b.change({ board: boardOf([askCard('r2', 'review'), askCard('p2', 'progress'), askCard('t1', 'todo'), askCard('r1', 'todo'), askCard('p1', 'done')]) });
  assert.equal(top('t1'), t1);
});

// A block layout of the page: each element 2px tall, or its height in sizes, then its children below it; a closed
// details shows only its summary, and what it hides has an empty box at 0, as in a browser. scrollY scrolls it.
function flowOut(b, sizes = new Map()) {
  // The page's scroll is the window's, which the board reads.
  const view = { scrolls: [], get scrollY() { return b.page.win.scrollY; }, set scrollY(y) { b.page.win.scrollY = y; } };
  const boxes = () => {
    const out = new Map();
    let y = 0;
    const walk = (el) => {
      const top = y;
      y += sizes.get(el) ?? 2;
      const closed = el.matches('details') && !el.open;
      for (const c of el.children) if (!closed || c.matches('summary')) walk(c);
      out.set(el, { top, bottom: y });
    };
    walk(b.doc.body);
    return out;
  };
  Object.getPrototypeOf(b.root).getBoundingClientRect = function () {
    const r = boxes().get(this);
    return r ? { top: r.top - view.scrollY, bottom: r.bottom - view.scrollY } : { top: 0, bottom: 0 };
  };
  b.page.win.scrollBy = (x, y) => { view.scrolls.push(y); view.scrollY += y; };
  return view;
}

// docs/adr/2026-11-16-0916-the-topmost-card-on-screen-stays-put-through-any-reorder-or-resize.md
test("the topmost card on screen keeps its place through a filter change, a card below it changing lane, a size change above it and a card above it collapsing, and the page follows the only card on screen when it moves", async () => {
  const cards = [askCard('r1', 'review'), askCard('p1', 'progress'), askCard('p2', 'progress'), workCard('D1', { phase: 'discussing', blocked: true }), workCard('R1', { phase: 'ready', ready: true }), workCard('R2', { phase: 'ready', ready: true })];
  const b = boardOnDom({ open: ['w/r1'], board: boardOf(cards), threads: {} });
  await b.settle();
  const sizes = new Map();
  const view = flowOut(b, sizes);
  const card = (id) => b.root.querySelector(`details.item[data-key="w/${id}"]`);
  const top = (id) => card(id).getBoundingClientRect().top;
  const scrollTo = (id) => { view.scrollY += top(id); b.page.fire(vm.runInContext('window', b.page.win), 'scroll'); };
  const tap = async (el) => { b.page.fire(b.root, 'click', { target: el }); await b.settle(); };

  // The filter hides a Todo card above the one at the top of the screen. The header's menu opens over the page, which
  // this layout lays out in the flow, so the anchor is taken once it is open.
  await tap(b.root.querySelector('button.board-filter'));
  scrollTo('R1');
  let at = top('R1');
  await tap(b.root.querySelector('[data-board-filter="blocked"]'));
  assert.equal(card('D1'), null);
  assert.equal(top('R1'), at, 'a filter change');

  // A card below the top one changes lane, and one above it does: the top card holds.
  scrollTo('p1');
  at = top('p1');
  await b.change({ board: boardOf([askCard('r1', 'review'), askCard('p2', 'review'), askCard('p1', 'progress'), cards[3], cards[4], cards[5]]) });
  assert.equal(top('p1'), at, 'a card below it changing lane');

  // A size change above the top card outside a render, such as an image loading in the open card above it.
  // A scroll event that scrolled nothing, arriving between the change and the resize, keeps the anchor.
  sizes.set(card('r1').querySelector('summary'), 40);
  b.page.fire(vm.runInContext('window', b.page.win), 'scroll');
  b.page.resized();
  assert.equal(top('p1'), at, 'a size change above');

  // The open card above it collapses.
  card('r1').open = false;
  b.page.resized();
  assert.equal(top('p1'), at, 'a card above collapsing');

  // The owner's own scroll takes a new anchor, which the next resize keeps.
  scrollTo('R1');
  at = top('R1');
  sizes.set(card('p2').querySelector('summary'), 30);
  b.page.resized();
  assert.equal(top('R1'), at, 'a scroll re-takes the anchor');

  // With one card on screen, the page follows it when it moves.
  b.page.win.innerHeight = 3;
  scrollTo('p1');
  at = top('p1');
  await b.change({ board: boardOf([askCard('r1', 'review'), askCard('p2', 'review'), askCard('p1', 'todo'), cards[3], cards[4], cards[5]]) });
  assert.equal(card('p1').closest('details.lane').dataset.lane, 'todo');
  assert.equal(top('p1'), at, 'the only card on screen moving');
});

test("a lane or card opening or shutting by a tap leaves its title where it was, even when it hides the top card, and a fold opening upward in a thread keeps its reply box in place through the resize that follows", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const run = (n) => ({ ts: at(n), who: 'claude', kind: 'status', run: 'r1', agent: 'Builder', text: `Step ${n}` });
  const msgs = [{ ts: at(0), who: 'claude', text: 'One' }, run(1), run(2), run(3), { ts: at(4), who: 'claude', text: 'Two' }];
  const b = boardOnDom({ open: ['w/p1'], board: boardOf([askCard('r1', 'review'), askCard('r2', 'review'), askCard('p1', 'progress')]), threads: { 'w/p1': msgs } });
  await b.settle();
  const view = flowOut(b);
  const top = (el) => el.getBoundingClientRect().top;
  const lane = b.root.querySelector('details.lane[data-lane="review"]');
  view.scrollY = top(lane);
  b.page.fire(vm.runInContext('window', b.page.win), 'scroll');
  // The lane holding the top card shuts, and opens again: its title stays where it was tapped.
  const laneAt = top(lane);
  b.page.fire(b.root, 'click', { target: lane.querySelector('summary') });
  lane.open = false;
  b.page.resized();
  assert.equal(top(lane), laneAt);
  lane.open = true;
  b.page.resized();
  assert.equal(top(lane), laneAt);
  const r2 = b.root.querySelector('details.item[data-key="w/r2"]');
  const r2At = top(r2);
  b.page.fire(b.root, 'click', { target: r2.querySelector('summary') });
  r2.open = true;
  b.page.resized();
  assert.equal(top(r2), r2At);

  // holdBelow scrolls the page so the reply box stays: the resize after it holds that, not the card above.
  const box = () => b.root.querySelector('form[data-reply="w/p1"] textarea');
  const fold = b.root.querySelector('[data-thread="w/p1"] details.status-fold');
  const boxAt = top(box());
  b.page.fire(b.root, 'click', { target: fold.querySelector('summary') });
  assert.equal(fold.open, true);
  assert.equal(top(box()), boxAt);
  b.page.resized();
  assert.equal(top(box()), boxAt);
});

test("Done closes the card as the board moves it to Done and holds the cards still on screen, unflashed, and the owner's reply leaves its card untinted, while a card another hand moves flashes once, and a card another hand updates takes the tint in its place", async () => {
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
  // The tap's thread line grows the open card first, and the move then holds the cards that kept their lane still. layOut
  // counts 2px per element: the sending line's spinner is one element where its mark's icon was several (an svg and its
  // shapes), so the line is shorter here; the real .mark is a fixed 18x12 box, so the line's pixel height is the same.
  assert.deepEqual([card().closest('details.lane').dataset.lane, card().open, b.page.win.localStorage.getItem('site:board-a:openItems'), view.scrolls],
    ['done', false, '[]', [-92]]);
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

test("Done tapped with the card's thread field focused moves the card to Done closed and forgotten, where the page follows it", async () => {
  const board = boardOf([{ ...askCard('a1', 'review'), finishable: true }, workCard('C1')]);
  const b = boardOnDom({ open: ['w/a1'], board, threads: {}, confirm: true });
  await b.settle();
  layOut(b);
  const card = () => b.root.querySelector('details.item[data-key="w/a1"]');
  const field = card().querySelector('form[data-reply="w/a1"] textarea');
  b.page.win.document.activeElement = field;
  board.items[0] = { ...board.items[0], lane: 'done', finishable: false };
  b.page.fire(b.root, 'submit', { target: card().querySelector('form[data-reply="w/a1"]'), submitter: card().querySelector('form[data-reply="w/a1"] [data-confirm="finish"]') });
  await b.settle();
  await b.change({ board });
  assert.deepEqual([card().closest('details.lane').dataset.lane, card().open, b.page.win.localStorage.getItem('site:board-a:openItems')], ['done', false, '[]']);
});

// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
// The board with the owner's questions on topics, its questions sheet opened at `at` as a questions URL opens it
// (app-pane.js focusQuestion). server.questions answer as board/server.mjs records them; gate, once its promise settles,
// fails a send: gate.down with an error, gate.unreachable with no answer at all, gate.refuse with a 400 and its reason.
// stored: a browser's localStorage carried over from an earlier page, as a reload keeps it.
function questionsOnDom({ topics, questions, at = null, gate = null, items = [], stored = [] }) {
  const server = { questions: structuredClone(questions) };
  const ownerTopics = () => topics.map((t) => {
    const qs = server.questions.filter((q) => q.topic === t.id);
    const count = (s) => qs.filter((q) => q.state === s).length;
    return { ...t, state: qs.every((q) => q.state === 'resolved') ? 'resolved' : 'open', questions: qs.map((q) => q.id), open: count('open'), answered: count('answered'), resolved: count('resolved') };
  }).filter((t) => t.questions.length);
  // As board/server.mjs answers: /api/board leaves resolved questions out.
  const boardBody = () => ({ ...boardOf(items), owner: server.questions.filter((q) => q.state !== 'resolved'), ownerTopics: ownerTopics(), drafts: server.drafts ?? {} });
  const send = async (kind, data) => {
    const q = server.questions.find((x) => x.id === (data.id ?? data.question));
    await gate?.promise;
    if (gate?.down) throw Object.assign(new Error('send failed'), { status: 0 });
    if (gate?.unreachable) throw Object.assign(new TypeError('Failed to fetch'), { unreachable: true });
    if (gate?.refuse) throw Object.assign(new Error('send failed: 400'), { status: 400, reason: gate.refuse });
    // A question's prototype request is recorded, and reads requested; a grill or visual request leaves it open.
    if (kind === 'prototype-request') {
      Object.assign(q, { state: 'requested', request: { id: 'r1', ts: '2026-10-30T10:00:00.000Z', note: data.note, choice: data.choice } });
      topics.find((t) => t.id === q.topic).round = { n: (q.round || 0) + 1, state: 'making' };
      return { id: 'e1', board: structuredClone(boardBody()) };
    }
    if (kind !== 'owner-answers') return { id: 'g1', board: structuredClone(boardBody()) };
    // An owner-answers batch is recorded all or none.
    for (const a of data.answers) {
      const x = server.questions.find((y) => y.id === a.id);
      Object.assign(x, { state: 'answered' });
      x.answers.push({ ts: '2026-10-30T10:00:00.000Z', choice: a.choice, note: a.note, files: [], reply: null });
    }
    return { ids: data.answers.map((_, n) => `e${n}`), board: structuredClone(boardBody()) };
  };
  const b = boardOnDom({ board: boardBody(), threads: {}, send, stored });
  Object.defineProperty(b.server, 'board', { get: boardBody });
  // moves: the history entries the questions sheet pushes and spends.
  const moves = [];
  const { replaceState } = b.page.win.history;
  b.page.win.history = { state: { idx: 1 }, replaceState, pushState(state) { moves.push('push'); this.state = state; }, back() { moves.push('back'); } };
  b.page.win.BoardAttach.paintAll = () => {};
  const sheet = () => b.root.querySelector('#questionsSheet');
  const $ = (sel) => sheet().querySelector(sel);
  // open(id): the sheet of a question or a topic, as a Questions tap opens it.
  const open = async (id) => { b.view.B.openQuestionsSheet(id); await b.settle(); };
  const answer = (id) => {
    const input = $(`section.q[data-q="${id}"] input[value="A"]`);
    input.type = 'radio';
    b.page.fire(sheet(), 'change', { target: input });
  };
  const send_ = async () => { b.page.fire(sheet(), 'submit', { target: $('form') }); await b.settle(); };
  const questionsShown = () => (sheet()?.open ? sheet().querySelectorAll('section.q').map((s) => s.dataset.q) : []);
  const toast = () => b.page.win.document.body.querySelectorAll('.toast').at(-1)?.textContent;
  // The answers each owner-answers carried, each one's sendId read as whether it has one.
  const answersSent = () => JSON.parse(JSON.stringify(b.sent.filter(([kind]) => kind === 'owner-answers').map(([, d]) => d.answers.map(({ sendId, ...a }) => ({ ...a, sendId: typeof sendId })))));
  // A question's footer line in the sheet, its words.
  const footer = (id) => $(`section.q[data-q="${id}"] .sent-line`)?.textContent.replace(/·/g, ' · ').replace(/\s+/g, ' ').trim() ?? null;
  const settle = async () => {
    await b.settle();
    if (at !== null && b.view.B.focusQuestion(at)) at = null;
    await b.settle();
  };
  return { ...b, server, settle, open, answer, send: send_, questionsShown, toast, sheet, moves, answersSent, footer, unmount: () => b.view.unmount() };
}

// docs/adr/2026-11-18-1200-composer-drafts-live-on-the-server.md
test("a question's unsent pick and note draw from the board's q: drafts and save there after a 1 s pause, at once as the note loses focus, never overwriting a note being typed; another device's newer draft redraws the card, an older one nothing; Send empties it", async () => {
  const topic = { id: 'item:w/T1', title: 'INT-1: Topic' };
  const question = { id: 'q1', topic: topic.id, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [topic], questions: [question], at: 'q1' });
  const drafted = (text, at, choice = 'B') => ({ 'q:q1': { text, files: [], choice, at } });
  v.server.drafts = drafted('From the phone', draftAt(1));
  await v.change({});
  await v.settle();
  const note = () => v.sheet().querySelector('section.q[data-q="q1"] textarea.note');
  const checked = (id) => v.sheet().querySelector(`section.q[data-q="q1"] input[value="${id}"]`)?.hasAttribute('checked');
  assert.deepEqual([note().value ?? note().textContent, checked('B')], ['From the phone', true]);

  const radio = v.sheet().querySelector('section.q[data-q="q1"] input[value="A"]');
  radio.type = 'radio';
  v.page.fire(v.sheet(), 'change', { target: radio });
  await v.settle();
  assert.deepEqual(draftPosts(v), [], 'nothing before the pause');
  v.page.runTimers(1000);
  await v.settle();
  assert.deepEqual(draftPosts(v), [{ id: 'q:q1', text: 'From the phone', files: [], choice: 'A' }]);

  note().value = 'Mac note';
  v.page.fire(v.sheet(), 'input', { target: note() });
  v.page.fire(v.root, 'focusout', { target: note() });
  await v.settle();
  assert.deepEqual(draftPosts(v).at(-1), { id: 'q:q1', text: 'Mac note', files: [], choice: 'A' });

  v.server.drafts = drafted('Phone again', draftAt(3), 'B');
  await v.change({});
  const copy = (id) => JSON.parse(JSON.stringify(v.page.win.BoardUI.getDraft(id)));
  assert.deepEqual([copy('q1'), checked('B')], [{ choice: 'B', note: 'Phone again' }, true], 'a newer draft from elsewhere redraws the card');
  v.server.drafts = drafted('Stale', draftAt(2), 'A');
  await v.change({});
  assert.equal(v.page.win.BoardUI.getDraft('q1').note, 'Phone again');

  v.page.win.BoardUI.setDraft('q1', {});
  v.page.runTimers(1000);
  await v.settle();
  assert.deepEqual(draftPosts(v).at(-1), { id: 'q:q1', text: '', files: [] });
  v.unmount();
});

test("a browser's old qdraft keys move to the board once, each where the board has no draft for its question, and their keys go", async () => {
  const topic = { id: 'item:w/T1', title: 'INT-1: Topic' };
  const mk = (id) => ({ id, topic: topic.id, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' });
  const stored = [['qdraft:q1', JSON.stringify({ choice: 'B', note: 'Old' })], ['qdraft:q2', JSON.stringify({ choice: 'A' })], ['qdraft:q3', '{}']];
  const v = questionsOnDom({ topics: [topic], questions: [mk('q1'), mk('q2'), mk('q3')], stored });
  v.server.drafts = { 'q:q2': { text: '', files: [], choice: 'B', at: draftAt(1) } };
  await v.change({});
  await v.settle();
  v.page.runTimers(1000);
  await v.settle();
  assert.deepEqual(draftPosts(v), [{ id: 'q:q1', text: 'Old', files: [], choice: 'B' }]);
  assert.deepEqual([...v.storage.keys()].filter((k) => k.startsWith('qdraft:')), []);
  const copy = (id) => JSON.parse(JSON.stringify(v.page.win.BoardUI.getDraft(id)));
  assert.deepEqual([copy('q1'), copy('q2')], [{ choice: 'B', note: 'Old' }, { choice: 'B' }]);
  v.unmount();
});

// docs/adr/2026-11-06-0037-the-open-questions-page-shows-open-questions-only.md: a push tap on a stale page
test("a link to a question this copy of the board predates reloads the board once, then opens that question's sheet; one the new copy lacks too shows only Questions", async () => {
  const a = { id: 'item:w/A', title: 'INT-1: A' };
  const b = { id: 'item:w/B', title: 'INT-2: B' };
  const mk = (id, topic) => ({ id, topic, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }], answers: [], state: 'open' });
  const topics = [a];
  const v = questionsOnDom({ topics, questions: [mk('q1', a.id)], at: 'q1' });
  await v.settle();
  assert.deepEqual(v.questionsShown(), ['q1']);
  topics.push(b);
  v.server.questions.push(mk('q2', b.id));
  const loads = boardGets(v);
  assert.equal(v.view.B.focusQuestion('q2'), false, 'the shell asks again while the board reloads');
  await v.settle();
  assert.equal(boardGets(v), loads + 1);
  assert.equal(v.view.B.focusQuestion('q2'), true);
  assert.deepEqual(v.questionsShown(), ['q2']);
  assert.equal(v.view.B.focusQuestion('gone'), false);
  await v.settle();
  assert.equal(v.view.B.focusQuestion('gone'), true, 'the new copy lacks it too');
  assert.equal(JSON.stringify(v.view.B.state.boardFilter), JSON.stringify(['ready', 'action', 'blocked']));
  v.unmount();
});

test('tapping the marked option again clears the pick: the suggestion stays cleared, Send stays off until a note, and Space on it clears it too', async () => {
  const topic = { id: 'item:w/T1', title: 'INT-1: Topic' };
  const question = { id: 'q1', topic: topic.id, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], suggested: { option: 'A', task: '#1', answer: 'yes' }, state: 'open' };
  const v = questionsOnDom({ topics: [topic], questions: [question], at: 'q1' });
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  const radio = (id) => { const i = $(`section.q[data-q="q1"] input[value="${id}"]`); i.type = 'radio'; return i; };
  const draft = () => JSON.parse(JSON.stringify(v.page.win.BoardUI.getDraft('q1')));
  const tap = (input, was) => {
    input.checked = was; // the radio is already checked when the tap lands
    v.page.fire(v.sheet(), 'pointerdown', { target: input });
    input.checked = true; // a click leaves a radio checked
    v.page.fire(v.sheet(), 'click', { target: input });
  };
  assert.equal($('#send').disabled, false, 'the suggestion is pre-checked, so Send is on');
  tap(radio('A'), true);
  assert.deepEqual([radio('A').checked, draft()], [false, { choice: null }]);
  assert.equal($('#send').disabled, true, 'a cleared pick with no note stays unsent');

  const note = $('section.q[data-q="q1"] textarea.note');
  note.value = 'Neither';
  v.page.fire(v.sheet(), 'input', { target: note });
  assert.equal($('#send').disabled, false, 'a note alone sends');
  await v.send();
  assert.deepEqual(v.answersSent(), [[{ id: 'q1', question: 'Q?', choice: null, label: '', note: 'Neither', sendId: 'string' }]]);
});

test('a tap on an option that was not marked marks it, and Space on the marked one clears it', async () => {
  const topic = { id: 'item:w/T1', title: 'INT-1: Topic' };
  const question = { id: 'q1', topic: topic.id, source: '', question: 'Q?', context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [topic], questions: [question], at: 'q1' });
  await v.settle();
  const radio = (id) => { const i = v.root.querySelector(`section.q[data-q="q1"] input[value="${id}"]`); i.type = 'radio'; return i; };
  const draft = () => JSON.parse(JSON.stringify(v.page.win.BoardUI.getDraft('q1')));
  const a = radio('A');
  v.page.fire(v.sheet(), 'pointerdown', { target: a });
  a.checked = true;
  v.page.fire(v.sheet(), 'change', { target: a });
  v.page.fire(v.sheet(), 'click', { target: a });
  assert.deepEqual([a.checked, draft()], [true, { choice: 'A' }], 'the first tap marks');
  v.page.fire(v.sheet(), 'keydown', { target: a, key: ' ' });
  v.page.fire(v.sheet(), 'click', { target: a });
  assert.deepEqual([a.checked, draft()], [false, { choice: null }], 'Space on the marked one clears it');
});

const rowQuestion = (id, topic, extra = {}) => ({ id, topic, source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open', ...extra });
const rowTap = (kind, key, word, more = {}) => ({ kind, key, title: `${key.split('/')[1]}: Card ${key.split('/')[1]}`, word, label: `Tap ${word}`, fault: false, since: '2026-11-02T10:00:00.000Z', progress: false, ...more });
// A topic of no card, whose sheet a questions link opens over the board.
const TRIAGE = [{ id: 'triage-1', title: 'Overnight triage' }];

test("a link to a topic of no card opens its questions sheet over the board, which closes once Send has every one sent, and ✕ closes it with nothing sent", async () => {
  const v = questionsOnDom({ topics: [{ id: 'triage-1', title: 'Overnight triage' }, { id: 'triage-2', title: 'Older triage' }],
    questions: [rowQuestion('q1', 'triage-1'), rowQuestion('q2', 'triage-1'), rowQuestion('q3', 'triage-2')], at: 'triage-1' });
  await v.settle();
  assert.deepEqual([v.sheet().open, v.sheet().modal, v.questionsShown(), v.sheet().querySelector('.reader-ref').textContent], [true, true, ['q1', 'q2'], 'Overnight triage']);
  assert.equal(v.sheet().querySelectorAll('section.q[data-q="q1"] [data-proto], section.q[data-q="q1"] [data-grill], section.q[data-q="q1"] [data-visual]').length, 3, "each question keeps the thread's Prototype, Grill and Visual");
  v.answer('q1');
  v.answer('q2');
  await v.send();
  assert.deepEqual(v.answersSent(), [[{ id: 'q1', question: 'Question q1?', choice: 'A', label: 'A. Yes', note: '', sendId: 'string' }, { id: 'q2', question: 'Question q2?', choice: 'A', label: 'A. Yes', note: '', sendId: 'string' }]]);
  v.page.runTimers();
  assert.equal(v.sheet().open, false);
  await v.open('triage-2');
  v.page.fire(v.sheet(), 'click', { target: v.sheet().querySelector('[data-qs="close"]') });
  v.page.runTimers();
  assert.deepEqual([v.sheet().open, v.sent.length], [false, 1]);
  v.unmount();
});

// docs/adr/2026-11-16-1100-a-questions-requests-go-out-through-the-answer-outbox.md
test("the sheet's Prototype, Grill and Visual put their request for that question, with its note and pick, in the outbox at once: it reads its request and sending…, then the visual's opens again and the prototype's leaves the sheet; a refusal opens the question again with its draft and says why", async () => {
  const gate = { promise: Promise.resolve(), refuse: '' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'T1: Search' }], questions: [rowQuestion('q1', 'item:w/T1'), rowQuestion('q2', 'item:w/T1')], at: 'q1', gate });
  await v.settle();
  assert.deepEqual(v.questionsShown(), ['q1', 'q2'], "a link to an open question opens its topic's sheet");
  v.answer('q1');
  const $ = (sel) => v.sheet().querySelector(sel);
  const ask = async (sel) => { v.page.fire(v.sheet(), 'click', { target: $(`section.q[data-q="q1"] ${sel}`) }); await v.settle(); };
  await ask('[data-visual]');
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent.map(([kind, { sendId, ...d }]) => [kind, d, typeof sendId]))), [['visual-request', { key: 'w/T1', question: 'q1', note: '', choice: 'A' }, 'string']]);
  assert.equal($('section.q[data-q="q1"] textarea.note') !== null, true, 'a visual leaves the question open once the board has it');
  let release;
  gate.promise = new Promise((r) => { release = r; });
  await ask('[data-proto]');
  assert.match(v.footer('q1'), /^Prototype requested\. · \S.* · sending…$/);
  assert.equal($('section.q[data-q="q1"] textarea.note'), null, 'a question being sent is locked');
  release();
  await v.settle();
  assert.deepEqual([v.sent.at(-1)[0], v.questionsShown()], ['prototype-request', ['q2']], 'the requested question leaves the sheet');
  gate.refuse = 'board busy';
  v.answer('q2');
  v.page.fire(v.sheet(), 'click', { target: $('section.q[data-q="q2"] [data-grill]') });
  await v.settle();
  assert.deepEqual([v.footer('q2'), v.toast(), v.questionsShown(), JSON.parse(JSON.stringify(v.page.win.BoardUI.getDraft('q2')))], [null, 'Nothing was sent: board busy', ['q2'], { choice: 'A' }]);
  v.unmount();
});

test("a request the board can't be reached for reads not sent with Retry and X in its footer: Retry sends it again under its send id, X opens the question again with its pick and note", async () => {
  const gate = { promise: Promise.resolve(), down: true };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'T1: Search' }], questions: [rowQuestion('q1', 'item:w/T1'), rowQuestion('q2', 'item:w/T1')], at: 'q1', gate });
  await v.settle();
  const $ = (sel) => v.sheet().querySelector(sel);
  const tapIn = async (sel) => { v.page.fire(v.sheet(), 'click', { target: $(sel) }); await v.settle(); };
  v.answer('q1');
  await tapIn('section.q[data-q="q1"] [data-visual]');
  assert.match(v.footer('q1'), /^Visual requested\. · \S.* · not sent$/);
  assert.ok($('section.q[data-q="q1"] [data-resend]') && $('section.q[data-q="q1"] [data-unsend]'));
  gate.down = false;
  await tapIn('section.q[data-q="q1"] [data-resend]');
  assert.deepEqual([v.sent.map(([kind]) => kind), v.sent[0][1].sendId === v.sent[1][1].sendId, v.footer('q1')], [['visual-request', 'visual-request'], true, null]);
  gate.down = true;
  v.answer('q2');
  await tapIn('section.q[data-q="q2"] [data-grill]');
  assert.match(v.footer('q2'), / · not sent$/);
  await tapIn('section.q[data-q="q2"] [data-unsend]');
  assert.deepEqual([v.footer('q2'), $('section.q[data-q="q2"] textarea.note') !== null], [null, true], 'X: open again');
  v.unmount();
});

// docs/adr/2026-11-04-2200-overnight-triage-suggests-your-earlier-answers.md
test("the questions sheet's Send sends a suggested option pre-checked, and a picked one in its place", async () => {
  const question = (id, extra = {}) => ({ id, topic: 'item:w/T1', source: '', question: `Question ${id}?`, context: '', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], answers: [], state: 'open', ...extra });
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Search' }], questions: [question('q1', { suggested: { option: 'B', task: '#186', answer: 'No.' } }), question('q2')], at: 'q1' });
  await v.settle();
  const $ = (sel) => v.root.querySelector(sel);
  assert.equal($('#send').disabled, false);
  assert.equal($('section.q[data-q="q1"] input[value="B"]').hasAttribute('checked'), true);
  await v.send();
  assert.deepEqual(v.answersSent(), [[{ id: 'q1', question: 'Question q1?', choice: 'B', label: 'B. No', note: '', sendId: 'string' }]]);
  v.unmount();
});

// docs/adr/2026-11-16-2100-a-question-sets-answers-send-as-one.md
test("Send sends the answered questions as one set and closes the sheet; opened again, each reads <time> · sending… in its footer while the unanswered stay open and answerable, then Sent. once the board has the set", async () => {
  const question = (id) => rowQuestion(id, 'triage-1');
  let release;
  const gate = { promise: new Promise((r) => { release = r; }) };
  const v = questionsOnDom({ topics: TRIAGE, questions: [question('q1'), question('q2'), question('q3')], at: 'q1', gate });
  await v.settle();
  const $ = (sel) => v.sheet().querySelector(sel);
  const draft = (id) => JSON.parse(JSON.stringify(v.page.win.BoardUI.getDraft(id)));
  v.answer('q1');
  v.answer('q2');
  await v.send();
  assert.deepEqual(v.answersSent(), [[{ id: 'q1', question: 'Question q1?', choice: 'A', label: 'A. Yes', note: '', sendId: 'string' }, { id: 'q2', question: 'Question q2?', choice: 'A', label: 'A. Yes', note: '', sendId: 'string' }]], 'one send for the set');
  assert.equal(new Set(v.sent.at(-1)[1].answers.map((a) => a.sendId)).size, 1, 'under one send id');
  // The send is still out, so its 15 s limit is not run down: the sheet is closing.
  assert.equal(v.sheet().classList.contains('closing'), true, 'Send closes the sheet, whatever is left unanswered');
  assert.deepEqual([draft('q1'), draft('q2')], [{ choice: 'A' }, { choice: 'A' }], 'the drafts stay until the board has them');
  await v.open('triage-1');
  assert.match(v.footer('q1'), /^\S.* · sending…$/, 'opened again: the time, then sending…');
  assert.match(v.footer('q2'), / · sending…$/);
  assert.deepEqual([v.footer('q3'), $('section.q[data-q="q3"] textarea.note') !== null], [null, true], 'an unanswered question stays open and answerable');
  assert.deepEqual([$('section.q[data-q="q1"] textarea.note'), $('section.q[data-q="q1"] .badge')?.textContent ?? ''], [null, ''], 'a question being sent is locked, with no Resolved badge yet');
  assert.deepEqual([$('#send').disabled, $('#send').getAttribute('aria-busy')], [true, null], 'Send never spins: nothing else is ready to send');
  release();
  await v.settle();
  assert.deepEqual([v.footer('q1'), v.footer('q2'), v.sheet().open], ['Sent.', 'Sent.', true], 'sent, and the sheet waits on q3');
  assert.deepEqual([draft('q1'), draft('q2')], [{}, {}]);
  assert.deepEqual(v.questionsShown(), ['q1', 'q2', 'q3'], 'the sent questions stay in the sheet while it is open');
  v.answer('q3');
  await v.send();
  v.page.runTimers();
  assert.deepEqual([v.answersSent().length, v.sheet().open, v.moves], [2, false, []], 'every question sent, the topic moves on');
  v.unmount();
});

// docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md
test("a set whose send gets no answer at all reads waiting for the host with no Retry, the board goes out of reach, and the set goes out on its own once a load reaches the board", async () => {
  const gate = { promise: Promise.resolve(), unreachable: true };
  // q3 stays unanswered, so the topic keeps its sheet once q1 and q2 are sent.
  const v = questionsOnDom({ topics: TRIAGE, questions: ['q1', 'q2', 'q3'].map((id) => rowQuestion(id, 'triage-1')), at: 'q1', gate });
  await v.settle();
  v.answer('q1');
  await v.send();
  v.page.runTimers();
  await v.open('triage-1');
  assert.match(v.footer('q1'), / · waiting for the host$/);
  assert.deepEqual([v.sheet().querySelector('[data-resend]'), v.root.classList.contains('offline'), v.answersSent().length], [null, true, 1]);
  v.answer('q2');
  await v.send();
  v.page.runTimers();
  assert.equal(v.answersSent().length, 1, 'nothing sends while the board is out of reach');
  await v.open('triage-1');
  assert.match(v.footer('q2'), / · waiting for the host$/);
  gate.unreachable = false;
  v.page.runIntervals(15000);
  await v.settle();
  assert.deepEqual([v.root.classList.contains('offline'), v.answersSent().map((a) => a[0].id), v.footer('q1'), v.footer('q2')], [false, ['q1', 'q1', 'q2'], 'Sent.', 'Sent.']);
  v.unmount();
});

test("a Send the board answers with an error reads not sent with Retry and X once opened again; Retry sends it again, X opens them again with their picks and notes; a refusal opens them again and says why", async () => {
  const question = (id) => rowQuestion(id, 'triage-1');
  const gate = { promise: Promise.resolve(), down: true };
  const v = questionsOnDom({ topics: TRIAGE, questions: [question('q1'), question('q2')], at: 'q1', gate });
  await v.settle();
  const $ = (sel) => v.sheet().querySelector(sel);
  const tapIn = async (sel) => { v.page.fire(v.sheet(), 'click', { target: $(sel) }); await v.settle(); };
  v.answer('q1');
  await v.send();
  v.page.runTimers();
  await v.open('triage-1');
  assert.match(v.footer('q1'), / · not sent$/);
  assert.ok($('section.q[data-q="q1"] .sent-line [data-resend]') && $('section.q[data-q="q1"] .sent-line [data-unsend]'), 'Retry and X in its footer');

  gate.down = false;
  await tapIn('section.q[data-q="q1"] [data-resend]');
  assert.deepEqual([v.answersSent().map((a) => a[0].id), v.footer('q1')], [['q1', 'q1'], 'Sent.']);

  gate.down = true;
  v.answer('q2');
  await v.send();
  v.page.runTimers();
  await v.open('triage-1');
  assert.match(v.footer('q2'), / · not sent$/);
  await tapIn('section.q[data-q="q2"] [data-unsend]');
  assert.deepEqual([v.footer('q2'), $('section.q[data-q="q2"] input[value="A"]').hasAttribute('checked'), $('section.q[data-q="q2"] textarea.note') !== null], [null, true, true], 'X: open again, its pick kept');
  assert.equal($('#send').disabled, false);

  gate.down = false;
  gate.refuse = 'q2 is no longer asked here. Reload to see what is, then send again.';
  await v.send();
  v.page.runTimers();
  assert.equal(v.toast(), 'Nothing was sent: q2 is no longer asked here. Reload to see what is, then send again.', 'a refusal says why');
  await v.open('triage-1');
  assert.deepEqual([v.footer('q2'), $('section.q[data-q="q2"] input[value="A"]').hasAttribute('checked')], [null, true], 'and opens it again with its pick');
  v.unmount();
});

test('a set a reload left unsent, a failed one included, goes out again once the board loads', async () => {
  const topics = TRIAGE;
  const v = questionsOnDom({ topics, questions: [rowQuestion('q1', 'triage-1'), rowQuestion('q2', 'triage-1')], at: 'q1', gate: { promise: Promise.resolve(), down: true } });
  await v.settle();
  v.answer('q1');
  await v.send();
  v.page.runTimers();
  await v.open('triage-1');
  assert.match(v.footer('q1'), / · not sent$/);
  v.unmount();
  const w = questionsOnDom({ topics, questions: [rowQuestion('q1', 'triage-1'), rowQuestion('q2', 'triage-1')], at: 'q1', stored: [...v.storage] });
  await w.settle();
  assert.deepEqual(w.answersSent().map((a) => a.map((x) => x.id)), [['q1']]);
  assert.deepEqual([w.server.questions.find((q) => q.id === 'q1').state, w.questionsShown()], ['answered', ['q2']], 'the board has it before the link opens the sheet, which holds only what is left');
  w.unmount();
});

// docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md
test('the questions sheet frames no take: a prototype question shows its options and a View prototypes link to the viewer, and a choice only drafts', async () => {
  const takes = [{ id: 'A', label: 'Badge' }, { id: 'B', label: 'Dot', recommended: true }, { id: 'C', label: 'Thread' }];
  const q = { id: 'q1', topic: 'item:w/T1', source: '', question: 'Which?', context: '', url: 'prototype-unread.html?q=q1', options: takes, answers: [], state: 'open' };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'INT-1: Unread' }], questions: [q], at: 'q1' });
  await v.settle();
  assert.equal(v.sheet().querySelectorAll('iframe').length, 0);
  const view = v.sheet().querySelectorAll('a.proto-view');
  assert.deepEqual(view.map((a) => [a.getAttribute('href'), a.textContent]), [['prototype-unread.html?q=q1', 'View prototypes']]);
  const section = v.sheet().querySelector('section.q');
  v.answer('q1');
  assert.equal(v.page.win.BoardUI.getDraft('q1').choice, 'A');
  assert.equal(v.sheet().querySelector('section.q'), section);
  v.unmount();
});

// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
test("at every width every questions URL, a link, a push or a hand-off, shows the board at the board's URL and asks it for that question, with no history entry on the same board", async () => {
  for (const width of [1280, 390]) {
    const s = await shellPage('/_hub/', { width });
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
    assert.deepEqual([s.doc.querySelector('.view-board'), focused], [board, [null]], 'a link of no question asks with none');
    focused.length = 0;
    s.win.AppShell.open('/other/questions.html#q9');
    await new Promise(setImmediate);
    assert.deepEqual([s.win.location.pathname, s.doc.querySelectorAll('.view-board').length, focused], ['/other/', 1, ['q9']], "another board's questions open that board");
  }
});

// docs/adr/2026-11-16-0828-on-a-phone-a-cards-questions-open-over-the-card.md
async function phoneQuestions(path) {
  const board = { ...questionsBoard([openQuestion('qa', 'item:w/A1'), openQuestion('qb', 'item:w/A1'), openQuestion('qz', 'overnight')], []),
    items: [workCard('A1', { lane: 'progress', questions: { topic: 'item:w/A1', first: 'qa', open: 2, state: 'open' } }), workCard('B1', { lane: 'progress' })] };
  const fetch = async (url) => {
    const u = new URL(url, 'https://mac.ts.net/');
    const body = structuredClone(u.pathname.endsWith('/api/board') ? board : []);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const s = await shellPage(path, { fetch, realBoards: true });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  s.page.runTimers?.();
  await settle();
  const boardRoot = () => s.doc.querySelector('.view-board');
  const sheet = () => boardRoot()?.querySelector('#questionsSheet');
  const shown = () => ({
    url: s.win.location.pathname + s.win.location.hash,
    card: boardRoot()?.querySelector('details.item[data-key="w/A1"]')?.hasAttribute('open') ?? false,
    sheet: Boolean(sheet()?.open),
    asked: sheet()?.open ? sheet().querySelectorAll('section.q').map((q) => q.dataset.q) : [],
  });
  const tapLink = async (href) => {
    const a = s.doc.createElement('a');
    a.setAttribute('href', href);
    boardRoot().appendChild(a);
    s.tap(a);
    await settle();
    s.page.runTimers?.();
    await settle();
  };
  return { ...s, settle, sheet, shown, tapLink };
}

test("on a phone a card's question link opens that card on the board with its questions sheet over it, adding no history entry; closing the sheet leaves the card open", async () => {
  const s = await phoneQuestions('/shop/');
  const count = s.entries().length;
  await s.tapLink('questions.html#qb');
  assert.deepEqual(s.shown(), { url: '/shop/#selectedCard=w%2FA1', card: true, sheet: true, asked: ['qa', 'qb'] }, "a card's Answer link to its question");
  assert.equal(s.entries().length, count, 'on its own board the tap adds no history entry');
  s.page.fire(s.sheet(), 'click', { target: s.sheet().querySelector('[data-qs="close"]') });
  s.page.runTimers?.();
  await s.settle();
  assert.deepEqual([s.sheet().open, s.shown().card], [false, true], 'closing the sheet leaves the card open');
});

test("on a phone a cold load or a push of a card's question shows the board at its URL with the card open under its questions sheet, and Back returns where the push came from", async () => {
  const cold = await phoneQuestions('/shop/questions.html#qb');
  assert.deepEqual(cold.shown(), { url: '/shop/#selectedCard=w%2FA1', card: true, sheet: true, asked: ['qa', 'qb'] }, 'a cold load');

  const s = await phoneQuestions('/other/');
  s.win.AppShell.open('/shop/questions.html?from=push#item%3Aw%2FA1');
  await s.settle();
  s.page.runTimers?.();
  await s.settle();
  assert.deepEqual(s.shown(), { url: '/shop/#selectedCard=w%2FA1', card: true, sheet: true, asked: ['qa', 'qb'] }, 'a push');
  s.win.history.back();
  await s.settle();
  assert.equal(s.win.location.pathname, '/other/');
});

test("on a phone a questions link of no question shows the board with only the Questions box checked, and one of a topic of no card opens its sheet over the board, by a link or a cold load", async () => {
  const s = await phoneQuestions('/shop/');
  await s.tapLink('questions.html');
  assert.deepEqual([s.shown().url, s.shown().sheet, s.doc.querySelector('.view-board button.board-filter').classList.contains('on')], ['/shop/', false, true]);
  await s.tapLink('questions.html#qz');
  assert.deepEqual(s.shown(), { url: '/shop/', card: false, sheet: true, asked: ['qz'] }, "a board's own question");
  const cold = await phoneQuestions('/shop/questions.html#qz');
  assert.deepEqual(cold.shown(), { url: '/shop/', card: false, sheet: true, asked: ['qz'] }, 'a cold load of one');
});

// docs/adr/2026-11-16-0514-prototypes-and-visuals-open-in-the-reader-sheet.md
test("at every width a card page's URL, a prototype's or a visual's, by a link, a push or a cold load, shows the board at the board's URL with the page open in its reader sheet, never the frame view", async () => {
  const stub = (opened) => () => ({ B: { state: {}, openPage: (url) => { opened.push(url); return true; } }, mount() {}, unmount() {} });
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
  phone.win.AppShell.open('/shop/questions.html#q2');
  await new Promise(setImmediate);
  phone.win.AppShell.open('/shop/visuals/A1/flow.html');
  await new Promise(setImmediate);
  assert.deepEqual([phone.doc.querySelector('.view-frame'), Boolean(phone.doc.querySelector('.view-board')), phone.win.location.pathname, phoneOpened.map((u) => new URL(u).pathname)],
    [null, true, '/shop/', ['/shop/visuals/A1/flow.html']], "a phone's question link, then a visual, opens it over the board too");
  phone.win.AppShell.open('/shop/shots-gallery.html');
  await new Promise(setImmediate);
  assert.ok(phone.doc.querySelector('.view-frame'), 'a board page that is no card page still frames');
});

test('the board menu\'s Settings opens a board-only modal over the same board, closes without history entries and keeps back to Hub', async () => {
  const { win, doc, page, entries, position, boardUnmounts } = await shellPage('/_hub/');
  win.AppShell.open('/shop/#selectedCard=w%2FA1');
  const board = doc.querySelector('.view-board');
  const count = entries().length;
  const baseline = page.left();
  // The stubbed board view draws no menu, so the page's own row stands in for the one the view paints while it is open.
  board.querySelector('#boardMenu').innerHTML = win.BoardUI.boardMenu('none');
  const gear = board.querySelector('#boardMenu #settingsLink');
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
  const focused = (el) => (el?.closest('form[data-reply]') ? 'reply' : null);
  const shown = () => [win.location.pathname, win.scrollY, focused(doc.activeElement)];

  page.fire(doc.querySelector('.view-board'), 'click', { target: $('[data-thread="w/b1"] [data-thread-more]') });
  assert.deepEqual(lines(), ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5']);
  const reply = () => $('form[data-reply="w/a1"] textarea');
  win.scrollY = 640;
  await switchTo('other');
  assert.deepEqual(shown(), ['/other/', 0, null]);
  await switchTo('shop');
  assert.deepEqual(shown(), ['/shop/', 640, null]);
  assert.deepEqual(lines(), ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5']);

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
  const settings = { on: { on: true }, weekends: { on: false }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [], overnight: { starts: '', jobs: [] } }, closed: [], pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off' }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false }, alerts: { summary: 'Off', note: '', kinds: [] } };
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
  const data = { on: { on: true }, weekends: { on: false }, rules: [], quiet: { start: '22:00', end: '08:00', summary: '10:00pm – 8:00am · pushes held', hint: 'checks', hold: { on: true, sub: '' }, reads: [], overnight: { starts: '', jobs: [] } }, closed: [], pause: { summary: 'Off', on: null, choices: [] }, awake: { summary: 'Off' }, linear: { title: 'Linear', sub: '', set: false }, slack: { title: 'Slack', sub: '', set: false }, alerts: { summary: 'Off', note: '', kinds: [] } };
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
test("Todo has no Queued section: its cards show in the server's order, a bumped one first, each with Bump or Unbump in its \"…\" menu", async () => {
  const cards = [workCard('P1', { lane: 'progress', bumpable: true }), workCard('T2', { bumpable: true, bumpedAt: '2026-11-04T10:00:00.000Z', ready: true }), workCard('T1', { bumpable: true })];
  const b = boardOnDom({ board: boardOf(cards), threads: {} });
  await b.settle();
  assert.equal(b.root.querySelector('.lane-queue'), null);
  const todo = b.root.querySelector('details.lane[data-lane="todo"]');
  assert.deepEqual(todo.querySelectorAll('details.item').map((el) => el.dataset.key), ['w/T2', 'w/T1']);
  assert.deepEqual(['w/T2', 'w/T1'].map((key) => bumpItem(b, key).textContent), ['Unbump', 'Bump']);
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

test('a Done card open from before a reload and past the first 10 comes in collapsed when Show more loads it, and a card opened this visit stays open', async () => {
  const day = (n) => `2026-10-${String(30 - n).padStart(2, '0')}T08:00:00.000Z`;
  const work = Array.from({ length: 25 }, (_, n) => workCard(`D${n}`, { lane: 'done', sortAt: day(n) }));
  const b = boardOnDom({ open: ['w/D3', 'w/D15'], board: boardOf(work), threads: {} });
  await b.settle();
  const lane = () => b.root.querySelector('#lanes details.lane[data-lane="done"]');
  const card = (id) => lane().querySelector(`details.item[data-key="w/${id}"]`);
  const more = () => lane().querySelector('[data-lane-more]');
  assert.deepEqual([card('D3').open, card('D15')], [true, null]);
  b.page.fire(b.root, 'click', { target: more() });
  await b.settle();
  assert.deepEqual([card('D3').open, card('D15').open, b.page.win.localStorage.getItem('site:board-a:openItems')], [true, false, '["w/D3"]']);
  card('D12').open = true;
  b.page.fire(card('D12'), 'toggle');
  b.page.fire(b.root, 'click', { target: more() });
  await b.settle();
  assert.deepEqual([card('D12').open, card('D15').open, card('D22').open], [true, false, false]);
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
test('Done preloads its next archive page once its shown cards come within one step of the cards held, so the tap that reaches it fetches nothing', async () => {
  const day = (n) => new Date(Date.parse('2026-11-04T10:00:00Z') - n * 60000).toISOString();
  const card = (n) => workCard(`D${n}`, { lane: 'done', sortAt: day(n) });
  const archive = Array.from({ length: 130 }, (_, n) => card(100 + n));
  const b = boardOnDom({ stored: [['site:board-a:lanes', JSON.stringify({ done: true })]], board: { ...boardOf(Array.from({ length: 100 }, (_, n) => card(n))), doneArchived: 130 } });
  const asked = [];
  b.server.done = (params) => {
    asked.push(params.get('before'));
    return { cards: archive.slice(0, 100), left: 30 };
  };
  await b.settle();
  const lane = () => b.root.querySelector('#lanes details.lane[data-lane="done"]');
  const more = () => lane().querySelector('[data-lane-more]');
  const tap = async (n = 1) => { for (let i = 0; i < n; i++) { b.page.fire(b.root, 'click', { target: more() }); await b.settle(); } };
  await tap(8);
  assert.deepEqual([lane().querySelectorAll('details.item').length, asked], [90, [null]], 'at 90 shown of 100 held the next page is already fetched');
  assert.equal(more().hasAttribute('data-fetch'), false);
  await tap(2);
  assert.deepEqual([lane().querySelectorAll('details.item').length, more().textContent, asked.length], [110, 'Show more · 120 older tasks', 1]);
  b.view.unmount();
});

test('a closed Done does not preload, and a failed preload leaves the tap to fetch with its toast', async () => {
  const day = (n) => new Date(Date.parse('2026-11-04T10:00:00Z') - n * 60000).toISOString();
  const card = (n) => workCard(`D${n}`, { lane: 'done', sortAt: day(n) });
  const b = boardOnDom({ board: { ...boardOf(Array.from({ length: 100 }, (_, n) => card(n))), doneArchived: 130 } });
  let asked = 0;
  b.server.done = () => { asked++; return { cards: [], left: 0 }; };
  await b.settle();
  const lane = () => b.root.querySelector('#lanes details.lane[data-lane="done"]');
  const more = () => lane().querySelector('[data-lane-more]');
  for (let i = 0; i < 9; i++) { b.page.fire(b.root, 'click', { target: more() }); await b.settle(); }
  assert.deepEqual([lane().querySelectorAll('details.item').length, asked], [100, 0]);
  assert.equal(more().hasAttribute('data-fetch'), true);
  b.view.unmount();
});

test("a busy Show more has no underline and draws its spinner at the left, where its text starts", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.thread-more\[aria-busy="true"\] \{[^}]*text-decoration: none/);
  assert.match(css, /\.thread-more\[aria-busy="true"\]::after \{[^}]*inset: 0 auto 0 12px/);
});

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
    ['maxImplementers', 'Maximum tasks in progress'], ['maxServes', 'Maximum parallel serves'], ['autoBuild', 'Auto serve'], ['autoReview', 'Auto review'], ['autoMerge', 'Auto-merge'],
    ['idleNotification', 'Idle notification'],
  ]);
  assert.match(auto, /May use a lot of usage\./);
  assert.doesNotMatch(html, /<h2>(Merging|Builds|Todo)<\/h2>/);
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test("the Auto Review lane leads the lanes; a held review's #review= link opens it, and Post it goes through the outbox, its row in the New strip until the board has it", async () => {
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
  const sending = () => b.root.querySelectorAll('#newStrip .new-entry[data-send] .new-msg').map((el) => el.textContent);
  b.page.fire(b.root, 'click', { target: post() });
  await b.settle();
  assert.deepEqual(sentNoIds(b), [['review-answer', { pr: 437, answer: 'post' }]]);
  assert.deepEqual([post().disabled, post().getAttribute('aria-busy'), sending()], [false, null, ['Review of PR #437: Post it']], 'the answer shows in the New strip, its button free');
  answer();
  await b.settle();
  assert.deepEqual(sending(), []);
});

// docs/adr/2026-11-03-1921-board-settings-grant-a-boards-session-permissions.md
test("Board Settings' Permissions switches sit below Auto, wait for the server with a spinner beside them, and note a refusal", async () => {
  const page = fakePage(memoryStorage().localStorage);
  const html = page.win.AppViews.settings.markup({}, { siteTitle: 'Orch' });
  assert.ok(html.indexOf('<h2>Auto</h2>') < html.indexOf('<h2>Permissions</h2>') && html.indexOf('<h2>Permissions</h2>') < html.indexOf('<h2>Reviewers</h2>'));
  const rules = { pushMain: 'Bash(git push origin main)', runRelease: 'Bash(.kickflip/release *)', draftPr: 'Bash(gh pr create --draft *)' };
  const names = { pushMain: 'Push main after a land', runRelease: 'Run release script', draftPr: 'Open draft PRs' };
  const state = { pushMain: false, runRelease: true, draftPr: false };
  let unavailable = null;
  let answer = null;
  const posts = [];
  const view = () => ({ file: '/r/.claude/settings.local.json', permissions: Object.keys(rules).map((id) => ({ id, name: names[id], allows: `Allows ${id}.`, rule: rules[id], on: state[id], unavailable: id === 'runRelease' ? unavailable : null,
    refused: id === 'runRelease' && state[id] ? { command: '.kickflip/release ship 0.9.0 abc', how: 'denied', at: '2026-11-03T20:00:00.000Z' } : null })) });
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
  assert.match(rows[1].innerHTML, /Writes <code>Bash\(\.kickflip\/release \*\)<\/code>/);
  assert.equal(root.querySelector('#permissions .refused-note').textContent, 'Auto mode still refused this once: .kickflip/release ship 0.9.0 abc. Approve it under /permissions, Recently blocked.');
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

  toggle('runRelease').checked = false;
  change('runRelease');
  await tick();
  answer(false);
  await tick(); await tick();
  assert.deepEqual([toggle('runRelease').checked, toggle('runRelease').disabled], [true, false]);
  assert.equal(root.querySelector('#perm-runReleaseStatus').textContent, 'Cannot save');
  v.unmount();

  // docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md: a repo with no .kickflip/release.
  unavailable = 'No .kickflip/release in this repo';
  const on = await mount();
  assert.equal(on.root.querySelector('#perm-runRelease').disabled, false, 'a switch that is on can still be turned off');
  assert.match(on.root.querySelectorAll('#permissions label.who')[1].innerHTML, /No \.kickflip\/release in this repo\. Allows runRelease\./);
  on.v.unmount();
  state.runRelease = false;
  const off = await mount();
  assert.equal(off.root.querySelector('#perm-runRelease').disabled, true);
  off.v.unmount();
});

// docs/adr/2026-11-04-2345-a-builders-log-and-notes-open-in-a-sheet.md
// The page's history as a browser keeps it, from the entry start: a push adds an entry over the one shown, and the
// page's own back() (each a ['back'] in moves, as a push is ['push', state, url]) goes one down. land() is the browser
// landing a back the page asked for, its popstate; ownerBack() is the owner's Back, one entry down with its popstate.
function stackHistory(page, start, moves = []) {
  const history = {
    entries: [start], at: 0,
    get state() { return this.entries[this.at]; },
    pushState(state, _, url) { moves.push(['push', state, url]); this.entries.splice(this.at + 1, Infinity, state); this.at++; },
    replaceState(state) { this.entries[this.at] = state; },
    back() { moves.push(['back']); this.at--; },
  };
  page.win.history = history;
  const land = () => page.fire(vm.runInContext('window', page.win), 'popstate', { state: history.state });
  return { history, moves, land, ownerBack: () => { history.at--; land(); } };
}

function readerOnDom(logText,{ width = 390, topics = null, notes } = {}) {
  const launch = { ts: '2026-10-30T09:00:00.000Z', who: 'claude', kind: 'agent', run: 'r1', agent: 'Claude Sonnet implementer', text: 'Claude Sonnet implementer started', finished: false, log: 'builder-A1-1.log' };
  const card = workCard('A1', { lane: 'progress', hasNotes: true });
  const b = boardOnDom({ open: ['w/A1'], width, board: topics ? { ...questionsBoard(topics, []), items: [card] } : boardOf([card]), threads: { 'w/A1': [launch] }, notes });
  const log = { text: logText };
  const moves = [];
  const { land, ownerBack } = stackHistory(b.page, { idx: 3 }, moves);
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
    if (u.pathname.endsWith('/api/notes') && !u.searchParams.has('all')) { b.gets.push(`${u.pathname}?${u.searchParams}`); return { ok: true, status: 200, json: async () => ({ key: 'w/A1', ref: 'A1', title: 'Work A1', markdown: '# The plan\n\nBuild it, then see [the prototype](prototype-reader.html).' }) }; }
    return boardFetch(url, opts);
  };
  const tap = (el) => b.page.fire(b.root, 'click', { target: el, button: 0 });
  const sheet = () => b.root.querySelector('#readerSheet');
  return { ...b, log, moves, land, ownerBack, tap, sheet, inSheet: (sel) => sheet().querySelector(sel) };
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
  r.page.runTimers();
  assert.equal(r.sheet().open, false, 'Escape closes it');
  r.tap(link);
  await r.settle();
  r.page.fire(r.sheet(), 'click', { target: r.inSheet('[data-reader="close"]') });
  r.page.runTimers();
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
  assert.deepEqual(JSON.parse(JSON.stringify(r.moves)), [['push', { idx: 4, sheets: 1 }, 'https://mac.ts.net/']], 'Back has an entry to close it with');
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
  r.page.runTimers();
  assert.equal(r.sheet().open, false);
  assert.deepEqual(r.moves.at(-1), ['back'], 'Escape takes back the entry it pushed');
  r.land();

  r.tap(link);
  await r.settle();
  r.page.fire(r.sheet(), 'click', { target: r.sheet() });
  r.page.runTimers();
  assert.deepEqual([r.sheet().open, r.moves.at(-1)], [false, ['back']], 'a tap on the dim area closes it');
  r.land();

  r.tap(link);
  await r.settle();
  const backs = r.moves.filter(([m]) => m === 'back').length;
  r.ownerBack();
  r.page.runTimers();
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

// docs/adr/2026-11-17-0306-a-sheet-opened-from-another-stacks-on-it.md
test("a question link tapped in the reader, in a card's notes or a page it frames, opens the questions sheet stacked on the reader; closing it returns to the reader as it was", async () => {
  for (const width of [390, 1280]) {
    const r = readerOnDom('plain log text', { width, topics: [openQuestion('q1', 'item:w/A1')], notes: { 'w/A1': '# The plan\n\nSee [the question](/board-a/questions.html#q1).' } });
    await drain(() => r.view.B.state.notesCache.size === 1, "the card's notes load");
    const shown = [];
    r.page.win.AppShell = { open: (href) => { shown.push(href); return true; } };
    const questions = r.root.querySelector('#questionsSheet');
    const top = (sheet) => r.page.win.BoardUI.isTopSheet(sheet);
    r.tap(r.root.querySelector('a[href="notes.html?item=w%2FA1"]'));
    await r.settle();
    const notes = r.inSheet('.reader-md');
    const link = r.inSheet('.reader-md a');
    assert.equal(link.getAttribute('href'), '/board-a/questions.html#q1');
    assert.equal(r.page.fire(r.sheet(), 'click', { target: link, button: 0 }).defaultPrevented, true);
    r.page.runTimers();
    assert.deepEqual([r.sheet().open, questions.open, top(questions), r.inSheet('.reader-md'), shown], [true, true, true, notes, []], `${width}: the questions sheet stacks on the notes, which stay as they were`);
    assert.deepEqual(questions.querySelectorAll('section.q').map((q) => q.dataset.q), ['q1']);
    assert.deepEqual(JSON.parse(JSON.stringify(r.moves.map(([m, state]) => [m, state?.sheets]))), [['push', 1], ['push', 2]], 'one entry for each layer');
    r.ownerBack();
    r.page.runTimers();
    assert.deepEqual([questions.open, r.sheet().open, top(r.sheet()), r.inSheet('.reader-md')], [false, true, true, notes], 'Back closes the questions sheet, back on the notes');

    // A question linked from a page the reader frames stacks the same way, and its ✕ returns to the page.
    r.view.B.openPage('https://mac.ts.net/board-a/visuals/A1/flow.html');
    const frame = r.inSheet('iframe.reader-frame');
    const doc = Object.assign(new r.page.Target(), { title: 'Flow' });
    frame.contentWindow = { document: doc, location: { href: 'https://mac.ts.net/board-a/visuals/A1/flow.html', pathname: '/board-a/visuals/A1/flow.html', search: '', hash: '' } };
    r.page.fire(frame, 'load');
    r.page.fire(doc, 'click', { button: 0, target: { closest: (sel) => (sel === 'a[href]' ? { href: 'https://mac.ts.net/board-a/questions.html#q1', target: '', hasAttribute: () => false } : null) } });
    assert.deepEqual([questions.open, top(questions), r.inSheet('iframe.reader-frame'), shown], [true, true, frame, []]);
    r.page.fire(questions, 'click', { target: questions.querySelector('[data-qs="close"]') });
    r.land();
    r.page.runTimers();
    assert.deepEqual([questions.open, r.sheet().open, top(r.sheet()), r.inSheet('iframe.reader-frame')], [false, true, true, frame], 'its ✕ returns to the visual');
    r.view.unmount();
  }
});

// docs/adr/2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md
test("a visual in its opaque origin gives the reader its title and its link taps by message; another frame's, or a link that isn't the web's, does nothing", async () => {
  const r = readerOnDom('', { topics: [openQuestion('q1', 'item:w/A1')] });
  await r.settle();
  const shown = [];
  r.page.win.AppShell = { open: (href) => { shown.push(href); return true; } };
  const questions = r.root.querySelector('#questionsSheet');
  r.view.B.openPage('https://mac.ts.net/board-a/visuals/A1/flow.html');
  const frame = r.inSheet('iframe.reader-frame');
  frame.contentWindow = { get location() { throw new Error('a cross-origin frame'); } };
  r.page.fire(frame, 'load');
  // The page's scripts see the context's global, not win itself (node:vm).
  const global = vm.runInContext('globalThis', r.page.win);
  const send = (data, source = frame.contentWindow) => r.page.fire(global, 'message', { source, data });
  send({ kickflip: 'page', title: 'Flow' }, {});
  assert.equal(r.inSheet('.reader-ref').textContent, 'A1');
  send({ kickflip: 'page', title: 'Flow' });
  assert.equal(r.inSheet('.reader-ref').textContent, 'A1 · Flow');
  send({ kickflip: 'page-link', href: 'javascript:alert(1)' });
  send({ kickflip: 'page-link', href: 'https://mac.ts.net/board-a/questions.html#q1' }, {});
  assert.deepEqual([questions.open, frame.getAttribute('src'), shown], [false, 'https://mac.ts.net/board-a/visuals/A1/flow.html', []]);
  send({ kickflip: 'page-link', href: 'https://example.com/docs' });
  assert.equal(frame.src, 'https://example.com/docs', 'a page off the board opens in the frame, as the tap would have');
  send({ kickflip: 'page-link', href: 'https://mac.ts.net/board-a/questions.html#q1' });
  assert.deepEqual([questions.open, shown], [true, []], 'a question of the board stacks its sheet on the reader');
  r.view.unmount();
});

// docs/adr/2026-11-17-0306-a-sheet-opened-from-another-stacks-on-it.md
test("a visual or a transcript linked in the reader opens over the page it shows with an entry of its own; ✕, Escape or Back shows the page beneath as it was, the last closes the sheet; and a page opened from a questions sheet stacked on the reader goes back under it", async () => {
  for (const width of [390, 1280]) {
    const visual = 'https://mac.ts.net/board-a/visuals/A1/flow.html';
    const r = readerOnDom('plain log text', { width, topics: [openQuestion('q1', 'item:w/A1')], notes: { 'w/A1': '# The plan\n\nSee [the flow](/board-a/visuals/A1/flow.html), [the run](/board-a/log.html?file=builder-A1-1.log) and [the question](/board-a/questions.html#q1).' } });
    await drain(() => r.view.B.state.notesCache.size === 1, "the card's notes load");
    r.page.win.AppShell = { open: () => assert.fail('nothing leaves the board') };
    const questions = r.root.querySelector('#questionsSheet');
    const top = (sheet) => r.page.win.BoardUI.isTopSheet(sheet);
    const linkTo = (href) => [...r.sheet().querySelectorAll('.reader-md a')].find((a) => a.getAttribute('href') === href);
    const head = () => r.inSheet('#readerTitle').textContent;
    const shownBody = () => r.sheet().querySelectorAll('.reader-body').find((el) => !el.hidden);
    r.tap(r.root.querySelector('a[href="notes.html?item=w%2FA1"]'));
    await r.settle();
    const notesBody = shownBody();
    notesBody.scrollTop = 120;

    r.page.fire(r.sheet(), 'click', { target: linkTo('/board-a/visuals/A1/flow.html'), button: 0 });
    assert.deepEqual([r.sheet().open, head(), r.inSheet('iframe.reader-frame')?.getAttribute('src'), notesBody.hidden], [true, 'visual', visual, true], `${width}: the visual opens over the notes, kept hidden`);
    r.page.fire(r.sheet(), 'click', { target: r.inSheet('[data-reader="close"]') });
    assert.deepEqual([r.sheet().open, head(), shownBody(), notesBody.scrollTop, r.inSheet('iframe.reader-frame')], [true, 'notes', notesBody, 120, null], "its ✕ shows the notes again where they were");
    assert.deepEqual(r.moves.map(([m, state]) => [m, state?.sheets]), [['push', 1], ['push', 2], ['back', undefined]], 'the visual had an entry of its own, spent on its ✕');
    r.land();

    r.page.fire(r.sheet(), 'click', { target: linkTo('/board-a/log.html?file=builder-A1-1.log'), button: 0 });
    await r.settle();
    assert.deepEqual([head(), notesBody.hidden], ['builder transcript', true], 'a transcript linked in the notes opens over them');
    if (width < 900) r.page.fire(r.sheet(), 'cancel', { cancelable: true });
    else r.page.fire(r.page.win.document, 'keydown', { key: 'Escape' });
    assert.deepEqual([r.sheet().open, head(), shownBody()], [true, 'notes', notesBody], 'Escape shows the notes again');
    r.land();

    r.page.fire(r.sheet(), 'click', { target: linkTo('/board-a/visuals/A1/flow.html'), button: 0 });
    r.ownerBack();
    assert.deepEqual([r.sheet().open, head(), shownBody(), r.sheet().querySelectorAll('.reader-body').length], [true, 'notes', notesBody, 1], 'Back shows the notes again, the visual gone');

    // Notes, then the question stacked on them, then a page the questions sheet opens: the reader comes on top with it,
    // and its ✕ puts the reader back under the questions sheet, on the notes.
    r.page.fire(r.sheet(), 'click', { target: linkTo('/board-a/questions.html#q1'), button: 0 });
    assert.deepEqual([questions.open, top(questions)], [true, true]);
    r.view.B.openPage(visual);
    assert.deepEqual([top(r.sheet()), questions.open, head()], [true, true, 'visual'], 'a page from the questions sheet opens on top');
    r.page.fire(r.sheet(), 'click', { target: r.inSheet('[data-reader="close"]') });
    r.land();
    assert.deepEqual([top(questions), r.sheet().open, head(), shownBody(), notesBody.scrollTop], [true, true, 'notes', notesBody, 120], 'its ✕ returns to the questions sheet, the notes under it as they were');
    assert.equal(r.page.win.history.state.sheets, 2, 'an entry each for the reader and the questions sheet');
    r.view.B.openPage(visual);
    r.page.fire(r.sheet(), 'reader-leave', { detail: 'https://mac.ts.net/board-a/questions.html#q1' });
    r.land();
    assert.deepEqual([top(questions), r.sheet().open, head(), shownBody(), r.page.win.history.state.sheets], [true, true, 'notes', notesBody, 2], 'Choose this closes only its page, back on the question');
    r.page.fire(questions, 'click', { target: questions.querySelector('[data-qs="close"]') });
    r.land();
    r.page.fire(r.sheet(), 'click', { target: r.inSheet('[data-reader="close"]') });
    r.page.runTimers();
    r.land();
    assert.deepEqual([r.sheet().open, questions.open, r.page.win.history.state.sheets], [false, false, undefined], 'the last ✕ closes the sheet, its entry spent');
    r.view.unmount();
  }
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
  r.page.runTimers();
  assert.deepEqual([r.sheet().open, r.moves.at(-1)[0], shown], [false, 'back', []], 'the sheet closes and takes its entry back first');
  r.land();
  assert.deepEqual(shown, ['https://mac.ts.net/prototype-reader.html'], 'then the link opens through the shell');
  r.view.unmount();
});

// docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md
test("a card's notes the board's sync carried open in the sheet at once with no request, and a patch that changes them redraws the open sheet", async () => {
  const card = workCard('A1', { lane: 'progress', hasNotes: true });
  const v1 = { ...boardOf([card]), version: 'v1' };
  const v2 = { ...v1, generatedAt: '2026-10-30T10:00:01.000Z', version: 'v2' };
  const b = boardOnDom({ open: ['w/A1'], board: v1, threads: { 'w/A1': [] }, notes: { 'w/A1': '# Synced\n\nFirst.' } });
  b.server.held = { v1 };
  b.server.heldNotes = { v1: { 'w/A1': '# Synced\n\nFirst.' } };
  b.page.win.history = { state: { idx: 3 }, pushState(state) { this.state = state; }, replaceState() {}, back() {} };
  await drain(() => b.view.B.state.notesCache.size === 1, 'the whole board loads every card\'s notes');
  const notesGets = () => b.gets.filter((p) => p.endsWith('/api/notes')).length;
  assert.equal(notesGets(), 1, 'one request after the whole board, for every card at once');
  const sheet = b.root.querySelector('#readerSheet');
  b.page.fire(b.root, 'click', { target: b.root.querySelector('a[href="notes.html?item=w%2FA1"]'), button: 0 });
  assert.equal(sheet.open, true);
  assert.deepEqual([sheet.querySelector('.reader-ref').textContent, sheet.querySelector('.reader-md h1')?.textContent], ['A1 notes', 'Synced'], 'drawn in the same tick as the tap');
  await b.change({ board: v2, notes: { 'w/A1': '# Synced\n\nFirst.\n\n## Build notes' } });
  assert.deepEqual([b.patched, b.view.B.state.board.version], [['v1'], 'v2']);
  assert.equal(sheet.querySelector('.reader-md h2')?.textContent, 'Build notes');
  assert.equal(notesGets(), 1, 'the patch carried the notes; nothing asked for them');
  const shown = sheet.querySelector('.reader-md');
  b.page.fire(b.root, 'click', { target: b.root.querySelector('a[href="notes.html?item=w%2FA1"]'), button: 0 });
  assert.equal(sheet.querySelector('.reader-md'), shown, 'the notes already shown, opened again, stay in place');
  b.page.fire(sheet, 'click', { target: sheet.querySelector('[data-reader="close"]'), button: 0 });
  assert.deepEqual([sheet.open, sheet.classList.contains('closing')], [true, true], 'closing plays the entry backwards');
  b.page.runTimers();
  assert.deepEqual([sheet.open, sheet.classList.contains('closing')], [false, false], 'then the sheet shuts');
  b.view.unmount();
});

test("the reader sheet wraps long lines in monospace and never scrolls sideways", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.reader-body \{[^}]*overflow-x: hidden/);
  assert.match(css, /\.reader-row \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.reader-raw, \.reader-text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*ui-monospace/);
  assert.doesNotMatch(css, /85dvh/);
});

// docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md
test("the thread's Review button, fifth after Visual, sends what /review sends: a bare tap the bare request, typed text with it", async () => {
  const b = boardOnDom({ open: ['w/A1'], board: boardOf([workCard('A1')]), threads: { 'w/A1': [] } });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/A1"]');
  const box = () => form().querySelector('textarea');
  assert.deepEqual(form().querySelector('.request-row').children.map((c) => c.textContent).map((t) => t.replace(/(⌥|Alt\+).$/, '')), ['Prototype', 'Grill', 'Visual', 'Review']);
  const tap = async (text = '') => { box().value = text; b.page.fire(b.root, 'click', { target: form().querySelector('button[data-review]') }); await b.settle(); };
  await tap();
  await tap('Check the diff');
  box().value = '/review';
  b.page.fire(b.root, 'submit', { target: form(), submitter: form().querySelector('button[data-nth="0"]') });
  await b.settle();
  assert.deepEqual(sentNoIds(b), [['review-request', { key: 'w/A1' }], ['review-request', { key: 'w/A1', text: 'Check the diff' }], ['review-request', { key: 'w/A1' }]]);
  b.view.unmount();
});

// docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
// docs/adr/2026-11-17-1335-a-sending-card-button-spins-and-the-lane-waits-for-the-board.md
test("Prototype, Grill and Visual show their line at once as sending…, each button disabled while its own request sends; the board's line takes its place, a failed one reads not sent and frees its button, and Retry resends it in place under its send id", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/A1'], board: boardOf([workCard('A1')]), threads: { 'w/A1': [] }, send: sends.send, confirm: true });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/A1"]');
  const button = (sel) => form().querySelector(sel);
  const tap = async (sel, text = '') => { form().querySelector('textarea').value = text; b.page.fire(b.root, 'click', { target: button(sel) }); await b.settle(); };
  await tap('button[data-proto]');
  const PENDING = [true, false, null];
  assert.deepEqual([waitState(button('button[data-proto]')), waitState(button('button[data-grill]')), threadLines(b, 'w/A1')], [PENDING, IDLE, ['Prototype requested · sending…']]);
  await tap('button[data-grill]', 'Ask about the colours');
  await tap('button[data-visual]');
  assert.deepEqual([waitState(button('button[data-grill]')), waitState(button('button[data-visual]')), threadLines(b, 'w/A1')],
    [PENDING, PENDING, ['Prototype requested · sending…', 'Ask about the colours (Grill requested · sending…)', 'Visual requested · sending…']]);
  assert.equal(b.sent.length, 1, 'one at a time, in order');
  b.server.threads['w/A1'] = [{ ts: '2026-10-30T10:00:00.000Z', who: 'love', via: 'site', kind: 'prototype-request', text: 'Prototype requested', request: true, command: 'prototype', eventId: 'e1', reply: null, state: 'waiting' }];
  sends.answer();
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/A1'), ['Prototype requested · waiting…', 'Ask about the colours (Grill requested · sending…)', 'Visual requested · sending…']);
  assert.deepEqual(waitState(button('button[data-proto]')), IDLE, 'the board has the prototype request');
  sends.answer(false, REFUSED);
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/A1'), ['Prototype requested · waiting…', 'Ask about the colours (Grill requested · not sent)', 'Visual requested · sending…']);
  assert.deepEqual([waitState(button('button[data-grill]')), waitState(button('button[data-visual]'))], [IDLE, PENDING]);
  assert.equal(b.root.querySelector('.toast').textContent, REFUSED);
  const grillId = b.sent[1][1].sendId;
  b.page.fire(b.root, 'click', { target: b.root.querySelector(`[data-thread="w/A1"] button[data-resend="${grillId}"]`) });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), b.sent.at(-1)[0], b.sent.at(-1)[1].sendId], ['Send this message again?', 'grill-more', grillId]);
  assert.deepEqual(sentNoIds(b), [['prototype-request', { key: 'w/A1' }], ['grill-more', { key: 'w/A1', text: 'Ask about the colours' }], ['grill-more', { key: 'w/A1', text: 'Ask about the colours' }]]);
  b.view.unmount();
});

// docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
// docs/adr/2026-11-17-1335-a-sending-card-button-spins-and-the-lane-waits-for-the-board.md
test("a reply box's Block, after its sheet, and Unblock, Done and Reopen, after their confirm, show their line at once as sending…, their button disabled and their card in its lane, end plain once the board has them, and a failed one frees its button and retries in place", async () => {
  const cards = [
    workCard('P1', { lane: 'progress', holdable: true }),
    workCard('H1', { lane: 'progress', holdable: true, ownerBlock: { until: null }, blocked: true }),
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
  const R1 = b.root.querySelector('details.item[data-key="w/R1"]');
  assert.deepEqual([R1.closest('details.lane').dataset.lane, R1.open], ['review', true]);
  const PENDING = [true, false, null];
  assert.deepEqual(cards.map((c) => [threadLines(b, c.key), waitState(second(c.key))]), [
    [['Blocked · sending…'], PENDING], [['Unblocked · sending…'], PENDING], [['Marked done · sending…'], PENDING], [['Reopened · sending…'], PENDING],
  ]);
  assert.deepEqual(sentNoIds(b), [['card-hold', { key: 'w/P1', hold: true, for: '1h' }], ['card-hold', { key: 'w/H1', hold: false }], ['card-done', { key: 'w/R1' }], ['card-reopen', { key: 'w/D1' }]]);
  b.server.threads['w/P1'] = [{ ts: '2026-10-30T10:00:00.000Z', who: 'love', kind: 'command', command: 'hold', request: true, mark: 'Blocked', text: 'Blocked until 11:00 AM' }];
  sends.answer();
  await b.settle();
  assert.deepEqual(threadLines(b, 'w/P1'), ['Blocked until 11:00 AM']);
  sends.answer(false, REFUSED);
  await b.settle();
  assert.deepEqual([threadLines(b, 'w/H1'), waitState(second('w/H1'))], [['Unblocked · not sent'], IDLE]);
  const resumeId = b.sent[1][1].sendId;
  b.page.fire(b.root, 'click', { target: b.root.querySelector(`[data-thread="w/H1"] button[data-resend="${resumeId}"]`) });
  await b.settle();
  assert.deepEqual([b.confirms.at(-1), threadLines(b, 'w/H1'), b.sent.at(-1)[1].sendId], ['Send “Unblocked” again?', ['Unblocked · sending…'], resumeId]);
  b.view.unmount();
});

test("a tap whose POST board cannot land because a reload won the race reads sending… until a board made after the tap is drawn", async () => {
  const T1 = workCard('T1', { bumpable: true, sortAt: '2026-10-01T00:00:00.000Z', order: 0 });
  const T2 = workCard('T2', { bumpable: true, sortAt: '2026-10-02T00:00:00.000Z', order: 1 });
  const v1 = { ...boardOf([T1, T2]), version: 'v1', generatedAt: '2026-10-30T10:00:00.000Z' };
  const raced = { ...v1, version: 'v1b', generatedAt: '2026-10-30T10:00:00.500Z' };
  const bumped = { ...boardOf([{ ...T2, bumpedAt: '2026-10-30T10:00:01.000Z' }, T1]), version: 'v2', generatedAt: '2026-10-30T10:00:01.000Z' };
  let hold = null;
  const b = boardOnDom({ open: ['w/T2'], board: v1, threads: { 'w/T2': [] }, send: async (kind, data, server) => {
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
  const bump = () => bumpItem(b, 'w/T2');
  const sending = () => threadLines(b, 'w/T2').filter((line) => line.endsWith('· sending…'));
  b.page.fire(b.root, 'click', { target: bump() });
  await b.settle();
  assert.deepEqual([order(), sending()], [['w/T1', 'w/T2'], ['Moved to the top · sending…']], 'the board on screen lacks the bump, so its line still reads sending…');
  b.release();
  hold = null;
  await b.settle();
  assert.deepEqual([order(), sending()], [['w/T2', 'w/T1'], []]);
  b.view.unmount();
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

// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
test("from 900px the pane sits beside the lanes with a drag seam and, under any sheet, a landing: the board's name, Open a card to see it here, and chips counting what needs the owner, the questions and the ready cards; a phone mounts none, and no width draws a Needs you deck", async () => {
  const items = [
    workCard('M1', { lane: 'review', action: { kind: 'merge', label: 'Merge', url: '#selectedCard=w%2FM1' } }),
    workCard('S1', { lane: 'progress', action: { kind: 'stalled', label: 'stalled: tests fail', url: '#selectedCard=w%2FS1' } }),
    workCard('Q1', { phase: 'discussing', questions: { topic: 'item:w/Q1', first: 'q1', open: 1, state: 'open' } }),
    workCard('R1', { phase: 'ready' }), workCard('R2', { phase: 'ready' }), workCard('R3', { phase: 'ready' }),
    workCard('N1', { isNew: true, phase: 'ready' }),
  ];
  const board = { ...questionsBoard([openQuestion('q1', 'item:w/Q1')]), title: 'Shop <board>', items, version: 'v1' };
  const wide = boardOnDom({ board, threads: {}, width: 1280 });
  await wide.settle();
  const pane = wide.root.querySelector('#boardPane');
  const chips = () => pane.querySelectorAll('.pane-chip').map((c) => [c.dataset.paneShow, c.textContent, c.classList.contains('notice') ? 'orange' : c.classList.contains('info') ? 'blue' : c.classList.contains('success') ? 'green' : '']);
  assert.equal(pane.getAttribute('aria-label'), 'Pane');
  assert.deepEqual([pane.querySelector('.pane-landing h2').textContent, pane.querySelector('.pane-landing p').textContent], ['Shop <board>', 'Open a card to see it here']);
  assert.deepEqual(chips(), [['action', '2 need you', 'orange'], ['questions', '1 questions', 'blue'], ['ready', '3 ready', 'green']], 'a New entry counts in no chip');
  assert.ok(wide.root.querySelector('.split > .col-handle[data-col="pane"]'), 'the seam between the lanes and the pane drags');
  await wide.change({ board: { ...board, items: items.filter((it) => it.key !== 'w/R3'), version: 'v2' } });
  assert.deepEqual(chips()[2], ['ready', '2 ready', 'green'], "the lanes' next load repaints the chips");
  const narrow = boardOnDom({ board, threads: {} });
  await narrow.settle();
  assert.match(fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8'), /^\.board-pane \{ display: none; \}$/m, 'a phone shows no pane: it shows only from 900px');
  for (const b of [wide, narrow]) {
    assert.deepEqual([b.root.querySelector('#needsDeck'), b.root.querySelector('#waiting'), b.root.querySelector('.deck-card')], [null, null, null], 'no Needs you deck or lines');
    b.view.unmount();
  }
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /needs-deck|deck-card/, 'the stylesheet keeps no deck rules');
});

test("a landing chip shows only its box's cards, unchecking every other box of the board filter", async () => {
  const items = [workCard('M1', { lane: 'review', action: { kind: 'merge', label: 'Merge', url: '#' } }), workCard('Q1', { phase: 'discussing', questions: { topic: 'item:w/Q1', first: 'q1', open: 1, state: 'open' } }), workCard('R1', { phase: 'ready' })];
  const wide = boardOnDom({ board: { ...questionsBoard([openQuestion('q1', 'item:w/Q1')]), items }, threads: {}, width: 1280 });
  await wide.settle();
  const shown = () => wide.root.querySelectorAll('#lanes details.item').map((d) => d.dataset.key);
  assert.deepEqual(shown().sort(), ['w/M1', 'w/Q1', 'w/R1']);
  wide.page.fire(wide.root, 'click', { target: wide.root.querySelector('[data-pane-show="ready"]') });
  await wide.settle();
  assert.deepEqual([shown(), JSON.stringify(wide.view.B.state.boardFilter)], [['w/R1'], JSON.stringify(['action', 'questions', 'blocked'])]);
  wide.page.fire(wide.root, 'click', { target: wide.root.querySelector('[data-pane-show="questions"]') });
  await wide.settle();
  assert.deepEqual(shown(), ['w/Q1']);
  const chip = (id) => wide.root.querySelector(`[data-pane-show="${id}"]`);
  assert.deepEqual([chip('questions').classList.contains('on'), chip('ready').classList.contains('on')], [true, false], 'the chosen chip glows');
  wide.page.fire(wide.root, 'click', { target: chip('questions') });
  await wide.settle();
  assert.deepEqual([JSON.stringify(wide.view.B.state.boardFilter), chip('questions').classList.contains('on')], ['[]', false], 'a second tap clears the filter and the glow');
  wide.view.unmount();
});

// docs/adr/2026-11-17-1944-the-pane-landing-shows-the-board-at-a-glance.md
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const glanceBoard = () => {
  // A Done card comes slim (domain.mjs slimDone): its sortAt is when it closed.
  const landed = (id, m, extra = {}) => workCard(id, { lane: 'done', sortAt: minsAgo(m), phase: 'closed', commit: { sha: 'abc1234', url: null }, ...extra });
  return { ...boardOf([
    workCard('V1', { lane: 'review' }),
    workCard('P1', { lane: 'progress', builder: { phase: 'building', at: minsAgo(30) } }),
    workCard('P2', { lane: 'progress', builder: { phase: 'landing', at: minsAgo(60) } }),
    workCard('P3', { lane: 'progress', stalled: 'tests fail', builder: { phase: 'building', at: minsAgo(10) } }),
    workCard('P4', { lane: 'progress', blocked: true, blockedBy: [{ key: 'w/T1', ref: 'T1', lane: 'todo' }], builder: { phase: 'reading', at: minsAgo(5) } }),
    workCard('T1', { phase: 'ready' }), workCard('T2', { phase: 'ready' }), workCard('T3', { phase: 'discussing' }),
    workCard('T4', { phase: 'ready', blocked: true, blockedBy: [{ key: 'w/P1', ref: 'P1', lane: 'progress' }] }),
    landed('D1', 14), landed('D2', 45, { phase: 'merged', commit: null, pr: { status: 'merged', number: 7 } }), landed('D3', 60), landed('D4', 90),
    landed('D5', 13 * 60), workCard('D6', { lane: 'done', sortAt: minsAgo(5), phase: 'closed' }),
  ]), title: 'Shop', version: 'v1' };
};
const TONES = ['danger', 'notice', 'info', 'success', 'merged', 'quiet'];
const toneOf = (el) => TONES.find((t) => el?.classList.contains(t)) || '';
const glanceOf = (root) => {
  const pane = root.querySelector('#boardPane');
  const row = (r) => [r.dataset.glanceOpen || r.dataset.glanceLane || '', toneOf(r.querySelector('.glance-mark')), r.querySelector('.glance-text')?.textContent ?? r.textContent, r.querySelector('.glance-end')?.textContent ?? ''];
  return {
    heads: pane.querySelectorAll('.glance h3').map((h) => h.textContent),
    lanes: pane.querySelectorAll('.glance-lanes > .glance-row').map(row),
    building: pane.querySelectorAll('.glance-building > *').map(row),
    landed: pane.querySelectorAll('.glance-landed > *').map(row),
  };
};

test("under the pane landing's chips the glance lists each lane with its count and its mark in board order, the cards In Progress red first then by when they started with their phase or block, and the last three landed today newest first, green landed and purple merged", async () => {
  const wide = boardOnDom({ board: glanceBoard(), threads: {}, width: 1280 });
  await wide.settle();
  const g = glanceOf(wide.root);
  assert.deepEqual(g.heads, ['Lanes', 'Building', 'Landed']);
  assert.deepEqual(g.lanes, [
    ['review', 'info', 'In Review1 to review', '1'],
    ['progress', 'danger', 'In Progress1 building · 1 landing · 2 blocked', '4'],
    ['todo', 'notice', 'Todo2 ready · 1 discussing · 1 blocked', '4'],
    ['done', 'success', 'Done4 landed today', '6'],
  ], "a lane's mark is the highest colour among its cards; Done counts the landed, not a card closed unlanded");
  assert.deepEqual(g.building, [
    ['w/P3', 'danger', 'P3Work P3', 'Stalled'],
    ['w/P2', 'notice', 'P2Work P2', 'Landing'],
    ['w/P1', 'notice', 'P1Work P1', 'Building'],
    ['w/P4', 'notice', 'P4Work P4', 'Blocked by T1'],
  ]);
  assert.deepEqual(g.landed, [
    ['w/D1', 'success', 'D1Work D1', 'landed 14m ago'],
    ['w/D2', 'merged', 'D2Work D2', 'merged 45m ago'],
    ['w/D3', 'success', 'D3Work D3', 'landed 1h ago'],
  ], "three at most; yesterday's and one closed without landing aren't listed");
  wide.view.unmount();
});

test("a glance lane line opens its lane if shut and scrolls the board to it, its count reading x of y as the lane header's does; a building or landed row selects its card; over six building rows cap with +N more, which scrolls to In Progress", async () => {
  const board = glanceBoard();
  for (let i = 5; i <= 8; i++) board.items.push(workCard(`P${i}`, { lane: 'progress', builder: { phase: 'building', at: minsAgo(i) } }));
  const wide = boardOnDom({ board, threads: {}, width: 1280, filter: ['ready'] });
  await wide.settle();
  const g = glanceOf(wide.root);
  assert.equal(g.lanes.find((l) => l[0] === 'todo')[3], '2 of 4', "the filter hides two ready cards, as Todo's header says");
  assert.equal(wide.root.querySelector('details.lane[data-lane="todo"] .count').textContent, '2 of 4');
  assert.equal(g.building.length, 7);
  assert.deepEqual(g.building[6], ['progress', '', '+2 more in In Progress', '']);
  const scrolled = [];
  wide.root.constructor.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.dataset.lane || this.dataset.key); };
  const done = () => wide.root.querySelector('details.lane[data-lane="done"]');
  assert.equal(done().open, false, 'Done starts shut');
  wide.page.fire(wide.root, 'click', { target: wide.root.querySelector('[data-glance-lane="done"] .glance-text') });
  await wide.settle();
  assert.deepEqual([done().open, scrolled.at(-1), JSON.parse(wide.page.win.localStorage.getItem('site:board-a:lanes')).done], [true, 'done', true]);
  wide.page.fire(wide.root, 'click', { target: wide.root.querySelector('#glance-more') });
  await wide.settle();
  assert.equal(scrolled.at(-1), 'progress');
  wide.page.fire(wide.root, 'click', { target: wide.root.querySelector('[data-glance-open="w/P1"]') });
  await wide.settle();
  assert.equal(wide.page.win.location.hash, '#selectedCard=w%2FP1');
  wide.page.fire(wide.root, 'click', { target: wide.root.querySelector('[data-glance-open="w/D2"] .glance-end') });
  await wide.settle();
  assert.equal(wide.page.win.location.hash, '#selectedCard=w%2FD2');
  wide.view.unmount();
});

test("the glance repaints with the board's stream: a card that starts building joins Building with an orange wash, a land moves its row to the top of Landed with a green wash, and rows that stayed are the same elements", async () => {
  const board = glanceBoard();
  const wide = boardOnDom({ board, threads: {}, width: 1280 });
  await wide.settle();
  const pane = wide.root.querySelector('#boardPane');
  assert.equal(pane.querySelectorAll('.glance .fresh').length, 0, 'the first paint washes nothing');
  const p1 = pane.querySelector('[data-glance-open="w/P1"]');
  const started = board.items.map((it) => (it.key === 'w/T1' ? { ...it, lane: 'progress', phase: 'reading', builder: { phase: 'reading', at: minsAgo(0) } } : it));
  await wide.change({ board: { ...board, items: started, version: 'v2' } });
  assert.ok(pane.querySelector('[data-glance-open="w/T1"]').classList.contains('fresh'));
  assert.equal(pane.querySelector('[data-glance-open="w/P1"]'), p1, 'a row that stayed is the same element');
  assert.equal(p1.classList.contains('fresh'), false);
  const landed = started.map((it) => (it.key === 'w/P2' ? { ...it, lane: 'done', builder: null, sortAt: minsAgo(0), phase: 'closed', commit: { sha: 'def5678', url: null } } : it));
  await wide.change({ board: { ...board, items: landed, version: 'v3' } });
  const g = glanceOf(wide.root);
  assert.deepEqual(g.landed.map((r) => r[0]), ['w/P2', 'w/D1', 'w/D2']);
  const row = pane.querySelector('.glance-landed [data-glance-open="w/P2"]');
  assert.deepEqual([row.classList.contains('fresh'), row.classList.contains('landed')], [true, true], 'the landed wash is green');
  assert.equal(pane.querySelector('.glance-building [data-glance-open="w/P2"]'), null);
  assert.equal(g.lanes.find((l) => l[0] === 'done')[2], 'Done5 landed today');
  wide.view.unmount();
});

test("each glance block keeps its heading and one grey line when it has nothing: an empty lane reads 0 in grey with no breakdown, Nothing is building, Nothing landed today", async () => {
  const wide = boardOnDom({ board: { ...boardOf([workCard('V1', { lane: 'review' }), workCard('D5', { lane: 'done', sortAt: minsAgo(13 * 60), phase: 'closed', commit: { sha: 'a', url: null } })]), version: 'v1' }, threads: {}, width: 1280 });
  await wide.settle();
  const g = glanceOf(wide.root);
  assert.deepEqual(g.lanes, [
    ['review', 'info', 'In Review1 to review', '1'],
    ['progress', 'quiet', 'In Progress', '0'],
    ['todo', 'quiet', 'Todo', '0'],
    ['done', 'quiet', 'Done', '1'],
  ]);
  assert.ok(wide.root.querySelector('[data-glance-lane="todo"]').classList.contains('empty'));
  assert.deepEqual([g.building.map((r) => r[2]), g.landed.map((r) => r[2])], [['Nothing is building'], ['Nothing landed today']]);
  wide.view.unmount();
});

// docs/adr/2026-11-14-2359-one-owner-of-the-open-selection.md
test("focusQuestion waits for the board, then opens a card's question or topic on the card under its questions sheet, selecting it in the fragment, and with no id shows only Questions", async () => {
  const base = questionsBoard([openQuestion('qa', 'item:w/A'), openQuestion('qb', 'item:w/B')], []);
  const board = { ...base, items: [workCard('A', { questions: { topic: 'item:w/A' } }), workCard('B', { questions: { topic: 'item:w/B' } })] };
  const wide = boardOnDom({ board, threads: {}, width: 1280 });
  assert.equal(wide.view.B.focusQuestion('qa'), false, 'before the board loads, so the shell asks again');
  await wide.settle();
  const win = vm.runInContext('window', wide.page.win);
  const sheet = () => wide.root.querySelector('#questionsSheet');
  const ids = () => sheet().querySelectorAll('section.q').map((s) => s.dataset.q);
  assert.equal(wide.view.B.focusQuestion('qa'), true);
  assert.deepEqual([wide.page.win.location.hash, sheet().open, ids()], ['#selectedCard=w%2FA', true, ['qa']]);
  assert.equal(wide.view.B.focusQuestion('item:w/B'), true);
  assert.deepEqual([wide.page.win.location.hash, wide.root.querySelector('details.item[data-key="w/B"]').open, ids()], ['#selectedCard=w%2FB', true, ['qb']], 'a topic id too');
  wide.page.fire(win, 'hashchange');
  await wide.settle();
  assert.equal(wide.root.querySelector('details.item[data-key="w/B"]').open, true, 'a replay of the URL stays on B');
  assert.equal(JSON.stringify(wide.view.B.state.boardFilter), '[]', 'a card question leaves the filter alone');
  assert.equal(wide.view.B.focusQuestion(null), true);
  assert.equal(JSON.stringify(wide.view.B.state.boardFilter), JSON.stringify(['ready', 'action', 'blocked']));
  wide.view.unmount();
});

// docs/adr/2026-11-12-2359-a-topic-in-the-questions-pane-closes-the-overlays-over-it.md
test('a questions URL closes the reader sheet over the pane for the questions sheet, a prototype in it included', async () => {
  const r = readerOnDom('plain log text', { width: 1280, topics: [openQuestion('q1', 'item:w/T1'), openQuestion('q2', 'item:w/P1')] });
  await r.settle();
  const link = r.root.querySelector('a[href="log.html?file=builder-A1-1.log"]');
  r.tap(link);
  await r.settle();
  assert.equal(r.sheet().open, true);
  r.view.B.focusQuestion('q1');
  r.page.runTimers();
  assert.deepEqual([r.sheet().open, r.root.querySelector('#questionsSheet').open], [false, true], 'a questions URL closes the reader');
  r.view.B.openPage('https://mac.ts.net/board-a/prototype-x2.html?q=q2');
  assert.equal(r.sheet().open, true);
  r.view.B.focusQuestion('q2');
  r.page.runTimers();
  assert.deepEqual([r.sheet().open, r.sheet().querySelector('iframe.reader-frame')], [false, null], 'and the prototype in it');
  r.view.unmount();
});

// docs/adr/2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md
// Card A1 asked qa, then qb; card B1 asked qc; the thread's two Questions added lines name qa and qb.
// gate: an owner-answers send waits on gate.promise, and with gate.down can't reach the board; once through, as
// board/server.mjs records it, each answer's question reads answered and the card's thread gains the set's one line, its
// answers folded as board/domain.mjs foldSubmits folds one write's, with the set's sendId.
function sheetOnDom({ width = 390, board = null, gate = null, lines = null } = {}) {
  const added = (ts, ids) => ({ ts, who: 'claude', kind: 'hub', line: 'questions-added', mark: 'questions', text: `${ids.length} question added`, link: `questions.html#${ids[0]}`, questions: ids, open: true });
  const base = questionsBoard([openQuestion('qa', 'item:w/A1'), openQuestion('qb', 'item:w/A1'), openQuestion('qc', 'item:w/B1')], []);
  const send = async (kind, data, server) => {
    await gate?.promise;
    if (gate?.down) throw Object.assign(new Error('send failed'), { status: 0 });
    if (kind !== 'owner-answers') return { id: 'e0', board: structuredClone(server.board) };
    const texts = data.answers.map((a) => {
      const q = server.board.owner.find((x) => x.id === a.id);
      Object.assign(q, { state: 'answered', answers: [...q.answers, { ts: '2026-11-14T11:00:00.000Z', choice: a.choice, note: a.note, files: [] }] });
      const t = server.board.ownerTopics.find((x) => x.id === q.topic);
      t.open -= 1;
      t.answered += 1;
      return `Question ${t.questions.indexOf(q.id) + 1} · ${q.question}\n→ ${a.label}`;
    });
    const key = server.board.owner.find((x) => x.id === data.answers[0].id).topic.slice(5);
    server.threads[key]?.push({ ts: '2026-11-14T11:00:00.000Z', who: 'love', via: 'questions', kind: 'owner-answer', text: texts.join('\n\n'),
      files: [], eventId: `e-${data.answers[0].id}`, status: 'answers submitted', state: 'waiting', sendId: data.answers[0].sendId });
    return { ids: data.answers.map((a) => `e-${a.id}`), board: structuredClone(server.board) };
  };
  const b = boardOnDom({ open: ['w/A1'], width, send, board: board || { ...base, items: [workCard('A1', { lane: 'progress', questions: { topic: 'item:w/A1', first: 'qa', open: 2, state: 'open' } }), workCard('B1')] },
    threads: { 'w/A1': lines?.(added) || [added('2026-11-14T09:00:00.000Z', ['qa']), added('2026-11-14T10:00:00.000Z', ['qb'])] } });
  const moves = [];
  const { replaceState } = b.page.win.history;
  b.page.win.history = { state: { idx: 3 }, pushState(state, _, url) { moves.push(['push', state, url]); this.state = state; }, replaceState, back() { moves.push(['back']); } };
  const sheet = () => b.root.querySelector('#questionsSheet');
  const line = () => b.root.querySelector('.status-line button[data-questions]');
  const ids = () => sheet().querySelectorAll('section.q').map((s) => s.dataset.q);
  const pick = (id, option = 'B') => {
    const input = sheet().querySelector(`section.q[data-q="${id}"] input[value="${option}"]`);
    input.type = 'radio';
    b.page.fire(sheet(), 'change', { target: input });
  };
  return { ...b, moves, sheet, line, ids, pick };
}

test("a thread's Questions added line keeps its words, orange while a question of its batch is open and gray once none is, and its tap opens the card's questions sheet instead of the page", async () => {
  const s = sheetOnDom();
  await s.settle();
  assert.equal(s.line().textContent, '1 question added', 'the words stay as posted');
  assert.equal(s.line().getAttribute('href'), null, 'it is a button, with no page link for the router to follow');
  assert.equal(s.sheet().open, false);
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  assert.deepEqual([s.sheet().open, s.sheet().modal], [true, true], 'a phone gets the modal sheet');
  assert.deepEqual(s.ids(), ['qb', 'qa'], "only card A1's open questions, the newest batch first");
  assert.equal(s.sheet().querySelectorAll('h3.qs-round').length, 2, 'two batches each get a heading');
  assert.equal(s.sheet().querySelector('#readerTitle'), null);
  assert.equal(s.sheet().querySelectorAll('[data-proto]').length, 2, 'each question has its Prototype');
  assert.deepEqual(s.moves, [], 'the sheet makes no history entry');
  s.view.unmount();
});

// A thread kept from before a questions-added line named its questions holds a line with none.
test("a thread with an older Questions added line that names no questions still fills the sheet", async () => {
  const s = sheetOnDom({ lines: (added) => [{ ...added('2026-11-10T09:00:00.000Z', []), questions: undefined }, added('2026-11-14T10:00:00.000Z', ['qb'])] });
  await s.settle();
  s.page.fire(s.root, 'click', { target: s.root.querySelector('.status-line button[data-questions]'), button: 0 });
  assert.equal(s.sheet().open, true);
  assert.deepEqual(s.ids(), ['qb', 'qa'], 'the named batch, then the question no line names');
  s.view.unmount();
});

test("a card's Questions button opens that topic's questions sheet in place, with only its questions, leaving the page's URL and scroll alone", async () => {
  const base = questionsBoard([openQuestion('qa', 'item:w/A1'), openQuestion('qc', 'item:w/B1')], []);
  const s = sheetOnDom({ board: { ...base, items: [workCard('A1', { lane: 'progress', actionButton: 'openQuestions', resolvedBy: 'openQuestions', questions: { topic: 'item:w/A1', first: 'qa', open: 1, state: 'open' } }), workCard('B1')] } });
  await s.settle();
  const button = s.root.querySelector('button.button[data-questions="qa"]');
  assert.ok(button, 'the card has its Questions button');
  assert.equal(button.getAttribute('href'), null, 'it links nowhere');
  s.page.win.scrollY = 700;
  const hash = s.page.win.location.hash;
  s.page.fire(s.root, 'click', { target: button, button: 0 });
  assert.deepEqual([s.sheet().open, s.ids()], [true, ['qa']], "the tap opens only card A1's questions");
  assert.deepEqual([s.page.win.scrollY, s.page.win.location.hash], [700, hash], 'the page under it did not move');
  s.view.unmount();
});

// docs/adr/2026-11-16-1900-a-sheet-opens-at-its-top-unless-already-open.md
test("a sheet that opens scrolls its body to the top, and one already open keeps its scroll: BoardUI.openSheet", () => {
  const page = fakePage(memoryStorage([]).localStorage);
  miniDom(page.Target, page.win.document);
  const dialog = page.win.document.createElement('dialog');
  dialog.innerHTML = '<div class="body"></div>';
  const body = dialog.querySelector('.body');
  body.scrollTop = 300;
  page.win.BoardUI.openSheet(dialog);
  assert.deepEqual([dialog.open, dialog.modal, body.scrollTop], [true, true, 0], 'closed → opens at the top');
  body.scrollTop = 300;
  page.win.BoardUI.openSheet(dialog, { modal: false });
  assert.deepEqual([dialog.modal, body.scrollTop], [true, 300], 'a call while open changes nothing');
  dialog.close();
  page.win.BoardUI.openSheet(dialog, { modal: false });
  assert.deepEqual([dialog.open, dialog.modal, body.scrollTop], [true, false, 0], 'non-modal on request, at the top again');
});

test("the questions sheet reopens at its top, and opening it again while it is open leaves its scroll", async () => {
  const s = sheetOnDom();
  await s.settle();
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  const body = s.sheet().querySelector('.reader-body');
  body.scrollTop = 250;
  s.pick('qb');
  assert.equal(body.scrollTop, 250, 'a tap inside leaves the scroll');
  s.page.fire(s.sheet(), 'click', { target: s.sheet().querySelector('[data-qs="close"]') });
  s.page.runTimers();
  assert.equal(s.sheet().open, false);
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  assert.deepEqual([s.sheet().open, body.scrollTop], [true, 0], 'reopened at the top');
  body.scrollTop = 250;
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  assert.equal(body.scrollTop, 250, 'opening it again while open keeps the place');
  s.view.unmount();
});

test("the reader sheet reopens at its top, and opening again while it is open keeps its scroll", async () => {
  const r = readerOnDom('plain log text');
  await r.settle();
  const link = r.root.querySelector('a[href="notes.html?item=w%2FA1"]');
  r.tap(link);
  await r.settle();
  const body = r.inSheet('.reader-body');
  body.scrollTop = 400;
  r.tap(link);
  await r.settle();
  assert.equal(body.scrollTop, 400, 'a second open while it is open keeps the place');
  r.page.fire(r.sheet(), 'click', { target: r.inSheet('[data-reader="close"]') });
  r.page.runTimers();
  assert.equal(r.sheet().open, false);
  r.tap(link);
  await r.settle();
  assert.deepEqual([r.sheet().open, body.scrollTop], [true, 0], 'reopened at the top');
});

// docs/adr/2026-11-16-2100-a-question-sets-answers-send-as-one.md
test("the questions sheet's Send sends the answered questions as one owner-answers under one send id and closes the sheet at once, leaving the page where it was", async () => {
  const s = sheetOnDom();
  await s.settle();
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  assert.equal(s.sheet().querySelector('#send').disabled, true, 'nothing picked yet');
  s.pick('qb');
  s.pick('qa');
  assert.equal(s.sheet().querySelector('#send').disabled, false);
  s.page.win.scrollY = 700;
  s.page.fire(s.sheet(), 'submit', { target: s.sheet().querySelector('form') });
  s.page.runTimers();
  assert.equal(s.sheet().open, false, 'Send closes the sheet at once');
  await s.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(s.sent.map(([kind, data]) => [kind, data.answers.map(({ sendId, ...a }) => a)]))),
    [['owner-answers', [{ id: 'qa', question: 'Question qa?', choice: 'B', label: 'B. No', note: '' }, { id: 'qb', question: 'Question qb?', choice: 'B', label: 'B. No', note: '' }]]], 'one request for the set');
  const sendIds = new Set(s.sent[0][1].answers.map((a) => a.sendId));
  assert.deepEqual([sendIds.size, typeof [...sendIds][0]], [1, 'string'], 'every answer carries the one send id');
  assert.equal(s.page.win.scrollY, 700, 'the page did not move');
  assert.deepEqual(s.moves, [], 'no history entry is made or spent');
  s.view.unmount();
});

// docs/adr/2026-11-16-2100-a-question-sets-answers-send-as-one.md
test("a set sent from the sheet shows at once in its card's thread as one message, its answers numbered as the board words them, with one footer, sending…, gives way to the board's own line, and one that fails reads not sent there with one Retry and X, X dismissing it and the sheet keeping its picks", async () => {
  let release;
  const gate = { promise: new Promise((r) => { release = r; }) };
  const s = sheetOnDom({ gate });
  await s.settle();
  const msgs = () => s.root.querySelector('[data-thread="w/A1"] .msgs');
  const answerLines = () => msgs().querySelectorAll('.msg').filter((m) => m.textContent.includes('Question qb?'));
  const reopen = () => { s.page.runTimers(); s.page.fire(s.root, 'click', { target: s.line(), button: 0 }); };
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  s.pick('qb');
  s.pick('qa', 'A');
  s.page.fire(s.sheet(), 'submit', { target: s.sheet().querySelector('form') });
  await s.settle();
  assert.equal(answerLines().length, 1, 'one line for the set, in the thread at once');
  assert.match(answerLines()[0].textContent, /Question 1 · Question qa\?\s*→ A\. Yes[\s\S]*Question 2 · Question qb\?\s*→ B\. No/);
  assert.equal(answerLines()[0].querySelectorAll('.msg-foot').length, 1, 'one footer');
  assert.match(answerLines()[0].querySelector('.msg-foot').textContent, /answers submitted·sending…$/);
  assert.equal(s.sheet().classList.contains('closing'), true, 'the sheet closes on Send');

  gate.down = true;
  release();
  await s.settle();
  assert.match(answerLines()[0].querySelector('.msg-foot').textContent, /not sent$/);
  assert.deepEqual([answerLines()[0].querySelectorAll('[data-resend]').length, answerLines()[0].querySelectorAll('[data-unsend]').length], [1, 1], 'one Retry and one X for the set');
  reopen();
  assert.deepEqual(['qa', 'qb'].map((id) => /not sent/.test(s.sheet().querySelector(`section.q[data-q="${id}"] .sent-line`).textContent)), [true, true], 'opened again, the sheet shows the set not sent');

  s.page.fire(s.root, 'click', { target: answerLines()[0].querySelector('[data-unsend]') });
  await s.settle();
  assert.equal(answerLines().length, 0, 'X dismisses the message');
  assert.deepEqual([s.sent.length, s.sheet().querySelector('section.q[data-q="qb"] input[value="B"]').hasAttribute('checked'), s.sheet().querySelector('section.q[data-q="qa"] input[value="A"]').hasAttribute('checked')], [1, true, true],
    'nothing sent again, and the open sheet keeps the picks made before the send');
  s.page.fire(s.sheet(), 'click', { target: s.sheet().querySelector('[data-qs="close"]') });
  reopen();
  assert.equal(s.sheet().querySelector('section.q[data-q="qb"] input[value="B"]').hasAttribute('checked'), true, 'and so does the sheet opened again');

  gate.down = false;
  s.page.fire(s.sheet(), 'submit', { target: s.sheet().querySelector('form') });
  await s.settle();
  assert.deepEqual([s.sent.filter(([kind]) => kind === 'owner-answers').length, answerLines().length], [2, 1], "sent again, and the board's line takes the page's place");
  assert.match(answerLines()[0].querySelector('.msg-foot').textContent, /waiting…$/);
  s.view.unmount();
});

// docs/adr/2026-11-16-1100-a-questions-requests-go-out-through-the-answer-outbox.md
test("a request sent from the sheet shows at once in its card's thread as that request, sending…, and one that fails reads not sent there with Retry and X", async () => {
  const gate = { promise: Promise.resolve(), down: true };
  const s = sheetOnDom({ gate });
  await s.settle();
  const msgs = () => s.root.querySelector('[data-thread="w/A1"] .msgs');
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  s.page.fire(s.sheet(), 'click', { target: s.sheet().querySelector('section.q[data-q="qb"] [data-visual]') });
  await s.settle();
  const line = () => msgs().querySelectorAll('.msg').find((m) => m.textContent.includes('Visual requested'));
  assert.match(line().textContent, /^Visual requested · \S.* · not sent$/);
  assert.ok(line().querySelector('[data-resend]') && line().querySelector('[data-unsend]'), 'Retry and X in the thread');
  s.view.unmount();
});

test("on a wide board a Questions button opens the sheet beside the pane on the first tap, which stays open, and its ✕ closes it with the URL and history untouched", async () => {
  const base = questionsBoard([openQuestion('qa', 'item:w/A1')], []);
  const s = sheetOnDom({ width: 1280, board: { ...base, items: [workCard('A1', { lane: 'progress', actionButton: 'openQuestions', resolvedBy: 'openQuestions', questions: { topic: 'item:w/A1', first: 'qa', open: 1, state: 'open' } })] } });
  await s.settle();
  const hash = s.page.win.location.hash;
  s.page.fire(s.root, 'click', { target: s.root.querySelector('button.button[data-questions="qa"]'), button: 0 });
  await s.settle();
  assert.deepEqual([s.sheet().open, s.sheet().modal, s.page.win.location.hash], [true, false, hash]);
  s.page.fire(s.sheet(), 'click', { target: s.sheet().querySelector('[data-qs="close"]') });
  s.page.runTimers();
  assert.deepEqual([s.sheet().open, s.page.win.location.hash, s.moves], [false, hash, []]);
  s.view.unmount();
});

test("a card's Questions button opens the sheet on the latest answered batch once every question is answered, on a phone and from 900px, where opening the card by itself opens none", async () => {
  const done = (id) => openQuestion(id, 'item:w/A1', { state: 'answered', answers: [{ ts: '2026-11-14T11:00:00.000Z', choice: 'A', note: '', files: [] }] });
  const base = questionsBoard([done('qa'), done('qb')], []);
  base.ownerTopics[0].answered = 2;
  const board = { ...base, items: [workCard('A1', { lane: 'progress', actionButton: 'openQuestions', resolvedBy: 'openQuestions', questions: { topic: 'item:w/A1', first: 'qa', open: 0, answered: 2, state: 'answered' } })] };
  for (const width of [390, 1280]) {
    const s = sheetOnDom({ width, board });
    await s.settle();
    if (width === 1280) {
      s.page.fire(s.root, 'click', { target: s.root.querySelector('details.item[data-key="w/A1"] > summary'), button: 0 });
      assert.equal(s.sheet().open, false, 'opening the card opens none with nothing open');
    }
    s.page.fire(s.root, 'click', { target: s.root.querySelector('button.button[data-questions="qa"]'), button: 0 });
    await s.settle();
    assert.deepEqual([s.sheet().open, s.ids()], [true, ['qb']], `${width}px: the latest batch, answered`);
    s.view.unmount();
  }
});

// docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
test("a card's Questions button opens the sheet on its resolved questions, fetched by topic and read-only, once the board download holds none", async () => {
  const resolved = (id) => openQuestion(id, 'item:w/A1', { state: 'resolved', answers: [{ ts: '2026-11-14T11:00:00.000Z', choice: 'A', note: `note ${id}`, files: [] }] });
  const base = questionsBoard([], []);
  base.ownerTopics = [{ id: 'item:w/A1', title: 'Topic', state: 'resolved', questions: ['qa', 'qb'], open: 0, answered: 0, resolved: 2 }];
  const board = { ...base, items: [workCard('A1', { lane: 'progress', actionButton: 'openQuestions', resolvedBy: 'openQuestions', questions: { topic: 'item:w/A1', first: 'qa', open: 0, answered: 0, resolved: 2, state: 'resolved' } })] };
  for (const width of [390, 1280]) {
    const s = sheetOnDom({ width, board });
    await s.settle();
    const asked = [];
    s.page.win.fetch = async (url) => { asked.push(url); return { ok: true, status: 200, json: async () => ({ questions: [resolved('qa'), resolved('qb')] }) }; };
    s.page.fire(s.root, 'click', { target: s.root.querySelector('button.button[data-questions="item:w/A1"]'), button: 0 });
    await s.settle();
    assert.deepEqual([s.sheet().open, s.ids()], [true, ['qb']], `${width}px: the latest batch, resolved`);
    assert.ok(asked.every((u) => u.endsWith('api/questions?topic=item%3Aw%2FA1')) && asked.length === 1, 'fetched by topic');
    assert.equal(s.sheet().querySelectorAll('section.q input[type="radio"]:not([disabled])').length, 0, 'read-only');
    assert.match(s.sheet().textContent, /note qb/);
    s.view.unmount();
  }
});

// The cards scroll in the sheet's body and Send sits in a footer under it, its status counting the questions answered.
test("the questions sheet's Send and status sit in a footer outside its scrolling body, the status counting what is answered", async () => {
  const s = sheetOnDom();
  await s.settle();
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  const foot = s.sheet().querySelector('.qs-foot');
  assert.ok(foot && foot.querySelector('#send') && foot.querySelector('#qstatus'), 'the footer holds Send and the status');
  assert.equal(foot.closest('.reader-body'), null, 'outside the scrolling body');
  assert.equal(s.sheet().querySelector('.reader-body form'), null, 'the form wraps the body and the footer, not the cards alone');
  assert.equal(foot.closest('form'), s.sheet().querySelector('.reader-body').closest('form'));
  assert.equal(s.sheet().querySelector('#qstatus').textContent, '0 of 2 answered');
  s.pick('qa');
  assert.equal(s.sheet().querySelector('#qstatus').textContent, '1 of 2 answered');
  assert.ok(s.sheet().classList.contains('keyboard-sheet'), 'the open sheet follows the keyboard (dialogs.js fitSheet)');
  s.view.unmount();
});

test('a prototype question opens in the sheet with its View prototypes link, and from 900px the sheet is not modal and a questions URL opens its topic in it', async () => {
  const proto = sheetOnDom({ board: { ...questionsBoard([openQuestion('qp', 'item:w/A1', { url: 'prototype-x2.html?q=qp' })], []), items: [workCard('A1', { lane: 'progress' })] } });
  await proto.settle();
  assert.equal(proto.view.B.openQuestionsSheet('qp'), true);
  assert.ok(proto.sheet().querySelector('section.q[data-q="qp"] a.proto-view'));
  proto.view.unmount();
  const wide = sheetOnDom({ width: 1280 });
  await wide.settle();
  wide.page.fire(wide.root, 'click', { target: wide.line(), button: 0 });
  assert.deepEqual([wide.sheet().open, wide.sheet().modal], [true, false]);
  wide.view.B.focusQuestion('item:w/B1');
  await wide.settle();
  assert.deepEqual([wide.sheet().open, wide.ids(), wide.root.querySelector('details.item[data-key="w/B1"]')?.open], [true, ['qc'], true], "a topic's URL opens it in the sheet and its card on the board");
  wide.view.unmount();
});

// docs/adr/2026-11-16-0600-on-desktop-the-questions-sheet-follows-the-opened-card-unless-opened-by-hand.md
test("from 900px opening a card opens its questions sheet while none is open or the open one followed, swapping as cards open and closing for a card with no questions; a sheet opened by hand stays", async () => {
  const qs = [openQuestion('qa', 'item:w/A1'), openQuestion('qb', 'item:w/A1'), openQuestion('qc', 'item:w/B1'), openQuestion('qd', 'item:w/D1'), openQuestion('qe', 'item:w/E1')];
  const board = { ...questionsBoard(qs, []), items: [workCard('A1', { lane: 'progress', questions: { topic: 'item:w/A1', first: 'qa', open: 2, state: 'open' } }), workCard('B1'), workCard('C1'), workCard('D1'), workCard('E1')] };
  const s = sheetOnDom({ width: 1280, board });
  await s.settle();
  const openCard = (key) => s.page.fire(s.root, 'click', { target: s.root.querySelector(`details.item[data-key="w/${key}"] > summary`), button: 0 });
  openCard('B1');
  assert.deepEqual([s.sheet().open, s.sheet().modal, s.ids()], [true, false, ['qc']], 'a card opened with no sheet open opens its questions');
  openCard('D1');
  assert.deepEqual([s.sheet().open, s.ids()], [true, ['qd']], 'the next card swaps it');
  openCard('C1');
  s.page.runTimers();
  assert.equal(s.sheet().open, false, 'a card with no open questions closes a followed sheet');
  s.view.B.openQuestionsSheet('qa');
  s.view.B.focusQuestion;
  s.page.fire(s.root, 'click', { target: s.root.querySelector('details.item[data-key="w/B1"] > summary'), button: 0 });
  assert.deepEqual([s.sheet().open, s.ids()], [true, ['qb', 'qa']], 'a sheet opened by hand stays when a card opens');
  s.page.fire(s.sheet(), 'click', { target: s.sheet().querySelector('[data-qs="close"]') });
  s.page.runTimers();
  assert.equal(s.sheet().open, false, 'closing by hand leaves none');
  s.view.unmount();
  const phone = sheetOnDom({ board });
  await phone.settle();
  phone.page.fire(phone.root, 'click', { target: phone.root.querySelector('details.item[data-key="w/B1"] > summary'), button: 0 });
  assert.equal(phone.sheet().open, false, 'a phone opens none');
  phone.view.unmount();
});

// docs/adr/2026-11-18-1200-on-desktop-a-card-with-no-questions-opens-its-notes-by-itself.md
test("from 900px opening a card with no open questions opens its notes in the reader by itself, swapped as cards open, closed on collapse, and never over a view opened by hand; a card with no notes and a phone open nothing", async () => {
  const qs = [openQuestion('qa', 'item:w/A1')];
  const board = { ...questionsBoard(qs, []), items: [
    workCard('A1', { lane: 'progress', hasNotes: true, questions: { topic: 'item:w/A1', first: 'qa', open: 1, state: 'open' } }),
    workCard('B1', { hasNotes: true }), workCard('C1', { hasNotes: true }), workCard('D1')] };
  const notes = { 'w/A1': '# Notes A1', 'w/B1': '# Notes B1', 'w/C1': '# Notes C1' };
  const wide = boardOnDom({ open: ['w/C1'], board, threads: {}, notes, width: 1280 });
  await wide.settle();
  const reader = () => wide.root.querySelector('#readerSheet');
  const text = () => reader().querySelector('.reader-body')?.textContent ?? '';
  const questions = () => wide.root.querySelector('#questionsSheet');
  const tapCard = (key, open) => { wide.root.querySelector(`details.item[data-key="w/${key}"]`).open = open; wide.page.fire(wide.root, 'click', { target: wide.root.querySelector(`details.item[data-key="w/${key}"] > summary`), button: 0 }); };
  tapCard('B1', false);
  await wide.settle();
  assert.deepEqual([reader().open, reader().modal, /Notes B1/.test(text())], [true, false, true], 'a card with no questions opens its notes');
  tapCard('C1', false);
  await wide.settle();
  assert.deepEqual([reader().open, /Notes C1/.test(text())], [true, true], 'the next card swaps them in place');
  tapCard('A1', false);
  wide.page.runTimers();
  assert.deepEqual([questions().open, reader().open], [true, false], 'a card with questions swaps the notes for its questions');
  tapCard('A1', true);
  wide.page.runTimers();
  tapCard('D1', false);
  await wide.settle();
  assert.equal(reader().open, false, 'a card with no notes opens nothing');
  tapCard('B1', false);
  await wide.settle();
  tapCard('B1', true);
  wide.page.runTimers();
  assert.equal(reader().open, false, 'collapsing the card closes its notes');
  // Notes opened by hand stay.
  tapCard('C1', false);
  await wide.settle();
  wide.page.fire(wide.root, 'click', { target: wide.root.querySelector('a[href="notes.html?item=w%2FC1"]'), button: 0 });
  await wide.settle();
  tapCard('B1', false);
  await wide.settle();
  assert.deepEqual([reader().open, /Notes C1/.test(text())], [true, true], 'notes opened by hand stay when a card opens');
  tapCard('C1', true);
  wide.page.runTimers();
  assert.equal(reader().open, true, 'and through a collapse');
  wide.view.unmount();
  const phone = boardOnDom({ board, threads: {}, notes, width: 390 });
  await phone.settle();
  phone.page.fire(phone.root, 'click', { target: phone.root.querySelector('details.item[data-key="w/B1"] > summary'), button: 0 });
  await phone.settle();
  assert.equal(phone.root.querySelector('#readerSheet').open, false, 'a phone opens none');
  phone.view.unmount();
});

// docs/adr/2026-11-16-2330-a-cards-questions-sheet-opens-once-hides-on-collapse-and-a-tap-keeps-it.md
test("opening a card whose questions sheet is already open leaves it alone, collapsing a card closes its auto-opened sheet and not one opened by hand, and Questions on an auto-opened sheet makes it the owner's", async () => {
  const qs = [openQuestion('qa', 'item:w/A1'), openQuestion('qb', 'item:w/A1'), openQuestion('qc', 'item:w/B1')];
  const board = { ...questionsBoard(qs, []), items: [workCard('A1', { lane: 'progress', questions: { topic: 'item:w/A1', first: 'qa', open: 2, state: 'open' } }), workCard('B1', { questions: { topic: 'item:w/B1', first: 'qc', open: 1, state: 'open' } })] };
  const s = sheetOnDom({ width: 1280, board });
  await s.settle();
  const summary = (key) => s.root.querySelector(`details.item[data-key="w/${key}"] > summary`);
  const tapCard = (key, open) => { s.root.querySelector(`details.item[data-key="w/${key}"]`).open = open; s.page.fire(s.root, 'click', { target: summary(key), button: 0 }); };
  const mark = () => { s.sheet().querySelector('form').marked = true; };
  const marked = () => s.sheet().querySelector('form')?.marked === true;
  // 1: a card opening whose questions the sheet already shows leaves the sheet alone.
  tapCard('A1', false);
  assert.deepEqual([s.sheet().open, s.ids()], [true, ['qb', 'qa']]);
  mark();
  assert.equal(marked(), true, 'the mark takes');
  tapCard('A1', false);
  assert.equal(s.sheet().classList.contains('closing'), false);
  assert.equal(marked(), true, 'opening the card again neither redraws nor resets the open sheet');
  // 2: collapsing the card closes the sheet it opened by itself.
  tapCard('A1', true);
  s.page.runTimers();
  assert.equal(s.sheet().open, false, "collapsing a card closes its auto-opened sheet");
  // Collapsing another card leaves an auto-opened sheet for the first.
  tapCard('A1', false);
  tapCard('B1', true);
  assert.deepEqual([s.sheet().open, s.ids()], [true, ['qb', 'qa']], "collapsing a card the sheet isn't showing leaves it");
  // 3: Questions on the open auto sheet makes it the owner's, which stays.
  s.view.B.openQuestionsSheet('item:w/A1');
  tapCard('A1', true);
  s.page.runTimers();
  assert.equal(s.sheet().open, true, 'a sheet the owner opened stays through a collapse');
  tapCard('B1', false);
  assert.deepEqual([s.sheet().open, s.ids()], [true, ['qb', 'qa']], 'and when another card opens');
  s.view.unmount();
});

test("a questions URL or push on an open question of a card opens the card with its questions sheet open, and on a phone a card's topic does too", async () => {
  const s = sheetOnDom({ width: 1280 });
  await s.settle();
  assert.equal(s.view.B.focusQuestion('qb'), true);
  assert.deepEqual([s.sheet().open, s.ids(), s.page.win.location.hash], [true, ['qb', 'qa'], '#selectedCard=w%2FA1']);
  s.view.B.focusQuestion('qc');
  assert.deepEqual([s.sheet().open, s.ids()], [true, ['qc']]);
  assert.equal(s.view.B.openQuestionsSheet('nope'), false);
  s.view.unmount();

  // docs/adr/2026-11-16-0828-on-a-phone-a-cards-questions-open-over-the-card.md
  const phone = sheetOnDom();
  await phone.settle();
  assert.equal(phone.view.B.focusQuestion('item:w/A1'), true);
  assert.deepEqual([phone.sheet().open, phone.sheet().modal, phone.ids(), phone.page.win.location.hash, phone.root.querySelector('details.item[data-key="w/A1"]').open],
    [true, true, ['qb', 'qa'], '#selectedCard=w%2FA1', true], "on a phone a card's topic opens the card under its modal sheet");
  phone.view.unmount();
});

// docs/adr/2026-11-16-0514-prototypes-and-visuals-open-in-the-reader-sheet.md
test("a prototype or a visual opens in the reader sheet: the page framed under its kind, the card's ref and the page's title, the Round pill and Open alone ↗; opened again it stays put, a round or a card page it links opens over it with an entry of its own, which its ✕ or Back peels back to the page beneath as it was, and any other link or Choose this closes it with every page first", async () => {
  const round = (n, q, state) => ({ n, q, url: `prototype-x${n}.html?q=${q}`, confirm: false, state });
  const board = { ...questionsBoard([openQuestion('q1', 'item:w/T1'), openQuestion('q2', 'item:w/P1', { url: 'prototype-x2.html?q=q2' })], []),
    items: [workCard('T1'), workCard('P1', { ref: '#287', questions: { topic: 'item:w/P1' }, prototypes: { open: true, rounds: [round(1, 'q0', 'resolved'), round(2, 'q2', 'open')] } })] };
  const b = boardOnDom({ board, threads: {}, width: 1280 });
  const { moves, land: landBack, ownerBack } = stackHistory(b.page, { idx: 3 });
  const shown = [];
  b.page.win.AppShell = { open: (href) => { shown.push(href); return true; } };
  await b.settle();
  const sheet = b.root.querySelector('#readerSheet');
  const frame = () => sheet.querySelector('iframe.reader-frame');
  const head = () => [sheet.querySelector('#readerTitle').textContent, sheet.querySelector('.reader-ref').textContent];
  const tap = async (target) => { b.page.fire(sheet, 'click', { target, button: 0 }); await b.settle(); };
  const proto = 'https://mac.ts.net/board-a/prototype-x2.html?q=q2';
  // The page loading in the frame: its title, and a tap on a link in it.
  const land = (href, title) => {
    const u = new URL(href);
    const doc = Object.assign(new b.page.Target(), { title });
    frame().contentWindow = { document: doc, location: { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash } };
    b.page.fire(frame(), 'load');
    return (to) => b.page.fire(doc, 'click', { button: 0, target: { closest: (sel) => (sel === 'a[href]' ? { href: to, target: '', hasAttribute: () => false } : null) } });
  };

  assert.equal(b.view.B.openPage(proto), true);
  assert.deepEqual([sheet.open, sheet.modal, sheet.classList.contains('reader-page'), frame().getAttribute('src')], [true, false, true, proto], 'from 900px it opens beside the board, widened for the page');
  assert.deepEqual(head(), ['prototype', '#287']);
  assert.equal(sheet.querySelector('.reader-tools .ps-chip').textContent, 'Round 2 of 2 · earlier');
  const alone = sheet.querySelector('.reader-tools a.reader-alone');
  assert.deepEqual([alone.getAttribute('href'), alone.getAttribute('target')], ['/board-a/prototype-x2.html?q=q2&alone=1', '_blank']);
  const linkIn = land(proto, 'Snooze takes');
  assert.deepEqual(head(), ['prototype', '#287 · Snooze takes'], "the page's title joins the card's ref once it loads");
  const first = frame();
  assert.equal(b.view.B.openPage(proto), true);
  assert.equal(frame(), first, 'opened again it stays put');

  await tap(sheet.querySelector('[data-ps-top="rounds"]'));
  assert.match(sheet.querySelector('.ps-sheet').textContent, /Rounds on #287/);
  await tap(sheet.querySelector('[data-ps-round="prototype-x1.html?q=q0"]'));
  assert.deepEqual([frame().getAttribute('src'), sheet.querySelector('.ps-sheet'), sheet.open], ['https://mac.ts.net/board-a/prototype-x1.html?q=q0', null, true], 'a round opens over the page');
  const roundFrame = frame();
  const linkOut = land('https://mac.ts.net/board-a/prototype-x1.html?q=q0', 'Round 1');
  assert.equal(linkOut('https://mac.ts.net/board-a/visuals/T1/flow.html').defaultPrevented, true);
  assert.deepEqual([frame().getAttribute('src'), head()], ['https://mac.ts.net/board-a/visuals/T1/flow.html', ['visual', 'T1']], "a visual it links opens over it, under its card's ref");
  assert.deepEqual(sheet.querySelectorAll('.reader-body').map((el) => el.hidden), [false, true, true], 'the pages beneath keep their frames, hidden');
  assert.deepEqual(moves.map(([m, state]) => [m, state?.sheets]), [['push', 1], ['push', 2], ['push', 3]], 'one history entry for each page');

  await tap(sheet.querySelector('[data-reader="close"]'));
  assert.deepEqual([sheet.open, frame(), head(), moves.at(-1)], [true, roundFrame, ['prototype', '#287 · Round 1'], ['back']], "the visual's ✕ shows the round again as it was, its entry spent");
  landBack();
  ownerBack();
  assert.deepEqual([sheet.open, frame(), head(), sheet.querySelectorAll('.reader-body').length], [true, first, ['prototype', '#287 · Snooze takes'], 1], 'Back shows the first page again');
  assert.equal(linkIn('https://mac.ts.net/board-a/prototype-x2.html?q=q2#take-b').defaultPrevented, false, 'a link within the page is its own');

  assert.equal(linkIn('https://mac.ts.net/board-a/#selectedCard=w%2FT1').defaultPrevented, true);
  b.page.runTimers();
  assert.deepEqual([sheet.open, moves.at(-1), shown, frame()], [false, ['back'], [], null], 'any other link closes the sheet and drops the page first');
  landBack();
  assert.deepEqual(shown, ['https://mac.ts.net/board-a/#selectedCard=w%2FT1'], 'then opens through the shell');

  b.view.B.openPage(proto);
  b.page.fire(sheet, 'reader-leave', { detail: 'https://mac.ts.net/board-a/questions.html#q2' });
  b.page.runTimers();
  landBack();
  assert.deepEqual([sheet.open, sheet.classList.contains('reader-page'), shown.at(-1)], [false, false, 'https://mac.ts.net/board-a/questions.html#q2'], "Choose this with no questions sheet under it leaves through the sheet");
  b.view.unmount();

  const phone = boardOnDom({ board, threads: {} });
  await phone.settle();
  stackHistory(phone.page, { idx: 1 });
  phone.view.B.openPage(proto);
  const phoneSheet = phone.root.querySelector('#readerSheet');
  assert.deepEqual([phoneSheet.open, phoneSheet.modal, phoneSheet.classList.contains('reader-page')], [true, true, true], 'a phone opens the modal sheet');
  phone.view.unmount();
});

// docs/adr/2026-11-17-0306-a-sheet-opened-from-another-stacks-on-it.md
test("a prototype or a visual opened from the questions sheet stacks on it, with one history entry; Choose this closes only the prototype, leaving the question with the take picked, and Back or a close returns to the question", async () => {
  const round = { n: 1, q: 'q2', url: 'prototype-x2.html?q=q2', confirm: false, state: 'open' };
  const board = { ...questionsBoard([openQuestion('q2', 'item:w/P1', { url: 'prototype-x2.html?q=q2' })], []),
    items: [workCard('P1', { ref: '#287', questions: { topic: 'item:w/P1', first: 'q2', open: 1, state: 'open' }, prototypes: { open: true, rounds: [round] } })] };
  const proto = 'https://mac.ts.net/board-a/prototype-x2.html?q=q2';
  const visual = 'https://mac.ts.net/board-a/visuals/P1/flow.html';
  for (const width of [390, 1280]) {
    const b = boardOnDom({ board, threads: {}, width });
    await b.settle();
    const { moves, land, ownerBack } = stackHistory(b.page, { idx: 3 });
    const shown = [];
    b.page.win.AppShell = { open: (href) => { shown.push(href); return true; } };
    const questions = b.root.querySelector('#questionsSheet');
    const reader = b.root.querySelector('#readerSheet');
    const picked = () => questions.querySelector('section.q[data-q="q2"] input[value="B"]')?.hasAttribute('checked');
    const top = (sheet) => b.page.win.BoardUI.isTopSheet(sheet);

    assert.equal(b.view.B.openQuestionsSheet('q2'), true);
    assert.equal(questions.querySelector('section.q[data-q="q2"] a.proto-view').getAttribute('href'), 'prototype-x2.html?q=q2');
    assert.deepEqual(moves, [], `${width}: the questions sheet alone has no entry`);
    // The question's View prototypes, which the shell hands to the board's reader sheet (shell.js go).
    b.view.B.openPage(proto);
    assert.deepEqual([questions.open, reader.open, top(reader), reader.modal, questions.modal], [true, true, true, width < 900, width < 900], `${width}: the prototype stacks on the questions sheet, which stays open`);
    assert.deepEqual(JSON.parse(JSON.stringify(moves)), [['push', { idx: 4, sheets: 1 }, 'https://mac.ts.net/']], 'one entry for the layer');

    // Choose this: prototype-switcher.js drafts the pick, then hands the question's URL to the sheet.
    b.page.win.BoardUI.setDraft('q2', { choice: 'B', note: '' });
    b.page.fire(reader, 'reader-leave', { detail: 'https://mac.ts.net/board-a/questions.html#q2' });
    assert.deepEqual([top(questions), picked(), moves.at(-1)], [true, true, ['back']], 'the questions sheet is on top again, the take picked, and the entry spent');
    land();
    b.page.runTimers();
    assert.deepEqual([reader.open, reader.querySelector('iframe.reader-frame'), questions.open, shown], [false, null, true, []], 'only the prototype closed: nothing navigates');

    // A visual linked in the question stacks the same way, and Back peels it off.
    b.view.B.openPage(visual);
    assert.deepEqual([reader.open, questions.open, top(reader)], [true, true, true]);
    ownerBack();
    b.page.runTimers();
    assert.deepEqual([reader.open, questions.open, top(questions), moves.filter(([m]) => m === 'back').length], [false, true, true, 1], 'Back closes the visual, back on the question; Back took the entry itself');

    // Its ✕ does too.
    b.view.B.openPage(visual);
    b.page.fire(reader, 'click', { target: reader.querySelector('[data-reader="close"]'), button: 0 });
    land();
    b.page.runTimers();
    assert.deepEqual([reader.open, questions.open, top(questions)], [false, true, true]);
    b.view.unmount();
  }
});

test("a card page's sheet stands near full height on a phone, and from 900px takes the pane's width like every sheet, stacked over the questions sheet", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const wideAt = css.indexOf('@media (min-width: 900px) {\n  .split');
  assert.doesNotMatch(css, /\.reader-sheet\.reader-page \{/, 'a card page has no height of its own');
  assert.match(css.slice(0, wideAt), /\.reader-frame \{[^}]*flex: 1;[^}]*border: 0;/);
  assert.match(css.slice(wideAt), /\.sheet\.reader-sheet, \.sheet\.arch-sheet, \.settings-modal \{ position: fixed; z-index: calc\(30 \+ var\(--layer, 0\)\);/, 'a sheet stacked over another lies above it by its layer (ui.js openSheet)');
  assert.doesNotMatch(css, /reader-page \{ z-index/);
  assert.doesNotMatch(css, /pane-viewer|\.pv-top|board-pane\.viewing|board-pane\.widened/, 'the pane viewer is gone');
});

// docs/adr/2026-11-17-1800-the-board-menu-holds-settings-repo-review-and-pause.md
test("the board has no foot: the bulb and the gear are rows of the board menu", async () => {
  const b = boardOnDom({ board: boardOf([workCard('T1')]), threads: {} });
  await b.settle();
  assert.equal(b.root.querySelector('.board-foot'), null);
  assert.equal(b.root.querySelector('#archBulb'), null);
  assert.equal(b.root.querySelector('#settingsLink'), null, 'the menu draws Settings only while open');
  b.view.unmount();
});

// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
test("at every width the board header ends in search, the board filter and the orchestrator's waits mark, in that order, with no ?; the bulb and gear are never in the header", async () => {
  for (const width of [390, 1280]) {
    const b = boardOnDom({ board: questionsBoard([openQuestion('q1', 't1')]), threads: {}, width });
    await b.settle();
    const nav = b.root.querySelector('.top .nav');
    assert.deepEqual(nav.querySelectorAll('#searchOpen, #boardFilter, #waitsChip').map((el) => el.id), ['searchOpen', 'boardFilter', 'waitsChip']);
    assert.equal(nav.children.at(-1).id, 'waitsChip', 'the waits mark is rightmost');
    assert.deepEqual([b.root.querySelector('#questionsLink'), b.root.querySelector('.q-count'), b.root.querySelector('.top #archBulb'), b.root.querySelector('.top #settingsLink'), b.root.querySelector('.board-foot')], [null, null, null, null, null]);
    b.view.unmount();
  }
});

// docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md
test("the board header's chip counts what waits on the orchestrator, its tap opens the list in the file's order, a card's row opens the card, and at 0 the hourglass stays without a badge", async () => {
  const ago = (m) => new Date(NOW - m * 60000).toISOString();
  const orchestratorWaits = [
    { key: 'w/T2', ref: 'T2', title: 'Work T2', kind: 'calls', since: ago(34), tone: 'red' },
    { key: 'w/T1', ref: 'T1', title: 'Work T1', kind: 'intake', since: ago(4), tone: 'grey' },
    { key: 'ev-9', ref: '2026-11-12', title: 'Overnight triage 2026-11-12', kind: 'triage', since: ago(2), tone: 'grey' },
  ];
  const b = boardOnDom({ board: { ...boardOf([workCard('T1'), workCard('T2')]), orchestratorWaits }, threads: {} });
  await b.settle();
  const chip = () => b.root.querySelector('.top .nav #waitsChip [data-waits]');
  const sheet = b.root.querySelector('#waitsSheet');
  assert.equal(chip().getAttribute('aria-label'), '3 waiting on the orchestrator');
  assert.equal(chip().querySelector('.q-badge').textContent, '3');
  assert.ok(chip().querySelector('.q-badge.tone-red'), 'one wait is past the 30-minute push');
  b.page.fire(b.root.querySelector('#waitsChip'), 'click', { target: chip() });
  assert.equal(sheet.open, true);
  assert.equal(b.root.querySelector('#waitsTitle').textContent, 'Waiting on the orchestrator · 3');
  assert.deepEqual(sheet.querySelectorAll('.waits-ref').map((r) => r.textContent), ['T2', 'T1', '2026-11-12']);
  b.page.fire(sheet, 'click', { target: sheet.querySelector('[data-wait-open="w/T1"]') });
  assert.deepEqual([sheet.open, b.page.win.location.hash], [false, '#selectedCard=w%2FT1']);
  await b.change({ board: { ...b.server.board, orchestratorWaits: [], version: undefined } });
  assert.ok(chip(), 'the hourglass stays at 0');
  assert.equal(chip().querySelector('.q-badge'), null);
  b.page.fire(b.root.querySelector('#waitsChip'), 'click', { target: chip() });
  assert.equal(sheet.open, false, 'a tap at 0 has no list to open');
  b.view.unmount();
});

// docs/adr/2026-11-18-0700-the-hub-has-no-sharing-only-the-owners-tailnet-identity-gets-in.md
test('Board settings has no Sharing, and the board opens with no shared strip', () => {
  const html = fakePage(memoryStorage().localStorage).win.AppViews.settings.markup({}, { siteTitle: 'Orch' });
  assert.match(html, /<h2>Reviewers<\/h2>/);
  assert.doesNotMatch(html, /Sharing|shareCopy|shareList|Tailscale’s Machines page/);
  assert.doesNotMatch(fakePage(memoryStorage().localStorage).win.BoardView.markup({ title: 'Orch' }), /view-only-strip|Shared with you/);
});

// docs/adr/2026-11-17-1500-the-board-menu-shows-how-to-join-the-orchestrator-in-a-terminal.md
test("the board's name opens the board menu, whose Join in terminal opens the sheet: the command with Copy, Wake while asleep with the spinner while waking, and the saved command with no Wake while the server is down", async () => {
  const checks = (watcher) => ({ at: '2026-10-30T10:00:00.000Z', every: 30, late: false, watcher, claudeAt: null });
  const join = { command: 'claude attach 3f9a1c7e', tmux: false };
  const b = boardOnDom({ board: { ...boardOf([workCard('A1')]), checks: checks('running'), join }, threads: {} });
  await b.settle();
  const $ = (s) => b.root.querySelector(s);
  const open = $('#boardMenuOpen');
  assert.deepEqual([$('.top h1').textContent, open.textContent, $('#boardMenu').hidden], ['A', 'A', true]);
  b.page.fire(open, 'click', { target: open });
  assert.deepEqual([$('#boardMenu').hidden, open.getAttribute('aria-expanded')], [false, 'true']);
  assert.match($('#boardMenu').textContent, /Join in terminal\s*Running/);
  b.page.fire($('#boardMenu'), 'click', { target: $('[data-join-open]') });
  assert.deepEqual([$('#boardMenu').hidden, open.getAttribute('aria-expanded'), $('#joinSheet').open], [true, 'false', true]);
  assert.equal($('#joinBody code').textContent, 'claude attach 3f9a1c7e');
  assert.ok($('#joinBody [data-join-copy]'));
  assert.match($('#joinBody').textContent, /Ctrl\+Z \(shell\) leaves it running/);
  await b.change({ board: { ...b.view.B.state.board, checks: checks('asleep') } });
  assert.equal($('#joinBody [data-join-wake]').textContent, 'Wake');
  assert.equal($('#joinBody [data-join-copy]'), null);
  b.page.fire($('#joinSheet'), 'click', { target: $('#joinBody [data-join-wake]') });
  assert.deepEqual([$('#joinBody [data-join-wake]').getAttribute('aria-busy'), $('#joinBody [data-join-wake]').textContent], ['true', '']);
  await b.settle();
  assert.deepEqual(b.posts.filter(([p]) => p === '/_hub/wake'), [['/_hub/wake', { route: 'board-a' }]]);
  b.view.B.linkDown();
  assert.equal($('#joinBody code').textContent, 'claude attach 3f9a1c7e');
  assert.ok($('#joinBody [data-join-copy]'));
  assert.equal($('#joinBody [data-join-wake]'), null);
  assert.match($('#joinBody').textContent, /Server not answering/);
  b.view.unmount();
});

test("the board menu's Repo review opens the review sheet, Pause opens the duration sheet and posts the chosen length, and Resume ends the owner's pause in one tap", async () => {
  const pause = { now: { paused: false } };
  const b = boardOnDom({ board: { ...boardOf([workCard('A1')]), arch: { repo: 'org/shop', last: null, waits: null } }, threads: {}, pause });
  await b.settle();
  const $ = (s) => b.root.querySelector(s);
  const openMenu = () => { if ($('#boardMenu').hidden) b.page.fire($('#boardMenuOpen'), 'click', { target: $('#boardMenuOpen') }); };
  openMenu();
  assert.match($('#boardMenu').textContent, /Join in terminal[\s\S]*Settings[\s\S]*Repo review[\s\S]*No review yet[\s\S]*Pause[\s\S]*Running/);
  b.page.fire($('#boardMenu'), 'click', { target: $('[data-arch-sheet]') });
  assert.deepEqual([$('#boardMenu').hidden, $('#archSheet').open], [true, true]);
  $('#archSheet').close();
  openMenu();
  b.page.fire($('#boardMenu'), 'click', { target: $('[data-pause-open]') });
  await b.settle();
  assert.equal($('#pauseSheet').open, true);
  assert.deepEqual([...$('#pauseBody').innerHTML.matchAll(/name="pause" value="([^"]+)"/g)].map((m) => m[1]), ['1h', 'forever']);
  const chip = $('#pauseBody button[value="1h"]');
  b.page.fire($('#pauseSheet'), 'submit', { target: $('#pauseBody form'), submitter: chip });
  await b.settle();
  assert.deepEqual(b.posts.filter(([p]) => p.endsWith('/api/pause')), [['/board-a/api/pause', { pause: '1h' }]]);
  pause.now = { paused: true, manual: 'board', resets_at: 'forever' };
  await b.change({});
  openMenu();
  assert.match($('#boardMenu').textContent, /Resume\s*Paused until you resume/);
  b.page.fire($('#boardMenu'), 'click', { target: $('[data-pause-resume]') });
  await b.settle();
  assert.deepEqual(b.posts.filter(([p]) => p.endsWith('/api/pause')).at(-1), ['/board-a/api/pause', { pause: 'off' }]);
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

test("a card's workflow buttons run quiet first: Block, Notes, Serve, then Questions, then Merge", async () => {
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
  assert.deepEqual(order('w/F1'), ['Block', 'Notes', 'Serve', 'Questions', 'Merge']);
  assert.deepEqual(order('w/F2'), ['Block', 'Notes', 'Serve', 'Merge']);
  assert.deepEqual(order('w/F3'), ['Block', 'Notes', 'Serve', 'Questions', 'Merge']);
});

// docs/adr/2026-11-09-1100-needs-you-button-reaches-the-prototypes.md
test("a card with prototypes has no Prototypes button: its Questions button opens its questions page, solid orange while a round waits on the owner's pick", async () => {
  const round = (n, q, state) => ({ n, q, url: `prototype-x${n}.html?q=${q}`, confirm: false, state });
  const cards = [
    workCard('P1', { actionButton: 'openQuestions', questions: { first: 'q2', open: 1, state: 'open' }, action: { kind: 'pick', url: 'questions.html#q2', label: 'Prototypes ready: pick a take' }, resolvedBy: 'openQuestions',
      prototypes: { open: true, rounds: [round(1, 'q1', 'resolved'), round(2, 'q2', 'open')] } }),
    workCard('P3', { actionButton: 'openQuestions', lane: 'done', questions: { topic: 'item:w/P3', first: 'q1', open: 0, state: 'resolved' }, prototypes: { open: false, rounds: [round(1, 'q1', 'resolved')] } }),
  ];
  const b = boardOnDom({ open: cards.map((c) => c.key), board: boardOf(cards), threads: {} });
  await b.settle();
  const buttons = (key) => [...b.root.querySelectorAll(`details.item[data-key="${key}"] .action-row.workflow button`)];
  assert.deepEqual(buttons('w/P1').map((a) => a.textContent.trim()), ['Questions']);
  assert.equal(buttons('w/P1')[0].dataset.questions, 'q2');
  assert.equal(buttons('w/P1')[0].getAttribute('class'), 'button resolves');
  assert.deepEqual(buttons('w/P3').map((a) => [a.textContent.trim(), a.dataset.questions]), [['Questions', 'item:w/P3']]);
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
test('a selected option draws the blue selected look', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const lines = css.split('\n');
  const rule = (sel) => lines.find((l) => l.startsWith(`${sel} {`));
  assert.match(css, /--sel-bg: var\(--accent-soft\); --sel-line: var\(--accent\)/);
  assert.match(rule('.view-questions .opt:has(input:checked)'), /border-color: var\(--sel-line\); background: var\(--sel-bg\)/);
  assert.doesNotMatch(rule('.view-questions .opt:has(input:checked)'), /color-notice|color: #000/);
});

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
test("the thread's Visual button, after Prototype and Grill, asks for a visual at once, with the typed text if any, as /visual does on Reply", async () => {
  const b = boardOnDom({ open: ['w/A1'], board: boardOf([workCard('A1')]), threads: { 'w/A1': [] } });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/A1"]');
  const image = () => form().querySelector('button[data-visual]');
  const box = () => form().querySelector('textarea');
  const icons = [...form().querySelector('.request-row').children];
  assert.equal(icons.at(-2), image(), 'Visual follows Prototype and Grill, Review last');
  assert.equal(image().getAttribute('aria-label'), 'Ask for a visual');
  assert.match(box().getAttribute('placeholder'), /\/prototype, \/grill, \/visual or \/review asks for one/);
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
// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
// docs/adr/2026-11-15-2230-the-owners-hold-is-a-block.md: Held is no box of its own; the owner's block is Blocked.
test("the header's board filter lists four boxes, all checked; an unchecked box hides every card it matches in every lane, boxes overlapping, a lane's count reads N of M, and the funnel, with no count, goes orange", async () => {
  const owner = { ownerBlock: { until: null }, blocked: true };
  const cards = [
    workCard('R1', { phase: 'ready', ready: true }), workCard('R2', { phase: 'staging' }), workCard('D1', { phase: 'discussing', turn: 'owner' }), workCard('D2', { phase: 'new' }),
    workCard('P1', { phase: 'grilling' }), workCard('P2', { phase: 'prototyping' }), workCard('B1', { phase: 'ready', blocked: true }), workCard('H1', { phase: 'grilling', ...owner }),
    workCard('Q1', { phase: 'discussing', questions: { topic: 'item:w/Q1', first: 'q1', open: 1, state: 'open' } }),
    workCard('M1', { lane: 'review', action: { kind: 'merge', label: 'Merge', url: '#' } }), workCard('W1', { lane: 'progress' })];
  const b = boardOnDom({ board: boardOf(cards), threads: {} });
  await b.settle();
  const keys = () => b.root.querySelectorAll('#lanes details.item').map((el) => el.dataset.key.slice(2)).sort();
  const btn = () => b.root.querySelector('.top #boardFilter button.board-filter');
  const box = (name) => b.root.querySelector(`#boardFilter [data-board-filter="${name}"]`);
  const tap = async (el) => { b.page.fire(b.root, 'click', { target: el }); await b.settle(); };
  // A tap on a box closes the menu, so each box is tapped through a freshly opened one.
  const pick = async (name) => { if (!box(name)) await tap(btn()); await tap(box(name)); };
  const todoCount = () => b.root.querySelector('details.lane[data-lane="todo"] summary .count').textContent;
  const all = cards.map((c) => c.key.slice(2)).sort();
  assert.deepEqual([keys(), todoCount(), btn().classList.contains('on'), btn().textContent, b.root.querySelector('.board-filter-menu')], [all, '9', false, '', null]);
  assert.equal(b.root.querySelector('.lane-filter'), null, 'the Todo lane has no filter of its own');
  await tap(btn());
  assert.deepEqual(b.root.querySelectorAll('[data-board-filter]').map((el) => [el.textContent, el.getAttribute('aria-checked')]),
    [['Ready', 'true'], ['Action needed', 'true'], ['Questions', 'true'], ['Blocked', 'true']]);
  await pick('blocked');
  assert.deepEqual(keys(), all.filter((k) => !['B1', 'H1'].includes(k)), 'Blocked hides the owner blocked too');
  assert.deepEqual([btn().classList.contains('on'), todoCount()], [true, '7 of 9']);
  await pick('blocked');
  await pick('ready');
  assert.deepEqual(keys(), all.filter((k) => !['R1', 'R2'].includes(k)), 'a blocked ready card is hidden only by Blocked');
  await pick('ready');
  await pick('questions');
  assert.deepEqual(keys(), all.filter((k) => k !== 'Q1'));
  await pick('questions');
  await pick('action');
  assert.deepEqual(keys(), all.filter((k) => k !== 'M1'), 'Action needed reaches past Todo');
  await pick('action');
  assert.deepEqual([keys(), btn().classList.contains('on'), todoCount()], [all, false, '9']);
  b.view.unmount();
});

test('the open board filter menu closes on a click outside it and on Escape, closes when a box is ticked, and the outside click still lands', async () => {
  const b = boardOnDom({ board: boardOf([workCard('R1', { phase: 'ready', ready: true })]), threads: {} });
  await b.settle();
  const doc = b.page.win.document;
  const menu = () => b.root.querySelector('.board-filter-menu');
  const tap = async (el) => { b.page.fire(doc, 'click', { target: el }); b.page.fire(b.root, 'click', { target: el }); await b.settle(); };
  const open = () => tap(b.root.querySelector('button.board-filter'));
  await open();
  assert.equal(b.root.querySelector('button.board-filter').getAttribute('aria-expanded'), 'true');
  await tap(b.root.querySelector('[data-board-filter="blocked"]'));
  assert.equal(menu(), null, 'ticking a box closes it');
  await open();
  assert.ok(menu());
  await open();
  assert.equal(menu(), null, 'the funnel still closes it');
  await open();
  await tap(b.root.querySelector('details.item summary'));
  assert.equal(menu(), null, 'a click elsewhere closes it');
  await open();
  b.page.fire(doc, 'keydown', { key: 'Escape' }); await b.settle();
  assert.equal(menu(), null, 'Escape closes it');
});

// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md: the filter is kept until reload.
test('the board filter is kept while the page lives, across a move to another board and back, and a reload shows every box', async () => {
  const cards = [workCard('R1', { phase: 'ready', ready: true }), workCard('H1', { phase: 'grilling', ownerBlock: { until: null }, blocked: true })];
  const first = boardOnDom({ board: boardOf(cards), threads: {} });
  await first.settle();
  first.page.fire(first.root, 'click', { target: first.root.querySelector('button.board-filter') }); await first.settle();
  first.page.fire(first.root, 'click', { target: first.root.querySelector('[data-board-filter="blocked"]') }); await first.settle();
  const todo = (b) => b.root.querySelectorAll('details.lane[data-lane="todo"] details.item').map((el) => el.dataset.key);
  assert.deepEqual(todo(first), ['w/R1']);
  assert.ok(first.root.querySelector('button.board-filter').classList.contains('on'));

  // The board unmounts and mounts again in the same page.
  first.view.unmount();
  const back = first.page.win.BoardView.create(first.root, 'https://mac.ts.net/board-a', { signal: () => () => {} });
  back.mount();
  assert.equal(JSON.stringify(back.B.state.boardFilter), '["blocked"]', 'the board left and returned to keeps its filter');
  back.unmount();

  // A reload is a new page: nothing stored brings the filter back, and the old stored key goes.
  const again = boardOnDom({ board: boardOf(cards), threads: {}, stored: [...first.storage, ['site:board-a:boardFilter', JSON.stringify(['blocked'])]] });
  await again.settle();
  assert.deepEqual([...todo(again)].sort(), ['w/H1', 'w/R1'], 'every box is checked');
  assert.equal(again.root.querySelector('button.board-filter').classList.contains('on'), false);
  assert.equal(again.page.win.localStorage.getItem('site:board-a:boardFilter'), null, 'the old stored key is removed');
});

// The funnel fills in as well as turning orange while any box is unchecked: one rule sets both, from one colour.
test('the funnel reads filled and orange together on its on state', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const on = css.match(/\.board-filter\.on \{ color: (var\(--[\w-]+\)); \}/)?.[1];
  assert.ok(on, 'the on state sets the colour');
  assert.ok(css.includes(`.board-filter.on svg path { fill: ${on}; }`), 'and the funnel path takes the same colour as its fill');
});

test('a #show= link, as a needs-you push opens, shows only the boxes it names and leaves the address', async () => {
  const cards = [workCard('R1', { phase: 'ready' }), workCard('Q1', { phase: 'grilling', questions: { topic: 'item:w/Q1', first: 'q1', open: 1, state: 'open' } }), workCard('M1', { lane: 'review', action: { kind: 'merge', label: 'Merge', url: '#' } })];
  const b = boardOnDom({ board: boardOf(cards), threads: {} });
  await b.settle();
  b.page.win.location.hash = '#show=action,questions';
  b.page.fire(vm.runInContext('window', b.page.win), 'hashchange');
  await b.settle();
  assert.deepEqual([JSON.stringify(b.view.B.state.boardFilter), b.page.win.location.hash], [JSON.stringify(['ready', 'blocked']), '']);
  assert.deepEqual(b.root.querySelectorAll('#lanes details.item').map((el) => el.dataset.key), ['w/M1', 'w/Q1']);
  b.view.unmount();
});

// A card the board filter hides opens only on the owner's yes, which clears the filter; no leaves the filter, the address and the New strip's row as they were.
test('opening a card the board filter hides asks to reset the filter: yes clears it and opens the card, no leaves the filter and the New strip row', async () => {
  const ASK = 'This task is not currently visible, reset filters?';
  const mk = (n, ask, at) => ({ ...askCard(ask, 'todo'), id: `T-${n}`, key: `w/T-${n}`, ref: `T-${n}`, title: `feat: ticket ${n}`, phase: 'discussing', blocked: true, turn: 'owner', created: '2026-10-30T08:00:00.000Z', ingested: { at, text: `Ask ${n}` } });
  const setup = (answer) => {
    const b = boardOnDom({ board: boardOf([mk(7, 'a3', '2026-10-30T09:20:00.000Z')]), seen: {}, threads: {}, width: 1280, filter: ['blocked'], confirm: answer });
    return b;
  };
  const item = (b) => b.root.querySelector('details.item[data-key="w/T-7"]');
  const filter = (b) => JSON.stringify(b.view.B.state.boardFilter);

  // No, from the New strip's link.
  const no = setup(false);
  await no.settle();
  assert.equal(item(no), null, 'the filter hides the card');
  no.page.win.location.hash = '#selectedCard=w%2FT-7';
  no.page.fire(no.root, 'click', { target: no.root.querySelector('#newStrip a.new-link') });
  await no.settle(); no.page.runTimers(0); await no.settle();
  assert.deepEqual(no.confirms, [ASK]);
  assert.equal(item(no), null);
  assert.equal(filter(no), JSON.stringify(['blocked']));
  assert.ok(no.root.querySelector('#newStrip a.new-link'), 'the row stays');
  assert.equal(no.posts.filter(([path]) => path.endsWith('/api/read')).length, 0, 'the row is not marked read');
  no.view.unmount();

  // Yes, from a link in the address.
  const yes = setup(true);
  await yes.settle();
  yes.page.win.location.hash = '#selectedCard=w%2FT-7';
  yes.page.fire(vm.runInContext('window', yes.page.win), 'hashchange');
  await yes.settle();
  assert.deepEqual(yes.confirms, [ASK]);
  assert.equal(filter(yes), '[]');
  assert.ok(item(yes).hasAttribute('open'), 'the card opens');
  yes.view.unmount();
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


test("opening or closing a fold in a thread, and tapping Show more, grow and shrink it upward: the reply box keeps its place on screen and the page scrolls by the added height", async () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const said = (n, text) => ({ ts: at(n), who: 'claude', text });
  const run = (n, extra) => ({ ts: at(n), who: 'claude', kind: 'status', run: 'r1', agent: 'Builder', text: `Step ${n}`, ...extra });
  const msgs = [said(0, 'One'), said(1, 'Two'), said(2, 'Three'), said(3, 'Four'), said(4, 'Five'), run(5), run(6), run(7), said(8, 'Six'), said(9, 'Seven')];
  const b = boardOnDom({ open: ['w/A1'], seen: { 'w/A1': at(7) }, board: boardOf([workCard('A1', { lane: 'progress', othersAt: [at(8), at(9)] })]), threads: { 'w/A1': msgs } });
  await b.settle();
  // A closed fold draws only its summary; an open one draws its lines too.
  const view = { scrollY: 0, scrolls: [] };
  const drawn = (el) => {
    const out = [];
    const walk = (n) => { for (const c of n.children) { out.push(c); if (c.matches('details') && !c.open) out.push(...c.children.filter((k) => k.matches('summary'))); else walk(c); } };
    walk(b.doc.body);
    return out;
  };
  Object.getPrototypeOf(b.root).getBoundingClientRect = function () { return { top: drawn().indexOf(this) * 2 - view.scrollY }; };
  b.page.win.scrollBy = (x, y) => { view.scrolls.push(y); view.scrollY += y; };
  const box = () => b.root.querySelector('form[data-reply="w/A1"] textarea');
  const boxTop = () => box().getBoundingClientRect().top;
  const fold = () => b.root.querySelector('[data-thread="w/A1"] details.status-fold');
  const start = boxTop();

  b.page.fire(b.root, 'click', { target: fold().querySelector('summary') });
  assert.deepEqual([fold().open, boxTop()], [true, start]);
  assert.deepEqual(view.scrolls.map((y) => y > 0), [true]);

  b.page.fire(b.root, 'click', { target: fold().querySelector('summary') });
  assert.deepEqual([fold().open, boxTop()], [false, start]);

  const before = b.root.querySelectorAll('[data-thread="w/A1"] .msg').length;
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-thread="w/A1"] [data-thread-more]') });
  assert.ok(b.root.querySelectorAll('[data-thread="w/A1"] .msg').length > before);
  assert.equal(boxTop(), start);
});

// docs/adr/2026-11-15-1800-the-shell-keeps-every-sidebar-boards-saved-copy-fresh.md
test("the shell keeps every other sidebar board's saved copy current: whole on open, then by the changes since, at most once a minute, and again for a copy another build saved", async () => {
  const idb = memoryIndexedDB();
  const storage = memoryStorage();
  const sources = [];
  class EventSource {
    static CLOSED = 2;
    constructor() { this.readyState = 1; this.listeners = new Map(); sources.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    close() { this.readyState = EventSource.CLOSED; }
  }
  const msg = (n) => ({ at: `2026-11-15T10:0${n}:00.000Z`, text: `line ${n}` });
  const card = (key, changed) => ({ key, lane: 'todo', changed });
  const answers = {
    'https://mac.ts.net/other/api/board': { title: 'Other', version: 5, generatedAt: '2026-11-15T10:00:00.000Z', items: [card('o/A', 5), card('o/B', 5)], owner: [], ownerTopics: [] },
    'https://mac.ts.net/other/api/thread?key=o%2FA': [msg(1)],
    'https://mac.ts.net/other/api/thread?key=o%2FB': [],
    'https://mac.ts.net/other/api/notes?all=1': { notes: { 'o/A': '# Notes A' } },
    'https://mac.ts.net/other/api/board?since=5': { since: 5, version: 6, generatedAt: '2026-11-15T10:05:00.000Z', set: {}, unset: [], lists: { items: { set: [card('o/B', 6)], drop: [] } },
      threads: { 'o/A': { from: 1, lines: [msg(2)] } }, notes: { 'o/A': '# Notes A, edited' } },
  };
  const asked = [];
  const { win, page } = await shellPage('/shop/', {
    indexedDB: idb, storage, EventSource,
    fetch: async (url) => {
      asked.push(url);
      return answers[url] === undefined ? new Promise(() => {}) : { ok: true, status: 200, json: async () => answers[url] };
    },
  });
  const saved = () => idb.rows.get('https://mac.ts.net/other/');
  const syncs = () => asked.filter((u) => u.includes('/other/api/board'));
  await drain(() => saved()?.notes['o/A'], "the board the shell isn't showing is saved whole on open");
  assert.equal(asked.some((u) => u.includes('/shop/api/')), false, 'the open board keeps its own copy');
  assert.deepEqual([saved().build, saved().board.version, saved().threads['o/A'].length, saved().notes['o/A']], ['build-1', 5, 1, '# Notes A']);
  assert.deepEqual(JSON.parse(storage.storage.get('site:other:copyVersion')), { build: 'build-1', version: 5 }, "app.html's boot asks since this number");

  // A change within the minute of the last catch-up fetches nothing; the open board's change never does.
  sources[0].listeners.get('change')({ data: JSON.stringify({ route: 'other' }) });
  sources[0].listeners.get('change')({ data: JSON.stringify({ route: 'shop' }) });
  await new Promise(setImmediate);
  assert.deepEqual(syncs(), ['https://mac.ts.net/other/api/board']);

  page.advance(61_000);
  sources[0].listeners.get('change')({ data: JSON.stringify({ route: 'other' }) });
  await drain(() => saved().board.version === 6, 'a change a minute on catches up by the changes since');
  assert.deepEqual([saved().threads['o/A'].map((m) => m.text), saved().notes['o/A'], saved().board.items[1].changed], [['line 1', 'line 2'], '# Notes A, edited', 6]);
  assert.deepEqual(JSON.parse(storage.storage.get('site:other:copyVersion')), { build: 'build-1', version: 6 });

  // A copy another build saved is fetched whole again.
  await win.BoardUI.copyStore('boards', 'readwrite', (store) => store.put({ ...saved(), build: 'build-0' }, 'https://mac.ts.net/other/'));
  page.advance(61_000);
  const before = asked.length;
  sources[0].listeners.get('change')({ data: JSON.stringify({ route: 'other' }) });
  await drain(() => saved().build === 'build-1', 'an old build copy is refetched');
  assert.equal(asked.slice(before)[0], 'https://mac.ts.net/other/api/board');
  assert.equal(saved().board.version, 5);
});

test("a catch-up that finds the saved copy replaced meanwhile, by the board's own view, leaves that copy", async () => {
  const idb = memoryIndexedDB();
  const { win } = await shellPage('/shop/', { indexedDB: idb, fetch: () => new Promise(() => {}) });
  const key = 'https://mac.ts.net/other/';
  const old = { build: 'build-1', savedAt: '2026-11-15T10:00:00.000Z', board: { version: 5, items: [], owner: [], ownerTopics: [] }, threads: {}, notes: {} };
  const newer = { ...old, savedAt: '2026-11-15T10:09:00.000Z', board: { ...old.board, version: 9 } };
  await win.BoardUI.copyStore('boards', 'readwrite', (store) => store.put(old, key));
  const result = await win.BoardUI.syncCopy(key, 'build-1', async () => {
    await win.BoardUI.copyStore('boards', 'readwrite', (store) => store.put(newer, key));
    return { since: 5, version: 6, generatedAt: '2026-11-15T10:05:00.000Z', set: {}, unset: [], lists: {} };
  });
  assert.equal(result, null);
  assert.equal(idb.rows.get(key).board.version, 9);
});

// docs/adr/2026-11-16-0630-the-request-row-is-outlined-buttons-spread-with-key-hints.md
test("Alt+L in a thread's box does nothing; Alt+G presses Grill, the typed text going with it", async () => {
  const b = boardOnDom({ open: ['w/A1'], board: boardOf([workCard('A1')]), threads: { 'w/A1': [] } });
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/A1"]');
  const box = () => form().querySelector('textarea');
  // The mini DOM's elements have no click(): a button's click reaches the board's root as a tap does.
  for (const btn of form().querySelectorAll('button[data-grill]')) btn.click = () => b.page.fire(b.root, 'click', { target: btn });
  const key = (target, code) => b.page.fire(b.root, 'keydown', { key: 'x', code, altKey: true, target }).defaultPrevented;
  assert.equal(key(box(), 'KeyL'), false);
  box().value = 'Go deeper on the sync';
  assert.equal(key(box(), 'KeyG'), true);
  await b.settle();
  assert.deepEqual(sentNoIds(b), [['grill-more', { key: 'w/A1', text: 'Go deeper on the sync' }]]);
  b.view.unmount();
});

// docs/adr/2026-11-16-1030-a-thread-replys-and-an-answers-attachments-send-atomically-with-thumbnails.md
const replyTiles = (b, key) => b.root.querySelectorAll(`[data-thread="${key}"] [data-uploads] .file-thumb, [data-thread="${key}"] [data-uploads] .file-link`).map((el) => [el.getAttribute('title'), el.getAttribute('class').split(' ')[1]]);
test("a thread reply with a file still uploading clears its box at once, its send buttons never waiting; the line shows the files as tiles under sending…, and the reply goes once every file is up, with them as its files", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send });
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const boxes = boxesOn(b.page.win);
  boxes.put('item:w/T1', [boxes.up(shot), boxes.uploading(log)]);
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/T1"]');
  const reply = form().querySelector('button[data-intent="reply"]');
  form().querySelector('textarea').value = 'See these';
  b.page.fire(b.root, 'submit', { target: form(), submitter: reply });
  await b.settle();
  const [stored] = JSON.parse(b.storage.get(OUTBOX));
  assert.deepEqual([b.sent, waitState(reply), boxes.boxes.has('item:w/T1'), stored.uploads], [[], IDLE, false, [shot, { name: 'run.log', type: 'text/plain', lost: true }]]);
  assert.deepEqual(replyTiles(b, 'w/T1'), [['shot.png', 'done'], ['run.log', 'uploading']]);
  assert.equal(b.root.querySelector(`[data-thread="w/T1"] [data-uploads]`).dataset.uploads, `send:${stored.sendId}`);
  boxes.finish('run.log', true);
  await b.settle();
  assert.deepEqual(sentNoIds(b), [['item-message', { key: 'w/T1', text: 'See these', files: [shot, log], intent: 'reply' }]]);
  assert.deepEqual([JSON.parse(b.storage.get(OUTBOX))[0].uploads, boxes.boxes.has(`send:${stored.sendId}`)], [undefined, false]);
  b.view.unmount();
});

test("a thread reply whose upload failed sends nothing: it reads not sent with the file marked and its X; Retry uploads again and sends, and X on the reply puts its text and files back in the box", async () => {
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send, confirm: true });
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const boxes = boxesOn(b.page.win);
  await b.settle();
  const form = () => b.root.querySelector('form[data-reply="w/T1"]');
  const post = async (text) => {
    boxes.put('item:w/T1', [boxes.up(shot), boxes.uploading(log)]);
    form().querySelector('textarea').value = text;
    b.page.fire(b.root, 'submit', { target: form(), submitter: form().querySelector('button[data-intent="reply"]') });
    await b.settle();
    return JSON.parse(b.storage.get(OUTBOX)).at(-1).sendId;
  };
  const sendId = await post('First');
  boxes.finish('run.log', false);
  await b.settle();
  const line = () => b.root.querySelector(`[data-thread="w/T1"] .msg[data-send="${sendId}"]`);
  assert.deepEqual([b.sent, footOf(line()), replyTiles(b, 'w/T1')], [[], 'not sent', [['shot.png', 'done'], ['run.log: Upload failed', 'error']]]);
  assert.ok(line().querySelector('[data-uploads] .file-link.error [data-unattach]'), 'the failed file has its X');
  b.page.fire(b.root, 'click', { target: line().querySelector(`button[data-resend="${sendId}"]`) });
  await b.settle();
  assert.deepEqual([boxes.retried, footOf(line()), replyTiles(b, 'w/T1')[1]], [[`send:${sendId}`], 'sending…', ['run.log', 'uploading']]);
  boxes.finish('run.log', true);
  await b.settle();
  assert.deepEqual(sentNoIds(b), [['item-message', { key: 'w/T1', text: 'First', files: [shot, log], intent: 'reply' }]]);
  sends.answer();
  await b.settle();

  const second = await post('Second');
  boxes.finish('run.log', false);
  await b.settle();
  b.page.fire(b.root, 'click', { target: b.root.querySelector(`button[data-unsend="${second}"]`) });
  await b.settle();
  assert.deepEqual([form().querySelector('textarea').value, [...b.page.win.BoardAttach.list('item:w/T1')].map((p) => [p.name, p.status]), boxes.boxes.has(`send:${second}`)],
    ['Second', [['shot.png', 'done'], ['run.log', 'error']], false]);
  b.view.unmount();
});

test("a reload puts a thread reply's kept files back in its box: with every one up it sends with them, with one lost mid-upload it reads not sent", async () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const whole = { sendId: 's-whole', key: 'w/T1', kind: undefined, text: 'Whole', files: [], uploads: [shot], intent: 'reply', ts: '2026-11-13T11:00:00.000Z' };
  const cut = { sendId: 's-cut', key: 'w/T1', text: 'Cut', files: [], uploads: [shot, { name: 'run.log', type: 'text/plain', lost: true }], intent: 'reply', ts: '2026-11-13T11:01:00.000Z' };
  const sends = heldSends();
  const b = boardOnDom({ open: ['w/T1'], board: boardOf([workCard('T1')]), threads: { 'w/T1': [] }, send: sends.send, stored: [[OUTBOX, JSON.stringify([whole, cut])]] });
  const boxes = boxesOn(b.page.win);
  await b.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent)).map(([kind, d]) => [kind, d.text, d.files]), [['item-message', 'Whole', [shot]]]);
  assert.ok(boxes.boxes.has('send:s-cut'));
  assert.deepEqual(replyTiles(b, 'w/T1').slice(-2), [['shot.png', 'done'], ['run.log: Lost in a reload', 'error']]);
  b.view.unmount();
});

test("an answer on the questions sheet with a file still uploading sends once every file is up, with them in its answer; a failed file marks the answer not sent in the card and the thread, Retry uploads again, and X reopens the question with its files", async () => {
  const s = sheetOnDom();
  await s.settle();
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const boxes = boxesOn(s.page.win);
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  s.pick('qb');
  boxes.put('q:qb', [boxes.up(shot), boxes.uploading(log)]);
  const sendButton = () => s.sheet().querySelector('#send');
  assert.deepEqual([sendButton().disabled, sendButton().textContent.replace(/⌘↵|Ctrl\+↵/, '').trim()], [false, 'Send'], 'Send does not wait on an upload');
  s.page.fire(s.sheet(), 'submit', { target: s.sheet().querySelector('form') });
  await s.settle();
  assert.equal(s.sent.length, 0, 'nothing is sent while a file uploads');
  const reopen = () => { s.page.runTimers(); s.page.fire(s.root, 'click', { target: s.line(), button: 0 }); };
  reopen();
  const cardTiles = () => s.sheet().querySelectorAll('section.q[data-q="qb"] [data-uploads] .file-thumb, section.q[data-q="qb"] [data-uploads] .file-link').map((el) => [el.getAttribute('title'), el.getAttribute('class').split(' ')[1]]);
  assert.deepEqual([cardTiles(), replyTiles(s, 'w/A1')], [[['shot.png', 'done'], ['run.log', 'uploading']], [['shot.png', 'done'], ['run.log', 'uploading']]]);
  boxes.finish('run.log', false);
  await s.settle();
  assert.equal(s.sent.length, 0, 'an upload that failed sends nothing');
  assert.match(s.sheet().querySelector('section.q[data-q="qb"] .sent-line').textContent, /not sent/);
  assert.deepEqual(cardTiles()[1], ['run.log: Upload failed', 'error']);
  s.page.fire(s.sheet(), 'click', { target: s.sheet().querySelector('section.q[data-q="qb"] [data-resend]') });
  await s.settle();
  assert.deepEqual([boxes.retried.length, cardTiles()[1]], [1, ['run.log', 'uploading']]);
  boxes.finish('run.log', true);
  await s.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(s.sent.map(([kind, d]) => [kind, d.answers[0].id, d.answers[0].files]))), [['owner-answers', 'qb', [shot, log]]]);

  // X on a failed one gives the question back with its files.
  s.pick('qa');
  boxes.put('q:qa', [boxes.uploading(log)]);
  s.page.fire(s.sheet(), 'submit', { target: s.sheet().querySelector('form') });
  await s.settle();
  boxes.finish('run.log', false);
  await s.settle();
  reopen();
  s.page.fire(s.sheet(), 'click', { target: s.sheet().querySelector('section.q[data-q="qa"] [data-unsend]') });
  await s.settle();
  assert.deepEqual([[...s.page.win.BoardAttach.list('q:qa')].map((p) => [p.name, p.status]), s.sent.length], [[['run.log', 'error']], 1]);
  s.view.unmount();
});

// docs/adr/2026-11-16-2100-a-question-sets-answers-send-as-one.md
test("a set whose answers each carry files sends once all are up, as one owner-answers with each answer's own files, and its one thread line shows every answer's tiles meanwhile", async () => {
  const s = sheetOnDom();
  await s.settle();
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const boxes = boxesOn(s.page.win);
  s.page.fire(s.root, 'click', { target: s.line(), button: 0 });
  s.pick('qa');
  s.pick('qb');
  boxes.put('q:qa', [boxes.up(shot)]);
  boxes.put('q:qb', [boxes.uploading(log)]);
  s.page.fire(s.sheet(), 'submit', { target: s.sheet().querySelector('form') });
  await s.settle();
  assert.deepEqual([s.sent.length, replyTiles(s, 'w/A1')], [0, [['shot.png', 'done'], ['run.log', 'uploading']]], 'one line, both answers\' tiles, nothing sent yet');
  boxes.finish('run.log', true);
  await s.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(s.sent.map(([kind, d]) => [kind, d.answers.map((a) => [a.id, a.files])]))), [['owner-answers', [['qa', [shot]], ['qb', [log]]]]]);
  s.view.unmount();
});

test('an open card whose lane changes in a repaint comes back closed and forgotten, a card that stays in its lane stays open, and the URL still selects the moved card', async () => {
  const v1 = { ...boardOf([workCard('A1', { lane: 'todo' }), workCard('A2', { lane: 'todo' })]), version: 'v1' };
  const b = boardOnDom({ open: ['w/A1', 'w/A2'], board: v1, threads: { 'w/A1': [], 'w/A2': [] } });
  await b.settle();
  b.page.win.location.hash = '#selectedCard=w%2FA1';
  const card = (id) => b.root.querySelector(`details.item[data-key="w/${id}"]`);
  const lane = (id) => card(id).closest('details.lane').dataset.lane;
  assert.deepEqual([card('A1').open, card('A2').open], [true, true]);
  await b.change({ board: { ...boardOf([workCard('A1', { lane: 'progress' }), workCard('A2', { lane: 'todo' })]), version: 'v2' } });
  await b.settle();
  assert.deepEqual([lane('A1'), card('A1').open, lane('A2'), card('A2').open], ['progress', false, 'todo', true]);
  assert.equal(b.page.win.localStorage.getItem('site:board-a:openItems'), '["w/A2"]');
  assert.equal(b.page.win.location.hash, '#selectedCard=w%2FA1');
  card('A1').open = true;
  b.page.fire(b.root, 'toggle', { target: card('A1') });
  await b.change({ board: { ...boardOf([workCard('A1', { lane: 'progress' }), workCard('A2', { lane: 'todo' })]), version: 'v3', title: 'T' } });
  assert.equal(card('A1').open, true, 'a card the owner opened after the move stays open');
  b.view.unmount();
});

// docs/adr/2026-11-16-2300-a-starting-board-shows-its-sessions-liveness-activity-and-prompt.md
test("a starting row answers its session's prompt in place and retries a stalled start, each tap waiting on the hub, a refusal shown in the row", async () => {
  const page = repoPage(true);
  const { win, doc } = page;
  const stepAt = new Date(NOW).toISOString();
  const prompt = { id: 'p1', tool: 'Bash', action: 'run kickflip doctor --fix', detail: 'kickflip doctor --fix', rule: 'Bash(kickflip doctor --fix)', questions: null };
  const question = { id: 'p2', tool: 'AskUserQuestion', questions: [{ question: 'Which repo?', header: '', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] };
  let data = { sites: [], starting: [{ route: 'shop', title: 'Shop', branch: 'main', step: 'starting', stepAt, failed: false, activity: 'running kickflip doctor', prompt }] };
  const posted = [];
  let answer = null;
  win.fetch = async (url, options = {}) => {
    if (url === '/_hub/sidebar.json') return repoResponse(data);
    posted.push([url, JSON.parse(options.body)]);
    return new Promise((resolve) => { answer = resolve; });
  };
  win.Sidebar.mount({ data });
  const aside = doc.getElementById('sidebar');
  const tap = (sel) => page.fire(aside, 'click', { target: aside.querySelector(sel) });
  assert.match(aside.querySelector('.sb-prompt').textContent, /waiting on you · Bash: kickflip doctor --fix\s*Allow once\s*Always\s*Deny/);
  // Always confirms first, as the board's strip and the hub page do, naming the rule it adds.
  const confirms = [];
  win.BoardDialogs.confirm = async (text) => { confirms.push(text); return false; };
  tap('[data-start-answer="always"]');
  await tick(); await tick();
  assert.deepEqual([confirms, posted], [['Always allow Bash(kickflip doctor --fix) for the rest of this session?'], []], 'a cancelled Always sends nothing');
  tap('[data-start-answer="allow"]');
  assert.deepEqual([aside.querySelector('[data-start-answer="allow"]').getAttribute('aria-busy'), aside.querySelector('[data-start-answer="deny"]').disabled], ['true', true]);
  assert.deepEqual(posted, [['/_hub/prompts/p1/answer', { choice: 'allow' }]]);
  data = { ...data, starting: [{ ...data.starting[0], prompt: undefined }] };
  answer(repoResponse({ ok: true }));
  await tick(); await tick();
  assert.equal(aside.querySelector('.sb-prompt'), null, 'the answered prompt goes with the next copy');

  data = { ...data, starting: [{ ...data.starting[0], prompt: question }] };
  win.Sidebar.mount({ data });
  tap('[data-start-option="B"]');
  assert.deepEqual(posted.at(-1), ['/_hub/prompts/p2/answer', { choice: 'allow', answers: { 'Which repo?': 'B' } }]);
  answer({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'Pick an answer to "Which repo?".' }) });
  await tick(); await tick();
  assert.equal(aside.querySelector('.sb-start-refused').textContent, 'Pick an answer to "Which repo?".');

  data = { ...data, starting: [{ ...data.starting[0], prompt: undefined, stalled: true, quietSince: new Date(NOW - 200_000).toISOString() }] };
  win.Sidebar.mount({ data });
  assert.match(aside.querySelector('[data-starting="shop"]').textContent, /stalled · 3m quiet\s*Retry/);
  tap('[data-start-retry="shop"]');
  assert.deepEqual(posted.at(-1), ['/_hub/new-board/shop/retry', {}]);
  answer({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'Only a board that didn’t start can be retried.' }) });
  await tick(); await tick();
  assert.equal(aside.querySelector('.sb-start-refused').textContent, 'Only a board that didn’t start can be retried.');
});

// docs/adr/2026-11-16-1930-a-joined-boards-prompts-show-on-the-board.md
test("a joined board's pending prompts show as a strip right under the pause banner, answered in place, an answered row fading until the board's next copy drops it", async () => {
  const at = '2026-10-30T10:00:00.000Z';
  const perm = { id: 'p1', cwd: '~/repo', tool: 'Bash', action: 'run kickflip doctor', detail: 'kickflip doctor', rule: 'Bash(kickflip doctor)', questions: null, at };
  const write = { id: 'p2', cwd: '~/repo', tool: 'Write', action: 'write app.html', detail: '/r/app.html', rule: 'Write(//r/app.html)', questions: null, at };
  const b = boardOnDom({ board: { ...boardOf([]), version: 'v1', prompts: [perm, write] }, threads: {}, confirm: true });
  await b.settle();
  const markup = b.root.innerHTML;
  assert.ok(markup.indexOf('id="pauseBanner"') < markup.indexOf('id="promptStrip"') && markup.indexOf('id="promptStrip"') < markup.indexOf('id="answers"'), 'the strip sits right under the pause banner');
  const strip = b.root.querySelector('#promptStrip');
  const row = (id) => strip.querySelector(`li[data-prompt="${id}"]`);
  assert.equal(strip.hidden, false);
  assert.match(row('p1').textContent, /Orchestrator waits on you · Bash: kickflip doctor\s*Allow once\s*Always\s*Deny/);
  assert.match(row('p2').textContent, /Write: \/r\/app\.html/);

  b.page.fire(b.root, 'click', { target: row('p1').querySelector('[data-prompt-choice="allow"]') });
  await b.settle();
  assert.deepEqual(b.posts, [['/_hub/prompts/p1/answer', { choice: 'allow' }]]);
  assert.match(row('p1').getAttribute('class'), /prompt-answered/, 'the answered row fades');
  assert.doesNotMatch(row('p2').getAttribute('class'), /prompt-answered/);

  b.page.fire(b.root, 'click', { target: row('p2').querySelector('[data-prompt-choice="always"]') });
  await b.settle();
  assert.deepEqual(b.confirms, ['Always allow Write(//r/app.html) for the rest of this session?']);
  assert.deepEqual(b.posts.at(-1), ['/_hub/prompts/p2/answer', { choice: 'always' }]);

  await b.change({ board: { ...boardOf([]), version: 'v2', prompts: [] } });
  assert.equal(strip.hidden, true, "the board's next copy drops the answered prompts");
  assert.equal(strip.innerHTML, '');
  b.view.unmount();
});

// docs/adr/2026-11-17-0254-a-new-board-opens-empty-while-its-orchestrator-starts.md
test("a New board served while its orchestrator starts opens as a board with the start's banner, whose Retry posts to the hub, and the banner goes once the session joins", async () => {
  const stepAt = new Date(Date.now() - 5000).toISOString();
  const start = { route: 'shop', title: 'Shop', branch: 'main', step: 'starting', stepAt, askedAt: stepAt, failed: false, served: true };
  const posted = [];
  const fetch = async (url, options = {}) => {
    const u = new URL(url, 'https://mac.ts.net/');
    if (u.pathname.endsWith('/api/board')) return { ok: true, json: async () => boardOf([]) };
    if (options.method === 'POST') { posted.push([u.pathname, JSON.parse(options.body)]); return { ok: true, status: 200, text: async () => '{}' }; }
    return { ok: true, json: async () => [] };
  };
  const sources = [];
  class EventSource {
    static CLOSED = 2;
    constructor() { this.readyState = 1; this.listeners = new Map(); sources.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    close() { this.readyState = EventSource.CLOSED; }
  }
  const { doc, page } = await shellPage('/shop/', { fetch, EventSource, realBoards: true, sidebarData: { sites: [], starting: [start] } });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  const banner = () => doc.querySelector('#startBanner');
  const sidebar = (data) => sources.at(-1).listeners.get('sidebar')({ data: JSON.stringify(data) });
  assert.ok(doc.querySelector('.view-board'), 'the route opens as a board');
  assert.equal(banner().hidden, false);
  assert.match(banner().textContent, /orchestrator starting\s*starting orchestrator · \d+s/);

  sidebar({ sites: [], starting: [{ ...start, failed: true, ended: true, error: 'Its session ended before it joined the hub.' }] });
  assert.match(banner().textContent, /orchestrator didn’t start\s*Its session ended before it joined the hub\.\s*Retry/);
  page.fire(banner(), 'click', { target: banner().querySelector('[data-start-retry="shop"]') });
  await settle();
  assert.deepEqual(posted, [['/_hub/new-board/shop/retry', {}]]);

  sidebar({ sites: [{ route: 'shop', title: 'Shop', board: true, icon: '' }], starting: [{ ...start, step: 'landing', joined: true }] });
  assert.equal(banner().hidden, true, 'the banner goes once the session joins');
  assert.equal(banner().innerHTML, '');
});

// docs/adr/2026-11-17-0613-a-search-bar-narrows-the-board-as-you-type.md
const searchBoard = () => ({
  ...boardOf([
    workCard('T-330', { ref: 'T-330', title: 'Search the board', lane: 'progress' }),
    workCard('T-33', { ref: 'T-33', title: 'Fix the header', lane: 'review' }),
    workCard('T-12', { ref: 'T-12', title: 'Board search ranking', phase: 'ready', ticket: { id: 'LIN-7', source: 'linear', url: 'https://linear.app/x/issue/LIN-7' } }),
    workCard('T-40', { ref: 'T-40', title: 'Old search work', lane: 'done', sortAt: '2026-10-30T07:00:00.000Z' }),
    workCard('T-41', { ref: 'T-41', title: 'Unrelated', lane: 'done', sortAt: '2026-10-30T06:00:00.000Z' }),
    newAsk('n1', '2026-10-30T08:00:00.000Z', 'waiting', 'Search should mark words'),
  ]),
  reviews: { shown: true, at: '2026-10-30T09:00:00.000Z', repo: 'o/r', waiting: 0, earlier: [],
    cards: [{ number: 12, title: 'Search deps bump', author: 'quinn', url: 'https://github.com/o/r/pull/12', asked: false, touches: [], state: 'posted', at: '2026-10-30T09:00:00.000Z', text: null, reviewUrl: null }] },
});
function searchOnDom(opts = {}) {
  const b = boardOnDom({ board: searchBoard(), threads: {}, ...opts });
  const field = () => b.root.querySelector('#searchField');
  const bar = () => b.root.querySelector('#searchBar');
  const type = async (text) => { field().value = text; b.page.fire(b.root, 'input', { target: field() }); await b.settle(); };
  const counts = () => b.root.querySelectorAll('details.lane').map((l) => [l.dataset.lane, l.querySelector(':scope > summary .count').textContent]);
  const shown = () => b.root.querySelectorAll('#newStrip .new-entry, #lanes details.rv-card, #lanes details.item').map((el) => el.dataset.key || `PR ${el.dataset.review}`);
  const lane = (id) => b.root.querySelector(`details.lane[data-lane="${id}"]`);
  let at = 0;
  const press = (key, ev = {}) => { const e = b.page.fire(b.doc, 'keydown', { key, target: b.doc.body, timeStamp: at += 100, ...ev }); return b.settle().then(() => e); };
  const wait = (ms) => { at += ms; };
  return { ...b, field, bar, type, counts, shown, lane, press, wait };
}

test('the magnifier opens a search bar; typing narrows the New strip, Auto Review and every lane to the cards holding every typed word in their title, key or ticket, any case, each header reading x of y, even 0, with the words marked in the titles', async () => {
  const b = searchOnDom();
  await b.settle();
  assert.equal(b.bar().hidden, true);
  assert.deepEqual(b.counts(), [['new', '1'], ['reviews', '1'], ['review', '1'], ['progress', '1'], ['todo', '1'], ['done', '2']]);
  b.page.fire(b.root, 'click', { target: b.root.querySelector('#searchOpen') });
  await b.settle();
  assert.equal(b.bar().hidden, false);
  assert.equal(b.doc.activeElement, b.field());
  assert.equal(b.field().getAttribute('enterkeyhint'), 'search');

  await b.type('search');
  assert.deepEqual(b.shown(), ['w/n1', 'PR 12', 'w/T-330', 'w/T-12', 'w/T-40']);
  assert.deepEqual(b.counts(), [['new', '1 of 1'], ['reviews', '1 of 1'], ['review', '0 of 1'], ['progress', '1 of 1'], ['todo', '1 of 1'], ['done', '1 of 2']]);
  assert.match(b.root.querySelector('details.item[data-key="w/T-330"] .title').innerHTML, /<mark>Search<\/mark> the board/);
  assert.match(b.root.querySelector('details.item[data-key="w/T-12"] .title').innerHTML, /Board <mark>search<\/mark> ranking/);
  assert.match(b.root.querySelector('details.rv-card .title').innerHTML, /<mark>Search<\/mark> deps bump/);
  assert.match(b.root.querySelector('#newStrip .new-msg').innerHTML, /<mark>Search<\/mark> should mark words/);

  await b.type('BOARD  search');
  assert.deepEqual(b.shown(), ['w/T-330', 'w/T-12'], 'every word, in any order');
  await b.type('t-33');
  assert.deepEqual(b.shown(), ['w/T-33', 'w/T-330'], 'a whole key is any text');
  await b.type('lin-7');
  assert.deepEqual(b.shown(), ['w/T-12'], 'the ticket id');
  await b.type('zzz');
  assert.deepEqual(b.shown(), []);
  assert.deepEqual(b.counts(), [['new', '0 of 1'], ['reviews', '0 of 1'], ['review', '0 of 1'], ['progress', '0 of 1'], ['todo', '0 of 1'], ['done', '0 of 2']]);
  assert.equal(b.root.querySelectorAll('#lanes .empty').length, 0, 'no match is just the 0 counts');
  await b.type('  ');
  assert.deepEqual(b.counts(), [['new', '1'], ['reviews', '1'], ['review', '1'], ['progress', '1'], ['todo', '1'], ['done', '2']], 'a blank search narrows nothing');
  b.view.unmount();
});

test('a folded lane opens while it holds matches and folds again after, its stored state untouched; Esc and the × each clear the search and close the bar', async () => {
  const b = searchOnDom({ stored: [['site:board-a:lanes', JSON.stringify({ review: false })]] });
  await b.settle();
  assert.deepEqual([b.lane('review').open, b.lane('done').open], [false, false]);
  await b.press('/');
  await b.type('old');
  assert.deepEqual([b.lane('review').open, b.lane('done').open], [false, true]);
  await b.type('header');
  assert.deepEqual([b.lane('review').open, b.lane('done').open], [true, false]);
  await b.press('Escape', { target: b.field() });
  assert.deepEqual([b.bar().hidden, b.field().value], [true, '']);
  assert.deepEqual([b.lane('review').open, b.lane('done').open], [false, false]);
  assert.equal(b.storage.get('site:board-a:lanes'), JSON.stringify({ review: false }));
  assert.equal(b.root.querySelectorAll('mark').length, 0);

  await b.press('/');
  await b.type('header');
  b.page.fire(b.root, 'click', { target: b.root.querySelector('[data-search-clear]') });
  await b.settle();
  assert.deepEqual([b.bar().hidden, b.field().value, b.shown().length], [true, '', 7]);
  b.view.unmount();
});

test('a pointerdown on the × ends the search before the field blurs, so a phone with the keyboard up needs one tap', async () => {
  const b = searchOnDom();
  await b.settle();
  await b.press('/');
  await b.type('header');
  assert.equal(b.doc.activeElement, b.field());
  const down = b.page.fire(b.root, 'pointerdown', { target: b.root.querySelector('[data-search-clear]') });
  await b.settle();
  assert.equal(down.defaultPrevented, true, 'the field is not blurred by the touch');
  assert.deepEqual([b.bar().hidden, b.field().value, b.shown().length], [true, '', 7]);
  b.view.unmount();
});

test('f twice or / opens the search from outside a text box; not from a field, with a modifier, with f pressed slowly or apart, or once a key went to switch mode', async () => {
  const b = searchOnDom();
  await b.settle();
  const closed = async () => { await b.press('Escape', { target: b.field() }); assert.equal(b.bar().hidden, true); };
  await b.press('f');
  assert.equal((await b.press('f')).defaultPrevented, true);
  assert.deepEqual([b.bar().hidden, b.doc.activeElement], [false, b.field()]);
  await closed();
  assert.equal((await b.press('/')).defaultPrevented, true);
  assert.equal(b.bar().hidden, false);
  assert.equal((await b.press('/', { target: b.field() })).defaultPrevented, false, '/ types in the search itself');
  await closed();

  const box = b.root.appendChild(b.doc.createElement('textarea'));
  const pairs = [
    [['f', { target: box }], ['f', { target: box }], ['/', { target: box }]],
    [['f', { metaKey: true }], ['f', { metaKey: true }], ['/', { ctrlKey: true }]],
    [['f'], ['x'], ['f']],
    [['f'], ['f', { defaultPrevented: true }]],
    [['f'], ['wait'], ['f']],
  ];
  for (const keys of pairs) {
    for (const [key, ev] of keys) if (key === 'wait') b.wait(500); else await b.press(key, ev);
    assert.equal(b.bar().hidden, true, keys.map(([key]) => key).join(' '));
    b.wait(1000);
  }
  b.view.unmount();
});

test('Enter in the search opens the top match on a desktop, the New strip first, keeping the filter; on a phone Enter or a drag on the page hides the keyboard and keeps the filter', async () => {
  const desk = searchOnDom({ width: 1280 });
  await desk.settle();
  await desk.press('/');
  await desk.type('board');
  assert.equal((await desk.press('Enter', { target: desk.field() })).defaultPrevented, true);
  await desk.settle();
  assert.equal(desk.root.querySelector('details.item[data-key="w/T-330"]').open, true);
  assert.match(desk.page.win.location.hash, /selectedCard=w%2FT-330/);
  assert.deepEqual([desk.bar().hidden, desk.field().value, desk.shown()], [false, 'board', ['w/T-330', 'w/T-12']]);
  desk.view.unmount();

  const phone = searchOnDom();
  await phone.settle();
  await phone.press('/');
  await phone.type('board');
  await phone.press('Enter', { target: phone.field() });
  assert.equal(phone.doc.activeElement, null, 'the keyboard hides');
  assert.equal(phone.root.querySelector('details.item[data-key="w/T-330"]').open, false);
  assert.deepEqual([phone.bar().hidden, phone.shown()], [false, ['w/T-330', 'w/T-12']]);
  phone.field().focus();
  phone.page.fire(phone.doc, 'touchmove', { target: phone.root.querySelector('details.item') });
  assert.equal(phone.doc.activeElement, null);
  assert.deepEqual(phone.shown(), ['w/T-330', 'w/T-12']);
  phone.view.unmount();
});

test('a link to a card the search hides asks to reset filters: yes ends the search and opens the card', async () => {
  const b = searchOnDom({ width: 1280, confirm: true });
  await b.settle();
  await b.press('/');
  await b.type('board');
  b.page.win.location.hash = '#selectedCard=w%2FT-33';
  b.page.fire(vm.runInContext('window', b.page.win), 'hashchange');
  await b.settle();
  assert.deepEqual(b.confirms, ['This task is not currently visible, reset filters?']);
  assert.deepEqual([b.bar().hidden, b.field().value], [true, '']);
  assert.equal(b.root.querySelector('details.item[data-key="w/T-33"]').open, true);
  b.view.unmount();
});

// docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md
// A family: T-594 the parent of T-598, T-600 and T-601, T-601 blocked by T-600, T-596 related to T-598; T-610, T-612
// and T-33 linked to nothing.
const linkedBoard = () => {
  const l = (ref) => ({ key: `w/${ref}`, ref });
  return {
    ...boardOf([
      workCard('T-33', { ref: 'T-33', title: 'Fix the header', lane: 'review' }),
      workCard('T-600', { ref: 'T-600', title: 'Reconcile probes each board', lane: 'progress', parent: l('T-594'), blocks: [l('T-601')] }),
      workCard('T-601', { ref: 'T-601', title: 'The hub stream rides the clocks, polls gone', bumpable: true, parent: l('T-594'), blockers: [l('T-600')], blockedBy: [l('T-600')] }),
      workCard('T-610', { ref: 'T-610', title: 'Polls in the colour rule', bumpable: true }),
      workCard('T-612', { ref: 'T-612', title: 'Done keeps its scroll', bumpable: true, bumpedAt: '2026-10-30T09:00:00.000Z' }),
      workCard('T-594', { ref: 'T-594', title: 'Re-audit polling', lane: 'done', sortAt: '2026-10-30T07:00:00.000Z', children: [l('T-598'), l('T-600'), l('T-601')] }),
      workCard('T-598', { ref: 'T-598', title: 'The Polls registry', lane: 'done', sortAt: '2026-10-30T06:00:00.000Z', parent: l('T-594'), related: [l('T-596')] }),
      workCard('T-596', { ref: 'T-596', title: 'Architecture review', lane: 'done', sortAt: '2026-10-30T05:00:00.000Z', related: [l('T-598')] }),
      newAsk('n1', '2026-10-30T08:00:00.000Z', 'waiting', 'Something new'),
    ]),
    reviews: { shown: true, at: '2026-10-30T09:00:00.000Z', repo: 'o/r', waiting: 0, earlier: [],
      cards: [{ number: 12, title: 'Deps bump', author: 'quinn', url: 'https://github.com/o/r/pull/12', asked: false, touches: [], state: 'posted', at: '2026-10-30T09:00:00.000Z', text: null, reviewUrl: null }] },
  };
};
function linkedOnDom(opts = {}) {
  const b = searchOnDom({ board: linkedBoard(), ...opts });
  const menu = () => b.root.querySelector('#cardMenu');
  const more = (ref) => b.root.querySelector(`details.item[data-key="w/${ref}"] button[data-card-menu]`);
  const items = () => (menu().hidden ? null : menu().querySelectorAll('button[role="menuitem"]').map((el) => el.textContent));
  const open = async (ref) => { b.page.fire(b.root, 'click', { target: more(ref) }); await b.settle(); };
  const choose = async (ref, label) => {
    await open(ref);
    b.page.fire(b.root, 'click', { target: menu().querySelectorAll('button[role="menuitem"]').find((el) => el.textContent === label) });
    await b.settle();
  };
  const banner = () => { const el = b.root.querySelector('#linkedBanner'); return el.hidden ? null : el.textContent.trim(); };
  return { ...b, menu, more, items, open, choose, banner };
}

test('a card\'s "…" opens its menu: Bump or Unbump when it can be bumped, Linked · 1 hop and Linked · all when it has links; a card with neither has no "…"; a tap elsewhere or Esc closes it', async () => {
  const b = linkedOnDom();
  await b.settle();
  assert.equal(b.items(), null);
  await b.open('T-601');
  assert.deepEqual([b.items(), b.more('T-601').getAttribute('aria-expanded'), b.menu().dataset.key], [['Bump', 'Linked · 1 hop', 'Linked · all'], 'true', 'w/T-601']);
  await b.open('T-601');
  assert.deepEqual([b.items(), b.more('T-601').getAttribute('aria-expanded')], [null, 'false'], 'the "…" again closes it');
  await b.open('T-612');
  assert.deepEqual([b.items(), b.more('T-612').classList.contains('bumped')], [['Unbump'], true]);
  await b.open('T-598');
  assert.deepEqual(b.items(), ['Linked · 1 hop', 'Linked · all'], 'Done: not bumpable');
  assert.equal(b.more('T-33'), null);
  b.page.fire(b.doc, 'click', { target: b.root.querySelector('#lanes') });
  await b.settle();
  assert.equal(b.items(), null);
  await b.open('T-598');
  const esc = await b.press('Escape');
  assert.deepEqual([b.items(), esc.defaultPrevented, b.banner()], [null, true, null]);
  b.view.unmount();
});

test('Linked · 1 hop shows the card and its direct links, Linked · all the whole chain: a banner reads Linked to the card and the depth, lanes read x of y, a lane with none of the chain and Auto Review hide, and choosing again on a card in the chain re-roots', async () => {
  const b = linkedOnDom();
  await b.settle();
  await b.choose('T-594', 'Linked · 1 hop');
  assert.deepEqual([b.banner(), b.items()], ['Linked to T-594 · 1 hop', null]);
  assert.deepEqual(b.shown(), ['w/n1', 'w/T-600', 'w/T-601', 'w/T-594', 'w/T-598']);
  assert.deepEqual(b.counts(), [['new', '1'], ['progress', '1 of 1'], ['todo', '1 of 3'], ['done', '2 of 3']]);
  assert.equal(b.lane('done').open, true, 'a folded lane holding the chain opens');
  assert.deepEqual(b.root.querySelectorAll('details.item.linked-root').map((el) => el.dataset.key), ['w/T-594']);

  await b.choose('T-594', 'Linked · all');
  assert.equal(b.banner(), 'Linked to T-594 · all');
  assert.deepEqual(b.shown(), ['w/n1', 'w/T-600', 'w/T-601', 'w/T-594', 'w/T-598', 'w/T-596'], 'related walked too');

  await b.choose('T-600', 'Linked · 1 hop');
  assert.equal(b.banner(), 'Linked to T-600 · 1 hop', 'the banner moves, never stacks');
  assert.deepEqual(b.shown(), ['w/n1', 'w/T-600', 'w/T-601', 'w/T-594']);
  assert.equal(b.root.querySelectorAll('#linkedBanner .hold-banner').length, 1);

  b.page.fire(b.root, 'click', { target: b.root.querySelector('#linkedBanner [data-linked-end]') });
  await b.settle();
  assert.equal(b.banner(), null);
  assert.deepEqual(b.counts(), [['new', '1'], ['reviews', '1'], ['review', '1'], ['progress', '1'], ['todo', '3'], ['done', '3']]);
  assert.equal(b.lane('done').open, false, 'the lane folds again, its stored state untouched');
  b.view.unmount();
});

test('typed search narrows within the chain, the banner staying; Esc in the search ends the search, then Esc ends the chain', async () => {
  const b = linkedOnDom();
  await b.settle();
  await b.choose('T-594', 'Linked · all');
  await b.press('/');
  await b.type('polls');
  assert.deepEqual(b.shown(), ['w/T-601', 'w/T-598'], 'T-610 holds the word, not the link');
  assert.deepEqual(b.counts(), [['new', '0 of 1'], ['todo', '1 of 3'], ['done', '1 of 3']]);
  assert.equal(b.banner(), 'Linked to T-594 · all');
  await b.press('Escape', { target: b.field() });
  assert.deepEqual([b.bar().hidden, b.banner()], [true, 'Linked to T-594 · all']);
  await b.press('Escape');
  assert.equal(b.banner(), null);
  assert.equal(b.shown().length, 10);
  b.view.unmount();
});

test('a link to a card the chain hides asks to reset filters: yes ends the chain and opens the card', async () => {
  const b = linkedOnDom({ width: 1280, confirm: true });
  await b.settle();
  await b.choose('T-594', 'Linked · 1 hop');
  b.page.win.location.hash = '#selectedCard=w%2FT-610';
  b.page.fire(vm.runInContext('window', b.page.win), 'hashchange');
  await b.settle();
  assert.deepEqual([b.confirms, b.banner()], [['This task is not currently visible, reset filters?'], null]);
  assert.equal(b.root.querySelector('details.item[data-key="w/T-610"]').open, true);
  b.view.unmount();
});

// docs/adr/2026-11-17-1230-search-also-finds-old-done-tasks-in-the-archive.md
test('typing asks the archive for matching Done tasks 250 ms after the last key; they follow the loaded Done cards, count in x of y, page 100 at a time, and clearing drops them', async () => {
  const day = (n) => new Date(Date.parse('2026-11-04T10:00:00Z') - n * 60000).toISOString();
  const archive = Array.from({ length: 130 }, (_, n) => workCard(`A${n}`, { ref: `T-${500 + n}`, title: `Old search ${n}`, lane: 'done', sortAt: day(100 + n) }));
  const b = searchOnDom({ board: { ...searchBoard(), doneArchived: 400 } });
  const asked = [];
  b.server.done = (params) => {
    asked.push([params.get('q'), params.get('before')]);
    const from = params.get('before') ? archive.findIndex((c) => `${c.sortAt}|${c.key}` === params.get('before')) + 1 : 0;
    const cards = archive.slice(from, from + 100);
    return { cards, left: archive.length - from - cards.length };
  };
  await b.settle();
  b.page.fire(b.root, 'click', { target: b.root.querySelector('#searchOpen') });
  await b.type('o');
  await b.type('old search');
  assert.deepEqual(asked, [], 'nothing is asked until the typing pauses');
  b.page.runTimers(250);
  await b.settle();
  assert.deepEqual(asked, [['old search', null]], 'one request, for the words as they stand');
  const done = () => b.lane('done');
  const keys = () => done().querySelectorAll('details.item').map((el) => el.dataset.key);
  assert.deepEqual(keys().slice(0, 2), ['w/T-40', 'w/A0'], 'the matches follow the loaded Done cards');
  assert.equal(keys().length, 10);
  assert.equal(done().querySelector(':scope > summary .count').textContent, '101 of 402', 'x counts the matches, y stays the true total');
  assert.equal(done().querySelector('[data-lane-more]').textContent, 'Show more · 121 older tasks');
  for (let i = 0; i < 9; i++) { b.page.fire(b.root, 'click', { target: done().querySelector('[data-lane-more]') }); await b.settle(); }
  assert.equal(done().querySelector('[data-lane-more]').textContent, 'Show more · 31 older tasks', 'the older tasks are the matches past those shown, fetched or not');
  const tap = async () => { b.page.fire(b.root, 'click', { target: done().querySelector('[data-lane-more]') }); await b.settle(); };
  await tap();
  assert.deepEqual(asked.at(-1), ['old search', `${day(199)}|w/A99`], 'the next page pages the matches, past the last one held');
  assert.equal(asked.length, 2);
  await b.type('');
  assert.deepEqual(keys().length, 2, 'clearing drops the fetched matches');
  assert.equal(done().querySelector(':scope > summary .count').textContent, '402');
  b.view.unmount();
});

test('on a phone the search bar is fixed just above the bottom bar, mirroring the desktop, and its shadow no longer paints the status bar', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const phone = css.match(/@media \(max-width: 899px\) \{\n  \.search-bar \.search-hint[^]*?\n\}/)[0];
  assert.match(phone, /\.search-bar \{[^}]*position: fixed; top: auto;[^}]*bottom: max\(var\(--app-bottom, 0px\), var\(--kb, 0px\)\);[^}]*left: 0; right: 0;[^}]*border-top: 1px solid var\(--line\); border-bottom: 0; box-shadow: none/);
});

// docs/adr/2026-11-17-2100-a-sent-answer-clears-its-cards-questions-marks-at-once.md
// A card asking `n` questions, as the board draws it: Open items and an orange Questions button.
const asking = (n) => workCard('T1', { actionButton: 'openQuestions', resolvedBy: 'openQuestions', questions: { first: 'q1', open: n, answered: 0, replied: 0, state: 'open' }, action: { kind: 'questions', url: 'questions.html#q1', label: `Answer ${n} questions` } });
const marks = (v) => {
  const card = v.root.querySelector('details.item[data-key="w/T1"]');
  const chip = v.root.querySelector('.pane-chip[data-pane-show="questions"] b')?.textContent;
  return [card.querySelector('.card-open-items') !== null, card.querySelector('button[data-questions]')?.getAttribute('class').split(' ').includes('resolves'), chip];
};

test("sending answers to every open question of a card clears its Open items and its Questions button's orange at once, before the board replies, and counts it out of the questions chip", async () => {
  const gate = { promise: new Promise(() => {}) };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'T1: Search' }], items: [asking(2)], questions: [rowQuestion('q1', 'item:w/T1'), rowQuestion('q2', 'item:w/T1')], at: 'q1', gate });
  await v.settle();
  assert.deepEqual(marks(v), [true, true, '1']);
  v.answer('q1');
  v.answer('q2');
  await v.send();
  assert.equal(v.sent.length, 1, 'the board has not replied');
  assert.deepEqual(marks(v), [false, false, '0']);
  v.unmount();
});

test("answering one of a card's two open questions leaves its Open items and orange button", async () => {
  const gate = { promise: new Promise(() => {}) };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'T1: Search' }], items: [asking(2)], questions: [rowQuestion('q1', 'item:w/T1'), rowQuestion('q2', 'item:w/T1')], at: 'q1', gate });
  await v.settle();
  v.answer('q1');
  await v.send();
  assert.deepEqual(marks(v), [true, true, '1']);
  v.unmount();
});

test("a send that fails brings the card's Open items and orange button back", async () => {
  const gate = { promise: Promise.resolve(), down: true };
  const v = questionsOnDom({ topics: [{ id: 'item:w/T1', title: 'T1: Search' }], items: [asking(1)], questions: [rowQuestion('q1', 'item:w/T1')], at: 'q1', gate });
  await v.settle();
  v.answer('q1');
  await v.send();
  assert.match(v.footer('q1'), /not sent$/);
  assert.deepEqual(marks(v), [true, true, '1']);
  v.unmount();
});
