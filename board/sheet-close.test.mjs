// Every .sheet closes by playing its entry backwards (the .closing class, 180 ms), instantly under reduced motion; a
// sheet asked to open for what it already shows stays where it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const timers = [];
const reduced = { matches: false };
// The page's history: its entries, each push one more over the one shown, and backs the page's own back() calls not
// landed yet.
const page = new EventTarget();
const history = {
  entries: [{ idx: 0 }], at: 0, backs: 0,
  get state() { return this.entries[this.at]; },
  pushState(state) { this.entries.splice(this.at + 1, Infinity, state); this.at++; },
  back() { this.backs++; },
};
const popstate = () => page.dispatchEvent(Object.assign(new Event('popstate'), { state: history.state }));
// The owner's Back: one entry down, and its popstate.
const pop = () => { history.at--; popstate(); };
// The browser landing a back the page asked for.
const land = () => { history.backs--; pop(); };
const context = vm.createContext({
  document: { addEventListener() {} }, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443', href: 'https://mac.ts.net/board-a/' }, navigator: { onLine: true },
  setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout, matchMedia: () => reduced, history, Event,
  addEventListener: (type, fn) => page.addEventListener(type, fn),
});
for (const file of ['ui-icon-text.js', 'ui.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const later = (ms, fn) => timers.push({ fn, ms });
const { closeSheet: close, cutClose } = context.BoardUI;
const closeSheet = (sheet, done) => close(sheet, later, done);

const dialog = () => {
  const classes = new Set();
  return { open: true, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }, close() { this.open = false; } };
};
// A dialog as the stack sees it: shown modal or not, its close event, its --layer, its scroll, and the events it got.
// showing: the shown dialogs in the order they show, the last on top.
const made = [];
const showing = [];
const sheetEl = (name) => {
  const el = Object.assign(new EventTarget(), dialog(), { name, open: false, modal: null, layer: null, scrollTop: 0, got: [] });
  const shown = (modal) => { el.open = true; el.modal = modal; showing.splice(showing.indexOf(el) >>> 0, 1); showing.push(el); };
  el.showModal = () => shown(true);
  el.show = () => shown(false);
  // As a browser does, the close event comes a task later; the dialog's scroll goes with its box.
  el.close = () => {
    if (!el.open) return;
    Object.assign(el, { open: false, scrollTop: 0 });
    showing.splice(showing.indexOf(el), 1);
    queueMicrotask(() => el.dispatchEvent(new Event('close')));
  };
  el.style = { setProperty: (_, v) => { el.layer = Number(v); } };
  el.querySelectorAll = () => [];
  for (const type of ['sheet-return', 'cancel', 'page-back']) el.addEventListener(type, () => el.got.push(type));
  made.push(el);
  return el;
};
const tick = () => new Promise((r) => setImmediate(r));
const src = (f) => fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');

test('a closing sheet plays .closing for 180 ms, then closes and calls done', () => {
  timers.length = 0;
  const sheet = dialog();
  let done = 0;
  closeSheet(sheet, () => { done++; });
  assert.ok(sheet.open && sheet.classList.contains('closing'));
  assert.equal(timers[0].ms, 180);
  timers[0].fn();
  assert.ok(!sheet.open && !sheet.classList.contains('closing'));
  assert.equal(done, 1);
});

test('reduced motion closes at once', () => {
  reduced.matches = true;
  const sheet = dialog();
  let done = 0;
  closeSheet(sheet, () => { done++; });
  reduced.matches = false;
  assert.ok(!sheet.open);
  assert.equal(done, 1);
});

test('a second close while closing, and a close of a shut sheet, do nothing', () => {
  timers.length = 0;
  const sheet = dialog();
  closeSheet(sheet);
  closeSheet(sheet);
  assert.equal(timers.length, 1);
  const shut = dialog();
  shut.open = false;
  closeSheet(shut);
  assert.equal(timers.length, 1);
});

test('cutClose ends a close in progress, so the sheet can open again; the timer then does nothing', () => {
  timers.length = 0;
  const sheet = dialog();
  let done = 0;
  closeSheet(sheet, () => { done++; });
  cutClose(sheet);
  assert.ok(!sheet.open);
  sheet.open = true;
  timers[0].fn();
  assert.ok(sheet.open);
  assert.equal(done, 0);
});

// The reader leaving the notes already shown in place, and its close-out, are tested by behaviour in view.test.mjs ("a
// card's notes the board's sync carried open in the sheet").

test('the questions sheet closes through the shared helper', () => {
  assert.match(src('app-questions-sheet.js'), /closeSheet\(sheet, later, \(\) => \{ topic = null; fetched = null; \}\)/);
});

test('no sheet keeps its own copy of the closing class dance', () => {
  for (const f of ['app-header.js', 'app-cards.js', 'new-task.js']) assert.doesNotMatch(src(f), /classList\.add\('closing'\)/, f);
});

// docs/adr/2026-11-17-0306-a-sheet-opened-from-another-stacks-on-it.md
const { openSheet, pushPage, popPage, isTopSheet, afterSheets } = context.BoardUI;
// A new page: every sheet a test left open shut, and the history of one entry.
const fresh = async () => {
  for (const el of made) el.close();
  await tick();
  Object.assign(history, { entries: [{ idx: 0 }], at: 0, backs: 0 });
  popstate();
  timers.length = 0;
};

test('a sheet opened over another stacks on it with one history entry; closing it returns to the one beneath, which hears sheet-return', async () => {
  await fresh();
  const questions = sheetEl('questions'), reader = sheetEl('reader');
  openSheet(questions);
  assert.deepEqual([questions.open, history.entries.length, questions.layer], [true, 1, 0], 'a sheet alone has no entry of its own');
  openSheet(reader);
  assert.deepEqual([questions.open, reader.open, isTopSheet(reader), reader.layer], [true, true, true, 1], 'both open, the new on top');
  assert.deepEqual({ ...history.state }, { idx: 1, sheets: 1 }, 'one entry for the layer, at the same URL');
  closeSheet(reader);
  assert.deepEqual([questions.open, isTopSheet(questions), questions.got, history.backs], [true, true, ['sheet-return'], 1], 'the one beneath is back on top, and the entry is spent');
  land();
  timers[0].fn();
  await tick();
  assert.deepEqual([reader.open, questions.open, history.backs], [false, true, 0]);
});

test('Back peels one layer at a time, each dismissed through its own cancel', async () => {
  await fresh();
  const a = sheetEl('a'), b = sheetEl('b'), c = sheetEl('c');
  for (const s of [a, b, c]) s.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(s); });
  openSheet(a, { modal: false, entry: true });
  openSheet(b, { modal: false });
  openSheet(c, { modal: false });
  assert.deepEqual([history.state.sheets, [a, b, c].map((s) => s.layer)], [3, [0, 1, 2]], 'an opener may ask an entry for the base; non-modal sheets stack by --layer');
  pop();
  assert.deepEqual([c.got, c.classList.contains('closing'), b.open, isTopSheet(b), history.backs], [['cancel'], true, true, true, 0], 'the top one closes as Escape would; no further back');
  pop();
  assert.deepEqual([b.got, a.open, isTopSheet(a)], [['cancel'], true, true]);
  pop();
  assert.deepEqual([a.got, history.at], [['cancel'], 0]);
});

test('a sheet shut by its own close() leaves the stack and spends its entry; one under another closing leaves the top as it is', async () => {
  await fresh();
  const a = sheetEl('a'), b = sheetEl('b'), c = sheetEl('c');
  openSheet(a); openSheet(b); openSheet(c);
  b.close();
  await tick();
  assert.deepEqual([isTopSheet(c), c.got, history.backs], [true, [], 1], 'b goes, c stays on top, one entry spent');
  land();
  c.close();
  await tick();
  assert.deepEqual([isTopSheet(a), a.got, history.backs], [true, ['sheet-return'], 1]);
  land();
  assert.equal(history.at, 0);
});

test('two layers closing at once go back one entry at a time, and afterSheets waits for the last', async () => {
  await fresh();
  const a = sheetEl('a'), b = sheetEl('b');
  openSheet(a, { entry: true }); openSheet(b);
  const ran = [];
  closeSheet(b); closeSheet(a);
  afterSheets(() => ran.push(history.at));
  assert.deepEqual([history.backs, ran], [1, []], 'one back under way');
  land();
  assert.deepEqual([history.backs, ran], [1, []], 'then the next');
  land();
  assert.deepEqual(ran, [0], 'and then what waited runs');
  afterSheets(() => ran.push('now'));
  assert.deepEqual(ran, [0, 'now'], 'with nothing to spend it runs at once');
});

test('a sheet opened again while under another comes back on top, keeping the entries; one open on top stays put', async () => {
  await fresh();
  const reader = sheetEl('reader'), questions = sheetEl('questions');
  openSheet(reader, { entry: true });
  openSheet(questions);
  openSheet(questions);
  assert.equal(history.entries.length, 3, 'opened again on top: nothing');
  openSheet(reader);
  await tick();
  assert.deepEqual([reader.open, questions.open, isTopSheet(reader), reader.layer, questions.layer, history.entries.length], [true, true, true, 1, 0, 3], 'raised over the questions sheet; the late close event leaves it in the stack');
  closeSheet(reader);
  assert.deepEqual([isTopSheet(questions), history.backs], [true, 1]);
});

test('a page a sheet stacks on itself has a layer and an entry of its own, which Back or popPage takes off; raised over another sheet with it, the sheet goes back under it, which shows again where it was', async () => {
  await fresh();
  const reader = sheetEl('reader'), questions = sheetEl('questions');
  openSheet(reader, { entry: true });
  pushPage(reader);
  assert.deepEqual([history.state.sheets, isTopSheet(reader), showing], [2, true, [reader]], 'one more entry, the sheet as it was');
  pop();
  assert.deepEqual([reader.got, reader.open, history.backs], [['page-back'], true, 0], 'Back takes the page off: page-back, no cancel');

  openSheet(questions);
  questions.scrollTop = 40;
  pushPage(reader);
  assert.deepEqual([isTopSheet(reader), showing, history.state.sheets, reader.layer, questions.layer], [true, [questions, reader], 3, 1, 0], 'a page over the questions sheet raises the sheet');
  popPage(reader);
  await tick();
  assert.deepEqual([isTopSheet(questions), showing, questions.scrollTop, questions.got, reader.open, history.backs], [true, [reader, questions], 40, ['sheet-return'], true, 1], 'popPage puts it back under the questions sheet, shown again where it was');
  land();
  assert.equal(history.state.sheets, 2);

  pushPage(reader);
  closeSheet(reader);
  assert.deepEqual([isTopSheet(questions), history.backs], [true, 1], 'the sheet closing takes its pages with it');
  land();
  land();
  assert.equal(history.state.sheets, 1);
});

test('swapSheet is gone: a sheet opened from another stacks on it', () => {
  assert.equal(context.BoardUI.swapSheet, undefined);
  for (const f of fs.readdirSync(new URL('./public/', import.meta.url)).filter((x) => x.endsWith('.js'))) assert.doesNotMatch(src(f), /swapSheet/, f);
});
