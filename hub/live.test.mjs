import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { liveOf, liveSessions, parentOf, processStarts, sessionGone } from './live.mjs';
import { stallingPs } from '../shared/test-helpers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
const sleepers = [];
const sleeper = async () => {
  const c = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  sleepers.push(c);
  await new Promise((resolve, reject) => { c.once('message', resolve); c.once('error', reject); c.once('exit', (code) => reject(new Error(`sleeper exited ${code}`))); });
  return c;
};
const lstart = (pid) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
const record = (pid, sessionId, extra = {}) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/repo', kind: 'bg', ...extra }));

after(() => { for (const c of sleepers) c.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

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

test('liveSessions reads the session records and checks each pid and its start time with ps', async () => {
  const running = await sleeper();
  const reused = await sleeper();
  const gone = await sleeper();
  record(running.pid, 'live-one', { procStart: lstart(running.pid) });
  record(reused.pid, 'reused-pid', { procStart: 'Thu Oct 01 00:00:00 2026' });
  record(gone.pid, 'exited', { procStart: lstart(gone.pid) });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const exited = new Promise((resolve) => gone.once('exit', resolve));
  gone.kill();
  await exited;
  const live = liveSessions({ dir });
  assert.deepEqual([...live.keys()], ['live-one']);
  assert.equal(live.get('live-one').cwd, '/repo');
  assert.equal(liveSessions({ dir: path.join(dir, 'none') }).size, 0);
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

test("a ps that times out leaves every liveness unknown, so a live session's watcher isn't told it is gone", { timeout: 60000 }, async (t) => {
  const running = await sleeper();
  record(running.pid, 'stalled', { procStart: lstart(running.pid) });
  const ps = stallingPs(dir);
  const PATH = process.env.PATH;
  process.env.PATH = `${ps.bin}:${PATH}`;
  t.after(() => { process.env.PATH = PATH; ps.stall(false); });
  assert.deepEqual([...liveSessions({ dir, session: 'stalled' }).keys()], ['stalled'], 'the stand-in ps answers as ps does');
  assert.equal(parentOf(running.pid), process.pid);
  ps.stall(true);
  assert.equal(processStarts([running.pid]), null);
  assert.equal(liveSessions({ dir }), null);
  assert.equal(parentOf(running.pid), undefined);
  assert.equal(sessionGone('stalled', [running.pid, process.pid], { ppid: running.pid, live: (o) => liveSessions({ dir, ...o }) }), false);
  assert.equal(processStarts([0x7ffffffe]).size, 0, 'a pid that no longer runs is known gone without asking ps');
});

test('parentOf reads a running process\'s parent with ps, and null once it has exited', async () => {
  const c = await sleeper();
  assert.equal(parentOf(c.pid), process.pid);
  const exited = new Promise((resolve) => c.once('exit', resolve));
  c.kill();
  await exited;
  assert.equal(parentOf(c.pid), null);
});
