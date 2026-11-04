import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalHome = process.env.HOME;
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compact-')));
process.env.HOME = home;
after(() => { process.env.HOME = originalHome; fs.rmSync(home, { recursive: true, force: true }); });
const { compactFullContexts } = await import('./sessions.mjs');

const web = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const NOW = new Date('2026-11-03T22:14:40.000Z');
const board = (route, extra = {}) => {
  const dir = path.join(home, 'sites', route);
  return { dir, port: 1, cmd: [process.execPath, path.join(SKILL, 'board', 'server.mjs'), dir], owner: { session: `s-${route}`, repo: home }, ...extra };
};
const manifest = { sites: { orch: board('orch', { hub: true }), shop: board('shop') } };
const running = new Map([['s-orch', {}], ['s-shop', {}]]);
const context = (session, percent) => write(web('context', `${session}.json`), { percent, at: NOW.toISOString() });

function fakeTmux({ open = true, sendStatus = 0 } = {}) {
  const calls = [];
  const tmux = (argv) => {
    calls.push(argv);
    if (argv[0] === 'has-session') return { status: open ? 0 : 1, stdout: '', stderr: open ? '' : "can't find session" };
    return { status: sendStatus, stdout: '', stderr: sendStatus ? 'no server running' : '' };
  };
  return { tmux, calls, sent: () => calls.filter((a) => a[0] === 'send-keys') };
}
const check = (tmux) => compactFullContexts({ manifest, now: NOW, running, wakes: {}, tmux });

test('the hub board not listening with a full context gets /compact typed into its tmux pane once, and again only after its context drops', async () => {
  context('s-orch', 97.6);
  context('s-shop', 99);
  const t = fakeTmux();
  assert.deepEqual(await check(t.tmux), { compacted: ['orch'], failed: [] });
  assert.deepEqual(t.sent(), [['send-keys', '-t', '=kickflip-orch:', '-l', '/compact'], ['send-keys', '-t', '=kickflip-orch:', 'Enter']]);
  assert.deepEqual(read(web('compact-state.json')), { orch: { session: 's-orch', percent: 97.6, at: NOW.toISOString() } });

  assert.deepEqual(await check(t.tmux), { compacted: [], failed: [] });
  assert.equal(t.sent().length, 2);

  context('s-orch', 31);
  assert.deepEqual(await check(t.tmux), { compacted: [], failed: [] });
  assert.deepEqual(read(web('compact-state.json')), {});
  context('s-orch', 96);
  assert.deepEqual(await check(t.tmux), { compacted: ['orch'], failed: [] });
  assert.equal(t.sent().length, 4);
  write(web('compact-state.json'), {});
});

test('a listening board, a board below 95% and a hub board with no tmux session are left alone', async () => {
  context('s-orch', 99);
  write(path.join(manifest.sites.orch.dir, 'data', 'watcher.json'), { pid: 1, since: NOW.toISOString(), exited_at: NOW.toISOString() });
  let t = fakeTmux();
  assert.deepEqual(await check(t.tmux), { compacted: [], failed: [] });
  fs.rmSync(path.join(manifest.sites.orch.dir, 'data', 'watcher.json'));
  context('s-orch', 94);
  assert.deepEqual(await check(t.tmux), { compacted: [], failed: [] });
  assert.deepEqual(t.sent(), []);
  context('s-orch', 99);
  t = fakeTmux({ open: false });
  assert.deepEqual(await check(t.tmux), { compacted: [], failed: [] });
  assert.deepEqual(t.sent(), []);
  assert.deepEqual(read(web('compact-state.json')), {});
});

test('a failed send is reported and recorded, so it is not retried every check', async () => {
  context('s-orch', 99);
  const t = fakeTmux({ sendStatus: 1 });
  assert.deepEqual(await check(t.tmux), { compacted: [], failed: ['orch: could not send /compact to tmux session kickflip-orch (no server running)'] });
  assert.equal(read(web('compact-state.json')).orch.error, 'no server running');
  assert.deepEqual(await check(t.tmux), { compacted: [], failed: [] });
  assert.equal(t.sent().length, 1);
});
