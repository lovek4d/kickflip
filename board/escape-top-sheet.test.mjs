// docs/adr/2026-11-23-1700-one-escape-closes-the-top-sheet.md: in a real page, Escape closes only the top sheet and
// each sheet takes focus, including with focus left in a sheet beneath.
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

// Two sheets, each closing through its own cancel as a view's does, a confirm outside the stack, and ui.js.
async function load() {
  const file = path.join(tempDir('escape-'), 'page.html');
  fs.writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<dialog id="a"><button id="a1">a</button></dialog><dialog id="b"><input id="b1" autofocus></dialog><dialog id="c"><button id="c1">c</button></dialog>
<script src="${pub}ui-icon-text.js"></script><script src="${pub}ui.js"></script><script>
const later = (ms, fn) => fn();
for (const id of ['a', 'b']) { const el = document.getElementById(id); el.addEventListener('cancel', (ev) => { ev.preventDefault(); BoardUI.closeSheet(el, later); }); }
window.state = () => ({ a: a.open, b: b.open, active: document.activeElement.id });
window.ready = true;
</script></body></html>`);
  const tab = await openTab(chrome.port);
  await tab.cdp('Page.enable');
  const loaded = new Promise((resolve) => { const off = tab.on((m) => { if (m.method === 'Page.loadEventFired') { off(); resolve(); } }); });
  await tab.cdp('Page.navigate', { url: `file://${file}` });
  await loaded;
  const run = async (expression) => (await tab.cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  assert.equal(await run('window.ready'), true);
  return {
    run,
    state: () => run('state()'),
    escape: async () => {
      for (const type of ['keyDown', 'keyUp']) await tab.cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    },
    close: () => tab.close(),
  };
}

test('a sheet opened from a sheet takes focus; Escape closes it, then the one beneath', { skip: !chromeInstalled }, async () => {
  const p = await load();
  try {
    await p.run('BoardUI.openSheet(a)');
    assert.deepEqual(await p.state(), { a: true, b: false, active: 'a1' }, 'a takes focus, its button');
    await p.run('BoardUI.openSheet(b)');
    assert.deepEqual(await p.state(), { a: true, b: true, active: 'b1' }, 'b takes its autofocus field');
    await p.escape();
    assert.deepEqual(await p.state(), { a: true, b: false, active: 'a1' }, 'only b closed, focus back in a');
    await p.escape();
    assert.deepEqual(await p.state(), { a: false, b: false, active: '' });
  } finally { await p.close(); }
});

test('with focus left in the sheet beneath, Escape still closes the top one; a confirm outside the stack keeps its own', { skip: !chromeInstalled }, async () => {
  const p = await load();
  try {
    await p.run('BoardUI.openSheet(a, { modal: false }); BoardUI.openSheet(b, { modal: false }); a1.focus()');
    assert.equal((await p.state()).active, 'a1');
    await p.escape();
    assert.deepEqual([(await p.state()).a, (await p.state()).b], [true, false], 'b closed, not a');
    await p.run('c.showModal()');
    await p.escape();
    assert.deepEqual(await p.run('[c.open, a.open]'), [false, true], 'Escape closed the confirm only');
  } finally { await p.close(); }
});
