import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'close-board-')));
process.env.HOME = home;
const { boardClosure, closeBoard, closedBoards, reopenBoard } = await import('./close-board.mjs');
const { readManifest, saveJSON, listBoards, hubBoard, withManifestLock } = await import('./boards.mjs');
const { checkSessions, resumeSession, runSessionStop, stopSession } = await import('./sessions.mjs');
const { requestBoard } = await import('./new-board.mjs');
const web = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const id = '12345678-1234-1234-1234-123456789abc';
const boardServer = fileURLToPath(new URL('../board/server.mjs', import.meta.url));
const cliFile = fileURLToPath(new URL('../bin/kickflip.mjs', import.meta.url));
const live = () => new Map();
function fixture({ hub = false, waves = false } = {}) {
  const dir = web('sites', 'shop');
  const data = waves ? path.join(home, '.claude', 'waves', 'shop') : path.join(dir, 'data');
  write(path.join(dir, 'board.json'), { title: 'The Shop', slug: 'shop', items: waves ? 'waves' : 'data/cards.json' });
  write(path.join(data, waves ? 'wave.json' : 'cards.json'), { repo: 'o/r', items: [{ id: 'S1', pr: 42, status: 'building' }, { id: 'S2', status: 'done' }] });
  write(path.join(data, 'agents', 'S1.json'), { label: 'Builder', started: '2026-10-30T00:00:00Z', eta: '2026-11-01T00:00:00Z' });
  write(path.join(data, 'agents', 'S1@review.json'), { label: 'Reviewer', kind: 'codex', started: '2026-10-30T00:00:00Z' });
  write(path.join(data, 'agents', 'S1@install.json'), { label: 'Install', kind: 'install', started: '2026-10-30T00:00:00Z' });
  write(path.join(data, 'agents', 'S2.json'), { label: 'Finished', started: '2026-10-29T00:00:00Z', done: '2026-10-30T00:00:00Z' });
  write(path.join(dir, 'data', 'notes.md'), 'Kept notes');
  write(path.join(dir, 'data', 'threads', 'shop__S1.jsonl'), '{"text":"Kept thread"}\n');
  const site = { dir, cmd: [process.execPath, boardServer, dir], port: 49001, title: 'Shop', description: 'A shop', icon: 'board', color: '#abcdef',
    watch: ['data/events.jsonl'], filter: 'ask', created: '2026-10-01T00:00:00Z', hub,
    owner: { session: id, repo: home, model: 'opus', label: 'Shop owner', since: '2026-10-01T00:00:00Z' } };
  saveJSON(web('manifest.json'), { version: 1, migrated: ['hub-flag'], sites: { shop: site, page: { dir: home, cmd: ['echo'], port: 49002 } } });
  return { dir, data, site };
}
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('close and reopen retain the folder and complete manifest entry, stop the session and builders, and resume the recorded session, the hub board like any other', async () => {
  for (const waves of [false, true]) {
    const { dir, data, site } = fixture({ waves, hub: waves });
    const warning = await boardClosure('shop');
    assert.equal(warning.title, 'The Shop');
    assert.deepEqual(warning.prs.map((p) => p.pr), [42]);
    assert.deepEqual(warning.builders.map((b) => b.agent).sort(), ['install', 'main', 'review']);
    let running = new Map([[id, { sessionId: id, pid: 123, kind: 'bg', jobId: '12345678' }]]);
    const stops = [];
    const out = await closeBoard('shop', 'The Shop', { live: () => running, stop: async (record, options) => { stops.push([record, options]); running = new Map(); } });
    assert.deepEqual([out.route, out.filesKept, out.buildersClosed, out.next], ['shop', dir, 3, '/_hub/']);
    assert.equal(stops.length, 1);
    assert.deepEqual([stops[0][0].sessionId, stops[0][1].cwd], [id, home]);
    assert.equal(readManifest().sites.shop, undefined);
    assert.deepEqual(readManifest().closed.shop.site, site);
    assert.deepEqual(listBoards().map((b) => b.route), []);
    assert.equal(hubBoard(), undefined);
    assert.deepEqual(closedBoards().map((b) => [b.route, b.title]), [['shop', 'The Shop']]);
    assert.deepEqual([readManifest().version, readManifest().migrated], [1, ['hub-flag']]);
    for (const file of ['S1.json', 'S1@review.json', 'S1@install.json']) {
      const builder = read(path.join(data, 'agents', file));
      assert.ok(builder.done);
      assert.match(builder.note, /Board closed/);
      assert.equal(builder.eta, undefined);
    }
    assert.equal(read(path.join(data, 'agents', 'S2.json')).done, '2026-10-30T00:00:00Z');
    assert.equal(read(path.join(data, waves ? 'wave.json' : 'cards.json')).items[0].pr, 42);
    assert.equal(fs.readFileSync(path.join(dir, 'data', 'notes.md'), 'utf8'), 'Kept notes');
    assert.match(fs.readFileSync(path.join(dir, 'data', 'threads', 'shop__S1.jsonl'), 'utf8'), /Kept thread[\s\S]*Board closed/);
    let wakes = 0;
    await checkSessions({ live, resume: async () => { wakes++; } });
    assert.equal(wakes, 0);
    const calls = [];
    const tmuxCalls = [];
    const reopened = await reopenBoard('shop', { live, run: async (argv, opts) => {
      calls.push([argv, opts.cwd]);
      return { status: 0, stdout: argv[0] === 'agents' ? JSON.stringify([{ sessionId: id, kind: 'background' }]) : 'backgrounded · 12345678 · Shop', stderr: '' };
    }, tmux: (argv) => { tmuxCalls.push(argv); return { status: argv[0] === 'has-session' ? 1 : 0, stdout: '', stderr: '' }; } });
    assert.deepEqual(reopened, { route: 'shop', session: id });
    assert.deepEqual(readManifest().sites.shop, site);
    assert.equal(readManifest().closed, undefined);
    // The hub board comes back in the foreground in its tmux session; any other board in the background.
    if (waves) assert.deepEqual([calls.length, tmuxCalls.map((a) => a.slice(0, 6)), tmuxCalls[1][tmuxCalls[1].indexOf('--resume') + 1]], [0, [['has-session', '-t', '=kickflip-shop'], ['new-session', '-d', '-s', 'kickflip-shop', '-c', home]], id]);
    else {
      assert.deepEqual([calls[1][0].slice(0, 3), calls[1][1], tmuxCalls], [['--resume', id, '--bg'], home, []]);
    }
  }
});

test('an incorrect typed title is refused without changing records or stopping anything', async () => {
  for (const [name, status] of [['Shop', 400], ['the shop', 400], [undefined, 400]]) {
    const { data } = fixture();
    const before = readManifest();
    await assert.rejects(closeBoard('shop', name, { live: () => { assert.fail('looked up a process'); }, stop: () => assert.fail('stopped a process') }), { status });
    assert.deepEqual(readManifest(), before);
    assert.equal(read(path.join(data, 'agents', 'S1.json')).done, undefined);
  }
});

test('a failed stop keeps the board open, and a failed resume leaves the closed entry available to retry', async () => {
  const { data } = fixture();
  const before = readManifest();
  await assert.rejects(closeBoard('shop', 'The Shop', { live: () => new Map([[id, { pid: 1 }]]), stop: async () => { throw new Error('stop refused'); } }), /stop refused/);
  assert.deepEqual(readManifest(), before);
  assert.equal(read(path.join(data, 'agents', 'S1.json')).done, undefined);
  await closeBoard('shop', 'The Shop', { live });
  const closed = readManifest();
  await assert.rejects(reopenBoard('shop', { live, run: async () => ({ status: 1, stdout: '', stderr: 'Not signed in' }) }), /Not signed in/);
  assert.deepEqual(readManifest(), closed);
});

test('closed routes are reserved against new boards, starts and joins, and CLI close validates the title', async () => {
  fixture();
  assert.throws(() => execFileSync(process.execPath, [cliFile, 'close', 'shop', '--name', 'Shop'], { encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 2 && /name exactly/.test(e.stderr));
  const closed = JSON.parse(execFileSync(process.execPath, [cliFile, 'close', 'shop', '--name', 'The Shop'], { encoding: 'utf8' }));
  assert.equal(closed.buildersClosed, 3);
  await assert.rejects(requestBoard({ name: 'Shop', repo: home, purpose: '' }), { status: 400 });
  assert.throws(() => execFileSync(process.execPath, [cliFile, 'join', '--name', 'shop', '--session', id, '--force'], { stdio: 'pipe' }), (e) => e.status === 2 && /closed/.test(e.stderr));
  assert.throws(() => execFileSync(process.execPath, [cliFile, 'start', 'shop'], { stdio: 'pipe' }), (e) => e.status === 1 && /closed/.test(e.stderr));
  const fake = path.join(home, 'fake-claude');
  write(fake, `#!${process.execPath}\nconsole.log(process.argv[2] === 'agents' ? JSON.stringify([{sessionId: '${id}', kind: 'background'}]) : 'backgrounded · 12345678 · Shop');\n`);
  fs.chmodSync(fake, 0o755);
  const reopened = JSON.parse(execFileSync(process.execPath, [cliFile, 'reopen', 'shop'], { encoding: 'utf8', env: { ...process.env, KICKFLIP_CLAUDE: fake } }));
  assert.deepEqual(reopened, { route: 'shop', session: id });
});

test('background stop uses claude stop through the runner and already stopped sessions run nothing', async () => {
  const calls = [];
  await runSessionStop({ kind: 'bg', sessionId: id, jobId: '12345678' }, { cwd: home, run: async (argv, opts) => { calls.push([argv, opts]); return { status: 0 }; } });
  assert.deepEqual(calls, [[['stop', '12345678'], { cwd: home, timeout: 8000 }]]);
  await assert.rejects(runSessionStop({ kind: 'bg', sessionId: id }, { cwd: home, run: async () => ({ status: 1, stderr: 'not found' }) }), /claude stop failed: not found/);
  await stopSession({ session: id }, { live, stop: () => assert.fail('stopped an absent session') });
});

test('close waits for an in-flight session wake, then stops the session it resumed', async () => {
  fixture();
  let running = new Map();
  let finishResume;
  let entered;
  const inRunner = new Promise((resolve) => { entered = resolve; });
  const resumed = resumeSession('shop', { live: () => running, run: async (argv) => {
    if (argv[0] === 'agents') return { status: 0, stdout: JSON.stringify([{ sessionId: id, kind: 'background' }]) };
    entered();
    await new Promise((resolve) => { finishResume = resolve; });
    running = new Map([[id, { sessionId: id, pid: 123, kind: 'bg' }]]);
    return { status: 0, stdout: 'backgrounded · 12345678 · Shop' };
  } });
  await inRunner;
  let stopped = false;
  const closed = closeBoard('shop', 'The Shop', { live: () => running, stop: async () => { stopped = true; running = new Map(); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finishResume();
  await resumed;
  await closed;
  assert.equal(stopped, true);
  assert.equal(readManifest().sites.shop, undefined);
  assert.equal(running.size, 0);
});

test('reopen refuses a reused port and a missing folder without losing its closed entry', async () => {
  const { dir, site } = fixture();
  await closeBoard('shop', 'The Shop', { live });
  const before = readManifest();
  saveJSON(web('manifest.json'), { ...before, sites: { other: { port: site.port } } });
  await assert.rejects(reopenBoard('shop', { live }), { status: 409, message: 'The board’s recorded port is in use by another site.' });
  saveJSON(web('manifest.json'), before);
  fs.renameSync(dir, `${dir}-saved`);
  try {
    await assert.rejects(reopenBoard('shop', { live }), { status: 409, message: 'The board’s folder is missing.' });
    assert.deepEqual(readManifest(), before);
  } finally { fs.renameSync(`${dir}-saved`, dir); }
});


test('terminal stopping refuses unknown or reused process identities and signals only a verified session', async (t) => {
  const procStart = 'Sat Oct 31 10:00:00 2026';
  const started = Date.parse('2026-10-31T10:00:00Z');
  const signals = [];
  t.mock.method(process, 'kill', (...args) => signals.push(args));
  const record = { pid: 123, sessionId: id, kind: 'interactive', procStart };
  const signal = (...args) => signals.push(args);
  for (const [change, observed] of [[{ procStart: undefined }, started], [{ procStart: 'unknown' }, started], [{}, started + 60_000], [{}, undefined]]) {
    await assert.rejects(runSessionStop({ ...record, ...change }, { cwd: home, signal, starts: () => new Map([[123, observed]]) }), /Cannot verify.*process identity/);
    assert.deepEqual(signals, []);
  }
  fixture();
  const before = readManifest();
  await assert.rejects(closeBoard('shop', 'The Shop', { live: () => new Map([[id, { ...record, procStart: undefined }]]) }), /Cannot verify.*process identity/);
  assert.deepEqual(signals, []);
  assert.deepEqual(readManifest(), before);
  await runSessionStop(record, { cwd: home, signal, starts: () => new Map([[123, started]]) });
  assert.deepEqual(signals, [[123, 'SIGTERM']]);
});

test('close refuses a session shared with another board, including the flagged hub, before stopping or changing anything', async () => {
  for (const hub of [false, true]) {
    const { site, data } = fixture();
    const manifest = readManifest();
    manifest.sites.other = { ...site, title: 'Other Board', hub, dir: web('sites', 'other'), port: 49003 };
    saveJSON(web('manifest.json'), manifest);
    const before = read(path.join(data, 'agents', 'S1.json'));
    let stopped = false;
    await assert.rejects(closeBoard('shop', 'The Shop', { live, stop: async () => { stopped = true; } }), (error) => error.status === 409 && /Other Board.*\/other/.test(error.message));
    assert.equal(stopped, false);
    assert.deepEqual(readManifest(), manifest);
    assert.deepEqual(read(path.join(data, 'agents', 'S1.json')), before);
  }
});

test('failed reopen keeps the session lock until rollback so a queued resume cannot launch into a closed board', async () => {
  fixture();
  await closeBoard('shop', 'The Shop', { live });
  let fail;
  let entered;
  const inRunner = new Promise((resolve) => { entered = resolve; });
  const reopening = reopenBoard('shop', { live, run: async (argv) => {
    if (argv[0] === 'agents') return { status: 0, stdout: JSON.stringify([{ sessionId: id, kind: 'background' }]) };
    entered();
    return new Promise((resolve) => { fail = () => resolve({ status: 1, stderr: 'Resume refused' }); });
  } }).then(() => null, (error) => error);
  await inRunner;
  let release;
  let locked;
  const holding = new Promise((resolve) => { locked = resolve; });
  const writer = withManifestLock(async () => { locked(); await new Promise((resolve) => { release = resolve; }); });
  await holding;
  let launches = 0;
  const queued = resumeSession('shop', { live, run: async (argv) => {
    if (argv[0] === 'agents') return { status: 0, stdout: JSON.stringify([{ sessionId: id, kind: 'background' }]) };
    launches++;
    return { status: 0, stdout: 'backgrounded · 12345678 · Shop' };
  } }).then(() => null, (error) => error);
  fail();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const launchedBeforeRollback = launches;
  release();
  await writer;
  const [refused, blocked] = await Promise.all([reopening, queued]);
  assert.match(refused.message, /Resume refused/);
  assert.equal(launchedBeforeRollback, 0);
  assert.equal(launches, 0);
  assert.match(blocked.message, /closed/);
  assert.equal(readManifest().sites.shop, undefined);
  assert.ok(readManifest().closed.shop);
});

test('reopen rewinds to the cursor saved before stopping even if the old watcher advanced while closed', async () => {
  const { dir } = fixture();
  const cursor = path.join(dir, 'data', `.watch-cursor-${id}.json`);
  const event = JSON.stringify({ id: 'waiting', kind: 'ask', ts: new Date().toISOString(), data: { text: 'Do this next' } });
  write(path.join(dir, 'data', 'events.jsonl'), event + '\n');
  write(cursor, { 'data/events.jsonl': 0 });
  let running = new Map([[id, { sessionId: id, kind: 'bg', pid: 123 }]]);
  await closeBoard('shop', 'The Shop', { live: () => running, stop: async () => { write(cursor, { 'data/events.jsonl': 1 }); running = new Map(); } });
  write(cursor, { 'data/events.jsonl': 1 });
  assert.deepEqual(readManifest().closed.shop.cursor, { 'data/events.jsonl': 0 });
  await reopenBoard('shop', { live, run: async (argv) => {
    if (argv[0] === 'agents') return { status: 0, stdout: JSON.stringify([{ sessionId: id, kind: 'background' }]) };
    assert.deepEqual(read(cursor), { 'data/events.jsonl': 0 });
    return { status: 0, stdout: 'backgrounded · 12345678 · Shop' };
  } });
  assert.deepEqual(read(cursor), { 'data/events.jsonl': 0 });
  const watcherFile = fileURLToPath(new URL('../bin/wait-events.mjs', import.meta.url));
  const watcher = spawn(process.execPath, [watcherFile, 'shop', id], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { watcher.kill(); reject(new Error('Watcher did not deliver the saved event')); }, 30000);
    watcher.stdout.on('data', (chunk) => { stdout += chunk; });
    watcher.stderr.on('data', (chunk) => { stderr += chunk; });
    watcher.on('error', (error) => { clearTimeout(timeout); reject(error); });
    watcher.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /event data\/events.jsonl .*"id":"waiting"/);
});


test('a resumed copy inherits the saved cursor and a missing cursor replays every pending watched line', async () => {
  const { dir } = fixture();
  const cursor = path.join(dir, 'data', `.watch-cursor-${id}.json`);
  fs.rmSync(cursor, { force: true });
  const manifest = readManifest();
  manifest.sites.shop.watch.push('data/other.jsonl');
  saveJSON(web('manifest.json'), manifest);
  await closeBoard('shop', 'The Shop', { live });
  assert.deepEqual(readManifest().closed.shop.cursor, { 'data/events.jsonl': 0, 'data/other.jsonl': 0 });
  write(cursor, { 'data/events.jsonl': 5, 'data/other.jsonl': 2 });
  const copy = 'abcdef01-1234-1234-1234-123456789abc';
  write(path.join(home, '.claude', 'sessions', 'copy.json'), { pid: 1, sessionId: copy, jobId: copy.slice(0, 8) });
  const reopened = await reopenBoard('shop', { live, run: async (argv) => {
    if (argv[0] === 'agents') return { status: 0, stdout: '[]' };
    assert.deepEqual(read(cursor), { 'data/events.jsonl': 0, 'data/other.jsonl': 0 });
    return { status: 0, stdout: 'backgrounded · abcdef01 · Shop' };
  } });
  assert.equal(reopened.session, copy);
  assert.equal(readManifest().sites.shop.owner.session, copy);
  assert.deepEqual(read(path.join(dir, 'data', `.watch-cursor-${copy}.json`)), { 'data/events.jsonl': 0, 'data/other.jsonl': 0 });
});
