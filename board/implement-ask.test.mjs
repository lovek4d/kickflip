// docs/adr/2026-11-18-0100-implement-is-only-the-cards-tap.md: no question offers Implement. A grill ends its round
// with the card's Implement ask (thread --implement), which the card carries back to discussing once every question is
// answered; only the owner's tap stages it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addQuestions, appendMessage, recordOwnerTap, settleAnswers, stageImplement, stopPlanner } from './store.mjs';
import { dropNextGates } from './migrations.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const other = (id = 'q-other') => ({ id, topic: 'item:t/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }] });
const oldNext = (id = 'q-next') => ({ id, topic: 'item:t/A1', question: 'What next, given these answers?', options: [{ id: 'implement', label: 'Implement' }, { id: 'prototype', label: 'Prototype first' }, { id: 'discuss', label: 'Keep discussing' }], next_gate: true });
const oldGate = (id = 'q-gate') => ({ id, topic: 'item:t/A1', question: 'Prototype round first?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], prototype_gate: true });
const ASK = 'Answer the questions, then tap Implement when the plan reads right.';

function world(fields = {}) {
  const site = tempDir('implement-ask-');
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
  const owner = () => JSON.parse(fs.readFileSync(path.join(data, 'owner.json'), 'utf8'));
  const resolved = (id) => owner().items.find((q) => q.id === id).resolved ?? null;
  const threadFile = path.join(data, 'threads', 't__A1.jsonl');
  const thread = () => (fs.existsSync(threadFile) ? fs.readFileSync(threadFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  // Questions already in owner.json, as an older board published them.
  const published = (...qs) => fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: qs.map((q) => ({ ...q, asked_at: new Date().toISOString() })) }));
  const grill = () => {
    fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(data, 'agents', 'A1.json'), JSON.stringify({ kind: 'grill', label: 'Grilling', started: new Date().toISOString() }));
  };
  return { site, data, answer, read, owner, resolved, thread, published, grill };
}

test('question add refuses next_gate as an unknown field, and an Implement option on any question', async () => {
  const { site } = world();
  await assert.rejects(addQuestions(site, oldNext()), /next_gate/);
  const asks = (options) => ({ ...other(), options });
  await assert.rejects(addQuestions(site, asks([{ id: 'implement', label: 'Build it' }, { id: 'a', label: 'A' }])), /Implement option.*card's Implement tap.*thread t\/A1 --implement/);
  await assert.rejects(addQuestions(site, asks([{ id: 'go', label: 'Implement as shown' }])), /Implement option/);
  await addQuestions(site, asks([{ id: 'a', label: 'Implementation notes first' }]));
});

test("a grill's Implement ask carries the card back to discussing once every question is answered, waiting on the tap, unstaged", async () => {
  const w = world();
  await addQuestions(w.site, [other(), other('q-two')]);
  await appendMessage(w.site, 't/A1', { text: ASK, implement: true });
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-other', 'a')]), { prototype: [] });
  assert.equal(w.read().phase, 'grilling');
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-two', 'a')]), { prototype: [] });
  assert.equal(w.read().phase, 'discussing');
  assert.deepEqual([w.read().waits_on_owner.on, w.read().waits_on_owner.phase], ['implement', 'discussing']);
  await stageImplement(w.site, 't/A1', { text: '' });
  assert.equal(w.read().phase, 'staging');
  assert.equal(w.read().waits_on_owner, undefined);
});

test("a grilling card's last answer leaves it discussing with Implement waiting, never staged, with or without its grill's ask", async () => {
  const w = world();
  await addQuestions(w.site, other());
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-other', 'a')]), { prototype: [] });
  assert.equal(w.read().phase, 'discussing');
  assert.equal(w.read().waits_on_owner.on, 'implement');
  assert.equal(w.thread().some((l) => l.line === 'staged'), false);
});

test('a grill that asks nothing and ends on its Implement ask moves the card to discussing, waiting on the tap, with no fault line; one with neither still faults', async () => {
  const w = world();
  w.grill();
  await appendMessage(w.site, 't/A1', { text: ASK, implement: true });
  await stopPlanner(w.site, 't/A1', { note: 'Nothing left to ask' });
  assert.equal(w.read().phase, 'discussing');
  assert.equal(w.read().waits_on_owner.on, 'implement');
  assert.equal(w.thread().some((l) => l.line === 'planner-unasked'), false);
  const bare = world();
  bare.grill();
  await stopPlanner(bare.site, 't/A1', { note: 'Asked nothing' });
  assert.equal(bare.read().phase, 'grilling');
  assert.ok(bare.thread().some((l) => l.line === 'planner-unasked'));
});

test("an open old prototype question's no is not Implement: the card returns to discussing on its Implement ask, unstaged", async () => {
  const w = world();
  w.published(oldGate());
  assert.deepEqual(await settleAnswers(w.site, [w.answer('q-gate', 'no')]), { prototype: [] });
  assert.equal(w.read().phase, 'discussing');
  assert.equal(w.read().waits_on_owner.on, 'implement');
});

test("the boot migration resolves an open next question with a note, and its card falls back to its Implement ask in discussing; gates.next goes", async () => {
  const w = world({ gates: { next: 'discuss', prototype: 'no' } });
  w.published(oldNext());
  const lines = await dropNextGates(w.site);
  assert.deepEqual(lines, ['t: 1 closing questions resolved, Implement is only the tap', 't: 1 tasks dropped their Keep discussing']);
  assert.match(w.resolved('q-next'), /tap Implement/);
  assert.equal(w.read().phase, 'discussing');
  assert.equal(w.read().waits_on_owner.on, 'implement');
  assert.deepEqual(w.read().gates, { prototype: 'no' });
  assert.ok(w.thread().some((l) => /tap Implement/.test(l.text)), 'the note is in the thread');
  assert.deepEqual(await dropNextGates(w.site), [], 'a second pass changes nothing');
});

test('the boot migration leaves a card with another open question grilling, its Implement ask carried once that is answered', async () => {
  const w = world();
  w.published(oldNext(), other());
  await dropNextGates(w.site);
  assert.ok(w.resolved('q-next'));
  assert.equal(w.read().phase, 'grilling');
  await settleAnswers(w.site, [w.answer('q-other', 'a')]);
  assert.equal(w.read().phase, 'discussing');
  assert.equal(w.read().waits_on_owner.on, 'implement');
});

test('the boot migration resolves a next question on a card that has had Implement without marking it, and drops a staged one', async () => {
  const w = world({ phase: 'staging' });
  w.published(oldNext());
  fs.writeFileSync(path.join(w.data, 'staged-questions.json'), JSON.stringify({ 't/A1': [oldNext('q-staged'), other()] }));
  await dropNextGates(w.site);
  assert.ok(w.resolved('q-next'));
  assert.equal(w.read().phase, 'staging');
  assert.equal(w.read().waits_on_owner, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.data, 'staged-questions.json'), 'utf8'))['t/A1'].map((q) => q.id), ['q-other']);
});

// docs/adr/2026-11-16-1030-implement-stages-a-blocked-card-and-keeps-the-block.md
test('an Implement on a held card stages it and keeps the block and its pick-up time, with no Unblocked line; Unblock still lifts it', async () => {
  const w = world({ phase: 'discussing', held: true, pick_up_at: '2026-11-18T00:00:00.000Z' });
  await stageImplement(w.site, 't/A1', { text: '' });
  assert.equal(w.read().phase, 'staging');
  assert.equal(w.read().held, true);
  assert.equal(w.read().pick_up_at, '2026-11-18T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(w.thread()), /Unblocked/);
  await recordOwnerTap(w.site, 'card-hold', { key: 't/A1', hold: false });
  assert.equal(w.read().held, undefined);
  assert.equal(w.read().phase, 'staging');
});
