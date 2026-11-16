// docs/adr/2026-11-16-0205-the-event-log-and-threads-are-parsed-once-and-archived-cards-agent-files-go-unread.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';
import { readLog } from './store.mjs';

const line = (id) => JSON.stringify({ id, data: { n: id } }) + '\n';
const logFile = () => path.join(tempDir('read-log-'), 'events.jsonl');

test('readLog parses a line once: after an append it returns the lines it already had, the same objects, and the new ones', async () => {
  const file = logFile();
  fs.writeFileSync(file, line('a') + line('b'));
  const first = await readLog(file);
  assert.deepEqual(first.map((e) => e.id), ['a', 'b']);
  fs.appendFileSync(file, line('c'));
  const second = await readLog(file);
  assert.deepEqual(second.map((e) => e.id), ['a', 'b', 'c']);
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1]);
  assert.equal(await readLog(file).then((l) => l[2]), second[2], 'an unchanged file is not parsed again');
});

test('readLog reads a file rewritten in place whole again, longer, shorter or the same length', async () => {
  const file = logFile();
  fs.writeFileSync(file, line('a') + line('b'));
  await readLog(file);
  fs.writeFileSync(file, line('x') + line('y') + line('z'));
  assert.deepEqual((await readLog(file)).map((e) => e.id), ['x', 'y', 'z']);
  fs.writeFileSync(file, line('q'));
  assert.deepEqual((await readLog(file)).map((e) => e.id), ['q']);
  fs.writeFileSync(file, line('r'));
  assert.deepEqual((await readLog(file)).map((e) => e.id), ['r']);
});

test('readLog of a missing file is empty, and a file made again reads as it is now', async () => {
  const file = logFile();
  assert.deepEqual(await readLog(file), []);
  fs.writeFileSync(file, line('a'));
  await readLog(file);
  fs.rmSync(file);
  assert.deepEqual(await readLog(file), []);
  fs.writeFileSync(file, line('b'));
  assert.deepEqual((await readLog(file)).map((e) => e.id), ['b']);
});

test('readLog leaves out a line still being written and reads it once it is whole; a whole last line with no newline counts', async () => {
  const file = logFile();
  fs.writeFileSync(file, line('a') + '{"id":"b","da');
  assert.deepEqual((await readLog(file)).map((e) => e.id), ['a']);
  fs.appendFileSync(file, 'ta":{}}');
  assert.deepEqual((await readLog(file)).map((e) => e.id), ['a', 'b']);
  fs.appendFileSync(file, '\n' + line('c'));
  assert.deepEqual((await readLog(file)).map((e) => e.id), ['a', 'b', 'c']);
});

test('readLog returns its own array each call, of frozen lines, so no caller changes what another reads', async () => {
  const file = logFile();
  fs.writeFileSync(file, line('a') + line('b'));
  const first = await readLog(file);
  first.reverse();
  assert.deepEqual((await readLog(file)).map((e) => e.id), ['a', 'b']);
  assert.throws(() => { first[0].id = 'changed'; }, TypeError);
  assert.throws(() => { first[0].data.n = 'changed'; }, TypeError);
});

test('readLog of a file with a broken whole line is empty, as reading it whole was', async () => {
  const file = logFile();
  fs.writeFileSync(file, line('a') + 'not json\n' + line('b'));
  assert.deepEqual(await readLog(file), []);
});
