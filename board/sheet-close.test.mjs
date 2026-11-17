// Every .sheet closes by playing its entry backwards (the .closing class, 180 ms), instantly under reduced motion; a
// sheet asked to open for what it already shows stays where it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const timers = [];
const reduced = { matches: false };
const context = vm.createContext({
  document: { addEventListener() {} }, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true },
  setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout, matchMedia: () => reduced,
});
for (const file of ['ui-icon-text.js', 'ui.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const later = (ms, fn) => timers.push({ fn, ms });
const { closeSheet: close, cutClose } = context.BoardUI;
const closeSheet = (sheet, done) => close(sheet, later, done);

const dialog = () => {
  const classes = new Set();
  return { open: true, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }, close() { this.open = false; } };
};

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

const src = (f) => fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');

// The reader leaving the notes already shown in place, and its close-out, are tested by behaviour in view.test.mjs ("a
// card's notes the board's sync carried open in the sheet").

test('the questions sheet closes through the shared helper', () => {
  assert.match(src('app-questions-sheet.js'), /closeSheet\(sheet, later, \(\) => \{ topic = null; \}\)/);
});

test('no sheet keeps its own copy of the closing class dance', () => {
  for (const f of ['app-header.js', 'app-cards.js', 'new-task.js']) assert.doesNotMatch(src(f), /classList\.add\('closing'\)/, f);
});

test('a swap opens the new sheet over the old, which stays open until the entry ends, then closes with no exit', () => {
  timers.length = 0;
  const from = dialog(), to = dialog();
  to.open = false;
  let done = 0;
  context.BoardUI.swapSheet(from, later, () => { done++; }, () => { to.open = true; });
  assert.ok(from.open && to.open, 'both open during the swap');
  assert.ok(!from.classList.contains('closing'));
  assert.equal(done, 0);
  timers[0].fn();
  assert.ok(!from.open && to.open, 'after it only the new one');
  assert.equal(done, 1);
});

test('a swap under reduced motion closes the old at once; from a shut sheet it only opens the new', () => {
  const from = dialog(), to = dialog();
  to.open = false;
  reduced.matches = true;
  context.BoardUI.swapSheet(from, later, () => {}, () => { to.open = true; });
  reduced.matches = false;
  assert.ok(!from.open && to.open);
  const shut = dialog(), next = dialog();
  shut.open = false; next.open = false;
  timers.length = 0;
  context.BoardUI.swapSheet(shut, later, () => {}, () => { next.open = true; });
  assert.ok(next.open);
  assert.equal(timers.length, 0);
});

test('the pane swaps the reader for the questions sheet through swapSheet', () => {
  assert.match(src('app-reader.js'), /BoardUI\.swapSheet\(sheet, B\.later, dropPage, opening\)/);
  assert.match(src('app-pane.js'), /B\.closeReader\(\(\) => \{ opened = B\.openQuestionsSheet\(id\); \}\)/);
});
