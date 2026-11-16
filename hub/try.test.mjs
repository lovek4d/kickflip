import { home, bin } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { advance, buildScriptError, calls, clock, commit, execFileAsync, fetchTimed, config, fakeRelays, git, installWorktree, kill, listBoards, listing, manager, manifest, ownerGate, prober, read, relayOf, repo, root, script, setManager, setScript, signal, signals, site, start, state, thread, tick, tryManager, until, worktree, write } from './try-fixture.mjs';

test('an app run uses only the fixed script and arguments, worktree cwd and build env, writes a private replacement log, and leaves builders and threads alone', async () => {
  setScript(`require('node:fs').writeFileSync('called.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), board: process.env.KICKFLIP_BOARD, host: process.env.HOST, base: process.env.KICKFLIP_BASE })); console.log('stdout'); console.error('stderr');`);
  const record = fs.readFileSync(path.join(site, 'data/agents/A1.json'), 'utf8');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().kind, 'app');
  assert.equal(state().cards['w/A1'].sha, git(worktree, 'rev-parse', 'HEAD'));
  assert.deepEqual(read(path.join(worktree, 'called.json')), { args: ['w/A1', worktree], cwd: worktree, board: 'orch', host: '127.0.0.1' });
  assert.equal(fs.readFileSync(path.join(site, 'data/agents/A1.json'), 'utf8'), record);
  assert.deepEqual(thread(), []);
  const log = path.join(site, 'data/try/A1.log');
  assert.match(fs.readFileSync(log, 'utf8'), /stdout\nstderr\n/);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  setScript("console.log('replacement');");
  await start();
  await manager.settled();
  assert.equal(fs.readFileSync(log, 'utf8'), 'replacement\n');
  assert.equal(state().cards['w/A1'].state, 'ready');
});

test('settled() waits until every run is ready or has ended, and next(key, state) for its entry’s next move into state', async () => {
  await manager.settled();
  setScript("setInterval(() => { if (require('node:fs').existsSync('go')) process.exit(0); }, 20);");
  await start();
  let settled = false;
  const settling = manager.settled().then(() => { settled = true; });
  const ready = manager.next('w/A1', 'ready');
  await new Promise(setImmediate);
  assert.equal(settled, false, 'a run that is still building holds settled()');
  write(path.join(worktree, 'go'), '');
  await ready;
  await settling;
  assert.equal(state().cards['w/A1'].state, 'ready');
  // An entry already in the state waits for its next move into it.
  let moved = false;
  const again = manager.next('w/A1', 'ready').then(() => { moved = true; });
  await new Promise(setImmediate);
  assert.equal(moved, false);
  await start();
  await again;
  await manager.settled();
});

test('the manager runs its commands through run, a local git with no time limit, and the poll’s fetch through its own run', async () => {
  const ran = [];
  const record = (command, args, options = {}) => {
    ran.push({ command, fetch: args.includes('fetch'), timeout: options.timeout });
    if (args.includes('fetch')) return Promise.reject(Object.assign(new Error('offline'), { stderr: 'fatal: offline' }));
    return listing([])(command, args, options);
  };
  setManager(tryManager({ now: () => clock, log() {}, run: record }));
  setScript('process.exit(0);');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const local = ran.filter((call) => call.command === 'git');
  assert.ok(local.length);
  assert.deepEqual(local.filter((call) => call.timeout !== undefined), []);
  ran.length = 0;
  await fetchTimed({ manifest, log() {}, run: record });
  assert.deepEqual(ran.filter((call) => call.fetch).map((call) => [call.command, call.timeout]), [['git', 10_000]]);
  assert.equal(read(path.join(home, '.claude', 'kickflip', 'repo-fetch.json')).orch.error, 'fatal: offline');
});

test('script validation refuses missing, symlink, directory, foreign ownership, writable and nonexecutable files', async (t) => {
  await assert.rejects(start(), /existing regular file/);
  setScript('');
  for (const mode of [0o720, 0o702, 0o600]) {
    fs.chmodSync(script(), mode);
    await assert.rejects(start(), mode === 0o600 ? /executable/ : /writable by group or others/);
  }
  fs.chmodSync(script(), 0o700);
  const stat = fs.lstatSync;
  const mocked = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const result = stat(file, ...args);
    if (file === script()) result.uid = process.getuid() + 1;
    return result;
  });
  await assert.rejects(start(), /owned by the current user/);
  mocked.mock.restore();
  fs.renameSync(script(), script() + '.real');
  fs.symlinkSync(script() + '.real', script());
  await assert.rejects(start(), /regular file/);
  fs.unlinkSync(script());
  fs.mkdirSync(script());
  await assert.rejects(start(), /regular file/);
  assert.match(buildScriptError('relative'), /absolute/);
  await assert.rejects(start({ command: '/bin/sh' }), /only the board route/);
  await assert.rejects(start({ key: 'main' }), { status: 409, message: 'Main has no failed build to retry.' });
  await assert.rejects(start({ key: 'w/missing' }), /no item/);
  await assert.rejects(start({ key: 'w/..' }), /Task key/);
  await assert.rejects(start({ route: 'missing' }), /not a board/);
});

test('worktree resolution keeps traversal, boundary, symlink and repo checks, and the newest recorded worktree wins', async () => {
  const board = listBoards(manifest)[0];
  const file = path.join(site, 'data/agents/A1.json');
  const outside = path.join(site, 'outside');
  fs.mkdirSync(outside);
  const alias = path.join(path.dirname(worktree), path.basename(worktree) + '-alias');
  fs.symlinkSync(worktree, alias);
  for (const candidate of [outside, worktree + '/..', worktree + '-missing']) {
    write(file, { worktree: { repo, path: candidate } });
    assert.equal(await installWorktree(board, 'w/A1', manifest), '');
  }
  fs.symlinkSync(outside, path.join(worktree, 'escape'));
  write(file, { worktree: { repo, path: path.join(worktree, 'escape') } });
  assert.equal(await installWorktree(board, 'w/A1', manifest), '');
  write(file, { started: '2026-01-01', worktree: { repo, path: '/old' } });
  write(path.join(site, 'data/agents/A1@build.json'), { started: '2026-02-01', done: '2026-02-02', worktree: { repo, path: alias } });
  assert.equal(await installWorktree(board, 'w/A1', manifest), worktree);
  fs.unlinkSync(file);
  fs.unlinkSync(path.join(site, 'data/agents/A1@build.json'));
  const nested = path.join(repo, '.claude/worktrees/item');
  fs.mkdirSync(nested, { recursive: true });
  write(path.join(site, 'data/items.json'), { repo: 'example/project', items: [{ id: 'A1', worktree: '.claude/worktrees/item' }] });
  assert.equal(await installWorktree(listBoards(manifest)[0], 'w/A1', manifest), nested);
  assert.equal(await installWorktree({ ...listBoards(manifest)[0], github: 'other/repo' }, 'w/A1', manifest), '');
});

test('a failed run writes one failure status line with its exit and one reason, the keychain hint before the log, a retry once it shows failed starts, and successful runs write no message', async (t) => {
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1', install: { url: 'https://example.com/app.apk' } }] });
  setScript("console.error('errSecInternalComponent'); console.log('one\\ntwo\\nthree\\nfour\\nfive'); process.exit(7);");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const append = fsp.appendFile;
  t.mock.method(fsp, 'appendFile', async (file, ...args) => {
    if (String(file).includes(`${path.sep}threads${path.sep}`)) await held;
    return append(file, ...args);
  });
  const failed = manager.next('w/A1', 'failed');
  await start();
  await failed;
  setScript('process.exit(0);');
  const retry = start();
  await new Promise(setImmediate);
  release();
  assert.deepEqual(await retry, { status: 'started' });
  assert.equal(thread().length, 1);
  assert.deepEqual([thread()[0].line, thread()[0].text, thread()[0].detail], ['run-failed', 'Build failed (exit 7)', 'unlock the login keychain on the host']);
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(thread().length, 1);
});

test('a second concurrent start returns 409', async () => {
  setScript('setInterval(() => {}, 1000);');
  const results = await Promise.allSettled([start(), start()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  await assert.rejects(start(), { status: 409 });
});

test('a web run waits for its port and stays up with no visits while its card is open', async (t) => {
  fakeRelays(t);
  let answering = false;
  const { answers, asked } = prober(() => answering);
  setManager(tryManager({ now: () => clock, answers, log() {} }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  config({ auto_build: true });
  await start();
  await asked(32123);
  assert.equal(state().cards['w/A1'].state, 'running');
  answering = true;
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().kind, 'web');
  assert.equal(state().cards['w/A1'].https, 8500);
  for (let hour = 0; hour < 5; hour++) {
    advance(60 * 60_000);
    await tick();
  }
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.deepEqual(manager.lookup('orch', 'a1', { manifest }), { key: 'w/A1', port: state().cards['w/A1'].port });
  assert.equal(calls().includes('serve --https=8500 off'), false);
  assert.deepEqual(thread(), []);
});

test('a card serve stops and drops its entry once its card is Done, its PR merged, its card gone or its worktree removed', async (t) => {
  fakeRelays(t);
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  const serve = async () => {
    await start();
    await manager.settled();
    assert.equal(state().cards['w/A1'].state, 'ready');
  };
  const stopped = async () => {
    await tick();
    assert.equal(manager.lookup('orch', 'A1', { manifest }), null);
    assert.equal(state().cards['w/A1'], undefined);
  };
  await serve();
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1', lane: 'done' }, { id: 'A2' }] });
  await stopped();
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1', prs: [{ repo: 'example/project', number: 7 }] }, { id: 'A2' }] });
  write(path.join(home, '.claude/kickflip/github-state.json'), { prs: { 'example/project#7': { state: 'MERGED' } } });
  await serve();
  await stopped();
  fs.rmSync(path.join(home, '.claude/kickflip/github-state.json'));
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1' }, { id: 'A2' }] });
  await serve();
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A2' }] });
  await stopped();
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1' }, { id: 'A2' }] });
  await serve();
  git(repo, 'worktree', 'remove', '--force', worktree);
  await stopped();
});

test('a serve that exits after it was up starts again up to 3 times in 10 minutes on its port, then reads Serve failed', async (t) => {
  const relays = fakeRelays(t);
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  const runsFile = path.join(home, 'runs');
  const exits = path.join(home, 'exits');
  // Run n of a round exits once the test writes go/n, after the hub has it up: an exit before then is a build that
  // failed, not a serve to restart, and a fixed delay on a loaded host can come before it.
  const go = path.join(home, 'go');
  write(exits, '2');
  setScript(`const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(runsFile)}, 'run\\n');
const runs = fs.readFileSync(${JSON.stringify(runsFile)}, 'utf8').trim().split('\\n').length;
console.log('port 32123');
setInterval(() => {}, 1000);
if (runs <= Number(fs.readFileSync(${JSON.stringify(exits)}, 'utf8'))) setInterval(() => { if (fs.existsSync(${JSON.stringify(go)} + '/' + runs)) process.exit(0); }, 20);`);
  const launches = () => fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').trim().split('\n').length : 0;
  // Run n exits once it is up, and the card's entry then reads then (ready again for a restart, failed once they run out).
  const exitThen = async (n, then) => {
    const moved = manager.next('w/A1', then);
    write(path.join(go, String(n)), '');
    await moved;
    await manager.settled();
  };
  await start();
  await manager.settled();
  for (const n of [1, 2]) await exitThen(n, 'ready');
  assert.deepEqual([launches(), relays.length, state().cards['w/A1'].state], [3, 3, 'ready']);
  assert.equal(state().cards['w/A1'].https, 8500);
  assert.match(fs.readFileSync(path.join(site, 'data/try/A1.log'), 'utf8'), /^The serve exited on its own; serving it again \(2 of 3 in 10 minutes\)\./);
  assert.deepEqual(thread(), []);
  // Ten minutes on, the earlier restarts no longer count: three more exits restart it, and a fourth reads failed.
  advance(11 * 60_000);
  fs.rmSync(runsFile);
  fs.rmSync(go, { recursive: true });
  write(exits, '99');
  await start();
  await manager.settled();
  for (const n of [1, 2, 3]) await exitThen(n, 'ready');
  await exitThen(4, 'failed');
  assert.equal(thread().length, 1);
  assert.equal(relays.length, 7);
  assert.equal(launches(), 4);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /The serve exited on its own 4 times within 10 minutes/);
});

test('the stand-in tailscale keeps every mapping of serves that run at once, as tailscaled does', async () => {
  const mapped = Array.from({ length: 30 }, (_, i) => 8600 + i);
  await Promise.all(mapped.map((port) => execFileAsync(path.join(bin, 'tailscale'), ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port + 100}`])));
  assert.deepEqual(Object.keys(read(path.join(home, 'tailscale.status')).TCP).sort(), mapped.map(String));
});

test('a serve past the board’s Maximum parallel serves is refused, a busy host asks first, and Auto serve waits for room', async (t) => {
  fakeRelays(t);
  let busy = false;
  setManager(tryManager({ now: () => clock, answers: async () => true, busy: () => busy, log() {} }));
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] });
  for (const id of ['A2', 'A3']) write(path.join(site, `data/agents/${id}.json`), { worktree: { path: worktree, repo } });
  config({ max_serves: 2 });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  await start();
  await start({ key: 'w/A2' });
  await manager.settled();
  assert.deepEqual([state().cards['w/A1'].state, state().cards['w/A2'].state], ['ready', 'ready']);
  await assert.rejects(start({ key: 'w/A3' }), (e) => e.status === 409 && e.ask === 'cap' && /cap of 2 parallel serves/.test(e.message));
  // Serving a card again takes no new slot.
  assert.deepEqual(await start(), { status: 'started' });
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  await kill('w/A2');
  busy = true;
  await assert.rejects(start({ key: 'w/A3' }), (e) => e.status === 409 && e.ask === 'busy' && e.message === 'The host is busy, start this serve anyway?');
  assert.deepEqual(await start({ key: 'w/A3', anyway: true }), { status: 'started' });
  await manager.settled();
  assert.equal(state().cards['w/A3'].state, 'ready');
  await kill('w/A3');
  // Auto serve starts nothing new on a busy host or at the cap, and serves once there is room.
  config({ auto_build: true, max_serves: 1 });
  write(path.join(worktree, 'next'), 'next');
  commit(worktree, 'next');
  await kill();
  busy = true;
  await tick();
  assert.equal(Object.values(state().cards).some((card) => card.state), false);
  busy = false;
  await tick();
  await manager.settled();
  assert.equal(Object.values(state().cards).filter((card) => card.state === 'ready').length, 1);
  await tick();
  assert.equal(Object.values(state().cards).filter((card) => card.state).length, 1);
});

test('Kill stops a running or ready serve, frees its port, and Auto serve leaves it until its head moves, across a hub restart', async (t) => {
  fakeRelays(t);
  let answering = false;
  const { answers, asked } = prober(() => answering);
  setManager(tryManager({ now: () => clock, answers, log() {} }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  config({ auto_build: true });
  await tick();
  await asked(32123);
  assert.equal(state().cards['w/A1'].state, 'running');
  assert.deepEqual(await kill(), { status: 'stopped' });
  assert.equal(state().cards['w/A1'].state, undefined);
  await tick();
  assert.equal(state().cards['w/A1'].state, undefined);
  answering = true;
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  await kill();
  assert.equal(manager.lookup('orch', 'A1', { manifest }), null);
  assert.ok(calls().includes('serve --https=8500 off'));
  await assert.rejects(kill(), (e) => e.status === 409);
  await manager.stop();
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  await tick();
  assert.equal(state().cards['w/A1'].state, undefined);
  assert.deepEqual(thread(), []);
  write(path.join(worktree, 'moved'), 'moved');
  commit(worktree, 'moved');
  await tick();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].killed, undefined);
});

test('a hub restart serves each card that was up again, with Auto serve off', async (t) => {
  fakeRelays(t);
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  setScript("require('node:fs').appendFileSync('runs', 'run\\n'); console.log('port 32123'); setInterval(() => {}, 1000);");
  commit(worktree);
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  await manager.stop();
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  await manager.initialize(manifest);
  assert.equal(state().cards['w/A1'].state, 'running');
  await tick();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(fs.readFileSync(path.join(worktree, 'runs'), 'utf8'), 'run\nrun\n');
});

test('a port announcement followed by exit before readiness fails, even with exit 0', async () => {
  setManager(tryManager({ answers: async () => false, log() {} }));
  setScript("console.log('port 32123');");
  await start();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /^Build script exited before its port answered/);
});

test('the auto-build tick refreshes head, changes and script and runs each new head only when enabled', async () => {
  setScript('process.exit(0);');
  const sha = commit(worktree);
  await tick();
  assert.deepEqual(state().cards['w/A1'], { head: sha, ahead: 1, script: true });
  const before = fs.statSync(path.join(site, 'data/try.json')).mtimeMs;
  await tick();
  assert.equal(fs.statSync(path.join(site, 'data/try.json')).mtimeMs, before);
  config({ auto_build: true });
  await tick();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const first = state().cards['w/A1'].at;
  advance(1000);
  await tick();
  assert.equal(state().cards['w/A1'].at, first);
  setScript('process.exit(9);');
  const failedSha = commit(worktree, 'failure');
  await tick();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].sha, failedSha);
  await tick();
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.equal(thread().length, 1);
});

test('main builds at the remote tip regardless of auto_build, uses a detached worktree, and does not repeat a failed tip', async (t) => {
  setScript('process.exit(0);', repo);
  const sha = commit(repo, 'main script');
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha);
  await tick();
  await manager.settled();
  assert.deepEqual(state().main, { sha, branch: 'main', slug: 'example/project', at: git(repo, 'log', '-1', '--format=%cI'), state: 'ready', script: true });
  const dir = path.join(home, '.claude/kickflip/try/orch-main-a');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), sha);
  assert.throws(() => git(dir, 'symbolic-ref', '-q', 'HEAD'));
  await assert.rejects(start({ key: 'main' }), { status: 409, message: 'Main has no failed build to retry.' });
  setScript(`
console.log(require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
setInterval(() => { if (!require('node:fs').existsSync('hold')) process.exit(8); }, 20);
`, repo);
  const failedSha = commit(repo, 'broken');
  git(repo, 'update-ref', 'refs/remotes/origin/main', failedSha);
  await tick();
  await manager.settled();
  assert.equal(state().main.state, 'failed');
  assert.equal(state().main.sha, failedSha);
  await tick();
  assert.equal(state().main.state, 'failed');
  const metadata = state().main;
  setScript('process.exit(0);', repo);
  const movedSha = commit(repo, 'origin moved');
  git(repo, 'update-ref', 'refs/remotes/origin/main', movedSha);
  await manager.stop();
  let reason = 'Try builds wait on Tailscale: Tailscale isn’t signed in';
  setManager(tryManager({ waiting: async () => reason, log() {} }));
  await assert.rejects(start({ key: 'main' }), (e) => e.status === 409 && e.message === reason);
  reason = null;
  write(path.join(dir, 'hold'), '');
  assert.deepEqual(await start({ key: 'main' }), { status: 'started' });
  await assert.rejects(start({ key: 'main' }), (e) => e.status === 409 && /already running/.test(e.message));
  fs.unlinkSync(path.join(dir, 'hold'));
  await manager.settled();
  assert.equal(state().main.state, 'failed');
  assert.deepEqual(state().main, metadata);
  assert.equal(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8').trim(), failedSha);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), failedSha);
  const stat = fs.lstatSync;
  const mocked = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const result = stat(file, ...args);
    if (file === path.join(dir, '.kickflip/build')) result.mode &= ~0o111;
    return result;
  });
  await assert.rejects(start({ key: 'main' }), /executable/);
  mocked.mock.restore();
  assert.deepEqual(state().main, metadata);
  assert.match(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8'), /executable/);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(await start({ key: 'main' }), { status: 'started' });
  assert.equal(state().main.state, 'running');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), failedSha);
  await manager.settled();
  assert.equal(state().main.state, 'failed');
  assert.deepEqual(state().main, metadata);
  assert.equal(fs.readFileSync(path.join(site, 'data/try/main.log'), 'utf8').trim(), failedSha);
  assert.deepEqual(thread(), []);
});

test('a board’s build target runs .kickflip/build-<target> for its cards and main, and switching it rebuilds main', async () => {
  const setTarget = (name, body, dir) => {
    const file = path.join(dir, '.kickflip', `build-${name}`);
    write(file, `#!${process.execPath}\n${body}\n`);
    fs.chmodSync(file, 0o700);
  };
  const record = (name) => `require('node:fs').writeFileSync('ran.json', JSON.stringify({ target: ${JSON.stringify(name)}, args: process.argv.slice(2), board: process.env.KICKFLIP_BOARD, host: process.env.HOST }));`;
  for (const dir of [repo, worktree]) {
    setScript(record('default'), dir);
    setTarget('web', record('web'), dir);
    setTarget('ios', record('ios'), dir);
  }
  const sha = commit(repo, 'targets');
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha);
  fs.rmSync(path.join(worktree, '.kickflip', 'build'));
  commit(worktree, 'task targets');
  config({ build_target: 'web' });
  await tick();
  assert.equal(state().cards['w/A1'].script, true);
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  const dir = path.join(home, '.claude/kickflip/try/orch-main-a');
  assert.deepEqual(read(path.join(dir, 'ran.json')), { target: 'web', args: ['main', dir], board: 'orch', host: '127.0.0.1' });
  assert.equal(state().main.target, 'web');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.deepEqual(read(path.join(worktree, 'ran.json')), { target: 'web', args: ['w/A1', worktree], board: 'orch', host: '127.0.0.1' });
  config({ build_target: 'ios' });
  await tick();
  await manager.settled();
  assert.deepEqual([state().main.state, state().main.target], ['ready', 'ios']);
  assert.equal(read(path.join(dir, 'ran.json')).target, 'ios');
  assert.equal(state().main.sha, sha);
  config({ build_target: 'android' });
  await tick();
  assert.equal(state().cards['w/A1'].script, false);
  assert.equal(state().main, null);
  config();
  await tick();
  assert.equal(state().cards['w/A1'].script, false);
  await manager.settled();
  assert.equal(state().main.state, 'ready');
  assert.equal(read(path.join(dir, 'ran.json')).target, 'default');
  assert.equal(state().main.target, undefined);
});

test('a restart serves ready web cards again, keeps killed ones, clears the rest and stops main so the next tick serves it again', async () => {
  write(path.join(site, 'data/try.json'), { kind: 'web', cards: { 'w/A1': { state: 'ready', port: 1, https: 8500, sha: 'a' }, 'w/A2': { killed: true, sha: 'b', head: 'b' }, 'w/A3': { state: 'failed' } }, main: { state: 'running', sha: 'old', script: true, serving: { sha: 'older', https: 8500 } } });
  await manager.initialize(manifest);
  assert.deepEqual(state(), { kind: 'web', cards: { 'w/A1': { state: 'running', sha: 'a' }, 'w/A2': { killed: true, sha: 'b', head: 'b' } }, main: { sha: 'old', script: true } });
});

test('builds waiting on each other when the hub restarts run after it, and one that can no longer start fails in its thread', async () => {
  write(path.join(site, 'data/items.json'), { items: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] });
  for (const id of ['A2', 'A3']) write(path.join(site, `data/agents/${id}.json`), { worktree: { path: worktree, repo } });
  const lock = path.join(home, 'xcode.lock');
  const built = path.join(home, 'built');
  const keys = ['w/A1', 'w/A2', 'w/A3'];
  const building = await signals();
  setScript(`const fs = require('node:fs');
const take = () => {
  try { fs.mkdirSync(${JSON.stringify(lock)}); } catch { return setTimeout(take, 20); }
  fs.appendFileSync(${JSON.stringify(built)}, process.argv[2] + '\\n');
  ${signal(building, 'building')}
  setInterval(() => { if (!fs.existsSync('hold')) { fs.rmdirSync(${JSON.stringify(lock)}); process.exit(0); } }, 20);
};
take();`);
  const restart = async () => {
    await manager.stop();
    fs.rmSync(lock, { recursive: true, force: true });
    setManager(tryManager({ now: () => clock, log() {} }));
    await manager.initialize(manifest);
  };
  write(path.join(worktree, 'hold'), '');
  for (const key of keys) assert.deepEqual(await start({ key }), { status: 'started' });
  await building.next();
  await restart();
  assert.ok(keys.every((key) => state().cards[key].state === 'running'));
  fs.unlinkSync(path.join(worktree, 'hold'));
  fs.rmSync(built);
  await tick();
  await manager.settled();
  assert.ok(keys.every((key) => state().cards[key].state === 'ready'));
  assert.deepEqual(fs.readFileSync(built, 'utf8').trim().split('\n').sort(), keys);
  assert.deepEqual(thread(), []);
  write(path.join(worktree, 'hold'), '');
  await start();
  await restart();
  fs.chmodSync(script(), 0o600);
  await tick();
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /^Build script must be executable/);
});

test("a web script serves root paths and upgrades through the relay to the owner and the board's shared logins alone, and keeps its port across a new commit and Retry", async () => {
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => ({ login: 'lovek4d@github', addresses: [] }) });
  setManager(tryManager({ now: () => clock, log() {}, gate }));
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  setScript(`const server = require('node:http').createServer((req, res) => req.url === '/hold' ? res.writeHead(200).write('held') : res.end('served ' + req.url));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n' + req.url));
  server.listen(${port}, '127.0.0.1', () => console.log('port ${port}'));`);
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(manager.lookup('orch', 'a1', { manifest }).port, port);
  assert.equal(state().cards['w/A1'].https, 8500);
  assert.match(calls().find((call) => call.includes('--bg')), /^serve --bg --https=8500 http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await (await fetch(relayOf(8500) + '/nested')).text(), 'served /nested');
  const upgraded = await new Promise((resolve, reject) => {
    const request = http.request(relayOf(8500) + '/socket', { headers: { connection: 'Upgrade', upgrade: 'test' } });
    request.on('error', reject);
    request.on('upgrade', (_response, socket, head) => {
      let body = head.toString();
      socket.on('data', (chunk) => { body += chunk; });
      socket.on('end', () => { socket.destroy(); resolve(body); });
      socket.on('error', reject);
    });
    request.end();
  });
  assert.equal(upgraded, '/socket');
  // tailscale serve sends the owner's phone with its login, and anyone else is refused before the app.
  const phone = { 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'lovek4d@github' };
  assert.equal(await (await fetch(relayOf(8500) + '/nested', { headers: phone })).text(), 'served /nested');
  const friend = { 'x-forwarded-for': '100.70.1.3', 'tailscale-user-login': 'friend@github' };
  const page = await fetch(relayOf(8500) + '/nested', { headers: { ...friend, accept: 'text/html' } });
  assert.equal(page.status, 403);
  assert.match(await page.text(), /This kickflip belongs to someone else\./);
  const api = await fetch(relayOf(8500) + '/api', { method: 'POST', headers: { 'x-forwarded-for': '100.70.1.4' }, body: 'x' });
  assert.deepEqual([api.status, await api.text()], [403, '{}']);
  const refused = await new Promise((resolve, reject) => {
    const request = http.request(relayOf(8500) + '/socket', { headers: { connection: 'Upgrade', upgrade: 'test', ...friend } });
    request.on('error', reject);
    request.on('upgrade', () => reject(new Error('upgraded')));
    request.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    request.end();
  });
  assert.equal(refused, 403);
  // A login the board shares with opens its Visit links, view only (docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md).
  config({ share: ['friend@github'] });
  assert.equal(await (await fetch(relayOf(8500) + '/nested', { headers: friend })).text(), 'served /nested');
  const write = await fetch(relayOf(8500) + '/api', { method: 'POST', headers: friend, body: 'x' });
  assert.deepEqual([write.status, await write.json()], [403, { error: 'This board is shared with you to look at only.' }]);
  // A shared view opens no upgrades, so nothing outlives its share but a response, which removing the share ends.
  const sharedUpgrade = await new Promise((resolve, reject) => {
    const request = http.request(relayOf(8500) + '/socket', { headers: { connection: 'Upgrade', upgrade: 'test', ...friend } });
    request.on('error', reject);
    request.on('upgrade', () => reject(new Error('upgraded')));
    request.on('response', (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve([res.statusCode, JSON.parse(body)])); });
    request.end();
  });
  assert.deepEqual(sharedUpgrade, [403, { error: 'This board is shared with you to look at only.' }]);
  const hold = (headers) => new Promise((resolve, reject) => {
    http.get(relayOf(8500) + '/hold', { headers }, (res) => {
      const held = { ended: false, res };
      res.on('data', () => {});
      held.closed = new Promise((closed) => res.on('close', () => { held.ended = true; closed(); }));
      resolve(held);
    }).on('error', reject);
  });
  const theirs = await hold(friend);
  const owners = await hold(phone);
  manager.endUnshared();
  assert.equal(theirs.ended, false, 'still shared, still open');
  config();
  manager.endUnshared();
  await theirs.closed;
  assert.equal(owners.ended, false, "the owner's response stays open");
  owners.res.destroy();
  assert.equal((await fetch(relayOf(8500) + '/nested', { headers: friend })).status, 403);
  commit(worktree, 'new head');
  for (let n = 0; n < 2; n++) {
    await start();
    await manager.settled();
    assert.equal(state().cards['w/A1'].state, 'ready');
    assert.equal(state().cards['w/A1'].https, 8500);
    assert.equal(await (await fetch(relayOf(8500) + '/')).text(), 'served /');
  }
  await manager.stop();
  assert.equal(calls().filter((call) => call === 'serve --https=8500 off').length, 2, 'a stopping hub leaves the port mapped');
});

test('the relay hands the app an owner’s request without tailscale serve’s identity headers, so a gated demo hub behind it serves it', async () => {
  const gate = ownerGate({ addresses: () => ['127.0.0.1', '::1'], node: async () => ({ login: 'lovek4d@github', addresses: [] }) });
  setManager(tryManager({ now: () => clock, log() {}, gate }));
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  // A demo hub's own gate: a login or a forwarded address sends it to its stubbed tailscale, which doesn't answer.
  setScript(`const asked = (h) => ['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'x-forwarded-for'].filter((n) => n in h);
  const server = require('node:http').createServer((req, res) => asked(req.headers).length ? res.writeHead(503).end("Tailscale didn't answer") : res.end('served ' + req.url));
  server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n' + asked(req.headers).join(',')));
  server.listen(${port}, '127.0.0.1', () => console.log('port ${port}'));`);
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const phone = { 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'lovek4d@github', 'tailscale-user-name': 'Love', 'tailscale-user-profile-pic': 'https://pic' };
  const page = await fetch(relayOf(8500) + '/demo/', { headers: phone });
  assert.deepEqual([page.status, await page.text()], [200, 'served /demo/']);
  const upgraded = await new Promise((resolve, reject) => {
    const request = http.request(relayOf(8500) + '/socket', { headers: { connection: 'Upgrade', upgrade: 'test', ...phone } });
    request.on('error', reject);
    request.on('upgrade', (_response, socket, head) => {
      let body = head.toString();
      socket.on('data', (chunk) => { body += chunk; });
      socket.on('end', () => { socket.destroy(); resolve(body); });
    });
    request.end();
  });
  assert.equal(upgraded, '');
});

test('a stopping hub leaves its try ports mapped, and each tick serves a gone or changed mapping again', async (t) => {
  const relays = fakeRelays(t);
  const logs = [];
  setManager(tryManager({ now: () => clock, answers: async () => true, log: (line) => logs.push(line) }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  const relay = `http://127.0.0.1:${relays[0].address().port}`;
  const served = () => calls().filter((call) => call === `serve --bg --https=8500 ${relay}`).length;
  assert.equal(served(), 1);
  await tick();
  assert.equal(served(), 1, 'a mapping that is the relay stays');
  write(path.join(home, 'tailscale.status'), { TCP: { 443: { HTTPS: true } } });
  await tick();
  assert.equal(served(), 2);
  assert.ok(logs.includes('try port 8500: its serve mapping was gone; serving it again'));
  write(path.join(home, 'tailscale.status'), { TCP: { 8500: { HTTPS: true } }, Web: { 'mac.ts.net:8500': { Handlers: { '/': { Proxy: 'http://127.0.0.1:32123' } } } } });
  await tick();
  assert.equal(served(), 3);
  assert.ok(logs.includes('try port 8500: its serve mapping was changed; serving it again'));
  await manager.stop();
  assert.ok(!calls().includes('serve --https=8500 off'));
  assert.equal(read(path.join(home, 'tailscale.status')).Web['mac.ts.net:8500'].Handlers['/'].Proxy, relay);
});

