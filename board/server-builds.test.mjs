import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until, boardListening } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md
// Each board build reads the wave file once, so the server's reads of it count its builds. run(ctx) gets the server's
// port, the site, how many builds so far, settled(), and a page holding the stream that reloads on each signal, its
// signals and loads counted since the last settled().
async function withBoard(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-builds-'));
  const site = path.join(dir, 'site');
  const wave = path.join(site, 'data', 'wave.json');
  const reads = path.join(dir, 'reads');
  const setup = path.join(dir, 'setup.mjs');
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.mkdirSync(path.join(site, 'data', 'replies'));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(wave, JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress' }, { id: 'A2', title: 'Two' }] }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  fs.writeFileSync(setup, `
    import fs from 'node:fs';
    const read = fs.promises.readFile;
    fs.promises.readFile = function (file, ...rest) {
      if (String(file) === ${JSON.stringify(wave)}) fs.appendFileSync(${JSON.stringify(reads)}, '.');
      return read.call(this, file, ...rest);
    };
  `);
  const count = () => (fs.existsSync(reads) ? fs.readFileSync(reads, 'utf8').length : 0);
  const [port] = await freePorts();
  const worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), site], { env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: dir, PORT: String(port) } });
  let page;
  try {
    await boardListening(worker);
    await until(() => fs.existsSync(path.join(site, 'data', 'action-pushes.json')), 'the first Action needed check');
    const ctx = { port, site, count, signals: 0, loads: 0 };
    const load = () => fetch(`http://127.0.0.1:${port}/api/board`).then((r) => r.json()).then(() => { ctx.loads++; });
    // Resolves once the server has read nothing for 800 ms, so every check it started has finished.
    ctx.settled = async () => {
      for (let last = -1; last !== count();) { last = count(); await new Promise((resolve) => setTimeout(resolve, 800)); }
    };
    await new Promise((resolve) => {
      page = http.get(`http://127.0.0.1:${port}/api/stream`, (res) => { res.on('data', (c) => { if (String(c).includes('event: change')) { ctx.signals++; load(); } }); resolve(); });
    });
    await ctx.settled();
    ctx.signals = 0;
    ctx.loads = 0;
    await run(ctx);
  } finally {
    page?.destroy();
    worker.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('each change signal builds the board once for every check and the page that reloads on it', () => withBoard(async (ctx) => {
  const before = ctx.count();
  fs.appendFileSync(path.join(ctx.site, 'data', 'threads', 't__A1.jsonl'), JSON.stringify({ ts: new Date().toISOString(), who: 'claude', kind: 'status', text: 'building: a line' }) + '\n');
  await until(() => ctx.signals > 0 && ctx.loads === ctx.signals, 'the change signal and the page load');
  await ctx.settled();
  assert.equal(ctx.loads, ctx.signals);
  assert.equal(ctx.count() - before, ctx.signals);
}));

// docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md
test("a tap builds the board once: its answer's build has read the tap's own line, so the change signal that follows reuses it, and writing data/sync.json sends no signal", () => withBoard(async (ctx) => {
  const before = ctx.count();
  const r = await fetch(`http://127.0.0.1:${ctx.port}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ping', title: 'A tap' }) });
  const { board } = await r.json();
  await until(() => ctx.signals > 0 && ctx.loads === ctx.signals, 'the change signal and the page load');
  await ctx.settled();
  assert.equal(ctx.signals, 1);
  assert.equal(ctx.count() - before, 1);
  const again = await fetch(`http://127.0.0.1:${ctx.port}/api/board`, { headers: { 'if-none-match': `"${board.version}"` } });
  assert.equal(again.status, 304);
}));
