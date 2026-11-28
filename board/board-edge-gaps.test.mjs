// A board's scroller keeps one gap (--edge) on its top, left and right: the first band sits that far from the header,
// the classic scrollbar fits inside the right gap, and the open search bar sits flush at the scroller's top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { openTab } from '../shared/chrome.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));
const colors = fileURLToPath(new URL('../shared/colors.css', import.meta.url));
const probe = fs.readFileSync(`${pub}app.html`, 'utf8').match(/<script>(document\.addEventListener\('DOMContentLoaded'[^]*?)<\/script>/)[1];

test('the first band sits one gap from the top, left and right, and the search bar sits flush', { skip: !chromeInstalled }, async () => {
  const file = path.join(tempDir('edge-gaps-'), 'page.html');
  const lanes = Array.from({ length: 12 }, (_, i) => `<details class="lane" open><summary>lane ${i}</summary><div class="list" style="height:120px"></div></details>`).join('');
  fs.writeFileSync(file, `<!doctype html><html><head><link rel="stylesheet" href="${colors}"><link rel="stylesheet" href="${pub}style.css"><script>${probe}</script></head><body>
<div class="split"><main><div class="search-bar" id="bar" hidden><input></div>${lanes}</main></div></body></html>`);
  const tab = await openTab(chrome.port);
  try {
    await tab.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await tab.cdp('Page.enable');
    const loaded = new Promise((resolve) => { const off = tab.on((m) => { if (m.method === 'Page.loadEventFired') { off(); resolve(); } }); });
    await tab.cdp('Page.navigate', { url: `file://${file}` });
    await loaded;
    const run = async (expression) => (await tab.cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    const gaps = () => run(`(() => { const m = document.querySelector('main'), r = m.getBoundingClientRect(), l = m.querySelector('.lane').getBoundingClientRect();
      return { top: l.top - r.top, left: l.left - r.left, right: r.right - l.right }; })()`);
    const closed = await gaps();
    assert.deepEqual(closed, { top: 16, left: 16, right: 16 });
    await run(`document.getElementById('bar').hidden = false`);
    const barTop = await run(`document.getElementById('bar').getBoundingClientRect().top - document.querySelector('main').getBoundingClientRect().top`);
    assert.equal(barTop, 0, 'the open search bar sits at the scroller top');
    await run(`document.querySelector('main').scrollTop = 300`);
    assert.equal(await run(`document.getElementById('bar').getBoundingClientRect().top - document.querySelector('main').getBoundingClientRect().top`), 0, 'and stays flush while scrolled');
  } finally { await tab.close(); }
});
