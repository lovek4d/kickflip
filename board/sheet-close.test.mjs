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

test('the reader leaves the notes already shown in place', () => {
  const s = src('app-reader.js');
  assert.match(s, /if \(sheet\.open && !sheet\.classList\.contains\('closing'\) && notesKey === key\) return;/);
  assert.match(s, /BoardUI\.closeSheet\(sheet, B\.later\)/);
});

test('the questions sheet closes through the shared helper', () => {
  assert.match(src('app-questions-sheet.js'), /closeSheet\(sheet, later, \(\) => \{ topic = null; \}\)/);
});

test('no sheet keeps its own copy of the closing class dance', () => {
  for (const f of ['app-header.js', 'app-cards.js', 'new-task.js']) assert.doesNotMatch(src(f), /classList\.add\('closing'\)/, f);
});
