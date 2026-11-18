import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import * as runs from './runs.mjs';
import { launchBuilder } from './headless.mjs';
import { buildBoard } from './domain.mjs';
import { outsideData, readSnapshot } from './snapshot.mjs';
import { threadFile } from './store.mjs';

// docs/adr/2026-11-17-2345-a-board-launched-run-lives-in-one-runs-module.md
// A run's lifecycle through runs.mjs alone, with a fake launcher and no board server.

// The scratch HOME, emptied of what an earlier test left.
function emptyHome() {
  for (const name of fs.readdirSync(home)) fs.rmSync(path.join(home, name), { recursive: true, force: true });
  return home;
}

// The agents launched through launch, in order in runs, each {kind, model, cwd, prompt, pid, sessionId}. Each agent's
// process is a node, leading its own process group, that idles until gone(pid) ends it or the test ends; its log opens
// with the init event that names its session, as Claude's does.
function launcher(t) {
  const launched = [];
  const children = new Map();
  async function launch({ kind, model, cwd, prompt, log }) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
    children.set(child.pid, child);
    await once(child, 'spawn');
    const sessionId = `sess-${launched.length + 1}`;
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
    launched.push({ kind, model, cwd, prompt, pid: child.pid, sessionId });
    return { pid: child.pid, sessionId, log };
  }
  async function gone(pid) {
    const child = children.get(pid);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  t.after(() => Promise.all([...children.keys()].map(gone)));
  return { launched, launch, gone };
}

// A board "shop" (slug t) on a git repo, with items in its item file. → {site, data, repo}
function board(items) {
  emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(data, 'threads'));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const origin = path.join(home, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'base');
  const repo = path.join(home, 'clone');
  git(home, 'clone', '--quiet', origin, repo);
  const kickflip = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(kickflip, { recursive: true });
  fs.writeFileSync(path.join(kickflip, 'manifest.json'), JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items }));
  return { site, data, repo };
}

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const built = (site) => async () => buildBoard(await readSnapshot(site, await outsideData(site), { items: true })).items;
const lines = (site, key) => fs.readFileSync(threadFile(site, key), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test("a build's run starts, reads alive, is relaunched once when its process dies, and is handed back the second time", async (t) => {
  const { site, data } = board([{ id: 'B1', title: 'fix(board): one', lane: 'progress' }]);
  const { launched, launch, gone } = launcher(t);
  const logged = [];
  const io = { launch, log: (entry) => logged.push(entry) };
  const tracked = () => readJSON(path.join(data, 'headless-builders.json'))['t/B1'];

  const { started } = await runs.start(site, 't/B1', 'build', io);
  assert.equal(runs.startResult(started), 'started');
  assert.equal(launched.length, 1, 'the build launches its builder');
  assert.match(launched[0].prompt, /builder start t\/B1 --kind build/);
  assert.deepEqual([tracked().pid, tracked().relaunched], [launched[0].pid, false]);
  assert.equal((await runs.alive(site))['t/B1'], true);

  await runs.revive(site, built(site), io);
  assert.equal(launched.length, 1, 'a live builder is left running');

  await gone(launched[0].pid);
  await runs.revive(site, built(site), io);
  assert.equal(launched.length, 2, 'its first exit with the record open relaunches it');
  assert.deepEqual([tracked().pid, tracked().relaunched], [launched[1].pid, true]);
  assert.equal(logged.find((e) => e.call === 'relaunch')?.result, 'relaunched');

  await gone(launched[1].pid);
  await runs.revive(site, built(site), io);
  assert.equal(launched.length, 2, 'its second exit launches nothing');
  assert.equal(tracked().handedBack, true);
  assert.equal((await runs.alive(site))['t/B1'], false, 'the card reads its run stopped');
  assert.ok(lines(site, 't/B1').some((m) => m.line === 'exited-twice'));
});

test('stop with kill stops the board-launched builder and marks it, so revive never relaunches it; stop without kill closes the record', async (t) => {
  const { site, data } = board([{ id: 'S1', title: 'fix(board): stop me', lane: 'progress' }, { id: 'S2', title: 'fix(board): close me', lane: 'progress' }]);
  const { launched, launch } = launcher(t);
  const io = { launch };
  await runs.start(site, 't/S1', 'build', io);
  const { pid } = launched[0];

  const { lines: said } = await runs.stop(site, 't/S1', { kill: true, grace: 2000 });
  assert.match(said[0], /: build stopped by orchestrator$/);
  assert.ok(said.some((l) => l.startsWith(`stopped ${pid} `)), said.join('\n'));
  assert.throws(() => process.kill(pid, 0), 'its process is gone');
  assert.ok(lines(site, 't/S1').some((m) => m.line === 'run-stopped'));

  await runs.revive(site, built(site), io);
  assert.equal(launched.length, 1, 'a stopped run is never relaunched');
  assert.equal(readJSON(path.join(data, 'headless-builders.json'))['t/S1'].handedBack, true);
  await assert.rejects(runs.stop(site, 't/S1', { kill: true }), /isn't running/);

  await runs.start(site, 't/S2', 'build', io);
  const file = await runs.stop(site, 't/S2', { note: 'Closed by hand' });
  assert.equal(readJSON(file).note, 'Closed by hand');
  assert.equal(typeof readJSON(file).done, 'string', 'the record is closed');
});

test("tick launches a verified card's lander, relaunches it fresh once when it exits, and hands it back the second time", async (t) => {
  const { site, data, repo } = board([{ id: 'H1', title: 'fix(board): verified', lane: 'progress' }]);
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(data, 'agents', 'H1.json'), JSON.stringify({ started: '2026-11-13T20:00:00.000Z', done: '2026-11-13T21:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-13T20:30:00.000Z', text: 'Kept it small' }], handed_back: '2026-11-13T21:00:00.000Z', verified: { at: '2026-11-14T03:54:50.052Z' }, worktree: { path: worktree, branch: 'H1', repo } }));
  const { launched, launch, gone } = launcher(t);
  const io = { launch };
  const landers = () => readJSON(path.join(data, 'landers.json'))['t/H1'];
  const tick = async () => runs.tick(site, buildBoard(await readSnapshot(site, await outsideData(site))).items, io);

  assert.deepEqual(await tick(), { held: false });
  assert.equal(launched.length, 1, 'the verified card gets its lander');
  assert.deepEqual([landers().pid, landers().relaunched], [launched[0].pid, 0]);
  assert.equal((await runs.alive(site))['t/H1'], true);

  await gone(launched[0].pid);
  await tick();
  assert.equal(launched.length, 2, 'its first exit relaunches it');
  assert.match(launched[1].prompt, /You are the headless lander/, 'as a fresh lander');
  assert.equal(landers().relaunched, 1);

  await gone(launched[1].pid);
  await tick();
  assert.equal(launched.length, 2, 'its second exit launches nothing');
  assert.equal(landers().handedBack, true);
  assert.deepEqual(lines(site, 't/H1').filter((m) => m.line === 'exited-twice').map((m) => m.text), ['Its lander exited twice unfinished; it waits on the orchestrator.']);
});

test('restartLander drops the lander entry so the next tick launches it as a first, and refuses a card with no lander', async (t) => {
  const { site, data } = board([{ id: 'R1', title: 'fix(board): restart', lane: 'progress' }]);
  fs.writeFileSync(path.join(data, 'landers.json'), JSON.stringify({ 't/R1': { verified: 'v1', pid: 2 ** 22 + 12345, relaunched: 1, handedBack: true } }));
  await runs.restartLander(site, 't/R1');
  assert.equal(readJSON(path.join(data, 'landers.json'))['t/R1'], undefined);
  await assert.rejects(runs.restartLander(site, 't/R1'), /has no open builder and no lander/);
});

test("finish closes a helper's record with its result as the note, and refuses a builder's --text", async (t) => {
  const { site, data } = board([{ id: 'F1', title: 'fix(board): finish', lane: 'progress', next: 'Land it' }]);
  fs.writeFileSync(path.join(data, 'agents', 'F1@scan.json'), JSON.stringify({ started: '2026-11-17T10:00:00.000Z', kind: 'helper', label: 'Helper scan', task: 'Scan the files' }));
  fs.writeFileSync(path.join(data, 'agents', 'F1.json'), JSON.stringify({ started: '2026-11-17T09:00:00.000Z', kind: 'claude' }));
  class Usage extends Error {}
  const { file } = { file: await runs.finish(site, 't/F1', { agent: 'scan', text: 'Found two callers' }, { usage: Usage }) };
  assert.deepEqual([readJSON(file).note, typeof readJSON(file).done], ['Found two callers', 'string']);
  await assert.rejects(runs.finish(site, 't/F1', { text: 'Done' }, { usage: Usage }), Usage);
});

// docs/adr/2026-11-18-2030-a-launch-is-one-exclusive-claim.md
test('two passes launching the same run at once spawn one agent, and a run whose process is gone launches once again, however many race', async (t) => {
  const { site } = board([{ id: 'C1', title: 'fix(board): claimed', lane: 'progress' }]);
  const { launched, launch, gone } = launcher(t);
  const results = await Promise.all([launchBuilder(site, { key: 't/C1' }, { launch }), launchBuilder(site, { key: 't/C1' }, { launch })]);
  assert.equal(launched.length, 1, 'two servers pulling one card spawn one builder');
  assert.deepEqual(results.map((r) => r === null).sort(), [false, true], 'the loser is told it launched nothing');

  assert.equal(await launchBuilder(site, { key: 't/C1' }, { launch }), null, 'a later pass finds the builder alive');
  await gone(launched[0].pid);
  const again = await Promise.all([launchBuilder(site, { key: 't/C1' }, { launch }), launchBuilder(site, { key: 't/C1' }, { launch })]);
  assert.equal(launched.length, 2, 'its dead claim is taken over by one pass only');
  assert.equal(again.filter(Boolean).length, 1);
});

test("each agent of a card is its own claim, and a stop or a closed record frees it so the card's next run launches", async (t) => {
  const { site } = board([{ id: 'C2', title: 'fix(board): claims', lane: 'progress' }]);
  const { launched, launch } = launcher(t);
  await launchBuilder(site, { key: 't/C2' }, { launch });
  await launchBuilder(site, { key: 't/C2', agent: 'helper-a', kind: 'helper' }, { launch });
  assert.equal(launched.length, 2, 'a helper beside the builder claims on its own');

  await runs.markStopped(site, 't/C2', 'build');
  await launchBuilder(site, { key: 't/C2' }, { launch });
  assert.equal(launched.length, 3, 'a stopped run frees its claim while its process still dies');

  await runs.abandonLaunch(site, 't/C2', 'the launch failed');
  await launchBuilder(site, { key: 't/C2' }, { launch });
  assert.equal(launched.length, 4, 'a launch given up frees its claim');
});

test('a launch that rejects frees its claim, so the next pass tries again', async (t) => {
  const { site } = board([{ id: 'C3', title: 'fix(board): rejects', lane: 'progress' }]);
  const { launched, launch } = launcher(t);
  await assert.rejects(launchBuilder(site, { key: 't/C3' }, { launch: async () => { throw new Error('spawn claude ENOENT'); } }), /ENOENT/);
  assert.ok(await launchBuilder(site, { key: 't/C3' }, { launch }));
  assert.equal(launched.length, 1);
});
