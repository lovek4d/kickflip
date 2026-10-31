import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'installs-')));
process.env.HOME = home;
const { startInstall, stopInstalls } = await import('./installs.mjs');
const { listBoards } = await import('./boards.mjs');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const web = (...parts) => path.join(home, '.claude', 'web-ts', ...parts);
let site, source, script, manifest, gate;
const thread = (key = 'w/A1') => {
  try { return fs.readFileSync(path.join(site, 'data', 'threads', key.replace('/', '__') + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; }
};
const agent = (id = 'A1') => path.join(source, 'agents', `${id}@install.json`);
const output = (id = 'A1') => path.join(site, 'data', 'installs', `${id}.log`);
const until = async (fn) => {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the install');
    await new Promise((r) => setTimeout(r, 10));
  }
};
function setScript(body) {
  write(script, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(script, 0o700);
}
function config(extra = {}) {
  write(path.join(site, 'board.json'), { title: 'Test', items: 'data/wave.json', slug: 'w', install_script: script, ...extra });
}
const start = (key = 'w/A1', input = {}) => startInstall({ route: 'orch', key, ...input }, { manifest, log() {} });

beforeEach(() => {
  site = fs.mkdtempSync(path.join(home, 'site-'));
  source = path.join(site, 'data');
  script = path.join(site, 'install script;fixed.js');
  gate = path.join(site, 'release');
  config();
  write(path.join(source, 'wave.json'), { items: [{ id: 'A1' }, { id: 'A2' }] });
  manifest = { sites: { orch: { dir: site, cmd: [process.execPath, path.join(root, 'board', 'server.mjs'), site], port: 1 } } };
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('installs refuse an unset or invalid script, an unknown card and caller-selected commands without opening a record', async (t) => {
  config({ install_script: '' });
  await assert.rejects(start(), /Settings page/);
  for (const install_script of ['relative.sh', script, site]) {
    config({ install_script });
    await assert.rejects(start(), /Install script must/);
  }
  setScript('process.exit(0);');
  config();
  for (const mode of [0o720, 0o702]) {
    fs.chmodSync(script, mode);
    await assert.rejects(start(), /writable by group or others/);
  }
  fs.chmodSync(script, 0o700);
  const stat = fs.statSync;
  const mocked = t.mock.method(fs, 'statSync', (file, ...args) => {
    const result = stat(file, ...args);
    if (file === script) result.uid = process.getuid() + 1;
    return result;
  });
  await assert.rejects(start(), /owned by the current user/);
  mocked.mock.restore();
  await assert.rejects(start('w/A1', { command: '/bin/sh' }), /only the board route and card key/);
  await assert.rejects(start('w/A1', { route: 'missing' }), /not a board/);
  await assert.rejects(start('w/missing'), /no item/);
  await assert.rejects(start('w/..'), /Card key/);
  assert.equal(fs.existsSync(agent()), false);
  assert.deepEqual(thread(), []);
});

test('the hub starts one install per card, passes the newest worktree and cwd literally, and closes records with both output streams', async () => {
  const worktree = path.join(home, 'worktree with spaces;literal');
  write(path.join(source, 'agents', 'A1.json'), { started: '2026-10-29T00:00:00Z', worktree: { path: '/older' } });
  write(path.join(source, 'agents', 'A1@build.json'), { started: '2026-10-30T00:00:00Z', done: '2026-10-30T01:00:00Z', worktree: { path: worktree } });
  assert.equal(listBoards(manifest)[0].install_script, script);
  setScript(`const fs = require('node:fs');
fs.writeFileSync('called.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
fs.writeSync(1, 'old line\\n');
fs.writeSync(1, 'stdout one\\n');
fs.writeSync(2, 'stderr two\\n');
fs.writeSync(1, 'keychain unlocked\\nstdout four\\nstdout five\\n');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); } }, 10);`);
  const requests = await Promise.allSettled([start(), start()]);
  assert.equal(requests.filter((r) => r.status === 'fulfilled').length, 1);
  const refusal = requests.find((r) => r.status === 'rejected').reason;
  assert.deepEqual([refusal.status, refusal.message], [409, 'An install build is already running for this card.']);
  const record = read(agent());
  assert.deepEqual([record.kind, Boolean(record.started), record.done], ['install', true, undefined]);
  await until(() => fs.existsSync(path.join(site, 'called.json')));
  assert.deepEqual(read(path.join(site, 'called.json')), { args: ['w/A1', worktree], cwd: site });
  assert.equal(fs.existsSync(gate), false);
  assert.deepEqual(thread(), []);
  setScript('console.log("other card");');
  assert.deepEqual(await start('w/A2'), { status: 'started' });
  await until(() => thread('w/A2').length === 1);
  write(gate, 'go');
  await until(() => thread().length === 1);
  assert.ok(read(agent()).done);
  assert.equal(thread()[0].text, 'Install build finished\nstdout one\nstderr two\nkeychain unlocked\nstdout four\nstdout five');
  assert.match(fs.readFileSync(output(), 'utf8'), /^old line\nstdout one\nstderr two\n/);
  setScript('console.log("replacement");');
  assert.deepEqual(await start(), { status: 'started' });
  await until(() => thread().length === 2);
  assert.equal(fs.readFileSync(output(), 'utf8'), 'replacement\n');
  assert.equal(thread()[1].text, 'Install build finished\nreplacement');
});

test('a failed install closes its builder and reports exit, the last five lines, and a keychain hint from anywhere in the log', async () => {
  for (const hint of ['errSecInternalComponent', 'The login keychain is locked']) {
    const previous = thread().length;
    setScript(`const fs = require('node:fs');
fs.writeSync(2, ${JSON.stringify(hint + '\n')});
fs.writeSync(1, 'one\\ntwo\\nthree\\nfour\\nfive\\n');
process.exit(7);`);
    assert.deepEqual(await start(), { status: 'started' });
    await until(() => thread().length === previous + 1);
    assert.ok(read(agent()).done);
    assert.equal(thread().at(-1).text, 'Install build failed (exit 7)\nThe login keychain must be unlocked on the Mac.\none\ntwo\nthree\nfour\nfive');
  }
});

test('a card with no recorded worktree gets an empty argument, and a spawn failure still closes its record and posts one result', async () => {
  setScript('console.log(JSON.stringify(process.argv.slice(2)));');
  await start();
  await until(() => thread().length === 1);
  assert.equal(thread()[0].text, 'Install build finished\n["w/A1",""]');
  fs.chmodSync(script, 0o600);
  await start();
  await until(() => thread().length === 2);
  assert.ok(read(agent()).done);
  assert.match(thread()[1].text, /^Install build failed \(exit 1\)\n.*EACCES/);
  setScript('console.error("ordinary build error"); process.exit(9);');
  await start();
  await until(() => thread().length === 3);
  assert.equal(thread()[2].text, 'Install build failed (exit 9)\nordinary build error');
});

test('a waves board uses the same registry and records as a file board', async () => {
  source = path.join(home, '.claude', 'waves', 'w');
  write(path.join(source, 'wave.json'), { items: [{ id: 'A1' }] });
  config({ items: 'waves' });
  setScript('console.log("wave install");');
  await start();
  await until(() => thread().length === 1);
  assert.ok(read(agent()).done);
  assert.equal(thread()[0].text, 'Install build finished\nwave install');
});

test('the hub install route starts asynchronously and refuses forwarded, browser and caller-command requests', async () => {
  const port = await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  setScript(`const fs = require('node:fs');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) clearInterval(timer); }, 10);`);
  write(web('manifest.json'), manifest);
  write(web('settings.json'), { polling: { windows: [{ from: '00:00', every_minutes: 120 }], hold_overnight: false, wakes: [] } });
  const hub = spawn(process.execPath, [path.join(root, 'hub', 'hub.mjs')], { env: { ...process.env, WEB_TS_HUB_PORT: String(port) } });
  let stderr = '';
  hub.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => hub.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      let stdout = '';
      hub.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('hub on')) resolve(); });
      hub.once('exit', (code) => reject(new Error(`hub exited ${code}: ${stderr}`)));
    });
    const post = (body, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/_hub/install', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(text) }));
      });
      req.once('error', reject);
      req.end(JSON.stringify(body));
    });
    const input = { route: 'orch', key: 'w/A1' };
    for (const headers of [{ origin: 'https://mac.ts.net' }, { 'x-forwarded-for': '100.64.0.1' }, { host: 'mac.ts.net' }]) {
      assert.equal((await post(input, headers)).status, 403);
    }
    assert.equal((await post({ ...input, script: '/bin/sh' })).status, 400);
    const r = await post(input);
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { status: 'started' });
    assert.equal(read(agent()).done, undefined);
    assert.equal((await post(input)).status, 409);
    write(gate, 'go');
    await until(() => thread().length === 1);
    assert.ok(read(agent()).done);
  } finally { write(gate, 'go'); hub.kill('SIGTERM'); await exited; }
});

test('stopping the hub stops its install process and closes the record with a thread result', async () => {
  setScript('require("node:fs").writeFileSync("running", "yes"); setInterval(() => {}, 1000);');
  await start();
  await until(() => fs.existsSync(path.join(site, 'running')));
  await stopInstalls();
  assert.ok(read(agent()).done);
  assert.equal(thread().length, 1);
  assert.match(thread()[0].text, /^Install build failed \(exit 1\)\nStopped by SIGTERM\./);
  await assert.rejects(start(), /hub is stopping/);
});
