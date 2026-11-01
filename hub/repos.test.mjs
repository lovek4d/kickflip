import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-reuse-')));
process.env.HOME = home;
process.env.WEB_TS_CLAUDE = '/usr/bin/false';
const { repoService, runRepo, githubFromInput, githubFromOrigin, repoLookupRoute } = await import('./repos.mjs');
const { requestBoard } = await import('./new-board.mjs');
const { changeBoardRepo } = await import('./board-repo.mjs');
const { saveJSON, readManifest } = await import('./boards.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const manifestFile = path.join(home, '.claude/web-ts/manifest.json');
const board = { dir: path.join(home, 'board'), cmd: ['node', '/app/board/server.mjs'], github: 'old/project', branch: 'main', owner: { repo: '/old' } };
const manifest = { sites: { board } };
const origin = 'https://github.com/owner/project.git';

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'base');
  return dir;
}

function contents(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    return [name, stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fs.readFileSync(file).toString('base64') : null];
  }));
}

after(() => fs.rmSync(home, { recursive: true, force: true }));

test('GitHub input parsing accepts clone and browser links and refuses other hosts and unsafe identities', () => {
  const accepted = [
    ['owner/project', 'owner/project'], ['  Owner/Project  ', 'Owner/Project'],
    ['https://github.com/o/r', 'o/r'], ['https://github.com/o/r.git', 'o/r'],
    ['https://github.com/o/r.git/', 'o/r'], ['git@github.com:o/r.git', 'o/r'],
    ['ssh://git@github.com/o/r.git', 'o/r'], ['https://www.github.com/O/R', 'O/R'],
    ['https://github.com/o/r/tree/main', 'o/r'], ['https://github.com/o/r/pull/12', 'o/r'],
    ['https://github.com/o/r/blob/main/a.js?plain=1#L2', 'o/r'],
    ['https://github.com/o/r?tab=readme-ov-file', 'o/r'], ['org/.github', 'org/.github'],
  ];
  for (const [input, expected] of accepted) assert.equal(githubFromInput(input), expected, input);
  for (const input of [null, undefined, {}, '', 'search words', 'https://gitlab.com/o/r.git',
    'git@gitlab.com:o/r.git', 'ssh://git@gitlab.com/o/r', 'https://github.com.evil.test/o/r',
    'https://github.com@evil.test/o/r', 'https://evil.test/github.com/o/r',
    'https://github.com/o', 'https://github.com/o//tree/main', 'https://github.com/o/../r',
    'https://github.com/o/%2e%2e', 'https://github.com/o/r;ls', 'https://github.com/o/r trailing',
    'o/r/tree/main', '../r', '-o/r', 'o/.git', 'o/..', 'file:///o/r', '/tmp/repo']) {
    assert.equal(githubFromInput(input), null, String(input));
  }
  assert.equal(githubFromOrigin('https://github.com/o/r/tree/main'), null, 'reuse still requires a repo-root origin');
  assert.equal(githubFromOrigin('o/r'), null);
});

test('GET /_hub/repo returns a checked unlisted repo, caches argv calls and refreshes clone/share metadata', async () => {
  let at = 0;
  const base = path.join(home, 'lookup', '.repos');
  const calls = [];
  const repo = { nameWithOwner: 'Collaborator/Project', isPrivate: true, pushedAt: '2026-11-01T12:00:00Z', description: 'Shared project', defaultBranchRef: { name: 'develop' } };
  const repos = repoService({ base, now: () => at, run: async (command, argv) => {
    calls.push([command, argv]);
    assert.equal(command, 'gh');
    assert.deepEqual(argv.slice(0, 2), ['repo', 'view']);
    return { status: 0, stdout: JSON.stringify(repo) };
  } });
  const get = (input, manifest = {}) => repoLookupRoute(new URL(`http://test/_hub/repo?github=${encodeURIComponent(input)}`), { repos, manifest, sendJSON: (status, body) => ({ status, body }) });
  const [response, concurrent] = await Promise.all([get('https://github.com/Collaborator/Project/tree/develop'), get('collaborator/project')]);
  assert.deepEqual(response, concurrent);
  assert.equal(response.status, 200);
  const clone = path.join(base, 'collaborator/project');
  assert.deepEqual(response.body, { github: repo.nameWithOwner, private: true, pushedAt: repo.pushedAt, defaultBranch: 'develop', description: repo.description, clone, cloned: false, shared: [], listed: false });
  assert.deepEqual(calls, [['gh', ['repo', 'view', 'Collaborator/Project', '--json', 'nameWithOwner,isPrivate,description,pushedAt,defaultBranchRef']]]);
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const manifest = { sites: { board: { github: 'COLLABORATOR/PROJECT', title: 'Sharing board', owner: { repo: clone } }, legacy: { github: repo.nameWithOwner, owner: { repo: '/other' } } } };
  assert.deepEqual((await get('collaborator/project', manifest)).body.shared, [{ route: 'board', title: 'Sharing board' }]);
  assert.equal((await get('collaborator/project')).body.cloned, true);
  assert.equal(calls.length, 1);
  at = 60_000;
  await get('collaborator/project');
  assert.equal(calls.length, 2);
  assert.equal((await get('https://gitlab.com/o/r')).status, 400);
  assert.equal((await get('o/../../escape')).status, 400);
  assert.equal(calls.length, 2);
});

for (const reachable of [true, false]) {
  test(`GET /_hub/repo ${reachable ? 'accepts a public repo through ls-remote' : 'returns 404 when neither gh nor Git can reach it'}`, async () => {
    const calls = [], prompts = [];
    let at = 0;
    const repos = repoService({ base: path.join(home, 'public', '.repos'), now: () => at, run: async (command, argv, options) => {
      calls.push([command, argv]);
      if (command === 'git') prompts.push(options?.env?.GIT_TERMINAL_PROMPT);
      return command === 'git' && reachable ? { status: 0, stdout: '' } : { status: 1, stderr: 'secret detail' };
    } });
    const get = () => repoLookupRoute(new URL('http://test/_hub/repo?github=outside/public'), { repos, manifest: {}, sendJSON: (status, body) => ({ status, body }) });
    const response = await get();
    assert.equal(response.status, reachable ? 200 : 404);
    if (reachable) {
      assert.equal(response.body.github, 'outside/public');
      assert.equal(response.body.private, false);
      assert.equal(response.body.listed, false);
      assert.equal(response.body.pushedAt, '');
      assert.equal(response.body.description, '');
      assert.deepEqual(response.body.shared, []);
    } else assert.deepEqual(response.body, { error: "Not found, or you don't have access." });
    assert.deepEqual(calls[1], ['git', ['-c', 'credential.helper=', 'ls-remote', '--heads', 'https://github.com/outside/public.git']]);
    assert.deepEqual(prompts, ['0']);
    await get();
    assert.equal(calls.length, 2);
    at = 60_000;
    await get();
    assert.equal(calls.length, 4);
    if (!reachable) await assert.rejects(repos.branches('outside/public'), { status: 502, message: 'secret detail' });
  });
}

test('an unlisted public repo lists branches and prepares a verified clone with Git when gh cannot reach it', async () => {
  const calls = [];
  const base = path.join(home, 'public-clone', '.repos');
  const repos = repoService({ base, run: async (command, argv) => {
    calls.push([command, argv]);
    if (command === 'gh') return { status: 1, stderr: 'not signed in' };
    if (argv[2] === 'ls-remote') return { status: 0, stdout: `ref: refs/heads/trunk\tHEAD\n${'a'.repeat(40)}\trefs/heads/release/next\n${'b'.repeat(40)}\trefs/heads/trunk\n${'c'.repeat(40)}\trefs/heads/bad..branch\n` };
    if (argv[2] === 'clone') { fs.mkdirSync(path.join(argv.at(-1), '.git'), { recursive: true }); return { status: 0 }; }
    if (argv.includes('rev-parse')) return { status: 0, stdout: argv[1] };
    if (argv.includes('remote')) return { status: 0, stdout: 'https://github.com/outside/public.git' };
    if (argv.includes('fetch')) return { status: 0 };
    assert.fail(`unexpected command ${command} ${argv.join(' ')}`);
  } });
  assert.deepEqual(await repos.branches('outside/public'), { defaultBranch: 'trunk', branches: ['release/next', 'trunk'] });
  saveJSON(manifestFile, manifest);
  const result = await changeBoardRepo('board', { github: 'outside/public', branch: 'release/next' }, { repos, event: async () => 'event' });
  assert.equal(result.repo, path.join(base, 'outside/public'));
  const request = await requestBoard({ name: 'Unlisted public', github: 'outside/public', branch: 'trunk' }, { repos, run: async () => ({ status: 1, stderr: 'test session' }) });
  assert.equal((await request.started).error, 'claude --bg failed (1): test session');
  assert.equal(calls.filter(([command, argv]) => command === 'git' && argv[2] === 'clone').length, 1);
  assert.equal(calls.some(([, argv]) => argv.includes('list')), false);
  assert.ok(calls.some(([, argv]) => argv.includes('+refs/heads/release/next:refs/remotes/origin/release/next')));
  assert.ok(calls.some(([, argv]) => argv.includes('+refs/heads/trunk:refs/remotes/origin/trunk')));
});

for (const kind of ['wrong-origin', 'empty-metadata', 'symlink-metadata', 'gitdir-file', 'wrong-root', 'nested-folder', 'bare-repo']) {
  test(`New board and Settings refuse ${kind} without modifying the existing folder`, async () => {
    const base = path.join(home, kind, '.repos');
    const dest = path.join(base, 'owner/project');
    fs.mkdirSync(dest, { recursive: true });
    if (kind === 'wrong-origin') {
      init(dest);
      git(dest, 'remote', 'add', 'origin', 'git@github.com:other/project.git');
    } else if (kind === 'empty-metadata') fs.mkdirSync(path.join(dest, '.git'));
    else if (kind === 'symlink-metadata') {
      const source = init(path.join(home, 'metadata-source'));
      git(source, 'remote', 'add', 'origin', origin);
      fs.symlinkSync(path.join(source, '.git'), path.join(dest, '.git'));
    } else if (kind === 'gitdir-file') {
      const source = init(path.join(home, 'gitdir-source'));
      git(source, 'remote', 'add', 'origin', origin);
      fs.writeFileSync(path.join(dest, '.git'), `gitdir: ${path.join(source, '.git')}\n`);
    } else if (kind === 'wrong-root') {
      init(dest);
      git(dest, 'remote', 'add', 'origin', origin);
      git(dest, 'config', 'core.worktree', init(path.join(home, 'other-root')));
    } else if (kind === 'nested-folder') {
      init(base);
      git(base, 'remote', 'add', 'origin', origin);
    } else git(dest, 'init', '--quiet', '--bare');
    fs.writeFileSync(path.join(dest, 'keep'), 'untouched');
    const before = contents(dest);
    const calls = [];
    const repos = repoService({ base, run: async (command, argv) => {
      assert.ok(fs.existsSync(path.join(base, '.locks/owner/project.lock')));
      calls.push([command, argv]);
      return runRepo(command, argv);
    } });
    saveJSON(manifestFile, manifest);
    const settings = changeBoardRepo('board', { github: 'owner/project', branch: 'main' }, { repos });
    await assert.rejects(settings, /clone path.*(?:repo|origin|metadata|work tree)/i);
    assert.deepEqual(readManifest(), manifest);
    const request = await requestBoard({ name: `Bad ${kind}`, github: 'owner/project', branch: 'main' }, {
      repos, run: async () => { assert.fail('session must not start'); },
    });
    assert.match((await request.started).error, /clone path.*(?:repo|origin|metadata|work tree)/i);
    assert.deepEqual(contents(dest), before);
    assert.equal(calls.some(([command, argv]) => command === 'gh' || argv.includes('fetch')), false);
  });
}

for (const url of [origin, 'git@github.com:Owner/Project.git', 'ssh://git@github.com/OWNER/PROJECT.git/']) {
  test(`reuse accepts normalized origin ${url} and fetches a newly selected branch without switching checkout`, async () => {
    const root = fs.mkdtempSync(path.join(home, 'accepted-'));
    const remote = init(path.join(root, 'remote'));
    const base = path.join(root, '.repos');
    const dest = path.join(base, 'owner/project');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    git(root, 'clone', '--quiet', remote, dest);
    git(dest, 'remote', 'set-url', 'origin', url);
    const head = git(dest, 'rev-parse', 'HEAD');
    git(remote, 'checkout', '--quiet', '-b', 'release/next');
    git(remote, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'release');
    const selected = git(remote, 'rev-parse', 'HEAD');
    const fetches = [];
    const repos = repoService({ base, run: async (command, argv) => {
      assert.ok(fs.existsSync(path.join(base, '.locks/owner/project.lock')));
      if (command === 'git' && argv.includes('fetch')) {
        fetches.push(argv);
        return runRepo(command, ['-c', `url.${remote}.insteadOf=${url}`, ...argv]);
      }
      return runRepo(command, argv);
    } });
    saveJSON(manifestFile, manifest);
    const changed = await changeBoardRepo('board', { github: 'Owner/Project', branch: 'release/next' }, { repos, event: async () => 'event' });
    assert.equal(changed.repo, dest);
    assert.equal(git(dest, 'rev-parse', 'refs/remotes/origin/release/next'), selected);
    assert.equal(git(dest, 'branch', '--show-current'), 'main');
    assert.equal(git(dest, 'rev-parse', 'HEAD'), head);
    assert.equal(fetches.length, 1);
    assert.equal(git(dest, 'status', '--porcelain'), '');
    const saved = readManifest();
    await assert.rejects(changeBoardRepo('board', { github: 'owner/project', branch: 'missing' }, { repos }), /missing/);
    assert.deepEqual(readManifest(), saved);
    const request = await requestBoard({ name: 'Missing branch', github: 'owner/project', branch: 'missing' }, {
      repos, run: async () => { assert.fail('session must not start'); },
    });
    assert.match((await request.started).error, /missing/);
    git(remote, 'branch', '-D', 'main');
    await assert.rejects(repos.ensure('owner/project', 'main'), /main/);
    assert.equal(git(dest, 'branch', '--show-current'), 'main');
    assert.equal(git(dest, 'rev-parse', 'HEAD'), head);
  });
}
