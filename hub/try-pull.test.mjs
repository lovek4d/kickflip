import { home } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { clock, commit, fetchTryBranches, git, manager, manifest, read, repo, root, script, setManager, setScript, site, state, thread, tick, tryManager, until, untimed, worktree, write } from './try-fixture.mjs';

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
