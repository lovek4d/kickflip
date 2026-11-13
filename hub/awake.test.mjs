import { web, write, inProcessHub } from './hub-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { awakeUnsupported, caffeinate, setKeepAwake } from './awake.mjs';

test('Keep awake is refused off macOS and says why', () => {
  assert.equal(awakeUnsupported('darwin'), null);
  assert.equal(awakeUnsupported('linux'), 'macOS only · this host runs Linux');
  assert.throws(() => setKeepAwake(true, { platform: 'linux' }), { status: 409, message: 'Keep awake runs caffeinate, macOS only · this host runs Linux.' });
});

const plainAwake = ({ awake }) => [awake.on, awake.unsupported];

test('the hub runs caffeinate -s while Keep awake is on, stops it when turned off, starts it again after a restart, and carries only a saved forever over as on', { skip: process.platform !== 'darwin' }, async (t) => {
  write(path.join(web, 'manifest.json'), { version: 1, sites: {} });
  // Each caffeinate the hub spawns, in order: {pid, command, args, stopped}.
  const runs = [];
  const spawn = (command, args) => {
    const child = Object.assign(new EventEmitter(), { pid: 1000 + runs.length });
    const run = { pid: child.pid, command, args, stopped: false };
    child.kill = () => { run.stopped = true; child.emit('exit', null, 'SIGTERM'); return true; };
    runs.push(run);
    return child;
  };
  let hub;
  // A restart: the running hub stops, and a new one starts on the same files.
  const startHub = async () => {
    if (hub) await hub.close();
    hub = await inProcessHub(t, { awake: caffeinate({ spawn }) });
  };
  const saved = () => JSON.parse(fs.readFileSync(path.join(web, 'settings.json'), 'utf8')).keep_awake;
  const post = async (keepAwake) => {
    const r = await fetch(`${hub.base}/_hub/settings/keep-awake`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ keep_awake: keepAwake }) });
    return [r.status, await r.json()];
  };
  const awake = async () => plainAwake(await (await fetch(`${hub.base}/_hub/api/hub`)).json());

  await startHub();
  assert.deepEqual(await awake(), [false, null]);
  assert.deepEqual(runs, []);

  const [status, on] = await post('on');
  assert.equal(status, 200);
  assert.equal(on.awake, undefined);
  assert.deepEqual(await awake(), [true, null]);
  assert.deepEqual(runs.map(({ command, args, stopped }) => [command, args, stopped]), [['caffeinate', ['-s', '-w', String(process.pid)], false]]);
  assert.equal(saved(), true);
  assert.equal((await post('on'))[0], 200);
  assert.equal(runs.length, 1);

  const [, off] = await post('off');
  assert.equal(off.awake, undefined);
  assert.deepEqual(await awake(), [false, null]);
  assert.equal(runs[0].stopped, true);
  assert.equal(saved(), undefined);

  await post('on');
  assert.deepEqual([runs.length, runs[1].stopped], [2, false]);
  await startHub();
  assert.equal(runs[1].stopped, true, 'the hub stops it as it exits');
  assert.deepEqual([runs.length, runs[2].stopped], [3, false], 'and starts it again as it starts');
  assert.equal(saved(), true);

  // A setting saved by the timed Keep awake: forever reads as on, a time as off.
  await post('off');
  const settings = path.join(web, 'settings.json');
  write(settings, { keep_awake_until: 'forever' });
  await startHub();
  assert.equal(runs.length, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).keep_awake_until, undefined);
  assert.equal(saved(), true);
  write(settings, { keep_awake_until: new Date(Date.now() + 3_600_000).toISOString() });
  await startHub();
  assert.equal(runs.length, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {});
});
