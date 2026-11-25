// docs/adr/2026-11-25-0200-slack-is-read-every-30-seconds-on-its-own-poll.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

// push.mjs and boards.mjs read HOME as they load, so it is set before they are imported.
process.env.HOME = tempDir('slack-poll-');
const { slackPoll, STEPS } = await import('./slack-poll.mjs');

const ON = { on: true, weekends_off: false, snoozed_until: null };
const quiet = (start, end) => ({ quiet: { start, end, hold: true }, notifications: ON });
// 2:00pm, outside quiet hours 10pm to 8am; plus s seconds.
const day = new Date(2026, 10, 25, 14).getTime();
const night = new Date(2026, 10, 25, 2).getTime();

// A runner over steps that each record their run; gate: a promise the first step waits on. → {poll, runs, flushes, lines, at}
function runner({ start = day, gate, queued = false, settings = quiet('22:00', '08:00') } = {}) {
  const at = { now: start };
  const runs = [];
  const flushes = [];
  const lines = [];
  const steps = [
    { id: 'one', done: 'did', line: (l) => `did ${l}`, failures: 'one', run: async (args) => { runs.push(args); await gate; return { did: ['a thing'], failed: [] }; } },
    { id: 'two', done: 'did', line: (l) => l, failures: 'two', run: async () => ({ did: [], failed: [], ...(queued ? { queued: true } : {}) }) },
  ];
  const poll = slackPoll({ boards: () => ['b'], log: (...l) => lines.push(l.join(' ')), clock: () => at.now, settings: () => settings, slack: () => 'client', flush: async () => { flushes.push(at.now); return { count: 1, sent: 1, ok: true }; }, steps });
  return { poll, runs, flushes, lines, at };
}

test('a run asked for while one runs joins it, so each step runs once', async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const { poll, runs, at } = runner({ gate });
  const first = poll.run();
  at.now += 60_000;
  assert.equal(poll.run(), first);
  open();
  const result = await first;
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].boards, ['b']);
  assert.equal(runs[0].slack, 'client');
  assert.deepEqual(result.one, { did: ['a thing'], failed: [] });
});

test('Slack is read every 30 s by day and every 5 minutes in quiet hours, on the 30 s job', async () => {
  const count = async (start, minutes) => {
    const { poll, runs, at } = runner({ start });
    for (let s = 0; s < minutes * 60; s += 30) { at.now = start + s * 1000; await poll.run(); }
    return runs.length;
  };
  assert.equal(await count(day, 10), 20);
  assert.equal(await count(night, 10), 2);
});

test('a run sends the queued pushes only when a step queued one and pushes are not held', async () => {
  const sent = runner({ queued: true });
  assert.deepEqual((await sent.poll.run()).flushed, { count: 1, sent: 1, ok: true });
  assert.ok(sent.lines.includes('push queue: sent 1 of 1 queued'));
  const none = runner();
  assert.equal((await none.poll.run()).flushed, null);
  assert.deepEqual(none.flushes, []);
  const held = runner({ queued: true, start: night });
  await held.poll.run();
  assert.deepEqual(held.flushes, [], 'pushes held overnight wait for the hold to end');
});

test("a step that throws fails its own step only, logged at most hourly, and each step's lines log", async () => {
  const lines = [];
  const at = { now: day };
  const steps = [
    { id: 'bad', done: 'did', line: (l) => l, failures: 'slack bad', run: async () => { throw new Error('boom'); } },
    { id: 'good', done: 'posted', line: (l) => `posted ${l}`, failures: 'slack good', run: async () => ({ posted: ['orch T-1: a reply'], failed: [] }) },
  ];
  const poll = slackPoll({ boards: () => [], log: (...l) => lines.push(l.join(' ')), clock: () => at.now, settings: () => quiet('22:00', '08:00'), slack: () => null, steps });
  const result = await poll.run();
  assert.deepEqual(result.bad, { did: [], failed: ['boom'] });
  assert.deepEqual(lines, ['slack bad: 1 failed, first: boom (logged at most hourly)', 'slack: posted orch T-1: a reply']);
  at.now += 30_000;
  await poll.run();
  assert.equal(lines.filter((l) => l.startsWith('slack bad')).length, 1);
});

test("every Slack read and post is the Slack poll's: the GitHub poll runs none of its steps, and only it hears the day threads", () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['intake', 'follow', 'replies', 'status', 'hear']);
  const hub = fs.readFileSync(path.join(import.meta.dirname, 'hub.mjs'), 'utf8');
  const runPoll = hub.slice(hub.indexOf('function runPoll('), hub.indexOf('\n  }\n', hub.indexOf('function runPoll(')));
  assert.ok(runPoll.includes('sendReviews('), 'the review sends stay on the GitHub poll');
  assert.deepEqual(STEPS.map((s) => s.run.name).filter((name) => hub.includes(`${name}(`)), [], 'the hub calls no Slack step itself');
});
