// The sidebar's edge drags on a desktop (docs/adr/2026-11-10-1600-the-desktop-columns-drag-and-this-device-keeps-their-widths.md);
// the lanes | Waiting on you seam went with the pane (docs/adr/2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md).
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
  assert.equal(api.clamp(100), 220);
  assert.equal(api.clamp(300), 300);
  assert.equal(api.clamp(900), 420);
});

test('a stored width is applied at load, clamped', () => {
  const { vars } = load({ stored: { 'hub:sidebarWidth': '900', 'hub:paneWidth': '900' }, width: 1000 });
  assert.deepEqual({ ...vars }, { '--sb-w': '420px' }, 'an old pane width is ignored');
});

test('no stored width leaves the stylesheet defaults', () => {
  const { vars } = load();
  assert.deepEqual(vars, {});
});

test('setting a width stores it for this device; reset forgets it', () => {
  const { api, vars, store } = load();
  api.set(300);
  assert.equal(store.get('hub:sidebarWidth'), '300');
  assert.equal(vars['--sb-w'], '300px');
  api.reset();
  assert.equal(store.has('hub:sidebarWidth'), false);
  assert.equal(vars['--sb-w'], undefined);
});

test('the CSS reads the widths from the variables, desktop only', () => {
  const style = read('style.css');
  const side = read('sidebar.css');
  assert.doesNotMatch(style, /--pane-w/);
  assert.match(style, /body\.has-sidebar \{ --sidebar-w: var\(--sb-w, 272px\); \}/);
  assert.match(side, /body\.has-sidebar \{ padding-left: var\(--sidebar-w, 272px\); \}/);
  assert.doesNotMatch(side, /272px; \}\n\s*body\.has-sidebar \.sidebar \{ width: 272px/);
  assert.match(style, /\.col-handle \{ display: none; \}/);
});

test('the sidebar handle is in the markup, the board has none, and the page loads the helper', () => {
  assert.match(read('app.html'), /class="col-handle"[^>]*data-col="sidebar"/);
  assert.match(read('app.html'), /col-resize\.js/);
  assert.doesNotMatch(read('app.js'), /col-handle/);
});
