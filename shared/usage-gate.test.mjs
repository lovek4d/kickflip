import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { usageGate, readUsageGate, setPauseAt, setKeepGoing, setHubPause, heldUsageEvent, builderPick, heldFor, holdsWork, tasksInProgressCap, pauseReasonFor, pauseReason, pausedLine } from './usage-gate.mjs';
import { readClaudeModel, setClaudeModel } from '../hub/push.mjs';
import { tempDir } from './temp-dir.mjs';

const now = Date.parse('2026-11-01T21:00:00Z');
const until = new Date(now + 3600_000).toISOString();
const week = new Date(now + 86400_000).toISOString();
const win = (used_percentage, resets_at = until, state = 'live') => ({ used_percentage, resets_at, state });
const reading = (five = 90, seven = 40) => ({ five_hour: win(five), seven_day: win(seven, week) });
const gate = (extra = {}) => usageGate({ now, claude: reading(), ...extra });

function fixture(t) {
  const home = tempDir('usage-gate-');
  const dir = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  const settings = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  return { home, dir, write, settings };
}

test('the line defaults to 90, includes equality, checks the five-hour window first and Off never pauses either tool', () => {
  assert.deepEqual(gate(), { pause_at: 90, state: 'paused', manual: null, window: 'five_hour', used: 90, resets_at: until, near: null, codex: { past: false, window: null, used: null, resets_at: null }, machine: { state: 'normal', reason: null } });
  assert.equal(gate({ claude: reading(89, 89) }).state, 'normal');
  assert.equal(gate({ claude: reading(99, 99) }).window, 'five_hour');
  assert.equal(gate({ claude: reading(40, 95) }).window, 'seven_day');
  assert.equal(gate({ pauseAt: 50, claude: reading(50) }).state, 'paused');
  for (const pauseAt of [undefined, null, '95', 49, 101, 91, 90.5]) assert.equal(gate({ pauseAt }).pause_at, 90);
  const off = gate({ pauseAt: 100, claude: reading(100, 100), codex: reading(100, 100) });
  assert.equal(off.state, 'normal');
  assert.equal(off.codex.past, false);
});

test('only live windows count and a passing reset ends the pause, independently for each window', () => {
  for (const state of ['stale', 'reset']) assert.equal(gate({ claude: { five_hour: win(99, until, state) } }).state, 'normal');
  assert.equal(gate({ claude: null }).state, 'normal');
  assert.equal(gate({ now: Date.parse(until) }).state, 'normal');
  assert.equal(gate({ now: Date.parse(until), claude: reading(95, 95) }).window, 'seven_day');
});

test('Keep going covers exactly the paused Claude window until its reset and never changes Codex', () => {
  const keepGoing = { window: 'five_hour', until };
  assert.equal(gate({ keepGoing }).state, 'going');
  assert.equal(gate({ keepGoing, claude: { five_hour: win(95, new Date(Date.parse(until) + 30_000).toISOString()), seven_day: win(20, week) } }).state, 'going');
  assert.equal(gate({ keepGoing, now: Date.parse(until) }).state, 'normal');
  assert.equal(gate({ keepGoing, claude: reading(40, 95) }).state, 'paused');
  assert.equal(gate({ keepGoing: { ...keepGoing, until: week } }).state, 'paused');
  assert.equal(gate({ keepGoing: { ...keepGoing, until: 'bad' } }).state, 'paused');
  const codex = gate({ claude: reading(20), codex: reading(20, 92), keepGoing });
  assert.equal(codex.state, 'normal');
  assert.deepEqual(codex.codex, { past: true, window: 'seven_day', used: 92, resets_at: week });
  assert.equal(gate({ codex: { five_hour: win(99, until, 'stale') } }).codex.past, false);
});

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
test('each kind of agent is held by its own usage: Claude by the pause, Codex past its line, and a planner kind as Claude', () => {
  const claudePaused = gate();
  const codexPast = gate({ claude: reading(20), codex: reading(20, 92) });
  assert.deepEqual(['claude', 'codex', 'grill'].map((k) => heldFor(claudePaused, k)), [true, false, true]);
  assert.deepEqual(['claude', 'codex', 'prototype'].map((k) => heldFor(codexPast, k)), [false, true, false]);
  assert.equal(heldFor(gate({ keepGoing: { window: 'five_hour', until } }), 'claude'), false, 'Keep going lets Claude go');
  assert.match(pauseReasonFor(claudePaused, 'claude'), /^Work is paused: Claude's 5-hour usage is at 90%/);
  assert.equal(pauseReasonFor(codexPast, 'codex'), `Codex is paused: its weekly usage is at 92%, past the 90% line. Resumes at ${week}.`);
});

// docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md
test('within twice the buffer of the line the gate is near, and near the line the cap is half of it rounded up', () => {
  assert.equal(gate({ claude: reading(79, 20) }).near, null);
  assert.deepEqual(gate({ claude: reading(80, 20) }).near, { window: 'five_hour', used: 80, resets_at: until, from: 80, going: false });
  assert.equal(gate({ claude: reading(40, 85) }).near.window, 'seven_day');
  assert.equal(gate({ pauseAt: 80, claude: reading(60, 20) }).near.from, 60);
  assert.equal(gate({ pauseAt: 100, claude: reading(99, 99) }).near, null, 'Off has no band');
  assert.equal(gate().near, null, 'past the line it is paused, not near');
  assert.equal(gate({ claude: { five_hour: win(85, until, 'stale') } }).near, null);
  const near = gate({ claude: reading(85, 20) });
  assert.deepEqual([1, 4, 5, 6, 10].map((cap) => tasksInProgressCap(near, cap)), [1, 2, 3, 3, 5]);
  assert.deepEqual([1, 5].map((cap) => tasksInProgressCap(gate({ claude: reading(70, 20) }), cap)), [1, 5], 'under the band the cap is whole');
  assert.equal(tasksInProgressCap(gate(), 5), 5, 'past the line the pause holds, not the cap');
  assert.equal(near.state, 'normal');
  assert.deepEqual(['claude', 'grill', 'codex'].map((k) => heldFor(near, k)), [false, false, false], 'near the line nothing is held, only the cap');
  assert.equal(heldFor(gate(), 'claude'), true);
});

test("Keep going near the line restores the full cap until the window's reset, and never lifts the pause at the line", () => {
  const keepGoing = { window: 'five_hour', until, near: true };
  const going = gate({ claude: reading(85, 20), keepGoing });
  assert.deepEqual([going.near.going, tasksInProgressCap(going, 5)], [true, 5]);
  assert.equal(tasksInProgressCap(gate({ claude: reading(40, 85), keepGoing }), 5), 3, 'it covers only its own window');
  assert.equal(gate({ keepGoing }).state, 'paused');
  assert.equal(tasksInProgressCap(gate({ claude: reading(85, 20), keepGoing: { window: 'five_hour', until } }), 5), 3, "the line's Keep going isn't the band's");
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test('a manual hub or board pause pauses all new work until its end, over the usage pause and Keep going, hub first', () => {
  const later = new Date(now + 7200_000).toISOString();
  const calm = { claude: reading(20, 20) };
  assert.deepEqual(gate({ ...calm, hubPause: later }), { pause_at: 90, state: 'paused', manual: 'hub', window: null, used: null, resets_at: later, near: null, codex: { past: false, window: null, used: null, resets_at: null }, machine: { state: 'normal', reason: null } });
  assert.equal(gate({ ...calm, boardPause: later }).manual, 'board');
  assert.equal(gate({ ...calm, hubPause: until, boardPause: later }).manual, 'hub', 'the hub pause covers every board');
  assert.equal(gate({ hubPause: later }).manual, 'hub', 'over the usage pause');
  assert.equal(gate({ boardPause: later, keepGoing: { window: 'five_hour', until } }).state, 'paused', 'Keep going lifts only the usage pause');
  for (const ended of [new Date(now).toISOString(), 'bad', null]) assert.equal(gate({ ...calm, hubPause: ended, boardPause: ended }).state, 'normal');
  assert.equal(gate({ boardPause: later, now: Date.parse(later) }).manual, null, 'an ended board pause leaves the usage pause');
  const hub = gate({ ...calm, hubPause: later });
  const board = gate({ ...calm, boardPause: later });
  assert.deepEqual(['claude', 'codex', 'grill'].map((k) => heldFor(board, k)), [true, true, true], 'a manual pause holds Codex too');
  assert.equal(pauseReason(hub), `Work is paused: the owner paused the hub until ${later}. Pause hub in Hub settings resumes it.`);
  assert.equal(pauseReasonFor(board, 'codex'), `Work is paused: the owner paused this board until ${later}. Pause board in Board settings resumes it.`);
  assert.equal(pausedLine(board), `usage paused ${later} manual board`);
  assert.equal(pausedLine(gate()), `usage paused ${until} five_hour 90%`);
});

// docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md
test('a busy host holds every kind of new work, with no override, and words it after a pause', (t) => {
  const busy = { state: 'busy', reason: 'memory pressure critical' };
  const calm = { claude: reading(20, 20) };
  const held = gate({ ...calm, machine: busy });
  assert.deepEqual([held.state, held.machine], ['normal', busy], 'the usage pause stays its own state');
  assert.deepEqual(gate(calm).machine, { state: 'normal', reason: null });
  assert.deepEqual(['claude', 'codex', 'grill'].map((k) => heldFor(held, k)), [true, true, true]);
  assert.deepEqual([holdsWork(held), holdsWork(gate(calm)), holdsWork(gate())], [true, false, true]);
  assert.equal(heldFor(gate({ machine: busy, keepGoing: { window: 'five_hour', until } }), 'claude'), true, 'Keep going lifts only the usage pause');
  const words = 'Work is held: the host is busy (memory pressure critical). It starts again when the host eases.';
  assert.equal(pauseReason(held), words);
  assert.equal(pauseReasonFor(held, 'claude'), words);
  assert.equal(pauseReasonFor(held, 'codex'), words);
  assert.match(pauseReason(gate({ machine: busy })), /^Work is paused: Claude's 5-hour usage/, 'a pause is worded first');
  assert.match(pauseReasonFor(gate({ claude: reading(20), codex: reading(20, 92), machine: busy }), 'codex'), /^Codex is paused/);
  const f = fixture(t);
  assert.deepEqual(readUsageGate({ home: f.home, now }).machine, { state: 'normal', reason: null });
  f.write('machine-state.json', { state: 'busy', reason: 'load high', since: new Date(now).toISOString(), at: new Date(now).toISOString() });
  assert.deepEqual(readUsageGate({ home: f.home, now }).machine, { state: 'busy', reason: 'load high', since: new Date(now).toISOString() });
});

test('a Forever manual pause lasts until it is lifted and says so', () => {
  const forever = gate({ claude: reading(20, 20), boardPause: 'forever', now: now + 365 * 86_400_000 });
  assert.deepEqual([forever.state, forever.manual, forever.resets_at], ['paused', 'board', 'forever']);
  assert.equal(gate({ hubPause: 'forever', boardPause: 'forever' }).manual, 'hub');
  assert.equal(pauseReason(forever), 'Work is paused: the owner paused this board until the owner resumes it. Pause board in Board settings resumes it.');
  assert.equal(pausedLine(forever), 'usage paused forever manual board');
});

test('the file reader reads the hub pause from settings and the board pause from its board.json', (t) => {
  const f = fixture(t);
  const site = path.join(f.home, 'site');
  fs.mkdirSync(site);
  f.write('settings.json', { rules: ['kept'] });
  assert.equal(setHubPause('3h', { home: f.home, now: new Date(now) }), new Date(now + 3 * 3600_000).toISOString());
  assert.deepEqual(f.settings(), { rules: ['kept'], paused_until: new Date(now + 3 * 3600_000).toISOString() });
  assert.equal(readUsageGate({ home: f.home, now }).manual, 'hub');
  assert.equal(setHubPause('forever', { home: f.home, now: new Date(now) }), 'forever');
  assert.deepEqual(f.settings(), { rules: ['kept'], paused_until: 'forever' });
  assert.equal(readUsageGate({ home: f.home, now }).resets_at, 'forever');
  for (const choice of ['0h', '31d', 'soon']) assert.throws(() => setHubPause(choice, { home: f.home, now: new Date(now) }), { status: 400 });
  assert.equal(setHubPause('off', { home: f.home, now: new Date(now) }), null);
  assert.deepEqual(f.settings(), { rules: ['kept'] });
  assert.equal(readUsageGate({ home: f.home, now }).state, 'normal');
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ paused_until: until }));
  assert.equal(readUsageGate({ home: f.home, now, dir: site }).manual, 'board');
  assert.equal(readUsageGate({ home: f.home, now }).state, 'normal', 'without the board, its pause is not read');
  fs.writeFileSync(path.join(site, 'board.json'), '{');
  assert.equal(readUsageGate({ home: f.home, now, dir: site }).state, 'normal');
});

test('the file reader follows setting changes and resets while writes preserve other settings', (t) => {
  const f = fixture(t);
  assert.equal(readUsageGate({ home: f.home, now }).state, 'normal');
  f.write('usage.json', { claude: { at: new Date(now).toISOString(), ...reading(92) } });
  f.write('settings.json', { rules: ['kept'], notifications: { on: false } });
  assert.equal(readUsageGate({ home: f.home, now }).state, 'paused');
  setKeepGoing('on', { home: f.home, now });
  assert.deepEqual(f.settings().keepGoing, { window: 'five_hour', until });
  assert.equal(readUsageGate({ home: f.home, now }).state, 'going');
  setKeepGoing('off', { home: f.home });
  assert.equal(f.settings().keepGoing, undefined);
  assert.equal(readUsageGate({ home: f.home, now }).state, 'paused');
  setPauseAt('95', { home: f.home });
  assert.equal(readUsageGate({ home: f.home, now }).state, 'normal');
  setKeepGoing('on', { home: f.home, now });
  assert.deepEqual(f.settings().keepGoing, { window: 'five_hour', until, near: true }, 'near the line, Keep going lifts the halved cap');
  assert.equal(readUsageGate({ home: f.home, now }).near.going, true);
  setKeepGoing('off', { home: f.home });
  setPauseAt('100', { home: f.home });
  assert.throws(() => setKeepGoing('on', { home: f.home, now }), { status: 409 });
  setPauseAt('95', { home: f.home });
  assert.throws(() => setKeepGoing('wrong', { home: f.home, now }), { status: 400 });
  for (const value of [undefined, '', null, '90.0', ' 90', 91, 45, 105]) assert.throws(() => setPauseAt(value, { home: f.home }), { status: 400 });
  assert.deepEqual(f.settings(), { rules: ['kept'], notifications: { on: false }, pauseAt: 95 });
  setPauseAt(90, { home: f.home });
  assert.equal(readUsageGate({ home: f.home, now: Date.parse(until) }).state, 'normal');
});

test('CLI reads without a hub and changes the line and Keep going directly', (t) => {
  const f = fixture(t);
  const bin = path.join(f.home, 'bin');
  fs.mkdirSync(bin);
  const run = (...args) => spawnSync(process.execPath, [new URL('../bin/kickflip.mjs', import.meta.url).pathname, 'usage-gate', ...args], { env: { ...process.env, HOME: f.home, PATH: bin, KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8' });
  const read = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  assert.equal(read().pause_at, 90);
  for (const value of ['{', 'null', '[]', '"bad"']) { fs.writeFileSync(path.join(f.dir, 'settings.json'), value); assert.equal(read().pause_at, 90); }
  assert.deepEqual(read().codex, { past: false, window: null, used: null, resets_at: null });
  assert.equal(read('pause-at', '85').pause_at, 85);
  assert.equal(run('pause-at', '86').status, 2);
  assert.equal(run('keep-going').status, 1);
  const reset = new Date(Date.now() + 3600_000).toISOString();
  f.write('usage.json', { claude: { at: new Date().toISOString(), five_hour: win(88, reset) } });
  assert.equal(read().state, 'paused');
  assert.equal(read('keep-going').state, 'going');
  assert.equal(read('stop').state, 'paused');
  assert.equal(read('pause-at', '100').state, 'normal');
});

test('only the hub work kinds are held', () => {
  for (const kind of ['github-change', 'check-github', 'card-unblocked', 'overnight-triage', 'pr-review', 'owner-check-broken']) assert.equal(heldUsageEvent(JSON.stringify({ kind })), true);
  for (const kind of ['ask', 'item-message', 'owner-answer', 'ping', 'usage-resumed', 'rules', 'review-answer', 'unknown']) assert.equal(heldUsageEvent(JSON.stringify({ kind })), false);
  assert.equal(heldUsageEvent('broken'), false);
});

test('the reader exposes Codex past the line only while effective share is on', (t) => {
  const f = fixture(t);
  const bin = path.join(f.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  fs.mkdirSync(path.join(f.home, '.codex'));
  fs.writeFileSync(path.join(f.home, '.codex', 'auth.json'), '{}');
  const logs = path.join(f.home, '.codex', 'sessions', '2026', '11', '01');
  fs.mkdirSync(logs, { recursive: true });
  const log = path.join(logs, 'rollout-a.jsonl');
  fs.writeFileSync(log, JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 91, resets_at: Date.parse(until) / 1000 } } } }) + '\n');
  fs.utimesSync(log, new Date(now), new Date(now));
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = oldPath; });
  const read = () => readUsageGate({ home: f.home, now });
  const pick = () => { const { inputs, ...picked } = builderPick({ home: f.home, now }); return picked; };
  assert.deepEqual(read().codex, { past: true, window: 'five_hour', used: 91, resets_at: until });
  assert.deepEqual(pick(), { kind: 'claude', model: 'opus', reason: `Codex is at 91%, past the 90% line until ${until}. Claude model is Auto and the task isn't small.` });
  f.write('settings.json', { codexShare: 'off' });
  assert.equal(read().codex.past, false);
  assert.deepEqual(pick(), { kind: 'claude', model: 'opus', reason: "Codex share is off. Claude model is Auto and the task isn't small." });
  f.write('settings.json', { pauseAt: 95, codexShare: 'always' });
  assert.equal(read().codex.past, false);
  assert.deepEqual(pick(), { kind: 'codex', reason: 'Codex share is always and Codex is under the 95% line.' });
  setPauseAt(90, { home: f.home });
  assert.equal(read().codex.past, true);
  fs.rmSync(path.join(f.home, '.codex', 'auth.json'));
  assert.equal(read().codex.past, false);
  assert.deepEqual(pick(), { kind: 'claude', model: 'opus', reason: "Codex isn't logged in on the host. Claude model is Auto and the task isn't small." });
});

// docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md
test("the hub's Claude model decides a Claude build's model: Auto gives a small card Sonnet and a card's own model wins, Opus and Sonnet force it, and Codex builds take none", (t) => {
  const f = fixture(t);
  const oldPath = process.env.PATH;
  process.env.PATH = path.join(f.home, 'bin');
  t.after(() => { process.env.PATH = oldPath; });
  const pick = (card, settings) => {
    if (settings) f.write('settings.json', settings);
    const { model, reason } = builderPick({ home: f.home, now, card });
    return [model, reason.replace("Codex isn't installed on the host. ", '')];
  };
  assert.deepEqual(pick({}), ['opus', "Claude model is Auto and the task isn't small."]);
  assert.deepEqual(pick({ size: 'large' }), ['opus', "Claude model is Auto and the task isn't small."]);
  assert.deepEqual(pick({ size: 'small' }), ['sonnet', 'Claude model is Auto and the task is small.']);
  assert.deepEqual(pick({ size: 'small', model: 'opus' }), ['opus', 'Claude model is Auto and the task asks for Claude Opus.']);
  assert.deepEqual(pick({ model: 'sonnet' }), ['sonnet', 'Claude model is Auto and the task asks for Claude Sonnet.']);
  for (const card of [{}, { size: 'small' }, { model: 'sonnet' }]) assert.deepEqual(pick(card, { claudeModel: 'opus' }), ['opus', 'Claude model is Opus.']);
  for (const card of [{}, { size: 'large' }, { model: 'opus' }]) assert.deepEqual(pick(card, { claudeModel: 'sonnet' }), ['sonnet', 'Claude model is Sonnet.']);
  assert.deepEqual(pick({ size: 'small' }, { claudeModel: 'bad' }), ['sonnet', 'Claude model is Auto and the task is small.']);

  fs.mkdirSync(path.join(f.home, 'bin'));
  fs.writeFileSync(path.join(f.home, 'bin', 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  fs.mkdirSync(path.join(f.home, '.codex'));
  fs.writeFileSync(path.join(f.home, '.codex', 'auth.json'), '{}');
  f.write('settings.json', { claudeModel: 'sonnet' });
  const { inputs, ...picked } = builderPick({ home: f.home, now, card: { size: 'small' } });
  assert.deepEqual(picked, { kind: 'codex', reason: 'Codex share is auto and Codex is under the 90% line.' });
});

// docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
test('a pick names the inputs it read, as far as it read them', (t) => {
  const f = fixture(t);
  const oldPath = process.env.PATH;
  process.env.PATH = path.join(f.home, 'bin');
  t.after(() => { process.env.PATH = oldPath; });
  f.write('settings.json', { claudeModel: 'auto' });
  assert.deepEqual(builderPick({ home: f.home, now, card: { size: 'small' } }).inputs, { codex: 'not installed', claudeModel: 'auto', size: 'small', cardModel: null });
  fs.mkdirSync(path.join(f.home, 'bin'));
  fs.writeFileSync(path.join(f.home, 'bin', 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  fs.mkdirSync(path.join(f.home, '.codex'));
  fs.writeFileSync(path.join(f.home, '.codex', 'auth.json'), '{}');
  f.write('settings.json', { codexShare: 'off', claudeModel: 'sonnet' });
  assert.deepEqual(builderPick({ home: f.home, now, card: { model: 'opus' } }).inputs, { codex: 'usable', claudeModel: 'sonnet', size: null, cardModel: 'opus', codexShare: 'off' });
  f.write('settings.json', { claudeModel: 'auto' });
  assert.deepEqual(builderPick({ home: f.home, now }).inputs, {
    codex: 'usable', claudeModel: 'auto', size: null, cardModel: null, codexShare: 'auto', pauseAt: 90, codexUsage: { past: false, window: null, used: null, resets_at: null },
  });
});

test('setClaudeModel saves opus, auto or sonnet beside the other hub settings and refuses anything else', (t) => {
  const f = fixture(t);
  f.write('settings.json', { codexShare: 'off' });
  assert.equal(readClaudeModel(f.home), 'auto');
  for (const value of ['opus', 'sonnet', 'auto']) {
    assert.equal(setClaudeModel(value, f.home), value);
    assert.deepEqual(f.settings(), { codexShare: 'off', claudeModel: value });
    assert.equal(readClaudeModel(f.home), value);
  }
  for (const value of [undefined, '', 'Opus', 'haiku', 'toString']) {
    assert.throws(() => setClaudeModel(value, f.home), { message: 'claude-model takes opus, auto or sonnet', status: 400 });
  }
  assert.deepEqual(f.settings(), { codexShare: 'off', claudeModel: 'auto' });
});
