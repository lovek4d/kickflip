import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('logged-out-'));
process.env.HOME = home;
const { loggedOutText, checkLoggedOut, loggedOutRoutes } = await import('./logged-out.mjs');
const { siteStatus } = await import('./home.mjs');

const NOW = new Date('2026-11-14T12:00:00Z');
const logs = path.join(home, 'logs');
const stateFile = path.join(home, 'logged-out-state.json');
fs.mkdirSync(logs, { recursive: true });
const manifest = { sites: { orch: { route: 'orch', title: 'Orchestrator', hub: true, cmd: ['node', 'board/server.mjs'], dir: path.join(home, 'orch'), owner: { session: 's1', repo: home } } } };
const pane = (text) => (argv) => (argv[0] === 'has-session' ? { status: 0, stdout: '', stderr: '' } : { status: 0, stdout: text, stderr: '' });
const run = (tmux) => {
  const sent = [];
  return checkLoggedOut({ manifest, now: NOW, tmux, logDir: logs, stateFile, push: async (m, o) => { sent.push([m, o]); } }).then((r) => ({ ...r, sent }));
};

test('the matcher knows the login prompt and auth errors, not ordinary text', () => {
  for (const t of ['Not logged in · Please run /login', 'Invalid API key · Please run /login', 'OAuth token has expired', 'API Error: 401 authentication_error']) assert.ok(loggedOutText(t), t);
  assert.ok(!loggedOutText('All tests pass\n❯ '));
});

test('a hub pane at the login prompt pushes once and holds until the pane clears', async () => {
  const a = await run(pane('Not logged in · Please run /login'));
  assert.deepEqual(a.loggedOut, ['orch']);
  assert.equal(a.sent.length, 1);
  assert.equal(a.sent[0][0].title, 'Claude is logged out: run /login');
  assert.equal(a.sent[0][0].url, '/orch/');
  assert.equal(a.sent[0][1].kind, 'fault');
  assert.equal((await run(pane('Please run /login'))).sent.length, 0);
  assert.deepEqual([...loggedOutRoutes(stateFile)], ['orch']);
  const c = await run(pane('❯ working'));
  assert.deepEqual(c.loggedOut, []);
  assert.deepEqual([...loggedOutRoutes(stateFile)], []);
  assert.equal((await run(pane('Please run /login'))).sent.length, 1);
  await run(pane('ok'));
});

test('a headless run that ended on an auth error pushes once; an old one does not', async () => {
  const none = () => ({ status: 1, stdout: '', stderr: '' });
  const log = path.join(logs, 'builder-T-1-x.log');
  fs.writeFileSync(log, `${JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' })}\n`);
  fs.utimesSync(log, NOW, NOW);
  const a = await run(none);
  assert.deepEqual(a.loggedOut, ['headless']);
  assert.equal(a.sent.length, 1);
  assert.equal((await run(none)).sent.length, 0);
  const old = new Date(NOW.getTime() - 3_600_000);
  fs.utimesSync(log, old, old);
  assert.deepEqual((await run(none)).loggedOut, []);
});

test('a logged-out board row is red and says so', () => {
  assert.deepEqual(siteStatus({ state: 'up', working: true, listen: 'logged-out' }), { shape: 'dot', colour: 'red', word: 'logged out: run /login' });
});

test("a board whose open run's log ends on the login error holds the episode under its route, and a log its open run names is not headless", async () => {
  const none = () => ({ status: 1, stdout: '', stderr: '' });
  const other = { sites: { ...manifest.sites, app: { route: 'app', title: 'App', cmd: ['node', 'board/server.mjs'], dir: path.join(home, 'app') } } };
  fs.mkdirSync(path.join(home, 'app', 'data', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app', 'data', 'board.json'), '{}');
  const log = path.join(logs, 'builder-T-9-x.log');
  fs.writeFileSync(log, `${JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' })}\n`);
  fs.utimesSync(log, NOW, NOW);
  const record = path.join(home, 'app', 'data', 'agents', 'T9.json');
  fs.writeFileSync(record, JSON.stringify({ started: '2026-11-14T11:00:00Z', session: { log: 'builder-T-9-x.log' } }));
  const sent = [];
  const check = () => checkLoggedOut({ manifest: other, now: NOW, tmux: none, logDir: logs, stateFile, push: async (m) => { sent.push(m); } });
  assert.deepEqual((await check()).loggedOut, ['app']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/app/');
  assert.deepEqual([...loggedOutRoutes(stateFile)], ['app']);
  fs.writeFileSync(record, JSON.stringify({ started: '2026-11-14T11:00:00Z', session: { log: 'builder-T-9-y.log' } }));
  assert.deepEqual((await check()).loggedOut, ['headless'], 'a recent log no open run names stays headless');
  fs.writeFileSync(record, JSON.stringify({ started: '2026-11-14T11:00:00Z', done: '2026-11-14T11:30:00Z', session: { log: 'builder-T-9-x.log' } }));
  fs.rmSync(log);
  assert.deepEqual((await check()).loggedOut, []);
});
