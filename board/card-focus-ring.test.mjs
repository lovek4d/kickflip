// A card's header takes the board's accent focus ring, as a lane header does, in place of the browser default.
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

test('a focused card header draws the accent ring, and a lane header draws the same', { skip: !chromeInstalled }, async () => {
  const file = path.join(tempDir('card-ring-'), 'page.html');
  fs.writeFileSync(file, `<!doctype html><html><head><link rel="stylesheet" href="${colors}"><link rel="stylesheet" href="${pub}style.css"></head><body>
<details class="lane"><summary id="lane">lane</summary></details><div class="item"><details><summary id="card">card</summary></details></div>
<details class="item"><summary id="item">item</summary></details></body></html>`);
  const tab = await openTab(chrome.port);
  try {
    await tab.cdp('Page.enable');
    const loaded = new Promise((resolve) => { const off = tab.on((m) => { if (m.method === 'Page.loadEventFired') { off(); resolve(); } }); });
    await tab.cdp('Page.navigate', { url: `file://${file}` });
    await loaded;
    const run = async (expression) => (await tab.cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    // A key press first, so a focus afterwards matches :focus-visible.
    await tab.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await tab.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    const ring = (id) => run(`(() => { const el = document.getElementById('${id}'); el.focus(); const s = getComputedStyle(el); return [el.matches(':focus-visible'), s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset].join(' '); })()`);
    const lane = await ring('lane');
    assert.match(lane, /^true solid 2px /);
    assert.equal(await ring('item'), lane, 'the card header takes the lane header ring');
  } finally { await tab.close(); }
});
