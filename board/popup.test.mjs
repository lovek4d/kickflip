// docs/adr/2026-11-18-0300-every-popup-opens-through-one-seam.md: a popup (public/popup.js) opens in the top layer,
// above a modal and above a sheet over the header, stays inside the screen at its edges, and closes on Escape or a tap
// outside it, leaving the modal under it open.
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
const ROWS = (n) => Array.from({ length: n }, (_, i) => `<button type="button" class="board-filter-box">Row ${i}</button>`).join('');

// Loads body with style.css, popup.js and then script, at width × height, once script has run.
// → {run(expr), report(), key(name), tap(x, y), close()}; report() reads #pop and #modal.
async function load(body, script, width = 390, height = 700) {
  const file = path.join(tempDir('popup-'), 'page.html');
  fs.writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head><body>${body}<script src="${pub}popup.js"></script><script>
window.shut = 0;
window.report = () => { const pop = document.getElementById('pop'); const r = pop.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { open: pop.matches(':popover-open'), onTop: pop.contains(top), left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrolls: pop.scrollHeight > pop.clientHeight, closed: window.shut, modal: document.getElementById('modal')?.open ?? null, w: innerWidth, h: innerHeight }; };
${script}; window.ready = true;
</script></body></html>`);
  const tab = await openTab(chrome.port);
  await tab.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  // The page's script runs before its load event, so the popup is open once the tab reports the load.
  await tab.cdp('Page.enable');
  const loaded = new Promise((resolve) => { const off = tab.on((m) => { if (m.method === 'Page.loadEventFired') { off(); resolve(); } }); });
  await tab.cdp('Page.navigate', { url: `file://${file}` });
  await loaded;
  const run = async (expression) => (await tab.cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  assert.equal(await run('window.ready'), true, 'the page opened its popup');
  return {
    run,
    report: () => run('report()'),
    key: async (key) => {
      for (const type of ['keyDown', 'keyUp']) await tab.cdp('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: 27 });
    },
    tap: async (x, y) => {
      for (const type of ['mousePressed', 'mouseReleased']) await tab.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    },
    close: () => tab.close(),
  };
}

const OPEN = (align = 'start') => `Popup.open(document.getElementById('pop'), document.getElementById('anchor'), { align: '${align}', onClose: () => { window.shut++; } })`;

test('a popup opened over a modal is in the top layer above it, and Escape closes the popup only', { skip: !chromeInstalled }, async () => {
  const p = await load(`<dialog id="modal" style="width:300px;height:40px;overflow:hidden;padding:0"><button id="anchor">Emoji</button><div id="pop" class="board-filter-menu">${ROWS(6)}</div></dialog>`,
    `document.getElementById('modal').showModal(); ${OPEN()}`);
  try {
    const got = await p.report();
    assert.equal(got.open, true, 'the popup is open as a popover');
    assert.equal(got.onTop, true, 'the popup draws above the modal it sits in, past the modal’s clipped edge');
    await p.key('Escape');
    const after = await p.report();
    assert.deepEqual([after.open, after.closed, after.modal], [false, 1, true], 'Escape closed the popup, told its owner, and left the modal open');
    await p.key('Escape');
    assert.equal((await p.report()).modal, false, 'the next Escape reaches the modal');
  } finally { await p.close(); }
});

test("a popup in the header draws above a sheet over the header, whatever the header's own layer", { skip: !chromeInstalled }, async () => {
  const p = await load(`<header class="top" style="position:sticky;top:0;z-index:5"><button id="anchor">Filter</button><span id="pop" class="board-filter-menu">${ROWS(4)}</span></header>
<dialog id="modal" style="position:fixed;inset:0;margin:0;width:100vw;height:100vh;max-width:none;max-height:none;z-index:30">Sheet</dialog>`,
  `document.getElementById('modal').show(); ${OPEN()}`);
  try {
    assert.equal((await p.report()).onTop, true);
  } finally { await p.close(); }
});

test("a popup anchored at the screen's bottom-right corner stays inside the screen, scrolling what doesn't fit", { skip: !chromeInstalled }, async () => {
  const p = await load(`<button id="anchor" style="position:fixed;right:0;bottom:0">More</button><div id="pop" class="board-filter-menu" style="width:260px">${ROWS(60)}</div>`, OPEN());
  try {
    const got = await p.report();
    assert.ok(got.left >= 8 && got.right <= got.w - 8, `the popup spans ${got.left}–${got.right} inside 8–${got.w - 8}`);
    assert.ok(got.top >= 8 && got.bottom <= got.h - 8, `the popup spans ${got.top}–${got.bottom} inside 8–${got.h - 8}`);
    assert.equal(got.scrolls, true, 'rows past the screen scroll inside the popup');
  } finally { await p.close(); }
});

test('a popup anchored at the top-left opens under its anchor, its right edge on the anchor’s with align end, kept on screen', { skip: !chromeInstalled }, async () => {
  const p = await load(`<button id="anchor" style="position:fixed;left:0;top:0;width:40px;height:30px">Menu</button><div id="pop" class="board-filter-menu" style="width:200px">${ROWS(3)}</div>`, OPEN('end'));
  try {
    const got = await p.report();
    assert.equal(got.top, 34, 'under the anchor, 4px down');
    assert.equal(got.left, 8, 'pushed right of the screen edge, though its right edge would line up with the anchor’s');
  } finally { await p.close(); }
});

test('a tap outside the popup closes it and goes on; a tap inside keeps it; its anchor leaving the page closes it', { skip: !chromeInstalled }, async () => {
  const p = await load(`<button id="anchor" style="position:fixed;left:20px;top:20px">Menu</button><div id="pop" class="board-filter-menu">${ROWS(3)}</div>`, OPEN());
  try {
    const got = await p.report();
    await p.tap(got.left + 10, got.top + 10);
    assert.deepEqual([(await p.report()).open, (await p.report()).closed], [true, 0], 'a tap in the popup keeps it');
    await p.tap(300, 600);
    assert.deepEqual([(await p.report()).open, (await p.report()).closed], [false, 1], 'a tap outside closes it and tells its owner');
    // The seam's MutationObserver hears the removal in a microtask, which has run by the time this evaluation returns.
    await p.run(`${OPEN()}; document.getElementById('anchor').remove()`);
    assert.deepEqual([(await p.report()).open, (await p.report()).closed], [false, 2], 'the popup closed once its anchor left');
  } finally { await p.close(); }
});
