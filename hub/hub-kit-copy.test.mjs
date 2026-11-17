import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise((r) => setImmediate(r));

// HubKit.live in a bare context: pages maps a url to its saved {savedAt, body}; answer() is the hub's reply.
function setup({ build = 'b1', pages = new Map(), answer }) {
  const status = { textContent: '' };
  const B = { $: (s) => (s === '#status' ? status : null), alive: () => true, on() {}, tick() {} };
  const context = {
    document: { hidden: false, documentElement: { dataset: { build } } },
    BoardUI: {
      statusLine: () => 'offline',
      pageCopy: {
        read: async (url) => pages.get(url) || null,
        save: async (url, body) => { pages.set(url, { savedAt: new Date().toISOString(), body }); },
      },
    },
    fetch: async () => answer(),
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'board/public/hub-kit.js'), 'utf8'), context);
  return { B, status, pages, HubKit: context.HubKit };
}
const ok = (data) => ({ ok: true, json: async () => data, headers: { get: () => null } });

test('the hub page paints its saved answer at once, then the live one, and saves each live answer with the build', async () => {
  const pages = new Map([['/_hub/api/hub', { savedAt: new Date(Date.now() - 5 * 60000).toISOString(), body: { build: 'b1', data: { n: 'saved' } } }]]);
  let release;
  const { B, status, HubKit } = setup({ pages, answer: () => new Promise((r) => { release = () => r(ok({ n: 'live' })); }) });
  const painted = [];
  HubKit.live(B, { url: () => '/_hub/api/hub', paint: (d) => painted.push(d) });
  await tick();
  assert.deepEqual(painted, [{ n: 'saved' }]);
  assert.equal(status.textContent, '5 min');
  release();
  await tick();
  assert.deepEqual(painted, [{ n: 'saved' }, { n: 'live' }]);
  assert.equal(status.textContent, 'now');
  assert.equal(JSON.stringify(pages.get('/_hub/api/hub').body), JSON.stringify({ build: 'b1', data: { n: 'live' } }));
});

test("a copy from another build isn't painted, and a failed first load paints nothing over a copy", async () => {
  const stale = new Map([['/u', { savedAt: new Date().toISOString(), body: { build: 'old', data: { n: 'old' } } }]]);
  const a = setup({ pages: stale, answer: () => new Promise(() => {}) });
  const seen = [];
  a.HubKit.live(a.B, { url: () => '/u', paint: (d) => seen.push(d) });
  await tick();
  assert.deepEqual(seen, []);

  const saved = new Map([['/u', { savedAt: new Date().toISOString(), body: { build: 'b1', data: { n: 'saved' } } }]]);
  const b = setup({ pages: saved, answer: async () => { throw new Error('down'); } });
  const got = [];
  const linked = [];
  b.HubKit.live(b.B, { url: () => '/u', paint: (d) => got.push(d), linked: (on) => linked.push(on) });
  await tick();
  await tick();
  assert.deepEqual(got, [{ n: 'saved' }]);
  assert.deepEqual(linked, [false]);
});

test('until the live answer is in, every button, checkbox and form submit is held except the reads', () => {
  const { B, HubKit } = setup({ answer: () => new Promise(() => {}) });
  const handlers = {};
  const toasts = [];
  B.root = {};
  B.toast = (m) => toasts.push(m);
  B.on = (_t, type, fn, capture) => { assert.equal(capture, true); handlers[type] = fn; };
  let waiting = true;
  HubKit.holdUntilLive(B, () => waiting);
  const tap = (type, target) => {
    const e = { type, target, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
    handlers[type](e);
    return e.stopped && e.prevented;
  };
  // An element is the selector parts it matches; closest(list) answers whether any part of the list is among them.
  const el = (...parts) => ({ closest: (list) => (list.split(', ').some((p) => parts.includes(p)) ? {} : null) });
  assert.equal(tap('click', el('button')), true, 'any button, whatever its hook');
  assert.equal(tap('click', el('input[type="checkbox"]')), true);
  assert.equal(tap('click', el('select')), true);
  assert.equal(tap('submit', el()), true, 'any form submit');
  assert.equal(toasts.length, 4);
  for (const read of ['.top', '#sheet', 'a', 'summary', '[data-settings-open]', '[data-permissions]', '[data-sheet-close]', '[data-settings-dismiss]', '#oledOn']) {
    assert.equal(tap('click', el('button', read)), false, read);
  }
  assert.equal(tap('submit', el('#sheet')), false, 'the New task box sends through the outbox');
  assert.equal(tap('click', el()), false, 'a tap on text is not a control');
  assert.equal(toasts.length, 4);
  waiting = false;
  assert.equal(tap('click', el('button')), false);
  assert.equal(tap('submit', el()), false);
});
