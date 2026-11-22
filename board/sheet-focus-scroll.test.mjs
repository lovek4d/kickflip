// A sheet with a keyboard focuses its field through BoardDialogs.focusField: focus without scrolling, since iOS otherwise
// scrolls the board behind the sheet, then the field scrolls into view once the keyboard is up. Below 900px the page is
// locked under a modal by CSS alone; dialogs.js fitSheet never writes the page's scroll
// (docs/adr/2026-11-22-2330-a-sheets-height-follows-rotation-from-css.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (name) => fs.readFileSync(fileURLToPath(new URL(`./public/${name}`, import.meta.url)), 'utf8');

test('New task and Close board focus their field through focusField', () => {
  const calls = [
    ['new-task.js', "BoardDialogs.focusField($('#askText'))"],
    ['view-settings.js', 'BoardDialogs.focusField(typed)'],
  ];
  for (const [file, call] of calls) assert.ok(src(file).includes(call), `${file} focuses its field with focusField`);
});

const load = (vv) => {
  const timers = [];
  const window = { visualViewport: vv, innerHeight: 844, innerWidth: 390, addEventListener() {} };
  const ctx = { window, globalThis: null, setTimeout: (f) => timers.push(f) - 1, clearTimeout: (id) => { timers[id] = null; }, matchMedia: () => ({ matches: false }) };
  ctx.globalThis = ctx;
  vm.runInNewContext(src('dialogs.js'), ctx);
  return { focusField: ctx.BoardDialogs.focusField, timers };
};
const field = () => {
  const log = [];
  return { log, focus: (o) => log.push(['focus', o.preventScroll]), scrollIntoView: (o) => log.push(['scroll', o.block]) };
};

test('focusField focuses without scrolling, then scrolls the field into view when the keyboard resizes the viewport', () => {
  const listeners = {};
  const vv = { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } };
  const { focusField } = load(vv);
  const f = field();
  focusField(f);
  assert.deepEqual(f.log, [['focus', true]]);
  listeners.resize();
  assert.deepEqual(f.log, [['focus', true], ['scroll', 'nearest']]);
  assert.equal(listeners.resize, undefined, 'it listens once');
});

test('focusField returns a cancel that drops its listener and timer', () => {
  const listeners = {};
  const vv = { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } };
  const { focusField, timers } = load(vv);
  focusField(field())();
  assert.equal(listeners.resize, undefined);
  assert.equal(timers[0], null);
});

test('focusField scrolls into view after a short wait when no resize follows (keyboard already up)', () => {
  const vv = { addEventListener() {}, removeEventListener() {} };
  const { focusField, timers } = load(vv);
  const f = field();
  focusField(f);
  timers[0]();
  assert.deepEqual(f.log, [['focus', true], ['scroll', 'nearest']]);
});
