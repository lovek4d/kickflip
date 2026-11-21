import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('folders-'));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-config');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
const claudeConfig = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
fs.writeFileSync(claudeConfig, '{}');
const { folderInfo, folderSuggestions, makeRepo, readableFolder, recentSources } = await import('./folders.mjs');
const { requestBoard, retryBoard } = await import('./new-board.mjs');
const { boardRepo } = await import('./board-repo.mjs');
const { saveJSON, readManifest, listBoards } = await import('./boards.mjs');
const { builderRepo } = await import('../board/worktree.mjs');

const manifestFile = path.join(home, '.claude', 'kickflip', 'manifest.json');
const sessionsDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const boardCmd = [process.execPath, fileURLToPath(new URL('../board/server.mjs', import.meta.url))];
const bin = fileURLToPath(new URL('../bin/kickflip.mjs', import.meta.url));
const live = () => new Map();
const git = (cwd, ...argv) => {
  const r = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
process.env.GIT_AUTHOR_NAME = 't'; process.env.GIT_AUTHOR_EMAIL = 't@t'; process.env.GIT_COMMITTER_NAME = 't'; process.env.GIT_COMMITTER_EMAIL = 't@t';
const folder = (rel, files = {}) => {
  const dir = path.join(home, rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};
const repo = (rel, { origin, branch = 'main' } = {}) => {
  const dir = folder(rel, { 'README.md': 'hi\n' });
  git(dir, 'init', '--quiet', '-b', branch);
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '-m', 'first');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
};
const claude = () => {
  const calls = [];
  const run = async (argv, { cwd }) => {
    calls.push({ argv, cwd });
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify({ pid: 1, sessionId: id, jobId: id.slice(0, 8) }));
    return { status: 0, stdout: `backgrounded · ${id.slice(0, 8)} · board\n`, stderr: '' };
  };
  return { calls, run };
};
// A repo service that fails any clone, since a board on a folder never clones.
const repos = { base: path.join(home, '.claude', 'kickflip', 'repos'), path: () => assert.fail('a board on a folder has no clone path'), cloned: () => assert.fail('a board on a folder is never cloned'), ensure: async () => assert.fail('a board on a folder is never cloned') };
const join = (route, session, port) => {
  const r = spawnSync(process.execPath, [bin, 'join', '--name', route, '--session', session, '--port', String(port), '--template', 'board', '--items', 'data/items.json', '--cmd', JSON.stringify(boardCmd)], { encoding: 'utf8', env: { ...process.env, KICKFLIP_HUB_PORT: '1' } });
  assert.equal(r.status, 0, r.stderr);
};

test('a folder reads as a GitHub repo, another host, no remote or not a repo, with its default branch first', async () => {
  repo('dev/site', { origin: 'git@github.com:Acme/site.git', branch: 'trunk' });
  git(path.join(home, 'dev/site'), 'branch', 'alpha');
  repo('dev/fw', { origin: 'https://gitlab.com/acme/fw.git' });
  repo('dev/dots');
  folder('dev/notes', { 'a.txt': 'x' });
  assert.deepEqual(await folderInfo('~/dev/site'), { folder: '~/dev/site', path: path.join(home, 'dev/site'), git: true, github: 'Acme/site', branch: 'trunk', branches: ['trunk', 'alpha'] });
  assert.equal((await folderInfo(`${home}/dev/fw/`)).remote, 'https://gitlab.com/acme/fw.git');
  const dots = await folderInfo('~/dev/dots');
  assert.deepEqual([dots.git, dots.github, dots.remote, dots.branch], [true, undefined, undefined, 'main']);
  assert.deepEqual(await folderInfo('~/dev/notes'), { folder: '~/dev/notes', path: path.join(home, 'dev/notes'), git: false, branch: 'main', branches: ['main'] });
});

test("a folder is refused when it is home, outside it, in ~/.claude, a symlink, a file, missing, inside another repo, a repo with no commits, or a board's repo", async () => {
  folder('.claude/kickflip/repos/x');
  folder('dev/real');
  fs.symlinkSync(path.join(home, 'dev/real'), path.join(home, 'dev/link'));
  fs.writeFileSync(path.join(home, 'dev/file.txt'), '');
  const inner = repo('dev/outer');
  folder('dev/outer/src');
  const empty = folder('dev/empty');
  git(empty, 'init', '--quiet', '-b', 'main');
  const refused = async (input, message, manifest = {}) => assert.rejects(folderInfo(input, { manifest }), { message });
  await refused('~', /whole home folder/);
  await refused(home, /whole home folder/);
  await refused('/tmp', /inside your home folder/);
  await refused('~/../', /inside your home folder/);
  await refused('dev/real', /Start the path with ~\/ or \//);
  await refused('~/.claude', /Claude’s own/);
  await refused('~/.claude/kickflip/repos/x', /Claude’s own/);
  await refused('~/dev/link', /symlink/);
  await refused('~/dev/link/', /symlink/);
  await refused('~/dev/file.txt', /a file/);
  await refused('~/dev/missing', /No folder there/);
  await refused('~/dev/outer/src', /Inside the git repo ~\/dev\/outer/);
  await refused('~/dev/empty', /no commits/);
  await refused('~/dev/outer', /Already \/outer-board’s repo/, { sites: { 'outer-board': { dir: '/x', owner: { repo: inner } } } });
  await refused('~/dev/outer', /Already \/old’s repo/, { closed: { old: { site: { owner: { repo: inner } } } } });
  await refused('~/dev/outer', /Already \/coming’s repo/, { starting: { coming: { repo: inner } } });
});

test('suggestions list the folders under the typed path, hidden ones only on a dot, never ~/.claude or a symlink', () => {
  folder('dev/notes-site'); folder('dev/Notebook'); folder('dev/.hidden'); folder('.config');
  assert.deepEqual(folderSuggestions('~/dev/no'), ['~/dev/Notebook', '~/dev/notes', '~/dev/notes-site']);
  assert.ok(!folderSuggestions('~/dev/').includes('~/dev/link'));
  assert.ok(!folderSuggestions('~/dev/').includes('~/dev/.hidden'));
  assert.deepEqual(folderSuggestions('~/dev/.h'), ['~/dev/.hidden']);
  assert.deepEqual(folderSuggestions('~/.c'), ['~/.config']);
  assert.ok(folderSuggestions('~/').includes('~/dev'));
  assert.deepEqual([folderSuggestions('~/.claude/'), folderSuggestions('dev'), folderSuggestions('~/dev/link/')], [[], [], []]);
});

test('Make it a git repo commits what is there on main, honouring .gitignore, and a failed commit leaves no .git', async () => {
  const dir = folder('dev/scratch', { 'keep.md': 'k', '.gitignore': 'secret.env\n', 'secret.env': 's' });
  await makeRepo(dir);
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(dir, 'log', '--format=%s'), 'Initial commit');
  assert.deepEqual(git(dir, 'ls-files').split('\n'), ['.gitignore', 'keep.md']);
  const bare = folder('dev/bare');
  await makeRepo(bare);
  assert.equal(git(bare, 'log', '--format=%s'), 'Initial commit', 'an empty folder still gets its first commit');
  const broken = folder('dev/broken', { 'a.txt': 'a' });
  const run = async (command, argv) => (argv.includes('commit') ? { status: 1, stdout: '', stderr: 'Author identity unknown' } : spawnSync(command, argv, { encoding: 'utf8' }));
  await assert.rejects(makeRepo(broken, run), { status: 502, message: /git commit failed: Author identity unknown/ });
  assert.equal(fs.existsSync(path.join(broken, '.git')), false);
  assert.ok(fs.existsSync(path.join(broken, 'a.txt')));
});

test('a New board on a folder works there in place: no clone, trusted, a GitHub origin keeps GitHub tickets, and its joined board is local', async () => {
  saveJSON(manifestFile, { sites: {} });
  const dir = repo('dev/shop', { origin: 'https://github.com/acme/shop.git', branch: 'trunk' });
  const { calls, run } = claude();
  const request = await requestBoard({ name: 'Shop', folder: '~/dev/shop', purpose: 'Shop work', tickets: { source: 'github' } }, { run, live, repos });
  const pending = readManifest().starting.shop;
  assert.deepEqual([pending.repo, pending.github, pending.folder, pending.branch, pending.phase], [dir, 'acme/shop', true, 'trunk', 'starting']);
  const { session } = await request.started;
  assert.deepEqual(calls.map((c) => c.cwd), [dir]);
  assert.equal(JSON.parse(fs.readFileSync(claudeConfig, 'utf8')).projects[dir].hasTrustDialogAccepted, true);
  join('shop', session, 4721);
  assert.deepEqual(boardRepo('shop'), { github: 'acme/shop', branch: 'trunk', repo: dir, local: true });
  const site = readManifest().sites.shop;
  assert.deepEqual(builderRepo(site.dir), { repo: dir, base: 'trunk', remote: false }, 'builders branch from the folder’s own trunk, never origin’s');
  assert.equal(listBoards().find((b) => b.route === 'shop').github, 'acme/shop');
  await assert.rejects(requestBoard({ name: 'Shop again', folder: '~/dev/shop', purpose: 'x' }, { run, live, repos }), { status: 409, message: /Already \/shop’s repo/ });
});

test('a folder with no remote makes a local board on its branch, and refuses GitHub issues and a branch it lacks', async () => {
  saveJSON(manifestFile, { sites: {} });
  const dir = repo('dev/diary');
  const { run } = claude();
  const diary = { name: 'Diary', folder: '~/dev/diary', purpose: 'Notes' };
  await assert.rejects(requestBoard({ ...diary, tickets: { source: 'github' } }, { run, live, repos }), { status: 400, message: /GitHub issues need a repo on GitHub/ });
  await assert.rejects(requestBoard({ ...diary, branch: 'nope' }, { run, live, repos }), { status: 400, message: /no branch nope/ });
  await assert.rejects(requestBoard({ ...diary, github: 'acme/diary' }, { run, live, repos }), { status: 400, message: /github, remote or folder/ });
  await assert.rejects(requestBoard({ ...diary, git_init: false }, { run, live, repos }), { status: 400 });
  const { session } = await (await requestBoard(diary, { run, live, repos })).started;
  join('diary', session, 4722);
  assert.deepEqual(boardRepo('diary'), { github: '', branch: 'main', repo: dir, local: true });
});

test('a folder that is not a repo needs Make it a git repo; with it the board starts on main after git init, and Retry keeps the folder', async () => {
  saveJSON(manifestFile, { sites: {} });
  const dir = folder('dev/poems', { 'one.txt': 'o' });
  const { calls, run } = claude();
  const poems = { name: 'Poems', folder: '~/dev/poems', purpose: 'Poems' };
  await assert.rejects(requestBoard(poems, { run, live, repos }), { status: 400, message: 'Not a git repo. Turn on Make it a git repo to use it.' });
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
  saveJSON(manifestFile, { sites: {}, starting: { poems: { title: 'Taken' } } });
  await assert.rejects(requestBoard({ ...poems, git_init: true }, { run, live, repos }), { status: 400, message: /route already exists/ });
  assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'a taken route makes no repo');
  saveJSON(manifestFile, { sites: {} });
  const failing = async () => ({ status: 1, stdout: '', stderr: 'Not signed in' });
  await (await requestBoard({ ...poems, git_init: true }, { run: failing, live, repos })).started;
  assert.equal(git(dir, 'log', '--format=%s'), 'Initial commit');
  assert.deepEqual(readManifest().starting.poems.branch, 'main');
  await (await retryBoard('poems', { run, live, stop: async () => {}, repos })).started;
  assert.deepEqual(calls.map((c) => c.cwd), [dir]);
  assert.equal(readManifest().starting.poems.repo, dir);
});

// docs/adr/2026-11-21-2300-new-board-and-new-course-share-one-source-field.md
test("a course reads any folder in home: a board's repo, a plain folder or a folder inside a repo, but folderPath's refusals still hold", () => {
  const shop = repo('dev/course-shop');
  folder('dev/course-shop/src');
  folder('Documents/course-notes');
  assert.deepEqual(readableFolder('~/dev/course-shop'), { folder: '~/dev/course-shop', path: shop, git: true });
  assert.deepEqual(readableFolder('~/dev/course-shop/src'), { folder: '~/dev/course-shop/src', path: path.join(shop, 'src'), git: true });
  assert.deepEqual(readableFolder('~/Documents/course-notes'), { folder: '~/Documents/course-notes', path: path.join(home, 'Documents/course-notes'), git: false });
  assert.throws(() => readableFolder('~/.claude'), /Claude’s own/);
  assert.throws(() => readableFolder('~/dev/none-here'), { status: 404 });
});

test("recent sources are the remotes and folders the hub's boards and courses use, each once, with who uses it", () => {
  const manifest = {
    sites: {
      deploy: { title: 'Deploy', remote: 'git@git.acme.dev:infra/deploy.git', owner: { repo: '/clones/deploy' } },
      kit: { title: 'Kit', github: 'acme/kit', owner: { repo: '/clones/kit' } },
      notes: { title: 'Notes', local: true, owner: { repo: path.join(home, 'dev/notes-site') } },
    },
    starting: {
      ops: { title: 'Ops', remote: 'ssh://git@git.acme.dev/infra/deploy.git', repo: '/clones/deploy' },
      diary: { title: 'Diary', folder: true, repo: path.join(home, 'dev/diary') },
      rust: { kind: 'course', title: 'Rust', repo: '/pages/rust', source: { folder: path.join(home, 'Documents/rust-book') } },
      hono: { kind: 'course', title: 'Hono', repo: '/pages/hono', source: { remote: 'https://git.sr.ht/~a/b' } },
    },
    closed: { old: { site: { title: 'Old', remote: 'https://gitlab.com/o/r.git', owner: { repo: '/clones/r' } } } },
  };
  assert.deepEqual(recentSources(manifest), {
    remotes: [
      { remote: 'git@git.acme.dev:infra/deploy.git', name: 'git.acme.dev/infra/deploy', by: ['Deploy', 'Ops'] },
      { remote: 'https://git.sr.ht/~a/b', name: 'git.sr.ht/~a/b', by: ['Hono'] },
      { remote: 'https://gitlab.com/o/r.git', name: 'gitlab.com/o/r', by: ['Old'] },
    ],
    folders: [
      { folder: '~/dev/notes-site', path: path.join(home, 'dev/notes-site'), by: ['Notes'], board: 'notes' },
      { folder: '~/dev/diary', path: path.join(home, 'dev/diary'), by: ['Diary'], board: 'diary' },
      { folder: '~/Documents/rust-book', path: path.join(home, 'Documents/rust-book'), by: ['Rust'] },
    ],
  });
  assert.deepEqual(recentSources({}), { remotes: [], folders: [] });
});
