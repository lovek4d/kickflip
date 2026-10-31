import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('automatic builder check-ins run without a browser, once per silent spell across a restart, and stop on done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-stalled-'));
  const siteDir = path.join(dir, 'site');
  const dataDir = path.join(siteDir, 'data');
  const clockFile = path.join(dir, 'clock');
  const setup = path.join(dir, 'setup.mjs');
  const stateFile = path.join(dataDir, 'builder-stalled.json');
  const agentFile = path.join(dataDir, 'agents', 'A1.json');
  let now = Date.parse('2026-10-30T10:00:00Z');
  let worker;
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'threads'));
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(dataDir, 'wave.json'), JSON.stringify({ items: [{ id: 'A1', status: 'building', title: 'One' }] }));
  const started = new Date(now - 29 * 60000).toISOString();
  fs.writeFileSync(agentFile, JSON.stringify({ kind: 'codex', started }));
  fs.writeFileSync(clockFile, String(now));
  fs.writeFileSync(setup, `
    import http from 'node:http';
    import fs from 'node:fs';
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [Date.now()])); }
      static now() { return Number(fs.readFileSync(process.env.BUILDER_TEST_CLOCK, 'utf8')); }
    };
    const interval = globalThis.setInterval;
    interval(() => {}, 1000);
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 20 : ms, ...args);
    http.Server.prototype.listen = function (port, host, ready) { ready(); return this; };
  `);
  const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  const stalledEvents = () => {
    const text = fs.existsSync(path.join(dataDir, 'events.jsonl')) ? fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8') : '';
    return text.trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'builder-stalled');
  };
  const until = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Builder check did not reach the expected state');
  };
  const start = async () => {
    worker = spawn(process.execPath, ['--import', setup, fileURLToPath(new URL('./server.mjs', import.meta.url)), siteDir], {
      env: { ...process.env, HOME: dir, BUILDER_TEST_CLOCK: clockFile },
    });
    let errors = '';
    worker.stderr.on('data', (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
  };
  const stop = async () => {
    if (!worker || worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill();
    await exited;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
  const advance = (minutes) => { now += minutes * 60000; fs.writeFileSync(clockFile, String(now)); };
  try {
    await start();
    await tick();
    assert.equal(stalledEvents().length, 0);
    advance(2);
    await until(() => read(stateFile, {})['t/A1'] === started);
    assert.deepEqual(stalledEvents().map((e) => e.data), [{ key: 't/A1', silentSince: started }]);
    await stop();
    await start();
    await tick();
    assert.equal(stalledEvents().length, 1);
    await stop();
    fs.rmSync(stateFile);
    await start();
    await until(() => read(stateFile, {})['t/A1'] === started);
    assert.equal(stalledEvents().length, 1);

    const progress = new Date(now).toISOString();
    fs.writeFileSync(path.join(dataDir, 'threads', 't__A1.jsonl'), JSON.stringify({ ts: progress, kind: 'status', text: 'Running tests' }) + '\n');
    await until(() => !read(stateFile, {})['t/A1']);
    advance(31);
    await until(() => read(stateFile, {})['t/A1'] === progress);
    assert.deepEqual(stalledEvents().map((e) => e.data), [{ key: 't/A1', silentSince: started }, { key: 't/A1', silentSince: progress }]);

    fs.writeFileSync(agentFile, JSON.stringify({ kind: 'codex', started, done: new Date(now).toISOString() }));
    await until(() => !read(stateFile, {})['t/A1']);
    advance(60);
    await tick();
    assert.equal(stalledEvents().length, 2);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
