import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const listeners = {};
const document = { addEventListener: (type, fn, capture) => { listeners[type] = { fn, capture }; } };
const context = vm.createContext({ document, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
for (const file of ['ui-icon-text.js', 'ui.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const { onBackdrop } = context.BoardUI;

const backdrop = {};
const inside = {};
const press = (target) => listeners.pointerdown.fn({ target });

test('the press is recorded before the page sees it, in the capture phase', () => {
  assert.equal(listeners.pointerdown.capture, true);
});

test('a press and a click both on the backdrop dismiss the modal', () => {
  press(backdrop);
  assert.equal(onBackdrop({ target: backdrop }, backdrop), true);
});

test('a press inside the modal released on the backdrop leaves it open', () => {
  press(inside);
  assert.equal(onBackdrop({ target: backdrop }, backdrop), false);
});

test('a click inside the modal never dismisses it', () => {
  press(inside);
  assert.equal(onBackdrop({ target: inside }, backdrop), false);
});

test('a click is outside a sheet only beyond its box, not on its padding', () => {
  const box = { getBoundingClientRect: () => ({ left: 100, right: 400, top: 300, bottom: 700 }) };
  const { outsideBox } = context.BoardUI;
  assert.equal(outsideBox({ clientX: 250, clientY: 650 }, box), false);
  assert.equal(outsideBox({ clientX: 50, clientY: 650 }, box), true);
  assert.equal(outsideBox({ clientX: 250, clientY: 100 }, box), true);
});
