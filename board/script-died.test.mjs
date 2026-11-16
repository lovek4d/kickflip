import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempDir } from '../shared/temp-dir.mjs';
import path from 'node:path';
import { diedRuns, logTail, RUNNER_START_GRACE } from './scripts.mjs';
import { scriptStateOf } from './domain.mjs';

// A script run whose runner died reads failed, keeping its output so far.
const at = Date.parse('2026-11-15T12:00:00Z');
const run = (id, ago) => ({ kind: 'script-run', ts: new Date(at - ago).toISOString(), data: { key: 'b/T-1', id } });

test('a tapped run whose runner pid is gone is dead; one whose runner lives, or that has a result or was declined, is not', () => {
  const events = [run('a', 5000), run('b', 5000), run('c', 5000), { kind: 'script-result', data: { id: 'c', exit: 0 } }, run('d', 5000), { kind: 'script-decline', data: { id: 'd' } }];
  const pids = { a: 10, b: 20, c: 30, d: 40 };
  assert.deepEqual(diedRuns(events, { pidOf: (id) => pids[id], alive: (pid) => pid === 20, now: at }), [{ key: 'b/T-1', id: 'a', ms: 5000 }]);
});

test('a run with no pid file waits out the runner start grace, then reads dead', () => {
  const none = () => null;
  assert.deepEqual(diedRuns([run('a', RUNNER_START_GRACE - 1)], { pidOf: none, alive: () => true, now: at }), []);
  assert.equal(diedRuns([run('a', RUNNER_START_GRACE + 1)], { pidOf: none, alive: () => true, now: at }).length, 1);
});

test('the output so far is the log tail, empty for a missing log, and a dead run reads failed with it', () => {
  const dir = tempDir('died-');
  const log = path.join(dir, 's.log');
  fs.writeFileSync(log, 'abcdef');
  assert.equal(logTail(log, 3), 'def');
  assert.equal(logTail(path.join(dir, 'none.log')), '');
  const state = scriptStateOf({ id: 'a' }, [{ kind: 'script-result', data: { id: 'a', exit: null, died: true, output: 'so far' } }], 'a');
  assert.deepEqual([state.state, state.output, state.died], ['failed', 'so far', true]);
});
