import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('board-model-'));
process.env.HOME = home;
const { boardModel, changeBoardModel, changeHubOrchestratorModel, restartOnModel } = await import('./board-model.mjs');
const { readOrchestratorModel, setOrchestratorModel } = await import('../shared/hub-settings.mjs');
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

const hubChoice = async (value) => setOrchestratorModel(value, home);
const choice = (view) => view.choices.find((c) => c.on).value;
const flag = (argv) => argv[argv.indexOf('--model') + 1];

test("a session with no model recorded starts, and the hub board resumes, on Hub settings' Orchestrators, Opus until it says Sonnet", async () => {
  for (const value of ['opus', 'sonnet']) {
    await hubChoice(value);
    assert.equal(flag(startArgv({ route: 'shop', name: 'Shop' })), value);
    assert.equal(flag(hubArgv({ route: 'shop', title: 'Shop', id: OLD })), value);
    assert.equal(flag(startArgv({ route: 'shop', name: 'Shop', model: value === 'opus' ? 'sonnet' : 'opus' })), value === 'opus' ? 'sonnet' : 'opus');
  }
  fs.rmSync(web('settings.json'));
  assert.equal(flag(startArgv({ route: 'shop', name: 'Shop' })), 'opus');
});

test("a board's Orchestrators reads Hub default with no model recorded, else its override, and a page that isn't a board has none", async () => {
  await hubChoice('sonnet');
  fixture();
  const { orchestrators, hub } = boardModel('shop');
  assert.deepEqual([orchestrators.label, orchestrators.choices.map((c) => c.label), choice(orchestrators), orchestrators.description, hub],
    ['Orchestrators', ['Hub default (Sonnet)', 'Opus', 'Sonnet'], 'hub', 'Follows Hub settings: Sonnet.', false]);
  fixture({ model: 'opus', hub: true });
  assert.deepEqual([choice(boardModel('shop').orchestrators), boardModel('shop').orchestrators.description, boardModel('shop').hub],
    ['opus', 'This board’s own session runs on Opus, whatever Hub settings pick.', true]);
  assert.throws(() => boardModel('page'), { status: 404 });
  await hubChoice('opus');
});

test("a headless board's override is kept on its owner record for the next new session, Hub default drops it, and nothing is typed anywhere", async () => {
  fixture();
  const { calls, tmux } = tmuxCalls();
  const sonnet = await changeBoardModel('shop', { model: 'sonnet' }, { tmux, live: running('idle') });
  assert.deepEqual([choice(sonnet.orchestrators), sonnet.applies], ['sonnet', 'new session']);
  assert.deepEqual(readManifest().sites.shop.owner, { session: OLD, label: 'Shop owner', since: '2026-11-01T00:00:00Z', repo, model: 'sonnet' });
  for (const bad of [{ model: 'haiku' }, { model: 'hub' }, {}, { model: 'opus', extra: 1 }, null]) {
    await assert.rejects(changeBoardModel('shop', bad, { tmux, live: running('idle') }), { status: 400 });
  }
  assert.equal(readManifest().sites.shop.owner.model, 'sonnet');
  const back = await changeBoardModel('shop', { model: null }, { tmux, live: running('idle') });
  assert.deepEqual([choice(back.orchestrators), back.applies], ['hub', 'new session']);
  assert.deepEqual(readManifest().sites.shop.owner, { session: OLD, label: 'Shop owner', since: '2026-11-01T00:00:00Z', repo });
  assert.deepEqual(calls, []);
});

test("the hub board's idle session gets /model typed into its tmux pane at once, the hub's model for Hub default; busy or not running, the change waits for its next start", async () => {
  fixture({ hub: true });
  const idle = tmuxCalls();
  assert.equal((await changeBoardModel('shop', { model: 'sonnet' }, { tmux: idle.tmux, live: running('idle') })).applies, 'now');
  assert.equal((await changeBoardModel('shop', { model: null }, { tmux: idle.tmux, live: running('idle') })).applies, 'now');
  const target = `=${tmuxName('shop')}:`;
  assert.deepEqual(idle.calls, [['send-keys', '-t', target, '-l', '/model sonnet'], ['send-keys', '-t', target, 'Enter'], ['send-keys', '-t', target, '-l', '/model opus'], ['send-keys', '-t', target, 'Enter']]);
  for (const live of [running('busy'), () => new Map()]) {
    const later = tmuxCalls();
    assert.equal((await changeBoardModel('shop', { model: 'opus' }, { tmux: later.tmux, live })).applies, 'next start');
    assert.deepEqual(later.calls, []);
  }
  const refused = { tmux: () => ({ status: 1, stdout: '', stderr: 'no pane' }) };
  assert.equal((await changeBoardModel('shop', { model: 'sonnet' }, { ...refused, live: running('idle') })).applies, 'next start');
  assert.equal(readManifest().sites.shop.owner.model, 'sonnet');
});

test("a change of Hub settings' Orchestrators is saved, and reaches the hub board's idle session at once only while that board is on Hub default", async () => {
  fixture({ hub: true });
  const idle = tmuxCalls();
  assert.deepEqual(await changeHubOrchestratorModel('sonnet', { tmux: idle.tmux, live: running('idle') }), { model: 'sonnet', applies: 'now' });
  assert.deepEqual(idle.calls.map((c) => c.at(-1)), ['/model sonnet', 'Enter']);
  assert.equal(readOrchestratorModel(home), 'sonnet');
  assert.equal((await changeHubOrchestratorModel('opus', { tmux: idle.tmux, live: running('busy') })).applies, 'next start');
  fixture({ hub: true, model: 'sonnet' });
  const pinned = tmuxCalls();
  assert.deepEqual(await changeHubOrchestratorModel('sonnet', { tmux: pinned.tmux, live: running('idle') }), { model: 'sonnet', applies: null });
  fixture();
  assert.deepEqual(await changeHubOrchestratorModel('opus', { tmux: pinned.tmux, live: running('idle') }), { model: 'opus', applies: null });
  assert.deepEqual(pinned.calls, []);
  await assert.rejects(() => changeHubOrchestratorModel('auto', { tmux: pinned.tmux, live: running('idle') }), { status: 400, message: 'orchestrator-model takes opus or sonnet' });
  assert.equal(readOrchestratorModel(home), 'opus');
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
