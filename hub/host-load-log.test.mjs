// docs/adr/2026-11-17-0010-the-load-sheet-accent-follows-busy-and-each-tick-logs-its-rows.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { logHostLoad } from './host-load-log.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const data = {
  load: 42.5, cores: 10, busy: true,
  groups: [
    { key: 'orphan', title: 'Looks orphaned', rows: [{ pid: 8, ppid: 1, command: 'yes', cmd: 'yes', cpu: 99.8, age: 100, owner: '' }, { pid: 9, ppid: 1, command: 'yes', cpu: 0.2, age: 50 }] },
    { key: 'other', title: 'Other', rows: [{ pid: 3, ppid: 1, command: '/usr/bin/mds', cpu: 18, age: 40 }] },
  ],
};
const scratch = () => tempDir('host-load-');
const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('each tick writes one line with its load, groups and every row', () => {
  const dir = scratch();
  logHostLoad(data, { dir, now: new Date('2026-11-16T12:00:00') });
  logHostLoad({ ...data, busy: false, groups: null }, { dir, now: new Date('2026-11-16T12:00:15') });
  const [first, second] = lines(path.join(dir, 'host-load.jsonl'));
  assert.deepEqual(Object.keys(first), ['ts', 'load', 'cores', 'busy', 'groups', 'rows']);
  assert.equal(first.busy, true);
  assert.deepEqual(first.groups, [{ name: 'orphan', count: 2, cpu: 100 }, { name: 'other', count: 1, cpu: 18 }]);
  assert.deepEqual(first.rows[0], { pid: 8, ppid: 1, command: 'yes', cpu: 99.8, age: 100, group: 'orphan' });
  assert.equal(first.rows.length, 3);
  assert.deepEqual([second.busy, second.groups, second.rows], [false, [], []], 'ps gave no answer: empty groups');
});

test('a new day moves the file to its day and the days past 14 are deleted', () => {
  const dir = scratch();
  logHostLoad(data, { dir, now: new Date('2026-11-15T23:59:00') });
  fs.writeFileSync(path.join(dir, 'host-load-2026-10-31.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'host-load-2026-11-02.jsonl'), '{}\n');
  logHostLoad(data, { dir, now: new Date('2026-11-16T00:00:15') });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['host-load-2026-11-02.jsonl', 'host-load-2026-11-15.jsonl', 'host-load.jsonl']);
  assert.equal(lines(path.join(dir, 'host-load.jsonl')).length, 1);
});
