import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp-dir.mjs';
import { claimLaunch, release } from './launch-claim.mjs';

// docs/adr/2026-11-18-2030-a-launch-is-one-exclusive-claim.md
const dir = () => path.join(tempDir('claim-'), 'launches');

test('two claims on one name in a row give one winner, and a release lets the next win', () => {
  const d = dir();
  const first = claimLaunch(d, 'w/A1~main');
  assert.ok(first);
  assert.equal(claimLaunch(d, 'w/A1~main'), null, 'the second finds it held by its live claimer');
  assert.ok(claimLaunch(d, 'w/A2~main'), 'another name is its own claim');
  first.release();
  assert.ok(claimLaunch(d, 'w/A1~main'), 'released, it is claimed again');
});

test('a claim holds while the process it launched lives, and a dead one is taken over once', () => {
  const d = dir();
  const alive = new Set([111, process.pid]);
  const live = (pid) => alive.has(pid);
  claimLaunch(d, 'w/A1~main', { alive: live }).settle(111);
  assert.equal(claimLaunch(d, 'w/A1~main', { alive: live }), null, 'its launched pid lives');
  alive.delete(111);
  const racers = [claimLaunch(d, 'w/A1~main', { alive: live }), claimLaunch(d, 'w/A1~main', { alive: live })];
  assert.equal(racers.filter(Boolean).length, 1, 'its pid is gone, so one pass re-claims it and the other finds it held');
});

test('a claim whose pid is not yet known holds while its claimer lives and falls when the claimer is gone', () => {
  const d = dir();
  claimLaunch(d, 'k');
  assert.equal(claimLaunch(d, 'k', { alive: (pid) => pid === process.pid }), null);
  assert.ok(claimLaunch(d, 'k', { alive: () => false }), 'its claimer died before it spawned or named its pid');
});

test('releasing a name nothing claimed does nothing, and a name with a slash is one file in the folder', () => {
  const d = dir();
  release(d, 'never');
  claimLaunch(d, 'w/A1~main');
  assert.equal(fs.readdirSync(d).length, 1);
});
