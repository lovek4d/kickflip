import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('new-course-'));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-config');
const claudeConfig = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
fs.writeFileSync(claudeConfig, '{}');
const trusted = (dir) => JSON.parse(fs.readFileSync(claudeConfig, 'utf8')).projects?.[dir]?.hasTrustDialogAccepted === true;
const { requestCourse, resumeCourse, courseLessons, pagesHome } = await import('./new-course.mjs');
const { settleStarts, dismissBoard } = await import('./new-board.mjs');
const { startingBoards, STARTING_WAIT, COURSE_WAIT } = await import('./sessions.mjs');
const { saveJSON, readManifest } = await import('./boards.mjs');
const manifestFile = path.join(home, '.claude', 'kickflip', 'manifest.json');
const sessionsDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const live = () => new Map();
const claude = (answer) => {
  const calls = [];
  const run = async (argv, { cwd }) => {
    calls.push({ argv, cwd });
    if (answer) return answer;
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify({ pid: 1, sessionId: id, jobId: id.slice(0, 8) }));
    return { status: 0, stdout: `backgrounded · ${id.slice(0, 8)} · course\n`, stderr: '' };
  };
  return { calls, run };
};

test('Start makes the course folder under pages, trusts it, and starts a session there whose first prompt runs /teach and then joins the folder as a page', async () => {
  saveJSON(manifestFile, { sites: {} });
  const { calls, run } = claude();
  const { route, started } = await requestCourse({ name: 'Rust ownership', learn: "Rust's borrow checker, from scratch" }, { run, live });
  assert.equal(route, 'rust-ownership');
  const dir = path.join(home, '.claude', 'kickflip', 'pages', 'rust-ownership');
  assert.equal(pagesHome(), path.dirname(dir));
  const { session } = await started;
  assert.ok(session);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, dir);
  assert.ok(trusted(dir), 'a new course folder is trusted before its session starts');
  const prompt = calls[0].argv.at(-1);
  assert.match(prompt, /^\/teach Rust's borrow checker, from scratch\n/);
  assert.match(prompt, /index\.html/);
  assert.ok(prompt.includes(`page 'Rust ownership' --session <your session id> --dir '${dir}' --icon book`), prompt);
  assert.ok(calls[0].argv.includes('--bg'));
  const rec = readManifest().starting['rust-ownership'];
  assert.deepEqual({ kind: rec.kind, title: rec.title, learn: rec.learn, repo: rec.repo, session: rec.session, phase: rec.phase },
    { kind: 'course', title: 'Rust ownership', learn: "Rust's borrow checker, from scratch", repo: dir, session, phase: 'starting' });
  const [row] = startingBoards(readManifest());
  assert.deepEqual({ route: row.route, title: row.title, course: row.course, step: row.step, failed: row.failed, branch: row.branch },
    { route: 'rust-ownership', title: 'Rust ownership', course: true, step: 'starting', failed: false, branch: undefined });
});

test('a name a site, a start or a closed board holds is refused as taken, and the fields are checked', async () => {
  for (const manifest of [{ sites: { learn: { dir: '/x' } } }, { sites: {}, starting: { learn: { title: 'Learn' } } }, { sites: {}, closed: { learn: { title: 'Learn' } } }]) {
    saveJSON(manifestFile, manifest);
    await assert.rejects(requestCourse({ name: 'Learn', learn: 'Go' }, { run: claude().run, live }), { status: 409, message: /name is taken/ });
  }
  saveJSON(manifestFile, { sites: {} });
  for (const [input, message] of [
    [{ name: '', learn: 'Go' }, /Name/],
    [{ name: '!!!', learn: 'Go' }, /letter or digit/],
    [{ name: 'Go', learn: ' ' }, /learn/],
    [{ name: 'Go', learn: 'Go', model: 'opus' }, /Send only name, learn and one source/],
  ]) await assert.rejects(requestCourse(input, { run: claude().run, live }), { status: 400, message });
  assert.equal(readManifest().starting, undefined);
});

test('a /teach session that fails to start reads failed on its Starting row, and Dismiss keeps the course folder', async () => {
  saveJSON(manifestFile, { sites: {} });
  const { run } = claude({ status: 1, stdout: '', stderr: 'teach: unknown skill' });
  const { route, started } = await requestCourse({ name: 'Bread', learn: 'Sourdough' }, { run, live });
  assert.match((await started).error, /teach: unknown skill/);
  const [row] = startingBoards(readManifest());
  assert.equal(row.failed, true);
  assert.equal(row.course, true);
  await dismissBoard(route, { live });
  assert.equal(readManifest().starting, undefined);
  assert.ok(fs.existsSync(path.join(pagesHome(), 'bread')), 'the folder stays for a course of the same name to reuse');
});

test("a course waits COURSE_WAIT before it reads failed, a board's start STARTING_WAIT", () => {
  assert.ok(COURSE_WAIT > STARTING_WAIT);
  const now = Date.parse('2026-11-18T06:00:00Z');
  const asked = (ms) => new Date(now - ms).toISOString();
  const manifest = { sites: {}, starting: {
    course: { kind: 'course', title: 'Course', asked_at: asked(STARTING_WAIT + 1000), phase: 'starting' },
    board: { title: 'Board', asked_at: asked(STARTING_WAIT + 1000), phase: 'starting', branch: 'main' },
  } };
  assert.deepEqual(startingBoards(manifest, now).map((r) => [r.route, r.failed]), [['course', false], ['board', true]]);
  manifest.starting.course.asked_at = asked(COURSE_WAIT + 1000);
  assert.equal(startingBoards(manifest, now)[0].failed, true);
});

test("once the course's page joins, its Starting row is gone at once and the hub's tick drops the record", async () => {
  const dir = path.join(pagesHome(), 'go');
  saveJSON(manifestFile, {
    sites: { go: { dir, title: 'Go', owner: { session: 's1' } } },
    starting: { go: { kind: 'course', title: 'Go', asked_at: new Date().toISOString(), session: 's1', joined_at: new Date().toISOString() } },
  });
  assert.deepEqual(startingBoards(readManifest(), Date.now(), undefined, () => false), []);
  assert.deepEqual(await settleStarts(), ['go']);
  assert.equal(readManifest().starting, undefined);
});

test("a course's lesson count is its lessons/*.html, only for a folder under pages", () => {
  const dir = path.join(pagesHome(), 'count');
  assert.equal(courseLessons(dir), null, 'no folder yet');
  fs.mkdirSync(path.join(dir, 'lessons'), { recursive: true });
  assert.equal(courseLessons(dir), 0);
  for (const f of ['0001-a.html', '0002-b.html', 'notes.md', '.0003-c.html']) fs.writeFileSync(path.join(dir, 'lessons', f), '');
  assert.equal(courseLessons(dir), 2);
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(path.join(elsewhere, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'lessons', '0001-a.html'), '');
  assert.equal(courseLessons(elsewhere), null);
  assert.equal(courseLessons(undefined), null);
});

test("resuming a course whose session is down resumes the same session in its folder, prompted to carry on to the next lesson", async () => {
  const dir = path.join(pagesHome(), 'resume-me');
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  saveJSON(manifestFile, { sites: { 'resume-me': { dir, title: 'Resume me', owner: { session: id, label: 'resume-me' } } } });
  const calls = [];
  const run = async (argv, { cwd }) => { calls.push({ argv, cwd }); return { status: 0, stdout: `backgrounded · ${id.slice(0, 8)} · resume-me\n`, stderr: '' }; };
  const r = await resumeCourse('resume-me', { run, live: () => new Map() });
  assert.equal(r.started, true);
  const resume = calls.find((c) => c.argv[0] === '--resume');
  assert.deepEqual([resume.argv[1], resume.cwd], [id, dir]);
  assert.match(resume.argv.at(-1), /next lesson/);
  assert.match(resume.argv.at(-1), /Resume me/);
});

test('a course whose session is already live just opens: nothing is started', async () => {
  const dir = path.join(pagesHome(), 'up-already');
  fs.mkdirSync(dir, { recursive: true });
  saveJSON(manifestFile, { sites: { 'up-already': { dir, title: 'Up', owner: { session: 's9' } } } });
  const { calls, run } = claude();
  const r = await resumeCourse('up-already', { run, live: () => new Map([['s9', { pid: 1 }]]) });
  assert.equal(r.started, false);
  assert.equal(calls.length, 0);
});

test('a course with no recorded session starts a fresh /teach in its folder and records it as the page\'s owner', async () => {
  const dir = path.join(pagesHome(), 'no-session');
  fs.mkdirSync(dir, { recursive: true });
  saveJSON(manifestFile, { sites: { 'no-session': { dir, title: 'No session' } } });
  const { calls, run } = claude();
  const r = await resumeCourse('no-session', { run, live });
  assert.equal(r.started, true);
  assert.equal(calls[0].cwd, dir);
  assert.match(calls[0].argv.at(-1), /^\/teach /);
  assert.match(calls[0].argv.at(-1), /next lesson/);
  assert.equal(readManifest().sites['no-session'].owner.session, r.session);
});

// docs/adr/2026-11-18-2030-a-launch-is-one-exclusive-claim.md
test('two taps on a course with no session at once start one /teach', async () => {
  const dir = path.join(pagesHome(), 'double-tap');
  fs.mkdirSync(dir, { recursive: true });
  saveJSON(manifestFile, { sites: { 'double-tap': { dir, title: 'Double tap' } } });
  const { calls, run } = claude();
  const taps = await Promise.all([resumeCourse('double-tap', { run, live }), resumeCourse('double-tap', { run, live })]);
  assert.equal(calls.length, 1, 'one session started');
  assert.deepEqual(taps.map((r) => r.started).sort(), [false, true]);
  assert.equal(readManifest().sites['double-tap'].owner.session, taps.find((r) => r.started).session);
});

test('only a course page under pages can be resumed', async () => {
  saveJSON(manifestFile, { sites: { plain: { dir: path.join(home, 'elsewhere'), title: 'Plain' } } });
  await assert.rejects(resumeCourse('plain', { run: claude().run, live }), { status: 404 });
  await assert.rejects(resumeCourse('nope', { run: claude().run, live }), { status: 404 });
});

// docs/adr/2026-11-21-2300-new-board-and-new-course-share-one-source-field.md
// A repo service that records what a course asks of it: a clone in the shared clone home, on the repo's default branch.
const fakeRepos = ({ cloned = false, fail } = {}) => {
  const asked = [];
  const base = path.join(home, '.claude', 'kickflip', 'repos');
  const at = (repo) => path.join(base, ...repo.replace(/^git@|\.git$/g, '').replace(':', '/').split('/'));
  return {
    asked, base, path: at, cloned: () => cloned,
    async branches(repo) { asked.push(['branches', repo]); return { defaultBranch: 'trunk', branches: ['trunk'] }; },
    async ensure(repo, branch, { progress } = {}) {
      asked.push(['ensure', repo, branch]);
      if (fail) throw new Error(fail);
      progress?.(40);
      fs.mkdirSync(at(repo), { recursive: true });
      return at(repo);
    },
  };
};

test('a course that learns from a GitHub repo clones it into the shared clone home, and /teach reads it there while lessons stay in the pages folder', async () => {
  saveJSON(manifestFile, { sites: {} });
  const { calls, run } = claude();
  const repos = fakeRepos();
  const { route, started } = await requestCourse({ name: 'Hono inside', learn: 'How its router works', github: 'honojs/hono' }, { run, live, repos });
  const rec = readManifest().starting[route];
  assert.deepEqual([rec.phase, rec.source], ['cloning', { github: 'honojs/hono' }], 'a repo not cloned yet starts on cloning');
  assert.ok((await started).session);
  const clone = repos.path('honojs/hono');
  assert.deepEqual(repos.asked, [['branches', 'honojs/hono'], ['ensure', 'honojs/hono', 'trunk']]);
  const dir = path.join(pagesHome(), 'hono-inside');
  assert.equal(calls[0].cwd, dir, 'the session runs in the course folder, never in the repo');
  const argv = calls[0].argv;
  assert.equal(argv[argv.indexOf('--add-dir') + 1], clone, 'the session may read the clone');
  assert.ok(argv.indexOf('--add-dir') < argv.indexOf('--name'), '--add-dir takes values until the next flag, so it never sits before the prompt');
  const prompt = argv.at(-1);
  assert.match(prompt, /^\/teach How its router works\n/);
  assert.ok(prompt.includes(`Learn from honojs/hono, cloned at ${clone}`), prompt);
  assert.match(prompt, /never write to it/);
  assert.equal(readManifest().starting[route].phase, 'starting');
});

test('a course on a repo already cloned starts on starting, and a remote on another host is read the same way', async () => {
  saveJSON(manifestFile, { sites: {} });
  const { calls, run } = claude();
  const repos = fakeRepos({ cloned: true });
  const remote = 'git@git.acme.dev:infra/deploy.git';
  const { route, started } = await requestCourse({ name: 'Deploy', learn: 'The deploy scripts', remote }, { run, live, repos });
  assert.deepEqual([readManifest().starting[route].phase, readManifest().starting[route].source], ['starting', { remote }]);
  await started;
  assert.ok(calls[0].argv.at(-1).includes(`Learn from git.acme.dev/infra/deploy, cloned at ${repos.path(remote)}`), calls[0].argv.at(-1));
});

test('a course that learns from a folder on this Mac reads it in place: no clone, its path under --add-dir, lessons in the pages folder', async () => {
  saveJSON(manifestFile, { sites: {} });
  const notes = path.join(home, 'Documents', 'rust-book');
  fs.mkdirSync(notes, { recursive: true });
  const { calls, run } = claude();
  const repos = fakeRepos();
  const { route, started } = await requestCourse({ name: 'Rust book', learn: 'Chapter 4', folder: '~/Documents/rust-book' }, { run, live, repos });
  assert.deepEqual(readManifest().starting[route].source, { folder: notes });
  assert.equal(readManifest().starting[route].phase, 'starting');
  await started;
  assert.deepEqual(repos.asked, [], 'a folder is never cloned');
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--add-dir') + 1], notes);
  assert.ok(calls[0].argv.at(-1).includes(`Learn from the folder ~/Documents/rust-book at ${notes}`), calls[0].argv.at(-1));
});

test('a course with no source passes no --add-dir; a source is one of github, remote or folder, and a bad one is refused before anything is reserved', async () => {
  saveJSON(manifestFile, { sites: {} });
  const { calls, run } = claude();
  await (await requestCourse({ name: 'Plain topic', learn: 'Bread' }, { run, live, repos: fakeRepos() })).started;
  assert.equal(calls[0].argv.includes('--add-dir'), false);
  assert.doesNotMatch(calls[0].argv.at(-1), /Learn from/);
  saveJSON(manifestFile, { sites: {} });
  for (const [input, message] of [
    [{ name: 'Go', learn: 'Go', github: 'a/b', folder: '~/x' }, /one source/],
    [{ name: 'Go', learn: 'Go', github: 'not a repo' }, /owner\/name/],
    [{ name: 'Go', learn: 'Go', folder: '~/nowhere' }, /No folder there/],
    [{ name: 'Go', learn: 'Go', folder: '~/.claude' }, /Claude’s own/],
    [{ name: 'Go', learn: 'Go', branch: 'main' }, /Send only name, learn and one source/],
  ]) await assert.rejects(requestCourse(input, { run, live, repos: fakeRepos() }), { message });
  assert.equal(readManifest().starting, undefined);
});

test("a course whose clone fails reads failed on its Starting row with git's line, and never starts claude", async () => {
  saveJSON(manifestFile, { sites: {} });
  const { calls, run } = claude();
  const { route, started } = await requestCourse({ name: 'Private one', learn: 'x', github: 'acme/private' }, { run, live, repos: fakeRepos({ fail: 'Not found, or you don\'t have access.' }) });
  assert.match((await started).error, /don't have access/);
  assert.equal(calls.length, 0);
  assert.equal(startingBoards(readManifest()).find((r) => r.route === route).failed, true);
});
