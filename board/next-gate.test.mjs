// docs/adr/2026-11-12-1400-a-grill-ends-asking-to-implement-prototype-or-discuss.md: a grill's closing question is
// "What next, given these answers?", options implement, prototype and discuss, which the board acts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addQuestions, recordOwnerTap, settleAnswers, stageImplement, stopPlanner } from './store.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const choices = [{ id: 'implement', label: 'Implement', recommended: true }, { id: 'prototype', label: 'Prototype first' }, { id: 'discuss', label: 'Keep discussing' }];
const other = (id = 'q-other') => ({ id, topic: 'item:t/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }] });
const next = (id = 'q-next') => ({ id, topic: 'item:t/A1', question: 'What next, given these answers?', options: choices, next_gate: true });
const oldGate = (id = 'q-gate') => ({ id, topic: 'item:t/A1', question: 'Prototype round first?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], prototype_gate: true });

function world(fields = {}) {
  const site = tempDir('next-');
  const data = path.join(site, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'notes.md'), '# Task\n');
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'Card', lane: 'todo', phase: 'grilling', size: 'small', plan: 'notes.md', ...fields }] }));
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [] }));
  fs.writeFileSync(path.join(data, 'events.jsonl'), '');
  const answer = (id, choice) => {
    const a = { id, choice, note: '' };
    fs.appendFileSync(path.join(data, 'events.jsonl'), JSON.stringify({ id: `e-${id}`, ts: new Date().toISOString(), kind: 'owner-answer', data: a }) + '\n');
    return a;
  };
  const read = () => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items[0];
  const set = (f) => fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ ...read(), ...f }] }));
  const resolved = (id) => JSON.parse(fs.readFileSync(path.join(data, 'owner.json'), 'utf8')).items.find((q) => q.id === id).resolved ?? null;
  const grill = () => {
    fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(data, 'agents', 'A1.json'), JSON.stringify({ kind: 'grill', label: 'Grilling', started: new Date().toISOString() }));
  };
  return { site, answer, read, set, resolved, grill };
}

test('a next_gate question takes exactly implement, prototype and discuss, on a card', async () => {
  const { site } = world();
  await assert.rejects(addQuestions(site, { ...next(), options: [choices[1], choices[0], choices[2]] }), /takes exactly the options implement, prototype, discuss/);
  await assert.rejects(addQuestions(site, { ...next(), options: choices.slice(0, 2) }), /takes exactly the options implement, prototype, discuss/);
  await assert.rejects(addQuestions(site, { ...next(), next_gate: 'yes' }), /must be true or false/);
  await assert.rejects(addQuestions(site, { ...next(), prototype_gate: true }), /one closing question/);
  await addQuestions(site, next());
});

test('Implement stages the card once every question is answered, keeping prototype no', async () => {
  const w = world();
  await addQuestions(w.site, [other(), next()]);
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-next', 'implement')]), { prototype: [], staged: [] });
  assert.equal(w.read().phase, 'grilling');
  assert.match(w.resolved('q-next'), /^Next: Implement\. /);
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-other', 'a')]), { prototype: [], staged: ['t/A1'] });
  assert.equal(w.read().phase, 'staging');
  assert.deepEqual(w.read().gates, { prototype: 'no' });
});

test('Prototype first moves the card to prototyping and spends the yes', async () => {
  const w = world();
  await addQuestions(w.site, [other(), next()]);
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-other', 'a'), w.answer('q-next', 'prototype')]), { prototype: ['t/A1'], staged: [] });
  assert.equal(w.read().phase, 'prototyping');
  assert.deepEqual(w.read().gates, { prototype: 'ran' });
});

test('Keep discussing returns the card to discussing once every question is answered, starting nothing, and the next grill asks again', async () => {
  const w = world();
  await addQuestions(w.site, [other(), next()]);
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-next', 'discuss')]), { prototype: [], staged: [] });
  assert.equal(w.read().phase, 'grilling');
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-other', 'a')]), { prototype: [], staged: [] });
  assert.equal(w.read().phase, 'discussing');
  assert.equal(w.read().gates, undefined);
  w.set({ phase: 'grilling' });
  await addQuestions(w.site, next('q-next-2'));
});

test('question add refuses a next_gate on a card that keeps its prototype answer', async () => {
  const w = world({ gates: { prototype: 'no' } });
  await assert.rejects(addQuestions(w.site, next()), /next_gate: t\/A1 already has its prototype answer, no/);
});

test("an open old prototype question still decides the card, and answering it closes a next question beside it", async () => {
  const w = world();
  fs.writeFileSync(path.join(w.site, 'data', 'owner.json'), JSON.stringify({ topics: [], items: [{ ...oldGate(), asked_at: new Date().toISOString() }, { ...next(), asked_at: new Date().toISOString() }] }));
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-gate', 'no')]), { prototype: [], staged: ['t/A1'] });
  assert.equal(w.read().phase, 'staging');
  assert.ok(w.resolved('q-next'));
});

test('a grill that ends asking nothing on an unanswered card still faults', async () => {
  const w = world();
  w.grill();
  await stopPlanner(w.site, 't/A1', { note: 'Asked nothing' });
  assert.equal(w.read().phase, 'grilling');
});

test("an Implement tap after Keep discussing stages the card and spends the discuss, so a later grill doesn't return it to discussing", async () => {
  const w = world();
  await addQuestions(w.site, [other(), next()]);
  await settleAnswers(w.site, [w.answer('q-next', 'discuss')]);
  assert.deepEqual(w.read().gates, { next: 'discuss' });
  await stageImplement(w.site, 't/A1', { text: '' });
  assert.equal(w.read().phase, 'staging');
  assert.equal(w.read().gates, undefined);
});

// docs/adr/2026-11-16-1030-implement-stages-a-blocked-card-and-keeps-the-block.md
test('an Implement on a held card stages it and keeps the block and its pick-up time, with no Unblocked line; Unblock still lifts it', async () => {
  const w = world({ phase: 'discussing', held: true, pick_up_at: '2026-11-18T00:00:00.000Z' });
  await stageImplement(w.site, 't/A1', { text: '' });
  assert.equal(w.read().phase, 'staging');
  assert.equal(w.read().held, true);
  assert.equal(w.read().pick_up_at, '2026-11-18T00:00:00.000Z');
  const thread = path.join(w.site, 'data', 'threads', 't__A1.jsonl');
  assert.doesNotMatch(fs.existsSync(thread) ? fs.readFileSync(thread, 'utf8') : '', /Unblocked/);
  await recordOwnerTap(w.site, 'card-hold', { key: 't/A1', hold: false });
  assert.equal(w.read().held, undefined);
  assert.equal(w.read().phase, 'staging');
});

test('an Implement option is refused on any question but a next_gate', async () => {
  const { site } = world();
  const asks = (options) => ({ ...other(), options });
  await assert.rejects(addQuestions(site, asks([{ id: 'implement', label: 'Build it' }, { id: 'a', label: 'A' }])), /Implement option.*next_gate/);
  await assert.rejects(addQuestions(site, asks([{ id: 'go', label: 'Implement as shown' }])), /Implement option.*next_gate/);
  await addQuestions(site, asks([{ id: 'a', label: 'Implementation notes first' }]));
  await addQuestions(site, next());
});
