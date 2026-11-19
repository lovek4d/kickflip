import { home } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { advance, calls, clock, commit, fakeRelays, freePort, git, kill, listing, manager, manifest, prober, read, relayOf, repo, script, setManager, setScript, site, start, state, tick, tryManager, until, visit, worktree, write } from './try-fixture.mjs';

const mainDir = (side) => path.join(home, '.claude/kickflip/try', `orch-main-${side}`);
const mainPortScript = (port) => setScript(`console.log('port ${port}'); setInterval(() => {}, 1000);`, repo);
function mainCommit(name) {
  const sha = commit(repo, name);
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha);
  return sha;
}

test('a main re-serve keeps the old server on its port until the new one answers, then hands the port over and stops the old one, building in alternating worktrees', async (t) => {
  const relays = fakeRelays(t);
  const answering = new Set([32123]);
  const { answers, asked } = prober((port) => answering.has(port));
  setManager(tryManager({ now: () => clock, answers, log() {} }));
  // A hub from before the alternating worktrees left one Main worktree; the next build removes it.
  git(repo, 'worktree', 'add', '--quiet', '--detach', path.join(home, '.claude/kickflip/try/orch-main'), 'HEAD');
  mainPortScript(32123);
  const first = mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main')), false);
  assert.equal(git(mainDir('a'), 'rev-parse', 'HEAD'), first);
  const at = state().main.at;
  mainPortScript(32124);
  const second = mainCommit('second');
  await tick();
  await asked(32124);
  assert.equal(git(mainDir('b'), 'rev-parse', 'HEAD'), second);
  assert.equal(git(mainDir('a'), 'rev-parse', 'HEAD'), first);
  assert.equal(state().main.state, 'running');
  assert.equal(state().main.sha, second);
  assert.deepEqual(state().main.serving, { sha: first, at, https: 8500 });
  assert.equal(relayOf(8500), 'http://127.0.0.1:49000');
  assert.equal(relays[0].closed, undefined);
  answering.add(32124);
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(state().main.serving, undefined);
  assert.equal(state().main.https, 8500);
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32124);
  assert.equal(relayOf(8500), 'http://127.0.0.1:49001');
  assert.ok(relays[0].closed);
  assert.ok(!calls().includes('serve --https=8500 off'), 'the old run leaves the port its successor holds');
  assert.equal(read(path.join(home, 'tailscale.status')).Web['mac.ts.net:8500'].Handlers['/'].Proxy, 'http://127.0.0.1:49001');
  await tick();
  assert.equal(relayOf(8500), 'http://127.0.0.1:49001');
  answering.add(32125);
  mainPortScript(32125);
  const third = mainCommit('third');
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.sha], ['ready', third]);
  assert.equal(git(mainDir('a'), 'rev-parse', 'HEAD'), third);
  assert.equal(git(mainDir('b'), 'rev-parse', 'HEAD'), second);
  assert.ok(relays[1].closed);
  // A hub stops every server it started, so the next hub's try.json names no old server.
  mainPortScript(32126);
  mainCommit('fourth');
  await tick();
  assert.equal(state().main.serving.https, 8500);
  await manager.stop();
  assert.ok(relays.every((relay) => relay.closed));
  setManager(tryManager({ now: () => clock, answers: async () => false, log() {} }));
  await manager.initialize(manifest);
  assert.equal(state().main.serving, undefined);
});

test("a main re-serve's relay takes the try port over from the old run's once the new server answers", async () => {
  const relayAt = await freePort();
  const ports = [await freePort(), await freePort()];
  const answering = new Set([ports[0]]);
  const { answers, asked } = prober((port) => answering.has(port));
  setManager(tryManager({ now: () => clock, answers, log() {}, relayPort: () => relayAt }));
  const serves = (port, body) => setScript(`require('node:http').createServer((req, res) => res.end('${body}')).listen(${port}, '127.0.0.1', () => console.log('port ${port}'));`, repo);
  serves(ports[0], 'first');
  mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(await visit(`http://127.0.0.1:${relayAt}/`), 'first');
  serves(ports[1], 'second');
  mainCommit('second');
  await tick();
  await asked(ports[1]);
  assert.equal(await visit(`http://127.0.0.1:${relayAt}/`), 'first', 'the old run keeps the port while the new one starts');
  answering.add(ports[1]);
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.https, state().main.serving], ['ready', 8500, undefined]);
  assert.equal(await visit(`http://127.0.0.1:${relayAt}/`), 'second');
});

test('a build that prints the old main server’s port stops the old server before probing', async (t) => {
  const relays = fakeRelays(t);
  const probes = [];
  setManager(tryManager({ now: () => clock, answers: async (port) => { probes.push([port, Boolean(relays[0]?.closed)]); return true; }, log() {} }));
  mainPortScript(32123);
  mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  probes.length = 0;
  write(path.join(repo, 'file'), 'same port');
  const same = mainCommit('same port');
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.sha], ['ready', same]);
  assert.ok(probes.length);
  assert.ok(probes.every(([port, stopped]) => port === 32123 && stopped), 'the old server is gone before the new port is probed');
  assert.equal(state().main.serving, undefined);
  assert.equal(relayOf(8500), 'http://127.0.0.1:49001');
  assert.equal(read(path.join(home, 'tailscale.status')).Web['mac.ts.net:8500'].Handlers['/'].Proxy, 'http://127.0.0.1:49001');
});

// A dev server that allows one server per project, as next dev does: it exits while another of its servers runs.
const oneServerScript = (port) => setScript(`const fs = require('node:fs');
const lock = require('node:path').join(process.env.HOME, 'main.lock');
let other = 0, dir = '';
try { [other, dir] = fs.readFileSync(lock, 'utf8').split('\\n'); process.kill(Number(other), 0); } catch { other = 0; }
if (other) { console.log('Another dev server is already running. PID: ' + other + ' Dir: ' + dir); process.exit(1); }
fs.writeFileSync(lock, process.pid + '\\n' + process.cwd());
console.log('port ${port}');
setInterval(() => {}, 1000);`, repo);

test('a main serve that is refused beside the old one stops the old serve and serves once more in the same worktree, and one that fails on its own leaves the old one serving', async (t) => {
  const relays = fakeRelays(t);
  const logs = [];
  setManager(tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line) }));
  oneServerScript(32123);
  const first = mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  oneServerScript(32124);
  const second = mainCommit('second');
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.sha], ['ready', second]);
  assert.equal(state().main.serving, undefined);
  assert.equal(state().main.https, 8500);
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32124);
  assert.equal(git(mainDir('b'), 'rev-parse', 'HEAD'), second);
  assert.equal(git(mainDir('a'), 'rev-parse', 'HEAD'), first);
  assert.ok(relays[0].closed);
  assert.equal(relayOf(8500), `http://127.0.0.1:${relays.at(-1).address().port}`);
  assert.ok(logs.includes(`try /orch main: the new serve refused to run beside the old one; stopped the old serve and serving again in ${mainDir('b')}`));
  assert.match(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8'), /^The new serve exited before answering while the old one served; stopped the old serve and serving again\.\n/);
  // A commit that fails on its own, naming no worktree, fails beside the serve that keeps answering.
  setScript('console.log("broken"); process.exit(3);', repo);
  const broken = mainCommit('broken');
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.sha], ['failed', broken]);
  assert.equal(state().main.serving.sha, second);
  assert.equal(logs.filter((line) => line.includes('refused to run beside the old one')).length, 1);
});

test('the single main worktree of a hub from before the pair has its servers stopped and is removed, even where git refuses to remove it', async (t) => {
  fakeRelays(t);
  const logs = [];
  // Not a worktree git knows, so git worktree remove refuses it; an old Main server still runs inside it, and another
  // runs elsewhere with a file inside it on its command line.
  const legacy = path.join(home, '.claude/kickflip/try/orch-main');
  write(path.join(legacy, 'server.js'), 'setInterval(() => {}, 1000);');
  const inside = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: legacy, detached: true, stdio: 'ignore' });
  const named = spawn(process.execPath, [path.join(legacy, 'server.js')], { cwd: home, detached: true, stdio: 'ignore' });
  t.after(() => { for (const child of [inside, named]) try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  setManager(tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line), run: listing([
    { pid: inside.pid, pgid: inside.pid, command: `${process.execPath} -e setInterval(() => {}, 1000)`, cwd: legacy },
    { pid: named.pid, pgid: named.pid, command: `${process.execPath} ${path.join(legacy, 'server.js')}`, cwd: home },
    { pid: process.pid, pgid: process.pid, command: process.execPath, cwd: home }]) }));
  const ended = (child) => new Promise((resolve) => child.once('exit', resolve));
  const gone = Promise.all([ended(inside), ended(named)]);
  mainPortScript(32123);
  mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  await gone;
  assert.equal(fs.existsSync(legacy), false);
  for (const child of [inside, named]) assert.ok(logs.includes(`try /orch main: stopped pid ${child.pid} (pgid ${child.pid}) in the old main worktree ${legacy}`));
  assert.ok(logs.some((line) => line.startsWith(`try /orch main: git could not remove the old main worktree ${legacy}; removed the folder: `)));
});

test('a server left in the old single main worktree is stopped even after the folder was removed under it', async (t) => {
  fakeRelays(t);
  const logs = [];
  const legacy = path.join(home, '.claude/kickflip/try/orch-main');
  fs.mkdirSync(legacy, { recursive: true });
  const inside = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: legacy, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-inside.pid, 'SIGKILL'); } catch {} });
  const exited = new Promise((resolve) => inside.once('exit', resolve));
  await new Promise((resolve) => inside.once('spawn', resolve));
  fs.rmSync(legacy, { recursive: true, force: true });
  // lsof names a removed cwd by its old path.
  setManager(tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line), run: listing([
    { pid: inside.pid, pgid: inside.pid, command: `${process.execPath} -e setInterval(() => {}, 1000)`, cwd: legacy }]) }));
  mainPortScript(32123);
  mainCommit('first');
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  await exited;
  assert.ok(logs.includes(`try /orch main: stopped pid ${inside.pid} (pgid ${inside.pid}) in the old main worktree ${legacy}`));
  assert.ok(!logs.some((line) => line.includes('could not remove the old main worktree')));
});

test("a local board's main builds the tip of its recorded branch in its folder, not a branch called main", async () => {
  git(repo, 'switch', '--quiet', '-c', 'trunk');
  setScript('process.exit(0);', repo);
  const sha = commit(repo, 'trunk script');
  git(repo, 'switch', '--quiet', 'main');
  Object.assign(manifest.sites.orch, { local: true, branch: 'trunk' });
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.deepEqual([state().main.sha, state().main.branch], [sha, 'trunk']);
});

test('main keeps its fixed port across merges and restart, never idles out and uses the recorded branch and origin slug', async (t) => {
  const relays = fakeRelays(t);
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);", repo);
  const sha = commit(repo, 'web main');
  // With no github, the board builds locally: from its folder's own develop.
  git(repo, 'branch', '--force', 'develop', sha);
  manifest.sites.orch.branch = 'develop';
  delete manifest.sites.orch.github;
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(state().main.slug, 'example/project');
  assert.equal(state().main.branch, 'develop');
  assert.equal(state().main_port, 8500);
  assert.equal(state().main.https, 8500);
  setScript("console.log('port 32124'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].https, 8501);
  write(path.join(repo, 'file'), 'merged');
  const merged = commit(repo, 'merge');
  git(repo, 'branch', '--force', 'develop', merged);
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(state().main.sha, merged);
  assert.equal(state().main.https, 8500);
  advance(60 * 60_000);
  await tick();
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32123);
  await manager.stop();
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  await manager.initialize(manifest);
  assert.equal(state().main.state, undefined);
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(manager.lookup('orch', 'main', { manifest }).port, 32123);
  assert.equal(state().main_port, 8500);
  assert.equal(state().main.https, 8500);
  await manager.stop();
  assert.ok(relays.every((relay) => relay.closed));
});
