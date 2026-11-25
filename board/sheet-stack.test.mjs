// docs/adr/2026-11-24-0300-a-sheet-stacks-only-from-a-tap-inside-another.md: in a real page with style.css, a sheet
// stacks only when a tap inside the top sheet opens it; a tap on the board replaces the stack; reopening a lower sheet
// closes those above it; an auto-open replaces an auto sheet and stacks over the owner's; the sheets beneath show as
// peek strips, scaled back, and each closes by a pull down once it is on top.
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

// Three standard sheets, each closing through its own cancel as a view's does and dragging to dismiss, a button inside
// each that opens the next (c's reopens a), and a board button behind them. modal: whether openSheet shows them modal.
const SHEET = (id, to) => `<dialog id="${id}" class="sheet reader-sheet"><div class="sheet-head"><h2>Sheet ${id}</h2></div>
<p><button id="${id}To" data-to="${to}">open ${to}</button></p></dialog>`;
async function load({ width = 390, height = 760, modal = true } = {}) {
  const file = path.join(tempDir('stack-'), 'page.html');
  fs.writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"><style>*, ::backdrop { animation: none !important; }</style></head><body><button id="board" style="position:fixed;left:10px;top:200px">board</button>
${SHEET('a', 'b')}${SHEET('b', 'c')}${SHEET('c', 'a')}
<dialog id="m" class="settings-modal"><div class="settings-head"><h2>Settings</h2></div><p>body</p></dialog>
<script src="${pub}ui-icon-text.js"></script><script src="${pub}ui.js"></script><script>
const later = (ms, fn) => fn();
const open = (el, opts) => BoardUI.openSheet(el, { modal: ${modal}, ...opts });
m.addEventListener('cancel', (ev) => { ev.preventDefault(); BoardUI.closeSheet(m, later); });
for (const el of [a, b, c]) {
  el.addEventListener('cancel', (ev) => { ev.preventDefault(); BoardUI.closeSheet(el, later); });
  el.querySelector('button').addEventListener('click', (ev) => open(document.getElementById(ev.target.dataset.to)));
  BoardUI.swipeToDismiss(el);
}
board.addEventListener('click', () => open(b));
window.state = () => ({ open: BoardUI.openSheets().map((s) => s.id), anchored: BoardUI.anchored() });
window.box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, bottom: r.bottom }; };
window.ready = true;
</script></body></html>`);
  const tab = await openTab(chrome.port);
  await tab.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await tab.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await tab.cdp('Page.enable');
  const loaded = new Promise((resolve) => { const off = tab.on((m) => { if (m.method === 'Page.loadEventFired') { off(); resolve(); } }); });
  await tab.cdp('Page.navigate', { url: `file://${file}` });
  await loaded;
  const run = async (expression) => (await tab.cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  assert.equal(await run('window.ready'), true);
  const tapAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await tab.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  return {
    run,
    tab,
    state: () => run('state()'),
    box: (id) => run(`box('${id}')`),
    tapAt,
    // A real click in the middle of the element.
    tap: async (selector) => {
      const r = await run(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await tapAt(r.x, r.y);
    },
    escape: async () => {
      for (const type of ['keyDown', 'keyUp']) await tab.cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    },
    // A finger on the sheet's head, pulled down by `by`.
    pull: async (id, by = 400) => {
      const r = await run(`box('${id}')`);
      const x = r.left + r.width / 2;
      const y = r.top + 12;
      await tab.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let d = 20; d <= by; d += 40) await tab.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + d }] });
      await tab.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    close: () => tab.close(),
  };
}

test('a sheet opened by a tap inside the top sheet stacks on it; one opened from the board behind replaces the stack', { skip: !chromeInstalled }, async () => {
  const p = await load({ width: 1280, modal: false });
  try {
    await p.run('open(a)');
    await p.tap('#aTo');
    await p.tap('#bTo');
    assert.deepEqual((await p.state()).open, ['a', 'b', 'c'], 'each tap inside the top sheet stacked the next');
    await p.tap('#board');
    assert.deepEqual((await p.state()).open, ['b'], 'a tap on the board closed the stack and opened its sheet alone');
  } finally { await p.close(); }
});

test('reopening a sheet lower in the stack from inside the top closes every sheet above it, with no second copy', { skip: !chromeInstalled }, async () => {
  const p = await load();
  try {
    await p.run('open(a)');
    await p.tap('#aTo');
    await p.tap('#bTo');
    await p.tap('#cTo');
    assert.deepEqual((await p.state()).open, ['a'], 'c reopened a: b and c closed');
    await p.escape();
    assert.deepEqual((await p.state()).open, [], 'one Escape closes a: nothing was left above it');
  } finally { await p.close(); }
});

test('an auto-open replaces an auto sheet and stacks over the owner’s; closed back down to an auto root, the stack is unanchored again', { skip: !chromeInstalled }, async () => {
  const p = await load();
  try {
    await p.run('open(a, { auto: true })');
    assert.deepEqual(await p.state(), { open: ['a'], anchored: false });
    await p.run('BoardUI.opening("auto", () => open(b))');
    assert.deepEqual(await p.state(), { open: ['b'], anchored: false }, 'the next auto-open replaced the auto sheet');
    await p.tap('#bTo');
    assert.deepEqual(await p.state(), { open: ['b', 'c'], anchored: true }, 'a tap inside the auto sheet stacked the owner’s on it');
    await p.run('BoardUI.opening("auto", () => open(a))');
    assert.deepEqual(await p.state(), { open: ['b', 'c', 'a'], anchored: true }, 'a push while the owner’s sheet is up stacks above it');
    await p.escape();
    await p.escape();
    assert.deepEqual(await p.state(), { open: ['b'], anchored: false }, 'back down to the auto root, it is replaceable again');
    await p.run('BoardUI.opening("auto", () => open(c))');
    assert.deepEqual((await p.state()).open, ['c']);
  } finally { await p.close(); }
});

test('at 390, the sheets beneath show as peek strips above the top one, scaled back, and a tap on a strip closes the sheets above it', { skip: !chromeInstalled }, async () => {
  const p = await load();
  try {
    await p.run('open(a)');
    const alone = await p.box('a');
    await p.tap('#aTo');
    await p.tap('#bTo');
    const [ba, bb, bc] = [await p.box('a'), await p.box('b'), await p.box('c')];
    assert.ok(ba.top < bb.top && bb.top < bc.top, `each sheet beneath peeks above the one over it: ${ba.top} < ${bb.top} < ${bc.top}`);
    assert.ok(bc.top - ba.top >= 24, 'the strips have room to read');
    assert.ok(ba.width < bb.width && bb.width < bc.width, `deeper is scaled further back: ${ba.width} < ${bb.width} < ${bc.width}`);
    assert.equal(ba.top, alone.top, 'the bottom sheet stands where it stood alone');
    assert.equal(await p.run(`getComputedStyle(c, '::backdrop').backgroundColor`), 'rgba(0, 0, 0, 0)', 'only the bottom sheet dims the board, so the strips aren’t dimmed');
    await p.tapAt(ba.left + ba.width / 2, ba.top + 4);
    assert.deepEqual((await p.state()).open, ['a'], 'the tap on a’s strip closed b and c');
    assert.deepEqual(await p.box('a'), alone, 'alone again, a has no strip and stands as before');
  } finally { await p.close(); }
});

test('at 390, a pull down closes the top sheet, then each sheet beneath once it is on top', { skip: !chromeInstalled }, async () => {
  const p = await load();
  try {
    await p.run('open(a)');
    await p.tap('#aTo');
    await p.tap('#bTo');
    await p.pull('c');
    assert.deepEqual((await p.state()).open, ['a', 'b'], 'the pull closed c only');
    await p.pull('b');
    assert.deepEqual((await p.state()).open, ['a']);
    await p.pull('a');
    assert.deepEqual((await p.state()).open, []);
  } finally { await p.close(); }
});

test('at 1280, a tap on the board leaves exactly one root sheet open, whatever was open before', { skip: !chromeInstalled }, async () => {
  const p = await load({ width: 1280, modal: false });
  const openDialogs = () => p.run(`[...document.querySelectorAll('dialog[open]')].map((d) => d.id)`);
  try {
    const cases = [
      ['nothing open', async () => {}],
      ['the owner’s sheet alone', () => p.run('open(a)')],
      ['an auto sheet alone', () => p.run('open(a, { auto: true })')],
      ['a stack of three', async () => { await p.run('open(a)'); await p.tap('#aTo'); await p.tap('#bTo'); }],
      ['a push over the owner’s sheet', async () => { await p.run('open(a)'); await p.run('BoardUI.opening("auto", () => open(c))'); }],
      ['the board’s own sheet', () => p.run('open(b)')],
    ];
    for (const [before, setUp] of cases) {
      await setUp();
      await p.tap('#board');
      assert.deepEqual((await p.state()).open, ['b'], `${before}: one root sheet in the stack`);
      assert.deepEqual(await openDialogs(), ['b'], `${before}: one sheet open on the page`);
      await p.escape();
      assert.deepEqual(await openDialogs(), [], `${before}: Escape closed it`);
    }
  } finally { await p.close(); }
});

// docs/adr/2026-11-25-0100-board-settings-and-repo-review-open-centred.md
test('from 900px a centred modal opens over the pane: the sheet beneath stays open and unstripped, the modal sits mid-screen', { skip: !chromeInstalled }, async () => {
  const p = await load({ width: 1280, modal: false });
  try {
    await p.run('open(a)');
    await p.run('BoardUI.openSheet(m, { centred: true })');
    assert.deepEqual((await p.state()).open, ['a', 'm'], 'a stayed open beneath');
    assert.equal(await p.run(`document.getElementById('a').hasAttribute('data-under')`), false, 'no peek strip on the pane sheet');
    assert.equal(await p.run(`document.getElementById('m').hasAttribute('data-over')`), false);
    const box = await p.box('m');
    assert.ok(box.width <= 680, `at most 680px wide, got ${box.width}`);
    assert.ok(Math.abs(box.left + box.width / 2 - 640) < 2, 'centred across the window');
    await p.escape();
    assert.deepEqual((await p.state()).open, ['a'], 'Escape closed the modal, the card stayed');
  } finally { await p.close(); }
});

test('on a phone a centred modal replaces the open sheet, as every sheet does', { skip: !chromeInstalled }, async () => {
  const p = await load({ width: 390 });
  try {
    await p.run('open(a)');
    await p.run('BoardUI.openSheet(m, { centred: true })');
    assert.deepEqual((await p.state()).open, ['m']);
  } finally { await p.close(); }
});
