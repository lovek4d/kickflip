// docs/adr/2026-11-17-0613-a-search-bar-narrows-the-board-as-you-type.md
// On a 390x844 phone the open search bar sits fixed above the bottom bar; the + and the toast stack sit above the bar and
// the last card, scrolled to, clears the bar. With the keyboard up, app-search.js measures it from visualViewport (as
// dialogs.js fitSheet does) and lifts the bar above it; the bar drops back on blur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));

// A visualViewport stub the keyboard shrinks by kb px; app-search.js runs as it is on the board, on a minimal BoardView.
const fixture = (kb) => `<!doctype html><html><head><link rel="stylesheet" href="${pub}colors.css"><link rel="stylesheet" href="${pub}style.css"></head>
<body class="view-board"><header class="top"><nav class="nav"><button style="min-height:44px;padding:0">a</button></nav></header>
<main>${Array.from({ length: 40 }, (_, i) => `<div class="card" style="height:80px">card ${i}</div>`).join('')}<div id="last" style="height:80px">last</div></main>
<div class="search-bar" id="searchBar"><input type="search" id="searchField"><button class="search-clear">×</button></div>
<button class="fab">+</button><div class="toast-stack"><div class="toast-row" id="toast"></div></div>
<script>
  const vv = new EventTarget(); vv.height = innerHeight; vv.offsetTop = 0;
  Object.defineProperty(window, 'visualViewport', { value: vv });
  window.BoardUI = { searchWords: (v) => v.split(' ').filter(Boolean) };
  window.BoardView = { part(fn) { fn({ $: (s) => document.querySelector(s), state: {}, root: document, on: (t, e, f, o) => t.addEventListener(e, f, o), findArchived() {}, render() {} }); } };
</script><script src="${pub}app-search.js"></script>
<script>{
  scrollTo(0, document.documentElement.scrollHeight);
  const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
  const field = document.querySelector('#searchField');
  const probe = document.createElement('pre'); probe.id = 'probe';
  const snap = () => ({ bar: r('#searchBar'), nav: r('.top'), fab: r('.fab'), toast: r('#toast'), last: r('#last'), vh: innerHeight, vw: document.documentElement.clientWidth });
  field.dispatchEvent(new Event('focus'));
  vv.height = innerHeight - ${kb}; vv.dispatchEvent(new Event('resize'));
  const up = snap();
  field.dispatchEvent(new Event('blur'));
  probe.textContent = JSON.stringify({ up, down: snap() });
  document.body.append(probe);
}</script></body></html>`;

for (const kb of [0, 300]) {
  test(`at 390px the bar, the + and the last card do not overlap, keyboard ${kb ? 'up' : 'down'}`, { skip: !chromeInstalled }, async () => {
    const file = path.join(tempDir('search-bar-phone-'), 'page.html');
    fs.writeFileSync(file, fixture(kb));
    const { up: g, down } = await chrome.probe(`file://${file}`, 390);
    assert.ok(Math.abs(g.bar.bottom - (kb ? g.vh - kb : g.nav.top)) <= 1, `the bar's foot: ${g.bar.bottom}, the nav's top ${g.nav.top}`);
    assert.ok(Math.abs(down.bar.bottom - down.nav.top) <= 1, `after blur the bar drops back above the bottom bar: ${down.bar.bottom}`);
    assert.ok(g.bar.right - g.bar.left === g.vw, 'the bar spans the phone');
    if (!kb) assert.ok(g.fab.bottom <= g.bar.top, `the + (${g.fab.bottom}) sits above the bar (${g.bar.top})`);
    assert.ok(g.toast.bottom <= g.fab.top, 'the toast stack sits above the +');
    assert.ok(g.last.bottom <= g.bar.top || kb, `the last card (${g.last.bottom}) clears the bar (${g.bar.top})`);
  });
}
