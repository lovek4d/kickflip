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
const { requestCourse, courseLessons, pagesHome } = await import('./new-course.mjs');
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
    [{ name: 'Go', learn: 'Go', github: 'a/b' }, /Send only name and learn/],
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
