// docs/adr/2026-11-03-1638-the-hub-restarts-itself-from-its-stale-code-notice.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until } from '../shared/test-helpers.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };

test("Restart hub answers once the hub service's restart is asked for, then runs it; the hub reads it while it runs older code than its files", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-hub-')));
  const [port] = await freePorts(1);
  for (const tool of ['gh', 'tailscale', 'launchctl', 'systemctl', 'codex', 'caffeinate', 'claude', 'tmux']) { write(path.join(home, 'bin', tool), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(home, 'bin', tool), 0o755); }
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {} });
  const restarts = path.join(home, 'restarts');
  // The stand-in restart records what it was asked to restart; the hub's response is flushed before it runs.
  const runner = [process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], process.argv.slice(2).join(' ') + '\\n')", restarts];
  const hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_RESTART_CMD: JSON.stringify(runner), PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` } });
  const base = `http://127.0.0.1:${port}`;
  const post = (headers = { 'content-type': 'application/json' }) => fetch(`${base}/_hub/restart-hub`, { method: 'POST', headers, body: '{}' });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
      hub.once('exit', reject);
    });
    assert.equal((await (await fetch(`${base}/_hub/api/hub`)).json()).hub.restart, false);
    const codeFile = path.join(home, '.claude', 'kickflip', 'hub-code.json');
    write(codeFile, { ...JSON.parse(fs.readFileSync(codeFile, 'utf8')), hash: 'old' });
    const stale = await fetch(`${base}/_hub/api/hub`);
    assert.equal(stale.headers.get('x-hub-code'), 'old');
    assert.equal((await stale.json()).hub.restart, true);

    assert.equal((await post({ 'content-type': 'text/plain' })).status, 403);
    assert.equal((await post({ 'content-type': 'application/json', origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal(fs.existsSync(restarts), false);

    const r = await post();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-hub-code'), 'old');
    const out = await r.json();
    assert.equal(out.restarting, true);
    assert.equal(typeof out.command, 'string');
    await until(() => fs.existsSync(restarts), 'the restart runs');
    assert.deepEqual(fs.readFileSync(restarts, 'utf8').trim().split('\n'), ['hub']);
    const again = await post();
    assert.deepEqual([again.status, await again.json()], [409, { error: 'The hub is already restarting.' }]);
  } finally {
    hub.kill();
    await new Promise((resolve) => hub.once('exit', resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
