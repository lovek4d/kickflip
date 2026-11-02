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
  assert.throws(() => setKeepAwake('1h', { platform: 'linux' }), { status: 409, message: 'Keep awake runs caffeinate, macOS only · this host runs Linux.' });
});

test('the hub runs caffeinate -ims while Keep awake is on, stops it when turned off or at its end, and starts it again after a restart while time is left', { skip: process.platform !== 'darwin' }, async (t) => {
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
  const saved = () => JSON.parse(fs.readFileSync(path.join(web, 'settings.json'), 'utf8')).keep_awake_until;
  let hub;
  const startHub = async () => {
    hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', PATH: `${bin}:${process.env.PATH}` } });
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
  t.after(async () => { await stopHub(); fs.rmSync(home, { recursive: true, force: true }); });
  const post = async (keepAwake) => {
    const r = await fetch(`${base}/_hub/settings/keep-awake`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ keep_awake: keepAwake }) });
    return [r.status, await r.json()];
  };
  const started = async (n) => {
    await until(() => lines().filter((l) => l.startsWith('start ')).length === n, `caffeinate start ${n}`);
    const [, pid, ...args] = lines().filter((l) => l.startsWith('start ')).at(-1).split(' ');
    assert.deepEqual(args, ['-ims', '-w', String(hub.pid)]);
    return pid;
  };
  const stopped = (pid) => until(() => lines().includes(`stop ${pid}`), `caffeinate ${pid} stopped`);

  await startHub();
  assert.equal((await (await fetch(`${base}/_hub/api/settings`)).json()).awake.summary, 'Off');
  assert.deepEqual(lines(), []);

  const [status, on] = await post('1h');
  assert.equal(status, 200);
  assert.match(on.awake.summary, /^On until /);
  const first = await started(1);
  assert.ok(Math.abs(Date.parse(saved()) - Date.now() - 3_600_000) < 60_000);
  assert.match((await (await fetch(`${base}/_hub/api/hub`)).json()).awake, /^until /);
  assert.equal((await post('1h'))[0], 200);
  assert.equal(lines().filter((l) => l.startsWith('start ')).length, 1);

  const [, off] = await post('off');
  assert.equal(off.awake.summary, 'Off');
  await stopped(first);
  assert.equal(saved(), undefined);

  const [refused, why] = await post(new Date(Date.now() - 60_000).toISOString());
  assert.deepEqual([refused, why.error], [400, 'That keep awake ends in the past or more than 30 days on. Pick another time.']);

  await post(new Date(Date.now() + 1500).toISOString());
  await stopped(await started(2));
  assert.equal(saved(), undefined);
  assert.equal((await (await fetch(`${base}/_hub/api/settings`)).json()).awake.summary, 'Off');

  const [, forever] = await post('forever');
  assert.equal(forever.awake.summary, 'On · forever');
  assert.equal(saved(), 'forever');
  assert.equal((await (await fetch(`${base}/_hub/api/hub`)).json()).awake, 'until you turn it off');
  const endless = await started(3);
  await post('off');
  await stopped(endless);

  await post('3h');
  const end = saved();
  const beforeRestart = await started(4);
  await stopHub();
  await stopped(beforeRestart);
  await startHub();
  await started(5);
  assert.equal(saved(), end);
});
