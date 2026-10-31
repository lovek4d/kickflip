import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'new-board-')));
process.env.HOME = home;
const { requestBoard, dismissBoard } = await import('./new-board.mjs');
const { startingBoards, STARTING_WAIT, BG_SETTINGS } = await import('./sessions.mjs');
const { routeFromName, ROUTE_RE } = await import('./routes.mjs');
const { saveJSON, readManifest } = await import('./boards.mjs');
const manifestFile = path.join(home, '.claude', 'web-ts', 'manifest.json');
const sessionsDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const dir = path.join(home, 'hub-board');
const board = { dir, port: 0, cmd: [process.execPath, fileURLToPath(new URL('../board/server.mjs', import.meta.url))] };
const decoyDir = path.join(home, 'decoy-board');
const sites = { 'hub-orchestrator': { ...board, dir: decoyDir }, 'dev-hub': { ...board, hub: true } };
const noEvents = () => {
  for (const d of [dir, decoyDir]) assert.equal(fs.existsSync(path.join(d, 'data', 'events.jsonl')), false);
};
const live = () => new Map();
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
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(`${home}2`, { recursive: true, force: true });
});

test("a valid request starts the board's session in its folder with the board's join flags, records it on the Starting row, and appends no event to any board", async () => {
  saveJSON(manifestFile, { sites });
  const { calls, run } = claude();
  const request = await requestBoard({ name: "Bob's audit", repo: '~', purpose: 'Review $HOME changes' }, { run, live });
  assert.equal(request.route, 'bob-s-audit');
  const pending = readManifest().starting['bob-s-audit'];
  assert.deepEqual([pending.title, pending.repo], ["Bob's audit", home]);
  const started = await request.started;
  assert.deepEqual(calls, [{ cwd: home, argv: ['--bg', '--name', "Bob's audit", '--permission-mode', 'auto', '--settings', BG_SETTINGS,
    `/join-web-ts bob-s-audit --template board --title 'Bob'\\''s audit' --description 'Review $HOME changes'`] }]);
  const rec = readManifest().starting['bob-s-audit'];
  assert.equal(started.session, rec.session);
  assert.ok(fs.existsSync(path.join(sessionsDir, `${rec.session}.json`)));
  assert.deepEqual(rec, { title: "Bob's audit", repo: home, asked_at: pending.asked_at, session: rec.session, label: "Bob's audit", since: rec.since });
  const at = Date.parse(rec.asked_at);
  assert.deepEqual(startingBoards(readManifest(), at), [{ route: 'bob-s-audit', title: "Bob's audit", repo: home, askedAt: rec.asked_at, failed: false }]);
  assert.equal(startingBoards(readManifest(), at + STARTING_WAIT)[0].failed, true);
  noEvents();
  await assert.rejects(dismissBoard('bob-s-audit'), { status: 400 });
  const timedOut = readManifest();
  timedOut.starting['bob-s-audit'].asked_at = new Date(Date.now() - STARTING_WAIT).toISOString();
  saveJSON(manifestFile, timedOut);
  assert.deepEqual(await dismissBoard('bob-s-audit'), { route: 'bob-s-audit' });
  assert.equal(readManifest().starting, undefined);
});

test('a start needs no hub board, and a request with no purpose passes no description', async () => {
  const repo = path.join(home, 'repo & tools');
  fs.mkdirSync(repo);
  saveJSON(manifestFile, { sites: {} });
  const { calls, run } = claude();
  const request = await requestBoard({ name: 'Tools', repo, purpose: '' }, { run, live });
  assert.equal((await request.started).error, undefined);
  assert.deepEqual([calls[0].cwd, calls[0].argv.at(-1)], [repo, "/join-web-ts tools --template board --title 'Tools'"]);
  assert.equal(readManifest().starting.tools.repo, repo);
  assert.ok(readManifest().starting.tools.session);
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
    const { route, started } = await requestBoard({ name: `Broken ${i}`, repo: home, purpose: '' }, { run, live });
    const { error } = await started;
    assert.equal(calls.length, 1);
    assert.match(error, line);
    assert.ok(error.length <= 200, error);
    const rec = readManifest().starting[route];
    assert.deepEqual([rec.error, rec.session], [error, undefined]);
    assert.deepEqual(startingBoards(readManifest(), Date.parse(rec.asked_at)), [{ route, title: `Broken ${i}`, repo: home, askedAt: rec.asked_at, failed: true, error }]);
    noEvents();
    assert.deepEqual(await dismissBoard(route), { route });
    assert.equal(readManifest().starting, undefined);
  }
});

test('a session that joins before its start is recorded keeps the join, and the start writes no Starting row back', async () => {
  saveJSON(manifestFile, { sites });
  const { run } = claude();
  const joining = async (argv, opts) => {
    const m = readManifest();
    delete m.starting;
    m.sites.quick = { ...board, dir: path.join(home, 'quick') };
    saveJSON(manifestFile, m);
    return run(argv, opts);
  };
  const { started } = await requestBoard({ name: 'Quick', repo: home, purpose: '' }, { run: joining, live });
  assert.ok((await started).session);
  assert.deepEqual([readManifest().starting, readManifest().sites.quick.owner], [undefined, undefined]);
});

test('requests validate fields, home containment and route reservations before recording or starting anything', async () => {
  const input = { name: 'New board', repo: home, purpose: '' };
  const manifest = { sites: { 'hub-orchestrator': board, board }, starting: { pending: { since: new Date().toISOString() } } };
  saveJSON(manifestFile, manifest);
  fs.symlinkSync(path.dirname(home), path.join(home, 'outside'));
  fs.mkdirSync(`${home}2`);
  const { calls, run } = claude();
  for (const change of [{ extra: true }, { name: '' }, { name: 'n'.repeat(61) }, { name: '!!!' }, { name: 'Board' }, { name: 'Pending' },
    { repo: 'relative' }, { repo: path.dirname(home) }, { repo: `${home}2` }, { repo: '~/outside' }, { repo: '~/absent' }, { purpose: 'p'.repeat(241) }, { purpose: null }]) {
    await assert.rejects(requestBoard({ ...input, ...change }, { run, live }), { status: 400 });
  }
  assert.deepEqual(readManifest(), manifest);
  assert.deepEqual(calls, []);
  noEvents();
  assert.equal(routeFromName('  Backend & Audit! '), 'backend-audit');
  assert.equal(routeFromName('N'.repeat(60)), 'n'.repeat(41));
  assert.equal(routeFromName('__proto__'), 'proto');
  assert.ok(ROUTE_RE.test(routeFromName('Backend audit')));
});
