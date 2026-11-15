import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { usageReader, checkUsagePause, contextReading, runLimit } from './usage.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const originalHome = process.env.HOME;
const home = tempDir('usage-');
process.env.HOME = home;
after(() => { process.env.HOME = originalHome; });
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
  return { home: dir, file, claude, log, read: usageReader({ home: dir, now: () => time }), advance: (ms) => { time += ms; } };
}

test('missing files hide Claude; Codex with share on but without rollouts has no reading', (t) => {
  assert.deepEqual(usageReader({ now: () => NOW })(), { claude: null, codex: null });
  const f = fixture(t);
  assert.deepEqual(f.read({ codexShare: 'always' }), { claude: null, codex: { at: null, five_hour: null, seven_day: null } });
});

test('Claude comes from usage.json without run logs, with window reset times and reading time', (t) => {
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

test('Codex requires share on, even when a cached reading exists', (t) => {
  const f = fixture(t);
  f.log('a');
  assert.equal(f.read().codex, null);
  assert.equal(f.read({ codexShare: 'auto' }).codex.five_hour.used_percentage, 20);
  assert.equal(f.read({ codexShare: 'off' }).codex, null);
  assert.equal(f.read({ codexShare: 'always' }).codex.five_hour.used_percentage, 20);
});

test('Codex takes the highest readings in the newest window, allowing three minutes of reset drift', (t) => {
  const f = fixture(t);
  f.log('old-window', { primary: 99, secondary: 100, reset: NOW - HOUR });
  f.log('high-primary', { primary: 42, secondary: 10, mtime: NOW - 1000 });
  f.log('high-week', { primary: 30, secondary: 57, reset: NOW + HOUR - 180_000 });
  f.log('outside-drift', { primary: 98, secondary: 99, reset: NOW + HOUR - 181_000 });
  const r = f.read({ codexShare: 'auto' }).codex;
  assert.deepEqual(r, { at: iso(NOW), five_hour: { used_percentage: 42, resets_at: iso(NOW + HOUR), state: 'live' }, seven_day: { used_percentage: 57, resets_at: iso(NOW + 24 * HOUR), state: 'live' } });
});

test('Codex reads only the six newest rollouts by mtime, and the last limits in each', (t) => {
  const f = fixture(t);
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
  write(f.file('.claude', 'kickflip', 'usage.json'), '{');
  const file = f.log('invalid');
  write(file, '{"payload":{"rate_limits":{"primary":{"used_percent":42}}}}\n{"rate_limits":\n');
  assert.deepEqual(f.read({ codexShare: 'auto' }), { claude: null, codex: { at: null, five_hour: null, seven_day: null } });
  f.claude({ at: 'bad', five_hour: { used_percentage: 'bad' }, seven_day: null });
  assert.deepEqual(f.read().claude, { at: null, five_hour: null, seven_day: null });
});

test('Codex can find limits beyond the short tail and ignores newer unrelated lines', (t) => {
  const f = fixture(t);
  f.log('long', { primary: 48, text: JSON.stringify({ message: 'x'.repeat(300 * 1024) }) + '\n' });
  assert.equal(f.read({ codexShare: 'auto' }).codex.five_hour.used_percentage, 48);
});

test('Codex readings become stale per window after their rollout mtime', (t) => {
  const f = fixture(t);
  f.log('old', { mtime: NOW - 5 * HOUR - 1 });
  const r = f.read({ codexShare: 'auto' }).codex;
  assert.equal(r.at, iso(NOW - 5 * HOUR - 1));
  assert.equal(r.five_hour.state, 'stale');
  assert.equal(r.seven_day.state, 'live');
});

// docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md
const stamp = (time) => iso(time).replace(/[:.]/g, '-');
function runLog(f, role, start, { events = [], mtime = start, codex = false } = {}) {
  const target = f.file('.claude', 'kickflip', 'logs', `${role}-GH-1-${stamp(start)}.log`);
  const event = ({ five = 0.5, seven = 0.3, status = 'allowed', fiveStatus = 'allowed', reset = NOW + HOUR, type = 'five_hour' }) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {
    status, rateLimitType: type, resetsAt: (type === 'seven_day' ? NOW + 24 * HOUR : reset) / 1000,
    unifiedWindows: { five_hour: { utilization: five, resetsAt: reset / 1000, status: fiveStatus }, seven_day: { utilization: seven, resetsAt: (NOW + 24 * HOUR) / 1000, status: 'allowed' } },
  } });
  write(target, codex ? 'session id: abc\nworking\n' : [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }), ...events.map(event), JSON.stringify({ type: 'assistant' })].join('\n') + '\n');
  fs.utimesSync(target, new Date(mtime), new Date(mtime));
  return target;
}

test("Claude also reads the newest rate_limit_event in the headless agents' run logs, the highest in the newest window", (t) => {
  const f = fixture(t);
  f.claude({ at: iso(NOW - 30 * 60_000), five_hour: { used_percentage: 42, resets_at: iso(NOW + HOUR) } });
  runLog(f, 'builder', NOW - 20 * 60_000, { events: [{ five: 0.6 }, { five: 0.87, seven: 0.52 }], mtime: NOW - 60_000 });
  runLog(f, 'planner', NOW - 10 * 60_000, { events: [{ five: 0.81 }], mtime: NOW - 120_000 });
  runLog(f, 'builder', NOW - 3 * HOUR, { events: [{ five: 0.99, reset: NOW - HOUR }], mtime: NOW - 2 * HOUR });
  write(f.file('.claude', 'kickflip', 'logs', 'hub-orchestrator.log'), JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1, resetsAt: (NOW + HOUR) / 1000 } } } }) + '\n');
  assert.deepEqual(f.read().claude, {
    at: iso(NOW - 60_000),
    five_hour: { used_percentage: 87, resets_at: iso(NOW + HOUR), state: 'live' },
    seven_day: { used_percentage: 75, resets_at: iso(NOW + 24 * HOUR), state: 'live' },
  });
});

test('a run the limit rejected reads 100% for that window, and the run logs alone make a reading', (t) => {
  const f = fixture(t);
  runLog(f, 'builder', NOW - 20 * 60_000, { events: [{ five: 0.97 }, { five: 0.98, status: 'rejected', fiveStatus: 'rejected' }] });
  const r = f.read().claude;
  assert.equal(r.five_hour.used_percentage, 100);
  assert.equal(r.seven_day.used_percentage, 30);
  assert.equal(r.at, iso(NOW - 20 * 60_000));
});

test("runLimit gives the reset of a run whose last usage event the limit rejected, while that reset is ahead", (t) => {
  const f = fixture(t);
  const limited = runLog(f, 'builder', NOW - HOUR, { events: [{ five: 0.9 }, { five: 1, status: 'rejected', fiveStatus: 'rejected' }] });
  assert.equal(runLimit(limited, NOW), iso(NOW + HOUR));
  assert.equal(runLimit(limited, NOW + HOUR), null);
  const weekly = runLog(f, 'lander', NOW - HOUR, { events: [{ five: 0.4, seven: 1, status: 'rejected', type: 'seven_day' }] });
  assert.equal(runLimit(weekly, NOW), iso(NOW + 24 * HOUR));
  assert.equal(runLimit(runLog(f, 'planner', NOW - HOUR, { events: [{ five: 0.98, status: 'rejected', fiveStatus: 'rejected' }, { five: 0.1, reset: NOW + 5 * HOUR }] }), NOW), null);
  assert.equal(runLimit(f.file('missing.log'), NOW), null);
});

test('the hub remembers the gate across ticks and restarts, wakes after paused and never after going', async (t) => {
  const f = fixture(t);
  const woke = [];
  const check = (state, window = null) => checkUsagePause({ home: f.home, gate: { state, window }, resume: async (window) => woke.push(window) });
  await check('normal');
  await check('paused', 'five_hour');
  assert.deepEqual(woke, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file('.claude', 'kickflip', 'usage-gate-state.json'), 'utf8')), { state: 'paused', window: 'five_hour' });
  await check('normal');
  assert.deepEqual(woke, ['five_hour']);
  await check('normal');
  assert.deepEqual(woke, ['five_hour']);
  await check('paused', 'seven_day');
  await check('going', 'seven_day');
  await check('normal');
  assert.deepEqual(woke, ['five_hour']);
  await check('paused', 'seven_day');
  await check('normal');
  assert.deepEqual(woke, ['five_hour', 'seven_day']);
});

// docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
test("each pause that starts, and each that lifts and wakes the boards, goes in the hub's audit log, which kickflip audit prints", async (t) => {
  const f = fixture(t);
  const cli = () => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/kickflip.mjs', import.meta.url)), 'audit'], { env: { ...process.env, HOME: f.home }, encoding: 'utf8' });
  assert.deepEqual([cli().status, cli().stdout], [0, 'No calls in the last 30 days.\n']);
  const check = (state, window = null) => checkUsagePause({ home: f.home, gate: { state, window, pause_at: 90, used: window && 91 }, resume: async () => {} });
  await check('normal');
  await check('paused', 'five_hour');
  await check('paused', 'five_hour');
  await check('going', 'five_hour');
  await check('normal');
  await check('paused', 'seven_day');
  await check('normal');
  const log = fs.readFileSync(f.file('.claude', 'kickflip', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => [e.call, e.result, e.reason]), [
    ['usage-pause', 'paused', "Claude's 5-hour usage reached the 90% line."],
    ['usage-pause', 'paused', "Claude's weekly usage reached the 90% line."],
    ['usage-resume', 'resumed', "Claude's weekly usage is under the line again, so every board was told."],
  ]);
  assert.deepEqual(log[0].inputs, { gate: { state: 'paused', window: 'five_hour', pause_at: 90, used: 91 }, previous: 'normal' });
  const printed = cli();
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /^\S+ usage-pause: paused\. Claude's 5-hour usage reached the 90% line\.\n {2}inputs: \{"gate":/);
  assert.equal(printed.stdout.trim().split('\n').length, 6);
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test('Pause hub starts and lifts as the usage pause does, waking every board, and the audit log says the owner paused it', async (t) => {
  const f = fixture(t);
  const woke = [];
  const check = (state, manual = null) => checkUsagePause({ home: f.home, gate: { state, manual, window: null, pause_at: 90, used: null, resets_at: '2026-11-06T12:00:00.000Z' }, resume: async (window) => woke.push(window) });
  await check('paused', 'hub');
  await check('normal');
  const log = fs.readFileSync(f.file('.claude', 'kickflip', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => [e.call, e.result, e.reason]), [
    ['usage-pause', 'paused', 'The owner paused the hub until 2026-11-06T12:00:00.000Z.'],
    ['usage-resume', 'resumed', "The owner's pause of the hub ended, so every board was told."],
  ]);
  assert.deepEqual(woke, ['manual']);
});

test('a session\'s context reading is its saved percent and time, null without one', () => {
  const dir = tempDir('context-');
  try {
    fs.mkdirSync(path.join(dir, '.claude', 'kickflip', 'context'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'kickflip', 'context', 's-1.json'), JSON.stringify({ percent: 62, at: '2026-11-03T10:00:00.000Z' }));
    fs.writeFileSync(path.join(dir, '.claude', 'kickflip', 'context', 'bad.json'), '{nope');
    assert.deepEqual(contextReading('s-1', { home: dir }), { percent: 62, at: '2026-11-03T10:00:00.000Z' });
    assert.equal(contextReading('bad', { home: dir }), null);
    assert.equal(contextReading('missing', { home: dir }), null);
    assert.equal(contextReading('../x', { home: dir }), null);
    assert.equal(contextReading(undefined, { home: dir }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
