// docs/adr/2026-11-03-1638-the-hub-restarts-itself-from-its-stale-code-notice.md
import { home, web, write, inProcessHub, serverSignals } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePorts } from '../shared/test-helpers.mjs';

test("Restart hub answers, then stops the hub through close() and exits for its service to start it again; the hub reads it while it runs older code than its files", async (t) => {
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {} });
  // The stand-in exit records each exit code; the hub's response is flushed before the restart stops it.
  const exits = [];
  let exited;
  const exitedOnce = new Promise((resolve) => { exited = resolve; });
  const hub = await inProcessHub(t, { exit: (code) => { exits.push(code); exited(); } });
  const post = (headers = { 'content-type': 'application/json' }) => fetch(`${hub.base}/_hub/restart-hub`, { method: 'POST', headers, body: '{}' });

  const newHub = async () => (await (await fetch(`${hub.base}/_hub/sidebar.json`)).json()).newHub;
  assert.equal((await (await fetch(`${hub.base}/_hub/api/hub`)).json()).hub.restart, false);
  assert.equal(await newHub(), false);
  // The version tap's check: this hub runs from a clone, which never asks npm and answers with its commit.
  const checked = await fetch(`${hub.base}/_hub/check-update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const check = await checked.json();
  assert.equal(check.state, 'clone');
  assert.match(check.commit, /^[0-9a-f]{7,}$/);
  const codeFile = path.join(web, 'hub-code.json');
  write(codeFile, { ...JSON.parse(fs.readFileSync(codeFile, 'utf8')), hash: 'old' });
  const stale = await fetch(`${hub.base}/_hub/api/hub`);
  assert.equal(stale.headers.get('x-hub-code'), 'old');
  assert.equal((await stale.json()).hub.restart, true);
  // docs/adr/2026-11-15-2221-new-server-code-waits-behind-a-restart-row-and-restarts-itself-once-idle.md: the hub pages' New hub version row.
  assert.equal(await newHub(), true);

  assert.equal((await post({ 'content-type': 'text/plain' })).status, 403);
  assert.equal((await post({ 'content-type': 'application/json', origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' })).status, 403);
  // A tailnet device not signed in as the owner (here a tagged node: no Tailscale-User-Login) is refused.
  const stranger = await post({ 'content-type': 'application/json', 'x-forwarded-for': '100.70.1.4' });
  assert.deepEqual([stranger.status, await stranger.json()], [403, {}]);
  assert.deepEqual(exits, []);

  const r = await post();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-hub-code'), 'old');
  const out = await r.json();
  assert.equal(out.restarting, true);
  assert.equal(typeof out.command, 'string');
  await exitedOnce;
  assert.ok(hub.lines.includes('hub stopping; stopping sites'));
  assert.deepEqual(exits, [0]);
});

// docs/adr/2026-11-17-1357-the-hub-restarts-itself-through-close.md
test('a restart mid-send waits for the send: the hub stops its board servers, which finish their sends, and exits only then', async (t) => {
  fs.rmSync(web, { recursive: true, force: true });
  const signals = await serverSignals(t);
  // A stand-in board server mid-send: stopped, it exits only once its send is done, as board/server.mjs close() does.
  // The test finishes the send with GET /finish.
  const sent = path.join(home, 'sent');
  const server = path.join(home, 'sending-server.mjs');
  write(server, `import http from 'node:http';
import fs from 'node:fs';
let stopping = false;
let done = false;
http.createServer((req, res) => {
  res.end('ok');
  if (req.url !== '/finish') return;
  fs.writeFileSync(${JSON.stringify(sent)}, 'sent');
  done = true;
  if (stopping) process.exit(0);
}).listen(Number(process.env.PORT), '127.0.0.1');
process.once('SIGTERM', () => { stopping = true; if (done) process.exit(0); });
`);
  const [port] = await freePorts(1);
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: { shop: { title: 'Shop', dir: home, port, cmd: [process.execPath, ...signals.args, server] } } });
  let exited;
  let exitedYet = false;
  const exit = new Promise((resolve) => { exited = resolve; });
  const hub = await inProcessHub(t, { codeRestarts: false, exit: (code) => { exitedYet = true; exited({ code, sent: fs.existsSync(sent) }); } });
  await hub.reconcile();
  await signals.up();

  const post = () => fetch(`${hub.base}/_hub/restart-hub`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await post()).status, 200);
  // While the board server finishes its send, the hub still answers, and a second tap is told the restart is out.
  const again = await post();
  assert.deepEqual([again.status, await again.json()], [409, { error: 'The hub is already restarting.' }]);
  await hub.logged(/^hub stopping; stopping sites$/);
  assert.equal(exitedYet, false, 'the hub waits while its board server is mid-send');
  await fetch(`http://127.0.0.1:${port}/finish`);
  assert.deepEqual(await exit, { code: 0, sent: true }, 'the hub exits once its board server has finished its send');
  assert.ok(hub.lines.includes('hub stopping; stopping sites'));
});
