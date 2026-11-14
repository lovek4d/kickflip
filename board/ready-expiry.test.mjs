// docs/adr/2026-11-14-1700-a-ready-task-unpulled-a-day-re-stages-when-main-has-moved.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, write, read, lines, board, wave } from './board-fixture.mjs';
import { restageStaleReady, READY_EXPIRES_MS } from './store.mjs';

const dir = () => site('audit');
const file = () => site('audit', 'data', 'items.json');
const item = (id = 'T1') => read(file()).items.find((i) => i.id === id);
const thread = (id = 'T1') => { try { return lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)); } catch { return []; } };
const T0 = Date.parse('2026-11-13T20:41:00.000Z');
const at = (ms) => new Date(T0 + ms);
const fileItems = (...items) => write(file(), { ...wave(), items });
const readyOne = (extra = {}) => ({ id: 'T1', title: 'feat: one', lane: 'todo', phase: 'ready', ready_at: new Date(T0).toISOString(), ready_main: 'aaa', ...extra });

test('a ready card unpulled for a day goes back to staging when main moved, keeping its notes', async () => {
  fileItems(readyOne({ plan: 't1-notes.md', size: 'small' }));
  assert.deepEqual(await restageStaleReady(dir(), 'bbb', at(READY_EXPIRES_MS)), ['audit/T1']);
  const it = item();
  assert.deepEqual([it.phase, it.plan, it.size, it.ready_at, it.ready_main], ['staging', 't1-notes.md', 'small', undefined, undefined]);
  assert.equal(it.staged_at, at(READY_EXPIRES_MS).toISOString());
  assert.equal(thread().at(-1).text, 'Ready expired after a day unpulled: re-checking against what landed since');
});

test('a ready card stays ready before the day is up, or when main has not moved however long it waits', async () => {
  fileItems(readyOne());
  assert.deepEqual(await restageStaleReady(dir(), 'bbb', at(READY_EXPIRES_MS - 1)), []);
  assert.deepEqual(await restageStaleReady(dir(), 'aaa', at(30 * READY_EXPIRES_MS)), []);
  assert.equal(item().phase, 'ready');
  assert.deepEqual(thread(), []);
});

test('a held card expires too, but one pulled out of Todo or in no ready phase does not', async () => {
  fileItems(readyOne({ held: true }), readyOne({ id: 'T2', lane: 'progress' }), readyOne({ id: 'T3', phase: 'grilling' }));
  assert.deepEqual(await restageStaleReady(dir(), 'bbb', at(READY_EXPIRES_MS)), ['audit/T1']);
  assert.deepEqual([item('T2').phase, item('T3').phase], ['ready', 'grilling']);
});

test('a ready card with no record of main yet is stamped with this time and main, and expires a day later', async () => {
  fileItems(readyOne({ ready_at: undefined, ready_main: undefined }));
  assert.deepEqual(await restageStaleReady(dir(), 'aaa', at(0)), []);
  assert.deepEqual([item().ready_at, item().ready_main], [at(0).toISOString(), 'aaa']);
  assert.deepEqual(await restageStaleReady(dir(), 'bbb', at(READY_EXPIRES_MS)), ['audit/T1']);
});

test('the clock restarts on each ready: item set --phase ready records ready_at and drops the main of the last ready', async () => {
  fileItems(readyOne({ phase: 'staging', ready_at: undefined, ready_main: 'aaa', plan: 't1.md', size: 'small' }));
  write(site('audit', 'data', 't1.md'), '# Notes\n');
  const r = await board('item', 'set', 'audit/T1', '--site', 'audit', '--phase', 'ready', '--text', 'Checked.');
  assert.equal(r.code, 0, r.err);
  const it = item();
  assert.equal(it.phase, 'ready');
  assert.ok(Date.parse(it.ready_at) > Date.now() - 60000);
  assert.equal(it.ready_main, undefined);
});
