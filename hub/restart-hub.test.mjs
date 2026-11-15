// docs/adr/2026-11-03-1638-the-hub-restarts-itself-from-its-stale-code-notice.md
import { home, web, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test("Restart hub answers once the hub service's restart is asked for, then runs it; the hub reads it while it runs older code than its files", async (t) => {
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {} });
  const restarts = path.join(home, 'restarts');
  // The stand-in restart records what it was asked to restart; the hub's response is flushed before it runs.
  process.env.KICKFLIP_RESTART_CMD = JSON.stringify([process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], process.argv.slice(2).join(' ') + '\\n')", restarts]);
  const hub = await inProcessHub(t);
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
  assert.equal(fs.existsSync(restarts), false);

  const r = await post();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-hub-code'), 'old');
  const out = await r.json();
  assert.equal(out.restarting, true);
  assert.equal(typeof out.command, 'string');
  await hub.settled();
  assert.deepEqual(fs.readFileSync(restarts, 'utf8').trim().split('\n'), ['hub']);
  const again = await post();
  assert.deepEqual([again.status, await again.json()], [409, { error: 'The hub is already restarting.' }]);
});
