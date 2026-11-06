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

// A stand-in board server at <pkg>/board/server.mjs: answers every request with its pid, and imports ./dep.mjs, whose
// text the test changes as an upgrade or pull would.
function fakePackage(home) {
  const pkg = path.join(home, 'pkg');
  write(path.join(pkg, 'board', 'server.mjs'), `import http from 'node:http';
import './dep.mjs';
http.createServer((req, res) => res.end(JSON.stringify({ pid: process.pid }))).listen(Number(process.env.PORT), '127.0.0.1');
`);
  write(path.join(pkg, 'board', 'dep.mjs'), 'export const v = 1;\n');
  return pkg;
}

test('a board server whose code changed on disk restarts once its board has no running builder, and its page reads restarting meanwhile', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-board-')));
  const [port, shopPort] = await freePorts(2);
  for (const tool of ['gh', 'tailscale', 'launchctl', 'systemctl', 'codex', 'caffeinate', 'claude', 'tmux']) { write(path.join(home, 'bin', tool), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(home, 'bin', tool), 0o755); }
  const pkg = fakePackage(home);
  const dir = path.join(home, '.claude', 'kickflip', 'sites', 'shop');
  write(path.join(dir, 'board.json'), { title: 'Shop', items: 'data/cards.json' });
  write(path.join(dir, 'data', 'cards.json'), { items: [{ id: 'A1', title: 'One' }] });
  const builder = path.join(dir, 'data', 'agents', 'A1.json');
  write(builder, { started: new Date().toISOString(), label: 'Builder' });
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: {
    shop: { title: 'Shop', dir, port: shopPort, cmd: [process.execPath, path.join(pkg, 'board', 'server.mjs'), dir] },
  } });
  const hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` } });
  let out = '';
  hub.stdout.on('data', (d) => { out += d; });
  hub.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const pid = () => fetch(`http://127.0.0.1:${shopPort}/`).then((r) => r.json()).then((j) => j.pid, () => null);
  try {
    await until(() => out.includes('hub on'), 'the hub starts');
    await until(async () => Boolean(await pid()), 'the Shop server answers');
    const first = await pid();

    // The new code waits for the release file before it listens, so its page can be caught while it restarts.
    const release = path.join(home, 'release');
    write(path.join(pkg, 'board', 'dep.mjs'), `import fs from 'node:fs';\nexport const v = 2;\nwhile (!fs.existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 50));\n`);
    await until(() => out.includes('shop runs older code than its files; restarts once no builder runs'), 'the hub sees the stale server and waits on the builder');
    assert.equal(await pid(), first, 'a running builder keeps the old server');

    write(builder, { started: new Date().toISOString(), done: new Date().toISOString(), label: 'Builder' });
    await until(() => out.includes('shop runs older code than its files; restarting it'), 'the hub restarts the stale server');
    const page = await fetch(`${base}/shop/`, { headers: { accept: 'text/html' } });
    assert.match(await page.text(), /restarting · its code changed/);
    // docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md: the page tells the states apart by these.
    assert.equal(page.headers.get('x-kickflip-down'), 'code');
    const gone = await fetch(`${base}/nowhere/api/board`);
    assert.deepEqual([gone.status, gone.headers.get('x-kickflip-down')], [404, 'removed']);
    write(release, '');
    await until(async () => { const now = await pid(); return now && now !== first; }, 'the new server answers');

    // Once restarted, it runs the code in its files, so the check that finds it up restarts nothing.
    const second = await pid();
    const proxied = () => fetch(`${base}/shop/`).then((r) => r.json()).then((j) => j.pid, () => null);
    await until(async () => (await proxied()) === second, 'the hub finds the new server up');
    const answer = await fetch(`${base}/shop/`);
    assert.deepEqual([answer.headers.get('x-kickflip-hub'), answer.headers.get('x-kickflip-down')], ['1', null]);
    assert.equal(await pid(), second);
    assert.equal(out.split('restarting it').length, 2, 'the hub restarted the server once');
  } finally {
    hub.kill();
    await new Promise((resolve) => hub.once('exit', resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
