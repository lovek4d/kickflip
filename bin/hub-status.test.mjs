import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KICKFLIP = fileURLToPath(new URL('./kickflip.mjs', import.meta.url));

// Runs kickflip with fetch replaced by preload's. → {status, stdout, stderr}
function kickflip(home, preload, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, KICKFLIP, ...args], {
      cwd: home, env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1', KICKFLIP_TAILSCALE: path.join(home, 'no-tailscale') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

// docs/adr/2026-11-13-2230-kickflip-waits-for-a-slow-hub.md
test('kickflip reads a hub slower than any time limit as running, and one that refuses as not running', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-status-'));
  try {
    fs.mkdirSync(path.join(home, 'page'));
    // A hub slower than any time limit: a status read that carries one is cut off before the hub answers.
    const slow = `globalThis.fetch = async (url, opts) => {
      if (!url.endsWith('/_hub/status.json')) throw new Error('unexpected fetch ' + url);
      if (opts?.signal) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return { ok: true, json: async () => ({ hub: { port: 1 }, sites: [] }) };
    };`;
    const read = await kickflip(home, slow, 'join', '--name', 'Notes', '--dir', path.join(home, 'page'));
    assert.equal(read.status, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout).hub, 'running');
    const refused = await kickflip(home, `globalThis.fetch = async () => { throw new TypeError('fetch failed'); };`, 'join', '--name', 'Notes', '--dir', path.join(home, 'page'));
    assert.equal(refused.status, 0, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).hub, 'NOT running: run `kickflip doctor --fix`');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
