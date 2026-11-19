// The hub page's Sign in a device dialog (board/public/view-hub.js) and Hub settings › Devices (view-hub-settings.js)
// (docs/adr/2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from '../board/mini-dom.mjs';
import { DEFAULTS, hold, flushAt } from './schedule.mjs';
import { settingsView } from './views.mjs';

const load = (context, files) => { for (const file of files) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context); };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
// A page whose B.on and each element's own events share one listener list, so a dialog's close() reaches its handler.
function page() {
  const document = {};
  const listeners = [];
  const { Element } = miniDom(class {
    addEventListener(type, fn) { listeners.push({ target: this, type, fn }); }
    dispatchEvent(ev) { for (const l of listeners.filter((l) => l.target === this && l.type === ev.type)) l.fn(ev); }
  }, document);
  const store = new Map();
  const B = (root) => ({ root, site: { root: '/_hub' }, store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
    $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) });
  const click = (target) => listeners.filter((l) => l.type === 'click' && l.target?.contains?.(target)).forEach((l) => l.fn({ target }));
  return { document, listeners, Element, B, click };
}
const BOARD_UI = { BUSY: ' disabled aria-busy="true"', onBackdrop: (ev, backdrop) => ev.target === backdrop, outsideBox: () => true,
  swipeToDismiss: () => () => {}, openSheet: (sheet) => sheet.showModal(), newStrip: () => '' };

test('Show PIN opens Sign in a device on the PIN and the address, drains to orange, renews at 0 after voiding the old PIN, and voids the live one on close or pagehide', async () => {
  const { listeners, Element, B, click } = page();
  const root = new Element('div');
  let now = 1_000_000;
  let tick = null;
  const calls = [];
  const pins = ['48291735', '90164428', '11112222'];
  let held = null;
  const context = vm.createContext({
    navigator: {}, localStorage: { getItem: () => null },
    Date: class extends Date { static now() { return now; } },
    setInterval: (fn) => { tick = fn; return 7; }, clearInterval: (id) => { if (id === 7) tick = null; },
    BoardNewTask: { markup: () => '', wire() {} }, BoardAttach: { onChange: () => () => {}, list: () => [] },
    BoardDrafts: { create: () => ({ take() {} }) }, BoardView: { page: (el, site, run) => run(B(el)) },
    HubSettings: { markup: () => '<button type="button" class="btn" data-pin-open>Show PIN</button>', create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { ...BOARD_UI, header: ({ navAfter }) => `<header class="top"><nav class="nav">${navAfter}</nav></header>` },
    PromptAnswers: { wire: () => ({}) },
    HubKit: { holdUntilLive() {}, forms: () => ({}), live: () => () => {} },
    fetch: async (url, opts = {}) => {
      calls.push([opts.method || 'GET', url, Boolean(opts.keepalive)]);
      if (url === '/_hub/pins' && opts.method === 'POST') {
        await held;
        return { ok: true, json: async () => ({ pin: pins.shift(), until: now + 60_000, address: 'https://hub.tail1234.ts.net' }) };
      }
      return { ok: true, json: async () => ({ voided: true }) };
    },
  });
  load(context, ['ui-hub.js', 'view-hub.js']);
  root.innerHTML = context.AppViews.hub.markup();
  context.AppViews.hub.create(root, '/_hub', {});
  const dialog = root.querySelector('#pinModal');
  assert.equal(root.querySelector('header [data-pin-open]'), null, 'the header holds no Sign in a device; Devices’ Show PIN opens it');
  const open = root.querySelector('[data-pin-open]');
  assert.ok(dialog.classList.contains('hub-modal') && dialog.classList.contains('settings-modal'), 'opens as the hub’s other modals do');

  click(open);
  await settle();
  assert.equal(dialog.open, true);
  assert.equal(root.querySelector('#pinTitle').textContent, 'Sign in a device');
  assert.deepEqual(root.querySelectorAll('.pin-say').map((p) => p.textContent), ['On the new device, open', 'then type this PIN']);
  assert.equal(root.querySelector('.pin-addr').textContent, 'https://hub.tail1234.ts.net');
  assert.equal(root.querySelector('.pin-digits').textContent, '4829 1735');
  assert.deepEqual(root.querySelectorAll('.pin-count span').map((s) => s.textContent), ['PIN expires in 60 s', 'new PIN follows']);
  assert.equal(root.querySelector('.pin-drain').classList.contains('low'), false);
  assert.match(root.querySelector('.pin-drain i').getAttribute('style'), /width:100%/);
  assert.equal(root.querySelector('.pin-content .note').textContent, 'Closing this dialog voids the PIN.');

  now += 30_000;
  tick();
  assert.equal(root.querySelector('.pin-count span').textContent, 'PIN expires in 30 s');
  assert.match(root.querySelector('.pin-drain i').getAttribute('style'), /width:50%/);
  now += 20_000;
  tick();
  assert.equal(root.querySelector('.pin-count span').textContent, 'PIN expires in 10 s');
  assert.equal(root.querySelector('.pin-drain').classList.contains('low'), true, 'orange from 10 s left');

  calls.length = 0;
  now += 10_000;
  tick();
  await settle();
  assert.deepEqual(calls, [['DELETE', '/_hub/pins/48291735', false], ['POST', '/_hub/pins', false]], 'the old PIN is voided before a new one is asked for');
  assert.equal(root.querySelector('.pin-digits').textContent, '9016 4428');
  assert.equal(root.querySelector('.pin-digits').classList.contains('fresh'), true);
  assert.equal(root.querySelector('.pin-count span').textContent, 'PIN expires in 60 s');
  assert.equal(root.querySelector('.pin-drain').classList.contains('low'), false);
  assert.equal(root.querySelector('.pin-content .note').textContent, 'Fresh PIN: the one before it no longer works.');

  calls.length = 0;
  listeners.find((l) => l.type === 'pagehide').fn({});
  assert.deepEqual(calls, [['DELETE', '/_hub/pins/90164428', true]], 'the page going away voids the live PIN with keepalive');

  calls.length = 0;
  click(root.querySelector('[data-pin-dismiss]'));
  await settle();
  assert.equal(dialog.open, false);
  assert.deepEqual(calls, [['DELETE', '/_hub/pins/90164428', false]]);
  assert.equal(tick, null, 'the countdown stops');

  // A PIN still on its way when the dialog closes is voided as it lands.
  let release;
  held = new Promise((r) => { release = r; });
  click(open);
  dialog.close();
  calls.length = 0;
  release();
  await settle();
  assert.deepEqual(calls, [['DELETE', '/_hub/pins/11112222', false]]);
  assert.equal(root.querySelector('.pin-digits'), null);
});

const NOW = new Date(2026, 10, 18, 10);
const before = (ms) => new Date(NOW - ms).toISOString();
const AGES = { [before(2 * 86_400_000)]: '2d ago', [before(5 * 3_600_000)]: '5h ago', [before(3_600_000)]: '1h ago', [before(7_200_000)]: '2h ago', [NOW.toISOString()]: 'just now' };
// Hub settings opened on Devices, GET /_hub/devices answering state's devices and blocked, and a DELETE answering
// state.status, dropping the row it names while that's 200.
async function devicesSheet(state) {
  const { Element, B, click } = page();
  const root = new Element('div');
  const calls = [];
  let live;
  const context = vm.createContext({
    window: {}, history: { replaceState() {}, state: null },
    BoardDialogs: { fitSheet: () => () => {} }, AppRouter: { urlOf: () => '/_hub/', viewOf: () => ({}) },
    BoardUI: { ...BOARD_UI, ago: (iso) => AGES[iso] },
    BoardView: { page: (el, site, run) => { const b = B(el); run(b); return b; } },
    HubKit: { durationPicker: () => '', durationPickers: () => ({ painted() {} }), forms: () => ({ busy: () => false }),
      device: () => ({ state: () => null, ready: Promise.resolve(), busy: () => false }), live: (b, opts) => { live = opts; return () => {}; } },
    fetch: async (url, opts = {}) => {
      calls.push([opts.method || 'GET', url]);
      if (url === '/_hub/devices') return { ok: true, json: async () => ({ devices: state.devices, blocked: state.blocked }) };
      if (opts.method === 'DELETE') {
        if (state.status === 200) {
          state.devices = state.devices.filter((d) => `/_hub/devices/${d.id}` !== url);
          state.blocked = state.blocked.filter((b) => `/_hub/blocked/${encodeURIComponent(b.key)}` !== url);
        }
        return { ok: state.status === 200, status: state.status, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  load(context, ['ui-hub.js', 'view-hub-settings.js']);
  root.innerHTML = context.HubSettings.markup();
  context.HubSettings.create(root, '/_hub', { view: { hash: '#devices' } });
  live.paint(settingsView({ now: NOW, st: { settings: DEFAULTS, hold: hold(NOW, DEFAULTS), count: 0, nextFlushAt: flushAt(NOW, DEFAULTS) } }));
  await settle();
  return { root, calls, click };
}

test('Hub settings › Devices lists each device with its ages and this device tagged, and Remove asks under its row before it signs the device out', async () => {
  const state = { status: 200, blocked: [], devices: [
    { id: 'd-mac', name: 'macbook-air', ip: '100.64.0.12', at: before(2 * 86_400_000), seen: NOW.toISOString(), me: true },
    { id: 'd-pixel', name: 'pixel-8', ip: '100.64.0.31', at: before(5 * 3_600_000), seen: before(3_600_000), me: false },
  ] };
  const { root, calls, click } = await devicesSheet(state);

  assert.equal(root.querySelector('#devices .title').textContent, 'Devices');
  assert.equal(root.querySelector('[data-summary="devices"]').textContent, '2 signed in');
  assert.equal(root.querySelector('#hubSettingsModal').open, true);
  assert.equal(root.querySelector('#hubSettingsTitle').textContent, 'Devices');
  const rows = () => root.querySelectorAll('.setting-content .device-list > .row');
  assert.deepEqual(rows().map((r) => r.querySelector('.title').textContent), ['macbook-airThis device', 'pixel-8']);
  assert.deepEqual(rows().map((r) => r.querySelector('.sub').textContent), ['signed in 2d ago · seen just now', 'signed in 5h ago · seen 1h ago']);
  const mine = root.querySelector('[data-device-remove="d-mac"]');
  assert.deepEqual([mine.disabled, mine.classList.contains('danger')], [true, false], 'this device can’t remove itself');
  assert.equal(root.querySelector('[data-device-remove="d-pixel"]').disabled, false);

  click(root.querySelector('[data-device-remove="d-pixel"]'));
  const ask = root.querySelector('.device-confirm');
  assert.equal(ask.querySelector('span').textContent, 'Remove pixel-8? It signs out on its next request.');
  assert.deepEqual(ask.querySelectorAll('button').map((b) => b.textContent), ['Cancel', 'Remove']);
  assert.equal(calls.some(([method]) => method === 'DELETE'), false, 'nothing is removed before the confirm');
  click(ask.querySelector('[data-device-cancel]'));
  assert.equal(root.querySelector('.device-confirm'), null);

  // A refusal says so and keeps the row.
  state.status = 500;
  click(root.querySelector('[data-device-remove="d-pixel"]'));
  click(root.querySelector('[data-device-confirm="d-pixel"]'));
  await settle();
  assert.equal(root.querySelector('.hs-flash').textContent, 'Could not remove pixel-8. Is the host awake?');
  assert.equal(rows().length, 2);

  state.status = 200;
  calls.length = 0;
  click(root.querySelector('[data-device-remove="d-pixel"]'));
  click(root.querySelector('[data-device-confirm="d-pixel"]'));
  assert.equal(root.querySelector('[data-device-remove="d-pixel"]').textContent, 'Removing…');
  await settle();
  assert.deepEqual(calls, [['DELETE', '/_hub/devices/d-pixel'], ['GET', '/_hub/devices']]);
  assert.deepEqual(rows().map((r) => r.querySelector('.title').textContent), ['macbook-airThis device']);
  assert.equal(root.querySelector('[data-summary="devices"]').textContent, '1 signed in');
  assert.equal(root.querySelector('.hs-flash').textContent, '');
});

test('Devices lists the blocked devices under the signed-in ones with Unblock, then a Sign in a device row whose Show PIN opens the PIN', async () => {
  const state = { status: 200,
    devices: [{ id: 'd-mac', name: 'macbook-air', ip: '100.64.0.12', at: before(2 * 86_400_000), seen: NOW.toISOString(), me: true }],
    blocked: [{ key: 'node:iphone-guest', name: 'iphone-guest', ip: '100.64.0.9', at: before(7_200_000) }, { key: 'ip:100.88.14.9', name: '', ip: '100.88.14.9', at: before(5 * 3_600_000) }] };
  const { root, calls, click } = await devicesSheet(state);
  assert.equal(root.querySelector('[data-summary="devices"]').textContent, '1 signed in · 2 blocked');
  const content = root.querySelector('.setting-content');
  assert.deepEqual(content.querySelectorAll('h2.label').map((h) => h.textContent), ['Blocked devices', 'Sign in a device']);
  const blockedRows = () => content.querySelectorAll('.blocked-list > .row');
  assert.deepEqual(blockedRows().map((r) => [r.querySelector('.title').textContent, r.querySelector('.sub').textContent]),
    [['iphone-guest', '100.64.0.9 · last tried 2h ago'], ['100.88.14.9', 'last tried 5h ago']], 'a client with no name reads its address');
  assert.deepEqual(blockedRows().map((r) => r.querySelector('button').textContent), ['Unblock', 'Unblock']);
  const pinRow = content.querySelector('.pin-row > .row');
  assert.deepEqual([pinRow.querySelector('.title').textContent, pinRow.querySelector('.sub').textContent], ['Sign in a device', 'Show a PIN to type on the new device']);
  assert.equal(pinRow.querySelector('[data-pin-open]').textContent, 'Show PIN', 'view-hub.js opens its PIN dialog from it, over this modal');

  // A refusal says so and keeps the row.
  state.status = 500;
  click(root.querySelector('[data-device-unblock="node:iphone-guest"]'));
  assert.equal(root.querySelector('[data-device-unblock="node:iphone-guest"]').textContent, 'Unblocking…');
  await settle();
  assert.equal(root.querySelector('.hs-flash').textContent, 'Could not unblock iphone-guest. Is the host awake?');
  assert.equal(blockedRows().length, 2);

  state.status = 200;
  calls.length = 0;
  click(root.querySelector('[data-device-unblock="node:iphone-guest"]'));
  await settle();
  assert.deepEqual(calls, [['DELETE', '/_hub/blocked/node%3Aiphone-guest'], ['GET', '/_hub/devices']]);
  assert.equal(blockedRows().length, 1);
  assert.equal(root.querySelector('.hs-flash').textContent, '');

  click(root.querySelector('[data-device-unblock="ip:100.88.14.9"]'));
  await settle();
  assert.equal(content.querySelector('.blocked-list'), null);
  assert.equal(content.querySelector('.blocked-none').textContent, 'No blocked devices. A device that gets its PIN wrong three times lands here.');
  assert.equal(root.querySelector('[data-summary="devices"]').textContent, '1 signed in');
});
