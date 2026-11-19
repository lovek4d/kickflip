// docs/adr/2026-11-16-0916-the-topmost-card-on-screen-stays-put-through-any-reorder-or-resize.md
// The real board scripts and stylesheet in headless Chrome, at phone and desktop widths, over a stub server: the topmost
// card on screen keeps its place within 1px through an image loading above it, a card above it collapsing and a card
// below it changing lane, and the page follows the only card on screen when it moves lanes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));

// The board's scripts in app.html's order, but the shell, which the page mounts the board in place of, and attach.js,
// whose uploads the page stubs.
const SCRIPTS = [...fs.readFileSync(path.join(pub, 'app.html'), 'utf8').matchAll(/<script src="\/_hub\/app\/([\w-]+\.js)"/g)]
  .map((m) => m[1]).filter((f) => fs.existsSync(path.join(pub, f)) && !['shell.js', 'attach.js'].includes(f));

// Runs in the page: mounts board-a over a stub server, plays each case and reports the anchored card's screen top
// before and after it.
function scenario() {
  const card = (id, lane) => ({ key: `w/${id}`, id, kind: 'work', lane, title: `Task ${id}`, ref: `T-${id}`, fromAsk: id, deps: [], manualSteps: [], othersAt: [] });
  const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const lanes = Object.fromEntries([['r0', 'review'], ['r1', 'review'], ['p0', 'progress'], ['p1', 'progress'], ...ids.map((id) => [id, 'todo'])]);
  const board = () => ({ title: 'A', generatedAt: '2026-10-30T10:00:00.000Z', items: Object.entries(lanes).map(([id, lane]) => card(id, lane)),
    files: [], needs: [], answers: [], owner: [], ownerTopics: [], doneArchived: 0 });
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = async (url) => {
    const p = new URL(url, location.href).pathname;
    if (p.endsWith('/api/board')) return json(board());
    if (p.endsWith('/api/thread')) return json([]);
    if (p.endsWith('/api/notes')) return json({ notes: {} });
    return json({});
  };
  window.ClaudeSite = { site: (root) => ({ root, url: (p) => new URL(`${root}/${p}`, location.origin).href, send: async () => ({}), events: async () => [], syncBadge() {}, watch: () => ({ stop() {} }) }) };
  window.BoardAttach = { files: () => [], busy: () => false, settled: async () => true, restore() {}, clear() {}, paint() {}, paintAll() {}, list: () => [], move() {}, saved: () => [], retryFailed() {}, onChange: () => () => {} };

  // Room below the board, so any card can scroll to the top of the screen.
  document.body.style.paddingBottom = '3000px';
  const root = document.body.appendChild(document.createElement('div'));
  root.className = 'view-board';
  root.innerHTML = BoardView.markup({ title: 'A' });
  let signal = null;
  BoardView.create(root, '/board-a', { signal: (fn) => { signal = fn; return () => {}; } }).mount();

  const el = (id) => root.querySelector(`details.item[data-key="w/${id}"]`);
  const top = (id) => el(id).getBoundingClientRect().top;
  const laneOf = (id) => el(id)?.closest('details.lane')?.dataset.lane;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  // A few frames: each runs the scroll events, then layout, then the ResizeObservers.
  const settle = async () => { for (let i = 0; i < 4; i++) await frame(); };
  // Waits frame by frame for ok, as the board draws what the stub server answered, then settles.
  const drawn = async (ok) => { for (let i = 0; i < 600 && !ok(); i++) await frame(); if (!ok()) throw new Error('never drawn'); await settle(); };
  // The topmost card on screen, as the board picks it: the first in page order with any part on screen.
  const topmost = () => [...root.querySelectorAll('details.item')].find((d) => { const r = d.getBoundingClientRect(); return r.bottom > Math.max(r.top, 0) && r.top < innerHeight; }).dataset.key.slice(2);
  // Scrolls card id to just past the top of the screen, as the owner would, so the card above, whose border it may
  // share, is off it, and lets the board take its anchor. → the topmost card on screen then, and its top.
  const scrollTo = async (id) => { scrollBy(0, top(id) + 2); await settle(); return [topmost(), top(topmost())]; };
  // Loads a 200px image into host and waits on its load event, never on time, as the stub server answers /tall.svg only
  // once asked. → the image and its height at the load, before the board's next draw could replace the card it is in.
  const grow = async (host) => {
    const img = new Image();
    const loaded = new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('the image failed to load')); });
    img.src = '/tall.svg';
    host.append(img);
    await loaded;
    await img.decode();
    return [img, img.getBoundingClientRect().height];
  };
  const out = {};
  const report = (name, id, before, extra = {}) => { out[name] = { id, before, after: top(id), ...extra }; };

  (async () => {
    await drawn(() => el('t39'));
    // A 200px image loads in the card just above the topmost one.
    let [id, before] = await scrollTo('t20');
    const [, grew] = await grow(el('t19').querySelector('summary'));
    await settle();
    report('image', id, before, { grew });

    // The card just above the topmost one, open, collapses.
    const above = el('t24');
    above.open = true;
    await settle();
    [id, before] = await scrollTo('t25');
    const tall = above.getBoundingClientRect().height;
    above.open = false;
    await settle();
    report('collapse', id, before, { shrank: tall - above.getBoundingClientRect().height });

    // The card just below the topmost one moves to In Review, above it on the page.
    [id, before] = await scrollTo('t30');
    lanes.t31 = 'review';
    signal();
    await drawn(() => laneOf('t31') === 'review');
    report('lane', id, before, { lane: laneOf('t31') });

    // A text box in the card below the topmost one takes focus, then an image loads in the card between them: the box
    // keeps its place, not the topmost card.
    [id, before] = await scrollTo('t10');
    const box = el('t12').querySelector('summary').appendChild(document.createElement('textarea'));
    box.focus({ preventScroll: true });
    // A page without the window's focus, as in headless Chrome, sends no focusin for it.
    if (!document.hasFocus()) box.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await settle();
    const boxBefore = box.getBoundingClientRect().top;
    const [, grew2] = await grow(el('t11').querySelector('summary'));
    await settle();
    out.field = { grew: grew2, before: boxBefore, after: box.getBoundingClientRect().top };
    box.remove();
    await settle();

    // A card with its reply box focused moves to In Review. The box is blurred, as a phone does when its keyboard closes,
    // and the page resizes under it: the box keeps its place, not the topmost card on screen.
    const open = el('t35');
    open.open = true;
    await drawn(() => open.querySelector('form[data-reply] textarea'));
    await scrollTo('t35');
    const reply = open.querySelector('form[data-reply] textarea');
    reply.focus({ preventScroll: true });
    if (!document.hasFocus()) reply.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await settle();
    const boxWas = reply.getBoundingClientRect().top;
    lanes.t35 = 'review';
    signal();
    await drawn(() => laneOf('t35') === 'review');
    const boxNow = () => el('t35').querySelector('form[data-reply] textarea');
    const placed = boxNow().getBoundingClientRect().top;
    boxNow().blur();
    boxNow().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
    const [img3, grew3] = await grow(el('t35').querySelector('summary'));
    await settle();
    out.blurred = { was: boxWas, grew: grew3, before: placed, after: boxNow().getBoundingClientRect().top };
    img3.remove();
    open.open = false;
    await settle();

    // With only one card on screen, that card moves to In Review: the page follows it.
    document.head.append(Object.assign(document.createElement('style'), { textContent: 'details.item { margin-bottom: 1200px; }' }));
    await settle();
    [id, before] = await scrollTo('t35');
    const shown = [...root.querySelectorAll('details.item')].filter((d) => { const r = d.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).length;
    lanes[id] = 'review';
    signal();
    await drawn(() => laneOf(id) === 'review');
    report('follow', id, before, { shown, lane: laneOf(id) });
  })().catch((e) => { out.error = String(e?.stack || e); }).finally(() => {
    const probe = document.createElement('pre');
    probe.id = 'probe';
    probe.textContent = JSON.stringify(out);
    document.body.append(probe);
  });
}

// A script that throws reports at once, rather than leaving the probe to time out.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/app/style.css">
<script>addEventListener('error', (e) => { if (!document.getElementById('probe')) document.documentElement.append(Object.assign(document.createElement('pre'), { id: 'probe', textContent: JSON.stringify({ error: e.message + ' at ' + e.filename + ':' + e.lineno }) })); });</script>
</head><body>
${SCRIPTS.map((f) => `<script src="/app/${f}"></script>`).join('\n')}
<script>(${scenario})()</script></body></html>`;

// Serves the page, board/public under /app/, and a 200px-tall image, which the page asks for only once the board has
// taken its anchor.
async function serve(run) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/page.html') return res.setHeader('content-type', 'text/html').end(PAGE);
    if (p === '/tall.svg') return res.setHeader('content-type', 'image/svg+xml').end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="200"></svg>');
    const file = path.join(pub, p.replace(/^\/app\//, ''));
    if (!p.startsWith('/app/') || !file.startsWith(pub) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise((ok) => server.listen(0, ok));
  try { return await run(`http://localhost:${server.address().port}/page.html`); } finally { server.close(); }
}

for (const width of [390, 1280]) {
  test(`at ${width}px the topmost card on screen holds within 1px through an image loading and a card collapsing above it and a lane change below it, and the page follows the only card on screen as it moves`, { skip: !chromeInstalled }, async () => {
    const got = await serve((url) => chrome.probe(url, width));
    assert.equal(got.error, undefined, got.error);
    const held = (name, id) => {
      assert.equal(got[name].id, id, `${name}: the topmost card on screen`);
      assert.ok(Math.abs(got[name].after - got[name].before) <= 1, `${name}: ${id} moved from ${got[name].before} to ${got[name].after}`);
    };
    assert.equal(got.image.grew, 200, 'the image loaded at its height');
    held('image', 't20');
    assert.ok(got.collapse.shrank > 0, 'the card above collapsed');
    held('collapse', 't25');
    assert.equal(got.lane.lane, 'review', 'the card below moved to In Review');
    held('lane', 't30');
    assert.deepEqual([got.follow.shown, got.follow.lane], [1, 'review'], 'one card on screen, moved to In Review');
    held('follow', 't35');
    assert.ok(Math.abs(got.blurred.before - got.blurred.was) <= 1, `the box moved with its card from ${got.blurred.was} to ${got.blurred.before}`);
    assert.equal(got.blurred.grew, 200, 'the image loaded at its height');
    assert.ok(Math.abs(got.blurred.after - got.blurred.before) <= 1, `the blurred box moved from ${got.blurred.before} to ${got.blurred.after}`);
    assert.equal(got.field.grew, 200, 'the image loaded at its height');
    assert.ok(Math.abs(got.field.after - got.field.before) <= 1, `the focused box moved from ${got.field.before} to ${got.field.after}`);
  });
}
