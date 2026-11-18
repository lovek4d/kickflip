// docs/adr/2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md: every board's session runs on Hub settings'
// Orchestrators, and no board overrides it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('orchestrator-model-'));
process.env.HOME = home;
const { readOrchestratorModel, setOrchestratorModel } = await import('../shared/hub-settings.mjs');
const { startArgv, resumeArgv, hubArgv, changeOrchestratorModel, tmuxName } = await import('./sessions.mjs');
const { saveJSON } = await import('./boards.mjs');
const web = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const repo = path.join(home, 'repo');
fs.mkdirSync(repo, { recursive: true });
const OLD = '11111111-1111-1111-1111-111111111111';

// model is an owner record's old orchestrator model, which nothing reads.
function fixture({ hub = false, model } = {}) {
  const dir = web('sites', 'shop');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const owner = { session: OLD, label: 'Shop owner', since: '2026-11-01T00:00:00Z', repo, ...(model ? { model } : {}) };
  const site = { dir, cmd: ['node', 'board/server.mjs', dir], port: 49001, title: 'Shop', watch: ['data/events.jsonl'], ...(hub ? { hub: true } : {}), owner };
  saveJSON(web('manifest.json'), { version: 1, sites: { shop: site } });
}
const tmuxCalls = () => {
  const calls = [];
  return { calls, tmux: (argv) => { calls.push(argv); return { status: 0, stdout: '', stderr: '' }; } };
};
const running = (status) => () => new Map([[OLD, { pid: 1, sessionId: OLD, kind: 'fg', status }]]);
const flag = (argv) => argv[argv.indexOf('--model') + 1];

test("every start, resume and hub board session runs on Hub settings' Orchestrators, Opus until it says Sonnet, whatever model a caller passes", async () => {
  for (const value of ['opus', 'sonnet']) {
    await setOrchestratorModel(value, home);
    const other = value === 'opus' ? 'sonnet' : 'opus';
    assert.equal(flag(startArgv({ route: 'shop', name: 'Shop', model: other })), value);
    assert.equal(flag(resumeArgv({ id: OLD, route: 'shop', name: 'Shop', model: other, background: false })), value);
    assert.equal(flag(hubArgv({ route: 'shop', title: 'Shop', id: OLD, model: other })), value);
  }
  fs.rmSync(web('settings.json'));
  assert.equal(flag(startArgv({ route: 'shop', name: 'Shop' })), 'opus');
});

test("a change of Hub settings' Orchestrators is saved, and reaches the hub board's idle session at once, an old owner model or not; busy, at its next start", async () => {
  fixture({ hub: true, model: 'sonnet' });
  const idle = tmuxCalls();
  assert.deepEqual(await changeOrchestratorModel('opus', { tmux: idle.tmux, live: running('idle') }), { model: 'opus', applies: 'now' });
  const target = `=${tmuxName('shop')}:`;
  assert.deepEqual(idle.calls, [['send-keys', '-t', target, '-l', '/model opus'], ['send-keys', '-t', target, 'Enter']]);
  assert.equal(readOrchestratorModel(home), 'opus');
  const busy = tmuxCalls();
  assert.deepEqual(await changeOrchestratorModel('sonnet', { tmux: busy.tmux, live: running('busy') }), { model: 'sonnet', applies: 'next start' });
  assert.deepEqual(busy.calls, []);
  const refused = { tmux: () => ({ status: 1, stdout: '', stderr: 'no pane' }) };
  assert.equal((await changeOrchestratorModel('opus', { ...refused, live: running('idle') })).applies, 'next start');
  fixture();
  const none = tmuxCalls();
  assert.deepEqual(await changeOrchestratorModel('sonnet', { tmux: none.tmux, live: running('idle') }), { model: 'sonnet', applies: null });
  assert.deepEqual(none.calls, []);
  await assert.rejects(() => changeOrchestratorModel('auto', { tmux: none.tmux, live: running('idle') }), { status: 400, message: 'orchestrator-model takes opus or sonnet' });
  assert.equal(readOrchestratorModel(home), 'sonnet');
});
