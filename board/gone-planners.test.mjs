// docs/adr/2026-11-12-1000-a-planner-whose-process-is-gone-closes-at-once.md: the board closes a planner's open record
// itself once its process is gone, with the line its end owes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addQuestions, closeGonePlanners } from './store.mjs';
import { runFailure } from './headless.mjs';

function world(phase = 'grilling') {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'gone-'));
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'notes.md'), '# Card\n');
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'Card', lane: 'todo', phase, size: 'small', plan: 'notes.md' }] }));
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [] }));
  fs.writeFileSync(path.join(data, 'events.jsonl'), '');
  const open = (kind, file = 'A1.json', session = { id: 's', pid: 4242, log: 'x.log', at: new Date().toISOString() }) =>
    fs.writeFileSync(path.join(data, 'agents', file), JSON.stringify({ kind, label: kind, started: new Date().toISOString(), session }));
  const record = (file = 'A1.json') => JSON.parse(fs.readFileSync(path.join(data, 'agents', file), 'utf8'));
  const thread = () => (fs.existsSync(path.join(data, 'threads', 't__A1.jsonl'))
    ? fs.readFileSync(path.join(data, 'threads', 't__A1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { site, data, open, record, thread };
}
const gone = { alive: () => false, failure: () => null };

test('a planner whose process is gone with its record open closes, and its card reads planner-unasked at once', async () => {
  const w = world();
  w.open('grill');
  assert.deepEqual(await closeGonePlanners(w.site, gone), [{ key: 't/A1', kind: 'grill', failed: null }]);
  assert.ok(w.record().done);
  assert.ok(w.thread().some((l) => l.line === 'planner-unasked' && l.detail === 'grill'));
});

test('a planner that exited non-zero closes with planner-failed and the error, not the unasked line', async () => {
  const w = world('prototyping');
  w.open('prototype');
  const closed = await closeGonePlanners(w.site, { alive: () => false, failure: () => 'its command was refused' });
  assert.deepEqual(closed, [{ key: 't/A1', kind: 'prototype', failed: 'its command was refused' }]);
  const line = w.thread().find((l) => l.line === 'planner-failed');
  assert.ok(line.text.includes('its command was refused'));
  assert.equal(w.thread().some((l) => l.line === 'planner-unasked'), false);
  assert.ok(w.record().done);
});

test('a live planner, one the card has a question from, and a record with no process of the board are left alone', async () => {
  const live = world();
  live.open('grill');
  assert.deepEqual(await closeGonePlanners(live.site, { alive: () => true, failure: () => null }), []);
  assert.equal(live.record().done, undefined);

  const own = world();
  own.open('grill', 'A1.json', null);
  assert.deepEqual(await closeGonePlanners(own.site, gone), []);
  assert.equal(own.record().done, undefined);

  const asked = world();
  asked.open('grill');
  await addQuestions(asked.site, { id: 'q', topic: 'item:t/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }] });
  await closeGonePlanners(asked.site, gone);
  assert.ok(asked.record().done);
  assert.equal(asked.thread().some((l) => l.line === 'planner-unasked'), false);
});

test('a gone visual agent closes its record with no unasked line, and a builder is never touched', async () => {
  const w = world();
  w.open('visual', 'A1@visual-1.json');
  w.open('builder');
  assert.deepEqual(await closeGonePlanners(w.site, gone), [{ key: 't/A1', kind: 'visual', failed: null }]);
  assert.ok(w.record('A1@visual-1.json').done);
  assert.equal(w.record().done, undefined);
  assert.equal(w.thread().length, 0);
});

test('runFailure reads a run log: null after a clean result, the error text after an error result, and a words of its own with no result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  const write = (name, events) => { const f = path.join(dir, name); fs.writeFileSync(f, events.map((e) => JSON.stringify(e)).join('\n') + '\n'); return f; };
  assert.equal(runFailure(write('ok.log', [{ type: 'system' }, { type: 'result', is_error: false, result: 'done' }])), null);
  assert.equal(runFailure(write('bad.log', [{ type: 'result', is_error: true, result: 'Credit balance is too low' }])), 'Credit balance is too low');
  assert.equal(runFailure(write('cut.log', [{ type: 'system' }, { type: 'assistant' }])), 'its process ended before it finished');
  assert.equal(runFailure(path.join(dir, 'missing.log')), 'its process ended before it finished');
});
