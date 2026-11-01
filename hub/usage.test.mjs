import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageReader } from './usage.mjs';

const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
process.env.HOME = home;
after(() => { process.env.HOME = originalHome; fs.rmSync(home, { recursive: true, force: true }); });
const NOW = Date.parse('2026-11-01T21:00:00Z');
const HOUR = 3600_000;
const iso = (time) => new Date(time).toISOString();
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(home, 'case-'));
  let time = NOW;
  const file = (...p) => path.join(dir, ...p);
  const claude = (over = {}) => write(file('.claude', 'kickflip', 'usage.json'), { claude: {
    at: iso(NOW), five_hour: { used_percentage: 42, resets_at: iso(NOW + HOUR) },
    seven_day: { used_percentage: 75, resets_at: iso(NOW + 24 * HOUR) }, ...over,
  }, codex: { five_hour: { used_percentage: 99 } } });
  const log = (name, { primary = 20, secondary = 30, reset = NOW + HOUR, mtime = NOW, text = '', payload = true } = {}) => {
    const limits = { rate_limits: { primary: { used_percent: primary, resets_at: reset / 1000, window_minutes: 300 }, secondary: { used_percent: secondary, resets_at: (NOW + 24 * HOUR) / 1000, window_minutes: 10080 } } };
    const target = file('.codex', 'sessions', '2026', '11', '01', `rollout-${name}.jsonl`);
    write(target, JSON.stringify(payload ? { payload: limits } : limits) + '\n' + text);
    fs.utimesSync(target, new Date(mtime), new Date(mtime));
    return target;
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file, claude, log, login: () => write(file('.codex', 'auth.json'), {}),
    read: usageReader({ home: dir, now: () => time }), advance: (ms) => { time += ms; } };
}

test('missing files hide Claude and Codex; a logged-in Codex without rollouts has no reading', (t) => {
  assert.deepEqual(usageReader({ now: () => NOW })({ codexShare: 'auto' }), { claude: null, codex: null });
  const f = fixture(t);
  f.login();
  assert.deepEqual(f.read({ codexShare: 'always' }), { claude: null, codex: { at: null, five_hour: null, seven_day: null } });
});

test('Claude comes only from usage.json, with window reset times and reading time', (t) => {
  const f = fixture(t);
  f.claude();
  const r = f.read();
  assert.deepEqual(r.claude, { at: iso(NOW), five_hour: { used_percentage: 42, resets_at: iso(NOW + HOUR), state: 'live' }, seven_day: { used_percentage: 75, resets_at: iso(NOW + 24 * HOUR), state: 'live' } });
  assert.equal(r.codex, null);
  f.claude({ five_hour: { used_percentage: 50, resets_at: iso(NOW + HOUR) } });
  assert.equal(f.read().claude.five_hour.used_percentage, 50);
});

test('a reset window reads 0%, independently of the weekly window', (t) => {
  const f = fixture(t);
  f.claude({ five_hour: { used_percentage: 95, resets_at: iso(NOW) } });
  assert.deepEqual(f.read().claude.five_hour, { used_percentage: 0, resets_at: iso(NOW), state: 'reset' });
  assert.equal(f.read().claude.seven_day.state, 'live');
  f.claude({ seven_day: { used_percentage: 99, resets_at: iso(NOW - 1) } });
  assert.equal(f.read().claude.seven_day.used_percentage, 0);
});

test('a reading older than its window is stale, including when its recorded reset passed', (t) => {
  const f = fixture(t);
  f.claude({ at: iso(NOW - 6 * HOUR), five_hour: { used_percentage: 95, resets_at: iso(NOW - HOUR) } });
  assert.equal(f.read().claude.five_hour.state, 'stale');
  assert.equal(f.read().claude.five_hour.used_percentage, 95);
  assert.equal(f.read().claude.seven_day.state, 'live');
  f.claude({ at: iso(NOW - 8 * 24 * HOUR) });
  assert.equal(f.read().claude.seven_day.state, 'stale');
});

test('Codex requires a login and share on, even when a cached reading exists', (t) => {
  const f = fixture(t);
  f.log('a');
  assert.equal(f.read({ codexShare: 'auto' }).codex, null);
  f.login();
  assert.equal(f.read().codex, null);
  assert.equal(f.read({ codexShare: 'off' }).codex, null);
  assert.equal(f.read({ codexShare: 'auto' }).codex.five_hour.used_percentage, 20);
  assert.equal(f.read({ codexShare: 'always' }).codex.five_hour.used_percentage, 20);
  fs.unlinkSync(f.file('.codex', 'auth.json'));
  assert.equal(f.read({ codexShare: 'auto' }).codex, null);
});

test('Codex takes the highest readings in the newest window, allowing three minutes of reset drift', (t) => {
  const f = fixture(t);
  f.login();
  f.log('old-window', { primary: 99, secondary: 100, reset: NOW - HOUR });
  f.log('high-primary', { primary: 42, secondary: 10, mtime: NOW - 1000 });
  f.log('high-week', { primary: 30, secondary: 57, reset: NOW + HOUR - 180_000 });
  f.log('outside-drift', { primary: 98, secondary: 99, reset: NOW + HOUR - 181_000 });
  const r = f.read({ codexShare: 'auto' }).codex;
  assert.deepEqual(r, { at: iso(NOW), five_hour: { used_percentage: 42, resets_at: iso(NOW + HOUR), state: 'live' }, seven_day: { used_percentage: 57, resets_at: iso(NOW + 24 * HOUR), state: 'live' } });
});

test('Codex reads only the six newest rollouts by mtime, and the last limits in each', (t) => {
  const f = fixture(t);
  f.login();
  f.log('excluded', { primary: 99, reset: NOW + 2 * HOUR, mtime: NOW - 10_000 });
  for (let i = 0; i < 6; i++) f.log(`new-${i}`, { primary: 10 + i, mtime: NOW - i });
  const file = f.log('last', { primary: 100, mtime: NOW + 1 });
  fs.appendFileSync(file, JSON.stringify({ rate_limits: { primary: { used_percent: 22, resets_at: (NOW + HOUR) / 1000 } } }) + '\n{"rate_limits":\n');
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
  const r = f.read({ codexShare: 'auto' }).codex;
  assert.equal(r.five_hour.used_percentage, 22);
  assert.equal(r.seven_day.used_percentage, 30);
});

test('Codex scans cache briefly, while window reset state updates on every read', (t) => {
  const f = fixture(t);
  f.login();
  f.log('a', { reset: NOW + 30_000 });
  assert.equal(f.read({ codexShare: 'auto' }).codex.five_hour.used_percentage, 20);
  f.log('a', { primary: 80, reset: NOW + HOUR });
  f.advance(30_000);
  assert.equal(f.read({ codexShare: 'auto' }).codex.five_hour.state, 'reset');
  f.advance(30_000);
  assert.equal(f.read({ codexShare: 'auto' }).codex.five_hour.used_percentage, 80);
});

test('malformed JSON, missing limits and partial rollout lines leave no reading', (t) => {
  const f = fixture(t);
  f.login();
  write(f.file('.claude', 'kickflip', 'usage.json'), '{');
  const file = f.log('invalid');
  write(file, '{"payload":{"rate_limits":{"primary":{"used_percent":42}}}}\n{"rate_limits":\n');
  assert.deepEqual(f.read({ codexShare: 'auto' }), { claude: null, codex: { at: null, five_hour: null, seven_day: null } });
  f.claude({ at: 'bad', five_hour: { used_percentage: 'bad' }, seven_day: null });
  assert.deepEqual(f.read().claude, { at: null, five_hour: null, seven_day: null });
});

test('Codex can find limits beyond the short tail and ignores newer unrelated lines', (t) => {
  const f = fixture(t);
  f.login();
  f.log('long', { primary: 48, text: JSON.stringify({ message: 'x'.repeat(300 * 1024) }) + '\n' });
  assert.equal(f.read({ codexShare: 'auto' }).codex.five_hour.used_percentage, 48);
});

test('Codex readings become stale per window after their rollout mtime', (t) => {
  const f = fixture(t);
  f.login();
  f.log('old', { mtime: NOW - 5 * HOUR - 1 });
  const r = f.read({ codexShare: 'auto' }).codex;
  assert.equal(r.at, iso(NOW - 5 * HOUR - 1));
  assert.equal(r.five_hour.state, 'stale');
  assert.equal(r.seven_day.state, 'live');
});
