import { home } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { advance, clock, commit, fakeRelays, git, kill, listing, manager, manifest, ownerGate, prober, relayOf, repo, script, setManager, setScript, site, start, state, thread, tick, tryManager, visit, worktree, write } from './try-fixture.mjs';

test("the prototype serve's relay drops the headers that refuse a frame, and a card's relay keeps them", async () => {
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => ({ login: 'lovek4d@github', addresses: [] }), tailnet: () => true });
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {}, gate }));
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  const free = async () => {
    const server = http.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
  };
  const framed = (port) => `const s = require('node:http').createServer((q, r) => { r.setHeader('X-Frame-Options', 'SAMEORIGIN'); r.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'"); r.end('page'); });
  s.listen(${port}, '127.0.0.1', () => console.log('port ${port}'));`;
  setScript(framed(await free()), base);
  setScript(framed(await free()));
  write(path.join(site, 'data', 'owner.json'), { topics: [], items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', url: 'prototype-look.html?q=q1', options: [{ id: 'A', label: 'A' }] }] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [{ topic: 'look', title: 'Look', served: '/proto/look', takes: [{ key: 'A', label: 'A' }] }] });
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const proto = await fetch(relayOf(state().prototypes.https) + '/');
  assert.equal(proto.headers.get('x-frame-options'), null);
  assert.equal(proto.headers.get('content-security-policy'), "default-src 'self'");
  const card = await fetch(relayOf(state().cards['w/A1'].https) + '/');
  assert.equal(card.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(card.headers.get('content-security-policy'), /frame-ancestors/);
  await manager.stop();
  git(repo, 'worktree', 'remove', '--force', base);
});

// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
test("the board's base prototype worktree is served while an open question links a served round: never idle, back after a restart, stopped once resolved, and a failure waits for Try again", async (t) => {
  fakeRelays(t);
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  t.after(() => git(repo, 'worktree', 'remove', '--force', base));
  setScript("console.log('port 32125'); setInterval(() => {}, 1000);", base);
  const ownerFile = path.join(site, 'data', 'owner.json');
  const round = (extra = {}) => write(ownerFile, { topics: [], items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', url: 'prototype-look.html?q=q1', options: [{ id: 'A', label: 'A' }], ...extra }] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [{ topic: 'look', title: 'Look', served: '/proto/look', takes: [{ key: 'A', label: 'A' }] }] });
  await tick();
  assert.ok(!state().prototypes);
  round();
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  assert.equal(state().prototypes.https, 8500);
  advance(2 * 60 * 60_000);
  await tick();
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32125);
  await manager.stop();
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  await manager.initialize(manifest);
  assert.ok(!state().prototypes?.state);
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  round({ resolved: '2026-11-06T10:00:00Z' });
  advance(31 * 60_000);
  await tick();
  assert.ok(!state().prototypes);
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }), null);
  round();
  setScript('process.exit(3);', base);
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'failed');
  setScript("console.log('port 32126'); setInterval(() => {}, 1000);", base);
  await tick();
  assert.equal(state().prototypes.state, 'failed');
  await manager.start({ route: 'orch', key: 'prototypes' }, { manifest });
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32126);
  assert.match(fs.readFileSync(path.join(site, 'data', 'try', 'prototypes.log'), 'utf8'), /port 32126/);
  assert.deepEqual(thread(), []);
});

// docs/adr/2026-11-14-1446-a-prototype-pages-landing-shows-its-sites-start-steps.md
test("the base serve records its start step and each finished step's time, building → starting → opening → ready, and a failure keeps its step and error", async (t) => {
  fakeRelays(t);
  let up = false;
  const { answers, asked } = prober(() => up);
  setManager(tryManager({ now: () => clock, answers, log() {} }));
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  t.after(() => git(repo, 'worktree', 'remove', '--force', base));
  const go = path.join(home, 'base-go');
  fs.rmSync(go, { force: true });
  // The script prints its port once the test lets it, so the building step can be seen.
  setScript(`const fs = require('node:fs'); const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(wait); console.log('port 32127'); setInterval(() => {}, 1000); } }, 20);`, base);
  write(path.join(site, 'data', 'owner.json'), { topics: [], items: [] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [] });
  const started = new Date(clock).toISOString();
  await manager.start({ route: 'orch', key: 'prototypes' }, { manifest });
  assert.equal(state().prototypes.state, 'running');
  assert.deepEqual([state().prototypes.step, state().prototypes.stepAt, state().prototypes.steps], ['building', started, []]);
  advance(4000);
  fs.writeFileSync(go, '');
  await asked(32127);
  assert.equal(state().prototypes.step, 'starting');
  assert.equal(state().prototypes.stepAt, new Date(clock).toISOString());
  assert.deepEqual(state().prototypes.steps, [{ name: 'building', ms: 4000 }]);
  advance(2000);
  up = true;
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  assert.equal(state().prototypes.step, 'ready');
  assert.deepEqual(state().prototypes.steps, [{ name: 'building', ms: 4000 }, { name: 'starting', ms: 2000 }, { name: 'opening', ms: 0 }]);

  await manager.stop();
  up = false;
  const again = prober(() => up);
  setManager(tryManager({ now: () => clock, answers: again.answers, log() {} }));
  await manager.start({ route: 'orch', key: 'prototypes' }, { manifest });
  await again.asked(32127);
  assert.equal(state().prototypes.step, 'starting');
  assert.deepEqual(state().prototypes.steps, [{ name: 'building', ms: 0 }], 'a new run starts its steps again');
  advance(61_000);
  await manager.settled();
  assert.equal(state().prototypes.state, 'failed');
  assert.equal(state().prototypes.step, 'starting');
  assert.equal(state().prototypes.error, 'Nothing answered on the build script’s port within 60 seconds.');
});

// docs/adr/2026-11-07-1231-a-base-move-restarts-the-prototype-serve-and-a-demo-hub-never-restarts-itself.md
test("a move of the base worktree to a new commit restarts its serve on the same https port as a new run, and an unmoved base keeps its run", async (t) => {
  fakeRelays(t);
  const logs = [];
  setManager(tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line) }));
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  t.after(() => git(repo, 'worktree', 'remove', '--force', base));
  const counter = path.join(home, 'base-port');
  setScript(`const fs = require('node:fs'); const f = ${JSON.stringify(counter)}; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) + 1 : 32125;
fs.writeFileSync(f, String(n)); console.log('port ' + n); setInterval(() => {}, 1000);`, base);
  write(path.join(site, 'data', 'owner.json'), { topics: [], items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', url: 'prototype-look.html?q=q1', options: [{ id: 'A', label: 'A' }] }] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [{ topic: 'look', title: 'Look', served: '/proto/look', takes: [{ key: 'A', label: 'A' }] }] });
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  const first = state().prototypes;
  assert.ok(first.since);
  advance(60_000);
  await tick();
  assert.equal(state().prototypes.since, first.since);
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32125);

  write(path.join(repo, 'moved.txt'), 'moved');
  const moved = commit(repo, 'moved');
  git(base, 'checkout', '--quiet', '--detach', moved);
  advance(60_000);
  await tick();
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }).port, 32126);
  assert.equal(state().prototypes.https, first.https);
  assert.equal(state().prototypes.sha, moved);
  assert.notEqual(state().prototypes.since, first.since);
  assert.ok(logs.some((line) => line.includes(`prototypes: the base moved to ${moved.slice(0, 7)}; restarting its serve`)), logs.join('\n'));
});

test('a run’s process group is recorded in try.json while it runs and forgotten once it ends', async () => {
  const { answers, asked } = prober(() => false);
  setManager(tryManager({ now: () => clock, answers, log() {} }));
  setScript(`console.log('port ' + 1); setInterval(() => {}, 1000);`);
  await start();
  await asked(1);
  assert.deepEqual(state().groups[0], { pgid: state().groups[0].pgid, key: 'w/A1', worktree, port: 1 });
  await manager.stop();
  assert.equal(state().groups, undefined);
});

test('a hub that died hard stops a recorded group still running its script at startup, and leaves one outside the worktree', async (t) => {
  const logs = [];
  const leftover = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: worktree, detached: true, stdio: 'ignore' });
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: home, detached: true, stdio: 'ignore' });
  t.after(() => { for (const child of [leftover, stranger]) try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const command = `${process.execPath} -e setInterval(() => {}, 1000)`;
  setManager(tryManager({ now: () => clock, log: (line) => logs.push(line), run: listing([
    { pid: leftover.pid, pgid: leftover.pid, command, cwd: worktree }, { pid: stranger.pid, pgid: stranger.pid, command, cwd: home }]) }));
  write(path.join(site, 'data/try.json'), { kind: 'app', cards: { 'w/A1': { state: 'running' } }, main: null, groups: [
    { pgid: leftover.pid, key: 'w/A1', worktree }, { pgid: stranger.pid, key: 'w/A2', worktree }, { pgid: 2 ** 22 - 1, key: 'w/A3', worktree }] });
  await manager.initialize(manifest);
  assert.throws(() => process.kill(-leftover.pid, 0));
  assert.doesNotThrow(() => process.kill(-stranger.pid, 0));
  assert.ok(logs.includes(`stopped leftover try /orch w/A1 (pgid ${leftover.pid})`));
  assert.equal(state().groups, undefined);
});

test('a stopped leftover whose port still answers posts a red fault on its card', async (t) => {
  const leftover = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: worktree, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-leftover.pid, 'SIGKILL'); } catch {} });
  setManager(tryManager({ now: () => clock, log() {}, lingers: async () => true, run: listing([
    { pid: leftover.pid, pgid: leftover.pid, command: `${process.execPath} -e setInterval(() => {}, 1000)`, cwd: worktree }]) }));
  write(path.join(site, 'data/try.json'), { kind: 'app', cards: {}, main: null, groups: [{ pgid: leftover.pid, key: 'w/A1', worktree, port: 4321 }] });
  await manager.initialize(manifest);
  assert.match(JSON.stringify(thread()), /Port 4321 still answers after the run was stopped/);
});

// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
test("with no open question the base serve stays up for 30 minutes after a viewer's ask: an ask on a ready serve only stamps the visit, and a stale one lets it stop", async (t) => {
  fakeRelays(t);
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  const base = path.join(home, '.claude', 'kickflip', 'worktrees', 'orch-prototypes');
  git(repo, 'worktree', 'add', '--quiet', '--detach', base, 'main');
  t.after(() => git(repo, 'worktree', 'remove', '--force', base));
  setScript("console.log('port 32125'); setInterval(() => {}, 1000);", base);
  write(path.join(site, 'data', 'owner.json'), { topics: [], items: [] });
  write(path.join(site, 'data', 'prototypes.json'), { prototypes: [] });
  await tick();
  assert.ok(!state().prototypes);
  await manager.start({ route: 'orch', key: 'prototypes' }, { manifest });
  await manager.settled();
  assert.equal(state().prototypes.state, 'ready');
  const first = state().prototypes;
  advance(20 * 60_000);
  await tick();
  assert.equal(state().prototypes.since, first.since, 'a recent ask keeps it');
  assert.deepEqual(await manager.start({ route: 'orch', key: 'prototypes' }, { manifest }), { status: 'ready' });
  assert.equal(state().prototypes.since, first.since, 'an ask on a ready serve does not restart it');
  advance(20 * 60_000);
  await tick();
  assert.equal(state().prototypes.since, first.since, 'the ask moved the 30 minutes on');
  advance(11 * 60_000);
  await tick();
  assert.ok(!state().prototypes, 'a stale ask stops it');
  assert.equal(manager.lookup('orch', 'prototypes', { manifest }), null);
});
