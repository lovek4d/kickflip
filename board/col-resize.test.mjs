// The desktop columns drag: the sidebar's edge and the lanes | Waiting on you seam (docs/adr/2026-11-10-1600-the-desktop-columns-drag-and-this-device-keeps-their-widths.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (f) => fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');

function load({ stored = {}, width = 1600 } = {}) {
  const store = new Map(Object.entries(stored));
  const vars = {};
  const listeners = {};
  const win = {
    innerWidth: width,
    addEventListener: (t, f) => { listeners[t] = f; },
    matchMedia: () => ({ matches: width >= 900 }),
  };
  const doc = {
    documentElement: { style: { setProperty: (k, v) => { vars[k] = v; }, removeProperty: (k) => { delete vars[k]; } }, classList: { contains: () => false } },
    addEventListener: (t, f) => { listeners[`doc:${t}`] = f; },
  };
  const ctx = { window: win, document: doc, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
  ctx.globalThis = ctx;
  vm.runInNewContext(read('col-resize.js'), ctx);
  return { api: win.ColResize, vars, store, listeners, win };
}

test('a sidebar width clamps to 220–420px', () => {
  const { api } = load();
  assert.equal(api.clamp('sidebar', 100, 1600, 272), 220);
  assert.equal(api.clamp('sidebar', 300, 1600, 272), 300);
  assert.equal(api.clamp('sidebar', 900, 1600, 272), 420);
});

test('a pane width keeps the lanes and the pane each at 360px or more', () => {
  const { api } = load();
  assert.equal(api.clamp('pane', 100, 1600, 272), 360);
  assert.equal(api.clamp('pane', 5000, 1600, 272), 1600 - 272 - 360);
  assert.equal(api.clamp('pane', 500, 1600, 272), 500);
});

test('a stored width is applied at load and clamped to a narrower window', () => {
  const { vars } = load({ stored: { 'hub:sidebarWidth': '300', 'hub:paneWidth': '900' }, width: 1000 });
  assert.equal(vars['--sb-w'], '300px');
  assert.equal(vars['--pane-w'], '360px');
});

test('no stored width leaves the stylesheet defaults', () => {
  const { vars } = load();
  assert.deepEqual(vars, {});
});

test('setting a width stores it for this device; reset forgets it', () => {
  const { api, vars, store } = load();
  api.set('pane', 600);
  assert.equal(store.get('hub:paneWidth'), '600');
  assert.equal(vars['--pane-w'], '600px');
  api.reset('pane');
  assert.equal(store.has('hub:paneWidth'), false);
  assert.equal(vars['--pane-w'], undefined);
});

test('the CSS reads the widths from the variables, desktop only', () => {
  const style = read('style.css');
  const side = read('sidebar.css');
  assert.match(style, /grid-template-columns: minmax\(0, 1fr\) var\(--pane-w, minmax\(0, 1fr\)\)/);
  assert.match(style, /body\.has-sidebar \{ --sidebar-w: var\(--sb-w, 272px\); \}/);
  assert.match(style, /\.view-board \.fab \{ right: calc\(var\(--pane-w, calc\(50% - var\(--sidebar-w, 0px\) \/ 2\)\) \+ var\(--fab-edge\)\); \}/);
  assert.match(side, /body\.has-sidebar \{ padding-left: var\(--sidebar-w, 272px\); \}/);
  assert.doesNotMatch(side, /272px; \}\n\s*body\.has-sidebar \.sidebar \{ width: 272px/);
  assert.match(style, /\.col-handle \{ display: none; \}/);
});

test('both handles are in the markup and the page loads the helper', () => {
  assert.match(read('app.html'), /class="col-handle"[^>]*data-col="sidebar"/);
  assert.match(read('app.html'), /col-resize\.js/);
  assert.match(read('app.js'), /class="col-handle"[^>]*data-col="pane"/);
});
