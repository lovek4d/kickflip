import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveOf, liveSessions, parentOf, processStarts, sessionGone } from './live.mjs';
import { fakePs } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const dir = tempDir('live-');
// ps answers for this process and its parent, both started at START; a pid that no longer runs is never asked about.
const START = 'Thu Nov  5 00:00:00 2026';
const started = Date.parse(`${START} UTC`);
const ps = fakePs([{ pid: process.pid, ppid: process.ppid, start: started }, { pid: process.ppid, ppid: 1, start: started }]);
const silent = () => null;
const GONE = 0x7ffffffe;
const record = (pid, sessionId, extra = {}) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/repo', kind: 'bg', ...extra }));


test('a record is live while its pid runs and that process started when the record says', () => {
  const start = Date.parse('2026-10-29T21:35:54Z');
  const starts = new Map([[1, start], [2, start + 3_600_000]]);
  const ids = (records) => liveOf(records, starts).map((r) => r.sessionId);
  assert.deepEqual(ids([{ pid: 1, sessionId: 'a', procStart: 'Thu Oct 29 21:35:54 2026' }]), ['a']);
  assert.deepEqual(ids([{ pid: 1, sessionId: 'a', procStart: 'Thu Oct 29 21:35:55 2026' }]), ['a']);
  assert.deepEqual(ids([{ pid: 2, sessionId: 'b', procStart: 'Thu Oct 29 21:35:54 2026' }]), []);
  assert.deepEqual(ids([{ pid: 3, sessionId: 'c', procStart: 'Thu Oct 29 21:35:54 2026' }]), []);
  assert.deepEqual(ids([{ pid: 2, sessionId: 'd' }]), ['d']);
});

test('liveSessions reads the session records and checks each pid and its start time with ps', () => {
  record(process.pid, 'live-one', { procStart: START });
  record(process.ppid, 'reused-pid', { procStart: 'Thu Oct 01 00:00:00 2026' });
  record(GONE, 'exited', { procStart: START });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const live = liveSessions({ dir, ps });
  assert.deepEqual([...live.keys()], ['live-one']);
  assert.equal(live.get('live-one').cwd, '/repo');
  assert.deepEqual([...liveSessions({ dir, ps, session: 'live-one' }).keys()], ['live-one']);
  assert.equal(liveSessions({ dir: path.join(dir, 'none'), ps }).size, 0);
});

test("a watcher's session is gone once its shell or the shell's parent changes, or the session stops running", () => {
  const live = (...ids) => () => new Map(ids.map((id) => [id, {}]));
  const parent = (map) => (pid) => map[pid] ?? null;
  const at = { ppid: 20, parent: parent({ 20: 10 }), live: live('s1') };
  assert.equal(sessionGone('s1', [20, 10], at), false);
  assert.equal(sessionGone('s1', [20, 10], { ...at, ppid: 1 }), true, 'the shell died and the watcher went to launchd');
  assert.equal(sessionGone('s1', [20, 10], { ...at, parent: parent({ 20: 1 }) }), true, 'the session died and its shell went to launchd');
  assert.equal(sessionGone('s1', [20, 10], { ...at, parent: parent({}) }), true, 'the shell no longer runs');
  assert.equal(sessionGone('s1', [20, 10], { ...at, live: live('s2') }), true, 'the session no longer runs');
  assert.equal(sessionGone('s1', [20, 10], { ...at, live: () => null }), false, 'ps gave no answer for the session');
  assert.equal(sessionGone('s1', [20, 10], { ...at, parent: () => undefined }), false, "ps gave no answer for the shell's parent");
  assert.equal(sessionGone('s1', [20, undefined], at), false, "the shell's parent wasn't known at start");
  assert.equal(sessionGone('s1', [20, undefined], { ...at, ppid: 1 }), true);
});

test("a ps that gives no answer leaves every liveness unknown, so a live session's watcher isn't told it is gone", () => {
  record(process.pid, 'stalled', { procStart: START });
  assert.deepEqual([...liveSessions({ dir, ps, session: 'stalled' }).keys()], ['stalled'], 'ps answers for it');
  assert.equal(processStarts([process.pid], { ps: silent }), null);
  assert.equal(liveSessions({ dir, ps: silent }), null);
  assert.equal(parentOf(process.pid, { ps: silent }), undefined);
  const live = (o) => liveSessions({ dir, ps: silent, ...o });
  assert.equal(sessionGone('stalled', [process.ppid, 1], { ppid: process.ppid, parent: (pid) => parentOf(pid, { ps: silent }), live }), false);
  assert.equal(processStarts([GONE], { ps: () => assert.fail('asked ps') }).size, 0, 'a pid that no longer runs is known gone without asking ps');
});

test("parentOf reads a running process's parent with ps, and null once it no longer runs", () => {
  assert.equal(parentOf(process.pid, { ps }), process.ppid);
  assert.equal(parentOf(GONE, { ps }), null);
});
