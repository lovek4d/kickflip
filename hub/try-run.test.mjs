import { home, bin, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { advance, calls, clock, commit, config, fakeRelays, git, kill, manager, manifest, prober, repo, script, setManager, setScript, signal, signals, site, start, state, thread, tick, tryManager, until, worktree, write } from './try-fixture.mjs';

test('the hub build route enforces loopback and fixed inputs', async (t) => {
  setScript("require('node:http').createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', function () { console.log('port ' + this.address().port); });");
  const web = path.join(home, '.claude/kickflip');
  write(path.join(web, 'manifest.json'), manifest);
  write(path.join(web, 'settings.json'), { quiet: { start: '23:59', end: '00:00', hold: false } });
  const { port } = await inProcessHub(t);
  // Try builds wait until Tailscale serves the hub on the port it listens on (readiness.mjs), here this hub's.
  write(path.join(home, 'tailscale.status'), { Web: { 'mac.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });
  // Resolves once the board's try.json holds a ready w/A1. The hub's try manager replaces the file on each change, so
  // each change ends the watch on the file it replaced, and the wait watches the new one before it reads it again.
  const ready = () => new Promise((resolve) => {
    const file = path.join(site, 'data', 'try.json');
    const check = () => {
      const watcher = fs.watch(file, () => { watcher.close(); check(); });
      if (state().cards['w/A1']?.state === 'ready') { watcher.close(); resolve(); }
    };
    check();
  });
  // POSTs body to the hub's /_hub/<route> → its status code. http.request, not fetch, so a test can set Host.
  const call = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: `/_hub/${route}`, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
  const outside = [{ origin: 'https://mac.ts.net' }, { 'x-forwarded-for': '100.64.0.1' }, { host: 'mac.ts.net' }];
  const input = { route: 'orch', key: 'w/A1' };
  for (const headers of outside) assert.equal(await call('build', input, headers), 403);
  assert.equal(await call('build', { ...input, command: '/bin/sh' }), 400);
  assert.equal(await call('build', { ...input, key: 'main' }), 409);
  assert.equal(await call('build', input), 202);
  await ready();
  for (const headers of outside) assert.equal(await call('kill', input, headers), 403);
  assert.equal(await call('kill', { ...input, anyway: true }), 400);
  assert.equal(await call('kill', input), 200);
  assert.equal(state().cards['w/A1'].state, undefined);
  assert.equal(await call('kill', input), 409);
  for (const headers of outside) assert.equal(await call('pull', { route: 'orch' }, headers), 403);
  assert.equal(await call('pull', { route: 'orch', key: 'main' }), 400);
  assert.equal(await call('pull', { route: 'orch' }), 200);
});

test('a running script with no port fails after sixty minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setScript('setInterval(() => {}, 1000);');
  await start();
  t.mock.timers.tick(59 * 60_000);
  assert.equal(state().cards['w/A1'].state, 'running');
  t.mock.timers.tick(60_000);
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /No port line within 60 minutes/);
  t.mock.timers.reset();
});

test('an unanswered announced port fails after sixty seconds', async () => {
  const { answers, asked } = prober(() => false);
  setManager(tryManager({ now: () => clock, answers, log() {} }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await asked(32123);
  advance(61_000);
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /Nothing answered.*60 seconds/);
});

test('shutdown kills the whole process group, escalating when a server ignores SIGTERM, with no failure message, and refuses new starts', async () => {
  // No grace: the stop escalates to SIGKILL at once, which the server needs.
  setManager(tryManager({ now: () => clock, log() {}, grace: 0 }));
  const up = await signals();
  const server = `process.on('SIGTERM', () => {}); ${signal(up, 'server')} setInterval(() => {}, 1000);`;
  setScript(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);`);
  await start();
  const { closed } = await up.next();
  await manager.stop();
  // The server ignored SIGTERM, so its socket closes only once the SIGKILL reached it.
  await closed;
  assert.deepEqual(thread(), []);
  await assert.rejects(start(), /hub is stopping/);
});

test('an automatic validation refusal records one failed head and useful thread log, while a main failure survives restart', async () => {
  config({ auto_build: true });
  setScript('process.exit(0);');
  fs.chmodSync(script(), 0o600);
  const sha = commit(worktree, 'not executable');
  await tick();
  assert.equal(state().cards['w/A1'].sha, sha);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /^Build script must be executable/);
  await tick();
  assert.equal(thread().length, 1);
  setScript('process.exit(0);', repo);
  const mainSha = commit(repo, 'main script');
  git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
  await manager.stop();
  write(path.join(site, 'data/try.json'), { kind: 'web', cards: {}, main: { sha: mainSha, state: 'failed', script: true } });
  setManager(tryManager({ log() {} }));
  await manager.initialize(manifest);
  await tick();
  assert.equal(state().main.state, 'failed');
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main-a')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude/kickflip/try/orch-main-b')), false);
});

test('startup removes only unowned in-range ports and parses stdout despite a version warning', async () => {
  write(path.join(home, 'tailscale.status'), { TCP: { 443: {}, 8499: {}, 8500: {}, 8599: {}, 8600: {} } });
  await manager.initialize(manifest);
  assert.deepEqual(calls(), ['serve status --json', 'serve --https=8500 off', 'serve --https=8599 off']);
});

test('with the app recorded and quit, a try port is refused with the recorded-daemon fault and no serve lands on the daemon that answered', async (t) => {
  fakeRelays(t);
  // The quit app's CLI falls through to brew's socket, so the daemon that answers is brew's node.
  write(path.join(home, 'tailscale.node'), 'nBrew');
  t.after(() => fs.rmSync(path.join(home, 'tailscale.node'), { force: true }));
  const recorded = { kind: 'app', cli: path.join(bin, 'tailscale'), node: 'nApp' };
  setManager(tryManager({ answers: async () => true, log() {}, daemon: () => recorded }));
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.match(thread()[0].detail, /Couldn't open try port 8500: Tailscale's recorded daemon isn't running \(mac answered in its place\); start it, or run kickflip doctor --fix to pick again/);
  assert.deepEqual(calls().filter((call) => call.startsWith('serve')), []);
  // Once the recorded node answers, the port is served.
  recorded.node = 'nBrew';
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.ok(calls().some((call) => call.startsWith('serve --bg --https=8500 ')));
});

test('a failed Tailscale registration fails the run with stderr and removes the port, and a served card whose server dies serves again', async (t) => {
  const relays = fakeRelays(t);
  setManager(tryManager({ answers: async () => true, log() {} }));
  write(path.join(home, 'tailscale.fail'), 'yes');
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.equal(state().cards['w/A1'].state, 'failed');
  assert.equal(state().cards['w/A1'].https, undefined);
  assert.match(thread()[0].detail, /Couldn't open try port 8500: permission denied by tailscaled/);
  assert.ok(relays[0].closed);
  assert.ok(calls().includes('serve --https=8500 off'));
  fs.rmSync(path.join(home, 'tailscale.fail'));
  setScript("require('node:fs').writeFileSync('server.pid', String(process.pid)); console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].https, 8500);
  // A served card whose server is stopped outside the hub serves again on its port, with no thread line.
  const servedAgain = manager.next('w/A1', 'ready');
  process.kill(Number(fs.readFileSync(path.join(worktree, 'server.pid'), 'utf8')), 'SIGTERM');
  await servedAgain;
  await manager.settled();
  assert.equal(relays.length, 3);
  assert.equal(state().cards['w/A1'].https, 8500);
  assert.equal(calls().filter((call) => call === 'serve --https=8500 off').length, 2);
  assert.ok(relays.slice(0, 2).every((relay) => relay.closed));
  assert.equal(thread().length, 1);
});

test('card ports skip every board’s fixed main port, including closed boards, and release on Kill', async (t) => {
  fakeRelays(t);
  setManager(tryManager({ now: () => clock, answers: async () => true, log() {} }));
  const other = path.join(home, 'other');
  write(path.join(other, 'data/try.json'), { main_port: 8500 });
  manifest.closed = { other: { site: { dir: other } } };
  write(path.join(site, 'data/try.json'), { kind: 'web', main_port: 8501, cards: {} });
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
  assert.equal(state().cards['w/A1'].https, 8502);
  await kill();
  assert.ok(calls().includes('serve --https=8502 off'));
  assert.equal(state().main_port, 8501);
  write(path.join(site, 'data/agents/A2.json'), { worktree: { path: worktree, repo } });
  await start({ key: 'w/A2' });
  await manager.settled();
  assert.equal(state().cards['w/A2'].state, 'ready');
  assert.equal(state().cards['w/A2'].https, 8502);
  manifest.sites = {};
  await tick();
  assert.equal(calls().filter((call) => call === 'serve --https=8502 off').length, 2);
  assert.equal(state().cards['w/A2'], undefined);
});

test('exhausted try ports fail clearly without adding a serve entry', async () => {
  setManager(tryManager({ answers: async () => true, log() {} }));
  manifest.closed = {};
  for (let port = 8500; port <= 8599; port++) {
    const dir = path.join(home, `reserved-${port}`);
    write(path.join(dir, 'data/try.json'), { main_port: port });
    manifest.closed[port] = { site: { dir } };
  }
  setScript("console.log('port 32123'); setInterval(() => {}, 1000);");
  await start();
  await manager.settled();
  assert.equal(thread().length, 1);
  assert.match(thread()[0].detail, /No try ports available \(8500–8599\)/);
  assert.equal(calls().some((call) => call.includes('--bg')), false);
});

test('startup cleanup failure logs and still allows a build', async () => {
  const logs = [];
  setManager(tryManager({ log: (line) => logs.push(line) }));
  write(path.join(home, 'tailscale.status'), 'not json');
  await manager.initialize(manifest);
  assert.match(logs[0], /try startup cleanup/);
  setScript('process.exit(0);');
  await start();
  await manager.settled();
  assert.equal(state().cards['w/A1'].state, 'ready');
});

test('try builds refuse with 409 while waiting and main rebuilds wait without a failure', async () => {
  const reason = 'Try builds wait on Tailscale: Tailscale / is not serving the hub.';
  const launched = path.join(home, 'build-started');
  setScript(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes');`);
  setScript(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes');`, repo);
  commit(repo);
  const messages = [];
  setManager(tryManager({ waiting: async () => reason, log: (text) => messages.push(text) }));
  await assert.rejects(start(), (error) => error.status === 409 && error.message === reason);
  await tick();
  assert.equal(fs.existsSync(launched), false);
  assert.equal(state().main, null);
  assert.equal(Object.values(state().cards).some((card) => card.state === 'failed' || card.state === 'running'), false);
  assert.deepEqual(thread(), []);
  assert.deepEqual(messages, []);
});
