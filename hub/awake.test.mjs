import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until } from '../shared/test-helpers.mjs';
import { awakeUnsupported, setKeepAwake } from './awake.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));

test('Keep awake is refused off macOS and says why', () => {
  assert.equal(awakeUnsupported('darwin'), null);
  assert.equal(awakeUnsupported('linux'), 'macOS only · this host runs Linux');
  assert.throws(() => setKeepAwake(true, { platform: 'linux' }), { status: 409, message: 'Keep awake runs caffeinate, macOS only · this host runs Linux.' });
});

const plainAwake = ({ awake }) => [awake.on, awake.unsupported];

test('the hub runs caffeinate -s while Keep awake is on, stops it when turned off, starts it again after a restart, and carries only a saved forever over as on', { skip: process.platform !== 'darwin' }, async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-awake-')));
  const web = path.join(home, '.claude', 'kickflip');
  const bin = path.join(home, 'bin');
  const log = path.join(home, 'caffeinate.log');
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(web, 'manifest.json'), JSON.stringify({ version: 1, sites: {} }));
  fs.writeFileSync(path.join(bin, 'caffeinate'), [
    '#!/bin/sh',
    `echo "start $$ $*" >> "${log}"`,
    `trap 'echo "stop $$" >> "${log}"; exit 0' TERM`,
    'while kill -0 "$3" 2>/dev/null; do sleep 0.1; done',
    `echo "gone $$" >> "${log}"`,
  ].join('\n') + '\n', { mode: 0o755 });
  const [port] = await freePorts(1);
  const base = `http://127.0.0.1:${port}`;
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const saved = () => JSON.parse(fs.readFileSync(path.join(web, 'settings.json'), 'utf8')).keep_awake;
  let hub;
  const startHub = async () => {
    hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', PATH: `${bin}:${process.env.PATH}` } });
    await new Promise((resolve, reject) => {
      let out = '';
      hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
      hub.once('exit', reject);
    });
  };
  const stopHub = async () => {
    if (hub.exitCode !== null || hub.signalCode !== null) return;
    const exited = new Promise((resolve) => hub.once('exit', resolve));
    hub.kill('SIGTERM');
    await exited;
  };
  // Each caffeinate writes its last log line in home as it exits, so home is removed once they all have.
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => {
    await stopHub();
    await until(() => lines().filter((l) => l.startsWith('start ')).every((l) => !alive(Number(l.split(' ')[1]))), 'every caffeinate exited');
    fs.rmSync(home, { recursive: true, force: true });
  });
  const post = async (keepAwake) => {
    const r = await fetch(`${base}/_hub/settings/keep-awake`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ keep_awake: keepAwake }) });
    return [r.status, await r.json()];
  };
  const started = async (n) => {
    await until(() => lines().filter((l) => l.startsWith('start ')).length === n, `caffeinate start ${n}`);
    const [, pid, ...args] = lines().filter((l) => l.startsWith('start ')).at(-1).split(' ');
    assert.deepEqual(args, ['-s', '-w', String(hub.pid)]);
    return pid;
  };
  const stopped = (pid) => until(() => lines().includes(`stop ${pid}`), `caffeinate ${pid} stopped`);

  await startHub();
  assert.deepEqual(plainAwake(await (await fetch(`${base}/_hub/api/hub`)).json()), [false, null]);
  assert.deepEqual(lines(), []);

  const [status, on] = await post('on');
  assert.equal(status, 200);
  assert.equal(on.awake, undefined);
  assert.deepEqual(plainAwake(await (await fetch(`${base}/_hub/api/hub`)).json()), [true, null]);
  const first = await started(1);
  assert.equal(saved(), true);
  assert.equal((await post('on'))[0], 200);
  assert.equal(lines().filter((l) => l.startsWith('start ')).length, 1);

  const [, off] = await post('off');
  assert.equal(off.awake, undefined);
  assert.deepEqual(plainAwake(await (await fetch(`${base}/_hub/api/hub`)).json()), [false, null]);
  await stopped(first);
  assert.equal(saved(), undefined);

  await post('on');
  const beforeRestart = await started(2);
  await stopHub();
  await stopped(beforeRestart);
  await startHub();
  await started(3);
  assert.equal(saved(), true);

  // A setting saved by the timed Keep awake: forever reads as on, a time as off.
  await post('off');
  await stopHub();
  const settings = path.join(web, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ keep_awake_until: 'forever' }));
  await startHub();
  await started(4);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).keep_awake_until, undefined);
  assert.equal(saved(), true);
  await stopHub();
  fs.writeFileSync(settings, JSON.stringify({ keep_awake_until: new Date(Date.now() + 3_600_000).toISOString() }));
  await startHub();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lines().filter((l) => l.startsWith('start ')).length, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {});
});
