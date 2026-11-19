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
// A new page: every sheet a test left open shut, and a history of one entry.
const fresh = async () => {
  for (const el of made) el.close();
  await tick();
  Object.assign(history, { entries: [{ idx: 0 }], at: 0, backs: 0 });
  timers.length = 0;
};
const noHistory = () => assert.deepEqual([history.entries.length, history.at, history.backs], [1, 0, 0], 'no entry pushed, none stepped back');

test('a sheet opened over another stacks on it; closing it returns to the one beneath, which hears sheet-return; no history entry is made or spent', async () => {
  await fresh();
  const questions = sheetEl('questions'), reader = sheetEl('reader');
  openSheet(questions);
  openSheet(reader);
  assert.deepEqual([questions.open, reader.open, isTopSheet(reader), reader.layer], [true, true, true, 1], 'both open, the new on top');
  closeSheet(reader);
  assert.deepEqual([questions.open, isTopSheet(questions), questions.got], [true, true, ['sheet-return']]);
  timers[0].fn();
  await tick();
  assert.deepEqual([reader.open, questions.open], [false, true]);
  noHistory();
});

test('opening A then B and closing A then B never steps history, so no older address can come back', async () => {
  await fresh();
  const a = sheetEl('a'), b = sheetEl('b');
  openSheet(a);
  openSheet(b);
  closeSheet(a);
  closeSheet(b);
  noHistory();
  assert.deepEqual([isTopSheet(a), isTopSheet(b)], [false, false]);
});

test('a sheet shut by its own close() leaves the stack; one under another closing leaves the top as it is', async () => {
  await fresh();
  const a = sheetEl('a'), b = sheetEl('b'), c = sheetEl('c');
  openSheet(a); openSheet(b); openSheet(c);
  b.close();
  await tick();
  assert.deepEqual([isTopSheet(c), c.got], [true, []], 'b goes, c stays on top');
  c.close();
  await tick();
  assert.deepEqual([isTopSheet(a), a.got], [true, ['sheet-return']]);
  noHistory();
});

test('a sheet opened again while under another comes back on top; one open on top stays put', async () => {
  await fresh();
  const reader = sheetEl('reader'), questions = sheetEl('questions');
  openSheet(reader);
  openSheet(questions);
  openSheet(questions);
  openSheet(reader);
  await tick();
  assert.deepEqual([reader.open, questions.open, isTopSheet(reader), reader.layer, questions.layer], [true, true, true, 1, 0], 'raised over the questions sheet; the late close event leaves it in the stack');
  closeSheet(reader);
  assert.equal(isTopSheet(questions), true);
  noHistory();
});

test('a page a sheet stacks on itself is a layer of its own, which popPage takes off; raised over another sheet with it, the sheet goes back under it, which shows again where it was', async () => {
  await fresh();
  const reader = sheetEl('reader'), questions = sheetEl('questions');
  openSheet(reader);
  pushPage(reader);
  assert.deepEqual([isTopSheet(reader), showing], [true, [reader]]);
  popPage(reader);
  assert.deepEqual([reader.got, reader.open], [[], true]);

  openSheet(questions);
  questions.scrollTop = 40;
  pushPage(reader);
  assert.deepEqual([isTopSheet(reader), showing, reader.layer, questions.layer], [true, [questions, reader], 1, 0], 'a page over the questions sheet raises the sheet');
  popPage(reader);
  await tick();
  assert.deepEqual([isTopSheet(questions), showing, questions.scrollTop, questions.got, reader.open], [true, [reader, questions], 40, ['sheet-return'], true], 'popPage puts it back under the questions sheet, shown again where it was');

  pushPage(reader);
  closeSheet(reader);
  assert.equal(isTopSheet(questions), true, 'the sheet closing takes its pages with it');
  noHistory();
});

test('the sheet stack never touches the browser history', () => {
  assert.doesNotMatch(src('ui.js'), /history\.|popstate|afterSheets/);
  assert.doesNotMatch(src('app-reader.js'), /afterSheets|entry: true|page-back/);
});

test('closing a sheet never scrolls the board: no window scroll, no scrollToFocus, no scroll restoration in the sheet code', () => {
  for (const file of ['ui.js', 'app-reader.js']) assert.doesNotMatch(src(file), /scrollTo\(|scrollBy\(|scrollIntoView|scrollToFocus|scrollRestoration/, file);
});

test('swapSheet is gone: a sheet opened from another stacks on it', () => {
  assert.equal(context.BoardUI.swapSheet, undefined);
  for (const f of fs.readdirSync(new URL('./public/', import.meta.url)).filter((x) => x.endsWith('.js'))) assert.doesNotMatch(src(f), /swapSheet/, f);
});
