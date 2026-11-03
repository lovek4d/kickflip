import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./watcher-stop.mjs', import.meta.url));
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };

test('the Stop hook blocks once while a board the session owns has no live watcher, with the command that relaunches it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-stop-'));
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'wait-events.mjs'], { stdio: 'ignore' });
  t.after(() => { sleeper.kill(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = (route) => path.join(home, '.claude', 'kickflip', 'sites', route);
  const board = (route, session) => ({ dir: dir(route), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', dir(route)], owner: { session } });
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { sites: { orch: board('orch', 's1'), shop: board('shop', 's2'), notes: { dir: dir('notes'), port: 1, cmd: ['node', 'server.mjs'], owner: { session: 's1' } } } });
  const stop = (input) => {
    const r = spawnSync(process.execPath, [hook], { input: typeof input === 'string' ? input : JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], ...input }), env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };

  const blocked = stop({ session_id: 's1' });
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /^Your board has no watcher, so its events wait unheard\. Relaunch it as a background Bash task, then end your turn: \/orch: \S+ \S+wait-events\.mjs orch s1$/);
  assert.equal(stop({ session_id: 's1', stop_hook_active: true }), null);
  assert.equal(stop({ session_id: 's3' }), null);
  assert.equal(stop({ session_id: 's1', hook_event_name: 'SubagentStop' }), null);
  assert.equal(stop('not json'), null);

  const task = (command) => ({ id: 'b1', type: 'shell', status: 'running', description: 'watcher', command });
  assert.equal(stop({ session_id: 's1', background_tasks: [task(`node "${home}/bin/wait-events.mjs" orch s1`)] }), null);
  assert.equal(stop({ session_id: 's1', background_tasks: [task('node wait-events.mjs orchard s1')] }).decision, 'block');

  write(path.join(dir('orch'), 'data', 'watcher.json'), { pid: sleeper.pid, since: new Date().toISOString() });
  assert.equal(stop({ session_id: 's1' }), null);
  write(path.join(dir('orch'), 'data', 'watcher.json'), { pid: sleeper.pid, since: new Date().toISOString(), exited_at: new Date().toISOString() });
  assert.equal(stop({ session_id: 's1' }).decision, 'block');
});
