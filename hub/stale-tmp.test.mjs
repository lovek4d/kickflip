import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sweepStaleTempsUnder } from './stale-tmp.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

test('the sweep removes temp files of dead writers in the home and each site data folder, and keeps the rest', () => {
  const home = tempDir('stale-tmp-');
  const data = path.join(home, 'sites', 'a', 'data');
  fs.mkdirSync(data, { recursive: true });
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const touch = (dir, name) => { fs.writeFileSync(path.join(dir, name), ''); return path.join(dir, name); };
  const dead = [touch(home, `usage.json.${gone}.tmp`), touch(data, `x.json.${gone}.1700000000.tmp`)];
  const kept = [touch(home, `usage.json.${process.pid}.tmp`), touch(home, 'usage.json'), touch(data, `y.json.${gone}.bak`), touch(home, 'notes.tmp')];
  const removed = sweepStaleTempsUnder(home);
  assert.deepEqual(removed.sort(), dead.sort());
  for (const f of dead) assert.equal(fs.existsSync(f), false);
  for (const f of kept) assert.equal(fs.existsSync(f), true);
});

test('a missing home sweeps nothing', () => {
  assert.deepEqual(sweepStaleTempsUnder(path.join(tempDir('stale-tmp-'), 'none')), []);
});
