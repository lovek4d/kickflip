import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startBoard } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md
// docs/adr/2026-11-13-2210-the-board-server-starts-in-process-and-tests-await-settled.md
// Each board build reads the wave file once, so reads of it count the builds. run(ctx) gets the in-process server, its
// site, how many builds so far, and a page on its stream: each change signal pushes the page's reload of the board onto
// ctx.loads.
async function withBoard(t, run) {
  const site = fs.mkdtempSync(path.join(home, 'site-'));
  const wave = path.join(site, 'data', 'items.json');
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.mkdirSync(path.join(site, 'data', 'replies'));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(wave, JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress' }, { id: 'A2', title: 'Two' }] }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  let reads = 0;
  const read = fsp.readFile;
  t.mock.method(fsp, 'readFile', function (file, ...rest) {
    if (String(file) === wave) reads++;
    return read.call(this, file, ...rest);
  });
  const b = await startBoard(t, { site });
  await b.settled();
  const ctx = { ...b, site, count: () => reads, loads: [] };
  const page = Object.assign(new EventEmitter(), { method: 'GET', url: '/api/stream', headers: {} });
  b.server.emit('request', page, {
    writeHead() { return this; },
    write(text) { if (text.includes('event: change')) ctx.loads.push(fetch(`${b.base}/api/board`).then((r) => r.json())); },
  });
  await run(ctx);
}

test('each change signal builds the board once for every check and the page that reloads on it', (t) => withBoard(t, async (ctx) => {
  const before = ctx.count();
  const thread = path.join(ctx.site, 'data', 'threads', 't__A1.jsonl');
  fs.appendFileSync(thread, JSON.stringify({ ts: new Date().toISOString(), who: 'claude', kind: 'status', text: 'building: a line' }) + '\n');
  ctx.changed(thread);
  await ctx.settled();
  await Promise.all(ctx.loads);
  await ctx.settled();
  assert.equal(ctx.loads.length, 1);
  assert.equal(ctx.count() - before, 1);
}));

// docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md
test("a tap builds the board once: its answer's build has read the tap's own line, so the change signal that follows reuses it, and writing data/sync.json sends no signal", (t) => withBoard(t, async (ctx) => {
  const before = ctx.count();
  const { board } = await fetch(`${ctx.base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ping', title: 'A tap' }) }).then((r) => r.json());
  ctx.changed(path.join(ctx.site, 'data', 'events.jsonl'));
  await ctx.settled();
  await Promise.all(ctx.loads);
  await ctx.settled();
  assert.equal(ctx.loads.length, 1);
  assert.equal(ctx.count() - before, 1);
  ctx.changed(path.join(ctx.site, 'data', 'sync.json'));
  await ctx.settled();
  assert.equal(ctx.loads.length, 1, 'data/sync.json sends no signal');
  const again = await fetch(`${ctx.base}/api/board`, { headers: { 'if-none-match': `"${board.version}"` } });
  assert.equal(again.status, 304);
}));
