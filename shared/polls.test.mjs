import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLLS, GROUPS, CLOCKS, cadenceOf, spanWords, dueOn } from './polls.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isCode = (f) => /\.(mjs|js|html)$/.test(f) && !/\.test\.mjs$/.test(f) && !f.includes('node_modules');
// hub/ and board/ with every folder under them, board/public/ and board/bin/ among them.
const files = () => ['hub', 'board'].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter(isCode).map((f) => path.join(dir, f)));
const TAG = /poll: ([\w-]+)/;
// A repeating timer: setInterval, or B.every, a board page's own (board/public/app.js).
const TIMER = /\bsetInterval\(|\bB\.every\(/;

test('every setInterval and B.every in hub/ and board/ names its registry entry', () => {
  const ids = new Set(POLLS.map((p) => p.id));
  const untagged = [];
  for (const file of files()) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!TIMER.test(line)) return;
      const tag = TAG.exec(line)?.[1] ?? TAG.exec(lines[i - 1] || '')?.[1];
      if (!tag || (!ids.has(tag) && tag !== 'none')) untagged.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(untagged, [], 'each repeating timer carries a `poll: <id>` comment naming a shared/polls.mjs entry');
});

test("every registry entry's file names it, once", () => {
  const missing = POLLS.filter((p) => {
    const text = fs.readFileSync(path.join(ROOT, p.where), 'utf8');
    return text.split('\n').filter((line) => TAG.exec(line)?.[1] === p.id).length !== 1;
  }).map((p) => `${p.id} in ${p.where}`);
  assert.deepEqual(missing, []);
});

test('entries are unique, each in a known group, run somewhere known, with a period', () => {
  assert.equal(new Set(POLLS.map((p) => p.id)).size, POLLS.length);
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const p of POLLS) {
    assert.ok(groups.has(p.group), p.id);
    assert.ok(['Hub', 'Each board', 'Each open page', 'Hook'].includes(p.runs), p.id);
    assert.ok(Number.isInteger(p.every) && p.every > 0, p.id);
    if (p.clock) assert.equal(p.every, CLOCKS[p.clock] * p.times, p.id);
  }
});

test('the hub runs on one 15 s clock, each job every so many of its ticks', () => {
  assert.deepEqual(CLOCKS, { quarter: 15_000 });
  const jobs = (clock, n) => dueOn(clock, n).map((p) => p.id).sort();
  assert.deepEqual(jobs('quarter', 1), ['hung-check', 'reconcile', 'self-restart', 'sidebar-refresh', 'tick']);
  assert.deepEqual(jobs('quarter', 4), ['hung-check', 'reconcile', 'self-restart', 'sidebar-refresh', 'tick']);
  assert.deepEqual(jobs('quarter', 60), ['hung-check', 'nightly-suite', 'reconcile', 'self-restart', 'sidebar-refresh', 'tick']);
  assert.equal(POLLS.some((p) => p.id === 'stream-reconnect'), false, 'the stream reconnects on the reconcile job');
});

test('a cadence reads as words, with a clock job’s ticks when it waits more than one', () => {
  assert.deepEqual([250, 1000, 15_000, 60_000, 15 * 60_000, 86_400_000].map(spanWords), ['250 ms', '1 s', '15 s', '1 min', '15 min', '1 day']);
  const of = (id) => cadenceOf(POLLS.find((p) => p.id === id));
  assert.equal(of('tick'), 'every 15 s');
  assert.equal(of('reconcile'), 'every 15 s');
  assert.equal(of('nightly-suite'), 'every 15 min (60 × 15 s)');
  assert.equal(of('down-check'), 'every 15 s');
  assert.equal(of('review-digest'), 'quiet hours’ end');
});

test('the watcher and the CLI wait loops are in the registry, and a tick’s gates read as checked each tick', () => {
  const by = (id) => POLLS.find((p) => p.id === id);
  assert.deepEqual(['watcher-pass', 'board-asks-wait', 'helper-wait', 'builder-asks-wait'].map((id) => [by(id).every, by(id).where]),
    [[2000, 'bin/wait-events.mjs'], [2000, 'board/asks.mjs'], [2000, 'board/runs.mjs'], [2000, 'board/runs.mjs']]);
  assert.equal(by('watcher-pass').group, 'sessions');
  for (const id of ['board-asks-wait', 'helper-wait', 'builder-asks-wait']) assert.equal(by(id).group, 'backoff', id);
  const steps = Object.fromEntries(by('tick').steps.map((s) => [s.name, s.cadence]));
  assert.equal(steps['npm update check'], 'checked every 15 s, due every 15 min');
  assert.equal(steps['Morning wake'], 'checked every 15 s, due once a day, at quiet hours’ end');
});
