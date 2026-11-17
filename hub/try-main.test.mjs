import { home, bin, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { advance, calls, clock, commit, config, fakeRelays, fetchTryBranches, git, kill, listing, manager, manifest, ownerGate, prober, read, relayOf, repo, root, script, setManager, setScript, signal, signals, site, start, state, thread, tick, tryManager, until, untimed, worktree, write } from './try-fixture.mjs';

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

test('the poll fetches each non-hub board branch into its origin ref without a network service', async () => {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  setScript('process.exit(0);', repo);
  const sha = commit(repo, 'remote main');
  git(repo, 'push', '--quiet', 'origin', 'main:develop');
  manifest.sites.orch.branch = 'develop';
  await fetchTryBranches({ manifest, log() {} });
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/develop'), sha);
});

// A git ahead of the real one on PATH: its fetch runs the shell body first, and every other command is the real git.
async function withFetchGit(body, run) {
  const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  const dir = path.join(home, 'fetch-git');
  write(path.join(dir, 'git'), `#!/bin/sh\ncase " $* " in *" fetch "*) ${body} ;; esac\nexec ${real} "$@"\n`);
  fs.chmodSync(path.join(dir, 'git'), 0o700);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try { await run(); } finally { process.env.PATH = saved; }
}
const repoFetch = () => read(path.join(home, '.claude', 'kickflip', 'repo-fetch.json')).orch;

test('the poll fetches a GitHub board with git prompts off', async () => {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  write(path.join(repo, 'remote'), 'main');
  const sha = commit(repo, 'remote main');
  git(repo, 'push', '--quiet', 'origin', 'main');
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  await withFetchGit('[ "$GIT_TERMINAL_PROMPT" = 0 ] || exit 9',() => fetchTryBranches({ manifest, log() {} }));
  assert.equal(repoFetch().ok, true);
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), sha);
});

test('a GitHub board fetch git refuses records git\'s own error and the sign-in fix', async () => {
  const lines = [];
  await withFetchGit(`echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128`,
    () => fetchTryBranches({ manifest, log: (line) => lines.push(line) }));
  assert.deepEqual({ ...repoFetch(), at: undefined }, { at: undefined, ok: false,
    error: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    hint: "git's github.com login can't see example/project; run gh auth setup-git" });
  assert.match(lines[0], /^fetch \/orch after \d+ ms: Command failed/);
});

test("a merge's fetch reaches only the merged board and keeps the other boards' repo-fetch records", async () => {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  write(path.join(repo, 'file'), 'merged');
  const sha = commit(repo, 'merged on the remote');
  git(repo, 'push', '--quiet', 'origin', 'main:develop');
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/develop');
  manifest.sites.orch.branch = 'develop';
  const fetches = path.join(home, '.claude', 'kickflip', 'repo-fetch.json');
  write(fetches, { elsewhere: { at: 'earlier', ok: true } });
  await fetchTryBranches({ manifest, routes: ['elsewhere'], log() {} });
  assert.throws(() => git(repo, 'rev-parse', '--verify', 'refs/remotes/origin/develop'));
  await fetchTryBranches({ manifest, routes: ['orch'], log() {} });
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/develop'), sha);
  assert.deepEqual(Object.keys(read(fetches)).sort(), ['elsewhere', 'orch']);
  assert.equal(read(fetches).orch.ok, true);
  await fetchTryBranches({ manifest, log() {} });
  assert.deepEqual(Object.keys(read(fetches)), ['orch']);
});

test("a merge's Main refresh covers only its board and runs after a tick already going, never alongside it", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let checks = 0;
  let checking;
  const checked = new Promise((resolve) => { checking = resolve; });
  let inFlight = 0;
  let mostInFlight = 0;
  setManager(tryManager({ now: () => clock, log() {}, waiting: async () => {
    checks += 1;
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    if (checks === 1) { checking(); await held; }
    inFlight -= 1;
    return null;
  } }));
  await manager.tick({ manifest, routes: ['elsewhere'] });
  assert.equal(checks, 0);
  const running = manager.tick({ manifest });
  await checked;
  const shared = manager.tick({ manifest });
  const refresh = manager.tick({ manifest, routes: ['orch'] });
  const again = manager.tick({ manifest, routes: ['orch'] });
  assert.equal(checks, 1);
  release();
  await Promise.all([running, shared, refresh, again]);
  assert.equal(checks, 2);
  assert.equal(mostInFlight, 1);
});

test('on a plain git remote board the poll moves a pushed card to Done once its branch is merged or gone from the remote, and leaves an unmerged one In Review', async () => {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  const branch = (name, file) => { git(repo, 'switch', '--quiet', '-c', name, 'main'); write(path.join(repo, file), name); commit(repo, name); git(repo, 'push', '--quiet', 'origin', name); git(repo, 'switch', '--quiet', 'main'); };
  branch('merged-one', 'merged');
  branch('open-one', 'open');
  branch('dropped-one', 'dropped');
  git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'merged-one');
  git(repo, 'push', '--quiet', 'origin', 'main', ':merged-one', ':dropped-one');
  const pushed = (b) => ({ branch: b, at: '2026-11-02T10:00:00Z' });
  write(path.join(site, 'data', 'items.json'), { items: [{ id: 'A1', lane: 'review', pushed: pushed('merged-one') }, { id: 'A2', lane: 'review', pushed: pushed('open-one') }, { id: 'A3', lane: 'review', pushed: pushed('dropped-one') }] });
  delete manifest.sites.orch.github;
  manifest.sites.orch.remote = 'git@gitlab.example.com:acme/project.git';
  await fetchTryBranches({ manifest, log() {} });
  assert.deepEqual(read(path.join(site, 'data', 'items.json')).items.map((it) => it.lane), ['done', 'review', 'done']);
  assert.equal(thread().at(-1).text, 'merged-one is merged into main on gitlab.example.com, so this task is Done.');
  assert.equal(fs.readFileSync(path.join(site, 'data', 'threads', 'w__A3.jsonl'), 'utf8').includes('dropped-one is gone from gitlab.example.com, so this task is Done.'), true);
  git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'open-one');
  git(repo, 'push', '--quiet', 'origin', 'main');
  await fetchTryBranches({ manifest, log() {} });
  assert.equal(read(path.join(site, 'data', 'items.json')).items[1].lane, 'done');
});

// A local board whose folder's origin is a bare repo here, with a second clone that pushes to it. → push(file) commits
// file in that clone, pushes it to branch and answers the new tip.
function originFor(branch = 'main') {
  const remote = path.join(site, 'remote.git');
  git(repo, 'clone', '--quiet', '--bare', repo, remote);
  git(repo, 'remote', 'set-url', 'origin', remote);
  git(repo, 'fetch', '--quiet', 'origin');
  const other = path.join(site, 'other');
  git(site, 'clone', '--quiet', '--branch', branch, remote, other);
  Object.assign(manifest.sites.orch, { local: true, branch });
  return (file = 'pushed') => { write(path.join(other, file), file); commit(other, file); git(other, 'push', '--quiet', 'origin', branch); return git(other, 'rev-parse', 'HEAD'); };
}
const pullEvents = (options = {}) => { const events = []; setManager(tryManager({ now: () => clock, log() {}, event: async (board, kind, data) => { events.push([board.route, kind, data]); return 'e1'; }, ...options })); return events; };

test("the poll fast-forwards a local board's checked-out branch from origin, sends main-pulled, and leaves it alone when nothing is new", async () => {
  const push = originFor();
  const events = pullEvents();
  const from = git(repo, 'rev-parse', 'main');
  push('one');
  const to = push('two');
  assert.deepEqual(await manager.pullMains({ manifest }), ['orch']);
  assert.equal(git(repo, 'rev-parse', 'main'), to);
  assert.equal(fs.readFileSync(path.join(repo, 'two'), 'utf8'), 'two');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.deepEqual(events, [['orch', 'main-pulled', { branch: 'main', from, to, commits: 2 }]]);
  assert.deepEqual(Object.keys(state().pull), ['at']);
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(events.length, 1);
  assert.equal(state().pull.error, undefined);
});

test("a pull uses the board's recorded branch, and moves it without a checkout when no worktree has it", async () => {
  git(repo, 'branch', 'trunk');
  const push = originFor('trunk');
  const events = pullEvents();
  const tip = push();
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  const main = git(repo, 'rev-parse', 'main');
  assert.deepEqual(await manager.pullMains({ manifest }), ['orch']);
  assert.equal(git(repo, 'rev-parse', 'trunk'), tip);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.equal(events[0][2].branch, 'trunk');
});

test('a pull only fast-forwards: local changes, a split from origin or a failed fetch refuse with the reason and leave the branch', async () => {
  const push = originFor();
  const events = pullEvents();
  push();
  const before = git(repo, 'rev-parse', 'main');
  write(path.join(repo, 'file'), 'edited here');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull.error, 'can’t pull: local changes');
  assert.equal(git(repo, 'rev-parse', 'main'), before);
  git(repo, 'checkout', '--quiet', '--', 'file');

  write(path.join(repo, 'local'), 'local');
  commit(repo, 'local only');
  const split = git(repo, 'rev-parse', 'main');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull.error, 'can’t pull: main has split from origin');
  assert.equal(git(repo, 'rev-parse', 'main'), split);

  git(repo, 'reset', '--quiet', '--hard', 'refs/remotes/origin/main');
  write(path.join(repo, 'ahead'), 'ahead');
  const ahead = commit(repo, 'ahead of origin');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull.error, undefined);
  assert.equal(git(repo, 'rev-parse', 'main'), ahead);

  await withFetchGit(`echo "fatal: unable to access 'https://example.com/': Could not resolve host" >&2; exit 128`, () => manager.pullMains({ manifest }));
  assert.equal(state().pull.error, "can’t pull: fatal: unable to access 'https://example.com/': Could not resolve host");
  assert.deepEqual(events, []);
});

test("a board whose pull throws is logged and leaves the boards after it pulled", async () => {
  const push = originFor();
  const lines = [];
  setManager(tryManager({ now: () => clock, log: (...a) => lines.push(a.join(' ')), event: async () => 'e1' }));
  const broken = path.join(site, 'broken');
  fs.mkdirSync(path.join(broken, 'data', 'try.json'), { recursive: true });
  manifest.sites = { broken: { dir: broken, cmd: [process.execPath, path.join(root, 'board/server.mjs'), broken], port: 2, owner: { repo }, local: true }, orch: manifest.sites.orch };
  const to = push('after');
  assert.deepEqual(await manager.pullMains({ manifest }), ['orch']);
  assert.equal(git(repo, 'rev-parse', 'main'), to);
  assert.ok(lines.some((line) => line.startsWith('pull /broken failed:')), lines.join('\n'));
});

test("a board's own clone is reset hard to origin's branch on every poll, and a local folder with no origin has no pull record", async () => {
  const push = originFor();
  pullEvents();
  delete manifest.sites.orch.local;
  write(path.join(repo, 'file'), 'edited');
  write(path.join(repo, 'stray'), 'untracked');
  git(repo, 'commit', '--quiet', '-am', 'diverged here');
  const tip = push();
  assert.deepEqual(await manager.pullMains({ manifest }), ['orch']);
  assert.equal(git(repo, 'rev-parse', 'main'), tip);
  assert.equal(fs.existsSync(path.join(repo, 'stray')), false);
  assert.deepEqual(Object.keys(state().pull), ['at']);
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  manifest.sites.orch.local = true;
  git(repo, 'remote', 'remove', 'origin');
  assert.deepEqual(await manager.pullMains({ manifest }), []);
  assert.equal(state().pull, undefined);
});

test('the pull reads running while it fetches, which a restart clears', async () => {
  originFor();
  // The fetch holds until the test has read try.json.
  let fetching, release;
  const fetched = new Promise((resolve) => { fetching = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  pullEvents({ run: async (command, args, options) => {
    if (command === 'git' && args.includes('fetch')) { fetching(); await held; }
    return untimed(command, args, options);
  } });
  const pulling = manager.pullMains({ manifest });
  await fetched;
  assert.equal(state().pull.running, true);
  release();
  await pulling;
  assert.equal(state().pull.running, undefined);
  const record = { ...state(), pull: { at: 'earlier', running: true } };
  write(path.join(site, 'data', 'try.json'), record);
  await manager.stop();
  setManager(tryManager({ now: () => clock, log() {} }));
  await manager.initialize(manifest);
  assert.deepEqual(state().pull, { at: 'earlier' });
});

test("a tap pulls now and rebuilds Main only when the pull brought commits; it resets a clone's board too", async () => {
  setScript('process.exit(0);', repo);
  commit(repo, 'script');
  const push = originFor();
  pullEvents();
  await manager.tick({ manifest });
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  const built = state().main.sha;
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 0 });
  assert.equal(state().main.sha, built);
  const tip = push();
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 1 });
  await manager.settled();
  assert.deepEqual([state().main.sha, state().main.state], [tip, 'ready']);
  write(path.join(repo, 'file'), 'edited here');
  push('again');
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 0, error: 'can’t pull: local changes' });
  await assert.rejects(manager.pull({ route: 'orch', key: 'x' }, { manifest }), { status: 400 });
  await assert.rejects(manager.pull({ route: 'nope' }, { manifest }), { status: 404 });
  delete manifest.sites.orch.local;
  const next = push('more');
  assert.deepEqual(await manager.pull({ route: 'orch' }, { manifest }), { commits: 2 });
  assert.equal(git(repo, 'rev-parse', 'main'), next);
  assert.equal(state().pull.error, undefined);
  git(repo, 'remote', 'set-url', 'origin', path.join(site, 'gone.git'));
  assert.match((await manager.pull({ route: 'orch' }, { manifest })).error, /^can’t pull: /);
  assert.match(state().pull.error, /^can’t pull: /);
});

test('the hub build route enforces loopback and fixed inputs', async (t) => {
  setScript("require('node:http').createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', function () { console.log('port ' + this.address().port); });");
  const web = path.join(home, '.claude/kickflip');
  write(path.join(web, 'manifest.json'), manifest);
  write(path.join(web, 'settings.json'), { quiet: { start: '23:59', end: '00:00', hold: false } });
  const { port } = await inProcessHub(t);
  // Try builds wait until Tailscale serves the hub on the port it listens on (readiness.mjs), here this hub's.
  write(path.join(home, 'tailscale.status'), { Web: { 'mac.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });
  // Resolves once the board's try.json holds a ready w/A1. The hub's try manager replaces the file on each change, so
  // each change ends the watch on the file it replaced, and the wait watches the new one before it reads it again.
  const ready = () => new Promise((resolve) => {
    const file = path.join(site, 'data', 'try.json');
    const check = () => {
      const watcher = fs.watch(file, () => { watcher.close(); check(); });
      if (state().cards['w/A1']?.state === 'ready') { watcher.close(); resolve(); }
    };
    check();
  });
  // POSTs body to the hub's /_hub/<route> → its status code. http.request, not fetch, so a test can set Host.
  const call = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: `/_hub/${route}`, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
  const outside = [{ origin: 'https://mac.ts.net' }, { 'x-forwarded-for': '100.64.0.1' }, { host: 'mac.ts.net' }];
  const input = { route: 'orch', key: 'w/A1' };
  for (const headers of outside) assert.equal(await call('build', input, headers), 403);
  assert.equal(await call('build', { ...input, command: '/bin/sh' }), 400);
  assert.equal(await call('build', { ...input, key: 'main' }), 409);
  assert.equal(await call('build', input), 202);
  await ready();
  for (const headers of outside) assert.equal(await call('kill', input, headers), 403);
  assert.equal(await call('kill', { ...input, anyway: true }), 400);
  assert.equal(await call('kill', input), 200);
  assert.equal(state().cards['w/A1'].state, undefined);
  assert.equal(await call('kill', input), 409);
  for (const headers of outside) assert.equal(await call('pull', { route: 'orch' }, headers), 403);
  assert.equal(await call('pull', { route: 'orch', key: 'main' }), 400);
  assert.equal(await call('pull', { route: 'orch' }), 200);
});

test('a running script with no port fails after sixty minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setScript('setInterval(() => {}, 1000);');
  await start();
  t.mock.timers.tick(59 * 60_000);
  assert.equal(state().cards['w/A1'].state, 'running');
  t.mock.timers.tick(60_000);
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /No port line within 60 minutes/);
  t.mock.timers.reset();
});

test('an unanswered announced port fails after sixty seconds', async () => {
  const { answers, asked } = prober(() => false);
  setManager(tryManager({ now: () => clock, answers, log() {} }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await asked(32123);
  advance(61_000);
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /Nothing answered.*60 seconds/);
});

test('shutdown kills the whole process group, escalating when a server ignores SIGTERM, with no failure message, and refuses new starts', async () => {
  // No grace: the stop escalates to SIGKILL at once, which the server needs.
  setManager(tryManager({ now: () => clock, log() {}, grace: 0 }));
  const up = await signals();
  const server = `process.on('SIGTERM', () => {}); ${signal(up, 'server')} setInterval(() => {}, 1000);`;
  setScript(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);`);
  await start();
  const { closed } = await up.next();
  await manager.stop();
  // The server ignored SIGTERM, so its socket closes only once the SIGKILL reached it.
  await closed;
  assert.deepEqual(thread(), []);
  await assert.rejects(start(), /hub is stopping/);
});

test('an automatic validation refusal records one failed head and useful thread log, while a main failure survives restart', async () => {
  config({ auto_build: true });
  setScript('process.exit(0);');
  fs.chmodSync(script(), 0o600);
  const sha = commit(worktree, 'not executable');
  await tick();
  assert.equal(state().cards['w/A1'].sha, sha);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /^Build script must be executable/);
  await tick();
  assert.equal(thread().length, 1);
  setScript('process.exit(0);', repo);
  const mainSha = commit(repo, 'main script');
  git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
  await manager.stop();
  write(path.join(site, 'data/try.json'), { kind: 'web', cards: {}, main: { sha: mainSha, state: 'failed', script: true } });
  setManager(tryManager({ log() {} }));
  await manager.initialize(manifest);
  await tick();
  assert.equal(state().main.state, 'failed');
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main-a')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main-b')), false);
});

test('startup removes only unowned in-range ports and parses stdout despite a version warning', async () => {
  write(path.join(home, 'tailscale.status'), { TCP: { 443: {}, 8499: {}, 8500: {}, 8599: {}, 8600: {} } });
  await manager.initialize(manifest);
  assert.deepEqual(calls(), ['serve status --json', 'serve --https=8500 off', 'serve --https=8599 off']);
});

test('with the app recorded and quit, a try port is refused with the recorded-daemon fault and no serve lands on the daemon that answered', async (t) => {
  fakeRelays(t);
  // The quit app's CLI falls through to brew's socket, so the daemon that answers is brew's node.
  write(path.join(home, 'tailscale.node'), 'nBrew');
  t.after(() => fs.rmSync(path.join(home, 'tailscale.node'), { force: true }));
  const recorded = { kind: 'app', cli: path.join(bin, 'tailscale'), node: 'nApp' };
  setManager(tryManager({ answers: async () => true, log() {}, daemon: () => recorded }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /Couldn't open try port 8500: Tailscale's recorded daemon isn't running \(mac answered in its place\); start it, or run kickflip doctor --fix to pick again/);
  assert.deepEqual(calls().filter((call) => call.startsWith('serve')), []);
  // Once the recorded node answers, the port is served.
  recorded.node = 'nBrew';
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.ok(calls().some((call) => call.startsWith('serve --bg --https=8500 ')));
});

test('a failed Tailscale registration fails the run with stderr and removes the port, and a served card whose server dies serves again', async (t) => {
  const relays = fakeRelays(t);
  setManager(tryManager({ answers: async () => true, log() {} }));
  write(path.join(home, 'tailscale.fail'), 'yes');
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.equal(state().cards['w/A1'].https, undefined);
  assert.match(thread()[0].detail, /Couldn't open try port 8500: permission denied by tailscaled/);
  assert.ok(relays[0].closed);
  assert.ok(calls().includes('serve --https=8500 off'));
  fs.rmSync(path.join(home, 'tailscale.fail'));
  setScript("require('node:fs').writeFileSync('server.pid', String(process.pid)); console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].https, 8500);
  // A served card whose server is stopped outside the hub serves again on its port, with no thread line.
  const servedAgain = manager.next('w/A1', 'ready');
  process.kill(Number(fs.readFileSync(path.join(worktree, 'server.pid'), 'utf8')), 'SIGTERM');
  await servedAgain;
  await manager.settled();
  assert.equal(relays.length, 3);
  assert.equal(state().cards['w/A1'].https, 8500);
  assert.equal(calls().filter((call) => call === 'serve --https=8500 off').length, 2);
  assert.ok(relays.slice(0, 2).every((relay) => relay.closed));
  assert.equal(thread().length, 1);
});

test('card ports skip every board’s fixed main port, including closed boards, and release on Kill', async (t) => {
  fakeRelays(t);
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  const other = path.join(home, 'other');
  write(path.join(other, 'data/try.json'), { main_port: 8500 });
  manifest.closed = { other: { site: { dir: other } } };
  write(path.join(site, 'data/try.json'), { kind: 'web', main_port: 8501, cards: {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].https, 8502);
  await kill();
  assert.ok(calls().includes('serve --https=8502 off'));
  assert.equal(state().main_port, 8501);
  write(path.join(site, 'data/agents/A2.json'), { worktree: { path: worktree, repo } });
  await start({ key: 'w/A2' });
  await manager.settled();
  assert.equal(state().cards['w/A2'].state, 'ready');
  assert.equal(state().cards['w/A2'].https, 8502);
  manifest.sites = {};
  await tick();
  assert.equal(calls().filter((call) => call === 'serve --https=8502 off').length, 2);
  assert.equal(state().cards['w/A2'], undefined);
});

test('exhausted try ports fail clearly without adding a serve entry', async () => {
  setManager(tryManager({ answers: async () => true, log() {} }));
  manifest.closed = {};
  for (let port = 8500; port <= 8599; port++) {
    const dir = path.join(home, `reserved-${port}`);
    write(path.join(dir, 'data/try.json'), { main_port: port });
    manifest.closed[port] = { site: { dir } };
  }
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.match(thread()[0].detail, /No try ports available \(8500–8599\)/);
  assert.equal(calls().some((call) => call.includes('--bg')), false);
});

test('startup cleanup failure logs and still allows a build', async () => {
  const logs = [];
  setManager(tryManager({ log: (line) => logs.push(line) }));
  write(path.join(home, 'tailscale.status'), 'not json');
  await manager.initialize(manifest);
  assert.match(logs[0], /try startup cleanup/);
  setScript('process.exit(0);');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
});

test('try builds refuse with 409 while waiting and main rebuilds wait without a failure', async () => {
  const reason = 'Try builds wait on Tailscale: Tailscale / is not serving the hub.';
  const launched = path.join(home, 'build-started');
  setScript(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes');`);
  setScript(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes');`, repo);
  commit(repo);
  const messages = [];
  setManager(tryManager({ waiting: async () => reason, log: (text) => messages.push(text) }));
  await assert.rejects(start(), (error) => error.status === 409 && error.message === reason);
  await tick();
  assert.equal(fs.existsSync(launched), false);
  assert.equal(state().main, null);
  assert.equal(Object.values(state().cards).some((card) => card.state === 'failed' || card.state === 'running'), false);
  assert.deepEqual(thread(), []);
  assert.deepEqual(messages, []);
});

test("the prototype serve's relay drops the headers that refuse a frame, and a card's relay keeps them", async () => {
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => ({ login: 'lovek4d@github', addresses: [] }) });
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
