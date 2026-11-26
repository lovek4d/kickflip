// docs/adr/2026-11-26-2200-a-let-me-know-when-reminder-pushes-once.md: board.mjs remind stores a one-shot reminder on a
// task, for when it's done or when it needs the owner, each set and cancel a line in its thread; the board server
// pushes it once and clears it (server.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { site, lines, read, write, board } from './board-fixture.mjs';

const items = () => read(site('audit', 'data', 'items.json')).items;
const item = (id) => items().find((it) => it.id === id);
const thread = (id) => {
  const file = site('audit', 'data', 'threads', `audit__${id}.jsonl`);
  return fs.existsSync(file) ? lines(file) : [];
};
const card = (id, extra = {}) => {
  const file = site('audit', 'data', 'items.json');
  write(file, { ...read(file), items: [...read(file).items, { id, title: `feat: ${id}`, lane: 'progress', ...extra }] });
};
const remind = (id, ...args) => board('remind', `audit/${id}`, '--site', 'audit', ...args);
const reminderLines = (id) => thread(id).filter((m) => String(m.line || '').startsWith('reminder')).map((m) => [m.line, m.text]);

test('remind --when done or needs-you stores a one-shot reminder on the task, with a Reminder line in its thread, and --cancel takes it off', async () => {
  card('R1');
  const set = await remind('R1', '--when', 'done');
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /reminder set for when it's done/);
  assert.equal(item('R1').remind_when, 'done');
  assert.equal((await remind('R1', '--when', 'needs-you')).code, 0, 'a second remind replaces the first');
  assert.equal(item('R1').remind_when, 'needs-you');
  const cancel = await remind('R1', '--cancel');
  assert.equal(cancel.code, 0, cancel.err);
  assert.match(cancel.out, /reminder cancelled/);
  assert.equal('remind_when' in item('R1'), false);
  assert.deepEqual(reminderLines('R1'), [
    ['reminder-set', "Reminder set: one push when it's done."],
    ['reminder-set', 'Reminder set: one push when it needs you.'],
    ['reminder-cancelled', 'Reminder cancelled.'],
  ]);
  assert.ok(thread('R1').filter((m) => String(m.line || '').startsWith('reminder')).every((m) => m.who === 'claude'));
});

test('remind refuses a task already done, an event it does not know, no event or both, and a cancel with nothing set', async () => {
  card('R2', { lane: 'done', closed_at: '2026-11-20T00:00:00.000Z' });
  card('R3');
  const done = await remind('R2', '--when', 'done');
  assert.notEqual(done.code, 0);
  assert.match(done.err, /already done/);
  const odd = await remind('R3', '--when', 'lands');
  assert.notEqual(odd.code, 0);
  assert.match(odd.err, /--when takes done or needs-you/);
  const none = await remind('R3');
  assert.notEqual(none.code, 0);
  assert.match(none.err, /remind needs --when done\|needs-you, or --cancel/);
  const both = await remind('R3', '--when', 'done', '--cancel');
  assert.notEqual(both.code, 0);
  const nothing = await remind('R3', '--cancel');
  assert.notEqual(nothing.code, 0);
  assert.match(nothing.err, /has no reminder/);
  assert.deepEqual(reminderLines('R3'), []);
  assert.equal('remind_when' in item('R3'), false);
});
