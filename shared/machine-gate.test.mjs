import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { machineState, pressureOf, checkMachine, readMachineState, readMachineSamples, readMachine, machineFile } from './machine-gate.mjs';
import { hubAudit, readAudit } from './audit.mjs';
import { tempDir } from './temp-dir.mjs';

const reading = (load, pressure = 'warn', cores = 10) => ({ load, cores, pressure });

function fixture(t) {
  const home = tempDir('machine-gate-');
  return home;
}

test('sysctl pressure levels read normal, warn and critical, and anything else reads unknown', () => {
  assert.deepEqual([1, 2, 4, 0, NaN, null].map(pressureOf), ['normal', 'warn', 'critical', null, null, null]);
  const now = readMachine();
  assert.equal(typeof now.load, 'number');
  assert.equal(now.cores, os.cpus().length);
  assert.ok(['normal', 'warn', 'critical', null].includes(now.pressure));
});

test('the Mac turns busy at critical pressure or a 1-minute load of 4× its cores, and eases only at warn or lower and under 3×', () => {
  assert.equal(machineState('normal', reading(39.9)), 'normal');
  assert.equal(machineState('normal', reading(40)), 'busy');
  assert.equal(machineState('normal', reading(1, 'critical')), 'busy');
  assert.equal(machineState(undefined, reading(40)), 'busy', 'no earlier state reads as normal');
  // Once busy, it stays busy until pressure is off critical and load is under the release point.
  assert.equal(machineState('busy', reading(35)), 'busy');
  assert.equal(machineState('busy', reading(30)), 'busy');
  assert.equal(machineState('busy', reading(29.9, 'critical')), 'busy');
  assert.equal(machineState('busy', reading(29.9, 'warn')), 'normal');
  assert.equal(machineState('busy', reading(5, null)), 'normal', 'a Mac whose pressure reads unknown goes by load alone');
});

test('the hub tick keeps the state file and audits each change and a reading every 10 minutes', (t) => {
  const home = fixture(t);
  const at = (minutes) => new Date(Date.parse('2026-11-06T01:00:00Z') + minutes * 60_000);
  assert.deepEqual(readMachineState(home), { state: 'normal', reason: null }, 'no file reads normal');
  checkMachine({ home, reading: reading(15), now: at(0) });
  checkMachine({ home, reading: reading(16), now: at(1) });
  assert.deepEqual(readMachineState(home), { state: 'normal', reason: null });
  checkMachine({ home, reading: reading(41.2, 'critical'), now: at(2) });
  assert.deepEqual(readMachineState(home), { state: 'busy', reason: 'memory pressure critical', since: at(2).toISOString() });
  checkMachine({ home, reading: reading(35, 'warn'), now: at(3) });
  assert.deepEqual(readMachineState(home), { state: 'busy', reason: 'load high', since: at(2).toISOString() }, 'since stays while it stays busy');
  checkMachine({ home, reading: reading(35, 'warn'), now: at(13) });
  checkMachine({ home, reading: reading(20, 'warn'), now: at(14) });
  assert.deepEqual(readMachineState(home), { state: 'normal', reason: null });
  const file = JSON.parse(fs.readFileSync(machineFile(home), 'utf8'));
  assert.deepEqual(file.reading, reading(20, 'warn'));
  assert.equal(file.at, at(14).toISOString());
  const log = readAudit(hubAudit(home), { now: at(15) });
  assert.deepEqual(log.map((e) => [e.at.slice(14, 16), e.call, e.result]), [
    ['00', 'machine-reading', 'normal'], ['02', 'machine-busy', 'busy'], ['13', 'machine-reading', 'busy'], ['14', 'machine-eased', 'normal'],
  ]);
  assert.match(log[1].reason, /memory pressure is critical/);
  assert.match(log[3].reason, /under 3× its 10 cores/);
  assert.deepEqual(log[1].inputs, { reading: reading(41.2, 'critical'), previous: 'normal', hold: 4, release: 3 });
});

// docs/adr/2026-11-13-0026-the-busy-hub-row-opens-whats-loading-the-host.md
test('the hub tick keeps one load sample a minute for the last hour', (t) => {
  const home = fixture(t);
  const start = Date.parse('2026-11-06T01:00:10Z');
  const at = (seconds) => new Date(start + seconds * 1000);
  // Four ticks a minute, as the hub's 15-second tick runs: one sample each wall-clock minute.
  for (let s = 0; s < 3 * 60; s += 15) checkMachine({ home, reading: reading(s / 10), now: at(s) });
  const samples = () => readMachineSamples(home);
  assert.deepEqual(samples().map((x) => [x.at.slice(11, 19), x.load]), [['01:00:10', 0], ['01:01:10', 6], ['01:02:10', 12]]);
  for (let m = 3; m <= 75; m++) checkMachine({ home, reading: reading(m), now: at(m * 60) });
  assert.equal(samples().length, 60, 'the last hour alone');
  assert.equal(samples()[0].load, 16);
  assert.equal(samples().at(-1).load, 75);
  assert.deepEqual(readMachineSamples(fixture(t)), [], 'no file has no samples');
});
