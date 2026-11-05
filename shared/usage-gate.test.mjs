import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { usageGate, readUsageGate, setPauseAt, setKeepGoing, heldUsageEvent, builderPick, heldFor, pauseReasonFor } from './usage-gate.mjs';
import { readClaudeModel, setClaudeModel } from '../hub/push.mjs';

const now = Date.parse('2026-11-01T21:00:00Z');
const until = new Date(now + 3600_000).toISOString();
const week = new Date(now + 86400_000).toISOString();
const win = (used_percentage, resets_at = until, state = 'live') => ({ used_percentage, resets_at, state });
const reading = (five = 90, seven = 40) => ({ five_hour: win(five), seven_day: win(seven, week) });
const gate = (extra = {}) => usageGate({ now, claude: reading(), ...extra });

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-gate-'));
  const dir = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  const settings = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, dir, write, settings };
}

test('the line defaults to 90, includes equality, checks the five-hour window first and Off never pauses either tool', () => {
  assert.deepEqual(gate(), { pause_at: 90, state: 'paused', window: 'five_hour', used: 90, resets_at: until, codex: { past: false, window: null, used: null, resets_at: null } });
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
  assert.throws(() => setKeepGoing('on', { home: f.home, now }), { status: 409 });
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
  for (const kind of ['ask', 'item-message', 'owner-answer', 'hello', 'usage-resumed', 'rules', 'review-answer', 'unknown']) assert.equal(heldUsageEvent(JSON.stringify({ kind })), false);
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
  const pick = () => builderPick({ home: f.home, now });
  assert.deepEqual(read().codex, { past: true, window: 'five_hour', used: 91, resets_at: until });
  assert.deepEqual(pick(), { kind: 'claude', model: 'opus', reason: `Codex is at 91%, past the 90% line until ${until}. Claude model is Auto and the card isn't small.` });
  f.write('settings.json', { codexShare: 'off' });
  assert.equal(read().codex.past, false);
  assert.deepEqual(pick(), { kind: 'claude', model: 'opus', reason: "Codex share is off. Claude model is Auto and the card isn't small." });
  f.write('settings.json', { pauseAt: 95, codexShare: 'always' });
  assert.equal(read().codex.past, false);
  assert.deepEqual(pick(), { kind: 'codex', reason: 'Codex share is always and Codex is under the 95% line.' });
  setPauseAt(90, { home: f.home });
  assert.equal(read().codex.past, true);
  fs.rmSync(path.join(f.home, '.codex', 'auth.json'));
  assert.equal(read().codex.past, false);
  assert.deepEqual(pick(), { kind: 'claude', model: 'opus', reason: "Codex isn't logged in on the host. Claude model is Auto and the card isn't small." });
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
  assert.deepEqual(pick({}), ['opus', "Claude model is Auto and the card isn't small."]);
  assert.deepEqual(pick({ size: 'large' }), ['opus', "Claude model is Auto and the card isn't small."]);
  assert.deepEqual(pick({ size: 'small' }), ['sonnet', 'Claude model is Auto and the card is small.']);
  assert.deepEqual(pick({ size: 'small', model: 'opus' }), ['opus', 'Claude model is Auto and the card asks for Claude Opus.']);
  assert.deepEqual(pick({ model: 'sonnet' }), ['sonnet', 'Claude model is Auto and the card asks for Claude Sonnet.']);
  for (const card of [{}, { size: 'small' }, { model: 'sonnet' }]) assert.deepEqual(pick(card, { claudeModel: 'opus' }), ['opus', 'Claude model is Opus.']);
  for (const card of [{}, { size: 'large' }, { model: 'opus' }]) assert.deepEqual(pick(card, { claudeModel: 'sonnet' }), ['sonnet', 'Claude model is Sonnet.']);
  assert.deepEqual(pick({ size: 'small' }, { claudeModel: 'bad' }), ['sonnet', 'Claude model is Auto and the card is small.']);

  fs.mkdirSync(path.join(f.home, 'bin'));
  fs.writeFileSync(path.join(f.home, 'bin', 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  fs.mkdirSync(path.join(f.home, '.codex'));
  fs.writeFileSync(path.join(f.home, '.codex', 'auth.json'), '{}');
  f.write('settings.json', { claudeModel: 'sonnet' });
  assert.deepEqual(builderPick({ home: f.home, now, card: { size: 'small' } }), { kind: 'codex', reason: 'Codex share is auto and Codex is under the 90% line.' });
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
