import { web, write, inProcessHub } from './hub-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// docs/adr/2026-11-13-2345-a-checkbox-under-the-hubs-version-turns-auto-update-off.md
test('the auto update box is stored as autoUpdate: false, unset is on, and the hub page data carries it', async (t) => {
  write(path.join(web, 'manifest.json'), { version: 1, sites: {} });
  const hub = await inProcessHub(t);
  const saved = () => JSON.parse(fs.readFileSync(path.join(web, 'settings.json'), 'utf8')).autoUpdate;
  const post = (value) => fetch(`${hub.base}/_hub/settings/auto-update`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ auto_update: value }) });
  const shown = async () => (await (await fetch(`${hub.base}/_hub/api/hub`)).json()).update;

  assert.equal((await shown()).auto, true);
  assert.equal((await post('off')).status, 200);
  assert.equal(saved(), false);
  assert.equal((await shown()).auto, false);
  assert.equal((await post('on')).status, 200);
  assert.equal(saved(), undefined);
  assert.equal((await shown()).auto, true);
});

// docs/adr/2026-11-15-2221-new-server-code-waits-behind-a-restart-row-and-restarts-itself-once-idle.md
test('the auto restart box beside it is stored as autoRestart: false, unset is on, and shows on a clone too', async (t) => {
  write(path.join(web, 'manifest.json'), { version: 1, sites: {} });
  const hub = await inProcessHub(t);
  const saved = () => JSON.parse(fs.readFileSync(path.join(web, 'settings.json'), 'utf8')).autoRestart;
  const post = (value) => fetch(`${hub.base}/_hub/settings/auto-restart`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ auto_restart: value }) });
  const shown = async () => (await (await fetch(`${hub.base}/_hub/api/hub`)).json()).update;

  assert.equal((await shown()).restart, true);
  assert.equal((await post('off')).status, 200);
  assert.equal(saved(), false);
  assert.equal((await shown()).restart, false);
  assert.equal((await post('on')).status, 200);
  assert.equal(saved(), undefined);
  assert.equal((await shown()).restart, true);
});
