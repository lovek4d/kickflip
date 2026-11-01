import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'new-board-')));
process.env.HOME = home;
const { requestBoard, dismissBoard } = await import('./new-board.mjs');
const { repoService, repoPath, validateBranch, runRepo } = await import('./repos.mjs');
const { boardRepo, changeBoardRepo, migrateBoardRepos, githubFromOrigin } = await import('./board-repo.mjs');
const { startingBoards, STARTING_WAIT, BG_SETTINGS } = await import('./sessions.mjs');
const { routeFromName, ROUTE_RE } = await import('./routes.mjs');
const { saveJSON, readManifest, listBoards, prsOf } = await import('./boards.mjs');
const manifestFile = path.join(home, '.claude', 'kickflip', 'manifest.json');
const sessionsDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const base = path.join(home, '.repos');
const dir = path.join(home, 'hub-board');
const board = { dir, port: 0, cmd: [process.execPath, fileURLToPath(new URL('../board/server.mjs', import.meta.url))] };
const decoyDir = path.join(home, 'decoy-board');
const sites = { 'hub-orchestrator': { ...board, dir: decoyDir }, 'dev-hub': { ...board, hub: true } };
const noEvents = () => {
  for (const d of [dir, decoyDir]) assert.equal(fs.existsSync(path.join(d, 'data', 'events.jsonl')), false);
};
const live = () => new Map();
const input = (name, github = 'owner/project', branch = 'main') => ({ name, github, branch, purpose: '' });
const cloneCalls = [];
const repoRun = async (command, argv) => {
  if (command === 'git') return argv.includes('fetch') ? { status: 0, stdout: '', stderr: '' } : runRepo(command, argv);
  cloneCalls.push([command, argv]);
  assert.equal(command, 'gh');
  assert.deepEqual(argv.slice(0, 2), ['repo', 'clone']);
  fs.mkdirSync(argv[3], { recursive: true });
  const init = await runRepo('git', ['-C', argv[3], 'init', '--quiet', '-b', 'main']);
  assert.equal(init.status, 0, init.stderr);
  const origin = await runRepo('git', ['-C', argv[3], 'remote', 'add', 'origin', `https://github.com/${argv[2]}.git`]);
  assert.equal(origin.status, 0, origin.stderr);
  return { status: 0, stdout: '', stderr: '' };
};
const repos = repoService({ base, run: repoRun });
const claude = (answer) => {
  const calls = [];
  const run = async (argv, { cwd }) => {
    calls.push({ argv, cwd });
    if (answer) return answer;
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify({ pid: 1, sessionId: id, jobId: id.slice(0, 8) }));
    return { status: 0, stdout: `backgrounded · ${id.slice(0, 8)} · board\n`, stderr: '' };
  };
  return { calls, run };
};
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('new repo requests clone before starting a session and store the board branch independently of the clone', async () => {
  saveJSON(manifestFile, { sites });
  const { calls, run } = claude();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const service = repoService({ base, run: async (...args) => { await waiting; return repoRun(...args); } });
  const request = await requestBoard({ ...input("Bob's audit", 'owner/new-project', 'release/next'), purpose: 'Review $HOME changes' }, { run, live, repos: service });
  const repo = path.join(base, 'owner', 'new-project');
  const pending = readManifest().starting['bob-s-audit'];
  assert.deepEqual([pending.github, pending.branch, pending.repo, pending.phase], ['owner/new-project', 'release/next', repo, 'cloning']);
  assert.equal(calls.length, 0);
  release();
  const started = await request.started;
  assert.deepEqual(calls, [{ cwd: repo, argv: ['--bg', '--name', "Bob's audit", '--permission-mode', 'auto', '--settings', BG_SETTINGS,
    `/kickflip bob-s-audit --template board --title 'Bob'\\''s audit' --description 'Review $HOME changes'`] }]);
  const rec = readManifest().starting['bob-s-audit'];
  assert.equal(started.session, rec.session);
  assert.ok(fs.existsSync(path.join(sessionsDir, `${rec.session}.json`)));
  assert.deepEqual(rec, { title: "Bob's audit", repo, github: 'owner/new-project', branch: 'release/next', tickets: { source: 'internal', prefix: 'INT' }, phase: 'starting', asked_at: pending.asked_at, session: rec.session, label: "Bob's audit", since: rec.since });
  assert.ok(fs.existsSync(path.join(repo, '.git')));
  const at = Date.parse(rec.asked_at);
  assert.deepEqual(startingBoards(readManifest(), at), [{ route: 'bob-s-audit', title: "Bob's audit", repo, phase: 'starting', askedAt: rec.asked_at, failed: false }]);
  assert.equal(startingBoards(readManifest(), at + STARTING_WAIT)[0].failed, true);
  noEvents();
  await assert.rejects(dismissBoard(request.route), { status: 400 });
  const timedOut = readManifest();
  timedOut.starting['bob-s-audit'].asked_at = new Date(Date.now() - STARTING_WAIT).toISOString();
  saveJSON(manifestFile, timedOut);
  assert.deepEqual(await dismissBoard('bob-s-audit'), { route: 'bob-s-audit' });
  assert.equal(readManifest().starting, undefined);
});

test('concurrent boards share one clone without switching its branch and need no hub session', async () => {
  saveJSON(manifestFile, { sites: {} });
  const { calls, run } = claude();
  const before = cloneCalls.length;
  const requests = await Promise.all(['main', 'develop'].map((branch, i) => requestBoard(input(`Shared ${i}`, 'Owner/shared', branch), { run, live, repos })));
  await Promise.all(requests.map((r) => r.started));
  assert.equal(cloneCalls.length - before, 1);
  assert.deepEqual(calls.map((c) => c.cwd), [path.join(base, 'owner/shared'), path.join(base, 'owner/shared')]);
  assert.equal(calls[0].argv.at(-1), "/kickflip shared-0 --template board --title 'Shared 0'");
  assert.deepEqual(Object.values(readManifest().starting).map((r) => r.branch), ['main', 'develop']);
  const another = await requestBoard(input('Shared again', 'owner/shared'), { run, live, repos });
  assert.ok((await another.started).session);
  assert.equal(cloneCalls.length - before, 1);
});

test('failed clones leave no clone or temporary directory and never start claude', async () => {
  saveJSON(manifestFile, { sites: {} });
  const { calls, run } = claude();
  const service = repoService({ base, run: async (command, argv) => {
    const dest = argv.at(-1);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'partial'), 'partial');
    return { status: 1, stdout: '', stderr: 'clone failed\nmore details' };
  } });
  const r = await requestBoard(input('Failed clone', 'owner/failed'), { run, live, repos: service });
  assert.deepEqual(await r.started, { error: 'clone failed' });
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(base, 'owner/failed')), false);
  assert.equal(fs.readdirSync(base).some((name) => name.startsWith('.clone-')), false);
  assert.equal(startingBoards(readManifest())[0].failed, true);
  await dismissBoard(r.route);
  assert.equal(readManifest().starting, undefined);
});

test("a claude that fails marks the Starting row Didn't start at once with its first error line, which Dismiss removes", async () => {
  const answers = [
    [{ status: 1, stdout: '', stderr: 'spawn claude ENOENT' }, /^claude --bg failed \(1\): spawn claude ENOENT$/],
    [{ status: 1, stdout: '', stderr: `Not signed in · run claude /login${'!'.repeat(400)}\nsecond line` }, /^claude --bg failed \(1\): Not signed in · run claude \/login!+…$/],
    [{ status: 0, stdout: 'nothing useful', stderr: '' }, /^claude --bg started a session but no session record names it yet/],
  ];
  for (const [i, [answer, line]] of answers.entries()) {
    saveJSON(manifestFile, { sites });
    const { calls, run } = claude(answer);
    const { route, started } = await requestBoard(input(`Broken ${i}`), { run, live, repos });
    const { error } = await started;
    assert.equal(calls.length, 1);
    assert.match(error, line);
    assert.ok(error.length <= 200, error);
    const rec = readManifest().starting[route];
    assert.deepEqual([rec.error, rec.session], [error, undefined]);
    assert.deepEqual(startingBoards(readManifest(), Date.parse(rec.asked_at)), [{ route, title: `Broken ${i}`, repo: path.join(base, 'owner/project'), phase: 'starting', askedAt: rec.asked_at, failed: true, error }]);
    noEvents();
    assert.deepEqual(await dismissBoard(route), { route });
    assert.equal(readManifest().starting, undefined);
  }
});

test('a session that joins before its start is recorded keeps the joined entry', async () => {
  saveJSON(manifestFile, { sites });
  const { run } = claude();
  const joining = async (argv, options) => {
    const m = readManifest();
    delete m.starting;
    m.sites.quick = { ...board, github: 'owner/project', branch: 'main' };
    saveJSON(manifestFile, m);
    return run(argv, options);
  };
  const { started } = await requestBoard(input('Quick'), { run: joining, live, repos });
  assert.ok((await started).session);
  assert.deepEqual([readManifest().starting, readManifest().sites.quick.owner], [undefined, undefined]);
  assert.equal(readManifest().sites.quick.github, 'owner/project');
});

test('invalid repo identities, branches, fields and reserved routes are refused before any command or write', async () => {
  const manifest = { sites: { 'hub-orchestrator': board, board }, starting: { pending: { since: new Date().toISOString() } } };
  saveJSON(manifestFile, manifest);
  const { calls, run } = claude();
  const before = cloneCalls.length;
  for (const change of [{ extra: true }, { name: '' }, { name: 'n'.repeat(61) }, { name: '!!!' }, { name: 'Board' }, { name: 'Pending' },
    { github: '../escape' }, { github: 'o/../../escape' }, { github: '/tmp/escape' }, { github: 'owner/repo;ls' }, { github: '-owner/repo' },
    { github: 'https://github.com/o/r' }, { github: 'o/.git' }, { github: null }, { repo: home },
    { branch: '-main' }, { branch: '../main' }, { branch: 'a.lock' }, { branch: 'a/.hidden' }, { branch: 'a@{b' }, { branch: 'a b' }, { branch: 'a\\b' }, { branch: null },
    { purpose: 'p'.repeat(241) }, { purpose: null }, { tickets: { source: 'internal', prefix: 'BAD1' } }, { tickets: { source: 'other' } }, { tickets: { source: 'linear', team: 'PROD' } }]) {
    await assert.rejects(requestBoard({ ...input('New board'), ...change }, { run, live, repos }), { status: 400 });
  }
  assert.deepEqual(readManifest(), manifest);
  assert.deepEqual(calls, []);
  assert.equal(cloneCalls.length, before);
  noEvents();
  assert.equal(routeFromName('  Backend & Audit! '), 'backend-audit');
  assert.equal(routeFromName('N'.repeat(60)), 'n'.repeat(41));
  assert.equal(routeFromName('__proto__'), 'proto');
  assert.ok(ROUTE_RE.test(routeFromName('Backend audit')));
  assert.equal(validateBranch('release/next'), 'release/next');
  assert.equal(repoPath('org/.github', base), path.join(base, 'org/.github'));
  assert.equal(repoPath('org/-repo', base), path.join(base, 'org/-repo'));
});

test('clone paths refuse symlink escapes through .repos, owner, repo and ancestors', async () => {
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  for (const where of ['root', 'owner', 'repo', 'ancestor']) {
    const root = path.join(home, `escape-${where}`);
    let target = root;
    if (where === 'owner') { fs.mkdirSync(root); target = path.join(root, 'owner'); }
    if (where === 'repo') { fs.mkdirSync(path.join(root, 'owner'), { recursive: true }); target = path.join(root, 'owner/project'); }
    fs.symlinkSync(outside, target);
    const service = repoService({ base: where === 'ancestor' ? path.join(root, '.repos') : root, run: repoRun });
    assert.throws(() => service.path('owner/project'), /stay inside .repos/);
    await assert.rejects(service.ensure('owner/project'), /stay inside .repos/);
  }
  assert.throws(() => repoPath('owner/../../escape', base), { status: 400 });
});

test('repo discovery lists the user and all orgs, sorts pushes, caches commands and refreshes shared clone metadata', async () => {
  let at = 0;
  const calls = [];
  const repository = (nameWithOwner, pushedAt, isPrivate = false) => ({ nameWithOwner, pushedAt, isPrivate, defaultBranchRef: { name: 'trunk' }, description: 'A repo' });
  const service = repoService({ base, now: () => at, run: async (command, argv) => {
    calls.push([command, argv]);
    let value;
    if (argv[0] === 'auth') return { status: 0 };
    if (argv[1] === 'user') value = { login: 'owner' };
    else if (argv[1] === 'user/orgs') value = [[{ login: 'org' }], [{ login: 'other' }]];
    else if (argv[2] === 'owner') value = [repository('owner/shared', '2026-10-01', true)];
    else if (argv[2] === 'org') value = [repository('org/project', '2026-10-31')];
    else value = [repository('other/project', '2026-10-15')];
    return { status: 0, stdout: JSON.stringify(value) };
  } });
  const manifest = { sites: { first: { github: 'OWNER/SHARED', title: 'First board', owner: { repo: path.join(base, 'owner/shared') } }, legacy: { github: 'owner/shared', title: 'Legacy board', owner: { repo: '/legacy' } } } };
  const [list] = await Promise.all([service.list(manifest), service.list(manifest)]);
  assert.equal(list.signedIn, true);
  assert.deepEqual(list.repos.map((r) => r.github), ['org/project', 'other/project', 'owner/shared']);
  assert.deepEqual(list.repos[2].shared, [{ route: 'first', title: 'First board' }]);
  assert.deepEqual([list.repos[2].private, list.repos[2].cloned, list.repos[2].defaultBranch], [true, true, 'trunk']);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(([command]) => command === 'gh'));
  assert.ok(calls.filter(([, args]) => args[0] === 'repo').every(([, args]) => args.includes('nameWithOwner,isPrivate,pushedAt,defaultBranchRef,description')));
  assert.deepEqual((await service.list()).repos[2].shared, []);
  assert.equal(calls.length, 6);
  at = 60_000;
  await service.list();
  assert.equal(calls.length, 12);
  await service.list({}, { fresh: true });
  assert.equal(calls.length, 18);
});

test('signed-out discovery runs no repo commands and can be checked again', async () => {
  const calls = [];
  const service = repoService({ base, run: async (...args) => { calls.push(args); return { status: 1 }; } });
  assert.deepEqual(await service.list(), { signedIn: false, repos: [] });
  assert.deepEqual(calls, [['gh', ['auth', 'status']]]);
  await service.list({}, { fresh: true });
  assert.equal(calls.length, 2);
});

test('branches come from paginated gh api with the actual default and reject bad repo names before commands', async () => {
  const calls = [];
  const service = repoService({ base, run: async (command, argv) => {
    calls.push([command, argv]);
    return { status: 0, stdout: JSON.stringify(argv.includes('--paginate') ? [[{ name: 'trunk' }], [{ name: 'release/next' }]] : { default_branch: 'trunk' }) };
  } });
  assert.deepEqual(await service.branches('owner/project'), { defaultBranch: 'trunk', branches: ['trunk', 'release/next'] });
  assert.deepEqual(calls, [['gh', ['api', 'repos/owner/project']], ['gh', ['api', 'repos/owner/project/branches?per_page=100', '--paginate', '--slurp']]]);
  await assert.rejects(service.branches('owner/../escape'), { status: 400 });
  assert.equal(calls.length, 2);
});

test('PR polling takes github ahead of a wave repo or the legacy default', () => {
  const waves = [{ slug: 'w', wave: { items: [{ id: 'A1', pr: 1 }] } }, { slug: 'x', wave: { repo: 'old/repo', items: [{ id: 'A2', pr: 2 }] } }];
  assert.deepEqual(prsOf(waves, 'new/project').map((p) => p.repo), ['new/project', 'new/project']);
  fs.mkdirSync(dir, { recursive: true });
  saveJSON(path.join(dir, 'board.json'), { items: 'items.json' });
  saveJSON(path.join(dir, 'items.json'), waves[1].wave);
  const registry = listBoards({ sites: { one: { ...board, github: 'new/project', branch: 'develop' } } });
  assert.deepEqual([registry[0].github, registry[0].branch, registry[0].prs[0].repo], ['new/project', 'develop', 'new/project']);
});

test('origin migration runs once, skips the hub board, preserves configured repos, ignores non-GitHub origins and records the default branch', async () => {
  saveJSON(manifestFile, { sites: { one: { ...board, owner: { repo: '/project' } }, local: { ...board, owner: { repo: '/local' } }, two: { ...board, github: 'kept/repo' },
    other: { ...board, dir: '/other' }, hub: { ...board, hub: true, owner: { repo: '/project' } } } });
  const calls = [];
  const run = async (command, argv) => {
    calls.push([command, argv]);
    if (argv[1] === '/other') return { status: 0, stdout: 'https://example.com/o/r.git' };
    if (argv.includes('refs/remotes/origin/HEAD')) return argv[1] === '/local' ? { status: 1, stdout: '' } : { status: 0, stdout: 'origin/trunk\n' };
    return { status: 0, stdout: argv.includes('symbolic-ref') ? 'develop\n' : 'git@github.com:Owner/Project.git\n' };
  };
  assert.deepEqual(await migrateBoardRepos({ run }), ['one', 'local']);
  assert.deepEqual(boardRepo('one'), { github: 'Owner/Project', branch: 'trunk', repo: '/project' });
  assert.deepEqual(boardRepo('local'), { github: 'Owner/Project', branch: 'develop', repo: '/local' });
  assert.equal(readManifest().sites.hub.github, undefined);
  assert.equal(readManifest().sites.two.github, 'kept/repo');
  assert.equal(readManifest().sites.other.github, undefined);
  const count = calls.length;
  assert.deepEqual(await migrateBoardRepos({ run }), []);
  assert.equal(calls.length, count);
  assert.equal(githubFromOrigin('https://github.com/o/r.git'), 'o/r');
  assert.equal(githubFromOrigin('ssh://git@github.com/o/r.git'), 'o/r');
  assert.equal(githubFromOrigin('https://evilgithub.com/o/r.git'), null);
});

test('Settings clone changes update repo, branch and session folder and notify the board through an event', async () => {
  saveJSON(manifestFile, { sites: { settings: { ...board, github: 'old/repo', branch: 'main', owner: { session: 's1', repo: '/old' } },
    hub: { ...board, hub: true, owner: { session: 's2', repo: '/session' } } } });
  const events = [];
  const event = async (board, kind, data) => { events.push([board.route, kind, data]); return 'e1'; };
  const hubSite = structuredClone(readManifest().sites.hub);
  const clones = cloneCalls.length;
  assert.deepEqual(boardRepo('hub'), { hub: true, github: '', branch: '', repo: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
  await assert.rejects(changeBoardRepo('hub', { github: 'owner/settings', branch: 'develop' }, { repos, event }), { status: 409 });
  assert.deepEqual(readManifest().sites.hub, hubSite);
  assert.equal(cloneCalls.length, clones);
  assert.deepEqual(events, []);
  const out = await changeBoardRepo('settings', { github: 'owner/settings', branch: 'develop' }, { repos, event });
  assert.deepEqual(out, { github: 'owner/settings', branch: 'develop', repo: path.join(base, 'owner/settings'), id: 'e1' });
  assert.equal(readManifest().sites.settings.owner.session, 's1');
  assert.deepEqual(boardRepo('settings'), { github: out.github, branch: out.branch, repo: out.repo });
  assert.deepEqual(events, [['settings', 'repo-changed', { github: out.github, branch: out.branch, repo: out.repo, previous: { github: 'old/repo', branch: 'main', repo: '/old' } }]]);
  const before = cloneCalls.length;
  await changeBoardRepo('settings', { github: 'owner/settings', branch: 'main' }, { repos, event });
  assert.equal(cloneCalls.length, before);
  await assert.rejects(changeBoardRepo('settings', { github: '../escape', branch: 'main' }, { repos, event }), { status: 400 });
  await assert.rejects(changeBoardRepo('missing', { github: 'owner/project', branch: 'main' }, { repos, event }), { status: 404 });
});

test('join transfers the reserved repo and branch before or after the start result, and rejoin keeps the selected session folder', () => {
  const bin = fileURLToPath(new URL('../bin/kickflip.mjs', import.meta.url));
  for (const recorded of [false, true]) {
    const route = recorded ? 'joined-after' : 'joined-before';
    const clone = path.join(base, 'owner/project');
    saveJSON(manifestFile, { sites: {}, starting: { [route]: { title: route, github: 'owner/project', branch: 'develop', repo: clone, tickets: { source: 'internal', prefix: 'OPS' }, ...(recorded ? { session: 'joined-id' } : {}) } } });
    const run = (args) => {
      const result = spawnSync(process.execPath, [bin, 'join', route, '--session', 'joined-id', '--port', '4613', ...args], { encoding: 'utf8', env: { ...process.env, KICKFLIP_HUB_PORT: '1' } });
      assert.equal(result.status, 0, result.stderr);
    };
    run(['--template', 'board', '--cmd', JSON.stringify(board.cmd), '--repo', clone]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(readManifest().sites[route].dir, 'board.json'))).tickets, { source: 'internal', prefix: 'OPS' });
    assert.deepEqual(boardRepo(route), { github: 'owner/project', branch: 'develop', repo: clone });
    assert.equal(readManifest().starting, undefined);
    run([]);
    assert.equal(readManifest().sites[route].owner.repo, clone);
  }
});

test('a failed Settings clone keeps the prior manifest entry and emits no event', async () => {
  const manifest = { sites: { settings: { ...board, github: 'old/repo', branch: 'main', owner: { repo: '/old' } } } };
  saveJSON(manifestFile, manifest);
  let events = 0;
  const repos = repoService({ base, run: async () => ({ status: 1, stderr: 'No access to https://x-access-token:secret@github.com/owner/denied.git' }) });
  await assert.rejects(changeBoardRepo('settings', { github: 'owner/denied', branch: 'main' }, { repos, event: async () => { events++; } }),
    (e) => e.message === 'No access to https://github.com/owner/denied.git');
  assert.deepEqual(readManifest(), manifest);
  assert.equal(events, 0);
});

test('repo names ending in .lock have independent clone locks', async () => {
  const paths = await Promise.all(['owner/lock-test', 'owner/lock-test.lock'].map((github) => repos.ensure(github)));
  assert.equal(paths.length, 2);
  assert.ok(paths.every((repo) => fs.statSync(path.join(repo, '.git')).isDirectory()));
  assert.equal(await repos.ensure('owner/lock-test'), paths[0]);
});
