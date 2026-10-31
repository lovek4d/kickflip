import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { liveOf, liveSessions } from './live.mjs';

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
