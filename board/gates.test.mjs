// docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md: the owner's answer to a card's prototype question is a
// fact the card keeps in `gates`, so a regrill or a split child never asks it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, addQuestions, briefFacts, migrateGates, settleAnswers, stopPlanner } from './store.mjs';

const yesNo = [{ id: 'yes', label: 'Yes', recommended: true }, { id: 'no', label: 'No' }];
const other = (id = 'q-other') => ({ id, topic: 'item:t/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }] });
const gate = (id = 'q-gate') => ({ id, topic: 'item:t/A1', question: 'Prototype round first?', options: yesNo, prototype_gate: true });

function world(fields = {}, more = []) {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-'));
  const data = path.join(site, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'notes.md'), '# Card\n');
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'Card', lane: 'todo', phase: 'grilling', size: 'small', plan: 'notes.md', ...fields }, ...more] }));
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [] }));
  fs.writeFileSync(path.join(data, 'events.jsonl'), '');
  const answer = (id, choice) => {
    const a = { id, choice, note: '' };
    fs.appendFileSync(path.join(data, 'events.jsonl'), JSON.stringify({ id: `e-${id}`, ts: new Date().toISOString(), kind: 'owner-answer', data: a }) + '\n');
    return a;
  };
  const items = () => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items;
  const read = (id = 'A1') => items().find((it) => it.id === id);
  const set = (fields) => fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: items().map((it) => (it.id === 'A1' ? { ...it, ...fields } : it)) }));
  const thread = () => fs.readFileSync(path.join(data, 'threads', 't__A1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // A grill planner's open record, as builder start writes it.
  const grill = () => {
    fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(data, 'agents', 'A1.json'), JSON.stringify({ kind: 'grill', label: 'Grilling', started: new Date().toISOString() }));
  };
  return { site, data, answer, read, set, thread, grill };
}

test("the owner's answer to the prototype question becomes the card's gates.prototype, and question add then refuses another", async () => {
  const w = world();
  await addQuestions(w.site, [other(), gate()]);
  await settleAnswers(w.site, [w.answer('q-gate', 'no')]);
  assert.deepEqual(w.read().gates, { prototype: 'no' });
  await assert.rejects(addQuestions(w.site, gate('q-gate-2')), /prototype_gate: t\/A1 already has its prototype answer, no/);
  assert.equal((await briefFacts(w.site, 't/A1')).prototype, 'no');
  assert.equal((await briefFacts(world().site, 't/A1')).prototype, null);
});

test('a decided no stages a regrill once its own questions are answered, with no prototype question', async () => {
  const w = world({ gates: { prototype: 'no' } });
  await addQuestions(w.site, other());
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-other', 'a')]), { prototype: [], staged: ['t/A1'] });
  assert.equal(w.read().phase, 'staging');
});

test('a yes is spent once its round runs: the move to prototyping marks it ran, and a later regrill stages', async () => {
  const w = world();
  await addQuestions(w.site, gate());
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-gate', 'yes')]), { prototype: ['t/A1'], staged: [] });
  assert.equal(w.read().phase, 'prototyping');
  assert.deepEqual(w.read().gates, { prototype: 'ran' });
  w.set({ phase: 'grilling' });
  await addQuestions(w.site, other('q-again'));
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-again', 'a')]), { prototype: [], staged: ['t/A1'] });
  assert.equal(w.read().phase, 'staging');

  const decided = world({ gates: { prototype: 'yes' } });
  await addQuestions(decided.site, other());
  assert.deepEqual(await settleAnswers(decided.site, [decided.answer('q-other', 'a')]), { prototype: ['t/A1'], staged: [] });
  assert.deepEqual(decided.read().gates, { prototype: 'ran' });
});

// docs/adr/2026-11-11-1300-a-planner-that-ends-without-its-question-waits-on-the-orchestrator.md
test("a grill that ends asking nothing on a card whose prototype answer is kept moves the card on, with no fault line; an unanswered one still faults", async () => {
  for (const [prototype, phase] of [['no', 'staging'], ['yes', 'prototyping'], ['ran', 'staging']]) {
    const w = world({ gates: { prototype } });
    w.grill();
    await stopPlanner(w.site, 't/A1', { note: 'Nothing left to ask' });
    assert.equal(w.read().phase, phase, prototype);
    assert.equal(w.thread().some((l) => l.line === 'planner-unasked'), false, prototype);
    if (prototype === 'yes') assert.deepEqual(w.read().briefs.map((b) => b.kind), ['prototype'], 'the card owes the orchestrator its prototype brief');
  }
  const unset = world();
  unset.grill();
  await stopPlanner(unset.site, 't/A1', { note: 'Asked nothing' });
  assert.equal(unset.read().phase, 'grilling');
  assert.ok(unset.thread().some((l) => l.line === 'planner-unasked'));
});

test('item add --split-of sets the Parent and copies its gates; it refuses --parent beside it', async () => {
  const w = world({ gates: { prototype: 'no' } }, [{ id: 'B1', title: 'Bare', lane: 'todo', phase: 'grilling' }]);
  const { key } = await addItem(w.site, 't/C1', { title: 'feat: slice one', splitOf: 't/A1', phase: 'grilling', intake: true });
  assert.equal(key, 't/C1');
  assert.deepEqual([w.read('C1').parent, w.read('C1').gates], ['t/A1', { prototype: 'no' }]);
  await addItem(w.site, 't/C2', { title: 'feat: slice of a bare card', splitOf: 't/B1', phase: 'grilling', intake: true });
  assert.deepEqual([w.read('C2').parent, 'gates' in w.read('C2')], ['t/B1', false]);
  await assert.rejects(addItem(w.site, 't/C3', { title: 'feat: both', splitOf: 't/A1', parent: 't/A1', phase: 'grilling', intake: true }), /--split-of sets the Parent; drop --parent/);
  await assert.rejects(addItem(w.site, 't/C4', { title: 'feat: gone', splitOf: 't/Z9', phase: 'grilling', intake: true }), /Z9/);
});

// docs/adr/2026-11-10-1600-tickets-are-made-at-ready.md: a card's ticket is made at ready, so no question asks for one.
test('question add refuses a ticket_gate key as an unknown field', async () => {
  const w = world();
  const ticket = { ...gate('q-ticket'), prototype_gate: undefined, ticket_gate: true, question: 'Create a ticket for this task?' };
  await assert.rejects(addQuestions(w.site, ticket), /question q-ticket has unknown field "ticket_gate"/);
});

test("the start-up backfill sets each live card's gates from its last answered gate questions, a yes whose round ran as ran, once", async () => {
  const w = world({}, [
    { id: 'A2', title: 'Waiting', lane: 'todo', phase: 'grilling' },
    { id: 'A3', title: 'Prototyped', lane: 'todo', phase: 'ready' },
    { id: 'A4', title: 'Kept', lane: 'todo', phase: 'grilling', gates: { prototype: 'no' } },
    { id: 'A5', title: 'Unasked', lane: 'todo', phase: 'grilling' },
  ]);
  const q = (id, key) => ({ ...gate(id), topic: `item:t/${key}` });
  fs.writeFileSync(path.join(w.data, 'owner.json'), JSON.stringify({ topics: [], items: [q('a1-s', 'A1'), q('a1-r', 'A1'), q('a2', 'A2'), q('a3', 'A3'), q('a4', 'A4'), q('a5', 'A5')] }));
  w.answer('a1-s', 'yes');
  w.answer('a2', 'yes');
  w.answer('a3', 'yes');
  w.answer('a4', 'yes');
  // A1 was regrilled after its round: its thread's prototype-round line comes after the yes.
  fs.mkdirSync(path.join(w.data, 'threads'));
  fs.writeFileSync(path.join(w.data, 'threads', 't__A1.jsonl'), JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), who: 'claude', kind: 'hub', line: 'prototype-round', text: 'moved' }) + '\n');
  assert.deepEqual(await migrateGates(w.site), ['t: 3 cards keep their gate answers']);
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => w.read(id).gates ?? null), [{ prototype: 'ran' }, { prototype: 'yes' }, { prototype: 'ran' }, { prototype: 'no' }, null]);
  assert.deepEqual(await migrateGates(w.site), []);
});
