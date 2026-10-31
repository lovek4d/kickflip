import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-reuse-')));
process.env.HOME = home;
const { repoService, runRepo } = await import('./repos.mjs');
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
