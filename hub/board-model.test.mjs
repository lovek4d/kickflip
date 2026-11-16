import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('board-model-'));
process.env.HOME = home;
const { boardModel, changeBoardModel, restartOnModel } = await import('./board-model.mjs');
const { startArgv, hubArgv, BG_SETTINGS, tmuxName } = await import('./sessions.mjs');
const { readManifest, saveJSON } = await import('./boards.mjs');
const web = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const sessionsDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const repo = path.join(home, 'repo');
fs.mkdirSync(repo, { recursive: true });
const OLD = '11111111-1111-1111-1111-111111111111';

function fixture({ hub = false, model } = {}) {
  const dir = web('sites', 'shop');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const owner = { session: OLD, label: 'Shop owner', since: '2026-11-01T00:00:00Z', repo, ...(model ? { model } : {}) };
  const site = { dir, cmd: ['node', 'board/server.mjs', dir], port: 49001, title: 'Shop', watch: ['data/events.jsonl'], ...(hub ? { hub: true } : {}), owner };
  saveJSON(web('manifest.json'), { version: 1, sites: { shop: site, page: { dir: home, cmd: ['echo'], port: 49002 } } });
  return { dir };
}
const tmuxCalls = () => {
  const calls = [];
  return { calls, tmux: (argv) => { calls.push(argv); return { status: 0, stdout: '', stderr: '' }; } };
};
const running = (status) => () => new Map([[OLD, { pid: 1, sessionId: OLD, kind: 'fg', status }]]);

test('a session with no model recorded starts, and the hub board resumes, on Opus', () => {
  const start = startArgv({ route: 'shop', name: 'Shop' });
  assert.deepEqual(start.slice(start.indexOf('--model'), start.indexOf('--model') + 2), ['--model', 'opus']);
  const resumed = hubArgv({ route: 'shop', title: 'Shop', id: OLD });
  assert.deepEqual(resumed.slice(resumed.indexOf('--model'), resumed.indexOf('--model') + 2), ['--model', 'opus']);
  assert.ok(startArgv({ route: 'shop', name: 'Shop', model: 'sonnet' }).join(' ').includes('--model sonnet'));
});

test("a board's orchestrator model reads Opus with none recorded, else the recorded one, and a page that isn't a board has none", () => {
  fixture();
  assert.deepEqual(boardModel('shop'), { model: 'opus', hub: false });
  fixture({ model: 'sonnet', hub: true });
  assert.deepEqual(boardModel('shop'), { model: 'sonnet', hub: true });
  assert.throws(() => boardModel('page'), { status: 404 });
});

test("a headless board's change is kept on its owner record for the next new session, and nothing is typed anywhere", async () => {
  fixture();
  const { calls, tmux } = tmuxCalls();
  assert.deepEqual(await changeBoardModel('shop', { model: 'sonnet' }, { tmux, live: running('idle') }), { model: 'sonnet', applies: 'new session' });
  assert.deepEqual(readManifest().sites.shop.owner, { session: OLD, label: 'Shop owner', since: '2026-11-01T00:00:00Z', repo, model: 'sonnet' });
  assert.deepEqual(calls, []);
  for (const bad of [{ model: 'haiku' }, {}, { model: 'opus', extra: 1 }, null]) {
    await assert.rejects(changeBoardModel('shop', bad, { tmux, live: running('idle') }), { status: 400 });
  }
  assert.equal(readManifest().sites.shop.owner.model, 'sonnet');
});

test("the hub board's idle session gets /model typed into its tmux pane at once; busy or not running, the change waits for its next start", async () => {
  fixture({ hub: true });
  const idle = tmuxCalls();
  assert.deepEqual(await changeBoardModel('shop', { model: 'sonnet' }, { tmux: idle.tmux, live: running('idle') }), { model: 'sonnet', applies: 'now' });
  const target = `=${tmuxName('shop')}:`;
  assert.deepEqual(idle.calls, [['send-keys', '-t', target, '-l', '/model sonnet'], ['send-keys', '-t', target, 'Enter']]);
  for (const live of [running('busy'), () => new Map()]) {
    const later = tmuxCalls();
    assert.deepEqual(await changeBoardModel('shop', { model: 'opus' }, { tmux: later.tmux, live }), { model: 'opus', applies: 'next start' });
    assert.deepEqual(later.calls, []);
  }
  const refused = { tmux: () => ({ status: 1, stdout: '', stderr: 'no pane' }) };
  assert.deepEqual(await changeBoardModel('shop', { model: 'sonnet' }, { ...refused, live: running('idle') }), { model: 'sonnet', applies: 'next start' });
  assert.equal(readManifest().sites.shop.owner.model, 'sonnet');
});

test("Restart the session now stops a headless board's session and starts a fresh one on its model that rejoins the board, taking over its owner record and watcher cursor", async () => {
  const { dir } = fixture({ model: 'sonnet' });
  fs.writeFileSync(path.join(dir, 'data', `.watch-cursor-${OLD}.json`), JSON.stringify({ 'data/events.jsonl': 4 }));
  let live = new Map([[OLD, { pid: 1, sessionId: OLD, kind: 'bg', jobId: OLD.slice(0, 8) }]]);
  const steps = [];
  const fresh = crypto.randomUUID();
  const run = async (argv, { cwd }) => {
    steps.push(['run', argv, cwd]);
    fs.writeFileSync(path.join(sessionsDir, `${fresh}.json`), JSON.stringify({ pid: 2, sessionId: fresh, jobId: fresh.slice(0, 8) }));
    return { status: 0, stdout: `backgrounded · ${fresh.slice(0, 8)} · Shop\n`, stderr: '' };
  };
  const stop = async (record) => { steps.push(['stop', record.sessionId]); live = new Map(); };
  const r = await restartOnModel('shop', { live: () => live, stop, run });
  assert.deepEqual(steps, [['stop', OLD], ['run', ['--bg', '--name', 'Shop', '--permission-mode', 'auto', '--settings', BG_SETTINGS, '--model', 'sonnet', "/kickflip board 'Shop'"], repo]]);
  assert.deepEqual(r, { route: 'shop', session: fresh, previous: OLD, model: 'sonnet' });
  assert.deepEqual(readManifest().sites.shop.owner, { session: fresh, label: 'Shop owner', since: '2026-11-01T00:00:00Z', repo, model: 'sonnet' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', `.watch-cursor-${fresh}.json`), 'utf8')), { 'data/events.jsonl': 4 });
});

test("Restart the session now is refused on the hub board, whose session takes /model in its pane", async () => {
  fixture({ hub: true });
  await assert.rejects(restartOnModel('shop', { live: () => new Map(), stop: async () => assert.fail('stopped'), run: async () => assert.fail('ran') }), { status: 409 });
});
