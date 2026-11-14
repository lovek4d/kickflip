import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp-dir.mjs';

test('the repo build script announces a private working hub that never runs the host\'s tailscale, and stops with its process group', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const home = tempDir('build-test-');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'gh', 'codex', 'launchctl', 'systemctl', 'loginctl', 'osascript']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  // The host's tailscale, its daemon Running: the demo hub must never call it, or its startup turns off the real hub's
  // try ports.
  const calls = path.join(home, 'tailscale-calls');
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\necho "$@" >> '${calls}'\necho '{"BackendState":"Running"}'\n`, { mode: 0o700 });
  const child = spawn(path.join(root, '.kickflip/build'), ['main', root], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH, KICKFLIP_CLAUDE: '/usr/bin/false' },
  });
  let stderr = '';
  let stdout = '';
  let closed = false;
  const close = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  const signal = (value) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, value); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  t.after(async () => {
    signal('SIGTERM');
    try {
      await close;
    } finally {
      signal('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const finish = (error, value) => { if (error) reject(error); else resolve(value); };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /^port (\d+)\r?$/m.exec(stdout);
      if (match) finish(null, Number(match[1]));
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, sig) => finish(new Error(`Build script exited before a working hub (${code ?? sig}): ${stderr}`)));
  });
  assert.notEqual(port, 4500);
  assert.ok(port > 0 && port <= 65535);
  const response = await fetch(`http://127.0.0.1:${port}/_hub/status.json`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(closed, false, stderr);
  // The hub prints `hub on` only after it has initialised its tries (hub/hub.mjs awaits initializeTries before it
  // listens), so its startup calls to tailscale are over by the port line.
  assert.equal(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', '');
  signal('SIGTERM');
  await close;
});
