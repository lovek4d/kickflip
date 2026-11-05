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
// Each board build reads the wave file once, so the server's reads of it count its builds.
test('each change signal builds the board once for every check and the page that reloads on it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-builds-'));
  const site = path.join(dir, 'site');
  const wave = path.join(site, 'data', 'wave.json');
  const reads = path.join(dir, 'reads');
  const setup = path.join(dir, 'setup.mjs');
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(wave, JSON.stringify({ items: [{ id: 'A1', title: 'One', status: 'building' }, { id: 'A2', title: 'Two' }] }));
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
  // Resolves once the server has read nothing for 800 ms, so every check it started has finished.
  const settled = async () => {
    for (let last = -1; last !== count();) { last = count(); await new Promise((resolve) => setTimeout(resolve, 800)); }
  };
  const [port] = await freePorts();
  const worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), site], { env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: dir, PORT: String(port) } });
  let page;
  try {
    await boardListening(worker);
    await until(() => fs.existsSync(path.join(site, 'data', 'action-pushes.json')), 'the first Action needed check');
    let signals = 0;
    let loads = 0;
    const load = () => fetch(`http://127.0.0.1:${port}/api/board`).then((r) => r.json()).then(() => { loads++; });
    await new Promise((resolve) => {
      page = http.get(`http://127.0.0.1:${port}/api/stream`, (res) => { res.on('data', (c) => { if (String(c).includes('event: change')) { signals++; load(); } }); resolve(); });
    });
    await settled();
    signals = 0;
    loads = 0;
    const before = count();
    fs.appendFileSync(path.join(site, 'data', 'threads', 't__A1.jsonl'), JSON.stringify({ ts: new Date().toISOString(), who: 'claude', kind: 'status', text: 'building: a line' }) + '\n');
    await until(() => signals > 0 && loads === signals, 'the change signal and the page load');
    await settled();
    assert.equal(loads, signals);
    assert.equal(count() - before, signals);
  } finally {
    page?.destroy();
    worker.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
